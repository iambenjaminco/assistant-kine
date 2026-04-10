function getHourInParis(startISO, PARIS_TIMEZONE) {
    const parts = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).formatToParts(new Date(startISO));

    const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
    return Number.isFinite(hour) ? hour : null;
}

function getMinutesInParis(startISO, PARIS_TIMEZONE) {
    const parts = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).formatToParts(new Date(startISO));

    const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || NaN);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

function slotMatchesTimePreference(slot, preference, getMinutesInParisFn, logWarn, logInfo) {
    if (!slot?.start || !preference) return true;

    const minutes = getMinutesInParisFn(slot.start);

    if (!Number.isFinite(minutes)) {
        if (typeof logWarn === "function") {
            logWarn("TIME_FILTER_INVALID_MINUTES", {
                slotStart: slot?.start || null,
                preference,
            });
        }
        return true;
    }

    let matched = true;

    switch (preference) {
        case "EARLY_MORNING":
            matched = minutes >= 8 * 60 && minutes < 10 * 60;
            break;
        case "LATE_MORNING":
            matched = minutes >= 10 * 60 && minutes < 12 * 60;
            break;
        case "MORNING":
            matched = minutes >= 8 * 60 && minutes < 12 * 60;
            break;
        case "EARLY_AFTERNOON":
            matched = minutes >= 14 * 60 && minutes < 16 * 60;
            break;
        case "AFTERNOON":
            matched = minutes >= 14 * 60 && minutes < 19 * 60;
            break;
        case "LATE_AFTERNOON":
            matched = minutes >= 17 * 60 && minutes < 19 * 60;
            break;
        case "EVENING":
            matched = minutes >= 18 * 60 && minutes < 19 * 60;
            break;
        default:
            matched = true;
            break;
    }

    if (typeof logInfo === "function") {
        logInfo("TIME_FILTER_CHECK", {
            slotStart: slot.start,
            practitionerName: slot.practitionerName || null,
            preference,
            minutesInParis: minutes,
            matched,
        });
    }

    return matched;
}

function filterSlotsByTimePreference(slots, preference, slotMatchesTimePreferenceFn) {
    if (!preference) return slots || [];
    if (typeof slotMatchesTimePreferenceFn !== "function") return slots || [];

    return (slots || []).filter((slot) => slotMatchesTimePreferenceFn(slot, preference));
}

function hydrateSlotsWithDefaultPractitioner(slots, cabinet) {
    const defaultPractitioner = cabinet?.practitioners?.[0];

    if (!defaultPractitioner) {
        return slots || [];
    }

    return (slots || []).map((s) => ({
        ...s,
        calendarId: s.calendarId || defaultPractitioner.calendarId,
        practitionerName: s.practitionerName || defaultPractitioner.name,
    }));
}

function getSlotWeekdayFR(startISO, PARIS_TIMEZONE) {
    return new Intl.DateTimeFormat("fr-FR", {
        weekday: "long",
        timeZone: PARIS_TIMEZONE,
    }).format(new Date(startISO));
}

function getSlotHourMinuteFR(startISO, PARIS_TIMEZONE) {
    return new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: PARIS_TIMEZONE,
    }).format(new Date(startISO));
}

function pickChoiceFromSpeech(text, digits, slots = [], normalizeText, helpers) {
    if (digits === "1") return 0;
    if (digits === "2") return 1;

    if (typeof normalizeText !== "function") return null;
    if (!helpers) return null;

    const t = normalizeText(text);
    const a = slots?.[0];
    const b = slots?.[1] || slots?.[0];

    if (!t) return null;

    if (/\b(premier|premiere|1|un)\b/.test(t) || /\ble 1\b/.test(t)) return 0;
    if (/\b(deuxieme|second|seconde|2|deux)\b/.test(t) || /\ble 2\b/.test(t)) return 1;

    if (t.includes("plus tot") || t.includes("le plus tot")) return 0;
    if (t.includes("plus tard") || t.includes("le plus tard")) return 1;

    if (a && b) {
        const aDay = normalizeText(helpers.getSlotWeekdayFR?.(a.start) || "");
        const bDay = normalizeText(helpers.getSlotWeekdayFR?.(b.start) || "");
        const aHm = normalizeText((helpers.getSlotHourMinuteFR?.(a.start) || "").replace(":", "h"));
        const bHm = normalizeText((helpers.getSlotHourMinuteFR?.(b.start) || "").replace(":", "h"));

        const aHour = helpers.getHourInParis?.(a.start);
        const bHour = helpers.getHourInParis?.(b.start);

        const aHourOnly = Number.isFinite(aHour) ? `${String(aHour).padStart(2, "0")}h` : "";
        const bHourOnly = Number.isFinite(bHour) ? `${String(bHour).padStart(2, "0")}h` : "";

        const aName = normalizeText(a.practitionerName || "");
        const bName = normalizeText(b.practitionerName || "");

        if (aDay && t.includes(aDay) && (!bDay || !t.includes(bDay))) return 0;
        if (bDay && t.includes(bDay) && (!aDay || !t.includes(aDay))) return 1;

        if (aHm && (t.includes(aHm) || t.includes(aHm.replace("h", " h ")))) return 0;
        if (bHm && (t.includes(bHm) || t.includes(bHm.replace("h", " h ")))) return 1;

        if (aHourOnly && t.includes(aHourOnly) && (!bHourOnly || !t.includes(bHourOnly))) return 0;
        if (bHourOnly && t.includes(bHourOnly) && (!aHourOnly || !t.includes(aHourOnly))) return 1;

        if (aName && t.includes(aName) && (!bName || !t.includes(bName))) return 0;
        if (bName && t.includes(bName) && (!aName || !t.includes(aName))) return 1;
    }

    return null;
}

module.exports = {
    getHourInParis,
    getMinutesInParis,
    slotMatchesTimePreference,
    filterSlotsByTimePreference,
    hydrateSlotsWithDefaultPractitioner,
    getSlotWeekdayFR,
    getSlotHourMinuteFR,
    pickChoiceFromSpeech,
};