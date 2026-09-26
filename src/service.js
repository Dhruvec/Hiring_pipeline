'use strict';

/**
 * Domain service. All business rules live behind this boundary so that stage
 * validation never depends on the frontend (Architecture Decisions).
 *
 * Invariants:
 *  - A candidate may only move one stage forward, or to Rejected, or not at all
 *    once final.
 *  - Every successful transition appends a history event and closes the
 *    previous open event. Existing history is never mutated.
 */

const { validateTransition, allowedNextStages, STAGES, isFinal, REJECTED } = require('./stages');
const { msUntilEntered, formatDuration } = require('./timeInStage');

class DomainError extends Error {
    constructor(message, status = 400, code = 'VALIDATION_ERROR', details = undefined) {
        super(message);
        this.name = 'DomainError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

class HiringService {
    /**
     * @param {import('./db').Database} db
     * @param {{now?: () => Date}} [opts]
     */
    constructor(db, opts = {}) {
        this.db = db;
        this.now = opts.now || (() => new Date());
    }

    // --- reads --------------------------------------------------------------

    listCandidates({ stage } = {}) {
        let rows = this.db.allCandidates().slice();
        if (stage) rows = rows.filter((c) => c.current_stage === stage);
        return rows
            .map((c) => this.decorate(c))
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    }

    getCandidate(id) {
        const c = this.db.getCandidate(id);
        if (!c) throw new DomainError(`Candidate ${id} not found.`, 404, 'NOT_FOUND');
        return this.decorate(c);
    }

    getHistory(id) {
        const c = this.db.getCandidate(id);
        if (!c) throw new DomainError(`Candidate ${id} not found.`, 404, 'NOT_FOUND');
        const events = this.db.historyForCandidate(id);
        return events.map((e, i) => {
            // `exited_at` is DERIVED, not stored: an event exits when the next event
            // begins. This keeps history strictly append-only (no row is ever edited).
            const next = events[i + 1];
            const exitedAt = next ? next.entered_at : null;
            return {
                id: e.id,
                candidate_id: e.candidate_id,
                stage: e.stage,
                entered_at: e.entered_at,
                exited_at: exitedAt,
                is_current: !next,
                reason: e.reason,
                duration_in_stage: formatDuration(
                    msUntilEntered(e.entered_at, exitedAt ? new Date(exitedAt) : this.now())
                ),
            };
        });
    }

    /** Build the pipeline board grouped by stage. */
    board() {
        const columns = [...STAGES, REJECTED].map((stage) => ({
            stage,
            is_final: isFinal(stage),
            candidates: this.listCandidates({ stage }),
        }));
        return { columns, total: this.db.allCandidates().length };
    }

    /** Attach derived fields used by both the UI and the search engine. */
    decorate(candidate) {
        const open = this.db.openEvent(candidate.id);
        const enteredAt = open ? open.entered_at : candidate.created_at;
        const ms = msUntilEntered(enteredAt, this.now());
        return {
            ...candidate,
            entered_current_stage_at: enteredAt,
            time_in_stage_ms: ms,
            time_in_stage: formatDuration(ms),
            is_final: isFinal(candidate.current_stage),
            allowed_next_stages: allowedNextStages(candidate.current_stage),
        };
    }

    // --- writes -------------------------------------------------------------

    /**
     * Create a candidate. Creation is itself the first audited event
     * (stage = Applied at T0).
     */
    createCandidate({ name, email, phone, role, source, notes } = {}) {
        if (!name || !String(name).trim()) {
            throw new DomainError('Candidate name is required.', 400, 'NAME_REQUIRED');
        }
        const nowIso = this.now().toISOString();

        const candidate = {
            id: this.db.nextId('candidates'),
            name: String(name).trim(),
            email: email ? String(email).trim() : null,
            phone: phone ? String(phone).trim() : null,
            role: role ? String(role).trim() : 'General',
            source: source ? String(source).trim() : 'Manual',
            notes: notes ? String(notes).trim() : null,
            current_stage: 'Applied',
            created_at: nowIso,
            updated_at: nowIso,
        };
        this.db.insertCandidate(candidate);

        this.db.insertHistory({
            id: this.db.nextId('history'),
            candidate_id: candidate.id,
            stage: 'Applied',
            entered_at: nowIso,
            exited_at: null,
            reason: 'Candidate created',
            created_by: 'recruiter',
        });

        this.db.persist();
        return this.getCandidate(candidate.id);
    }

    /**
     * Move a candidate to a new stage. Validates via the strict stage machine,
     * then appends history (never edits it).
     */
    moveStage(id, target, { reason } = {}) {
        const candidate = this.db.getCandidate(id);
        if (!candidate) throw new DomainError(`Candidate ${id} not found.`, 404, 'NOT_FOUND');

        const check = validateTransition(candidate.current_stage, target);
        if (!check.ok) {
            throw new DomainError(check.message, 409, check.code, {
                from: candidate.current_stage,
                to: target,
                allowed_next_stages: check.allowed,
            });
        }

        const nowIso = this.now().toISOString();

        // Strict append-only: we never mutate the previously open event. Its
        // exit timestamp is derived at read time from this event's entry time.
        this.db.insertHistory({
            id: this.db.nextId('history'),
            candidate_id: candidate.id,
            stage: target,
            entered_at: nowIso,
            exited_at: null, // legacy field; treated as derived on read
            reason: reason ? String(reason) : `Moved from ${candidate.current_stage} to ${target}`,
            created_by: 'recruiter',
        });

        const previousStage = candidate.current_stage;
        candidate.current_stage = target;
        candidate.updated_at = nowIso;
        this.db.persist();

        return {
            candidate: this.getCandidate(id),
            transition: { from: previousStage, to: target, at: nowIso },
        };
    }
}

module.exports = { HiringService, DomainError };
