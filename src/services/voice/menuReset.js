function resetToMenu(session, callSid = "UNKNOWN", reason = "MANUAL_RESET", logInfo = null) {
    if (!session || typeof session !== "object") {
        return;
    }

    if (typeof logInfo === "function") {
        logInfo("RESET_TO_MENU", {
            callSid,
            reason,
        });
    }

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

module.exports = {
    resetToMenu,
};