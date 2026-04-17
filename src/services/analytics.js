const supabase = require("../config/supabase");

function getDateKeyParis() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function assertSupabase() {
  if (!supabase) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }
}

async function incrementMetric(cabinetKey, metric, amount = 1) {
  if (!cabinetKey) return;
  if (!metric) return;
  if (!Number.isFinite(amount) || amount <= 0) return;

  assertSupabase();

  const dateKey = getDateKeyParis();

  const { error } = await supabase.rpc("increment_cabinet_daily_metric", {
    p_cabinet_id: cabinetKey,
    p_date_key: dateKey,
    p_metric: metric,
    p_amount: amount,
  });

  if (error) {
    console.error("[ANALYTICS][INCREMENT_ERROR]", {
      cabinetKey,
      metric,
      amount,
      dateKey,
      message: error.message,
    });
    throw new Error("ANALYTICS_INCREMENT_FAILED");
  }
}

async function addCallDuration(cabinetKey, durationSeconds) {
  if (!cabinetKey) return;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;

  assertSupabase();

  const dateKey = getDateKeyParis();

  const { error } = await supabase.rpc("add_cabinet_daily_call_duration", {
    p_cabinet_id: cabinetKey,
    p_date_key: dateKey,
    p_duration_seconds: Math.round(durationSeconds),
  });

  if (error) {
    console.error("[ANALYTICS][ADD_DURATION_ERROR]", {
      cabinetKey,
      durationSeconds,
      dateKey,
      message: error.message,
    });
    throw new Error("ANALYTICS_ADD_DURATION_FAILED");
  }
}

async function getCabinetAnalytics(cabinetKey) {
  if (!cabinetKey) return null;

  assertSupabase();

  const { data, error } = await supabase
    .from("cabinet_daily_metrics")
    .select("*")
    .eq("cabinet_id", cabinetKey)
    .order("date", { ascending: false });

  if (error) {
    console.error("[ANALYTICS][GET_CABINET_ANALYTICS_ERROR]", {
      cabinetKey,
      message: error.message,
    });
    throw new Error("GET_CABINET_ANALYTICS_FAILED");
  }

  const rows = Array.isArray(data) ? data : [];

  const totals = rows.reduce(
    (acc, row) => {
      acc.callsReceived += row.calls_received || 0;
      acc.callsHandled += row.calls_handled || 0;
      acc.appointmentsBooked += row.appointments_booked || 0;
      acc.appointmentsModified += row.appointments_modified || 0;
      acc.appointmentsCancelled += row.appointments_cancelled || 0;
      acc.failedCalls += row.failed_calls || 0;
      acc.totalCallDurationSeconds += row.total_call_duration_seconds || 0;
      return acc;
    },
    {
      callsReceived: 0,
      callsHandled: 0,
      appointmentsBooked: 0,
      appointmentsModified: 0,
      appointmentsCancelled: 0,
      failedCalls: 0,
      totalCallDurationSeconds: 0,
    }
  );

  const daily = Object.fromEntries(
    rows.map((row) => [
      row.date,
      {
        callsReceived: row.calls_received || 0,
        callsHandled: row.calls_handled || 0,
        appointmentsBooked: row.appointments_booked || 0,
        appointmentsModified: row.appointments_modified || 0,
        appointmentsCancelled: row.appointments_cancelled || 0,
        failedCalls: row.failed_calls || 0,
        totalCallDurationSeconds: row.total_call_duration_seconds || 0,
      },
    ])
  );

  return {
    totals,
    daily,
  };
}

module.exports = {
  incrementMetric,
  addCallDuration,
  getCabinetAnalytics,
};