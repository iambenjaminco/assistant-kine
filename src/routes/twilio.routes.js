// src/routes/twilio.routes.js
const express = require("express");
const twilio = require("twilio");

const {
  suggestTwoSlotsNext7Days,
  suggestTwoSlotsFromDate,
  bookAppointmentSafe,
  formatSlotFR,
  findNextAppointmentSafe,
  cancelAppointmentSafe,
  addCallbackNoteToEvent,
} = require("../services/calendar");

const {
  sendAppointmentConfirmationSMS,
  sendAppointmentModifiedSMS,
  sendAppointmentCancelledSMS,
} = require("../services/sms");

const { CABINETS } = require("../config/cabinets");
const { PHRASES } = require("../../phrases.js");

const router = express.Router();

// ⚠️ Session en mémoire (dev). Prod => Redis/DB
const sessions = new Map();

// ✅ Voix FR configurable
const SAY_OPTS = {
  language: "fr-FR",
  voice: "Google.fr-FR-Wavenet-A",
};

function sayFr(node, text) {
  const safeText = String(text || "").trim();

  console.log("[TWILIO][TTS_DEBUG]", {
    voice: SAY_OPTS.voice,
    language: SAY_OPTS.language,
    text: safeText,
  });

  node.say(SAY_OPTS, safeText || "...");
}

function safeCallSid(req) {
  return (
    req.body?.CallSid ||
    req.headers["x-twilio-call-sid"] ||
    "UNKNOWN_CALLSID"
  );
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function wantsMainMenu(text) {
  return (
    text.includes("menu") ||
    text.includes("retour menu") ||
    text.includes("revenir au menu") ||
    text.includes("retour au menu") ||
    text.includes("accueil") ||
    text.includes("recommencer")
  );
}

function gatherSpeech(vr, actionUrl, overrides = {}) {
  return vr.gather({
    input: "speech dtmf",
    language: "fr-FR",
    speechTimeout: 1,
    timeout: 6,
    actionOnEmptyResult: true,
    action: actionUrl,
    method: "POST",
    hints:
      "prendre rendez-vous, modifier rendez-vous, annuler rendez-vous, premier, deuxième, second, autre jour, oui, non, demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, Benjamin, Lisa, peu importe, suivi, premier rendez-vous",
    ...overrides,
  });
}

function sayGoodbye(vr) {
  sayFr(vr, PHRASES.goodbye || "À bientôt. Au revoir.");
  vr.hangup();
}

function logInfo(event, data = {}) {
  console.log(`[TWILIO][${event}]`, data);
}

function logWarn(event, data = {}) {
  console.warn(`[TWILIO][${event}]`, data);
}

function logError(event, data = {}) {
  console.error(`[TWILIO][${event}]`, data);
}

function sendTwiml(res, vr) {
  const xml = vr.toString();
  console.log("[TWILIO][TWIML_XML]", xml);
  return res.type("text/xml").send(xml);
}

function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

function summarizeSlot(slot) {
  if (!slot) return null;
  return {
    start: slot.start,
    end: slot.end,
    formattedStart: slot.start ? formatSlotFR(slot.start) : null,
    practitionerName: slot.practitionerName || null,
    calendarId: slot.calendarId || null,
  };
}

function summarizeSlots(slots) {
  return (slots || []).map(summarizeSlot);
}

function setPrompt(session, prompt) {
  session.lastPrompt = prompt || "";
}

function resetRetry(session) {
  session.retryCount = 0;
}

function promptAndGather(vr, session, prompt, intro = "") {
  if (typeof prompt === "string") {
    setPrompt(session, prompt);
  }

  if (intro) {
    sayFr(vr, intro);
  }

  if (session.lastPrompt) {
    sayFr(vr, session.lastPrompt);
  }

  gatherSpeech(vr, "/twilio/voice");
  return vr;
}

function getCabinetOrFail(vr) {
  const cabinet = Object.values(CABINETS)[0];

  if (!cabinet) {
    sayFr(vr, "Configuration cabinet invalide.");
    vr.hangup();
    return null;
  }

  if (!cabinet.practitioners || !cabinet.practitioners.length) {
    sayFr(vr, "Aucun praticien n’est configuré. Merci de rappeler le cabinet.");
    sayGoodbye(vr);
    return null;
  }

  return cabinet;
}

function getCabinetDurations(cabinet) {
  const first = Number(cabinet?.appointmentDurations?.first);
  const followUp = Number(cabinet?.appointmentDurations?.followUp);

  return {
    first: Number.isFinite(first) && first > 0 ? first : 45,
    followUp: Number.isFinite(followUp) && followUp > 0 ? followUp : 30,
  };
}

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      step: "ACTION",
      slots: [],
      patientName: "",
      phone: "",
      phoneCandidate: "",
      phonePurpose: null, // BOOK | MODIFY | CANCEL
      pendingSlot: null,
      foundEvent: null,
      createdAt: Date.now(),
      noInputCount: 0,
      retryCount: 0,
      lastPrompt: "",

      initialBookingSpeech: "",
      appointmentType: null, // FIRST | FOLLOW_UP
      appointmentDurationMinutes: null,
      preferredPractitioner: null,
      practitionerPreferenceMode: null, // ANY | SPECIFIC | USUAL
      wantsUsualPractitioner: null,

      lastProposedStartISO: null,
      requestedDateISO: null,
      lastIntentContext: null, // BOOK | MODIFY
    });
  }
  return sessions.get(callSid);
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

function resetToMenu(session) {
  session.step = "ACTION";
  session.slots = [];
  session.patientName = "";
  session.phone = "";
  session.phoneCandidate = "";
  session.phonePurpose = null;
  session.pendingSlot = null;
  session.foundEvent = null;
  session.noInputCount = 0;
  session.retryCount = 0;
  session.lastPrompt = "";

  session.initialBookingSpeech = "";
  session.appointmentType = null;
  session.appointmentDurationMinutes = null;
  session.preferredPractitioner = null;
  session.practitionerPreferenceMode = null;
  session.wantsUsualPractitioner = null;

  session.lastProposedStartISO = null;
  session.requestedDateISO = null;
  session.lastIntentContext = null;
}

function getGuidedFallbackPrompt(step) {
  switch (step) {
    case "ACTION":
      return "Merci de me dire prendre, modifier ou annuler un rendez-vous.";
    case "BOOK_ASK_APPOINTMENT_TYPE":
      return "Merci de me dire si c'est un premier rendez-vous ou un rendez-vous de suivi.";
    case "BOOK_ASK_PRACTITIONER_PREF":
      return "Merci de me dire le prénom du kiné souhaité, ou dites peu importe.";
    case "BOOK_ASK_USUAL_PRACTITIONER":
      return "Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe.";
    case "BOOK_PICK_SLOT":
    case "BOOK_PICK_ALT":
    case "MODIFY_PICK_NEW":
      return "Vous pouvez me dire le premier, le deuxième, ou un autre jour.";
    case "BOOK_ASK_PREFERRED_DATE":
    case "MODIFY_ASK_PREFERRED_DATE":
      return "Vous pouvez dire par exemple demain, jeudi, lundi prochain ou le 18 mars.";
    case "BOOK_ASK_NAME":
      return "Merci de me dire votre nom et prénom.";
    case "BOOK_ASK_PHONE":
    case "MODIFY_ASK_PHONE":
    case "CANCEL_ASK_PHONE":
      return "Merci de me redonner votre numéro de téléphone chiffre par chiffre.";
    case "BOOK_CONFIRM_PHONE":
    case "MODIFY_CONFIRM_PHONE":
    case "CANCEL_CONFIRM_PHONE":
    case "MODIFY_CONFIRM_FOUND":
    case "CANCEL_CONFIRM_FOUND":
    case "CANCEL_ASK_REBOOK":
      return "Merci de répondre simplement par oui ou par non.";
    default:
      return "Je n’ai pas bien compris. Merci de reformuler simplement.";
  }
}

function handleRetry(vr, res, session, callSid, reason = "UNKNOWN") {
  session.retryCount = (session.retryCount || 0) + 1;

  logWarn("MISUNDERSTOOD_RETRY", {
    callSid,
    step: session.step,
    retryCount: session.retryCount,
    reason,
  });

  if (session.retryCount >= 3) {
    logWarn("CALL_ENDED_MISUNDERSTOOD", {
      callSid,
      step: session.step,
      reason,
    });
    sayFr(vr, "Je n’arrive pas à comprendre votre réponse.");
    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  return null;
}

// =========================
// Helpers date / alternatives
// =========================

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildDateAtStartOfDayISO(date) {
  const d = startOfDay(date);
  return d.toISOString();
}

function getFrenchMonthIndex(token) {
  const months = {
    janvier: 0,
    fevrier: 1,
    mars: 2,
    avril: 3,
    mai: 4,
    juin: 5,
    juillet: 6,
    aout: 7,
    septembre: 8,
    octobre: 9,
    novembre: 10,
    decembre: 11,
  };
  return months[token] ?? null;
}

function getFrenchWeekdayIndex(token) {
  const weekdays = {
    dimanche: 0,
    lundi: 1,
    mardi: 2,
    mercredi: 3,
    jeudi: 4,
    vendredi: 5,
    samedi: 6,
  };
  return weekdays[token] ?? null;
}

function computeNextWeekdayDate(targetDow, nextWeek = false) {
  const now = new Date();
  const today = startOfDay(now);
  const currentDow = today.getDay();

  let delta = targetDow - currentDow;
  if (delta < 0) delta += 7;

  if (delta === 0) {
    delta = nextWeek ? 7 : 0;
  } else if (nextWeek) {
    delta += 7;
  }

  return addDays(today, delta);
}

function detectAlternativeRequest(text) {
  const t = normalizeText(text);

  return (
    t.includes("autre date") ||
    t.includes("autre jour") ||
    t.includes("un autre jour") ||
    t.includes("une autre date") ||
    t.includes("autre creneau") ||
    t.includes("autre rendez") ||
    t.includes("un autre rendez") ||
    t.includes("pas disponible") ||
    t.includes("je ne suis pas disponible") ||
    t.includes("je suis pas disponible") ||
    t.includes("je peux pas") ||
    t.includes("je ne peux pas") ||
    t.includes("pas possible") ||
    t.includes("plus tard") ||
    t.includes("plus tot") ||
    t.includes("plus tard dans la semaine") ||
    t.includes("avez vous autre chose") ||
    t.includes("vous avez autre chose") ||
    t.includes("autre chose") ||
    t.includes("aucun des deux") ||
    t.includes("ni l'un ni l'autre") ||
    t.includes("ni lun ni lautre")
  );
}

function parseRequestedDate(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const now = new Date();
  const today = startOfDay(now);

  if (raw.includes("aujourd'hui") || raw.includes("aujourdhui")) {
    return buildDateAtStartOfDayISO(today);
  }

  if (raw.includes("demain")) {
    return buildDateAtStartOfDayISO(addDays(today, 1));
  }

  if (raw.includes("apres demain")) {
    return buildDateAtStartOfDayISO(addDays(today, 2));
  }

  const numericMatch = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]) - 1;
    let year = numericMatch[3] ? Number(numericMatch[3]) : today.getFullYear();
    if (year < 100) year += 2000;

    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) {
      if (!numericMatch[3] && startOfDay(d) < today) {
        d.setFullYear(d.getFullYear() + 1);
      }
      return buildDateAtStartOfDayISO(d);
    }
  }

  const longDateMatch = raw.match(
    /\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/
  );
  if (longDateMatch) {
    const day = Number(longDateMatch[1]);
    const month = getFrenchMonthIndex(longDateMatch[2]);
    let year = longDateMatch[3] ? Number(longDateMatch[3]) : today.getFullYear();

    if (month !== null) {
      const d = new Date(year, month, day);
      if (!Number.isNaN(d.getTime())) {
        if (!longDateMatch[3] && startOfDay(d) < today) {
          d.setFullYear(d.getFullYear() + 1);
        }
        return buildDateAtStartOfDayISO(d);
      }
    }
  }

  const weekdayMatch = raw.match(
    /\b(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)(?:\s+prochain)?\b/
  );
  if (weekdayMatch) {
    const dow = getFrenchWeekdayIndex(weekdayMatch[1]);
    const nextWeek = raw.includes("prochain");
    if (dow !== null) {
      return buildDateAtStartOfDayISO(computeNextWeekdayDate(dow, nextWeek));
    }
  }

  return null;
}

function isExplicitDateRequest(text) {
  return Boolean(parseRequestedDate(text));
}

function cleanProposeSpeech(s) {
  return String(s || "")
    .replace(/^bonjour[\s,.-]*/i, "")
    .replace(/^vous etes bien[^.?!]*[.?!]\s*/i, "")
    .replace(/^cabinet[^.?!]*[.?!]\s*/i, "")
    .trim();
}

function isLessThan24h(startISO) {
  const start = new Date(startISO).getTime();
  const now = Date.now();
  return start - now < 24 * 60 * 60 * 1000;
}

// =========================
// Helpers métier
// =========================

function parseYesNo(text) {
  const t = normalizeText(text);

  const yes =
    t.includes("oui") ||
    t.includes("ouais") ||
    t.includes("yes") ||
    t.includes("cest ca") ||
    t.includes("c est ca") ||
    t.includes("exact") ||
    t.includes("correct") ||
    t.includes("daccord") ||
    t.includes("d accord") ||
    t === "ok" ||
    t.includes("ca me va");

  const no =
    t.includes("non") ||
    t.includes("no") ||
    t.includes("pas du tout") ||
    t.includes("incorrect") ||
    t.includes("ce n'est pas ca") ||
    t.includes("cest pas ca");

  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

function detectAppointmentType(text) {
  const t = normalizeText(text);

  const first =
    t.includes("premier rendez") ||
    t.includes("premiere fois") ||
    t.includes("1er rendez") ||
    t.includes("nouveau patient") ||
    t.includes("je ne suis jamais venu") ||
    t.includes("jamais venu") ||
    t.includes("premiere consultation");

  const followUp =
    t.includes("suivi") ||
    t.includes("controle") ||
    t.includes("deja suivi") ||
    t.includes("je suis deja suivi") ||
    t.includes("patient du cabinet") ||
    t.includes("je suis deja patient") ||
    t.includes("seance") ||
    t.includes("rdv de suivi");

  if (first && !followUp) return "FIRST";
  if (followUp && !first) return "FOLLOW_UP";
  return null;
}

function detectNoPractitionerPreference(text) {
  const t = normalizeText(text);
  return (
    t.includes("peu importe") ||
    t.includes("nimporte lequel") ||
    t.includes("n'importe lequel") ||
    t.includes("pas de preference") ||
    t.includes("aucune preference") ||
    t.includes("comme vous voulez") ||
    t.includes("n'importe qui") ||
    t.includes("pas important")
  );
}

function detectUsualPractitionerIntent(text) {
  const t = normalizeText(text);
  return (
    t.includes("mon kine habituel") ||
    t.includes("ma kine habituelle") ||
    t.includes("mon praticien habituel") ||
    t.includes("ma praticienne habituelle") ||
    t.includes("le meme kine") ||
    t.includes("la meme kine") ||
    t.includes("garder le meme kine") ||
    t.includes("je suis deja suivi")
  );
}

function findPractitionerBySpeech(text, cabinet) {
  const t = normalizeText(text);
  if (!t || !cabinet?.practitioners?.length) return null;

  for (const p of cabinet.practitioners) {
    const full = normalizeText(p.name || "");
    const parts = full.split(/\s+/).filter(Boolean);

    if (full && t.includes(full)) return p;
    for (const part of parts) {
      if (part.length >= 3 && t.includes(part)) return p;
    }
  }

  return null;
}

function getSearchPractitioners(session, cabinet) {
  if (session.preferredPractitioner?.calendarId) {
    return cabinet.practitioners.filter(
      (p) => p.calendarId === session.preferredPractitioner.calendarId
    );
  }
  return cabinet.practitioners;
}

function rememberLastProposedSlots(session) {
  session.lastProposedStartISO = session.slots?.[0]?.start || null;
}

function hydrateSlotsWithDefaultPractitioner(slots, cabinet) {
  const defaultCalendarId = cabinet.practitioners[0].calendarId;

  return (slots || []).map((s) => ({
    ...s,
    calendarId: s.calendarId || defaultCalendarId,
    practitionerName: s.practitionerName || cabinet.practitioners[0].name,
  }));
}

function getSlotWeekdayFR(startISO) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(startISO));
}

function getSlotHourMinuteFR(startISO) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris",
  }).format(new Date(startISO));
}

function pickChoiceFromSpeech(text, digits, slots = []) {
  if (digits === "1") return 0;
  if (digits === "2") return 1;

  const t = normalizeText(text);
  const a = slots?.[0];
  const b = slots?.[1] || slots?.[0];

  if (!t) return null;

  if (/\b(premier|premiere|1|un)\b/.test(t) || /\ble 1\b/.test(t)) return 0;
  if (/\b(deuxieme|second|seconde|2|deux)\b/.test(t) || /\ble 2\b/.test(t)) {
    return 1;
  }

  if (t.includes("plus tot") || t.includes("le plus tot")) return 0;
  if (t.includes("plus tard") || t.includes("le plus tard")) return 1;

  if (a && b) {
    const aDay = normalizeText(getSlotWeekdayFR(a.start));
    const bDay = normalizeText(getSlotWeekdayFR(b.start));
    const aHm = normalizeText(getSlotHourMinuteFR(a.start).replace(":", "h"));
    const bHm = normalizeText(getSlotHourMinuteFR(b.start).replace(":", "h"));
    const aName = normalizeText(a.practitionerName || "");
    const bName = normalizeText(b.practitionerName || "");

    if (aDay && t.includes(aDay) && (!bDay || !t.includes(bDay))) return 0;
    if (bDay && t.includes(bDay) && (!aDay || !t.includes(aDay))) return 1;

    if (aHm && (t.includes(aHm) || t.includes(aHm.replace("h", " h ")))) return 0;
    if (bHm && (t.includes(bHm) || t.includes(bHm.replace("h", " h ")))) return 1;

    if (aName && t.includes(aName) && (!bName || !t.includes(bName))) return 0;
    if (bName && t.includes(bName) && (!aName || !t.includes(aName))) return 1;

    const aHour = Number(getSlotHourMinuteFR(a.start).split(":")[0]);
    const bHour = Number(getSlotHourMinuteFR(b.start).split(":")[0]);

    if (t.includes("matin") && aHour < 12 && !(bHour < 12)) return 0;
    if (t.includes("matin") && bHour < 12 && !(aHour < 12)) return 1;

    if ((t.includes("apres midi") || t.includes("apres-midi")) && aHour >= 12 && !(bHour >= 12)) return 0;
    if ((t.includes("apres midi") || t.includes("apres-midi")) && bHour >= 12 && !(aHour >= 12)) return 1;
  }

  return null;
}

function normalizePhoneCandidate(raw) {
  let digits = String(raw || "").replace(/\D/g, "");

  if (!digits) return "";

  if (digits.startsWith("0033")) {
    digits = `0${digits.slice(4)}`;
  } else if (digits.startsWith("33") && digits.length >= 11) {
    digits = `0${digits.slice(2)}`;
  }

  if (digits.length === 9) {
    digits = `0${digits}`;
  }

  if (digits.length !== 10) return "";
  if (!digits.startsWith("0")) return "";

  return digits;
}

function parsePhone(text, digits) {
  const byDigits = normalizePhoneCandidate(digits);
  if (byDigits) return byDigits;

  const bySpeech = normalizePhoneCandidate(text);
  if (bySpeech) return bySpeech;

  return "";
}

function formatPhoneForSpeech(phone) {
  const digits = normalizePhoneCandidate(phone);
  if (!digits) return "";
  return digits.match(/.{1,2}/g).join(" ");
}

async function lookupSlotsFromDate({
  practitioners,
  fromDateISO,
  appointmentDurationMinutes,
}) {
  const result = await suggestTwoSlotsFromDate({
    practitioners,
    fromDate: fromDateISO,
    durationMinutes: appointmentDurationMinutes || undefined,
  });

  if (Array.isArray(result)) {
    return { slots: result, speech: "" };
  }

  return {
    slots: result?.slots || [],
    speech: result?.speech || "",
  };
}

async function proposeSlotsFromRequestedDate({
  vr,
  res,
  session,
  callSid,
  cabinet,
  requestedDateISO,
  nextStep,
  intro,
  emptyMessage,
}) {
  const searchPractitioners = getSearchPractitioners(session, cabinet);

  const { slots, speech: proposeSpeech } = await lookupSlotsFromDate({
    practitioners: searchPractitioners,
    fromDateISO: requestedDateISO,
    appointmentDurationMinutes: session.appointmentDurationMinutes,
  });

  session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
  session.requestedDateISO = requestedDateISO;
  rememberLastProposedSlots(session);

  logInfo("REQUESTED_DATE_SLOTS_RESULT", {
    callSid,
    requestedDateISO,
    appointmentType: session.appointmentType,
    appointmentDurationMinutes: session.appointmentDurationMinutes,
    preferredPractitioner: session.preferredPractitioner?.name || null,
    count: session.slots.length,
    slots: summarizeSlots(session.slots),
    context: session.lastIntentContext,
  });

  if (!session.slots.length) {
    session.step =
      session.lastIntentContext === "MODIFY"
        ? "MODIFY_ASK_PREFERRED_DATE"
        : "BOOK_ASK_PREFERRED_DATE";

    promptAndGather(
      vr,
      session,
      "Je n’ai pas trouvé de disponibilité à cette date. Donnez-moi un autre jour qui vous conviendrait.",
      emptyMessage || "Je n’ai pas trouvé de disponibilité à cette date."
    );
    return sendTwiml(res, vr);
  }

  if (intro) sayFr(vr, intro);

  const cleaned = cleanProposeSpeech(proposeSpeech);
  if (cleaned) {
    sayFr(vr, cleaned);
  } else {
    const a = session.slots[0];
    const b = session.slots[1] || session.slots[0];

    sayFr(
      vr,
      `Je peux vous proposer ${formatSlotFR(a.start)}${
        a.practitionerName ? ` avec ${a.practitionerName}` : ""
      }.`
    );

    if (b?.start && b.start !== a.start) {
      sayFr(
        vr,
        `Ou ${formatSlotFR(b.start)}${
          b.practitionerName ? ` avec ${b.practitionerName}` : ""
        }.`
      );
    }
  }

  session.step = nextStep;
  promptAndGather(vr, session, "Quel créneau vous convient ?");
  return sendTwiml(res, vr);
}

async function proposeBookingSlots({
  vr,
  res,
  session,
  callSid,
  cabinet,
  fromDateISO = null,
}) {
  const searchPractitioners = getSearchPractitioners(session, cabinet);

  logInfo("BOOKING_SLOTS_LOOKUP_START", {
    callSid,
    practitionersCount: searchPractitioners.length,
    preferredPractitioner: session.preferredPractitioner?.name || null,
    appointmentType: session.appointmentType,
    appointmentDurationMinutes: session.appointmentDurationMinutes,
    fromDateISO,
  });

  const result = fromDateISO
    ? await suggestTwoSlotsFromDate({
        practitioners: searchPractitioners,
        fromDate: fromDateISO,
        durationMinutes: session.appointmentDurationMinutes || undefined,
      })
    : await suggestTwoSlotsNext7Days({
        practitioners: searchPractitioners,
        durationMinutes: session.appointmentDurationMinutes || undefined,
      });

  const slots = Array.isArray(result) ? result : result?.slots || [];
  const proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

  session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
  rememberLastProposedSlots(session);

  logInfo("BOOKING_SLOTS_LOOKUP_RESULT", {
    callSid,
    count: session.slots.length,
    slots: summarizeSlots(session.slots),
    preferredPractitioner: session.preferredPractitioner?.name || null,
    appointmentType: session.appointmentType,
  });

  if (!session.slots.length) {
    const msg =
      cleanProposeSpeech(proposeSpeech) ||
      PHRASES.noAvailability ||
      "Je n’ai pas de créneau disponible dans les prochains jours.";

    sayFr(vr, msg);

    session.step = "BOOK_ASK_PREFERRED_DATE";
    promptAndGather(
      vr,
      session,
      "Quel autre jour vous conviendrait ? Vous pouvez dire par exemple jeudi, lundi prochain ou le 18 mars."
    );
    return sendTwiml(res, vr);
  }

  if (session.preferredPractitioner?.name) {
    sayFr(vr, `Très bien, je cherche avec ${session.preferredPractitioner.name}.`);
  } else {
    sayFr(vr, "Très bien.");
  }

  const cleaned = cleanProposeSpeech(proposeSpeech);
  if (cleaned) {
    sayFr(vr, cleaned);
  } else {
    const a = session.slots[0];
    const b = session.slots[1] || session.slots[0];

    sayFr(
      vr,
      `Je peux vous proposer ${formatSlotFR(a.start)}${
        a.practitionerName ? ` avec ${a.practitionerName}` : ""
      }.`
    );

    if (b?.start && b.start !== a.start) {
      sayFr(
        vr,
        `Ou ${formatSlotFR(b.start)}${
          b.practitionerName ? ` avec ${b.practitionerName}` : ""
        }.`
      );
    }
  }

  session.step = "BOOK_PICK_SLOT";
  promptAndGather(vr, session, "Quel créneau vous convient ?");
  return sendTwiml(res, vr);
}

async function finalizeBooking(vr, res, session, callSid, cabinet) {
  const slot = session.pendingSlot;
  session.pendingSlot = null;

  if (!slot || !slot.calendarId) {
    logError("BOOKING_PENDING_SLOT_MISSING", {
      callSid,
      patientName: session.patientName,
      phone: maskPhone(session.phone),
    });

    sayFr(vr, "Je ne retrouve plus le créneau sélectionné.");
    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  logInfo("BOOKING_ATTEMPT", {
    callSid,
    calendarId: slot.calendarId,
    patientName: session.patientName,
    phone: maskPhone(session.phone),
    slot: summarizeSlot(slot),
    appointmentType: session.appointmentType,
    appointmentDurationMinutes: session.appointmentDurationMinutes,
  });

  const result = await bookAppointmentSafe({
    calendarId: slot.calendarId,
    patientName: session.patientName || "Patient",
    reason:
      session.appointmentType === "FIRST"
        ? "Premier rendez-vous kiné"
        : "Rendez-vous kiné",
    startDate: slot.start,
    endDate: slot.end,
    phone: session.phone || "",
    appointmentType: session.appointmentType || undefined,
    durationMinutes: session.appointmentDurationMinutes || undefined,
  });

  logInfo("BOOKING_RESULT", {
    callSid,
    ok: result.ok,
    code: result.code || null,
    eventId: result.event?.id || null,
    slot: summarizeSlot(slot),
  });

  if (result.ok) {
    sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
    sayFr(
      vr,
      `${formatSlotFR(slot.start)}${
        slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
      }.`
    );

    try {
      const sms = await sendAppointmentConfirmationSMS({
        to: session.phone,
        patientName: session.patientName || "Patient",
        formattedSlot: formatSlotFR(slot.start),
        practitionerName: slot.practitionerName || "",
      });

      logInfo("SMS_SENT", {
        callSid,
        type: "BOOK_CONFIRMATION",
        to: maskPhone(session.phone),
        sid: sms?.sid || null,
        status: sms?.status || null,
      });
    } catch (smsErr) {
      logError("SMS_FAILED", {
        callSid,
        type: "BOOK_CONFIRMATION",
        to: maskPhone(session.phone),
        message: smsErr?.message,
      });
    }

    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  const statusMsg =
    result.code === "LOCKED"
      ? "Ce créneau est en cours de réservation."
      : "Ce créneau vient d’être pris.";

  const searchPractitioners = getSearchPractitioners(session, cabinet);

  const { slots: altSlots } = await lookupSlotsFromDate({
    practitioners: searchPractitioners,
    fromDateISO: slot.start,
    appointmentDurationMinutes: session.appointmentDurationMinutes,
  });

  session.slots = hydrateSlotsWithDefaultPractitioner(altSlots, cabinet);
  rememberLastProposedSlots(session);

  if (!session.slots?.length) {
    sayFr(
      vr,
      `${statusMsg} Je n’ai pas d’autre créneau disponible rapidement. Merci de rappeler le cabinet.`
    );
    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  const a = session.slots[0];
  const b = session.slots[1] || session.slots[0];

  sayFr(vr, statusMsg);
  sayFr(
    vr,
    `Je peux vous proposer ${formatSlotFR(a.start)}${
      a.practitionerName ? ` avec ${a.practitionerName}` : ""
    }.`
  );
  sayFr(
    vr,
    `Ou ${formatSlotFR(b.start)}${
      b.practitionerName ? ` avec ${b.practitionerName}` : ""
    }.`
  );

  session.step = "BOOK_PICK_ALT";
  promptAndGather(vr, session, "Quel créneau vous convient ?");
  return sendTwiml(res, vr);
}

// Webhook principal
router.post("/voice", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const vr = new VoiceResponse();

  const callSid = safeCallSid(req);
  const speech = (req.body?.SpeechResult || "").trim();
  const digits = (req.body?.Digits || "").trim();

  const session = getSession(callSid);

  logInfo("VOICE_WEBHOOK", {
    callSid,
    step: session.step,
    speech,
    digits,
    hasInput: Boolean(speech || digits),
  });

  const cabinet = getCabinetOrFail(vr);
  if (!cabinet) {
    logError("CABINET_CONFIG_INVALID", { callSid });
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  const durations = getCabinetDurations(cabinet);

  const hasInput = Boolean(speech || digits);
  const normalizedSpeech = normalizeText(speech);

  if (hasInput && wantsMainMenu(normalizedSpeech) && session.step !== "ACTION") {
    resetToMenu(session);
    promptAndGather(
      vr,
      session,
      PHRASES.askAction || "Souhaitez-vous prendre, modifier ou annuler un rendez-vous ?",
      "Très bien, retour au menu principal."
    );
    return sendTwiml(res, vr);
  }

  if (!hasInput && session.lastPrompt) {
    session.noInputCount = (session.noInputCount || 0) + 1;

    if (session.noInputCount === 1) {
      promptAndGather(vr, session, session.lastPrompt, "Vous êtes toujours là ?");
      return sendTwiml(res, vr);
    }

    sayFr(vr, "Je n’ai pas eu de réponse.");
    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }

  if (hasInput) {
    session.noInputCount = 0;
    resetRetry(session);
  }

  try {
    // =========================
    // 0) ACTION (menu)
    // =========================
    if (session.step === "ACTION") {
      const text = normalizeText(speech);

      if (!text) {
        setPrompt(
          session,
          PHRASES.askAction || "Souhaitez-vous prendre, modifier ou annuler un rendez-vous ?"
        );

        sayFr(
          vr,
          PHRASES.greeting || "Bonjour, vous êtes bien au cabinet de kinésithérapie."
        );
        sayFr(vr, session.lastPrompt);
        gatherSpeech(vr, "/twilio/voice");
        return sendTwiml(res, vr);
      }

      const wantsModify =
        text.includes("modifier") ||
        text.includes("changer") ||
        text.includes("decaler") ||
        text.includes("deplacer") ||
        text.includes("reporter");

      const wantsCancel =
        text.includes("annuler") ||
        text.includes("supprimer") ||
        text.includes("retirer");

      const wantsBook =
        text.includes("prendre") ||
        text.includes("rendez") ||
        text.includes("rdv") ||
        text.includes("consult");

      if (wantsModify) {
        session.phonePurpose = "MODIFY";
        session.step = "MODIFY_ASK_PHONE";
        promptAndGather(vr, session, "Quel est votre numéro de téléphone ?", "Très bien.");
        return sendTwiml(res, vr);
      }

      if (wantsCancel) {
        session.phonePurpose = "CANCEL";
        session.step = "CANCEL_ASK_PHONE";
        promptAndGather(vr, session, "Quel est votre numéro de téléphone ?", "D’accord.");
        return sendTwiml(res, vr);
      }

      if (wantsBook) {
        session.lastIntentContext = "BOOK";
        session.initialBookingSpeech = speech || "";
        session.step = "BOOK_WELCOME";
        vr.redirect({ method: "POST" }, "/twilio/voice");
        return sendTwiml(res, vr);
      }

      const retry = handleRetry(vr, res, session, callSid, "ACTION");
      if (retry) return retry;

      promptAndGather(
        vr,
        session,
        getGuidedFallbackPrompt("ACTION"),
        "Je n’ai pas bien compris."
      );
      return sendTwiml(res, vr);
    }

    // =========================
    // A) PRENDRE RDV
    // =========================
    if (session.step === "BOOK_WELCOME") {
      session.lastIntentContext = "BOOK";
      const seed = session.initialBookingSpeech || "";

      if (!session.appointmentType) {
        const detectedType = detectAppointmentType(seed);
        if (detectedType) {
          session.appointmentType = detectedType;
          session.appointmentDurationMinutes =
            detectedType === "FIRST" ? durations.first : durations.followUp;
        }
      }

      if (!session.preferredPractitioner) {
        const detectedPractitioner = findPractitionerBySpeech(seed, cabinet);
        if (detectedPractitioner) {
          session.preferredPractitioner = detectedPractitioner;
          session.practitionerPreferenceMode = "SPECIFIC";
        }
      }

      if (!session.practitionerPreferenceMode && detectNoPractitionerPreference(seed)) {
        session.practitionerPreferenceMode = "ANY";
      }

      if (!session.wantsUsualPractitioner && detectUsualPractitionerIntent(seed)) {
        session.wantsUsualPractitioner = true;
        session.practitionerPreferenceMode = "USUAL";
      }

      if (!session.appointmentType) {
        session.step = "BOOK_ASK_APPOINTMENT_TYPE";
        promptAndGather(
          vr,
          session,
          "S’agit-il d’un premier rendez-vous au cabinet, ou d’un rendez-vous de suivi ?",
          "Très bien."
        );
        return sendTwiml(res, vr);
      }

      if (!session.practitionerPreferenceMode) {
        session.step = "BOOK_ASK_PRACTITIONER_PREF";
        promptAndGather(
          vr,
          session,
          "Avez-vous une préférence pour un kiné en particulier ? Vous pouvez me donner son prénom, ou dire peu importe."
        );
        return sendTwiml(res, vr);
      }

      if (session.practitionerPreferenceMode === "USUAL" && !session.preferredPractitioner) {
        session.step = "BOOK_ASK_USUAL_PRACTITIONER";
        promptAndGather(vr, session, "Avec quel kiné êtes-vous habituellement suivi ?");
        return sendTwiml(res, vr);
      }

      return proposeBookingSlots({ vr, res, session, callSid, cabinet });
    }

    if (session.step === "BOOK_ASK_APPOINTMENT_TYPE") {
      const detectedType = detectAppointmentType(speech);

      if (!detectedType) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_APPOINTMENT_TYPE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de me dire si c’est un premier rendez-vous ou un rendez-vous de suivi."
        );
        return sendTwiml(res, vr);
      }

      session.appointmentType = detectedType;
      session.appointmentDurationMinutes =
        detectedType === "FIRST" ? durations.first : durations.followUp;

      session.step = "BOOK_ASK_PRACTITIONER_PREF";
      promptAndGather(
        vr,
        session,
        "Avez-vous une préférence pour un kiné en particulier ? Vous pouvez me donner son prénom, ou dire peu importe.",
        "Très bien."
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_ASK_PRACTITIONER_PREF") {
      const practitioner = findPractitionerBySpeech(speech, cabinet);
      const noPreference = detectNoPractitionerPreference(speech);
      const usual = detectUsualPractitionerIntent(speech);

      if (practitioner) {
        session.preferredPractitioner = practitioner;
        session.practitionerPreferenceMode = "SPECIFIC";
        return proposeBookingSlots({ vr, res, session, callSid, cabinet });
      }

      if (noPreference) {
        session.preferredPractitioner = null;
        session.practitionerPreferenceMode = "ANY";
        return proposeBookingSlots({ vr, res, session, callSid, cabinet });
      }

      if (usual) {
        session.wantsUsualPractitioner = true;
        session.practitionerPreferenceMode = "USUAL";
        session.step = "BOOK_ASK_USUAL_PRACTITIONER";
        promptAndGather(vr, session, "Avec quel kiné êtes-vous habituellement suivi ?", "Très bien.");
        return sendTwiml(res, vr);
      }

      const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_PRACTITIONER_PREF");
      if (retry) return retry;

      promptAndGather(
        vr,
        session,
        "Je n’ai pas bien compris. Merci de me dire le prénom du kiné souhaité, ou dites peu importe."
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_ASK_USUAL_PRACTITIONER") {
      const practitioner = findPractitionerBySpeech(speech, cabinet);
      const noPreference = detectNoPractitionerPreference(speech);

      if (practitioner) {
        session.preferredPractitioner = practitioner;
        session.practitionerPreferenceMode = "SPECIFIC";
        return proposeBookingSlots({ vr, res, session, callSid, cabinet });
      }

      if (noPreference) {
        session.preferredPractitioner = null;
        session.practitionerPreferenceMode = "ANY";
        return proposeBookingSlots({ vr, res, session, callSid, cabinet });
      }

      const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_USUAL_PRACTITIONER");
      if (retry) return retry;

      promptAndGather(
        vr,
        session,
        "Je n’ai pas bien compris. Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe."
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_PICK_SLOT") {
      const t = normalizeText(speech);

      const wantsRepeat =
        t.includes("repete") ||
        t.includes("repeter") ||
        t.includes("pardon") ||
        t.includes("recommence") ||
        t.includes("pas compris") ||
        t.includes("vous pouvez repeter");

      if (wantsRepeat) {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (!a) {
          sayFr(vr, "Je ne retrouve plus les créneaux proposés. Merci de rappeler le cabinet.");
          sayGoodbye(vr);
          clearSession(callSid);
          return sendTwiml(res, vr);
        }

        sayFr(vr, "Je répète.");
        sayFr(
          vr,
          `Je peux vous proposer ${formatSlotFR(a.start)}${
            a.practitionerName ? ` avec ${a.practitionerName}` : ""
          }.`
        );
        sayFr(
          vr,
          `Ou ${formatSlotFR(b.start)}${
            b.practitionerName ? ` avec ${b.practitionerName}` : ""
          }.`
        );

        promptAndGather(vr, session, "Quel créneau vous convient ?");
        return sendTwiml(res, vr);
      }

      if (detectAlternativeRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        if (requestedDateISO) {
          return proposeSlotsFromRequestedDate({
            vr,
            res,
            session,
            callSid,
            cabinet,
            requestedDateISO,
            nextStep: "BOOK_PICK_SLOT",
            intro: "Très bien, je regarde à cette date.",
            emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
          });
        }

        session.step = "BOOK_ASK_PREFERRED_DATE";
        promptAndGather(
          vr,
          session,
          "D’accord. Parmi les deux autres jours disponibles, lequel vous conviendrait ?"
        );
        return sendTwiml(res, vr);
      }

      if (isExplicitDateRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        return proposeSlotsFromRequestedDate({
          vr,
          res,
          session,
          callSid,
          cabinet,
          requestedDateISO,
          nextStep: "BOOK_PICK_SLOT",
          intro: "Très bien, je regarde cette date.",
          emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
        });
      }

      const choice = pickChoiceFromSpeech(speech, digits, session.slots);

      if (choice === null) {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (!a) {
          session.step = "BOOK_WELCOME";
          sayFr(vr, "On recommence.");
          vr.redirect({ method: "POST" }, "/twilio/voice");
          return sendTwiml(res, vr);
        }

        const retry = handleRetry(vr, res, session, callSid, "BOOK_PICK_SLOT");
        if (retry) return retry;

        sayFr(vr, "Je n’ai pas bien compris.");
        sayFr(
          vr,
          `Vous pouvez me dire le premier pour ${formatSlotFR(a.start)}, le deuxième pour ${formatSlotFR(b.start)}, ou un autre jour.`
        );

        promptAndGather(vr, session, "Quel créneau vous convient ?");
        return sendTwiml(res, vr);
      }

      const slot = session.slots?.[choice];

      if (!slot || !slot.calendarId) {
        sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");
        session.step = "BOOK_WELCOME";
        vr.redirect({ method: "POST" }, "/twilio/voice");
        return sendTwiml(res, vr);
      }

      session.pendingSlot = slot;
      session.step = "BOOK_ASK_NAME";

      promptAndGather(vr, session, "Quel est votre nom et prénom ?", "Très bien.");
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_ASK_PREFERRED_DATE") {
      const requestedDateISO = parseRequestedDate(speech);

      if (!requestedDateISO) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_PREFERRED_DATE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain ou le 18 mars."
        );
        return sendTwiml(res, vr);
      }

      return proposeSlotsFromRequestedDate({
        vr,
        res,
        session,
        callSid,
        cabinet,
        requestedDateISO,
        nextStep: "BOOK_PICK_SLOT",
        intro: "Très bien, je regarde.",
        emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
      });
    }

    if (session.step === "BOOK_ASK_NAME") {
      const name = (speech || "").trim();

      if (!name) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_NAME");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de me dire votre nom et prénom."
        );
        return sendTwiml(res, vr);
      }

      session.patientName = name;
      session.phonePurpose = "BOOK";
      session.step = "BOOK_ASK_PHONE";

      promptAndGather(vr, session, "Quel est votre numéro de téléphone ?", "Merci.");
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_ASK_PHONE") {
      const phone = parsePhone(speech, digits);

      if (!phone) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phoneCandidate = phone;
      session.step = "BOOK_CONFIRM_PHONE";

      promptAndGather(
        vr,
        session,
        `Si j’ai bien compris, votre numéro est le ${formatPhoneForSpeech(phone)}. Est-ce correct ?`
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "BOOK_CONFIRM_PHONE") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_CONFIRM_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        session.phoneCandidate = "";
        session.step = "BOOK_ASK_PHONE";

        promptAndGather(
          vr,
          session,
          "Très bien. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phone = session.phoneCandidate;
      session.phoneCandidate = "";

      return finalizeBooking(vr, res, session, callSid, cabinet);
    }

    if (session.step === "BOOK_PICK_ALT") {
      const t = normalizeText(speech);

      if (detectAlternativeRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        if (requestedDateISO) {
          return proposeSlotsFromRequestedDate({
            vr,
            res,
            session,
            callSid,
            cabinet,
            requestedDateISO,
            nextStep: "BOOK_PICK_ALT",
            intro: "Très bien, je regarde à cette date.",
            emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
          });
        }

        session.step = "BOOK_ASK_PREFERRED_DATE";
        promptAndGather(
          vr,
          session,
          "D’accord. Parmi les deux autres jours disponibles, lequel vous conviendrait ?"
        );
        return sendTwiml(res, vr);
      }

      if (isExplicitDateRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        return proposeSlotsFromRequestedDate({
          vr,
          res,
          session,
          callSid,
          cabinet,
          requestedDateISO,
          nextStep: "BOOK_PICK_ALT",
          intro: "Très bien, je regarde cette date.",
          emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
        });
      }

      const choice = pickChoiceFromSpeech(speech, digits, session.slots);

      if (choice === null) {
        const retry = handleRetry(vr, res, session, callSid, "BOOK_PICK_ALT");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Vous pouvez me dire le premier, le deuxième, ou un autre jour."
        );
        return sendTwiml(res, vr);
      }

      const slot = session.slots?.[choice];

      if (!slot || !slot.calendarId) {
        sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName || "Patient",
        reason:
          session.appointmentType === "FIRST"
            ? "Premier rendez-vous kiné"
            : "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
        appointmentType: session.appointmentType || undefined,
        durationMinutes: session.appointmentDurationMinutes || undefined,
      });

      if (result.ok) {
        sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
        sayFr(
          vr,
          `${formatSlotFR(slot.start)}${
            slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
          }.`
        );

        try {
          const sms = await sendAppointmentConfirmationSMS({
            to: session.phone,
            patientName: session.patientName || "Patient",
            formattedSlot: formatSlotFR(slot.start),
            practitionerName: slot.practitionerName || "",
          });

          logInfo("SMS_SENT", {
            callSid,
            type: "BOOK_CONFIRMATION_ALT",
            to: maskPhone(session.phone),
            sid: sms?.sid || null,
            status: sms?.status || null,
          });
        } catch (smsErr) {
          logError("SMS_FAILED", {
            callSid,
            type: "BOOK_CONFIRMATION_ALT",
            to: maskPhone(session.phone),
            message: smsErr?.message,
          });
        }

        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      sayFr(
        vr,
        "Désolé, je n’arrive pas à confirmer un rendez-vous pour le moment. Merci de rappeler le cabinet."
      );
      sayGoodbye(vr);
      clearSession(callSid);
      return sendTwiml(res, vr);
    }

    // =========================
    // B) MODIFIER RDV
    // =========================
    if (session.step === "MODIFY_ASK_PHONE") {
      const phone = parsePhone(speech, digits);

      if (!phone) {
        const retry = handleRetry(vr, res, session, callSid, "MODIFY_ASK_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phoneCandidate = phone;
      session.step = "MODIFY_CONFIRM_PHONE";

      promptAndGather(
        vr,
        session,
        `Si j’ai bien compris, votre numéro est le ${formatPhoneForSpeech(phone)}. Est-ce correct ?`
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_CONFIRM_PHONE") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "MODIFY_CONFIRM_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        session.phoneCandidate = "";
        session.step = "MODIFY_ASK_PHONE";

        promptAndGather(
          vr,
          session,
          "Très bien. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phone = session.phoneCandidate;
      session.phoneCandidate = "";
      session.step = "MODIFY_FIND_APPT";
      session.lastIntentContext = "MODIFY";
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_FIND_APPT") {
      const found = await findNextAppointmentSafe({
        practitioners: cabinet.practitioners,
        phone: session.phone,
      });

      if (!found) {
        sayFr(
          vr,
          "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
        );
        session.phone = "";
        session.foundEvent = null;
        session.step = "MODIFY_ASK_PHONE";
        promptAndGather(vr, session, "Quel est votre numéro de téléphone ?");
        return sendTwiml(res, vr);
      }

      session.foundEvent = found;
      session.patientName = found.patientName || session.patientName || "Patient";

      const currentPractitioner = cabinet.practitioners.find(
        (p) => p.calendarId === found.calendarId
      );
      if (currentPractitioner) {
        session.preferredPractitioner = currentPractitioner;
        session.practitionerPreferenceMode = "SPECIFIC";
      }

      session.step = "MODIFY_CONFIRM_FOUND";

      sayFr(vr, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
      promptAndGather(vr, session, "Est-ce bien votre rendez-vous ?");
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_CONFIRM_FOUND") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "MODIFY_CONFIRM_FOUND");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        session.phone = "";
        session.foundEvent = null;
        session.step = "MODIFY_ASK_PHONE";
        promptAndGather(
          vr,
          session,
          "Quel est votre numéro de téléphone ?",
          "Très bien, redonnez-moi votre numéro pour vérification."
        );
        return sendTwiml(res, vr);
      }

      const found = session.foundEvent;
      if (!found) {
        sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      if (isLessThan24h(found.startISO)) {
        await addCallbackNoteToEvent({
          calendarId: found.calendarId,
          eventId: found.eventId,
        });

        sayFr(
          vr,
          "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de le modifier automatiquement. Le cabinet vous rappellera."
        );

        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      const cancelResult = await cancelAppointmentSafe({
        calendarId: found.calendarId,
        eventId: found.eventId,
      });

      if (!cancelResult.ok) {
        sayFr(
          vr,
          "Je n’arrive pas à modifier le rendez-vous pour le moment. Merci de rappeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      session.step = "MODIFY_PROPOSE_NEW";
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_PROPOSE_NEW") {
      session.lastIntentContext = "MODIFY";

      const searchPractitioners = getSearchPractitioners(session, cabinet);

      const result = await suggestTwoSlotsNext7Days({
        practitioners: searchPractitioners,
        durationMinutes: session.appointmentDurationMinutes || undefined,
      });

      const slots = Array.isArray(result) ? result : result?.slots || [];
      const proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

      session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
      rememberLastProposedSlots(session);

      if (!session.slots.length) {
        sayFr(
          vr,
          "J’ai bien annulé votre rendez-vous, mais je n’ai pas de nouveau créneau disponible. Merci d’appeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      sayFr(vr, "D’accord.");

      const cleaned = cleanProposeSpeech(proposeSpeech);
      if (cleaned) {
        sayFr(vr, cleaned);
      } else {
        const a = session.slots[0];
        const b = session.slots[1] || session.slots[0];

        sayFr(
          vr,
          `Je peux vous proposer ${formatSlotFR(a.start)}${
            a.practitionerName ? ` avec ${a.practitionerName}` : ""
          }.`
        );
        sayFr(
          vr,
          `Ou ${formatSlotFR(b.start)}${
            b.practitionerName ? ` avec ${b.practitionerName}` : ""
          }.`
        );
      }

      session.step = "MODIFY_PICK_NEW";
      promptAndGather(vr, session, "Quel créneau vous convient ?");
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_PICK_NEW") {
      const t = normalizeText(speech);

      if (detectAlternativeRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        if (requestedDateISO) {
          return proposeSlotsFromRequestedDate({
            vr,
            res,
            session,
            callSid,
            cabinet,
            requestedDateISO,
            nextStep: "MODIFY_PICK_NEW",
            intro: "Très bien, je regarde à cette date.",
            emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
          });
        }

        session.step = "MODIFY_ASK_PREFERRED_DATE";
        promptAndGather(
          vr,
          session,
          "D’accord. Parmi les deux autres jours disponibles, lequel vous conviendrait ?"
        );
        return sendTwiml(res, vr);
      }

      if (isExplicitDateRequest(t)) {
        const requestedDateISO = parseRequestedDate(t);

        return proposeSlotsFromRequestedDate({
          vr,
          res,
          session,
          callSid,
          cabinet,
          requestedDateISO,
          nextStep: "MODIFY_PICK_NEW",
          intro: "Très bien, je regarde cette date.",
          emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
        });
      }

      const choice = pickChoiceFromSpeech(speech, digits, session.slots);

      if (choice === null) {
        const retry = handleRetry(vr, res, session, callSid, "MODIFY_PICK_NEW");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Vous pouvez me dire le premier, le deuxième, ou un autre jour."
        );
        return sendTwiml(res, vr);
      }

      const slot = session.slots?.[choice];

      if (!slot || !slot.calendarId) {
        sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName || "Patient",
        reason:
          session.appointmentType === "FIRST"
            ? "Premier rendez-vous kiné"
            : "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
        appointmentType: session.appointmentType || undefined,
        durationMinutes: session.appointmentDurationMinutes || undefined,
      });

      if (result.ok) {
        sayFr(vr, "C’est modifié et confirmé.");
        sayFr(
          vr,
          `${formatSlotFR(slot.start)}${
            slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
          }.`
        );

        try {
          const sms = await sendAppointmentModifiedSMS({
            to: session.phone,
            patientName: session.patientName || "Patient",
            formattedSlot: formatSlotFR(slot.start),
            practitionerName: slot.practitionerName || "",
          });

          logInfo("SMS_SENT", {
            callSid,
            type: "MODIFY_CONFIRMATION",
            to: maskPhone(session.phone),
            sid: sms?.sid || null,
            status: sms?.status || null,
          });
        } catch (smsErr) {
          logError("SMS_FAILED", {
            callSid,
            type: "MODIFY_CONFIRMATION",
            to: maskPhone(session.phone),
            message: smsErr?.message,
          });
        }

        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      sayFr(
        vr,
        "Désolé, je n’arrive pas à confirmer ce nouveau créneau. Merci de rappeler le cabinet."
      );
      sayGoodbye(vr);
      clearSession(callSid);
      return sendTwiml(res, vr);
    }

    if (session.step === "MODIFY_ASK_PREFERRED_DATE") {
      const requestedDateISO = parseRequestedDate(speech);

      if (!requestedDateISO) {
        const retry = handleRetry(vr, res, session, callSid, "MODIFY_ASK_PREFERRED_DATE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain ou le 18 mars."
        );
        return sendTwiml(res, vr);
      }

      return proposeSlotsFromRequestedDate({
        vr,
        res,
        session,
        callSid,
        cabinet,
        requestedDateISO,
        nextStep: "MODIFY_PICK_NEW",
        intro: "Très bien, je regarde.",
        emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
      });
    }

    // =========================
    // C) ANNULER RDV
    // =========================
    if (session.step === "CANCEL_ASK_PHONE") {
      const phone = parsePhone(speech, digits);

      if (!phone) {
        const retry = handleRetry(vr, res, session, callSid, "CANCEL_ASK_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phoneCandidate = phone;
      session.step = "CANCEL_CONFIRM_PHONE";

      promptAndGather(
        vr,
        session,
        `Si j’ai bien compris, votre numéro est le ${formatPhoneForSpeech(phone)}. Est-ce correct ?`
      );
      return sendTwiml(res, vr);
    }

    if (session.step === "CANCEL_CONFIRM_PHONE") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "CANCEL_CONFIRM_PHONE");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        session.phoneCandidate = "";
        session.step = "CANCEL_ASK_PHONE";

        promptAndGather(
          vr,
          session,
          "Très bien. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
      }

      session.phone = session.phoneCandidate;
      session.phoneCandidate = "";
      session.step = "CANCEL_FIND_APPT";
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return sendTwiml(res, vr);
    }

    if (session.step === "CANCEL_FIND_APPT") {
      const found = await findNextAppointmentSafe({
        practitioners: cabinet.practitioners,
        phone: session.phone,
      });

      if (!found) {
        sayFr(
          vr,
          "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
        );
        session.phone = "";
        session.foundEvent = null;
        session.step = "CANCEL_ASK_PHONE";
        promptAndGather(vr, session, "Quel est votre numéro de téléphone ?");
        return sendTwiml(res, vr);
      }

      session.foundEvent = found;
      session.patientName = found.patientName || session.patientName || "Patient";
      session.step = "CANCEL_CONFIRM_FOUND";

      sayFr(vr, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
      promptAndGather(vr, session, "Est-ce bien votre rendez-vous ?");
      return sendTwiml(res, vr);
    }

    if (session.step === "CANCEL_CONFIRM_FOUND") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "CANCEL_CONFIRM_FOUND");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        session.phone = "";
        session.foundEvent = null;
        session.step = "CANCEL_ASK_PHONE";
        promptAndGather(
          vr,
          session,
          "Quel est votre numéro de téléphone ?",
          "Très bien, redonnez-moi votre numéro pour vérification."
        );
        return sendTwiml(res, vr);
      }

      const found = session.foundEvent;
      if (!found) {
        sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      if (isLessThan24h(found.startISO)) {
        await addCallbackNoteToEvent({
          calendarId: found.calendarId,
          eventId: found.eventId,
        });

        sayFr(
          vr,
          "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de l’annuler automatiquement. Le cabinet vous rappellera."
        );

        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      const cancelResult = await cancelAppointmentSafe({
        calendarId: found.calendarId,
        eventId: found.eventId,
      });

      if (!cancelResult.ok) {
        sayFr(
          vr,
          "Je n’arrive pas à annuler le rendez-vous pour le moment. Merci de rappeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      try {
        const sms = await sendAppointmentCancelledSMS({
          to: session.phone,
          patientName: session.patientName || "Patient",
          formattedSlot: formatSlotFR(found.startISO),
        });

        logInfo("SMS_SENT", {
          callSid,
          type: "CANCEL_CONFIRMATION",
          to: maskPhone(session.phone),
          sid: sms?.sid || null,
          status: sms?.status || null,
        });
      } catch (smsErr) {
        logError("SMS_FAILED", {
          callSid,
          type: "CANCEL_CONFIRMATION",
          to: maskPhone(session.phone),
          message: smsErr?.message,
        });
      }

      session.step = "CANCEL_ASK_REBOOK";
      sayFr(vr, "Votre rendez-vous est annulé.");
      promptAndGather(vr, session, "Voulez-vous reprendre un rendez-vous ?");
      return sendTwiml(res, vr);
    }

    if (session.step === "CANCEL_ASK_REBOOK") {
      const yesNo = parseYesNo(speech);

      if (yesNo === null) {
        const retry = handleRetry(vr, res, session, callSid, "CANCEL_ASK_REBOOK");
        if (retry) return retry;

        promptAndGather(
          vr,
          session,
          "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
        );
        return sendTwiml(res, vr);
      }

      if (!yesNo) {
        sayFr(vr, "Très bien.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
      }

      session.step = "BOOK_WELCOME";
      session.lastIntentContext = "BOOK";
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return sendTwiml(res, vr);
    }

    // =========================
    // Fallback
    // =========================
    const retry = handleRetry(vr, res, session, callSid, "FALLBACK");
    if (retry) return retry;

    promptAndGather(
      vr,
      session,
      getGuidedFallbackPrompt(session.step),
      "Je n’ai pas bien compris."
    );
    return sendTwiml(res, vr);
  } catch (err) {
    logError("UNEXPECTED_ERROR", {
      message: err?.message,
      stack: err?.stack,
      step: session.step,
      callSid,
      phone: maskPhone(session.phone),
      patientName: session.patientName || "",
    });

    sayFr(
      vr,
      PHRASES.errorGeneric || "Une erreur est survenue. Veuillez réessayer plus tard."
    );
    sayGoodbye(vr);
    clearSession(callSid);
    return sendTwiml(res, vr);
  }
});

module.exports = router;