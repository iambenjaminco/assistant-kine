function ensureTracking(session) {
    if (!session || typeof session !== "object") {
        return;
    }

    if (!session.tracking) {
        session.tracking = {
            callReceivedTracked: false,
            callHandledTracked: false,
            failedCallTracked: false,
            durationTracked: false,
            startedAt: Date.now(),
        };
    }
}

function trackCallReceived(session, cabinetKey = "main", incrementMetric) {
    ensureTracking(session);

    if (!session?.tracking || session.tracking.callReceivedTracked) return;
    if (typeof incrementMetric !== "function") return;

    incrementMetric(cabinetKey, "callsReceived");
    session.tracking.callReceivedTracked = true;
}

function trackCallHandled(session, cabinetKey = "main", incrementMetric) {
    ensureTracking(session);

    if (!session?.tracking || session.tracking.callHandledTracked) return;
    if (typeof incrementMetric !== "function") return;

    incrementMetric(cabinetKey, "callsHandled");
    session.tracking.callHandledTracked = true;
}

function trackFailedCall(session, cabinetKey = "main", incrementMetric) {
    ensureTracking(session);

    if (!session?.tracking || session.tracking.failedCallTracked) return;
    if (typeof incrementMetric !== "function") return;

    incrementMetric(cabinetKey, "failedCalls");
    session.tracking.failedCallTracked = true;
}

function trackCallDuration(session, cabinetKey = "main", addCallDuration) {
    ensureTracking(session);

    if (!session?.tracking || session.tracking.durationTracked) return;
    if (typeof addCallDuration !== "function") return;

    const startedAt = Number(session.tracking.startedAt || session.createdAt || Date.now());
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

    addCallDuration(cabinetKey, durationSeconds);
    session.tracking.durationTracked = true;
}

function isCallTooLong(session, maxMs = 8 * 60 * 1000) {
    const startedAt = Number(
        session?.tracking?.startedAt ||
        session?.createdAt ||
        Date.now()
    );

    return Date.now() - startedAt > maxMs;
}

module.exports = {
    ensureTracking,
    trackCallReceived,
    trackCallHandled,
    trackFailedCall,
    trackCallDuration,
    isCallTooLong,
};