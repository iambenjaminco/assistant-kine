// src/routes/calendar.routes.js
const express = require("express");
const {
  createEvent,
  updateEvent,
  deleteEvent,
  findAvailableSlots,
  suggestTwoSlotsNext7Days
} = require("../services/calendar");

const router = express.Router();

function toSafeError(err) {
  const status = err?.code || err?.response?.status || 500;
  const data = err?.response?.data || null;
  const message = err?.message || "Unknown error";
  return { status, message, data };
}

// ✅ CREATE
router.post("/events", async (req, res) => {
  try {
    const { summary, description, startISO, endISO } = req.body;

    if (!summary || !startISO || !endISO) {
      return res.status(400).json({ error: "summary, startISO, endISO requis" });
    }

    const out = await createEvent({ summary, description, startISO, endISO });
    res.json(out);
  } catch (err) {
    const e = toSafeError(err);
    res.status(e.status).json({ error: e.message, details: e.data });
  }
});

// ✅ UPDATE (PATCH)
router.patch("/events/:id", async (req, res) => {
  try {
    const out = await updateEvent(req.params.id, req.body);
    res.json(out);
  } catch (err) {
    const e = toSafeError(err);
    res.status(e.status).json({ error: e.message, details: e.data });
  }
});

// ✅ DELETE
router.delete("/events/:id", async (req, res) => {
  try {
    const out = await deleteEvent(req.params.id);
    res.json(out);
  } catch (err) {
    const e = toSafeError(err);
    res.status(e.status).json({ error: e.message, details: e.data });
  }
});

// ✅ AVAILABILITY (créneaux libres)
router.get("/availability", async (req, res) => {
  try {
    const { date, limit, minutes } = req.query;

  // 🔴 BLOQUER LES DATES PASSÉES
const today = new Date();
today.setHours(0, 0, 0, 0);

const requested = new Date(date);
requested.setHours(0, 0, 0, 0);

if (requested < today) {
  return res.status(400).json({
    error: "La date demandée est déjà passée."
  });
}

    console.log("✅ calendar.routes HIT query =", req.query);

    const slots = await findAvailableSlots({
      dateISO: date,
      limit: limit ? parseInt(limit, 10) : 3,
      slotMinutes: minutes ? parseInt(minutes, 10) : undefined,
    });

    console.log("======== DEBUG SLOTS ========");
console.log("RAW slots =", slots);
console.log("Is array ?", Array.isArray(slots));
console.log("First slot =", Array.isArray(slots) ? slots[0] : slots);
console.log("Keys of first slot =", Array.isArray(slots) && slots[0] ? Object.keys(slots[0]) : null);
console.log("================================");

    res.json({ date, slots });
  } catch (err) {
    const e = toSafeError(err);
    res.status(e.status).json({ error: e.message, details: e.data });
  }
});

// 🔥 Suggest 2 créneaux sur 7 jours
router.get("/suggest", async (req, res) => {
  try {
    const result = await suggestTwoSlotsNext7Days();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "suggest_failed" });
  }
});

module.exports = router;