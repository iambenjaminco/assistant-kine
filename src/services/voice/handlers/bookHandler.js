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
                // ✅ PAR :
                intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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
                    intro: pickVariant(session, "ack", ["Très bien.", "Parfait.", "D'accord.", "Entendu.", "C'est noté."]),
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

            // ✅ PAR :
            const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_NO_SLOT_WITH_PRACTITIONER");
            if (retry) return retry;

            promptAndGather(
                vr,
                session,
                "Souhaitez-vous un autre praticien du cabinet, attendre un créneau plus tard, ou être mis en relation avec le cabinet ?"
            );
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_PICK_SLOT") {
            const t = normalizeText(speech);
            const requestedDateISO = parseRequestedDate(speech);

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
                    return null;
                }

                const prompt = getSlotSelectionPrompt(session);
                const gather = gatherSpeech(vr, "/twilio/voice");
                sayFr(gather, "Je répète.");
                saySlotsOnNode(gather, session.slots);
                sayFr(gather, prompt);

                return sendTwiml(res, vr, callSid, session);
            }

            if (requestedDateISO) {
                session.pendingSlot = null;
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

                return proposeBookingSlots({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                });
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
                    return proposeBookingSlots({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet: activeCabinet,
                    });
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_SLOT");
                if (retry) return retry;

                const prompt = getSlotSelectionPrompt(session);
                const gather = gatherSpeech(vr, "/twilio/voice");
                sayFr(gather, "Je n'ai pas bien compris.");
                sayFr(
                    gather,
                    `Vous pouvez me dire le premier pour ${formatSlotFR(a.start)}, le deuxième pour ${formatSlotFR(b.start)}, ou un autre jour.`
                );
                sayFr(gather, prompt);

                return sendTwiml(res, vr, callSid, session);
            }

            const slot = session.slots?.[choice];

            if (!slot || !slot.calendarId) {
                session.pendingSlot = null;
                session.slots = [];
                session.requestedDateISO = null;

                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");
                return proposeBookingSlots({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                });
            }

            session.pendingSlot = slot;
            ctx.logInfo?.("BOOK_SLOT_SELECTED", {
                callSid,
                cabinetId,
                slot: summarizeSlot(slot),
            });
            setStep(session, callSid, "BOOK_ASK_NAME", {
                trigger: "SLOT_SELECTED",
                selectedSlot: summarizeSlot(slot),
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

            if (!requestedDateISO && hasPreferenceRefinementRequest(speech)) {
                session.slots = [];
                session.pendingSlot = null;
                session.requestedDateISO = null;

                return proposeBookingSlots({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                });
            }

            if (!requestedDateISO) {
                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_ASK_PREFERRED_DATE");
                if (retry) return retry;

                promptAndGatherDate(
                    vr,
                    session,
                    "Je n’ai pas compris le jour demandé. Vous pouvez dire par exemple demain, lundi prochain, mardi après-midi, ou une date précise."
                );
                return sendTwiml(res, vr, callSid, session);
            }

            session.pendingSlot = null;

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
            const name = (speech || "").replace(/\s+/g, " ").trim();

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
            session.phonePurpose = "BOOK";

            setStep(session, callSid, "BOOK_ASK_PHONE", {
                trigger: "PATIENT_NAME_CAPTURED",
                patientName: name,
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
                phone,
            });

            promptAndGather(vr, session, getPhoneConfirmPrompt(phone));
            return sendTwiml(res, vr, callSid, session);
        }

        if (session.step === "BOOK_CONFIRM_PHONE") {
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

            // ✅ PAR :
            session.phone = session.phoneCandidate;
            session.phoneCandidate = "";

            sayFr(vr, "Très bien, je réserve votre créneau. Veuillez patienter un instant.");

            return finalizeBooking(vr, res, session, callSid, activeCabinet, cabinetId);
        }

        if (session.step === "BOOK_PICK_ALT") {
            const t = normalizeText(speech);
            const requestedDateISO = parseRequestedDate(speech);

            if (requestedDateISO) {
                session.pendingSlot = null;
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

                return proposeBookingSlots({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                });
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
                    return proposeBookingSlots({
                        vr,
                        res,
                        session,
                        callSid,
                        cabinet: activeCabinet,
                    });
                }

                const retry = await handleRetry(vr, res, session, callSid, cabinetId, "BOOK_PICK_ALT");
                if (retry) return retry;

                const prompt = getSlotSelectionPrompt(session);
                const gather = gatherSpeech(vr, "/twilio/voice");
                sayFr(gather, "Je n'ai pas bien compris.");
                sayFr(
                    gather,
                    `Vous pouvez me dire le premier pour ${formatSlotFR(a.start)}, le deuxième pour ${formatSlotFR(b.start)}, ou un autre jour.`
                );
                sayFr(gather, prompt);

                return sendTwiml(res, vr, callSid, session);
            }

            const slot = session.slots?.[choice];

            if (!slot || !slot.calendarId) {
                session.pendingSlot = null;
                session.slots = [];
                session.requestedDateISO = null;

                sayFr(vr, "Ce créneau vient d’être pris. Je regarde d’autres disponibilités.");
                return proposeBookingSlots({
                    vr,
                    res,
                    session,
                    callSid,
                    cabinet: activeCabinet,
                });
            }

            session.pendingSlot = slot;
            ctx.logInfo?.("BOOK_ALT_SLOT_SELECTED", {
                callSid,
                cabinetId,
                slot: summarizeSlot(slot),
            });
            return finalizeBooking(vr, res, session, callSid, activeCabinet, cabinetId);
        }

        return null;
    }

    module.exports = {
        isBookStep,
        handleBookStep,
    };