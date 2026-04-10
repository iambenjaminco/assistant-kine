function logInfo(event, data = {}) {
    console.log(`[TWILIO][${event}]`, data);
}

function logWarn(event, data = {}) {
    console.warn(`[TWILIO][${event}]`, data);
}

function logError(event, data = {}) {
    console.error(`[TWILIO][${event}]`, data);
}

function resolveMetaAndSnapshotBuilder(metaOrBuilder, maybeBuilder) {
    if (typeof metaOrBuilder === "function") {
        return {
            meta: {},
            buildSessionSnapshot: metaOrBuilder,
        };
    }

    return {
        meta: metaOrBuilder || {},
        buildSessionSnapshot: maybeBuilder,
    };
}

function safeSnapshot(session, buildSessionSnapshot) {
    if (typeof buildSessionSnapshot !== "function") {
        return null;
    }

    try {
        return buildSessionSnapshot(session);
    } catch (err) {
        return {
            snapshotError: err?.message || "SNAPSHOT_BUILD_FAILED",
        };
    }
}

function logStepTransition(callSid, session, from, to, metaOrBuilder = {}, maybeBuilder) {
    const { meta, buildSessionSnapshot } = resolveMetaAndSnapshotBuilder(
        metaOrBuilder,
        maybeBuilder
    );

    logInfo("STEP_TRANSITION", {
        callSid,
        from: from || null,
        to: to || null,
        ...meta,
        snapshot: safeSnapshot(session, buildSessionSnapshot),
    });
}

function logSessionCreated(callSid, session, metaOrBuilder = {}, maybeBuilder) {
    const { meta, buildSessionSnapshot } = resolveMetaAndSnapshotBuilder(
        metaOrBuilder,
        maybeBuilder
    );

    logInfo("SESSION_CREATED", {
        callSid,
        ...meta,
        snapshot: safeSnapshot(session, buildSessionSnapshot),
    });
}

function logSessionCleared(callSid, session, reason = "UNKNOWN", metaOrBuilder = {}, maybeBuilder) {
    const { meta, buildSessionSnapshot } = resolveMetaAndSnapshotBuilder(
        metaOrBuilder,
        maybeBuilder
    );

    logInfo("SESSION_CLEARED", {
        callSid,
        reason,
        ...meta,
        snapshot: safeSnapshot(session, buildSessionSnapshot),
    });
}

function logCallOutcome(callSid, outcome, session, metaOrBuilder = {}, maybeBuilder) {
    const { meta, buildSessionSnapshot } = resolveMetaAndSnapshotBuilder(
        metaOrBuilder,
        maybeBuilder
    );

    logInfo("CALL_OUTCOME", {
        callSid,
        outcome,
        ...meta,
        snapshot: safeSnapshot(session, buildSessionSnapshot),
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