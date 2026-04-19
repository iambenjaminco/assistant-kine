function isModifyStep(step) {
    return [
        "MODIFY_ASK_PHONE",
        "MODIFY_CONFIRM_PHONE",
        "MODIFY_FIND_APPT",
        "MODIFY_CONFIRM_FOUND",
        "MODIFY_PROPOSE_NEW",
        "MODIFY_PICK_NEW",
        "MODIFY_ASK_PREFERRED_DATE",
    ].includes(step);
}

async function handleModifyStep(ctx) {
    const {
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
    } = ctx;

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
        logInfo("MODIFY_FIND_APPT_INPUT", {
            callSid,
            cabinetId,
            phone: maskPhone(session.phone),
            practitioners: (activeCabinet.practitioners || []).map((p) => ({
                name: p?.name || null,
                calendarId: p?.calendarId || null,
            })),
        });

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

        const currentPractitioner = activeCabinet.practitioners.find((p) => {
            return (
                p.calendarId === found.calendarId ||
                p.selectedCalendarId === found.calendarId
            );
        });
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
        gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
        gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, prompt);

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
                        cabinet: activeCabinet,
                        practitioners: activeCabinet.practitioners,
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
                logInfo("CALLBACK_NOTE_FAILED", {
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

        session.slots = slots || [];

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

        gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, "Très bien.");

        if (usedAnyPractitionerFallback) {
            gather.say(
                { language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" },
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
            gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, cleaned);
        } else {
            saySlotsOnNode(gather, session.slots);
        }

        gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, prompt);

        return sendTwiml(res, vr, callSid, session);
    }

    if (session.step === "MODIFY_PICK_NEW") {
        const t = normalizeText(speech);
        const requestedDateISO = parseRequestedDate(speech) || parseRequestedDate(t);

        if (requestedDateISO) {
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
            gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, "Je n'ai pas bien compris.");
            gather.say(
                { language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" },
                `Vous pouvez me dire le premier pour ${formatSlotFR(a.start)}, le deuxième pour ${formatSlotFR(b.start)}, ou un autre jour.`
            );
            gather.say({ language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" }, prompt);

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

        const modifyActionKey = `MODIFY:${session.foundEvent?.eventId}:${slot.calendarId}:${new Date(slot.start).toISOString()}`;

        if (hasProcessedAction(session, modifyActionKey)) {
            logWarn("MODIFY_ALREADY_PROCESSED", {
                callSid,
                modifyActionKey,
            });

            sayFr(vr, "La modification est déjà en cours de traitement.");
            return sendTwiml(res, vr, callSid, session);
        }

        markProcessedAction(session, modifyActionKey);

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
                    "Le nouveau rendez-vous est bien réservé, mais une vérification manuelle de l’ancien rendez-vous reste nécessaire. Merci de contacter le cabinet."
                );
                sayGoodbye(vr);
                return sendTwiml(res, vr);
            }

            const cancelOldResult = await withTimeout(
                cancelAppointmentSafe({
                    cabinet: activeCabinet,
                    practitioners: activeCabinet.practitioners,
                    calendarId: oldEvent.calendarId,
                    eventId: oldEvent.eventId,
                }),
                8000,
                "CANCEL_OLD_APPOINTMENT_AFTER_REBOOK"
            );

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
                return sendTwiml(res, vr);
            }

            await incrementMetric(cabinetId, "appointmentsModified");
            await trackHandledOnce(session, cabinetId);
            await trackDurationOnce(session, cabinetId);
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

            promptAndGatherDate(
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

    return null;
}

module.exports = {
    isModifyStep,
    handleModifyStep,
};