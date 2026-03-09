// calendar.js
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// 🔥 CORRECTION ICI (remonte à la racine)
const CREDENTIALS_PATH = path.join(__dirname, "../../credentials.json");
const TOKEN_PATH = path.join(__dirname, "../../token.json");

const CALENDAR_ID = "primary"; // ton agenda principal

function loadSavedCredentialsIfExist() {
  try {
    const content = fs.readFileSync(TOKEN_PATH, "utf8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

function saveCredentials(client) {
  const content = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  const keys = JSON.parse(content);

  const key = keys.installed || keys.web;
  if (!key) throw new Error("credentials.json invalide (installed/web introuvable).");

  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });

  fs.writeFileSync(TOKEN_PATH, payload);
}

async function authorize() {
  let client = loadSavedCredentialsIfExist();
  if (client) return client;

  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client?.credentials?.refresh_token) {
    saveCredentials(client);
  }

  return client;
}

async function createEvent(calendar) {
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const event = {
    summary: "TEST - RDV Kiné (création)",
    description: "Événement créé par calendar.js",
    start: { dateTime: start.toISOString(), timeZone: "Europe/Paris" },
    end: { dateTime: end.toISOString(), timeZone: "Europe/Paris" },
  };

  const res = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
  });

  console.log("✅ Créé :", res.data.id);
  return res.data.id;
}

async function updateEvent(calendar, eventId) {
  const resGet = await calendar.events.get({
    calendarId: CALENDAR_ID,
    eventId,
  });

  const ev = resGet.data;
  ev.summary = "TEST - RDV Kiné (modifié)";
  ev.description = (ev.description || "") + "\n\nModifié par calendar.js";

  const resUp = await calendar.events.update({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: ev,
  });

  console.log("✏️ Modifié :", resUp.data.id);
}

async function deleteEvent(calendar, eventId) {
  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId,
  });
  console.log("🗑️ Supprimé :", eventId);
}

/*
(async () => {
  try {
    const auth = await authorize();
    const calendar = google.calendar({ version: "v3", auth });

    const eventId = await createEvent(calendar);
    await updateEvent(calendar, eventId);
    await deleteEvent(calendar, eventId);

    console.log("🎉 Test terminé (create → update → delete)");
  } catch (e) {
    console.error("❌ Erreur:", e.message || e);
    console.error(e);
  }
})();
*/