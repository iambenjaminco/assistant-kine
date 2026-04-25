const SAY_OPTS = {
    language: "fr-FR",
    voice: "Google.fr-FR-Wavenet-A",
};

function isCancelStep(step) {
    return [
        "CANCEL_ASK_PHONE",
        "CANCEL_CONFIRM_PHONE",
        "CANCEL_FIND_APPT",
        "CANCEL_CONFIRM_FOUND",
        "CANCEL_ASK_REBOOK",
    ].includes(step);
}

async function handleCancelStep(ctx) {
    const {
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
    } = ctx;

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

        // ✅ PAR :
        session.phone = session.phoneCandidate;
        session.phoneCandidate = "";
        setStep(session, callSid, "CANCEL_FIND_APPT", {
            trigger: "PHONE_CONFIRMED",
            phone: maskPhone(session.phone),
        });
        setPrompt(session, "");
        sayFr(vr, "Très bien, je recherche votre rendez-vous. Veuillez patienter un instant.");
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
        sayFr(gather, `J’ai trouvé un rendez-vous le ${formatSlotFR(found.startISO)}.`);
        sayFr(gather, prompt);

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

        const cancelActionKey = `CANCEL:${found.eventId}`;

        if (hasProcessedAction(session, cancelActionKey)) {
            logWarn("CANCEL_ALREADY_PROCESSED", {
                callSid,
                cancelActionKey,
            });

            sayFr(vr, "La demande d'annulation est déjà en cours de traitement.");
            return sendTwiml(res, vr, callSid, session);
        }

        markProcessedAction(session, cancelActionKey);

        const cancelResult = await withTimeout(
            cancelAppointmentSafe({
                cabinet: activeCabinet,
                practitioners: activeCabinet.practitioners,
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
                    activeCabinet.practitioners.find((p) => {
                        return (
                            p.calendarId === found.calendarId ||
                            p.selectedCalendarId === found.calendarId
                        );
                    })?.name || "",
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

        await incrementMetric(cabinetId, "appointmentsCancelled");
        await trackHandledOnce(session, cabinetId);

        setStep(session, callSid, "CANCEL_ASK_REBOOK", {
            trigger: "CANCEL_SUCCESS",
            cancelledEventId: found.eventId || null,
        });

        const prompt = "Voulez-vous reprendre un rendez-vous ?";
        setPrompt(session, prompt);

        const gather = gatherSpeech(vr, "/twilio/voice");
        sayFr(gather, "Votre rendez-vous est annulé.");
        sayFr(gather, prompt);

        return sendTwiml(res, vr, callSid, session);
    }

    if (session.step === "CANCEL_ASK_REBOOK") {
        const yesNo = parseYesNo(speech);
        const normalizedSpeech = normalizeText(speech);

        const wantsBook =
            normalizedSpeech &&
            (
                normalizedSpeech.includes("prendre") ||
                normalizedSpeech.includes("reprendre") ||
                normalizedSpeech.includes("reserver") ||
                normalizedSpeech.includes("booker") ||
                normalizedSpeech.includes("rendez") ||
                normalizedSpeech.includes("rdv")
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
            await trackDurationOnce(session, cabinetId);

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

        // ✅ PAR :
        await trackDurationOnce(session, cabinetId);
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

    return null;
}

module.exports = {
    isCancelStep,
    handleCancelStep,
};