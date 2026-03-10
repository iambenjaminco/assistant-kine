// src/services/sms.js
const twilio = require("twilio");

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    throw new Error("TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN manquant");
  }

  return twilio(sid, token);
}

function normalizeFrenchPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (!digits) return null;

  if (digits.length === 10 && digits.startsWith("0")) {
    return `+33${digits.slice(1)}`;
  }

  if (digits.length === 11 && digits.startsWith("33")) {
    return `+${digits}`;
  }

  if (digits.length >= 11 && !digits.startsWith("0")) {
    return `+${digits}`;
  }

  return null;
}

async function sendSms({ to, body }) {
  const from =
    process.env.TWILIO_SMS_FROM ||
    process.env.TWILIO_PHONE_NUMBER ||
    null;

  if (!from) {
    throw new Error("TWILIO_SMS_FROM ou TWILIO_PHONE_NUMBER manquant");
  }

  const toE164 = normalizeFrenchPhone(to);
  if (!toE164) {
    throw new Error("Numéro de téléphone invalide pour envoi SMS");
  }

  const client = getTwilioClient();

  return client.messages.create({
    from,
    to: toE164,
    body,
  });
}

async function sendAppointmentConfirmationSMS({
  to,
  patientName,
  formattedSlot,
  practitionerName,
}) {
  const body =
    `Bonjour${patientName ? ` ${patientName}` : ""}, votre rendez-vous est confirmé ` +
    `pour ${formattedSlot}` +
    `${practitionerName ? ` avec ${practitionerName}` : ""}. ` +
    `Cabinet de kinésithérapie.`;

  return sendSms({ to, body });
}

async function sendAppointmentModifiedSMS({
  to,
  patientName,
  formattedSlot,
  practitionerName,
}) {
  const body =
    `Bonjour${patientName ? ` ${patientName}` : ""}, votre rendez-vous a bien été modifié ` +
    `pour ${formattedSlot}` +
    `${practitionerName ? ` avec ${practitionerName}` : ""}. ` +
    `Cabinet de kinésithérapie.`;

  return sendSms({ to, body });
}

async function sendAppointmentCancelledSMS({
  to,
  patientName,
  formattedSlot,
}) {
  const body =
    `Bonjour${patientName ? ` ${patientName}` : ""}, votre rendez-vous prévu ` +
    `pour ${formattedSlot} a bien été annulé. ` +
    `Cabinet de kinésithérapie.`;

  return sendSms({ to, body });
}

module.exports = {
  sendSms,
  sendAppointmentConfirmationSMS,
  sendAppointmentModifiedSMS,
  sendAppointmentCancelledSMS,
};