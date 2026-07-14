// netlify/functions/oauth-callback.js
//
// One-time use: after visiting the Google consent URL (see README) and approving access,
// Google redirects here with a ?code=... param. This exchanges that code for a refresh
// token, which you then copy into GOOGLE_REFRESH_TOKEN in Netlify env vars.
//
// You can delete/disable this function after you've captured the refresh token once.

exports.handler = async (event) => {
  const code = event.queryStringParameters?.code;
  if (!code) {
    return { statusCode: 400, body: "Missing ?code param. Start from the Google consent URL in README." };
  }

  const redirectUri = `https://${event.headers.host}/.netlify/functions/oauth-callback`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();

  if (!data.refresh_token) {
    return {
      statusCode: 200,
      body: `No refresh_token returned. This usually means you've already authorized this app before.
Revoke access at https://myaccount.google.com/permissions and try again, so Google issues a fresh refresh_token.

Full response: ${JSON.stringify(data)}`,
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: `Success! Copy this value into GOOGLE_REFRESH_TOKEN in Netlify env vars:\n\n${data.refresh_token}`,
  };
};
