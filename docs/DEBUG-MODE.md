# DEBUG-MODE.md — 编辑器调试模式：使用手册 + 开发规范

> 2026-10-24 调试模式批立（`51d0d485`）。本文件是调试模式的**唯一真源**：会用看 §一–§四，
> 要扩展先读 §五（规范）再动笔。入口命令同时登记在 `AGENTS.md` §三；坑账在 `docs/PITFALLS.md` 190/191。
> 本机级 skill（`~/.agents/skills/kojo-debug/SKILL.md`）是本手册的蒸馏版，改这里之后顺手同步它。

## 一、是什么、何时用哪把刀

| 验证通道 | 工具 | 何时用 |
|---|---|---|
| 纯逻辑单测 | `pnpm test`（vitest） | 判据能写成纯函数 / 无 UI |
| 桌面壳真机 | `tools/smoke-tauri-dom.mjs` / `-ipc.mjs` | 真 Tauri IPC / 真机右键 / 发版判据 |
| **Web 调试模式（本文件）** | `tools/debug-cli.mjs` + `tools/debug-server.mjs` | **无桌面壳的 agent**；体感 / UI 观感 / 功能链路验证；截图审 UI |

Web 调试模式的形态：编辑器在**纯浏览器**里跑（vite dev 页面 + `?kojo-debug=1`），全部宿主命令
（Rust 那侧的 36 条）由本机 Node 调试宿镜像，页内有 `window.__kojoDebug` 调试面，外面有 CLI 全命令行驱动。
运行时落点默认 `%TEMP%/kojo-debug/`（`KOJO_DEBUG_HOME` 可整体搬）。

**边界（如实）**：`market_*` 网络命令显式失败（联网白名单在 Rust 侧，市场链路走桌面壳）；
`encode_string` 不支持 shift_jis（Node 无编码器，读取方向不受影响）；没有本机 Chrome/Edge 时浏览器腿起不来（rc=2，纯 CLI 面仍可用）。

## 二、快速上手（agent 标准工作流）

```bash
# 0) 在 kojo-editor 仓库内；先 pnpm install 过（vite 在位）
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），打印编辑器 URL
node tools/debug-cli.mjs serve --headless
#    ↳ 有窗模式去掉 --headless（真人看屏）；不带浏览器加 --no-browser；
#      挂真实语料只读盘：--readonly "D:/Game/你的语料"（铁律 5：只读，永不写）
# 2) agent 内置浏览器打开它打印的 URL —— 人与 agent 看同一屏
# 3) 开项目（真实点击链路：目录对话框自动应答 → 写权限审批）+ 开文件（树自动逐层展开）
node tools/debug-cli.mjs open-project <项目目录> [--writable]   # 仓库内目录＝只读打开，见下方 ⚠ 注
node tools/debug-cli.mjs open-file M_KOJO
# 4) 驱动 / 取读数 / 截图
node tools/debug-cli.mjs commands                 # 所有功能的可编程入口（命令面板注册表）
node tools/debug-cli.mjs run workbench.problems   # 跑一条命令 = 真人按 Ctrl+Shift+P 同一条路
node tools/debug-cli.mjs state / dom / events 20  # 一屏读数 / DOM 结构快照 / 内核事件旁听
node tools/debug-cli.mjs screenshot out.png       # agent 直接看图审 UI（--full 整页）
# 5) 收工（按 pid + 命令行认领杀逃逸的 Edge 子进程）
node tools/debug-cli.mjs stop
```

⚠ `open-project` 直接指向仓库内目录时是**只读打开**写不进（写域闸会如实拒）；
要在可写区测保存链路，先把样例复制进沙盒：
`node -e "require('fs').cpSync('fixtures/mini-game','%TEMP%/kojo-debug/sandbox/mini-game',{recursive:true})"`
然后 `open-project` 指沙盒那份（Windows 下 `%TEMP%` 换实际路径，`serve` 打印的 sandbox 路径可直接抄）。

### 常用配方

- **UI 观感检查**：`serve --headless` → `run` 各视图命令逐个 → `screenshot` 每屏一张 → 看图（PNG 可直接读）。
- **功能健全验证**：`commands` 找到目标命令 id → `run <id>` → `state`/`events` 断言副作用（相位 / 面板 / 事件名）。
- **编辑链路**：`open-file` → `eval "__kojoDebug.editor.type('PRINTL x')"` → `eval "__kojoDebug.editor.markers()"`
  → 保存后 `eval "__kojoDebug.invoke('read_file_bytes_raw',{path:'…'})"` 与盘上内容对拍。
- **外部改动 / 文件监视**：改沙盒内文件 → `events` 里应出现 `file.changed` 级联（调试宿 SSE → `kojo:fs-changed`）。
- **对话框流**：目录选择 = `POST /policy {"chooseDir": …}` 自动应答（`open-project` 已内置）；`null` = 模拟取消。
- **批量回归**：`node tools/debug-web-smoke.mjs`（9 断言端到端；失败自动留屏上文本 + 失败截图）。

## 三、CLI 子命令总表

| 子命令 | 作用 | 备注 |
|---|---|---|
| `serve` | 拉起调试宿+vite+浏览器 | `--headless / --no-browser / --record`（console 落盘）/ `--fresh`（清沙盒）/ `--sandbox/--readonly/--port/--vite-port/--cdp-port/--browser` |
| `status` / `stop` / `url` | 会话健康 / 收会话 / 打印编辑器 URL | 会话文件 `%TEMP%/kojo-debug/session.json`（`KOJO_DEBUG_SESSION` 可指别处） |
| `open-project <dir> [--writable]` | 真实点击链路开项目 | 自动应答目录对话框；`--writable` 批准写权限，缺省只读浏览；已开同项目幂等直过 |
| `open-file <路径片段>` | 真实点击文件树开文件 | 角色分组→目录逐层展开；等 Monaco 挂载后回编辑器读数 |
| `commands [过滤]` / `run <id>` | 列出 / 执行命令面板命令 | **所有功能只要登记了命令就有可编程入口** |
| `state` / `dom` / `events [n]` | 一屏读数 / DOM 结构快照 / 事件旁听 | 全部 JSON，可断言 |
| `eval "<js>"` | 页内求值（可 await） | 万能逃生口 |
| `invoke <cmd> [json]` | 直达宿主命令 | 与产品同一条 invoke 路 |
| `click <sel>` / `type <sel> <文本>` / `key <键> [ctrl+…]` | CDP 真实输入 | click 带 elementFromPoint 自证；key 支持 enter/escape/tab/arrow* |
| `screenshot <png> [--full]` | 截图 | agent 的「眼睛」 |

页内 API（`?kojo-debug=1` 选入后）：`__kojoDebug.{mode, host, state(), kernel(), commands.{list,run},
bus.{recent,on}, editor.{info,setValue,type,setCursor,markers}, invoke, dom.snapshot}`。
写动作（setValue/type）显式命名；`type` 走 executeEdits 进撤销栈＝「像真人一样改」。

## 四、调试宿（debug-server.mjs）速览

- 协议：`POST /invoke` `{cmd,args}`→`{ok,value|error}`（二进制回 `{__b64}` 信封）；`GET /events` SSE
  （`kojo:fs-changed` / `kojo:fs-watch-error`，事件名与桌面壳 Tauri 事件**字面成对**）；`GET /health|/config`；`POST /policy`。
- 准入：只绑 127.0.0.1；读域＝sandbox ∪ appData ∪ `--readonly` 根 ∪ 常驻工作区根；写域＝sandbox ∪ appData ∪
  常驻根 ∪ `register_write_domain` 登记根；域外一律显式报错。对话框＝policy 自动应答（**不开放任意目标路径参数**，
  与铁律 6 同向）；`export_file` 落 sandbox/exports 并回全路径。

## 五、开发规范（扩展调试模式前必读）

1. **产品路径零语义变化**：`?kojo-debug` 未选入时，`invoke.ts` / `search.ts` / `tauri-bridge.ts`
   的行为与从前逐字一致——原报错文案与降级路径有守门用例（`packages/app/tests/debug-surface.test.ts`），改文案先过它。
2. **新宿主命令三处成对**：Rust 命令（`src-tauri`）→ `tools/debug-server.mjs` 实现 → `SUPPORTED_COMMANDS`。
   忘了进调试宿？`tools/tests/debug-server.test.ts` 的对账用例会红（它现场扫 app 源里 `invoke('…')` 的全集）。
3. **开机图纪律**：`packages/app/src/debug/**` 只许**动态 import**；`debug-registry` 登记簿在
   bootstrap/ShellLayout 两枚常驻件里也只许动态装载（文件闸余量纪律，守门用例钉死）。
4. **落点纪律**：一切运行时写盘默认 `%TEMP%/kojo-debug`（`debugHome()` 单源），**不许默认写进仓库**——
   仓库内残留会弄红对仓库建 watcher 的别的工具、vite HMR 会整页刷新拆碎会话（PITFALLS 190 双坑，均有实测）。
5. **进程收尾**：Edge 子进程会逃出 `taskkill /T` 的树并锁住 profile——收尾必须 `killProcessesMarked(<目录>)`
   （`tools/debug-lib.mjs`），别只杀 launcher。
6. **判据口径**：只认结构锚（类名 / data 属性），不匹配界面文案（§5.117 老纪律）；DOM 快照的选择器单源在
   `dom-snapshot.ts` 顶部，别在别处手抄。
7. **事件名成对**：宿主推送事件名与桌面壳 Tauri 事件字面一致，不发明第二套名字。
8. **帧格式单源**：`read_files_raw` 有三份实现（Rust 编码 / Node 编码 / 页面解码），以帧格式为唯一真源成对演进，
   改帧必过「Node 编码 × 页面解码」对拍用例。
9. **安全面不变式**：只绑回环；读写域 fail-loud 不静默；`market_*` 一族 fail-closed（不复制 Rust 白名单）；
   对话框只做自动应答 policy。给调试宿加「出网 / 任意路径写」能力之前先过组长。
10. **`__kojoDebug` API 只 additive**：加字段可以，改既有字段语义不可以；破坏性变更抬版本位（`kojoDebug.v2`）。
11. **新能力同步补冒烟**：调试面 / 宿新增可断言能力时，`tools/debug-web-smoke.mjs` 补一条断言（那是这套通道的回归网）。
12. **改了调试模式的验收口径**：`tools/tests/debug-server.test.ts` + `packages/app/tests/debug-surface.test.ts`
    + `debug-dom-snapshot.test.ts` 全绿，且 `node tools/debug-web-smoke.mjs` **真跑** rc=0（纯文档批豁免）。

## 六、故障定位速查

| 症状 | 先查 |
|---|---|
| 命令注册表 + 事件旁听**同时**失灵 | HMR 整页刷新拆了会话（PITFALLS 190）：确认落点在 `%TEMP%`、vite watch 忽略 `.kojo-debug` |
| 别的工具（conformance CLI 等）EBUSY 崩 | 仓库内有调试残留 / Edge 锁 profile：`killProcessesMarked` + 清 `.kojo-debug`（PITFALLS 190） |
| 端口被占（rc=2） | `node tools/debug-cli.mjs stop`，或 `--vite-port/--port/--cdp-port` 换口 |
| 找不到浏览器 | `KOJO_DEBUG_BROWSER=<chrome或edge路径>` |
| 点击无反应 | 首启「碎碎念」遮罩（`open-project` 已自动关）；自定义点击前先 `dom` 看遮罩 |
| `open-project` 写不进 | 写域闸如实拒——要么 `--writable`，要么把项目放进沙盒（§二注） |
