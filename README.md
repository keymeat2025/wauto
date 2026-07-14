# Secret Venue WhatsApp AI Assistant — Demo Build

Demo scaffold built against **Queueapp's** existing Meta app/test number, for demoing
to Secret Venue's owner before a dedicated isolated setup is built post-signoff.

## What this does

Customer sends a WhatsApp message → webhook receives it → Claude extracts intent
(availability check or FAQ) → checks Google Calendar if needed → replies on WhatsApp.

## Files

- `netlify/functions/whatsapp-webhook.js` — main handler (verification + incoming messages)
- `netlify/functions/oauth-callback.js` — one-time use, to get a Google Calendar refresh token
- `netlify.toml` — Netlify config

## Setup steps (demo, using Queueapp's test app)

### 1. Deploy this to Netlify
Push this folder to a GitHub repo, connect it in Netlify, deploy.

### 2. Set environment variables in Netlify dashboard
Site settings > Environment variables:

| Variable | Where to get it |
|---|---|
| `WHATSAPP_TOKEN` | Queueapp Meta app > WhatsApp > API Setup > temporary access token |
| `WHATSAPP_VERIFY_TOKEN` | Make up any string, e.g. `secretvenue_demo_2026` |
| `WHATSAPP_PHONE_NUMBER_ID` | Queueapp Meta app > WhatsApp > API Setup > Phone number ID |
| `ANTHROPIC_API_KEY` | Your Anthropic console API key |
| `GOOGLE_CLIENT_ID` | Google Cloud Console > OAuth 2.0 Client |
| `GOOGLE_CLIENT_SECRET` | Same as above |
| `GOOGLE_REFRESH_TOKEN` | Obtained via step 4 below |
| `GOOGLE_CALENDAR_ID` | The demo Google Calendar's email, or `primary` |

### 3. Register the webhook with Meta
In the Queueapp Meta app dashboard > WhatsApp > Configuration:
- Callback URL: `https://YOUR-SITE.netlify.app/.netlify/functions/whatsapp-webhook`
- Verify token: same string you set as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field

### 4. Get a Google Calendar refresh token (one-time)
1. Build this consent URL (replace placeholders), open it in a browser, and sign in
   with the Google account whose calendar you're demoing against:

```
https://accounts.google.com/o/oauth2/v2/auth?
  client_id=YOUR_GOOGLE_CLIENT_ID&
  redirect_uri=https://YOUR-SITE.netlify.app/.netlify/functions/oauth-callback&
  response_type=code&
  scope=https://www.googleapis.com/auth/calendar.readonly&
  access_type=offline&
  prompt=consent
```

2. Approve access. You'll land on the `oauth-callback` function, which prints a
   refresh token — copy it into `GOOGLE_REFRESH_TOKEN`.

### 5. Test
Send a WhatsApp message to the Queueapp test number, e.g. "Is Aug 15 available?"
You should get a reply within a few seconds.

## Important — this is a demo, not the final architecture

This build intentionally uses Queueapp's shared Meta app/number for speed.
**Do not** treat this as the production setup for Secret Venue. Once the owner
signs off, this needs to be rebuilt under Secret Venue's own:
- Facebook Business Manager + Meta Developer app + WABA (their number)
- Google Cloud OAuth credentials (their calendar)
- Anthropic API key (their billing)
- Netlify account (their hosting)

See the isolated-per-customer setup plan for that migration.
