'use strict';

/**
 * Fuzzy string matching used for name search ("Find Priya Sharma", partial or
 * slightly misspelled names like "priya shrama").
 *
 * Uses normalized Levenshtein distance plus token-level and substring bonuses.
 */

/** Normalize a string: lowercase, strip accents/punctuation, collapse spaces. */
function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Classic Levenshtein edit distance (iterative, O(n*m)). */
function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let k = 0; k <= b.length; k++) prev[k] = curr[k];
    }
    return prev[b.length];
}

/** Similarity ratio in [0,1] derived from normalized edit distance. */
function similarity(a, b) {
    const max = Math.max(a.length, b.length);
    if (max === 0) return 1;
    return 1 - levenshtein(a, b) / max;
}

/**
 * Score how well `query` matches `target` (both names).
 * @returns {{score: number, reason: string}}
 */
function scoreName(query, target) {
    const q = normalize(query);
    const t = normalize(target);
    if (!q || !t) return { score: 0, reason: 'empty' };

    if (t === q) return { score: 1, reason: 'exact name match' };
    if (t.includes(q)) return { score: 0.95, reason: 'name contains query' };

    const qTokens = q.split(' ').filter(Boolean);
    const tTokens = t.split(' ').filter(Boolean);

    // Token containment: every query token appears (as prefix) in some target token.
    const allTokensHit = qTokens.every((qt) =>
        tTokens.some((tt) => tt === qt || tt.startsWith(qt) || qt.startsWith(tt))
    );
    if (allTokensHit) return { score: 0.9, reason: 'all name tokens matched' };

    // Best per-token similarity (handles one misspelled token, e.g. "priya shrama").
    const perToken = qTokens.map((qt) => {
        let best = 0;
        for (const tt of tTokens) best = Math.max(best, similarity(qt, tt));
        return best;
    });
    const avgToken = perToken.reduce((s, v) => s + v, 0) / (qTokens.length || 1);
    const whole = similarity(q, t);
    const score = Math.max(avgToken, whole);

    if (score >= 0.8) return { score, reason: 'close name match (fuzzy)' };
    if (score >= 0.6) return { score, reason: 'partial name match (fuzzy)' };
    return { score, reason: '' };
}

/**
 * Find the best name match among candidates.
 * @param {string} query
 * @param {Array<{name: string}>} candidates
 * @param {number} [threshold] minimum score to be considered a match
 */
function bestNameMatch(query, candidates, threshold = 0.6) {
    let best = null;
    for (const c of candidates) {
        const { score, reason } = scoreName(query, c.name);
        if (score >= threshold && (!best || score > best.score)) {
            best = { candidate: c, score, reason };
        }
    }
    return best;
}

module.exports = { normalize, levenshtein, similarity, scoreName, bestNameMatch };
