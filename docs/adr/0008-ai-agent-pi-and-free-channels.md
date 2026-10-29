# ADR-0008: 内置 AI agent（pi 引擎）与免费渠道 —— 设计提案，暂不执行

- **日期**：2026-10-29
- **状态**：**设计提案，未执行、不排期**（只钉形态与行数预算，不承诺开工）
- **相关**：`docs/ARCHITECTURE.md` §5.6（沙箱运行档 / 产物判据）、§5.9（二进制作边车）；
  ADR-0003（拒 Node sidecar）；ADR-0007（代码插件仅立项、市场只发声明式数据）；
  `docs/STATE.md`（基线数字）

---

## 背景

口上作者的完整回路目前缺两段：

1. **写之后的验证**：改完 ERB 要手动起引擎、肉眼判断有没有炸，报错信息散在游戏窗口与日志里。
2. **炸之后的修复**：没有把"报错 → 定位 → 改回"接成一条线的手段。

通用编码 agent（Cline 类）能补，但代价是把整个 IDE 宿主搬进来。本提案换一条路：
**用可嵌入的 agent 循环 + 域工具 + 可外包的渠道**，让编辑器自己长出一个懂口上的 agent。

同时要解决一个现实约束：**用户不会填 API Key**。任何以"请先申请 key"开场的方案在 era 社区的转化率上等于零。

---

## 决策（提案）

1. **引擎用 `pi-agent-core`，不用 Cline / era-harness 的全量移植。**
   `packages/agent`（`@earendil-works/pi-agent-core` 1.4.0，MIT）只有 6 个文件 ≈2,900 行，
   依赖仅 `pi-ai` + `typebox`；循环接受注入式 `streamFn`，因此可以完全不引入 `pi-ai` 的运行时
   （那套依赖 `@aws-sdk/*`、`nodes >= 22`、`http-proxy-agent`，在 WebView 里跑不起来）。

2. **出网收口到一条新能力面 `kernel.ai`。**
   渲染层不直连任何 provider；Rust 侧一条命令做 POST + SSE + 取消 + 探活。
   主机策略＝内置白名单 ∪ 用户显式添加的端点，**不开放任意主机**。

3. **渠道不内置，改为"通道适配 + 外包给本地网关"。**
   统一 `AiChannel` 接口，四类实现：`gateway.local`（本机 OpenAI 兼容网关，自动探测）、
   `pool.anon`（运营商**公开声明**的匿名池）、`local.ollama`、`byok`。
   明确排除需要伪造客户端身份或铸造会话凭据的车道（如 OpenCode Zen）。

4. **游戏知识留在 `eratw-adapter`，agent 插件零游戏名词。**
   域工具（日志诊断、块配平、符号索引、条件抽取）以 `AgentToolContribution` 槽位由 adapter 贡献；
   agent 只认 `id` + schema。

5. **写盘改为"会话级授权 + 批量审批"，不废双闸。**
   沙箱域内全自动；真实工程一次批量审批；域外仍拒。备份、可回滚、diff 可审三条不变——
   它们正是"隔离兜底"成立的前提。

6. **本提案不排期、不进当前版本。** 开工前需单独确认（见「开放问题」）。

---

## 架构

```
┌────────────────────────── WebView (React 19) ──────────────────────────┐
│  AgentPanel (ui.panel)        Settings › AI        Diff/审批卡 (ui.overlay)│
└───────────────▲──────────────────────────────────────────▲──────────────┘
                │ ctx.services                               │ ctx.ui
┌───────────────┴──────────────┐              ┌──────────────┴──────────────┐
│ 内置插件 agent               │              │ eratw-adapter（域工具贡献）  │
│  pi-agent-core (vendored)    │◀── tools ───▶│  log_diagnose / block_check  │
│  streamFn → kernel.ai        │              │  erb_symbols / conditions    │
└───────────────▲──────────────┘              └─────────────────────────────┘
                │ AiService（plugin-api 契约）
┌───────────────┴─────────────────────────────────────────────────────────┐
│ kernel.ai：ChannelRouter（gateway.local / pool.anon / local.ollama / byok）│
│            模型合并 · 降级链 · 状态可见                                   │
└───────────────▲─────────────────────────────────────────────────────────┘
                │ invoke(Channel)
┌───────────────┴─────────────────────────────────────────────────────────┐
│ Rust：ai_stream（POST + SSE 解析 + 取消）· ai_probe（/v1/models 探活）    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 包归属

| 位置 | 职责 | 约束 |
| --- | --- | --- |
| `packages/plugin-api/src/ai.ts` | `AiService` 契约、消息/工具/chunk 类型、`AgentToolContribution` | 零游戏名词 |
| `packages/app/src/kernel/ai/*` | `AiService` 实现、通道路由、模型合并、降级 | kernel 内部 |
| `packages/app/src-tauri/src/ai.rs` | 单条出网能力 | reqwest |
| `packages/plugins/agent` | 内置插件：pi 循环、工具调度、会话 | 仅 `@kojo/plugin-api` |
| `packages/plugins/eratw-adapter` | 域工具与提示词贡献 | 仅 `@kojo/plugin-api` |

内置插件 17 → 18，`pnpm audit:decoupling` 必须仍 ✅。

---

## 核心契约

### `AiService`（plugin-api）

```ts
export interface AiService {
  listModels(): Promise<AiModel[]>;
  /** 事件流；signal 中止即取消上游，不允许悬挂 */
  stream(req: AiRequest, signal: AbortSignal): AsyncIterable<AiChunk>;
  /** 通道状态：ok | needsLogin | unreachable | rateLimited | degraded */
  lanes(): Promise<LaneStatus[]>;
  refreshLanes(): Promise<void>;
}

export interface AiRequest {
  model: string;                 // "lane:model" 复合 id
  system: string;
  messages: AiMessage[];
  tools?: AiToolDeclaration[];
  maxTokens?: number;
  reasoning?: "off" | "low" | "high" | "max";
}

export type AiChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argsJson?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: "stop" | "length" | "tool_calls" | "aborted" | "error" };
```

### Rust 能力

```rust
#[tauri::command]
async fn ai_stream(
    app: AppHandle,
    req: AiStreamRequest,          // base_url, key_ref, model, body, timeout
    on_event: Channel<AiEvent>,    // text / thinking / tool_delta / usage / done / error
    stream_id: String,
) -> Result<(), String>;

#[tauri::command]
async fn ai_cancel(stream_id: String);

#[tauri::command]
async fn ai_probe(base_url: String, key_ref: Option<String>) -> Result<LaneProbe, String>;
```

- key 只存句柄，永不回传明文；UI 只显示 `hasKey` 与指纹。
- 超时、体积上限、取消三件套与 `exportFile` 同级写死。

### 工具贡献槽位

```ts
interface AgentToolContribution {
  id: string;
  description: string;
  schema: JsonSchema;
  run(args: unknown, ctx: ToolRuntime): Promise<ToolResult>;
}
```

---

## 免费渠道

### 四类通道

| 通道 | 来源 | 用户动作 |
| --- | --- | --- |
| `gateway.local` | 本机 OpenAI 兼容网关（OmniRoute / CLIProxyAPI / dsh-our-free-model / LM Studio） | **0**（自动探测） |
| `pool.anon` | 运营商公开声明的匿名池（Kilo `isFree`、OVH 匿名） | **0** |
| `local.ollama` | `127.0.0.1:11434` | **0** |
| `byok` | 任意 OpenAI 兼容端点 + key | 填一次（兜底） |

探测端口：`18899`、`18900`、`8326`、`1234`、`11434`、`4000`；以 `/v1/models` 探活为准，不存静态快照。

### 启动顺序

1. 并发探测 `gateway.local` 全部候选端口；
2. 命中 → 模型列表直接取网关 `/v1/models`；
3. 未命中 → `local.ollama`；
4. 仍未命中 → `pool.anon`；
5. 都不行 → 设置页「安装免费网关」一键跳 release 页，回来刷新；
6. 最后才是 `byok`。

### 降级规则（必须留痕）

| 上游信号 | 处理 |
| --- | --- |
| `429` / 配额墙 | 换下一条 lane，UI 明示"额度耗尽，已切换" |
| `404 model` | 该模型移出选择器，设置页保留拒因 |
| `5xx` / 超时 | 同 lane 重试 1 次，再降级 |
| `401` | 置 `needsLogin`，不重试 |
| 断网 | 全部 `unreachable`，不得显示"正在思考" |

---

## Agent 与工具

| 工具 | 来源 | 写盘 |
| --- | --- | --- |
| `read_file` | kernel.io | 否 |
| `list_dir` / `search` | kernel.io | 否 |
| `write_file` | kernel.io + 备份 + diff | **是** |
| `apply_patch` | 自研 unified diff | **是** |
| `erb_symbols` | eratw-adapter | 否 |
| `era_conditions` | eratw-adapter | 否 |
| `era_replay` | 既有 replay 服务 | 否 |
| `log_diagnose` | 移植日志解析 | 否 |
| `block_check` | 移植 `erb-check` | 否 |
| `ask_user` | `ctx.ui` | 否 |
| `finish` | — | 否 |
| `game_launch` | 阶段 5（新增窄口进程命令） | 进程 |

权限三档：沙箱全自动 / 真实工程一次批量审批 / 域外拒；每次写入仍保留备份与可回滚。

---

## 阶段与行数预算（新写）

| 阶段 | 内容 | 行数 |
| --- | --- | --- |
| P0 | `AiService` 契约 + Rust `ai_stream`/`ai_probe` + 取消 | 2,300（Rust 1,800 / TS 500） |
| P1 | ChannelRouter + 4 通道 + 模型合并/降级 | 2,100 |
| P2 | pi vendor（借用 3,300）+ `streamFn` 适配 + 会话/事件 | 1,300 |
| P3 | 12 个工具 + 审批模型 | 3,600 |
| P4 | AgentPanel / 模型选择器 / 设置页 | 2,700 |
| P5 | 启动器闭环（沙箱、报错收集、深链交接、回流 diff） | 1,800 |
| 合计 | | **≈ 13,800 新写 + 3,300 借用** |

vi 引擎（pi）路径 vs 全量移植 era-harness（96,401 行 / 712 文件）的对比口径：

| | pi 路径 | era-harness 路径 |
| --- | --- | --- |
| 需要 fork 的代码 | 6 文件（≈2,900 行） | 96k 行仓库 |
| 需改写的工具 | 0（自写 12 个） | 30 个直连 `node:fs` 的 handler |
| 宿主层 | 0 | 8,156 行 `hosts/` + 30,575 行 webview |
| 渠道 | 外包给网关 | 879 行灰道 + 风险 |

### 验收口径

- `pnpm test` 不回退；双 typecheck；`audit:decoupling` ✅（17 → 18 插件）；
- Rust `cargo test --lib`；
- 真机：断网时 lane 全 `unreachable` 且 UI 明示；取消流在 100ms 内回收；写盘 0 次绕过双闸；
- 新机器零配置，能在 `gateway.local` 或 `pool.anon` 上完成一次真实对话。

---

## 备选方案（为何不选）

| 方案 | 为何不选 |
| --- | --- |
| 全量移植 era-harness（Cline 派生） | 96k 行仓库、30 个直连 `node:fs` 的 handler、8k 行宿主层；还要处理 CC BY-NC 数据许可 |
| 改用 gemini-cli core | 引擎抽象更干净，但个人免费额度已迁出，且无域工具，需从零补 2~3k 行 |
| 改用 opencode core | client/server 架构最干净，但 Bun + Effect 迁移成本高 |
| 自己从零写 wire/流式/tool-call/diff | 这四块最易出错，重写等于重新踩坑；行数不低于借用 |
| 内置渠道代码（Kilo/Zen 等） | Zen 需伪造客户端与铸会话；Kilo 上游声明 prompt 可能被记录；维护面随上游漂移 |
| 打包 Node sidecar | ADR-0003 已拒；且绕过双闸 |

## 铁律对照

| 铁律 | 本提案 |
| --- | --- |
| A 内核零游戏名词 | `ai.ts` 全通用；`era*` 只在 adapter 与工具贡献 |
| B/C 插件只依赖 plugin-api | agent 不 import kernel、不 import 其他插件（服务注册表按名解析） |
| 4 不静默 | lane 状态、降级、截断、拒因全部可见 |
| 5/6 写盘与进程 | 写盘走 kernel.io + 会话级授权；`game_launch` 为新增窄口命令，需 ADR |
| ADR-0007 市场 | 渠道/配置不进市场，无代码插件分发 |

---

## 风险与开放问题

1. **`pool.anon` 的隐私面**：Kilo 上游声明 prompt 可能被记录。首次使用需一次明确说明，不得默认静默。
2. **网关探测误报**：`18899` 常被 `netsh interface portproxy` 占用（回环绑定 `EACCES`）。需区分"未监听"与"被占用"并给可执行提示。
3. **SSE 跨 IPC**：必须用 Tauri `Channel`；取消要能打断 reqwest body 读取，需专项测试。
4. **pi 归属**：vendor 目录保留 MIT 版权头与来源说明。
5. **开放问题（开工前需拍板）**：
   - `pool.anon` 是否默认开启；
   - 是否先冻结 `kernel.ai` 契约（建议先冻结，它是唯一会被三方复用的面）；
   - 会话级授权是否需要单开 ADR（本提案倾向需要）。

---

## 未执行声明

本文件仅为设计提案。**未创建任何代码、未修改任何契约、未新增任何依赖**；
列入 `docs/BOARD.md` 的执行条件为：`kernel.ai` 契约冻结 + 会话级授权 ADR 通过 + 渠道默认策略拍板。
