'use strict';

/**
 * Time-in-stage utilities.
 *
 * Duration is always calculated from the transition timestamp that ENTERED the
 * current stage (the open history event's `entered_at`). Reference "now" can be
 * injected for deterministic tests.
 */

const MS = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
};

function msUntilEntered(enteredAt, now = new Date()) {
    const start = new Date(enteredAt).getTime();
    const end = new Date(now).getTime();
    return Math.max(0, end - start);
}

/**
 * Human-readable duration, e.g. "6 days 4 hours", "3 weeks", "2 hrs 15 mins".
 * @param {number} ms
 */
function formatDuration(ms) {
    if (ms < MS.minute) return 'less than a minute';
    const days = Math.floor(ms / MS.day);
    const hours = Math.floor((ms % MS.day) / MS.hour);
    const minutes = Math.floor((ms % MS.hour) / MS.minute);

    const parts = [];
    if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    if (hours > 0 && parts.length < 2) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (parts.length === 0 && minutes > 0) parts.push(`${minutes} min${minutes === 1 ? '' : 's'}`);
    return parts.join(' ');
}

/**
 * Parse a loose duration/relative-period phrase into milliseconds.
 * Supports: "a week", "7 days", "more than a month", "2 hours", "24 hrs".
 * @returns {number|null}
 */
function parseDurationToMs(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();

    const wordNumbers = {
        a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
        six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
    };

    const re = /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)/g;
    let best = null;
    let match;
    while ((match = re.exec(t)) !== null) {
        const rawNum = match[1];
        const unit = match[2];
        const qty = /^\d+$/.test(rawNum) ? Number(rawNum) : wordNumbers[rawNum] || 1;
        let unitMs = 0;
        if (/^min/.test(unit)) unitMs = MS.minute;
        else if (/^(hour|hr)/.test(unit)) unitMs = MS.hour;
        else if (/^day/.test(unit)) unitMs = MS.day;
        else if (/^week/.test(unit)) unitMs = MS.week;
        else if (/^month/.test(unit)) unitMs = 30 * MS.day;
        else if (/^year/.test(unit)) unitMs = 365 * MS.day;

        if (unitMs) {
            const value = qty * unitMs;
            if (best === null || value > best) best = value;
        }
    }
    return best;
}

/** True if the phrase expresses "more than" / "over" / "at least". */
function parseComparator(text) {
    if (!text) return '>=';
    const t = String(text).toLowerCase();
    if (/\b(less than|under|before|fewer than)\b/.test(t)) return '<';
    if (/\b(more than|over|at least|longer than|greater than|older than)\b/.test(t)) return '>';
    return '>=';
}

module.exports = {
    MS,
    msUntilEntered,
    formatDuration,
    parseDurationToMs,
    parseComparator,
};
