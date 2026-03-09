// src/services/calendar.service.js
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");
require("dotenv").config();

const TIMEZONE = process.env.TZ || "Europe/Paris";
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

const WORK_START = process.env.WORK_START || "09:00";
const WORK_END = process.env.WORK_END || "18:00";
const LUNCH_START = process.env.LUNCH_START || "12:00";
const LUNCH_END = process.env.LUNCH_END || "14:00";

const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 30);
const MIN_LEAD_MINUTES = Number(process.env.MIN_LEAD_MINUTES || 60);

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// credentials.json + token.json à la RACINE du projet
const CREDENTIALS_PATH = path.join(__dirname, "../../credentials.json");
const TOKEN_PATH = path.join(__dirname, "../../token.json");

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function loadSavedCredentialsIfExist() {
  try {
    const content = fs.readFileSync(TOKEN_PATH, "utf8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
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

async function calendarClient() {
  const auth = await authorize();
  return google.calendar({ version: "v3", auth });
}

async function getBusyIntervals(cal, timeMinISO, timeMaxISO) {
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      timeZone: TIMEZONE,
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busy = res.data?.calendars?.[CALENDAR_ID]?.busy || [];
  return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

/**
 * Dispos sur 1 JOUR
 * dateISO = "YYYY-MM-DD"
 */
async function findAvailableSlots({ dateISO, limit = 3, slotMinutes = SLOT_MINUTES }) {
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error(`dateISO invalide: "${dateISO}" (attendu YYYY-MM-DD)`);
  }

  const cal = await calendarClient();

  const workStartM = toMinutes(WORK_START);
  const workEndM = toMinutes(WORK_END);
  const lunchStartM = toMinutes(LUNCH_START);
  const lunchEndM = toMinutes(LUNCH_END);

  const day = new Date(`${dateISO}T00:00:00`);

  const timeMin = new Date(day);
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(day);
  timeMax.setHours(23, 59, 59, 999);

  const busy = await getBusyIntervals(cal, timeMin.toISOString(), timeMax.toISOString());

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMinutes(cutoff.getMinutes() + MIN_LEAD_MINUTES);

  const slots = [];

  for (let t = workStartM; t + slotMinutes <= workEndM; t += slotMinutes) {
    // skip pause midi
    if (t < lunchEndM && t + slotMinutes > lunchStartM) continue;

    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(t);

    const end = new Date(day);
    end.setHours(0, 0, 0, 0);
    end.setMinutes(t + slotMinutes);

    if (start < cutoff) continue;

    const isBusy = busy.some((b) => overlaps(start, end, b.start, b.end));
    if (!isBusy) {
      const readable = start.toLocaleString("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      });

      slots.push({
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        readable,
      });

      if (slots.length >= limit) break;
    }
  }

  return slots;
}

/**
 * Suggest sur 7 jours -> retourne 2 créneaux (obligatoire)
 */
async function suggestTwoSlotsNext7Days() {
  const collected = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
const dateISO = d.toLocaleDateString("en-CA");
    
const daySlots = await findAvailableSlots({ dateISO, limit: 2 });
    if (Array.isArray(daySlots) && daySlots.length) {
      collected.push(...daySlots);
    }
    if (collected.length >= 2) break;
  }

  if (!collected.length) {
    return {
      speech:
        "Je n’ai pas de créneau disponible sur les 7 prochains jours. Souhaitez-vous que je regarde la semaine suivante ?",
      slots: [],
    };
  }

  const a = collected[0];
  const b = collected[1] || collected[0];

  return {
    speech: `Je peux vous proposer ${a.readable} ou ${b.readable}. Lequel vous convient ?`,
    slots: [a, b],
  };
}

async function isSlotStillFree({ startISO, endISO }) {
  const cal = await calendarClient();

  // Freebusy sur exactement le créneau
  const busy = await getBusyIntervals(cal, startISO, endISO);

  // Si ça renvoie un busy qui chevauche, c'est plus libre
  const start = new Date(startISO);
  const end = new Date(endISO);

  const blocked = busy.some((b) => overlaps(start, end, b.start, b.end));
  return !blocked;
}

async function createEventForSlot({ startISO, endISO }, { summary, description } = {}) {
  const cal = await calendarClient();

  const event = {
    summary: summary || "RDV Kiné",
    description: description || "",
    start: { dateTime: startISO, timeZone: TIMEZONE },
    end: { dateTime: endISO, timeZone: TIMEZONE },
  };

  const res = await cal.events.insert({
calendarId: env.calendarId || "primary", 
   requestBody: event,
  });

  return res.data; // contient id, htmlLink, etc.
}

// ✅ Re-vérifie si un créneau est toujours libre (anti-conflit)
async function isSlotStillFree(slot) {
  const cal = await calendarClient();

  const startISO = slot.startISO;
  const endISO = slot.endISO;

  const busy = await getBusyIntervals(cal, startISO, endISO);

  const start = new Date(startISO);
  const end = new Date(endISO);

  const blocked = busy.some((b) => overlaps(start, end, b.start, b.end));
  return !blocked;
}

// ✅ Crée l’événement Google Calendar pour un créneau choisi
async function createEventForSlot(slot, { summary, description } = {}) {
  const cal = await calendarClient();

  const event = {
    summary: summary || "RDV Kiné",
    description: description || "",
    start: { dateTime: slot.startISO, timeZone: env.timezone || "Europe/Paris" },
    end: { dateTime: slot.endISO, timeZone: env.timezone || "Europe/Paris" },
  };

  const res = await cal.events.insert({
    calendarId: CALENDAR_ID || "primary",
    requestBody: event,
  });

  return res.data;
}

module.exports = {
  findAvailableSlots,
  suggestTwoSlotsNext7Days,
  isSlotStillFree,
  createEventForSlot,
};