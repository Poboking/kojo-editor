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
