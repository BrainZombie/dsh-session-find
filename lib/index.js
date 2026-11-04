/**
 * dsh-session-find — cross-session search that actually answers.
 *
 * The bundled `session_search` builds an FTS index on first use and never
 * finishes on a large history (409 sessions / 365 MB decompressed here), so
 * every call ends as a 30 s timeout or "session history storage is unavailable".
 * This plugin keeps its own persistent FTS5 index, syncs only changed
 * transcripts, and redacts credentials before anything reaches the model.
 */
import { join } from 'node:path';
import { loadHostModule, dshHomePath } from './host.js';
import { openIndex, search, searchTitles, stats, syncIndex, rebuildIndex, sessionEvents } from './indexdb.js';
import { redact } from './redact.js';
import { listTranscripts, readMetadata, readTranscript, describeEvent, resolveDshHome } from './store.js';

const name = 'session-find';
const inject = ['tools'];

const DEFAULTS = Object.freeze({
    indexPath: '',
    // 默认不脱敏：会话历史的原文才是能力本身，脱敏是可选开关（用户 2026-11-03 明确）
    redact: false,
    extraRedactPatterns: [],
    includeArchived: true,
    maxResults: 40,
    snippetChars: 240,
    autoSync: true,
    syncTtlMs: 3000,
    // 单次调用最多花多久做增量；剩下的交给后台补齐，避免首查把宿主卡住
    syncCallBudgetMs: 1200,
    syncCallMaxSessions: 24,
    warmUpOnStart: true,
});

function normalizeConfig(raw) {
    const config = { ...DEFAULTS, ...(raw ?? {}) };
    config.redact = config.redact === true;
    config.includeArchived = config.includeArchived !== false;
    config.autoSync = config.autoSync !== false;
    config.maxResults = Math.max(1, Math.min(200, Number(config.maxResults) || DEFAULTS.maxResults));
    config.snippetChars = Math.max(80, Math.min(2000, Number(config.snippetChars) || DEFAULTS.snippetChars));
    config.extraRedactPatterns = Array.isArray(config.extraRedactPatterns) ? config.extraRedactPatterns : [];
    return config;
}

const pad = (value, width) => String(value).padEnd(width);
const clock = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '?');

/** One line per hit, grouped by session. */
function formatHits(rows, options) {
    const mask = typeof options.mask === 'function' ? options.mask : (text) => text;
    if (rows.length === 0) return '没有命中。可以换关键词，或用 session_index 看索引状态。';
    const bySession = new Map();
    for (const row of rows) {
        const list = bySession.get(row.id) ?? [];
        list.push(row);
        bySession.set(row.id, list);
    }
    const out = [];
    for (const [id, hits] of bySession) {
        const head = hits[0];
        out.push(`\n=== ${id}  [${clock(head.createdAt || head.mtime)}]  ${head.cwd || ''}`);
        const detail = head.events !== undefined ? `${head.events} 条事件` : `${hits.length} 处命中`;
        out.push(`    ${mask(head.title || '(无标题)')}  ·  ${head.workspace || ''}  ·  ${detail}`);
        const take = Math.max(1, Math.min(hits.length, options.perSession));
        for (const hit of hits.slice(0, take)) {
            if (hit.snippet === undefined) continue;
            const snippet = mask(String(hit.snippet).replace(/\s+/g, ' ').slice(0, options.snippetChars));
            out.push(`    seq ${pad(hit.seq, 5)} ${pad(hit.kind ?? '', 22)} ${snippet}`);
        }
        if (hits.length > take) out.push(`    …还有 ${hits.length - take} 处（加 perSession 可看更多）`);
    }
    return out.join('\n');
}

/** Direct scan used when node:sqlite is missing: slower, still correct. */
async function scanFallback(dshHome, query, options) {
    const needle = query.toLowerCase();
    const meta = readMetadata(dshHome);
    const rows = [];
    for (const row of listTranscripts(dshHome)) {
        let events;
        try {
            events = await readTranscript(row.file);
        } catch {
            continue;
        }
        const info = meta.get(row.id) ?? {};
        let hits = 0;
        for (const event of events) {
            const described = describeEvent(event);
            if (!described.text.toLowerCase().includes(needle)) continue;
            const index = described.text.toLowerCase().indexOf(needle);
            const from = Math.max(0, index - 60);
            rows.push({
                id: row.id,
                seq: described.seq,
                kind: described.role ? `${described.type}:${described.role}` : described.type,
                snippet: described.text.slice(from, from + 160),
                title: info.title ?? '',
                cwd: info.cwd ?? '',
                workspace: row.workspace,
                createdAt: info.createdAt ?? 0,
                mtime: row.mtime,
            });
            hits += 1;
            if (hits >= options.perSession) break;
        }
        if (rows.length >= options.limit) break;
    }
    return rows.slice(0, options.limit);
}

export async function apply(ctx, rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    const dshHome = resolveDshHome(config.dshHome);
    const indexPath = config.indexPath || join(dshHome, 'storages', 'session-find', 'index.db');

    // ToolRuntime 缺席时不要让整行崩掉：cordis 的 inject 声明保证真实宿主里它一定在，
    // 这一层只是把「没有工具可注册」变成安静返回，而不是让插件行变红。
    const tools = (() => {
        try {
            return ctx.tools;
        } catch {
            return undefined;
        }
    })();
    if (!tools || typeof tools.register !== 'function') return;

    const { defineTool } = await loadHostModule('@deepseek-ai/dsh-tools');
    const TEXT_OUTPUT = {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    };

    let indexPromise;
    let openHandle = null;
    let warming = null;
    let lastSyncSummary = null;
    const getIndex = async () => {
        indexPromise ??= (async () => {
            const handle = await openIndex(indexPath);
            openHandle = handle;
            return handle;
        })();
        return indexPromise;
    };
    // Hot reload must not leak the sqlite handle (Windows keeps -wal/-shm locked).
    ctx.effect?.(() => () => {
        try {
            openHandle?.close?.();
        } catch {
            /* already closed */
        }
        openHandle = null;
        indexPromise = undefined;
    });

    /** Sync then answer; a sync failure degrades to a scan, never to an error. */
    let lastSyncAt = 0;
    const withIndex = async (run) => {
        let db = null;
        try {
            db = await getIndex();
        } catch {
            db = null;
        }
        if (db === null) return { db: null, result: await run(null) };
        let sync = null;
        const throttled = Date.now() - lastSyncAt < Math.max(0, Number(config.syncTtlMs) || 0);
        if (config.autoSync && !throttled) {
            try {
                const started = Date.now();
                // 空索引（首次安装 / schema 迁移后）给一次大预算：宁可等 6 秒出结果，
                // 也不要让用户看到"命中 0 条"。之后每轮只吃小预算，剩下的后台补齐。
                const empty = Number(stats(db).sessions) === 0;
                sync = await syncIndex(db, dshHome, {
                    includeArchived: config.includeArchived,
                    maxMs: empty ? 6000 : Math.max(200, Number(config.syncCallBudgetMs) || 1200),
                    maxSessions: empty ? 150 : Math.max(4, Number(config.syncCallMaxSessions) || 24),
                });
                sync.elapsedMs = Date.now() - started;
                lastSyncAt = Date.now();
                lastSyncSummary = sync;
                if (Number(sync.pending) > 0) scheduleWarm(db);
            } catch (error) {
                sync = { error: error instanceof Error ? error.message : String(error) };
            }
        } else if (throttled) {
            sync = { skipped: true };
        }
        return { db, sync, result: await run(db) };
    };

    const scheduleWarm = (db) => {
        if (warming !== null) return;
        warming = setTimeout(async () => {
            warming = null;
            try {
                const result = await syncIndex(db, dshHome, { includeArchived: config.includeArchived, maxMs: 800, maxSessions: 24 });
                if (Number(result.pending) > 0) scheduleWarm(db);
            } catch {
                /* 后台补齐失败不影响查询，下一次调用会重试 */
            }
        }, 50);
        warming.unref?.();
    };

    tools.register(
        defineTool({
            name: 'session_find',
            description:
                'Search every DSH session transcript on this machine (persistent FTS5 index, warm search is milliseconds). '
                + 'Use instead of session_search: that tool\'s own index never finishes building on this host. '
                + 'Returns session id, title, cwd, time and matching events; read one with `session_show`. '
                + 'Credential-shaped values are masked by default.',
            parameters: {
                query: { type: 'string', required: true, description: '要搜的关键词或词组，原样匹配（词组按短语优先，全无结果时自动退化为逐词 OR）。' },
                since: { type: 'string', description: '只要该时间之后的会话，ISO 日期（如 2026-11-01）。' },
                until: { type: 'string', description: '只要该时间之前的会话，ISO 日期。' },
                cwd: { type: 'string', description: '按会话工作目录过滤，子串匹配（如 C:\\tools）。' },
                limit: { type: 'number', description: '最多返回多少条命中事件，默认 40。' },
                perSession: { type: 'number', description: '每个会话最多显示几处命中，默认 3。' },
                redact: { type: 'boolean', description: '是否屏蔽口令类片段，默认关（原文优先）。' },
                types: { type: 'string', description: '只搜某类事件：user / reply / tool / all，默认 all（可逗号组合）。' },
                titleMode: { type: 'boolean', description: '只按会话标题/工作目录找会话（不搜正文），适合“我记得标题里有 X”。' },
                sortBy: { type: 'string', enum: ['score', 'time'], description: '排序：score=相关度（默认，消息权重高于工具输出）｜time=按会话时间倒序。' },
            },
            output: TEXT_OUTPUT,
            timeoutMs: 120000,
            async execute(args) {
                const limit = Math.max(1, Math.min(200, Number(args.limit) || config.maxResults));
                const perSession = Math.max(1, Math.min(10, Number(args.perSession) || 3));
                const options = { limit, perSession, snippetChars: config.snippetChars };
                const since = args.since ? Date.parse(args.since) : 0;
                const until = args.until ? Date.parse(args.until) + 86_400_000 : 0;
                const useRedact = args.redact === true ? true : config.redact;

                const groupMap = { user: 'user', reply: 'reply', assistant: 'reply', tool: 'tool', other: 'other' };
                const groups = typeof args.types === 'string' && args.types.trim() !== '' && args.types.trim().toLowerCase() !== 'all'
                    ? String(args.types).split(/[,，\s]+/).map((entry) => groupMap[entry.trim().toLowerCase()]).filter(Boolean)
                    : null;
                const titleMode = args.titleMode === true;

                const { db, sync, result } = await withIndex(async (handle) => {
                    if (handle === null) return null;
                    if (titleMode) return { rows: searchTitles(handle, args.query, { limit }), match: 'TITLE' };
                    return search(handle, args.query, { limit, since, until, cwd: args.cwd, groups, sortBy: args.sortBy });
                });

                const rows = result?.rows ?? (db === null ? await scanFallback(dshHome, args.query, options) : []);
                const mask = useRedact ? (text) => redact(text, config.extraRedactPatterns) : (text) => text;
                const out = formatHits(rows, { ...options, perSession, mask });
                const header = [
                    `查询「${args.query}」｜命中 ${rows.length} 条｜索引 ${db === null ? '不可用（已退回直读扫描）' : 'FTS5'}`,
                    sync && !sync.error ? `同步：新/更新 ${sync.indexed} 个会话、跳过 ${sync.unchanged}、耗时 ${sync.elapsedMs} ms${Number(sync.pending) > 0 ? `、后台补齐中（还剩 ${sync.pending}）` : ''}` : '',
                    sync?.error ? `同步告警：${sync.error}` : '',
                    result?.error ? `检索告警：${result.error}` : '',
                ].filter(Boolean).join('｜');
                return `${header}\n${out}`;
            },
        }),
    );

    tools.register(
        defineTool({
            name: 'session_show',
            description: 'Read one session by id: metadata plus its events in seq order (optionally a range). Use after session_find. '
                + 'Reads the transcript directly, so it always reflects what is on disk.',
            parameters: {
                session_id: { type: 'string', required: true, description: '会话 id，可带或不带 session- 前缀。' },
                seqFrom: { type: 'number', description: '起始 seq（含），默认从头。' },
                seqTo: { type: 'number', description: '结束 seq（含），默认到末尾。' },
                limit: { type: 'number', description: '最多输出多少条事件，默认 40。' },
                redact: { type: 'boolean', description: '是否屏蔽口令类片段，默认关。' },
                maxChars: { type: 'number', description: '每条事件最多输出多少字符，默认 0 = 不截断。' },
            },
            output: TEXT_OUTPUT,
            timeoutMs: 60000,
            async execute(args) {
                const id = String(args.session_id).replace(/^session-/, '');
                const row = listTranscripts(dshHome).find((entry) => entry.id === id);
                if (!row) return `找不到会话 ${id}。可以先 session_index(action:"status")，或用 session_find 搜关键词。`;
                const meta = readMetadata(dshHome).get(id) ?? {};
                // 索引里有这个会话就查索引（毫秒级）；否则回落到整份转写解码。
                const limitHint = Math.max(1, Math.min(200, Number(args.limit) || 40));
                const fromHint = Number(args.seqFrom) || 0;
                const toHint = Number(args.seqTo) || Number.MAX_SAFE_INTEGER;
                let indexedRows = null;
                try {
                    const handle = await getIndex();
                    if (handle !== null) indexedRows = sessionEvents(handle, id, fromHint, toHint, limitHint);
                } catch {
                    indexedRows = null;
                }
                if (Array.isArray(indexedRows) && indexedRows.length > 0) {
                    const useRedactIdx = args.redact === true ? true : config.redact;
                    const maxCharsIdx = Math.max(0, Number(args.maxChars) || 0);
                    const lines = [
                        `会话 ${id}`,
                        `标题：${meta.title ?? '(无标题)'}｜工作目录：${meta.cwd ?? row.workspace}｜最后写入：${clock(row.mtime)}｜事件（索引内本区间 ${indexedRows.length} 条）`,
                    ];
                    for (const hit of indexedRows) {
                        const text = useRedactIdx ? redact(hit.text, config.extraRedactPatterns) : hit.text;
                        lines.push(`\n[seq ${hit.seq}] ${hit.kind}`);
                        if (text !== '') lines.push('    ' + (maxCharsIdx > 0 ? text.slice(0, maxCharsIdx) : text));
                    }
                    return lines.join('\n');
                }
                const events = await readTranscript(row.file);
                const from = Number(args.seqFrom) || 0;
                const to = Number(args.seqTo) || Number.MAX_SAFE_INTEGER;
                const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
                const maxChars = Math.max(0, Number(args.maxChars) || 0);
                const useRedact = args.redact === true ? true : config.redact;
                const picked = events.filter((event) => Number(event.seq) >= from && Number(event.seq) <= to).slice(0, limit);
                const lines = [
                    `会话 ${id}`,
                    `标题：${meta.title ?? '(无标题)'}｜工作目录：${meta.cwd ?? row.workspace}｜最后写入：${clock(row.mtime)}｜事件 ${events.length} 条（输出 ${picked.length}）`,
                ];
                for (const event of picked) {
                    const described = describeEvent(event);
                    const text = useRedact ? redact(described.text, config.extraRedactPatterns) : described.text;
                    lines.push(`\n[seq ${described.seq}] ${described.type}${described.role ? ` (${described.role})` : ''}`);
                    if (text !== '') lines.push('    ' + (maxChars > 0 ? text.slice(0, maxChars) : text));
                }
                return lines.join('\n');
            },
        }),
    );

    tools.register(
        defineTool({
            name: 'session_index',
            description: 'Status or rebuild of the local session search index (session_find’s storage). '
                + 'status shows indexed sessions/events and the last sync; rebuild re-reads every transcript.',
            parameters: {
                action: { type: 'string', enum: ['status', 'sync', 'rebuild'], description: 'status 看状态；sync 只处理变化的会话；rebuild 全量重建。' },
            },
            output: TEXT_OUTPUT,
            timeoutMs: 300000,
            async execute(args) {
                const action = args.action === 'rebuild' ? 'rebuild' : args.action === 'sync' ? 'sync' : 'status';
                const db = await getIndex();
                if (db === null) return `索引不可用：当前 Node（${process.version}）没有 node:sqlite，session_find 会退回直读扫描。`;
                if (action === 'rebuild' || action === 'sync') {
                    const started = Date.now();
                    const result = action === 'rebuild' ? await rebuildIndex(db, dshHome, { includeArchived: config.includeArchived }) : await syncIndex(db, dshHome, { includeArchived: config.includeArchived });
                    const after = stats(db);
                    return [
                        `${action === 'rebuild' ? '全量重建' : '增量同步'}完成：${Date.now() - started} ms`,
                        `检查 ${result.checked}｜索引 ${result.indexed}｜未变 ${result.unchanged}｜跳过 ${result.skipped}｜写入事件 ${result.events}`,
                        `当前索引：${after.sessions} 个会话 / ${after.events} 条事件｜上次同步 ${after.lastSync ? clock(after.lastSync) : '无'}`,
                        `索引文件：${indexPath}`,
                    ].join('\n');
                }
                const current = stats(db);
                const transcripts = listTranscripts(dshHome);
                return [
                    `索引文件：${indexPath}`,
                    `已索引：${current.sessions} 个会话 / ${current.events} 条事件｜上次同步 ${current.lastSync ? clock(current.lastSync) : '无'}`,
                    `磁盘上：${transcripts.length} 个会话｜最新写入 ${clock(transcripts[0]?.mtime)}`,
                    `检索上限：${config.maxResults} 条｜脱敏：${config.redact ? '开' : '关'}｜自动同步：${config.autoSync ? '开' : '关'}`,
                    current.sessions === 0 ? '索引还是空的：先跑 action:"rebuild"。' : '',
                ].filter(Boolean).join('\n');
            },
        }),
    );

    // Tell the model which search to reach for, so it stops calling the broken one.
    ctx.inject?.(['systemPrompt'], (promptCtx) => {
        promptCtx.systemPrompt?.section?.({
            name: 'tool:session-find',
            order: 60,
            text: '跨会话查找本机历史记录时用 session_find（本地 FTS5 索引，毫秒级）；找到会话后用 session_show 读原文。'
                + '不要用 session_search / session_event_search：本机它们的索引从未建成，调用只会超时或报 storage unavailable。'
                + 'session_trace / session_event_read 仍然可用。',
        });
    });

    if (config.warmUpOnStart) {
        setTimeout(async () => {
            try {
                const handle = await getIndex();
                if (handle !== null) scheduleWarm(handle);
            } catch {
                /* 预热失败无妨，首次查询会再试 */
            }
        }, 2000).unref?.();
    }

    ctx.logger?.info?.(`session-find ready: index=${indexPath} redact=${config.redact}`);
}

export { name, inject, normalizeConfig };
export const __internal = { formatHits, scanFallback };
export { dshHomePath as hostSearchDirs };
