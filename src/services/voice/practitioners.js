const { normalizeText } = require("./parsers");

function detectNoPractitionerPreference(text) {
    const t = normalizeText(text);
    return (
        t.includes("peu importe") ||
        t.includes("nimporte lequel") ||
        t.includes("n'importe lequel") ||
        t.includes("pas de preference") ||
        t.includes("aucune preference") ||
        t.includes("comme vous voulez") ||
        t.includes("n'importe qui") ||
        t.includes("pas important") ||
        t === "non" ||
        t.includes("non peu importe") ||
        t.includes("non pas de preference")
    );
}

function detectUsualPractitionerIntent(text) {
    const t = normalizeText(text);
    return (
        t.includes("mon kine habituel") ||
        t.includes("ma kine habituelle") ||
        t.includes("mon praticien habituel") ||
        t.includes("ma praticienne habituelle") ||
        t.includes("le meme kine") ||
        t.includes("la meme kine") ||
        t.includes("garder le meme kine") ||
        t.includes("je suis deja suivi")
    );
}

function findPractitionerBySpeech(text, cabinet) {
    const t = normalizeText(text);
    if (!t || !cabinet?.practitioners?.length) return null;

    for (const p of cabinet.practitioners) {
        const full = normalizeText(p.name || "");
        const parts = full.split(/\s+/).filter(Boolean);

        if (full && t.includes(full)) return p;
        for (const part of parts) {
            if (part.length >= 3 && t.includes(part)) return p;
        }
    }

    return null;
}

function getSearchPractitioners(session, cabinet) {
    if (session.preferredPractitioner?.calendarId) {
        return cabinet.practitioners.filter(
            (p) => p.calendarId === session.preferredPractitioner.calendarId
        );
    }
    return cabinet.practitioners;
}

function asksWhoAreThePractitioners(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("il y a qui comme kine") ||
        t.includes("il y a qui comme kiné") ||
        t.includes("quels kines") ||
        t.includes("quels kinés") ||
        t.includes("qui sont les kines") ||
        t.includes("qui sont les kinés") ||
        t.includes("vous avez quels kines") ||
        t.includes("vous avez quels kinés") ||
        t.includes("avec quels kines") ||
        t.includes("avec quels kinés")
    );
}

function detectForgotPractitionerIdentity(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("je sais pas son nom") ||
        t.includes("je ne sais pas son nom") ||
        t.includes("je sais plus son nom") ||
        t.includes("je ne sais plus son nom") ||
        t.includes("j'ai oublie son nom") ||
        t.includes("jai oublie son nom") ||
        t.includes("j'ai oublié son nom") ||
        t.includes("j'ai oublier son nom") ||
        t.includes("je me souviens plus de son nom") ||
        t.includes("je ne me souviens plus de son nom") ||
        t.includes("je sais pas son prenom") ||
        t.includes("je ne sais pas son prenom") ||
        t.includes("je sais plus son prenom") ||
        t.includes("je ne sais plus son prenom") ||
        t.includes("j'ai oublie son prenom") ||
        t.includes("jai oublie son prenom") ||
        t.includes("j'ai oublié son prénom") ||
        t.includes("j'ai oublier son prénom") ||
        t.includes("je me souviens plus de son prenom") ||
        t.includes("je ne me souviens plus de son prénom") ||
        t.includes("j'ai oublie comment il s'appelle") ||
        t.includes("jai oublie comment il s'appelle") ||
        t.includes("j'ai oublié comment il s'appelle") ||
        t.includes("j'ai oublier comment il s'appelle") ||
        t.includes("je sais plus comment il s'appelle") ||
        t.includes("je ne sais plus comment il s'appelle") ||
        t.includes("je sais pas comment il s'appelle") ||
        t.includes("je ne sais pas comment il s'appelle") ||
        t.includes("je sais plus comment il s appel") ||
        t.includes("je ne sais plus comment il s appel") ||
        t.includes("je sais pas comment il s appel") ||
        t.includes("je ne sais pas comment il s appel")
    );
}

module.exports = {
    detectNoPractitionerPreference,
    detectUsualPractitionerIntent,
    findPractitionerBySpeech,
    getSearchPractitioners,
    asksWhoAreThePractitioners,
    detectForgotPractitionerIdentity,
};