const PARIS_TIMEZONE = "Europe/Paris";

function normalizeText(s) {
    return (s || "")
        .toString()
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’']/g, "'")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ");
}

function wantsMainMenu(text) {
    return (
        text.includes("menu") ||
        text.includes("retour menu") ||
        text.includes("revenir au menu") ||
        text.includes("retour au menu") ||
        text.includes("accueil") ||
        text.includes("recommencer")
    );
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function buildDateKey(date) {
    const d = startOfDay(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getFrenchMonthIndex(token) {
    const months = {
        janvier: 0,
        fevrier: 1,
        mars: 2,
        avril: 3,
        mai: 4,
        juin: 5,
        juillet: 6,
        aout: 7,
        septembre: 8,
        octobre: 9,
        novembre: 10,
        decembre: 11,
    };
    return months[token] ?? null;
}

function getFrenchWeekdayIndex(token) {
    const weekdays = {
        dimanche: 0,
        lundi: 1,
        mardi: 2,
        mercredi: 3,
        jeudi: 4,
        vendredi: 5,
        samedi: 6,
    };
    return weekdays[token] ?? null;
}

function getParisNow() {
    return new Date(
        new Date().toLocaleString("en-US", { timeZone: PARIS_TIMEZONE })
    );
}

function computeNextWeekdayDate(targetDow, forceNextWeek = false) {
    const nowParis = getParisNow();
    const today = startOfDay(nowParis);
    const currentDow = today.getDay();

    let delta = targetDow - currentDow;
    if (delta < 0) delta += 7;

    if (delta === 0) {
        delta = forceNextWeek ? 7 : 0;
    }

    return addDays(today, delta);
}

function detectAlternativeRequest(text) {
    const t = normalizeText(text);

    return (
        t.includes("autre date") ||
        t.includes("autre jour") ||
        t.includes("un autre jour") ||
        t.includes("une autre date") ||
        t.includes("autre creneau") ||
        t.includes("autre horaire") ||
        t.includes("un autre horaire") ||
        t.includes("plus tard") ||
        t.includes("plus tot") ||
        t.includes("autre rendez") ||
        t.includes("un autre rendez") ||
        t.includes("pas disponible") ||
        t.includes("je ne suis pas disponible") ||
        t.includes("je suis pas disponible") ||
        t.includes("je peux pas") ||
        t.includes("je ne peux pas") ||
        t.includes("pas possible") ||
        t.includes("plus tard dans la semaine") ||
        t.includes("avez vous autre chose") ||
        t.includes("vous avez autre chose") ||
        t.includes("autre chose") ||
        t.includes("aucun des deux") ||
        t.includes("ni l'un ni l'autre") ||
        t.includes("ni lun ni lautre")
    );
}

function parseRequestedDate(text) {
    const raw = normalizeText(text);
    if (!raw) return null;

    // ✅ PAR :
    const now = getParisNow();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (raw.includes("aujourd'hui") || raw.includes("aujourdhui")) {
        return buildDateKey(today);
    }

    if (raw.includes("apres demain")) {
        return buildDateKey(addDays(today, 2));
    }

    if (raw.includes("demain")) {
        return buildDateKey(addDays(today, 1));
    }

    const numericMatch = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
    if (numericMatch) {
        const day = Number(numericMatch[1]);
        const month = Number(numericMatch[2]) - 1;
        let year = numericMatch[3] ? Number(numericMatch[3]) : today.getFullYear();
        if (year < 100) year += 2000;

        const d = new Date(year, month, day);
        if (!Number.isNaN(d.getTime())) {
            if (!numericMatch[3] && startOfDay(d) < today) {
                d.setFullYear(d.getFullYear() + 1);
            }
            return buildDateKey(d);
        }
    }

    const longDateMatch = raw.match(
        /\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/
    );
    if (longDateMatch) {
        const day = Number(longDateMatch[1]);
        const month = getFrenchMonthIndex(longDateMatch[2]);
        let year = longDateMatch[3] ? Number(longDateMatch[3]) : today.getFullYear();

        if (month !== null) {
            const d = new Date(year, month, day);
            if (!Number.isNaN(d.getTime())) {
                if (!longDateMatch[3] && startOfDay(d) < today) {
                    d.setFullYear(d.getFullYear() + 1);
                }
                return buildDateKey(d);
            }
        }
    }

    const weekdayMatch = raw.match(
        /\b(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)(?:\s+prochain)?\b/
    );
    if (weekdayMatch) {
        const dow = getFrenchWeekdayIndex(weekdayMatch[1]);
        const forceNextWeek = raw.includes("prochain");
        if (dow !== null) {
            return buildDateKey(
                computeNextWeekdayDate(dow, forceNextWeek)
            );
        }
    }

    return null;
}

function isExplicitDateRequest(text) {
    return Boolean(parseRequestedDate(text));
}

function cleanProposeSpeech(s) {
    return String(s || "")
        .replace(/^bonjour[\s,.-]*/i, "")
        .replace(/^vous etes bien[^.?!]*[.?!]\s*/i, "")
        .replace(/^cabinet[^.?!]*[.?!]\s*/i, "")
        .trim();
}

function isLessThan24h(startISO) {
    const start = new Date(startISO).getTime();
    const now = Date.now();
    return start - now < 24 * 60 * 60 * 1000;
}

function inferTimeWindowFromHourMinutes(hourMinutes) {
    if (!Number.isFinite(hourMinutes)) return null;
    const hour = Math.floor(hourMinutes / 60);

    if (hour < 12) return "MORNING";
    if (hour < 16) return "EARLY_AFTERNOON";
    if (hour < 17) return "AFTERNOON";
    if (hour < 19) return "LATE_AFTERNOON";
    return "EVENING";
}

function detectSpecificHourPreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (t.includes("midi et demi")) return 12 * 60 + 30;
    if (t.includes("midi trente")) return 12 * 60 + 30;
    if (t.includes("midi")) return 12 * 60;
    if (t.includes("minuit")) return 0;

    let match =
        t.match(/\b(\d{1,2})\s*h\s*(\d{2})?\b/) ||
        t.match(/\b(\d{1,2})\s*heure(?:s)?\s*(\d{2})?\b/);

    if (!match) {
        match = t.match(
            /\b(?:vers|autour de|aux alentours de|plutot vers|plutot autour de)\s+(\d{1,2})(?::(\d{2}))?\b/
        );
    }

    if (!match) return null;

    const hour = Number(match[1]);
    const minutes = Number(match[2] || 0);

    if (!Number.isFinite(hour) || !Number.isFinite(minutes)) return null;
    if (hour < 7 || hour > 21) return null;
    if (minutes < 0 || minutes > 59) return null;

    return hour * 60 + minutes;
}

function detectTimePreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (
        t.includes("debut de matinee") ||
        t.includes("debut de matine") ||
        t.includes("en debut de matinee") ||
        t.includes("en debut de matine") ||
        t.includes("tot le matin")
    ) {
        return "EARLY_MORNING";
    }

    if (
        t.includes("fin de matinee") ||
        t.includes("fin de matine") ||
        t.includes("en fin de matinee") ||
        t.includes("en fin de matine")
    ) {
        return "LATE_MORNING";
    }

    if (
        t.includes("fin d'apres midi") ||
        t.includes("fin dapres midi") ||
        t.includes("fin d apres midi") ||
        t.includes("en fin d'apres midi") ||
        t.includes("en fin dapres midi") ||
        t.includes("fin de journee") ||
        t.includes("fin d'aprem") ||
        t.includes("fin daprem") ||
        t.includes("fin d aprem") ||
        t.includes("apres le travail")
    ) {
        return "LATE_AFTERNOON";
    }

    if (
        t.includes("debut d'apres midi") ||
        t.includes("debut dapres midi") ||
        t.includes("en debut d'apres midi") ||
        t.includes("tot l'apres midi") ||
        t.includes("tot lapres midi")
    ) {
        return "EARLY_AFTERNOON";
    }

    if (
        t.includes("soir") ||
        t.includes("en soiree") ||
        t.includes("fin de soiree")
    ) {
        return "EVENING";
    }

    if (t.includes("matin") || t.includes("matinee") || t.includes("matine")) {
        return "MORNING";
    }

    if (
        t.includes("apres midi") ||
        t.includes("apres-midi") ||
        t.includes("apresmidi") ||
        t.includes("dans l'apres midi") ||
        t.includes("dans lapres midi")
    ) {
        return "AFTERNOON";
    }

    return null;
}

function detectPriorityPreference(text) {
    const t = normalizeText(text);
    if (!t) return null;

    if (
        t.includes("le plus tot possible") ||
        t.includes("au plus vite") ||
        t.includes("des que possible") ||
        t.includes("des que vous avez de la place") ||
        t.includes("le premier creneau disponible") ||
        t.includes("au plus tot") ||
        t.includes("le plus tot possible dans la journee") ||
        t.includes("tot dans la journee")
    ) {
        return "EARLIEST";
    }

    if (
        t.includes("le plus tard possible") ||
        t.includes("le plus tard") ||
        t.includes("le dernier creneau") ||
        t.includes("le dernier creneau possible") ||
        t.includes("le plus tard possible dans la journee")
    ) {
        return "LATEST";
    }

    if (
        t.includes("n'importe quand") ||
        t.includes("nimporte quand") ||
        t.includes("comme vous voulez") ||
        t.includes("je suis flexible") ||
        t.includes("peu importe") ||
        t.includes("ca m'est egal") ||
        t.includes("ça m'est egal") ||
        t.includes("pas de preference")
    ) {
        return "FLEXIBLE";
    }

    return null;
}

function mentionsWholeDayScope(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("dans la journee") ||
        t.includes("sur la journee") ||
        t.includes("dans toute la journee") ||
        t.includes("sur toute la journee") ||
        t.includes("dans la meme journee") ||
        t.includes("sur la meme journee")
    );
}

function updateTimePreferenceFromSpeech(session, text, { clearOnExplicitNone = false } = {}) {
    const t = normalizeText(text);
    if (!t) return;

    const explicitNone =
        t.includes("n'importe quelle heure") ||
        t.includes("nimporte quelle heure") ||
        t.includes("peu importe l'heure") ||
        t.includes("peu importe lheure") ||
        t.includes("aucune preference horaire") ||
        t.includes("pas de preference horaire");

    const wholeDayScope = mentionsWholeDayScope(t);
    const explicitHour = detectSpecificHourPreference(t);
    const detectedTimeWindow = detectTimePreference(t);
    const priority = detectPriorityPreference(t);

    if (explicitNone && clearOnExplicitNone) {
        session.preferredTimeWindow = null;
        session.preferredHourMinutes = null;
        session.priorityPreference = "FLEXIBLE";
        return;
    }

    if (Number.isFinite(explicitHour)) {
        session.preferredHourMinutes = explicitHour;
        session.preferredTimeWindow = inferTimeWindowFromHourMinutes(explicitHour);
        session.priorityPreference = null;
        return;
    }

    if (priority) {
        session.priorityPreference = priority;
        session.preferredHourMinutes = null;

        if (wholeDayScope || priority === "FLEXIBLE") {
            session.preferredTimeWindow = null;
            return;
        }

        if (detectedTimeWindow) {
            session.preferredTimeWindow = detectedTimeWindow;
        }

        return;
    }

    if (detectedTimeWindow) {
        session.preferredTimeWindow = detectedTimeWindow;
        session.preferredHourMinutes = null;
        session.priorityPreference = null;
        return;
    }

    if (wholeDayScope && clearOnExplicitNone) {
        session.preferredTimeWindow = null;
        session.preferredHourMinutes = null;
    }
}

function hasPreferenceRefinementRequest(text) {
    return Boolean(
        detectSpecificHourPreference(text) ||
        detectTimePreference(text) ||
        detectPriorityPreference(text) ||
        mentionsWholeDayScope(text)
    );
}

function parseYesNo(text) {
    const t = normalizeText(text);
    if (!t) return null;

    const noPatterns = [
        /\bnon\b/,
        /\bno\b/,
        /pas du tout/,
        /incorrect/,
        /ce n'?est pas ca/,
        /c'?est pas ca/,
        /ce n'?est pas mon numero/,
        /c'?est pas mon numero/,
        /ce n'?est pas mon rendez/,
        /c'?est pas mon rendez/,
        /mauvais numero/,
        /pas le bon/,
        /^pas bon$/,
        /^faux$/,
        /^negative?$/,
    ];

    const yesPatterns = [
        /\boui\b/,
        /\bouais\b/,
        /\bouep\b/,
        /\boh oui\b/,
        /\bben oui\b/,
        /\bbah oui\b/,
        /\byes\b/,
        /c'?est ca/,
        /c est ca/,
        /c'?est bien ca/,
        /c'?est bien cela/,
        /exact/,
        /exactement/,
        /correct/,
        /tout a fait/,
        /c'?est correct/,
        /c'?est le bon/,
        /c'?est bien le bon/,
        /c'?est bien mon numero/,
        /c'?est mon numero/,
        /c'?est bien mon rendez/,
        /c'?est bien mon rdv/,
        /ca me va/,
        /cela me va/,
        /^ok$/,
        /^okay$/,
        /^ok oui$/,
        /^daccord$/,
        /^d accord$/,
        /^dac$/,
        /^c bon$/,
        /^c'est bon$/,
        /^tres bien$/,
        /^parfait$/,
        /^oui oui$/,
        /je confirme/,
        /confirme/,
        /valide/,
        /c'est valide/,
        /tout bon/,
    ];

    const no = noPatterns.some((pattern) => pattern.test(t));
    const yes = yesPatterns.some((pattern) => pattern.test(t));

    if (yes && !no) return true;
    if (no && !yes) return false;
    return null;
}

function isLikelyValidPatientName(name) {
    const value = String(name || "").trim();
    const normalized = normalizeText(value);

    if (!value || normalized.length < 3) return false;
    if (parseYesNo(normalized) !== null) return false;
    if (wantsMainMenu(normalized)) return false;

    const forbiddenExact = new Set([
        "demain",
        "aujourd'hui",
        "aujourdhui",
        "premier",
        "premiere",
        "deuxieme",
        "second",
        "seconde",
        "autre jour",
        "autre date",
        "matin",
        "apres midi",
        "soir",
        "oui",
        "non",
    ]);

    if (forbiddenExact.has(normalized)) return false;

    return true;
}

function isPhoneConfirmationStep(step) {
    return (
        step === "BOOK_CONFIRM_PHONE" ||
        step === "MODIFY_CONFIRM_PHONE" ||
        step === "CANCEL_CONFIRM_PHONE"
    );
}

function detectExplicitPhoneRejection(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t === "non" ||
        t.includes("pas le bon") ||
        t.includes("c'est pas le bon") ||
        t.includes("ce n'est pas le bon") ||
        t.includes("mauvais numero") ||
        t.includes("ce n'est pas mon numero") ||
        t.includes("c'est pas mon numero") ||
        t.includes("numero faux") ||
        t.includes("faux numero")
    );
}

function detectBookingIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("prendre") ||
        t.includes("reprendre") ||
        t.includes("reserver") ||
        t.includes("booker") ||
        t.includes("fixer un rendez") ||
        t.includes("un rendez") ||
        t.includes("rdv") ||
        t.includes("creneau") ||
        t.includes("consult")
    );
}

function detectModifyIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("modifier") ||
        t.includes("changer") ||
        t.includes("decaler") ||
        t.includes("deplacer") ||
        t.includes("reporter")
    );
}

function detectCancelIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("annuler") ||
        t.includes("supprimer") ||
        t.includes("retirer")
    );
}

function detectInfoIntent(text) {
    const t = normalizeText(text);
    if (!t) return false;

    return (
        t.includes("information") ||
        t.includes("renseignement") ||
        t.includes("adresse") ||
        t.includes("horaire") ||
        t.includes("horaires") ||
        t.includes("ouvert") ||
        t.includes("ferme") ||
        t.includes("ou se trouve") ||
        t.includes("ou etes vous") ||
        t.includes("localisation") ||
        t.includes("venir")
    );
}

function detectActionChoice(speech, digits) {
    const t = normalizeText(speech);

    if (digits === "1") return "BOOK";
    if (digits === "2") return "MODIFY";
    if (digits === "3") return "CANCEL";
    if (digits === "4") return "INFO";

    // ✅ PAR :
    if (detectModifyIntent(t)) return "MODIFY";
    if (detectCancelIntent(t)) return "CANCEL";
    if (detectBookingIntent(t)) return "BOOK";
    if (detectInfoIntent(t)) return "INFO";

    return null;
}

function detectAppointmentType(text) {
    const t = normalizeText(text);

    const first =
        t.includes("premier rendez") ||
        t.includes("premiere fois") ||
        t.includes("1er rendez") ||
        t.includes("nouveau patient") ||
        t.includes("je ne suis jamais venu") ||
        t.includes("jamais venu") ||
        t.includes("premiere consultation");

    const followUp =
        t.includes("suivi") ||
        t.includes("controle") ||
        t.includes("deja suivi") ||
        t.includes("je suis deja suivi") ||
        t.includes("patient du cabinet") ||
        t.includes("je suis deja patient") ||
        t.includes("seance") ||
        t.includes("rdv de suivi");

    if (first && !followUp) return "FIRST";
    if (followUp && !first) return "FOLLOW_UP";
    return null;
}

function normalizePhoneCandidate(raw) {
    let digits = String(raw || "").replace(/\D/g, "");

    if (!digits) return "";

    if (digits.startsWith("0033")) {
        digits = `0${digits.slice(4)}`;
    } else if (digits.startsWith("33") && digits.length >= 11) {
        digits = `0${digits.slice(2)}`;
    }

    if (digits.length === 9) {
        digits = `0${digits}`;
    }

    if (digits.length !== 10) return "";
    if (!digits.startsWith("0")) return "";

    return digits;
}

const FRENCH_DIGIT_WORDS = {
    zero: "0",
    un: "1",
    une: "1",
    deux: "2",
    trois: "3",
    quatre: "4",
    cinq: "5",
    six: "6",
    sept: "7",
    huit: "8",
    neuf: "9",
    oh: "0",
    o: "0",
};

function parseSpokenFrenchPhone(text) {
    const normalized = normalizeText(text);
    if (!normalized) return "";

    const tokens = normalized.split(/\s+/).filter(Boolean);
    let rawDigits = "";

    for (const token of tokens) {
        if (/^\d+$/.test(token)) {
            rawDigits += token;
            continue;
        }

        if (FRENCH_DIGIT_WORDS[token]) {
            rawDigits += FRENCH_DIGIT_WORDS[token];
        }
    }

    return normalizePhoneCandidate(rawDigits);
}

function parsePhone(text, digits) {
    const byDigits = normalizePhoneCandidate(digits);
    if (byDigits) return byDigits;

    const bySpeechDigits = normalizePhoneCandidate(String(text || "").replace(/\D/g, ""));
    if (bySpeechDigits) return bySpeechDigits;

    const bySpeechWords = parseSpokenFrenchPhone(text);
    if (bySpeechWords) return bySpeechWords;

    return "";
}

module.exports = {
    PARIS_TIMEZONE,
    normalizeText,
    wantsMainMenu,
    parseRequestedDate,
    isExplicitDateRequest,
    cleanProposeSpeech,
    isLessThan24h,
    inferTimeWindowFromHourMinutes,
    detectSpecificHourPreference,
    detectTimePreference,
    detectPriorityPreference,
    mentionsWholeDayScope,
    updateTimePreferenceFromSpeech,
    hasPreferenceRefinementRequest,
    parseYesNo,
    isLikelyValidPatientName,
    isPhoneConfirmationStep,
    detectExplicitPhoneRejection,
    detectBookingIntent,
    detectModifyIntent,
    detectCancelIntent,
    detectInfoIntent,
    detectActionChoice,
    detectAppointmentType,
    detectAlternativeRequest,
    normalizePhoneCandidate,
    parseSpokenFrenchPhone,
    parsePhone,
};