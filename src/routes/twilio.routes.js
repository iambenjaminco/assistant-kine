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

const {
    sendAppointmentConfirmationSMS,
    sendAppointmentModifiedSMS,
    sendAppointmentCancelledSMS,
} = require("../services/sms");

const { CABINETS } = require("../config/cabinets");
const { PHRASES } = require("../../phrases.js");

const router = express.Router();

// ⚠️ Session en mémoire (dev). Prod => Redis/DB
const sessions = new Map();

// ✅ Voix FR configurable
// Test avec Google Wavenet, souvent plus fiable que Polly sur <Say>
const SAY_OPTS = {
    language: "fr-FR",
    voice: "Google.fr-FR-Wavenet-A",
};

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

function getSession(callSid) {
    if (!sessions.has(callSid)) {
        sessions.set(callSid, {
            step: "ACTION",
            slots: [],
            patientName: "",
            phone: "",
            pendingSlot: null,
            foundEvent: null, // { calendarId, eventId, startISO, summary, patientName? }
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

function resetRetry(session) {
    session.retryCount = 0;
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

function logInfo(event, data = {}) {
    console.log(`[TWILIO][${event}]`, data);
}

function logWarn(event, data = {}) {
    console.warn(`[TWILIO][${event}]`, data);
}

function logError(event, data = {}) {
    console.error(`[TWILIO][${event}]`, data);
}

function sendTwiml(res, vr) {
    const xml = vr.toString();
    console.log("[TWILIO][TWIML_XML]", xml);
    return res.type("text/xml").send(xml);
}

function handleRetry(vr, res, session, callSid, reason = "UNKNOWN") {
    session.retryCount = (session.retryCount || 0) + 1;

    logWarn("MISUNDERSTOOD_RETRY", {
        callSid,
        step: session.step,
        retryCount: session.retryCount,
        reason,
    });

    if (session.retryCount >= 2) {
        logWarn("CALL_ENDED_MISUNDERSTOOD", {
            callSid,
            step: session.step,
            reason,
        });
        sayFr(vr, "Je n’arrive pas à comprendre votre réponse.");
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
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

    logInfo("VOICE_WEBHOOK", {
        callSid,
        step: session.step,
        speech,
        digits,
        hasInput: Boolean(speech || digits),
    });

    const cabinet = getCabinetOrFail(vr);
    if (!cabinet) {
        logError("CABINET_CONFIG_INVALID", { callSid });
        clearSession(callSid);
        return sendTwiml(res, vr);
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
        logInfo("RETURN_TO_MAIN_MENU", {
            callSid,
            previousStep: session.step,
            speech,
        });

        resetToMenu(session);
        setPrompt(
            session,
            PHRASES.askAction ||
            "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
        );

        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Très bien, retour au menu principal.");
        sayFr(g, session.lastPrompt);
        return sendTwiml(res, vr);
    }

    if (!hasInput && session.lastPrompt) {
        if (session.skipSilenceOnce) {
            session.skipSilenceOnce = false;
            logInfo("SKIP_SILENCE_ONCE", {
                callSid,
                step: session.step,
            });
        } else {
            if (typeof session.noInputCount !== "number") session.noInputCount = 0;
            session.noInputCount += 1;

            logWarn("NO_INPUT", {
                callSid,
                step: session.step,
                noInputCount: session.noInputCount,
                lastPrompt: session.lastPrompt,
            });

            if (session.noInputCount === 1) {
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Vous êtes toujours là ?");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logWarn("CALL_ENDED_NO_INPUT", {
                callSid,
                step: session.step,
                noInputCount: session.noInputCount,
            });

            sayFr(vr, "Je n’ai pas eu de réponse.");
            sayGoodbye(vr);
            clearSession(callSid);
            return sendTwiml(res, vr);
        }
    }

    if (hasInput) {
        session.noInputCount = 0;
        resetRetry(session);
    }

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

                logInfo("CALL_STARTED", {
                    callSid,
                    step: session.step,
                    voice: SAY_OPTS.voice,
                    language: SAY_OPTS.language,
                });

                sayFr(
                    vr,
                    PHRASES.greeting ||
                    "Bonjour, vous êtes bien au cabinet de kinésithérapie."
                );

                session.noInputCount = 0;
                session.skipSilenceOnce = true;
                session.step = "ACTION_LISTEN";

                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
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
                logInfo("INTENT_DETECTED", {
                    callSid,
                    step: session.step,
                    intent: "MODIFY",
                    speech,
                });

                session.step = "MODIFY_ASK_PHONE";
                setPrompt(session, "Quel est votre numéro de téléphone ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            if (wantsCancel) {
                logInfo("INTENT_DETECTED", {
                    callSid,
                    step: session.step,
                    intent: "CANCEL",
                    speech,
                });

                session.step = "CANCEL_ASK_PHONE";
                setPrompt(session, "Quel est votre numéro de téléphone ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "D’accord.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            if (wantsBook) {
                logInfo("INTENT_DETECTED", {
                    callSid,
                    step: session.step,
                    intent: "BOOK",
                    speech,
                });

                session.step = "BOOK_WELCOME";
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            logWarn("INTENT_NOT_UNDERSTOOD", {
                callSid,
                step: session.step,
                speech,
            });

            setPrompt(
                session,
                PHRASES.askAction ||
                "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
            );
            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, "Désolé, je n’ai pas compris.");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "ACTION_LISTEN") {
            setPrompt(
                session,
                PHRASES.askAction ||
                "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
            );

            logInfo("ACTION_MENU_PROMPTED", {
                callSid,
                step: session.step,
                prompt: session.lastPrompt,
            });

            sayFr(vr, session.lastPrompt);

            session.noInputCount = 0;
            session.skipSilenceOnce = true;
            session.step = "ACTION_WAIT";

            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "ACTION_WAIT") {
            session.step = "ACTION";
            session.noInputCount = 0;

            logInfo("ACTION_MENU_LISTENING", {
                callSid,
                step: session.step,
            });

            gatherSpeech(vr, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        // =========================
        // A) PRENDRE RDV
        // =========================
        if (session.step === "BOOK_WELCOME") {
            logInfo("BOOKING_SLOTS_LOOKUP_START", {
                callSid,
                practitionersCount: cabinet.practitioners.length,
            });

            const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
                practitioners: cabinet.practitioners,
            });

            const defaultCalendarId = cabinet.practitioners[0].calendarId;

            session.slots = (slots || []).map((s) => ({
                ...s,
                calendarId: s.calendarId || defaultCalendarId,
                practitionerName: s.practitionerName || cabinet.practitioners[0].name,
            }));

            logInfo("BOOKING_SLOTS_LOOKUP_RESULT", {
                callSid,
                count: session.slots.length,
                slots: summarizeSlots(session.slots),
            });

            if (!session.slots.length) {
                const msg =
                    cleanProposeSpeech(proposeSpeech) ||
                    PHRASES.noAvailability ||
                    "Je n’ai pas de créneau disponible dans les prochains jours.";

                logWarn("BOOKING_NO_AVAILABILITY", {
                    callSid,
                    practitionersCount: cabinet.practitioners.length,
                });

                sayFr(vr, msg);
                logInfo("CALL_ENDED_NO_AVAILABILITY", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
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
            return sendTwiml(res, vr);
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

                logInfo("BOOKING_SLOT_REPEAT_REQUESTED", {
                    callSid,
                    speech,
                    slots: summarizeSlots([a, b]),
                });

                if (!a) {
                    logError("BOOKING_REPEAT_NO_SLOTS_FOUND", {
                        callSid,
                        speech,
                    });

                    sayFr(
                        vr,
                        "Je ne retrouve plus les créneaux proposés. Merci de rappeler le cabinet."
                    );
                    logInfo("CALL_ENDED_MISSING_SLOTS", { callSid });
                    sayGoodbye(vr);
                    clearSession(callSid);
                    return sendTwiml(res, vr);
                }

                sayFr(vr, "Je répète.");
                sayFr(
                    vr,
                    `Premier créneau : ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
                    }.`
                );
                sayFr(
                    vr,
                    `Deuxième créneau : ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""
                    }.`
                );

                setPrompt(session, "Vous préférez le premier ou le deuxième ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const choice = pickChoiceFromSpeech(speech, digits);

            if (choice === null) {
                const a = session.slots?.[0];
                const b = session.slots?.[1] || session.slots?.[0];

                logWarn("BOOKING_SLOT_SELECTION_FAILED", {
                    callSid,
                    speech,
                    digits,
                    slots: summarizeSlots([a, b]),
                });

                if (!a) {
                    logWarn("BOOKING_RESTART_NO_SLOTS_IN_SESSION", {
                        callSid,
                    });

                    session.step = "BOOK_WELCOME";
                    setPrompt(session, "");
                    sayFr(vr, "On recommence.");
                    vr.redirect({ method: "POST" }, "/twilio/voice");
                    return sendTwiml(res, vr);
                }

                sayFr(vr, "Je n’ai pas compris.");
                sayFr(
                    vr,
                    `Dites "premier" pour ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
                    }, ou "deuxième" pour ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""
                    }.`
                );

                setPrompt(session, "Premier ou deuxième ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            logInfo("BOOKING_SLOT_SELECTED", {
                callSid,
                choice,
                slot: summarizeSlot(slot),
            });

            if (!slot || !slot.calendarId) {
                logWarn("BOOKING_SELECTED_SLOT_INVALID", {
                    callSid,
                    choice,
                    slot: summarizeSlot(slot),
                });

                sayFr(
                    vr,
                    "Ce créneau vient d’être pris. Je regarde d’autres disponibilités."
                );

                session.step = "BOOK_WELCOME";
                setPrompt(session, "");
                vr.redirect({ method: "POST" }, "/twilio/voice");
                return sendTwiml(res, vr);
            }

            session.pendingSlot = slot;
            session.step = "BOOK_ASK_NAME";

            setPrompt(session, "Quel est votre nom et prénom ?");
            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, "Très bien.");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_NAME") {
            const name = (speech || "").trim();

            if (!name) {
                logWarn("PATIENT_NAME_NOT_UNDERSTOOD", {
                    callSid,
                    speech,
                });

                setPrompt(session, "Quel est votre nom et prénom ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            session.patientName = name;

            logInfo("PATIENT_NAME_CAPTURED", {
                callSid,
                patientName: session.patientName,
            });

            session.step = "BOOK_ASK_PHONE";

            setPrompt(session, "Quel est votre numéro de téléphone ?");
            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, "Merci.");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                logWarn("PHONE_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                    digits,
                });

                setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            session.phone = phone;

            logInfo("PHONE_CAPTURED", {
                callSid,
                phone: maskPhone(session.phone),
            });

            const slot = session.pendingSlot;
            session.pendingSlot = null;

            if (!slot || !slot.calendarId) {
                logError("BOOKING_PENDING_SLOT_MISSING", {
                    callSid,
                    patientName: session.patientName,
                    phone: maskPhone(session.phone),
                });

                sayFr(vr, "Je ne retrouve plus le créneau sélectionné.");
                logInfo("CALL_ENDED_MISSING_PENDING_SLOT", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logInfo("BOOKING_ATTEMPT", {
                callSid,
                calendarId: slot.calendarId,
                patientName: session.patientName,
                phone: maskPhone(session.phone),
                slot: summarizeSlot(slot),
            });

            const result = await bookAppointmentSafe({
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                reason: "Rendez-vous kiné",
                startDate: slot.start,
                endDate: slot.end,
                phone: session.phone || "",
            });

            logInfo("BOOKING_RESULT", {
                callSid,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                slot: summarizeSlot(slot),
            });

            if (result.ok) {
                sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
                    }.`
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

                logInfo("CALL_ENDED_BOOKING_CONFIRMED", {
                    callSid,
                    patientName: session.patientName,
                    phone: maskPhone(session.phone),
                    slot: summarizeSlot(slot),
                });

                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
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

            logInfo("BOOKING_ALT_SLOTS_PROPOSED", {
                callSid,
                previousSlot: summarizeSlot(slot),
                resultCode: result.code || null,
                count: session.slots.length,
                slots: summarizeSlots(session.slots),
            });

            if (!session.slots?.length) {
                sayFr(
                    vr,
                    `${statusMsg} Je n’ai pas d’autre créneau disponible rapidement. Merci de rappeler le cabinet.`
                );
                logInfo("CALL_ENDED_NO_ALT_SLOTS", {
                    callSid,
                    previousSlot: summarizeSlot(slot),
                    resultCode: result.code || null,
                });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            const a = session.slots[0];
            const b = session.slots[1] || session.slots[0];

            sayFr(vr, statusMsg);
            sayFr(
                vr,
                `Premier : ${formatSlotFR(a.start)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
                }.`
            );
            sayFr(
                vr,
                `Deuxième : ${formatSlotFR(b.start)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""
                }.`
            );

            session.step = "BOOK_PICK_ALT";
            setPrompt(session, "Premier ou deuxième ?");

            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "BOOK_PICK_ALT") {
            const choice = pickChoiceFromSpeech(speech, digits);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, "BOOK_PICK_ALT");
                if (retry) return retry;

                setPrompt(session, "Premier ou deuxième ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            logInfo("BOOKING_ALT_SLOT_SELECTED", {
                callSid,
                choice,
                slot: summarizeSlot(slot),
            });

            if (!slot || !slot.calendarId) {
                logWarn("BOOKING_ALT_SLOT_INVALID", {
                    callSid,
                    choice,
                    slot: summarizeSlot(slot),
                });

                sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
                logInfo("CALL_ENDED_ALT_SLOT_INVALID", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logInfo("BOOKING_ALT_ATTEMPT", {
                callSid,
                calendarId: slot.calendarId,
                patientName: session.patientName,
                phone: maskPhone(session.phone),
                slot: summarizeSlot(slot),
            });

            const result = await bookAppointmentSafe({
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                reason: "Rendez-vous kiné",
                startDate: slot.start,
                endDate: slot.end,
                phone: session.phone || "",
            });

            logInfo("BOOKING_ALT_RESULT", {
                callSid,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                slot: summarizeSlot(slot),
            });

            if (result.ok) {
                sayFr(vr, PHRASES.confirmed || "C’est confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
                    }.`
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

                logInfo("CALL_ENDED_ALT_BOOKING_CONFIRMED", {
                    callSid,
                    patientName: session.patientName,
                    phone: maskPhone(session.phone),
                    slot: summarizeSlot(slot),
                });

                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logError("BOOKING_ALT_UNCONFIRMED", {
                callSid,
                code: result.code || null,
                slot: summarizeSlot(slot),
            });

            sayFr(
                vr,
                "Désolé, je n’arrive pas à confirmer un rendez-vous pour le moment. Merci de rappeler le cabinet."
            );
            logInfo("CALL_ENDED_ALT_BOOKING_FAILED", { callSid });
            sayGoodbye(vr);
            clearSession(callSid);
            return sendTwiml(res, vr);
        }

        // =========================
        // B) MODIFIER RDV
        // =========================
        if (session.step === "MODIFY_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                logWarn("PHONE_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                    digits,
                });

                setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            session.phone = phone;

            logInfo("MODIFY_PHONE_CAPTURED", {
                callSid,
                phone: maskPhone(session.phone),
            });

            session.step = "MODIFY_FIND_APPT";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_FIND_APPT") {
            logInfo("APPOINTMENT_LOOKUP_START", {
                callSid,
                mode: "MODIFY",
                phone: maskPhone(session.phone),
            });

            const found = await findNextAppointmentSafe({
                practitioners: cabinet.practitioners,
                phone: session.phone,
            });

            if (!found) {
                logWarn("APPOINTMENT_NOT_FOUND", {
                    callSid,
                    mode: "MODIFY",
                    phone: maskPhone(session.phone),
                });

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
                return sendTwiml(res, vr);
            }

            session.foundEvent = found;
            session.patientName = found.patientName || session.patientName || "Patient";

            logInfo("APPOINTMENT_FOUND", {
                callSid,
                mode: "MODIFY",
                phone: maskPhone(session.phone),
                appointment: {
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                    startISO: found.startISO,
                    formattedStart: formatSlotFR(found.startISO),
                    patientName: found.patientName || null,
                    summary: found.summary || "",
                },
            });

            session.step = "MODIFY_CONFIRM_FOUND";

            setPrompt(session, "Est-ce bien votre rendez-vous ?");
            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_CONFIRM_FOUND") {
            const t = normalizeText(speech);
            const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
            const no = t.includes("non") || t.includes("no");

            if (!yes && !no) {
                logWarn("YES_NO_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                });

                setPrompt(session, "Est-ce bien votre rendez-vous ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logInfo("APPOINTMENT_CONFIRMATION_RESPONSE", {
                callSid,
                mode: "MODIFY",
                response: yes ? "YES" : "NO",
                speech,
            });

            if (no) {
                session.phone = "";
                session.foundEvent = null;
                session.step = "MODIFY_ASK_PHONE";
                setPrompt(session, "Quel est votre numéro de téléphone ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien, redonnez-moi votre numéro pour vérification.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const found = session.foundEvent;
            if (!found) {
                logError("MODIFY_FOUND_EVENT_MISSING", {
                    callSid,
                });

                sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
                logInfo("CALL_ENDED_MODIFY_MISSING_EVENT", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("MODIFY_BLOCKED_LT24H", {
                    callSid,
                    appointmentStart: found.startISO,
                    formattedStart: formatSlotFR(found.startISO),
                });

                await addCallbackNoteToEvent({
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                });

                sayFr(
                    vr,
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de le modifier automatiquement. Le cabinet vous rappellera."
                );

                logInfo("CALL_ENDED_MODIFY_LT24H", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_START", {
                callSid,
                calendarId: found.calendarId,
                eventId: found.eventId,
                appointmentStart: found.startISO,
            });

            await cancelAppointmentSafe({
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

            logInfo("MODIFY_CANCEL_OLD_APPOINTMENT_SUCCESS", {
                callSid,
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

            session.step = "MODIFY_PROPOSE_NEW";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_PROPOSE_NEW") {
            logInfo("MODIFY_NEW_SLOTS_LOOKUP_START", {
                callSid,
                practitionersCount: cabinet.practitioners.length,
            });

            const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
                practitioners: cabinet.practitioners,
            });

            const defaultCalendarId = cabinet.practitioners[0].calendarId;
            session.slots = (slots || []).map((s) => ({
                ...s,
                calendarId: s.calendarId || defaultCalendarId,
                practitionerName: s.practitionerName || cabinet.practitioners[0].name,
            }));

            logInfo("MODIFY_NEW_SLOTS_LOOKUP_RESULT", {
                callSid,
                count: session.slots.length,
                slots: summarizeSlots(session.slots),
            });

            if (!session.slots.length) {
                sayFr(
                    vr,
                    "J’ai bien annulé votre rendez-vous, mais je n’ai pas de nouveau créneau disponible. Merci d’appeler le cabinet."
                );
                logWarn("MODIFY_NO_NEW_SLOTS_AFTER_CANCEL", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            sayFr(vr, "D’accord. Je vous propose deux nouveaux créneaux.");
            const cleaned = cleanProposeSpeech(proposeSpeech);
            if (cleaned) sayFr(vr, cleaned);

            session.step = "MODIFY_PICK_NEW";
            setPrompt(session, "Vous préférez le premier ou le deuxième ?");

            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_PICK_NEW") {
            const choice = pickChoiceFromSpeech(speech, digits);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, "MODIFY_PICK_NEW");
                if (retry) return retry;

                setPrompt(session, "Premier ou deuxième ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const slot = session.slots?.[choice];

            logInfo("MODIFY_NEW_SLOT_SELECTED", {
                callSid,
                choice,
                slot: summarizeSlot(slot),
            });

            if (!slot || !slot.calendarId) {
                logWarn("MODIFY_NEW_SLOT_INVALID", {
                    callSid,
                    choice,
                    slot: summarizeSlot(slot),
                });

                sayFr(vr, "Ce créneau n’est plus disponible pour le moment.");
                logInfo("CALL_ENDED_MODIFY_INVALID_SLOT", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logInfo("MODIFY_BOOKING_ATTEMPT", {
                callSid,
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                phone: maskPhone(session.phone),
                slot: summarizeSlot(slot),
            });

            const result = await bookAppointmentSafe({
                calendarId: slot.calendarId,
                patientName: session.patientName || "Patient",
                reason: "Rendez-vous kiné",
                startDate: slot.start,
                endDate: slot.end,
                phone: session.phone || "",
            });

            logInfo("MODIFY_BOOKING_RESULT", {
                callSid,
                ok: result.ok,
                code: result.code || null,
                eventId: result.event?.id || null,
                slot: summarizeSlot(slot),
            });

            if (result.ok) {
                sayFr(vr, "C’est modifié et confirmé.");
                sayFr(
                    vr,
                    `${formatSlotFR(slot.start)}${slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
                    }.`
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

                logInfo("CALL_ENDED_MODIFY_CONFIRMED", {
                    callSid,
                    patientName: session.patientName,
                    phone: maskPhone(session.phone),
                    slot: summarizeSlot(slot),
                });

                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logError("MODIFY_BOOKING_FAILED", {
                callSid,
                code: result.code || null,
                slot: summarizeSlot(slot),
            });

            sayFr(
                vr,
                "Désolé, je n’arrive pas à confirmer ce nouveau créneau. Merci de rappeler le cabinet."
            );
            logInfo("CALL_ENDED_MODIFY_BOOKING_FAILED", { callSid });
            sayGoodbye(vr);
            clearSession(callSid);
            return sendTwiml(res, vr);
        }

        // =========================
        // C) ANNULER RDV
        // =========================
        if (session.step === "CANCEL_ASK_PHONE") {
            const phone = parsePhone(speech, digits);

            if (!phone) {
                logWarn("PHONE_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                    digits,
                });

                setPrompt(session, "Dites votre numéro de téléphone, chiffre par chiffre.");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            session.phone = phone;

            logInfo("CANCEL_PHONE_CAPTURED", {
                callSid,
                phone: maskPhone(session.phone),
            });

            session.step = "CANCEL_FIND_APPT";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_FIND_APPT") {
            logInfo("APPOINTMENT_LOOKUP_START", {
                callSid,
                mode: "CANCEL",
                phone: maskPhone(session.phone),
            });

            const found = await findNextAppointmentSafe({
                practitioners: cabinet.practitioners,
                phone: session.phone,
            });

            if (!found) {
                logWarn("APPOINTMENT_NOT_FOUND", {
                    callSid,
                    mode: "CANCEL",
                    phone: maskPhone(session.phone),
                });

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
                return sendTwiml(res, vr);
            }

            session.foundEvent = found;
            session.patientName = found.patientName || session.patientName || "Patient";

            logInfo("APPOINTMENT_FOUND", {
                callSid,
                mode: "CANCEL",
                phone: maskPhone(session.phone),
                appointment: {
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                    startISO: found.startISO,
                    formattedStart: formatSlotFR(found.startISO),
                    patientName: found.patientName || null,
                    summary: found.summary || "",
                },
            });

            session.step = "CANCEL_CONFIRM_FOUND";

            setPrompt(session, "Est-ce bien votre rendez-vous ?");
            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_CONFIRM_FOUND") {
            const t = normalizeText(speech);
            const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
            const no = t.includes("non") || t.includes("no");

            if (!yes && !no) {
                logWarn("YES_NO_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                });

                setPrompt(session, "Est-ce bien votre rendez-vous ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logInfo("APPOINTMENT_CONFIRMATION_RESPONSE", {
                callSid,
                mode: "CANCEL",
                response: yes ? "YES" : "NO",
                speech,
            });

            if (no) {
                session.phone = "";
                session.foundEvent = null;
                session.step = "CANCEL_ASK_PHONE";
                setPrompt(session, "Quel est votre numéro de téléphone ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien, redonnez-moi votre numéro pour vérification.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            const found = session.foundEvent;
            if (!found) {
                logError("CANCEL_FOUND_EVENT_MISSING", {
                    callSid,
                });

                sayFr(vr, "Je ne retrouve plus votre rendez-vous.");
                logInfo("CALL_ENDED_CANCEL_MISSING_EVENT", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            if (isLessThan24h(found.startISO)) {
                logWarn("CANCEL_BLOCKED_LT24H", {
                    callSid,
                    appointmentStart: found.startISO,
                    formattedStart: formatSlotFR(found.startISO),
                });

                await addCallbackNoteToEvent({
                    calendarId: found.calendarId,
                    eventId: found.eventId,
                });

                sayFr(
                    vr,
                    "Votre rendez-vous est dans moins de vingt-quatre heures. Il n’est pas possible de l’annuler automatiquement. Le cabinet vous rappellera."
                );

                logInfo("CALL_ENDED_CANCEL_LT24H", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            logInfo("CANCEL_APPOINTMENT_START", {
                callSid,
                calendarId: found.calendarId,
                eventId: found.eventId,
                appointmentStart: found.startISO,
            });

            await cancelAppointmentSafe({
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

            logInfo("CANCEL_APPOINTMENT_SUCCESS", {
                callSid,
                calendarId: found.calendarId,
                eventId: found.eventId,
            });

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

            session.step = "CANCEL_ASK_REBOOK";
            setPrompt(session, "Voulez-vous reprendre un rendez-vous ?");

            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, "Votre rendez-vous est annulé.");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "CANCEL_ASK_REBOOK") {
            const t = normalizeText(speech);
            const yes = t.includes("oui") || t.includes("ouais") || t.includes("yes");
            const no = t.includes("non") || t.includes("no");

            if (!yes && !no) {
                logWarn("YES_NO_NOT_UNDERSTOOD", {
                    callSid,
                    step: session.step,
                    speech,
                });

                setPrompt(session, "Voulez-vous reprendre un rendez-vous ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Je n’ai pas compris.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logInfo("REBOOK_RESPONSE", {
                callSid,
                response: yes ? "YES" : "NO",
                speech,
            });

            if (no) {
                sayFr(vr, "Très bien.");
                logInfo("CALL_ENDED_AFTER_CANCEL_NO_REBOOK", { callSid });
                sayGoodbye(vr);
                clearSession(callSid);
                return sendTwiml(res, vr);
            }

            session.step = "BOOK_WELCOME";
            setPrompt(session, "");
            vr.redirect({ method: "POST" }, "/twilio/voice");
            return sendTwiml(res, vr);
        }

        // =========================
        // Fallback
        // =========================
        const retry = handleRetry(vr, res, session, callSid, "FALLBACK");
        if (retry) return retry;

        logWarn("FALLBACK_NOT_UNDERSTOOD", {
            callSid,
            step: session.step,
            speech,
            digits,
        });

        setPrompt(
            session,
            PHRASES.askAction ||
            "Voulez-vous prendre, modifier ou annuler un rendez-vous ?"
        );
        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(g, "Je n’ai pas compris.");
        sayFr(g, session.lastPrompt);
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

        sayFr(
            vr,
            PHRASES.errorGeneric ||
            "Une erreur est survenue. Veuillez réessayer plus tard."
        );
        sayGoodbye(vr);
        clearSession(callSid);
        return sendTwiml(res, vr);
    }
});

module.exports = router;