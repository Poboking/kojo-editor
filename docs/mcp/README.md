# kojo-editor · MCP 外部客户端接入指南

> 面向：Codex CLI / DeepSeek Harness / 通用 MCP 客户端。
> 协议：MCP 2026-07-28。设计决策真源：`docs/adr/0013-mcp-transport-and-session-scope.md`。
> 能力注册表唯一真源：`packages/mcp-host/src/index.ts`（冻结契约 v1）。

kojo-editor 把编辑器能力以 MCP 暴露给本机 AI 客户端。客户端**不直接连编辑器**：
编辑器进程内跑一个仅回环的 HTTP 端点（`POST /mcp`），外部客户端由一个**零依赖 stdio shim**
（`tools/kojo-mcp.mjs`）转发换行分隔的 JSON-RPC 帧。shim 只转发帧、不跑内核、不读写项目文件、
不自动拉起编辑器（ADR-0003）。

```
外部 AI 客户端 ──stdio(JSON-RPC 换行帧)──▶ tools/kojo-mcp.mjs ──HTTP POST /mcp──▶ 编辑器内 Rust 端点
                                           (仅转发，不落盘)              (127.0.0.1 动态端口 + Bearer + Origin 白名单)
```

## 1. 启用（编辑器侧）

1. 打开编辑器「**设置 › AI 接入**」。
2. 开启 **MCP 服务**（Rust `mcp_start(enabled=true)`）。设置页对「未启动 / 未授权 / 连接失败」三态可见。
3. 开启后，编辑器在 `app_data_dir` 写入**发现文件** `mcp-endpoint.json`，形如：

   ```json
   { "port": 54321, "token": "<运行时生成，勿复制进任何配置>", "endpoint": "http://127.0.0.1:54321/mcp" }
   ```

4. 同一页面可**轮换 token**、查看已授权会话、撤销客户端授权（`mcp_approvals.json`）。

服务监听 **127.0.0.1 动态端口**，绝不 `0.0.0.0`；端口与 token 每次启动/轮换都会变，
**不要在任何客户端配置里写死端口或 token**。

## 2. 发现文件位置与 token 轮换

### 2.1 各平台的默认发现文件位置

shim 按**当前平台**自动定位 Tauri `app_data_dir()`（应用标识 `dev.kojo.editor`）下的
`mcp-endpoint.json`，与 Rust `mcp_start` 写入的位置一致，**无需手动指定**：

| 操作系统 | 判定依据 | 发现文件完整路径 |
| --- | --- | --- |
| Windows | `process.env.APPDATA` | `%APPDATA%\dev.kojo.editor\mcp-endpoint.json` |
| macOS | `~/Library/Application Support` | `~/Library/Application Support/dev.kojo.editor/mcp-endpoint.json` |
| Linux | `$XDG_DATA_HOME`（须为绝对路径，相对值按 XDG 规范忽略），缺省 `~/.local/share` | `~/.local/share/dev.kojo.editor/mcp-endpoint.json` |

第四张授权表 `mcp_approvals.json` 与审计日志同样落在上述目录。

> **定制 / 兜底**：只有改过 `app_data_dir()` 落点、跑在未知平台、或 CI / 端口转发时，
> 才需要显式指定：
>
> - `KOJO_MCP_ENDPOINT_FILE=/abs/path/to/mcp-endpoint.json`（指向上表对应路径）；
> - 或 `KOJO_MCP_ENDPOINT` + `KOJO_MCP_TOKEN` 成对覆盖（见 §3.2，此时完全跳过发现文件）。
>
> 未知平台、Windows 缺 `%APPDATA%`、主目录无法确定时 shim 一律 **stderr 给可执行提示 + exit 2**，
> 绝不猜路径、不回落空 token。

### 2.2 token 轮换

- 设置页「轮换 token」→ 编辑器重写 `mcp-endpoint.json` 与 Bearer 校验用 token → 旧 token 立即失效（HTTP 401）。
- shim **每次启动**都重新读发现文件，因此轮换后**重启客户端 / shim 即可**，无需改配置。
- **绝不**把 token 写进 `codex.toml` / `*.json` 示例、环境变量提交物、日志或 stdout：
  - 示例配置里没有 token 字段；token 一律运行时从发现文件读；
  - shim 的所有失败提示只描述失败类型与处置，从不回显 token 值；
  - 仅 CI / 端口转发场景才用 `KOJO_MCP_TOKEN` 覆盖，且只经进程环境注入，不落盘。

## 3. stdio shim 用法

客户端把 shim 当作 stdio MCP server 拉起：

```
node tools/kojo-mcp.mjs
```

- `stdin`：每行一条 JSON-RPC 请求 / notification。
- `stdout`：每行一条 JSON-RPC 响应帧（普通请求一一对应）。
- `stderr`：仅失败时的可执行提示。
- 退出码：`0` 正常（stdin 关闭）；`2` 发现文件/参数/端点解析失败；`3` 连接失败（编辑器未启用）；`4` HTTP 非 2xx / 鉴权失败。

### 3.1 默认行为（推荐）

不带任何 `KOJO_MCP_*` 环境变量时，shim **只读发现文件**：
不猜默认端口、不回落空 token、不吞错、不自动拉起编辑器。

### 3.2 环境变量覆盖（CI / 本地端口转发）

| 变量 | 作用 |
| --- | --- |
| `KOJO_MCP_ENDPOINT` | 覆盖地址：`host:port` / `host:port/path` / `http(s)://host:port[/path]`；端口须 1..65535，默认 path `/mcp` |
| `KOJO_MCP_TOKEN` | 覆盖 token（运行时密钥，勿提交、勿写进配置示例） |
| `KOJO_MCP_ENDPOINT_FILE` | 覆盖发现文件绝对路径（夹具 / 定制 `app_data_dir` 落点 / 未知平台用） |

- `KOJO_MCP_ENDPOINT` + `KOJO_MCP_TOKEN` **齐备** ⇒ 完全跳过发现文件。
- 只给其一 ⇒ 在发现文件基线上覆盖对应字段。
- 地址中的 query / userinfo 一律丢弃且**不回显输入值**（防误把嵌在地址里的密钥打进日志）。

### 3.3 JSON-RPC notification

无 `id`（或 `id: null`）/ `notifications/*` 的帧是 notification。shim **转发后即继续主循环**：
不等待其响应、不往 stdout 写合成响应帧、不挂住后续请求；其连接失败只在 stderr 提示且不终止后续帧。
客户端不要在 notification 后等待响应帧。

### 3.4 shim 不做什么

不装载 kernel、不读写项目文件、不新增外部 npm 依赖、不打包 Node sidecar、不自动拉起编辑器、
不缓存 token。真正的会话、能力注册表与授权都在已运行的编辑器进程内。

## 4. 客户端配置示例

| 文件 | 适用 |
| --- | --- |
| `examples/mcp/codex.toml` | Codex CLI（`~/.codex/config.toml` 的 `[mcp_servers.*]` 段） |
| `examples/mcp/deepseek-harness.json` | DeepSeek Harness 通用 `mcpServers` 配置 |
| `examples/mcp/generic-mcp.json` | 其它通用 MCP 客户端（Claude Desktop / Cursor 等 `mcpServers` 形态） |

三个示例都：

- `command = "node"`、`args = ["tools/kojo-mcp.mjs"]`；
- `cwd` 用相对/占位说明，**不写死机器绝对路径**（在仓库根目录启动客户端即可解析）；
- **不含任何 token**；token 一律运行时从发现文件读。

## 5. 暴露的能力概览

能力注册表唯一真源 `packages/mcp-host/src/index.ts`（冻结契约 v1）。按 `node tools/mcp-inventory.mjs --print`
盘点：`tools` 共 **77** 个，按 tier 分组 `read 37 / edit 11 / privileged 29`（详见 §6 授权模型；2026-11-06 第四/五波只读补齐、余项① / ⑤、B3 编辑器写腿、B2 结构化批读、B4 启动器族、B10 打开文档面落地后按同一命令复核）。
这些是**规范定义**的计数；`tools/list` 还会按会话 `tier` 与第四张表进一步过滤，危险工具默认缺席。
另外，生产真源会把命令面板命令投影成同名工具（`commands.list` 读数与工具 `tier` 同源），但它们
**一律按 `privileged` fail-closed**，默认不出现在 `tools/list`、也不接受 `edit` 会话调用（§6）；
上面的 77 个具名工具计数不含这部分（命令面板投影的条数即 `commands` 读数，见 §10.5）。

### 5.1 tools（按 tier，面向模型）

| tier | 代表工具 | 说明 |
| --- | --- | --- |
| `read` | `project.info` `fs.tree` `fs.readFile` `fs.readMany` `fs.stat` `search.all` `workspace.searchAll` `problems.diagnostics` `document.active` `commands.list` `editor.info` `editor.selfCheck` `io.listDir` `io.workspaceRoots` `semantic.definitionAt` `semantic.referencesAt` `semantic.hoverAt` `semantic.suggestAt` `semantic.documentSymbols` `semantic.tokens` `semantic.codeActionsAt` `semantic.diagnostics` `lang.foldingRanges` `lang.highlightsAt` `lang.signatureAt` `lang.markers` `diff.compare` `state.replay` `preview.document` `app.dataDir` `codec.encodeString` `fs.pathExists` `fs.statFiles` `lang.lensesAt` `lang.selectionRangesAt` `editor.cursor` `tasks.status` | 只读；`readOnlyHint: true` |
| `edit` | `fileTree.create` `fileTree.update` `problems.quickFix` `tasks.start` `tasks.cancel` `editor.setValue` `editor.type` `editor.setCursor` `editor.setSelection` `editor.revealLine` `editor.openDocument` | 需会话 `tier >= edit`；只有 `fileTree.*` 触盘写双闸，其余三种形态见 §5.4，`editor.openDocument` 的可观测回执见 §5.9 |
| `privileged` | `fileTree.remove` `fileTree.rename` + 启动器族 27 枚（`launcher_instance_{list,get,update,remove,duplicate}` · `launcher_content_{list,diagnose,apply,uninstall,set_enabled,set_order}` · `launcher_process_{list,status}` · `launcher_task_{list,cancel}` · `launcher_save_{list,backups,backup,restore,delete_backup,apply_import}` · `launcher_log_{sessions,tail,read}` · `launcher_project_hash` · `launcher_start` · `launcher_stop`） | 默认**不进 `tools/list`**；须宿主经第四张表**逐工具名精确批准**（面板那张三张表同源，见 §5.4 与 §6） |

每个工具都有面向模型的 `description`、严格 `inputSchema`、正确 `tier` + `annotations`；
执行统一走 `runSupplemental` / `runSemantic` 等宿主钩子，未接线时显式 `NOT_WIRED`，
**绝不返回空串假实现**。写类只收项目根内**相对路径**：`RELATIVE_PATH_SCHEMA` 拒绝绝对路径、
盘符、`..` 逃逸，执行层再用 `approvedRoots` 复核。

### 5.2 resources（`kojo://project/*` 与 `kojo://tasks`）

`snapshot` / `file-tree` / `diagnostics` / `validation-failures` / `commands` / `plugins` / `events` / `active-document` / `fs-freshness` / `tasks`。
所有资源文本都有**截断上限**并带显式 `truncated` 标记；插件状态 `inactive` 与 `missing[]` 必须可见，不静默。
`fs-freshness`（2026-11-06 余项③＝`b90d79bb`）自述监视覆盖与两张有界账本读数；同一批把判定结果附在**只读应答**
的 `fsFreshness` 字段上（不可用 / 未覆盖 / 无基线 / 账溢出 ⇒ `stale:null` + `staleReason`，绝不乐观 `false`）。
**窗内的自写回声那一格已从「乐观 false」改成「读时真 stat 复核」**（B8 发起＝`283c35d8`，B13 把只读腿改用异步入口
＝`843f420a`）：判据 `mtimeMs` + `size` 双等、核出的外部写如实进改动账并归因 `unattributed`、判不了仍 `null` + 理由，
逐格形态与成本见 §5.10。

### 5.3 prompts（骨架，零游戏名词）

`workflow.triage-diagnostics` / `workflow.author-review` / `workflow.safe-refactor`。
骨架**零游戏名词**，领域知识只能经 `mcp.prompt` 槽注入（`collectPromptSlotFragments`）；
缺槽时显式标注「领域槽未注入」，绝不编造领域事实。

### 5.4 写腿状态段（真值自 `node tools/mcp-inventory.mjs --json` 的 `writeLegs`）

2026-11-06 第四波收口时 **wired 4 / NOT_WIRED 1**；余项① 收口（`b8ff59d4`）后 **wired 5 / NOT_WIRED 0**；
余项⑤ 收口（`784cc077`）后 **wired 7 / NOT_WIRED 0**；B3 编辑器写腿批（`f3dad97c`）后 **wired 12 / NOT_WIRED 0**；
B4 启动器族（`e1e9de71`）后 **wired 39 / NOT_WIRED 0**；B10 打开文档面（`3b13f7ad`）后 **wired 40 / NOT_WIRED 0**。
下表逐条点名那 12 枚编辑器/文件/任务面写腿（`editor.openDocument` 见 §5.9）；
启动器 27 枚（13 只读 + 14 生命周期/写）的接线与授权口径见 §5.6——**它们同样一枚都不许挂空串**。

| 工具 | tier | 状态 | 真源 |
| --- | --- | --- | --- |
| `fileTree.create` | `edit` | wired | `createFileExclusive` / `createDirExclusive` |
| `fileTree.update` | `edit` | wired | `kernel.io.writeText`（`write_file_bytes`） |
| `fileTree.remove` | `privileged` | wired | `kernel.io.removeFile` / `removeDir` |
| `fileTree.rename` | `privileged` | wired | `kernel.io.rename`（`from`/`to` 双端过闸） |
| `problems.quickFix` | `edit` | wired | 宿主 `provideCodeActionsFor` 既有签发 id（`pane-N:贡献id#seq`）+ 有界台账（≤300 条 / 10min TTL）；apply＝Monaco 模型内单次 `executeEdits`（一个撤销步、可见脏、**不落盘**，零 io/invoke/bus）；文档版本前进或换页 ⇒ 旧 id 显式 `E_QUICKFIX_DOC_CHANGED` |
| `tasks.start` | `edit` | wired | 缺口 `search_text` / `convention.linter.run(opts)`——起一条真长操作，改的是**运行态**（任务表 + 在途请求），两种 kind 都不落项目盘 |
| `tasks.cancel` | `edit` | wired | 缺口 `cancel_search`（按行内持有的 `searchId` 认领，**不接受调用方传 id**）/ 本轮 `AbortSignal`；取消是**请求**语义，终态才是事实 |
| `editor.setValue` | `edit` | wired | 缺口 `setValue`（`install-debug.ts` 同一实现腿）：整篇替换 Monaco 模型，**必回读核对**，不过 ⇒ `E_EDITOR_APPLY_UNVERIFIED`；只读实例显式 `PERMISSION_DENIED` + `E_EDITOR_READ_ONLY` |
| `editor.type` | `edit` | wired | 缺口 `type`：光标处插入，走 `executeEdits` ⇒ **一个撤销步**且移动光标；同上回读核对与只读拒绝 |
| `editor.setCursor` | `edit` | wired | 缺口 `setCursor`：1-based 行列由调试面同一 `normalizeCursorTarget` 严格校验，脏值（0-based / 小数 / 缺 line）`INVALID_ARGS` 且**零调用**真源 API；夹取如实标 `clamped` |
| `editor.setSelection` | `edit` | wired | 缺口 `setSelection`：1-based 四点，越界行拒绝、超线尾列夹取并如实回报；正文不动（`contentChanged:false`） |
| `editor.revealLine` | `edit` | wired | 缺口 `revealLine`：`center` / `top` / `nearest` 三档（不发明 `bottom`），超文末行夹到末行并回报 `requestedLine` vs `revealedLine`；视口方法抛错就报错误，不静默成功 |

三种形态要分清：**四枚盘写腿**（`fileTree.*`）一律叠**双闸**——写闸一第四张表 `approvedRoots` 复核，写闸二内核 `writablePaths` 写原语；成功后广播 `file.changed`（remove 发 `unlink`、rename 发源 `unlink` + 目标 `add`）。
**六枚模型侧写**（`problems.quickFix` + `editor.*` 五枚）**不落盘**：只改 Monaco 模型（可撤销、留脏，回执恒带 `saved:false` 与真实 `dirty` 读数——脏值取自 `EditorPane.computeDirty` 同一条表达式 `getAlternativeVersionId() !== editorModelPool.baseline(path)`，monaco 0.57 的 `ITextModel` **没有** `isDirty`，拿不到就 `dirty:null` + 理由，不另立第二份脏账），落盘仍只经上面两闸；`editor.*` 五枚按 `paneId` 显式反查实例，**这一面没有「当前聚焦」语义**（禁用 `focusedCtx()`），pane 不在 ⇒ `NOT_WIRED` + `E_EDITOR_PANE_GONE`，绝不 `applied:true` 冒充。
**两枚运行态写**（`tasks.*`）不占盘、不触双闸。三类一律判 `edit` ⇒ read 会话直调被端点 `E_TIER_DENIED` 拒（`editor.*` 五枚与 `tasks.*` 两枚同批点名进 Rust `EDIT_TOOLS_EXACT`，端点级回归钉「拒在 emit 之前 ⇒ 桥零调用」+ 逐条 Denied 审计）。
`privileged` 具名工具（现 **29** 枚：`fileTree.remove` / `fileTree.rename` + 启动器族 27 枚，见 §5.6）默认不进 `tools/list`、按工具名精确批准；`exportFile` 对话框仍是唯一域外写法定通道。
`NOT_WIRED` 一律显式抛错可见，**绝不挂空串假实现**。

### 5.5 分页与游标（B1 批＝`5f8c8df5`）

- **为什么需要**：旧面一旦超界就切一半返回，AI 客户端**无从知道自己少读了什么**。现在超界面改可续读：
  **25 面**声明 `cursor`（真源＝`packages/mcp-host/src/index.ts` 里展开 `...PAGE_PROPS` 的 25 枚规格：
  B1 的 13 枚 `semantic.diagnostics` / `semantic.documentSymbols` / `fs.tree` / `search.all` /
  `workspace.searchAll` / `problems.diagnostics` / `commands.list` / `document.active` / `fs.readFile` /
  `io.listDir` / `io.workspaceRoots` / `editor.selfCheck` / `lang.markers`，B2 加 `fs.readMany`，
  B4 的启动器只读面 11 枚 `launcher_instance_list` / `launcher_content_list` / `launcher_content_diagnose` /
  `launcher_process_list` / `launcher_task_list` / `launcher_save_list` / `launcher_save_backups` /
  `launcher_log_sessions` / `launcher_log_tail` / `launcher_log_read` / `launcher_project_hash`）。
- **游标里装的是什么**：全量快照的 FNV-1a 指纹（列举面按稳定 key、文本面按正文），检索面按**已消费前缀指纹**
  （拿不到全量就不假称拿得到）。编解码真源 `packages/mcp-host/src/index.ts` 的
  `pageFingerprint` / `encodePageCursor` / `decodePageCursor`，两面共用 `paginateByCursor` / `paginateText`。
- **页间被改怎么办**：指纹对不上 ⇒ `changedDuringPaging:true` + offset 归 0（旧行为是盲切旧偏移＝静默错位）。
- **越界 / 脏游标**：显式 `INVALID_ARGS`，**不回空页冒充到底**；`decodePageCursor` 对 17 类脏值返 `null`，
  schema 的 `pattern` 与解码器逐字对拍。
- **完整性自证**：真语料大文件（>200K 字符）走 `fs.readFile` 游标腿逐页取满，**拼接与一次性读逐字符等值**；
  语料不在盘的兜底＝30 万字符确定性夹具跑同一条断言（两条都不静默缺席）。
- **引擎墙**：检索单次封顶 `SEARCH_ENGINE_HARD_CAP = 5000` 条命中，触墙时 `hasMore:false` +
  `engineWallReached` + `knownTotal:false` + note（请缩 query 或改逐文件 `fs.readFile` 分页），
  绝不把「页并集」谎称成「真命中总数」。
- **上限真值未放宽**：`RESOURCE_TEXT_LIMIT 24_000` / `RESOURCE_ITEM_LIMIT 200` / 文档 `8_000`（经
  `slimActiveDocument` 实测）/ 列举面 `64Ki` / 检索 `5000`，用例逐字断言；`limit` 超上限按面 clamp
  （`fs.readFile` 65000、`commands.list` 500、`io.listDir` 与 `fs.tree` 5000、`searchAll` 200）。
- **刻意 deferred（逐面要建模旧别名，不硬套游标）**：`lang.foldingRanges`（≤2000 仍 slice）、`lang.lensesAt`、
  `lang.selectionRangesAt`、`fs.statFiles`；位置型单点面（`semantic.definitionAt` 等）一页即窗口。
- **在册欠账**：带参分页面的 `additionalProperties: false` 本批未做（要先逐面声明旧别名，否则严格化会拒掉合法的
  `maxChars`）——列下一批。B2 的**新**工具没有旧别名包袱，故 `fs.readMany` 出厂即 `additionalProperties:false`。

### 5.6 批读面与启动器族（B2＝`e5406978` · B4＝`e1e9de71`）

- **`fs.readMany`（read 档，结构化批读）**：真源＝`kernel.io.readTexts`（契约 `packages/plugin-api/src/io.ts:102`
  ——与 `readText` 同一条编码探测 / BOM / EOL 管线、**每批一次 IPC**、**逐文件失败不抛整批**、可命中会话文本缓存）。
  入参 `relPaths`（与 `fs.statFiles.relPaths` / `fs.readFile.relPath` 同族口径，**不叫 `paths`**）、
  `offset` / `limit` / `cursor` 复用 §5.5 的 `PAGE_PROPS`；**硬上限 64 条/次**，超限整批 `INVALID_ARGS` + 分批指引，
  零静默截断；页闸沿用 24000 / 65000 一字未动。返回逐条对应入参：失败位是
  `{path, ok:false, error:{code:'NOT_FOUND'|'READ_FAILED', message}, fsFreshness}`（失败另付**一次**批量
  `stat_files` 分诊，分诊判不出时如实标注，不硬归因），总账
  `requested / succeeded / failed / charsReturned / truncated / hasMore / maxPathsPerCall / overLimit /
  fingerprint / nextCursor` 外加可见的 `accountMismatch` / `changedDuringPaging` / `via`。
  缺口账随之变动：`read_files_raw` **deferred→wired**（两条旧理由逐条被拆——输出是 `TextFile` 投影而非裸帧，
  且逐条 `resolveWithinRoot` 只收根内相对路径）；`read_file_bytes_raw` **继续 deferred**
  （path 即任意绝对目标路径 + 无结构化面）。
  实测（假桥 IPC 计数＝真数；Node 调试宿镜像真 HTTP、合成 2000×30 KB）：N=20 ⇒ 8.7 ms（1 趟）vs 40.8 ms（20 趟）
  ＝ **4.7×**；N=64 ⇒ 16.3 vs 119.3 ＝ **7.3×**；N=1 ⇒ 3.7 vs 2.5，**单文件仍该用 `fs.readFile`**。
  ⚠ **Tauri 真壳端到端墙钟未取到**（无已构建壳二进制、真语料不在盘 `tools/corpus.mjs --print` rc=1）——
  这一格显式留空，不拿镜像数冒充壳数。
- **启动器族 27 枚具名 `privileged` 工具**（13 只读 + 14 生命周期/写）：一工具＝一条 `launcher_*` Rust 命令，
  真源腿表 `packages/app/src/mcp/real-sources-launcher.ts`（腿表键类型收窄成那 27 枚的字面量联合 ⇒
  **名单外的名字在类型层就进不了腿表**，「刻意不登记」有类型闸兜着）。
- **为什么名字必须保持 `launcher_*` 下划线形态**：端点按**名字形状**判档（`protocol.rs`
  `is_launcher_tool()` / `is_market_tool()` 前缀 ⇒ `is_privileged_tool()` fail-closed），
  点号形态（`launcher.instance.list`）既不命中前缀表也不在具名表 ⇒ 掉进「未知名按 read 放行」＝后门。
- **批准面**：27 枚同批进 `APPROVABLE_PRIVILEGED_TOOLS`（现共 **29** 枚，含 `fileTree.remove` / `rename`）。
  这一步不是可选项——审批面板历史上列过 Rust **命令名**而端点按**工具名**批准，结果那两枚特权写腿永远批不动。
  端点级回归 `e2e_launcher_tools_require_exact_approval_with_zero_bridge_calls`（cargo `mcp::tests` **94**）
  钉「未精确批准 ⇒ 拒在 emit 之前、桥零调用」。
- **写侧形态＝一次性句柄，不是路径**：`launcher_content_apply` / `launcher_save_apply_import` 只吃界面导入向导
  产出的 `planId`（过期/未知名 ⇒ 宿主结构化错误，绝不后台重新规划），落点仍由**第三张表**
  （实例 × `rootId` 的 `launcher/approvals.json`，`launcher/paths.rs:23`）逐根复验；
  确认闸 / 信任闸不因本表存在而放松（铁律 7：三张表互不继承）。
- **刻意不登记（逐条理由在 `MCP_DEFERRED_GAP_NOTES` 的 B4 条目里）**：
  `launcher_pick_*` 三枚＝原生对话框即授权本身（铁律 6/7）；`launcher_trust_executable`＝信任授予必须是人的动作；
  `launcher_instance_open_folder`＝OS shell 面向人；`launcher_log_export` / `launcher_save_export`＝落点由对话框选定；
  `launcher_content_plan` / `launcher_save_import` / `launcher_project_extract`＝入参是原生对话框产出的**本机绝对路径**，
  宿主只做形态闸、没有「这台机器上哪些包已被人选过」的可复验登记表 ⇒ 登记等于新造一条读侧任意路径通道，
  与铁律 6 相反；`launcher_instance_create`＝载荷里的 `profile` 由 adapter 的 probe + buildProfile 编译
  （游戏知识只能进 `*-adapter`，MCP 腿零游戏知识），`request.sourceRoot` 又是对话框产物 ⇒ 造不出诚实输入，
  实例新建走界面或用 `launcher_instance_duplicate` 复制既有实例；`launcher_runtime_*`＝宿主尚未落地；
  `market_*` 全族＝铸凭据 / 不可逆外发 / 网络 + 安装副作用。

### 5.7 Agent 可达性与写域多根（2026-11-06；原 §5.6，2026-11-06 编号让位）

- **批准面可达**：静态可批准名单 `APPROVABLE_PRIVILEGED_TOOLS`（B4 起 29 枚：两枚
  `fileTree.*` + 启动器族 27 枚）**不是全部**——命令面板动作是运行时投影成同名工具的，
  静态规格里没有，旧设置页列不出即批不了。现由 `SettingsPanel` 把统一命令注册表 ID
  注入 `AiAccessSection`，`scopeStateToApproval` 合并两路真源（形状闸与
  `buildApprovalBatch` / Rust `validate_tool_pattern` 同尺，`market_*` 不进批准面），
  `ApprovalUi` 增「全选 / 清空」。全选**只**是一次勾选：`approvedTools` 逐项精确列名，
  会话 tier 固定 `edit`，不抬档、不新增隐式授权、不放宽默认拒绝。
- **UI 动作不假成功**：`CommandEntry.run` 返回 `void` ⇒ 没有 ack、没有落地确认。过去
  `commandToTool` 原样回 `undefined`，fire-and-forget 被当成执行成功。现回
  `{dispatched:true, confirmed:false, notice}`；有真实返回值的命令原样透出（旧契约零改动）。
  Agent 不得据此判定落地，须用 `project.info` / `document.active` / `problems.diagnostics`
  等只读真源复核。
- **写域多根已落地（additive，默认行为零变化）**：落盘写腿的域基准根不再只能是
  `project.current().rootDir`。四枚写腿 `fileTree.create` / `update` / `remove` / `rename`
  新增**可选** `rootId`（形状 `ws:` + 8 位小写十六进制，`workspace-root-id.ts` 对归一化
  绝对路径取 FNV-1a 32 位哈希；不用顺序索引，避免授权漂移），**只收枚举标识、绝不收任意目标路径**。
  - **发现**：`io.workspaceRoots` 回包新增 `rootIds`，与分页后的 `roots` 逐项对齐；候选根来自
    人类经系统目录对话框选定的 `workspace_roots.txt`，不是客户端可编造的路径。
  - **批准**：第四张表新增可选 `approvedRootIds`，默认空 ⇒ 任何 `rootId` 都不可用；「AI 接入」
    面板从只读 `workspace_roots` 列候选根（枚举失败单独上屏，不拖累既有 scope / audit），逐项
    勾选后 `approveArgs` 才 additive 带第五键。`approvedRoots` 仍是「根内哪些相对前缀可写」的
    独立账，**两张账不合并、不互相派生**。
  - **三道复核**：WebView 真源腿 `resolveWriteRoot()` 过形状闸 → 查 `approvedRootIds` 精确批准
    → 反查只读 `workspace_roots` 得到绝对路径；找不到 / 反查失败都显式拒绝，绝不退回项目根。
    Rust 端点 `check_root_id_param()` 在 `validate_params` 之后、tier 闸之前再做一次
    （形状 / 四写腿 / 精确批准，路径形态单独 `E_PATH_TARGET_FORBIDDEN`），命中写 `Denied`
    审计且桥零调用。落盘最后仍走 `resolveWithinRoot` 相对路径闸 + `approvedRoots` 写闸一 +
    内核 `assertWritable` / Rust `ensure_write_allowed` 写闸二，**双闸一字未动**。
  - **可达**：era 类游戏口上创作（项目根内 `ERB/Lines` 一类目录），以及人类显式批准的常驻
    工作区根 / 插件源码根 —— 前提是这些根同时也在内核写允许域内、且第四张表 `approvedRoots`
    批了对应相对前缀。**批准不等于放行**：默认权限、危险工具 fail-closed、`market_*` 恒拒、
    无任意落点路径入口，均不变。
  - **向后兼容**：不传 `rootId` 零额外 IPC；旧五参 `scope::approve` 委托空列表；旧
    `mcp_approvals.json` 无 `approvedRootIds` 键经 `#[serde(default)]` 读成空。这属 ADR-0013
    第四张表的**写域信任模型 additive 扩展**，由人工拍板（2026-11-06）后按「判据先红」落地。

### 5.8 端点吞吐与延迟契约（B5＝`d1a43790`）

写给**客户端作者**的四条事实，都是实测钉过的，不是愿望：

- **batch 数组帧是真并发**：一次 HTTP 里放 N 条 `tools/call`，端点**并发派发、按请求顺序回帧**，
  逐条仍各自过 tier / 第四张表 / 参数闸，某条被拒不影响其余条目（`docs/mcp/README.md` §6 的判定同源）。
  对 chatty 客户端来说这是最省的一招：实测真桌面壳里 batch 20 墙钟 58.3-61.2 ms vs 20 条串行
  178.6-194.1 ms（**≈3×**）；端点自身（假 bridge）batch 20 并发 vs 串行＝**5.9-6.7×**。
- **全局在途预算＝8**（`max_inflight_calls`，与 `max_concurrent` 同数）：batch 不是无限并。
  超预算 ⇒ **显式 `E_CALL_BUDGET_EXCEEDED`**（`codes::CALL_BUDGET_EXCEEDED`）+ 一条 denied 审计 +
  **零额外桥调用**——不静默排队、不丢帧、不塞爆 WebView。客户端要更大并发就自己分批。
- **配额按 envelope 计**（`max_calls_per_minute = 120` 一字未动）：这一条从 B5 起是**收紧**——
  以前 batch 的 N 条只算 1 次，现在第 2 条起逐条另计。别把 batch 当绕过速率闸的口子。
- **应答带耗时、台账只经宿主读口**：`tools/call` 结果帧 additive 地带 `_meta.elapsedMs`，审计行也记
  `elapsedMs`（单行体积闸照旧生效，超限显式报错）。分位数/窗口台账（每方法 512 样本窗、1024 键，
  溢出并入 `overflowKeys` 可见计数）**不在 MCP 协议面**——只有宿主侧命令 `mcp_latency_query` 能读，
  服务未启动时显式报错。理由与用例见 §6/§10.3。
- **每帧恒 `Connection: close`**（有用例钉住）：有界 keep-alive 经实测**放弃**——连接那一格只值
  ≈1.4 ms/条，真正的 50 ms 税在 accept 轮询，已改阻塞式 accept + `wake_accept` 唤醒修掉。
  改这条必须带新的实测依据。
- 数字口径：端点自身单条 p50 **3.19 ms**（改前 50.4 ms）、并发 8×12 **1411-1618 次/秒**（改前 154.5）；
  真桌面壳单条 `tools/call` p50 6.97 / p95 16.12 ms。**两格显式留空**：真壳「成功数据帧」读数
  （语料不在盘 ⇒ read 面按 `NOT_WIRED` 报错，往返本身是真的）与真壳「改前」对照（需另一次冷构建）——
  不拿镜像数或估算冒充壳内 A/B。

### 5.9 「打开文档」面的诚实收口（B10＝`3b13f7ad`）

Wave4 #4 当年把 `editor.openDocument` / `editor.revealPosition` 判成**刻意不登记**，理由是宿主只有一条
fire-and-forget 的 `editor.revealLocation` 事件：无 ack、无落地确认、落地走 React 异步重渲染、
订阅者只在 GUI 挂载时存在（原判性全文见 `MCP_DEFERRED_GAP_NOTES` 的 Wave4 #4 / B10 两条）。
B3 批之后**观察件第一次真的存在**，于是这一面从「只能承认做不到」变成「可观测回执」：

- **执行体没换**：仍只发射宿主既有的 `editor.revealLocation`（与转到定义 / 问题面板 / 大纲同一条导航通路），
  **零新事件、零新宿主能力、没给事件加 ack**——观察是加在 MCP 腿上的，不是加在宿主契约上的。
- **观察真源**：`packages/app/src/mcp/editor-open-legs.ts` 的 `productionObserveEditorPanes(targetAbs)`
  按 `paneId` 反查 `livePanes` 登记簿（与 B3 同一接缝，**执行时才动态 import**，开机图零新增字节）。
  判据是两条同时成立：某实例的 `filePathRef` 命中目标 **且** 其上屏 model 就是那一份标签 model。
- **有界轮询**：窗缺省 `3000 ms`、上限 `10000 ms`（入参 `deadlineMs` 可加，越界**不夹取**、脏值不静默回落缺省窗）、
  每 `25 ms` 复核一次。成功回包把读回来的事实全部带上：
  `paneId / lineCount / language / modelUri / readOnly / derivedView / waitedMs / polls / pollIntervalMs / deadlineMs / intent`。
- **读不到就显式失败并交代账目**：失败理由包含「等了多久 / 窗多大 / 每多久复核」「登记簿里看到几个实例、
  各实例正显示什么」「为什么判没打开」；登记簿整张读不到、或**发射前**就查到该事件零订阅者 ⇒ **不发射**，
  直接 `NOT_WIRED`（绝不发射后再假称成功）。
- **域界由 MCP 侧补上**：入参只收**项目根内相对路径**，走与 `fs.readFile` 同一条 `resolveWithinRoot`，
  绝对路径 / 盘符 / `..` 当场 `INVALID_ARGS` ⇒ 宿主事件永远拿不到域外落点（附带红利：目标锚在当前根内，
  换项目分支构造上不可达）。打开文档不写盘、不改模型、不改光标：`contentChanged:false` 与
  `saved:false` / `persisted:false` 恒定如实回报。
- **档位与回归同批**：`editor.openDocument` 进 Rust `EDIT_TOOLS_EXACT`（现 11 枚），端点级回归钉
  「read 会话直调 ⇒ `E_TIER_DENIED` 带工具名 + Denied 审计 + 桥零调用」（cargo `mcp::tests` 107→**109**）。
- **`editor.revealPosition` 继续不登记**：观察件救不了「一步同时打开并定位」这条组合面——把它登记成工具
  ＝造第二条没有核对通道的跳转。定位已由两枚各带读回核对的工具覆盖：`editor.revealLine`（视口，回读
  `revealedLine` 与 `clamped`）与 `editor.setCursor`（光标，回读 `cursor` 与 `clamped`），
  要操作哪个实例由 `editor.openDocument` / `document.active` / `editor.info` 交回 `paneId`。

### 5.10 只读应答的失效标注：读时复核（B8＝`283c35d8` · B13＝`843f420a`）

余项③ 把监视器回声并条（同一事实不重复计数），代价是**窗内的真实外部写也不推序号** ⇒ 下一次读
谎报 `stale:false`。这两批把那一格换成一趟真 stat 的结论，形状对客户端是四条事实：

- **窗＝`SELF_WRITE_ECHO_WINDOW_MS = 5_000`**（`fs-freshness.ts:77`）。只在「事件流判出 `false`
  **且**窗内命中同路径」这一格付 syscall；窗外 / 非同路径 / 已判 `true` 或已 `null` ⇒ 零额外探针
  （用例逐条计数钉住）。
- **复核只走既有只读契约**：`kernel.io.stat` / `statFiles`（`plugin-api/src/io.ts:185/199`，不受写允许域
  约束，也不新建任何写通道）；判据与内核文本缓存同尺＝`mtimeMs` + `size` **双等**。核出的外部写如实进
  改动账：推序号 + 归因 `unattributed`（证明不了是谁写的）并收掉那笔回声记忆，同一笔外部写不重复记
  （复核指纹账去重）。
- **两条入口，别混**：同步 `verdictOf` / `listingOf` 在窗内改为「发起复核 + 本档 `stale:null`」，
  **窗内自动 `false` 这条路已经没了**；要在同一次读数里定档用异步入口 `verdictOfRechecked` /
  `listingOfRechecked` / `verdictsOfRechecked`（`fs-freshness.ts:340/342/352`），`settlePendingRechecks`
  供在途结论落账。B13 把生产只读腿（`fs.readFile` / `fs.stat` / `fs.statFiles` / `fs.readMany` /
  `io.listDir` / `fs.tree` / `search.all` / `snapshot`）全部改用异步入口 ⇒ 窗内命中即在本次回包里给结论。
- **批量面只付一趟**：多目标并进同一趟 `statFiles`（`recheck.trips = 1`、`batched:true`），
  `fs.readMany` ≤64 条与 `fs.statFiles` ≤200 条各钉**恰 1 次 `statFiles`、0 次 `stat`**；注入面只有
  单路径 stat 时如实退化为逐条趟并由 `recheck.trips` 出声，不假称一趟。

判不了就 `null` + `staleReason`，逐条分档不合并：seam 缺席 / `stat` 抛错 / `mtimeMs:null` /
「取不到与不存在合一」（Rust `metadata(...).ok()` 两态不分离 ⇒ 不乱报外部删除 `true`）/ 复核在途 /
队列满。回包读法：`recheck.basis:"mtime-recheck"` 的 `stale:false` 才是"核过盘态证明没变"，
`recheck:null` 的 `false` 是"窗外，监视事件流没报到改动"。复核侧第三张账容量沿用
`CHANGE_LEDGER_CAPACITY`，溢出 `dropped` / `truncated` 可见。

### 5.11 检索引擎墙的分片续取（B16＝dev `586eafc7`）

`search.all` / `workspace.searchAll` 过去只有一句话：「触墙了，前 5,000 条给你，`knownTotal:false`」。
B16 把这堵墙变成**可续取**——但开关是显式的，旧行为逐字保留：

- **入参**＝`resumeBySlice:true`（不给 ⇒ 仍是旧的触墙三件套，且没有分片账）。本批**零新增工具名**，
  分片续取只是既有检索面的入参形态。该入参现已进两枚面的 schema 与 B11 取用对照表（`fc516b0a` / `6637a93e`），
  但它一度只活在腿里——那段事故与教训见 §5.12 末段。
- **计划怎么切**：一趟整棵树枚举拿到清单，按**深度 1 目录**分组，小目录整片走、大目录组内再按
  ≤64 枚文件根切片的（散文件同样按硬上限切多条，绝不静默并片）；片与片**两两不相交**（嵌套根逐条排除、
  隐藏条目不进计划、按 `label` 自定序，不赌 `walkDir` 的返回序）。分片数超硬上限（65 片）⇒
  显式 `INVALID_ARGS` + 分批指引，绝不静默少一片。
- **游标仍是 B1 那一份**：快照指纹失配（翻页途中新增文件）⇒ 从第 0 片第 0 条重发，**绝不与旧页拼接**；
  只改正文不改清单那种改动，本腿在别片察觉不到，`prefixReverified` 如实标注重扫范围。
- **账目字段**逐页可见：`planSlices` / `sliceIndex` / `sliceTotal` / `slicesRun` / `perSliceTruncated` /
  `prefixReverified` / `walkComplete` / `knownTotal` / `totalScope`。任何空页必须当场按墙出声，
  不出现「空页 + `hasMore:true`」。
- **`knownTotal` 只有单片计划才许转 `true`**（`totalScope:"project"`）。多片即使走完也只交代
  「片走完了、每片都没触墙 ⇒ 命中集可自证无重无漏」，**不交代总量**：本腿游标里没有跨片累加器，
  各片 total 相加不等于引擎会给出的真值（实测闸下集合是调度产物）。多片末态继续
  `knownTotal:false` + 理由点名「累加器」，`walkComplete:true` 是「客户端逐页 `sliceTotal` 相加即真值」
  这句话的凭证（`totalScope:"slice"`）。
- **判据侧的一条硬教训**（红过一整批）：解析式真值的 `path` 半边必须与实现走**同一枚投影腿**
  `toRelativePath`——旧面 hits.path 就是它（反斜杠投影时归成正斜杠），判据里自己抄一份
  `path.slice(ROOT.length+1)` 会得到「两边各 6,000 条但成员全错位」这种最难看的红。
- **仍修不掉的那堵墙**：单文件命中 > `SEARCH_PER_FILE_CAP`（500，`src-tauri/src/lib.rs:2671`）——分片
  切不到文件内部，`search_tests.rs:2030` 那条结论六把它钉成「分片救不了」；B18 正在给内核加 additive
  续取凭据。另外：引擎闸下命中集的不可复现只由 Rust `wall_*` 用例承担（MCP 腿全程假注入）。

读数：合并树 MCP 定向 **23 文件 632 passed / 1 skipped**、全量 `cargo test --lib` **432 / 0 / 8**、
`mcp::tests` 109、conformance 54/0、ps10 197 文件 / 3395 KB、inventory 能力面读数零变化（tools 77）。

### 5.12 入参严格化：未知键当场拒收（B11＝dev `fc516b0a` + `6637a93e`）

以前 MCP 面对未知入参的态度是「照收并静默忽略」——`problems.diagnostics` 挂了四枚在册却不生效的别名，
模型以为自己在改页大小，其实按默认页跑。B11 把三张契约表（命令投影 / 具名工具 / 补齐面）**逐面**
`additionalProperties:false`（现 74 处），未知键 ⇒ `INVALID_ARGS`，且回执必须：

- **点名未知键** + 摊开该面的合法清单；
- **指回最接近的合法名**：名字那条腿是归一化 Damerau-Levenshtein，阈值 `SCHEMA_SUGGEST_MAX_DISTANCE = 0.34`
  **一个字没抬**（抬到 0.50 实测让「最接近合法名」从 188 组涨到 639 组，等于把无关名字推到模型眼前）；
- 名字够不着时走**值形状证据**第二通道：未知键的**值**原样满足本面一枚「窄形状」`pattern`、且本面**唯一**命中才指回。
  「窄」用 12 个普通参数词探子鉴别力度量（≥0.75 拒收才算证据）——`relPath` / `instanceId` 这类兜底形状
  拒 0/12 不作证据，只有游标 `^[0-9a-f]{8}:\d{1,10}$` 拒 12/12；两枚同样窄的形状并列 ⇒ **沉默**；
- 违规项有界如实报数（单次 ≤12 条），少报几条必须写在文案里。

**等价性是硬要求**，严格化只能靠「旧别名同批建模」做到：`fs.readFile` 八枚旧别名与 `limit` 逐字同尺、
`io.listDir` 零参＝改前默认页 500、`commands.list` 零参＝200（上限 500）、`fs.tree` 的 `maxEntries` 与
`limit` 同尺、`workspace.searchAll` / `search.all` 的 `maxResults` 别名与裸 `offset` 照旧取用。
在册却不生效的别名（那四枚）现在**显式拒收**，不再静默按默认页。
启动器 9 枚 privileged 面只改形状：第三张表复验、确认闸、信任闸、下划线命名、嵌套 `items` 严格形态零改动。

⚠ 这一批揭出一个**结构性洞**（已补声明，闸另批在跑）：B16 的分片开关 `resumeBySlice` 当时只写在腿里
（`real-sources-io.ts` 读 `args?.['resumeBySlice']`），**没进 schema** ⇒ B11 的
`additionalProperties:false` 一落地，真客户端发它就会当场被拒，而**两边的测试全绿**（B16 的 22 例走注入
harness 直接叫腿，B11 的取用对照表是手抄的）。现 `fc516b0a` 已把这枚入参声明进两枚检索面、
`6637a93e` 补进取用对照表，判据 2 从此盯得住它；**机械化的双向漂移闸**（从腿源码扫取用名 ↔ 对账 properties，
两个方向漏了都红，外加一条真走注册表校验层的通路用例）＝B19 在跑。写进这里是因为这形态会复发：
凡「能力做在腿里、schema 里看不见」，严格化落地那天就是功能对客户端不可达那天。

## 6. tier 与授权模型

`McpTier = 'read' | 'edit' | 'privileged'`；会话形状（冻结契约 v1）：

```ts
interface McpSessionScope {
  sessionId: string;
  clientId: string;
  tier: McpTier;
  approvedRoots: string[];
  approvedTools: string[];
  approvedRootIds?: string[]; // additive（2026-11-06）：显式批准的常驻可写根枚举标识，见 §5.7
}
```

- `listTools(scope)` 按会话 `tier` 过滤：`read` 会话看不到 `edit` / `privileged` 工具。
- **危险工具默认不可见**：`launcher_*` / `market_*` / `open_url_external` / `export_file` / `remove_*` / `rename_path`
  一律 `privileged`，默认不进 `tools/list`；`annotations` 不可信，须宿主显式授权。
- **命令面板动作不是模型工具**：`workbench.*` / `layout.*` / `bookmarks.*` / `launcher.*` /
  `editor.action.*` / `editor.fontZoom*` 是面向人的 UI 动作，没有独立数据面。生产真源用
  `classifyCommandTier` 把它们一律判 `privileged`，命令自报的 `tier` 只许收紧、不许放宽；
  必须在 `approvedTools` 里**精确列名**才会出现在 `tools/list`，`tools/call` 同样要精确批准。
  Rust 端点（`src-tauri/src/mcp/protocol.rs`）按同名前缀做第二道分级，不采信 WebView 回帧的
  `annotations` / `tier`；`editor.info` / `editor.selfCheck` 等具名只读工具不在前缀内，不受影响。
  这些动作在批准面**列得出来、批得进去**（真源驱动 + 精确列名 +「全选」），且执行回执
  不再 fire-and-forget 冒充成功，口径见 §5.7；默认全不批准这一点不变。
- **第四张表独立**：MCP 会话授权只用 `mcp_approvals.json`，**不继承**三张既有写授权表
  （内核 `writablePaths` / Rust `ensure_write_allowed` / launcher `approvals.json`）。
- `export_file` 是「系统对话框 + 写盘绑在同一 Rust 命令」的唯一法定绕开通道，
  禁止复用 debug-server 自动落 `sandbox/exports` 的应答。
- 失败一律显式 `{ code, message }`：`NOT_WIRED` / `RESOURCE_UNAVAILABLE` / `INVALID_ARGS` /
  `PERMISSION_DENIED` / `OUT_OF_DOMAIN` / `WRITE_DISABLED` 等，绝不吞错、不静默兜底。
  （这一族是 **WebView 宿主层**的码，经桥原样透传；Rust 端点自己的闸门码另有一套带 `E_` 前缀的
  `codes::*`，如 `E_TIER_DENIED` / `E_TOOL_NOT_APPROVED`，两套别混——见 §10.3。）
  WebView 桥把结构化的 `code` 原样写进 `mcp_respond` 的 error 帧，最终落在 JSON-RPC
  `error.data.code`，**不再降级成 `mcp/internal`**；普通异常或形状不合法的脏码仍回落到 `mcp/internal`。

## 7. 三类失败排障（+ token 失效）

| 现象 | shim 退出码 | stderr 提示要点 | 处置 |
| --- | --- | --- | --- |
| 发现文件缺失 / `%APPDATA%` 找不到 / 主目录或平台落点无法确定 / JSON 坏 / 缺 port·token | `2` | 「端点文件…编辑器可能未启用 MCP 服务」/「找不到 %APPDATA%」/「平台 … 没有已知的落点」 | 「设置 › AI 接入」开启服务；定制落点或未知平台用 `KOJO_MCP_ENDPOINT_FILE` 指定；CI 用 `KOJO_MCP_ENDPOINT`+`KOJO_MCP_TOKEN` |
| 编辑器未启用 / 端点失效（ECONNREFUSED 族） | `3` | 「无法连接 MCP 服务…未启用 MCP 服务」 | 开启服务并确认状态；端口是动态的，确认端点文件是最新一次启动写入的 |
| 连接层其它失败（超时 / 重置） | `3` | 「MCP 请求失败」 | 查服务状态与端点文件 |
| Bearer token 失效 / 被拒（401/403） | `4` | 「拒绝 Bearer token…轮换 token」 | 设置页轮换 token 后重启 shim |
| 非 2xx / 5xx | `4` | 「POST /mcp 返回 HTTP …」 | 查编辑器日志、必要时重启服务 |

共同纪律：**任何失败都不写 stdout 响应帧、不伪造成功、不静默兜底**；stderr 只给可执行提示，
**绝不含 token 值**。

## 8. 安全边界

- **仅回环**：`127.0.0.1` 动态端口，绝不 `0.0.0.0`。
- **三道闸缺一不可**：回环绑定 + `Authorization: Bearer <token>` + `Origin` 白名单（防 DNS rebinding / 浏览器冒用）。
- **单端点** `POST /mcp`；缺 Bearer / Origin 不在白名单 → 拒。
- **第四张表不继承三张表**：`mcp_approvals.json` 独立授权，按会话 `clientId` 管理 `approvedRoots` / `approvedTools`。
- **不给 MCP 暴露任意目标路径参数**：写类只收项目根内相对路径 + `approvedRoots` 复核。
- **危险工具默认缺席**：`privileged` 工具不进 `tools/list`，`annotations` 不可信。
- **宿主二次分级**：Rust 端点不采信 WebView 回帧的 `annotations` / `tier`，按工具名形状独立推断
  所需 tier，在 `tools/list` 与 `tools/call` 各拦一次；即便 WebView 注册表被替换或出错，
  命令面板命名空间仍按 `privileged` 处理（§6）。
- **零游戏名词**：`@kojo/mcp-host` 不 import kernel/app/bridge/其它插件；领域知识只经 `mcp.prompt` 槽注入。
- **shim 零依赖**：只用 Node 内置模块，不新增 npm 依赖、不读写项目文件、不打包 sidecar。

## 9. 排障速查（客户端侧）

- 客户端报 `spawn node ENOENT`：确认 `node` 在 PATH，且从**仓库根目录**启动客户端（相对路径 `tools/kojo-mcp.mjs` 才能解析）。
- 客户端一直挂住不返回：检查是否在发 `notifications/*` 后错误地等响应——shim 对 notification 不回帧（§3.3）。
- 「tools/list 里没有写工具」：会话 `tier=read` 或写工具未获第四张表批准（§6），这是预期行为。
- 想看当前能力面与缺口：`node tools/mcp-inventory.mjs --print`（含按 tier 的覆盖率与剩余缺口原因）；
  机器消费用 `--json`（`counts` / `gaps` 带 `wiringCost` 分级 / `writeLegs` 写腿状态段）。
## 10. 协议一致性自检（B3 · `tools/mcp-conformance.mjs`）

### 10.1 怎么跑

```bash
node tools/mcp-conformance.mjs --self-test   # 全量对拍：全过 exit 0，任一失败 exit 1 + stderr 可执行提示
node tools/mcp-conformance.mjs --json        # 同上，另附结果 JSON
node node_modules/vitest/vitest.mjs run tools/tests/mcp-conformance.test.ts   # vitest 通道
```

零外部 npm 依赖（只用 `node:http` / `node:crypto` 等内置模块），**无需 GUI / Tauri / 运行中的编辑器**：
harness 起一个回环 mock MCP endpoint（`http.createServer` 只 bind `127.0.0.1` + 动态端口），
`spawn('node', ['tools/kojo-mcp.mjs'])` 驱动**真实 stdio shim** 逐条对拍，stdout 打 PASS/FAIL 表。

### 10.2 PASS/FAIL 表怎么读

| 前缀 | 通道 | 钉什么 |
| --- | --- | --- |
| `H01..H31` | `direct-http`：node:http 直打 mock endpoint | mock 协议面语义（协议形状 / 闸门 / 错误帧 / 协商） |
| `S01..S15` | `stdio-shim`：真 shim 进程逐行喂帧 | 端到端转发语义（透传 / 不挂住 / 坏帧终结） |
| `X01` | 卫生检查 | token 不泄漏（stdout / stderr / 日志 / 请求摘要四个泄漏面全扫） |

- `PASS :: detail` 的 detail 给关键读数（如 `text 1000/2000 字符 + truncated=true`）；
- 任一 `FAIL` → 进程 exit 1，stderr 逐条给「期望 vs 实际」+ 可执行提示；`--self-test` 也把整表打在 stdout；
- token 由运行时随机生成（`mck_<hex>`），**不进 stdout / stderr / 对拍表 / 日志**——mock 的请求记录只记
  `hasAuth/authOk` 布尔，不记 token 值；每行输出渲染前过 scrub，命中 token 字面量即判 FAIL 并遮蔽。

### 10.3 覆盖了什么

**方法面**（mock 靶全部实现并逐条对拍）：`initialize`（兼容旧握手三连）/ `ping` / `tools/list` /
`tools/call` / `resources/list` / `resources/read` / `prompts/list` / `prompts/get` / batch（数组帧）/ notification（无 id 帧）。

**闸门面**（三道闸缺一不可，mock 自身同规格示范）：

| 对拍点 | 用例 |
| --- | --- |
| 仅回环 `127.0.0.1` + 动态端口 | 结构断言（vitest ③组） |
| Bearer：缺 → 401、错 → 401 + `WWW-Authenticate` | H23/H24 |
| Origin 白名单：缺 → 403、伪造 → 403（闸序在 Bearer 之前） | H25/H26 |
| 单端点 `POST /mcp`：其它路径 404、GET 405（无状态不供 GET 服务器流） | H27/H28 |
| 非法 JSON → 400 + `-32700` | H29 |
| Accept 协商：纯 JSON → 单帧；含 `text/event-stream` → SSE | H30/H31/H18 |

**授权面**（tier 过滤 + 第四张表语义）：read 会话不见 edit/privileged（H04/S03，**privileged 默认缺席**
在端到端通道复钉）；edit 会话加 edit 仍无 privileged（H05）；privileged 会话全量可见（H06）；
tier 不匹配 `tools/call` → `-32000 E_TIER_DENIED`（拒绝可见，不静默过滤，H11）；`approvedTools`
未命中 → `-32000 TOOL_NOT_APPROVED`（H12），命中后可执行（H13）。

> **口径差（2026-11-06 收口，余项⑥＝`b77b248f`）**：`E_TIER_DENIED` 现在**是真 Rust 端点的码**，
> 不再只存在于 mock 对拍靶——`tools/call` 侧补了 `check_tool_call_permission` 的 tier 纵深闸，判定与
> `tools/list` 的 `filter_tools_list` 严格同源（`host_required_tier` / `tier_rank` / `approved_tool`），
> 并有端点级回归（真 TCP 帧 `-32000` + `data.code` + 一条 denied 审计 + 桥零调用）。闸序钉死：
> privileged 未精确批准先吃 `E_TOOL_NOT_APPROVED`（危险面），tier 不足才吃 `E_TIER_DENIED`（档位面）。
> **残余未消除的一处**：harness 的批准面字面码仍写作 `TOOL_NOT_APPROVED`（无 `E_` 前缀），端点线契约是
> `E_TOOL_NOT_APPROVED`；本批只统一了 tier 码，批准码的 `E_` 前缀待单独一批连引用面一起改。
> 另：`tools/list` 审计对被 tier 剔除的条目，note 标签仍笼统记 `privileged_not_approved`
> （`FilterOutcome` 只带名字不带原因），要精确到 `tier_filtered` 需扩结构，本批未动。

**错误帧面**：未知 method `-32601`（H22/S13）；参数错 `-32602`（未知工具 / 缺 name，H08/H09/S 系透传）；
结构化错误 `{code, message, data}`（`MOCK_FAILURE` 带 `retryable:false`，H10/S12）；错误帧是 200 应答，
shim 不吞、主循环不死（S14）。

**SSE 面**：单请求 SSE（H18/H31）、batch SSE 多 `data:` 帧逐帧合法 JSON（H21）、真 shim 吃 SSE 应答
逐帧转发到 stdout（S11——mock 对 SSE Accept 的请求恒以 `text/event-stream` 应答，stdio 通道全程走 SSE）。
mock 按**真 Rust 端点形态**发 `event: message` 元数据行，钉住 shim 只转发 `data:` 行、
绝不把元数据当 JSON-RPC 帧写进 stdout（真壳取证发现的污染路径）。

**batch / notification 面**：混合 batch 只回非 notification 项（H19）；纯 notification batch → 202 空体（H20）；
notification 转发后不回帧、不挂住 stdio（S02/S05）；batch 数组行 shim 按 notification 语义转发、不等待（S06）；
坏 JSON 行 → shim 显式终结 exit 4 + stderr 提示（S15，不静默红线）。

**资源面**：大资源 text 截到上限 + 显式 `truncated:true`（H15/S08）；未知 URI `-32002 UNKNOWN_RESOURCE`（H16/S09）。

### 10.4 mock 的定位与卫生

- **协议对拍靶，不是能力真源**：所有工具名带 `mock.` 前缀、资源 URI 用 `mock://` scheme、
  `serverInfo` 自报 `kojo-mcp-mock-endpoint`、无执行体的工具显式 `MOCK_NO_EXECUTOR` 拒绝——
  绝不空串冒充成功、不伪装真能力清单；
- mock 零 fs import（结构上不可能写任何项目文件）；请求记录不含 token 值；
- 资源文本上限 1000 字符（`RES_TEXT_LIMIT`），超限截断并显式 `truncated`。

### 10.5 当前能力面读数与剩余缺口（真值自 `node tools/mcp-inventory.mjs --print`）

> 下列数字随仓库命令 / 槽贡献增减而变，**以脚本当下输出为准**（2026-11-06 第四/五波落地后按当前树复核）。

- 能力面：命令 **61** / Rust 命令 **90** / 语义读数 **23** / 槽贡献 **103**（命令类 4）；
  tools **77**（read **37** / edit **11** / privileged **29**）；resources **10**；prompts **3**；
- 缺口：`totalGaps=181` / `wiredGaps=64` / **`deferredGaps=117`**，逐条带原因，
  按七类归因（合计 117，逐条清单跑 `node tools/mcp-inventory.mjs --print` 看 `deferred` 数组）：

| 原因类 | 条数 |
| --- | --- |
| 纯 UI / 注册槽贡献：无独立数据面可暴露；领域知识只经 `mcp.prompt` 槽注入 | 68 |
| 危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准 | 19 |
| 写 / 授权 / 原生 UI 交互：面向人的操作或需宿主接线，首期不默认暴露 | 17 |
| MCP 会话控制 / 审计内建命令：由宿主线协议与第四张表管理，不作为模型工具 | 9 |
| 只读原语：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补，绝不挂空串假实现） | 2 |
| 编辑器写 / 光标副作用：只剩 `format` 一条（异步 provider 通道，B3 批刻意不登记半截实现） | 1 |
| 语义读数：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补） | 1 |

- **读数轨迹**：`read 28→35`（第四波 6 枚只读具名工具 + 第五波 `editor.cursor`）→ 余项① `quickFix`
  （`b8ff59d4`）→ 余项⑤ `tasks.start` / `tasks.status` / `tasks.cancel`（`784cc077`）⇒ tools **43**、
  resources **10**、`wiredGaps 31` / `deferredGaps 149`；B3 编辑器写腿（`f3dad97c`）再 +5 枚具名 `edit`
  工具 ⇒ tools **48**（edit 5→**10**）、`wiredGaps 36` / `deferredGaps 144`；B1 分页游标（`5f8c8df5`）
  **零新工具名**，只给分页面加 `limit` / `cursor` 入参与完整性账（见 §5.5）；B2 批读（`e5406978`）+1 枚
  只读 ⇒ tools **49**（read 36→37）、`read_files_raw` 一条 deferred 转 wired；**B4 启动器族**（`e1e9de71`）
  +**27** 枚具名 `privileged` ⇒ tools **76**（privileged 2→**29**）、`wiredGaps 64` / `deferredGaps 116`
  （危险工具桶 46→19）。**B5 吞吐与延迟**（`d1a43790`）**零新工具名**，只新增一条宿主命令
  `mcp_latency_query`（会话控制 / 审计内建，不作模型工具）⇒ Rust 命令 **90**、`deferredGaps 116→117`；
  **B10 打开文档面**（`ebc3d714` / `3b13f7ad`）+1 枚具名 `edit` ⇒ tools **77**（edit **10→11**）、
  写腿 wired **39→40**，缺口账不变（`totalGaps 181` = `wired 64` + `deferred 117`）。
  `orphanedWires=0` / `missingSources=0` 全程为零；写腿状态段见 §5.4
  （wired 12→**40** / NOT_WIRED 0）。
- **刻意不登记**（铁律「真源不存在 = 不登记」，留在缺口里）：第四波 11 条 `cheap-read`
  逐条判性只登记 6 条，余 3 条 = `read_file_bytes_raw`（二进制帧 + path 即任意绝对目标路径）、
  `updater_relaunch`（重启动作）、`debug.actions`（注入面不可达）——`debug.type` 已于 B3 批由具名工具
  `editor.type` 覆盖，`read_files_raw` 已于 B2 批由结构化面 `fs.readMany` 覆盖（逐条根内相对路径 + ≤64 硬上限）；
  第五波 Wave4 #4 的
  `editor.revealPosition` 判性 = 组合面没有独立诚实数据面（视口＝`editor.revealLine`、光标＝
  `editor.setCursor` 各自带读回核对），**不登记**（只留显式缺口 + 防御性 `NOT_WIRED`，不假实现）；
  同批的 `editor.openDocument` 已于 B10（`ebc3d714`）转登记为具名 `edit` 工具——四条判性一条没被推翻，
  变的是观察件（执行时反查上屏登记簿），判据与诚实边界见 §5.9。`editor.format` 同判（异步 provider
  通道 + 前后长度读数，登记即假实现，Rust 侧也不提前点名未接线名）。启动器/市场面的不登记清单逐条见 §5.6。
  调用一律显式可见，不静默。
- **截断账目**：`documentSymbols` / `referencesAt` 两处静默截断已改成 `total` 真实 +
  `truncated` 可见（连带 `definitionAt` / `suggestAt` / `codeActionsAt` 同形补齐，旧字段 additive 保留）。
- **零参工具的 schema 契约**（`1061df6b`）：`app.dataDir` / `editor.cursor` 两枚真无入参的只读工具
  原先写空 `{type:'object', properties:{}}`，撞上 `packages/mcp-host/tests/mcp-host.test.ts` 的
  「不许空 schema 兜底」闸，成为 2026-11-06 空闲全量首跑的**唯一真红**（单跑复现，非满载假红）。
  现改为 `properties:{}` + `additionalProperties:false`（显式拒绝任何入参），闸新增零参白名单：
  零参工具必须逐个登记且真走零参契约、白名单不留残项；新增零参工具不登记仍红，**闸未放宽**。

### 10.6 本 harness 不覆盖什么（如实边界）

- **mock ≠ Rust 真端点**：token 轮换作旧、审计轮转、第四张表落盘与发现文件生命周期、
  `MCP-Protocol-Version` 头校验等 Rust 侧行为由路 C3 的真实 TCP/HTTP 集成测试覆盖；
- **线协议形状归一不接 mock**：WebView 注册表按冻结契约 v1 回裸数组 / 裸结果对象，
  由 Rust `finalize_reply` 在二次过滤前补成 `{tools}` / `{resources}` / `{prompts}` / `content`
  规范形状（`mcp::tests` 两例钉住，真壳端到端取证复核）；mock 本身已是规范形状，不接生产桥；
- **mock 不接能力真源**：semantic 8 腿 / kernelIo 3 腿 / 8 个 resource 真读数 / `runSupplemental`
  的接线与路径闸，由路 A3 接满真源，本 harness 只钉协议形状与转发；
- **SSE 服务器流（GET /mcp）显式不支持**（405）：这是无状态单端点形态的边界（见 §11），
  不是缺陷；`capabilities.resources.subscribe=false` 同理。

## 11. P5 演进边界（sampling / elicitation / resources-subscribe / progress）

以下四项本期**只描述方向，不实现、不排期、不动契约**（与 ADR-0013「后续演进」节同口径）。
它们的共同前置是「有状态会话或反向通道」——与 P0 冻结的「无状态、按请求协商能力、单端点 POST /mcp」
形态相斥，任何一项落地都属独立信任模型变更，须单独拍板。

### 11.1 sampling（服务端反向请求模型补全）

- **为何不做**：sampling 要求服务端能向客户端发 JSON-RPC **请求**并等待回包（server→client 回路），
  本期只有 client→server 单向请求；且「模型自主决策的每次调用都可能让另一个模型回答」，
  授权必须逐次、可见——与铁律 4 叠加后是新授权面，不是纯协议问题。
- **前置条件**：会话层（SSE 服务器流或会话 id 维持反压通道）；sampling 授权进第四张表
  （逐会话、逐次批准，`mcp_approvals.json` 扩字段）；审计留痕（谁在何时让哪个模型答了什么）。
- **未来接入点**：`@kojo/mcp-host` capabilities 增 `sampling: {}`；Rust `mcp/*` 帧型扩
  server→client request/response；stdio shim 增反向帧转发（notification 之外的 server-initiated 帧）。

### 11.2 elicitation（服务端向客户端收集结构化输入）

- **为何不做**：同 sampling 需要 server→client 反向请求；elicitation 的表单/确认 UI 属「面向人的
  授权交互」，要在设置页新增渲染与应答流，涉及 UI 面（`settings-ai.tsx`）与审计面的协同扩展。
- **前置条件**：设置页 elicitation 表单（schema 驱动渲染 + 显式提交）；会话层；审计记录
  （elicitation 的展示与提交都要留痕，不静默）。
- **未来接入点**：capabilities 增 `elicitation: {}`；`mcp://request` 事件族扩 elicitation 帧；
  `SettingsAi` 增应答面板；shim 反向帧转发与 sampling 共用同一条通道。

### 11.3 resources/subscribe（资源变更推送）

- **为何不做**：本仓资源是**按请求现算**（`readResourceData` 每次求值），没有变更事件总线；
  subscribe 需要 `listChanged` / `resources/updated` 通知 + GET /mcp 服务器流 + 订阅状态管理，
  三者都与「无状态单端点」形态冲突。
- **前置条件**：内核资源真源给出失效信号（编辑器内已有事件面可挂）；会话层记录订阅关系并随
  撤销（`revokedAt`）一并清理。
- **2026-11-06 余项③ 收口后的口径**：前半条已到位（监视回执 + `file.changed` / `file.watchState`
  经 `fs-freshness` 变成可比对的单调序号基线），但**推送形态仍不开**——传输层是无状态单请求 HTTP，
  `notifications/resources/updated` 出不去，故收口形态＝**只读应答逐条附 `fsFreshness` 标注**，
  `subscribe` / `listChanged` 继续如实 `false`（抬成真值即谎报能力）。
- **未来接入点**：协议面已钉死闸门——`capabilities.resources.subscribe=false`（harness H01/S01
  已把该断言钉进对拍表）；开启时 Rust 侧开 GET /mcp 服务器流 + WebView 桥订阅事件 + shim 增通知转发。

### 11.4 progress（长任务进度通知）

- **现状（2026-11-06 余项⑤ 收口＝`784cc077`，ADR-0013 P5 已拍板）**：「长任务」本体**已经建模**——
  三件套（进度 + 取消 + 可查询状态）齐备的两族登记成 `tasks.start` / `tasks.status` / `tasks.cancel`
  与资源 `kojo://tasks`；索引 / 导出 / 启动器任务表逐族写明缺什么，缺席事实在 `notIncluded[]` 可见。
  但 **`notifications/progress` 仍不做**：本端点是无状态单请求 HTTP（`GET /mcp` 回 405，不供服务器流），
  通知帧推不出去 ⇒ 进度契约＝**轮询读**（`tasks.status` / `kojo://tasks`），
  `capabilities` 的 `subscribe` / `listChanged` 继续如实 `false`（抬成真值即谎报能力）。
  本仓其余能力面仍是短只读调用为主，唯一长任务族已从「只描述不实现」变成实现。
- **前置条件**：任务资源模型（任务 id / 可查询 / 可取消，`kojo://tasks` + `tasks.*`）**已具备**；
  缺的是可推送的服务器流（GET /mcp 单向流 + 订阅态）；`notifications/progress`
  帧协议与客户端展示契约；超时 / 取消与既有三件套（AbortSignal / 30s / 体积上限）已部分打通（取消腿真接）。
- **未来接入点**：`tools/call` 的 `_meta.progressToken` 透传 → 桥分发任务进度 → shim 转发
  `notifications/progress`；任务本身以 resource 形态暴露，复用 tier 与第四张表授权。

### 11.5 跨机 TLS（前瞻，不属于 P5 四项）

若将来要跨机器接入，回环 + Bearer + Origin 三道闸需整体升级为 mTLS + 显式主机白名单 + 证书轮换
（ADR-0013「后续演进」）；这是独立的信任模型变更，不得由「仅回环」配置平滑过渡。本 harness 的
三道闸对拍（H23–H26）届时是对拍的**下限基线**。
