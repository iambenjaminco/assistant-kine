// src/services/calendar.js
const { google } = require("googleapis");
const { getAuth } = require("../config/googleAuth");

const TIMEZONE = "Europe/Paris";
const SLOT_MINUTES = 30;
const FIRST_APPOINTMENT_MINUTES = 45; // fallback de sécurité

const BUSINESS_HOURS = [
  {
    dow: [1, 2, 3, 4, 5],
    ranges: [
      { start: "08:00", end: "12:00" },
      { start: "14:00", end: "19:00" },
    ],
  },
];

// ✅ Lock en mémoire pour éviter les doubles réservations (MVP)
const slotLocks = new Map();

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

function generateCandidateSlots(startDate, days = 7, slotMinutes = SLOT_MINUTES) {
  const slots = [];
  const day0 = new Date(startDate);

  for (let i = 0; i < days; i++) {
    const day = new Date(day0);
    day.setDate(day0.getDate() + i);

    const jsDow = day.getDay(); // 0=dim..6=sam
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

        // On continue par pas de 30 min pour garder une grille simple
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
    "Origine : Assistant vocal",
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

// ======================================================
// ✅ Suggestions multi-praticiens
// ======================================================

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
  days = 7,
  durationMinutes,
  appointmentType,
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

  const minLeadMinutes = 60;
  const cutoff = new Date(now);
  cutoff.setMinutes(cutoff.getMinutes() + minLeadMinutes);

  const available = [];
  for (const c of candidates) {
    if (c.start < cutoff) continue;

    for (const p of practitioners) {
      const busy = busyByCal[p.calendarId] || [];
      if (!isSlotBusy(c.start, c.end, busy)) {
        available.push({
          start: c.start,
          end: c.end,
          calendarId: p.calendarId,
          practitionerName: p.name,
        });
        break;
      }
    }

    if (available.length >= 2) break;
  }

  const a = available[0];
  const b = available[1] || available[0];

  return {
    slots: available.slice(0, 2),
    speech: available.length
      ? `Je peux vous proposer ${formatSlotFR(a.start)}${
          a.practitionerName ? ` avec ${a.practitionerName}` : ""
        } ou ${formatSlotFR(b.start)}${
          b.practitionerName ? ` avec ${b.practitionerName}` : ""
        }.`
      : "Je n’ai pas de créneau disponible sur les 7 prochains jours.",
  };
}

async function suggestTwoSlotsFromDate({
  practitioners,
  fromDate,
  days = 7,
  durationMinutes,
  appointmentType,
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
  const available = [];

  for (const c of candidates) {
    if (c.start < start) continue;

    for (const p of practitioners) {
      const busy = busyByCal[p.calendarId] || [];
      if (!isSlotBusy(c.start, c.end, busy)) {
        available.push({
          start: c.start,
          end: c.end,
          calendarId: p.calendarId,
          practitionerName: p.name,
        });
        break;
      }
    }

    if (available.length >= 2) break;
  }

  const a = available[0];
  const b = available[1] || available[0];

  return {
    slots: available.slice(0, 2),
    speech: available.length
      ? `Je peux vous proposer ${formatSlotFR(a.start)}${
          a.practitionerName ? ` avec ${a.practitionerName}` : ""
        } ou ${formatSlotFR(b.start)}${
          b.practitionerName ? ` avec ${b.practitionerName}` : ""
        }.`
      : "Je n’ai pas trouvé de disponibilité à partir de cette date.",
  };
}

// ======================================================
// ✅ Recherche + annulation Google Calendar
// ======================================================

// Cherche le prochain RDV correspondant au téléphone.
// Retour: null ou { calendarId, eventId, startISO, summary, patientName }
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
      const summary = ev.summary || "";
      const desc = ev.description || "";

      const summaryPhoneNorm = normalizePhone(summary);
      const descPhoneNorm = normalizePhone(desc);

      const phoneOk =
        summaryPhoneNorm.includes(phoneNorm) ||
        descPhoneNorm.includes(phoneNorm);

      if (!phoneOk) continue;

      const startISO = ev.start?.dateTime || ev.start?.date;
      if (!startISO) continue;

      const candidate = {
        calendarId: p.calendarId,
        eventId: ev.id,
        startISO,
        summary,
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
  await calendar.events.delete({
    calendarId,
    eventId,
  });
  return { ok: true };
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
};