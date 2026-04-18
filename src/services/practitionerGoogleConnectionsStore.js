const supabase = require("../config/supabase");

function assertSupabase() {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }
}

async function upsertPractitionerGoogleConnection({
  practitionerKey,
  cabinetId,
  practitionerName,
  googleEmail,
  accessToken,
  refreshToken,
  scope,
  tokenType,
  expiryDate,
  selectedCalendarId,
}) {
  assertSupabase();

  const payload = {
    practitioner_key: practitionerKey,
    cabinet_id: cabinetId,
    practitioner_name: practitionerName || null,
    google_email: googleEmail || null,
    access_token: accessToken,
    refresh_token: refreshToken || null,
    scope: scope || null,
    token_type: tokenType || null,
    expiry_date: expiryDate || null,
    selected_calendar_id: selectedCalendarId || null,
  };

  const { data, error } = await supabase
    .from("practitioner_google_connections")
    .upsert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("[PRACTITIONER_GOOGLE_CONNECTIONS][UPSERT_ERROR]", error);
    throw new Error("UPSERT_PRACTITIONER_GOOGLE_CONNECTION_FAILED");
  }

  return data;
}

async function getPractitionerGoogleConnection(practitionerKey) {
  assertSupabase();

  const { data, error } = await supabase
    .from("practitioner_google_connections")
    .select("*")
    .eq("practitioner_key", practitionerKey)
    .maybeSingle();

  if (error) {
    console.error("[PRACTITIONER_GOOGLE_CONNECTIONS][GET_ERROR]", error);
    throw new Error("GET_PRACTITIONER_GOOGLE_CONNECTION_FAILED");
  }

  return data || null;
}

async function setPractitionerSelectedCalendarId(practitionerKey, selectedCalendarId) {
  assertSupabase();

  const { data, error } = await supabase
    .from("practitioner_google_connections")
    .update({ selected_calendar_id: selectedCalendarId })
    .eq("practitioner_key", practitionerKey)
    .select("*")
    .single();

  if (error) {
    console.error("[PRACTITIONER_GOOGLE_CONNECTIONS][SET_CALENDAR_ERROR]", error);
    throw new Error("SET_PRACTITIONER_SELECTED_CALENDAR_FAILED");
  }

  return data;
}

module.exports = {
  upsertPractitionerGoogleConnection,
  getPractitionerGoogleConnection,
  setPractitionerSelectedCalendarId,
};