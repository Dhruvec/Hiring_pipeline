'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeService } = require('./helpers');
const { MS } = require('../src/timeInStage');

test('creating a candidate records the first audited event in Applied', () => {
    const { service, cleanup } = makeService();
    const c = service.createCandidate({ name: 'Priya Sharma', email: 'p@example.com' });

    assert.equal(c.current_stage, 'Applied');
    const history = service.getHistory(c.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].stage, 'Applied');
    assert.equal(history[0].is_current, true);
    cleanup();
});

test('creation requires a name', () => {
    const { service, cleanup } = makeService();
    assert.throws(() => service.createCandidate({ name: '   ' }), /name is required/i);
    cleanup();
});

test('a valid transition appends history and closes the previous event', () => {
    const { service, cleanup } = makeService();
    const c = service.createCandidate({ name: 'Aman Kumar' });

    service.moveStage(c.id, 'Screening');
    const history = service.getHistory(c.id);

    assert.equal(history.length, 2);
    assert.equal(history[0].stage, 'Applied');
    assert.ok(history[0].exited_at, 'previous event should be closed');
    assert.equal(history[1].stage, 'Screening');
    assert.equal(history[1].is_current, true);
    assert.equal(service.getCandidate(c.id).current_stage, 'Screening');
    cleanup();
});

test('skipping stages is rejected by the backend', () => {
    const { service, cleanup } = makeService();
    const c = service.createCandidate({ name: 'Riya Singh' });

    assert.throws(() => service.moveStage(c.id, 'Interview'), (err) => {
        assert.equal(err.code, 'SKIPPED_STAGE');
        assert.equal(err.status, 409);
        return true;
    });
    cleanup();
});

test('reverse transitions are rejected by the backend', () => {
    const { service, cleanup } = makeService();
    const c = service.createCandidate({ name: 'Vikram Rao' });
    service.moveStage(c.id, 'Screening');

    assert.throws(() => service.moveStage(c.id, 'Applied'), (err) => {
        assert.equal(err.code, 'REVERSE_TRANSITION');
        return true;
    });
    cleanup();
});

test('Hired and Rejected are terminal outcomes', () => {
    const { service, cleanup } = makeService();

    const rejected = service.createCandidate({ name: 'Neha Jain' });
    service.moveStage(rejected.id, 'Screening');
    service.moveStage(rejected.id, 'Rejected');
    assert.throws(() => service.moveStage(rejected.id, 'Interview'), (err) => {
        assert.equal(err.code, 'TERMINAL_STAGE');
        return true;
    });

    const hired = service.createCandidate({ name: 'Karan Shah' });
    for (const stage of ['Screening', 'Interview', 'Offer', 'Hired']) {
        service.moveStage(hired.id, stage);
    }
    assert.throws(() => service.moveStage(hired.id, 'Offer'), (err) => {
        assert.equal(err.code, 'TERMINAL_STAGE');
        return true;
    });
    cleanup();
});

test('the audit trail is append-only: stored events are never edited', () => {
    const { service, db, cleanup } = makeService();
    const c = service.createCandidate({ name: 'Rahul Verma' });
    service.moveStage(c.id, 'Screening');

    // Snapshot the RAW stored records (not the derived view).
    const before = JSON.parse(JSON.stringify(db.historyForCandidate(c.id)));
    service.moveStage(c.id, 'Interview');
    const after = db.historyForCandidate(c.id);

    assert.equal(after.length, before.length + 1, 'exactly one event was appended');
    // Every previously stored record is byte-for-byte unchanged.
    for (let i = 0; i < before.length; i++) {
        assert.deepEqual(after[i], before[i]);
    }
    // The derived view still shows a clean sequence with a single current event.
    const view = service.getHistory(c.id);
    assert.equal(view.length, 3);
    assert.deepEqual(view.map((e) => e.stage), ['Applied', 'Screening', 'Interview']);
    assert.equal(view.filter((e) => e.is_current).length, 1);
    assert.equal(view[2].is_current, true);
    // Derived exit timestamps chain: Applied exits when Screening begins, etc.
    assert.equal(view[0].exited_at, view[1].entered_at);
    assert.equal(view[1].exited_at, view[2].entered_at);
    cleanup();
});

test('time-in-stage is calculated from the entering transition timestamp', () => {
    const { service, clock, cleanup } = makeService({ now: '2026-01-01T00:00:00.000Z' });
    const c = service.createCandidate({ name: 'Ankit Mehta' });

    clock.advance(2 * MS.day);
    service.moveStage(c.id, 'Screening');

    clock.advance(6 * MS.day + 4 * MS.hour);
    const candidate = service.getCandidate(c.id);

    assert.equal(candidate.current_stage, 'Screening');
    assert.equal(candidate.time_in_stage_ms, 6 * MS.day + 4 * MS.hour);
    assert.equal(candidate.time_in_stage, '6 days 4 hours');

    const history = service.getHistory(c.id);
    assert.equal(history[0].duration_in_stage, '2 days'); // Applied lasted 2 days
    cleanup();
});

test('board groups candidates by current stage', () => {
    const { service, cleanup } = makeService();
    const c1 = service.createCandidate({ name: 'One' });
    const c2 = service.createCandidate({ name: 'Two' });
    service.moveStage(c2.id, 'Screening');

    const board = service.board();
    const applied = board.columns.find((col) => col.stage === 'Applied');
    const screening = board.columns.find((col) => col.stage === 'Screening');
    const hired = board.columns.find((col) => col.stage === 'Hired');

    assert.equal(applied.candidates.length, 1);
    assert.equal(applied.candidates[0].id, c1.id);
    assert.equal(screening.candidates.length, 1);
    assert.equal(screening.candidates[0].id, c2.id);
    assert.equal(hired.candidates.length, 0);
    cleanup();
});
