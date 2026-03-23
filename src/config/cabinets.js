// src/config/cabinets.js

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "Europe/Paris";
const DEFAULT_CABINET_KEY = process.env.DEFAULT_CABINET_KEY || "main";

const DEFAULT_CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

// -------------------------
// Réglages cabinet principal
// -------------------------
const MAIN_SLOT_MINUTES = parseInt(process.env.MAIN_SLOT_MINUTES || "30", 10);
const MAIN_FIRST_APPOINTMENT_MINUTES = parseInt(
  process.env.MAIN_FIRST_APPOINTMENT_MINUTES || "45",
  10
);
const MAIN_MIN_LEAD_MINUTES = parseInt(
  process.env.MAIN_MIN_LEAD_MINUTES || "60",
  10
);
const MAIN_LOOKAHEAD_DAYS = parseInt(
  process.env.MAIN_LOOKAHEAD_DAYS || "7",
  10
);
const MAIN_MAX_SUGGESTIONS = parseInt(
  process.env.MAIN_MAX_SUGGESTIONS || "2",
  10
);
const MAIN_CANCEL_MODIFY_LIMIT_HOURS = parseInt(
  process.env.MAIN_CANCEL_MODIFY_LIMIT_HOURS || "24",
  10
);

const BENJAMIN_CALENDAR_ID =
  process.env.BENJAMIN_CALENDAR_ID || DEFAULT_CALENDAR_ID;
const LISA_CALENDAR_ID = process.env.LISA_CALENDAR_ID || null;

// -------------------------
// Réglages cabinet 2
// -------------------------
const CABINET2_TIMEZONE = process.env.CABINET2_TIMEZONE || DEFAULT_TIMEZONE;

const CABINET2_SLOT_MINUTES = parseInt(
  process.env.CABINET2_SLOT_MINUTES || "30",
  10
);
const CABINET2_FIRST_APPOINTMENT_MINUTES = parseInt(
  process.env.CABINET2_FIRST_APPOINTMENT_MINUTES || "45",
  10
);
const CABINET2_MIN_LEAD_MINUTES = parseInt(
  process.env.CABINET2_MIN_LEAD_MINUTES || "60",
  10
);
const CABINET2_LOOKAHEAD_DAYS = parseInt(
  process.env.CABINET2_LOOKAHEAD_DAYS || "7",
  10
);
const CABINET2_MAX_SUGGESTIONS = parseInt(
  process.env.CABINET2_MAX_SUGGESTIONS || "2",
  10
);
const CABINET2_CANCEL_MODIFY_LIMIT_HOURS = parseInt(
  process.env.CABINET2_CANCEL_MODIFY_LIMIT_HOURS || "24",
  10
);

const CABINET2_DISPLAY_NAME =
  process.env.CABINET2_DISPLAY_NAME || "Cabinet 2 de kinésithérapie";

const CABINET2_JULIEN_CALENDAR_ID =
  process.env.CABINET2_JULIEN_CALENDAR_ID || null;
const CABINET2_EMMA_CALENDAR_ID =
  process.env.CABINET2_EMMA_CALENDAR_ID || null;

function buildPractitioner({ name, calendarId, cabinetKey }) {
  if (!name || !calendarId) return null;

  return {
    name,
    calendarId,
    cabinetKey,
  };
}

const mainPractitioners = [
  buildPractitioner({
    name: "Benjamin",
    calendarId: BENJAMIN_CALENDAR_ID,
    cabinetKey: "main",
  }),
].filter(Boolean);

if (LISA_CALENDAR_ID) {
  const lisa = buildPractitioner({
    name: "Lisa",
    calendarId: LISA_CALENDAR_ID,
    cabinetKey: "main",
  });

  if (lisa) mainPractitioners.push(lisa);
}

const cabinet2Practitioners = [
  buildPractitioner({
    name: "Julien",
    calendarId: CABINET2_JULIEN_CALENDAR_ID,
    cabinetKey: "cabinet2",
  }),
  buildPractitioner({
    name: "Emma",
    calendarId: CABINET2_EMMA_CALENDAR_ID,
    cabinetKey: "cabinet2",
  }),
].filter(Boolean);

const CABINETS = {
  main: {
    key: "main",
    displayName: "Cabinet de kinésithérapie",
    timezone: DEFAULT_TIMEZONE,

    scheduling: {
      appointmentDurations: {
        first: MAIN_FIRST_APPOINTMENT_MINUTES,
        followUp: MAIN_SLOT_MINUTES,
      },
      slotStepMinutes: MAIN_SLOT_MINUTES,
      minLeadMinutes: MAIN_MIN_LEAD_MINUTES,
      lookaheadDays: MAIN_LOOKAHEAD_DAYS,
      maxSuggestions: MAIN_MAX_SUGGESTIONS,
      cancelModifyLimitHours: MAIN_CANCEL_MODIFY_LIMIT_HOURS,
    },

    openingHours: [
      {
        dow: [1, 2, 3, 4, 5],
        ranges: [
          { start: "08:00", end: "12:00" },
          { start: "14:00", end: "19:00" },
        ],
      },
    ],

    observesPublicHolidays: true,
    publicHolidayCountry: "FR",

    closedDates: [
      // { date: "2026-08-15", reason: "Fermeture exceptionnelle" },
    ],

    closedPeriods: [
      // { start: "2026-08-01", end: "2026-08-15", reason: "Congés d'été" },
    ],

    openingOverrides: [
      // {
      //   date: "2026-06-14",
      //   ranges: [{ start: "09:00", end: "13:00" }],
      //   reason: "Ouverture exceptionnelle",
      // },
    ],

    inboundNumbers: process.env.MAIN_CABINET_INBOUND_NUMBERS
      ? process.env.MAIN_CABINET_INBOUND_NUMBERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],

    sms: {
      enabled: true,
      from:
        process.env.TWILIO_SMS_FROM ||
        process.env.TWILIO_PHONE_NUMBER ||
        null,
    },

    practitioners: mainPractitioners,
  },

  cabinet2: {
    key: "cabinet2",
    displayName: CABINET2_DISPLAY_NAME,
    timezone: CABINET2_TIMEZONE,

    scheduling: {
      appointmentDurations: {
        first: CABINET2_FIRST_APPOINTMENT_MINUTES,
        followUp: CABINET2_SLOT_MINUTES,
      },
      slotStepMinutes: CABINET2_SLOT_MINUTES,
      minLeadMinutes: CABINET2_MIN_LEAD_MINUTES,
      lookaheadDays: CABINET2_LOOKAHEAD_DAYS,
      maxSuggestions: CABINET2_MAX_SUGGESTIONS,
      cancelModifyLimitHours: CABINET2_CANCEL_MODIFY_LIMIT_HOURS,
    },

    openingHours: [
      {
        dow: [1, 2, 3, 4, 5],
        ranges: [
          { start: "09:00", end: "12:30" },
          { start: "14:00", end: "18:30" },
        ],
      },
    ],

    observesPublicHolidays: true,
    publicHolidayCountry: "FR",

    closedDates: [
      // { date: "2026-12-24", reason: "Fermeture exceptionnelle" },
    ],

    closedPeriods: [
      // { start: "2026-08-10", end: "2026-08-20", reason: "Congés d'été" },
    ],

    openingOverrides: [
      // {
      //   date: "2026-05-08",
      //   ranges: [{ start: "10:00", end: "16:00" }],
      //   reason: "Ouverture exceptionnelle",
      // },
    ],

    inboundNumbers: process.env.CABINET2_INBOUND_NUMBERS
      ? process.env.CABINET2_INBOUND_NUMBERS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],

    sms: {
      enabled: true,
      from:
        process.env.TWILIO_SMS_FROM ||
        process.env.TWILIO_PHONE_NUMBER ||
        null,
    },

    practitioners: cabinet2Practitioners,
  },
};

function getCabinetByKey(cabinetKey) {
  return CABINETS[cabinetKey] || null;
}

function getDefaultCabinet() {
  return CABINETS[DEFAULT_CABINET_KEY] || Object.values(CABINETS)[0] || null;
}

function normalizePhoneNumberForLookup(phone) {
  return String(phone || "").replace(/\s+/g, "");
}

function getCabinetByInboundNumber(phone) {
  const normalized = normalizePhoneNumberForLookup(phone);
  if (!normalized) return null;

  return (
    Object.values(CABINETS).find((cabinet) =>
      (cabinet.inboundNumbers || []).some(
        (n) => normalizePhoneNumberForLookup(n) === normalized
      )
    ) || null
  );
}

function resolveCabinetFromInboundNumber(phone) {
  return getCabinetByInboundNumber(phone) || getDefaultCabinet();
}

module.exports = {
  CABINETS,
  DEFAULT_CABINET_KEY,
  getCabinetByKey,
  getDefaultCabinet,
  getCabinetByInboundNumber,
  resolveCabinetFromInboundNumber,
};