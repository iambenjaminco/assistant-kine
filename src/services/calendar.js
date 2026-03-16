// src/services/calendar.js
const { google } = require("googleapis");
const { getAuth } = require("../config/googleAuth");

const TIMEZONE = "Europe/Paris";
const SLOT_MINUTES = 30;
const FIRST_APPOINTMENT_MINUTES = 45;
const DEFAULT_MIN_LEAD_MINUTES = 60;
const DEFAULT_LOOKAHEAD_DAYS = 7;
const DEFAULT_MAX_SUGGESTIONS = 2;

const BUSINESS_HOURS = [
  {
    dow: [1, 2, 3, 4, 5],
    ranges: [
      { start: "08:00", end: "12:00" },
      { start: "14:00", end: "19:00" },
    ],
  },
];

const TIME_PREFERENCE_RULES = {
  MORNING: { label: "le matin", startHour: 8, endHour: 12 },
  EARLY_AFTERNOON: { label: "en début d'après-midi", startHour: 12, endHour: 15 },
  AFTERNOON: { label: "l'après-midi", startHour: 12, endHour: 18 },
  LATE_AFTERNOON: { label: "en fin d'après-midi", startHour: 16, endHour: 19 },
  EVENING: { label: "en soirée", startHour: 18, endHour: 21 },
};

const slotLocks = new Map();

function logInfo(event, data = {}) {
  console.log(`[CALENDAR][${event}]`, data);
}

function logWarn(event, data = {}) {
  console.warn(`[CALENDAR][${event}]`, data);
}

function logError(event, data = {}) {
  console.error(`[CALENDAR][${event}]`, data);
}

function lockKey(calendarId, startDate, endDate) {
  return `${calendarId}|${new Date(startDate).toISOString()}|${new Date(endDate).toISOString()}`;
}

function acquireSlotLock(key, ttlMs = 60_000) {
  const now = Date.now();
  const expiresAt = slotLocks.get(key);

  if (expiresAt && expiresAt <= now) {
    slotLocks.delete(key);
  }

  if (slotLocks.has(key)) return false;

  slotLocks.set(key, now + ttlMs);
  return true;
}

function releaseSlotLock(key) {
  slotLocks.delete(key);
}

function dateAtTime(dayDate, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  return d;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function isSlotBusy(slotStart, slotEnd, busyList) {
  for (const b of busyList) {
    const bStart = new Date(b.start);
    const bEnd = new Date(b.end);
    if (overlaps(slotStart, slotEnd, bStart, bEnd)) return true;
  }
  return false;
}

function resolveSlotMinutes({ durationMinutes, appointmentType }) {
  const n = Number(durationMinutes);

  if (Number.isFinite(n) && n > 0) return n;
  if (appointmentType === "FIRST") return FIRST_APPOINTMENT_MINUTES;

  return SLOT_MINUTES;
}

function generateCandidateSlots(startDate, days = DEFAULT_LOOKAHEAD_DAYS, slotMinutes = SLOT_MINUTES) {
  const slots = [];
  const day0 = new Date(startDate);

  for (let i = 0; i < days; i++) {
    const day = new Date(day0);
    day.setDate(day0.getDate() + i);

    const jsDow = day.getDay();
    const isoDow = jsDow === 0 ? 7 : jsDow;

    const rule = BUSINESS_HOURS.find((r) => r.dow.includes(isoDow));
    if (!rule) continue;

    for (const range of rule.ranges) {
      let cursor = dateAtTime(day, range.start);
      const end = dateAtTime(day, range.end);

      while (cursor < end) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor);
        slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);

        if (slotEnd <= end) {
          slots.push({ start: slotStart, end: slotEnd });
        }

        cursor.setMinutes(cursor.getMinutes() + SLOT_MINUTES);
      }
    }
  }

  return slots;
}

function formatSlotFR(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (Number.isNaN(d.getTime())) return "une date invalide";

  const datePart = d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TIMEZONE,
  });

  const timePart = d.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });

  return `${datePart} à ${timePart}`;
}

async function getCalendarClient() {
  const auth = await getAuth();
  return google.calendar({ version: "v3", auth });
}

async function getBusyPeriods(calendar, calendarId, timeMin, timeMax) {
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const cal = res.data.calendars?.[calendarId];
  return cal?.busy ?? [];
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizePhone(s) {
  return (s || "").toString().replace(/\D/g, "");
}

function extractPatientNameFromEvent(ev) {
  const description = ev?.description || "";
  const lines = description.split("\n").map((line) => line.trim());

  const patientLine = lines.find((line) =>
    normalizeText(line).startsWith("patient :")
  );

  if (!patientLine) return null;

  const patientName = patientLine.split(":").slice(1).join(":").trim();
  return patientName || null;
}

function extractPhoneFromEvent(ev) {
  const description = ev?.description || "";
  const lines = description.split("\n").map((line) => line.trim());

  const phoneLine = lines.find((line) => {
    const normalized = normalizeText(line);
    return normalized.startsWith("telephone :") || normalized.startsWith("téléphone :");
  });

  if (!phoneLine) return "";

  const phone = phoneLine.split(":").slice(1).join(":").trim();
  return normalizePhone(phone);
}

function getTimePreferenceRule(timePreference) {
  return TIME_PREFERENCE_RULES[timePreference] || null;
}

function getHourInParis(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    hour12: false,
    timeZone: TIMEZONE,
  });

  const parts = formatter.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
  return Number.isFinite(hour) ? hour : null;
}

function matchesTimePreference(slotStart, timePreference) {
  const rule = getTimePreferenceRule(timePreference);
  if (!rule) return true;

  const hour = getHourInParis(slotStart);
  if (!Number.isFinite(hour)) return true;

  return hour >= rule.startHour && hour < rule.endHour;
}

function practitionerSortKey(practitioner) {
  return normalizeText(practitioner?.name || "");
}

function buildOrderedPractitioners(practitioners) {
  return [...practitioners].sort((a, b) => {
    const aKey = practitionerSortKey(a);
    const bKey = practitionerSortKey(b);
    return aKey.localeCompare(bKey, "fr");
  });
}

function buildSlotSpeech(slots, { emptySpeech, timePreference } = {}) {
  const available = slots || [];

  if (!available.length) {
    if (timePreference && getTimePreferenceRule(timePreference)) {
      return `Je n’ai pas trouvé de disponibilité ${getTimePreferenceRule(timePreference).label}.`;
    }
    return emptySpeech || "Je n’ai pas trouvé de disponibilité.";
  }

  const a = available[0];
  const b = available[1] || available[0];

  if (b && b.start && a.start && b.start !== a.start) {
    return `Je peux vous proposer ${formatSlotFR(a.start)}${
      a.practitionerName ? ` avec ${a.practitionerName}` : ""
    } ou ${formatSlotFR(b.start)}${
      b.practitionerName ? ` avec ${b.practitionerName}` : ""
    }.`;
  }

  return `Je peux vous proposer ${formatSlotFR(a.start)}${
    a.practitionerName ? ` avec ${a.practitionerName}` : ""
  }.`;
}

function selectAvailableSlots({
  candidates,
  practitioners,
  busyByCal,
  cutoff,
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  timePreference = null,
}) {
  const orderedPractitioners = buildOrderedPractitioners(practitioners);
  const available = [];
  const seenKeys = new Set();

  for (const c of candidates) {
    if (c.start < cutoff) continue;
    if (!matchesTimePreference(c.start, timePreference)) continue;

    for (const p of orderedPractitioners) {
      const busy = busyByCal[p.calendarId] || [];
      if (isSlotBusy(c.start, c.end, busy)) continue;

      const key = `${p.calendarId}|${c.start.toISOString()}|${c.end.toISOString()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      available.push({
        start: c.start,
        end: c.end,
        calendarId: p.calendarId,
        practitionerName: p.name,
      });
      break;
    }

    if (available.length >= maxSuggestions) break;
  }

  return available;
}

async function createAppointment({
  calendarId = "primary",
  patientName,
  reason = "Rendez-vous kiné",
  startDate,
  endDate,
  phone,
  appointmentType,
  durationMinutes,
}) {
  const calendar = await getCalendarClient();

  const start = new Date(startDate);
  let end = new Date(endDate);

  if (!(end > start)) {
    const effectiveMinutes = resolveSlotMinutes({ durationMinutes, appointmentType });
    end = new Date(start);
    end.setMinutes(end.getMinutes() + effectiveMinutes);
  }

  const effectiveDurationMinutes = Math.round(
    (end.getTime() - start.getTime()) / 60000
  );

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const lines = [
    reason || "Rendez-vous kiné",
    `Patient : ${patientName || "Patient"}`,
    ...(phone ? [`Téléphone : ${phone}`] : []),
    ...(appointmentType ? [`Type : ${appointmentType}`] : []),
    `Durée : ${effectiveDurationMinutes} min`,
    "Origine : Assistant vocal SaaS",
    "Canal : Téléphone",
  ];

  const description = lines.join("\n");

  const event = {
    summary: `RDV kiné - ${patientName || "Patient"}`,
    description,
    start: { dateTime: startIso, timeZone: TIMEZONE },
    end: { dateTime: endIso, timeZone: TIMEZONE },
  };

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  return res.data;
}

async function isSlotAvailable({ calendarId = "primary", startDate, endDate }) {
  const calendar = await getCalendarClient();

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (!(end > start)) {
    throw new Error("Créneau invalide : endDate doit être après startDate");
  }

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busy = res.data.calendars?.[calendarId]?.busy ?? [];
  return busy.length === 0;
}

async function bookAppointmentSafe({
  calendarId = "primary",
  patientName,
  reason,
  startDate,
  endDate,
  phone,
  appointmentType,
  durationMinutes,
}) {
  const start = new Date(startDate);
  let end = new Date(endDate);

  if (!(end > start)) {
    const effectiveMinutes = resolveSlotMinutes({ durationMinutes, appointmentType });
    end = new Date(start);
    end.setMinutes(end.getMinutes() + effectiveMinutes);
  }

  const key = lockKey(calendarId, start, end);

  const gotLock = acquireSlotLock(key, 60_000);
  if (!gotLock) return { ok: false, code: "LOCKED" };

  try {
    const ok = await isSlotAvailable({
      calendarId,
      startDate: start,
      endDate: end,
    });

    if (!ok) return { ok: false, code: "TAKEN" };

    const event = await createAppointment({
      calendarId,
      patientName,
      reason,
      startDate: start,
      endDate: end,
      phone,
      appointmentType,
      durationMinutes,
    });

    return { ok: true, event };
  } finally {
    releaseSlotLock(key);
  }
}

function assertPractitioners(practitioners) {
  if (!Array.isArray(practitioners) || practitioners.length === 0) {
    throw new Error("practitioners requis (tableau non vide)");
  }

  for (const p of practitioners) {
    if (!p.calendarId) throw new Error("practitioner.calendarId manquant");
    if (!p.name) throw new Error("practitioner.name manquant");
  }
}

async function suggestTwoSlotsNext7Days({
  practitioners,
  days = DEFAULT_LOOKAHEAD_DAYS,
  durationMinutes,
  appointmentType,
  timePreference = null,
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  minLeadMinutes = DEFAULT_MIN_LEAD_MINUTES,
}) {
  assertPractitioners(practitioners);

  const calendar = await getCalendarClient();
  const slotMinutes = resolveSlotMinutes({ durationMinutes, appointmentType });

  const now = new Date();
  const timeMin = new Date(now);
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + days);

  const busyEntries = await Promise.all(
    practitioners.map(async (p) => {
      const busy = await getBusyPeriods(calendar, p.calendarId, timeMin, timeMax);
      return [p.calendarId, busy];
    })
  );

  const busyByCal = Object.fromEntries(busyEntries);
  const candidates = generateCandidateSlots(now, days, slotMinutes);

  const cutoff = new Date(now);
  cutoff.setMinutes(cutoff.getMinutes() + minLeadMinutes);

  const available = selectAvailableSlots({
    candidates,
    practitioners,
    busyByCal,
    cutoff,
    maxSuggestions,
    timePreference,
  });

  logInfo("SUGGEST_NEXT_7_DAYS", {
    practitioners: practitioners.map((p) => p.name),
    days,
    slotMinutes,
    appointmentType: appointmentType || null,
    timePreference,
    results: available.map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      practitionerName: slot.practitionerName,
    })),
  });

  return {
    slots: available.slice(0, maxSuggestions),
    speech: buildSlotSpeech(available.slice(0, maxSuggestions), {
      emptySpeech: "Je n’ai pas de créneau disponible sur les 7 prochains jours.",
      timePreference,
    }),
  };
}

async function suggestTwoSlotsFromDate({
  practitioners,
  fromDate,
  days = DEFAULT_LOOKAHEAD_DAYS,
  durationMinutes,
  appointmentType,
  timePreference = null,
  maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  minLeadMinutes = DEFAULT_MIN_LEAD_MINUTES,
}) {
  assertPractitioners(practitioners);

  const calendar = await getCalendarClient();
  const slotMinutes = resolveSlotMinutes({ durationMinutes, appointmentType });

  const start = new Date(fromDate);
  const timeMax = new Date(start);
  timeMax.setDate(timeMax.getDate() + days);

  const busyEntries = await Promise.all(
    practitioners.map(async (p) => {
      const busy = await getBusyPeriods(calendar, p.calendarId, start, timeMax);
      return [p.calendarId, busy];
    })
  );

  const busyByCal = Object.fromEntries(busyEntries);
  const candidates = generateCandidateSlots(start, days, slotMinutes);

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMinutes(cutoff.getMinutes() + minLeadMinutes);

  const effectiveCutoff = start > cutoff ? start : cutoff;

  const available = selectAvailableSlots({
    candidates,
    practitioners,
    busyByCal,
    cutoff: effectiveCutoff,
    maxSuggestions,
    timePreference,
  });

  logInfo("SUGGEST_FROM_DATE", {
    practitioners: practitioners.map((p) => p.name),
    fromDate: start.toISOString(),
    days,
    slotMinutes,
    appointmentType: appointmentType || null,
    timePreference,
    results: available.map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      practitionerName: slot.practitionerName,
    })),
  });

  return {
    slots: available.slice(0, maxSuggestions),
    speech: buildSlotSpeech(available.slice(0, maxSuggestions), {
      emptySpeech: "Je n’ai pas trouvé de disponibilité à partir de cette date.",
      timePreference,
    }),
  };
}

async function findNextAppointmentSafe({ practitioners, patientName, phone }) {
  assertPractitioners(practitioners);

  const calendar = await getCalendarClient();
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm) return null;

  const now = new Date();
  const timeMin = now.toISOString();

  let best = null;

  for (const p of practitioners) {
    const res = await calendar.events.list({
      calendarId: p.calendarId,
      timeMin,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    });

    const items = res.data.items || [];

    for (const ev of items) {
      if (ev.status === "cancelled") continue;

      const startISO = ev.start?.dateTime || ev.start?.date;
      if (!startISO) continue;

      const eventPhone = extractPhoneFromEvent(ev);
      if (eventPhone !== phoneNorm) continue;

      const candidate = {
        calendarId: p.calendarId,
        eventId: ev.id,
        startISO,
        summary: ev.summary || "",
        patientName: extractPatientNameFromEvent(ev),
      };

      if (!best) {
        best = candidate;
        continue;
      }

      const bestTime = new Date(best.startISO).getTime();
      const candTime = new Date(candidate.startISO).getTime();

      if (candTime < bestTime) best = candidate;
    }
  }

  if (!best) return null;

  return {
    calendarId: best.calendarId,
    eventId: best.eventId,
    startISO: best.startISO,
    summary: best.summary,
    patientName: best.patientName,
  };
}

async function addCallbackNoteToEvent({ calendarId, eventId }) {
  const calendar = await getCalendarClient();

  const { data: ev } = await calendar.events.get({
    calendarId,
    eventId,
  });

  const currentDescription = String(ev.description || "");
  const note = "Note : rappeler le client";

  if (currentDescription.includes(note)) {
    return { ok: true, alreadyPresent: true };
  }

  const updatedDescription = currentDescription
    ? `${currentDescription}\n${note}`
    : note;

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      description: updatedDescription,
    },
  });

  return { ok: true, alreadyPresent: false };
}

async function cancelAppointmentSafe({ calendarId, eventId }) {
  const calendar = await getCalendarClient();

  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
    return { ok: true };
  } catch (error) {
    logError("DELETE_FAILED", {
      calendarId,
      eventId,
      message: error?.message,
    });

    return {
      ok: false,
      code: "DELETE_FAILED",
      message: error?.message || "Impossible de supprimer le rendez-vous",
    };
  }
}

module.exports = {
  createAppointment,
  formatSlotFR,
  isSlotAvailable,
  bookAppointmentSafe,
  suggestTwoSlotsNext7Days,
  suggestTwoSlotsFromDate,
  findNextAppointmentSafe,
  addCallbackNoteToEvent,
  cancelAppointmentSafe,
  getTimePreferenceRule,
};