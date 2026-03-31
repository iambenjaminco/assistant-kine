const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../../data");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");

function ensureAnalyticsFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(ANALYTICS_FILE)) {
    fs.writeFileSync(
      ANALYTICS_FILE,
      JSON.stringify({ cabinets: {} }, null, 2),
      "utf8"
    );
  }
}

function readAnalytics() {
  ensureAnalyticsFile();
  const raw = fs.readFileSync(ANALYTICS_FILE, "utf8");
  return JSON.parse(raw);
}

function writeAnalytics(data) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function getDateKeyParis() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function ensureCabinet(data, cabinetKey) {
  if (!data.cabinets[cabinetKey]) {
    data.cabinets[cabinetKey] = {
      totals: {
        callsReceived: 0,
        callsHandled: 0,
        appointmentsBooked: 0,
        appointmentsModified: 0,
        appointmentsCancelled: 0,
        failedCalls: 0,
        totalCallDurationSeconds: 0,
      },
      daily: {},
    };
  }
}

function ensureDay(cabinetStats, dateKey) {
  if (!cabinetStats.daily[dateKey]) {
    cabinetStats.daily[dateKey] = {
      callsReceived: 0,
      callsHandled: 0,
      appointmentsBooked: 0,
      appointmentsModified: 0,
      appointmentsCancelled: 0,
      failedCalls: 0,
      totalCallDurationSeconds: 0,
    };
  }
}

function incrementMetric(cabinetKey, metric, amount = 1) {
  const data = readAnalytics();
  ensureCabinet(data, cabinetKey);

  const dateKey = getDateKeyParis();
  ensureDay(data.cabinets[cabinetKey], dateKey);

  if (typeof data.cabinets[cabinetKey].totals[metric] !== "number") {
    data.cabinets[cabinetKey].totals[metric] = 0;
  }

  if (typeof data.cabinets[cabinetKey].daily[dateKey][metric] !== "number") {
    data.cabinets[cabinetKey].daily[dateKey][metric] = 0;
  }

  data.cabinets[cabinetKey].totals[metric] += amount;
  data.cabinets[cabinetKey].daily[dateKey][metric] += amount;

  writeAnalytics(data);
}

function addCallDuration(cabinetKey, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;

  const data = readAnalytics();
  ensureCabinet(data, cabinetKey);

  const dateKey = getDateKeyParis();
  ensureDay(data.cabinets[cabinetKey], dateKey);

  data.cabinets[cabinetKey].totals.totalCallDurationSeconds += durationSeconds;
  data.cabinets[cabinetKey].daily[dateKey].totalCallDurationSeconds += durationSeconds;

  writeAnalytics(data);
}

function getCabinetAnalytics(cabinetKey) {
  const data = readAnalytics();
  ensureCabinet(data, cabinetKey);
  return data.cabinets[cabinetKey];
}

module.exports = {
  incrementMetric,
  addCallDuration,
  getCabinetAnalytics,
};