// src/config/cabinets.js

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "Europe/Paris";
const DEFAULT_CABINET_KEY = process.env.DEFAULT_CABINET_KEY || "main";

const DEFAULT_CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

const SLOT_MINUTES = parseInt(process.env.SLOT_MINUTES || "30", 10);
const FIRST_APPOINTMENT_MINUTES = parseInt(
  process.env.FIRST_APPOINTMENT_MINUTES || "45",
  10
);
const MIN_LEAD_MINUTES = parseInt(process.env.MIN_LEAD_MINUTES || "60", 10);

const BENJAMIN_CALENDAR_ID =
  process.env.BENJAMIN_CALENDAR_ID || DEFAULT_CALENDAR_ID;

const LISA_CALENDAR_ID = process.env.LISA_CALENDAR_ID || null;

function buildPractitioner({ name, calendarId, cabinetKey }) {
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
];

if (LISA_CALENDAR_ID) {
  mainPractitioners.push(
    buildPractitioner({
      name: "Lisa",
      calendarId: LISA_CALENDAR_ID,
      cabinetKey: "main",
    })
  );
}

const CABINETS = {
  main: {
    key: "main",
    displayName: "Cabinet de kinésithérapie",
    timezone: DEFAULT_TIMEZONE,

    appointmentDurations: {
      first: FIRST_APPOINTMENT_MINUTES,
      followUp: SLOT_MINUTES,
    },

    slotStepMinutes: SLOT_MINUTES,
    minLeadMinutes: MIN_LEAD_MINUTES,
    lookaheadDays: parseInt(process.env.LOOKAHEAD_DAYS || "7", 10),
    maxSuggestions: parseInt(process.env.MAX_SUGGESTIONS || "2", 10),

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
      // Exemple :
      // { date: "2026-08-15", reason: "Fermeture exceptionnelle" },
    ],

    closedPeriods: [
      // Exemple :
      // { start: "2026-08-01", end: "2026-08-15", reason: "Congés d'été" },
    ],

    openingOverrides: [
      // Exemple :
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

    practitioners: mainPractitioners,
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

module.exports = {
  CABINETS,
  DEFAULT_CABINET_KEY,
  getCabinetByKey,
  getDefaultCabinet,
  getCabinetByInboundNumber,
};