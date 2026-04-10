function logInfo(event, data = {}) {
    console.log(`[TWILIO][${event}]`, data);
}

function logWarn(event, data = {}) {
    console.warn(`[TWILIO][${event}]`, data);
}

function logError(event, data = {}) {
    console.error(`[TWILIO][${event}]`, data);
}

function logStepTransition(callSid, session, from, to, meta = {}, buildSessionSnapshot) {
    logInfo("STEP_TRANSITION", {
        callSid,
        from: from || null,
        to: to || null,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function logSessionCreated(callSid, session, meta = {}, buildSessionSnapshot) {
    logInfo("SESSION_CREATED", {
        callSid,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function logSessionCleared(callSid, session, reason = "UNKNOWN", meta = {}, buildSessionSnapshot) {
    logInfo("SESSION_CLEARED", {
        callSid,
        reason,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

function logCallOutcome(callSid, outcome, session, meta = {}, buildSessionSnapshot) {
    logInfo("CALL_OUTCOME", {
        callSid,
        outcome,
        ...meta,
        snapshot: buildSessionSnapshot(session),
    });
}

module.exports = {
    logInfo,
    logWarn,
    logError,
    logStepTransition,
    logSessionCreated,
    logSessionCleared,
    logCallOutcome,
};