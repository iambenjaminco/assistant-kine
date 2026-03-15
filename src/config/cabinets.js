// src/config/cabinets.js

const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

const SLOT_MINUTES = parseInt(process.env.SLOT_MINUTES || "30", 10);

const CABINETS = {
  main: {
    displayName: "Cabinet de kinésithérapie",

    // Durée des rendez-vous par type
    appointmentDurations: {
      first: 45, // premier rendez-vous
      followUp: SLOT_MINUTES, // suivi
    },

    practitioners: [
      {
        name: "Benjamin",
        calendarId: CALENDAR_ID,
      },

      // 👇 Kiné fictif pour tester la logique multi-praticiens
      {
        name: "Lisa",
        calendarId: CALENDAR_ID,
      },
    ],
  },
};

module.exports = { CABINETS };