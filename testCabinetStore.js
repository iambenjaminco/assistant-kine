require("dotenv").config();

const { findCabinetByTwilioNumber } = require("./src/services/cabinetsStore");

async function test() {
  const result = await findCabinetByTwilioNumber("+33412058252");
  console.log(JSON.stringify(result, null, 2));
}

test().catch((err) => {
  console.error("❌ Test error:", err);
});