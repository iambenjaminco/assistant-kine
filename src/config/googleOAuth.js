const { google } = require("googleapis");

const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
];

function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("GOOGLE_OAUTH_NOT_CONFIGURED");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function buildGoogleAuthUrl({ state }) {
  const oauth2Client = getGoogleOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_CALENDAR_SCOPES,
    state,
  });
}

async function exchangeGoogleCodeForTokens(code) {
  const oauth2Client = getGoogleOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

function buildOAuthClientFromTokens(tokens) {
  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

module.exports = {
  GOOGLE_CALENDAR_SCOPES,
  getGoogleOAuthClient,
  buildGoogleAuthUrl,
  exchangeGoogleCodeForTokens,
  buildOAuthClientFromTokens,
};