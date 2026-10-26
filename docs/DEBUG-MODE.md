# DEBUG-MODE.md — 编辑器调试模式：使用手册 + 开发规范

> 2026-10-24 调试模式批立（`51d0d485`）。本文件是调试模式的**唯一真源**：会用看 §一–§四，
> 要扩展先读 §五（规范）再动笔。入口命令同时登记在 `AGENTS.md` §三；坑账在 `docs/PITFALLS.md` 190/191。
> 上手 skill 的源随仓库走：`skills/kojo-debug/SKILL.md`（本手册的蒸馏版）——各 agent 把它同步/链接进
> 自己的专属 skill 目录（如 `~/.agents/skills/kojo-debug/`）；改手册或 skill 任一侧，都要同步另一侧。

## 一、是什么、何时用哪把刀

| 验证通道 | 工具 | 何时用 |
|---|---|---|
| 纯逻辑单测 | `pnpm test`（vitest） | 判据能写成纯函数 / 无 UI |
| **Web 调试模式（本文件主体）** | `tools/debug-cli.mjs serve` + 调试宿 | **无桌面壳的 agent**；体感 / UI 观感 / 功能链路验证；截图审 UI |
| **真桌面壳通道** | `tools/debug-cli.mjs shell` | 壳专属改动：启动相位 / 无边框 / 窗口几何 / 真 Tauri IPC——Web 调试宿**复现不了**这些，必须起真壳 |
| 桌面壳真机冒烟 | `tools/smoke-tauri-dom.mjs` / `-ipc.mjs` | 发版判据的一次性全绿（真 IPC / 真机右键） |

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
- **卡顿体检（可开关探针）**：`perf start` → 驱动交互（`type`/`run`/切主题）→ `perf stop` 出报告（帧率分档
  >32/50/100ms、长任务≥50ms 带总线事件 hint、交互延迟>100ms 带 target、逐源码文件的帧耗时归因）；
  `perf quick [ms]` 一条龙。真机读数示例：189 帧 p50=16.7ms max=74.1ms；人为注入 120ms 帧被精确钉住。
  探针关着零开销。**口径（2026-10-25 反馈批修正）**：报告只含探针窗口内的条目（buffered 已关＋
  startedAt 双保险，页面加载期的历史长任务混不进来）；bySource 空＝无**渲染型**长帧（纯脚本长帧会
  记进 `(render)` 桶的反面——脚本帧带源码名，样式/布局帧归 `(render)`）；hint 只认任务窗口 ±200ms 内
  的总线事件（内核事件与任务要真正同窗，分两次 CLI 调用隔太久就是 null——那是语义不是 bug）。
- **函数级热点归因**：`profile run [ms] [--eval "<js>"]`（CDP CPU 采样器；⚠ Profiler 绑 CDP 连接，
  跨 CLI 调用 start→stop 拿不到数据——代码级负载用 `--eval` 同连接跑，页内交互在窗口内驱动）；
  输出 selfTime 降序 Top25，`KOJO_PROFILE_OUT=<路径>` 同时落完整 .cpuprofile（DevTools 火焰图）。
- **功能健全验证**：`commands` 找到目标命令 id → `run <id>` → `state`/`events` 断言副作用（相位 / 面板 / 事件名）。
- **编辑链路**：`open-file` → `eval "__kojoDebug.editor.type('PRINTL x')"` → `eval "__kojoDebug.editor.markers()"`
  → 保存后 `eval "__kojoDebug.invoke('read_file_bytes_raw',{path:'…'})"` 与盘上内容对拍。
- **外部改动 / 文件监视**：改沙盒内文件 → `events` 里应出现 `file.changed` 级联（调试宿 SSE → `kojo:fs-changed`）。
- **对话框流**：目录选择＝policy 自动应答、两条腿同一口径（web 模式＝`POST /policy {"chooseDir": …}`（`null`＝模拟取消）；真壳＝`__kojoDebug.dialogPolicy.arm(<目录>)` **一次性**、只答"打开＝读"）——`open-project` 两模式都已内置；`export_file`/`choose_file`/写域准入门**不应答**（对话框即授权不许绕）。
- **批量回归**：`node tools/debug-web-smoke.mjs`（19 断言端到端；失败自动留屏上文本 + 失败截图）。

## 三、CLI 子命令总表

| 子命令 | 作用 | 备注 |
|---|---|---|
| `serve` | 拉起调试宿+vite+浏览器 | `--headless / --no-browser / --record`（console 落盘）/ `--fresh`（清沙盒）/ `--sandbox/--readonly/--port/--vite-port/--cdp-port/--browser`。**会话按仓库工作树自动隔离**（`<home>/sessions/<树哈希>/`，多 agent 并发互不可见；`KOJO_DEBUG_SESSION_NAME` 显式命名、`KOJO_DEBUG_SESSION` 直指会话文件） |
| `status` / `stop` / `url` | 会话健康 / 收会话 / 打印编辑器 URL | 会话文件 `%TEMP%/kojo-debug/session.json`（`KOJO_DEBUG_SESSION` 可指别处） |
| `open-project <dir> [--writable]` | 真实点击链路开项目 | 自动应答目录对话框（web=宿 policy／shell=调试面 dialogPolicy，见 §二对话框流）；`--writable` 批准写权限（**仅 web 模式**，真壳只读），缺省只读浏览；已开同项目幂等直过；结尾硬对拍 `rootDir===请求目录` 防假绿 |
| `open-file <路径片段>` | 真实点击文件树开文件 | 角色分组→目录逐层展开；等 Monaco 挂载后回编辑器读数 |
| `commands [过滤]` / `run <id>` | 列出 / 执行命令面板命令 | **所有功能只要登记了命令就有可编程入口** |
| `state` / `dom` / `events [n]` | 一屏读数 / DOM 结构快照 / 事件旁听 | 全部 JSON，可断言 |
| `eval "<js>"` | 页内求值（可 await） | 万能逃生口 |
| `invoke <cmd> [json]` | 直达宿主命令 | 与产品同一条 invoke 路 |
| `click <sel>` / `type [<sel>] <文本>` / `key <键> [ctrl+…]` | CDP 真实输入 | click 带 elementFromPoint 自证；**type 省略选择器＝打到当前焦点元素**（命令面板/搜索框先点开或 `key ctrl+p` 再 type）；key 支持 enter/escape/tab/arrow* |
| `screenshot <png> [--full]` | 截图 | 拍前自动 `Page.bringToFront` + 双 rAF 强制产帧，**不吃缓存帧**（切主题/Monaco 重绘后也是新帧）；agent 的「眼睛」 |
| `perf <start\|stop\|quick [ms]>` | UI 卡顿体检（可开关探针） | start/stop 跨命令存活（探针在页内）；报告四路：帧分档 / 长任务×事件 hint / 交互延迟 / 逐源码帧耗时（render 型长帧归 `(render)` 桶） |
| `profile <run [ms]> [--eval "<js>"]` | CPU 采样归因（函数级热点） | selfTime Top25；⚠ 绑 CDP 连接——start/stop 跨调用无效，用 run 一条龙；KOJO_PROFILE_OUT 落 .cpuprofile |

页内 API（`?kojo-debug=1` 选入后）：`__kojoDebug.{mode, host, state(), kernel(), commands.{list,run},
bus.{recent,on}, editor.{info,setValue,type,setCursor,markers}, invoke, dialogPolicy.{arm,armed,clear,status},
dom.snapshot,
perf.{start,stop,isRunning,lastReport,summary}}`。
写动作（setValue/type）显式命名；`type` 走 executeEdits 进撤销栈＝「像真人一样改」；
`perf.*` 见 §二 卡顿体检配方（关着零开销）。

## 四、调试宿（debug-server.mjs）速览

- 协议：`POST /invoke` `{cmd,args}`→`{ok,value|error}`（二进制回 `{__b64}` 信封；带 `?binary=1`
  时两个二进制命令直接回 `application/octet-stream` 原始帧/字节，错误仍回 JSON——页面侧按
  content-type 自动回退，旧宿/旧页面可独立升级）；`GET /events` SSE
  （`kojo:fs-changed` / `kojo:fs-watch-error`，事件名与桌面壳 Tauri 事件**字面成对**）；`GET /health|/config`；`POST /policy`。
- 准入：只绑 127.0.0.1；读域＝sandbox ∪ appData ∪ `--readonly` 根 ∪ 常驻工作区根；写域＝sandbox ∪ appData ∪
  常驻根 ∪ `register_write_domain` 登记根；域外一律显式报错。对话框＝policy 自动应答（**不开放任意目标路径参数**，
  与铁律 6 同向）；`export_file` 落 sandbox/exports 并回全路径。
- **性能（2026-10-26 性能批）**：`search_text` 目录遍历并行但输出顺序确定；普通文本查询（非正则、
  不含换行）在整串上 `indexOf`/全局正则一次扫完，只在命中处回推行号；≤8 MiB 文件整读、超限 fstat
  秒拒；批内并发由 `KOJO_DEBUG_SEARCH_CONCURRENCY`（默认 8）封顶，内存上界≈并发×8 MiB。
  目录/元数据并发为 `KOJO_DEBUG_WALK_CONCURRENCY`（默认 24）。`walk_dir` 并行 readdir/stat 但
  输出序与串行实现逐项一致；批量读用 open+fstat+readFile 一趟句柄，二进制应答不再 base64 膨胀。
  同机同语料对拍（`node tools/debug-host-bench.mjs`，2000×~30KB + 大文件，warm cache，2026-10-26，
  优化前→优化后）：全扫检索 2.78s→0.66s（大小写不敏感 2.00s→0.53s、正则 1.85s→0.63s）、
  `walk_dir` 带元数据 0.88s→0.39s、200 文件批读 131ms→81ms、24MB 批读 268ms→118ms、5MiB 单读
  164ms→77ms；`stat_files` 2000 条基本持平（Windows 元数据 I/O 下限）。**口径**：同一行多处命中
  全列出（与 Rust `scan_text` 的 `find_iter(line)` 对齐）；`maxResults` 截断落点仍按 readdir 序确定。

## 四b、真桌面壳模式（shell）——壳专属改动的验证通道

```bash
node tools/debug-cli.mjs shell              # 起真壳（tauri dev）带 CDP；默认把 webview 导航到 ?kojo-debug=api
node tools/debug-cli.mjs state / commands / eval / screenshot …   # 全套子命令照用（同会话房间）
node tools/debug-cli.mjs stop
```

- **`?kojo-debug=api` 形态**：只装 `__kojoDebug` 调试面、**不切** web 宿路由——`invoke` 走**真 Tauri IPC**
  （实测 `app_data_dir` 回真 `%APPDATA%`）。`?kojo-debug=1` 仍是 web 宿形态，两者别混。
- 与 serve 互斥（同一会话房间同时只挂一套）；`--isolate` 换 `.smoke` 身份（多台壳并发时避免
  同 identifier 的 0x8007139F）；`--no-debug-api` 保持 pristine boot——**验启动相位本身**用这个
  （默认的导航注入会重放开机流程）；冷 cargo 构建首次会久（预算 `KOJO_DEBUG_SHELL_BOOT_MS`，默认 300s）。
- 边界：CDP 看不到 OS 窗口框——无边框 / 窗口几何的判据以**截图 + DOM**（窗口 chrome 模块的属性）为准；
  目录选择是原生对话框、CDP 点不到它——`open-project` 在 shell 模式经调试面 `dialogPolicy` 应答 IPC 请求腿
  （一次性、**只读**；写审批 `--writable` 如实拒——Rust 准入门只认真实对话框交付。裁决与残余口子见
  `packages/app/src/debug/dialog-policy.ts` 头注 + PITFALLS 230）。
- 与 smoke-tauri-dom 的分工：那是发版判据一次性冒烟；这是可驻留、可逐步驱动（eval/events/screenshot）的会话。

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
13. **多 agent 并发隔离（2026-10-25 反哺立规，PITFALLS 192）**：会话目录＝`sessionDir(仓库根)`
    （`<home>/sessions/<树哈希>/`，`debug-lib.mjs` 单源）——session.json / sandbox / appdata /
    browser-profile / console.log 全在房间里；**`stop` 与 `killProcessesMarked` 只许认领本会话目录**
    （全局杀＝把别人的会话一起收掉）；`status` 首行必须带会话标识（键＋repoRoot），agent 核对
    「量的是不是自己的树」。跨树要共享或接管时走显式 env（`KOJO_DEBUG_SESSION_NAME` /
    `KOJO_DEBUG_SESSION`），不做静默兜底。

## 六、故障定位速查

| 症状 | 先查 |
|---|---|
| 壳专属改动（启动相位 / 无边框 / 窗口几何）验不了 | 那本来就不归 Web 调试宿——`debug-cli.mjs shell` 起真壳带 CDP（§四b）；验启动相位本身加 `--no-debug-api` |
| shell 起不来 / 起来就退（0x8007139F） | 同 identifier 的壳在并发——加 `--isolate`；或 1420 被占（KOJO_SMOKE_VITE_PORT 换口） |
| **量到别人的树**（端口/模块 URL/插件数与本树不符） | 会话已按工作树隔离（PITFALLS 192 已修）：先 `status` 核首行「会话＝<键>（<本树路径>）」；不对就是接管了显式 env 指到的别人的会话。多树并发无需再手工 `KOJO_DEBUG_HOME`，但**旧版工具写的全局 session.json 仍会被旧代码读到**——各树先更新到带隔离的版本 |
| serve 中途挂 / 某件套没了 | `status` 的「退出记录」带每个子进程的退出码与时间（serve 输出同步打）；宿侧已加大堆（`--max-old-space-size=4096`，重检索 OOM 的主嫌疑）并有 uncaught 落日志不静默死——重检索把 2325 文件全扫约 10 分钟后挂（exit 13）是本条立规的实测 |
| 点击全被挡 / 白红页 | `eval` 查 `vite-error-overlay` 在不在＝陈旧错误盖屏，`location.reload()` 即清（新 workspace 包没 `pnpm install` 链上时会出现，PITFALLS 192③） |
| 项目弹回欢迎页 / 命令注册表「未登记」 | PITFALLS 192 的三成因排查链：error-overlay → serve 日志 grep `reloading`（deps 冷发现，新项目态懒依赖要补进 `optimizeDeps.include`）→ 落点 |
| 命令注册表 + 事件旁听**同时**失灵 | HMR 整页刷新拆了会话（PITFALLS 190）：确认落点在 `%TEMP%`、vite watch 忽略 `.kojo-debug` |
| 别的工具（conformance CLI 等）EBUSY 崩 | 仓库内有调试残留 / Edge 锁 profile：`killProcessesMarked` + 清 `.kojo-debug`（PITFALLS 190） |
| 端口被占（rc=2） | `node tools/debug-cli.mjs stop`，或 `--vite-port/--port/--cdp-port` 换口 |
| 找不到浏览器 | `KOJO_DEBUG_BROWSER=<chrome或edge路径>` |
| 点击无反应 | 首启「碎碎念」遮罩（`open-project` 已自动关）；自定义点击前先 `dom` 看遮罩 |
| `open-project` 写不进 | 写域闸如实拒——要么 `--writable`，要么把项目放进沙盒（§二注） |
