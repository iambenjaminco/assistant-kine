console.log("✅ server.js exécuté");
require("dotenv").config();

const app = require("./src/app");
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`📞 Twilio webhook: POST /twilio/voice`);
});