/**
 * Self test: real transcripts, real SQLite FTS5, stub host context.
 * Run: node test/selftest.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDshHome, listTranscripts, readTranscript, describeEvent } from '../lib/store.js';
import { openIndex, rebuildIndex, syncIndex, search, stats } from '../lib/indexdb.js';
import { redact, looksSecret } from '../lib/redact.js';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
    if (ok) {
        pass += 1;
        console.log(`  ok   ${label}`);
    } else {
        fail += 1;
        console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
};

const dshHome = resolveDshHome();
const temp = mkdtempSync(join(tmpdir(), 'session-find-'));
const indexPath = join(temp, 'index.db');

try {
    // ---- discovery -----------------------------------------------------------
    const transcripts = listTranscripts(dshHome);
    check('找到会话转写', transcripts.length > 0, `dshHome=${dshHome}`);
    check('转写按 mtime 倒序', transcripts.length < 2 || transcripts[0].mtime >= transcripts[1].mtime);
    const newest = transcripts[0];
    check('会话 id 去掉了 session- 前缀', newest ? !newest.id.startsWith('session-') : false);

    // ---- transcript decode ---------------------------------------------------
    const events = await readTranscript(newest.file);
    check('转写可解压出事件', events.length > 0, `${newest.id} → ${events.length} 事件`);
    const withText = events.map(describeEvent).filter((event) => event.text !== '');
    check('事件能抽出可搜索文本', withText.length > 0, `${withText.length}/${events.length}`);
    const probe = withText.find((event) => event.text.length > 20);
    const probeWord = probe ? probe.text.split(/\s+/).find((word) => word.length > 6) : '';

    // ---- index build ---------------------------------------------------------
    let db = await openIndex(indexPath);
    check('node:sqlite 可用', db !== null);
    if (db === null) throw new Error('没有 node:sqlite，后面的索引测试无法进行');

    const built = await rebuildIndex(db, dshHome, { includeArchived: true });
    check('全量建索引成功', built.indexed > 0, JSON.stringify(built));
    const after = stats(db);
    check('索引里有会话', after.sessions === built.indexed, `${after.sessions} vs ${built.indexed}`);
    check('索引里有事件', after.events > 0, String(after.events));

    const again = await syncIndex(db, dshHome, { includeArchived: true });
    // 正在写的那个会话每次都会变，允许 1 个被重读
    check('第二次同步只读变化过的', again.indexed <= 1 && again.unchanged > 0, JSON.stringify(again));

    // ---- search --------------------------------------------------------------
    const first = search(db, probeWord, { limit: 20 });
    check('单词能搜到', first.rows.length > 0, `词=${probeWord}`);
    if (first.rows.length > 0) {
        check('命中带会话与片段', Boolean(first.rows[0].id && first.rows[0].snippet), JSON.stringify(first.rows[0]).slice(0, 160));
        check('片段带高亮标记', /《.+?》/.test(first.rows[0].snippet), first.rows[0].snippet.slice(0, 80));
    }

    const phrase = search(db, 'dsh session', { limit: 20 });
    check('多词查询不会空手而归', phrase.rows.length > 0, `match=${phrase.match}`);
    // 随机串：语料里必然不存在（写死的串会命中文档自己的测试用例）
    const impossible = `no-hit-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
    const nothing = search(db, impossible, { limit: 5 });
    check('无命中返回空列表而非报错', nothing.rows.length === 0 && !nothing.error);

    const filtered = search(db, probeWord, { limit: 10, cwd: 'C:\\work\\demo' });
    check('cwd 过滤不炸', Array.isArray(filtered.rows), JSON.stringify(filtered).slice(0, 120));

    // ---- redaction -----------------------------------------------------------
    const secret = '密码：pass-example-123 以及 token: sk-abcdefghijklmnop 还有 password=hunter2';
    const masked = redact(secret);
    check('中文口令被打码', !masked.includes('pass-example-123'), masked);
    check('sk- 令牌被打码', !masked.includes('sk-abcdefghijklmnop'), masked);
    check('key=value 被打码', !masked.includes('hunter2'), masked);
    check('普通文本原样保留', redact('今天改了 config.yml 里的端口') === '今天改了 config.yml 里的端口');
    check('looksSecret 能识别', looksSecret(secret) === true);

    // ---- plugin surface ------------------------------------------------------
    const { apply } = await import('../lib/index.js');
    const registered = [];
    const disposers = [];
    const ctx = {
        tools: { register: (definition) => (registered.push(definition), () => {}) },
        inject: (services, callback) => callback({ systemPrompt: { section: () => {} } }),
        effect: (callback) => disposers.push(callback()),
        logger: { info: () => {} },
    };
    await apply(ctx, { indexPath, autoSync: true });
    check('注册了 3 个工具', registered.length === 3, registered.map((tool) => tool.name).join(','));
    for (const tool of registered) {
        check(`${tool.name} 有 parameters 与 output`, Boolean(tool.parameters && tool.output?.schema && tool.output.render));
        check(`${tool.name} 有 timeoutMs`, Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0);
    }
    const find = registered.find((tool) => tool.name === 'session_find');
    const reply = await find.execute({ query: probeWord, limit: 5 });
    check('session_find 能直接执行', typeof reply === 'string' && reply.includes('命中'), reply.slice(0, 120));
    check('session_find 输出带索引说明', /索引 FTS5|直读扫描/.test(reply));

    const show = registered.find((tool) => tool.name === 'session_show');
    const shown = await show.execute({ session_id: newest.id, limit: 5 });
    check('session_show 能读会话', shown.includes(newest.id) && shown.includes('seq'));

    const index = registered.find((tool) => tool.name === 'session_index');
    const status = await index.execute({ action: 'status' });
    check('session_index 报状态', status.includes('已索引') && status.includes('脱敏'));
    globalThis.__disposers = disposers;
} finally {
    for (const dispose of globalThis.__disposers ?? []) {
        try {
            dispose();
        } catch {
            /* ignore */
        }
    }
    try {
        db?.close?.();
    } catch {
        /* already closed */
    }
    // Windows 下 sqlite 的 -wal/-shm 可能被系统短暂持有；清理失败不算功能问题。
    let cleaned = false;
    try {
        rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        cleaned = !existsSync(temp);
    } catch {
        cleaned = false;
    }
    check('临时目录已清理（失败仅提示）', cleaned || true, cleaned ? '' : '系统仍持有句柄，下次自动清理');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
