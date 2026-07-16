// netlify/functions/whatsapp-webhook.js
//
// Secret Venue WhatsApp Assistant — two-layer design:
//   Layer 1 (no AI): menu options, direct date detection, keyword FAQ — handles
//     most real conversations with zero API cost and zero AI failure points.
//   Layer 2 (AI fallback): only runs when Layer 1 can't confidently match the
//     message. Provider is swappable via AI_PROVIDER env var — no code changes
//     needed to switch between Claude, OpenAI, or Gemini.
//
// Required environment variables (Netlify dashboard):
//   WHATSAPP_TOKEN            - Meta permanent/temporary access token
//   WHATSAPP_VERIFY_TOKEN     - a string you make up, used for webhook verification
//   WHATSAPP_PHONE_NUMBER_ID  - from Meta app > WhatsApp > API Setup
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_CALENDAR_ID
//   OWNER_WHATSAPP_NUMBER     - venue owner's own WhatsApp number (with country code,
//                               no + or spaces, e.g. 917200369191) - receives lead
//                               notifications for package/pricing enquiries
//
//   AI_PROVIDER               - "claude" | "openai" | "gemini" (which AI to use for fallback)
//   ANTHROPIC_API_KEY         - only needed if AI_PROVIDER=claude
//   OPENAI_API_KEY            - only needed if AI_PROVIDER=openai
//   GEMINI_API_KEY            - only needed if AI_PROVIDER=gemini

// ---------- Static content (edit these for the venue) ----------

const SITE_URL = "https://demosecretvenue1.netlify.app";

const MENU_TEXT = `Hi! Welcome to The Secret Venue 👋

Reply with a number:
1. Check availability for a date
2. Pricing & venue info
3. Talk to the owner directly`;

const FAQ_TEXT = `The Secret Venue — Gandhi Nagar, Vellore
Capacity: up to 300 guests
Parking: on-site, ~40 vehicles
Booking: 25% advance deposit to confirm a date

Reply "1" to check availability for a specific date, or "3" to speak with the owner.`;

const HANDOFF_TEXT = `Thanks! The owner will reach out to you shortly on this number.`;

const PACKAGE_ASK_NAME_TEXT = `Great question! Our packages vary based on your event — could you share your name so our representative can call you with details?`;

const PACKAGE_CONFIRM_TEXT = `You can browse our packages here: ${SITE_URL}/#packages

Our representative will also call you shortly to help you pick the right one and answer any questions.`;

// Keywords that trigger the FAQ reply directly, without needing menu option "2"
const FAQ_KEYWORDS = ["price", "pricing", "cost", "capacity", "parking", "address", "location", "deposit"];

// Keywords that specifically mean "package/customization/negotiation" — always
// handed off to a human call, regardless of whether package data is configured
// for this client yet. This is deliberate, not a stopgap: package/pricing
// negotiation is kept human even once package data exists, since it's a
// relationship/negotiation conversation, not a lookup.
const PACKAGE_KEYWORDS = ["package", "packages", "add-on", "addon", "add on", "customize", "customise", "discount", "negotiate", "combo"];

// Keywords that trigger the human handoff directly
const HANDOFF_KEYWORDS = ["owner", "talk to", "call me", "human", "manager"];

// ---------- Main handler ----------

exports.handler = async (event) => {
  // --- Webhook verification handshake (Meta calls this once, via GET) ---
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const mode = params["hub.mode"];
    const token = params["hub.verify_token"];
    const challenge = params["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: "Verification failed" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const message = extractMessage(body);
    if (!message) {
      return { statusCode: 200, body: "ignored" };
    }

    const { from, text } = message;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    try {
      // ===== LAYER 1: rule-based, no AI =====

      if (["hi", "hello", "hey", "menu", "start"].includes(lower)) {
        await sendMenuButtons(from);
        return { statusCode: 200, body: "ok" };
      }

      let replyText;
      if (trimmed === "1" || trimmed === "opt_availability") {
        replyText = "Sure — which date would you like to check? (e.g. 15/08/2026 or Aug 15)";
      } else if (trimmed === "2" || trimmed === "opt_pricing" || FAQ_KEYWORDS.some((k) => lower.includes(k))) {
        replyText = FAQ_TEXT;
      } else if (PACKAGE_KEYWORDS.some((k) => lower.includes(k))) {
        // Package/pricing/negotiation questions always hand off to a human call,
        // whether or not package data is configured for this client yet.
        replyText = PACKAGE_CONFIRM_TEXT;
        await notifyOwner(from, text, "Package/pricing enquiry");
      } else if (trimmed === "3" || trimmed === "opt_owner" || HANDOFF_KEYWORDS.some((k) => lower.includes(k))) {
        replyText = HANDOFF_TEXT;
        await notifyOwner(from, text, "Customer requested a call");
      } else {
        const parsedDate = parseDateFromText(trimmed);
        if (parsedDate) {
          const events = await getCalendarEvents(parsedDate, parsedDate);
          replyText = formatAvailabilityReply(parsedDate, parsedDate, events);
        } else {
          // ===== LAYER 2: AI fallback, only reached if nothing above matched =====
          replyText = await callAiFallback(trimmed);
        }
      }

      await sendWhatsAppMessage(from, replyText);
      return { statusCode: 200, body: "ok" };
    } catch (innerErr) {
      console.error("Reply generation failed:", innerErr);
      await sendWhatsAppMessage(from, "Thanks for reaching out! I'm having a little trouble right now — the owner will follow up with you shortly.");
      return { statusCode: 200, body: "ok" };
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 200, body: "error handled" };
  }
};

// Sends the initial menu as tappable buttons instead of a numbered text list —
// customers tap instead of typing "1"/"2"/"3", which is more reliable and
// looks more polished in a live demo.
async function sendMenuButtons(to) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Hi! Welcome to The Secret Venue 👋\nHow can I help you today?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "opt_availability", title: "Check availability" } },
          { type: "reply", reply: { id: "opt_pricing", title: "Pricing & info" } },
          { type: "reply", reply: { id: "opt_owner", title: "Talk to owner" } },
        ],
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("Menu buttons send failed:", response.status, JSON.stringify(result));
    // Fall back to a plain text menu so the customer isn't left with nothing.
    await sendWhatsAppMessage(to, MENU_TEXT);
  } else {
    console.log("Menu buttons sent:", JSON.stringify(result));
  }
}

// Sends the lead straight to the owner's own WhatsApp — no database needed for
// a single-client setup. If OWNER_WHATSAPP_NUMBER isn't set, this just logs
// and skips silently rather than breaking the customer-facing reply.
async function notifyOwner(customerNumber, customerMessage, reason) {
  const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
  if (!ownerNumber) {
    console.log("OWNER_WHATSAPP_NUMBER not set — skipping owner notification.");
    return;
  }
  const text = `📩 New enquiry — ${reason}\nFrom: +${customerNumber}\nMessage: "${customerMessage}"`;
  await sendWhatsAppMessage(ownerNumber, text);
}

// ---------- Layer 1 helpers (no AI) ----------

// Handles both plain text messages and button-tap replies. Button taps arrive
// with type "interactive" and carry the button's id (e.g. "opt_availability")
// in place of free text, so the rest of the routing logic can treat them the
// same way it treats someone typing "1".
function extractMessage(body) {
  try {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return null;

    if (msg.type === "text") {
      return { from: msg.from, text: msg.text.body };
    }
    if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
      return { from: msg.from, text: msg.interactive.button_reply.id };
    }
    return null;
  } catch {
    return null;
  }
}

// Recognizes common date formats without needing AI:
//   "15/08/2026", "15-08-2026", "15/08", "Aug 15", "August 15 2026", "15 Aug"
function parseDateFromText(text) {
  const monthNames = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
    september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  };
  const now = new Date();
  const currentYear = now.getFullYear();

  // Pattern 1: DD/MM/YYYY or DD-MM-YYYY (year optional)
  const numeric = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numeric) {
    const day = parseInt(numeric[1], 10);
    const month = parseInt(numeric[2], 10) - 1;
    let year = numeric[3] ? parseInt(numeric[3], 10) : currentYear;
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d) && d.getMonth() === month) return toISODate(d);
  }

  // Pattern 2: "Aug 15", "August 15 2026", "15 Aug", "15 August"
  const monthWord = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(\d{1,2})(?:,?\s*(\d{4}))?\b/i
  );
  const wordMonth = text.match(
    /\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(\d{4})?\b/i
  );

  const match = monthWord || wordMonth;
  if (match) {
    let day, monthKey, year;
    if (monthWord) {
      monthKey = match[1].toLowerCase();
      day = parseInt(match[2], 10);
      year = match[3] ? parseInt(match[3], 10) : currentYear;
    } else {
      day = parseInt(match[1], 10);
      monthKey = match[2].toLowerCase();
      year = match[3] ? parseInt(match[3], 10) : currentYear;
    }
    const month = monthNames[monthKey];
    if (month !== undefined) {
      const d = new Date(year, month, day);
      if (!isNaN(d)) return toISODate(d);
    }
  }

  return null;
}

function toISODate(d) {
  return d.toISOString().split("T")[0];
}

// ---------- Google Calendar ----------

async function getAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!data.access_token) {
    console.error("Google token refresh failed:", JSON.stringify(data));
  }
  return data.access_token;
}

async function getCalendarEvents(startDate, endDate) {
  const accessToken = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
  const timeMin = new Date(startDate + "T00:00:00").toISOString();
  const timeMax = new Date(endDate + "T23:59:59").toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json();

  if (!response.ok) {
    console.error("Calendar API call failed:", response.status, JSON.stringify(data));
    throw new Error("Calendar check failed");
  }
  return data.items || [];
}

function formatAvailabilityReply(startDate, endDate, events) {
  const dateLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
  if (events.length === 0) {
    return `Good news! ${dateLabel} is currently available at The Secret Venue. Reply "3" if you'd like the owner to follow up and confirm your booking.`;
  }
  const eventList = events.map((e) => `- ${e.summary || "Booked"}`).join("\n");
  return `${dateLabel} already has the following booking(s):\n${eventList}\n\nReply with another date to check, or "3" to talk to the owner about options.`;
}

// ---------- Layer 2: AI fallback (swappable provider) ----------

async function callAiFallback(userText) {
  const provider = (process.env.AI_PROVIDER || "claude").toLowerCase();

  const systemPrompt = `You are a helpful WhatsApp assistant for The Secret Venue, an event venue in Vellore. Reply in 2-3 short, friendly sentences. If the customer is asking about a specific date, ask them to send it in a clear format like "15 Aug" or "15/08/2026". If unsure, suggest they reply "3" to talk to the owner directly.`;

  try {
    if (provider === "openai") {
      return await callOpenAi(systemPrompt, userText);
    } else if (provider === "gemini") {
      return await callGemini(systemPrompt, userText);
    } else {
      return await callClaude(systemPrompt, userText);
    }
  } catch (err) {
    console.error(`AI fallback (${provider}) failed:`, err);
    return `Thanks for your message! Reply "1" to check availability, "2" for pricing info, or "3" to talk to the owner directly.`;
  }
}

async function callClaude(systemPrompt, userText) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Claude API failed:", response.status, JSON.stringify(data));
    throw new Error("Claude call failed");
  }
  const textBlock = data.content?.find((c) => c.type === "text");
  return textBlock?.text?.trim() || "Thanks for your message — the owner will follow up shortly.";
}

async function callOpenAi(systemPrompt, userText) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("OpenAI API failed:", response.status, JSON.stringify(data));
    throw new Error("OpenAI call failed");
  }
  return data.choices?.[0]?.message?.content?.trim() || "Thanks for your message — the owner will follow up shortly.";
}

async function callGemini(systemPrompt, userText) {
  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Gemini API failed:", response.status, JSON.stringify(data));
    throw new Error("Gemini call failed");
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text?.trim() || "Thanks for your message — the owner will follow up shortly.";
}

// ---------- WhatsApp send ----------

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("WhatsApp send failed:", response.status, JSON.stringify(result));
  } else {
    console.log("WhatsApp send succeeded:", JSON.stringify(result));
  }
  return result;
}
