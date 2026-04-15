const supabase = require("../config/supabase");

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function mapDbCabinetToApp(row) {
  if (!row) return null;

  const practitioners = Array.isArray(row.practitioners) ? row.practitioners : [];

  return {
    key: row.id,
    id: row.id,
    name: row.name || "",
    status: row.status || null,
    timezone: row.timezone || "Europe/Paris",

    practitioners: practitioners.filter(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof p.name === "string" &&
        p.name.trim() &&
        typeof p.calendarId === "string" &&
        p.calendarId.trim()
    ),

    twilioPhoneNumber: row.twilio_phone_number || "",
    smsPhoneNumber: row.sms_phone_number || "",
    transferPhoneNumber: row.transfer_phone_number || "",

    addressSpeech: row.address_speech || "",
    hoursSpeech: row.hours_speech || "",

    appointmentDurations:
      row.appointment_durations &&
        typeof row.appointment_durations === "object" &&
        !Array.isArray(row.appointment_durations)
        ? row.appointment_durations
        : {},

    scheduling:
      row.scheduling &&
        typeof row.scheduling === "object" &&
        !Array.isArray(row.scheduling)
        ? row.scheduling
        : {},

    openingHours: Array.isArray(row.opening_hours)
      ? row.opening_hours
      : [],

    observesPublicHolidays: Boolean(row.observes_public_holidays),
    publicHolidayCountry: row.public_holiday_country || "FR",

    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,

    createdAt: row.created_at || null,
  };
}

function mapAppUpdatesToDb(cabinetId, updates = {}) {
  const rawPhone =
    updates.twilioPhoneNumber ??
    updates.twilio_phone_number;

  const normalizedPhone =
    rawPhone !== undefined ? normalizePhone(rawPhone) : undefined;

  return {
    id: cabinetId,

    name: updates.name,
    status: updates.status,
    timezone: updates.timezone,

    practitioners: Array.isArray(updates.practitioners)
      ? updates.practitioners
      : updates.practitioners === null
        ? []
        : undefined,

    twilio_phone_number: rawPhone,
    twilio_phone_number_normalized: normalizedPhone,

    sms_phone_number:
      updates.smsPhoneNumber ??
      updates.sms_phone_number,

    transfer_phone_number:
      updates.transferPhoneNumber ??
      updates.transfer_phone_number,

    stripe_customer_id:
      updates.stripeCustomerId ??
      updates.stripe_customer_id,

    stripe_subscription_id:
      updates.stripeSubscriptionId ??
      updates.stripe_subscription_id,

    appointment_durations:
      updates.appointmentDurations ??
      updates.appointment_durations,

    scheduling:
      updates.scheduling,

    opening_hours:
      updates.openingHours ??
      updates.opening_hours,

    observes_public_holidays:
      updates.observesPublicHolidays ??
      updates.observes_public_holidays,

    public_holiday_country:
      updates.publicHolidayCountry ??
      updates.public_holiday_country,
  };
}

function removeUndefinedFields(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

async function getCabinet(cabinetId) {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!cabinetId) return null;

  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("id", cabinetId)
    .maybeSingle();

  if (error) {
    console.error("[CABINETS_STORE][GET_CABINET_ERROR]", {
      cabinetId,
      message: error.message,
    });
    return null;
  }

  return mapDbCabinetToApp(data);
}

async function upsertCabinet(cabinetId, updates = {}) {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!cabinetId) {
    throw new Error("cabinetId requis");
  }

  const payload = removeUndefinedFields(
    mapAppUpdatesToDb(cabinetId, updates)
  );

  const { data, error } = await supabase
    .from("cabinets")
    .upsert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("[CABINETS_STORE][UPSERT_ERROR]", {
      cabinetId,
      message: error.message,
      payload,
    });
    throw new Error("UPSERT_CABINET_FAILED");
  }

  return mapDbCabinetToApp(data);
}

async function findCabinetByTwilioNumber(twilioNumber) {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!twilioNumber) return null;

  const normalized = normalizePhone(twilioNumber);

  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("twilio_phone_number_normalized", normalized)
    .maybeSingle();

  if (error) {
    console.error("[CABINETS_STORE][FIND_BY_TWILIO_ERROR]", {
      twilioNumber: normalized,
      message: error.message,
    });
    return null;
  }

  if (!data) return null;

  return {
    cabinetId: data.id,
    cabinet: mapDbCabinetToApp(data),
  };
}

async function findCabinetByCustomerId(customerId) {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!customerId) return null;

  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    console.error("[CABINETS_STORE][FIND_BY_CUSTOMER_ERROR]", {
      customerId,
      message: error.message,
    });
    return null;
  }

  if (!data) return null;

  return {
    cabinetId: data.id,
    cabinet: mapDbCabinetToApp(data),
  };
}

async function findCabinetBySubscriptionId(subscriptionId) {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!subscriptionId) return null;

  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (error) {
    console.error("[CABINETS_STORE][FIND_BY_SUBSCRIPTION_ERROR]", {
      subscriptionId,
      message: error.message,
    });
    return null;
  }

  if (!data) return null;

  return {
    cabinetId: data.id,
    cabinet: mapDbCabinetToApp(data),
  };
}

module.exports = {
  getCabinet,
  upsertCabinet,
  findCabinetByTwilioNumber,
  findCabinetByCustomerId,
  findCabinetBySubscriptionId,
};
