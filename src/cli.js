'use strict';

/**
 * Small command-line interface for the pipeline (handy for demos and CI smoke
 * tests without starting the HTTP server).
 *
 * Usage:
 *   node src/cli.js board
 *   node src/cli.js search "Stuck in Screening for more than a week"
 *   node src/cli.js show 1
 */

const { Database, DEFAULT_FILE } = require('./db');
const { HiringService } = require('./service');
const { search } = require('./search');
const { seed } = require('./seed');

function getService(file = DEFAULT_FILE) {
    seed({ file });
    const db = new Database(file);
    db.load();
    return new HiringService(db);
}

function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString() : '—';
}

function cmdBoard(service) {
    const board = service.board();
    console.log(`Pipeline — ${board.total} candidate(s)\n`);
    for (const col of board.columns) {
        console.log(`${col.stage}${col.is_final ? ' (final)' : ''} — ${col.candidates.length}`);
        for (const c of col.candidates) {
            console.log(`   • ${c.name} (${c.time_in_stage})`);
        }
    }
}

function cmdSearch(service, query) {
    const result = search(query, service);
    console.log(`Query: ${result.query}`);
    console.log(`${result.interpretation}\n`);
    if (!result.results.length) {
        console.log('No results.');
        return;
    }
    for (const r of result.results) {
        console.log(`• ${r.name} — ${r.current_stage} for ${r.time_in_stage} (score ${r.score})`);
        console.log(`    why: ${r.reasons.join('; ')}`);
    }
}

function cmdShow(service, id) {
    const c = service.getCandidate(Number(id));
    console.log(`${c.name} — ${c.role || ''}`);
    console.log(`Current stage : ${c.current_stage}`);
    console.log(`Time in stage : ${c.time_in_stage}`);
    console.log(`Allowed next  : ${c.allowed_next_stages.join(', ') || '(terminal)'}\n`);
    console.log('History (audit trail):');
    for (const e of service.getHistory(c.id)) {
        console.log(`  [${e.stage}] entered ${fmtDate(e.entered_at)}` +
            `  exited ${e.exited_at ? fmtDate(e.exited_at) : 'ongoing'}` +
            `  (${e.duration_in_stage})${e.is_current ? '  ← current' : ''}`);
    }
}

if (require.main === module) {
    const [cmd, ...rest] = process.argv.slice(2);
    const service = getService();
    switch (cmd) {
        case 'board': cmdBoard(service); break;
        case 'search': cmdSearch(service, rest.join(' ')); break;
        case 'show': cmdShow(service, rest[0]); break;
        default:
            console.log('Usage: node src/cli.js <board|search <query>|show <id>>');
    }
}

module.exports = { getService, cmdBoard, cmdSearch, cmdShow };
