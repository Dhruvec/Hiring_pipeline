'use strict';

/**
 * Zero-dependency HTTP server.
 *
 * Serves the static frontend from /public and exposes a small JSON REST API.
 * All business rules are enforced in the service layer (server.js only does
 * transport, validation-shape, and error mapping).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Database, DEFAULT_FILE } = require('./db');
const { HiringService, DomainError } = require('./service');
const { search, SEARCH_EXAMPLES } = require('./search');
const { seed } = require('./seed');
const { STAGES, REJECTED, allowedNextStages } = require('./stages');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 1_000_000) {
                reject(new DomainError('Request body too large.', 413, 'PAYLOAD_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new DomainError('Request body must be valid JSON.', 400, 'BAD_JSON'));
            }
        });
        req.on('error', reject);
    });
}

function createApp({ file = DEFAULT_FILE, service } = {}) {
    const db = new Database(file);
    db.load();
    const svc = service || new HiringService(db);

    async function handler(req, res) {
        let url;
        try {
            url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch {
            return sendJson(res, 400, { error: 'Malformed URL' });
        }
        const { pathname } = url;
        const method = req.method.toUpperCase();

        try {
            // ---- API ---------------------------------------------------------
            if (pathname.startsWith('/api/')) {
                return await handleApi({ req, res, method, pathname, url, svc });
            }

            // ---- Static frontend --------------------------------------------
            if (method === 'GET' || method === 'HEAD') {
                return serveStatic(res, pathname);
            }
            return sendJson(res, 405, { error: 'Method not allowed' });
        } catch (err) {
            if (err instanceof DomainError) {
                return sendJson(res, err.status, {
                    error: err.message,
                    code: err.code,
                    details: err.details,
                });
            }
            console.error('[server] Unhandled error:', err);
            return sendJson(res, 500, { error: 'Internal server error' });
        }
    }

    return { handler, db, service: svc };
}

async function handleApi({ req, res, method, pathname, url, svc }) {
    // GET /api/meta
    if (pathname === '/api/meta' && method === 'GET') {
        return sendJson(res, 200, {
            stages: [...STAGES, REJECTED],
            pipeline_order: STAGES,
            final_stages: ['Hired', 'Rejected'],
            examples: SEARCH_EXAMPLES,
        });
    }

    // GET /api/board
    if (pathname === '/api/board' && method === 'GET') {
        return sendJson(res, 200, svc.board());
    }

    // GET /api/candidates  &  POST /api/candidates
    if (pathname === '/api/candidates') {
        if (method === 'GET') {
            const stage = url.searchParams.get('stage') || undefined;
            return sendJson(res, 200, { candidates: svc.listCandidates({ stage }) });
        }
        if (method === 'POST') {
            const body = await readBody(req);
            const candidate = svc.createCandidate(body);
            return sendJson(res, 201, { candidate });
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // /api/candidates/:id
    const candMatch = pathname.match(/^\/api\/candidates\/(\d+)$/);
    if (candMatch) {
        const id = Number(candMatch[1]);
        if (method === 'GET') return sendJson(res, 200, { candidate: svc.getCandidate(id) });
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // GET /api/candidates/:id/history
    const histMatch = pathname.match(/^\/api\/candidates\/(\d+)\/history$/);
    if (histMatch) {
        const id = Number(histMatch[1]);
        if (method === 'GET') {
            return sendJson(res, 200, {
                candidate_id: id,
                history: svc.getHistory(id),
            });
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // POST /api/candidates/:id/transition   { to: "Screening", reason?: string }
    const moveMatch = pathname.match(/^\/api\/candidates\/(\d+)\/transition$/);
    if (moveMatch) {
        const id = Number(moveMatch[1]);
        if (method === 'POST') {
            const body = await readBody(req);
            if (!body.to) {
                throw new DomainError('Field "to" (target stage) is required.', 400, 'TARGET_REQUIRED');
            }
            const result = svc.moveStage(id, body.to, { reason: body.reason });
            return sendJson(res, 200, result);
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // GET /api/search?q=...
    if (pathname === '/api/search' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return sendJson(res, 200, search(q, svc));
    }

    return sendJson(res, 404, { error: `Unknown API route: ${method} ${pathname}` });
}

function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // Prevent path traversal.
    const target = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!target.startsWith(PUBLIC_DIR)) {
        return sendJson(res, 403, { error: 'Forbidden' });
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return sendJson(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(target).toLowerCase();
    const body = fs.readFileSync(target);
    res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
    });
    res.end(body);
}

function start() {
    // Seed on first boot so the app is never empty for a reviewer.
    seed({ file: DEFAULT_FILE });

    const { handler } = createApp();
    const server = http.createServer(handler);
    server.listen(PORT, HOST, () => {
        console.log(`Mini Hiring Pipeline running at http://${HOST}:${PORT}`);
        console.log('Press Ctrl+C to stop.');
    });
    return server;
}

if (require.main === module) {
    start();
}

module.exports = { createApp, start, serveStatic, handleApi };
