function summarizeSlot(formatSlotFR, slot) {
    if (!slot) return null;
    return {
        start: slot.start,
        end: slot.end,
        formattedStart: slot.start ? formatSlotFR(slot.start) : null,
        practitionerName: slot.practitionerName || null,
        calendarId: slot.calendarId || null,
    };
}

function summarizeSlots(formatSlotFR, slots) {
    return (slots || []).map((slot) => summarizeSlot(formatSlotFR, slot));
}

function buildSessionSnapshot(session, helpers = {}) {
    const { maskPhone = () => "", maskName = () => "", summarizeSlot: summarizeSlotFn = () => null } = helpers;

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
        pendingSlot: summarizeSlotFn(session?.pendingSlot),
        foundEvent: session?.foundEvent
            ? {
                eventId: session.foundEvent.eventId || null,
                calendarId: session.foundEvent.calendarId || null,
                startISO: session.foundEvent.startISO || null,
                endISO: session.foundEvent.endISO || null,
                appointmentType: session.foundEvent.appointmentType || null,
                durationMinutes: session.foundEvent.durationMinutes || null,
            }
            : null,
        retryCount: session?.retryCount || 0,
        noInputCount: session?.noInputCount || 0,
    };
}

function setPrompt(session, prompt) {
    session.lastPrompt = prompt || "";
}

function resetRetry(session) {
    session.retryCount = 0;
}

function rememberLastProposedSlots(session) {
    session.lastProposedStartISO = session.slots?.[0]?.start || null;
}

function resetBookingFlowState(session, { keepIdentity = false } = {}) {
    session.slots = [];
    session.pendingSlot = null;
    session.foundEvent = null;

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

    if (!keepIdentity) {
        session.patientName = "";
        session.phone = "";
        session.phoneCandidate = "";
        session.phonePurpose = null;
    }
}

function resetToMenu(session, buildSessionSnapshotFn, callSid = "UNKNOWN", reason = "MANUAL_RESET", logWarn = () => {}) {
    logWarn("RESET_TO_MENU", {
        callSid,
        reason,
        snapshotBeforeReset: buildSessionSnapshotFn(session),
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
    session.tracking = session.tracking || {
        callReceivedTracked: false,
        callHandledTracked: false,
        failedCallTracked: false,
        durationTracked: false,
        startedAt: Date.now(),
    };
}

function setStep(session, callSid, nextStep, logStepTransition, meta = {}) {
    const previousStep = session?.step || null;
    session.step = nextStep;
    logStepTransition(callSid, session, previousStep, nextStep, meta);
}

module.exports = {
    summarizeSlot,
    summarizeSlots,
    buildSessionSnapshot,
    setPrompt,
    resetRetry,
    rememberLastProposedSlots,
    resetBookingFlowState,
    resetToMenu,
    setStep,
};