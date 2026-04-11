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
    const safeText = String(text || "").trim();

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
        input: "speech",
        language: "fr-FR",
        speechModel: "phone_call",
        speechTimeout: "auto",
        timeout: 10,
        actionOnEmptyResult: true,
        bargeIn: true,
        action: actionUrl,
        method: "POST",
        hints:
            "prendre rendez-vous, prendre, reprendre rendez-vous, reserver un rendez-vous, booker un rendez-vous, modifier rendez-vous, changer rendez-vous, deplacer rendez-vous, reporter rendez-vous, annuler rendez-vous, supprimer rendez-vous, information, renseignements, adresse, horaires, horaire, ouverture, fermeture, ouvert, ferme, localisation, ou se trouve le cabinet, matin, debut de matinee, fin de matinee, apres-midi, debut d'apres-midi, debut d'apres midi, fin d'apres-midi, fin d'apres midi, soir, midi, midi et demi, midi trente, minuit, oui, non, demain, lundi, mardi, mercredi, jeudi, vendredi, samedi, Benjamin, Lisa, peu importe, peu importe le jour, n'importe quel jour, suivi, premier rendez-vous, lundi prochain, mardi prochain, mercredi prochain, jeudi prochain, vendredi prochain, semaine prochaine, le 18 mars, le 20 avril, 12h, 12 heures, 12h30, 17h, 17 heures, 17h30, 18h, 18 heures, 18h30, 19h, 20h, 20 heures, vers 12h, vers 12h30, vers 17h, vers 18h, le plus tot possible, au plus vite, le plus tard possible, n'importe quand, dans la journee",
        ...overrides,
    });
}

function sayGoodbye(vr) {
    sayFr(vr, PHRASES.goodbye || "À bientôt. Au revoir.");
    vr.hangup();
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
            }
        } catch (err) {
            logError("SESSION_SAVE_FAILED", {
                severity: "HIGH",
                callSid,
                message: err?.message,
                step: session?.step || null,
            });
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

function buildInitialSession() {
    return {
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

    if (session.retryCount >= 3) {
        logWarn("CALL_ENDED_MISUNDERSTOOD", {
            callSid,
            step: session.step,
            reason,
        });

        trackFailedCall(session, cabinetId, incrementMetric);
        trackCallDuration(session, cabinetId, addCallDuration);
        return endCall(
            vr,
            res,
            callSid,
            session,
            "CALL_ENDED_MISUNDERSTOOD",
            "Je n’arrive pas à comprendre votre réponse.",
            {
                failedStep: session.step,
                reason,
                retryCount: session.retryCount,
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

    node.say(
        SAY_OPTS,
        `Je peux vous proposer ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""}.`
    );

    if (b && b.start !== a.start) {
        node.say(
            SAY_OPTS,
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
        saySlotsOnNode(gather, session.slots);
    }

    gather.say(SAY_OPTS, prompt);

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
        saySlotsOnNode(gather, session.slots);
    }

    gather.say(SAY_OPTS, prompt);

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

    promptAndGather(
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
        incrementMetric(cabinetId, "appointmentsBooked");
        incrementMetric(cabinetId, "successfulCallFlows");
        trackCallHandled(session, cabinetId, incrementMetric);
        trackCallDuration(session, cabinetId, addCallDuration);
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

    gather.say(SAY_OPTS, statusMsg);
    gather.say(SAY_OPTS, "Je peux vous proposer un autre créneau.");

    saySlotsOnNode(gather, session.slots);

    gather.say(SAY_OPTS, prompt);

    return sendTwiml(res, vr, callSid, session);
}

router.post("/voice", async (req, res) => {

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
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const vr = new VoiceResponse();

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

    trackCallReceived(session, cabinetId, incrementMetric);

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

        trackFailedCall(session, cabinetId, incrementMetric);
        trackCallDuration(session, cabinetId, addCallDuration);
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

        trackFailedCall(session, cabinetId, incrementMetric);
        trackCallDuration(session, cabinetId, addCallDuration);
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

            if (actionChoice === "INFO") {
                setStep(session, callSid, "INFO_HANDLE", { trigger: "ACTION_INFO" });

                promptAndGather(
                    vr,
                    session,
                    "Souhaitez-vous connaître l'adresse du cabinet ou les horaires d'ouverture ?",
                    "Bien sûr."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "ACTION");
            if (retry) return retry;

            const gather = gatherSpeech(vr, "/twilio/voice", {
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

            return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            if (!session.practitionerPreferenceMode) {
                setStep(session, callSid, "BOOK_ASK_PRACTITIONER_PREF", {
                    trigger: "APPOINTMENT_TYPE_READY",
                });
                promptAndGather(vr, session, getPractitionerPrompt(session), consumeActionAck(session));
                return sendTwiml(res, vr, callSid, session);
            }

            if (session.practitionerPreferenceMode === "USUAL" && !session.preferredPractitioner) {
                setStep(session, callSid, "BOOK_ASK_USUAL_PRACTITIONER", {
                    trigger: "USUAL_PRACTITIONER_REQUESTED",
                });
                promptAndGather(vr, session, "Avec quel kiné êtes-vous habituellement suivi ?", consumeActionAck(session));
                return sendTwiml(res, vr, callSid, session);
            }

            session.actionAckOverride = "";
            return continueBookingAfterPractitionerSelection({
                vr,
                res,
                session,
                callSid,
                cabinet: activeCabinet,
                speech: seed,
                intro: "Très bien.",
            });
        }

        if (session.step === "BOOK_ASK_APPOINTMENT_TYPE") {
            const detectedType = detectAppointmentType(speech);

            if (!detectedType) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_APPOINTMENT_TYPE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me dire si c’est un premier rendez-vous ou un rendez-vous de suivi."
                );
                return sendTwiml(res, vr, callSid, session);
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
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_ASK_PRACTITIONER_PREF") {
            const practitioner = findPractitionerBySpeech(speech, activeCabinet);
            const noPreference = detectNoPractitionerPreference(speech);
            const usual = detectUsualPractitionerIntent(speech);
            const yesNo = parseYesNo(speech);

            if (asksWhoAreThePractitioners(speech)) {
                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, buildPractitionersSpeech(activeCabinet));
                gather.say(SAY_OPTS, getPractitionerPrompt(session));
                return sendTwiml(res, vr, callSid, session);
            }

            if (practitioner) {
                session.preferredPractitioner = practitioner;
                session.practitionerPreferenceMode = "SPECIFIC";

                logInfo("PRACTITIONER_PREFERENCE_SET", {
                    callSid,
                    practitionerPreferenceMode: "SPECIFIC",
                    preferredPractitioner: session.preferredPractitioner?.name || null,
                    speech,
                });

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
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

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
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
                return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PRACTITIONER_PREF");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Répondez simplement par oui, non, ou peu importe."
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME") {
            if (detectForgotPractitionerIdentity(speech) || asksWhoAreThePractitioners(speech)) {
                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, buildPractitionersSpeech(activeCabinet));
                gather.say(SAY_OPTS, "Quel est le nom du kiné souhaité ?");
                return sendTwiml(res, vr, callSid, session);
            }

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

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
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

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas reconnu le nom du kiné. Merci de me redire son nom, ou dites peu importe."
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_ASK_USUAL_PRACTITIONER") {
            if (detectForgotPractitionerIdentity(speech) || asksWhoAreThePractitioners(speech)) {
                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, buildPractitionersSpeech(activeCabinet));
                gather.say(SAY_OPTS, "Avec quel kiné êtes-vous habituellement suivi ?");
                return sendTwiml(res, vr, callSid, session);
            }

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

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
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

                return continueBookingAfterPractitionerSelection({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                    speech,
                    intro: "Très bien.",
                });
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_USUAL_PRACTITIONER");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe."
            );
            return sendTwiml(res, vr, callSid, session);
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
                    return endCall(
                        vr,
                        res,
                        callSid,
                        session,
                        "BOOK_SLOTS_LOST",
                        "Je ne retrouve plus les créneaux proposés. Merci de rappeler le cabinet."
                    );
                }

                const prompt = getSlotSelectionPrompt(session);
                setPrompt(session, prompt);

                const gather = gatherSpeech(vr, "/twilio/voice");
                gather.say(SAY_OPTS, "Je répète.");

                saySlotsOnNode(gather, session.slots);

                gather.say(SAY_OPTS, prompt);

                return sendTwiml(res, vr, callSid, session);
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

                session.pendingSlot = null;

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
                return sendTwiml(res, vr, callSid, session);
            }

            const choice = pickChoiceFromSpeech(
                speech,
                digits,
                session.slots,
                normalizeText,
                {
                    getSlotWeekdayFR: (start) => getSlotWeekdayFR(start, PARIS_TIMEZONE),
                    getSlotHourMinuteFR: (start) => getSlotHourMinuteFR(start, PARIS_TIMEZONE),
                    getHourInParis: (start) => getHourInParis(start, PARIS_TIMEZONE),
                }
            );
            if (choice === null) {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                if (!a) {
                    session.slots = [];
                    session.pendingSlot = null;
                    session.requestedDateISO = null;

                    sayFr(vr, "Je relance une recherche de disponibilités.");
                    return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_SLOT");
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

                return sendTwiml(res, vr, callSid, session);
            }

            const slot = session.slots?.[choice];

            if (!slot || !slot.calendarId) {
                logWarn("BOOK_SLOT_INVALID_RECOVERY", {
                    callSid,
                    cabinetId,
                    step: session.step,
                    choice,
                    requestedDateISO: session.requestedDateISO || null,
                    slotsAvailable: summarizeSlots(session.slots),
                });

                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");
                session.pendingSlot = null;
                session.slots = [];
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
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
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_ASK_PREFERRED_DATE") {
            const requestedDateISO = parseRequestedDate(speech);

            logInfo("BOOK_REQUESTED_DATE_PARSED", {
                callSid,
                speech,
                requestedDateISO,
                preferredTimeWindow: session.preferredTimeWindow || null,
                preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
                    ? session.preferredHourMinutes
                    : null,
                priorityPreference: session.priorityPreference || null,
            });

            if (!requestedDateISO && hasPreferenceRefinementRequest(speech)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            if (!requestedDateISO) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PREFERRED_DATE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple demain, lundi prochain, ou une date précise."
                );
                return sendTwiml(res, vr, callSid, session);
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

            if (!isLikelyValidPatientName(name)) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_NAME");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me dire votre nom et prénom."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.patientName = name;
            logInfo("PATIENT_NAME_SET", {
                callSid,
                step: session.step,
                patientName: maskName(session.patientName),
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
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "BOOK_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
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

                session.pendingSlot = null;

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
                return sendTwiml(res, vr, callSid, session);
            }

            const choice = pickChoiceFromSpeech(
                speech,
                digits,
                session.slots,
                normalizeText,
                {
                    getSlotWeekdayFR: (start) => getSlotWeekdayFR(start, PARIS_TIMEZONE),
                    getSlotHourMinuteFR: (start) => getSlotHourMinuteFR(start, PARIS_TIMEZONE),
                    getHourInParis: (start) => getHourInParis(start, PARIS_TIMEZONE),
                }
            );
            if (choice === null) {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                if (!a) {
                    session.slots = [];
                    session.pendingSlot = null;
                    session.requestedDateISO = null;

                    sayFr(vr, "Je relance une recherche de disponibilités.");
                    return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_ALT");
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

                return sendTwiml(res, vr, callSid, session);
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
                logWarn("BOOK_ALT_SLOT_INVALID_RECOVERY", {
                    callSid,
                    cabinetId,
                    step: session.step,
                    choice,
                    requestedDateISO: session.requestedDateISO || null,
                    slotsAvailable: summarizeSlots(session.slots),
                });

                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");

                session.pendingSlot = null;
                session.slots = [];
                session.requestedDateISO = null;

                return proposeBookingSlots({ vr, res, session, callSid, cabinet: activeCabinet });
            }

            logInfo("BOOK_ALT_ATTEMPT", {
                callSid,
                cabinetId,
                step: session.step,
                selectedSlot: summarizeSlot(slot),
                patientName: maskName(session.patientName),
                phone: maskPhone(session.phone),
            });

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
                    cabinet: activeCabinet,
                }),
                8000,
                "BOOK_APPOINTMENT_ALT"
            );

            logInfo("BOOK_ALT_RESULT", {
                callSid,
                cabinetId,
                step: session.step,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                selectedSlot: summarizeSlot(slot),
            });

            if (result.ok) {
                incrementMetric(cabinetId, "appointmentsBooked");
                incrementMetric(cabinetId, "successfulCallFlows");
                trackCallHandled(session, cabinetId, incrementMetric);
                trackCallDuration(session, cabinetId, addCallDuration);
                logCallOutcome(callSid, "BOOK_ALT_SUCCESS", session, {
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
                await clearSessionWithLog(callSid, session, "BOOK_ALT_SUCCESS", {
                    eventId: result.event?.id || null,
                    slot: summarizeSlot(slot),
                });
                return sendTwiml(res, vr);
            }

            return endCall(
                vr,
                res,
                callSid,
                session,
                "BOOK_ALT_FAILED",
                "Désolé, je n’arrive pas à confirmer un rendez-vous pour le moment. Merci de rappeler le cabinet.",
                {
                    code: result.code || null,
                    slot: summarizeSlot(slot),
                }
            );
        }

        if (session.step === "MODIFY_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "MODIFY_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            if (!yesNo) {
                session.phoneCandidate = "";
                setStep(session, callSid, "MODIFY_ASK_PHONE", { trigger: "ACTION_MODIFY" });

                promptAndGather(
                    vr,
                    session,
                    "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr, callSid, session);
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
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "MODIFY_FIND_APPT") {
            const found = await withTimeout(
                findNextAppointmentSafe({
                    cabinet: activeCabinet,
                    practitioners: activeCabinet.practitioners,
                    phone: session.phone,
                }),
                8000,
                "FIND_NEXT_APPOINTMENT_MODIFY"
            );

            logInfo("MODIFY_FIND_APPOINTMENT_RESULT", {
                callSid,
                phone: maskPhone(session.phone),
                found: Boolean(found),
                appointment: found
                    ? {
                        eventId: found.eventId || null,
                        calendarId: found.calendarId || null,
                        startISO: found.startISO || null,
                        endISO: found.endISO || null,
                        patientName: maskName(found.patientName || ""),
                        appointmentType: found.appointmentType || null,
                        durationMinutes: found.durationMinutes || null,
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
                return sendTwiml(res, vr, callSid, session);
            }

            session.foundEvent = found;
            session.patientName = found.patientName || session.patientName || "Patient";
            session.appointmentType =
                found.appointmentType === "FIRST" || found.appointmentType === "FOLLOW_UP"
                    ? found.appointmentType
                    : session.appointmentType || "FOLLOW_UP";

            session.appointmentDurationMinutes =
                Number.isFinite(found.durationMinutes) && found.durationMinutes > 0
                    ? found.durationMinutes
                    : session.appointmentDurationMinutes || durations.followUp;

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

            return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_CONFIRM_FOUND");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            const found = session.foundEvent;
            if (!found) {
                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "MODIFY_FOUND_EVENT_LOST",
                    "Je ne retrouve plus votre rendez-vous."
                );
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("MODIFY_BLOCKED_LESS_THAN_24H", {
                    callSid,
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });

                try {
                    await withTimeout(
                        addCallbackNoteToEvent({
                            calendarId: found.calendarId,
                            eventId: found.eventId,
                        }),
                        8000,
                        "ADD_CALLBACK_NOTE"
                    );

                    logInfo("CALLBACK_NOTE_ADDED", {
                        callSid,
                        reason: "MODIFY_LESS_THAN_24H",
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                    });
                } catch (noteErr) {
                    logError("CALLBACK_NOTE_FAILED", {
                        callSid,
                        reason: "MODIFY_LESS_THAN_24H",
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                        message: noteErr?.message,
                    });
                }

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "MODIFY_BLOCKED_LESS_THAN_24H",
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de le modifier automatiquement. Le cabinet vous rappellera.",
                    {
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                        startISO: found.startISO,
                    }
                );
            }

            setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                trigger: "MODIFY_APPOINTMENT_CONFIRMED",
                previousEventId: found.eventId || null,
            });
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "MODIFY_PROPOSE_NEW") {
            session.lastIntentContext = "MODIFY";

            const primaryPractitioners = getSearchPractitioners(session, activeCabinet);

            let usedAnyPractitionerFallback = false;

            let result = await withTimeout(
                suggestTwoSlotsNext7Days({
                    cabinet: activeCabinet,
                    practitioners: primaryPractitioners,
                    durationMinutes: session.appointmentDurationMinutes || undefined,
                    timePreference: session.preferredTimeWindow || undefined,
                    targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                        ? session.preferredHourMinutes
                        : undefined,
                    priorityPreference: session.priorityPreference || undefined,
                }),
                8000,
                "SUGGEST_TWO_SLOTS_NEXT_7_DAYS_MODIFY"
            );

            let slots = Array.isArray(result) ? result : result?.slots || [];
            let proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";

            if (
                (!slots || !slots.length) &&
                session.preferredPractitioner?.calendarId &&
                Array.isArray(activeCabinet.practitioners) &&
                activeCabinet.practitioners.length > 1
            ) {
                usedAnyPractitionerFallback = true;

                logInfo("MODIFY_ANY_PRACTITIONER_FALLBACK", {
                    callSid,
                    cabinetId,
                    preferredPractitioner: session.preferredPractitioner?.name || null,
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                    preferredTimeWindow: session.preferredTimeWindow || null,
                    preferredHourMinutes: Number.isFinite(session.preferredHourMinutes)
                        ? session.preferredHourMinutes
                        : null,
                    priorityPreference: session.priorityPreference || null,
                });

                result = await withTimeout(
                    suggestTwoSlotsNext7Days({
                        cabinet: activeCabinet,
                        practitioners: activeCabinet.practitioners,
                        durationMinutes: session.appointmentDurationMinutes || undefined,
                        timePreference: session.preferredTimeWindow || undefined,
                        targetHourMinutes: Number.isFinite(session.preferredHourMinutes)
                            ? session.preferredHourMinutes
                            : undefined,
                        priorityPreference: session.priorityPreference || undefined,
                    }),
                    8000,
                    "SUGGEST_TWO_SLOTS_NEXT_7_DAYS_MODIFY_ANY_PRACTITIONER"
                );

                slots = Array.isArray(result) ? result : result?.slots || [];
                proposeSpeech = Array.isArray(result) ? "" : result?.speech || "";
            }

            const hydratedSlots = hydrateSlotsWithDefaultPractitioner(slots, activeCabinet);
            session.slots = filterSlotsByTimePreference(
                hydratedSlots,
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

            if (!session.slots.length) {
                logCallOutcome(callSid, "MODIFY_NO_NEW_SLOT_FOUND", session, {
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                }, buildSessionSnapshot);

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "MODIFY_NO_NEW_SLOT_FOUND",
                    "Je n’ai pas trouvé de nouveau créneau disponible pour le moment. Votre rendez-vous actuel reste inchangé. Merci d’appeler le cabinet si besoin.",
                    {
                        oldEventId: session.foundEvent?.eventId || null,
                        oldStartISO: session.foundEvent?.startISO || null,
                    }
                );
            }

            setStep(session, callSid, "MODIFY_PICK_NEW", {
                trigger: "NEW_SLOTS_PROPOSED",
                slotsCount: session.slots.length,
            });

            const prompt = getSlotSelectionPrompt(session);
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");

            gather.say(SAY_OPTS, "Très bien.");

            if (usedAnyPractitionerFallback) {
                gather.say(
                    SAY_OPTS,
                    "Je n'ai pas trouvé de disponibilité rapidement avec le même kiné. Je regarde avec un autre praticien du cabinet."
                );
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
                saySlotsOnNode(gather, session.slots);
            }

            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            if (detectAlternativeRequest(t)) {
                session.pendingSlot = null;
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
                return sendTwiml(res, vr, callSid, session);
            }

            const choice = pickChoiceFromSpeech(
                speech,
                digits,
                session.slots,
                normalizeText,
                {
                    getSlotWeekdayFR: (start) => getSlotWeekdayFR(start, PARIS_TIMEZONE),
                    getSlotHourMinuteFR: (start) => getSlotHourMinuteFR(start, PARIS_TIMEZONE),
                    getHourInParis: (start) => getHourInParis(start, PARIS_TIMEZONE),
                }
            );
            if (choice === null) {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                if (!a) {
                    session.slots = [];
                    session.pendingSlot = null;
                    session.requestedDateISO = null;

                    setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                        trigger: "MODIFY_SLOTS_LOST_RETRY",
                    });
                    setPrompt(session, "");
                    vr.redirect({ method: "POST" }, "/twilio/voice");
                    return sendTwiml(res, vr, callSid, session);
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_PICK_NEW");
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

                return sendTwiml(res, vr, callSid, session);
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
                logWarn("MODIFY_NEW_SLOT_INVALID_RECOVERY", {
                    callSid,
                    cabinetId,
                    step: session.step,
                    choice,
                    speech: process.env.NODE_ENV !== "production" ? speech : maskSpeech(speech),
                    digits,
                    requestedDateISO: session.requestedDateISO || null,
                    slotsAvailable: summarizeSlots(session.slots),
                    oldEventId: session.foundEvent?.eventId || null,
                });

                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");

                session.pendingSlot = null;
                session.slots = [];
                session.requestedDateISO = null;

                setStep(session, callSid, "MODIFY_PROPOSE_NEW", {
                    trigger: "MODIFY_SLOT_INVALID_RETRY",
                });
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr, callSid, session);
            }


            logInfo("MODIFY_BOOK_NEW_ATTEMPT", {
                callSid,
                cabinetId,
                step: session.step,
                patientName: maskName(session.patientName),
                phone: maskPhone(session.phone),
                selectedSlot: summarizeSlot(slot),
                oldEventId: session.foundEvent?.eventId || null,
                oldStartISO: session.foundEvent?.startISO || null,
                appointmentType: session.appointmentType || null,
                appointmentDurationMinutes: session.appointmentDurationMinutes || null,
            });

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
                    cabinet: activeCabinet,
                }),
                8000,
                "BOOK_APPOINTMENT_MODIFY_NEW"
            );

            logInfo("MODIFY_BOOK_NEW_RESULT", {
                callSid,
                cabinetId,
                step: session.step,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                selectedSlot: summarizeSlot(slot),
                oldEventId: session.foundEvent?.eventId || null,
            });

            if (result.ok) {
                const oldEvent = session.foundEvent;

                if (!oldEvent?.eventId || !oldEvent?.calendarId) {
                    logCallOutcome(callSid, "MODIFY_OLD_EVENT_MISSING_AFTER_REBOOK", session, {
                        newEventId: result.event?.id || null,
                        newSlot: summarizeSlot(slot),
                    }, buildSessionSnapshot);

                    sayFr(
                        vr,
                        "Le nouveau rendez-vous est bien réservé, mais une vérification manuelle de l’ancien rendez-vous reste nécessaire. Merci de contacter le cabinet.");
                    sayGoodbye(vr);
                    await clearSessionWithLog(callSid, session, "MODIFY_OLD_EVENT_MISSING_AFTER_REBOOK", {
                        newEventId: result.event?.id || null,
                        newSlot: summarizeSlot(slot),
                    });
                    return sendTwiml(res, vr);
                }

                logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_ATTEMPT", {
                    callSid,
                    eventId: oldEvent.eventId,
                    calendarId: oldEvent.calendarId,
                    startISO: oldEvent.startISO || null,
                    newEventId: result.event?.id || null,
                });

                const cancelOldResult = await withTimeout(
                    cancelAppointmentSafe({
                        calendarId: oldEvent.calendarId,
                        eventId: oldEvent.eventId,
                    }),
                    8000,
                    "CANCEL_OLD_APPOINTMENT_AFTER_REBOOK"
                );

                logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_RESULT", {
                    callSid,
                    ok: cancelOldResult.ok,
                    eventId: oldEvent.eventId,
                    calendarId: oldEvent.calendarId,
                    newEventId: result.event?.id || null,
                });

                if (!cancelOldResult.ok) {
                    logCallOutcome(callSid, "MODIFY_CANCEL_OLD_APPOINTMENT_FAILED_AFTER_REBOOK", session, {
                        oldEventId: oldEvent.eventId,
                        oldCalendarId: oldEvent.calendarId,
                        newEventId: result.event?.id || null,
                        newSlot: summarizeSlot(slot),
                    }, buildSessionSnapshot);

                    sayFr(
                        vr,
                        "Le nouveau rendez-vous est bien réservé, mais je n’ai pas réussi à supprimer automatiquement l’ancien. Merci de contacter rapidement le cabinet."
                    );
                    sayGoodbye(vr);
                    await clearSessionWithLog(callSid, session, "MODIFY_CANCEL_OLD_APPOINTMENT_FAILED_AFTER_REBOOK", {
                        oldEventId: oldEvent.eventId,
                        oldCalendarId: oldEvent.calendarId,
                        newEventId: result.event?.id || null,
                        newSlot: summarizeSlot(slot),
                    });
                    return sendTwiml(res, vr);
                }
                incrementMetric(cabinetId, "appointmentsModified");
                incrementMetric(cabinetId, "successfulCallFlows");
                trackCallHandled(session, cabinetId, incrementMetric);
                trackCallDuration(session, cabinetId, addCallDuration);
                logCallOutcome(callSid, "MODIFY_SUCCESS", session, {
                    oldEventId: session.foundEvent?.eventId || null,
                    oldStartISO: session.foundEvent?.startISO || null,
                    newEventId: result.event?.id || null,
                    newSlot: summarizeSlot(slot),
                }, buildSessionSnapshot);

                sayFr(vr, "C’est modifié et confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""}.`
                );

                await sendSmsWithLogging({
                    sender: sendAppointmentModifiedSMS,
                    payload: {
                        to: session.phone,
                        patientName: session.patientName || "Patient",
                        formattedSlot: formatSlotFR(slot.start),
                        practitionerName: slot.practitionerName || "",
                    },
                    timeoutLabel: "SEND_MODIFY_CONFIRMATION_SMS",
                    logType: "MODIFY_CONFIRMATION",
                    callSid,
                    cabinetId,
                    step: session?.step,
                    to: session.phone,
                });

                sayGoodbye(vr);
                await clearSessionWithLog(callSid, session, "MODIFY_SUCCESS", {
                    oldEventId: session.foundEvent?.eventId || null,
                    newEventId: result.event?.id || null,
                    newSlot: summarizeSlot(slot),
                });
                return sendTwiml(res, vr);
            }

            return endCall(
                vr,
                res,
                callSid,
                session,
                "MODIFY_REBOOK_FAILED",
                "Désolé, je n’arrive pas à confirmer ce nouveau créneau. Merci de rappeler le cabinet.",
                {
                    oldEventId: session.foundEvent?.eventId || null,
                    selectedSlot: summarizeSlot(slot),
                    resultCode: result.code || null,
                }
            );
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
                return sendTwiml(res, vr, callSid, session);
            }

            if (!requestedDateISO) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "MODIFY_ASK_PREFERRED_DATE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain, le 18 mars, ou simplement début de matinée, fin de matinée, début d'après-midi ou fin d'après-midi."
                );
                return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_ASK_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de me redonner votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.phoneCandidate = phone;
            setStep(session, callSid, "CANCEL_CONFIRM_PHONE", {
                trigger: "PHONE_PARSED",
                phone: maskPhone(phone),
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_CONFIRM_PHONE");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            if (!yesNo) {
                session.phoneCandidate = "";
                setStep(session, callSid, "CANCEL_ASK_PHONE", { trigger: "ACTION_CANCEL" });

                promptAndGather(
                    vr,
                    session,
                    "D'accord. Redonnez-moi votre numéro de téléphone chiffre par chiffre."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.phone = session.phoneCandidate;
            session.phoneCandidate = "";
            setStep(session, callSid, "CANCEL_FIND_APPT", {
                trigger: "PHONE_CONFIRMED",
                phone: maskPhone(session.phone),
            });
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "CANCEL_FIND_APPT") {
            const found = await withTimeout(
                findNextAppointmentSafe({
                    cabinet: activeCabinet,
                    practitioners: activeCabinet.practitioners,
                    phone: session.phone,
                }),
                8000,
                "FIND_NEXT_APPOINTMENT_CANCEL"
            );

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
                return sendTwiml(res, vr, callSid, session);
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

            return sendTwiml(res, vr, callSid, session);
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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_CONFIRM_FOUND");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
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
                return sendTwiml(res, vr, callSid, session);
            }

            const found = session.foundEvent;
            if (!found) {
                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "CANCEL_FOUND_EVENT_LOST",
                    "Je ne retrouve plus votre rendez-vous."
                );
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("CANCEL_BLOCKED_LESS_THAN_24H", {
                    callSid,
                    eventId: found.eventId,
                    calendarId: found.calendarId,
                    startISO: found.startISO,
                });
                try {
                    await withTimeout(
                        addCallbackNoteToEvent({
                            calendarId: found.calendarId,
                            eventId: found.eventId,
                        }),
                        8000,
                        "ADD_CALLBACK_NOTE"
                    );

                    logInfo("CALLBACK_NOTE_ADDED", {
                        callSid,
                        reason: "CANCEL_LESS_THAN_24H",
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                    });
                } catch (noteErr) {
                    logError("CALLBACK_NOTE_FAILED", {
                        callSid,
                        reason: "CANCEL_LESS_THAN_24H",
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                        message: noteErr?.message,
                    });
                }

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "CANCEL_BLOCKED_LESS_THAN_24H",
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de l’annuler automatiquement. Le cabinet vous rappellera.",
                    {
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                    }
                );
            }

            logInfo("CANCEL_APPOINTMENT_ATTEMPT", {
                callSid,
                cabinetId,
                step: session.step,
                eventId: found.eventId,
                calendarId: found.calendarId,
                startISO: found.startISO,
            });
            const cancelResult = await withTimeout(
                cancelAppointmentSafe({
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                }),
                8000,
                "CANCEL_APPOINTMENT"
            );

            logInfo("CANCEL_APPOINTMENT_RESULT", {
                callSid,
                cabinetId,
                step: session.step,
                ok: cancelResult.ok,
                eventId: found.eventId,
                calendarId: found.calendarId,
            });

            if (!cancelResult.ok) {
                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "CANCEL_FAILED",
                    "Je n’arrive pas à annuler le rendez-vous pour le moment. Merci de rappeler le cabinet.",
                    {
                        eventId: found.eventId,
                        calendarId: found.calendarId,
                    }
                );
            }

            await sendSmsWithLogging({
                sender: sendAppointmentCancelledSMS,
                payload: {
                    to: session.phone,
                    patientName: session.patientName || "Patient",
                    formattedSlot: formatSlotFR(found.startISO),
                    practitionerName:
                        activeCabinet.practitioners.find((p) => p.calendarId === found.calendarId)?.name || "",
                },
                timeoutLabel: "SEND_CANCEL_CONFIRMATION_SMS",
                logType: "CANCEL_CONFIRMATION",
                callSid,
                cabinetId,
                step: session?.step,
                to: session.phone,
            });
            logCallOutcome(callSid, "CANCEL_SUCCESS", session, {
                cancelledEventId: found.eventId,
                cancelledStartISO: found.startISO,
            }, buildSessionSnapshot);

            incrementMetric(cabinetId, "appointmentsCancelled");
            incrementMetric(cabinetId, "successfulCallFlows");
            trackCallHandled(session, cabinetId, incrementMetric);
            setStep(session, callSid, "CANCEL_ASK_REBOOK", {
                trigger: "CANCEL_SUCCESS",
                cancelledEventId: found.eventId || null,
            });

            const prompt = "Voulez-vous reprendre un rendez-vous ?";
            setPrompt(session, prompt);

            const gather = gatherSpeech(vr, "/twilio/voice");
            gather.say(SAY_OPTS, "Votre rendez-vous est annulé.");
            gather.say(SAY_OPTS, prompt);

            return sendTwiml(res, vr, callSid, session);

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
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "CANCEL_ASK_REBOOK");
                if (retry) return retry;

                promptAndGather(
                    vr,
                    session,
                    "Je n’ai pas bien compris. Merci de répondre simplement par oui ou par non."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            if (yesNo === false) {
                trackCallDuration(session, cabinetId, addCallDuration);

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "CANCEL_COMPLETED_NO_REBOOK",
                    pickVariant(session, "cancel_done_ack", [
                        "Très bien.",
                        "C'est noté.",
                        "Parfait.",
                        "Entendu.",
                    ])
                );
            }

            resetBookingFlowState(session, { keepIdentity: true });
            session.lastIntentContext = "BOOK";
            session.phonePurpose = "BOOK";
            session.initialBookingSpeech = "";
            session.actionAckOverride = "Très bien.";
            setStep(session, callSid, "BOOK_WELCOME", { trigger: "ACTION_BOOK" });
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr, callSid, session);
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
                incrementMetric(cabinetId, "successfulCallFlows");
                trackCallHandled(session, cabinetId, incrementMetric);
                trackCallDuration(session, cabinetId, addCallDuration);

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "INFO_ADDRESS_GIVEN",
                    activeCabinet?.addressSpeech ||
                    "Le cabinet se situe à l'adresse renseignée par le cabinet."
                );
            }

            if (asksHours) {
                incrementMetric(cabinetId, "successfulCallFlows");
                trackCallHandled(session, cabinetId, incrementMetric);
                trackCallDuration(session, cabinetId, addCallDuration);

                return endCall(
                    vr,
                    res,
                    callSid,
                    session,
                    "INFO_HOURS_GIVEN",
                    activeCabinet?.hoursSpeech ||
                    "Le cabinet est ouvert du lundi au vendredi de 8 heures à 12 heures et de 14 heures à 19 heures."
                );
            }

            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "INFO_HANDLE");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Je n’ai pas bien compris. Vous pouvez dire l'adresse ou les horaires d'ouverture."
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

        trackFailedCall(session, cabinetId, incrementMetric);
        trackCallDuration(session, cabinetId, addCallDuration);
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
});

module.exports = router;