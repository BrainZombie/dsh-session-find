/**
 * Persistent FTS5 index over session transcripts.
 *
 * Why an index: decoding 400 transcripts takes ~1-4 s (zstd + JSON), which is
 * fine once and wasteful per query. The index keeps a row per event and syncs
 * only sessions whose file mtime/size changed, so a warm search is milliseconds.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { listTranscripts, readMetadata, readTranscript, describeEvent } from './store.js';

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        workspace TEXT,
        cwd TEXT,
        title TEXT,
        created_at INTEGER,
        mtime REAL,
        size INTEGER,
        events INTEGER
    )`,
    // unicode61 + 前缀通配：索引比 trigram 小一半以上（129MB vs 307MB），
    // 中文短查询/子串由 LIKE 兜底；想要纯子串检索可把 tokenize 改成 trigram。
    `CREATE VIRTUAL TABLE IF NOT EXISTS events USING fts5(
        session_id UNINDEXED,
        seq UNINDEXED,
        kind UNINDEXED,
        grp UNINDEXED,
        weight UNINDEXED,
        text
    )`,
    `CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT)`,
];

let DatabaseSync;
async function loadSqlite() {
    if (DatabaseSync !== undefined) return DatabaseSync;
    try {
        ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
        DatabaseSync = null;
    }
    return DatabaseSync;
}

/** Whether this Node build can provide the index at all. */
export async function sqliteAvailable() {
    return (await loadSqlite()) !== null;
}

/** Open (and create) the index. Returns null when node:sqlite is unavailable. */
export async function openIndex(path) {
    const Driver = await loadSqlite();
    if (Driver === null) return null;
    mkdirSync(dirname(path), { recursive: true });
    const db = new Driver(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // Schema upgrades are derived-only: drop and let the next sync rebuild.
    const columns = db.prepare("SELECT name FROM pragma_table_info('events')").all().map((row) => row.name);
    if (columns.length > 0 && !columns.includes('grp')) {
        db.exec('DROP TABLE IF EXISTS events');
        db.exec('DROP TABLE IF EXISTS sessions');
        db.exec('DROP TABLE IF EXISTS state');
    }
    for (const statement of SCHEMA) db.exec(statement);
    return db;
}

function known(db, id) {
    return db.prepare('SELECT mtime, size FROM sessions WHERE id = ?').get(id);
}

function replaceSession(db, row, events) {
    db.prepare('DELETE FROM events WHERE session_id = ?').run(row.id);
    const insert = db.prepare('INSERT INTO events(session_id, seq, kind, grp, weight, text) VALUES (?, ?, ?, ?, ?, ?)');
    let kept = 0;
    for (const event of events) {
        const { seq, type, role, text, group, weight } = describeEvent(event);
        if (text === '') continue;
        insert.run(row.id, seq, role ? `${type}:${role}` : type, group, weight, text);
        kept += 1;
    }
    db.prepare(
        `INSERT INTO sessions(id, workspace, cwd, title, created_at, mtime, size, events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            workspace = excluded.workspace, cwd = excluded.cwd, title = excluded.title,
            created_at = excluded.created_at, mtime = excluded.mtime,
            size = excluded.size, events = excluded.events`,
    ).run(row.id, row.workspace, row.cwd ?? '', row.title ?? '', row.createdAt ?? 0, row.mtime, row.size, kept);
    return kept;
}

/**
 * Bring the index up to date. Only changed transcripts are re-read, so the
 * steady-state cost is a stat() per session.
 */
export async function syncIndex(db, dshHome, options = {}) {
    const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : Infinity;
    const maxMs = Number.isFinite(options.maxMs) && options.maxMs > 0 ? options.maxMs : 0;
    const startedAt = Date.now();
    const meta = readMetadata(dshHome);
    const transcripts = listTranscripts(dshHome).filter((row) => options.includeArchived !== false || !row.workspace.includes('archive'));
    const stats = { checked: transcripts.length, indexed: 0, unchanged: 0, skipped: 0, events: 0 };
    const pending = [];
    for (const row of transcripts) {
        const previous = known(db, row.id);
        if (previous && Math.abs(previous.mtime - row.mtime) < 1 && previous.size === row.size) {
            stats.unchanged += 1;
            continue;
        }
        pending.push(row);
    }
    if (pending.length === 0) return { ...stats, pending: 0 };
    const budgetHits = [];

    db.exec('BEGIN');
    try {
        for (const row of pending) {
            if (stats.indexed + stats.skipped >= maxSessions) break;
            if (maxMs > 0 && Date.now() - startedAt > maxMs) break;
            budgetHits.push(row.id);
            try {
                const events = await readTranscript(row.file);
                const info = meta.get(row.id) ?? {};
                stats.events += replaceSession(db, { ...row, ...info }, events);
                stats.indexed += 1;
            } catch {
                stats.skipped += 1;
            }
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    db.prepare(
        `INSERT INTO state(key, value) VALUES ('lastSync', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(Date.now()));
    return { ...stats, pending: pending.length - budgetHits.length };
}

/** Drop every indexed row and rebuild from disk. */
export async function rebuildIndex(db, dshHome, options = {}) {
    db.exec('DELETE FROM events');
    db.exec('DELETE FROM sessions');
    return syncIndex(db, dshHome, options);
}

function phrase(query) {
    return `"${String(query).replace(/"/g, '""')}"`;
}

function terms(query) {
    return String(query)
        .split(/[\s,，、]+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0)
        .map((term) => `"${term.replace(/"/g, '""')}"`)
        .join(' OR ');
}

/**
 * Search indexed events. Tries the query as a phrase first (precise), then as
 * an OR of its words (recall), so a multi-word query still finds something.
 */
export function search(db, query, options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
    const since = Number(options.since) || 0;
    const until = Number(options.until) || 0;
    const cwdNeedle = typeof options.cwd === 'string' ? options.cwd.trim().toLowerCase() : '';
    const groups = Array.isArray(options.groups) && options.groups.length > 0 ? options.groups : null;
    const sortBy = options.sortBy === 'time' ? 'time' : 'score';
    const scanLimit = Math.max(limit * 12, 400);

    const meta = new Map();
    for (const row of db.prepare('SELECT id, title, cwd, workspace, created_at AS createdAt, mtime FROM sessions').all()) {
        meta.set(row.id, row);
    }

    const keep = (hit) => {
        const info = meta.get(hit.id);
        if (info === undefined) return null;
        if (since !== 0 && info.createdAt < since) return null;
        if (until !== 0 && info.createdAt > until) return null;
        if (cwdNeedle !== '' && String(info.cwd ?? '').toLowerCase().includes(cwdNeedle) === false) return null;
        if (groups !== null && !groups.includes(hit.grp)) return null;
        return { ...hit, title: info.title, cwd: info.cwd, workspace: info.workspace, createdAt: info.createdAt, mtime: info.mtime };
    };

    // FTS5 must not be joined (ambiguous MATCH); the rank column carries the score.
    const fts = db.prepare(
        `SELECT session_id AS id, seq, kind, grp, weight,
                snippet(events, 5, '《', '》', ' … ', 24) AS snippet,
                rank AS ftsRank
           FROM events
          WHERE events MATCH ?
          ORDER BY rank
          LIMIT ?`,
    );

    const trimmed = String(query).trim();
    const phrase = `"${trimmed.replace(/"/g, '""')}"*`;
    let rows = [];
    let match = '';
    if (trimmed.length > 0) {
        try {
            const raw = fts.all(phrase, scanLimit);
            match = phrase;
            for (const hit of raw) {
                const kept = keep(hit);
                if (kept === null) continue;
                // 权重放大：消息内容 > 工具噪音（同 dsh-search-index 的 TYPE_WEIGHT）
                kept.score = -Number(kept.ftsRank) * Number(kept.weight || 1);
                rows.push(kept);
            }
        } catch (error) {
            rows = [];
            match = '';
            var ftsError = error;
        }
    }

    if (rows.length === 0) {
        // trigram 需要 ≥3 字符；短查询/特殊符号落到 LIKE 扫描，保证不空手而归。
        try {
            const like = `%${String(query).trim()}%`;
            const raw = db
                .prepare(`SELECT session_id AS id, seq, kind, grp, weight, text FROM events WHERE text LIKE ? LIMIT ?`)
                .all(like, scanLimit);
            match = 'LIKE';
            for (const hit of raw) {
                const kept = keep(hit);
                if (kept === null) continue;
                const at = String(hit.text).toLowerCase().indexOf(String(query).trim().toLowerCase());
                const from = Math.max(0, at - 40);
                kept.snippet = String(hit.text).slice(from, from + 180);
                kept.score = Number(kept.weight || 1);
                rows.push(kept);
                if (rows.length >= scanLimit) break;
            }
        } catch (error) {
            return { rows: [], error: error instanceof Error ? error.message : String(error) };
        }
    }

    // 会话级分组：每会话按最高加权分排序，组内按分数排
    const bySession = new Map();
    for (const row of rows) {
        const list = bySession.get(row.id) ?? [];
        list.push(row);
        bySession.set(row.id, list);
    }
    const sessions = [...bySession.entries()].map(([id, hits]) => {
        hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
        return { id, hits, best: hits[0].score, updatedAt: Math.max(...hits.map((hit) => hit.mtime || 0)) };
    });
    sessions.sort((a, b) => (sortBy === 'time' ? b.updatedAt - a.updatedAt : b.best - a.best));

    const flat = [];
    for (const session of sessions) {
        for (const hit of session.hits) {
            flat.push(hit);
            if (flat.length >= limit) break;
        }
        if (flat.length >= limit) break;
    }
    if (flat.length === 0) return { rows: [], match };
    return { rows: flat, match };
}

/** Title / cwd lookup: the cheap "which session was that" path. */
export function searchTitles(db, needle, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const like = `%${String(needle).trim()}%`;
    return db
        .prepare(
            `SELECT id, title, cwd, workspace, created_at AS createdAt, mtime, events
               FROM sessions
              WHERE title LIKE ? OR cwd LIKE ?
              ORDER BY mtime DESC LIMIT ?`,
        )
        .all(like, like, limit);
}

/** Index statistics for the status tool. */
export function stats(db) {
    const sessions = db.prepare('SELECT count(*) AS c FROM sessions').get();
    const events = db.prepare('SELECT count(*) AS c FROM events').get();
    const last = db.prepare("SELECT value FROM state WHERE key = 'lastSync'").get();
    const newest = db.prepare('SELECT mtime FROM sessions ORDER BY mtime DESC LIMIT 1').get();
    return {
        sessions: Number(sessions?.c ?? 0),
        events: Number(events?.c ?? 0),
        lastSync: last ? Number(last.value) : 0,
        newestSession: newest ? Number(newest.mtime) : 0,
    };
}

/** One session's indexed events in seq order (for range reads). */
export function sessionEvents(db, sessionId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 200) {
    return db
        .prepare(
            `SELECT seq, kind, text FROM events
              WHERE session_id = ? AND seq >= ? AND seq <= ?
              ORDER BY seq LIMIT ?`,
        )
        .all(sessionId, from, to, Math.max(1, Math.min(1000, limit)));
}
