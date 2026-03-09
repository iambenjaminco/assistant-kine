const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");
const env = require("./env");

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "token.json");

function loadToken() {
  try {
    return google.auth.fromJSON(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  } catch {
    return null;
  }
}

function saveToken(client) {
  const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const key = keys.installed || keys.web;

  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    })
  );
}

async function getAuth() {
  let client = loadToken();
  if (client) return client;

  client = await authenticate({
    scopes: env.scopes,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials.refresh_token) saveToken(client);
  return client;
}

module.exports = { getAuth };