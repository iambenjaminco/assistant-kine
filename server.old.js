console.log("✅ server.js exécuté");
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { bookAppointmentSafe, suggestTwoSlotsFromDate } = require("./src/services/calendar");// ✅ Google Calendar (ajout)
const { PHRASES } = require("./phrases");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const calendarRoutes = require("./src/routes/calendar.routes");
app.use("/api/calendar", calendarRoutes);

// ✅ IMPORTANT : tu as déjà tes routes dans ce fichier,
// donc on SUPPRIME twilioRoutes (sinon doublon)
// const twilioRoutes = require("./src/routes/twilio.routes");
// app.use("/twilio", twilioRoutes);

// =====================
// CONFIG CABINET (EDIT)
// =====================
const CONFIG = {
  cabinetName: 'Cabinet "..."',
  language: "fr-FR",

  // Voix Twilio la plus naturelle possible (si Polly.Celine ne marche pas -> "alice")
  twilioVoice: "Polly.Celine",

  infos: {
    address: "Adresse du cabinet, Ville",
    hours: "Lundi au vendredi, 8h à 18h30",
    documents: "Ordonnance, carte Vitale, mutuelle",
  },

  openDays: [1, 2, 3, 4, 5], // Lun-Ven
  openingHours: { start: "08:00", end: "18:30" },

  practitioners: [
    { id: "1", name: "Praticien 1" },
    { id: "2", name: "Praticien 2" },
    { id: "3", name: "Praticien 3" },
  ],

  maxNoInput: 2,
  maxNoMatch: 2,

  enableSms: Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_SMS_FROM
  ),

  storageDir: path.join(__dirname, "data"),
  sessionsFile: path.join(__dirname, "data", "sessions.json"),
  apptsFile: path.join(__dirname, "data", "appointments.json"),
  priorityFile: path.join(__dirname, "data", "priority_requests.json"),

  messages: {
    greet1: "Bonjour, vous êtes bien au ",
    greet2: "Nous sommes actuellement en consultation.",
    greet3: "Je peux vous aider à prendre, modifier ou annuler un rendez-vous.",
    askIntent: "Comment puis-je vous aider ?",
    clarifyIntent:
      "D'accord. Vous souhaitez prendre un rendez-vous, modifier un rendez-vous, annuler, ou obtenir une information ?",

    fallback: "Désolé, je n'ai pas bien compris.",
    beShort: "Merci de répondre en une phrase courte, s’il vous plaît.",
    goodbye: "Au revoir.",

    urgent15:
      "Si vous avez une douleur aiguë ou une situation urgente, contactez immédiatement le 15. " +
      "Je peux aussi transmettre votre demande au cabinet en priorité.",

    humanCallback:
      "Votre demande va être transmise. Un membre de l’équipe vous rappellera dès que possible.",

    technical:
      "Désolé, l’agenda est momentanément indisponible. Je peux transmettre votre demande au cabinet pour rappel.",

    cancelTooLate:
      "Désolé, je ne peux pas annuler ce rendez-vous à moins de 24 heures. Merci de contacter le cabinet.",
  },
};

// Durée RDV (pour Google Calendar)
const APPOINTMENT_DURATION_MINUTES = 30;

// =====================
// Storage
// =====================
function ensureStorage() {
  if (!fs.existsSync(CONFIG.storageDir)) fs.mkdirSync(CONFIG.storageDir);
  if (!fs.existsSync(CONFIG.sessionsFile)) fs.writeFileSync(CONFIG.sessionsFile, JSON.stringify({}), "utf8");
  if (!fs.existsSync(CONFIG.apptsFile)) fs.writeFileSync(CONFIG.apptsFile, JSON.stringify([]), "utf8");
  if (!fs.existsSync(CONFIG.priorityFile)) fs.writeFileSync(CONFIG.priorityFile, JSON.stringify([]), "utf8");
}
function loadJson(file, fallback) {
  ensureStorage();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  ensureStorage();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function getSession(callSid) {
  const sessions = loadJson(CONFIG.sessionsFile, {});
  if (!sessions[callSid]) {
    sessions[callSid] = {
      step: "ASK_INTENT",
      flow: null, // BOOK | MODIFY | CANCEL | INFO | URGENT | CALLBACK
      data: {},
      noInput: 0,
      noMatch: 0,

      lastPrompt: null,
      lastQuestion: null,
      history: [],

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveJson(CONFIG.sessionsFile, sessions);
  }
  return sessions[callSid];
}
function setSession(callSid, session) {
  const sessions = loadJson(CONFIG.sessionsFile, {});
  sessions[callSid] = { ...session, updatedAt: new Date().toISOString() };
  saveJson(CONFIG.sessionsFile, sessions);
  return sessions[callSid];
}
function clearSession(callSid) {
  const sessions = loadJson(CONFIG.sessionsFile, {});
  delete sessions[callSid];
  saveJson(CONFIG.sessionsFile, sessions);
}
function loadAppointmentsSafe() {
  try {
    return loadJson(CONFIG.apptsFile, []);
  } catch {
    throw new Error("AGENDA_UNAVAILABLE");
  }
}
function saveAppointments(appts) {
  saveJson(CONFIG.apptsFile, appts);
}
function savePriorityRequest(payload) {
  const list = loadJson(CONFIG.priorityFile, []);
  list.push(payload);
  saveJson(CONFIG.priorityFile, list);
}

// =====================
// TwiML helpers
// =====================
function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
function say(text) {
  return `<Say voice="${CONFIG.twilioVoice}" language="${CONFIG.language}">${escapeXml(text)}</Say>`;
}
function hangup() {
  return `<Hangup/>`;
}
function redirect(url) {
  return `<Redirect method="POST">${escapeXml(url)}</Redirect>`;
}
function gather({ action, content, hints = "", timeout = 7, allowDtmf = true, allowSpeech = true }) {
  const input = [allowSpeech ? "speech" : null, allowDtmf ? "dtmf" : null].filter(Boolean).join(" ");

  const attrs = [
    `action="${escapeXml(action)}"`,
    `method="POST"`,
    `timeout="${timeout}"`,
    `speechTimeout="auto"`,
    `actionOnEmptyResult="true"`,
    `language="${CONFIG.language}"`,
    `speechModel="phone_call"`,
    `enhanced="true"`,
    input ? `input="${input}"` : "",
    hints ? `hints="${escapeXml(hints)}"` : "",
  ].filter(Boolean).join(" ");

  return `<Gather ${attrs}>${content}</Gather>`;
}
function userInput(req) {
  return {
    digits: (req.body.Digits || "").trim(),
    speech: (req.body.SpeechResult || "").trim(),
    from: (req.body.From || "").trim(),
  };
}
function norm(s) {
  return (s || "").toLowerCase().trim();
}
function tooLongSpeech(s) {
  return (s || "").length > 240;
}

// Prononciation FR des heures
function formatTimeFr(hhmm) {
  const [hStr, mStr] = String(hhmm).split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  if (m === 0) return `${h} heures`;
  if (m === 15) return `${h} heures 15`;
  if (m === 30) return `${h} heures 30`;
  if (m === 45) return `${h} heures 45`;
  return `${h} heures ${m}`;
}

// Noms des praticiens en phrase, pas en liste
function practitionersSpoken() {
  const names = CONFIG.practitioners.map((p) => p.name);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ou ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ou ${names[names.length - 1]}`;
}

// Fin de session: toujours dire au revoir
function endSession(callSid, text) {
  clearSession(callSid);
  const msg = text ? `${text} ${CONFIG.messages.goodbye}` : CONFIG.messages.goodbye;
  return twiml(say(msg) + hangup());
}

// =====================
// Repeat / Back
// =====================
function detectRepeatIntent({ digits, speech }) {
  const t = norm(speech);
  return digits === "9" || ["répète", "repete", "répéter", "repeter", "redis", "encore"].some((w) => t.includes(w));
}
function detectBackIntent({ digits, speech }) {
  const t = norm(speech);
  return digits === "0" || ["retour", "revenir", "reviens", "menu", "précédent", "precedent", "changer"].some((w) => t.includes(w));
}
function ask(callSid, session, text, opts) {
  session.lastPrompt = text;
  session.lastQuestion = text; // IMPORTANT: c’est ça que "répète" renvoie
  session = setSession(callSid, session);
  return twiml(gather({ ...opts, content: say(text) }) + redirect("/noinput"));
}
function pushHistory(session) {
  session.history = session.history || [];
  session.history.push({
    flow: session.flow,
    step: session.step,
    data: JSON.parse(JSON.stringify(session.data || {})),
    lastPrompt: session.lastPrompt || null,
    lastQuestion: session.lastQuestion || null,
  });
  if (session.history.length > 30) session.history.shift();
  return session;
}
function popHistory(session) {
  session.history = session.history || [];
  const prev = session.history.pop();
  if (!prev) return null;
  session.flow = prev.flow;
  session.step = prev.step;
  session.data = prev.data;
  session.lastPrompt = prev.lastPrompt;
  session.lastQuestion = prev.lastQuestion;
  return session;
}

// =====================
// Intent helpers
// =====================
function isYes({ digits, speech }) {
  if (digits === "1") return true;

  const t = (speech || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // enlève accents
    .replace(/[^a-z0-9\s]/g, " ") // enlève ponctuation
    .replace(/\s+/g, " ")
    .trim();

  const positives = [
    "oui",
    "ouais",
    "yes",
    "ok",
    "okay",
    "daccord",
    "je confirme",
    "confirme",
    "cest ca",
    "c est ca",
    "exact"
  ];

  return positives.some(word => t.includes(word));
}
function isNo({ digits, speech }) {
  if (digits === "2") return true;

  const t = (speech || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const negatives = [
    "non",
    "no",
    "pas du tout",
    "annule",
    "stop"
  ];

  return negatives.some(word => t.includes(word));
}
function parsePhone({ digits, speech, from }) {
  const raw = (from && from.startsWith("+") ? from : (digits || speech || "")).toString();

  // garde que chiffres et +
  const cleaned = raw.replace(/[^\d+]/g, "");

  // formats acceptés:
  // +33XXXXXXXXX (>= 11 chars avec +)
  // 0XXXXXXXXX (10 chiffres FR)
  // ou au moins 8 chiffres si international / autre
  const onlyDigits = cleaned.replace(/\D/g, "");

  // si c'est juste "oui/non" => reject
  const t = norm(raw);
  if (["oui", "non", "ok", "daccord", "d'accord"].includes(t)) return null;

  if (cleaned.startsWith("+") && onlyDigits.length >= 11) return cleaned; // ex +336...
  if (!cleaned.startsWith("+") && onlyDigits.length === 10) return onlyDigits; // ex 0612...
  if (onlyDigits.length >= 8) return onlyDigits;

  return null;
}
function detectUrgency(text) {
  const t = norm(text);
  const keywords = ["urgence", "urgent", "douleur aigu", "insupportable", "accident", "trauma", "fracture", "saigne"];
  return t && keywords.some((k) => t.includes(k));
}
function detectInfoIntent(text) {
  const t = norm(text);
  return ["horaires", "horaire", "adresse", "documents", "ordonnance", "où", "localisation"].some((k) => t.includes(k));
}
function detectBookingIntent(text) {
  const t = norm(text);
  return ["prendre", "rendez", "rdv", "consultation", "disponibilit", "créneau", "creneau", "réserver", "reserver"].some((k) => t.includes(k));
}
function detectModifyIntent(text) {
  const t = norm(text);
  return ["modifier", "déplacer", "deplacer", "changer", "reporter", "décaler", "decaler"].some((k) => t.includes(k));
}
function detectCancelIntent(text) {
  const t = norm(text);
  return ["annuler", "annulation", "supprimer"].some((k) => t.includes(k));
}

// =====================
// Date / slots (proto)
// =====================
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function isSlotWithinHours(time) {
  const m = timeToMinutes(time);
  return m >= timeToMinutes(CONFIG.openingHours.start) && m <= timeToMinutes(CONFIG.openingHours.end);
}
function extractDayName(text) {
  const t = norm(text);
  const days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  return days.find((d) => t.includes(d)) || null;
}
function isOpenDayName(dayName) {
  const map = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
  const d = map[dayName];
  return typeof d === "number" && CONFIG.openDays.includes(d);
}
function nextDateForDayName(dayName) {
  const map = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
  const target = map[dayName];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    if (d.getDay() === target) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function isoDateTime(dateYmd, timeHHmm) {
  return `${dateYmd}T${timeHHmm}:00`;
}
function hoursUntil(isoDt) {
  const now = new Date();
  const dt = new Date(isoDt);
  return (dt.getTime() - now.getTime()) / (1000 * 60 * 60);
}
function getSlotCandidates(dayName) {
  const start = timeToMinutes(CONFIG.openingHours.start);
  const end = timeToMinutes(CONFIG.openingHours.end);

  const step = APPOINTMENT_DURATION_MINUTES; // 30 minutes
  const toTime = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  const slots = [];
  for (let t = start; t + APPOINTMENT_DURATION_MINUTES <= end; t += step) {
    slots.push({ dayName, time: toTime(t) });
  }

  return slots;
}
function isSlotFree(appts, practitionerId, dateYmd, time) {
  return !appts.some((a) => a.practitionerId === practitionerId && a.dateYmd === dateYmd && a.time === time);
}
function pickUpToTwoFreeSlots(appts, practitionerId, dayName) {
  const dateYmd = nextDateForDayName(dayName);
  const candidates = getSlotCandidates(dayName);
  const free = candidates.filter((s) => isSlotFree(appts, practitionerId, dateYmd, s.time));
  return { dateYmd, slots: free.slice(0, 2) };
}

// =====================
// Optional SMS (no SDK)
// =====================
function sendSms(to, body) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.enableSms) return resolve({ skipped: true });

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_SMS_FROM;

    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const postData = new URLSearchParams({ To: to, From: from, Body: body }).toString();

    const req = https.request(
      {
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${sid}/Messages.json`,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
          else reject(new Error(`SMS failed ${res.statusCode}: ${data}`));
        });
      }
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// =====================
// ROUTES
// =====================
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  let session = getSession(callSid);

  session.step = "ASK_INTENT";
  session.flow = null;
  session.data = {};
  session.noInput = 0;
  session.noMatch = 0;
  session.history = [];
  session.lastPrompt = null;

  // IMPORTANT: lastQuestion doit être la QUESTION, pas l'accueil
  session.lastQuestion = CONFIG.messages.askIntent;
  session = setSession(callSid, session);

  const response = twiml(
    say(`${CONFIG.messages.greet1}${CONFIG.cabinetName}.`) +
      say(CONFIG.messages.greet2) +
      say(CONFIG.messages.greet3) +
      gather({
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        hints: "rendez-vous, prendre, modifier, annuler, horaires, adresse, documents, urgence",
        timeout: 8,
        content: say(CONFIG.messages.askIntent),
      }) +
      redirect("/noinput")
  );

  res.type("text/xml").send(response);
});

app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  let session = getSession(callSid);
  const input = userInput(req);

  // Global: répète -> répète la dernière QUESTION utile
  if (detectRepeatIntent(input)) {
    const prompt = session.lastQuestion || "D'accord. Pouvez-vous répéter votre demande ?";
    return res.type("text/xml").send(
      ask(callSid, session, prompt, {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        timeout: 7,
      })
    );
  }

  // Global: retour/menu
  if (detectBackIntent(input)) {
    const back = popHistory(session);
    if (!back) return res.type("text/xml").send(twiml(redirect("/voice")));
    session = setSession(callSid, back);
    const prompt = session.lastQuestion || CONFIG.messages.askIntent;
    return res.type("text/xml").send(
      ask(callSid, session, prompt, { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
    );
  }

  // Silence / rien compris côté reco
  if (!input.digits && !input.speech) return res.type("text/xml").send(twiml(redirect("/noinput")));
  if (tooLongSpeech(input.speech)) return res.type("text/xml").send(twiml(say(CONFIG.messages.beShort) + redirect("/voice")));

  // Urgence à tout moment
  if (detectUrgency(input.speech) && session.flow !== "URGENT") {
    session = pushHistory(session);
    session.flow = "URGENT";
    session.step = "URGENT_NAME";
    session.data = {};
    session = setSession(callSid, session);

    const q = `${CONFIG.messages.urgent15} Dites votre nom et prénom.`;
    return res.type("text/xml").send(
      ask(callSid, session, q, { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
    );
  }

  // =====================
  // INTENT: ASK_INTENT
  // =====================
  if (session.step === "ASK_INTENT") {
    const s = norm(input.speech);
    const d = input.digits;

    const wantsInfo = d === "4" || detectInfoIntent(s);
    const wantsCancel = d === "3" || detectCancelIntent(s);
    const wantsModify = d === "2" || detectModifyIntent(s);
    const wantsBook = d === "1" || detectBookingIntent(s);

    if (wantsInfo) {
      session = pushHistory(session);
      session.flow = "INFO";
      session.step = "INFO_CHOICE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Vous voulez l’adresse, les horaires, ou les documents à apporter ?", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: true,
          timeout: 7,
        })
      );
    }

    if (wantsCancel) {
      session = pushHistory(session);
      session.flow = "CANCEL";
      session.step = "CANCEL_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "D'accord. Quel est votre nom et prénom ?", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: false,
          timeout: 7,
        })
      );
    }

    if (wantsModify) {
      session = pushHistory(session);
      session.flow = "MODIFY";
      session.step = "MODIFY_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "D'accord. Quel est votre nom et prénom ?", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: false,
          timeout: 7,
        })
      );
    }

    if (wantsBook) {
      session = pushHistory(session);
      session.flow = "BOOK";
      session.step = "BOOK_EXISTING";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Très bien. Êtes-vous déjà patient du cabinet ?", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: true,
          hints: "oui, non",
          timeout: 7,
        })
      );
    }

    // pas clair -> clarifier / puis humain si ça boucle
    session.noMatch = (session.noMatch || 0) + 1;
    session = setSession(callSid, session);

    if (session.noMatch > 1) {
      session = pushHistory(session);
      session.flow = "CALLBACK";
      session.step = "CALLBACK_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "D'accord. Dites votre nom et prénom, et le cabinet vous rappellera.", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: false,
          timeout: 7,
        })
      );
    }

    return res.type("text/xml").send(
      ask(callSid, session, CONFIG.messages.clarifyIntent, {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        timeout: 7,
      })
    );
  }

  // =====================
  // INFO
  // =====================
  if (session.flow === "INFO") {
    const s = norm(input.speech);

    if (s.includes("horaire") || input.digits === "1") {
      return res.type("text/xml").send(endSession(callSid, `Horaires : ${CONFIG.infos.hours}.`));
    }
    if (s.includes("adresse") || s.includes("où") || input.digits === "2") {
      return res.type("text/xml").send(endSession(callSid, `Adresse : ${CONFIG.infos.address}.`));
    }
    if (s.includes("document") || s.includes("ordonnance") || input.digits === "3") {
      return res.type("text/xml").send(endSession(callSid, `Documents : ${CONFIG.infos.documents}.`));
    }

    return res.type("text/xml").send(
      ask(callSid, session, "Vous préférez l’adresse, les horaires, ou les documents ?", {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        timeout: 7,
      })
    );
  }

  // =====================
  // URGENT
  // =====================
  if (session.flow === "URGENT") {
    if (session.step === "URGENT_NAME") {
      const name = input.speech.trim();
      if (!name || name.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Dites votre nom et prénom.", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }
      session = pushHistory(session);
      session.data.fullName = name;
      session.step = "URGENT_PHONE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Merci. Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "URGENT_PHONE") {
      const phone = parsePhone(input);
      if (!phone) {
        return res.type("text/xml").send(
          ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }
      session = pushHistory(session);
      session.data.phone = phone;
      session.step = "URGENT_REASON";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "En une phrase courte, quel est le motif ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "URGENT_REASON") {
      const reason = input.speech.trim();
      if (!reason || reason.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel est le motif ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      savePriorityRequest({
        type: "URGENT",
        createdAt: new Date().toISOString(),
        fullName: session.data.fullName,
        phone: session.data.phone,
        reason,
      });

      return res.type("text/xml").send(endSession(callSid, CONFIG.messages.humanCallback));
    }
  }

  // =====================
  // CALLBACK
  // =====================
  if (session.flow === "CALLBACK") {
    if (session.step === "CALLBACK_NAME") {
      const name = input.speech.trim();
      if (!name || name.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Dites votre nom et prénom.", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }
      session = pushHistory(session);
      session.data.fullName = name;
      session.step = "CALLBACK_PHONE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "CALLBACK_PHONE") {
      const phone = parsePhone(input);
      if (!phone) {
        return res.type("text/xml").send(
          ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }
      session = pushHistory(session);
      session.data.phone = phone;
      session.step = "CALLBACK_REASON";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "En une phrase courte, quelle est votre demande ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "CALLBACK_REASON") {
      const reason = input.speech.trim();
      if (!reason || reason.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quelle est votre demande ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      savePriorityRequest({
        type: "CALLBACK",
        createdAt: new Date().toISOString(),
        fullName: session.data.fullName,
        phone: session.data.phone,
        reason,
      });

      return res.type("text/xml").send(endSession(callSid, CONFIG.messages.humanCallback));
    }
  }

  // =====================
  // BOOK
  // =====================
  if (session.flow === "BOOK") {
    let appts;
    try {
      appts = loadAppointmentsSafe();
    } catch {
      session = pushHistory(session);
      session.flow = "CALLBACK";
      session.step = "CALLBACK_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, `${CONFIG.messages.technical} Dites votre nom et prénom.`, {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: false,
          timeout: 7,
        })
      );
    }

    if (session.step === "BOOK_EXISTING") {
      const yes = isYes(input);
      const no = isNo(input);
      if (!yes && !no) {
        return res.type("text/xml").send(
          ask(callSid, session, "Vous êtes déjà patient du cabinet ?", { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.isExisting = yes;
      session.step = yes ? "BOOK_PRACTITIONER" : "BOOK_ORDO";
      session = setSession(callSid, session);

      if (!yes) {
        return res.type("text/xml").send(
          ask(callSid, session, "Avez-vous une ordonnance ?", { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
        );
      }

      return res.type("text/xml").send(
        ask(callSid, session, `Quel praticien souhaitez-vous ? ${practitionersSpoken()}.`, { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "BOOK_ORDO") {
      const yes = isYes(input);
      const no = isNo(input);
      if (!yes && !no) {
        return res.type("text/xml").send(
          ask(callSid, session, "Avez-vous une ordonnance ?", { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.hasOrdo = yes;
      session.step = "BOOK_PRACTITIONER";
      session = setSession(callSid, session);

      const prefix = no ? "Sans ordonnance, le cabinet pourra vous indiquer la marche à suivre. " : "";
      return res.type("text/xml").send(
        ask(callSid, session, `${prefix}Quel praticien souhaitez-vous ? ${practitionersSpoken()}.`, { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "BOOK_PRACTITIONER") {
      const s = norm(input.speech);

      let chosen = null;
      if (input.digits) chosen = CONFIG.practitioners.find((p) => p.id === input.digits) || null;
      if (!chosen) chosen = CONFIG.practitioners.find((p) => s.includes(norm(p.name))) || null;
      if (!chosen) {
        if (s.includes("premier")) chosen = CONFIG.practitioners[0];
        if (s.includes("deuxième") || s.includes("deuxieme")) chosen = CONFIG.practitioners[1];
        if (s.includes("troisième") || s.includes("troisieme")) chosen = CONFIG.practitioners[2];
      }

      if (!chosen) {
        return res.type("text/xml").send(
          ask(callSid, session, `Je n'ai pas identifié le praticien. Lequel souhaitez-vous ? ${practitionersSpoken()}.`, {
            action: "/gather",
            allowSpeech: true,
            allowDtmf: true,
            timeout: 7,
          })
        );
      }

      session = pushHistory(session);
      session.data.practitionerId = chosen.id;
      session.data.practitionerName = chosen.name;
      session.step = "BOOK_DAY";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Quel jour souhaitez-vous ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "BOOK_DAY") {
      const day = extractDayName(input.speech);
      if (!day) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel jour souhaitez-vous ? Par exemple lundi ou mardi.", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }
      if (!isOpenDayName(day)) {
        return res.type("text/xml").send(
          ask(callSid, session, `Le cabinet n'est pas ouvert le ${day}. Quel autre jour ?`, { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      const { dateYmd, slots } = pickUpToTwoFreeSlots(appts, session.data.practitionerId, day);
      if (slots.length === 0) {
        session = pushHistory(session);
        session.step = "BOOK_ALTS";
        session.data.dayName = day;
        session.data.dateYmd = dateYmd;
        session = setSession(callSid, session);

        return res.type("text/xml").send(
          ask(callSid, session, `La journée de ${day} est complète. Vous préférez un autre jour ou un autre praticien ?`, {
            action: "/gather",
            allowSpeech: true,
            allowDtmf: true,
            timeout: 7,
          })
        );
      }

      session = pushHistory(session);
      session.data.dayName = day;
      session.data.dateYmd = dateYmd;
      session.data.proposed = slots;
      session.step = "BOOK_PICK_SLOT";
      session = setSession(callSid, session);

      const ord = ["Premier", "Deuxième"];
      const slotText = slots
        .map((slt, i) => `${ord[i] || "Créneau"} : ${slt.dayName} à ${formatTimeFr(slt.time)}`)
        .join(". ");

      return res.type("text/xml").send(
        ask(callSid, session, `Je vous propose ${slotText}. Lequel vous convient ?`, {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: true,
          timeout: 7,
        })
      );
    }

    if (session.step === "BOOK_ALTS") {
      const s = norm(input.speech);
      if (input.digits === "1" || s.includes("jour")) {
        session = pushHistory(session);
        session.step = "BOOK_DAY";
        session = setSession(callSid, session);
        return res.type("text/xml").send(
          ask(callSid, session, "Quel autre jour souhaitez-vous ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }
      if (input.digits === "2" || s.includes("praticien")) {
        session = pushHistory(session);
        session.step = "BOOK_PRACTITIONER";
        session = setSession(callSid, session);
        return res.type("text/xml").send(
          ask(callSid, session, `Quel autre praticien ? ${practitionersSpoken()}.`, { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      return res.type("text/xml").send(
        ask(callSid, session, "Vous préférez un autre jour ou un autre praticien ?", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "BOOK_PICK_SLOT") {
      const list = session.data.proposed || [];
      const s = norm(input.speech);

      let idx = null;
      if (input.digits) idx = parseInt(input.digits, 10) - 1;
      if (idx === null || Number.isNaN(idx)) {
        if (s.includes("premier")) idx = 0;
        if (s.includes("deuxième") || s.includes("deuxieme")) idx = 1;
      }
      if (idx === null || idx < 0 || idx >= list.length) {
        return res.type("text/xml").send(
          ask(callSid, session, "Lequel vous convient ?", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      const picked = list[idx];

      if (!isSlotFree(appts, session.data.practitionerId, session.data.dateYmd, picked.time)) {
        session = pushHistory(session);
        session.step = "BOOK_DAY";
        session = setSession(callSid, session);
        return res.type("text/xml").send(
          ask(callSid, session, "Désolé, ce créneau vient d'être pris. Quel autre jour souhaitez-vous ?", {
            action: "/gather",
            allowSpeech: true,
            allowDtmf: false,
            timeout: 7,
          })
        );
      }

      session = pushHistory(session);
      session.data.time = picked.time;
      session.step = "BOOK_NAME";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Quel est votre nom et prénom ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "BOOK_NAME") {
      const name = input.speech.trim();
      if (!name || name.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel est votre nom et prénom ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.fullName = name;
      session.step = "BOOK_PHONE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "BOOK_PHONE") {
      const phone = parsePhone(input);
      if (!phone) {
        return res.type("text/xml").send(
          ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.phone = phone;
      session.step = "BOOK_CONFIRM";
      session = setSession(callSid, session);

      const recap =
        `Je confirme : rendez-vous avec ${session.data.practitionerName}, ` +
        `le ${session.data.dayName} à ${formatTimeFr(session.data.time)}. ` +
        `Pour ${session.data.fullName}. C’est bien ça ?`;

      return res.type("text/xml").send(
        ask(callSid, session, recap, { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
      );
    }

    if (session.step === "BOOK_CONFIRM") {
      if (isNo(input)) {
        session = pushHistory(session);
        session.step = "BOOK_EXISTING";
        session.data = {};
        session = setSession(callSid, session);

        return res.type("text/xml").send(
          ask(callSid, session, "D'accord. Êtes-vous déjà patient du cabinet ?", { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
        );
      }

      // =====================
// BOOK_PICK_ALT
// =====================
if (session.step === "BOOK_PICK_ALT") {
const s = norm(input.speech || "");
  let idx = null;

  if (input.digits) idx = parseInt(input.digits, 10) - 1;

  if (idx === null || Number.isNaN(idx)) {
    if (s.includes("premier")) idx = 0;
    if (s.includes("deuxième") || s.includes("deuxieme")) idx = 1;
  }

  if (idx === null || idx < 0 || idx > 1) {
    return res.type("text/xml").send(
      ask(callSid, session, "Dites premier ou deuxième.", {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        hints: "premier, deuxième, 1, 2",
        timeout: 7,
      })
    );
  }

  const picked = idx === 0 ? session.data.alt1 : session.data.alt2;

  if (!picked || !picked.start || !picked.end) {
    return res.type("text/xml").send(
      endSession(callSid, "Désolé, je n’ai plus les créneaux en mémoire. Merci de rappeler.")
    );
  }

  try {
    const retry = await bookAppointmentSafe({
      calendarId: "primary",
      patientName: session.data.fullName,
      reason: "Rendez-vous kiné",
      startDate: new Date(picked.start),
      endDate: new Date(picked.end),
    });

    if (retry.ok) {
      return res.type("text/xml").send(
        endSession(callSid, "Parfait, votre rendez-vous est confirmé.")
      );
    }

    return res.type("text/xml").send(
      endSession(callSid, "Désolé, ces créneaux ne sont plus disponibles. Merci de rappeler le cabinet.")
    );

  } catch (err) {
    console.error("Erreur BOOK_PICK_ALT :", err);
    return res.type("text/xml").send(
      endSession(callSid, "Une erreur est survenue. Merci de rappeler le cabinet.")
    );
  }
}

      if (!isYes(input)) {
        return res.type("text/xml").send(
          ask(callSid, session, "C’est bien ça ?", { action: "/gather", allowSpeech: true, allowDtmf: true, hints: "oui, non", timeout: 7 })
        );
      }

      // re-check + blocage
      appts = loadAppointmentsSafe();
      if (!isSlotFree(appts, session.data.practitionerId, session.data.dateYmd, session.data.time)) {
        session = pushHistory(session);
        session.step = "BOOK_DAY";
        session = setSession(callSid, session);

        return res.type("text/xml").send(
          ask(callSid, session, "Désolé, ce créneau n'est plus disponible. Quel autre jour souhaitez-vous ?", {
            action: "/gather",
            allowSpeech: true,
            allowDtmf: false,
            timeout: 7,
          })
        );
      }

      const appt = {
        id: `apt_${Date.now()}`,
        fullName: session.data.fullName,
        phone: session.data.phone,
        practitionerId: session.data.practitionerId,
        practitionerName: session.data.practitionerName,
        dayName: session.data.dayName,
        dateYmd: session.data.dateYmd,
        time: session.data.time,
        isoDateTime: isoDateTime(session.data.dateYmd, session.data.time),
        createdAt: new Date().toISOString(),
      };

     appts.push(appt);
saveAppointments(appts);

console.log("➡️ RDV enregistré en local :", appt);

try {
  console.log("➡️ Tentative création Google Calendar...");

const result = await bookAppointmentSafe({
  calendarId: "primary",
  patientName: appt.fullName,
  reason: "Rendez-vous kiné",
  startDate: new Date(appt.isoDateTime),
  endDate: new Date(new Date(appt.isoDateTime).getTime() + 30 * 60000),
});

if (result.ok) {
  // ✅ IMPORTANT: n'enregistre en local QUE si Google a accepté
  appts.push(appt);
  saveAppointments(appts);

  // (optionnel) SMS
  try { await sendSms(appt.phone, `Confirmation ${CONFIG.cabinetName}: RDV avec ${appt.practitionerName} le ${appt.dayName} à ${formatTimeFr(appt.time)}.`); } catch {}

  return res.type("text/xml").send(
    endSession(callSid, "Parfait, votre rendez-vous est confirmé.")
  );
}

  // ❌ Sinon : créneau pris ou verrouillé
  const alternatives = await suggestTwoSlotsFromDate({
    calendarId: "primary",
    fromDate: appt.isoDateTime,
  });

if (alternatives.length >= 1) {
  const a = alternatives[0];
  const b = alternatives[1] || alternatives[0];

  const message =
    result.code === "LOCKED"
      ? "Ce créneau est en cours de réservation."
      : "Ce créneau vient d’être pris.";

  // ✅ on stocke les alternatives dans la session
  session = pushHistory(session);
  session.step = "BOOK_PICK_ALT";
  session.data.alt1 = a;
  session.data.alt2 = b;
  session = setSession(callSid, session);

  // ✅ Question + Gather (sinon il ne peut pas répondre)
  return res.type("text/xml").send(
    ask(
      callSid,
      session,
      `${message} Je peux vous proposer le premier créneau ou le deuxième. Lequel vous convient ?`,
      {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: true,
        hints: "premier, deuxième, 1, 2",
        timeout: 7,
      }
    )
  );
}

  // ❌ Aucun créneau dispo
  return res.type("text/xml").send(
    twiml(
     say(PHRASES.noAvailability) +
redirect("/voice")
    )
  );

} catch (err) {
  console.error("❌ Google Calendar ERROR :", err?.message || err);

  return res.type("text/xml").send(
    twiml(
     say(PHRASES.errorGeneric) +
redirect("/voice")
    )
  );
}

      // ✅ AJOUT : création Google Calendar (vrai event)
      try {
        const start = new Date(appt.isoDateTime);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + APPOINTMENT_DURATION_MINUTES);

        const created = await createAppointment({
          calendarId: "primary",
          patientName: appt.fullName,
          reason: `RDV avec ${appt.practitionerName}`,
          startDate: start,
          endDate: end,
        });

        // log utile
        console.log("Google Calendar event created:", created?.htmlLink || created?.id || "(no link)");
      } catch (e) {
        console.error("Google Calendar createAppointment error:", e?.message || e);
      }

      const smsText = `Confirmation ${CONFIG.cabinetName}: RDV avec ${appt.practitionerName} le ${appt.dayName} à ${formatTimeFr(appt.time)}.`;
      try {
        await sendSms(appt.phone, smsText);
      } catch {}

      return res.type("text/xml").send(endSession(callSid, "Parfait, c’est confirmé."));
    }
  }

  // =====================
  // MODIFY
  // =====================
  if (session.flow === "MODIFY") {
    let appts;
    try {
      appts = loadAppointmentsSafe();
    } catch {
      session = pushHistory(session);
      session.flow = "CALLBACK";
      session.step = "CALLBACK_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, `${CONFIG.messages.technical} Dites votre nom et prénom.`, { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "MODIFY_NAME") {
      const name = input.speech.trim();
      if (!name || name.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel est votre nom et prénom ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.fullName = name;
      session.step = "MODIFY_PHONE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "MODIFY_PHONE") {
      const phone = parsePhone(input);
      if (!phone) {
        return res.type("text/xml").send(
          ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.phone = phone;

      const found = appts.find((a) => norm(a.fullName) === norm(session.data.fullName) && a.phone === session.data.phone);
      if (!found) {
        session = pushHistory(session);
        session.flow = "CALLBACK";
        session.step = "CALLBACK_NAME";
        session.data = {};
        session = setSession(callSid, session);

        return res.type("text/xml").send(
          ask(callSid, session, "Je ne retrouve pas ce rendez-vous. Dites votre nom et prénom pour être rappelé.", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      session.data.apptId = found.id;
      session.data.practitionerId = found.practitionerId;
      session.step = "MODIFY_DAY";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Quel nouveau jour souhaitez-vous ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "MODIFY_DAY") {
      const day = extractDayName(input.speech);
      if (!day || !isOpenDayName(day)) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel nouveau jour souhaitez-vous ? (lundi à vendredi)", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      const { dateYmd, slots } = pickUpToTwoFreeSlots(appts, session.data.practitionerId, day);
      if (slots.length === 0) {
        return res.type("text/xml").send(
          ask(callSid, session, `La journée de ${day} est complète. Quel autre jour ?`, { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.dayName = day;
      session.data.dateYmd = dateYmd;
      session.data.proposed = slots;
      session.step = "MODIFY_PICK";
      session = setSession(callSid, session);

      const ord = ["Premier", "Deuxième"];
      const slotText = slots
        .map((slt, i) => `${ord[i] || "Créneau"} : ${slt.dayName} à ${formatTimeFr(slt.time)}`)
        .join(". ");

      return res.type("text/xml").send(
        ask(callSid, session, `Je vous propose ${slotText}. Lequel ?`, { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "MODIFY_PICK") {
      const list = session.data.proposed || [];
      const s = norm(input.speech);

      let idx = null;
      if (input.digits) idx = parseInt(input.digits, 10) - 1;
      if (idx === null || Number.isNaN(idx)) {
        if (s.includes("premier")) idx = 0;
        if (s.includes("deuxième") || s.includes("deuxieme")) idx = 1;
      }
      if (idx === null || idx < 0 || idx >= list.length) {
        return res.type("text/xml").send(
          ask(callSid, session, "Lequel ?", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      const picked = list[idx];
      const idxAppt = appts.findIndex((a) => a.id === session.data.apptId);
      if (idxAppt === -1) {
        return res.type("text/xml").send(endSession(callSid, "Je ne retrouve plus ce rendez-vous."));
      }

      if (!isSlotFree(appts, appts[idxAppt].practitionerId, session.data.dateYmd, picked.time)) {
return res.type("text/xml").send(
  twiml(
    say(PHRASES.slotUnavailable) + redirect("/voice")
  )
);      }

      appts[idxAppt].dayName = session.data.dayName;
      appts[idxAppt].dateYmd = session.data.dateYmd;
      appts[idxAppt].time = picked.time;
      appts[idxAppt].isoDateTime = isoDateTime(session.data.dateYmd, picked.time);
      appts[idxAppt].updatedAt = new Date().toISOString();
      saveAppointments(appts);

      return res.type("text/xml").send(endSession(callSid, "C'est noté, votre rendez-vous est modifié."));
    }
  }

  // =====================
  // CANCEL
  // =====================
  if (session.flow === "CANCEL") {
    let appts;
    try {
      appts = loadAppointmentsSafe();
    } catch {
      session = pushHistory(session);
      session.flow = "CALLBACK";
      session.step = "CALLBACK_NAME";
      session.data = {};
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, `${CONFIG.messages.technical} Dites votre nom et prénom.`, { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
      );
    }

    if (session.step === "CANCEL_NAME") {
      const name = input.speech.trim();
      if (!name || name.length < 2) {
        return res.type("text/xml").send(
          ask(callSid, session, "Quel est votre nom et prénom ?", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.fullName = name;
      session.step = "CANCEL_PHONE";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
      );
    }

    if (session.step === "CANCEL_PHONE") {
      const phone = parsePhone(input);
      if (!phone) {
        return res.type("text/xml").send(
          ask(callSid, session, "Confirmez votre numéro de téléphone.", { action: "/gather", allowSpeech: true, allowDtmf: true, timeout: 7 })
        );
      }

      session = pushHistory(session);
      session.data.phone = phone;

      const found = appts.find((a) => norm(a.fullName) === norm(session.data.fullName) && a.phone === session.data.phone);
      if (!found) {
        session = pushHistory(session);
        session.flow = "CALLBACK";
        session.step = "CALLBACK_NAME";
        session.data = {};
        session = setSession(callSid, session);

        return res.type("text/xml").send(
          ask(callSid, session, "Je ne retrouve pas ce rendez-vous. Dites votre nom et prénom pour être rappelé.", { action: "/gather", allowSpeech: true, allowDtmf: false, timeout: 7 })
        );
      }

      const h = hoursUntil(found.isoDateTime);
      if (h <= 24) {
        return res.type("text/xml").send(endSession(callSid, CONFIG.messages.cancelTooLate));
      }

      session.data.apptId = found.id;
      session.step = "CANCEL_CONFIRM";
      session = setSession(callSid, session);

      return res.type("text/xml").send(
        ask(callSid, session, "D'accord. Je confirme l'annulation, c'est bien ça ?", {
          action: "/gather",
          allowSpeech: true,
          allowDtmf: true,
          hints: "oui, non",
          timeout: 7,
        })
      );
    }

    if (session.step === "CANCEL_CONFIRM") {
      if (!isYes(input)) {
        return res.type("text/xml").send(endSession(callSid, "Très bien."));
      }

      const idx = appts.findIndex((a) => a.id === session.data.apptId);
      if (idx !== -1) {
        appts.splice(idx, 1);
        saveAppointments(appts);
      }

      return res.type("text/xml").send(endSession(callSid, "C'est annulé."));
    }
  }

  // fallback ultime
  session = setSession(callSid, session);
return res.type("text/xml").send(
  ask(callSid, session, `${CONFIG.messages.fallback} ${session.lastQuestion || "Pouvez-vous répéter ?"}`, {
    action: "/gather",
    allowSpeech: true,
    allowDtmf: true,
    timeout: 7,
  })
);});

// Silence / bruit
app.post("/noinput", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  let session = getSession(callSid);
  session.noInput = (session.noInput || 0) + 1;
  session = setSession(callSid, session);

  if (session.noInput > CONFIG.maxNoInput) {
    return res.type("text/xml").send(endSession(callSid, CONFIG.messages.urgent15));
  }

const prompt = session.lastQuestion || "Je n’ai pas entendu. Pouvez-vous répéter ?";
return res.type("text/xml").send(
  ask(callSid, session, prompt, {
    action: "/gather",
    allowSpeech: true,
    allowDtmf: true,
    timeout: 7,
  })
);});

app.post("/nomatch", (req, res) => {
  const callSid = req.body.CallSid || "UNKNOWN";
  let session = getSession(callSid);
  session.noMatch = (session.noMatch || 0) + 1;
  session = setSession(callSid, session);

  if (session.noMatch > CONFIG.maxNoMatch) {
    session = pushHistory(session);
    session.flow = "CALLBACK";
    session.step = "CALLBACK_NAME";
    session.data = {};
    session.noMatch = 0;
    session = setSession(callSid, session);

    return res.type("text/xml").send(
      ask(callSid, session, "Dites votre nom et prénom. Le cabinet vous rappellera.", {
        action: "/gather",
        allowSpeech: true,
        allowDtmf: false,
        timeout: 7,
      })
    );
  }

  return res.type("text/xml").send(twiml(say(CONFIG.messages.fallback) + redirect("/voice")));
});

// Debug
app.get("/appointments", (req, res) => res.json(loadJson(CONFIG.apptsFile, [])));
app.get("/priority", (req, res) => res.json(loadJson(CONFIG.priorityFile, [])));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  ensureStorage();
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Twilio webhook: POST /voice`);
  console.log(`SMS enabled: ${CONFIG.enableSms}`);
});

const {
  isSlotAvailable,
} = require("./src/services/calendar"); // adapte le chemin si besoin

(async () => {
  try {
    const startDate = "2026-02-28T10:00:00+01:00";
    const endDate = "2026-02-28T10:30:00+01:00";

    const ok = await isSlotAvailable({
      calendarId: "primary",
      startDate,
      endDate,
    });

    console.log("Créneau demandé disponible ?", ok);

    if (!ok) {
      const alternatives = await suggestTwoSlotsFromDate({
        calendarId: "primary",
        fromDate: startDate,
      });

      console.log(
        "Alternatives:",
        alternatives.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
        }))
      );
    }
  } catch (err) {
    console.error("Erreur test bloc 2 :", err);
  }
})();