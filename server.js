console.log("✅ server.js exécuté");
require("dotenv").config();

const app = require("./src/app");
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  console.log(`✅ Health: /health`);
  console.log(`📞 Twilio webhook: POST /twilio/voice`);
  console.log(`💳 Stripe webhook: POST /stripe/webhook`);
});