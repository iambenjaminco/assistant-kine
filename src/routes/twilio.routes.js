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
    addCallbackNoteToEvent,
} = require("../services/calendar");

const {
    incrementMetric,
    addCallDuration,
} = require("../services/analytics");

const {
    sendAppointmentConfirmationSMS,
    sendAppointmentModifiedSMS,
    sendAppointmentCancelledSMS,
} = require("../services/sms");

const {
    getCabinet: getCabinetBilling,
    findCabinetByTwilioNumber,
} = require("../services/cabinetsStore");
const { PHRASES } = require("../../phrases.js");

const router = express.Router();

// ⚠️ Session en mémoire (dev). Prod => Redis/DB
const sessions = new Map();

// ✅ Voix FR configurable
const SAY_OPTS = {
    language: "fr-FR",
    voice: "Google.fr-FR-Wavenet-A",
};

const PARIS_TIMEZONE = "Europe/Paris";

function sayFr(node, text) {
    const safeText = String(text || "").trim();

    console.log("[TWILIO][TTS_DEBUG]", {
        voice: SAY_OPTS.voice,
        language: SAY_OPTS.language,
        text: safeText,
    });

    node.say(SAY_OPTS, safeText || "...");
}

function safeCallSid(req) {
    return (
        req.body?.CallSid ||
        req.headers["x-twilio-call-sid"] ||
        "UNKNOWN_CALLSID"
    );
}

function normalizeText(s) {
    return (s || "")
        .toString()
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’']/g, "'")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ");
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

function gatherSpeech(vr, actionUrl, overrides = {}) {
    return vr.gather({
        input: "speech dtmf",
        language: "fr-FR",
        speechTimeout: "auto",
        timeout: 6,
        actionOnEmptyResult: true,
        action: actionUrl,
        method: "POST",
        hints:
            "prendre rendez-vous, prendre, reprendre rendez-vous, reserver un rendez-vous, booker un rendez-vous, modifier rendez-vous, changer rendez-vous, deplacer rendez-vous, reporter rendez-vous, annuler rendez-vous, supprimer rendez-vous, information, renseignements, adresse, horaires, horaire, ouverture, fermeture, ouvert, ferme, localisation, ou se trouve le cabinet, matin, debut de matinee, fin de matinee, apres-midi, debut d'apres-midi, debut d'apres midi, fin d'apres-midi, fin d'apres midi, soir, midi, midi et demi, midi trente, minuit, oui, non, demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, Benjamin, Lisa, peu importe, peu importe le jour, n'importe quel jour, suivi, premier rendez-vous, 12h, 12 heures, 12h30, 17h, 17 heures, 17h30, 18h, 18 heures, 18h30, 19h, 20h, 20 heures, vers 12h, vers 12h30, vers 17h, vers 18h, le plus tot possible, au plus vite, le plus tard possible, n'importe quand, dans la journee, 1, 2, 3, 4",
        ...overrides,
    });
}

function sayGoodbye(vr) {
    sayFr(vr, PHRASES.goodbye || "À bientôt. Au revoir.");
    vr.hangup();
}

function logInfo(event, data = {}) {
    console.log(`[TWILIO][${event}]`, data);
}

function logWarn(event, data = {}) {
    console.warn(`[TWILIO][${event}]`, data);
}

function logError(event, data = {}) {
    console.error(`[TWILIO][${event}]`, data);
}

function maskName(name) {
    const value = String(name || "").trim();
    if (!value) return "";
    if (value.length <= 2) return `${value[0] || ""}*`;
    return `${value.slice(0, 2)}***`;
}

function buildSessionSnapshot(session) {
    return {
        step: session?.step || null,
        patientName: maskName(session?.patientName || ""),
        phone: maskPhone(session?.phone || ""),
        phoneCandidate: maskPhone(session?.phoneCandidate || ""),
        appointmentType: session?.appointmentType || null,
        appointmentDurationMinutes: session?.appointmentDurationMinutes || null,
        preferredPractitioner: session?.preferredPractitioner?.name || null,
        practitionerPreferenceMode: session?.practitionerPreferenceMode || null,
        wantsUsualPractitioner: session?.wantsUsualPractitioner ?? null,
        preferredTimeWindow: session?.preferredTimeWindow || null,
        preferredHourMinutes: Number.isFinite(session?.preferredHourMinutes)
            ? session.preferredHourMinutes
            : null,
        priorityPreference: session?.priorityPreference || null,
        requestedDateISO: session?.requestedDateISO || null,
        lastProposedStartISO: session?.lastProposedStartISO || null,
        lastIntentContext: session?.lastIntentContext || null,
        slotsCount: Array.isArray(session?.slots) ? session.slots.length : 0,
        pendingSlot: summarizeSlot(session?.pendingSlot),
        foundEvent: session?.foundEvent
            ? {
                eventId: session.foundEvent.eventId || null,
                calendarId: session.foundEvent.calendarId || null,
                startISO: session.foundEvent.startISO || null,
            }
            : null,
        retryCount: session?.retryCount || 0,
        noInputCount: session?.noInputCount || 0,
    };
}

function logStepTransition(callSid, session, from, to, meta = {}) {
    logInfo("STEP_TRANSITION", {
        callSid,
        from: from || null,
        to: to || null,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function setStep(session, callSid, nextStep, meta = {}) {
    const previousStep = session?.step || null;
    session.step = nextStep;
    logStepTransition(callSid, session, previousStep, nextStep, meta);
}

function logSessionCreated(callSid, session, meta = {}) {
    logInfo("SESSION_CREATED", {
        callSid,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function logSessionCleared(callSid, session, reason = "UNKNOWN", meta = {}) {
    logInfo("SESSION_CLEARED", {
        callSid,
        reason,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function logCallOutcome(callSid, outcome, session, meta = {}) {
    logInfo("CALL_OUTCOME", {
        callSid,
        outcome,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function clearSessionWithLog(callSid, session, reason = "UNKNOWN", meta = {}) {
    logSessionCleared(callSid, session, reason, meta);
    clearSession(callSid);
}

function endCall(vr, res, callSid, session, reason, message = "", meta = {}) {
    if (message) sayFr(vr, message);
    logCallOutcome(callSid, reason, session, meta);
    sayGoodbye(vr);
    clearSessionWithLog(callSid, session, reason, meta);
    return sendTwiml(res, vr);
}

function sendTwiml(res, vr) {
    const xml = vr.toString();
    console.log("[TWILIO][TWIML_XML]", xml);
    return res.type("text/xml").send(xml);
}

function maskPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length <= 4) return digits;
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

function summarizeSlot(slot) {
    if (!slot) return null;
    return {
        start: slot.start,
        end: slot.end,
        formattedStart: slot.start ? formatSlotFR(slot.start) : null,
        practitionerName: slot.practitionerName || null,
        calendarId: slot.calendarId || null,
    };
}

function summarizeSlots(slots) {
    return (slots || []).map(summarizeSlot);
}

function setPrompt(session, prompt) {
    session.lastPrompt = prompt || "";
}

function resetRetry(session) {
    session.retryCount = 0;
}

function nextVariantIndex(session, key) {
    session.variantCursor = session.variantCursor || {};
    const current = Number(session.variantCursor[key] || 0);
    session.variantCursor[key] = current + 1;
    return current;
}

function pickVariant(session, key, values) {
    if (!Array.isArray(values) || !values.length) return "";
    const index = nextVariantIndex(session, key) % values.length;
    return values[index];
}

function sayAck(vr, session, kind = "neutral") {
    const variants = {
        neutral: ["D'accord.", "Très bien.", "Bien sûr.", "Parfait.", "Entendu."],
        search: [
            "Je regarde.",
            "Je vérifie.",
            "Je m'en occupe.",
            "Je regarde cela.",
            "Je consulte les disponibilités.",
        ],
        thanks: [
            "Merci.",
            "Parfait, merci.",
            "C'est noté.",
            "Très bien, merci.",
            "Merci beaucoup.",
        ],
        back: [
            "D'accord, retour au menu principal.",
            "Très bien, je reviens au menu principal.",
            "Entendu, on reprend depuis le début.",
        ],
        confirm: ["Très bien.", "C'est noté.", "Parfait.", "Entendu.", "Bien reçu."],
        repeat: [
            "Je répète.",
            "Bien sûr, je répète.",
            "Pas de souci, je répète.",
            "Je vous redis les créneaux.",
        ],
        sorry: [
            "Je n'ai pas bien compris.",
            "Je n'ai pas saisi votre réponse.",
            "Je préfère vérifier.",
            "Je veux simplement être sûr d'avoir bien compris.",
        ],
    };

    const text = pickVariant(session, `ack_${kind}`, variants[kind] || variants.neutral);
    if (text) sayFr(vr, text);
}

function consumeActionAck(session, fallback = "") {
    const text = session.actionAckOverride || fallback || "";
    session.actionAckOverride = "";
    return text;
}

function promptAndGather(vr, session, prompt, intro = "") {
    if (typeof prompt === "string") {
        setPrompt(session, prompt);
    }

    const gather = gatherSpeech(vr, "/twilio/voice");

    if (intro) {
        gather.say(SAY_OPTS, intro);
    }

    if (session.lastPrompt) {
        gather.say(SAY_OPTS, session.lastPrompt);
    }

    return vr;
}

function getCabinetOrFail(vr, cabinet) {
    if (!cabinet) {
        sayFr(vr, "Aucun cabinet n'est associé à ce numéro.");
        vr.hangup();
        return null;
    }

    if (!cabinet.practitioners || !cabinet.practitioners.length) {
        sayFr(vr, "Aucun praticien n’est configuré. Merci de rappeler le cabinet.");
        sayGoodbye(vr);
        return null;
    }

    return cabinet;
}

function getCabinetDurations(cabinet) {
    const first = Number(
        cabinet?.appointmentDurations?.first ??
        cabinet?.scheduling?.appointmentDurations?.first
    );

    const followUp = Number(
        cabinet?.appointmentDurations?.followUp ??
        cabinet?.scheduling?.appointmentDurations?.followUp
    );

    return {
        first: Number.isFinite(first) && first > 0 ? first : 45,
        followUp: Number.isFinite(followUp) && followUp > 0 ? followUp : 30,
    };
}

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        const session = {
            step: "ACTION",
            slots: [],
            patientName: "",
            phone: "",
            phoneCandidate: "",
            phonePurpose: null,
            pendingSlot: null,
            foundEvent: null,
            createdAt: Date.now(),
            noInputCount: 0,
            retryCount: 0,
            lastPrompt: "",
            variantCursor: {},
            actionAckOverride: "",

            initialBookingSpeech: "",
            appointmentType: null,
            appointmentDurationMinutes: null,
            preferredPractitioner: null,
            practitionerPreferenceMode: null,
            wantsUsualPractitioner: null,
            preferredTimeWindow: null,
            preferredHourMinutes: null,
            priorityPreference: null,

            lastProposedStartISO: null,
            requestedDateISO: null,
            lastIntentContext: null,
        };

        sessions.set(callSid, session);
        logSessionCreated(callSid, session);
    }

    return sessions.get(callSid);
}

function clearSession(callSid) {
    sessions.delete(callSid);
}

function ensureTracking(session) {
    if (!session.tracking) {
        session.tracking = {
            callReceivedTracked: false,
            callHandledTracked: false,
            failedCallTracked: false,
            durationTracked: false,
            startedAt: Date.now(),
        };
    }
}

function trackCallReceived(session, cabinetKey = "main") {
    ensureTracking(session);

    if (session.tracking.callReceivedTracked) return;

    incrementMetric(cabinetKey, "callsReceived");
    session.tracking.callReceivedTracked = true;
}

function trackCallHandled(session, cabinetKey = "main") {
    ensureTracking(session);

    if (session.tracking.callHandledTracked) return;

    incrementMetric(cabinetKey, "callsHandled");
    session.tracking.callHandledTracked = true;
}

function trackFailedCall(session, cabinetKey = "main") {
    ensureTracking(session);

    if (session.tracking.failedCallTracked) return;

    incrementMetric(cabinetKey, "failedCalls");
    session.tracking.failedCallTracked = true;
}

function trackCallDuration(session, cabinetKey = "main") {
    ensureTracking(session);

    if (session.tracking.durationTracked) return;

    const startedAt = Number(session.tracking.startedAt || Date.now());
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

    addCallDuration(cabinetKey, durationSeconds);
    session.tracking.durationTracked = true;
}

function resetToMenu(session, callSid = "UNKNOWN", reason = "MANUAL_RESET") {
    logWarn("RESET_TO_MENU", {
        callSid,
        reason,
        snapshotBeforeReset: buildSessionSnapshot(session),
    });

    session.step = "ACTION";
    session.slots = [];
    session.patientName = "";
    session.phone = "";
    session.phoneCandidate = "";
    session.phonePurpose = null;
    session.pendingSlot = null;
    session.foundEvent = null;
    session.noInputCount = 0;
    session.retryCount = 0;
    session.lastPrompt = "";
    session.actionAckOverride = "";

    session.initialBookingSpeech = "";
    session.appointmentType = null;
    session.appointmentDurationMinutes = null;
    session.preferredPractitioner = null;
    session.practitionerPreferenceMode = null;
    session.wantsUsualPractitioner = null;
    session.preferredTimeWindow = null;
    session.preferredHourMinutes = null;
    session.priorityPreference = null;

    session.lastProposedStartISO = null;
    session.requestedDateISO = null;
    session.lastIntentContext = null;
}

function getGuidedFallbackPrompt(step) {
    switch (step) {
        case "ACTION":
            return "Merci de me dire prendre, modifier ou annuler un rendez-vous.";
        case "BOOK_ASK_APPOINTMENT_TYPE":
            return "Merci de me dire si c'est un premier rendez-vous ou un rendez-vous de suivi.";
        case "BOOK_ASK_PRACTITIONER_PREF":
            return "Souhaitez-vous un kiné en particulier ? Répondez par oui, non, ou peu importe.";
        case "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME":
            return "Merci de me donner le nom du kiné souhaité.";
        case "BOOK_ASK_USUAL_PRACTITIONER":
            return "Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe.";
        case "BOOK_PICK_SLOT":
        case "BOOK_PICK_ALT":
        case "MODIFY_PICK_NEW":
            return "Vous pouvez me dire le premier, le deuxième, ou un autre jour.";
        case "BOOK_ASK_PREFERRED_DATE":
        case "MODIFY_ASK_PREFERRED_DATE":
            return "Vous pouvez dire par exemple demain, jeudi, lundi prochain, le 18 mars, ou mercredi en fin d'après-midi.";
        case "BOOK_ASK_NAME":
            return "Merci de me dire votre nom et prénom.";
        case "BOOK_ASK_PHONE":
        case "MODIFY_ASK_PHONE":
        case "CANCEL_ASK_PHONE":
            return "Merci de me redonner votre numéro de téléphone chiffre par chiffre.";
        case "BOOK_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_PHONE":
        case "CANCEL_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_FOUND":
        case "CANCEL_CONFIRM_FOUND":
        case "CANCEL_ASK_REBOOK":
            return "Merci de répondre simplement par oui ou par non.";
        case "INFO_HANDLE":
            return "Vous pouvez dire l'adresse du cabinet ou les horaires d'ouverture.";
        default:
            return "Je n’ai pas bien compris. Merci de reformuler simplement.";
    }
}

function getNoInputIntro(step) {
    switch (step) {
        case "BOOK_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_PHONE":
        case "CANCEL_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_FOUND":
        case "CANCEL_CONFIRM_FOUND":
        case "CANCEL_ASK_REBOOK":
            return "Je n'ai pas entendu votre confirmation.";
        case "BOOK_PICK_SLOT":
        case "BOOK_PICK_ALT":
        case "MODIFY_PICK_NEW":
            return "Je n'ai pas entendu le créneau souhaité.";
        case "BOOK_ASK_PHONE":
        case "MODIFY_ASK_PHONE":
        case "CANCEL_ASK_PHONE":
            return "Je n'ai pas entendu votre numéro.";
        case "BOOK_ASK_NAME":
            return "Je n'ai pas entendu votre nom.";
        default:
            return "Je n'ai pas eu de réponse.";
    }
}

function handleRetry(vr, res, session, callSid, cabinetId, reason = "UNKNOWN") {
    session.retryCount = (session.retryCount || 0) + 1;

    logWarn("MISUNDERSTOOD_RETRY", {
        callSid,
        step: session.step,
        retryCount: session.retryCount,
        reason,
    });

    if (session.retryCount >= 3) {
        logWarn("CALL_ENDED_MISUNDERSTOOD", {
            callSid,
            step: session.step,
            reason,
        });

        trackFailedCall(session, cabinetId);
        trackCallDuration(session, cabinetId);
        logCallOutcome(callSid, "CALL_ENDED_MISUNDERSTOOD", session, {
            failedStep: session.step,
            reason,
            retryCount: session.retryCount,
        });

        sayFr(vr, "Je n’arrive pas à comprendre votre réponse.");
        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "CALL_ENDED_MISUNDERSTOOD", {
            failedStep: session.step,
            reason,
            retryCount: session.retryCount,
        });
        return sendTwiml(res, vr);
    }

    return null;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function buildDateAtStartOfDayISO(date) {
    const d = startOfDay(date);
    return d.toISOString();
}

function getFrenchMonthIndex(token) {
    const months = {
        janvier: 0,
        fevrier: 1,
        mars: 2,
        avril: 3,
        mai: 4,
        juin: 5,
        juillet: 6,
        aout: 7,
        septembre: 8,
        octobre: 9,
        novembre: 10,
        decembre: 11,
    };
    return months[token] ?? null;
}

function getFrenchWeekdayIndex(token) {
    const weekdays = {
        dimanche: 0,
        lundi: 1,
        mardi: 2,
        mercredi: 3,
        jeudi: 4,
        vendredi: 5,
        samedi: 6,
    };
    return weekdays[token] ?? null;
}

function computeNextWeekdayDate(targetDow, nextWeek = false) {
    const now = new Date();
    const today = startOfDay(now);
    const currentDow = today.getDay();

    let delta = targetDow - currentDow;
    if (delta < 0) delta += 7;

    if (delta === 0) {
        delta = nextWeek ? 7 : 0;
    } else if (nextWeek) {
        delta += 7;
    }

    return addDays(today, delta);
}

function detectAlternativeRequest(text) {
    const t = normalizeText(text);

    return (
        t.includes("autre date") ||
        t.includes("autre jour") ||
        t.includes("un autre jour") ||
        t.includes("une autre date") ||
        t.includes("autre creneau") ||
        t.includes("autre horaire") ||
        t.includes("un autre horaire") ||
        t.includes("plus tard") ||
        t.includes("plus tot") ||
        t.includes("autre rendez") ||
        t.includes("un autre rendez") ||
        t.includes("pas disponible") ||
        t.includes("je ne suis pas disponible") ||
        t.includes("je suis pas disponible") ||
        t.includes("je peux pas") ||
        t.includes("je ne peux pas") ||
        t.includes("pas possible") ||
        t.includes("plus tard dans la semaine") ||
        t.includes("avez vous autre chose") ||
        t.includes("vous avez autre chose") ||
        t.includes("autre chose") ||
        t.includes("aucun des deux") ||
        t.includes("ni l'un ni l'autre") ||
        t.includes("ni lun ni lautre")
    );
}

function parseRequestedDate(text) {
    const raw = normalizeText(text);
    if (!raw) return null;

    const now = new Date();
    const today = startOfDay(now);

    if (raw.includes("aujourd'hui") || raw.includes("aujourdhui")) {
        return buildDateAtStartOfDayISO(today);
    }

    if (raw.includes("apres demain")) {
        return buildDateAtStartOfDayISO(addDays(today, 2));
    }

    if (raw.includes("demain")) {
        return buildDateAtStartOfDayISO(addDays(today, 1));
    }

    const numericMatch = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
    if (numericMatch) {
        const day = Number(numericMatch[1]);
        const month = Number(numericMatch[2]) - 1;
        let year = numericMatch[3] ? Number(numericMatch[3]) : today.getFullYear();
        if (year < 100) year += 2000;

        const d = new Date(year, month, day);
        if (!Number.isNaN(d.getTime())) {
            if (!numericMatch[3] && startOfDay(d) < today) {
                d.setFullYear(d.getFullYear() + 1);
            }
            return buildDateAtStartOfDayISO(d);
        }
    }

    const longDateMatch = raw.match(
        /\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/
    );
    if (longDateMatch) {
        const day = Number(longDateMatch[1]);
        const month = getFrenchMonthIndex(longDateMatch[2]);
        let year = longDateMatch[3] ? Number(longDateMatch[3]) : today.getFullYear();

        if (month !== null) {
            const d = new Date(year, month, day);
            if (!Number.isNaN(d.getTime())) {
                if (!longDateMatch[3] && startOfDay(d) < today) {
                    d.setFullYear(d.getFullYear() + 1);
                }
                return buildDateAtStartOfDayISO(d);
            }
        }
    }

    const weekdayMatch = raw.match(
        /\b(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)(?:\s+prochain)?\b/
    );
    if (weekdayMatch) {
        const dow = getFrenchWeekdayIndex(weekdayMatch[1]);
        const nextWeek = raw.includes("prochain");
        if (dow !== null) {
            return buildDateAtStartOfDayISO(computeNextWeekdayDate(dow, nextWeek));
        }
    }

    return null;
}

function isExplicitDateRequest(text) {
    return Boolean(parseRequestedDate(text));
}

function cleanProposeSpeech(s) {
    return String(s || "")
        .replace(/^bonjour[\s,.-]*/i, "")
        .replace(/^vous etes bien[^.?!]*[.?!]\s*/i, "")
        .replace(/^cabinet[^.?!]*[.?!]\s*/i, "")
        .trim();
}

function isLessThan24h(startISO) {
    const start = new Date(startISO).getTime();
    const now = Date.now();
    return start - now < 24 * 60 * 60 * 1000;
}

function inferTimeWindowFromHourMinutes(hourMinutes) {
    if (!Number.isFinite(hourMinutes)) return null;
    const hour = Math.floor(hourMinutes / 60);

    if (hour < 12) return "MORNING";
    if (hour < 16) return "EARLY_AFTERNOON";
    if (hour < 17) return "AFTERNOON";
    if (hour < 19) return "LATE_AFTERNOON";
    return "EVENING";
}

function detectSpecificHourPreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (t.includes("midi et demi")) return 12 * 60 + 30;
    if (t.includes("midi trente")) return 12 * 60 + 30;
    if (t.includes("midi")) return 12 * 60;
    if (t.includes("minuit")) return 0;

    let match =
        t.match(/\b(\d{1,2})\s*h\s*(\d{2})?\b/) ||
        t.match(/\b(\d{1,2})\s*heure(?:s)?\s*(\d{2})?\b/);

    if (!match) {
        match = t.match(
            /\b(?:vers|autour de|aux alentours de|plutot vers|plutot autour de)\s+(\d{1,2})(?::(\d{2}))?\b/
        );
    }

    if (!match) return null;

    const hour = Number(match[1]);
    const minutes = Number(match[2] || 0);

    if (!Number.isFinite(hour) || !Number.isFinite(minutes)) return null;
    if (hour < 7 || hour > 21) return null;
    if (minutes < 0 || minutes > 59) return null;

    return hour * 60 + minutes;
}

function detectTimePreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (
        t.includes("debut de matinee") ||
        t.includes("debut de matine") ||
        t.includes("en debut de matinee") ||
        t.includes("en debut de matine") ||
        t.includes("tot le matin")
    ) {
        return "EARLY_MORNING";
    }

    if (
        t.includes("fin de matinee") ||
        t.includes("fin de matine") ||
        t.includes("en fin de matinee") ||
        t.includes("en fin de matine")
    ) {
        return "LATE_MORNING";
    }

    if (
        t.includes("fin d'apres midi") ||
        t.includes("fin dapres midi") ||
        t.includes("fin d apres midi") ||
        t.includes("en fin d'apres midi") ||
        t.includes("en fin dapres midi") ||
        t.includes("fin de journee") ||
        t.includes("fin d'aprem") ||
        t.includes("fin daprem") ||
        t.includes("fin d aprem") ||
        t.includes("apres le travail")
    ) {
        return "LATE_AFTERNOON";
    }

    if (
        t.includes("debut d'apres midi") ||
        t.includes("debut dapres midi") ||
        t.includes("en debut d'apres midi") ||
        t.includes("tot l'apres midi") ||
        t.includes("tot lapres midi")
    ) {
        return "EARLY_AFTERNOON";
    }

    if (
        t.includes("soir") ||
        t.includes("en soiree") ||
        t.includes("fin de soiree")
    ) {
        return "EVENING";
    }

    if (t.includes("matin") || t.includes("matinee") || t.includes("matine")) {
        return "MORNING";
    }

    if (
        t.includes("apres midi") ||
        t.includes("apres-midi") ||
        t.includes("apresmidi") ||
        t.includes("dans l'apres midi") ||
        t.includes("dans lapres midi")
    ) {
        return "AFTERNOON";
    }

    return null;
}

function detectPriorityPreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (
        t.includes("le plus tot possible") ||
        t.includes("au plus vite") ||
        t.includes("des que possible") ||
        t.includes("des que vous avez de la place") ||
        t.includes("le premier creneau disponible") ||
        t.includes("au plus tot") ||
        t.includes("le plus tot possible dans la journee") ||
        t.includes("tot dans la journee")
    ) {
        return "EARLIEST";
    }

    if (
        t.includes("le plus tard possible") ||
        t.includes("le plus tard") ||
        t.includes("le dernier creneau") ||
        t.includes("le dernier creneau possible") ||
        t.includes("le plus tard possible dans la journee")
    ) {
        return "LATEST";
    }

    if (
        t.includes("n'importe quand") ||
        t.includes("nimporte quand") ||
        t.includes("comme vous voulez") ||
        t.includes("je suis flexible") ||
        t.includes("peu importe") ||
        t.includes("ca m'est egal") ||
        t.includes("ça m'est egal") ||
        t.includes("pas de preference")
    ) {
        return "FLEXIBLE";
    }

    return null;
}

function getHourInParis(startISO) {
    const parts = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).formatToParts(new Date(startISO));

    const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
    return Number.isFinite(hour) ? hour : null;
}

function getMinutesInParis(startISO) {
    const parts = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).formatToParts(new Date(startISO));

    const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || NaN);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

function slotMatchesTimePreference(slot, preference) {
    if (!slot?.start || !preference) return true;

    const minutes = getMinutesInParis(slot.start);
    if (!Number.isFinite(minutes)) {
        logWarn("TIME_FILTER_INVALID_MINUTES", {
            slotStart: slot?.start || null,
            preference,
        });
        return true;
    }

    let matched = true;

    switch (preference) {
        case "EARLY_MORNING":
            matched = minutes >= 8 * 60 && minutes < 10 * 60;
            break;
        case "LATE_MORNING":
            matched = minutes >= 10 * 60 && minutes < 12 * 60;
            break;
        case "MORNING":
            matched = minutes >= 8 * 60 && minutes < 12 * 60;
            break;
        case "EARLY_AFTERNOON":
            matched = minutes >= 14 * 60 && minutes < 16 * 60;
            break;
        case "AFTERNOON":
            matched = minutes >= 14 * 60 && minutes < 19 * 60;
            break;
        case "LATE_AFTERNOON":
            matched = minutes >= 17 * 60 && minutes < 19 * 60;
            break;
        case "EVENING":
            matched = minutes >= 18 * 60 && minutes < 19 * 60;
            break;
        default:
            matched = true;
            break;
    }

    logInfo("TIME_FILTER_CHECK", {
        slotStart: slot.start,
        practitionerName: slot.practitionerName || null,
        preference,
        minutesInParis: minutes,
        matched,
    });

    return matched;
}

function filterSlotsByTimePreference(slots, preference) {
    if (!preference) return slots || [];
    return (slots || []).filter((slot) => slotMatchesTimePreference(slot, preference));
}

function describeTimePreference(preference) {
    switch (preference) {
        case "EARLY_MORNING":
            return "en début de matinée";
        case "LATE_MORNING":
            return "en fin de matinée";
        case "MORNING":
            return "le matin";
        case "EARLY_AFTERNOON":
            return "en début d'après-midi";
        case "AFTERNOON":
            return "l'après-midi";
        case "LATE_AFTERNOON":
            return "en fin d'après-midi";
        case "EVENING":
            return "en soirée";
        default:
            return "sur ce créneau horaire";
    }
}

function mentionsWholeDayScope(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("dans la journee") ||
        t.includes("sur la journee") ||
        t.includes("dans toute la journee") ||
        t.includes("sur toute la journee") ||
        t.includes("dans la meme journee") ||
        t.includes("sur la meme journee")
    );
}

function updateTimePreferenceFromSpeech(session, text, { clearOnExplicitNone = false } = {}) {
    const t = normalizeText(text);
    if (!t) return;

    const explicitNone =
        t.includes("n'importe quelle heure") ||
        t.includes("nimporte quelle heure") ||
        t.includes("peu importe l'heure") ||
        t.includes("peu importe lheure") ||
        t.includes("aucune preference horaire") ||
        t.includes("pas de preference horaire");

    const wholeDayScope = mentionsWholeDayScope(t);
    const explicitHour = detectSpecificHourPreference(t);
    const detectedTimeWindow = detectTimePreference(t);
    const priority = detectPriorityPreference(t);

    if (explicitNone && clearOnExplicitNone) {
        session.preferredTimeWindow = null;
        session.preferredHourMinutes = null;
        session.priorityPreference = "FLEXIBLE";
        return;
    }

    if (Number.isFinite(explicitHour)) {
        session.preferredHourMinutes = explicitHour;
        session.preferredTimeWindow = inferTimeWindowFromHourMinutes(explicitHour);
        session.priorityPreference = null;
        return;
    }

    if (priority) {
        session.priorityPreference = priority;
        session.preferredHourMinutes = null;

        if (wholeDayScope || priority === "FLEXIBLE") {
            session.preferredTimeWindow = null;
            return;
        }

        if (detectedTimeWindow) {
            session.preferredTimeWindow = detectedTimeWindow;
        }

        return;
    }

    if (detectedTimeWindow) {
        session.preferredTimeWindow = detectedTimeWindow;
        session.preferredHourMinutes = null;
        session.priorityPreference = null;
        return;
    }

    if (wholeDayScope && clearOnExplicitNone) {
        session.preferredTimeWindow = null;
        session.preferredHourMinutes = null;
    }
}

function hasPreferenceRefinementRequest(text) {
    return Boolean(
        detectSpecificHourPreference(text) ||
        detectTimePreference(text) ||
        detectPriorityPreference(text) ||
        mentionsWholeDayScope(text)
    );
}

function parseYesNo(text) {
    const t = normalizeText(text);
    if (!t) return null;

    const noPatterns = [
        /\bnon\b/,
        /\bno\b/,
        /pas du tout/,
        /incorrect/,
        /ce n'?est pas ca/,
        /c'?est pas ca/,
        /ce n'?est pas mon numero/,
        /c'?est pas mon numero/,
        /ce n'?est pas mon rendez/,
        /c'?est pas mon rendez/,
        /mauvais numero/,
        /pas le bon/,
        /^pas bon$/,
        /^faux$/,
        /^negative?$/,
    ];

    const yesPatterns = [
        /\boui\b/,
        /\bouais\b/,
        /\bouep\b/,
        /\boh oui\b/,
        /\bben oui\b/,
        /\bbah oui\b/,
        /\byes\b/,
        /c'?est ca/,
        /c est ca/,
        /c'?est bien ca/,
        /c'?est bien cela/,
        /exact/,
        /exactement/,
        /correct/,
        /tout a fait/,
        /c'?est correct/,
        /c'?est le bon/,
        /c'?est bien le bon/,
        /c'?est bien mon numero/,
        /c'?est mon numero/,
        /c'?est bien mon rendez/,
        /c'?est bien mon rdv/,
        /ca me va/,
        /cela me va/,
        /^ok$/,
        /^okay$/,
        /^ok oui$/,
        /^daccord$/,
        /^d accord$/,
        /^dac$/,
        /^c bon$/,
        /^c'est bon$/,
        /^tres bien$/,
        /^parfait$/,
        /^oui oui$/,
        /je confirme/,
        /confirme/,
        /valide/,
        /c'est valide/,
        /tout bon/,
    ];

    const no = noPatterns.some((pattern) => pattern.test(t));
    const yes = yesPatterns.some((pattern) => pattern.test(t));

    if (yes && !no) return true;
    if (no && !yes) return false;
    return null;
}

function isPhoneConfirmationStep(step) {
    return (
        step === "BOOK_CONFIRM_PHONE" ||
        step === "MODIFY_CONFIRM_PHONE" ||
        step === "CANCEL_CONFIRM_PHONE"
    );
}

function detectExplicitPhoneRejection(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t === "non" ||
        t.includes("pas le bon") ||
        t.includes("c'est pas le bon") ||
        t.includes("ce n'est pas le bon") ||
        t.includes("mauvais numero") ||
        t.includes("ce n'est pas mon numero") ||
        t.includes("c'est pas mon numero") ||
        t.includes("numero faux") ||
        t.includes("faux numero")
    );
}

function detectBookingIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("prendre") ||
        t.includes("reprendre") ||
        t.includes("reserver") ||
        t.includes("booker") ||
        t.includes("fixer un rendez") ||
        t.includes("un rendez") ||
        t.includes("rdv") ||
        t.includes("creneau") ||
        t.includes("consult")
    );
}

function detectModifyIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("modifier") ||
        t.includes("changer") ||
        t.includes("decaler") ||
        t.includes("deplacer") ||
        t.includes("reporter")
    );
}

function detectCancelIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("annuler") ||
        t.includes("supprimer") ||
        t.includes("retirer")
    );
}

function detectInfoIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("information") ||
        t.includes("renseignement") ||
        t.includes("adresse") ||
        t.includes("horaire") ||
        t.includes("horaires") ||
        t.includes("ouvert") ||
        t.includes("ferme") ||
        t.includes("ou se trouve") ||
        t.includes("ou etes vous") ||
        t.includes("localisation") ||
        t.includes("venir")
    );
}

function detectActionChoice(speech, digits) {
    const t = normalizeText(speech);

    if (digits === "1") return "BOOK";
    if (digits === "2") return "MODIFY";
    if (digits === "3") return "CANCEL";
    if (digits === "4") return "INFO";

    if (detectInfoIntent(t)) return "INFO";
    if (detectModifyIntent(t)) return "MODIFY";
    if (detectCancelIntent(t)) return "CANCEL";
    if (detectBookingIntent(t)) return "BOOK";

    return null;
}

function getActionPrompt() {
    return (
        PHRASES.askAction ||
        "Souhaitez-vous prendre, modifier ou annuler un rendez-vous, ou obtenir une information ?"
    );
}

function askActionMenu(vr, session, intro = "") {
    const prompt = getActionPrompt();
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice", {
        numDigits: 1,
        hints:
            "prendre rendez-vous, prendre, reprendre rendez-vous, reserver un rendez-vous, booker un rendez-vous, modifier rendez-vous, changer rendez-vous, deplacer rendez-vous, reporter rendez-vous, annuler rendez-vous, supprimer rendez-vous, information, renseignements, adresse, horaires, horaire, ouverture, fermeture, ouvert, ferme, localisation, ou se trouve le cabinet, matin, debut de matinee, fin de matinee, apres-midi, debut d'apres-midi, debut d'apres midi, fin d'apres-midi, fin d'apres midi, soir, midi, midi et demi, midi trente, minuit, oui, non, demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, Benjamin, Lisa, peu importe, peu importe le jour, n'importe quel jour, suivi, premier rendez-vous, 12h, 12 heures, 12h30, 17h, 17 heures, 17h30, 18h, 18 heures, 18h30, 19h, 20h, 20 heures, vers 12h, vers 12h30, vers 17h, vers 18h, le plus tot possible, au plus vite, le plus tard possible, n'importe quand, dans la journee, 1, 2, 3, 4",
    });

    if (intro) {
        gather.say(SAY_OPTS, intro);
    }

    gather.say(
        SAY_OPTS,
        PHRASES.greeting || "Bonjour, vous êtes bien au cabinet de kinésithérapie."
    );

    gather.say(SAY_OPTS, prompt);
    return vr;
}

function detectAppointmentType(text) {
    const t = normalizeText(text);

    const first =
        t.includes("premier rendez") ||
        t.includes("premiere fois") ||
        t.includes("1er rendez") ||
        t.includes("nouveau patient") ||
        t.includes("je ne suis jamais venu") ||
        t.includes("jamais venu") ||
        t.includes("premiere consultation");

    const followUp =
        t.includes("suivi") ||
        t.includes("controle") ||
        t.includes("deja suivi") ||
        t.includes("je suis deja suivi") ||
        t.includes("patient du cabinet") ||
        t.includes("je suis deja patient") ||
        t.includes("seance") ||
        t.includes("rdv de suivi");

    if (first && !followUp) return "FIRST";
    if (followUp && !first) return "FOLLOW_UP";
    return null;
}

function detectNoPractitionerPreference(text) {
    const t = normalizeText(text);
    return (
        t.includes("peu importe") ||
        t.includes("nimporte lequel") ||
        t.includes("n'importe lequel") ||
        t.includes("pas de preference") ||
        t.includes("aucune preference") ||
        t.includes("comme vous voulez") ||
        t.includes("n'importe qui") ||
        t.includes("pas important") ||
        t === "non" ||
        t.includes("non peu importe") ||
        t.includes("non pas de preference")
    );
}

function detectUsualPractitionerIntent(text) {
    const t = normalizeText(text);
    return (
        t.includes("mon kine habituel") ||
        t.includes("ma kine habituelle") ||
        t.includes("mon praticien habituel") ||
        t.includes("ma praticienne habituelle") ||
        t.includes("le meme kine") ||
        t.includes("la meme kine") ||
        t.includes("garder le meme kine") ||
        t.includes("je suis deja suivi")
    );
}

function findPractitionerBySpeech(text, cabinet) {
    const t = normalizeText(text);
    if (!t || !cabinet?.practitioners?.length) return null;

    for (const p of cabinet.practitioners) {
        const full = normalizeText(p.name || "");
        const parts = full.split(/\s+/).filter(Boolean);

        if (full && t.includes(full)) return p;
        for (const part of parts) {
            if (part.length >= 3 && t.includes(part)) return p;
        }
    }

    return null;
}

function getSearchPractitioners(session, cabinet) {
    if (session.preferredPractitioner?.calendarId) {
        return cabinet.practitioners.filter(
            (p) => p.calendarId === session.preferredPractitioner.calendarId
        );
    }
    return cabinet.practitioners;
}

function rememberLastProposedSlots(session) {
    session.lastProposedStartISO = session.slots?.[0]?.start || null;
}

function hydrateSlotsWithDefaultPractitioner(slots, cabinet) {
    const defaultCalendarId = cabinet.practitioners[0].calendarId;

    return (slots || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultCalendarId,
        practitionerName: s.practitionerName || cabinet.practitioners[0].name,
    }));
}

function getSlotWeekdayFR(startISO) {
    return new Intl.DateTimeFormat("fr-FR", {
        weekday: "long",
        timeZone: PARIS_TIMEZONE,
    }).format(new Date(startISO));
}

function getSlotHourMinuteFR(startISO) {
    return new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).format(new Date(startISO));
}

function pickChoiceFromSpeech(text, digits, slots = []) {
    if (digits === "1") return 0;
    if (digits === "2") return 1;

    const t = normalizeText(text);
    const a = slots?.[0];
    const b = slots?.[1] || slots?.[0];

    if (!t) return null;

    if (/\b(premier|premiere|1|un)\b/.test(t) || /\ble 1\b/.test(t)) return 0;
    if (/\b(deuxieme|second|seconde|2|deux)\b/.test(t) || /\ble 2\b/.test(t)) {
        return 1;
    }

    if (t.includes("plus tot") || t.includes("le plus tot")) return 0;
    if (t.includes("plus tard") || t.includes("le plus tard")) return 1;

    if (a && b) {
        const aDay = normalizeText(getSlotWeekdayFR(a.start));
        const bDay = normalizeText(getSlotWeekdayFR(b.start));
        const aHm = normalizeText(getSlotHourMinuteFR(a.start).replace(":", "h"));
        const bHm = normalizeText(getSlotHourMinuteFR(b.start).replace(":", "h"));
        const aHourOnly = `${String(getHourInParis(a.start)).padStart(2, "0")}h`;
        const bHourOnly = `${String(getHourInParis(b.start)).padStart(2, "0")}h`;
        const aName = normalizeText(a.practitionerName || "");
        const bName = normalizeText(b.practitionerName || "");

        if (aDay && t.includes(aDay) && (!bDay || !t.includes(bDay))) return 0;
        if (bDay && t.includes(bDay) && (!aDay || !t.includes(aDay))) return 1;

        if (aHm && (t.includes(aHm) || t.includes(aHm.replace("h", " h ")))) return 0;
        if (bHm && (t.includes(bHm) || t.includes(bHm.replace("h", " h ")))) return 1;

        if (aHourOnly && t.includes(aHourOnly) && (!bHourOnly || !t.includes(bHourOnly))) return 0;
        if (bHourOnly && t.includes(bHourOnly) && (!aHourOnly || !t.includes(aHourOnly))) return 1;

        if (aName && t.includes(aName) && (!bName || !t.includes(bName))) return 0;
        if (bName && t.includes(bName) && (!aName || !t.includes(aName))) return 1;
    }

    return null;
}

function normalizePhoneCandidate(raw) {
    let digits = String(raw || "").replace(/\D/g, "");

    if (!digits) return "";

    if (digits.startsWith("0033")) {
        digits = `0${digits.slice(4)}`;
    } else if (digits.startsWith("33") && digits.length >= 11) {
        digits = `0${digits.slice(2)}`;
    }

    if (digits.length === 9) {
        digits = `0${digits}`;
    }

    if (digits.length !== 10) return "";
    if (!digits.startsWith("0")) return "";

    return digits;
}

function parsePhone(text, digits) {
    const byDigits = normalizePhoneCandidate(digits);
    if (byDigits) return byDigits;

    const bySpeech = normalizePhoneCandidate(text);
    if (bySpeech) return bySpeech;

    return "";
}

function formatPhoneForSpeech(phone) {
    const digits = normalizePhoneCandidate(phone);
    if (!digits) return "";
    return digits.match(/.{1,2}/g).join(" ");
}

async function lookupSlotsFromDate({
    cabinet,
    practitioners,
    fromDateISO,
    appointmentDurationMinutes,
    timePreference,
    targetHourMinutes,
    priorityPreference,
}) {
    const result = await suggestTwoSlotsFromDate({
        cabinet,
        practitioners,
        fromDate: fromDateISO,
        durationMinutes: appointmentDurationMinutes || undefined,
        timePreference: timePreference || undefined,
        targetHourMinutes: Number.isFinite(targetHourMinutes) ? targetHourMinutes : undefined,
        priorityPreference: priorityPreference || undefined,
    });

    if (Array.isArray(result)) {
        return {
            slots: result,
            speech: "",
            status: null,
            context: {},
        };
    }

    return {
        slots: result?.slots || [],
        speech: result?.speech || "",
        status: result?.status || null,
        context: result?.context || {},
    };
}

function getSlotSelectionPrompt(session) {
    return pickVariant(session, "slot_selection_prompt", [
        "Quel créneau vous convient ?",
        "Lequel vous conviendrait ?",
        "Quel créneau préférez-vous ?",
    ]);
}

function getPractitionerPrompt(session) {
    return pickVariant(session, "practitioner_prompt", [
        "Souhaitez-vous un kiné en particulier ?",
        "Avez-vous une préférence pour un kiné en particulier ?",
        "Voulez-vous un kiné en particulier ?",
    ]);
}

function getPhoneConfirmPrompt(phone) {
    return `Si j’ai bien compris, votre numéro est le ${formatPhoneForSpeech(phone)}. Est-ce correct ?`;
}

function getFilteredSlotsResponse(session, slots, fallbackPrompt) {
    const filtered = filterSlotsByTimePreference(slots, session.preferredTimeWindow);

    logInfo("TIME_FILTER_RESULT", {
        preferredTimeWindow: session.preferredTimeWindow || null,
        preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
            ? session.preferredHourMinutes
            : null,
        priorityPreference: session.priorityPreference || null,
        beforeCount: (slots || []).length,
        afterCount: (filtered || []).length,
        beforeSlots: summarizeSlots(slots || []),
        afterSlots: summarizeSlots(filtered || []),
    });

    if (filtered.length) {
        return {
            slots: filtered,
            hasTimeFilterMiss: false,
            prompt: fallbackPrompt,
        };
    }

    return {
        slots: [],
        hasTimeFilterMiss: Boolean(session.preferredTimeWindow),
        prompt:
            fallbackPrompt ||
            (session.preferredTimeWindow
                ? `Je n'ai pas trouvé de disponibilité ${describeTimePreference(session.preferredTimeWindow)}.`
                : "Je n'ai pas trouvé de disponibilité à cette date."),
    };
}

function saySlots(vr, session, slots) {
    const a = slots?.[0];
    const b = slots?.[1] || slots?.[0];

    if (!a) return;

    sayFr(
        vr,
        `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
        }.`
    );

    if (b?.start && b.start !== a.start) {
        sayFr(
            vr,
            `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""
            }.`
        );
    }
}

async function proposeSlotsFromRequestedDate({
    vr,
    res,
    session,
    callSid,
    cabinet,
    requestedDateISO,
    nextStep,
    intro,
    emptyMessage,
}) {
    const searchPractitioners = getSearchPractitioners(session, cabinet);

    const { slots, speech: proposeSpeech, status, context } = await lookupSlotsFromDate({
        cabinet,
        practitioners: searchPractitioners,
        fromDateISO: requestedDateISO,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
        timePreference: session.preferredTimeWindow,
        targetHourMinutes: session.preferredHourMinutes,
        priorityPreference: session.priorityPreference,
    });

    const hydratedSlots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
    const filtered = getFilteredSlotsResponse(session, hydratedSlots, emptyMessage);

    session.slots = filtered.slots;
    session.requestedDateISO = requestedDateISO;
    rememberLastProposedSlots(session);

    logInfo("REQUESTED_DATE_SLOTS_RESULT", {
        callSid,
        requestedDateISO,
        appointmentType: session.appointmentType,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
        preferredPractitioner: session.preferredPractitioner?.name || null,
        preferredTimeWindow: session.preferredTimeWindow || null,
        preferredHourMinutes: session.preferredHourMinutes || null,
        priorityPreference: session.priorityPreference || null,
        status,
        context,
        count: session.slots.length,
        slots: summarizeSlots(session.slots),
        contextType: session.lastIntentContext,
    });

    if (!session.slots.length) {
        setStep(
            session,
            callSid,
            session.lastIntentContext === "MODIFY"
                ? "MODIFY_ASK_PREFERRED_DATE"
                : "BOOK_ASK_PREFERRED_DATE",
            {
                trigger: "NO_SLOT_FOUND_FOR_REQUESTED_DATE",
                requestedDateISO,
            }
        );

        let introSpeech =
            filtered.hasTimeFilterMiss
                ? `Je n'ai rien trouvé ${describeTimePreference(session.preferredTimeWindow)}.`
                : "Je n’ai pas trouvé de disponibilité à cette date.";

        let noAvailabilityPrompt =
            filtered.hasTimeFilterMiss
                ? `Je n'ai pas trouvé de disponibilité ${describeTimePreference(session.preferredTimeWindow)} à cette date. Donnez-moi un autre jour ou un autre horaire qui vous conviendrait.`
                : "Je n’ai pas trouvé de disponibilité à cette date. Donnez-moi un autre jour qui vous conviendrait.";

        if (status === "CABINET_CLOSED_DAY") {
            introSpeech = proposeSpeech || "Le cabinet est fermé ce jour-là.";
            noAvailabilityPrompt =
                "Donnez-moi un autre jour qui vous conviendrait.";
        }

        if (status === "OUTSIDE_OPENING_HOURS") {
            introSpeech = proposeSpeech || "Le cabinet est fermé à cet horaire.";
            noAvailabilityPrompt =
                "Donnez-moi un autre horaire ou un autre jour qui vous conviendrait.";
        }

        promptAndGather(
            vr,
            session,
            noAvailabilityPrompt,
            introSpeech
        );
        return sendTwiml(res, vr);
    }

    setStep(session, callSid, nextStep, {
        trigger: "REQUESTED_DATE_SLOTS_PROPOSED",
        requestedDateISO,
        slotsCount: session.slots.length,
    });

    const prompt = getSlotSelectionPrompt(session);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice");

    if (status === "REQUESTED_TIME_TAKEN_SAME_DAY_ALTERNATIVES") {
        gather.say(
            SAY_OPTS,
            "Le créneau demandé n’est plus disponible, mais j’ai d’autres horaires le même jour."
        );
    }

    if (intro) {
        gather.say(SAY_OPTS, intro);
    }

    const cleaned = cleanProposeSpeech(proposeSpeech);

    if (
        cleaned &&
        !session.preferredTimeWindow &&
        !Number.isFinite(session.preferredHourMinutes) &&
        !session.priorityPreference
    ) {
        gather.say(SAY_OPTS, cleaned);
    } else {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (a) {
            gather.say(
                SAY_OPTS,
                `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
            );
        }

        if (b && b.start !== a.start) {
            gather.say(
                SAY_OPTS,
                `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""}.`
            );
        }
    }

    gather.say(SAY_OPTS, prompt);

    return sendTwiml(res, vr);
}

async function proposeBookingSlots({
    vr,
    res,
    session,
    callSid,
    cabinet,
    fromDateISO = null,
}) {
    const searchPractitioners = getSearchPractitioners(session, cabinet);

    logInfo("BOOKING_SLOTS_LOOKUP_START", {
        callSid,
        practitionersCount: searchPractitioners.length,
        preferredPractitioner: session.preferredPractitioner?.name || null,
        appointmentType: session.appointmentType,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
        preferredTimeWindow: session.preferredTimeWindow || null,
        preferredHourMinutes: session.preferredHourMinutes || null,
        priorityPreference: session.priorityPreference || null,
        fromDateISO,
    });

    const result = fromDateISO
        ? await suggestTwoSlotsFromDate({
            cabinet,
            practitioners: searchPractitioners,
            fromDate: fromDateISO,
            durationMinutes: session.appointmentDurationMinutes || undefined,
            timePreference: session.preferredTimeWindow || undefined,
            targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                ? session.preferredHourMinutes
                : undefined,
            priorityPreference: session.priorityPreference || undefined,
        })
        : await suggestTwoSlotsNext7Days({
            cabinet,
            practitioners: searchPractitioners,
            durationMinutes: session.appointmentDurationMinutes || undefined,
            timePreference: session.preferredTimeWindow || undefined,
            targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                ? session.preferredHourMinutes
                : undefined,
            priorityPreference: session.priorityPreference || undefined,
        });

    const slots = Array.isArray(result) ? result : result?.slots || [];
    const proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

    const resultStatus = Array.isArray(result) ? null : result?.status || null;
    const resultContext = Array.isArray(result) ? {} : result?.context || {};

    const hydratedSlots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
    const filtered = getFilteredSlotsResponse(
        session,
        hydratedSlots,
        PHRASES.noAvailability || "Je n’ai pas de créneau disponible dans les prochains jours."
    );

    session.slots = filtered.slots;
    rememberLastProposedSlots(session);

    logInfo("BOOKING_SLOTS_LOOKUP_RESULT", {
        callSid,
        count: session.slots.length,
        slots: summarizeSlots(session.slots),
        preferredPractitioner: session.preferredPractitioner?.name || null,
        appointmentType: session.appointmentType,
        preferredTimeWindow: session.preferredTimeWindow || null,
        preferredHourMinutes: session.preferredHourMinutes || null,
        priorityPreference: session.priorityPreference || null,
        status: resultStatus,
        context: resultContext,
    });

    if (!session.slots.length) {
        let msg;
        let followUpPrompt;

        if (resultStatus === "CABINET_CLOSED_DAY") {
            msg = proposeSpeech || "Le cabinet est fermé ce jour-là.";
            followUpPrompt = "Quel autre jour vous conviendrait ?";
        } else if (resultStatus === "OUTSIDE_OPENING_HOURS") {
            msg = proposeSpeech || "Le cabinet est fermé à cet horaire.";
            followUpPrompt = "Donnez-moi un autre horaire ou un autre jour qui vous conviendrait.";
        } else if (filtered.hasTimeFilterMiss) {
            msg = `Je n'ai pas trouvé de créneau ${describeTimePreference(session.preferredTimeWindow)} dans les prochains jours.`;
            followUpPrompt =
                "Donnez-moi un autre jour ou un autre horaire. Vous pouvez dire par exemple jeudi matin, mercredi en fin d'après-midi ou le 18 mars.";
        } else {
            msg =
                cleanProposeSpeech(proposeSpeech) ||
                PHRASES.noAvailability ||
                "Je n’ai pas de créneau disponible dans les prochains jours.";
            followUpPrompt =
                "Quel autre jour vous conviendrait ? Vous pouvez dire par exemple jeudi, lundi prochain ou le 18 mars.";
        }

        sayFr(vr, msg);

        setStep(session, callSid, "BOOK_ASK_PREFERRED_DATE", {
            trigger: "NO_BOOKING_SLOT_FOUND",
        });
        promptAndGather(vr, session, followUpPrompt);
        return sendTwiml(res, vr);
    }

    setStep(session, callSid, "BOOK_PICK_SLOT", {
        trigger: "BOOKING_SLOTS_PROPOSED",
        slotsCount: session.slots.length,
    });

    const prompt = getSlotSelectionPrompt(session);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice");

    if (session.preferredPractitioner?.name) {
        gather.say(SAY_OPTS, `Je cherche avec ${session.preferredPractitioner.name}.`);
    } else {
        gather.say(SAY_OPTS, "Je regarde.");
    }

    const cleaned = cleanProposeSpeech(proposeSpeech);

    if (
        cleaned &&
        !session.preferredTimeWindow &&
        !Number.isFinite(session.preferredHourMinutes) &&
        !session.priorityPreference
    ) {
        gather.say(SAY_OPTS, cleaned);
    } else {
        const a = session.slots?.[0];
        const b = session.slots?.[1] || session.slots?.[0];

        if (a) {
            gather.say(
                SAY_OPTS,
                `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
            );
        }

        if (b && b.start !== a.start) {
            gather.say(
                SAY_OPTS,
                `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""}.`
            );
        }
    }

    gather.say(SAY_OPTS, prompt);

    return sendTwiml(res, vr);
}

async function finalizeBooking(vr, res, session, callSid, cabinet, cabinetId) {
    const slot = session.pendingSlot;
    session.pendingSlot = null;

    if (!slot || !slot.calendarId) {
        logError("BOOKING_PENDING_SLOT_MISSING", {
            callSid,
            patientName: session.patientName,
            phone: maskPhone(session.phone),
        });

        logCallOutcome(callSid, "BOOKING_PENDING_SLOT_MISSING", session, {
            patientName: maskName(session.patientName),
            phone: maskPhone(session.phone),
        });

        sayFr(vr, "Je ne retrouve plus le créneau sélectionné.");
        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "BOOKING_PENDING_SLOT_MISSING", {
            patientName: maskName(session.patientName),
            phone: maskPhone(session.phone),
        });
        return sendTwiml(res, vr);
    }

    logInfo("BOOKING_ATTEMPT", {
        callSid,
        calendarId: slot.calendarId,
        patientName: session.patientName,
        phone: maskPhone(session.phone),
        slot: summarizeSlot(slot),
        appointmentType: session.appointmentType,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
    });

    const result = await bookAppointmentSafe({
        calendarId: slot.calendarId,
        patientName: session.patientName || "Patient",
        reason:
            session.appointmentType === "FIRST"
                ? "Premier rendez-vous kiné"
                : "Rendez-vous kiné",
        startDate: slot.start,
        endDate: slot.end,
        phone: session.phone || "",
        appointmentType: session.appointmentType || undefined,
        durationMinutes: session.appointmentDurationMinutes || undefined,
        cabinet,
    });

    logInfo("BOOKING_RESULT", {
        callSid,
        ok: result.ok,
        code: result.code || null,
        eventId: result.event?.id || null,
        slot: summarizeSlot(slot),
    });

    if (result.ok) {
        incrementMetric(cabinetId, "appointmentsBooked");
        trackCallHandled(session, cabinetId);
        trackCallDuration(session, cabinetId);
        logCallOutcome(callSid, "BOOK_SUCCESS", session, {
            eventId: result.event?.id || null,
            slot: summarizeSlot(slot),
        });

        sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
        sayFr(
            vr,
            `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""}.`
        );

        try {
            const sms = await sendAppointmentConfirmationSMS({
                to: session.phone,
                patientName: session.patientName || "Patient",
                formattedSlot: formatSlotFR(slot.start),
                practitionerName: slot.practitionerName || "",
            });

            logInfo("SMS_SENT", {
                callSid,
                type: "BOOK_CONFIRMATION",
                to: maskPhone(session.phone),
                sid: sms?.sid || null,
                status: sms?.status || null,
            });
        } catch (smsErr) {
            logError("SMS_FAILED", {
                callSid,
                type: "BOOK_CONFIRMATION",
                to: maskPhone(session.phone),
                message: smsErr?.message,
            });
        }

        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "BOOK_SUCCESS", {
            eventId: result.event?.id || null,
            slot: summarizeSlot(slot),
        });
        return sendTwiml(res, vr);
    }


    const statusMsg =
        result.code === "LOCKED"
            ? "Ce créneau est en cours de réservation."
            : "Le créneau que vous avez demandé n’est plus disponible.";

    const searchPractitioners = getSearchPractitioners(session, cabinet);

    const { slots: altSlots } = await lookupSlotsFromDate({
        cabinet,
        practitioners: searchPractitioners,
        fromDateISO: slot.start,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
        timePreference: session.preferredTimeWindow,
        targetHourMinutes: session.preferredHourMinutes,
        priorityPreference: session.priorityPreference,
    });

    const hydratedAltSlots = hydrateSlotsWithDefaultPractitioner(altSlots, cabinet);
    session.slots = filterSlotsByTimePreference(hydratedAltSlots, session.preferredTimeWindow);
    rememberLastProposedSlots(session);

    if (!session.slots?.length) {
        logCallOutcome(callSid, "BOOK_FAILED_NO_ALT_SLOT", session, {
            code: result.code || null,
            requestedSlot: summarizeSlot(slot),
        });

        sayFr(
            vr,
            `${statusMsg} Je n’ai pas d’autre créneau disponible rapidement. Merci de rappeler le cabinet.`
        );
        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "BOOK_FAILED_NO_ALT_SLOT", {
            code: result.code || null,
            requestedSlot: summarizeSlot(slot),
        });
        return sendTwiml(res, vr);
    }

    setStep(session, callSid, "BOOK_PICK_ALT", {
        trigger: "BOOKING_FAILED_ALT_PROPOSED",
        slotsCount: session.slots.length,
    });

    const prompt = getSlotSelectionPrompt(session);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice");

    gather.say(SAY_OPTS, statusMsg);
    gather.say(SAY_OPTS, "Je peux vous proposer un autre créneau.");

    const a = session.slots?.[0];
    const b = session.slots?.[1] || session.slots?.[0];

    if (a) {
        gather.say(
            SAY_OPTS,
            `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
        );
    }

    if (b && b.start !== a.start) {
        gather.say(
            SAY_OPTS,
            `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""}.`
        );
    }

    gather.say(SAY_OPTS, prompt);

    return sendTwiml(res, vr);
}

router.post("/voice", async (req, res) => {
    const calledNumber = (req.body?.To || "").trim();

    const resolvedCabinet = findCabinetByTwilioNumber(calledNumber);

    if (!resolvedCabinet) {
        logWarn("CABINET_NOT_FOUND_FROM_TWILIO_NUMBER", {
            callSid: safeCallSid(req),
            calledNumber,
        });

        const blockedVr = new twilio.twiml.VoiceResponse();
        sayFr(
            blockedVr,
            "Aucun cabinet n'est configuré pour ce numéro. Merci de contacter le cabinet."
        );
        blockedVr.hangup();

        return sendTwiml(res, blockedVr);
    }
    const { cabinetId, cabinet } = resolvedCabinet;
    const billingCabinet = getCabinetBilling(cabinetId);


    if (!billingCabinet || billingCabinet.status !== "active") {
        logWarn("CABINET_SUBSCRIPTION_INACTIVE", {
            callSid: safeCallSid(req),
            cabinetId,
            billingStatus: billingCabinet?.status || null,
        });

        const blockedVr = new twilio.twiml.VoiceResponse();
        sayFr(
            blockedVr,
            "Votre abonnement n'est pas actif. Merci de contacter le cabinet."
        );
        blockedVr.hangup();

        return sendTwiml(res, blockedVr);
    }
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const vr = new VoiceResponse();

    const callSid = safeCallSid(req);
    const speech = (
        req.body?.SpeechResult ||
        req.body?.UnstableSpeechResult ||
        ""
    ).trim();
    const digits = (req.body?.Digits || "").trim();

    const session = getSession(callSid);
    trackCallReceived(session, cabinetId);

    logInfo("VOICE_WEBHOOK", {
        callSid,
        step: session.step,
        speech,
        unstableSpeech: req.body?.UnstableSpeechResult || "",
        digits,
        confidence: req.body?.Confidence || null,
        hasInput: Boolean(speech || digits),
    });

    const validatedCabinet = getCabinetOrFail(vr, cabinet);
    if (!validatedCabinet) {
        logError("CABINET_CONFIG_INVALID", { callSid, cabinetId, calledNumber });
        clearSession(callSid);
        return sendTwiml(res, vr);
    }

    const activeCabinet = validatedCabinet;
    const durations = getCabinetDurations(activeCabinet);

    const hasInput = Boolean(speech || digits);
    const normalizedSpeech = normalizeText(speech);

    if (hasInput && isPhoneConfirmationStep(session.step) && detectExplicitPhoneRejection(speech)) {
        session.phoneCandidate = "";

        if (session.step === "BOOK_CONFIRM_PHONE") {
            setStep(session, callSid, "BOOK_ASK_PHONE", {
                trigger: "PHONE_CONFIRMATION_REJECTED_GUARD",
            });
        } else if (session.step === "MODIFY_CONFIRM_PHONE") {
            setStep(session, callSid, "MODIFY_ASK_PHONE", {
                trigger: "PHONE_CONFIRMATION_REJECTED_GUARD",
            });
        } else if (session.step === "CANCEL_CONFIRM_PHONE") {
            setStep(session, callSid, "CANCEL_ASK_PHONE", {
                trigger: "PHONE_CONFIRMATION_REJECTED_GUARD",
            });
        }

        promptAndGather(
            vr,
            session,
            "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
        );
        return sendTwiml(res, vr);
    }

    if (hasInput && wantsMainMenu(normalizedSpeech) && session.step !== "ACTION") {
        resetToMenu(session, callSid, "USER_REQUESTED_MAIN_MENU");
        askActionMenu(
            vr,
            session,
            pickVariant(session, "menu_back", [
                "D'accord, retour au menu principal.",
                "Très bien, je reviens au menu principal.",
                "Entendu, on repart du début.",
            ])
        );
        return sendTwiml(res, vr);
    }

    if (!hasInput && session.step !== "ACTION" && session.lastPrompt) {
        session.noInputCount = (session.noInputCount || 0) + 1;

        logWarn("NO_INPUT_DETECTED", {
            callSid,
            step: session.step,
            noInputCount: session.noInputCount,
            rawBody: req.body,
        });

        if (session.noInputCount === 1) {
            promptAndGather(vr, session, session.lastPrompt, getNoInputIntro(session.step));
            return sendTwiml(res, vr);
        }

        trackFailedCall(session, cabinetId);
        trackCallDuration(session, cabinetId);
        logCallOutcome(callSid, "CALL_ENDED_NO_INPUT", session, {
            step: session.step,
            noInputCount: session.noInputCount,
        });

        sayFr(vr, "Je n’ai pas eu de réponse.");
        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "CALL_ENDED_NO_INPUT", {
            step: session.step,
            noInputCount: session.noInputCount,
        });
        return sendTwiml(res, vr);
    }

    if (hasInput) {
        session.noInputCount = 0;
        resetRetry(session);

        const beforePrefs = {
            preferredTimeWindow: session.preferredTimeWindow || null,
            preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
                ? session.preferredHourMinutes
                : null,
            priorityPreference: session.priorityPreference || null,
        };

        updateTimePreferenceFromSpeech(session, speech, { clearOnExplicitNone: true });

        logInfo("TIME_PREFERENCE_UPDATED", {
            callSid,
            speech,
            before: beforePrefs,
            after: {
                preferredTimeWindow: session.preferredTimeWindow || null,
                preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
                    ? session.preferredHourMinutes
                    : null,
                priorityPreference: session.priorityPreference || null,
            },
        });
    }

    try {
        if (session.step === "ACTION") {
            const actionChoice = detectActionChoice(speech, digits);

            logInfo("ACTION_DETECTION", {
                callSid,
                speech,
                digits,
                normalizedSpeech: normalizeText(speech),
                detectedAction: actionChoice,
                confidence: req.body?.Confidence || null,
            });

            if (!hasInput) {
                askActionMenu(vr, session);
                return sendTwiml(res, vr);
            }

            if (actionChoice === "MODIFY") {
                session.phonePurpose = "MODIFY";
                session.lastIntentContext = "MODIFY";
                setStep(session, callSid, "MODIFY_ASK_PHONE", { trigger: "ACTION_MODIFY" });

                promptAndGather(
                    vr,
                    session,
                    "Quel est votre numéro de téléphone ?",
                    "Très bien."
                );
                return sendTwiml(res, vr);
            }

            if (actionChoice === "CANCEL") {
                session.phonePurpose = "CANCEL";
                session.lastIntentContext = "CANCEL";
                setStep(session, callSid, "CANCEL_ASK_PHONE", { trigger: "ACTION_CANCEL" });

                promptAndGather(
                    vr,
                    session,
                    "Quel est votre numéro de téléphone ?",
                    "Très bien."
                );
                return sendTwiml(res, vr);
            }

            if (actionChoice === "BOOK") {
                session.lastIntentContext = "BOOK";
                session.initialBookingSpeech = speech || "";
                session.actionAckOverride = "Très bien.";
                setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            if (actionChoice === "INFO") {
                setStep(session, callSid, "INFO_HANDLE", { trigger: "ACTION_INFO" });

                promptAndGather(
                    vr,
                    session,
                    "Souhaitez-vous connaître l'adresse du cabinet ou les horaires d'ouverture ?",
                    "Bien sûr."
                );
                return sendTwiml(res, vr);
            }

            const retry = handleRetry(vr, res, session, callSid, cabinetId, "ACTION");
            if (retry) return retry;

            const gather = gatherSpeech(vr, "/twilio/voice", {
                numDigits: 1,
                hints:
                    "prendre rendez-vous, prendre, rendez-vous, rdv, reserver, booker, modifier, changer, deplacer, reporter, annuler, supprimer, retirer, information, renseignement, adresse, horaires, horaire, ouvert, ferme, localisation, venir, 1, 2, 3, 4",
            });

            setPrompt(
                session,
                "Je n’ai pas bien compris. Dites prendre, modifier, annuler ou information. Vous pouvez aussi taper 1, 2, 3 ou 4."
            );

            gather.say(SAY_OPTS, "Je n’ai pas bien compris.");

            gather.say(
                SAY_OPTS,
                "Dites prendre, modifier, annuler ou information. Vous pouvez aussi taper 1 pour prendre, 2 pour modifier, 3 pour annuler, 4 pour information."
            );

            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_WELCOME") {
            session.lastIntentContext = "BOOK";
            const seed = session.initialBookingSpeech || "";
            updateTimePreferenceFromSpeech(session, seed, { clearOnExplicitNone: false });

            if (!session.appointmentType) {
                const detectedType = detectAppointmentType(seed);
                if (detectedType) {
                    session.appointmentType = detectedType;
                    session.appointmentDurationMinutes =
                        detectedType === "FIRST" ? durations.first : durations.followUp;
                }
            }

            if (!session.preferredPractitioner) {
                const detectedPractitioner = findPractitionerBySpeech(seed, activeCabinet);
                if (detectedPractitioner) {
                    session.preferredPractitioner = detectedPractitioner;
                    session.practitionerPreferenceMode = "SPECIFIC";
                }
            }

            if (!session.practitionerPreferenceMode && detectNoPractitionerPreference(seed)) {
                session.practitionerPreferenceMode = "ANY";
            }

            if (!session.wantsUsualPractitioner && detectUsualPractitionerIntent(seed)) {
                session.wantsUsualPractitioner = true;
                session.practitionerPreferenceMode = "USUAL";
            }

            if (!session.appointmentType) {
                setStep(session, callSid, "BOOK_ASK_APPOINTMENT_TYPE", {
                    trigger: "APPOINTMENT_TYPE_MISSING",
                });
                promptAndGather(
                    vr,
                    session,
                    "S’agit-il d’un premier rendez-vous au cabinet, ou d’un rendez-vous de suivi ?",
                    consumeActionAck(session, pickVariant(session, "book_intro_type", ["D'accord.", "Très bien.", "Bien sûr."]))
                );
                return sendTwiml(res, vr);
            }

            if (!session.practitionerPreferenceMode) {
                setStep(session, callSid, "BOOK_ASK_PRACTITIONER_PREF", {
                    trigger: "APPOINTMENT_TYPE_READY",
                });
                promptAndGather(vr, session, getPractitionerPrompt(session), consumeActionAck(session));
                return sendTwiml(res, vr);
            }

            if (session.practitionerPreferenceMode === "USUAL" && !session.preferredPractitioner) {
                setStep(session, callSid, "BOOK_ASK_USUAL_PRACTITIONER", {
                    trigger: "USUAL_PRACTITIONER_REQUESTED",
                });
                promptAndGather(vr, session, "Avec quel kiné êtes-vous habituellement suivi ?", consumeActionAck(session));
                return sendTwiml(res, vr);
            }

            session.actionAckOverride = "";
            return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
        }

        if (session.step === "BOOK_ASK_APPOINTMENT_TYPE") {
            const detectedType = detectAppointmentType(speech);

            if (!detectedType) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_APPOINTMENT_TYPE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me dire si c’est un premier rendez-vous ou un rendez-vous de suivi."
                );
                return sendTwiml(res, vr);
            }

            session.appointmentType = detectedType;
            session.appointmentDurationMinutes =
                detectedType === "FIRST" ? durations.first : durations.followUp;

            logInfo("APPOINTMENT_TYPE_SET", {
                callSid,
                appointmentType: session.appointmentType,
                appointmentDurationMinutes: session.appointmentDurationMinutes,
                speech,
            });

            setStep(session, callSid, "BOOK_ASK_PRACTITIONER_PREF", {
                trigger: "APPOINTMENT_TYPE_SET",
                appointmentType: session.appointmentType,
            });
            promptAndGather(
                vr,
                session,
                getPractitionerPrompt(session),
                pickVariant(session, "type_ack", ["Très bien.", "Parfait.", "D'accord."])
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_PRACTITIONER_PREF") {
            const practitioner = findPractitionerBySpeech(speech, activeCabinet);
            const noPreference = detectNoPractitionerPreference(speech);
            const usual = detectUsualPractitionerIntent(speech);
            const yesNo = parseYesNo(speech);

            if (practitioner) {
                session.preferredPractitioner = practitioner;
                session.practitionerPreferenceMode = "SPECIFIC";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "SPECIFIC",
                    preferredPractitioner: session.preferredPractitioner?.name || null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (noPreference || yesNo === false) {
                session.preferredPractitioner = null;
                session.practitionerPreferenceMode = "ANY";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "ANY",
                    preferredPractitioner: null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (usual) {
                session.wantsUsualPractitioner = true;
                session.practitionerPreferenceMode = "USUAL";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "USUAL",
                    preferredPractitioner: null,
                    speech,
                });

                setStep(session, callSid, "BOOK_ASK_USUAL_PRACTITIONER", {
                    trigger: "PRACTITIONER_MODE_USUAL",
                });
                promptAndGather(vr, session, "Avec quel kiné êtes-vous habituellement suivi ?", "Très bien.");
                return sendTwiml(res, vr);
            }

            if (yesNo === true) {
                session.practitionerPreferenceMode = "SPECIFIC";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "SPECIFIC",
                    preferredPractitioner: null,
                    speech,
                });

                setStep(session, callSid, "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME", {
                    trigger: "SPECIFIC_PRACTITIONER_NAME_REQUIRED",
                });
                promptAndGather(vr, session, "D'accord. Quel est le nom du kiné souhaité ?");
                return sendTwiml(res, vr);
            }

            const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PRACTITIONER_PREF");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Répondez simplement par oui, non, ou peu importe."
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME") {
            const practitioner = findPractitionerBySpeech(speech, activeCabinet);
            const noPreference = detectNoPractitionerPreference(speech);

            if (practitioner) {
                session.preferredPractitioner = practitioner;
                session.practitionerPreferenceMode = "SPECIFIC";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "SPECIFIC",
                    preferredPractitioner: session.preferredPractitioner?.name || null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (noPreference) {
                session.preferredPractitioner = null;
                session.practitionerPreferenceMode = "ANY";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "ANY",
                    preferredPractitioner: null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas reconnu le nom du kiné. Merci de me redire son nom, ou dites peu importe."
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_USUAL_PRACTITIONER") {
            const practitioner = findPractitionerBySpeech(speech, activeCabinet);
            const noPreference = detectNoPractitionerPreference(speech);

            if (practitioner) {
                session.preferredPractitioner = practitioner;
                session.practitionerPreferenceMode = "SPECIFIC";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "SPECIFIC",
                    preferredPractitioner: session.preferredPractitioner?.name || null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (noPreference) {
                session.preferredPractitioner = null;
                session.practitionerPreferenceMode = "ANY";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "ANY",
                    preferredPractitioner: null,
                    speech,
                });

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_USUAL_PRACTITIONER");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe."
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_PICK_SLOT") {
            const t = normalizeText(speech);

            const wantsRepeat =
                t.includes("repete") ||
                t.includes("repeter") ||
                t.includes("pardon") ||
                t.includes("recommence") ||
                t.includes("pas compris") ||
                t.includes("vous pouvez repeter");

            if (wantsRepeat) {
                const firstSlot = session.slots?.[0];

                if (!firstSlot) {
                    logCallOutcome(callSid, "BOOK_SLOTS_LOST", session);

                    sayFr(vr, "Je ne retrouve plus les créneaux proposés. Merci de rappeler le cabinet.");
                    sayGoodbye(vr);
                    clearSessionWithLog(callSid, session, "BOOK_SLOTS_LOST");
                    return sendTwiml(res, vr);
                }

                const prompt = getSlotSelectionPrompt(session);
                setPrompt(session, prompt);

                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, "Je répète.");

                const secondSlot = session.slots?.[1] || session.slots?.[0];

                gather.say(
                    SAY_OPTS,
                    `Je peux vous proposer ${formatSlotFR(firstSlot.start)}${firstSlot.practitionerName ? ` avec ${firstSlot.practitionerName}` : ""}.`
                );

                if (secondSlot && secondSlot.start !== firstSlot.start) {
                    gather.say(
                        SAY_OPTS,
                        `Ou ${formatSlotFR(secondSlot.start)}${secondSlot.practitionerName ? ` avec ${secondSlot.practitionerName}` : ""}.`
                    );
                }

                gather.say(SAY_OPTS, prompt);

                return sendTwiml(res, vr);
            }

            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);

                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    requestedDateISO,
                    nextStep: "BOOK_PICK_SLOT",
                    intro: "Je regarde cette date.",
                    emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
                });
            }

            if (hasPreferenceRefinementRequest(t)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (detectAlternativeRequest(t)) {
                logInfo("ALTERNATIVE_REQUEST_DETECTED", {
                    callSid,
                    step: session.step,
                    speech,
                    lastProposedStartISO: session.lastProposedStartISO || null,
                });
                if (session.lastProposedStartISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet: activeCabinet,
                        requestedDateISO: session.lastProposedStartISO,
                        nextStep: "BOOK_PICK_SLOT",
                        intro: "Je regarde d'autres créneaux le même jour.",
                        emptyMessage: "Je n’ai pas trouvé d’autre disponibilité ce jour-là.",
                    });
                }

                setStep(session, callSid, "BOOK_ASK_PREFERRED_DATE", {
                    trigger: "ALTERNATIVE_REQUEST_WITHOUT_LAST_PROPOSED_DATE",
                });
                promptAndGather(
                    vr,
                    session,
                    "D'accord. Donnez-moi un autre jour ou un autre horaire qui vous conviendrait."
                );
                return sendTwiml(res, vr);
            }

            const choice = pickChoiceFromSpeech(speech, digits, session.slots);

            if (choice === null) {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                if (!a) {
                    setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
                    sayFr(vr, "On recommence.");
                    vr.redirect({ method: "POST" }, "/twilio/voice");
                    return sendTwiml(res, vr);
                }

                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_SLOT");
                if (retry) return retry;

                const prompt = getSlotSelectionPrompt(session);
                setPrompt(session, prompt);

                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, "Je n'ai pas bien compris.");
                gather.say(
                    SAY_OPTS,
                    `Vous pouvez me dire le premier pour ${formatSlotFR(a.start)}, le deuxième pour ${formatSlotFR(b.start)}, ou un autre jour.`
                );
                gather.say(SAY_OPTS, prompt);

                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            if (!slot || !slot.calendarId) {
                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");
                setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            session.pendingSlot = slot;
            setStep(session, callSid, "BOOK_ASK_NAME", {
                trigger: "SLOT_SELECTED",
                selectedSlot: summarizeSlot(slot),
            });

            logInfo("SLOT_SELECTED", {
                callSid,
                step: session.step,
                selectedSlot: summarizeSlot(slot),
                speech,
                digits,
            });

            promptAndGather(
                vr,
                session,
                "Quel est votre nom et prénom ?",
                pickVariant(session, "name_intro", ["Très bien.", "Parfait.", "D'accord."])
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_PREFERRED_DATE") {
            const requestedDateISO = parseRequestedDate(speech);

            if (!requestedDateISO && hasPreferenceRefinementRequest(speech)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (!requestedDateISO) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PREFERRED_DATE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain, le 18 mars, ou simplement début de matinée, fin de matinée, début d'après-midi ou fin d'après-midi."
                );
                return sendTwiml(res, vr);
            }

            return proposeSlotsFromRequestedDate({
                vr,
                res,
                session,
                callSid,
                cabinet: activeCabinet,
                requestedDateISO,
                nextStep: "BOOK_PICK_SLOT",
                intro: "Je regarde.",
                emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
            });
        }

        if (session.step === "BOOK_ASK_NAME") {
            const name = (speech || "").trim();

            if (!name) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_NAME");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me dire votre nom et prénom."
                );
                return sendTwiml(res, vr);
            }

            session.patientName = name;
            logInfo("PATIENT_NAME_SET", {
                callSid,
                step: session.step,
                patientName: session.patientName,
            });
            session.phonePurpose = "BOOK";
            setStep(session, callSid, "BOOK_ASK_PHONE", {
                trigger: "PATIENT_NAME_CAPTURED",
                patientName: maskName(session.patientName),
            });

            promptAndGather(
                vr,
                session,
                "Quel est votre numéro de téléphone ?",
                pickVariant(session, "book_phone_intro", ["Merci.", "Parfait, merci.", "C'est noté."])
            );
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "BOOK_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_CONFIRM_PHONE") {
            logInfo("PHONE_CONFIRM_RESPONSE", {
                callSid,
                step: session.step,
                speech,
                digits,
                parsedYesNo: parseYesNo(speech),
                phoneCandidate: maskPhone(session.phoneCandidate),
            });

            const yesNo = parseYesNo(speech);

            if (yesNo === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (!yesNo) {
                session.phoneCandidate = "";
                setStep(session, callSid, "BOOK_ASK_PHONE", {
                    trigger: "PHONE_CONFIRMATION_REJECTED",
                });

                promptAndGather(
                    vr,
                    session,
                    "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phone = session.phoneCandidate;
            session.phoneCandidate = "";

            return finalizeBooking(vr, res, session, callSid, activeCabinet, cabinetId);
        }

        if (session.step === "BOOK_PICK_ALT") {
            const t = normalizeText(speech);

            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);
                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    requestedDateISO,
                    nextStep: "BOOK_PICK_ALT",
                    intro: "Je regarde cette date.",
                    emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
                });
            }

            if (hasPreferenceRefinementRequest(t)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (detectAlternativeRequest(t)) {
                logInfo("ALTERNATIVE_REQUEST_DETECTED", {
                    callSid,
                    step: session.step,
                    speech,
                    lastProposedStartISO: session.lastProposedStartISO || null,
                });
                if (session.lastProposedStartISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet: activeCabinet,
                        requestedDateISO: session.lastProposedStartISO,
                        nextStep: "BOOK_PICK_ALT",
                        intro: "Je regarde d'autres créneaux le même jour.",
                        emptyMessage: "Je n’ai pas trouvé d’autre disponibilité ce jour-là.",
                    });
                }

                setStep(session, callSid, "BOOK_ASK_PREFERRED_DATE", {
                    trigger: "ALT_REQUEST_WITHOUT_LAST_PROPOSED_DATE",
                });
                promptAndGather(
                    vr,
                    session,
                    "D'accord. Donnez-moi un autre jour ou un autre horaire qui vous conviendrait."
                );
                return sendTwiml(res, vr);
            }

            const choice = pickChoiceFromSpeech(speech, digits, session.slots);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_ALT");
                if (retry) return retry;

                const prompt = "Je n’ai pas bien compris. Vous pouvez me dire le premier, le deuxième, ou un autre jour.";
                setPrompt(session, prompt);

                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, prompt);

                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            logInfo("BOOK_ALT_SLOT_SELECTED", {
                callSid,
                choice,
                speech,
                digits,
                selectedSlot: summarizeSlot(slot),
            });

            if (!slot || !slot.calendarId) {
                logCallOutcome(callSid, "BOOK_ALT_SLOT_INVALID", session, {
                    choice,
                    slotsAvailable: summarizeSlots(session.slots),
                });

                sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "BOOK_ALT_SLOT_INVALID", {
                    choice,
                    slotsAvailable: summarizeSlots(session.slots),
                });
                return sendTwiml(res, vr);
            }

            logInfo("BOOK_ALT_ATTEMPT", {
                callSid,
                selectedSlot: summarizeSlot(slot),
                patientName: maskName(session.patientName),
                phone: maskPhone(session.phone),
            });

            const result = await bookAppointmentSafe({
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                reason:
                    session.appointmentType === "FIRST"
                        ? "Premier rendez-vous kiné"
                        : "Rendez-vous kiné",
                startDate: slot.start,
                endDate: slot.end,
                phone: session.phone || "",
                appointmentType: session.appointmentType || undefined,
                durationMinutes: session.appointmentDurationMinutes || undefined,
                cabinet: activeCabinet,
            });

            logInfo("BOOK_ALT_RESULT", {
                callSid,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                selectedSlot: summarizeSlot(slot),
            });

            if (result.ok) {
                incrementMetric(cabinetId, "appointmentsBooked");
                trackCallHandled(session, cabinetId);
                trackCallDuration(session, cabinetId);
                logCallOutcome(callSid, "BOOK_ALT_SUCCESS", session, {
                    eventId: result.event?.id || null,
                    slot: summarizeSlot(slot),
                });

                sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""}.`
                );

                try {
                    const sms = await sendAppointmentConfirmationSMS({
                        to: session.phone,
                        patientName: session.patientName || "Patient",
                        formattedSlot: formatSlotFR(slot.start),
                        practitionerName: slot.practitionerName || "",
                    });

                    logInfo("SMS_SENT", {
                        callSid,
                        type: "BOOK_CONFIRMATION_ALT",
                        to: maskPhone(session.phone),
                        sid: sms?.sid || null,
                        status: sms?.status || null,
                    });
                } catch (smsErr) {
                    logError("SMS_FAILED", {
                        callSid,
                        type: "BOOK_CONFIRMATION_ALT",
                        to: maskPhone(session.phone),
                        message: smsErr?.message,
                    });
                }

                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "BOOK_ALT_SUCCESS", {
                    eventId: result.event?.id || null,
                    slot: summarizeSlot(slot),
                });
                return sendTwiml(res, vr);
            }

            logCallOutcome(callSid, "BOOK_ALT_FAILED", session, {
                code: result.code || null,
                slot: summarizeSlot(slot),
            });

            sayFr(
                vr,
                "Désolé, je n’arrive pas à confirmer un rendez-vous pour le moment. Merci de rappeler le cabinet."
            );
            sayGoodbye(vr);
            clearSessionWithLog(callSid, session, "BOOK_ALT_FAILED", {
                code: result.code || null,
                slot: summarizeSlot(slot),
            });
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "MODIFY_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_CONFIRM_PHONE") {
            logInfo("PHONE_CONFIRM_RESPONSE", {
                callSid,
                step: session.step,
                speech,
                digits,
                parsedYesNo: parseYesNo(speech),
                phoneCandidate: maskPhone(session.phoneCandidate),
            });

            const yesNo = parseYesNo(speech);

            if (yesNo === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (!yesNo) {
                session.phoneCandidate = "";
                setStep(session, callSid, "MODIFY_ASK_PHONE", { trigger: "ACTION_MODIFY" });

                promptAndGather(
                    vr,
                    session,
                    "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phone = session.phoneCandidate;
            session.phoneCandidate = "";
            setStep(session, callSid, "MODIFY_FIND_APPT", {
                trigger: "PHONE_CONFIRMED",
                phone: maskPhone(session.phone),
            });
            session.lastIntentContext = "MODIFY";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_FIND_APPT") {
            const found = await findNextAppointmentSafe({
                cabinet: activeCabinet,
                practitioners: activeCabinet.practitioners,
                phone: session.phone,
            });

            logInfo("MODIFY_FIND_APPOINTMENT_RESULT", {
                callSid,
                phone: maskPhone(session.phone),
                found: Boolean(found),
                appointment: found
                    ? {
                        eventId: found.eventId || null,
                        calendarId: found.calendarId || null,
                        startISO: found.startISO || null,
                        patientName: maskName(found.patientName || ""),
                    }
                    : null,
            });

            if (!found) {
                sayFr(
                    vr,
                    "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
                );
                session.phone = "";
                session.foundEvent = null;
                setStep(session, callSid, "MODIFY_ASK_PHONE", { trigger: "ACTION_MODIFY" });
                promptAndGather(vr, session, "Quel est votre numéro de téléphone ?");
                return sendTwiml(res, vr);
            }

            session.foundEvent = found;
            session.patientName = found.patientName || session.patientName || "Patient";

            const currentPractitioner = activeCabinet.practitioners.find(
                (p) => p.calendarId === found.calendarId
            );
            if (currentPractitioner) {
                session.preferredPractitioner = currentPractitioner;
                session.practitionerPreferenceMode = "SPECIFIC";
            }

            setStep(session, callSid, "MODIFY_CONFIRM_FOUND", {
                trigger: "MODIFY_APPOINTMENT_FOUND",
                foundEventId: found.eventId || null,
            });

            const prompt = "Est-ce bien votre rendez-vous ?";
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");
            gather.say(SAY_OPTS, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_CONFIRM_FOUND") {
            const yesNo = parseYesNo(speech);

            logInfo("MODIFY_CONFIRM_FOUND_RESPONSE", {
                callSid,
                speech,
                parsedYesNo: yesNo,
                foundEventId: session.foundEvent?.eventId || null,
            });

            if (yesNo === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_CONFIRM_FOUND");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (!yesNo) {
                session.phone = "";
                session.foundEvent = null;
                setStep(session, callSid, "MODIFY_ASK_PHONE", { trigger: "ACTION_MODIFY" });
                promptAndGather(
                    vr,
                    session,
                    "Quel est votre numéro de téléphone ?",
                    "D'accord, redonnez-moi votre numéro pour vérification."
                );
                return sendTwiml(res, vr);
            }

            const found = session.foundEvent;
            if (!found) {
                logCallOutcome(callSid, "MODIFY_FOUND_EVENT_LOST", session);

                sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_FOUND_EVENT_LOST");
                return sendTwiml(res, vr);
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("MODIFY_BLOCKED_LESS_THAN_24H", {
                    callSid,
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });

                await addCallbackNoteToEvent({
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                });

                logInfo("CALLBACK_NOTE_ADDED", {
                    callSid,
                    reason: "MODIFY_LESS_THAN_24H",
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });

                logCallOutcome(callSid, "MODIFY_BLOCKED_LESS_THAN_24H", session, {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });

                sayFr(
                    vr,
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de le modifier automatiquement. Le cabinet vous rappellera."
                );

                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_BLOCKED_LESS_THAN_24H", {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });
                return sendTwiml(res, vr);
            }

            logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_ATTEMPT", {
                callSid,
                eventId: found.eventId,
                calendarId: found.calendarId,
                startISO: found.startISO,
            });

            const cancelResult = await cancelAppointmentSafe({
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

            logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_RESULT", {
                callSid,
                ok: cancelResult.ok,
                eventId: found.eventId,
                calendarId: found.calendarId,
            });

            if (!cancelResult.ok) {
                logCallOutcome(callSid, "MODIFY_CANCEL_OLD_APPOINTMENT_FAILED", session, {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });

                sayFr(
                    vr,
                    "Je n’arrive pas à modifier le rendez-vous pour le moment. Merci de rappeler le cabinet."
                );
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_CANCEL_OLD_APPOINTMENT_FAILED", {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });
                return sendTwiml(res, vr);
            }

            setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                trigger: "MODIFY_OLD_APPOINTMENT_CANCELLED",
                previousEventId: found.eventId || null,
            });
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_PROPOSE_NEW") {
            session.lastIntentContext = "MODIFY";

            const searchPractitioners = getSearchPractitioners(session, activeCabinet);

            const result = await suggestTwoSlotsNext7Days({
                cabinet: activeCabinet,
                practitioners: searchPractitioners,
                durationMinutes: session.appointmentDurationMinutes || undefined,
                timePreference: session.preferredTimeWindow || undefined,
                targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                    ? session.preferredHourMinutes
                    : undefined,
                priorityPreference: session.priorityPreference || undefined,
            });

            const slots = Array.isArray(result) ? result : result?.slots || [];
            const proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

            const hydratedSlots = hydrateSlotsWithDefaultPractitioner(slots, activeCabinet);
            session.slots = filterSlotsByTimePreference(hydratedSlots, session.preferredTimeWindow);
            rememberLastProposedSlots(session);

            if (!session.slots.length) {
                logCallOutcome(callSid, "MODIFY_NO_NEW_SLOT_AFTER_CANCEL", session, {
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                });

                sayFr(
                    vr,
                    "J’ai bien annulé votre rendez-vous, mais je n’ai pas de nouveau créneau disponible. Merci d’appeler le cabinet."
                );
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_NO_NEW_SLOT_AFTER_CANCEL", {
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                });
                return sendTwiml(res, vr);
            }

            setStep(session, callSid, "MODIFY_PICK_NEW", {
                trigger: "NEW_SLOTS_PROPOSED",
                slotsCount: session.slots.length,
            });

            const prompt = getSlotSelectionPrompt(session);
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");

            gather.say(SAY_OPTS, "Très bien.");

            const cleaned = cleanProposeSpeech(proposeSpeech);

            if (
                cleaned &&
                !session.preferredTimeWindow &&
                !Number.isFinite(session.preferredHourMinutes) &&
                !session.priorityPreference
            ) {
                gather.say(SAY_OPTS, cleaned);
            } else {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                if (a) {
                    gather.say(
                        SAY_OPTS,
                        `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
                    );
                }

                if (b && b.start !== a.start) {
                    gather.say(
                        SAY_OPTS,
                        `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""}.`
                    );
                }
            }

            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_PICK_NEW") {
            const t = normalizeText(speech);

            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);

                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    requestedDateISO,
                    nextStep: "MODIFY_PICK_NEW",
                    intro: "Je regarde cette date.",
                    emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
                });
            }

            if (hasPreferenceRefinementRequest(t)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;
                setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                    trigger: "PREFERENCE_REFINEMENT_REQUESTED",
                });
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            if (detectAlternativeRequest(t)) {
                if (session.lastProposedStartISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet: activeCabinet,
                        requestedDateISO: session.lastProposedStartISO,
                        nextStep: "MODIFY_PICK_NEW",
                        intro: "Je regarde d'autres créneaux le même jour.",
                        emptyMessage: "Je n’ai pas trouvé d’autre disponibilité ce jour-là.",
                    });
                }

                setStep(session, callSid, "MODIFY_ASK_PREFERRED_DATE", {
                    trigger: "ALTERNATIVE_REQUEST_WITHOUT_LAST_PROPOSED_DATE",
                });
                promptAndGather(
                    vr,
                    session,
                    "D'accord. Donnez-moi un autre jour ou un autre horaire qui vous conviendrait."
                );
                return sendTwiml(res, vr);
            }

            const choice = pickChoiceFromSpeech(speech, digits, session.slots);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_PICK_NEW");
                if (retry) return retry;

                const prompt = "Je n’ai pas bien compris. Vous pouvez me dire le premier, le deuxième, ou un autre jour.";
                setPrompt(session, prompt);

                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, prompt);

                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            logInfo("MODIFY_NEW_SLOT_SELECTED", {
                callSid,
                choice,
                speech,
                digits,
                selectedSlot: summarizeSlot(slot),
                oldEventId: session.foundEvent?.eventId || null,
                oldStartISO: session.foundEvent?.startISO || null,
            });

            if (!slot || !slot.calendarId) {
                logWarn("MODIFY_NEW_SLOT_INVALID", {
                    callSid,
                    choice,
                    speech,
                    digits,
                    slotsAvailable: summarizeSlots(session.slots),
                    oldEventId: session.foundEvent?.eventId || null,
                });

                logCallOutcome(callSid, "MODIFY_NEW_SLOT_INVALID", session, {
                    choice,
                    speech,
                    digits,
                });

                sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_NEW_SLOT_INVALID", {
                    choice,
                    speech,
                    digits,
                });
                return sendTwiml(res, vr);
            }

            logInfo("MODIFY_BOOK_NEW_ATTEMPT", {
                callSid,
                patientName: maskName(session.patientName),
                phone: maskPhone(session.phone),
                selectedSlot: summarizeSlot(slot),
                oldEventId: session.foundEvent?.eventId || null,
                oldStartISO: session.foundEvent?.startISO || null,
                appointmentType: session.appointmentType || null,
                appointmentDurationMinutes: session.appointmentDurationMinutes || null,
            });

            const result = await bookAppointmentSafe({
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                reason:
                    session.appointmentType === "FIRST"
                        ? "Premier rendez-vous kiné"
                        : "Rendez-vous kiné",
                startDate: slot.start,
                endDate: slot.end,
                phone: session.phone || "",
                appointmentType: session.appointmentType || undefined,
                durationMinutes: session.appointmentDurationMinutes || undefined,
                cabinet: activeCabinet,
            });

            logInfo("MODIFY_BOOK_NEW_RESULT", {
                callSid,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                selectedSlot: summarizeSlot(slot),
                oldEventId: session.foundEvent?.eventId || null,
            });

            if (result.ok) {
                incrementMetric(cabinetId, "appointmentsModified");
                trackCallHandled(session, cabinetId);
                trackCallDuration(session, cabinetId);
                logCallOutcome(callSid, "MODIFY_SUCCESS", session, {
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                    newEventId: result.event?.id || null,
                    newSlot: summarizeSlot(slot),
                });

                sayFr(vr, "C’est modifié et confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""}.`
                );

                try {
                    const sms = await sendAppointmentModifiedSMS({
                        to: session.phone,
                        patientName: session.patientName || "Patient",
                        formattedSlot: formatSlotFR(slot.start),
                        practitionerName: slot.practitionerName || "",
                    });

                    logInfo("SMS_SENT", {
                        callSid,
                        type: "MODIFY_CONFIRMATION",
                        to: maskPhone(session.phone),
                        sid: sms?.sid || null,
                        status: sms?.status || null,
                    });
                } catch (smsErr) {
                    logError("SMS_FAILED", {
                        callSid,
                        type: "MODIFY_CONFIRMATION",
                        to: maskPhone(session.phone),
                        message: smsErr?.message,
                    });
                }

                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "MODIFY_SUCCESS", {
                    oldEventId: session.foundEvent?.eventId || null,
                    newEventId: result.event?.id || null,
                    newSlot: summarizeSlot(slot),
                });
                return sendTwiml(res, vr);
            }

            logCallOutcome(callSid, "MODIFY_REBOOK_FAILED", session, {
                oldEventId: session.foundEvent?.eventId || null,
                oldStartISO: session.foundEvent?.startISO || null,
                selectedSlot: summarizeSlot(slot),
                resultCode: result.code || null,
            });

            sayFr(
                vr,
                "Désolé, je n’arrive pas à confirmer ce nouveau créneau. Merci de rappeler le cabinet."
            );
            sayGoodbye(vr);
            clearSessionWithLog(callSid, session, "MODIFY_REBOOK_FAILED", {
                oldEventId: session.foundEvent?.eventId || null,
                selectedSlot: summarizeSlot(slot),
                resultCode: result.code || null,
            });
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_ASK_PREFERRED_DATE") {
            const requestedDateISO = parseRequestedDate(speech);

            if (!requestedDateISO && hasPreferenceRefinementRequest(speech)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;
                setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                    trigger: "PREFERENCE_REFINEMENT_REQUESTED",
                });
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            if (!requestedDateISO) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_ASK_PREFERRED_DATE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain, le 18 mars, ou simplement début de matinée, fin de matinée, début d'après-midi ou fin d'après-midi."
                );
                return sendTwiml(res, vr);
            }

            return proposeSlotsFromRequestedDate({
                vr,
                res,
                session,
                callSid,
                cabinet: activeCabinet,
                requestedDateISO,
                nextStep: "MODIFY_PICK_NEW",
                intro: "Je regarde.",
                emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
            });
        }

        if (session.step === "CANCEL_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "CANCEL_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_CONFIRM_PHONE") {
            logInfo("PHONE_CONFIRM_RESPONSE", {
                callSid,
                step: session.step,
                speech,
                digits,
                parsedYesNo: parseYesNo(speech),
                phoneCandidate: maskPhone(session.phoneCandidate),
            });

            const yesNo = parseYesNo(speech);

            if (yesNo === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (!yesNo) {
                session.phoneCandidate = "";
                setStep(session, callSid, "CANCEL_ASK_PHONE", { trigger: "ACTION_CANCEL" });

                promptAndGather(
                    vr,
                    session,
                    "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr);
            }

            session.phone = session.phoneCandidate;
            session.phoneCandidate = "";
            setStep(session, callSid, "CANCEL_FIND_APPT", {
                trigger: "PHONE_CONFIRMED",
                phone: maskPhone(session.phone),
            });
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_FIND_APPT") {
            const found = await findNextAppointmentSafe({
                cabinet: activeCabinet,
                practitioners: activeCabinet.practitioners,
                phone: session.phone,
            });

            logInfo("CANCEL_FIND_APPOINTMENT_RESULT", {
                callSid,
                phone: maskPhone(session.phone),
                found: Boolean(found),
                appointment: found
                    ? {
                        eventId: found.eventId || null,
                        calendarId: found.calendarId || null,
                        startISO: found.startISO || null,
                        patientName: maskName(found.patientName || ""),
                    }
                    : null,
            });

            if (!found) {
                sayFr(
                    vr,
                    "Je ne retrouve pas votre rendez-vous avec ce numéro. Merci de rappeler votre numéro pour vérification."
                );
                session.phone = "";
                session.foundEvent = null;
                setStep(session, callSid, "CANCEL_ASK_PHONE", { trigger: "ACTION_CANCEL" });
                promptAndGather(vr, session, "Quel est votre numéro de téléphone ?");
                return sendTwiml(res, vr);
            }

            session.foundEvent = found;
            session.patientName = found.patientName || session.patientName || "Patient";

            setStep(session, callSid, "CANCEL_CONFIRM_FOUND", {
                trigger: "CANCEL_APPOINTMENT_FOUND",
                foundEventId: found.eventId || null,
            });

            const prompt = "Est-ce bien votre rendez-vous ?";
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");
            gather.say(SAY_OPTS, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_CONFIRM_FOUND") {
            const yesNo = parseYesNo(speech);

            logInfo("CANCEL_CONFIRM_FOUND_RESPONSE", {
                callSid,
                speech,
                parsedYesNo: yesNo,
                foundEventId: session.foundEvent?.eventId || null,
            });

            if (yesNo === null) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_CONFIRM_FOUND");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (!yesNo) {
                session.phone = "";
                session.foundEvent = null;
                setStep(session, callSid, "CANCEL_ASK_PHONE", { trigger: "ACTION_CANCEL" });
                promptAndGather(
                    vr,
                    session,
                    "Quel est votre numéro de téléphone ?",
                    "D'accord, redonnez-moi votre numéro pour vérification."
                );
                return sendTwiml(res, vr);
            }

            const found = session.foundEvent;
            if (!found) {
                logCallOutcome(callSid, "CANCEL_FOUND_EVENT_LOST", session);

                sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "CANCEL_FOUND_EVENT_LOST");
                return sendTwiml(res, vr);
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("CANCEL_BLOCKED_LESS_THAN_24H", {
                    callSid,
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });
                await addCallbackNoteToEvent({
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                });

                logInfo("CALLBACK_NOTE_ADDED", {
                    callSid,
                    reason: "CANCEL_LESS_THAN_24H",
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });

                logCallOutcome(callSid, "CANCEL_BLOCKED_LESS_THAN_24H", session, {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });

                sayFr(
                    vr,
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de l’annuler automatiquement. Le cabinet vous rappellera."
                );

                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "CANCEL_BLOCKED_LESS_THAN_24H", {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });
                return sendTwiml(res, vr);
            }

            logInfo("CANCEL_APPOINTMENT_ATTEMPT", {
                callSid,
                eventId: found.eventId,
                calendarId: found.calendarId,
                startISO: found.startISO,
            });
            const cancelResult = await cancelAppointmentSafe({
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

            logInfo("CANCEL_APPOINTMENT_RESULT", {
                callSid,
                ok: cancelResult.ok,
                eventId: found.eventId,
                calendarId: found.calendarId,
            });

            if (!cancelResult.ok) {
                logCallOutcome(callSid, "CANCEL_FAILED", session, {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });

                sayFr(
                    vr,
                    "Je n’arrive pas à annuler le rendez-vous pour le moment. Merci de rappeler le cabinet."
                );
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "CANCEL_FAILED", {
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                });
                return sendTwiml(res, vr);
            }

            try {
                const sms = await sendAppointmentCancelledSMS({
                    to: session.phone,
                    patientName: session.patientName || "Patient",
                    formattedSlot: formatSlotFR(found.startISO),
                });

                logInfo("SMS_SENT", {
                    callSid,
                    type: "CANCEL_CONFIRMATION",
                    to: maskPhone(session.phone),
                    sid: sms?.sid || null,
                    status: sms?.status || null,
                });
            } catch (smsErr) {
                logError("SMS_FAILED", {
                    callSid,
                    type: "CANCEL_CONFIRMATION",
                    to: maskPhone(session.phone),
                    message: smsErr?.message,
                });
            }
            logCallOutcome(callSid, "CANCEL_SUCCESS", session, {
                cancelledEventId: found.eventId,
                cancelledStartISO: found.startISO,
            });

            incrementMetric(cabinetId, "appointmentsCancelled");
            trackCallHandled(session, cabinetId);
            setStep(session, callSid, "CANCEL_ASK_REBOOK", {
                trigger: "CANCEL_SUCCESS",
                cancelledEventId: found.eventId || null,
            });

            const prompt = "Voulez-vous reprendre un rendez-vous ?";
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");
            gather.say(SAY_OPTS, "Votre rendez-vous est annulé.");
            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr);

        }

        if (session.step === "CANCEL_ASK_REBOOK") {
            const yesNo = parseYesNo(speech);
            const wantsBook =
                speech &&
                (
                    normalizeText(speech).includes("prendre") ||
                    normalizeText(speech).includes("reprendre") ||
                    normalizeText(speech).includes("reserver") ||
                    normalizeText(speech).includes("booker") ||
                    normalizeText(speech).includes("rendez") ||
                    normalizeText(speech).includes("rdv")
                );

            if (yesNo === null && !wantsBook) {
                const retry = handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_ASK_REBOOK");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr);
            }

            if (yesNo === false) {
                trackCallDuration(session, cabinetId);
                logCallOutcome(callSid, "CANCEL_COMPLETED_NO_REBOOK", session);

                sayAck(vr, session, "confirm");
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "CANCEL_COMPLETED_NO_REBOOK");
                return sendTwiml(res, vr);
            }

            setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
            session.lastIntentContext = "BOOK";
            session.initialBookingSpeech = speech || "";
            session.pendingSlot = null;
            session.slots = [];
            session.requestedDateISO = null;
            session.actionAckOverride = "Très bien.";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "INFO_HANDLE") {
            const t = normalizeText(speech);

            const asksAddress =
                t.includes("adresse") ||
                t.includes("ou se situe") ||
                t.includes("ou se trouve") ||
                t.includes("ou etes vous") ||
                t.includes("localisation");

            const asksHours =
                t.includes("horaire") ||
                t.includes("horaires") ||
                t.includes("heure d'ouverture") ||
                t.includes("heure d ouverture") ||
                t.includes("ouverture") ||
                t.includes("fermeture") ||
                t.includes("ouvert") ||
                t.includes("ferme");

            if (asksAddress) {
                sayFr(
                    vr,
                    activeCabinet?.addressSpeech ||
                    "Le cabinet se situe à l'adresse renseignée par le cabinet."
                );
                trackCallHandled(session, cabinetId);
                trackCallDuration(session, cabinetId);
                logCallOutcome(callSid, "INFO_ADDRESS_GIVEN", session);
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "INFO_ADDRESS_GIVEN");
                return sendTwiml(res, vr);
            }

            if (asksHours) {
                sayFr(
                    vr,
                    activeCabinet?.hoursSpeech ||
                    "Le cabinet est ouvert du lundi au vendredi de 8 heures à 12 heures et de 14 heures à 19 heures."
                );
                trackCallHandled(session, cabinetId);
                trackCallDuration(session, cabinetId);
                logCallOutcome(callSid, "INFO_HOURS_GIVEN", session);
                sayGoodbye(vr);
                clearSessionWithLog(callSid, session, "INFO_HOURS_GIVEN");
                return sendTwiml(res, vr);
            }

            const retry = handleRetry(vr, res, session, callSid, cabinetId, "INFO_HANDLE");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Vous pouvez dire l'adresse ou les horaires d'ouverture."
            );
            return sendTwiml(res, vr);
        }

        const retry = handleRetry(vr, res, session, callSid, cabinetId, "FALLBACK");
        if (retry) return retry;

        promptAndGather(
            vr,
            session,
            getGuidedFallbackPrompt(session.step),
            pickVariant(session, "global_fallback_intro", [
                "Je n’ai pas bien compris.",
                "Je n'ai pas saisi votre réponse.",
                "Je préfère vérifier votre demande.",
            ])
        );
        return sendTwiml(res, vr);
    } catch (err) {
        logError("UNEXPECTED_ERROR", {
            message: err?.message,
            stack: err?.stack,
            step: session.step,
            callSid,
            phone: maskPhone(session.phone),
            patientName: session.patientName || "",
        });

        trackFailedCall(session, cabinetId);
        trackCallDuration(session, cabinetId);
        logCallOutcome(callSid, "UNEXPECTED_ERROR", session, {
            errorMessage: err?.message,
            step: session.step,
        });

        sayFr(
            vr,
            PHRASES.errorGeneric || "Une erreur est survenue. Veuillez réessayer plus tard."
        );
        sayGoodbye(vr);
        clearSessionWithLog(callSid, session, "UNEXPECTED_ERROR", {
            errorMessage: err?.message,
        });
        return sendTwiml(res, vr);
    }
});

module.exports = router;