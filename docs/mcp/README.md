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
盘点：`tools` 共 **48** 个，按 tier 分组 `read 36 / edit 10 / privileged 2`（详见 §6 授权模型；2026-11-06 第四/五波只读补齐、余项① / ⑤ 与 B3 编辑器写腿落地后复核）。
这些是**规范定义**的计数；`tools/list` 还会按会话 `tier` 与第四张表进一步过滤，危险工具默认缺席。
另外，生产真源会把命令面板命令投影成同名工具（`commands.list` 读数与工具 `tier` 同源），但它们
**一律按 `privileged` fail-closed**，默认不出现在 `tools/list`、也不接受 `edit` 会话调用（§6）；
上面的 33 个具名工具计数不含这部分。

### 5.1 tools（按 tier，面向模型）

| tier | 代表工具 | 说明 |
| --- | --- | --- |
| `read` | `project.info` `fs.tree` `fs.readFile` `fs.stat` `search.all` `workspace.searchAll` `problems.diagnostics` `document.active` `commands.list` `editor.info` `editor.selfCheck` `io.listDir` `io.workspaceRoots` `semantic.definitionAt` `semantic.referencesAt` `semantic.hoverAt` `semantic.suggestAt` `semantic.documentSymbols` `semantic.tokens` `semantic.codeActionsAt` `semantic.diagnostics` `lang.foldingRanges` `lang.highlightsAt` `lang.signatureAt` `lang.markers` `diff.compare` `state.replay` `preview.document` `app.dataDir` `codec.encodeString` `fs.pathExists` `fs.statFiles` `lang.lensesAt` `lang.selectionRangesAt` `editor.cursor` `tasks.status` | 只读；`readOnlyHint: true` |
| `edit` | `fileTree.create` `fileTree.update` `problems.quickFix` `tasks.start` `tasks.cancel` `editor.setValue` `editor.type` `editor.setCursor` `editor.setSelection` `editor.revealLine` | 需会话 `tier >= edit`；只有 `fileTree.*` 触盘写双闸，其余三种形态见 §5.4 |
| `privileged` | 危险工具 | 默认**不进 `tools/list`**；须宿主经第四张表逐会话批准 |

每个工具都有面向模型的 `description`、严格 `inputSchema`、正确 `tier` + `annotations`；
执行统一走 `runSupplemental` / `runSemantic` 等宿主钩子，未接线时显式 `NOT_WIRED`，
**绝不返回空串假实现**。写类只收项目根内**相对路径**：`RELATIVE_PATH_SCHEMA` 拒绝绝对路径、
盘符、`..` 逃逸，执行层再用 `approvedRoots` 复核。

### 5.2 resources（`kojo://project/*` 与 `kojo://tasks`）

`snapshot` / `file-tree` / `diagnostics` / `validation-failures` / `commands` / `plugins` / `events` / `active-document` / `fs-freshness` / `tasks`。
所有资源文本都有**截断上限**并带显式 `truncated` 标记；插件状态 `inactive` 与 `missing[]` 必须可见，不静默。
`fs-freshness`（2026-11-06 余项③＝`b90d79bb`）自述监视覆盖与两张有界账本读数；同一批把判定结果附在**只读应答**
的 `fsFreshness` 字段上（不可用 / 未覆盖 / 无基线 / 账溢出 ⇒ `stale:null` + `staleReason`，绝不乐观 `false`）。

### 5.3 prompts（骨架，零游戏名词）

`workflow.triage-diagnostics` / `workflow.author-review` / `workflow.safe-refactor`。
骨架**零游戏名词**，领域知识只能经 `mcp.prompt` 槽注入（`collectPromptSlotFragments`）；
缺槽时显式标注「领域槽未注入」，绝不编造领域事实。

### 5.4 写腿状态段（真值自 `node tools/mcp-inventory.mjs --json` 的 `writeLegs`）

2026-11-06 第四波收口时 **wired 4 / NOT_WIRED 1**；余项① 收口（`b8ff59d4`）后 **wired 5 / NOT_WIRED 0**；
余项⑤ 收口（`784cc077`）后 **wired 7 / NOT_WIRED 0**；B3 编辑器写腿批（`f3dad97c`）后 **wired 12 / NOT_WIRED 0**：

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
`privileged` 两枚默认不进 `tools/list`、按工具名精确批准；`exportFile` 对话框仍是唯一域外写法定通道。
`NOT_WIRED` 一律显式抛错可见，**绝不挂空串假实现**。

### 5.5 分页与游标（B1 批＝`5f8c8df5`）

- **为什么需要**：旧面一旦超界就切一半返回，AI 客户端**无从知道自己少读了什么**。现在超界面改可续读：
  **13 面**声明 `cursor`（真源＝`packages/mcp-host/src/index.ts` 里展开 `...PAGE_PROPS` 的 13 枚规格：
  `semantic.diagnostics` / `semantic.documentSymbols` / `fs.tree` / `search.all` / `workspace.searchAll` /
  `problems.diagnostics` / `commands.list` / `document.active` / `fs.readFile` / `io.listDir` /
  `io.workspaceRoots` / `editor.selfCheck` / `lang.markers`），全部**只加入参、零新工具名**。
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
  `maxChars`）——列下一批。

## 6. tier 与授权模型

`McpTier = 'read' | 'edit' | 'privileged'`；会话形状（冻结契约 v1）：

```ts
interface McpSessionScope {
  sessionId: string;
  clientId: string;
  tier: McpTier;
  approvedRoots: string[];
  approvedTools: string[];
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

- 能力面：命令 **61** / Rust 命令 **89** / 语义读数 **23** / 槽贡献 **103**（命令类 4）；
  tools **48**（read **36** / edit 10 / privileged 2）；resources **10**；prompts **3**；
- 缺口：`totalGaps=180` / `wiredGaps=36` / **`deferredGaps=144`**，逐条带原因，
  按七类归因（合计 144，逐条清单跑 `node tools/mcp-inventory.mjs --print` 看 `deferred` 数组）：

| 原因类 | 条数 |
| --- | --- |
| 纯 UI / 注册槽贡献：无独立数据面可暴露；领域知识只经 `mcp.prompt` 槽注入 | 68 |
| 危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准 | 46 |
| 写 / 授权 / 原生 UI 交互：面向人的操作或需宿主接线，首期不默认暴露 | 17 |
| MCP 会话控制 / 审计内建命令：由宿主线协议与第四张表管理，不作为模型工具 | 8 |
| 只读原语：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补，绝不挂空串假实现） | 3 |
| 编辑器写 / 光标副作用：只剩 `format` 一条（异步 provider 通道，B3 批刻意不登记半截实现） | 1 |
| 语义读数：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补） | 1 |

- **读数轨迹**：`read 28→35`（第四波 6 枚只读具名工具 + 第五波 `editor.cursor`）→ 余项① `quickFix`
  （`b8ff59d4`）→ 余项⑤ `tasks.start` / `tasks.status` / `tasks.cancel`（`784cc077`）⇒ tools **43**、
  resources **10**、`wiredGaps 31` / `deferredGaps 149`；B3 编辑器写腿（`f3dad97c`）再 +5 枚具名 `edit`
  工具 ⇒ tools **48**（edit 5→**10**）、`wiredGaps 36` / `deferredGaps 144`；B1 分页游标（`5f8c8df5`）
  **零新工具名**，只给 13 面加 `limit` / `cursor` 入参与完整性账（见 §5.5）。
  `orphanedWires=0` / `missingSources=0` 全程为零；写腿状态段见 §5.4（wired 12 / NOT_WIRED 0）。
- **刻意不登记**（铁律「真源不存在 = 不登记」，留在缺口里）：第四波 11 条 `cheap-read`
  逐条判性只登记 6 条，余 4 条 = `read_file_bytes_raw` / `read_files_raw`（二进制帧、无结构化
  数据面，且 `read_files_raw` 会暴露任意目标路径参数）、`updater_relaunch`（重启动作）、
  `debug.actions`（注入面不可达）——`debug.type` 已于 B3 批由具名工具 `editor.type` 覆盖；
  第五波 Wave4 #4 的
  `editor.openDocument` / `editor.revealPosition` 判性 = 宿主无可诚实回报结果的通道，
  **不登记**（只留显式缺口 + 防御性 `NOT_WIRED`，不假实现）。`editor.format` 同判（异步 provider
  通道 + 前后长度读数，登记即假实现，Rust 侧也不提前点名未接线名）。调用一律显式可见，不静默。
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
