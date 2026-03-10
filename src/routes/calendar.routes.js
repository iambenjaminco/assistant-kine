console.log("🔥 CALENDAR.ROUTES.JS CHARGÉ");
// src/routes/calendar.routes.js
const express = require("express");
const { google } = require("googleapis");
const { getAuth } = require("../config/googleAuth");
const {
  suggestTwoSlotsNext7Days,
  findNextAppointmentSafe,
  cancelAppointmentSafe,
  bookAppointmentSafe,
} = require("../services/calendar");
const { CABINETS } = require("../config/cabinets");

const router = express.Router();

function getCabinet() {
  const cabinet = Object.values(CABINETS)[0];
  if (!cabinet) {
    throw new Error("Aucun cabinet configuré");
  }
  if (!cabinet.practitioners || !cabinet.practitioners.length) {
    throw new Error("Aucun praticien configuré");
  }
  return cabinet;
}

// ✅ Test auth Google Calendar
router.get("/test-google", async (req, res) => {
  try {
    const auth = await getAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const result = await calendar.calendarList.list();

    return res.json({
      ok: true,
      calendars: (result.data.items || []).map((c) => ({
        id: c.id,
        summary: c.summary,
        accessRole: c.accessRole,
      })),
    });
  } catch (err) {
    console.error("TEST GOOGLE ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
      stack: err.stack,
    });
  }
});

// ✅ Test suggestions de créneaux
router.get("/test-suggest", async (req, res) => {
  try {
    const cabinet = getCabinet();
    const result = await suggestTwoSlotsNext7Days({
      practitioners: cabinet.practitioners,
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("TEST SUGGEST ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
      stack: err.stack,
    });
  }
});

// ✅ Test recherche prochain RDV par téléphone
router.get("/test-find-next", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({
        ok: false,
        message: "Paramètre phone requis",
      });
    }

    const cabinet = getCabinet();
    const result = await findNextAppointmentSafe({
      practitioners: cabinet.practitioners,
      phone,
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("TEST FIND NEXT ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
      stack: err.stack,
    });
  }
});

// ✅ Test réservation manuelle
router.post("/test-book", async (req, res) => {
  try {
    const { calendarId, patientName, startDate, endDate, phone } = req.body;

    if (!calendarId || !startDate || !endDate) {
      return res.status(400).json({
        ok: false,
        message: "calendarId, startDate et endDate requis",
      });
    }

    const result = await bookAppointmentSafe({
      calendarId,
      patientName: patientName || "Patient test",
      reason: "Rendez-vous kiné",
      startDate,
      endDate,
      phone: phone || "",
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("TEST BOOK ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
      stack: err.stack,
    });
  }
});

// ✅ Test annulation manuelle
router.post("/test-cancel", async (req, res) => {
  try {
    const { calendarId, eventId } = req.body;

    if (!calendarId || !eventId) {
      return res.status(400).json({
        ok: false,
        message: "calendarId et eventId requis",
      });
    }

    const result = await cancelAppointmentSafe({ calendarId, eventId });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("TEST CANCEL ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
      stack: err.stack,
    });
  }
});

module.exports = router;