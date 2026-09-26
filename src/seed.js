'use strict';

/**
 * Deterministic seeder.
 *
 * Builds a realistic pipeline with time-in-stage spread so the search examples
 * ("stuck in Screening for more than a week", "moved to Interview since
 * Monday") return meaningful results.
 *
 * Run:  node src/seed.js        (skips if data already exists)
 *       node src/seed.js --force (wipes and reseeds)
 */

const { Database, DEFAULT_FILE } = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Each candidate is defined by the number of days they spent in each stage
 * along their journey. The final entry (open) is their current stage.
 * daysAgo() computes timestamps relative to "now" so durations stay realistic.
 */
const CANDIDATES = [
    {
        name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+91 98100 11111',
        role: 'Senior Backend Engineer', source: 'Referral',
        journey: [['Applied', 12], ['Screening', 5], ['Interview', 6.16]],
    },
    {
        name: 'Aman Kumar', email: 'aman.kumar@example.com', phone: '+91 98100 22222',
        role: 'Backend Engineer', source: 'LinkedIn',
        journey: [['Applied', 20], ['Screening', 11]],
    },
    {
        name: 'Riya Singh', email: 'riya.singh@example.com', phone: '+91 98100 33333',
        role: 'Frontend Engineer', source: 'Careers Page',
        journey: [['Applied', 30], ['Screening', 9], ['Interview', 10], ['Offer', 4]],
    },
    {
        name: 'Vikram Rao', email: 'vikram.rao@example.com', phone: '+91 98100 44444',
        role: 'DevOps Engineer', source: 'Referral',
        journey: [['Applied', 40], ['Screening', 8], ['Interview', 9], ['Offer', 7], ['Hired', 5]],
    },
    {
        name: 'Neha Jain', email: 'neha.jain@example.com', phone: '+91 98100 55555',
        role: 'Data Engineer', source: 'LinkedIn',
        journey: [['Applied', 25], ['Screening', 6], ['Interview', 8], ['Rejected', 3]],
    },
    {
        name: 'Rahul Verma', email: 'rahul.verma@example.com', phone: '+91 98100 66666',
        role: 'Full Stack Engineer', source: 'Careers Page',
        journey: [['Applied', 3]],
    },
    {
        name: 'Karan Shah', email: 'karan.shah@example.com', phone: '+91 98100 77777',
        role: 'QA Engineer', source: 'Recruiter Sourcing',
        journey: [['Applied', 10], ['Screening', 2]],
    },
    {
        name: 'Ankit Mehta', email: 'ankit.mehta@example.com', phone: '+91 98100 88888',
        role: 'Engineering Manager', source: 'Referral',
        journey: [['Applied', 35], ['Screening', 6], ['Interview', 7], ['Offer', 5], ['Rejected', 2]],
    },
];

/**
 * Convert a journey into history events with entered_at / exited_at.
 * @param {Array<[string, number]>} journey pairs of [stage, daysInStage]
 * @param {Date} now
 */
function journeyToHistory(journey, now) {
    // Total days from creation to now.
    const totalDays = journey.reduce((sum, [, d]) => sum + d, 0);
    let cursor = new Date(now.getTime() - totalDays * DAY);

    const events = [];
    for (let i = 0; i < journey.length; i++) {
        const [stage, days] = journey[i];
        const enteredAt = new Date(cursor);
        // The last stage is currently open.
        const isLast = i === journey.length - 1;
        const exitedAt = isLast ? null : new Date(cursor.getTime() + days * DAY);
        events.push({
            stage,
            entered_at: enteredAt.toISOString(),
            exited_at: exitedAt ? exitedAt.toISOString() : null,
            reason: i === 0 ? 'Candidate created' : `Moved to ${stage}`,
            created_by: i === 0 ? 'recruiter' : 'recruiter',
        });
        cursor = exitedAt ? new Date(exitedAt.getTime()) : cursor;
    }
    return events;
}

function buildDatabase(now = new Date()) {
    const db = { candidates: [], history: [], counters: { candidates: 0, history: 0 } };

    CANDIDATES.forEach((def, idx) => {
        const events = journeyToHistory(def.journey, now);
        const createdAt = events[0].entered_at;
        const currentStage = def.journey[def.journey.length - 1][0];
        const updatedAt = events[events.length - 1].entered_at;

        const candidateId = idx + 1;
        db.candidates.push({
            id: candidateId,
            name: def.name,
            email: def.email,
            phone: def.phone,
            role: def.role,
            source: def.source,
            notes: null,
            current_stage: currentStage,
            created_at: createdAt,
            updated_at: updatedAt,
        });

        events.forEach((e, j) => {
            db.history.push({
                id: db.counters.history + 1,
                candidate_id: candidateId,
                stage: e.stage,
                entered_at: e.entered_at,
                exited_at: e.exited_at,
                reason: e.reason,
                created_by: e.created_by,
            });
            db.counters.history += 1;
        });
    });

    db.counters.candidates = CANDIDATES.length;
    return db;
}

function seed({ file = DEFAULT_FILE, force = false, now = new Date() } = {}) {
    const db = new Database(file);
    db.load();

    const hasData = db.data.candidates.length > 0;
    if (hasData && !force) {
        return { seeded: false, reason: 'Database already contains candidates. Use --force to reseed.', count: db.data.candidates.length };
    }

    const fresh = buildDatabase(now);
    db.replaceAll({
        meta: { created_at: new Date().toISOString(), version: 1, seeded: true },
        counters: fresh.counters,
        candidates: fresh.candidates,
        history: fresh.history,
    });
    return { seeded: true, count: fresh.candidates.length, file };
}

if (require.main === module) {
    const force = process.argv.includes('--force');
    const result = seed({ force });
    if (result.seeded) {
        console.log(`Seeded ${result.count} candidates into ${result.file}`);
    } else {
        console.log(result.reason);
    }
}

module.exports = { seed, buildDatabase, CANDIDATES, journeyToHistory };
