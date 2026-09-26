'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { levenshtein, similarity, scoreName, bestNameMatch } = require('../src/fuzzy');

test('levenshtein distance is computed correctly', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('same', 'same'), 0);
    assert.equal(levenshtein('', 'abc'), 3);
});

test('exact name match scores highest', () => {
    const { score } = scoreName('Priya Sharma', 'Priya Sharma');
    assert.equal(score, 1);
});

test('partial name match works (first name only)', () => {
    const { score } = scoreName('priya', 'Priya Sharma');
    assert.ok(score >= 0.9, `expected >= 0.9, got ${score}`);
});

test('slightly misspelled names still match', () => {
    const { score, reason } = scoreName('priya shrama', 'Priya Sharma');
    assert.ok(score >= 0.75, `expected fuzzy match >= 0.75, got ${score}`);
    assert.match(reason, /fuzzy|match/i);
});

test('normalization ignores case, punctuation and extra spaces', () => {
    const { score } = scoreName('  PRIYA   sharma ', 'Priya Sharma');
    assert.equal(score, 1);
});

test('unrelated names do not match', () => {
    const { score } = scoreName('banana', 'Priya Sharma');
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
});

test('bestNameMatch picks the closest candidate above threshold', () => {
    const candidates = [{ name: 'Priya Sharma' }, { name: 'Aman Kumar' }, { name: 'Riya Singh' }];
    const best = bestNameMatch('riy singh', candidates);
    assert.ok(best);
    assert.equal(best.candidate.name, 'Riya Singh');
});

test('similarity is symmetric and bounded in [0,1]', () => {
    const a = similarity('sharma', 'shrama');
    const b = similarity('shrama', 'sharma');
    assert.equal(a, b);
    assert.ok(a >= 0 && a <= 1);
});
