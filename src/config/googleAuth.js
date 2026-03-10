// src/config/googleAuth.js
const { google } = require("googleapis");
const env = require("./env");

function getPrivateKey() {
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) {
    throw new Error("GOOGLE_PRIVATE_KEY manquante dans les variables d'environnement.");
  }
  return key.replace(/\\n/g, "\n");
}

async function getAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;

  if (!clientEmail) {
    throw new Error("GOOGLE_CLIENT_EMAIL manquante dans les variables d'environnement.");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: getPrivateKey(),
    scopes: env.scopes,
  });

  await auth.authorize();
  return auth;
}

module.exports = { getAuth };