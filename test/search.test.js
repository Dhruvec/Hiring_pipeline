'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFixture } = require('./helpers');
const { search } = require('../src/search');

function run(query) {
    const fx = buildFixture();
    const result = search(query, fx.service, { now: fx.clock });
    return { result, cleanup: fx.cleanup };
}

function names(result) {
    return result.results.map((r) => r.name).sort();
}

test('fuzzy name search finds a candidate by partial/misspelled name', () => {
    const { result, cleanup } = run('Find Priya Sharma');
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Priya Sharma']);
    cleanup();
});

test('fuzzy name search tolerates a typo', () => {
    const { result, cleanup } = run('priya shrama');
    assert.equal(result.ok, true);
    assert.ok(names(result).includes('Priya Sharma'));
    cleanup();
});

test('"who is in Interview" filters by current stage', () => {
    const { result, cleanup } = run("Who's in Interview right now?");
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Priya Sharma']);
    assert.equal(result.results[0].current_stage, 'Interview');
    cleanup();
});

test('"stuck in Screening for more than a week" applies stage + duration', () => {
    const { result, cleanup } = run('Stuck in Screening for more than a week');
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Aman Kumar']);
    assert.match(result.results[0].reasons.join(' '), /week|day/i);
    cleanup();
});

test('"moved to Interview since Monday" uses the transition event and date range', () => {
    const { result, cleanup } = run('Moved to Interview since Monday');
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Priya Sharma']);
    cleanup();
});

test('"reached Offer but didn\'t get hired" excludes hired candidates', () => {
    const { result, cleanup } = run("Reached Offer but didn't get hired");
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Riya Singh']);
    assert.ok(!names(result).includes('Vikram Rao'));
    cleanup();
});

test('"everyone except rejected" returns all non-rejected candidates', () => {
    const { result, cleanup } = run('Everyone except rejected candidates');
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 4);
    assert.ok(!names(result).includes('Neha Jain'));
    cleanup();
});

test('combined conditions are applied together', () => {
    // Current stage Screening AND in stage more than a week.
    const { result, cleanup } = run('candidates in Screening for more than a week');
    assert.equal(result.ok, true);
    assert.deepEqual(names(result), ['Aman Kumar']);
    cleanup();
});

test('each result explains why it matched', () => {
    const { result, cleanup } = run('Stuck in Screening for more than a week');
    assert.ok(Array.isArray(result.results[0].reasons));
    assert.ok(result.results[0].reasons.length > 0);
    assert.match(result.interpretation, /Interpreted as/i);
    cleanup();
});

test('an unsupported/meaningless query is explained, not silently empty', () => {
    const { result, cleanup } = run('banana');
    assert.equal(result.ok, false);
    assert.equal(result.results.length, 0);
    assert.ok(result.interpretation.length > 0);
    assert.ok(Array.isArray(result.examples) && result.examples.length > 0);
    cleanup();
});

test('an empty query is rejected with guidance', () => {
    const { result, cleanup } = run('   ');
    assert.equal(result.ok, false);
    assert.match(result.interpretation, /empty|enter/i);
    cleanup();
});

test('results are ranked (higher score first)', () => {
    const { result, cleanup } = run('Everyone except rejected candidates');
    for (let i = 1; i < result.results.length; i++) {
        assert.ok(result.results[i - 1].score >= result.results[i].score);
    }
    cleanup();
});
