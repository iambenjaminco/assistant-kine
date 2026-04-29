// src/app.js

// ✅ SENTRY — en tout premier
const Sentry = require("@sentry/node");
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  tracesSampleRate: 0.1,
});

const express = require("express");
const twilio = require("twilio");
const calendarRoutes = require("./routes/calendar.routes");
const twilioRoutes = require("./routes/twilio.routes");
const stripeRoutes = require("./routes/stripe.routes");
const redis = require("./config/redis");
const googleOAuthRoutes = require("./routes/googleOAuth.routes");

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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ⚠️ Stripe webhook AVANT TOUT et isolé
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeRoutes.handleWebhook
);

// Middlewares globaux
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Routes principales
app.use("/api/calendar", calendarRoutes);

// ✅ Validation signature Twilio — version finale IE1
app.use("/twilio", (req, res, next) => {
  const twilioSignature = req.headers["x-twilio-signature"];
  const url = `https://${req.headers["host"]}${req.originalUrl}`;
  const params = req.body || {};

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    params
  );

  if (!isValid) {
    console.warn("[TWILIO][INVALID_SIGNATURE]", { url, signature: twilioSignature });
    return res.status(403).send("Forbidden");
  }

  next();
});

app.use("/twilio", twilioRoutes);
app.use("/stripe", stripeRoutes);
app.use("/auth/google", googleOAuthRoutes);

// ✅ SENTRY — après toutes les routes
Sentry.setupExpressErrorHandler(app);

module.exports = app;