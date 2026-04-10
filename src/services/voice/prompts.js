function getGuidedFallbackPrompt(step) {
    switch (step) {
        case "ACTION":
            return "Merci de me dire prendre, modifier ou annuler un rendez-vous.";
        case "BOOK_ASK_APPOINTMENT_TYPE":
            return "Merci de me dire si c'est un premier rendez-vous ou un rendez-vous de suivi.";
        case "BOOK_ASK_PRACTITIONER_PREF":
            return "Souhaitez-vous un kiné en particulier ? Répondez par oui, non, ou peu importe.";
        case "BOOK_ASK_SPECIFIC_PRACTITIONER_NAME":
            return "Merci de me donner le nom du kiné souhaité.";
        case "BOOK_ASK_USUAL_PRACTITIONER":
            return "Merci de me dire avec quel kiné vous êtes suivi, ou dites peu importe.";
        case "BOOK_PICK_SLOT":
        case "BOOK_PICK_ALT":
        case "MODIFY_PICK_NEW":
            return "Vous pouvez me dire le premier, le deuxième, ou un autre jour.";
        case "BOOK_ASK_PREFERRED_DATE":
        case "MODIFY_ASK_PREFERRED_DATE":
            return "Vous pouvez dire par exemple demain, jeudi, lundi prochain, le 18 mars, ou mercredi en fin d'après-midi.";
        case "BOOK_ASK_NAME":
            return "Merci de me dire votre nom et prénom.";
        case "BOOK_ASK_PHONE":
        case "MODIFY_ASK_PHONE":
        case "CANCEL_ASK_PHONE":
            return "Merci de me redonner votre numéro de téléphone chiffre par chiffre.";
        case "BOOK_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_PHONE":
        case "CANCEL_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_FOUND":
        case "CANCEL_CONFIRM_FOUND":
        case "CANCEL_ASK_REBOOK":
            return "Merci de répondre simplement par oui ou par non.";
        case "INFO_HANDLE":
            return "Vous pouvez dire l'adresse du cabinet ou les horaires d'ouverture.";
        default:
            return "Je n’ai pas bien compris. Merci de reformuler simplement.";
    }
}

function getNoInputIntro(step) {
    switch (step) {
        case "BOOK_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_PHONE":
        case "CANCEL_CONFIRM_PHONE":
        case "MODIFY_CONFIRM_FOUND":
        case "CANCEL_CONFIRM_FOUND":
        case "CANCEL_ASK_REBOOK":
            return "Je n'ai pas entendu votre confirmation.";
        case "BOOK_PICK_SLOT":
        case "BOOK_PICK_ALT":
        case "MODIFY_PICK_NEW":
            return "Je n'ai pas entendu le créneau souhaité.";
        case "BOOK_ASK_PHONE":
        case "MODIFY_ASK_PHONE":
        case "CANCEL_ASK_PHONE":
            return "Je n'ai pas entendu votre numéro.";
        case "BOOK_ASK_NAME":
            return "Je n'ai pas entendu votre nom.";
        default:
            return "Je n'ai pas eu de réponse.";
    }
}

function getActionPrompt(PHRASES) {
    return (
        PHRASES.askAction ||
        "Souhaitez-vous prendre, modifier ou annuler un rendez-vous, ou obtenir une information ?"
    );
}

function getSlotSelectionPrompt() {
    return "Quel créneau vous convient ?";
}

function getPractitionerPrompt() {
    return "Souhaitez-vous un kiné en particulier ?";
}

function getPhoneConfirmPrompt(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    const spoken = digits.match(/.{1,2}/g)?.join(" ") || phone || "";
    return `Si j’ai bien compris, votre numéro est le ${spoken}. Est-ce correct ?`;
}

function describeTimePreference(preference) {
    switch (preference) {
        case "EARLY_MORNING":
            return "en début de matinée";
        case "LATE_MORNING":
            return "en fin de matinée";
        case "MORNING":
            return "le matin";
        case "EARLY_AFTERNOON":
            return "en début d'après-midi";
        case "AFTERNOON":
            return "l'après-midi";
        case "LATE_AFTERNOON":
            return "en fin d'après-midi";
        case "EVENING":
            return "en soirée";
        default:
            return "sur ce créneau horaire";
    }
}

function buildPractitionersSpeech(cabinet) {
    const names = (cabinet?.practitioners || [])
        .map((p) => String(p.name || "").trim())
        .filter(Boolean);

    if (!names.length) {
        return "Je n’ai pas la liste des kinés du cabinet.";
    }

    if (names.length === 1) {
        return `Au cabinet, il y a ${names[0]}.`;
    }

    if (names.length === 2) {
        return `Au cabinet, il y a ${names[0]} et ${names[1]}.`;
    }

    return `Au cabinet, il y a ${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}.`;
}

module.exports = {
    getGuidedFallbackPrompt,
    getNoInputIntro,
    getActionPrompt,
    getSlotSelectionPrompt,
    getPractitionerPrompt,
    getPhoneConfirmPrompt,
    describeTimePreference,
    buildPractitionersSpeech,
};