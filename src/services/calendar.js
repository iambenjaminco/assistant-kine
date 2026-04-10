// src/services/calendar.js
const { google } = require("googleapis");
const { getAuth } = require("../config/googleAuth");

const {
    acquireSlotLock,
    releaseSlotLock,
} = require("./slotLock");

const DEFAULT_TIMEZONE = "Europe/Paris";
const DEFAULT_SLOT_MINUTES = 30;
const DEFAULT_FIRST_APPOINTMENT_MINUTES = 45;
const DEFAULT_MIN_LEAD_MINUTES = 60;
const DEFAULT_LOOKAHEAD_DAYS = 7;
const DEFAULT_MAX_SUGGESTIONS = 2;

const TIME_PREFERENCE_RULES = {

    EARLY_MORNING: {
        key: "EARLY_MORNING",
        label: "en début de matinée",
        keywords: [
            "debut de matinee",
            "début de matinée",
            "debut de matine",
            "début de matiné",
            "en debut de matinee",
            "en début de matinée",
            "en debut de matine",
            "en début de matiné",
            "tot le matin",
            "tôt le matin",
            "vers 8h",
            "vers 9h",
        ],
        startMinutes: 8 * 60,
        endMinutes: 10 * 60,
    },

    LATE_MORNING: {
        key: "LATE_MORNING",
        label: "en fin de matinée",
        keywords: [
            "fin de matinee",
            "fin de matinée",
            "fin de matine",
            "fin de matiné",
            "en fin de matinee",
            "en fin de matinée",
            "en fin de matine",
            "en fin de matiné",
            "vers 10h",
            "vers 11h",
        ],
        startMinutes: 10 * 60,
        endMinutes: 12 * 60,
    },
    MORNING: {
        key: "MORNING",
        label: "le matin",
        keywords: ["matin", "matinee", "matinée", "le matin"],
        startMinutes: 8 * 60,
        endMinutes: 12 * 60,
    },
    EARLY_AFTERNOON: {
        key: "EARLY_AFTERNOON",
        label: "en début d'après-midi",
        keywords: [
            "debut d'apres midi",
            "debut d'apres-midi",
            "début d'après midi",
            "début d'après-midi",
            "en debut d'apres midi",
            "en debut d'apres-midi",
            "en début d'après midi",
            "en début d'après-midi",
            "vers 14h",
            "vers 15h",
        ],
        startMinutes: 14 * 60,
        endMinutes: 16 * 60,
    },

    LATE_AFTERNOON: {
        key: "LATE_AFTERNOON",
        label: "en fin d'après-midi",
        keywords: [
            "fin d'apres midi",
            "fin d'apres-midi",
            "fin d'après midi",
            "fin d'après-midi",
            "en fin d'apres midi",
            "en fin d'apres-midi",
            "en fin d'après midi",
            "en fin d'après-midi",
            "fin de journee",
            "fin de journée",
            "apres le travail",
            "après le travail",
            "plus tard",
            "plus tard dans la journee",
            "plus tard dans la journée",
        ],
        startMinutes: 17 * 60,
        endMinutes: 19 * 60,
    },

    AFTERNOON: {
        key: "AFTERNOON",
        label: "l'après-midi",
        keywords: [
            "apres midi",
            "apres-midi",
            "après midi",
            "après-midi",
            "aprem",
            "l'apres midi",
            "l'apres-midi",
            "l'après midi",
            "l'après-midi",
            "dans l'apres midi",
            "dans l'apres-midi",
            "dans l'après midi",
            "dans l'après-midi",
        ],
        startMinutes: 14 * 60,
        endMinutes: 19 * 60,
    },
    EVENING: {
        key: "EVENING",
        label: "en soirée",
        keywords: ["soir", "soiree", "soirée", "en soiree", "en soirée"],
        startMinutes: 18 * 60,
        endMinutes: 19 * 60,
    },
};

const PRIORITY_PREFERENCE_RULES = {
    EARLIEST: {
        key: "EARLIEST",
        label: "le plus tôt possible",
        keywords: [
            "le plus tot possible",
            "le plus tôt possible",
            "au plus vite",
            "des que possible",
            "dès que possible",
            "le premier creneau disponible",
            "le premier créneau disponible",
            "au plus tot",
            "au plus tôt",
            "le plus vite possible",
            "le plus tot possible dans la journee",
            "le plus tôt possible dans la journée",
            "tot dans la journee",
            "tôt dans la journée",
        ],
    },
    LATEST: {
        key: "LATEST",
        label: "le plus tard possible",
        keywords: [
            "le plus tard possible",
            "le plus tard",
            "le dernier creneau",
            "le dernier créneau",
            "le dernier creneau possible",
            "le dernier créneau possible",
            "le plus tardif possible",
            "le plus tard possible dans la journee",
            "le plus tard possible dans la journée",
        ],
    },
    FLEXIBLE: {
        key: "FLEXIBLE",
        label: "n'importe quand",
        keywords: [
            "n'importe quand",
            "nimporte quand",
            "comme vous voulez",
            "je suis flexible",
            "peu importe",
            "ca m'est egal",
            "ça m'est égal",
            "ca m'egal",
            "ça m'egal",
        ],
    },
};


function logInfo(event, data = {}) {
    console.log(`[CALENDAR][${event}]`, data);
}

function logWarn(event, data = {}) {
    console.warn(`[CALENDAR][${event}]`, data);
}

function logError(event, data = {}) {
    console.error(`[CALENDAR][${event}]`, data);
}

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

function normalizePhone(s) {
    return (s || "").toString().replace(/\D/g, "");
}


function inferAppointmentTypeFromEvent(event = {}) {
    const text = [
        event.summary || "",
        event.description || "",
    ]
        .join(" ")
        .toLowerCase();

    if (
        text.includes("premier rendez-vous") ||
        text.includes("premiere consultation") ||
        text.includes("nouveau patient") ||
        text.includes("premier rendez vous")
    ) {
        return "FIRST";
    }

    return "FOLLOW_UP";
}

function computeEventDurationMinutes(startISO, endISO) {
    const start = new Date(startISO).getTime();
    const end = new Date(endISO).getTime();

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
    }

    return Math.round((end - start) / 60000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
}

function isSlotBusy(slotStart, slotEnd, busyList) {
    for (const b of busyList) {
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end);
        if (overlaps(slotStart, slotEnd, bStart, bEnd)) return true;
    }
    return false;
}

function getTimeZoneForCabinet(cabinet) {
    return cabinet?.timezone || DEFAULT_TIMEZONE;
}

function getCabinetSlotStep(cabinet) {
    const n = Number(cabinet?.scheduling?.slotStepMinutes);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOT_MINUTES;
}

function getCabinetMinLeadMinutes(cabinet) {
    const n = Number(cabinet?.scheduling?.minLeadMinutes);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_LEAD_MINUTES;
}

function getCabinetLookaheadDays(cabinet) {
    const n = Number(cabinet?.scheduling?.lookaheadDays);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOOKAHEAD_DAYS;
}

function getCabinetMaxSuggestions(cabinet) {
    const n = Number(cabinet?.scheduling?.maxSuggestions);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SUGGESTIONS;
}

function resolveSlotMinutes({
    durationMinutes,
    appointmentType,
    cabinet,
}) {
    const explicitDuration = Number(durationMinutes);
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
        return explicitDuration;
    }

    const first = Number(
        cabinet?.appointmentDurations?.first ??
        cabinet?.scheduling?.appointmentDurations?.first
    );

    const followUp = Number(
        cabinet?.appointmentDurations?.followUp ??
        cabinet?.scheduling?.appointmentDurations?.followUp
    );

    if (appointmentType === "FIRST") {
        return Number.isFinite(first) && first > 0
            ? first
            : DEFAULT_FIRST_APPOINTMENT_MINUTES;
    }

    return Number.isFinite(followUp) && followUp > 0
        ? followUp
        : DEFAULT_SLOT_MINUTES;
}

function getCalendarContext(cabinet = null) {
    const timezone = getTimeZoneForCabinet(cabinet);
    return { cabinet, timezone };
}

function getDatePartsInTimezone(dateOrIso, timezone) {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);

    const parts = new Intl.DateTimeFormat("fr-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(d);

    return {
        year: Number(parts.find((p) => p.type === "year")?.value || NaN),
        month: Number(parts.find((p) => p.type === "month")?.value || NaN),
        day: Number(parts.find((p) => p.type === "day")?.value || NaN),
    };
}

function getDateKeyInTimezone(dateOrIso, timezone) {
    const { year, month, day } = getDatePartsInTimezone(dateOrIso, timezone);
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function getIsoDowInTimezone(dateOrIso, timezone) {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);

    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
    }).format(d);

    const map = {
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 7,
    };

    return map[weekday] || null;
}

function getMinutesInTimezone(dateOrIso, timezone) {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);

    const formatter = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone,
    });

    const parts = formatter.formatToParts(d);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || NaN);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || NaN);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

function parseHHMMToMinutes(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return null;
    const [h, m] = hhmm.split(":").map(Number);

    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;

    return h * 60 + m;
}

function formatMinutesSpeech(totalMinutes) {
    if (!Number.isFinite(totalMinutes)) return "";
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    if (m === 0) return `${h}h`;
    return `${h}h${String(m).padStart(2, "0")}`;
}

function formatRangesSpeech(ranges = []) {
    const normalized = ranges
        .map((r) => ({
            startMinutes: parseHHMMToMinutes(r.start),
            endMinutes: parseHHMMToMinutes(r.end),
        }))
        .filter(
            (r) =>
                Number.isFinite(r.startMinutes) &&
                Number.isFinite(r.endMinutes) &&
                r.endMinutes > r.startMinutes
        )
        .map(
            (r) =>
                `de ${formatMinutesSpeech(r.startMinutes)} à ${formatMinutesSpeech(
                    r.endMinutes
                )}`
        );

    if (!normalized.length) return "";
    if (normalized.length === 1) return normalized[0];
    if (normalized.length === 2) return `${normalized[0]} et ${normalized[1]}`;

    return `${normalized.slice(0, -1).join(", ")} et ${normalized[normalized.length - 1]
        }`;
}

function buildClosedSpeech({ status, reason, ranges }) {
    const rangesSpeech = formatRangesSpeech(ranges);

    if (status === "CABINET_CLOSED_DAY") {
        return reason
            ? `Le cabinet est fermé ce jour-là pour ${reason.toLowerCase()}.`
            : "Le cabinet est fermé ce jour-là.";
    }

    if (status === "OUTSIDE_OPENING_HOURS") {
        if (rangesSpeech) {
            return `Le cabinet est fermé à cet horaire. Il est ouvert ${rangesSpeech}.`;
        }
        return "Le cabinet est fermé à cet horaire.";
    }

    return "Le cabinet est fermé.";
}

function dateAtMinutesInTimezone(dayDate, totalMinutes, timezone = DEFAULT_TIMEZONE) {
    const { year, month, day } = getDatePartsInTimezone(dayDate, timezone);

    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;

    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

    const tzAsLocal = new Date(
        utcGuess.toLocaleString("en-US", { timeZone: timezone })
    );

    const offsetMs = utcGuess.getTime() - tzAsLocal.getTime();

    return new Date(utcGuess.getTime() + offsetMs);
}

function dateAtTime(dayDate, hhmm, timezone = DEFAULT_TIMEZONE) {
    const totalMinutes = parseHHMMToMinutes(hhmm);
    return dateAtMinutesInTimezone(dayDate, totalMinutes, timezone);
}

function parseFromDateInput(fromDate, timezone = DEFAULT_TIMEZONE) {
    if (fromDate instanceof Date) {
        return new Date(fromDate);
    }

    const raw = String(fromDate || "").trim();
    if (!raw) return new Date(NaN);

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [year, month, day] = raw.split("-").map(Number);

        // On ancre la date au milieu de journée dans le fuseau du cabinet
        // pour éviter qu’un minuit local devienne "la veille" côté serveur.
        return dateAtMinutesInTimezone(
            new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0)),
            12 * 60,
            timezone
        );
    }

    return new Date(raw);
}

function addDaysInTimezone(dateOrIso, days, timezone = DEFAULT_TIMEZONE) {
    const { year, month, day } = getDatePartsInTimezone(dateOrIso, timezone);
    const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() + days);
    return anchor;
}

function getEasterDateUTC(year) {
    const f = Math.floor;
    const a = year % 19;
    const b = f(year / 100);
    const c = year % 100;
    const d = f(b / 4);
    const e = b % 4;
    const g = f((8 * b + 13) / 25);
    const h = (19 * a + b - d - g + 15) % 30;
    const j = f(c / 4);
    const k = c % 4;
    const m = (a + 11 * h) / 319;
    const r = (2 * e + 2 * j - k - h + f(m) + 32) % 7;
    const n = f((h - f(m) + r + 90) / 25);
    const p = (h - f(m) + r + n + 19) % 32;

    return new Date(Date.UTC(year, n - 1, p));
}

function addDaysUTC(date, days) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function formatUTCDateKey(date) {
    return date.toISOString().slice(0, 10);
}

function getFrenchPublicHolidayKeys(year) {
    const easter = getEasterDateUTC(year);
    const easterMonday = addDaysUTC(easter, 1);
    const ascension = addDaysUTC(easter, 39);
    const pentecostMonday = addDaysUTC(easter, 50);

    return new Set([
        `${year}-01-01`,
        formatUTCDateKey(easterMonday),
        `${year}-05-01`,
        `${year}-05-08`,
        formatUTCDateKey(ascension),
        formatUTCDateKey(pentecostMonday),
        `${year}-07-14`,
        `${year}-08-15`,
        `${year}-11-01`,
        `${year}-11-11`,
        `${year}-12-25`,
    ]);
}

function isFrenchPublicHoliday(dateOrIso, timezone) {
    const dateKey = getDateKeyInTimezone(dateOrIso, timezone);
    const year = Number(dateKey.slice(0, 4));
    return getFrenchPublicHolidayKeys(year).has(dateKey);
}

function isDateWithinClosedPeriod(dateKey, period) {
    if (!period?.start || !period?.end) return false;

    const startKey = String(period.start).slice(0, 10);
    const endKey = String(period.end).slice(0, 10);

    return dateKey >= startKey && dateKey <= endKey;
}

function getOpeningOverrideForDate(dateKey, cabinet) {
    return (cabinet?.openingOverrides || []).find((item) => item?.date === dateKey) || null;
}

function getClosedDateForDate(dateKey, cabinet) {
    return (cabinet?.closedDates || []).find((item) => item?.date === dateKey) || null;
}

function getClosedPeriodForDate(dateKey, cabinet) {
    return (cabinet?.closedPeriods || []).find((item) =>
        isDateWithinClosedPeriod(dateKey, item)
    ) || null;
}

function getJsDowInTimezone(dateOrIso, timezone) {
    const isoDow = getIsoDowInTimezone(dateOrIso, timezone);
    if (!isoDow) return null;
    return isoDow % 7; // ISO 7 (dimanche) -> JS 0
}

function normalizeDowValue(value) {
    if (value === null || value === undefined) return null;

    if (typeof value === "number" && Number.isFinite(value)) {
        if (value >= 1 && value <= 7) return value; // ISO
        if (value >= 0 && value <= 6) return value === 0 ? 7 : value; // JS -> ISO
        return null;
    }

    const raw = normalizeText(String(value));

    const map = {
        lundi: 1,
        monday: 1,
        mon: 1,

        mardi: 2,
        tuesday: 2,
        tue: 2,
        tues: 2,

        mercredi: 3,
        wednesday: 3,
        wed: 3,

        jeudi: 4,
        thursday: 4,
        thu: 4,
        thur: 4,
        thurs: 4,

        vendredi: 5,
        friday: 5,
        fri: 5,

        samedi: 6,
        saturday: 6,
        sat: 6,

        dimanche: 7,
        sunday: 7,
        sun: 7,
    };

    if (map[raw]) return map[raw];

    if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (n >= 1 && n <= 7) return n;
        if (n >= 0 && n <= 6) return n === 0 ? 7 : n;
    }

    return null;
}

function extractRuleDowValues(rule) {
    if (!rule || typeof rule !== "object") return [];

    const candidates = [
        rule.dow,
        rule.days,
        rule.daysOfWeek,
        rule.day,
    ];

    const values = [];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            values.push(...candidate);
        } else if (candidate !== undefined && candidate !== null) {
            values.push(candidate);
        }
    }

    return values
        .map(normalizeDowValue)
        .filter((v) => Number.isFinite(v));
}

function getBaseOpeningRangesForDate(dateOrIso, cabinet, timezone) {
    const isoDow = getIsoDowInTimezone(dateOrIso, timezone);

    const openingHours = Array.isArray(cabinet?.openingHours)
        ? cabinet.openingHours
        : Array.isArray(cabinet?.scheduling?.openingHours)
            ? cabinet.scheduling.openingHours
            : [];

    if (!isoDow) return [];

    logInfo("OPENING_HOURS_SOURCE", {
        cabinetKey: cabinet?.key || null,
        hasRootOpeningHours: Array.isArray(cabinet?.openingHours),
        hasSchedulingOpeningHours: Array.isArray(cabinet?.scheduling?.openingHours),
        openingHoursCount: openingHours.length,
        isoDow,
    });

    const rule = openingHours.find((r) => {
        const dowValues = extractRuleDowValues(r);
        return dowValues.includes(isoDow);
    });

    return Array.isArray(rule?.ranges) ? rule.ranges : [];
}

function getCabinetDayAvailability(dateOrIso, cabinet) {
    const timezone = getTimeZoneForCabinet(cabinet);
    const dateKey = getDateKeyInTimezone(dateOrIso, timezone);
    logInfo("DAY_AVAILABILITY_CHECK", {
        cabinetKey: cabinet?.key || null,
        dateKey,
        timezone,
        isoDow: getIsoDowInTimezone(dateOrIso, timezone),
        jsDow: getJsDowInTimezone(dateOrIso, timezone),
        openingHours: cabinet?.openingHours || [],
    });

    const openingOverride = getOpeningOverrideForDate(dateKey, cabinet);
    if (openingOverride) {
        const ranges = Array.isArray(openingOverride.ranges)
            ? openingOverride.ranges
            : [];
        return {
            isClosed: ranges.length === 0,
            status: ranges.length ? "OPENING_OVERRIDE" : "CABINET_CLOSED_DAY",
            reason: openingOverride.reason || null,
            ranges,
            dateKey,
            timezone,
        };
    }

    const closedDate = getClosedDateForDate(dateKey, cabinet);
    if (closedDate) {
        return {
            isClosed: true,
            status: "CABINET_CLOSED_DAY",
            reason: closedDate.reason || "fermeture exceptionnelle",
            ranges: [],
            dateKey,
            timezone,
        };
    }

    const closedPeriod = getClosedPeriodForDate(dateKey, cabinet);
    if (closedPeriod) {
        return {
            isClosed: true,
            status: "CABINET_CLOSED_DAY",
            reason: closedPeriod.reason || "fermeture exceptionnelle",
            ranges: [],
            dateKey,
            timezone,
        };
    }

    if (
        cabinet?.observesPublicHolidays &&
        cabinet?.publicHolidayCountry === "FR" &&
        isFrenchPublicHoliday(dateOrIso, timezone)
    ) {
        return {
            isClosed: true,
            status: "CABINET_CLOSED_DAY",
            reason: "jour férié",
            ranges: [],
            dateKey,
            timezone,
        };
    }

    const ranges = getBaseOpeningRangesForDate(dateOrIso, cabinet, timezone);

    if (!ranges.length) {
        return {
            isClosed: true,
            status: "CABINET_CLOSED_DAY",
            reason: "fermeture habituelle",
            ranges: [],
            dateKey,
            timezone,
        };
    }

    return {
        isClosed: false,
        status: "OPEN",
        reason: null,
        ranges,
        dateKey,
        timezone,
    };
}

function isWithinRangesByMinutes(targetStartMinutes, targetEndMinutes, ranges = []) {
    return ranges.some((range) => {
        const startMinutes = parseHHMMToMinutes(range.start);
        const endMinutes = parseHHMMToMinutes(range.end);

        if (
            !Number.isFinite(startMinutes) ||
            !Number.isFinite(endMinutes) ||
            endMinutes <= startMinutes
        ) {
            return false;
        }

        return (
            targetStartMinutes >= startMinutes &&
            targetEndMinutes <= endMinutes
        );
    });
}

function matchesTimePreference(slotStart, timePreference, timezone) {
    const rule = getTimePreferenceRule(timePreference);
    if (!rule) return true;

    const slotMinutes = getMinutesInTimezone(slotStart, timezone);
    if (!Number.isFinite(slotMinutes)) return true;

    return slotMinutes >= rule.startMinutes && slotMinutes < rule.endMinutes;
}

function practitionerSortKey(practitioner) {
    return normalizeText(practitioner?.name || "");
}

function buildOrderedPractitioners(practitioners) {
    return [...practitioners].sort((a, b) => {
        const aKey = practitionerSortKey(a);
        const bKey = practitionerSortKey(b);
        return aKey.localeCompare(bKey, "fr");
    });
}

function scoreSlotForTargetHour(slot, targetHourMinutes, timezone) {
    if (!Number.isFinite(targetHourMinutes)) return 0;
    const slotMinutes = getMinutesInTimezone(slot.start, timezone);
    if (!Number.isFinite(slotMinutes)) return 9999;
    return Math.abs(slotMinutes - targetHourMinutes);
}

function sortSlotsByTargetHour(slots, targetHourMinutes, timezone) {
    return [...(slots || [])].sort((a, b) => {
        const diffA = scoreSlotForTargetHour(a, targetHourMinutes, timezone);
        const diffB = scoreSlotForTargetHour(b, targetHourMinutes, timezone);

        if (diffA !== diffB) return diffA - diffB;

        const aTime = new Date(a.start).getTime();
        const bTime = new Date(b.start).getTime();
        return aTime - bTime;
    });
}

function groupSlotsByDay(slots, timezone) {
    const groups = new Map();

    for (const slot of slots || []) {
        const key = getDateKeyInTimezone(slot.start, timezone);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(slot);
    }

    return groups;
}

function pickBestDayForTargetHour(groups, targetHourMinutes, timezone) {
    const entries = [...groups.entries()].map(([dayKey, slots]) => {
        const sorted = sortSlotsByTargetHour(slots, targetHourMinutes, timezone);
        const bestDiff = sorted.length
            ? scoreSlotForTargetHour(sorted[0], targetHourMinutes, timezone)
            : 9999;
        const firstStart = sorted.length
            ? new Date(sorted[0].start).getTime()
            : Number.MAX_SAFE_INTEGER;

        return {
            dayKey,
            slots: sorted,
            bestDiff,
            firstStart,
        };
    });

    entries.sort((a, b) => {
        if (a.bestDiff !== b.bestDiff) return a.bestDiff - b.bestDiff;
        return a.firstStart - b.firstStart;
    });

    return entries[0] || null;
}

function narrowSlotsAroundTargetHour(slots, targetHourMinutes, maxSuggestions, timezone) {
    if (!Number.isFinite(targetHourMinutes)) {
        return (slots || []).slice(0, maxSuggestions);
    }

    const sorted = sortSlotsByTargetHour(slots, targetHourMinutes, timezone);
    const strictWindow = sorted.filter(
        (slot) => scoreSlotForTargetHour(slot, targetHourMinutes, timezone) <= 60
    );

    const acceptableWindow = strictWindow.length
        ? strictWindow
        : sorted.filter(
            (slot) => scoreSlotForTargetHour(slot, targetHourMinutes, timezone) <= 90
        );

    if (!acceptableWindow.length) {
        return [];
    }

    const grouped = groupSlotsByDay(acceptableWindow, timezone);
    const bestDay = pickBestDayForTargetHour(grouped, targetHourMinutes, timezone);

    if (!bestDay) {
        return acceptableWindow.slice(0, maxSuggestions);
    }

    return bestDay.slots.slice(0, maxSuggestions);
}

function getTimePreferenceRule(timePreference) {
    if (!timePreference) return null;

    if (typeof timePreference === "string") {
        return TIME_PREFERENCE_RULES[timePreference] || null;
    }

    if (
        typeof timePreference === "object" &&
        Number.isFinite(timePreference.startMinutes) &&
        Number.isFinite(timePreference.endMinutes)
    ) {
        return timePreference;
    }

    return null;
}

function getPriorityPreferenceRule(priorityPreference) {
    if (!priorityPreference) return null;
    return PRIORITY_PREFERENCE_RULES[priorityPreference] || null;
}

function shouldPriorityOverrideTargetHour(priorityPreference) {
    const rule = getPriorityPreferenceRule(priorityPreference);
    if (!rule) return false;
    return rule.key === "EARLIEST" || rule.key === "LATEST" || rule.key === "FLEXIBLE";
}

function sortAvailableSlotsByPriority(slots, priorityPreference) {
    const available = [...(slots || [])];
    const rule = getPriorityPreferenceRule(priorityPreference);

    if (!rule || rule.key === "FLEXIBLE" || rule.key === "EARLIEST") {
        return available.sort(
            (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
        );
    }

    if (rule.key === "LATEST") {
        return available.sort(
            (a, b) => new Date(b.start).getTime() - new Date(a.start).getTime()
        );
    }

    return available.sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
}

function slotUniqueKey(slot) {
    return `${slot.calendarId}|${new Date(slot.start).toISOString()}|${new Date(
        slot.end
    ).toISOString()}`;
}

function dedupeSlots(slots = []) {
    const seen = new Set();
    const out = [];

    for (const slot of slots) {
        const key = slotUniqueKey(slot);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(slot);
    }

    return out;
}

function buildSlotSpeech(
    slots,
    { emptySpeech, timePreference, targetHourMinutes, priorityPreference, timezone } = {}
) {
    const available = slots || [];

    if (!available.length) {
        if (
            Number.isFinite(targetHourMinutes) &&
            !shouldPriorityOverrideTargetHour(priorityPreference)
        ) {
            const hh = String(Math.floor(targetHourMinutes / 60)).padStart(2, "0");
            const mm = String(targetHourMinutes % 60).padStart(2, "0");
            return `Je n’ai pas trouvé de disponibilité vers ${hh}h${mm}.`;
        }

        if (timePreference && getTimePreferenceRule(timePreference)) {
            return `Je n’ai pas trouvé de disponibilité ${getTimePreferenceRule(
                timePreference
            ).label}.`;
        }

        if (priorityPreference && getPriorityPreferenceRule(priorityPreference)) {
            return `Je n’ai pas trouvé de disponibilité pour ${getPriorityPreferenceRule(
                priorityPreference
            ).label}.`;
        }

        return emptySpeech || "Je n’ai pas trouvé de disponibilité.";
    }

    const a = available[0];
    const b = available[1] || available[0];

    if (b && b.start && a.start && b.start !== a.start) {
        return `Je peux vous proposer ${formatSlotFR(a.start, timezone)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
            } ou ${formatSlotFR(b.start, timezone)}${b.practitionerName ? ` avec ${b.practitionerName}` : ""
            }.`;
    }

    return `Je peux vous proposer ${formatSlotFR(a.start, timezone)}${a.practitionerName ? ` avec ${a.practitionerName}` : ""
        }.`;
}

function selectAvailableSlots({
    candidates,
    practitioners,
    busyByCal,
    cutoff,
    maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
    timePreference = null,
    targetHourMinutes = null,
    priorityPreference = null,
    timezone = DEFAULT_TIMEZONE,
}) {
    const orderedPractitioners = buildOrderedPractitioners(practitioners);
    const available = [];
    const seenKeys = new Set();

    for (const c of candidates) {
        if (c.start < cutoff) continue;
        if (!matchesTimePreference(c.start, timePreference, timezone)) continue;

        for (const p of orderedPractitioners) {
            const busy = busyByCal[p.calendarId] || [];
            if (isSlotBusy(c.start, c.end, busy)) continue;

            const key = `${p.calendarId}|${c.start.toISOString()}|${c.end.toISOString()}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            available.push({
                start: c.start,
                end: c.end,
                calendarId: p.calendarId,
                practitionerName: p.name,
            });
            break;
        }
    }

    if (!available.length) return [];

    const effectiveTargetHourMinutes = shouldPriorityOverrideTargetHour(priorityPreference)
        ? null
        : targetHourMinutes;

    if (Number.isFinite(effectiveTargetHourMinutes)) {
        return narrowSlotsAroundTargetHour(
            available,
            effectiveTargetHourMinutes,
            maxSuggestions,
            timezone
        );
    }

    const prioritized = sortAvailableSlotsByPriority(available, priorityPreference);

    if (priorityPreference === "LATEST") {
        return prioritized
            .slice(0, maxSuggestions)
            .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }

    return prioritized.slice(0, maxSuggestions);
}

function generateDynamicCandidateSlots({
    startDate,
    days,
    slotMinutes,
    cabinet,
}) {
    const timezone = getTimeZoneForCabinet(cabinet);
    const stepMinutes = getCabinetSlotStep(cabinet);
    const allCandidates = [];
    const seen = new Set();

    for (let i = 0; i < days; i++) {
        const day = addDaysInTimezone(startDate, i, timezone);

        const availability = getCabinetDayAvailability(day, cabinet);
        logInfo("CANDIDATE_DAY_CHECK", {
            cabinetKey: cabinet?.key || null,
            dayISO: day.toISOString(),
            dayKey: getDateKeyInTimezone(day, timezone),
            isClosed: availability.isClosed,
            reason: availability.reason || null,
            ranges: availability.ranges || [],
        });
        if (availability.isClosed || !availability.ranges.length) continue;

        for (const range of availability.ranges) {
            const rangeStartMinutes = parseHHMMToMinutes(range.start);
            const rangeEndMinutes = parseHHMMToMinutes(range.end);

            if (
                !Number.isFinite(rangeStartMinutes) ||
                !Number.isFinite(rangeEndMinutes) ||
                rangeEndMinutes <= rangeStartMinutes
            ) {
                continue;
            }

            for (
                let startMinutes = rangeStartMinutes;
                startMinutes + slotMinutes <= rangeEndMinutes;
                startMinutes += stepMinutes
            ) {
                const candidateStart = dateAtMinutesInTimezone(day, startMinutes, timezone);
                const candidateEnd = new Date(candidateStart);
                candidateEnd.setMinutes(candidateEnd.getMinutes() + slotMinutes);

                const key = `${candidateStart.toISOString()}|${candidateEnd.toISOString()}`;
                if (seen.has(key)) continue;

                seen.add(key);
                allCandidates.push({
                    start: candidateStart,
                    end: candidateEnd,
                });
            }
        }
    }

    return allCandidates.sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
}

function extractPatientNameFromEvent(ev) {
    const description = ev?.description || "";
    const lines = description.split("\n").map((line) => line.trim());

    const patientLine = lines.find((line) =>
        normalizeText(line).startsWith("patient :")
    );

    if (!patientLine) return null;

    const patientName = patientLine.split(":").slice(1).join(":").trim();
    return patientName || null;
}

function extractPhoneFromEvent(ev) {
    const description = ev?.description || "";
    const lines = description.split("\n").map((line) => line.trim());

    const phoneLine = lines.find((line) => {
        const normalized = normalizeText(line);
        return (
            normalized.startsWith("telephone :") ||
            normalized.startsWith("téléphone :")
        );
    });

    if (!phoneLine) return "";

    const phone = phoneLine.split(":").slice(1).join(":").trim();
    return normalizePhone(phone);
}

function parseTargetHourMinutes(text = "") {
    const t = normalizeText(text);

    if (t.includes("midi et demi")) return 12 * 60 + 30;
    if (t.includes("midi")) return 12 * 60;
    if (t.includes("minuit")) return 0;

    if (t.includes("et quart")) {
        const quarterMatch = t.match(/\b(\d{1,2})\s*h\b/);
        if (quarterMatch) {
            const hour = Number(quarterMatch[1]);
            if (Number.isFinite(hour)) return hour * 60 + 15;
        }
    }

    if (t.includes("moins le quart")) {
        const quarterLessMatch = t.match(/\b(\d{1,2})\s*h\b/);
        if (quarterLessMatch) {
            const hour = Number(quarterLessMatch[1]);
            if (Number.isFinite(hour)) return hour * 60 - 15;
        }
    }

    const explicitTimeMatch = t.match(
        /\b(?:vers|a|à|aux alentours de|autour de)?\s*(\d{1,2})\s*h\s*(\d{2})?\b/
    );
    if (explicitTimeMatch) {
        const hour = parseInt(explicitTimeMatch[1], 10);
        const minute = explicitTimeMatch[2]
            ? parseInt(explicitTimeMatch[2], 10)
            : 0;

        if (
            Number.isFinite(hour) &&
            hour >= 0 &&
            hour <= 23 &&
            Number.isFinite(minute) &&
            minute >= 0 &&
            minute <= 59
        ) {
            return hour * 60 + minute;
        }
    }

    return null;
}

function detectTimePreference(text = "") {
    const t = normalizeText(text);

    for (const rule of Object.values(TIME_PREFERENCE_RULES)) {
        if (rule.keywords.some((keyword) => t.includes(normalizeText(keyword)))) {
            return rule;
        }
    }

    const targetHourMinutes = parseTargetHourMinutes(t);
    if (Number.isFinite(targetHourMinutes)) {
        const hour = Math.floor(targetHourMinutes / 60);
        const minute = targetHourMinutes % 60;
        const hh = String(hour).padStart(2, "0");
        const mm = String(minute).padStart(2, "0");

        return {
            key: "EXPLICIT_HOUR",
            label: `vers ${hh}h${mm}`,
            startMinutes: targetHourMinutes,
            endMinutes: targetHourMinutes + 60,
        };
    }

    return null;
}

function detectPriorityPreference(text = "") {
    const t = normalizeText(text);

    for (const rule of Object.values(PRIORITY_PREFERENCE_RULES)) {
        if (rule.keywords.some((keyword) => t.includes(normalizeText(keyword)))) {
            return rule;
        }
    }

    return null;
}

async function getCalendarClient() {
    const auth = await getAuth();
    return google.calendar({ version: "v3", auth });
}

async function getBusyPeriods(calendar, calendarId, timeMin, timeMax, timezone) {
    const res = await calendar.freebusy.query({
        requestBody: {
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            timeZone: timezone,
            items: [{ id: calendarId }],
        },
    });

    const cal = res.data.calendars?.[calendarId];
    return cal?.busy ?? [];
}

function buildExactRequestedSlots({
    requestedDate,
    practitioners,
    busyByCal,
}) {
    const available = [];

    for (const practitioner of buildOrderedPractitioners(practitioners)) {
        const busy = busyByCal[practitioner.calendarId] || [];
        if (isSlotBusy(requestedDate.start, requestedDate.end, busy)) continue;

        available.push({
            start: requestedDate.start,
            end: requestedDate.end,
            calendarId: practitioner.calendarId,
            practitionerName: practitioner.name,
        });
    }

    return available;
}

function sortSameDayAlternatives({
    slots,
    targetHourMinutes,
    timezone,
    maxSuggestions,
}) {
    const sorted = sortSlotsByTargetHour(slots, targetHourMinutes, timezone);
    return dedupeSlots(sorted).slice(0, maxSuggestions);
}

function buildSuggestResponse({
    status,
    slots,
    speech,
    context = {},
}) {
    return {
        status,
        slots: slots || [],
        speech: speech || "",
        context,
    };
}

function formatSlotFR(dateOrIso, timezone = DEFAULT_TIMEZONE) {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    if (Number.isNaN(d.getTime())) return "une date invalide";

    const datePart = d.toLocaleDateString("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: timezone,
    });

    const timePart = d.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
    });

    return `${datePart} à ${timePart}`;
}

async function createAppointment({

    calendarId,
    patientName,
    reason = "Rendez-vous kiné",
    startDate,
    endDate,
    phone,
    appointmentType,
    durationMinutes,
    cabinet,
}) {
    if (!calendarId) {
        throw new Error("calendarId requis");
    }
    assertCabinet(cabinet);
    const calendar = await getCalendarClient();
    const timezone = getTimeZoneForCabinet(cabinet);

    const start = new Date(startDate);
    let end = new Date(endDate);

    if (!(end > start)) {
        const effectiveMinutes = resolveSlotMinutes({
            durationMinutes,
            appointmentType,
            cabinet,
        });
        end = new Date(start);
        end.setMinutes(end.getMinutes() + effectiveMinutes);
    }

    const effectiveDurationMinutes = Math.round(
        (end.getTime() - start.getTime()) / 60000
    );

    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const safePatientName = String(patientName || "").trim() || "Patient";

    const lines = [
        reason || "Rendez-vous kiné",
        `Patient : ${safePatientName}`,
        ...(phone ? [`Téléphone : ${phone}`] : []),
        ...(appointmentType ? [`Type : ${appointmentType}`] : []),
        `Durée : ${effectiveDurationMinutes} min`,
        ...(cabinet?.key ? [`Cabinet : ${cabinet.key}`] : []),
        "Origine : Assistant vocal SaaS",
        "Canal : Téléphone",
    ];

    const description = lines.join("\n");

    const event = {
        summary: `RDV kiné - ${safePatientName}`,
        description,
        start: { dateTime: startIso, timeZone: timezone },
        end: { dateTime: endIso, timeZone: timezone },
    };

    const res = await calendar.events.insert({
        calendarId,
        requestBody: event,
    });

    return res.data;
}

async function isSlotAvailable({
    calendarId,
    startDate,
    endDate,
    cabinet,
}) {
    if (!calendarId) {
        throw new Error("calendarId requis");
    }
    assertCabinet(cabinet);
    const calendar = await getCalendarClient();
    const timezone = getTimeZoneForCabinet(cabinet);

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (!(end > start)) {
        throw new Error("Créneau invalide : endDate doit être après startDate");
    }

    const res = await calendar.freebusy.query({
        requestBody: {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            timeZone: timezone,
            items: [{ id: calendarId }],
        },
    });

    const busy = res.data.calendars?.[calendarId]?.busy ?? [];
    return busy.length === 0;
}

async function bookAppointmentSafe({
    calendarId,
    patientName,
    reason,
    startDate,
    endDate,
    phone,
    appointmentType,
    durationMinutes,
    cabinet = null,
}) {
    if (!calendarId) {
        throw new Error("calendarId requis");
    }
    assertCabinet(cabinet);

    const effectiveCabinet = cabinet;
    const start = new Date(startDate);
    let end = new Date(endDate);

    if (!(end > start)) {
        const effectiveMinutes = resolveSlotMinutes({
            durationMinutes,
            appointmentType,
            cabinet: effectiveCabinet,
        });
        end = new Date(start);
        end.setMinutes(end.getMinutes() + effectiveMinutes);
    }

    const { ok: gotLock, token } = await acquireSlotLock(calendarId, start, end, 60_000);

    if (!gotLock) {
        logWarn("BOOK_SLOT_LOCKED", {
            cabinetKey: effectiveCabinet?.key || null,
            calendarId,
            startISO: start.toISOString(),
            endISO: end.toISOString(),
        });
        return { ok: false, code: "LOCKED" };
    }

    try {
        const ok = await isSlotAvailable({
            calendarId,
            startDate: start,
            endDate: end,
            cabinet: effectiveCabinet,
        });

        if (!ok) {
            logWarn("BOOK_SLOT_TAKEN", {
                cabinetKey: effectiveCabinet?.key || null,
                calendarId,
                startISO: start.toISOString(),
                endISO: end.toISOString(),
            });
            return { ok: false, code: "TAKEN" };
        }

        const event = await createAppointment({
            calendarId,
            patientName,
            reason,
            startDate: start,
            endDate: end,
            phone,
            appointmentType,
            durationMinutes,
            cabinet: effectiveCabinet,
        });

        return { ok: true, event };
    } finally {
        await releaseSlotLock(calendarId, start, end, token);
    }
}

function assertPractitioners(practitioners) {
    if (!Array.isArray(practitioners) || practitioners.length === 0) {
        throw new Error("practitioners requis (tableau non vide)");
    }

    for (const p of practitioners) {
        if (!p.calendarId) throw new Error("practitioner.calendarId manquant");
        if (!p.name) throw new Error("practitioner.name manquant");
    }
}

function assertCabinet(cabinet) {
    if (!cabinet) {
        throw new Error("cabinet requis");
    }

    if (!cabinet.key) {
        throw new Error("cabinet.key manquant");
    }
}

function buildCutoff(now, minLeadMinutes) {
    const cutoff = new Date(now);
    cutoff.setMinutes(cutoff.getMinutes() + minLeadMinutes);
    return cutoff;
}

function getSameDaySlots(slots, dateKey, timezone) {
    return (slots || []).filter(
        (slot) => getDateKeyInTimezone(slot.start, timezone) === dateKey
    );
}

async function suggestTwoSlotsNext7Days({
    cabinet,
    practitioners,
    days,
    durationMinutes,
    appointmentType,
    timePreference = null,
    targetHourMinutes = null,
    priorityPreference = null,
    maxSuggestions,
    minLeadMinutes,
}) {
    assertPractitioners(practitioners);
    assertCabinet(cabinet);

    const { timezone } = getCalendarContext(cabinet);
    const calendar = await getCalendarClient();

    const effectiveDays = Number.isFinite(Number(days))
        ? Number(days)
        : getCabinetLookaheadDays(cabinet);

    const effectiveMaxSuggestions = Number.isFinite(Number(maxSuggestions))
        ? Number(maxSuggestions)
        : getCabinetMaxSuggestions(cabinet);

    const effectiveMinLeadMinutes = Number.isFinite(Number(minLeadMinutes))
        ? Number(minLeadMinutes)
        : getCabinetMinLeadMinutes(cabinet);

    const slotMinutes = resolveSlotMinutes({
        durationMinutes,
        appointmentType,
        cabinet,
    });

    logInfo("RESOLVED_SLOT_MINUTES", {
        durationMinutes,
        appointmentType,
        cabinetKey: cabinet?.key || null,
        cabinetAppointmentDurations: cabinet?.appointmentDurations || null,
        cabinetSchedulingAppointmentDurations: cabinet?.scheduling?.appointmentDurations || null,
        resolvedSlotMinutes: slotMinutes,
    });

    const now = new Date();
    const timeMin = new Date(now);
    const timeMax = addDaysInTimezone(now, effectiveDays, timezone);

    const busyEntries = await Promise.all(
        practitioners.map(async (p) => {
            const busy = await getBusyPeriods(
                calendar,
                p.calendarId,
                timeMin,
                timeMax,
                timezone
            );
            return [p.calendarId, busy];
        })
    );

    const busyByCal = Object.fromEntries(busyEntries);
    const candidates = generateDynamicCandidateSlots({
        startDate: now,
        days: effectiveDays,
        slotMinutes,
        cabinet,
    });

    const cutoff = buildCutoff(now, effectiveMinLeadMinutes);

    const available = selectAvailableSlots({
        candidates,
        practitioners,
        busyByCal,
        cutoff,
        maxSuggestions: effectiveMaxSuggestions,
        timePreference,
        targetHourMinutes,
        priorityPreference,
        timezone,
    });

    logInfo("SUGGEST_NEXT_7_DAYS", {
        practitioners: practitioners.map((p) => p.name),
        cabinetKey: cabinet?.key || null,
        days: effectiveDays,
        slotMinutes,
        appointmentType: appointmentType || null,
        timePreference: timePreference?.key || timePreference || null,
        targetHourMinutes: Number.isFinite(targetHourMinutes) ? targetHourMinutes : null,
        priorityPreference,
        results: available.map((slot) => ({
            start: slot.start.toISOString(),
            end: slot.end.toISOString(),
            practitionerName: slot.practitionerName,
        })),
    });

    return buildSuggestResponse({
        status: available.length ? "AVAILABLE" : "NO_AVAILABILITY",
        slots: available.slice(0, effectiveMaxSuggestions),
        speech: buildSlotSpeech(available.slice(0, effectiveMaxSuggestions), {
            emptySpeech: "Je n’ai pas de créneau disponible sur les prochains jours.",
            timePreference,
            targetHourMinutes: shouldPriorityOverrideTargetHour(priorityPreference)
                ? null
                : targetHourMinutes,
            priorityPreference,
            timezone,
        }),
        context: {
            cabinetKey: cabinet?.key || null,
            timezone,
            slotMinutes,
        },
    });
}

async function suggestTwoSlotsFromDate({
    cabinet,
    practitioners,
    fromDate,
    days,
    durationMinutes,
    appointmentType,
    timePreference = null,
    targetHourMinutes = null,
    priorityPreference = null,
    maxSuggestions,
    minLeadMinutes,
}) {
    assertPractitioners(practitioners);
    assertCabinet(cabinet);

    const { timezone } = getCalendarContext(cabinet);
    const calendar = await getCalendarClient();

    const effectiveDays = Number.isFinite(Number(days))
        ? Number(days)
        : getCabinetLookaheadDays(cabinet);

    const effectiveMaxSuggestions = Number.isFinite(Number(maxSuggestions))
        ? Number(maxSuggestions)
        : getCabinetMaxSuggestions(cabinet);

    const effectiveMinLeadMinutes = Number.isFinite(Number(minLeadMinutes))
        ? Number(minLeadMinutes)
        : getCabinetMinLeadMinutes(cabinet);

    const slotMinutes = resolveSlotMinutes({
        durationMinutes,
        appointmentType,
        cabinet,
    });

    logInfo("RESOLVED_SLOT_MINUTES", {
        durationMinutes,
        appointmentType,
        cabinetKey: cabinet?.key || null,
        cabinetAppointmentDurations: cabinet?.appointmentDurations || null,
        cabinetSchedulingAppointmentDurations: cabinet?.scheduling?.appointmentDurations || null,
        resolvedSlotMinutes: slotMinutes,
    });

    const start = parseFromDateInput(fromDate, timezone);
    if (Number.isNaN(start.getTime())) {
        return buildSuggestResponse({
            status: "INVALID_FROM_DATE",
            slots: [],
            speech: "Je n'ai pas compris la date demandée.",
            context: {},
        });

    }

    logInfo("SUGGEST_FROM_DATE_PARSED", {
        cabinetKey: cabinet?.key || null,
        fromDateRaw: fromDate,
        parsedStartISO: Number.isNaN(start.getTime()) ? null : start.toISOString(),
        timezone,
    });
    const timeMax = addDaysInTimezone(start, effectiveDays, timezone);

    const busyEntries = await Promise.all(
        practitioners.map(async (p) => {
            const busy = await getBusyPeriods(
                calendar,
                p.calendarId,
                start,
                timeMax,
                timezone
            );
            return [p.calendarId, busy];
        })
    );

    const busyByCal = Object.fromEntries(busyEntries);

    const candidates = generateDynamicCandidateSlots({
        startDate: start,
        days: effectiveDays,
        slotMinutes,
        cabinet,
    });

    const now = new Date();
    const cutoff = buildCutoff(now, effectiveMinLeadMinutes);
    const effectiveCutoff = start > cutoff ? start : cutoff;

    const requestedDateKey = getDateKeyInTimezone(start, timezone);
    const dayAvailability = getCabinetDayAvailability(start, cabinet);

    logInfo("SUGGEST_FROM_DATE_START", {
        cabinetKey: cabinet?.key || null,
        requestedDateKey,
        timezone,
        slotMinutes,
        timePreference: timePreference?.key || timePreference || null,
        targetHourMinutes: Number.isFinite(targetHourMinutes) ? targetHourMinutes : null,
        priorityPreference: priorityPreference || null,
        openingRanges: dayAvailability.ranges || [],
        isClosed: dayAvailability.isClosed,
        closedReason: dayAvailability.reason || null,
    });

    if (dayAvailability.isClosed) {
        const speech = buildClosedSpeech({
            status: "CABINET_CLOSED_DAY",
            reason: dayAvailability.reason,
            ranges: dayAvailability.ranges,
        });

        logInfo("SUGGEST_FROM_DATE_CLOSED_DAY", {
            cabinetKey: cabinet?.key || null,
            requestedDateKey,
            reason: dayAvailability.reason || null,
        });

        return buildSuggestResponse({
            status: "CABINET_CLOSED_DAY",
            slots: [],
            speech,
            context: {
                cabinetKey: cabinet?.key || null,
                timezone,
                requestedDateKey,
                reason: dayAvailability.reason || null,
                ranges: dayAvailability.ranges || [],
            },
        });
    }

    const availableAll = selectAvailableSlots({
        candidates,
        practitioners,
        busyByCal,
        cutoff: effectiveCutoff,
        maxSuggestions: Math.max(effectiveMaxSuggestions, 8),
        timePreference,
        targetHourMinutes: shouldPriorityOverrideTargetHour(priorityPreference)
            ? null
            : targetHourMinutes,
        priorityPreference,
        timezone,
    });

    const sameDayAvailableAll = getSameDaySlots(
        availableAll,
        requestedDateKey,
        timezone
    );

    const exactRequestedHourActive =
        Number.isFinite(targetHourMinutes) &&
        !shouldPriorityOverrideTargetHour(priorityPreference);

    if (exactRequestedHourActive) {
        const requestedStartMinutes = targetHourMinutes;
        const requestedEndMinutes = targetHourMinutes + slotMinutes;

        if (
            !isWithinRangesByMinutes(
                requestedStartMinutes,
                requestedEndMinutes,
                dayAvailability.ranges
            )
        ) {
            const sameDayAlternatives = sortSameDayAlternatives({
                slots: sameDayAvailableAll,
                targetHourMinutes,
                timezone,
                maxSuggestions: effectiveMaxSuggestions,
            });

            return buildSuggestResponse({
                status: "OUTSIDE_OPENING_HOURS",
                slots: sameDayAlternatives,
                speech: buildClosedSpeech({
                    status: "OUTSIDE_OPENING_HOURS",
                    reason: null,
                    ranges: dayAvailability.ranges,
                }),
                context: {
                    cabinetKey: cabinet?.key || null,
                    timezone,
                    requestedDateKey,
                    targetHourMinutes,
                    ranges: dayAvailability.ranges,
                    sameDayAlternativesCount: sameDayAlternatives.length,
                },
            });
        }

        const exactStart = dateAtMinutesInTimezone(start, targetHourMinutes, timezone);
        const exactEnd = new Date(exactStart);
        exactEnd.setMinutes(exactEnd.getMinutes() + slotMinutes);

        const exactSlots = buildExactRequestedSlots({
            requestedDate: { start: exactStart, end: exactEnd },
            practitioners,
            busyByCal,
        }).filter((slot) => slot.start >= effectiveCutoff);

        if (exactSlots.length) {
            const sameDayAlternatives = sortSameDayAlternatives({
                slots: sameDayAvailableAll.filter(
                    (slot) => slotUniqueKey(slot) !== slotUniqueKey(exactSlots[0])
                ),
                targetHourMinutes,
                timezone,
                maxSuggestions: Math.max(0, effectiveMaxSuggestions - 1),
            });

            const finalSlots = dedupeSlots([
                exactSlots[0],
                ...sameDayAlternatives,
            ]).slice(0, effectiveMaxSuggestions);

            return buildSuggestResponse({
                status: "REQUESTED_TIME_AVAILABLE",
                slots: finalSlots,
                speech: buildSlotSpeech(finalSlots, {
                    targetHourMinutes,
                    timezone,
                }),
                context: {
                    cabinetKey: cabinet?.key || null,
                    timezone,
                    requestedDateKey,
                    targetHourMinutes,
                    exactMatch: true,
                },
            });
        }

        if (sameDayAvailableAll.length) {
            const sameDayAlternatives = sortSameDayAlternatives({
                slots: sameDayAvailableAll,
                targetHourMinutes,
                timezone,
                maxSuggestions: effectiveMaxSuggestions,
            });

            return buildSuggestResponse({
                status: "REQUESTED_TIME_TAKEN_SAME_DAY_ALTERNATIVES",
                slots: sameDayAlternatives,
                speech: "Le créneau demandé n’est plus disponible.",
                context: {
                    cabinetKey: cabinet?.key || null,
                    timezone,
                    requestedDateKey,
                    targetHourMinutes,
                },
            });
        }
    }

    if (sameDayAvailableAll.length) {
        const sameDayPreferred = Number.isFinite(targetHourMinutes)
            ? sortSameDayAlternatives({
                slots: sameDayAvailableAll,
                targetHourMinutes,
                timezone,
                maxSuggestions: effectiveMaxSuggestions,
            })
            : sortAvailableSlotsByPriority(
                sameDayAvailableAll,
                priorityPreference
            ).slice(0, effectiveMaxSuggestions);

        return buildSuggestResponse({
            status: "SAME_DAY_ALTERNATIVES",
            slots: sameDayPreferred,
            speech: buildSlotSpeech(sameDayPreferred, {
                timePreference,
                targetHourMinutes,
                priorityPreference,
                timezone,
            }),
            context: {
                cabinetKey: cabinet?.key || null,
                timezone,
                requestedDateKey,
            },
        });
    }

    const fallbackAvailable = sortAvailableSlotsByPriority(
        availableAll,
        priorityPreference
    ).slice(0, effectiveMaxSuggestions);

    if (fallbackAvailable.length) {
        return buildSuggestResponse({
            status: "NO_AVAILABILITY_ON_REQUESTED_DAY",
            slots: fallbackAvailable,
            speech: buildSlotSpeech(fallbackAvailable, {
                timePreference,
                targetHourMinutes,
                priorityPreference,
                timezone,
            }),
            context: {
                cabinetKey: cabinet?.key || null,
                timezone,
                requestedDateKey,
            },
        });
    }

    logInfo("SUGGEST_FROM_DATE_NO_AVAILABILITY", {
        cabinetKey: cabinet?.key || null,
        requestedDateKey,
        timePreference: timePreference?.key || timePreference || null,
        targetHourMinutes: Number.isFinite(targetHourMinutes)
            ? targetHourMinutes
            : null,
        priorityPreference: priorityPreference || null,
    });

    return buildSuggestResponse({
        status: "NO_AVAILABILITY",
        slots: [],
        speech: buildSlotSpeech([], {
            emptySpeech: "Je n’ai pas trouvé de disponibilité à partir de cette date.",
            timePreference,
            targetHourMinutes,
            priorityPreference,
            timezone,
        }),
        context: {
            cabinetKey: cabinet?.key || null,
            timezone,
            requestedDateKey,
        },
    });
}

async function findNextAppointmentSafe({ cabinet, practitioners, phone }) {
    assertPractitioners(practitioners);
    assertCabinet(cabinet);

    const { timezone } = getCalendarContext(cabinet);
    const calendar = await getCalendarClient();
    const phoneNorm = normalizePhone(phone);

    if (!phoneNorm) return null;

    const now = new Date();
    const timeMin = now.toISOString();

    let best = null;

    for (const p of practitioners) {
        let pageToken = undefined;

        do {
            const res = await calendar.events.list({
                calendarId: p.calendarId,
                timeMin,
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 250,
                pageToken,
            });

            const items = res.data.items || [];

            for (const ev of items) {
                if (ev.status === "cancelled") continue;

                const startISO = ev.start?.dateTime || ev.start?.date;
                if (!startISO) continue;
                if (!ev.start?.dateTime || !ev.end?.dateTime) continue;

                const eventPhone = extractPhoneFromEvent(ev);
                if (eventPhone !== phoneNorm) continue;

                const endISO = ev.end?.dateTime || ev.end?.date || null;
                const appointmentType = inferAppointmentTypeFromEvent(ev);
                const durationMinutes = computeEventDurationMinutes(startISO, endISO);

                const candidate = {
                    calendarId: p.calendarId,
                    eventId: ev.id,
                    startISO,
                    endISO,
                    summary: ev.summary || "",
                    patientName: extractPatientNameFromEvent(ev),
                    appointmentType,
                    durationMinutes,
                };

                if (!best) {
                    best = candidate;
                    continue;
                }

                const bestTime = new Date(best.startISO).getTime();
                const candTime = new Date(candidate.startISO).getTime();

                if (candTime < bestTime) best = candidate;
            }

            pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);
    }

    if (!best) return null;

    return {
        calendarId: best.calendarId,
        eventId: best.eventId,
        startISO: best.startISO,
        endISO: best.endISO,
        summary: best.summary,
        patientName: best.patientName,
        appointmentType: best.appointmentType,
        durationMinutes: best.durationMinutes,
        timezone,
        cabinetKey: cabinet?.key || null,
    };
}

async function addCallbackNoteToEvent({ calendarId, eventId }) {
    const calendar = await getCalendarClient();

    const { data: ev } = await calendar.events.get({
        calendarId,
        eventId,
    });

    const currentDescription = String(ev.description || "");
    const note = "Note : rappeler le client";

    if (currentDescription.includes(note)) {
        return { ok: true, alreadyPresent: true };
    }

    const updatedDescription = currentDescription
        ? `${currentDescription}\n${note}`
        : note;

    await calendar.events.patch({
        calendarId,
        eventId,
        requestBody: {
            description: updatedDescription,
        },
    });

    return { ok: true, alreadyPresent: false };
}

async function cancelAppointmentSafe({ calendarId, eventId }) {
    const calendar = await getCalendarClient();

    try {
        await calendar.events.delete({
            calendarId,
            eventId,
        });
        return { ok: true };
    } catch (error) {
        logError("DELETE_FAILED", {
            calendarId,
            eventId,
            message: error?.message,
        });

        return {
            ok: false,
            code: "DELETE_FAILED",
            message: error?.message || "Impossible de supprimer le rendez-vous",
        };
    }
}

module.exports = {
    createAppointment,
    formatSlotFR,
    isSlotAvailable,
    bookAppointmentSafe,
    suggestTwoSlotsNext7Days,
    suggestTwoSlotsFromDate,
    findNextAppointmentSafe,
    addCallbackNoteToEvent,
    cancelAppointmentSafe,
    getTimePreferenceRule,
    getPriorityPreferenceRule,
    detectTimePreference,
    detectPriorityPreference,
    parseTargetHourMinutes,
    normalizeText,
};