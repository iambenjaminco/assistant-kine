// src/config/cabinets.js

const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

const SLOT_MINUTES = parseInt(process.env.SLOT_MINUTES || "30", 10);

const CABINETS = {
  main: {
    displayName: "Cabinet de kinésithérapie",
    appointmentMinutes: SLOT_MINUTES,
    practitioners: [
      {
        name: "Benjamin",
        calendarId: CALENDAR_ID,
      },
    ],
  },
};

module.exports = { CABINETS };