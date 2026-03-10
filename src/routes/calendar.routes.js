// src/routes/calendar.routes.js

const express = require("express");
const router = express.Router();

/*
  Ce routeur est volontairement vide.

  Toute la logique calendrier (suggestion de créneaux,
  création de rendez-vous, annulation, etc.)
  est utilisée directement par twilio.routes.js
  via le service :

  src/services/calendar.js
*/

// Route de santé optionnelle pour debug API
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "calendar" });
});

module.exports = router;