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

            // ✅ Nouveaux champs pour gérer les alternatives de dates
            lastProposedStartISO: null,
            requestedDateISO: null,
            lastIntentContext: null, // "BOOK" | "MODIFY"
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
    session.lastProposedStartISO = null;
    session.requestedDateISO = null;
    session.lastIntentContext = null;
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

// =========================
// Helpers date / alternatives
// =========================

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

function toISODateOnly(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
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
        t.includes("autre rendez") ||
        t.includes("un autre rendez") ||
        t.includes("pas disponible") ||
        t.includes("je ne suis pas disponible") ||
        t.includes("je suis pas disponible") ||
        t.includes("je peux pas") ||
        t.includes("je ne peux pas") ||
        t.includes("pas possible") ||
        t.includes("plus tard") ||
        t.includes("plus tot") ||
        t.includes("plus tard dans la semaine") ||
        t.includes("avez vous autre chose") ||
        t.includes("vous avez autre chose") ||
        t.includes("autre chose")
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

    if (raw.includes("demain")) {
        return buildDateAtStartOfDayISO(addDays(today, 1));
    }

    if (raw.includes("apres demain")) {
        return buildDateAtStartOfDayISO(addDays(today, 2));
    }

    // dd/mm ou dd-mm
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

    // "18 mars", "18 avril", etc.
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

    // "lundi", "jeudi prochain"
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

async function lookupSlotsFromDate({ practitioners, fromDateISO }) {
    const result = await suggestTwoSlotsFromDate({
        practitioners,
        fromDate: fromDateISO,
    });

    if (Array.isArray(result)) {
        return { slots: result, speech: "" };
    }

    return {
        slots: result?.slots || [],
        speech: result?.speech || "",
    };
}

function hydrateSlotsWithDefaultPractitioner(slots, cabinet) {
    const defaultCalendarId = cabinet.practitioners[0].calendarId;

    return (slots || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultCalendarId,
        practitionerName: s.practitionerName || cabinet.practitioners[0].name,
    }));
}

function rememberLastProposedSlots(session) {
    session.lastProposedStartISO = session.slots?.[0]?.start || null;
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
    const { slots, speech: proposeSpeech } = await lookupSlotsFromDate({
        practitioners: cabinet.practitioners,
        fromDateISO: requestedDateISO,
    });

    session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
    session.requestedDateISO = requestedDateISO;
    rememberLastProposedSlots(session);

    logInfo("REQUESTED_DATE_SLOTS_RESULT", {
        callSid,
        requestedDateISO,
        count: session.slots.length,
        slots: summarizeSlots(session.slots),
        context: session.lastIntentContext,
    });

    if (!session.slots.length) {
        session.step =
            session.lastIntentContext === "MODIFY"
                ? "MODIFY_ASK_PREFERRED_DATE"
                : "BOOK_ASK_PREFERRED_DATE";

        setPrompt(
            session,
            "Je n’ai pas trouvé de créneau à cette date. Quel autre jour vous conviendrait ?"
        );

        const g = gatherSpeech(vr, "/twilio/voice");
        sayFr(
            g,
            emptyMessage ||
            "Je n’ai pas trouvé de disponibilité à cette date."
        );
        sayFr(g, session.lastPrompt);
        return sendTwiml(res, vr);
    }

    if (intro) sayFr(vr, intro);

    const cleaned = cleanProposeSpeech(proposeSpeech);
    if (cleaned) {
        sayFr(vr, cleaned);
    } else {
        const a = session.slots[0];
        const b = session.slots[1] || session.slots[0];

        sayFr(
            vr,
            `Je vous propose ${formatSlotFR(a.start)}${
                a.practitionerName ? ` avec ${a.practitionerName}` : ""
            }.`
        );

        if (b?.start && b.start !== a.start) {
            sayFr(
                vr,
                `Ou ${formatSlotFR(b.start)}${
                    b.practitionerName ? ` avec ${b.practitionerName}` : ""
                }.`
            );
        }
    }

    session.step = nextStep;
    setPrompt(session, "Vous préférez le premier ou le deuxième ?");

    const g = gatherSpeech(vr, "/twilio/voice");
    sayFr(g, session.lastPrompt);
    return sendTwiml(res, vr);
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
                session.lastIntentContext = "BOOK";
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
            session.lastIntentContext = "BOOK";

            logInfo("BOOKING_SLOTS_LOOKUP_START", {
                callSid,
                practitionersCount: cabinet.practitioners.length,
            });

            const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
                practitioners: cabinet.practitioners,
            });

            session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
            rememberLastProposedSlots(session);

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
                'Vous préférez le premier ou le deuxième ? Vous pouvez aussi dire "un autre jour".'
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

                setPrompt(
                    session,
                    'Vous préférez le premier ou le deuxième ? Vous pouvez aussi dire "un autre jour".'
                );
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            // ✅ Demande d'une autre date / autre jour
            if (detectAlternativeRequest(t)) {
                logInfo("BOOKING_ALTERNATIVE_DATE_REQUESTED", {
                    callSid,
                    speech,
                    previousFirstSlot: session.slots?.[0]?.start || null,
                });

                const requestedDateISO = parseRequestedDate(t);

                if (requestedDateISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet,
                        requestedDateISO,
                        nextStep: "BOOK_PICK_SLOT",
                        intro: "Très bien, je regarde à cette date.",
                        emptyMessage:
                            "Je n’ai pas trouvé de disponibilité à cette date.",
                    });
                }

                session.step = "BOOK_ASK_PREFERRED_DATE";
                setPrompt(session, "Bien sûr. Quel jour vous conviendrait ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            // ✅ Jour / date précise directement dans la réponse
            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);

                logInfo("BOOKING_SPECIFIC_DATE_REQUESTED", {
                    callSid,
                    speech,
                    requestedDateISO,
                });

                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet,
                    requestedDateISO,
                    nextStep: "BOOK_PICK_SLOT",
                    intro: "Très bien, je regarde cette date.",
                    emptyMessage:
                        "Je n’ai pas trouvé de disponibilité à cette date.",
                });
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
                    `Dites "premier" pour ${formatSlotFR(a.start)}${
                        a.practitionerName ? ` avec ${a.practitionerName}` : ""
                    }, "deuxième" pour ${formatSlotFR(b.start)}${
                        b.practitionerName ? ` avec ${b.practitionerName}` : ""
                    }, ou dites "un autre jour".`
                );

                setPrompt(
                    session,
                    'Premier, deuxième, ou "un autre jour" ?'
                );
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

        if (session.step === "BOOK_ASK_PREFERRED_DATE") {
            const t = normalizeText(speech);
            const requestedDateISO = parseRequestedDate(t);

            if (!requestedDateISO) {
                const retry = handleRetry(vr, res, session, callSid, "BOOK_ASK_PREFERRED_DATE");
                if (retry) return retry;

                setPrompt(
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain ou le 18 mars."
                );
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logInfo("BOOKING_PREFERRED_DATE_CAPTURED", {
                callSid,
                speech,
                requestedDateISO,
            });

            return proposeSlotsFromRequestedDate({
                vr,
                res,
                session,
                callSid,
                cabinet,
                requestedDateISO,
                nextStep: "BOOK_PICK_SLOT",
                intro: "Très bien, je regarde.",
                emptyMessage:
                    "Je n’ai pas trouvé de disponibilité à cette date.",
            });
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
                    `${formatSlotFR(slot.start)}${
                        slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
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

            const { slots: altSlots } = await lookupSlotsFromDate({
                practitioners: cabinet.practitioners,
                fromDateISO: slot.start,
            });

            session.slots = hydrateSlotsWithDefaultPractitioner(altSlots, cabinet);
            rememberLastProposedSlots(session);

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
            setPrompt(
                session,
                'Premier ou deuxième ? Vous pouvez aussi dire "un autre jour".'
            );

            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

                if (session.step === "BOOK_PICK_ALT") {
            const t = normalizeText(speech);

            if (detectAlternativeRequest(t)) {
                logInfo("BOOKING_ALT_OTHER_DATE_REQUESTED", {
                    callSid,
                    speech,
                });

                const requestedDateISO = parseRequestedDate(t);

                if (requestedDateISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet,
                        requestedDateISO,
                        nextStep: "BOOK_PICK_ALT",
                        intro: "Très bien, je regarde à cette date.",
                        emptyMessage:
                            "Je n’ai pas trouvé de disponibilité à cette date.",
                    });
                }

                session.step = "BOOK_ASK_PREFERRED_DATE";
                setPrompt(session, "Quel jour vous conviendrait ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);

                logInfo("BOOKING_ALT_SPECIFIC_DATE_REQUESTED", {
                    callSid,
                    speech,
                    requestedDateISO,
                });

                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet,
                    requestedDateISO,
                    nextStep: "BOOK_PICK_ALT",
                    intro: "Très bien, je regarde cette date.",
                    emptyMessage:
                        "Je n’ai pas trouvé de disponibilité à cette date.",
                });
            }

            const choice = pickChoiceFromSpeech(speech, digits);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, "BOOK_PICK_ALT");
                if (retry) return retry;

                setPrompt(
                    session,
                    'Premier, deuxième, ou "un autre jour" ?'
                );
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
                    `${formatSlotFR(slot.start)}${
                        slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
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
            session.lastIntentContext = "MODIFY";
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
            session.lastIntentContext = "MODIFY";

            logInfo("MODIFY_NEW_SLOTS_LOOKUP_START", {
                callSid,
                practitionersCount: cabinet.practitioners.length,
            });

            const { slots, speech: proposeSpeech } = await suggestTwoSlotsNext7Days({
                practitioners: cabinet.practitioners,
            });

            session.slots = hydrateSlotsWithDefaultPractitioner(slots, cabinet);
            rememberLastProposedSlots(session);

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
            setPrompt(
                session,
                'Vous préférez le premier ou le deuxième ? Vous pouvez aussi dire "un autre jour".'
            );

            const g = gatherSpeech(vr, "/twilio/voice");
            sayFr(g, session.lastPrompt);
            return sendTwiml(res, vr);
        }

        if (session.step === "MODIFY_PICK_NEW") {
            const t = normalizeText(speech);

            if (detectAlternativeRequest(t)) {
                logInfo("MODIFY_ALTERNATIVE_DATE_REQUESTED", {
                    callSid,
                    speech,
                });

                const requestedDateISO = parseRequestedDate(t);

                if (requestedDateISO) {
                    return proposeSlotsFromRequestedDate({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet,
                        requestedDateISO,
                        nextStep: "MODIFY_PICK_NEW",
                        intro: "Très bien, je regarde à cette date.",
                        emptyMessage:
                            "Je n’ai pas trouvé de disponibilité à cette date.",
                    });
                }

                session.step = "MODIFY_ASK_PREFERRED_DATE";
                setPrompt(session, "Bien sûr. Quel jour vous conviendrait ?");
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, "Très bien.");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            if (isExplicitDateRequest(t)) {
                const requestedDateISO = parseRequestedDate(t);

                logInfo("MODIFY_SPECIFIC_DATE_REQUESTED", {
                    callSid,
                    speech,
                    requestedDateISO,
                });

                return proposeSlotsFromRequestedDate({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet,
                    requestedDateISO,
                    nextStep: "MODIFY_PICK_NEW",
                    intro: "Très bien, je regarde cette date.",
                    emptyMessage:
                        "Je n’ai pas trouvé de disponibilité à cette date.",
                });
            }

            const choice = pickChoiceFromSpeech(speech, digits);

            if (choice === null) {
                const retry = handleRetry(vr, res, session, callSid, "MODIFY_PICK_NEW");
                if (retry) return retry;

                setPrompt(
                    session,
                    'Premier, deuxième, ou "un autre jour" ?'
                );
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
                    `${formatSlotFR(slot.start)}${
                        slot.practitionerName ? ` avec ${slot.practitionerName}` : ""
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

        if (session.step === "MODIFY_ASK_PREFERRED_DATE") {
            const t = normalizeText(speech);
            const requestedDateISO = parseRequestedDate(t);

            if (!requestedDateISO) {
                const retry = handleRetry(vr, res, session, callSid, "MODIFY_ASK_PREFERRED_DATE");
                if (retry) return retry;

                setPrompt(
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple jeudi, lundi prochain, demain ou le 18 mars."
                );
                const g = gatherSpeech(vr, "/twilio/voice");
                sayFr(g, session.lastPrompt);
                return sendTwiml(res, vr);
            }

            logInfo("MODIFY_PREFERRED_DATE_CAPTURED", {
                callSid,
                speech,
                requestedDateISO,
            });

            return proposeSlotsFromRequestedDate({
                vr,
                res,
                session,
                callSid,
                cabinet,
                requestedDateISO,
                nextStep: "MODIFY_PICK_NEW",
                intro: "Très bien, je regarde.",
                emptyMessage:
                    "Je n’ai pas trouvé de disponibilité à cette date.",
            });
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
            session.lastIntentContext = "BOOK";
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