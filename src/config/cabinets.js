// src/config/cabinets.js

const DEFAULT_CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

const SLOT_MINUTES = parseInt(process.env.SLOT_MINUTES || "30", 10);

const BENJAMIN_CALENDAR_ID =
  process.env.BENJAMIN_CALENDAR_ID || DEFAULT_CALENDAR_ID;

const LISA_CALENDAR_ID =
  process.env.LISA_CALENDAR_ID || null;

const practitioners = [
  {
    name: "Benjamin",
    calendarId: BENJAMIN_CALENDAR_ID,
  },
];

// On ajoute Lisa uniquement si un vrai calendrier séparé est configuré
if (LISA_CALENDAR_ID) {
  practitioners.push({
    name: "Lisa",
    calendarId: LISA_CALENDAR_ID,
  });
}

const CABINETS = {
  main: {
    displayName: "Cabinet de kinésithérapie",

    appointmentDurations: {
      first: parseInt(process.env.FIRST_APPOINTMENT_MINUTES || "45", 10),
      followUp: SLOT_MINUTES,
    },

    // Réglages utiles pour un vrai SaaS
    slotStepMinutes: SLOT_MINUTES,
    minLeadMinutes: parseInt(process.env.MIN_LEAD_MINUTES || "60", 10),

    practitioners,
  },
};

module.exports = { CABINETS };