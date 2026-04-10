function wantsRepeat(text) {
    const t = String(text || "").trim();
    if (!t) return false;

    return (
        t.includes("repete") ||
        t.includes("repeter") ||
        t.includes("répète") ||
        t.includes("répéter") ||
        t.includes("vous pouvez repeter") ||
        t.includes("vous pouvez répéter") ||
        t.includes("redis") ||
        t.includes("redites") ||
        t.includes("je n'ai pas compris") ||
        t.includes("j'ai pas compris")
    );
}

function repeatCurrentPrompt(vr, session) {
    session.lastPrompt = session.lastPrompt || "Je répète.";

    const gather = vr.gather({
        input: "speech dtmf",
        language: "fr-FR",
        speechTimeout: "auto",
        timeout: 6,
        actionOnEmptyResult: true,
        action: "/twilio/voice",
        method: "POST",
    });

    gather.say(
        { language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" },
        "Je répète."
    );
    gather.say(
        { language: "fr-FR", voice: "Google.fr-FR-Wavenet-A" },
        session.lastPrompt
    );

    return gather;
}

module.exports = {
    wantsRepeat,
    repeatCurrentPrompt,
};