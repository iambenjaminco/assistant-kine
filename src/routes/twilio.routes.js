// src/routes/twilio.routes.js
const express = require("express");
const twilio = require("twilio");

const {
    PARIS_TIMEZONE,
    normalizeText,
    wantsMainMenu,
    parseRequestedDate,
    isExplicitDateRequest,
    cleanProposeSpeech,
    isLessThan24h,
    updateTimePreferenceFromSpeech,
    hasPreferenceRefinementRequest,
    parseYesNo,
    isLikelyValidPatientName,
    isPhoneConfirmationStep,
    detectExplicitPhoneRejection,
    detectActionChoice,
    detectAppointmentType,
    detectAlternativeRequest,
    normalizePhoneCandidate,
    parsePhone,
} = require("../services/voice/parsers");

const {
    getGuidedFallbackPrompt,
    getNoInputIntro,
    getActionPrompt,
    getSlotSelectionPrompt,
    getPractitionerPrompt,
    getPhoneConfirmPrompt,
    describeTimePreference,
    buildPractitionersSpeech,
} = require("../services/voice/prompts");

const {
    isBookStep,
    handleBookStep,
} = require("../services/voice/handlers/bookHandler");

const {
    isModifyStep,
    handleModifyStep,
} = require("../services/voice/handlers/modifyHandler");

const {
    isCancelStep,
    handleCancelStep,
} = require("../services/voice/handlers/cancelHandler");

const {
    detectNoPractitionerPreference,
    detectUsualPractitionerIntent,
    findPractitionerBySpeech,
    getSearchPractitioners,
    asksWhoAreThePractitioners,
    detectForgotPractitionerIdentity,
} = require("../services/voice/practitioners");

const {
    summarizeSlot: summarizeSlotBase,
    summarizeSlots: summarizeSlotsBase,
    buildSessionSnapshot: buildSessionSnapshotBase,
    setPrompt,
    resetRetry,
    rememberLastProposedSlots,
    resetBookingFlowState,
    setStep: setStepBase,
} = require("../services/voice/sessionHelpers");

const { wantsRepeat } = require("../services/voice/repeat");

const {
    maskSpeech,
    maskPhone,
    maskName,
    safeCallSid,
    withTimeout,
} = require("../services/voice/utils");

const {
    logInfo,
    logWarn,
    logError,
    logStepTransition,
    logSessionCreated,
    logSessionCleared,
    logCallOutcome,
} = require("../services/voice/logging");

const {
    trackCallReceived,
    trackCallHandled,
    trackFailedCall,
    trackCallDuration,
    isCallTooLong,
} = require("../services/voice/tracking");

const {
    getHourInParis,
    getMinutesInParis,
    slotMatchesTimePreference,
    filterSlotsByTimePreference,
    hydrateSlotsWithDefaultPractitioner,
    getSlotWeekdayFR,
    getSlotHourMinuteFR,
    pickChoiceFromSpeech,
} = require("../services/voice/slots");

const { resetToMenu } = require("../services/voice/menuReset");

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
    getSession: getStoredSession,
    saveSession,
    clearSession: clearStoredSession,
} = require("../services/sessionStore");

const {
    getCabinet: getCabinetBilling,
    findCabinetByTwilioNumber,
} = require("../services/cabinetsStore");
const { PHRASES } = require("../../phrases.js");

const router = express.Router();

// ✅ Session persistée via sessionStore (Redis en prod)

// ✅ Voix FR configurable
const SAY_OPTS = {
    language: "fr-FR",
    voice: "Google.fr-FR-Wavenet-A",
};

function sayFr(node, text) {
    const safeText =
        typeof text === "string" || typeof text === "number"
            ? String(text).trim()
            : "";

    if (process.env.NODE_ENV !== "production") {
        console.log("[TWILIO][TTS_DEBUG]", {
            voice: SAY_OPTS.voice,
            language: SAY_OPTS.language,
            text: safeText,
        });
    }

    node.say(SAY_OPTS, safeText || "...");
}


function gatherSpeech(vr, actionUrl, overrides = {}) {
    return vr.gather({
        input: "speech dtmf",
        language: "fr-FR",
        speechModel: "phone_call",
        speechTimeout: 1,
        timeout: 8,
        actionOnEmptyResult: true,
        action: actionUrl,
        method: "POST",
        hints:
            "prendre rendez-vous, modifier rendez-vous, annuler rendez-vous, autre, urgence, question, adresse, horaires, oui, non, demain, apres-demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche, lundi prochain, mardi prochain, mercredi prochain, jeudi prochain, vendredi prochain, samedi prochain, dimanche prochain, aujourd'hui, 1, 2, 3, 4",
        ...overrides,
    });
}

function ensureMetricsFlags(session) {
    if (!session.metricsTracked) {
        session.metricsTracked = {
            received: false,
            handled: false,
            failed: false,
            durationTracked: false,
        };
    }
}

async function trackHandledOnce(session, cabinetId) {
    ensureMetricsFlags(session);

    if (!session.metricsTracked.handled) {
        await trackCallHandled(session, cabinetId, incrementMetric);
        session.metricsTracked.handled = true;
    }
}

async function trackFailedOnce(session, cabinetId) {
    ensureMetricsFlags(session);

    if (!session.metricsTracked.failed) {
        await trackFailedCall(session, cabinetId, incrementMetric);
        session.metricsTracked.failed = true;
    }
}

async function trackDurationOnce(session, cabinetId) {
    ensureMetricsFlags(session);

    if (!session.metricsTracked.durationTracked) {
        await trackCallDuration(session, cabinetId, addCallDuration);
        session.metricsTracked.durationTracked = true;
    }
}

function hasProcessedAction(session, key) {
    session.processedActions = session.processedActions || {};
    return Boolean(session.processedActions[key]);
}

function markProcessedAction(session, key) {
    session.processedActions = session.processedActions || {};
    session.processedActions[key] = true;
}

function gatherDateSpeech(vr, actionUrl, overrides = {}) {
    return vr.gather({
        input: "speech dtmf",
        language: "fr-FR",
        speechModel: "phone_call",
        speechTimeout: 1,
        timeout: 10,
        actionOnEmptyResult: true,
        action: actionUrl,
        method: "POST",
        hints:
            "aujourd'hui, demain, apres-demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche, lundi prochain, mardi prochain, mercredi prochain, jeudi prochain, vendredi prochain, samedi prochain, dimanche prochain, le 10 avril, le 11 avril, le 12 avril, le 13 avril, le matin, en fin de matinée, l'après-midi, en fin d'après-midi, vers 17h, vers 18h",
        ...overrides,
    });
}

function sayGoodbye(vr) {
    sayFr(vr, PHRASES.goodbye || "À bientôt. Au revoir.");
    vr.hangup();
}

function detectOtherRequest(text = "", digits = "") {
    const t = normalizeText(text);

    return (
        digits === "4" ||
        t.includes("autre") ||
        t.includes("autre demande") ||
        t.includes("autre chose") ||
        t.includes("j'ai une autre demande") ||
        t.includes("j ai une autre demande") ||
        t.includes("question")
    );
}

function detectUrgencyRequest(text = "") {
    const t = normalizeText(text);

    return (
        t.includes("urgence") ||
        t.includes("urgent") ||
        t.includes("c'est urgent") ||
        t.includes("c est urgent") ||
        t.includes("douleur importante") ||
        t.includes("tres mal") ||
        t.includes("très mal") ||
        t.includes("j'ai tres mal") ||
        t.includes("j ai tres mal") ||
        t.includes("aggravation")
    );
}

function getTransferPhoneNumber(cabinet) {
    return String(
        cabinet?.transferPhoneNumber || ""
    ).trim();
}

function hasTransferPhoneNumber(cabinet) {
    return Boolean(getTransferPhoneNumber(cabinet));
}

function transferCallToCabinet(vr, cabinet, intro = "Je vous transfère au cabinet.") {
    const transferNumber = getTransferPhoneNumber(cabinet);

    if (!transferNumber) {
        return false;
    }

    sayFr(vr, intro);

    const dial = vr.dial({
        answerOnBridge: true,
        timeout: 20,
        action: "/twilio/transfer-status",
        method: "POST",
    });

    dial.number(transferNumber);
    return true;
}

async function clearSessionWithLog(callSid, session, reason = "UNKNOWN", meta = {}) {
    logSessionCleared(callSid, session, reason, meta, buildSessionSnapshot);
    try {
        await clearStoredSession(callSid);
    } catch (err) {
        logError("SESSION_CLEAR_FAILED", {
            callSid,
            message: err?.message,
        });
    }
}

async function endCall(vr, res, callSid, session, reason, message = "", meta = {}) {
    if (message) sayFr(vr, message);
    logCallOutcome(callSid, reason, session, meta, buildSessionSnapshot);
    sayGoodbye(vr);
    await clearSessionWithLog(callSid, session, reason, meta);
    return sendTwiml(res, vr);
}

async function sendTwiml(res, vr, callSid = null, session = null) {
    // ✅ NOUVEAU BLOC — Redis lent ne plante plus l'appel
    if (callSid && session) {
        try {
            const saved = await saveSession(callSid, session);

            if (!saved) {
                logError("SESSION_SAVE_FAILED", {
                    severity: "HIGH",
                    callSid,
                    reason: "SAVE_RETURNED_FALSE",
                    step: session?.step || null,
                });
                // On continue quand même — l'appel en cours reste fonctionnel
            }
        } catch (err) {
            logError("SESSION_SAVE_FAILED", {
                severity: "HIGH",
                callSid,
                message: err?.message,
                step: session?.step || null,
            });
            // On ne throw plus — un Redis lent ne doit pas planter le patient
        }
    }

    const xml = vr.toString();

    if (process.env.NODE_ENV !== "production") {
        console.log("[TWILIO][TWIML_XML]", xml);
    }

    return res.type("text/xml").send(xml);
}

function summarizeSlot(slot) {
    return summarizeSlotBase(slot, { formatSlotFR });
}

function summarizeSlots(slots) {
    const safeSlots = Array.isArray(slots) ? slots : [];

    if (!Array.isArray(slots)) {
        logWarn("SUMMARIZE_SLOTS_NON_ARRAY", {
            receivedType: typeof slots,
            isNull: slots == null,
            isArray: Array.isArray(slots),
            keys:
                slots && typeof slots === "object"
                    ? Object.keys(slots).slice(0, 10)
                    : [],
        });
    }

    return summarizeSlotsBase(safeSlots, { formatSlotFR });
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

function getTransferFallback(session, type) {
    const variants = {
        MISSING_CONFIG: [
            "Le cabinet n'a pas encore configuré la mise en relation téléphonique. Merci de rappeler un peu plus tard.",
            "La mise en relation avec le cabinet n'est pas encore disponible. Merci de rappeler plus tard.",
        ],

        UNAVAILABLE: [
            "Je ne peux pas vous mettre en relation avec le cabinet pour le moment. Merci de rappeler un peu plus tard.",
            "Le cabinet n'est pas joignable pour le moment. Merci de réessayer plus tard.",
            "Je n'arrive pas à vous mettre en relation avec le cabinet actuellement. Merci de rappeler un peu plus tard.",
        ],

        INFO_UNKNOWN: [
            "Je ne peux pas confirmer cette information automatiquement, et je ne peux pas vous mettre en relation pour le moment. Merci de rappeler un peu plus tard.",
            "Je n’ai pas accès à cette information pour le moment, et le cabinet n’est pas joignable. Merci de réessayer plus tard.",
        ],

        GENERIC: [
            "Je ne peux pas traiter cette demande automatiquement, et je ne peux pas vous mettre en relation pour le moment. Merci de rappeler un peu plus tard.",
            "Je ne suis pas en mesure de traiter cette demande pour le moment. Merci de réessayer un peu plus tard.",
        ],
    };

    const list = variants[type] || variants.GENERIC;
    return pickVariant(session, `fallback_${type}`, list);
}

function askIfOtherQuestion(vr, session, intro = "") {
    setPrompt(session, "Est-ce que vous avez d'autres questions ?");

    const gather = gatherSpeech(vr, "/twilio/voice");

    if (intro) {
        sayFr(gather, intro);
    }

    sayFr(gather, session.lastPrompt);
    return gather;
}

async function tryTransferToCabinet({
    vr,
    res,
    session,
    callSid,
    cabinetId,
    cabinet,
    intro,
    fallbackType = "UNAVAILABLE",
    endReason = "TRANSFER_FAILED",
    meta = {},
}) {
    const hasNumber = hasTransferPhoneNumber(cabinet);

    if (!hasNumber) {
        await trackFailedOnce(session, cabinetId);
        await trackDurationOnce(session, cabinetId);

        return endCall(
            vr,
            res,
            callSid,
            session,
            "TRANSFER_NUMBER_MISSING",
            getTransferFallback(session, "MISSING_CONFIG"),
            meta
        );
    }

    const transferred = transferCallToCabinet(vr, cabinet, intro);

    if (!transferred) {
        await trackFailedOnce(session, cabinetId);
        await trackDurationOnce(session, cabinetId);

        return endCall(
            vr,
            res,
            callSid,
            session,
            endReason,
            getTransferFallback(session, fallbackType),
            meta
        );
    }

    return sendTwiml(res, vr, callSid, session);
}

function buildSessionSnapshot(session) {
    return buildSessionSnapshotBase(session, {
        maskPhone,
        maskName,
        summarizeSlot,
    });
}

function setStep(session, callSid, nextStep, meta = {}) {
    return setStepBase(session, callSid, nextStep, logStepTransition, meta);
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
        sayFr(gather, intro);
    }

    if (session.lastPrompt) {
        sayFr(gather, session.lastPrompt);
    }

    return gather;
}

function promptAndGatherDate(vr, session, prompt, intro = "") {
    if (typeof prompt === "string") {
        setPrompt(session, prompt);
    }

    const gather = gatherDateSpeech(vr, "/twilio/voice");

    if (intro) {
        sayFr(gather, intro);
    }

    if (session.lastPrompt) {
        sayFr(gather, session.lastPrompt);
    }

    return gather;
}

function repeatLastPrompt(vr, session) {
    const prompt = session.lastPrompt || "Je répète.";
    const gather = gatherSpeech(vr, "/twilio/voice");
    sayFr(gather, "Je répète.");
    sayFr(gather, prompt);
    return gather;
}

function getCabinetOrFail(vr, cabinet) {
    if (!cabinet) {
        sayFr(vr, "Aucun cabinet n'est associé à ce numéro.");
        vr.hangup();
        return null;
    }

    if (!cabinet.key) {
        sayFr(vr, "Le cabinet est mal configuré. Merci de rappeler plus tard.");
        sayGoodbye(vr);
        return null;
    }

    if (!cabinet.practitioners || !Array.isArray(cabinet.practitioners) || !cabinet.practitioners.length) {
        sayFr(vr, "Aucun praticien n'est encore configuré. Merci de contacter le cabinet.");
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

function buildInitialSession() {
    return {
        step: "ACTION",
        cabinetId: null,
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
        metricsTracked: {
            received: false,
            handled: false,
            failed: false,
            durationTracked: false,
        },
        processedActions: {},
    };
}

async function getSession(callSid) {
    if (!callSid) {
        throw new Error("CALL_SID_REQUIRED");
    }

    let session = null;
    let storageError = false;

    try {
        session = await getStoredSession(callSid);
    } catch (err) {
        storageError = true;
        logError("SESSION_GET_FAILED", {
            callSid,
            message: err?.message,
        });
    }

    if (storageError) {
        throw new Error("SESSION_STORE_UNAVAILABLE");
    }

    if (!session) {
        session = buildInitialSession();

        try {
            const saved = await saveSession(callSid, session);

            if (!saved) {
                throw new Error("SESSION_INIT_SAVE_RETURNED_FALSE");
            }
        } catch (err) {
            logError("SESSION_INIT_SAVE_FAILED", {
                callSid,
                message: err?.message,
            });
            throw new Error("SESSION_INIT_SAVE_FAILED");
        }

        logSessionCreated(callSid, session, {}, buildSessionSnapshot);
    }

    return session;
}

async function clearSession(callSid) {
    try {
        await clearStoredSession(callSid);
    } catch (err) {
        logError("SESSION_CLEAR_FAILED", {
            callSid,
            message: err?.message,
        });
    }
}

async function handleRetry(vr, res, session, callSid, cabinetId, reason = "UNKNOWN") {
    session.retryCount = (session.retryCount || 0) + 1;

    logWarn("MISUNDERSTOOD_RETRY", {
        callSid,
        step: session.step,
        retryCount: session.retryCount,
        reason,
    });

    const MAX_RETRY_BY_STEP = {
        ACTION: 3,
        BOOK_PICK_SLOT: 2,
        BOOK_PICK_ALT: 2,
        BOOK_ASK_PHONE: 4,
        MODIFY_ASK_PHONE: 4,
        CANCEL_ASK_PHONE: 4,
    };

    const maxRetry = MAX_RETRY_BY_STEP[session.step] || 3;

    if (session.retryCount >= maxRetry) {
        logWarn("CALL_ENDED_MISUNDERSTOOD", {
            callSid,
            step: session.step,
            reason,
            maxRetry,
        });

        await trackFailedOnce(session, cabinetId);
        await trackDurationOnce(session, cabinetId);
        return endCall(
            vr,
            res,
            callSid,
            session,
            "CALL_ENDED_MISUNDERSTOOD",
            "Je n’arrive pas à comprendre votre réponse. Merci de rappeler le cabinet si besoin.",
            {
                failedStep: session.step,
                reason,
                retryCount: session.retryCount,
                maxRetry,
            }
        );
    }

    return null;
}

function askActionMenu(vr, session, intro = "") {
    const prompt = getActionPrompt(PHRASES);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice", {
        hints:
            "prendre rendez-vous, prendre, reprendre rendez-vous, reserver un rendez-vous, booker un rendez-vous, modifier rendez-vous, changer rendez-vous, deplacer rendez-vous, reporter rendez-vous, annuler rendez-vous, supprimer rendez-vous, autre, autre demande, autre chose, urgence, question, adresse, horaires, horaire, ouverture, fermeture, ouvert, ferme, localisation, ou se trouve le cabinet, matin, debut de matinee, fin de matinee, apres-midi, debut d'apres-midi, debut d'apres midi, fin d'apres-midi, fin d'apres midi, soir, midi, midi et demi, midi trente, minuit, oui, non, demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, Benjamin, Lisa, peu importe, peu importe le jour, n'importe quel jour, suivi, premier rendez-vous, 12h, 12 heures, 12h30, 17h, 17 heures, 17h30, 18h, 18 heures, 18h30, 19h, 20h, 20 heures, vers 12h, vers 12h30, vers 17h, vers 18h, le plus tot possible, au plus vite, le plus tard possible, n'importe quand, dans la journee, 1, 2, 3, 4",
    });

    if (intro) {
        sayFr(gather, intro);
    }

    sayFr(gather, "Bonjour, je suis Mary, l'assistante du cabinet.");
    sayFr(gather, session.lastPrompt);

    return gather;
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
    const result = await withTimeout(
        suggestTwoSlotsFromDate({
            cabinet,
            practitioners,
            fromDate: fromDateISO,
            durationMinutes: appointmentDurationMinutes || undefined,
            timePreference: timePreference || undefined,
            targetHourMinutes: Number.isFinite(targetHourMinutes) ? targetHourMinutes : undefined,
            priorityPreference: priorityPreference || undefined,
        }),
        8000,
        "SUGGEST_TWO_SLOTS_FROM_DATE"
    );

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

function getFilteredSlotsResponse(session, slots, fallbackPrompt) {
    const filtered = filterSlotsByTimePreference(
        slots,
        session.preferredTimeWindow,
        (slot, preference) =>
            slotMatchesTimePreference(
                slot,
                preference,
                (start) => getMinutesInParis(start, PARIS_TIMEZONE),
                logWarn,
                logInfo
            )
    );

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

function saySlotsOnNode(node, slots) {
    const a = slots?.[0];
    const b = slots?.[1] || slots?.[0];

    if (!a) return;

    sayFr(
        node,
        `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
    );

    if (b && b.start !== a.start) {
        sayFr(
            node,
            `Ou ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""}.`
        );
    }
}

async function sendSmsWithLogging({
    sender,
    payload,
    timeoutLabel,
    logType,
    callSid,
    cabinetId,
    step,
    to,
}) {
    try {
        const sms = await withTimeout(
            sender(payload),
            8000,
            timeoutLabel
        );

        logInfo("SMS_SENT", {
            callSid,
            cabinetId,
            step: step || null,
            type: logType,
            to: maskPhone(to),
            sid: sms?.sid || null,
            status: sms?.status || null,
        });

        return { ok: true, sms };
    } catch (err) {
        logError("SMS_FAILED", {
            callSid,
            cabinetId,
            step: step || null,
            type: logType,
            to: maskPhone(to),
            message: err?.message,
        });

        return { ok: false, error: err };
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

    logInfo("BOOK_REQUESTED_DATE_LOOKUP", {
        callSid,
        requestedDateISO,
        preferredPractitioner: session.preferredPractitioner?.name || null,
        practitionerPreferenceMode: session.practitionerPreferenceMode || null,
        appointmentType: session.appointmentType || null,
        appointmentDurationMinutes: session.appointmentDurationMinutes || null,
        preferredTimeWindow: session.preferredTimeWindow || null,
        preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
            ? session.preferredHourMinutes
            : null,
        priorityPreference: session.priorityPreference || null,
    });

    const { slots, speech: proposeSpeech, status, context } = await lookupSlotsFromDate({
        cabinet,
        practitioners: searchPractitioners,
        fromDateISO: requestedDateISO,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
        timePreference: session.preferredTimeWindow,
        targetHourMinutes: session.preferredHourMinutes,
        priorityPreference: session.priorityPreference,
    });

    const safeSlots = Array.isArray(slots) ? slots : [];
    const hydratedSlotsRaw = hydrateSlotsWithDefaultPractitioner(safeSlots, cabinet);
    const hydratedSlots = Array.isArray(hydratedSlotsRaw) ? hydratedSlotsRaw : [];

    session.slots = hydratedSlots.slice(0, 2);
    const filtered = {
        slots: session.slots,
        hasTimeFilterMiss: !session.slots.length && Boolean(session.preferredTimeWindow),
        prompt: emptyMessage,
    };
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
        const preferredName = session.preferredPractitioner?.name || null;

        if (preferredName && session.lastIntentContext === "BOOK") {
            sayFr(
                vr,
                `Je n’ai pas de disponibilité avec ${preferredName} à cette date.`
            );

            setStep(session, callSid, "BOOK_NO_SLOT_WITH_PRACTITIONER", {
                trigger: "NO_SLOT_SPECIFIC_PRACTITIONER_DATE",
                practitioner: preferredName,
                requestedDateISO,
            });

            promptAndGather(
                vr,
                session,
                "Souhaitez-vous un autre praticien du cabinet, attendre un autre moment, ou être mis en relation avec le cabinet ?"
            );

            return sendTwiml(res, vr, callSid, session);
        }

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

        promptAndGatherDate(
            vr,
            session,
            noAvailabilityPrompt,
            introSpeech
        );
        return sendTwiml(res, vr, callSid, session);
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
        sayFr(
            gather,
            "Le créneau demandé n’est plus disponible, mais j’ai d’autres horaires le même jour."
        );
    }

    if (intro) {
        sayFr(gather, intro);
    }

    const cleaned = cleanProposeSpeech(proposeSpeech);

    if (
        cleaned &&
        !session.preferredTimeWindow &&
        !Number.isFinite(session.preferredHourMinutes) &&
        !session.priorityPreference
    ) {
        sayFr(gather, cleaned);
    } else {
        saySlotsOnNode(gather, session.slots);
    }

    sayFr(gather, prompt);

    return sendTwiml(res, vr, callSid, session);
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
        ? await withTimeout(
            suggestTwoSlotsFromDate({
                cabinet,
                practitioners: searchPractitioners,
                fromDate: fromDateISO,
                durationMinutes: session.appointmentDurationMinutes || undefined,
                timePreference: session.preferredTimeWindow || undefined,
                targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                    ? session.preferredHourMinutes
                    : undefined,
                priorityPreference: session.priorityPreference || undefined,
            }),
            8000,
            "SUGGEST_TWO_SLOTS_FROM_DATE"
        )
        : await withTimeout(
            suggestTwoSlotsNext7Days({
                cabinet,
                practitioners: searchPractitioners,
                durationMinutes: session.appointmentDurationMinutes || undefined,
                timePreference: session.preferredTimeWindow || undefined,
                targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                    ? session.preferredHourMinutes
                    : undefined,
                priorityPreference: session.priorityPreference || undefined,
            }),
            8000,
            "SUGGEST_TWO_SLOTS_NEXT_7_DAYS"
        );

    const slots = Array.isArray(result) ? result : result?.slots || [];
    const proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

    const resultStatus = Array.isArray(result) ? null : result?.status || null;
    const resultContext = Array.isArray(result) ? {} : result?.context || {};

    const safeSlots = Array.isArray(slots) ? slots : [];
    const hydratedSlotsRaw = hydrateSlotsWithDefaultPractitioner(safeSlots, cabinet);
    const hydratedSlots = Array.isArray(hydratedSlotsRaw) ? hydratedSlotsRaw : [];

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
        const preferredName = session.preferredPractitioner?.name || null;

        if (preferredName) {
            sayFr(
                vr,
                `Je n’ai pas de disponibilité avec ${preferredName} dans les prochains jours.`
            );

            setStep(session, callSid, "BOOK_NO_SLOT_WITH_PRACTITIONER", {
                trigger: "NO_SLOT_SPECIFIC_PRACTITIONER",
                practitioner: preferredName,
            });

            promptAndGather(
                vr,
                session,
                "Souhaitez-vous un autre praticien du cabinet, attendre un créneau plus tard, ou être mis en relation avec le cabinet ?"
            );
            return sendTwiml(res, vr, callSid, session);
        }

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
        promptAndGatherDate(vr, session, followUpPrompt);
        return sendTwiml(res, vr, callSid, session);
    }

    setStep(session, callSid, "BOOK_PICK_SLOT", {
        trigger: "BOOKING_SLOTS_PROPOSED",
        slotsCount: session.slots.length,
    });

    const prompt = getSlotSelectionPrompt(session);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice");

    if (session.preferredPractitioner?.name) {
        sayFr(gather, `Je cherche avec ${session.preferredPractitioner.name}.`);
    } else {
        sayFr(gather, pickVariant(session, "search", [
            "Je regarde.",
            "Je vérifie les disponibilités.",
            "Un instant, je cherche."
        ]));
    }

    const cleaned = cleanProposeSpeech(proposeSpeech);

    if (
        cleaned &&
        !session.preferredTimeWindow &&
        !Number.isFinite(session.preferredHourMinutes) &&
        !session.priorityPreference
    ) {
        sayFr(gather, cleaned);
    } else {
        saySlotsOnNode(gather, session.slots);
    }

    sayFr(gather, prompt);

    return sendTwiml(res, vr, callSid, session);
}

function goToBookingPreferredDate(session, callSid, promptIntro = "Très bien.") {
    session.slots = [];
    session.pendingSlot = null;
    session.requestedDateISO = null;

    setStep(session, callSid, "BOOK_ASK_PREFERRED_DATE", {
        trigger: "BOOKING_PREFERENCE_READY",
        practitionerPreferenceMode: session.practitionerPreferenceMode || null,
        preferredPractitioner: session.preferredPractitioner?.name || null,
    });

    return promptIntro;
}

async function continueBookingAfterPractitionerSelection({
    vr,
    res,
    session,
    callSid,
    cabinet,
    speech = "",
    intro = "Très bien.",
}) {
    const requestedDateISO = parseRequestedDate(speech);

    if (requestedDateISO) {
        return proposeSlotsFromRequestedDate({
            vr,
            res,
            session,
            callSid,
            cabinet,
            requestedDateISO,
            nextStep: "BOOK_PICK_SLOT",
            intro,
            emptyMessage: "Je n’ai pas trouvé de disponibilité à cette date.",
        });
    }

    const introSpeech = goToBookingPreferredDate(session, callSid, intro);

    promptAndGatherDate(
        vr,
        session,
        "Quel jour vous conviendrait ?",
        introSpeech
    );

    return sendTwiml(res, vr, callSid, session);
}

async function finalizeBooking(vr, res, session, callSid, cabinet, cabinetId) {
    const slot = session.pendingSlot;
    session.pendingSlot = null;

    if (!slot || !slot.calendarId) {
        logError("BOOKING_PENDING_SLOT_MISSING", {
            callSid,
            patientName: maskName(session.patientName),
            phone: maskPhone(session.phone),
        });

        return endCall(
            vr,
            res,
            callSid,
            session,
            "BOOKING_PENDING_SLOT_MISSING",
            "Je ne retrouve plus le créneau sélectionné.",
            {
                patientName: maskName(session.patientName),
                phone: maskPhone(session.phone),
            }
        );
    }

    logInfo("BOOKING_ATTEMPT", {
        callSid,
        cabinetId,
        step: session.step,
        calendarId: slot.calendarId,
        patientName: maskName(session.patientName),
        phone: maskPhone(session.phone),
        slot: summarizeSlot(slot),
        appointmentType: session.appointmentType,
        appointmentDurationMinutes: session.appointmentDurationMinutes,
    });

    const bookingActionKey = `BOOK:${slot.calendarId}:${new Date(slot.start).toISOString()}:${session.phone}`;

    if (hasProcessedAction(session, bookingActionKey)) {
        logWarn("BOOKING_ALREADY_PROCESSED", {
            callSid,
            bookingActionKey,
        });

        sayFr(vr, "Votre demande est déjà en cours de traitement.");
        return sendTwiml(res, vr, callSid, session);
    }

    markProcessedAction(session, bookingActionKey);

    const result = await withTimeout(
        bookAppointmentSafe({
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
        }),
        8000,
        "BOOK_APPOINTMENT"
    );

    logInfo("BOOKING_RESULT", {
        callSid,
        cabinetId,
        step: session.step,
        ok: result.ok,
        code: result.code || null,
        eventId: result.event?.id || null,
        slot: summarizeSlot(slot),
    });

    if (result.ok) {
        await incrementMetric(cabinetId, "appointmentsBooked");
        await trackHandledOnce(session, cabinetId);
        await trackDurationOnce(session, cabinetId);
        logCallOutcome(callSid, "BOOK_SUCCESS", session, {
            eventId: result.event?.id || null,
            slot: summarizeSlot(slot),
        }, buildSessionSnapshot);

        sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
        sayFr(
            vr,
            `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""}.`
        );

        await sendSmsWithLogging({
            sender: sendAppointmentConfirmationSMS,
            payload: {
                to: session.phone,
                patientName: session.patientName || "Patient",
                formattedSlot: formatSlotFR(slot.start),
                practitionerName: slot.practitionerName || "",
            },
            timeoutLabel: "SEND_BOOK_CONFIRMATION_SMS",
            logType: "BOOK_CONFIRMATION",
            callSid,
            cabinetId,
            step: session?.step,
            to: session.phone,
        });

        sayGoodbye(vr);
        await clearSessionWithLog(callSid, session, "BOOK_SUCCESS", {
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

    const safeAltSlots = Array.isArray(altSlots) ? altSlots : [];
    const hydratedAltSlotsRaw = hydrateSlotsWithDefaultPractitioner(safeAltSlots, cabinet);
    const hydratedAltSlots = Array.isArray(hydratedAltSlotsRaw) ? hydratedAltSlotsRaw : [];

    session.slots = filterSlotsByTimePreference(
        hydratedAltSlots,
        session.preferredTimeWindow,
        (slot, preference) =>
            slotMatchesTimePreference(
                slot,
                preference,
                (start) => getMinutesInParis(start, PARIS_TIMEZONE),
                logWarn,
                logInfo
            )
    );
    rememberLastProposedSlots(session);

    if (!session.slots?.length) {
        return endCall(
            vr,
            res,
            callSid,
            session,
            "BOOK_FAILED_NO_ALT_SLOT",
            `${statusMsg} Je n’ai pas d’autre créneau disponible rapidement. Merci de rappeler le cabinet.`,
            {
                code: result.code || null,
                requestedSlot: summarizeSlot(slot),
            }
        );
    }

    setStep(session, callSid, "BOOK_PICK_ALT", {
        trigger: "BOOKING_FAILED_ALT_PROPOSED",
        slotsCount: session.slots.length,
    });

    const prompt = getSlotSelectionPrompt(session);
    setPrompt(session, prompt);

    const gather = gatherSpeech(vr, "/twilio/voice");

    sayFr(gather, statusMsg);
    sayFr(gather, "Je peux vous proposer un autre créneau.");

    saySlotsOnNode(gather, session.slots);

    sayFr(gather, prompt);

    return sendTwiml(res, vr, callSid, session);
}

router.post("/voice", async (req, res) => {

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const vr = new VoiceResponse();

    try {

        const calledNumber = (req.body?.To || "").trim();

        const resolvedCabinet = await findCabinetByTwilioNumber(calledNumber);

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
        const billingCabinet = await getCabinetBilling(cabinetId);

        if (!billingCabinet || billingCabinet.status !== "active") {
            logWarn("CABINET_SUBSCRIPTION_INACTIVE", {
                callSid: safeCallSid(req),
                cabinetId,
                billingStatus: billingCabinet?.status || null,
            });

            const blockedVr = new twilio.twiml.VoiceResponse();
            sayFr(
                blockedVr,
                "Le service de prise de rendez-vous automatique est momentanément indisponible. Merci de contacter directement le cabinet.");
            blockedVr.hangup();

            return sendTwiml(res, blockedVr);
        }

        const callSid = safeCallSid(req);
        if (!callSid) {
            logError("MISSING_CALL_SID", {
                bodyCallSid: req.body?.CallSid || null,
                headerCallSid: req.headers["x-twilio-call-sid"] || null,
                calledNumber,
            });

            sayFr(
                vr,
                "Une erreur technique est survenue. Merci de rappeler le cabinet dans quelques instants."
            );
            vr.hangup();
            return sendTwiml(res, vr);
        }
        const speech = (
            req.body?.SpeechResult ||
            req.body?.UnstableSpeechResult ||
            ""
        ).trim();
        const digits = (req.body?.Digits || "").trim();

        logInfo("RAW_SPEECH_DEBUG", {
            speechResult: req.body?.SpeechResult || "",
            unstableSpeechResult: req.body?.UnstableSpeechResult || "",
            digits: req.body?.Digits || "",
        });

        let session;

        try {
            session = await getSession(callSid);
        } catch (err) {
            logError("SESSION_BOOTSTRAP_FAILED", {
                callSid,
                cabinetId,
                message: err?.message,
            });

            sayFr(
                vr,
                "Une erreur technique est survenue. Merci de rappeler le cabinet dans quelques instants."
            );
            vr.hangup();
            return sendTwiml(res, vr);
        }

        session.cabinetId = cabinetId;

        if (!session.metricsTracked) {
            session.metricsTracked = {
                received: false,
                handled: false,
                failed: false,
                durationTracked: false,
            };
        }

        if (!session.metricsTracked.received) {
            await trackCallReceived(session, cabinetId, incrementMetric);
            session.metricsTracked.received = true;
        }
        logInfo("VOICE_WEBHOOK", {
            callSid,
            cabinetId,
            step: session.step,
            speech: process.env.NODE_ENV !== "production" ? speech : maskSpeech(speech),
            unstableSpeech:
                process.env.NODE_ENV !== "production"
                    ? (req.body?.UnstableSpeechResult || "")
                    : maskSpeech(req.body?.UnstableSpeechResult || ""),
            digits,
            confidence: req.body?.Confidence || null,
            hasInput: Boolean(speech || digits),
        });

        const validatedCabinet = getCabinetOrFail(vr, cabinet);
        if (!validatedCabinet) {
            logError("CABINET_CONFIG_INVALID", { callSid, cabinetId, calledNumber });

            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);

            logCallOutcome(
                callSid,
                "CABINET_CONFIG_INVALID",
                session,
                { cabinetId, calledNumber },
                buildSessionSnapshot
            );

            await clearSession(callSid);
            return sendTwiml(res, vr);
        }

        const activeCabinet = validatedCabinet;
        const durations = getCabinetDurations(activeCabinet);
        logInfo("ACTIVE_CABINET_DEBUG", {
            callSid,
            cabinetId,
            cabinetKey: activeCabinet?.key || null,
            hasOpeningHours: Array.isArray(activeCabinet?.openingHours),
            openingHours: activeCabinet?.openingHours || null,
            hasSchedulingOpeningHours: Array.isArray(activeCabinet?.scheduling?.openingHours),
            schedulingOpeningHours: activeCabinet?.scheduling?.openingHours || null,
        });

        const hasInput = Boolean(speech || digits);
        const normalizedSpeech = normalizeText(speech);

        if (hasInput && wantsRepeat(normalizedSpeech) && session.step !== "ACTION") {
            repeatLastPrompt(vr, session);
            return sendTwiml(res, vr, callSid, session);
        }

        if (isCallTooLong(session)) {
            logWarn("CALL_MAX_DURATION_REACHED", {
                callSid,
                cabinetId,
                step: session.step,
                snapshot: buildSessionSnapshot(session),
            });

            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
            return endCall(
                vr,
                res,
                callSid,
                session,
                "CALL_MAX_DURATION_REACHED",
                "L'appel a été interrompu pour éviter une erreur technique. Merci de rappeler le cabinet.",
                {
                    step: session.step,
                }
            );
        }

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
            return sendTwiml(res, vr, callSid, session);
        }

        if (hasInput && wantsMainMenu(normalizedSpeech) && session.step !== "ACTION") {
            resetToMenu(session, callSid, "USER_REQUESTED_MAIN_MENU", logInfo);
            askActionMenu(
                vr,
                session,
                pickVariant(session, "menu_back", [
                    "D'accord, retour au menu principal.",
                    "Très bien, je reviens au menu principal.",
                    "Entendu, on repart du début.",
                ])
            );
            return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
            return endCall(
                vr,
                res,
                callSid,
                session,
                "CALL_ENDED_NO_INPUT",
                "Je n’ai pas eu de réponse.",
                {
                    step: session.step,
                    noInputCount: session.noInputCount,
                }
            );
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
                    cabinetId,
                    speech: process.env.NODE_ENV !== "production" ? speech : maskSpeech(speech),
                    digits,
                    normalizedSpeech:
                        process.env.NODE_ENV !== "production"
                            ? normalizeText(speech)
                            : undefined,
                    detectedAction: actionChoice,
                    confidence: req.body?.Confidence || null,
                });

                if (!hasInput) {
                    askActionMenu(vr, session);
                    return sendTwiml(res, vr, callSid, session);
                }

                if (detectOtherRequest(speech, digits)) {
                    session.lastIntentContext = "OTHER";

                    setStep(session, callSid, "OTHER_ROUTER", { trigger: "ACTION_OTHER" });

                    promptAndGather(
                        vr,
                        session,
                        "S'agit-il d'une urgence ou d'une demande d'information ?",
                        "Très bien."
                    );
                    return sendTwiml(res, vr, callSid, session);
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
                    return sendTwiml(res, vr, callSid, session);
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
                    return sendTwiml(res, vr, callSid, session);
                }

                if (actionChoice === "BOOK") {
                    resetBookingFlowState(session);
                    session.lastIntentContext = "BOOK";
                    session.initialBookingSpeech = speech || "";
                    session.phonePurpose = "BOOK";
                    session.actionAckOverride = "Très bien.";
                    setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
                    setPrompt(session, "");
                    vr.redirect({ method: "POST" }, "/twilio/voice");
                    return sendTwiml(res, vr, callSid, session);
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "ACTION");
                if (retry) return retry;

                const gather = gatherSpeech(vr, "/twilio/voice", {
                    hints:
                        "prendre rendez-vous, prendre, rendez-vous, rdv, reserver, booker, modifier, changer, deplacer, reporter, annuler, supprimer, retirer, autre, urgence, question, adresse, horaires, horaire, ouvert, ferme, localisation, venir, 1, 2, 3, 4",
                });

                setPrompt(
                    session,
                    "Je n’ai pas bien compris. Dites prendre, modifier, annuler ou autre. Vous pouvez aussi taper 1, 2, 3 ou 4."
                );

                sayFr(gather, "Je n’ai pas bien compris.");

                sayFr(
                    gather,
                    "Dites prendre, modifier, annuler ou autre. Vous pouvez aussi taper 1 pour prendre, 2 pour modifier, 3 pour annuler, 4 pour autre."
                );

                return sendTwiml(res, vr, callSid, session);
            }

            if (isBookStep(session.step)) {
                const handled = await handleBookStep({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinetId,
                    activeCabinet,
                    speech,
                    digits,
                    durations,
                    detectAppointmentType,
                    updateTimePreferenceFromSpeech,
                    findPractitionerBySpeech,
                    detectNoPractitionerPreference,
                    detectUsualPractitionerIntent,
                    asksWhoAreThePractitioners,
                    detectForgotPractitionerIdentity,
                    parseYesNo,
                    normalizeText,
                    handleRetry,
                    promptAndGather,
                    promptAndGatherDate,
                    sendTwiml,
                    setStep,
                    getPractitionerPrompt,
                    buildPractitionersSpeech,
                    pickVariant,
                    consumeActionAck,
                    continueBookingAfterPractitionerSelection,
                    proposeBookingSlots,
                    proposeSlotsFromRequestedDate,
                    tryTransferToCabinet,
                    gatherSpeech,
                    sayFr,
                    isExplicitDateRequest,
                    parseRequestedDate,
                    hasPreferenceRefinementRequest,
                    detectAlternativeRequest,
                    pickChoiceFromSpeech,
                    getSlotWeekdayFR,
                    getSlotHourMinuteFR,
                    getHourInParis,
                    PARIS_TIMEZONE,
                    getSlotSelectionPrompt,
                    formatSlotFR,
                    saySlotsOnNode,
                    summarizeSlot,
                    summarizeSlots,
                    isLikelyValidPatientName,
                    parsePhone,
                    getPhoneConfirmPrompt,
                    finalizeBooking,
                });



                if (handled) {
                    return handled;
                }
            }

            if (isModifyStep(session.step)) {
                const handled = await handleModifyStep({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinetId,
                    activeCabinet,
                    speech,
                    digits,
                    durations,
                    parsePhone,
                    parseYesNo,
                    parseRequestedDate,
                    isExplicitDateRequest,
                    hasPreferenceRefinementRequest,
                    detectAlternativeRequest,
                    normalizeText,
                    handleRetry,
                    promptAndGather,
                    sendTwiml,
                    setStep,
                    setPrompt,
                    getPhoneConfirmPrompt,
                    withTimeout,
                    findNextAppointmentSafe,
                    maskPhone,
                    maskName,
                    gatherSpeech,
                    formatSlotFR,
                    isLessThan24h,
                    addCallbackNoteToEvent,
                    endCall,
                    getSearchPractitioners,
                    suggestTwoSlotsNext7Days,
                    cleanProposeSpeech,
                    saySlotsOnNode,
                    getSlotSelectionPrompt,
                    proposeSlotsFromRequestedDate,
                    pickChoiceFromSpeech,
                    getSlotWeekdayFR,
                    getSlotHourMinuteFR,
                    getHourInParis,
                    PARIS_TIMEZONE,
                    summarizeSlot,
                    summarizeSlots,
                    sayFr,
                    sayGoodbye,
                    bookAppointmentSafe,
                    hasProcessedAction,
                    markProcessedAction,
                    cancelAppointmentSafe,
                    incrementMetric,
                    trackHandledOnce,
                    trackDurationOnce,
                    logInfo,
                    logWarn,
                    logCallOutcome,
                    buildSessionSnapshot,
                    sendSmsWithLogging,
                    sendAppointmentModifiedSMS,
                    promptAndGatherDate,
                });

                if (handled) {
                    return handled;
                }
            }

            if (isCancelStep(session.step)) {
                const handled = await handleCancelStep({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinetId,
                    activeCabinet,
                    speech,
                    digits,
                    parsePhone,
                    parseYesNo,
                    normalizeText,
                    handleRetry,
                    promptAndGather,
                    sendTwiml,
                    setStep,
                    setPrompt,
                    getPhoneConfirmPrompt,
                    withTimeout,
                    findNextAppointmentSafe,
                    maskPhone,
                    maskName,
                    gatherSpeech,
                    formatSlotFR,
                    isLessThan24h,
                    addCallbackNoteToEvent,
                    endCall,
                    sayFr,
                    sayGoodbye,
                    cancelAppointmentSafe,
                    hasProcessedAction,
                    markProcessedAction,
                    logInfo,
                    logWarn,
                    logError,
                    sendSmsWithLogging,
                    sendAppointmentCancelledSMS,
                    incrementMetric,
                    trackHandledOnce,
                    trackDurationOnce,
                    logCallOutcome,
                    buildSessionSnapshot,
                    resetBookingFlowState,
                    pickVariant,
                });

                if (handled) {
                    return handled;
                }
            }

            if (session.step === "OTHER_ROUTER") {
                if (detectUrgencyRequest(speech)) {
                    setStep(session, callSid, "TRANSFER_TO_CABINET", {
                        trigger: "OTHER_URGENT",
                    });

                    return tryTransferToCabinet({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinetId,
                        cabinet: activeCabinet,
                        intro: "Je vous transfère immédiatement au cabinet.",
                        fallbackType: "UNAVAILABLE",
                        endReason: "TRANSFER_FAILED",
                        meta: { fromStep: "OTHER_ROUTER" },
                    });
                }

                setStep(session, callSid, "OTHER_ASK", {
                    trigger: "OTHER_NEEDS_DETAILS",
                });

                promptAndGather(
                    vr,
                    session,
                    "Quelle est votre demande ?",
                    "D'accord."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            if (session.step === "OTHER_ASK") {
                if (!speech || !normalizeText(speech)) {
                    const retry = await handleRetry(vr, res, session, callSid, cabinetId, "OTHER_ASK_EMPTY");
                    if (retry) return retry;

                    promptAndGather(
                        vr,
                        session,
                        "Je n’ai pas bien compris votre demande. Vous pouvez par exemple dire l'adresse, les horaires, ou préciser votre question."
                    );
                    return sendTwiml(res, vr, callSid, session);
                }

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

                const asksPresence =
                    t.includes("est la aujourd hui") ||
                    t.includes("est la aujourd'hui") ||
                    t.includes("il est la") ||
                    t.includes("elle est la") ||
                    t.includes("present aujourd hui") ||
                    t.includes("présent aujourd'hui");

                if (asksAddress) {
                    await trackHandledOnce(session, cabinetId);

                    setStep(session, callSid, "OTHER_ASK_MORE", {
                        trigger: "INFO_ADDRESS_GIVEN",
                    });

                    askIfOtherQuestion(
                        vr,
                        session,
                        activeCabinet?.addressSpeech ||
                        "Le cabinet se situe à l'adresse renseignée par le cabinet."
                    );

                    return sendTwiml(res, vr, callSid, session);
                }

                if (asksHours) {
                    await trackHandledOnce(session, cabinetId);

                    setStep(session, callSid, "OTHER_ASK_MORE", {
                        trigger: "INFO_HOURS_GIVEN",
                    });

                    askIfOtherQuestion(
                        vr,
                        session,
                        activeCabinet?.hoursSpeech ||
                        "Le cabinet est ouvert du lundi au vendredi de 8 heures à 12 heures et de 14 heures à 19 heures."
                    );

                    return sendTwiml(res, vr, callSid, session);
                }

                if (asksPresence) {
                    setStep(session, callSid, "TRANSFER_TO_CABINET", {
                        trigger: "INFO_PRESENCE_TRANSFER",
                    });

                    return tryTransferToCabinet({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinetId,
                        cabinet: activeCabinet,
                        intro: "Je ne peux pas confirmer cette information automatiquement. Je vous transfère au cabinet.",
                        fallbackType: "INFO_UNKNOWN",
                        endReason: "TRANSFER_FAILED",
                        meta: {
                            fromStep: "OTHER_ASK",
                            intent: "PRESENCE_CHECK",
                        },
                    });
                }

                setStep(session, callSid, "TRANSFER_TO_CABINET", {
                    trigger: "OTHER_UNKNOWN_TRANSFER",
                });

                return tryTransferToCabinet({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinetId,
                    cabinet: activeCabinet,
                    intro: "Je ne peux pas traiter cette demande automatiquement. Je vous transfère au cabinet.",
                    fallbackType: "GENERIC",
                    endReason: "TRANSFER_FAILED",
                    meta: { fromStep: "OTHER_ASK" },
                });
            }


            if (session.step === "OTHER_ASK_MORE") {
                if (!speech || !normalizeText(speech)) {
                    const retry = await handleRetry(vr, res, session, callSid, cabinetId, "OTHER_ASK_MORE_EMPTY");
                    if (retry) return retry;

                    promptAndGather(
                        vr,
                        session,
                        "Je n’ai pas bien compris. Est-ce que vous avez d'autres questions ? Répondez par oui ou par non."
                    );
                    return sendTwiml(res, vr, callSid, session);
                }

                const yesNo = parseYesNo(speech);
                const t = normalizeText(speech);

                const wantsAnotherQuestion =
                    yesNo === true ||
                    t.includes("oui") ||
                    t.includes("j'ai une autre question") ||
                    t.includes("j ai une autre question") ||
                    t.includes("encore une question") ||
                    t.includes("autre question");

                if (wantsAnotherQuestion) {
                    setStep(session, callSid, "OTHER_ASK", {
                        trigger: "USER_HAS_ANOTHER_QUESTION",
                    });

                    promptAndGather(
                        vr,
                        session,
                        "Quelle est votre question ?",
                        "Je vous écoute."
                    );
                    return sendTwiml(res, vr, callSid, session);
                }

                if (yesNo === false || t.includes("non")) {
                    await trackDurationOnce(session, cabinetId);

                    return endCall(
                        vr,
                        res,
                        callSid,
                        session,
                        "OTHER_COMPLETED",
                        "Pas de souci. Au revoir."
                    );
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "OTHER_ASK_MORE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Est-ce que vous avez d'autres questions ?"
                );
                return sendTwiml(res, vr, callSid, session);
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "FALLBACK");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                getGuidedFallbackPrompt(session.step),
                pickVariant(session, "global_fallback_intro", [
                    "Je n’ai pas bien compris.",
                    "Je n'ai pas saisi votre réponse.",
                    "Je préfère vérifier pour éviter une erreur.",
                    "Je veux être sûr de bien vous répondre.",
                ])
            );
            return sendTwiml(res, vr, callSid, session);
        } catch (err) {
            logError("UNEXPECTED_ERROR", {
                message: err?.message,
                stack: err?.stack,
                step: session.step,
                callSid,
                phone: maskPhone(session.phone),
                patientName: maskName(session.patientName || ""),
            });

            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
            logCallOutcome(callSid, "UNEXPECTED_ERROR", session, {
                errorMessage: err?.message,
                step: session.step,
            }, buildSessionSnapshot);

            return endCall(
                vr,
                res,
                callSid,
                session,
                "UNEXPECTED_ERROR",
                PHRASES.errorGeneric || "Une erreur est survenue. Veuillez réessayer plus tard.",
                {
                    errorMessage: err?.message,
                }
            );
        }
    } catch (err) {
        logError("VOICE_ROUTE_FATAL_ERROR", {
            message: err?.message,
            stack: err?.stack,
            callSid: safeCallSid(req),
        });

        sayFr(
            vr,
            "Une erreur technique est survenue. Merci de rappeler le cabinet dans quelques instants."
        );
        vr.hangup();
        return sendTwiml(res, vr);
    }
});

router.post("/transfer-status", async (req, res) => {
    const vr = new twilio.twiml.VoiceResponse();
    const status = String(req.body?.DialCallStatus || "").trim().toLowerCase();
    const callSid = safeCallSid(req);

    logInfo("TRANSFER_STATUS", {
        callSid,
        dialCallStatus: status || null,
    });

    let session = null;
    let cabinetId = null;

    if (callSid) {
        try {
            session = await getStoredSession(callSid);
            cabinetId = session?.cabinetId || null;
        } catch (err) {
            logError("TRANSFER_STATUS_SESSION_LOAD_FAILED", {
                callSid,
                message: err?.message,
            });
        }
    }

    if (status === "completed") {
        if (session && cabinetId) {
            await trackHandledOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
        }

        if (callSid) {
            await clearSession(callSid);
        }

        return sendTwiml(res, vr);
    }

    if (status === "busy") {
        if (session && cabinetId) {
            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
        }

        if (callSid) {
            await clearSession(callSid);
        }

        sayFr(
            vr,
            "Le cabinet est actuellement en ligne. Merci de rappeler dans quelques instants."
        );
        vr.hangup();
        return sendTwiml(res, vr);
    }

    if (status === "no-answer") {
        if (session && cabinetId) {
            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
        }

        if (callSid) {
            await clearSession(callSid);
        }

        sayFr(
            vr,
            "Le cabinet ne répond pas pour le moment. Merci de rappeler un peu plus tard."
        );
        vr.hangup();
        return sendTwiml(res, vr);
    }

    if (status === "failed" || status === "canceled") {
        if (session && cabinetId) {
            await trackFailedOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
        }

        if (callSid) {
            await clearSession(callSid);
        }

        sayFr(
            vr,
            "Je n'ai pas pu vous mettre en relation avec le cabinet. Merci de rappeler plus tard."
        );
        vr.hangup();
        return sendTwiml(res, vr);
    }

    if (session && cabinetId) {
        await trackFailedOnce(session, cabinetId);
        await trackDurationOnce(session, cabinetId);
    }

    if (callSid) {
        await clearSession(callSid);
    }

    sayFr(
        vr,
        "Je n'ai pas pu vous mettre en relation avec le cabinet pour le moment. Merci de rappeler plus tard."
    );
    vr.hangup();
    return sendTwiml(res, vr);
});

module.exports = router;