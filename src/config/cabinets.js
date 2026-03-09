// src/config/cabinets.js

const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";

const CABINETS = {
  main: {
    displayName: "Cabinet de kinésithérapie",
    appointmentMinutes: parseInt(process.env.SLOT_MINUTES || "30", 10),

    practitioners: [
      {
        name: "Benjamin",
        calendarId: CALENDAR_ID,
      },
    ],
  },
};

module.exports = { CABINETS };