const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase non configuré");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false, // important en backend
  },
  global: {
    headers: {
      "x-application-name": "assistant-kine-saas",
    },
  },
});

module.exports = supabase;