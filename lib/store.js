/**
 * Session discovery, metadata and transcript reading.
 *
 * The host keeps one transcript per session at
 *   <DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
 * and (optionally) a projection cache with titles at
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 *
 * Transcripts are zstd with one frame per append, so a whole-file streaming
 * decode is required; `zstdDecompressSync` only returns the first frame.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Byte offset just past the zstd frame starting at `start`, or -1 when the
 * buffer is too short. Node's zstd decoder stops after one frame, so a
 * transcript (one frame per append, ~45 of them) must be walked frame by frame.
 * Layout per RFC 8878: magic, frame header, blocks (3-byte headers), checksum.
 */
function frameEnd(buffer, start) {
    if (start + 5 > buffer.length || buffer.readUInt32LE(start) !== ZSTD_MAGIC) return -1;
    let offset = start + 4;
    const descriptor = buffer[offset];
    offset += 1;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const dictIdFlag = descriptor & 3;
    if (singleSegment === 0) offset += 1;                       // window descriptor
    offset += [0, 1, 2, 4][dictIdFlag];                         // dictionary id
    offset += [singleSegment === 1 ? 1 : 0, 2, 4, 8][contentSizeFlag]; // frame content size
    for (;;) {
        if (offset + 3 > buffer.length) return -1;
        const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        const last = header & 1;
        const type = (header >> 1) & 3;
        const size = header >> 3;
        offset += 3;
        offset += type === 1 ? 1 : size;                        // RLE stores one byte
        if (offset > buffer.length) return -1;
        if (last === 1) break;
    }
    if (checksumFlag === 1) offset += 4;
    return offset <= buffer.length ? offset : -1;
}

/** Decode every frame in a concatenated zstd buffer. */
export function decodeZstdFrames(buffer) {
    const parts = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            // unknown bytes between frames: skip forward to the next magic
            const next = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset + 1);
            if (next < 0) break;
            offset = next;
            continue;
        }
        const end = frameEnd(buffer, offset);
        if (end < 0) break;                                     // truncated tail (live session)
        try {
            parts.push(zstdDecompressSync(buffer.subarray(offset, end)));
        } catch {
            /* one unreadable frame must not lose the others */
        }
        offset = end;
    }
    return Buffer.concat(parts);
}

/** Resolve DSH_HOME the way the host does. */
export function resolveDshHome(configured) {
    const fromConfig = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : '';
    if (fromConfig) return fromConfig;
    const fromEnv = process.env.DSH_HOME?.trim();
    if (fromEnv) return fromEnv;
    return join(homedir(), '.dsh');
}

/** Every transcript on disk, newest first. */
export function listTranscripts(dshHome) {
    const root = join(dshHome, 'sessions');
    if (!existsSync(root)) return [];
    const out = [];
    for (const workspace of readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;
        const workspaceDir = join(root, workspace.name);
        for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = join(workspaceDir, entry.name, 'session.v4.jsonl.zstd');
            if (!existsSync(file)) continue;
            let stat;
            try {
                stat = statSync(file);
            } catch {
                continue;
            }
            const id = entry.name.startsWith('session-') ? entry.name.slice('session-'.length) : entry.name;
            out.push({
                id,
                file,
                workspace: workspace.name,
                mtime: stat.mtimeMs,
                size: stat.size,
            });
        }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Title / cwd / createdAt per session id, from the projection cache when present.
 * Parsing ~500 cache files costs ~80 ms, so the map is cached: the index sync
 * runs once per tool call and must not pay that price every time.
 */
const META_TTL_MS = 30_000;
let metaCache = { key: '', at: 0, value: new Map() };

export function readMetadata(dshHome, options = {}) {
    const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : META_TTL_MS;
    if (metaCache.key === dshHome && Date.now() - metaCache.at < ttl) return metaCache.value;
    const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
    const meta = new Map();
    if (!existsSync(dir)) {
        metaCache = { key: dshHome, at: Date.now(), value: meta };
        return meta;
    }
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length).replace(/^session-/, '');
        try {
            const record = JSON.parse(readFileSync(join(dir, name), 'utf8')).record ?? {};
            const rows = record.rows ?? {};
            const title = rows.title?.val ?? '';
            const identity = record.identity ?? {};
            meta.set(id, {
                title: typeof title === 'string' ? title : '',
                cwd: identity.cwd ?? '',
                createdAt: Number(identity.createdAt) || 0,
            });
        } catch {
            /* a corrupt cache entry only costs the title */
        }
    }
    metaCache = { key: dshHome, at: Date.now(), value: meta };
    return meta;
}

/** Decode one whole transcript into parsed events. */
export async function readTranscript(file) {
    // 异步读 + 让出一帧：重建索引时宿主事件循环不能整段被吞掉（会表现为界面卡顿）。
    const raw = await readFile(file);
    await new Promise((resolve) => setImmediate(resolve));
    const text = decodeZstdFrames(raw).toString('utf8');
    const events = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            /* a half-written trailing line is expected on the live session */
        }
    }
    return events;
}

/** Flatten one event into the text a future search should match. */
export function eventText(event) {
    const data = event?.data ?? {};
    const parts = [];
    const push = (value) => {
        if (typeof value === 'string' && value.trim() !== '') parts.push(value);
    };
    for (const block of data.message?.content ?? []) {
        if (!block || typeof block !== 'object') continue;
        push(block.text);
        if (block.type === 'tool-call' || block.type === 'tool_use') push(JSON.stringify(block.input ?? block.arguments ?? ''));
        if (block.type === 'reasoning') push(block.text ?? '');
    }
    push(data.name);
    if (data.arguments !== undefined) push(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments));
    if (data.result !== undefined && typeof data.result !== 'object') push(String(data.result));
    if (data.title) push(String(data.title));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Coarse group for one event, mirroring dsh-search-index's user / reply / tool split. */
export function coarseType(event) {
    const type = String(event?.type ?? '');
    if (type === 'user/message') return 'user';
    if (type === 'assistant/message') return 'reply';
    if (type === 'tool/call' || type === 'tool/result') return 'tool';
    return 'other';
}

/** Message content outranks tool chatter when ordering hits. */
export const TYPE_WEIGHT = Object.freeze({ user: 3, reply: 3, tool: 1, other: 1 });

/** Render one event for a human: role/source first, text after. */
export function describeEvent(event) {
    const type = String(event?.type ?? '?');
    const seq = Number(event?.seq ?? 0);
    const data = event?.data ?? {};
    const role = data.message?.role ?? data.name ?? '';
    const text = eventText(event);
    return { seq, type, role, text, group: coarseType(event), weight: TYPE_WEIGHT[coarseType(event)] ?? 1 };
}
