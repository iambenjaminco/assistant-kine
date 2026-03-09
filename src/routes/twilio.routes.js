// src/routes/twilio.routes.js
const express = require("express");
const twilio = require("twilio");

const {
  suggestTwoSlotsNext7Days,
  suggestTwoSlotsFromDate,
  bookAppointmentSafe,
  formatSlotFR,
  findNextAppointmentSafe,
  cancelAppointmentSafe,
} = require("../services/calendar");

const { CABINETS } = require("../config/cabinets");
const { PHRASES } = require("../../phrases.js");

const router = express.Router();

// ⚠️ Session en mémoire (dev). Prod => Redis/DB
const sessions = new Map();

// ✅ Voix FR forcée partout
const SAY_OPTS = {
  language: "fr-FR",
  voice: "alice",
};

function sayFr(node, text) {
  node.say(SAY_OPTS, text);
}

function safeCallSid(req) {
  return (
    req.body?.CallSid ||
    req.headers["x-twilio-call-sid"] ||
    "UNKNOWN_CALLSID"
  );
}

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      step: "ACTION",
      slots: [],
      patientName: "",
      phone: "",
      pendingSlot: null,
      foundEvent: null, // { calendarId, eventId, startISO, summary }
      createdAt: Date.now(),
      noInputCount: 0,
      retryCount: 0,
      lastPrompt: "",
      skipSilenceOnce: false,
    });
  }
  return sessions.get(callSid);
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

function resetToMenu(session) {
  session.step = "ACTION";
  session.slots = [];
  session.patientName = "";
  session.phone = "";
  session.pendingSlot = null;
  session.foundEvent = null;
  session.noInputCount = 0;
  session.retryCount = 0;
  session.lastPrompt = "";
  session.skipSilenceOnce = false;
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function wantsMainMenu(text) {
  return (
    text.includes("menu") ||
    text.includes("retour menu") ||
    text.includes("revenir au menu") ||
    text.includes("retour au menu") ||
    text.includes("accueil") ||
    text.includes("recommencer")
  );
}

function gatherSpeech(vr, actionUrl) {
  return vr.gather({
    input: "speech",
    language: "fr-FR",
    speechTimeout: "auto",
    timeout: 10,
    actionOnEmptyResult: true,
    action: actionUrl,
    method: "POST",
  });
}

function sayGoodbye(vr) {
  sayFr(vr, PHRASES.goodbye || "À bientôt. Au revoir.");
  vr.hangup();
}

function pickChoiceFromSpeech(text, digits) {
  if (digits === "1") return 0;
  if (digits === "2") return 1;

  const t = normalizeText(text);
  if (/\b(premier|1|un)\b/.test(t) || /\ble 1\b/.test(t)) return 0;
  if (/\b(deuxieme|2|deux)\b/.test(t) || /\ble 2\b/.test(t)) return 1;
  return null;
}

function parsePhone(text, digits) {
  const d = (digits || "").replace(/\D/g, "");
  if (d.length >= 9) return d;

  const t = (text || "").replace(/\D/g, "");
  if (t.length >= 9) return t;

  return "";
}

function isLessThan24h(startISO) {
  const start = new Date(startISO).getTime();
  const now = Date.now();
  return start - now < 24 * 60 * 60 * 1000;
}

function cleanProposeSpeech(s) {
  return String(s || "")
    .replace(/^bonjour[\s,.-]*/i, "")
    .replace(/^vous etes bien[^.?!]*[.?!]\s*/i, "")
    .replace(/^cabinet[^.?!]*[.?!]\s*/i, "")
    .trim();
}

function getCabinetOrFail(vr) {
  const cabinet = Object.values(CABINETS)[0];
  if (!cabinet) {
    sayFr(vr, "Configuration cabinet invalide.");
    vr.hangup();
    return null;
  }
  if (!cabinet.practitioners || !cabinet.practitioners.length) {
    sayFr(
      vr,
      "Aucun praticien n’est configuré. Merci de rappeler le cabinet."
    );
    sayGoodbye(vr);
    return null;
  }
  return cabinet;
}

function setPrompt(session, prompt) {
  session.lastPrompt = prompt || "";
}

function handleRetry(vr, res, session, callSid) {
  session.retryCount = (session.retryCount || 0) + 1;

  if (session.retryCount >= 2) {
    sayFr(vr, "Je n’arrive pas à comprendre votre réponse.");
    sayGoodbye(vr);
    clearSession(callSid);
    return res.type("text/xml").send(vr.toString());
  }

  return null;
}

// Webhook principal
router.post("/voice", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const vr = new VoiceResponse();

  const callSid = safeCallSid(req);
  const speech = (req.body?.SpeechResult || "").trim();
  const digits = (req.body?.Digits || "").trim();

  const session = getSession(callSid);

  const cabinet = getCabinetOrFail(vr);
  if (!cabinet) {
    clearSession(callSid);
    return res.type("text/xml").send(vr.toString());
  }

  const hasInput = Boolean(speech || digits);
  const normalizedSpeech = normalizeText(speech);

  // ✅ Retour menu principal depuis n'importe où
  if (
    hasInput &&
    wantsMainMenu(normalizedSpeech) &&
    session.step !== "ACTION" &&
    session.step !== "ACTION_LISTEN" &&
    session.step !== "ACTION_WAIT"
  ) {
    resetToMenu(session);
    setPrompt(
      session,
      PHRASES.askAction ||
        "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
    );

    const g = gatherSpeech(vr, "/twilio/voice");
    sayFr(g, "Très bien, retour au menu principal.");
    sayFr(g, session.lastPrompt);
    return res.type("text/xml").send(vr.toString());
  }

  if (!hasInput && session.lastPrompt) {
    if (session.skipSilenceOnce) {
      session.skipSilenceOnce = false;
    } else {
      if (typeof session.noInputCount !== "number") session.noInputCount = 0;
      session.noInputCount += 1;

      if (session.noInputCount === 1) {
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Vous êtes toujours là ?");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      sayFr(vr, "Je n’ai pas eu de réponse.");
      sayGoodbye(vr);
      clearSession(callSid);
      return res.type("text/xml").send(vr.toString());
    }
  }

  if (hasInput) session.noInputCount = 0;

  try {
    // =========================
    // 0) ACTION (menu)
    // =========================
    if (session.step === "ACTION") {
      const text = normalizeText(speech);

      if (!text) {
        setPrompt(
          session,
          PHRASES.askAction ||
            "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
        );

        sayFr(
          vr,
          PHRASES.greeting ||
            "Bonjour, vous êtes bien au cabinet de kinésithérapie."
        );

        session.noInputCount = 0;
        session.skipSilenceOnce = true;
        session.step = "ACTION_LISTEN";

        vr.redirect({ method: "POST" }, "/twilio/voice");
        return res.type("text/xml").send(vr.toString());
      }

      const wantsModify =
        text.includes("modifier") ||
        text.includes("changer") ||
        text.includes("decaler") ||
        text.includes("deplacer") ||
        text.includes("reporter");

      const wantsCancel =
        text.includes("annuler") ||
        text.includes("supprimer") ||
        text.includes("retirer");

      const wantsBook =
        text.includes("prendre") ||
        text.includes("rendez") ||
        text.includes("rdv") ||
        text.includes("consult");

      if (wantsModify) {
        session.step = "MODIFY_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Très bien.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      if (wantsCancel) {
        session.step = "CANCEL_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "D’accord.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      if (wantsBook) {
        session.step = "BOOK_WELCOME";
        setPrompt(session, "");
        vr.redirect({ method: "POST" }, "/twilio/voice");
        return res.type("text/xml").send(vr.toString());
      }

      if (text.includes("rendez") || text.includes("rdv")) {
        setPrompt(
          session,
          PHRASES.askAction ||
            "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
        );
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris votre demande.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      setPrompt(
        session,
        PHRASES.askAction ||
          "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
      );
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, "Désolé, je n’ai pas compris.");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "ACTION_LISTEN") {
      setPrompt(
        session,
        PHRASES.askAction ||
          "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
      );

      sayFr(vr, session.lastPrompt);

      session.noInputCount = 0;
      session.skipSilenceOnce = true;
      session.step = "ACTION_WAIT";

      vr.redirect({ method: "POST" }, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "ACTION_WAIT") {
      session.step = "ACTION";
      session.noInputCount = 0;

      gatherSpeech(vr, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    // =========================
    // A) PRENDRE RDV
    // =========================
    if (session.step === "BOOK_WELCOME") {
      const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
        practitioners: cabinet.practitioners,
      });

      const defaultCalendarId = cabinet.practitioners[0].calendarId;

      session.slots = (slots || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultCalendarId,
        practitionerName: s.practitionerName || cabinet.practitioners[0].name,
      }));

      if (!session.slots.length) {
        const msg =
          cleanProposeSpeech(proposeSpeech) ||
          PHRASES.noAvailability ||
          "Je n’ai pas de créneau disponible dans les prochains jours.";
        sayFr(vr, msg);
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      sayFr(
        vr,
        cleanProposeSpeech(proposeSpeech) || "Je vous propose deux créneaux."
      );

      session.step = "BOOK_PICK_SLOT";
      setPrompt(
        session,
        PHRASES.chooseSlot || "Vous préférez le premier ou le deuxième ?"
      );

      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "BOOK_PICK_SLOT") {
      const t = normalizeText(speech);

      const wantsRepeat =
        t.includes("repete") ||
        t.includes("repeter") ||
        t.includes("pardon") ||
        t.includes("recommence") ||
        t.includes("pas compris");

      if (wantsRepeat) {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (!a) {
          sayFr(
            vr,
            "Je ne retrouve plus les créneaux proposés. Merci de rappeler le cabinet."
          );
          sayGoodbye(vr);
          clearSession(callSid);
          return res.type("text/xml").send(vr.toString());
        }

        sayFr(vr, "Je répète.");
        sayFr(
          vr,
          `Premier créneau : ${formatSlotFR(a.start)}${
            a.practitionerName ? ` avec ${a.practitionerName}` : ""
          }.`
        );
        sayFr(
          vr,
          `Deuxième créneau : ${formatSlotFR(b.start)}${
            b.practitionerName ? ` avec ${b.practitionerName}` : ""
          }.`
        );

        setPrompt(session, "Vous préférez le premier ou le deuxième ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const choice = pickChoiceFromSpeech(speech, digits);

      if (choice === null) {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (!a) {
          session.step = "BOOK_WELCOME";
          setPrompt(session, "");
          sayFr(vr, "On recommence.");
          vr.redirect({ method: "POST" }, "/twilio/voice");
          return res.type("text/xml").send(vr.toString());
        }

        sayFr(vr, "Je n’ai pas compris.");
        sayFr(
          vr,
          `Dites "premier" pour ${formatSlotFR(a.start)}${
            a.practitionerName ? ` avec ${a.practitionerName}` : ""
          }, ou "deuxième" pour ${formatSlotFR(b.start)}${
            b.practitionerName ? ` avec ${b.practitionerName}` : ""
          }.`
        );

        setPrompt(session, "Premier ou deuxième ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const slot = session.slots?.[choice];
      if (!slot || !slot.calendarId) {
        sayFr(
          vr,
          "Ce créneau vient d’être pris. Je regarde d’autres disponibilités."
        );

        session.step = "BOOK_WELCOME";
        setPrompt(session, "");
        vr.redirect({ method: "POST" }, "/twilio/voice");

        return res.type("text/xml").send(vr.toString());
      }

      session.pendingSlot = slot;
      session.step = "BOOK_ASK_NAME";

      setPrompt(session, "Quel est votre nom et prénom ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, "Très bien.");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "BOOK_ASK_NAME") {
      const name = (speech || "").trim();
      if (!name) {
        setPrompt(session, "Quel est votre nom et prénom ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      session.patientName = name;
      session.step = "BOOK_ASK_PHONE";

      setPrompt(session, "Quel est votre numéro de téléphone ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, "Merci.");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "BOOK_ASK_PHONE") {
      const phone = parsePhone(speech, digits);
      if (!phone) {
        setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      session.phone = phone;

      const slot = session.pendingSlot;
      session.pendingSlot = null;

      if (!slot || !slot.calendarId) {
        sayFr(vr, "Je ne retrouve plus le créneau sélectionné.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName || "Patient",
        reason: "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
      });

      if (result.ok) {
        sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
        sayFr(
          vr,
          `${formatSlotFR(slot.start)}${
            slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
          }.`
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      const statusMsg =
        result.code === "LOCKED"
          ? "Ce créneau est en cours de réservation."
          : "Ce créneau vient d’être pris.";

      const alts = await suggestTwoSlotsFromDate({
        practitioners: cabinet.practitioners,
        fromDate: slot.start,
      });

      const defaultCalendarId = cabinet.practitioners[0].calendarId;
      session.slots = (alts || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultCalendarId,
        practitionerName: s.practitionerName || cabinet.practitioners[0].name,
      }));

      if (!session.slots?.length) {
        sayFr(
          vr,
          `${statusMsg} Je n’ai pas d’autre créneau disponible rapidement. Merci de rappeler le cabinet.`
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      const a = session.slots[0];
      const b = session.slots[1] || session.slots[0];

      sayFr(vr, statusMsg);
      sayFr(
        vr,
        `Premier : ${formatSlotFR(a.start)}${
          a.practitionerName ? ` avec ${a.practitionerName}` : ""
        }.`
      );
      sayFr(
        vr,
        `Deuxième : ${formatSlotFR(b.start)}${
          b.practitionerName ? ` avec ${b.practitionerName}` : ""
        }.`
      );

      session.step = "BOOK_PICK_ALT";
      setPrompt(session, "Premier ou deuxième ?");

      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "BOOK_PICK_ALT") {
      const choice = pickChoiceFromSpeech(speech, digits);

      if (choice === null) {
        const retry = handleRetry(vr, res, session, callSid);
        if (retry) return retry;

        setPrompt(session, "Premier ou deuxième ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const slot = session.slots?.[choice];
      if (!slot || !slot.calendarId) {
        sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName || "Patient",
        reason: "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
      });

      if (result.ok) {
        sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
        sayFr(
          vr,
          `${formatSlotFR(slot.start)}${
            slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
          }.`
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      sayFr(
        vr,
        "Désolé, je n’arrive pas à confirmer un rendez-vous pour le moment. Merci de rappeler le cabinet."
      );
      sayGoodbye(vr);
      clearSession(callSid);
      return res.type("text/xml").send(vr.toString());
    }

    // =========================
    // B) MODIFIER RDV
    // =========================
    if (session.step === "MODIFY_ASK_PHONE") {
      const phone = parsePhone(speech, digits);
      if (!phone) {
        setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }
      session.phone = phone;
      session.step = "MODIFY_FIND_APPT";
      setPrompt(session, "");
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "MODIFY_FIND_APPT") {
      const found = await findNextAppointmentSafe({
        practitioners: cabinet.practitioners,
        phone: session.phone,
      });

      if (!found) {
        sayFr(
          vr,
          "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
        );
        session.phone = "";
        session.foundEvent = null;
        session.step = "MODIFY_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      session.foundEvent = found;
      session.step = "MODIFY_CONFIRM_FOUND";

      setPrompt(session, "Est-ce bien votre rendez-vous ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "MODIFY_CONFIRM_FOUND") {
      const t = normalizeText(speech);
      const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
      const no = t.includes("non") || t.includes("no");

      if (!yes && !no) {
        setPrompt(session, "Est-ce bien votre rendez-vous ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      if (no) {
        session.phone = "";
        session.foundEvent = null;
        session.step = "MODIFY_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Très bien, redonnez-moi votre numéro pour vérification.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const found = session.foundEvent;
      if (!found) {
        sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      if (isLessThan24h(found.startISO)) {
        sayFr(
          vr,
          "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de le modifier automatiquement. Merci d’appeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      await cancelAppointmentSafe({
        calendarId: found.calendarId,
        eventId: found.eventId,
      });

      session.step = "MODIFY_PROPOSE_NEW";
      setPrompt(session, "");
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "MODIFY_PROPOSE_NEW") {
      const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
        practitioners: cabinet.practitioners,
      });

      const defaultCalendarId = cabinet.practitioners[0].calendarId;
      session.slots = (slots || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultCalendarId,
        practitionerName: s.practitionerName || cabinet.practitioners[0].name,
      }));

      if (!session.slots.length) {
        sayFr(
          vr,
          "J’ai bien annulé votre rendez-vous, mais je n’ai pas de nouveau créneau disponible. Merci d’appeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      sayFr(vr, "D’accord. Je vous propose deux nouveaux créneaux.");
      const cleaned = cleanProposeSpeech(proposeSpeech);
      if (cleaned) sayFr(vr, cleaned);

      session.step = "MODIFY_PICK_NEW";
      setPrompt(session, "Vous préférez le premier ou le deuxième ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "MODIFY_PICK_NEW") {
      const choice = pickChoiceFromSpeech(speech, digits);
      if (choice === null) {
        const retry = handleRetry(vr, res, session, callSid);
        if (retry) return retry;
        setPrompt(session, "Premier ou deuxième ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const slot = session.slots?.[choice];
      if (!slot || !slot.calendarId) {
        sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName,
        reason: "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
      });

      if (result.ok) {
        sayFr(vr, "C’est modifié et confirmé.");
        sayFr(
          vr,
          `${formatSlotFR(slot.start)}${
            slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
          }.`
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      sayFr(
        vr,
        "Désolé, je n’arrive pas à confirmer ce nouveau créneau. Merci de rappeler le cabinet."
      );
      sayGoodbye(vr);
      clearSession(callSid);
      return res.type("text/xml").send(vr.toString());
    }

    // =========================
    // C) ANNULER RDV
    // =========================
    if (session.step === "CANCEL_ASK_PHONE") {
      const phone = parsePhone(speech, digits);
      if (!phone) {
        setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }
      session.phone = phone;
      session.step = "CANCEL_FIND_APPT";
      setPrompt(session, "");
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "CANCEL_FIND_APPT") {
      const found = await findNextAppointmentSafe({
        practitioners: cabinet.practitioners,
        phone: session.phone,
      });

      if (!found) {
        sayFr(
          vr,
          "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
        );
        session.phone = "";
        session.foundEvent = null;
        session.step = "CANCEL_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      session.foundEvent = found;
      session.step = "CANCEL_CONFIRM_FOUND";

      setPrompt(session, "Est-ce bien votre rendez-vous ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "CANCEL_CONFIRM_FOUND") {
      const t = normalizeText(speech);
      const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
      const no = t.includes("non") || t.includes("no");

      if (!yes && !no) {
        setPrompt(session, "Est-ce bien votre rendez-vous ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      if (no) {
        session.phone = "";
        session.foundEvent = null;
        session.step = "CANCEL_ASK_PHONE";
        setPrompt(session, "Quel est votre numéro de téléphone ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Très bien, redonnez-moi votre numéro pour vérification.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      const found = session.foundEvent;
      if (!found) {
        sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      if (isLessThan24h(found.startISO)) {
        sayFr(
          vr,
          "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de l’annuler automatiquement. Merci d’appeler le cabinet."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      await cancelAppointmentSafe({
        calendarId: found.calendarId,
        eventId: found.eventId,
      });

      session.step = "CANCEL_ASK_REBOOK";
      setPrompt(session, "Voulez-vous reprendre un rendez-vous ?");
      const g = gatherSpeech(vr, "/twilio/voice");
      sayFr(g, "Votre rendez-vous est annulé.");
      sayFr(g, session.lastPrompt);
      return res.type("text/xml").send(vr.toString());
    }

    if (session.step === "CANCEL_ASK_REBOOK") {
      const t = normalizeText(speech);
      const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
      const no = t.includes("non") || t.includes("no");

      if (!yes && !no) {
        setPrompt(session, "Voulez-vous reprendre un rendez-vous ?");
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
        return res.type("text/xml").send(vr.toString());
      }

      if (no) {
        sayFr(vr, "Très bien.");
        sayGoodbye(vr);
        clearSession(callSid);
        return res.type("text/xml").send(vr.toString());
      }

      session.step = "BOOK_WELCOME";
      setPrompt(session, "");
      vr.redirect({ method: "POST" }, "/twilio/voice");
      return res.type("text/xml").send(vr.toString());
    }

    // =========================
    // Fallback
    // =========================
    const retry = handleRetry(vr, res, session, callSid);
    if (retry) return retry;

    setPrompt(
      session,
      PHRASES.askAction ||
        "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
    );
    const g = gatherSpeech(vr, "/twilio/voice");
    sayFr(g, "Je n’ai pas compris.");
    sayFr(g, session.lastPrompt);
    return res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("ERROR [TWILIO]", err);
    sayFr(
      vr,
      PHRASES.errorGeneric ||
        "Une erreur est survenue. Veuillez réessayer plus tard."
    );
    sayGoodbye(vr);
    clearSession(callSid);
    return res.type("text/xml").send(vr.toString());
  }
});

module.exports = router;