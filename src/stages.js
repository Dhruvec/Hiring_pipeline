'use strict';

/**
 * Stage machine for the Mini Hiring Pipeline.
 *
 * Design principles enforced here:
 *  - Controlled stage progression: a normal transition advances EXACTLY one stage.
 *  - Final outcomes: Hired and Rejected are terminal (no reverse transition).
 *  - Rejected may be entered from ANY pre-final stage.
 *
 * This module is framework-free and is the single source of truth for the
 * business rules. It is imported by the backend service layer so validation
 * never depends on frontend controls (see Architecture Decisions).
 */

/** Ordered happy-path stages. Index order defines progression. */
const STAGES = Object.freeze([
    'Applied',
    'Screening',
    'Interview',
    'Offer',
    'Hired',
]);

/** Terminal stages. Once here, no further transition is allowed. */
const FINAL_STAGES = Object.freeze(['Hired', 'Rejected']);

/** The special "rejection" outcome available from any pre-final stage. */
const REJECTED = 'Rejected';

/** All stages a candidate can ever be in. */
const ALL_STAGES = Object.freeze([...STAGES, REJECTED]);

function isStage(value) {
    return typeof value === 'string' && ALL_STAGES.includes(value);
}

function isFinal(stage) {
    return FINAL_STAGES.includes(stage);
}

function stageIndex(stage) {
    return STAGES.indexOf(stage);
}

/**
 * Validate a requested transition from `from` to `to`.
 * @returns {{ok: boolean, code: string, message: string, allowed: string[]}}
 */
function validateTransition(from, to) {
    const allowed = allowedNextStages(from);

    if (!isStage(from)) {
        return {
            ok: false,
            code: 'UNKNOWN_CURRENT_STAGE',
            message: `Unknown current stage "${from}".`,
            allowed,
        };
    }
    if (!isStage(to)) {
        return {
            ok: false,
            code: 'UNKNOWN_TARGET_STAGE',
            message: `Unknown target stage "${to}".`,
            allowed,
        };
    }
    if (from === to) {
        return {
            ok: false,
            code: 'SAME_STAGE',
            message: `Candidate is already in "${from}".`,
            allowed,
        };
    }
    if (isFinal(from)) {
        return {
            ok: false,
            code: 'TERMINAL_STAGE',
            message: `"${from}" is a final outcome. Final outcomes cannot be reversed or changed.`,
            allowed: [],
        };
    }
    if (to === REJECTED) {
        // Rejection is allowed from any pre-final stage.
        return { ok: true, code: 'OK', message: 'Allowed.', allowed };
    }
    const fromIdx = stageIndex(from);
    const toIdx = stageIndex(to);

    if (toIdx === -1) {
        return {
            ok: false,
            code: 'UNKNOWN_TARGET_STAGE',
            message: `Unknown target stage "${to}".`,
            allowed,
        };
    }
    if (toIdx <= fromIdx) {
        return {
            ok: false,
            code: 'REVERSE_TRANSITION',
            message: `Reverse transitions are not allowed (${from} -> ${to}). The pipeline only moves forward.`,
            allowed,
        };
    }
    if (toIdx > fromIdx + 1) {
        return {
            ok: false,
            code: 'SKIPPED_STAGE',
            message: `Cannot skip stages (${from} -> ${to}). A normal transition advances exactly one stage.`,
            allowed,
        };
    }
    return { ok: true, code: 'OK', message: 'Allowed.', allowed };
}

/**
 * Stages a candidate may legally move to from the given stage.
 * @returns {string[]}
 */
function allowedNextStages(from) {
    if (!isStage(from) || isFinal(from)) return [];
    const next = STAGES[stageIndex(from) + 1];
    return next ? [next, REJECTED] : [REJECTED];
}

module.exports = {
    STAGES,
    FINAL_STAGES,
    ALL_STAGES,
    REJECTED,
    isStage,
    isFinal,
    stageIndex,
    validateTransition,
    allowedNextStages,
};
