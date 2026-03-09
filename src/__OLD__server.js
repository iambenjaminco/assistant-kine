const { suggestTwoSlotsNext7Days } = require("./services/__OLD__calendar_test.js");
// src/server.js
const express = require("express");
require("dotenv").config();

const calendarRoutes = require("./routes/calendar.routes.js");

const app = express();
app.use(express.json());

// ✅ branchement des routes calendrier
app.use("/api/calendar", calendarRoutes);

// ✅ petit healthcheck
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});