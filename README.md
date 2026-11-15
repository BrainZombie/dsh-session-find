# dsh-session-find

Fast, local cross-session search for DeepSeek Harness — a persistent SQLite FTS5 index over your session transcripts.

DSH 自带的 `session_search` 在本机会话历史变大之后建不完索引，调用只会超时或报 `storage unavailable`。这个插件把「建索引」和「查」拆开：索引落盘成 SQLite，按 `mtime + size` 增量同步，查询走 FTS5，毫秒级返回。

## 和市面上那批会话检索插件的区别

插件市场上做「会话搜索」的有十来家，但它们补的是同一个缺口的两端，别装错：

| 那批插件 | 这个插件 |
| --- | --- |
| **给人看**：侧边栏面板、片段卡片、点「定位」跳回旧会话（`dsh-session-workbench` ★46、`dsh-session-explorer` ★6、`dsh-session-search-pro` ★5） | **给 agent 用**：`session_find` / `session_show` / `session_index` 三个工具，模型自己查、自己读原文 |
| 多数直接复用平台自带 FTS5（`ctx.sessionQuery`），平台索引坏了它跟着坏 | 自己维护索引，只依赖磁盘上的 transcript |
| 结果停在「哪个会话」或「哪条片段」，取原文还得人点 | 命中直接给 `session id + seq`，`session_show` 能精确切到那一段 |

一句话：**那批插件让「你能看见」，这个让「模型能查到」**。两者可以同时装——面板用来自己翻，工具用来让模型答题时引证。

> ⚠️ npm 上另有一个同名包 `dsh-session-find`（`fomalhaut1998`，v1.4.1），做的是**当前对话内** Ctrl+F 查找：纯客户端、零运行时依赖、只搜已加载历史、README 明写「不跨会话搜索」。方向完全不同，别混淆。本包从 0.1.1 起发布为 **`@brainzombie/dsh-session-find`**。

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

`session_find` 参数：`query`（必填）、`cwd`、`since` / `until`、`types`（`user` / `reply` / `tool`）、`scope`（`all` / `human` / `subagent`）、`limit`、`perSession`、`redact`、`titleMode`（只按标题找）、`sortBy`（`score` / `time`）。

结果里的会话会带来源标记：`human` 是人机对话，`subagent` 是子代理跑出来的（默认降权，`scope: "human"` 可整类排除），`fork` 继承父会话前缀（同 `seq` 的重复命中会合并到父会话，只留原件）。

## Install

```sh
dsh plugin add @brainzombie/dsh-session-find
```

装完重启宿主，工具即出现。首次调用会建索引（本机实测：788 个会话 / 约 12 万条事件 / 349 MB）。

## Config

```yaml
- id: session-find
  name: '@brainzombie/dsh-session-find'
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

- 表结构：`sessions`（id / workspace / cwd / title / created_at / mtime / size / events / **parent / origin / depth**）+ `events`（FTS5 虚表）+ `state`（`lastSync`）。
- 增量：会话文件 `mtime` 或 `size` 变了才重灌该会话的 `events`；`rebuild` 清表重来。
- 溯源：每个会话头的 `parentSession` / `origin` / `delegationDepth` 决定它的来源类型（`human` / `subagent` / `fork`），写进 `sessions` 表，用于降权与 fork 去重。老库加列走 `ALTER TABLE` + 只读首帧的 backfill，**不重灌 349 MB 的 FTS**。
- 一致性：单会话写入在一个 `BEGIN` / `COMMIT` / `ROLLBACK` 里；`PRAGMA journal_mode = WAL`、`synchronous = NORMAL`。
- FTS5 的 `MATCH` 不参与 join（会有歧义），排序分走 rank 列。
- 版本升级换过表结构时会自动 `DROP` 重建，不迁移旧数据（索引本来就是派生物）。

## Privacy

索引是**原文派生**的：库文件里存着会话片段，默认**不打码**，因为「原文即检索能力」。库文件在 `<DSH_HOME>/storages/` 下，不进仓库、不外发。需要打码时把 `config.redact` 设成 `true`，或单次调用传 `redact: true`；`extraRedactPatterns` 可追加自己的正则。

## Develop

```sh
npm test            # node test/selftest.mjs（自建 fixture 会话 + 临时库：检索/增量/打码/工具面）
npm run doctor      # 发布前的清单检查
dsh-plugin verify . # 真打包、真安装、挂载检查（需要装好 DSH 的机器）
```

`npm test` 自带 fixture 会话（临时 DSH home + zstd 转写），不读你的 `~/.dsh`，所以在 CI 和干净机器上同样是绿的；`verify` 要真实宿主，只在本地跑。
