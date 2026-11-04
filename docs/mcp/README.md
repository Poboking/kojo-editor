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

### 2.1 `%APPDATA%` 在各操作系统的对应路径

shim 默认读取 `%APPDATA%/dev.kojo.editor/mcp-endpoint.json`。`%APPDATA%` 是 **Windows 专有**
环境变量；其它平台由 Tauri `app_data_dir()`（应用标识 `dev.kojo.editor`）落到等价位置：

| 操作系统 | `%APPDATA%` / `app_data_dir()` 对应目录 | 发现文件完整路径 |
| --- | --- | --- |
| Windows | `C:\Users\<用户>\AppData\Roaming`（即 `%APPDATA%`） | `C:\Users\<用户>\AppData\Roaming\dev.kojo.editor\mcp-endpoint.json` |
| macOS | `~/Library/Application Support`（`app_data_dir()`） | `~/Library/Application Support/dev.kojo.editor/mcp-endpoint.json` |
| Linux | `$XDG_DATA_HOME`，缺省 `~/.local/share`（`app_data_dir()`） | `~/.local/share/dev.kojo.editor/mcp-endpoint.json` |

第四张授权表 `mcp_approvals.json` 与审计日志同样落在上述目录。

> **跨平台注意**：shim 的 `resolveEndpointFile` 只认 Windows 的 `process.env.APPDATA`。
> 在 macOS / Linux 上请用下面任一方式显式指向，否则 shim 会以「找不到 %APPDATA%」显式失败（exit 2）：
>
> - `KOJO_MCP_ENDPOINT_FILE=/abs/path/to/mcp-endpoint.json`（指向上表对应路径）；
> - 或 `KOJO_MCP_ENDPOINT` + `KOJO_MCP_TOKEN` 成对覆盖（见 §3.2）。

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
| `KOJO_MCP_ENDPOINT_FILE` | 覆盖发现文件绝对路径（夹具 / macOS / Linux 用） |

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
盘点：`tools` 共 **33** 个，按 tier 分组 `read 28 / edit 3 / privileged 2`（详见 §6 授权模型）。
这些是**规范定义**的计数；`tools/list` 还会按会话 `tier` 与第四张表进一步过滤，危险工具默认缺席。

### 5.1 tools（按 tier，面向模型）

| tier | 代表工具 | 说明 |
| --- | --- | --- |
| `read` | `project.info` `fs.tree` `fs.readFile` `fs.stat` `search.all` `workspace.searchAll` `problems.diagnostics` `document.active` `commands.list` `editor.info` `editor.selfCheck` `io.listDir` `io.workspaceRoots` `semantic.definitionAt` `semantic.referencesAt` `semantic.hoverAt` `semantic.suggestAt` `semantic.documentSymbols` `semantic.tokens` `semantic.codeActionsAt` `semantic.diagnostics` `lang.foldingRanges` `lang.highlightsAt` `lang.signatureAt` `lang.markers` `diff.compare` `state.replay` `preview.document` | 只读；`readOnlyHint: true` |
| `edit` | `fileTree.create` `fileTree.update` `problems.quickFix` | 需会话 `tier >= edit` + `approvedRoots` 复核 |
| `privileged` | 危险工具 | 默认**不进 `tools/list`**；须宿主经第四张表逐会话批准 |

每个工具都有面向模型的 `description`、严格 `inputSchema`、正确 `tier` + `annotations`；
执行统一走 `runSupplemental` / `runSemantic` 等宿主钩子，未接线时显式 `NOT_WIRED`，
**绝不返回空串假实现**。写类只收项目根内**相对路径**：`RELATIVE_PATH_SCHEMA` 拒绝绝对路径、
盘符、`..` 逃逸，执行层再用 `approvedRoots` 复核。

### 5.2 resources（`kojo://project/*`）

`snapshot` / `file-tree` / `diagnostics` / `validation-failures` / `commands` / `plugins` / `events` / `active-document`。
所有资源文本都有**截断上限**并带显式 `truncated` 标记；插件状态 `inactive` 与 `missing[]` 必须可见，不静默。

### 5.3 prompts（骨架，零游戏名词）

`workflow.triage-diagnostics` / `workflow.author-review` / `workflow.safe-refactor`。
骨架**零游戏名词**，领域知识只能经 `mcp.prompt` 槽注入（`collectPromptSlotFragments`）；
缺槽时显式标注「领域槽未注入」，绝不编造领域事实。

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
- **第四张表独立**：MCP 会话授权只用 `mcp_approvals.json`，**不继承**三张既有写授权表
  （内核 `writablePaths` / Rust `ensure_write_allowed` / launcher `approvals.json`）。
- `export_file` 是「系统对话框 + 写盘绑在同一 Rust 命令」的唯一法定绕开通道，
  禁止复用 debug-server 自动落 `sandbox/exports` 的应答。
- 失败一律显式 `{ code, message }`：`NOT_WIRED` / `RESOURCE_UNAVAILABLE` / `INVALID_ARGS` /
  `OUT_OF_DOMAIN` / `WRITE_DISABLED` 等，绝不吞错、不静默兜底。

## 7. 三类失败排障（+ token 失效）

| 现象 | shim 退出码 | stderr 提示要点 | 处置 |
| --- | --- | --- | --- |
| 发现文件缺失 / `%APPDATA%` 找不到 / JSON 坏 / 缺 port·token | `2` | 「端点文件…编辑器可能未启用 MCP 服务」/「找不到 %APPDATA%」 | 「设置 › AI 接入」开启服务；macOS/Linux 用 `KOJO_MCP_ENDPOINT_FILE` 指定；CI 用 `KOJO_MCP_ENDPOINT`+`KOJO_MCP_TOKEN` |
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
- **零游戏名词**：`@kojo/mcp-host` 不 import kernel/app/bridge/其它插件；领域知识只经 `mcp.prompt` 槽注入。
- **shim 零依赖**：只用 Node 内置模块，不新增 npm 依赖、不读写项目文件、不打包 sidecar。

## 9. 排障速查（客户端侧）

- 客户端报 `spawn node ENOENT`：确认 `node` 在 PATH，且从**仓库根目录**启动客户端（相对路径 `tools/kojo-mcp.mjs` 才能解析）。
- 客户端一直挂住不返回：检查是否在发 `notifications/*` 后错误地等响应——shim 对 notification 不回帧（§3.3）。
- 「tools/list 里没有写工具」：会话 `tier=read` 或写工具未获第四张表批准（§6），这是预期行为。
- 想看当前能力面与缺口：`node tools/mcp-inventory.mjs --print`（含按 tier 的覆盖率与剩余缺口原因）。
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
tier 不匹配 `tools/call` → `-32000 TIER_DENIED`（拒绝可见，不静默过滤，H11）；`approvedTools`
未命中 → `-32000 TOOL_NOT_APPROVED`（H12），命中后可执行（H13）。

**错误帧面**：未知 method `-32601`（H22/S13）；参数错 `-32602`（未知工具 / 缺 name，H08/H09/S 系透传）；
结构化错误 `{code, message, data}`（`MOCK_FAILURE` 带 `retryable:false`，H10/S12）；错误帧是 200 应答，
shim 不吞、主循环不死（S14）。

**SSE 面**：单请求 SSE（H18/H31）、batch SSE 多 `data:` 帧逐帧合法 JSON（H21）、真 shim 吃 SSE 应答
逐帧转发到 stdout（S11——mock 对 SSE Accept 的请求恒以 `text/event-stream` 应答，stdio 通道全程走 SSE）。

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

- 能力面：命令 **60** / Rust 命令 **88** / 语义读数 **23** / 槽贡献 **102**（命令类 4）；
  tools **33**（read 28 / edit 3 / privileged 2）；resources **8**；prompts **3**；
- 缺口：`totalGaps=179` / `wiredGaps=24` / **`deferredGaps=155`**，逐条带原因，
  按七类归因（合计 155，逐条清单跑 `node tools/mcp-inventory.mjs --print` 看 `deferred` 数组）：

| 原因类 | 条数 |
| --- | --- |
| 纯 UI / 注册槽贡献：无独立数据面可暴露；领域知识只经 `mcp.prompt` 槽注入 | 68 |
| 危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准 | 46 |
| 写 / 授权 / 原生 UI 交互：面向人的操作或需宿主接线，首期不默认暴露 | 18 |
| MCP 会话控制 / 审计内建命令：由宿主线协议与第四张表管理，不作为模型工具 | 8 |
| 只读原语：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补，绝不挂空串假实现） | 6 |
| 编辑器写 / 光标副作用：首期不面向只读模型面 | 5 |
| 语义读数：真源存在但本波未登记为具名工具（保留缺口，宿主后续按需补） | 4 |

### 10.6 本 harness 不覆盖什么（如实边界）

- **mock ≠ Rust 真端点**：token 轮换作旧、审计轮转、第四张表落盘与发现文件生命周期、
  `MCP-Protocol-Version` 头校验等 Rust 侧行为由路 C3 的真实 TCP/HTTP 集成测试覆盖；
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
- **未来接入点**：协议面已钉死闸门——`capabilities.resources.subscribe=false`（harness H01/S01
  已把该断言钉进对拍表）；开启时 Rust 侧开 GET /mcp 服务器流 + WebView 桥订阅事件 + shim 增通知转发。

### 11.4 progress（长任务进度通知）

- **为何不做**：progress notification 需要 `progressToken` 把通知与在途请求关联，并要求存在
  「长任务」本体；本仓能力面全是短只读调用，唯一长任务族（索引 / 校验 / 导出）尚未建模成任务资源
  （ADR-0013「Tasks over MCP」明确只描述不实现）。
- **前置条件**：任务资源模型（任务 id / 可查询 / 可取消，`kojo://tasks/*`）；`notifications/progress`
  帧协议与客户端展示契约；超时 / 取消与既有三件套（AbortSignal / 30s / 体积上限）打通。
- **未来接入点**：`tools/call` 的 `_meta.progressToken` 透传 → 桥分发任务进度 → shim 转发
  `notifications/progress`；任务本身以 resource 形态暴露，复用 tier 与第四张表授权。

### 11.5 跨机 TLS（前瞻，不属于 P5 四项）

若将来要跨机器接入，回环 + Bearer + Origin 三道闸需整体升级为 mTLS + 显式主机白名单 + 证书轮换
（ADR-0013「后续演进」）；这是独立的信任模型变更，不得由「仅回环」配置平滑过渡。本 harness 的
三道闸对拍（H23–H26）届时是对拍的**下限基线**。
