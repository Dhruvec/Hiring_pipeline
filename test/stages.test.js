'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    STAGES,
    allowedNextStages,
    validateTransition,
    isFinal,
} = require('../src/stages');

test('pipeline order is Applied → Screening → Interview → Offer → Hired', () => {
    assert.deepEqual(STAGES, ['Applied', 'Screening', 'Interview', 'Offer', 'Hired']);
});

test('a normal transition advances exactly one stage', () => {
    const pairs = [
        ['Applied', 'Screening'],
        ['Screening', 'Interview'],
        ['Interview', 'Offer'],
        ['Offer', 'Hired'],
    ];
    for (const [from, to] of pairs) {
        const result = validateTransition(from, to);
        assert.equal(result.ok, true, `${from} -> ${to} should be allowed`);
    }
});

test('stages cannot be skipped (Applied → Interview)', () => {
    const result = validateTransition('Applied', 'Interview');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SKIPPED_STAGE');
});

test('reverse transitions are rejected (Screening → Applied)', () => {
    const result = validateTransition('Screening', 'Applied');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REVERSE_TRANSITION');
});

test('rejection is allowed from any pre-final stage', () => {
    for (const stage of ['Applied', 'Screening', 'Interview', 'Offer']) {
        const result = validateTransition(stage, 'Rejected');
        assert.equal(result.ok, true, `${stage} -> Rejected should be allowed`);
    }
});

test('final outcomes cannot transition anywhere', () => {
    for (const finalStage of ['Hired', 'Rejected']) {
        assert.equal(isFinal(finalStage), true);
        const result = validateTransition(finalStage, 'Offer');
        assert.equal(result.ok, false);
        assert.equal(result.code, 'TERMINAL_STAGE');
    }
});

test('allowedNextStages exposes one forward stage plus Rejected', () => {
    assert.deepEqual(allowedNextStages('Applied'), ['Screening', 'Rejected']);
    assert.deepEqual(allowedNextStages('Offer'), ['Hired', 'Rejected']);
    assert.deepEqual(allowedNextStages('Hired'), []);
    assert.deepEqual(allowedNextStages('Rejected'), []);
});

test('unknown stages are rejected', () => {
    assert.equal(validateTransition('Applied', 'Ghosted').ok, false);
    assert.equal(validateTransition('Applied', 'Ghosted').code, 'UNKNOWN_TARGET_STAGE');
});
