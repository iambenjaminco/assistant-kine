function isBookStep(step) {
    return [
        "BOOK_WELCOME",
        "BOOK_ASK_APPOINTMENT_TYPE",
        "BOOK_ASK_PRACTITIONER_PREF",
        "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME",
        "BOOK_ASK_USUAL_PRACTITIONER",
        "BOOK_NO_SLOT_WITH_PRACTITIONER",
        "BOOK_PICK_SLOT",
        "BOOK_ASK_PREFERRED_DATE",
        "BOOK_ASK_NAME",
        "BOOK_ASK_PHONE",
        "BOOK_CONFIRM_PHONE",
        "BOOK_PICK_ALT",
    ].includes(step);
}

async function handleBookStep(ctx) {
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
    } = ctx;

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
                consumeActionAck(
                    session,
                    pickVariant(session, "book_intro_type", [
                        "D'accord.",
                        "Très bien.",
                        "Bien sûr.",
                    ])
                )
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (!session.practitionerPreferenceMode) {
            setStep(session, callSid, "BOOK_ASK_PRACTITIONER_PREF", {
                trigger: "APPOINTMENT_TYPE_READY",
            });
            promptAndGather(
                vr,
                session,
                getPractitionerPrompt(session),
                consumeActionAck(session)
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.practitionerPreferenceMode === "USUAL" && !session.preferredPractitioner) {
            setStep(session, callSid, "BOOK_ASK_USUAL_PRACTITIONER", {
                trigger: "USUAL_PRACTITIONER_REQUESTED",
            });
            promptAndGather(
                vr,
                session,
                "Avec quel kiné êtes-vous habituellement suivi ?",
                consumeActionAck(session)
            );
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
            const retry = await handleRetry(
                vr,
                res,
                session,
                callSid,
                cabinetId,
                "BOOK_ASK_APPOINTMENT_TYPE"
            );
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
            sayFr(gather, buildPractitionersSpeech(activeCabinet));
            sayFr(gather, getPractitionerPrompt(session));
            return sendTwiml(res, vr, callSid, session);
        }

        if (practitioner) {
            session.preferredPractitioner = practitioner;
            session.practitionerPreferenceMode = "SPECIFIC";

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

            setStep(session, callSid, "BOOK_ASK_USUAL_PRACTITIONER", {
                trigger: "PRACTITIONER_MODE_USUAL",
            });
            promptAndGather(
                vr,
                session,
                "Avec quel kiné êtes-vous habituellement suivi ?",
                "Très bien."
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (yesNo === true) {
            session.practitionerPreferenceMode = "SPECIFIC";

            setStep(session, callSid, "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME", {
                trigger: "SPECIFIC_PRACTITIONER_NAME_REQUIRED",
            });
            promptAndGather(vr, session, "D'accord. Quel est le nom du kiné souhaité ?");
            return sendTwiml(res, vr, callSid, session);
        }

        const retry = await handleRetry(
            vr,
            res,
            session,
            callSid,
            cabinetId,
            "BOOK_ASK_PRACTITIONER_PREF"
        );
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
            sayFr(gather, buildPractitionersSpeech(activeCabinet));
            sayFr(gather, "Quel est le nom du kiné souhaité ?");
            return sendTwiml(res, vr, callSid, session);
        }

        const practitioner = findPractitionerBySpeech(speech, activeCabinet);
        const noPreference = detectNoPractitionerPreference(speech);

        if (practitioner) {
            session.preferredPractitioner = practitioner;
            session.practitionerPreferenceMode = "SPECIFIC";

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

        const retry = await handleRetry(
            vr,
            res,
            session,
            callSid,
            cabinetId,
            "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME"
        );
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
            sayFr(gather, buildPractitionersSpeech(activeCabinet));
            sayFr(gather, "Avec quel kiné êtes-vous habituellement suivi ?");
            return sendTwiml(res, vr, callSid, session);
        }

        const practitioner = findPractitionerBySpeech(speech, activeCabinet);
        const noPreference = detectNoPractitionerPreference(speech);

        if (practitioner) {
            session.preferredPractitioner = practitioner;
            session.practitionerPreferenceMode = "SPECIFIC";

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

        const retry = await handleRetry(
            vr,
            res,
            session,
            callSid,
            cabinetId,
            "BOOK_ASK_USUAL_PRACTITIONER"
        );
        if (retry) return retry;

        promptAndGather(
            vr,
            session,
            "Je n’ai pas bien compris. Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe."
        );
        return sendTwiml(res, vr, callSid, session);
    }

    if (session.step === "BOOK_NO_SLOT_WITH_PRACTITIONER") {
        const t = normalizeText(speech);

        if (
            t.includes("autre") ||
            t.includes("quelqu'un d'autre") ||
            t.includes("quelquun d'autre") ||
            t.includes("autre kine") ||
            t.includes("autre kiné") ||
            t.includes("autre praticien")
        ) {
            session.preferredPractitioner = null;
            session.practitionerPreferenceMode = "ANY";

            sayFr(vr, "Très bien, je regarde avec un autre praticien.");

            return proposeBookingSlots({
                vr,
                res,
                session,
                callSid,
                cabinet: activeCabinet,
            });
        }

        if (
            t.includes("attendre") ||
            t.includes("plus tard") ||
            t.includes("semaine prochaine")
        ) {
            sayFr(vr, "Très bien, je recherche des créneaux plus tard.");

            const inSevenDays = new Date(
                Date.now() + 7 * 24 * 60 * 60 * 1000
            ).toISOString();

            return proposeBookingSlots({
                vr,
                res,
                session,
                callSid,
                cabinet: activeCabinet,
                fromDateISO: inSevenDays,
            });
        }

        if (
            t.includes("cabinet") ||
            t.includes("mettre en relation") ||
            t.includes("transfert") ||
            t.includes("transferer") ||
            t.includes("transférer")
        ) {
            return tryTransferToCabinet({
                vr,
                res,
                session,
                callSid,
                cabinetId,
                cabinet: activeCabinet,
                intro: "Je vous mets en relation avec le cabinet.",
                fallbackType: "UNAVAILABLE",
                endReason: "TRANSFER_FAILED",
                meta: { fromStep: "BOOK_NO_SLOT_WITH_PRACTITIONER" },
            });
        }

        promptAndGather(
            vr,
            session,
            "Souhaitez-vous un autre praticien du cabinet, attendre un créneau plus tard, ou être mis en relation avec le cabinet ?"
        );
        return sendTwiml(res, vr, callSid, session);
    }

    return null;
}

module.exports = {
    isBookStep,
    handleBookStep,
};