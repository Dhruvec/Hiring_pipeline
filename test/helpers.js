'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const { Database } = require('../src/db');
const { HiringService } = require('../src/service');

/** Clock whose value can be mutated for deterministic duration tests. */
function fixedClock(iso) {
    let t = new Date(iso);
    const fn = () => new Date(t);
    fn.set = (next) => { t = new Date(next); };
    fn.advance = (ms) => { t = new Date(t.getTime() + ms); };
    return fn;
}

function tmpFile(tag = 'db') {
    return path.join(
        os.tmpdir(),
        `mhp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
}

function makeService({ now } = {}) {
    const file = tmpFile('svc');
    const db = new Database(file);
    db.load();
    const clock = now instanceof Function ? now : fixedClock(now || '2026-01-15T12:00:00.000Z');
    const service = new HiringService(db, { now: clock });
    return { db, service, clock, file, cleanup: () => { try { fs.unlinkSync(file); } catch { /* ignore */ } } };
}

/**
 * Deterministic fixture for search tests.
 * NOW = 2026-01-15T12:00Z (a Thursday). Most recent Monday = 2026-01-12.
 */
function buildFixture() {
    const now = '2026-01-15T12:00:00.000Z';
    const clock = fixedClock(now);
    const file = tmpFile('fx');
    const db = new Database(file);
    db.load();

    const candidates = [];
    const history = [];
    let hid = 0;

    const add = (id, name, currentStage, events) => {
        candidates.push({
            id,
            name,
            email: `${name.toLowerCase().replace(/[^a-z]/g, '.')}@example.com`,
            phone: null,
            role: 'Engineer',
            source: 'Test',
            notes: null,
            current_stage: currentStage,
            created_at: events[0].entered_at,
            updated_at: events[events.length - 1].entered_at,
        });
        events.forEach((e) => {
            history.push({
                id: ++hid,
                candidate_id: id,
                stage: e.stage,
                entered_at: e.entered_at,
                exited_at: e.exited_at || null,
                reason: `Moved to ${e.stage}`,
                created_by: 'recruiter',
            });
        });
    };

    add(1, 'Priya Sharma', 'Interview', [
        { stage: 'Applied', entered_at: '2026-01-01T09:00:00.000Z', exited_at: '2026-01-06T09:00:00.000Z' },
        { stage: 'Screening', entered_at: '2026-01-06T09:00:00.000Z', exited_at: '2026-01-13T09:00:00.000Z' },
        { stage: 'Interview', entered_at: '2026-01-13T09:00:00.000Z', exited_at: null },
    ]);

    add(2, 'Aman Kumar', 'Screening', [
        { stage: 'Applied', entered_at: '2025-12-26T09:00:00.000Z', exited_at: '2026-01-05T09:00:00.000Z' },
        { stage: 'Screening', entered_at: '2026-01-05T09:00:00.000Z', exited_at: null },
    ]);

    add(3, 'Riya Singh', 'Offer', [
        { stage: 'Applied', entered_at: '2025-12-01T09:00:00.000Z', exited_at: '2025-12-20T09:00:00.000Z' },
        { stage: 'Screening', entered_at: '2025-12-20T09:00:00.000Z', exited_at: '2026-01-02T09:00:00.000Z' },
        { stage: 'Interview', entered_at: '2026-01-02T09:00:00.000Z', exited_at: '2026-01-12T09:00:00.000Z' },
        { stage: 'Offer', entered_at: '2026-01-12T09:00:00.000Z', exited_at: null },
    ]);

    add(4, 'Vikram Rao', 'Hired', [
        { stage: 'Applied', entered_at: '2025-11-01T09:00:00.000Z', exited_at: '2025-11-10T09:00:00.000Z' },
        { stage: 'Screening', entered_at: '2025-11-10T09:00:00.000Z', exited_at: '2025-11-18T09:00:00.000Z' },
        { stage: 'Interview', entered_at: '2025-11-18T09:00:00.000Z', exited_at: '2025-12-01T09:00:00.000Z' },
        { stage: 'Offer', entered_at: '2025-12-01T09:00:00.000Z', exited_at: '2026-01-14T09:00:00.000Z' },
        { stage: 'Hired', entered_at: '2026-01-14T09:00:00.000Z', exited_at: null },
    ]);

    add(5, 'Neha Jain', 'Rejected', [
        { stage: 'Applied', entered_at: '2025-12-28T09:00:00.000Z', exited_at: '2026-01-04T09:00:00.000Z' },
        { stage: 'Screening', entered_at: '2026-01-04T09:00:00.000Z', exited_at: '2026-01-11T09:00:00.000Z' },
        { stage: 'Rejected', entered_at: '2026-01-11T09:00:00.000Z', exited_at: null },
    ]);

    db.replaceAll({ counters: { candidates: candidates.length, history: hid }, candidates, history });

    const service = new HiringService(db, { now: clock });
    return { db, service, clock, file, cleanup: () => { try { fs.unlinkSync(file); } catch { /* ignore */ } } };
}

module.exports = { fixedClock, tmpFile, makeService, buildFixture };
