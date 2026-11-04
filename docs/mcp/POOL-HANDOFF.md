# MCP 三路轮流池交接（2026-11-04 深夜 · 额度中断前的完整交接）

> 本文是「把编辑器所有功能按 MCP 2026-07-28 开放给 Codex / DeepSeek Harness 等 AI 客户端」
> 批次的**唯一交接真源**。接手者只需：读本文 → 按 §3 认领一路开工 → 交付时按 §6 流程落地。
> 设计决策见 `docs/adr/0013-mcp-transport-and-session-scope.md`；客户端接入见 `docs/mcp/README.md`。

## 0. 一句话现状

**2026-11-05 收口：本批次已全部落地并推上 `origin/dev`——A3 `55d4f8eb` / B3 `ccdb856e` /
C3 `cec5448b`（Rust `mcp::tests` 60→75）/ INT `371333c5`+`0858677b`+`881acd34`（lockfile 同步 /
面板回归 ui-kit + 调试宿缺口登记 / STATE 落账）；BOARD 四卡已删净，全量 `pnpm test:unit`
23,499 passed / 0 failed。下文保留交接时的原始状态描述，作为历史记录。**

链路骨架已全部打通并推上 `origin/dev`（7 笔提交），三路轮流池已跑完两波；第三波（A3/B3/C3）
三条分支与工作树已备好、**尚未开工**——2026-11-04 22:17 起子 agent 派发额度 429（约
2026-11-05 13:03 UTC+8 恢复），恢复前任何接手者可**单线程顺序做**，任务书在 §3。

## 1. 已落地提交（全部在 `origin/dev`，回执在各提交信息）

| 提交 | 内容 |
|---|---|
| `704a9158` | `@kojo/mcp-host` 能力注册表（冻结契约 v1）+ 命令面板 `CommandEntry` 参数化（argsSchema/description/tier/run(ctx,args)） |
| `a31a360d` | ADR-0013 + `tools/mcp-inventory.mjs` 能力盘点 + `tools/kojo-mcp.mjs` stdio shim + `host-bridge.ts` 前端桥 + `settings-ai.tsx` |
| `f08045b3` | 能力覆盖补齐 + `tools/kojo-mcp-headless.mjs`（默认只读）+ `semantic-service.ts` + `mcp.prompt`/`mcp.tool` 槽 |
| `c5c5591d` | Rust 内嵌 endpoint（`src-tauri/src/mcp/{protocol,server,scope,audit,tests,mod}.rs`）+ 第四张授权表 `mcp_approvals.json` + 审计 + 8 个命令（`mcp_start/stop/status/respond/approve/revoke/scope_query/audit_query`） |
| `35e31ef0` | 只读能力覆盖（tools 33：read28/edit3/privileged2）+ `docs/mcp/README.md` + `examples/mcp/`（Codex / DeepSeek Harness / 通用三份样例，零 token）+ shim 环境变量覆盖 / notification 不挂住 |
| `928d9ca8` | Rust 协议一致性（initialize/ping/batch/MCP-Protocol-Version/Accept/SSE）+ 纵深硬化（tier+approvedTools 二次过滤、privileged 精确批准、路径闸 UNC/盘符/双编码/NUL/尾点尾空格 fail-closed、第四张表原子写、token 轮换作旧、审计轮转）。`mcp::tests` 24→60 例 |
| `cad0fd11` | WebView 端到端链路：host-bridge 消灭 @ts-ignore 改 import type、`wiring.ts` 注入 seam、`ShellLayout.tsx` 唯一生产登记点（命令注册表 + EditorCommandContext）、设置页「AI 接入」节（isTauri 条件懒装载，挂 SettingsAi+ApprovalUi+AuditPanel）、vite alias。新增 28 例测试 |

## 2. 当前能力面读数（`node tools/mcp-inventory.mjs --print`）

- 命令 59 / Rust 88 / 语义读数 23 / 槽贡献 102（命令类 4）/ `missingSources=[]`
- tools 33（read 28 / edit 3 / privileged 2）；`wiredGaps=24`；`deferredGaps=155`（逐条带原因，**均无真源即不造假实现**）
- resources 8（`kojo://project/{snapshot,file-tree,diagnostics,validation-failures,commands,plugins,events,active-document}`）；prompts 3（零游戏名词骨架）
- **仍 NOT_WIRED 的腿**：semantic 8 腿 / kernelIo 3 腿 / 8 个 resource 数据源 / runSupplemental / prompts 追加 / promptSlots——这正是 A3 要接满的。

## 3. 三条待开工路（完整任务书）

### 3.1 A3 — 接满真源腿（消灭 NOT_WIRED，只接真源）

- **工作树** `D:/DSH/kojo-mcp-pool-a` · **分支** `b/mcpa/1104-real-sources` · 尖 `cad0fd11` · 工作树干净
- **独占文件**：`packages/app/src/mcp/**`、`packages/app/src/ui/ShellLayout.tsx`（仅 additive 登记）、`packages/app/tests/mcp-wiring.test.ts`、`packages/app/tests/mcp-real-sources.test.ts`（新）、`packages/app/tests/mcp-integration.test.ts`（如需）
- **任务**：
  1. 新建 `packages/app/src/mcp/real-sources.ts`（可拆多文件），用动态 import / 注入 seam 组装生产真源：
     - `semantic` 8 腿（definitionAt/referencesAt/diagnostics/hoverAt/suggestAt/documentSymbols/tokens/codeActionsAt）接真实编辑器语义读数，只读、绝不 apply codeAction；
     - `kernelIo` 3 腿（projectInfo/fileTree/searchAll）接 ProjectService / kernel IO 原语；**只收项目根内相对路径 + 域复核，读文件有截断上限 + 显式 truncated**；
     - `readResourceData` 为 §2 的 8 个 URI 接真读数；接不到的 URI 报 `RESOURCE_UNAVAILABLE`，不许空串/空数组冒充成功；
     - `runSupplemental` 至少接满只读腿（commands.list/document.active/fs.readFile/fs.stat/io.listDir/io.workspaceRoots/editor.info/editor.selfCheck）；**写类（fileTree.create/update/remove/rename）与危险动作不要擅自开放执行**，保持 NOT_WIRED 或走宿主授权显式拒绝；
     - `promptSlots` 从 `mcp.prompt` 槽收集 adapter 贡献；无贡献就传空数组或缺席，**绝不硬编码游戏知识**。
  2. 扩展 `ShellLayout.tsx` 约 2166 行的登记点（仍动态 import；依赖数组按需扩；cleanup 保持 cancelled 语义，**不要** `registerMcpWiringSources(null)` 制造空 deps 窗口）。
  3. **开机图红线**：ps10 闸 196 文件 / 3,553 KB 已顶格（现读数 3,554 KB，INT 会按台账处理）；`real-sources.ts` 只能被 wiring / 首条请求动态装载，顶层不得给 bootstrap/main.tsx/常驻文件新增静态有值 import。用只读 node 静态走图核对（MCP 模块图内 0 命中 + 落在图内字节增量）。
  4. 测试：扩 `mcp-wiring.test.ts`、新 `mcp-real-sources.test.ts`——8 腿投影 / 3 腿 kernelIo / 8 URI 读数与 RESOURCE_UNAVAILABLE / 截断与 truncated / 路径逃逸拒绝（绝对路径、盘符、UNC、`..`、URL 编码）/ runSupplemental 未接线仍 NOT_WIRED / promptSlots 空数组不编造。假注入，不起 GUI/HTTP/Tauri。
- **验收**：`pnpm typecheck` · `pnpm --filter @kojo/app typecheck` · `pnpm audit:decoupling` · 定向 vitest（mcp-wiring/mcp-real-sources/mcp-integration/mcp-semantic-service/commands-mcp-schema/settings-search）· 开机图走图读数 · **回执逐条写明哪些腿已接、哪些仍 NOT_WIRED 及缺什么**。
- **禁改**：`packages/app/tests/ps10-eager-graph.test.ts`、docs/**、各 tsconfig/vite/vitest 配置、任何 package.json、pnpm-lock.yaml、Cargo.*、`packages/mcp-host/**`、`src-tauri/**`、`tools/**`、`packages/app/src/debug/**`。

### 3.2 B3 — 端到端协议一致性 harness

- **工作树** `D:/DSH/kojo-mcp-pool-b` · **分支** `b/mcpb/1104-conformance` · 尖 `cad0fd11` · 工作树干净
- **独占文件**：`tools/mcp-conformance.mjs`（新）、`tools/tests/mcp-conformance.test.ts`（新）、`docs/mcp/**`、`examples/mcp/**`、`tools/kojo-mcp.mjs` / `kojo-mcp-headless.mjs`（仅确需修 shim）、`tools/tests/mcp-stdio.test.ts`（如需）
- **任务**：
  1. `tools/mcp-conformance.mjs`（零外部 npm 依赖）：回环 mock MCP endpoint（`http.createServer` 只 bind 127.0.0.1 + 动态端口 + Bearer token + Origin 白名单 + 单端点 POST /mcp），实现 initialize/ping/tools/list（tier 过滤、privileged 默认不可见）/tools/call/resources/list/resources/read（截断+truncated）/prompts/list/prompts/get/batch（notification 不回帧）/-32601/-32602/结构化错误/可选 SSE；然后 `spawn('node', ['tools/kojo-mcp.mjs'])` 驱动真实 stdio shim 逐条对拍，输出 PASS/FAIL 表；`--self-test` 无需 GUI/Tauri，失败 exit 非 0 + stderr 可执行提示。token 不进 stdout/日志。mock 只是协议对拍靶，不伪装能力真源、不写项目文件。
  2. `tools/tests/mcp-conformance.test.ts`：initialize 形状 / tier 过滤 / batch 中 notification 无响应 / 错误帧 / Bearer、Origin 拒绝 / SSE 可选 / notification 不挂住 stdio / token 不泄漏。
  3. `docs/mcp/README.md` 加「协议一致性自检」节与「P5 演进边界」节（sampling/elicitation/resources-subscribe/progress 为何本期不做、前置条件、接入点），如实标注覆盖与剩余缺口（deferredGaps=155 逐条带原因）。
- **验收**：`node --check tools/mcp-conformance.mjs` · `node tools/mcp-conformance.mjs --self-test`（exit 0）· 定向 vitest（conformance/stdio/client-config）· `pnpm typecheck` · `pnpm audit:decoupling`。
- **禁改**：docs/BOARD.md、docs/STATE.md、docs/adr/**、任何 package.json、pnpm-lock.yaml、各配置、`packages/**`、`tools/mcp-inventory.mjs`、`tools/tests/{mcp-inventory,mcp-headless,mcp-client-config}.test.ts`。

### 3.3 C3 — Rust 真实 TCP/HTTP 端点集成测试

- **工作树** `D:/DSH/kojo-mcp-pool-c` · **分支** `b/mcpc/1104-http-e2e` · 尖 `cad0fd11` · 工作树干净
- **独占文件**：`packages/app/src-tauri/src/mcp/*.rs`（可新增同目录模块并在 mod.rs 挂载）
- **任务**：补上「未起真实 server」的缺口——在 `tests.rs`（或新模块）用 `server.rs` 的真实 listener 在 127.0.0.1 起端口 + `std::net::TcpStream` 发裸 HTTP（不新增 crate），覆盖：Bearer 拒绝 / Origin 拒绝 / initialize 响应形状 / tools/list tier 过滤 / tools/call 未批准 privileged 显式拒绝且审计 denied / notification 无响应 / batch / 未知方法 -32601 / 未知 MCP-Protocol-Version 报错 / Accept 协商与 SSE / 发现文件生命周期 / token 轮换后旧 token 失效。用既有 TempDir 模式。
- **验收**：`cargo test --lib mcp::tests` 全绿且例数上涨（现 60）· `rustfmt --edition 2021 --check src/mcp/*.rs` · 全量 `cargo test --lib` 仅既有 launcher_probe 2 红（见 §7）· `pnpm audit:decoupling`。
- **禁改**：`lib.rs`（8 命令 generate_handler! 原样）、Cargo.toml/Cargo.lock、pnpm-lock.yaml、任何 package.json/tsconfig/vite/vitest、docs/**、`packages/app/src/**`、`packages/mcp-host/**`、`tools/**`。

## 4. INT — 主 agent / 接手者的集成收尾（可与三路并行）

1. **ps10 体积闸台账**（`packages/app/tests/ps10-eager-graph.test.ts:1568`）：现读数
   **196 文件 / 3,554 KB · 3,638,818 B**，超闸 550 B（闸 3,638,272 B）。**零新进图文件**；
   归因（`git cat-file -s` 对拍 6bd1746d..dev）：`bootstrap.ts` +440（MCP 登记注释与一行
   `void import`）、`plugin-api/src/index.ts` +28（`export type * from './mcp'`）、
   `plugin-api/src/slots.ts` +32（mcp 槽 augmentation）、`ui/commands.ts` +13（additive 字段
   注释）＝ +513 B，余 +37 B 来自同批外部并发提交的在图片段。**按仓内台账流程**逐字节记账
   抬 KB 闸 3,553 → 3,554（或 3,555 留余量）并写台账条目；**文件闸 196 与成员断言不许放宽**。
   A3 若再动在图文件，合流后必须复跑此闸。
2. **`pnpm-lock.yaml` 同步**：root/app `package.json` 已声明 `@kojo/mcp-host: workspace:*`（704a9158 落的）但 lock 缺 3 个 importer 条目（12 行），每次 pnpm 命令都会自动补写又被还原。正确做法：`pnpm install --lockfile-only` 后单独提交 lock（提交信息写明「补 workspace importer 条目，非新增外部依赖」），并验证 `pnpm install --frozen-lockfile` 过。
3. **全量测试复跑**：基线 23,125 passed / 151 skipped / 0 failed；MCP 批新增约 28(TS)+36(Rust)+100(B2 定向) 例。合流后全量 `pnpm test:unit` 应 0 failed（launcher_probe 2 红是 Rust 侧既有）。
4. **`docs/STATE.md` 落账**：数字真变才改（测试总数、mcp::tests 60 等）。
5. **BOARD 交付删行**：每路交付后删对应行，回执在提交信息。

## 5. 全局红线（任何路都必须守，违反即退回）

1. 三张既有写授权表（内核 `writablePaths` / Rust `ensure_write_allowed` / launcher `approvals.json`）互不继承；MCP 会话授权只用第四张表 `mcp_approvals.json`。
2. **绝不给 MCP 暴露任意目标路径参数**；写类只收项目根内相对路径 + approvedRoots 复核；`export_file` 的「系统对话框 + 写盘绑在同一 Rust 命令」是唯一法定绕开写允许域通道；禁止复用 `tools/debug-server.mjs` 自动落 `sandbox/exports` 的 export_file 应答（那是「外部调用即授权」）。
3. 危险工具 `launcher_*` / `market_*` / `open_url_external` / `export_file` / `remove_*` / `rename_path` 标 `tier:'privileged'`，默认不进 tools/list；tool annotations 不可信，宿主显式授权。
4. 只绑 `127.0.0.1` + Bearer token + Origin 白名单，三缺一不可；发现文件 `%APPDATA%/dev.kojo.editor/mcp-endpoint.json` 只写 `{port,token,endpoint}`；token 不进日志/示例。
5. 铁律 4「不静默」：失败显式 `{code,message}`；未接线一律 `NOT_WIRED` / `RESOURCE_UNAVAILABLE` 可见；**不吞错、不伪造读数、不空串冒充成功**。
6. A–D 解耦审计基线 ✅31（内核/plugin-api/Rust 宿主/宿主 UI/Monaco 零游戏名词；插件禁依赖 @kojo/kernel；插件禁交叉 import）。
7. ps10 开机图 196 文件 / 3,553 KB：MCP 运行时只能动态 import，未启用 MCP 零字节进图；bootstrap 只允许一处 `void import('./mcp/host-bridge')`。
8. 不新增外部 npm 依赖；`pnpm-lock.yaml` 除 INT 第 2 项外严禁改动（pnpm 自动改了就 `git checkout -- pnpm-lock.yaml` 还原）。
9. 盘上无真实语料目录（需 `ERB/` + `CSV/`），真实语料集成冒烟跳过——不挂空串、不伪造读数。
10. `window.__kojoDebug` 调试面只 additive；`packages/app/src/debug/**` 不作为 MCP 生产真源。

## 6. 轮流池流程纪律（接手者照做）

1. 每条路：独立工作树 + 短命分支 `b/<agent>/<MMDD>-<slug>`，从 `origin/dev` 起；**不在本地 dev/main 提交**。
2. 交付流程：改完 → 自跑该路验收口径 → 主 agent/接手者复核 → 逐文件 `git add`（禁 `-A`）→ commit（回执写进提交信息）→ `git fetch origin --prune` → `git rebase origin/dev` → 门槛复绿 → `git push origin HEAD:dev` → **删 BOARD 对应行** → 立刻补发下一条路（轮流池：始终三路并发；额度不足时退化为单线程顺序做）。
3. 完成一路就验收推送一路；非快进被拒就是并发协议本身——重跑 fetch+rebase 再推；**永不 force 到 dev/main**。
4. 三路文件所有权互斥（见 §3 各路禁改清单），`docs/BOARD.md`/`docs/STATE.md`/各配置/lockfile 由主 agent 独占。

## 7. 已知红灯（既有，勿修、勿当本批回归）

- 全量 `cargo test --lib`：`launcher_probe::q5_env_whitelist_and_suspended_combo`、`launcher_probe::q5b_env_block_built_by_hand` 2 例失败（Windows env 探针预期 COUNT=4 实际 8；未改该文件）。
- `ps10-eager-graph` 体积闸顶格（见 §4.1，INT 处理）。
- 真实语料目录缺失：`node tools/corpus.mjs --print` 报未发现 `ERB/`+`CSV/`（§5.9 跳过）。

## 8. 派发额度状态（2026-11-04 22:17 记录）

- 子 agent 派发 API 返回 429：`usage exceeds frequency limit … reset at 2026-11-05 13:03:48 UTC+8`。
- 影响：第三波三路（§3）暂无法并发派发；**任务书与分支已备好，接手者可立即单线程顺序执行**，或等额度恢复后按 §6 恢复三路并发。
- 三条工作树当前状态：干净、无未提交改动、分支尖均为 `cad0fd11`。
