# ADR-0013: MCP Server 的传输选型与会话授权（P0 契约冻结）

- **日期**：2026-11-04
- **状态**：已接受（**P0 契约冻结**；三路并行按本文件对齐，验收由主 agent 走 origin/dev 窄门）
- **相关**：`docs/adr/0003-shell-architecture.md`（拒 Node sidecar）、`docs/adr/0008-ai-agent-pi-and-free-channels.md`（AI 出网收口、写盘审批、铁律对照的写法）、`docs/adr/0007-code-plugin-track.md`；`tools/debug-server.mjs`（调试宿，本 ADR 明确**不复用**其授权形态）
- **适用规范**：MCP（Model Context Protocol）**2026-07-28** 版：无状态、按请求协商能力；标准传输＝ `stdio` 与单端点 `POST /mcp` 的 **Streamable HTTP**；需兼容旧版 `initialize` 握手。

---

## 背景

桌面编辑器要把自身能力（打开工程、读源文件、查语义、跑校验、列命令……）开放给外部 AI（Codex / DeepSeek Harness 等）调用。外部进程与编辑器在同一台机器上，但**互不信任**：AI 侧的每一条请求都可能来自模型自主决策，不能因为"能连上"就获得写盘、启进程、导出文件的权力。

同时有两条既有约束必须先摆平：

1. **ADR-0003**：内核与插件全在 WebView 的 TS 环境，Tauri Rust 侧只做 IO 原语，**拒绝打包 Node sidecar**。若 MCP 要跑一个 Node 子进程承载协议栈，就直接违反该决议。
2. **调试宿 `tools/debug-server.mjs`** 是为 `?kojo-debug=1` 页内自动化服务的：`POST /invoke` 把 `{cmd, args}` 打到一张命令表，`export_file`（`:1165`）走的是**"对话框即授权"的自动应答**——外部调用一次就把字节写到盘上。把这张表面向 MCP 开放，等于把调试便利升级成外部写权。

本 ADR 只冻结 **P0（传输 + 会话授权 + 危险工具分级）** 与 **P2/P5 的设计面**；具体清单、字段、命令名以「冻结契约 v1」为准，三路逐字遵守、不得改名。

---

## 决策（用户已拍板的四条）

1. **首期只读 + 已授权根内编辑，危险工具逐项批准。**
   能力分三档 `read` / `edit` / `privileged`（`McpTier`）。`read` 面常态开放；`edit` 只在**会话批准的根**（`approvedRoots`）内生效；`privileged` 逐工具、逐会话批准（`approvedTools`），默认不进 `tools/list`。

2. **stdio shim 只转发帧、不跑内核，因此不违反 ADR-0003。**
   `tools/kojo-mcp.mjs` 是一个**零依赖、只用 Node 内置模块**的换行 JSON-RPC ↔ HTTP 帧转发器：stdin 每行一条 JSON-RPC → 回环 `POST /mcp`（带 Bearer）→ stdout 每行一条响应。它**不装载 kernel、不读写项目文件、不新增任何外部 npm 依赖、不自动拉起编辑器**。真正的 JSON-RPC 端点、会话与能力注册表都在已运行的编辑器进程里（Rust 线协议 + WebView 桥），shim 不是 sidecar、不是内核宿主。

3. **MCP 会话授权为独立第四张表，不继承 writablePaths / exportFile / launcher approvals。**
   落盘 `%APPDATA%/dev.kojo.editor/mcp_approvals.json`（Rust `packages/app/src-tauri/src/mcp/scope.rs`），形状：

   ```json
   { "version": 1, "sessions": [
     { "clientId": "...", "tier": "read|edit|privileged",
       "approvedRoots": [], "approvedTools": [],
       "createdAt": 0, "revokedAt": 0 }
   ] }
   ```

   **为什么必须独立**：写域（`writablePaths` / `register_write_domain`）是"当前桌面会话里用户点过对话框"的授权，`exportFile` 是单文件另存为的落点授权，launcher approvals 是"信任某可执行文件 / 实例库"的授权。三者都是**面向人、面向本次 UI 操作**的授权，作用域、生命周期、撤销语义都与"一个外部 AI 客户端、跨多次请求、可能无人值守"完全不同。继承它们等于把一次性对话框的信任悄悄放大成持久的机器授权。第四张表只认 `clientId` + `tier` + 两张批准清单，`revokedAt` 显式撤销；**不读、不并、不回落**前三张表。

4. **落地走 origin/dev 窄门**：三路并发在各自工作树开发，冻结契约对齐；合流、全量测试与推送由主 agent 统一在 origin/dev 完成，任一开发路不 push。

---

## 传输选型（2026-07-28 规范 + 旧握手兼容）

| 项 | 选定 | 理由 / 红线 |
| --- | --- | --- |
| 服务形态 | **无状态、按请求协商能力** | 不把"会话状态"压进传输层；能力 (`tools` / `resources` / `prompts`) 每请求按 `scope` 现算 |
| 标准传输 ① | **stdio shim**（`tools/kojo-mcp.mjs`） | 给 Codex / Harness 等按 stdio 拉起子进程的客户端；只转发帧，见决策 2 |
| 标准传输 ② | **Streamable HTTP，单端点 `POST /mcp`** | 2026-07-28 起取代旧 SSE 双端点；响应可为 `application/json` 单帧或 `text/event-stream` 多帧，shim 两种都能逐帧转发 |
| 监听 | **127.0.0.1 动态端口** | 绝不 `0.0.0.0`；端口与 token 由 Rust 写进 `mcp-endpoint.json` 供 shim 发现 |
| 鉴权 | **仅回环 + Bearer token + Origin 白名单** | 三道缺一不可；回环绑定防远程，token 防本机其他进程，Origin 白名单防 DNS rebinding / 浏览器冒用 |
| 线协议 | **JSON-RPC 2.0** | 六 method：`tools/list` `tools/call` `resources/list` `resources/read` `prompts/list` `prompts/get` |
| 握手兼容 | **兼容旧版 `initialize` 握手** | 老客户端先发 `initialize` 再 `notifications/initialized`；服务端按 2026-07-28 的无状态口径应答，不要求建立持久会话；`initialize` 不授予任何超出 `scope` 的权力 |
| 桥契约 | Tauri 事件 `mcp://request` + 命令 `mcp_start` / `mcp_stop` / `mcp_status` / `mcp_respond` | Rust 线协议把请求投递进 WebView，WebView 桥分派后经 `mcp_respond` 回帧；Rust 不认识能力语义、不跑内核 |
| 开机图纪律 | `createMcpCapabilityRegistry` **动态 import** | ps10 闸 197 文件 / 3,569 KB（2026-11-04 ERH 批读数）；产品未启用 MCP 时该包**零字节进图**。WebView 桥只在首条 `mcp://request` 到达时才装载注册表 |

**握手与分派边界**：Rust 侧只做"帧进 / 帧出 + 闸门"，**能力清单、分级、批准判定全在 `@kojo/mcp-host`（路 B，零游戏名词、只依赖 `@kojo/plugin-api`）** 与 WebView 桥（路 A）里；Rust 侧不写任何游戏/能力知识（ADR-0003 在 Rust 侧同样是硬约束）。

---

## 契约 v1 摘要（三路逐字遵守，不得改名）

- 包 `@kojo/mcp-host` 位于 `packages/mcp-host`（**路 B 拥有**）：导出 `McpTier`、`McpSessionScope`、`McpTool`、`McpResource`、`McpPrompt`、`McpCapabilityRegistry`、`createMcpCapabilityRegistry(deps)`。
- `McpSessionScope`：`{ sessionId, clientId, tier, approvedRoots: readonly string[], approvedTools: readonly string[] }`。
- `McpCapabilityRegistry`：`listTools(scope)` / `listResources()` / `listPrompts()` / `callTool(name,args,scope)` / `readResource(uri,scope)` / `getPrompt(name,args,scope)`。
- Rust 命令（**路 C**）：`mcp_start(enabled:bool) -> {port,token,endpoint}`、`mcp_stop() -> void`、`mcp_status() -> {enabled,port|null,clients}`、`mcp_respond(args:{id,ok,result?,error?}) -> void`。
- Tauri 事件 `"mcp://request"` payload：`{id, method, params, scope}`。
- **危险工具**（路 B 标 `tier:'privileged'`、路 C 默认不进 `tools/list`）：`launcher_*` / `market_*` / `open_url_external` / `export_file` / `remove_*` / `rename_path`。
- 命令面板（路 B）：`CommandEntry` 增 `argsSchema? / description? / tier?`，`run(ctx, args?)`，**旧命令零改动**。
- 第四张表（路 C）：`packages/app/src-tauri/src/mcp/scope.rs` + 上节 JSON 形状。
- **增补（2026-11-06，人工拍板「授权，按 additive 方案做」）**：上面 v1 五个既有字段
  **逐字不变、零改名**；`McpSessionScope` additive 增加可选
  `approvedRootIds?: readonly string[]`（第四张表独立签发、缺省 / 空 ⇒ 默认拒绝），
  四枚 `fileTree.*` 写腿 additive 收可选 `rootId`——只收 `ws:` + 8 位小写十六进制的
  **枚举根标识**，绝不收任意目标路径。候选根由人类经系统目录对话框选定、只读
  `io.workspaceRoots` 枚举，人在「AI 接入」逐项显式批准；端点侧二次复核，落盘双闸
  （`approvedRoots` 相对前缀 + 内核 / Rust 写允许域）一字不动。不传 `rootId` 零额外 IPC，
  旧表经 `#[serde(default)]` 读成空 ⇒ 现有行为零变化。详见 `docs/mcp/README.md` §5.7
  与 `docs/BOARD.md` 的 `MCP-WRITE-DOMAIN-MULTIROOT` 行。

---

## 安全红线（写死，不因"方便"放开）

1. **不接调试宿 `/invoke` 任意路径。** `tools/debug-server.mjs` 的 `POST /invoke {cmd,args}` 是一张**任意命令 + 任意参数**的调试面，MCP 侧不得把它当命令总线、不得给 MCP 暴露"任意目标路径参数"。MCP 的能力面是**具名、带 `inputSchema`、带 `tier`** 的注册表条目，不是任意 cmd 字符串。
2. **不复用 `tools/debug-server.mjs:1165` 的 `export_file` 自动应答。** 那一段的注释原文是「对话框即授权的调试形态」，落点固定沙箱、`fs.writeFile` 直接落盘——**外部调用一次即授权一次写盘**。MCP 的 `export_file`（若开放）必须归 `privileged`、逐会话批准、写域校验，且走与 UI 相同的写闸；"外部调用即授权"是明确禁止的反模式。
3. **三张表不继承。** 见决策 3；`mcp_approvals.json` 是唯一判据，读不到就按"未授权"fail-closed，绝不回落到 `writablePaths` / `exportFile` / launcher approvals。
4. **危险工具默认缺席。** `privileged` 工具默认不进 `tools/list`；即便客户端猜到名字直接 `tools/call`，也必须在 `scope.approvedTools` 命中且 `tier` 匹配，否则显式拒绝（铁律 4：拒绝要可见，不是静默过滤）。
5. **不静默兜底、不自动拉起。** shim 发现端点文件缺失 / 编辑器未启用 / 连接失败 / 401，必须 stderr 给**可执行提示**并 exit 非 0；设置页与桥对「未启动 / 未授权 / 连接失败」三态必须可见。
6. **取消 / 超时 / 体积上限三件套。** WebView 桥每条请求带 `AbortSignal`（关闭流语义）、默认 30s 超时（可配）、返回体积上限；超时与超限都回显式 error 帧，不让客户端悬挂。

### 铁律对照

| 铁律 | 本 ADR |
| --- | --- |
| A 内核零游戏名词 | `@kojo/mcp-host` 零游戏名词、只依赖 plugin-api；Rust `mcp/*` 只做线协议与授权表，不认能力语义 |
| B/C 插件只依赖 plugin-api | 新包不 import kernel、不交叉 import 其它插件；`pnpm audit:decoupling` A–D 仍 ✅（31 插件） |
| 4 不静默 | 三态可见、拒绝可见、降级/截断/超时/超限可见；端点缺失给可执行提示并 exit 非 0 |
| 5/6 写盘与进程 | `edit` 限批准根、`privileged` 逐项批准；`launcher_*` / `market_*` 等进程/出网工具全归 privileged |
| ADR-0003 | stdio shim 只转发帧、不跑内核、不打包 Node sidecar；内核仍在 WebView |
| ADR-0007 | MCP 不引入代码插件分发面，能力来自既有槽贡献 |

---

## 验收口径

- **契约**：`packages/mcp-host/src/index.ts` 导出与 v1 逐字一致；六种 method 全部可分派；`mcp://request` / `mcp_respond` 闭环。
- **开机图**：未启用 MCP 时 `createMcpCapabilityRegistry` 及其依赖 **0 字节进 ps10 开机图**（动态 import + 事件到达才装载）；`node tools/boot-probe.mjs` 类闸不回退。
- **解耦**：`pnpm audit:decoupling` A–D 全绿（`packages/app/src/mcp` 与 `packages/mcp-host/src` 已进 `NEUTRAL_DIRS`，✅31 插件数不变）；双 typecheck（root + `@kojo/app`）通过。
- **传输**：单端点 `POST /mcp`；仅回环；缺 Bearer / Origin 不在白名单 → 拒；旧 `initialize` 握手可完成一次 `tools/list`；stdio shim 换行 JSON-RPC ↔ HTTP 帧一一对应。
- **shim**：端点文件缺失 / 连接失败 / 401 三种场景 stderr 有可执行提示且 exit 非 0；不自动拉起编辑器、不新增 npm 依赖、不读写项目文件。
- **授权**：第四张表读写、撤销生效；`privileged` 工具默认不在 `tools/list`；未批准直接 `tools/call` 显式拒绝；前三张表的授权不被继承或回落。
- **取消/超时/体积**：超时（默认 30s，可配）回 error 帧；关闭流能中止在途请求；超限回 error 帧而非截断成半截 JSON。
- **盘点**：`node tools/mcp-inventory.mjs --print` rc=0 给出命令数 / Rust 命令数 / 语义读数数 / 未登记成命令的缺口清单，四处真源按当前树解析。
- **语料**：真实语料目录不在位 ⇒ 语料集成冒烟**跳过**（`node tools/corpus.mjs --print` 会 FAIL），不挂空串、不伪造读数。

---

## 增补：接入可见性（2026-11-06，不改变冻结契约）

用户审阅发现「有管理台、没有接入成功那一刻的 UI 信号」，且 `mcp_status().clients`
被误当成「已连接客户端数」。本批按 **additive** 收口，边界逐条钉死：

- 冻结契约 v1 **一字不改**：`packages/mcp-host/src/index.ts` 的导出、六种 method、
  `McpSessionScope` 既有字段、写腿 `inputSchema`、危险工具分级、双闸与默认拒绝全部原样。
  `mcp://client-connected` 是**宿主 → WebView 的 UI 通知**，不是 MCP server→client
  协议通知；`capabilities` / `subscribe` / `listChanged` 继续说真话，不新增任何线协议方法。
- `mcp_connections_query` 是 **Tauri 命令（仅宿主侧 WebView 可读）**，MCP 客户端在
  `POST /mcp` 里没有任何入口读写接入台账；与 `mcp_audit_query` / `mcp_latency_query`
  同一纵深。新增命令同步 `generate_handler!` 与调试宿镜像缺口清单。
- 接入台账是**有界内存表**（按 `clientId` 去重，上限 64，最新在前），只在三道闸鉴权
  通过之后记 `{clientId, ts, method}`；不落盘、不复用 `mcp_audit.jsonl`、不含 token /
  请求体 / 任意路径；`mcp_stop` 与 token 轮换即清空。**台账是唯一真源**，事件只用于
  触发即时刷新，事件丢帧也不影响查询读数。
- `mcp_status` 只 additive 增三格：`connections`（已握手客户端数）/ `authorizedSessions`
  （第四张表未撤销会话数）/ `discoveryPath`（固定文件名拼出的本机路径，不含 token）。
  旧三格 `enabled` / `port` / `clients` 逐字不变；`clients` 的语义如实降级为
  **瞬时并发 TCP 连接数**，不再冒充接入成功。
- 前端「已接入」必须由台账命中判定；第四张授权表只说明「人批准过」，两者互不推断。
  界面默认轮询 + 事件即时刷新，缺任一路径都不编造状态。

---

## 后续演进（**只描述，不实现**）

本节钉 P5 的方向；**Tasks over MCP 已单独拍板并落地**（2026-11-06 `784cc077`，见下条现状），其余三项仍是**只描述、不实现**，开工前需单独拍板。

- **headless**：把 WebView 内核能力经同一契约暴露给无 GUI 的 CI/批处理，MCP 作为唯一入口；需解决"无 Tauri 事件总线"时的帧投递与授权表落点。
- **Tasks over MCP**：已落地为 `kojo://tasks` + `tasks.start` / `tasks.status` / `tasks.cancel`（只登记「进度 + 取消 + 可查询」三件套有真源的两档：检索、约定校验；其余四档在 `notIncluded[]` 里逐条写明缺什么）。与 2026-07-28 的按请求能力协商**已定共存口径**：传输层是无状态单请求 HTTP，通知推不出去 ⇒ 进度契约＝轮询 `tasks.status`，`capabilities` 继续说真话（`subscribe:false` / `listChanged:false` 不变）。
- **Skills over MCP**：把编辑器内的领域技能（诊断、块配平、符号索引）以 prompt/resource 形式发布，供外部 agent 组合；分级与批准模型沿用本 ADR 的 `tier` / 第四张表。
- **跨机 TLS**：若将来要跨机器接入，回环 + Bearer + Origin 三道闸需升级为 mTLS + 显式主机白名单 + 证书轮换；这是**独立的信任模型变更**，不得由本批的"仅回环"配置平滑过渡过去。

---

## 范围声明

本文件是 **P0 契约 + P2/P5 设计面**的规格文档。代码实现分布在三路工作树：`@kojo/mcp-host`（路 B）、Rust `mcp/*` 与第四张表（路 C）、stdio shim / WebView 桥 / 设置页 / 盘点脚本 / 本 ADR / 解耦审计（路 A）。ADR-0013 是这批**唯一允许新增的文档**；`docs/STATE.md` / `docs/BOARD.md` 的认领与状态由路 C 维护。冻结契约 v1 的任何改名都视为破坏三路对齐。
