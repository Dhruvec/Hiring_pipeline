'use strict';

/**
 * Frontend controller for the Mini Hiring Pipeline.
 *
 * The UI never enforces business rules on its own; it renders what the backend
 * returns (including `allowed_next_stages`) and surfaces backend validation
 * errors verbatim. This keeps business rules on the server.
 */

const API = {
    meta: () => fetch('/api/meta').then(handle),
    board: () => fetch('/api/board').then(handle),
    candidate: (id) => fetch(`/api/candidates/${id}`).then(handle),
    history: (id) => fetch(`/api/candidates/${id}/history`).then(handle),
    create: (body) =>
        fetch('/api/candidates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(handle),
    transition: (id, to, reason) =>
        fetch(`/api/candidates/${id}/transition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, reason }),
        }).then(handle),
    search: (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then(handle),
};

async function handle(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.code = data.code;
        err.details = data.details;
        err.status = res.status;
        throw err;
    }
    return data;
}

const state = {
    meta: null,
    board: null,
    activeCandidate: null,
    searchActive: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const STAGE_CLASS = {
    Applied: 'stage-applied',
    Screening: 'stage-screening',
    Interview: 'stage-interview',
    Offer: 'stage-offer',
    Hired: 'final-hired',
    Rejected: 'final-rejected',
};

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
}

function initials(name) {
    return String(name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase();
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function renderBoard() {
    const board = state.board;
    const el = $('#board');
    if (!board) return;

    el.innerHTML = board.columns
        .map((col) => {
            const cards = col.candidates.length
                ? col.candidates.map(cardHtml).join('')
                : '<div class="empty-col">No candidates</div>';
            return `
        <section class="column" data-stage="${col.stage}">
          <header class="column-head">
            <h3>${col.stage}${col.is_final ? ' <span class="pill">final</span>' : ''}</h3>
            <span class="column-count">${col.candidates.length}</span>
          </header>
          <div class="column-body">${cards}</div>
        </section>`;
        })
        .join('');

    el.querySelectorAll('.card').forEach((card) => {
        card.addEventListener('click', () => openCandidate(Number(card.dataset.id)));
    });
}

function cardHtml(c) {
    const pill = c.is_final
        ? `<span class="pill ${STAGE_CLASS[c.current_stage]}">${c.current_stage}</span>`
        : `<span class="pill">${c.time_in_stage}</span>`;
    return `
    <article class="card" data-id="${c.id}">
      <p class="card-name">${escapeHtml(c.name)}</p>
      <p class="card-role">${escapeHtml(c.role || '')}</p>
      <div class="card-foot">
        <span>in stage</span>
        ${pill}
      </div>
    </article>`;
}

async function refreshBoard() {
    const data = await API.board();
    state.board = data;
    renderBoard();
}

// ---------------------------------------------------------------------------
// Candidate drawer
// ---------------------------------------------------------------------------

async function openCandidate(id) {
    const [{ candidate }, { history }] = await Promise.all([
        API.candidate(id),
        API.history(id),
    ]);
    state.activeCandidate = candidate;

    $('#drawer-identity').innerHTML = `
    <h2>${escapeHtml(candidate.name)}</h2>
    <p>${escapeHtml(candidate.role || 'Candidate')} &middot; ${escapeHtml(candidate.email || 'no email')}</p>`;

    const body = $('#drawer-body');
    body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-box">
        <div class="k">Current stage</div>
        <div class="v" id="detail-stage">${escapeHtml(candidate.current_stage)}</div>
      </div>
      <div class="detail-box">
        <div class="k">Stage duration</div>
        <div class="v">${escapeHtml(candidate.time_in_stage)}</div>
      </div>
      <div class="detail-box">
        <div class="k">Entered stage</div>
        <div class="v" style="font-size:13px">${fmtDate(candidate.entered_current_stage_at)}</div>
      </div>
      <div class="detail-box">
        <div class="k">Added</div>
        <div class="v" style="font-size:13px">${fmtDate(candidate.created_at)}</div>
      </div>
    </div>

    <p class="section-title">Move stage</p>
    <div class="transition-actions" id="transition-actions">${transitionButtons(candidate)}</div>

    <p class="section-title">History (immutable audit trail)</p>
    <ul class="timeline" id="timeline">${historyHtml(history)}</ul>`;

    bindTransitionButtons(candidate);
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
}

function transitionButtons(candidate) {
    if (candidate.is_final) {
        return `<div class="terminal-note">
      “${escapeHtml(candidate.current_stage)}” is a final outcome. Final outcomes cannot be reversed or changed.
      This candidate's history is preserved for auditing.</div>`;
    }
    const buttons = candidate.allowed_next_stages.map((stage) => {
        if (stage === 'Rejected') {
            return `<button class="btn btn-reject" data-to="Rejected">Reject</button>`;
        }
        return `<button class="btn btn-advance" data-to="${stage}">Move to ${stage}</button>`;
    });
    return buttons.join('');
}

function historyHtml(history) {
    return history
        .map((e) => {
            const cls = [
                'tl-item',
                e.is_current ? 'current' : '',
                e.stage === 'Hired' ? 'final-hired' : '',
                e.stage === 'Rejected' ? 'final-rejected' : '',
            ].join(' ');
            const badge = e.is_current ? '<span class="tl-badge">current</span>' : '';
            const exited = e.exited_at ? `→ exited ${fmtDate(e.exited_at)}` : '→ ongoing';
            return `
        <li class="${cls}">
          <span class="tl-dot"></span>
          <div class="tl-stage">${escapeHtml(e.stage)}${badge}</div>
          <div class="tl-meta">entered ${fmtDate(e.entered_at)}</div>
          <div class="tl-dur">${exited} &middot; ${escapeHtml(e.duration_in_stage)}</div>
          <div class="tl-reason">${escapeHtml(e.reason || '')}</div>
        </li>`;
        })
        .join('');
}

function bindTransitionButtons(candidate) {
    document.querySelectorAll('#transition-actions [data-to]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const to = btn.dataset.to;
            const verb = to === 'Rejected' ? 'reject' : `move to ${to}`;
            if (!confirm(`Confirm: ${verb} ${candidate.name}?`)) return;
            btn.disabled = true;
            try {
                const result = await API.transition(candidate.id, to);
                toast(`${candidate.name}: ${result.transition.from} → ${result.transition.to}`);
                await refreshBoard();
                await openCandidate(candidate.id);
                if (state.searchActive) runSearch();
            } catch (err) {
                toast(err.message, true);
                btn.disabled = false;
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Add candidate
// ---------------------------------------------------------------------------

function openModal() {
    $('#modal').hidden = false;
    $('#form-error').hidden = true;
    $('#add-form').reset();
    $('#add-form input[name="name"]').focus();
}
function closeModal() { $('#modal').hidden = true; }

async function submitAdd(e) {
    e.preventDefault();
    const form = e.target;
    const body = Object.fromEntries(new FormData(form).entries());
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
        const { candidate } = await API.create(body);
        closeModal();
        toast(`Added ${candidate.name} to Applied`);
        await refreshBoard();
    } catch (err) {
        const box = $('#form-error');
        box.textContent = err.message;
        box.hidden = false;
    } finally {
        submitBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch() {
    const q = $('#search-input').value.trim();
    if (!q) return;
    const panel = $('#search-panel');
    panel.hidden = false;
    state.searchActive = true;
    $('#search-clear').hidden = false;

    $('#search-interpretation').textContent = 'Searching…';
    $('#search-results').innerHTML = '';
    $('#search-title').textContent = `Search results for “${q}”`;

    try {
        const data = await API.search(q);
        renderSearch(data);
    } catch (err) {
        $('#search-results').innerHTML = `<div class="notice"><strong>Search failed.</strong>${escapeHtml(err.message)}</div>`;
    }
}

function renderSearch(data) {
    $('#search-interpretation').textContent = data.interpretation || '';

    const resultsEl = $('#search-results');

    if (!data.ok) {
        resultsEl.innerHTML = `
      <div class="notice">
        <strong>I couldn't answer that yet.</strong>
        ${escapeHtml(data.interpretation)}
        <ul>${(data.examples || []).map((ex) => `<li data-example="${escapeHtml(ex)}">${escapeHtml(ex)}</li>`).join('')}</ul>
      </div>`;
        resultsEl.querySelectorAll('[data-example]').forEach((li) => {
            li.addEventListener('click', () => { $('#search-input').value = li.dataset.example; runSearch(); });
        });
        return;
    }

    if (!data.results.length) {
        resultsEl.innerHTML = `
      <div class="notice">
        <strong>No candidates matched.</strong>
        ${escapeHtml(data.interpretation)}
      </div>`;
        return;
    }

    resultsEl.innerHTML = data.results
        .map((r) => `
      <div class="result-row" data-id="${r.id}">
        <div>
          <p class="result-name">${escapeHtml(r.name)}</p>
          <p class="result-meta">
            Current stage: <strong>${escapeHtml(r.current_stage)}</strong>
            &middot; In stage: <strong>${escapeHtml(r.time_in_stage)}</strong>
            &middot; since ${fmtDate(r.entered_current_stage_at)}
          </p>
          <div class="result-reasons">
            ${r.reasons.map((reason) => `<span class="reason">${escapeHtml(reason)}</span>`).join('')}
          </div>
        </div>
        <div class="result-side">
          <span class="score">score ${r.score}</span>
          <button class="btn btn-ghost" data-open="${r.id}">Open</button>
        </div>
      </div>`)
        .join('');

    resultsEl.querySelectorAll('[data-open]').forEach((btn) => {
        btn.addEventListener('click', () => openCandidate(Number(btn.dataset.open)));
    });
}

function clearSearch() {
    state.searchActive = false;
    $('#search-panel').hidden = true;
    $('#search-clear').hidden = true;
    $('#search-input').value = '';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&': return '\u0026amp;';
            case '<': return '\u0026lt;';
            case '>': return '\u0026gt;';
            case '"': return '\u0026quot;';
            case "'": return '\u0026#39;';
            default: return ch;
        }
    });
}

let toastTimer;
function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function init() {
    const meta = await API.meta();
    state.meta = meta;

    const examplesEl = $('#examples');
    examplesEl.innerHTML = meta.examples
        .map((ex) => `<button class="chip" data-example="${escapeHtml(ex)}">${escapeHtml(ex)}</button>`)
        .join('');
    examplesEl.querySelectorAll('[data-example]').forEach((chip) => {
        chip.addEventListener('click', () => { $('#search-input').value = chip.dataset.example; runSearch(); });
    });

    await refreshBoard();

    $('#search-btn').addEventListener('click', runSearch);
    $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    $('#search-clear').addEventListener('click', clearSearch);
    $('#search-close').addEventListener('click', clearSearch);

    $('#add-btn').addEventListener('click', openModal);
    $('#modal-close').addEventListener('click', closeModal);
    $('#cancel-add').addEventListener('click', closeModal);
    $('#add-form').addEventListener('submit', submitAdd);

    $('#drawer-close').addEventListener('click', () => {
        $('#drawer').hidden = true;
        $('#scrim').hidden = true;
    });
    $('#scrim').addEventListener('click', () => {
        $('#drawer').hidden = true;
        $('#scrim').hidden = true;
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!$('#modal').hidden) closeModal();
            else if (!$('#drawer').hidden) { $('#drawer').hidden = true; $('#scrim').hidden = true; }
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => toast(err.message, true));
});
