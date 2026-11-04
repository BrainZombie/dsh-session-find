# dsh-session-find

Fast, local cross-session search for DeepSeek Harness — a persistent SQLite FTS5 index over your session transcripts.

DSH 自带的 `session_search` 在本机会话历史变大之后建不完索引，调用只会超时或报 `storage unavailable`。这个插件把「建索引」和「查」拆开：索引落盘成 SQLite，按 `mtime + size` 增量同步，查询走 FTS5，毫秒级返回。

## Requirements

| 需要什么 | 版本 | 为什么 |
| --- | --- | --- |
| DeepSeek Harness | >= 0.2.0 | 提供工具注册与插件挂载点 |
| Node.js | >= 20 | 主机侧全是 ESM |
| `node:sqlite`（可选） | Node >= 22.5 | 有它才建 FTS5 索引；没有则自动退回直读扫描，功能不变、速度变慢 |

## Tools

| 工具 | 作用 |
| --- | --- |
| `session_find` | 跨会话全文检索，返回会话 id / 标题 / cwd / 命中片段 |
| `session_show` | 按 id 读原文，可按 `seqFrom` / `seqTo` 取区间 |
| `session_index` | `status` 看索引状态，`sync` 只处理变化的会话，`rebuild` 全量重建 |

`session_find` 参数：`query`（必填）、`cwd`、`since` / `until`、`types`（`user` / `reply` / `tool`）、`limit`、`perSession`、`redact`、`titleMode`（只按标题找）、`sortBy`（`score` / `time`）。

## Install

```sh
dsh plugin add dsh-session-find
```

装完重启宿主，工具即出现。首次调用会建索引（本机实测：479 个会话 / 32015 条事件）。

## Config

```yaml
- id: session-find
  name: dsh-session-find
  config:
    indexPath: ''            # 留空 = <DSH_HOME>/storages/session-find/index.db
    redact: false            # true = 默认打码（也可每次调用传 redact: true）
    extraRedactPatterns: []  # 追加的打码正则
    includeArchived: true
    maxResults: 40
    snippetChars: 240
    autoSync: true           # 每次调用前只对 mtime/size 变过的会话做增量
```

## How the index works

- 表结构：`sessions`（id / workspace / cwd / title / created_at / mtime / size / events）+ `events`（FTS5 虚表）+ `state`（`lastSync`）。
- 增量：会话文件 `mtime` 或 `size` 变了才重灌该会话的 `events`；`rebuild` 清表重来。
- 一致性：单会话写入在一个 `BEGIN` / `COMMIT` / `ROLLBACK` 里；`PRAGMA journal_mode = WAL`、`synchronous = NORMAL`。
- FTS5 的 `MATCH` 不参与 join（会有歧义），排序分走 rank 列。
- 版本升级换过表结构时会自动 `DROP` 重建，不迁移旧数据（索引本来就是派生物）。

## Privacy

索引是**原文派生**的：库文件里存着会话片段，默认**不打码**，因为「原文即检索能力」。库文件在 `<DSH_HOME>/storages/` 下，不进仓库、不外发。需要打码时把 `config.redact` 设成 `true`，或单次调用传 `redact: true`；`extraRedactPatterns` 可追加自己的正则。

## Develop

```sh
npm test            # node test/selftest.mjs（建临时库、跑检索、验证打码）
npm run doctor      # 发布前的清单检查
dsh-plugin verify . # 真打包、真安装、挂载检查
```
