'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createApp } = require('../src/server');
const { tmpFile } = require('./helpers');

function startServer() {
    const file = tmpFile('api');
    const { handler } = createApp({ file });
    const server = http.createServer(handler);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                port,
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

async function req(base, method, path, body) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

test('API: full lifecycle create → advance → terminal conflict', async () => {
    const s = await startServer();
    try {
        const created = await req(s.base, 'POST', '/api/candidates', { name: 'Priya Sharma' });
        assert.equal(created.status, 201);
        assert.equal(created.data.candidate.current_stage, 'Applied');
        const id = created.data.candidate.id;

        const moved = await req(s.base, 'POST', `/api/candidates/${id}/transition`, { to: 'Screening' });
        assert.equal(moved.status, 200);
        assert.equal(moved.data.candidate.current_stage, 'Screening');

        // Skipping a stage returns a 409 with an explanation.
        const skip = await req(s.base, 'POST', `/api/candidates/${id}/transition`, { to: 'Hired' });
        assert.equal(skip.status, 409);
        assert.equal(skip.data.code, 'SKIPPED_STAGE');
        assert.ok(skip.data.details.allowed_next_stages.includes('Interview'));

        const history = await req(s.base, 'GET', `/api/candidates/${id}/history`);
        assert.equal(history.data.history.length, 2);
    } finally {
        await s.close();
    }
});

test('API: missing name returns 400', async () => {
    const s = await startServer();
    try {
        const res = await req(s.base, 'POST', '/api/candidates', { email: 'x@y.com' });
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'NAME_REQUIRED');
    } finally {
        await s.close();
    }
});

test('API: search endpoint returns explained results', async () => {
    const s = await startServer();
    try {
        await req(s.base, 'POST', '/api/candidates', { name: 'Aman Kumar' });
        await req(s.base, 'POST', '/api/candidates', { name: 'Riya Singh' });

        const res = await req(s.base, 'GET', '/api/search?q=' + encodeURIComponent('Aman'));
        assert.equal(res.status, 200);
        assert.equal(res.data.ok, true);
        assert.ok(res.data.results.some((r) => r.name === 'Aman Kumar'));
        assert.ok(res.data.interpretation.length > 0);

        const bad = await req(s.base, 'GET', '/api/search?q=' + encodeURIComponent('zzzz nonsense'));
        assert.equal(bad.data.ok, false);
        assert.ok(bad.data.examples.length > 0);
    } finally {
        await s.close();
    }
});

test('API: unknown route returns 404', async () => {
    const s = await startServer();
    try {
        const res = await req(s.base, 'GET', '/api/does-not-exist');
        assert.equal(res.status, 404);
    } finally {
        await s.close();
    }
});
