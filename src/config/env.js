require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3000,
  tz: process.env.TZ || "Europe/Paris",
  calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
  scopes: ["https://www.googleapis.com/auth/calendar"],

  workStart: process.env.WORK_START || "09:00",
  workEnd: process.env.WORK_END || "18:00",
  lunchStart: process.env.LUNCH_START || "12:00",
  lunchEnd: process.env.LUNCH_END || "13:00",
  slotMinutes: parseInt(process.env.SLOT_MINUTES || "30", 10),
};