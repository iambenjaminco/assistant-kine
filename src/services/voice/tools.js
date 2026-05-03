// src/services/voice/tools.js
//
// Définit les tools que l'agent vocal Vapi peut appeler.
// - toolDefinitions : à passer dans la config Vapi de l'assistant
// - executeTool      : dispatcher appelé par le webhook /vapi/tools
//
// Architecture : le LLM (côté Vapi) gère la conversation. Quand il a besoin
// d'agir (chercher un créneau, booker, annuler, transférer), il appelle un
// de ces tools. Le tool exécute la logique métier (calendar, sms) et renvoie
// un résultat au LLM, qui formule la réponse au patient.

const {
    suggestTwoSlotsNext7Days,
    suggestTwoSlotsFromDate,
    bookAppointmentSafe,
    findNextAppointmentSafe,
    cancelAppointmentSafe,
    addCallbackNoteToEvent,
    formatSlotFR,
} = require("../calendar");

const {
    sendAppointmentConfirmationSMS,
    sendAppointmentModifiedSMS,
    sendAppointmentCancelledSMS,
} = require("../sms");

const { getCabinet } = require("../cabinetsStore");
const { isLessThan24h, parsePhone } = require("./parsers");

// =====================================================================
// SLOT ID encoding/decoding
// Pour empêcher le LLM d'inventer un créneau (hallucination), search_slots
// renvoie des slotId opaques. book_appointment exige un slotId valide,
// pas une date inventée.
// =====================================================================

function encodeSlotId({ calendarId, start, end, practitionerName }) {
    const payload = JSON.stringify({
        calendarId,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        practitionerName: practitionerName || null,
    });
    return Buffer.from(payload).toString("base64url");
}

function decodeSlotId(slotId) {
    try {
        const payload = JSON.parse(
            Buffer.from(String(slotId), "base64url").toString("utf8")
        );
        if (!payload?.calendarId || !payload?.start || !payload?.end) {
            return null;
        }
        return payload;
    } catch (_err) {
        return null;
    }
}

// =====================================================================
// DEFINITIONS - format Vapi (compatible OpenAI function calling)
// =====================================================================

const toolDefinitions = [
    {
        type: "function",
        function: {
            name: "search_available_slots",
            description:
                "Cherche jusqu'à 2 créneaux disponibles pour un rendez-vous. " +
                "À utiliser quand le patient veut prendre RDV ou modifier un RDV. " +
                "Retourne une liste de créneaux avec un slotId opaque que tu DOIS " +
                "réutiliser tel quel pour book_appointment. N'invente JAMAIS de date.",
            parameters: {
                type: "object",
                properties: {
                    fromDate: {
                        type: "string",
                        description:
                            "Date à partir de laquelle chercher au format AAAA-MM-JJ. " +
                            "Si le patient ne précise pas, laisse vide (= dans les 7 prochains jours).",
                    },
                    appointmentType: {
                        type: "string",
                        enum: ["FIRST", "FOLLOW_UP"],
                        description:
                            "FIRST = première consultation (durée plus longue), " +
                            "FOLLOW_UP = suivi (durée standard). Demande au patient si besoin.",
                    },
                    practitionerName: {
                        type: "string",
                        description:
                            "Nom du praticien souhaité par le patient. " +
                            "Laisse vide si le patient n'a pas de préférence.",
                    },
                    timePreference: {
                        type: "string",
                        enum: [
                            "EARLY_MORNING",
                            "LATE_MORNING",
                            "MORNING",
                            "EARLY_AFTERNOON",
                            "LATE_AFTERNOON",
                            "AFTERNOON",
                            "EVENING",
                        ],
                        description:
                            "Plage horaire souhaitée si le patient en exprime une.",
                    },
                    targetHourMinutes: {
                        type: "integer",
                        description:
                            "Heure exacte demandée en minutes depuis minuit (ex: 14h30 = 870). " +
                            "À utiliser SEULEMENT si le patient donne une heure précise.",
                    },
                    priorityPreference: {
                        type: "string",
                        enum: ["EARLIEST", "LATEST", "FLEXIBLE"],
                        description:
                            "EARLIEST = au plus tôt, LATEST = au plus tard, FLEXIBLE = peu importe.",
                    },
                },
                required: [],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "book_appointment",
            description:
                "Réserve un créneau précédemment proposé par search_available_slots. " +
                "Envoie automatiquement un SMS de confirmation. " +
                "À appeler UNIQUEMENT après que le patient a confirmé son choix de créneau " +
                "ET que tu as collecté son nom et numéro de téléphone.",
            parameters: {
                type: "object",
                properties: {
                    slotId: {
                        type: "string",
                        description:
                            "Le slotId EXACT renvoyé par search_available_slots. " +
                            "Ne le modifie jamais.",
                    },
                    patientName: {
                        type: "string",
                        description: "Nom et prénom du patient (ex: 'Marie Dupont').",
                    },
                    patientPhone: {
                        type: "string",
                        description:
                            "Numéro de téléphone du patient en format français à 10 chiffres " +
                            "(ex: '0612345678').",
                    },
                    appointmentType: {
                        type: "string",
                        enum: ["FIRST", "FOLLOW_UP"],
                        description: "FIRST ou FOLLOW_UP, le même que pour search_available_slots.",
                    },
                },
                required: ["slotId", "patientName", "patientPhone", "appointmentType"],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "find_patient_appointment",
            description:
                "Trouve le prochain rendez-vous d'un patient à partir de son numéro de téléphone. " +
                "À utiliser quand le patient veut modifier ou annuler un RDV.",
            parameters: {
                type: "object",
                properties: {
                    patientPhone: {
                        type: "string",
                        description: "Numéro de téléphone du patient (10 chiffres).",
                    },
                },
                required: ["patientPhone"],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "cancel_appointment",
            description:
                "Annule un rendez-vous trouvé par find_patient_appointment. " +
                "Envoie automatiquement un SMS d'annulation. " +
                "Si le RDV est dans moins de 24h, ajoute une note 'rappeler le patient' " +
                "à la place de l'annulation (utiliser request_callback).",
            parameters: {
                type: "object",
                properties: {
                    eventRef: {
                        type: "string",
                        description:
                            "La référence eventRef renvoyée par find_patient_appointment.",
                    },
                },
                required: ["eventRef"],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "modify_appointment",
            description:
                "Modifie un rendez-vous existant : annule l'ancien et en crée un nouveau. " +
                "Envoie un SMS de modification. " +
                "À utiliser après find_patient_appointment + search_available_slots " +
                "+ choix d'un nouveau créneau par le patient.",
            parameters: {
                type: "object",
                properties: {
                    oldEventRef: {
                        type: "string",
                        description: "eventRef du RDV à remplacer.",
                    },
                    newSlotId: {
                        type: "string",
                        description: "slotId du nouveau créneau choisi.",
                    },
                    patientName: { type: "string" },
                    patientPhone: { type: "string" },
                    appointmentType: {
                        type: "string",
                        enum: ["FIRST", "FOLLOW_UP"],
                    },
                },
                required: [
                    "oldEventRef",
                    "newSlotId",
                    "patientName",
                    "patientPhone",
                    "appointmentType",
                ],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "request_callback",
            description:
                "Demande au cabinet de rappeler le patient. À utiliser quand : " +
                "(a) le patient veut annuler/modifier un RDV à moins de 24h, " +
                "(b) une demande complexe que tu ne peux pas traiter.",
            parameters: {
                type: "object",
                properties: {
                    eventRef: {
                        type: "string",
                        description:
                            "Optionnel. eventRef du RDV concerné si pertinent.",
                    },
                    reason: {
                        type: "string",
                        description: "Raison du callback en une phrase courte.",
                    },
                },
                required: ["reason"],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "get_cabinet_info",
            description:
                "Récupère les informations publiques du cabinet (adresse, horaires, praticiens). " +
                "À utiliser quand le patient pose une question d'info pratique.",
            parameters: {
                type: "object",
                properties: {
                    field: {
                        type: "string",
                        enum: ["address", "hours", "practitioners", "all"],
                    },
                },
                required: ["field"],
            },
        },
    },
];

// =====================================================================
// HANDLERS - logique métier de chaque tool
// =====================================================================

function safeResult(payload) {
    return JSON.stringify(payload);
}

async function loadCabinet(cabinetId) {
    if (!cabinetId) {
        throw new Error("cabinetId manquant dans le contexte de l'appel");
    }
    const cabinet = await getCabinet(cabinetId);
    if (!cabinet) throw new Error(`Cabinet ${cabinetId} introuvable`);
    if (cabinet.status && cabinet.status !== "active") {
        throw new Error("Cabinet inactif");
    }
    return cabinet;
}

function getAppointmentDuration(cabinet, appointmentType) {
    const first = Number(cabinet?.appointmentDurations?.first) || 45;
    const followUp = Number(cabinet?.appointmentDurations?.followUp) || 30;
    return appointmentType === "FIRST" ? first : followUp;
}

function findPractitionerByName(cabinet, name) {
    if (!name) return null;
    const target = name.trim().toLowerCase();
    return (
        cabinet.practitioners.find(
            (p) => p.name && p.name.toLowerCase().includes(target)
        ) || null
    );
}

// ---- search_available_slots ----
async function handleSearchAvailableSlots(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);

    const practitioners = params.practitionerName
        ? [findPractitionerByName(cabinet, params.practitionerName)].filter(Boolean)
        : cabinet.practitioners;

    if (!practitioners.length) {
        return safeResult({
            ok: false,
            error: "Aucun praticien disponible pour cette recherche.",
            availablePractitioners: cabinet.practitioners.map((p) => p.name),
        });
    }

    const durationMinutes = getAppointmentDuration(
        cabinet,
        params.appointmentType
    );

    const lookupArgs = {
        cabinet,
        practitioners,
        durationMinutes,
        timePreference: params.timePreference || null,
        targetHourMinutes: Number.isFinite(params.targetHourMinutes)
            ? params.targetHourMinutes
            : null,
        priorityPreference: params.priorityPreference || null,
    };

    const result = params.fromDate
        ? await suggestTwoSlotsFromDate({ ...lookupArgs, fromDate: params.fromDate })
        : await suggestTwoSlotsNext7Days(lookupArgs);

    const slots = (result.slots || []).map((s) => ({
        slotId: encodeSlotId({
            calendarId: s.calendarId,
            start: s.start,
            end: s.end,
            practitionerName: s.practitionerName,
        }),
        startISO: new Date(s.start).toISOString(),
        humanReadable: formatSlotFR(s.start, cabinet.timezone),
        practitionerName: s.practitionerName || null,
    }));

    return safeResult({
        ok: true,
        status: result.status,
        slots,
        message: result.speech || null,
    });
}

// ---- book_appointment ----
async function handleBookAppointment(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);

    const decoded = decodeSlotId(params.slotId);
    if (!decoded) {
        return safeResult({
            ok: false,
            error: "slotId invalide. Tu dois utiliser un slotId renvoyé par search_available_slots.",
        });
    }

    const phone = parsePhone(params.patientPhone, "");
    if (!phone) {
        return safeResult({
            ok: false,
            error: "Numéro de téléphone invalide. Demande au patient de le redonner chiffre par chiffre.",
        });
    }

    const durationMinutes = getAppointmentDuration(cabinet, params.appointmentType);
    const reason =
        params.appointmentType === "FIRST"
            ? `Premier rendez-vous ${cabinet.appointmentLabel || ""}`.trim()
            : `Rendez-vous ${cabinet.appointmentLabel || ""}`.trim();

    const result = await bookAppointmentSafe({
        calendarId: decoded.calendarId,
        patientName: (params.patientName || "Patient").trim(),
        reason,
        startDate: decoded.start,
        endDate: decoded.end,
        phone,
        appointmentType: params.appointmentType,
        durationMinutes,
        cabinet,
    });

    if (!result.ok) {
        return safeResult({
            ok: false,
            code: result.code || "BOOK_FAILED",
            message:
                result.code === "LOCKED"
                    ? "Ce créneau est en cours de réservation par un autre appel. Propose un autre créneau."
                    : "Ce créneau n'est plus disponible. Propose un autre créneau via search_available_slots.",
        });
    }

    // SMS confirmation (best-effort, ne bloque pas la confirmation)
    sendAppointmentConfirmationSMS({
        to: phone,
        patientName: params.patientName,
        formattedSlot: formatSlotFR(decoded.start, cabinet.timezone),
        practitionerName: decoded.practitionerName || "",
    }).catch((err) =>
        console.error("[TOOLS][SMS_CONFIRMATION_FAILED]", err?.message)
    );

    return safeResult({
        ok: true,
        eventRef: encodeSlotId({
            calendarId: decoded.calendarId,
            start: decoded.start,
            end: decoded.end,
        }),
        eventId: result.event?.id || null,
        formattedSlot: formatSlotFR(decoded.start, cabinet.timezone),
        practitionerName: decoded.practitionerName,
    });
}

// ---- find_patient_appointment ----
async function handleFindPatientAppointment(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);
    const phone = parsePhone(params.patientPhone, "");

    if (!phone) {
        return safeResult({
            ok: false,
            error: "Numéro de téléphone invalide.",
        });
    }

    const next = await findNextAppointmentSafe({
        cabinet,
        practitioners: cabinet.practitioners,
        phone,
    });

    if (!next) {
        return safeResult({
            ok: true,
            found: false,
            message:
                "Aucun rendez-vous trouvé pour ce numéro. " +
                "Demande au patient si le numéro fourni est bien celui utilisé lors de la prise de RDV.",
        });
    }

    return safeResult({
        ok: true,
        found: true,
        eventRef: JSON.stringify({
            calendarId: next.calendarId,
            eventId: next.eventId,
        }),
        formattedSlot: formatSlotFR(next.startISO, cabinet.timezone),
        startISO: next.startISO,
        patientName: next.patientName || null,
        appointmentType: next.appointmentType,
        isLessThan24h: isLessThan24h(next.startISO),
    });
}

function decodeEventRef(eventRef) {
    try {
        const obj = JSON.parse(eventRef);
        if (!obj?.calendarId || !obj?.eventId) return null;
        return obj;
    } catch (_err) {
        return null;
    }
}

// ---- cancel_appointment ----
async function handleCancelAppointment(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);
    const ref = decodeEventRef(params.eventRef);

    if (!ref) {
        return safeResult({ ok: false, error: "eventRef invalide." });
    }

    const result = await cancelAppointmentSafe({
        cabinet,
        practitioners: cabinet.practitioners,
        calendarId: ref.calendarId,
        eventId: ref.eventId,
    });

    if (!result.ok) {
        return safeResult({
            ok: false,
            code: result.code || "CANCEL_FAILED",
            message: "Échec de l'annulation. Propose au patient d'être rappelé.",
        });
    }

    return safeResult({
        ok: true,
        deleted: result.deleted,
        alreadyDeleted: Boolean(result.alreadyDeleted),
    });
}

// ---- modify_appointment ----
async function handleModifyAppointment(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);
    const oldRef = decodeEventRef(params.oldEventRef);
    const newSlot = decodeSlotId(params.newSlotId);

    if (!oldRef) {
        return safeResult({ ok: false, error: "oldEventRef invalide." });
    }
    if (!newSlot) {
        return safeResult({
            ok: false,
            error: "newSlotId invalide. Utilise un slotId renvoyé par search_available_slots.",
        });
    }

    const phone = parsePhone(params.patientPhone, "");
    if (!phone) {
        return safeResult({ ok: false, error: "Numéro invalide." });
    }

    // 1) On book le nouveau d'abord (lock)
    const durationMinutes = getAppointmentDuration(cabinet, params.appointmentType);
    const bookRes = await bookAppointmentSafe({
        calendarId: newSlot.calendarId,
        patientName: (params.patientName || "Patient").trim(),
        reason: `Rendez-vous ${cabinet.appointmentLabel || ""}`.trim(),
        startDate: newSlot.start,
        endDate: newSlot.end,
        phone,
        appointmentType: params.appointmentType,
        durationMinutes,
        cabinet,
    });

    if (!bookRes.ok) {
        return safeResult({
            ok: false,
            code: bookRes.code || "BOOK_FAILED",
            message: "Le nouveau créneau n'est plus disponible. Propose-en un autre.",
        });
    }

    // 2) On annule l'ancien
    const cancelRes = await cancelAppointmentSafe({
        cabinet,
        practitioners: cabinet.practitioners,
        calendarId: oldRef.calendarId,
        eventId: oldRef.eventId,
    });

    if (!cancelRes.ok) {
        console.error("[TOOLS][MODIFY_OLD_CANCEL_FAILED]", {
            oldRef,
            newEventId: bookRes.event?.id,
        });
        // On ne fait pas échouer la modif : l'humain au cabinet
        // verra le doublon, c'est mieux qu'une perte de RDV.
    }

    // 3) SMS modification (best-effort)
    sendAppointmentModifiedSMS({
        to: phone,
        patientName: params.patientName,
        formattedSlot: formatSlotFR(newSlot.start, cabinet.timezone),
        practitionerName: newSlot.practitionerName || "",
    }).catch((err) =>
        console.error("[TOOLS][SMS_MODIFIED_FAILED]", err?.message)
    );

    return safeResult({
        ok: true,
        formattedSlot: formatSlotFR(newSlot.start, cabinet.timezone),
        practitionerName: newSlot.practitionerName,
    });
}

// ---- request_callback ----
async function handleRequestCallback(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);

    if (params.eventRef) {
        const ref = decodeEventRef(params.eventRef);
        if (ref) {
            try {
                await addCallbackNoteToEvent({
                    cabinet,
                    practitioners: cabinet.practitioners,
                    calendarId: ref.calendarId,
                    eventId: ref.eventId,
                });
            } catch (err) {
                console.error("[TOOLS][CALLBACK_NOTE_FAILED]", err?.message);
            }
        }
    }

    // Log pour le tableau de bord cabinet (à brancher sur ta DB plus tard)
    console.log("[TOOLS][CALLBACK_REQUESTED]", {
        cabinetId: context.cabinetId,
        callSid: context.callSid,
        reason: params.reason,
    });

    return safeResult({
        ok: true,
        message:
            "Demande de rappel enregistrée. Confirme au patient que le cabinet le rappellera.",
    });
}

// ---- get_cabinet_info ----
async function handleGetCabinetInfo(params, context) {
    const cabinet = await loadCabinet(context.cabinetId);
    const field = params.field || "all";

    const info = {
        address: cabinet.addressSpeech || null,
        hours: cabinet.hoursSpeech || null,
        practitioners: cabinet.practitioners.map((p) => p.name),
    };

    if (field === "all") return safeResult({ ok: true, ...info });
    return safeResult({ ok: true, [field]: info[field] });
}

// =====================================================================
// DISPATCHER
// =====================================================================

const handlers = {
    search_available_slots: handleSearchAvailableSlots,
    book_appointment: handleBookAppointment,
    find_patient_appointment: handleFindPatientAppointment,
    cancel_appointment: handleCancelAppointment,
    modify_appointment: handleModifyAppointment,
    request_callback: handleRequestCallback,
    get_cabinet_info: handleGetCabinetInfo,
};

/**
 * Exécute un tool appelé par Vapi.
 * @param {string} toolName
 * @param {object} params - arguments parsés depuis function.arguments (JSON)
 * @param {object} context - { cabinetId, callSid, customerPhone }
 * @returns {Promise<string>} résultat JSON-stringifié à renvoyer au LLM
 */
async function executeTool(toolName, params, context) {
    const handler = handlers[toolName];
    if (!handler) {
        return safeResult({
            ok: false,
            error: `Tool inconnu: ${toolName}`,
        });
    }

    try {
        return await handler(params || {}, context || {});
    } catch (err) {
        console.error(`[TOOLS][${toolName}_ERROR]`, {
            message: err?.message,
            stack: err?.stack,
            params,
            cabinetId: context?.cabinetId,
        });
        return safeResult({
            ok: false,
            error:
                "Erreur technique lors de l'exécution. " +
                "Propose au patient d'être rappelé par le cabinet.",
        });
    }
}

module.exports = {
    toolDefinitions,
    executeTool,
    encodeSlotId,
    decodeSlotId,
};