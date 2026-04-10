function maskSpeech(text, maxLen = 80) {
    const value = String(text || "").trim();
    if (!value) return "";
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}...`;
}

function maskPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length <= 4) return digits;
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

function maskName(name) {
    const value = String(name || "").trim();
    if (!value) return "";
    if (value.length <= 2) return `${value[0] || ""}*`;
    return `${value.slice(0, 2)}***`;
}

function safeCallSid(req) {
    const sid = req.body?.CallSid || req.headers["x-twilio-call-sid"];
    if (typeof sid !== "string") return null;

    const trimmed = sid.trim();
    return trimmed || null;
}

function withTimeout(promise, ms = 8000, label = "ASYNC_OPERATION") {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms)
        ),
    ]);
}

module.exports = {
    maskSpeech,
    maskPhone,
    maskName,
    safeCallSid,
    withTimeout,
};