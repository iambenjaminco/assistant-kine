const express = require("express");
const calendarRoutes = require("./routes/calendar.routes");
const twilioRoutes = require("./routes/twilio.routes");

const app = express();

function pickCallSid(req) {
  return req.body?.CallSid || null;
}

function log(level, tag, msg, meta = {}) {
  const ts = new Date().toISOString();
  const base = `${ts} ${level.padEnd(5)} [${tag}] ${msg}`;
  const extra = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : "";
  console.log(base + extra);
}

app.use((req, res, next) => {
  const callSid = pickCallSid(req);
  log("INFO", "HTTP", `${req.method} ${req.path}`, callSid ? { callSid } : {});
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/test-direct", (req, res) => {
  res.json({ ok: true, message: "test direct ok" });
});

app.use("/api/calendar", calendarRoutes);
app.use("/twilio", twilioRoutes);

module.exports = app;