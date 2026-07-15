// netlify/functions/whatsapp-webhook.js
//
// Demo webhook for Secret Venue WhatsApp AI Assistant
// Built against Queueapp's Meta test app/number for demo purposes only.
// Flow: WhatsApp message -> Claude (intent + dates) -> Google Calendar check -> WhatsApp reply
//
// Required environment variables (set in Netlify dashboard):
//   WHATSAPP_TOKEN            - Meta permanent/temporary access token
//   WHATSAPP_VERIFY_TOKEN     - a string you make up, used for webhook verification handshake
//   WHATSAPP_PHONE_NUMBER_ID  - from Meta app > WhatsApp > API Setup
//   ANTHROPIC_API_KEY         - Claude API key
//   GOOGLE_CLIENT_ID          - from Google Cloud Console OAuth credentials
//   GOOGLE_CLIENT_SECRET      - from Google Cloud Console OAuth credentials
//   GOOGLE_REFRESH_TOKEN      - obtained once via OAuth consent flow (see oauth-callback.js)
//   GOOGLE_CALENDAR_ID        - usually "primary" or the venue's calendar email

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  // --- 1. Webhook verification handshake (Meta calls this once, via GET) ---
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

  // --- 2. Incoming WhatsApp message (POST) ---
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body);

      const message = extractMessage(body);
      if (!message) {
        // Not a user text message (could be a status update, delivery receipt, etc.)
        return { statusCode: 200, body: "ignored" };
      }

      const { from, text } = message;

      let replyText;
      try {
        // --- 3. Ask Claude to extract intent + date range ---
        const intent = await parseIntent(text);

        // --- 4. Act on intent ---
        if (intent.intent === "get_events" && intent.start_date) {
          const events = await getCalendarEvents(intent.start_date, intent.end_date || intent.start_date);
          replyText = formatAvailabilityReply(intent.start_date, intent.end_date, events);
        } else if (intent.intent === "faq") {
          replyText = await answerFaq(text);
        } else {
          replyText = "Hi! I can check availability for a date, or answer questions about The Secret Venue. Could you share the date you're asking about?";
        }
      } catch (innerErr) {
        // Calendar/Claude failed (e.g. missing Google refresh token, expired API key).
        // Log the real reason, but still send the customer SOMETHING instead of silence.
        console.error("Intent/calendar step failed:", innerErr);
        replyText = "Thanks for reaching out! I'm having a little trouble checking that right now — the owner will follow up with you shortly.";
      }

      // --- 5. Send reply back via WhatsApp ---
      await sendWhatsAppMessage(from, replyText);

      return { statusCode: 200, body: "ok" };
    } catch (err) {
      console.error("Webhook error:", err);
      // Always return 200 to Meta even on internal errors, or Meta will retry aggressively
      return { statusCode: 200, body: "error handled" };
    }
  }

  return { statusCode: 405, body: "Method not allowed" };
};

// ---------- Helpers ----------

function extractMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return null;

    return {
      from: msg.from, // customer's WhatsApp number
      text: msg.text.body,
    };
  } catch {
    return null;
  }
}

async function parseIntent(userText) {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Today's date is ${today}. Extract the intent from this WhatsApp message sent to an event venue.

Return ONLY valid JSON, no other text, in this exact shape:
{"intent": "get_events" | "faq" | "unknown", "start_date": "YYYY-MM-DD or null", "end_date": "YYYY-MM-DD or null"}

Rules:
- "get_events" if the person is asking about availability/booking on a specific date
- "faq" if asking about pricing, capacity, location, parking, or general questions
- "unknown" if unclear
- Resolve relative dates (tomorrow, next Saturday, Aug 15) into actual YYYY-MM-DD using today's date above

Message: "${userText}"`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const textBlock = data.content?.find((c) => c.type === "text");
  const raw = (textBlock?.text || "{}").replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    return { intent: "unknown", start_date: null, end_date: null };
  }
}

async function answerFaq(userText) {
  // Keep the venue's FAQ knowledge inline for the demo.
  // In the real build, this would come from a per-customer knowledge doc.
  const knowledge = `
The Secret Venue is an event venue located in Gandhi Nagar, Vellore.
It hosts weddings, birthday parties, and corporate events.
Capacity: up to 300 guests.
Parking: available on-site for approximately 40 vehicles.
Booking requires a 25% advance deposit to confirm a date.
`;

  const prompt = `You are a helpful assistant for The Secret Venue, an event venue. Using ONLY the knowledge below, answer the customer's question in a short, friendly WhatsApp reply (2-3 sentences max). If the answer isn't in the knowledge, say you'll have the venue owner follow up directly.

Knowledge:
${knowledge}

Customer question: "${userText}"`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const textBlock = data.content?.find((c) => c.type === "text");
  return textBlock?.text?.trim() || "Thanks for your question — the venue owner will follow up shortly.";
}

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
  return data.access_token;
}

async function getCalendarEvents(startDate, endDate) {
  const accessToken = await getAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");

  const timeMin = new Date(startDate + "T00:00:00").toISOString();
  const timeMax = new Date(endDate + "T23:59:59").toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  return data.items || [];
}

function formatAvailabilityReply(startDate, endDate, events) {
  const dateLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;

  if (events.length === 0) {
    return `Good news! ${dateLabel} is currently available at The Secret Venue. Would you like me to note this as a tentative enquiry so the owner can follow up?`;
  }

  const eventList = events
    .map((e) => `- ${e.summary || "Booked"} (${formatTime(e.start)} - ${formatTime(e.end)})`)
    .join("\n");

  return `${dateLabel} already has the following booking(s):\n${eventList}\n\nWould you like to check another date, or shall I have the owner reach out to discuss options?`;
}

function formatTime(dateObj) {
  const dt = dateObj?.dateTime || dateObj?.date;
  if (!dt) return "unspecified time";
  return new Date(dt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
}

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
    // This is the critical bit that was missing: log Meta's actual error
    // (e.g. expired token, invalid recipient) instead of failing silently.
    console.error("WhatsApp send failed:", response.status, JSON.stringify(result));
  } else {
    console.log("WhatsApp send succeeded:", JSON.stringify(result));
  }

  return result;
}
