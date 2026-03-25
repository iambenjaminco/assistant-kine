console.log("✅ server.js exécuté");
require("dotenv").config();

const app = require("./src/app");
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`📞 Twilio webhook: POST /twilio/voice`);
});

const express = require("express");
const stripeRoutes = require("./src/routes/stripe.routes");

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ IMPORTANT : webhook Stripe AVANT express.json()
app.use("/stripe/webhook", express.raw({ type: "application/json" }));

// JSON pour le reste
app.use(express.json());

// Routes Stripe
app.use("/stripe", stripeRoutes);

// Route test (optionnel)
app.get("/health", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  console.log(`🌍 URL: https://assistant-kine-production.up.railway.app`);
});