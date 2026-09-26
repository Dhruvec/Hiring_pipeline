'use strict';

/**
 * Natural-language search engine.
 *
 * One search box, many question types. The engine:
 *   1. Parses the query into a structured "plan" of conditions (intent detection).
 *   2. Applies exact filters (current stage, exclusions, final-outcome rules).
 *   3. Uses fuzzy matching for names.
 *   4. Calculates time-in-stage from transition timestamps.
 *   5. Combines conditions (logical AND) and ranks results.
 *   6. Explains each match, and explains unsupported queries instead of
 *      silently returning an empty list.
 */

const { STAGES, REJECTED, isFinal } = require('./stages');
const { scoreName, normalize } = require('./fuzzy');
const { parseDurationToMs, parseComparator, MS } = require('./timeInStage');

const STAGE_ALIASES = {
    Applied: ['applied', 'application', 'new application'],
    Screening: ['screening', 'screen', 'screened'],
    Interview: ['interview', 'interviews', 'interviewing'],
    Offer: ['offer', 'offered', 'offer stage'],
    Hired: ['hired', 'hire', 'onboard', 'onboarded', 'joined'],
    Rejected: ['rejected', 'reject', 'rejection', 'declined'],
};

const REACH_VERBS = /\b(reached|reach|got to|made it to|moved to|move to|went to|advanced to|advanced|progressed to|transitioned to|transitioned)\b/;
const IN_VERBS = /\b(in|into|at|on|currently|still|sitting|waiting|stuck|remains?|right now|now)\b/;
const EXCEPT_WORDS = /\b(except|excluding|exclude|other than|apart from|minus|not including)\b/;

const SEARCH_EXAMPLES = [
    'Find Priya Sharma',
    "Who's in Interview right now?",
    'Stuck in Screening for more than a week',
    'Moved to Interview since Monday',
    "Reached Offer but didn't get hired",
    'Everyone except rejected candidates',
];

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const WEEKDAYS = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
};

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

/** Most recent past occurrence of a weekday (inclusive of today) at day start. */
function lastWeekday(now, dayIndex) {
    const today = startOfDay(now);
    const diff = (today.getDay() - dayIndex + 7) % 7;
    return addDays(today, -diff);
}

/**
 * Parse a date reference into a range.
 * @returns {{after: Date|null, before: Date|null, label: string}|null}
 */
function parseDateReference(text, now) {
    const t = ` ${text.toLowerCase()} `;

    let m;
    if ((m = t.match(/\b(today)\b/))) {
        const s = startOfDay(now);
        return { after: s, before: addDays(s, 1), label: 'today' };
    }
    if ((m = t.match(/\b(yesterday)\b/))) {
        const s = addDays(startOfDay(now), -1);
        return { after: s, before: addDays(s, 1), label: 'yesterday' };
    }
    if ((m = t.match(/\b(this week)\b/))) {
        const s = lastWeekday(now, 1);
        return { after: s, before: null, label: 'this week' };
    }
    if ((m = t.match(/\b(last week)\b/))) {
        const thisMon = lastWeekday(now, 1);
        return { after: addDays(thisMon, -7), before: thisMon, label: 'last week' };
    }
    if ((m = t.match(/\b(last|past|previous)\s+(\d+)\s+(day|week|month)s?\b/))) {
        const qty = Number(m[2]);
        const unitMs = m[3] === 'day' ? MS.day : m[3] === 'week' ? MS.week : 30 * MS.day;
        return { after: new Date(now - qty * unitMs), before: null, label: `${m[1]} ${qty} ${m[3]}(s)` };
    }

    // "since|after Monday" and "before Friday"
    const sinceMatch = t.match(/\b(since|after|from|starting)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    const beforeMatch = t.match(/\b(before|until|up to)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (sinceMatch || beforeMatch) {
        const after = sinceMatch ? lastWeekday(now, WEEKDAYS[sinceMatch[2]]) : null;
        const before = beforeMatch ? lastWeekday(now, WEEKDAYS[beforeMatch[2]]) : null;
        return {
            after,
            before,
            label: `${sinceMatch ? `since ${sinceMatch[2]}` : ''}${sinceMatch && beforeMatch ? ' and ' : ''}${beforeMatch ? `before ${beforeMatch[2]}` : ''}`,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

function detectStage(text) {
    for (const stage of [...STAGES, REJECTED]) {
        const aliases = STAGE_ALIASES[stage] || [stage.toLowerCase()];
        for (const alias of aliases) {
            const re = new RegExp(`\\b${alias}\\b`, 'i');
            if (re.test(text)) return { stage, alias };
        }
    }
    return null;
}

/**
 * Parse a raw query into a structured plan.
 * @param {string} raw
 * @param {Date} now
 */
function parseQuery(raw, now = new Date()) {
    const query = String(raw || '').trim();
    const intents = [];
    let text = ` ${query.toLowerCase()} `;

    const plan = {
        raw: query,
        currentStage: null,
        reachedStage: null,
        excludeStages: [],
        excludeFinal: false,
        requireReached: [],   // stages the candidate must have ever reached
        notHired: false,
        duration: null,       // { ms, comparator, phrase }
        dateRange: null,      // { after, before, label }
        nameQuery: null,
        nameHard: false,
        nameScore: 0,
        nameReason: '',
        unsupported: null,
    };

    if (!query) {
        plan.unsupported = 'The search box is empty. Enter a question such as "Who is in Interview?" or a candidate name.';
        return plan;
    }

    // 1. Final-outcome negation: "didn't get hired", "not hired yet".
    const notHiredRe = /\b(not|never|didn'?t|hasn'?t|haven'?t|wasn'?t)\b[^.]{0,20}\b(hired|hire)\b|\bwithout (being )?hired\b|\bnot (yet )?hired\b/;
    if (notHiredRe.test(text)) {
        plan.notHired = true;
        intents.push('exclude candidates whose current outcome is Hired');
        text = text.replace(notHiredRe, ' ');
    }

    // 2. Exclusion: "except rejected", "not rejected", "excluding hired".
    const exceptRe = new RegExp(`\\b(except|excluding|exclude|other than|apart from|minus|not including)\\b[^.]{0,20}?\\b(${Object.values(STAGE_ALIASES).flat().join('|')})\\b`);
    let ex;
    if ((ex = exceptRe.exec(text))) {
        const stageHit = detectStage(ex[2]);
        if (stageHit) {
            plan.excludeStages.push(stageHit.stage);
            intents.push(`exclude candidates currently in ${stageHit.stage}`);
        }
        text = text.replace(exceptRe, ' ');
    } else if (/\bnot (rejected|hired)\b/.test(text)) {
        const stageHit = detectStage(text.match(/\bnot (rejected|hired)\b/)[1]);
        if (stageHit) {
            plan.excludeStages.push(stageHit.stage);
            intents.push(`exclude candidates currently in ${stageHit.stage}`);
        }
        text = text.replace(/\bnot (rejected|hired)\b/, ' ');
    }

    // 3. Duration / "stuck in X for more than a week".
    const durationPhrase = text.match(/\b(more than|over|at least|less than|under|longer than|greater than|older than|for)\s*([a-z0-9\s]{0,16}?(?:minute|min|hour|hr|day|week|month|year)s?)/);
    if (durationPhrase) {
        const ms = parseDurationToMs(durationPhrase[2]);
        if (ms) {
            const comparator = parseComparator(text);
            plan.duration = { ms, comparator, phrase: durationPhrase[0].trim() };
            intents.push(`time in stage ${comparator} ${durationPhrase[2].trim()}`);
        }
    }

    // 4. Date range: "since Monday", "after <date>".
    const dateRange = parseDateReference(text, now);
    if (dateRange) {
        plan.dateRange = dateRange;
        intents.push(`transition date ${dateRange.label}`);
    }

    // 5. Stage intent (reached vs current).
    const stageHit = detectStage(text);
    if (stageHit) {
        if (REACH_VERBS.test(text)) {
            plan.reachedStage = stageHit.stage;
            intents.push(`ever reached ${stageHit.stage}`);
        } else {
            plan.currentStage = stageHit.stage;
            intents.push(`currently in ${stageHit.stage}`);
        }
    } else if (plan.notHired || REACH_VERBS.test(text)) {
        // "reached at least Offer" style without explicit stage handled above.
    }

    // 6. Fuzzy name: try the whole query, then a residual with known phrases removed.
    const residual = normalize(
        text
            .replace(REACH_VERBS, ' ')
            .replace(IN_VERBS, ' ')
            .replace(/who|is|are|the|a|an|candidate|candidates|show|find|list|me|all|everyone|please|get|has|have|been|was|were|right|now|stuck|for|more|than|less|week|weeks|day|days|month|months|hour|hours|since|after|before|between|and|or|in|into|at|on|stage|status|from|to|of/g, ' ')
            .trim()
    );

    return plan;
}

function resolveName(plan, candidates) {
    const candidatesToTry = [];
    if (plan.raw) candidatesToTry.push(plan.raw);

    // Build residual from the raw string (parseQuery already stripped for stages,
    // so here we strip generic question words as a second pass).
    const residual = normalize(
        plan.raw
            .replace(REACH_VERBS, ' ')
            .replace(/\b(who|is|are|the|show|find|list|me|all|everyone|please|candidate|candidates|in|at|on|right|now|stage|status)\b/gi, ' ')
            .trim()
    );
    if (residual) candidatesToTry.push(residual);

    let best = { score: 0, reason: '', candidate: null };
    for (const q of candidatesToTry) {
        for (const c of candidates) {
            const { score, reason } = scoreName(q, c.name);
            if (score > best.score) best = { score, reason, candidate: c };
        }
    }

    // Track the text the user actually typed (residual, minus filler words) so
    // the explanation reflects their phrasing, plus the resolved candidate name.
    plan.nameText = residual || plan.raw;
    if (best.score >= 0.75) {
        plan.nameHard = true;
        plan.nameScore = best.score;
        plan.nameReason = best.reason;
        plan.nameResolvedName = best.candidate ? best.candidate.name : null;
    } else if (best.score >= 0.55) {
        plan.nameHard = false;
        plan.nameScore = best.score;
        plan.nameReason = best.reason;
        plan.nameResolvedName = best.candidate ? best.candidate.name : null;
    }
    return plan;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function compareDuration(valueMs, targetMs, comparator) {
    switch (comparator) {
        case '<': return valueMs < targetMs;
        case '>': return valueMs > targetMs;
        default: return valueMs >= targetMs;
    }
}

function evaluateCandidate(candidate, plan, service) {
    const reasons = [];
    let score = 0;
    let matchedAll = true;

    // Name (hard constraint when confident).
    if (plan.nameHard) {
        const { score: ns, reason } = scoreName(plan.nameText || plan.raw, candidate.name);
        if (ns < 0.75) matchedAll = false;
        else {
            score += 60 + ns * 40;
            reasons.push(reason || 'name match');
        }
    } else if (plan.nameScore > 0) {
        const { score: ns } = scoreName(plan.nameText || plan.raw, candidate.name);
        score += ns * 25;
    }

    // Current stage.
    if (plan.currentStage) {
        if (candidate.current_stage === plan.currentStage) {
            score += 25;
            reasons.push(`currently in ${plan.currentStage}`);
        } else matchedAll = false;
    }

    // Reached stage (history).
    const history = service.db.historyForCandidate(candidate.id);
    if (plan.reachedStage) {
        const events = history.filter((e) => e.stage === plan.reachedStage);
        if (events.length) {
            score += 30;
            reasons.push(`reached ${plan.reachedStage}`);
            if (plan.dateRange) {
                const inRange = events.some((e) => {
                    const at = new Date(e.entered_at).getTime();
                    const afterOk = !plan.dateRange.after || at >= plan.dateRange.after.getTime();
                    const beforeOk = !plan.dateRange.before || at < plan.dateRange.before.getTime();
                    return afterOk && beforeOk;
                });
                if (inRange) {
                    score += 20;
                    reasons.push(`entered ${plan.reachedStage} ${plan.dateRange.label}`);
                } else {
                    matchedAll = false;
                }
            }
        } else matchedAll = false;
    } else if (plan.dateRange) {
        // Date range applies to the current stage's entry transition.
        const at = new Date(candidate.entered_current_stage_at).getTime();
        const afterOk = !plan.dateRange.after || at >= plan.dateRange.after.getTime();
        const beforeOk = !plan.dateRange.before || at < plan.dateRange.before.getTime();
        if (afterOk && beforeOk) {
            score += 15;
            reasons.push(`moved into ${candidate.current_stage} ${plan.dateRange.label}`);
        } else matchedAll = false;
    }

    // Duration in current stage.
    if (plan.duration) {
        if (compareDuration(candidate.time_in_stage_ms, plan.duration.ms, plan.duration.comparator)) {
            score += 25;
            reasons.push(`in ${candidate.current_stage} for ${candidate.time_in_stage} (${plan.duration.phrase})`);
        } else matchedAll = false;
    }

    // Final outcome: not hired.
    if (plan.notHired) {
        if (candidate.current_stage !== 'Hired') {
            score += 15;
            reasons.push(`current outcome is ${candidate.current_stage} (not Hired)`);
        } else matchedAll = false;
    }

    // Exclusions.
    for (const stage of plan.excludeStages) {
        if (candidate.current_stage === stage) matchedAll = false;
    }
    if (plan.excludeStages.length && matchedAll) {
        reasons.push(`not ${plan.excludeStages.join('/')}`);
    }

    // "everyone except rejected" is meaningful even with no other condition.
    return { matched: matchedAll, score, reasons };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function hasAnyCondition(plan) {
    return Boolean(
        plan.currentStage ||
        plan.reachedStage ||
        plan.excludeStages.length ||
        plan.notHired ||
        plan.duration ||
        plan.dateRange ||
        plan.nameScore > 0
    );
}

function describePlan(plan, emptyResult) {
    const bits = [];
    if (plan.nameHard) {
        const shown = plan.nameResolvedName && plan.nameResolvedName !== plan.nameText
            ? `"${plan.nameText}" ≈ ${plan.nameResolvedName}`
            : `"${plan.nameText}"`;
        bits.push(`name ≈ ${shown}`);
    }
    if (plan.currentStage) bits.push(`current stage = ${plan.currentStage}`);
    if (plan.reachedStage) bits.push(`ever reached = ${plan.reachedStage}`);
    if (plan.duration) bits.push(`time in stage ${plan.duration.comparator} ${plan.duration.phrase}`);
    if (plan.dateRange) bits.push(plan.dateRange.label);
    if (plan.notHired) bits.push('outcome is not Hired');
    if (plan.excludeStages.length) bits.push(`excluding ${plan.excludeStages.join(', ')}`);
    if (!bits.length) return 'No recognizable condition found in the query.';
    const base = `Interpreted as: ${bits.join(' AND ')}.`;
    if (emptyResult) {
        return `${base} No candidates satisfy this right now (the conditions are valid, the pipeline just has no match).`;
    }
    return base;
}

/**
 * Execute a natural-language search.
 * @param {string} rawQuery
 * @param {import('./service').HiringService} service
 * @param {{now?: () => Date}} [opts]
 */
function search(rawQuery, service, opts = {}) {
    const now = opts.now ? opts.now() : new Date();
    const candidates = service.listCandidates();
    const plan = parseQuery(rawQuery, now);
    resolveName(plan, candidates);

    if (plan.unsupported) {
        return {
            ok: false,
            query: rawQuery,
            interpretation: plan.unsupported,
            plan: serializePlan(plan),
            results: [],
            examples: SEARCH_EXAMPLES,
        };
    }

    if (!hasAnyCondition(plan)) {
        return {
            ok: false,
            query: rawQuery,
            interpretation:
                "I couldn't find a supported condition in that query. Try a candidate name, a stage (Applied/Screening/Interview/Offer/Hired/Rejected), a duration (e.g. \"more than a week\"), or a date (e.g. \"since Monday\").",
            plan: serializePlan(plan),
            results: [],
            examples: SEARCH_EXAMPLES,
        };
    }

    const scored = [];
    for (const c of candidates) {
        const { matched, score, reasons } = evaluateCandidate(c, plan, service);
        if (matched) {
            scored.push({
                candidate: c,
                score,
                reasons: reasons.length ? reasons : ['matched query'],
            });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.candidate.time_in_stage_ms - a.candidate.time_in_stage_ms);

    const results = scored.map(({ candidate, score, reasons }) => ({
        id: candidate.id,
        name: candidate.name,
        email: candidate.email,
        current_stage: candidate.current_stage,
        is_final: candidate.is_final,
        time_in_stage: candidate.time_in_stage,
        time_in_stage_ms: candidate.time_in_stage_ms,
        entered_current_stage_at: candidate.entered_current_stage_at,
        score: Math.round(score * 10) / 10,
        reasons,
    }));

    return {
        ok: true,
        query: rawQuery,
        interpretation: describePlan(plan, results.length === 0),
        plan: serializePlan(plan),
        count: results.length,
        results,
        examples: SEARCH_EXAMPLES,
    };
}

function serializePlan(plan) {
    return {
        currentStage: plan.currentStage,
        reachedStage: plan.reachedStage,
        excludeStages: plan.excludeStages,
        notHired: plan.notHired,
        duration: plan.duration ? { ms: plan.duration.ms, comparator: plan.duration.comparator, phrase: plan.duration.phrase } : null,
        dateRange: plan.dateRange ? { after: plan.dateRange.after, before: plan.dateRange.before, label: plan.dateRange.label } : null,
        name: plan.nameResolvedName || null,
        nameText: plan.nameText || null,
        nameHard: plan.nameHard,
    };
}

module.exports = { search, parseQuery, resolveName, SEARCH_EXAMPLES, isFinal };
