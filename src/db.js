'use strict';

/**
 * Tiny file-backed relational-ish store with zero external dependencies.
 *
 * Two "tables" mirror the assignment's data model:
 *   - candidates : optimized current state for the pipeline view
 *   - history    : append-only audit trail of stage events
 *
 * The store is intentionally simple, but the API is modeled so the persistence
 * layer could be swapped for SQLite/Postgres without touching the services.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'db.json');

function emptyDb() {
    return {
        meta: { created_at: new Date().toISOString(), version: 1 },
        counters: { candidates: 0, history: 0 },
        candidates: [],
        history: [],
    };
}

class Database {
    /** @param {string} [file] path to the JSON database file */
    constructor(file = DEFAULT_FILE) {
        this.file = file;
        this.data = emptyDb();
    }

    /** Load from disk (creating an empty database if none exists). */
    load() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        if (fs.existsSync(this.file)) {
            const raw = fs.readFileSync(this.file, 'utf8').trim();
            if (raw) {
                this.data = JSON.parse(raw);
                this.data.counters = this.data.counters || { candidates: 0, history: 0 };
                this.data.candidates = this.data.candidates || [];
                this.data.history = this.data.history || [];
                return this;
            }
        }
        this.persist();
        return this;
    }

    /** Atomically write the database to disk. */
    persist() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }

    /** Replace the entire dataset (used by the seeder). */
    replaceAll(next) {
        this.data = { ...emptyDb(), ...next };
        this.data.counters = next.counters || { candidates: 0, history: 0 };
        this.persist();
    }

    /** Monotonic per-table id generator. */
    nextId(table) {
        this.data.counters[table] = (this.data.counters[table] || 0) + 1;
        return this.data.counters[table];
    }

    // --- candidates ---------------------------------------------------------

    allCandidates() {
        return this.data.candidates;
    }

    getCandidate(id) {
        const numeric = Number(id);
        return this.data.candidates.find((c) => c.id === numeric);
    }

    insertCandidate(candidate) {
        this.data.candidates.push(candidate);
        return candidate;
    }

    updateCandidate(id, patch) {
        const candidate = this.getCandidate(id);
        if (!candidate) return null;
        Object.assign(candidate, patch);
        return candidate;
    }

    // --- history (append-only) ---------------------------------------------

    allHistory() {
        return this.data.history;
    }

    historyForCandidate(candidateId) {
        const numeric = Number(candidateId);
        return this.data.history
            .filter((e) => e.candidate_id === numeric)
            .sort((a, b) => {
                const t = new Date(a.entered_at) - new Date(b.entered_at);
                return t !== 0 ? t : a.id - b.id;
            });
    }

    /**
     * The "current" event for a candidate is the most recent one by entry time.
     * We deliberately do NOT rely on a mutable `exited_at` flag: transition is
     * append-only, so the open event is simply the last appended event.
     */
    openEvent(candidateId) {
        const numeric = Number(candidateId);
        const events = this.historyForCandidate(numeric);
        return events.length ? events[events.length - 1] : undefined;
    }

    insertHistory(event) {
        this.data.history.push(event);
        return event;
    }
}

module.exports = { Database, emptyDb, DEFAULT_FILE };
