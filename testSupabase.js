require("dotenv").config();

const supabase = require("./src/config/supabase");

async function test() {
  const { data, error } = await supabase
    .from("cabinets")
    .select("*");

  if (error) {
    console.error("❌ Erreur:", error.message);
  } else {
    console.log("✅ Connexion OK", data);
  }
}

test();