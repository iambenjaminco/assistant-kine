// src/app.js

const express = require("express");
const calendarRoutes = require("./routes/calendar.routes");
const twilioRoutes = require("./routes/twilio.routes");
const stripeRoutes = require("./routes/stripe.routes");
const redis = require("./config/redis");
const googleOAuthRoutes = require("./routes/googleOAuth.routes");

const app = express();

// Logger simple
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

// Santé serveur
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ⚠️ Stripe webhook AVANT les parseurs globaux
app.use("/stripe/webhook", express.raw({ type: "application/json" }));

// Middlewares globaux
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Routes principales
app.use("/api/calendar", calendarRoutes);
app.use("/twilio", twilioRoutes);
app.use("/stripe", stripeRoutes);
app.use("/auth/google", googleOAuthRoutes);

module.exports = app;