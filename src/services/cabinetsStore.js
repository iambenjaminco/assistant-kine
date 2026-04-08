const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "cabinets.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({}, null, 2), "utf-8");
  }
}

function readCabinets() {
  ensureFile();
  const raw = fs.readFileSync(FILE_PATH, "utf-8");
  return JSON.parse(raw || "{}");
}

function writeCabinets(data) {
  ensureFile();
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function findCabinetByTwilioNumber(twilioNumber) {
  if (!twilioNumber) return null;

  const normalized = String(twilioNumber).replace(/\s+/g, "");
  const cabinets = readCabinets();

  for (const [cabinetId, cabinet] of Object.entries(cabinets)) {
    const storedNumber = String(cabinet?.twilioNumber || "").replace(/\s+/g, "");
    if (storedNumber && storedNumber === normalized) {
      return { cabinetId, cabinet };
    }
  }

  return null;
}

function getCabinet(cabinetId) {
  const cabinets = readCabinets();
  return cabinets[cabinetId] || null;
}

function upsertCabinet(cabinetId, updates) {
  const cabinets = readCabinets();

  cabinets[cabinetId] = {
    ...(cabinets[cabinetId] || {}),
    ...updates,
  };

  writeCabinets(cabinets);
  return cabinets[cabinetId];
}

function findCabinetByCustomerId(customerId) {
  const cabinets = readCabinets();

  for (const [cabinetId, cabinet] of Object.entries(cabinets)) {
    if (cabinet.stripeCustomerId === customerId) {
      return { cabinetId, cabinet };
    }
  }

  return null;
}

function findCabinetBySubscriptionId(subscriptionId) {
  const cabinets = readCabinets();

  for (const [cabinetId, cabinet] of Object.entries(cabinets)) {
    if (cabinet.stripeSubscriptionId === subscriptionId) {
      return { cabinetId, cabinet };
    }
  }

  return null;
}

module.exports = {
  getCabinet,
  upsertCabinet,
  findCabinetByTwilioNumber,
  findCabinetByCustomerId,
  findCabinetBySubscriptionId,
};