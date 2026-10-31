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

Web 调试模式的形态：编辑器在**纯浏览器**里跑（vite dev 页面 + `?kojo-debug=<宿端口>&kojo-debug-token=<会话 token>`），
宿主命令由本机 Node 调试宿镜像，页内有 `window.__kojoDebug` 调试面，外面有 CLI 全命令行驱动。
运行时落点默认 `%TEMP%/kojo-debug/`（`KOJO_DEBUG_HOME` 可整体搬）。

**命令条数不写死在文档里**（每批都会变）：现读一次
`node -e "import('./tools/debug-server.mjs').then(m => console.log(m.SUPPORTED_COMMANDS.length))"`
——这是**宿主命令**（对应 Rust `invoke` 那一侧）的口径，2026-10-30 实测 **41 条**。
`debug-cli commands` 列的是**命令面板注册表**（含插件 `contributes.commands` 注册的命令），
条数更多且随插件增减，一律以当次实际输出为准；两个数字不同是正常的，别互相对账。

**边界（如实）**：`market_*` 网络命令显式失败（联网白名单在 Rust 侧，市场链路走桌面壳）；
`encode_string` 不支持 shift_jis（Node 无编码器，读取方向不受影响）；没有本机 Chrome/Edge 时浏览器腿起不来（rc=2，纯 CLI 面仍可用）。

## 二、快速上手（agent 标准工作流）

```bash
# 0) 在 kojo-editor 仓库内；先 pnpm install 过（vite 在位）
#    起不来 / 读数可疑，先体检（八项：node 版本 / 仓库根 / 会话文件 / 宿口 / CDP 口 / dist / vite 缓存 / 残留进程）
node tools/debug-cli.mjs doctor
#    ↳ 任一 FAIL ⇒ 退出码 1；WARN 只提示不失败；每项尾部带可复制的 fix 命令（体检只读：不删缓存、不杀进程）
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），打印编辑器 URL
node tools/debug-cli.mjs serve --headless
#    ↳ 有窗模式去掉 --headless（真人看屏）；不带浏览器加 --no-browser；
#      挂真实语料只读盘：--readonly "D:/Game/你的语料"（铁律 5：只读，永不写）
# 2) agent 内置浏览器打开它打印的 URL —— 人与 agent 看同一屏
#    该 URL 自带 `&kojo-debug-token=<会话 token>`；`status` 打印时会脱敏成 `kojo-debug-token=***`，
#    要完整 URL 用 `url` 子命令（它就是给浏览器/agent 用的）
# 3) 开项目（真实点击链路：目录对话框自动应答 → 写权限审批）+ 开文件（树自动逐层展开，等路径对拍）
node tools/debug-cli.mjs open-project <项目目录> [--writable] [--timeout <ms>]
#    ↳ 不是工程根会**快速失败**（当场 exit 1 并给应用原文，不再等满 60s）——见下方「打开失败判据」；
#      --timeout 只改第 4 步预算（默认 60000，夹 [3000,300000]），给慢盘/大工程放预算用
#    ↳ 仓库内目录＝只读打开，见下方 ⚠ 注
node tools/debug-cli.mjs open-file M_KOJO        # 结束条件＝editor.info().path 归一化后含该片段（最多 10s）
# 4) 驱动 / 取读数 / 断言 / 截图
node tools/debug-cli.mjs commands                 # 所有功能的可编程入口（命令面板注册表）
node tools/debug-cli.mjs run workbench.problems --settle 800   # 跑一条命令 = 真人按 Ctrl+Shift+P 同一条路
node tools/debug-cli.mjs wait "__kojoDebug.state().phase === 'project'"   # 每 200ms 求值，truthy 即成功
node tools/debug-cli.mjs assert "__kojoDebug.state().tabs.length > 0"     # 一次求值，falsy 就 exit 1
node tools/debug-cli.mjs state / dom / events 20  # 一屏读数 / DOM 结构快照 / 内核事件旁听
node tools/debug-cli.mjs screenshot out.png       # agent 直接看图审 UI（--full 整页）
# 5) 切项目别重启整套：关掉当前项目再开下一个（省掉 vite/CDP 冷启动）
node tools/debug-cli.mjs close-project            # 工具栏「项目操作」→「关闭项目」，等相位回 welcome
node tools/debug-cli.mjs open-project <另一个目录>
# 6) 收工（按 pid + 命令行认领杀逃逸的 Edge 子进程）
node tools/debug-cli.mjs stop
```

⚠ `open-project` 直接指向仓库内目录时是**只读打开**写不进（写域闸会如实拒）；
要在可写区测保存链路，先把样例复制进沙盒：
`node -e "require('fs').cpSync('fixtures/mini-game','%TEMP%/kojo-debug/sandbox/mini-game',{recursive:true})"`
然后 `open-project` 指沙盒那份（Windows 下 `%TEMP%` 换实际路径，`serve` 打印的 sandbox 路径可直接抄）。

### 内存预算：1G 容器里浏览器会被杀（2026-10-31）

这条链是**三件套**（调试宿 + vite + 浏览器），实测地板 1.0~1.2 GB、峰值 2.6 GB（fixture=mini-game，`--only semantic` 31s，WorkingSet 求和是上界）。容器只给 1G 时，浏览器的渲染进程会被 cgroup OOM killer 杀掉——**不是浏览器 bug，也不是本仓的限制**：全仓没有任何浏览器内存闸（`js-flags` / `renderer-process-limit` / `dev-shm` 零命中）。

- `serve` 会按本机预算给调试宿算堆上限（`--max-old-space-size`）：1G ⇒ 512 MB，2G ⇒ 921 MB，64G ⇒ 4096 MB（与原写死值一致，常态输出不多一行）。
- `KOJO_DEBUG_HOST_HEAP=<MB>` 可显式覆盖；覆盖时 `serve` 会打一行 `内存预算 … ⇒ 调试宿堆上限 …`。
- Windows 容器（Job Object 上限在进程内读不到、`os.totalmem()` 常报宿主总量）用 `KOJO_MEM_BUDGET_MB=<MB>` 声明真实预算；只在小于探测值且 ≥256 时采信。
- 预算 < 2048 MB 时，冒烟会在 boot 段先打两行告警（**只提示不失败**）。
- 判容量还是判泄漏：同一会话反复开文件后堆**单调上涨且不回落**才是泄漏；只死一次、读数停在某个水位是容量不够。进程"神秘消失"先看 `debug-cli status` 的 `exits` 与 `signal`（137 / SIGKILL ⇒ 外部杀）。

### 打开失败判据（2026-10-30 批：快速失败，不再等满 60s）

对**不是工程根**的目录（如 `fixtures/sugar`：只有 `.kojo`、没有 CSV/ERB），应用会当场拒绝并把
相位退回欢迎页。旧实现第 4 步只轮询「写权限弹窗 / 文件树」，于是一律拖到 60s 才报
「写权限审批 / 文件树」——用户读到的是**超时**，而不是**这个目录不被接受**。现在同一个 250ms
轮询里**同拍**看下面几路信号（判据是纯函数 `classifyOpenFailure()`，在 `tools/debug-cli.mjs`）：

| 信号 | 判据 | 说明 |
|---|---|---|
| 错误通知原文 | `.notice.error`（或 `.notice[data-kind="error"]`）的可见文本非空 | **无条件**算失败，原文直接进错误信息 |
| **新出现的 toast** | 点「打开项目」**之前**先给屏上已有 `.toast` 拍底片；之后与底片取差集，**新的那条**再按关键词过滤 | 应用的拒绝原文常只出现在 toast 里。**不无条件算失败**——打开前就挂着的后台报错不该判死一次正常打开（底片去重就是干这个的） |
| 状态通知关键词 | `__kojoDebug.state().notices.items`（含上面那批新 toast）任一条含 `打开` / `失败` / `不支持` / `不是` | 只认这四类词，普通提示不算 |
| 欢迎页回流 | 点完 `.welcome-open` 超过 **1.5s** 仍 `phase === 'welcome'` 且没有 `.file-tree` | 应用把这次打开退回来了；此刻若屏上有 error toast，**即便文案与底片逐字相同**（被去重）也把它原文带出来——那是应用真说的那句话 |

正常中间态一律**不**算失败：`.file-tree` 一旦出现＝这趟开了；`.modal[aria-label="写权限确认"]`
出现＝应用**接受了**目录（只是等你选只读/可写）。命中失败时固定文案 + **exit 1**（不是 2，2 留给
「参数/会话前置不满足」），其中 `<应用原文>` 的取法有优先级：**本次新 toast 原文 > 回流时屏上最后一条
error toast 原文 > 判据理由**：

```
[FAIL] 打开被应用拒绝：<应用原文>（目录：<abs>）——不是工程根或缺权限，换目录或先看 dom 通知
```

2026-10-30 实测两条（同一命令、同一目录 `fixtures/sugar`，命中哪条取决于应用把话说在哪）：

```
# 应用把话说在通知 / toast 里（最常见）
[FAIL] 打开被应用拒绝：「sugar」不是可识别的游戏目录。（目录：…/fixtures/sugar）——不是工程根或缺权限，换目录或先看 dom 通知
# 应用只是退回欢迎页、一句话都没留
[FAIL] 打开被应用拒绝：点开之后又回到了欢迎页：应用没有接受这个目录（目录：…/fixtures/sugar）——…
```

- `--timeout <ms>`：只改**第 4 步**（等弹窗/树/失败信号）的预算，默认 `60000`，夹在 `[3000, 300000]`；
  非法值落默认。它**不会**让失败变慢——快失败优先于预算，预算用完仍无任何信号（也没树/没弹窗）时
  报的是「没有可读的失败信号，放预算 `--timeout`」并提示先 `dom` 看屏。
- 排查顺序：报 `[FAIL] 打开被应用拒绝` ⇒ 看原文（多半是「该目录不是 era 工程」「不支持」）；
  报「预算内既没弹窗也没树」⇒ 屏卡在别处，`dom` / `screenshot` 看现场，再放 `--timeout`。

### `type` 的三种输入模式（2026-10-30 批）

`type [<选择器>] <文本> [--mode text|keys|ime]`，**默认 `text`，行为与旧版逐字一致**：

| 模式 | 走什么 | 何时用 |
|---|---|---|
| `text`（默认） | `Input.insertText` 直插 | 只要「输入框里出现这段字」：搜索框、命令面板过滤、改名 |
| `keys` | 逐字符 `Input.dispatchKeyEvent`（`keyDown` → `char` → `keyUp`），走**真实键盘路径** | 测**只认键盘事件**的行为：括号/引号**自动配对**、回车**缩进**、触发字符（`<`/`"` 弹出补全）、快捷键前缀 |
| `ime` | 先 `Input.imeSetComposition`（`selectionStart/End` 落在当前长度）再 `Input.insertText` 提交 | 模拟**输入法组合→上屏**：中文/日文候选上屏、组合期不触发补全的路径 |

- `keys` 对**非 BMP 字符**（emoji 等）退化为 `insertText` 单发，并在输出里如实给 `fallback=N`
  ——它表达「这 N 个字符没走键盘路径」，不假装成功。
- `ime` 在 CDP 端点不支持 `Input.imeSetComposition` 时**如实红**（exit 1），不静默退化成 `insertText`
  ——退化后的读数会让人以为「输入法这条路已经验过」，那是假绿。
- 输出统一带模式：`[ok] 已输入 <n> 字符（mode=keys|ime|text）…`（`keys` 附带 `fallback=N`）。
  注意 `keys` 的 `<n>` 按**码位**数（`[...text].length`），`text`/`ime` 按 UTF-16 长度
  （`text.length`）——含 emoji 时两个数会差，别拿它们互相对账。

### 常用配方

- **UI 观感检查**：`serve --headless` → `run` 各视图命令逐个 → `screenshot` 每屏一张 → 看图（PNG 可直接读）。
- **卡顿体检（可开关探针）**：`perf start` → 驱动交互（`type`/`run`/切主题）→ `perf stop` 出报告（帧率分档
  >32/50/100ms、长任务≥50ms 带总线事件 hint、交互延迟>100ms 带 target、逐源码文件的帧耗时归因）；
  `perf quick [ms]` 一条龙。真机读数示例：189 帧 p50=16.7ms max=74.1ms；人为注入 120ms 帧被精确钉住。
  探针关着零开销。**口径（2026-10-25 反馈批修正）**：报告只含探针窗口内的条目（buffered 已关＋
  startedAt 双保险，页面加载期的历史长任务混不进来）；bySource 空＝无**渲染型**长帧（纯脚本长帧会
  记进 `(render)` 桶的反面——脚本帧带源码名，样式/布局帧归 `(render)`）；hint 只认任务窗口 ±200ms 内
  的总线事件（内核事件与任务要真正同窗，分两次 CLI 调用隔太久就是 null——那是语义不是 bug）。
- **函数级热点归因**：`profile [run] [ms] [--eval "<js>"]`（`profile 3000` 与 `profile run 3000` 等价；
  CDP CPU 采样器；⚠ Profiler 绑 CDP 连接，
  跨 CLI 调用 start→stop 拿不到数据——代码级负载用 `--eval` 同连接跑，页内交互在窗口内驱动）；
  输出 selfTime 降序 Top25，`KOJO_PROFILE_OUT=<路径>` 同时落完整 .cpuprofile（DevTools 火焰图）。
- **功能健全验证**：`commands` 找到目标命令 id → `run <id> --settle <ms>` → `state`/`events` 断言副作用
  （相位 / 面板 / 事件名）。`--settle` 缺省 300ms，慢命令（建索引 / 全量检索）给 1000–3000。
- **等与断言**：`wait "<jsExpr>" [--timeout ms]` 每 200ms 求值一次、truthy 即成功（缺省 30s 超时，超时 exit 1）；
  `assert "<jsExpr>"` 只求值一次、falsy 就 exit 1 并把求值结果打成 JSON。这两个是脚本里的可读断言，
  比 `eval` + 人眼看输出可靠（`[ok] 断言成立：<expr>` / `[FAIL] 断言不成立：<expr> => <JSON>`）。
- **编辑链路**：`open-file`（结束条件是**路径对拍**：`editor.info().path` 归一化后必须包含你给的片段，
  10s 内反复重读；不匹配或读到 `null` 直接 exit 1 并回显实际 path——所以片段别给成会命中多份的短串）
  → `eval "__kojoDebug.editor.type('PRINTL x')"` → `eval "__kojoDebug.editor.markers()"`
  → 保存后 `eval "__kojoDebug.invoke('read_file_bytes_raw',{path:'…'})"` 与盘上内容对拍。
- **语言面真 provider 链路**（悬停 / 补全 / 格式化 / 折叠 / 高亮令牌）：`editor.actions()` 看动作表，
  `editor.hoverAt(line,col)` 走 `editor.action.showHover` 的真 provider 并读 `.monaco-hover`，
  `editor.suggestAt(line,col)` 触发补全并读 `.suggest-widget` 行——**别用 CDP 模拟鼠标**（对 Monaco 悬停
  不生效，PITFALLS 247）；补全光标必须落在引号内合法位置，否则只会给属性名候选。
  完整清单与"读不到返回 null/false 不抛"的口径见 §三 页内 API。
- **UI 层真鼠标（悬停 / 双击 / 拖拽 / 滚轮）**：`hover <选择器|"x,y"> [--settle <ms>]`（`mouseMoved` 停在目标
  中心再等静默窗，默认 120ms——hover provider 是异步的，事件送达那一刻弹窗必然还不在）、`dblclick <选择器|"x,y">`
  （`pressed`/`released` 两轮、`clickCount` 依次 1、2）、`drag <起点> <终点> [--steps <n>]`（按下 → n 帧带
  `buttons:1` 的移动 → 抬起，默认 8 帧）、`wheel <选择器|"x,y"> --dy 120`（先把指针移到目标再滚，滚的是指针
  下的那个滚动容器；`--dx/--dy` 都为 0 直接 exit 2）。
  选择器会过一遍 `document.elementFromPoint` 自证落点：被 toast / 遮罩 / 粘性工具栏盖住时打
  `[debug] ⚠ elementFromPoint 未命中 …` 后**仍按坐标操作**——"点了没反应"先看这行，再 `dom` 查遮罩，
  别先把账记到功能上。⚠ Monaco 编辑器里的**悬停文本**仍走 `editor.hoverAt`（PITFALLS 247：鼠标事件不弹
  `.monaco-hover`）；`hover` 用在 UI 层提示（按钮 tooltip、树条目、hover 才出现的操作条）。
- **语义读数（定义 / 引用 / 代码动作 / 签名 / 符号 / 诊断）**：`definition <行> <列>`、`references`、
  `code-actions`、`signature`（行列 **1 基**，与 Monaco position 同口径）、`symbols`、`diagnostics`（对整篇文档）。
  它们直读 provider 注册表（与真人点菜单同源，**不改光标、不弹面板**）；**空结果是正常读数**（打 `(空)`、
  退出码 0），只有"没有焦点编辑器 / 行列非法 / 页面没有 `.editor` 分面"才 exit 2——所以先 `open-project`
  + `open-file` 再查。`code-actions` 只列"有哪些动作"（`title/kind/isPreferred/hasEdit`），**绝不 apply**，
  要真改走 `run`。读数为空想分清"没挂 provider"与"这里确实没有"，先看 `selfCheck().semantic.providers`
  （§三「自检」）。
- **升级 Monaco / 动编辑器依赖后，先跑 `editor.selfCheck()`**（见 §三「自检」）：这一族读数依赖 Monaco
  **私有 DOM 形态**（`.monaco-hover` / `.suggest-widget` / `.label-name`）与**私有贡献点**
  （`editor.contrib.folding`），升级会**静默失效**——`hoverAt` 永远回 `null`、`foldingRanges` 永远回
  `null`，看起来像"功能没做"，其实是选择器跟不上了。`selfCheck().ok === false` 就是那个信号。
- **外部改动 / 文件监视**：改沙盒内文件 → `events` 里应出现 `file.changed` 级联（调试宿 SSE → `kojo:fs-changed`）。
- **对话框流**：目录选择＝policy 自动应答、两条腿同一口径（web 模式＝`POST /policy {"chooseDir": …}`（`null`＝模拟取消），该请求必须带 `x-kojo-policy-token` 头；真壳＝`__kojoDebug.dialogPolicy.arm(<目录>)` **一次性**、只答"打开＝读"）——`open-project` 两模式都已内置；`export_file`/`choose_file`/写域准入门**不应答**（对话框即授权不许绕）。
- **切换项目**：`close-project` → `open-project <另一个目录>`，**不必重启 `serve`**（vite/CDP/浏览器都还在，
  省一次冷启动；上一次失败留下半截相位（`unknown`）时先 `close-project` 再开，比 `location.reload()` 干净）。
- **批量回归**：`node tools/debug-web-smoke.mjs`（端到端断言；**条数以脚本实际输出为准，别抄文档里的数**——
  它每批都在加。失败自动留屏上文本 + 失败截图）。

## 三、CLI 子命令总表

| 子命令 | 作用 | 备注 |
|---|---|---|
| `serve` | 拉起调试宿+vite+浏览器 | `--headless / --no-browser / --record`（console 落盘）/ `--fresh`（清沙盒）/ `--sandbox/--readonly/--port/--vite-port/--cdp-port/--browser`。**会话按仓库工作树自动隔离**（`<home>/sessions/<树哈希>/`，多 agent 并发互不可见；`KOJO_DEBUG_SESSION_NAME` 显式命名、`KOJO_DEBUG_SESSION` 直指会话文件） |
| `status` / `stop` / `url` | 会话健康 / 收会话 / 打印编辑器 URL | 会话文件 `%TEMP%/kojo-debug/session.json`（`KOJO_DEBUG_SESSION` 可指别处）。**`status` 的 exit 0 判据按形态分**：shell 模式 = `viteOk && cdpOk && alive(shellPid)===true`；web 模式维持原判据（宿 + vite + 浏览器腿）。shell 模式多打一行 `写权限：只读浏览（debug 通道不代答确认框）`（**纯读数，不参与退出码**）。`status` 打印的 URL 里 token 已脱敏，要完整 URL 用 `url` |
| `open-project <dir> [--writable] [--timeout <ms>]` | 真实点击链路开项目 | 自动应答目录对话框（web=宿 policy／shell=调试面 dialogPolicy，见 §二对话框流）；`--writable` 批准写权限（**仅 web 模式**，真壳如实拒——见 §四b 安全裁决），缺省只读浏览；**不是工程根时快速失败**：第 4 步同拍看 错误通知原文 / **新 toast（底片去重）** / 通知关键词 / 欢迎页回流（1.5s），命中即 exit 1 并优先带应用原文，不再等满 60s（判据见 §二「打开失败判据」）；`--timeout` 只改第 4 步预算（默认 60000，夹 [3000,300000]）；已开同项目幂等直过；结尾硬对拍 `rootDir===请求目录` 防假绿。非 `welcome` 相位时错误文案会直接告诉你先跑 `close-project` |
| `close-project` | 关项目回欢迎相位 | 已在 welcome ⇒ 幂等直过（`[ok] 当前已在欢迎相位`）；否则跑 `workbench.closeProject` 并等 `phase === 'welcome'`（20s）。**切项目不用重启整套**：`close-project` → `open-project` |
| `open-file <路径片段>` | 真实点击文件树开文件 | 角色分组→目录逐层展开；等 Monaco 挂载后回编辑器读数，**结束条件是路径对拍**：`editor.info().path` 归一化后包含该片段（最多 10s、期间重读）；不匹配 / 读到 `null` ⇒ exit 1，错误里带实际 path |
| `commands [过滤]` / `run <id> [--settle ms]` | 列出 / 执行命令面板命令 | **所有功能只要登记了命令就有可编程入口**；`--settle` 缺省 300ms，跑完等这么久再读相位，输出带 `（settle <ms>ms，相位：<phase>）` |
| `wait "<jsExpr>" [--timeout ms]` / `assert "<jsExpr>"` | 等条件成立 / 一次断言 | `wait` 每 200ms 求值一次、truthy 即成功（缺省 30s，超时 exit 1）；`assert` 只求值一次、falsy ⇒ exit 1 并把结果打成 JSON。脚本里替代「`eval` + 人眼看」 |
| `state` / `dom` / `events [n]` | 一屏读数 / DOM 结构快照 / 事件旁听 | 全部 JSON，可断言 |
| `eval "<js>"` | 页内求值（可 await） | 万能逃生口 |
| `invoke <cmd> [json]` | 直达宿主命令 | 与产品同一条 invoke 路 |
| `click <sel>` / `type [<sel>] <文本> [--mode text\|keys\|ime]` / `key <键> [ctrl+…]` | CDP 真实输入 | click 带 elementFromPoint 自证；**type 省略选择器＝打到当前焦点元素**（命令面板/搜索框先点开或 `key ctrl+p` 再 type）；`--mode` 缺省 `text`（`insertText` 直插，行为与旧版逐字一致）/ `keys`（逐字符 `keyDown`+`char`+`keyUp`，走真键盘路径，非 BMP 退化 `insertText` 并给 `fallback=N`）/ `ime`（`imeSetComposition` 起组合再 `insertText` 上屏，不支持时如实红）——三种模式各自适用面见 §二「`type` 的三种输入模式」；key 支持 enter/escape/tab/arrow* |
| `screenshot <png> [--full]` | 截图 | 拍前自动 `Page.bringToFront` + 双 rAF 强制产帧，**不吃缓存帧**（切主题/Monaco 重绘后也是新帧）；agent 的「眼睛」 |
| `perf <start\|stop\|quick [ms]>` | UI 卡顿体检（可开关探针） | start/stop 跨命令存活（探针在页内）；报告四路：帧分档 / 长任务×事件 hint / 交互延迟 / 逐源码帧耗时（render 型长帧归 `(render)` 桶） |
| `profile <run [ms]> [--eval "<js>"]` | CPU 采样归因（函数级热点） | selfTime Top25；⚠ 绑 CDP 连接——start/stop 跨调用无效，用 run 一条龙；KOJO_PROFILE_OUT 落 .cpuprofile |
| `doctor [--json] [--repo <路径>]` | 工具链体检（八项） | `node-version / repo-root / session-file / host-port / cdp-port / dist-build / vite-cache / stale-procs` 逐项 PASS/WARN/FAIL；**任一 FAIL ⇒ 退出码 1**，WARN 不改变退出码；`--repo` 缺省＝本 CLI 所在仓库（不是 cwd）；只读（不删缓存、不杀进程），fix 只给可复制的命令；`--json` 与 `node tools/debug-doctor.mjs --json` 同一形态 |
| `hover <选择器\|"x,y"> [--settle <ms>]` | CDP 真鼠标悬停 | `mouseMoved` 停在目标中心再等静默窗（默认 120ms）；hover 是异步给的，静默窗不够就加大；Monaco 悬停文本仍走 `editor.hoverAt`（§二 语言面配方） |
| `dblclick <选择器\|"x,y">` | 真双击 | `pressed`/`released` 跑两轮、`clickCount` 依次 1、2——不是"连发两次 click"（两轮互不相干的单击浏览器不会合成 dblclick） |
| `drag <起点> <终点> [--steps <n>]` | 真拖拽 | 按下 → `n` 帧带 `buttons:1` 的 `mouseMoved`（末帧即终点）→ 抬起，`n` 默认 8；两端都收选择器或 `"x,y"`。中间帧不能省：HTML5 拖拽靠 mousemove 累积位移判落区 |
| `wheel <选择器\|"x,y"> [--dx <n>] [--dy <n>]` | 真滚轮 | 先把指针移到目标再 `mouseWheel`（滚的是指针下的滚动容器）；`--dx/--dy` 都为 0 ⇒ **exit 2**（空滚轮事件＝"滚了没反应"的假绿） |
| `definition <行> <列>` / `references <行> <列>` / `code-actions <行> <列>` / `signature <行> <列>` | 语义读数（行列为 **1 基**） | 走页内 `editor.*At()` 的 provider 链；`code-actions` **只列不 apply**；空结果是有效读数（打 `(空)`、exit 0），只有"没有焦点编辑器 / 行列非法"才 exit 2；`references` 带 `total` 与截断标记 |
| `symbols` / `diagnostics` | 文档符号 / 当前文档诊断 | 不吃行列（对整篇文档）；诊断按 `MarkerSeverity` 打档位名（Hint/Info/Warning/Error），未知值原样打 |

### 指针族：坐标是**一个**参数

- 坐标写成 `"x,y"` 一个位置参数：`drag 10,20 300,200`。拆成两个就把 `drag <起点> <终点>` 的位置参数占满，
  与 `type --mode` 把模式当成待输入文本是同一类翻车。
- 带逗号的选择器（`a[href], b`）不会被当成坐标：判据是"以数字或小数点打头**且**含逗号"。
- 坐标形态但数字写坏（`"10,y"` / `"10,,20"` / `"10,20,30"`）⇒ exit 2 并回显原文——`10,20` 与 `10 20`
  的报错必须能分辨，否则用户无从改。
- 数值参数（`--settle / --steps / --dx / --dy`）非法当场 exit 2，不静默落默认：`wheel --dy abc` 若变 0，
  用户看到的是"滚了没反应"，比报错贵。
- 四个命令都把落点回报出来（`--json` 里是 `point` / `from,to,moves`）；被遮挡时那行
  `[debug] ⚠ elementFromPoint 未命中 …` 在 stderr，人读形态的 `[ok]` 行仍会打出来。

### 语义族：空结果是读数，不是失败

- **行列 1 基**，列是字符列、从 1 开始（与 Monaco position、`editor.tokens()` 同口径）；输出回显
  `at: {line, column}`——位置错一位时读数照样"有内容"，只能靠回显抓。
- 空结果 ⇒ 打 `(空)`、**退出码 0**。只有这几种才 exit 2：`__kojoDebug.editor` 分面不在（页面跑的是旧构建）/
  没有焦点编辑器（先 `open-project` + `open-file`，或 `click` 编辑器）/ 行列不是 >=1 的整数。
- 数据源是 provider 注册表（`ILanguageFeaturesService`），不是编辑器动作：动作是**副作用**
  （`revealDefinition` 会搬光标、跨文件还换标签；quickFix 的清单只活在弹出的菜单里），注册表是那些动作
  背后的同一批 provider，读它不动编辑器状态。
- 读数都裁剪过：`definition` 20 条、`references` 显示 50 条而 `total` 是真实总数（裁剪上限 500，超出标
  "已截断"）、`code-actions` 30 条、`symbols` 200 条（父子已压平成 `depth`）、`diagnostics` 200 条。
- 读数为空时分流看 `selfCheck().semantic.providers`（见下「自检」）：`false`＝这个语言真的没挂 provider
  （空是**正确**读数）；`null`＝没问到（再调一次）；`true` 却读空 ⇒ 换行列，或 provider 对该位置确实没货。

### `--json`：stdout 只有一个 JSON 文档

`status / state / commands / dom / events / wait / assert` 与指针族、语义族、`doctor` 都吃 `--json`：

- `--json` 时 stdout **只有一个 JSON 文档**（无 ANSI、键序＝对象字面量顺序），可直接 `JSON.parse`；
- 失败 ⇒ stderr + 非 0，**stdout 一个字符都不留**（宁可空，也不给半截文档——半截 JSON 的报错位置极具误导性）；
- **不加 `--json` 时人类输出逐字不变**：`[ok] wait 满足（…）`、`（最近 N 条）`、`（12 条）` 这些字面量
  有脚本和人照着读，改一个字都算回归。

页内 API（`?kojo-debug=1` 选入后）：`__kojoDebug.{mode, host, state(), kernel(), commands.{list,run},
bus.{recent,on}, editor.{…}, invoke, dialogPolicy.{arm,armed,clear,status},
dom.snapshot,
perf.{start,stop,isRunning,lastReport,summary}}`。
写动作（setValue/type）显式命名；`type` 走 executeEdits 进撤销栈＝「像真人一样改」；
`perf.*` 见 §二 卡顿体检配方（关着零开销）。

### 页内 `editor.*` 速查（含语言面只读 API）

| 调用 | 语义 |
|---|---|
| `info()` / `setValue()` / `type()` / `setCursor()` / `markers()` | 既有编辑面（读路径 / 整篇替换 / 像真人打字 / 定光标 / 诊断标记） |
| `actions()` | 支持的动作表 `[{id,label,alias?,enabled}]`（`ed.getSupportedActions()`） |
| `hoverAt(line, column, opts?)` | **真 provider 链路**：setPosition → `editor.action.showHover` → 轮询 `.monaco-hover` → 读文本与行 → 收起。回 `{text, rows, line, column}`；超时无内容 ⇒ `null` |
| `suggestAt(line, column, opts?)` | triggerSuggest → 轮询 `.suggest-widget.visible` 的行。回 `{items:[{label,detail,kind}], count}`；读完自动收起 |
| `format()` | `editor.action.formatDocument`，回 `{ok, changed, before, after, elapsedMs}`（before/after = `model.getValueLength()`） |
| `setSelection(startLine, startColumn, endLine, endColumn)` / `revealLine(line, reveal?)` | 回 `boolean` |
| `foldingRanges()` | 尽力而为：拿不到折叠模型 ⇒ `null`（不同 Monaco 版本内部形状会变，不许假装有） |
| `tokens(lineFrom, lineTo)` | `[{line, tokens:[{type, startIndex}]}]`（`monaco.editor.tokenize`） |
| `selfCheck()` | **私有形态 + 语义自检**（只读、绝不抛）：`{monacoVersion, languageId, selectors, foldingShape, ok, semantic}`——升级 Monaco 后**先跑它**，`ok===false` 说明私有 DOM 形态或折叠贡献点已变，此时 `hoverAt`/`suggestAt`/`foldingRanges` 的 `null` **不可信**（见下方「自检」） |
| `definitionAt(line, column, opts?)` | `[{path, line, column}]`（1 基；`path` 相对工程根，拿不到工程根时给归一化后的绝对路径）——provider 注册表直读，不改光标；上限 20 条 |
| `referencesAt(line, column, opts?)` | `{items, total}`：`items` 最多 50 条、`total` 是真实总数（裁剪上限 500）；`opts.includeDeclaration` 缺省 `true`（与菜单「查找引用」同源） |
| `codeActionsAt(line, column, opts?)` | `[{title, kind, isPreferred, hasEdit}]`（零宽区间＝光标停在这一格按 Alt+Enter）；**只读，绝不 apply** |
| `signatureAt(line, column, opts?)` | `{label, parameters, activeParameter, documentation?}` 或 `null`：第一个给得出签名的 provider 即答案，`activeParameter` 0 基（与 provider 同口径） |
| `documentSymbols()` | `[{name, kind, depth}]`：父子关系压平成 `depth`（0＝顶层），不吃行列；上限 200 条 |
| `diagnostics()` | `[{line, column, severity, message, source?}]`：`markers()` 的契约形态，`severity` 是 `MarkerSeverity` 的 1/2/4/8，缺 `source` 不挂键 |

**口径（重要）**：这一族**一律不抛**。没有焦点编辑器 / 文件没开 / UI 部件没起来时，
返回 `null`（对象型）、`false`（布尔型）或 `[]`（数组型）。所以脚本里判「功能坏了」不能只看有没有异常，
要看**返回值形状**：`hoverAt` 回 `null` ＝ 没读到（可能 provider 真没内容，也可能位置不对），
`foldingRanges` 回 `null` ＝ 已知边界，都算「形态合法」而非失败。
**唯一能把「没读到」升级成「这套读数在当前构建上已经不可信」的，是 `selfCheck()` 的 `ok`**
——`ok===true` 时上面那些 `null` 才有诊断意义；`ok===false` 时先修选择器，别改测试。

#### 自检：`editor.selfCheck()`（2026-10-30 批）

```js
node tools/debug-cli.mjs eval "__kojoDebug.editor.selfCheck()"
// 0.57 实测（打开一个 kojo 文件后）：
// {"monacoVersion":"0.57.0","languageId":"kojo","selectors":{"hover":true,"suggest":true,
//  "suggestRow":false,"labelName":false,"detailsLabel":false,"foldingContribution":true},
//  "foldingShape":"promise","ok":true}
// 同一份输出末尾还有一块 `semantic`（形状与口径见下）
```

| 字段 | 取值 | 口径 |
|---|---|---|
| `monacoVersion` | `string \| null` | 先问运行时 `globalThis.monaco.version`（AMD/globalAPI 装配才有）；**0.57 的 `editor.api.js` 不导出 `version`**，所以实际落到「本仓钉版号」兜底（`packages/app/package.json` 的 `dependencies['monaco-editor']`，当前 `0.57.0`）；钉版号不合 semver 形态（改成 `workspace:`/`^0.57`/git 引用）⇒ **如实 null**，不猜 |
| `languageId` | `string \| null` | 当前模型语言；没焦点编辑器 ⇒ null |
| `selectors.hover` | `boolean` | `.monaco-hover` 在 DOM 里见过 **或** `editor.contrib.hover` 贡献点还在 |
| `selectors.suggest` | `boolean` | `.suggest-widget` 见过 **或** `editor.contrib.suggestController` 还在 |
| `selectors.suggestRow` / `labelName` / `detailsLabel` | `boolean` | **纯 DOM 探测、尽力而为**（0 命中即 false）：面板没弹本来就 0 命中，所以**不参与 `ok`**，只用于人工定位「候选行/名字/细节」三个类名还在不在 |
| `selectors.foldingContribution` | `boolean` | `getContribution('editor.contrib.folding')` 非空（真实探测） |
| `foldingShape` | `'regions' \| 'ranges' \| 'promise' \| 'none'` | 折叠模型真实形态：**0.57 是 `promise`**（`getFoldingModel()` 返 Promise ⇒ 同步读数取不到值，这就是 `foldingRanges()` 回 `null` 的原因，**形态合法不是缺陷**）；早期版本是 `ranges`；`regions` 是 `FoldingRegions` 实例形态；探不到 `none` |
| `ok` | `boolean` | **只由三项决定**：`monacoVersion !== null && selectors.hover && selectors.suggest && selectors.foldingContribution`。`semantic` **不进 `ok`**（见下） |

用法纪律：
- **升级 Monaco / 换编辑器依赖之后的第一条命令就是它**。`ok===true` 才继续信任 `hoverAt` / `suggestAt` /
  `foldingRanges` 的 `null`；`ok===false` 时那些 `null` 是「读数不可信」，不是「provider 没内容」。
- `ok===true` 且 `foldingShape==='promise'` 是**当前 0.57 的正常读数**：折叠区间拿不到是因为 API 形态
  （Promise），`foldingRanges()` 回 `null` 属已知边界（见上表「口径」段）。
- **`suggestRow` / `labelName` / `detailsLabel` 在 0.57 上实测为 `false` 是已知漂移**（候选行改用
  `.left` + `IconLabel`，老的 `.label-name` 类不再存在），**只要 `ok===true` 就不用管**——这三项本来就不参与
  `ok`。要按类名抓候选行时以实际 DOM 为准（`dom` 快照看 `.suggest-widget` 的真实子树）。
- `selfCheck()` **永不抛**、也**不改**任何既有 API 行为（内部每步各自吞错，最后统一过纯函数
  `summarizeSelfCheck()` 归一——脏值/半截对象一律归成上表形状）。想单测形状就用 `summarizeSelfCheck`。
- 脚本里断言 `ok` 与 `foldingShape` 两项即可；逐项 `selectors.*` 只用来**人工定位**（哪些类名/贡献点没了）。

##### `semantic`：六条语义读数有没有货

```js
node tools/debug-cli.mjs eval "__kojoDebug.editor.selfCheck().semantic"
// 形状（值随语言与调用次数变；首调 providers 常为全 null，再调一次才是真实读数）：
// {"actions":{"definition":{"present":true,"supported":true},"codeAction":{…},
//   "signatureHelp":{…},"documentSymbol":{…}},
//  "providers":{"definition":true,"references":true,"codeAction":false,
//   "signatureHelp":true,"documentSymbol":true,"diagnostics":null}}
```

它回答的是「`definitionAt` / `referencesAt` / `codeActionsAt` / `signatureAt` / `documentSymbols` /
`diagnostics` 这六条读数，在当前构建、当前语言下**有没有货可读**」——因为那六条读不到时一律回
`null` / `[]`，与"这里确实没有定义"**同形**，光看读数分不开。

| 字段 | 取值 | 口径 |
|---|---|---|
| `semantic.actions.{definition, codeAction, signatureHelp, documentSymbol}` | `{present: boolean, supported: boolean \| null}` | 每族取一枚**代表动作**，分别是 `editor.action.revealDefinition` / `editor.action.refactor` / `editor.action.triggerParameterHints` / `editor.action.quickOutline`。`present`：`getAction(id)` 交回对象——**只证明这枚动作注册着**。`supported`：该动作 `isSupported()` 的实测值；动作缺席 / 没这个方法 / 调用抛错 ⇒ `null`（没问到，不猜） |
| `semantic.providers.{definition, references, codeAction, signatureHelp, documentSymbol}` | `true \| false \| null` | **三态**：`true`＝注册表可查且当前 model 有 ≥1 个 provider；`false`＝可查但为空（对应读数**必然**是 `[]`/`null`）；`null`＝**没问到**（深路径 import 不通 / 没有 model / 服务还没结算） |
| `semantic.providers.diagnostics` | 恒 `null` | 诊断是语言服务**主动往模型推 marker**（读 `monaco.editor.getModelMarkers`），没有 provider 可问：给 `true` 是"诊断会自己来"，给 `false` 是"诊断坏了"，两种都是编造 |

三条口径（这一块最容易误读）：

1. **`present` 与 `supported` 都不等于 provider 存在。** Monaco 的动作是**静态注册**的：一个完全没有
   definition provider 的语言里，`getAction('editor.action.revealDefinition')` 照样交回对象，点下去什么
   也不会发生。`isSupported()` 强一些（走动作自己的 precondition，definition 那枚正是
   `hasDefinitionProvider`），但仍分辨不了"没有 provider"与"上下文键还没算出来"——所以它是
   `boolean | null`，不是结论。
2. **`providers.*` 的 `null` 不是 `false` 的另一种写法。** `false` 是"问到了，答案是没有"；`null` 是
   "这条问题此刻答不了"。`selfCheck()` 是同步 API，而 provider 注册表只能走深路径 import 的 DI 单例，
   **第一次调用常常六项全 `null`**（这次调用顺手把 import 踢起来）——**再调一次**就有真实读数。
3. **`semantic` 不进 `ok`。** `ok` 的语义是"这套私有 DOM 形态与私有贡献点还成立吗"（`hover` /
   `suggest` / `folding`），`semantic` 里全是**近似**：动作注册着不等于 provider 在，provider 在也不等于
   这一次调用有结果。把近似塞进 `ok`，`ok===true` 就会从"升级没漂"偷换成"语言服务齐活"——一个结论
   变两个，读它的人没法再分开排查。

排障用法：语义读数为空 ⇒ 先看 `providers.*`。`false`＝这个语言真的没挂 provider（空是**正确**读数，
别去改测试）；全 `null`＝再调一次 `selfCheck`，仍全 `null` 说明 provider 注册表这条深路径在当前构建上
不通（读数本身仍可用，只是没法自证有没有货）；`true` 却读空 ⇒ 换行列，或 provider 对该位置确实没货。
`diagnostics` 恒 `null` 与"诊断坏了"无关：诊断走 `markers()`，空就是当前文档没有 marker。

## 四、调试宿（debug-server.mjs）速览

- 协议：`POST /invoke` `{cmd,args}`→`{ok,value|error}`（二进制回 `{__b64}` 信封；带 `?binary=1`
  时两个二进制命令直接回 `application/octet-stream` 原始帧/字节，错误仍回 JSON——页面侧按
  content-type 自动回退，旧宿/旧页面可独立升级）；`GET /events` SSE
  （`kojo:fs-changed` / `kojo:fs-watch-error`，事件名与桌面壳 Tauri 事件**字面成对**）；`GET /health|/config`；`POST /policy`。
- 准入：只绑 127.0.0.1（**这只解决"谁能连"，不解决"谁能用"——鉴权与 Origin 白名单见 §四a**）；
  读域＝sandbox ∪ appData ∪ `--readonly` 根 ∪ 常驻工作区根；写域＝sandbox ∪ appData ∪
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

### `/invoke`：命令不存在的两种情形（501 / 404）

页面侧**不看状态码**（`web-host-transport` 只读 `body.ok` / `body.error`，所以真人用的界面行为不变），
但 CLI / curl / 脚本可以只看 `status` 或 `code` 分流——"镜像没做"与"名字拼错"的下一步完全不同，
不该在传输层同形：

| 情形 | HTTP | `code` | 内容 |
|---|---|---|---|
| Rust 有、镜像**刻意**没有 | **501** | `mirror_missing` | `cmd` / `reason`（为什么 web 模式给不出：要原生对话框、要能收尸的进程树、要 launcher 根布局……）/ `next`（换真壳：`node tools/debug-cli.mjs shell`） |
| 两边都没有（拼错） | **404** | `unknown_command` | `cmd` / `suggestions`（最多 3 条近似名，**可能为空数组**）/ `error`（"你是不是想用：…" 或"没有相近的命令名可推荐"） |
| 命中镜像 | 200 | — | 行为与改动前**一字未变**：成功 `{ok:true,value}`、业务失败 `200 + {ok:false,error}` |

- 缺口清单只此一份：`tools/debug-server.mjs` 的 `MIRROR_GAP_COMMANDS`（36 条 `launcher_*` + 旧 base64
  读通道 `read_file_bytes`）。`reason` 写得短（会进页面报错文本），长原因在测试里。
- `suggestions` 按命令名的最小编辑距离挑（距离 ≤2 或前缀互含；最多 3 条、近的排前面），候选集是
  「镜像实有的命令 ∪ 缺口清单」：所以**拼错**的 `launcher_*` 走 404，但 `suggestions` 里常常就给你
  缺口清单里的正名（下一次调用会落到 501，那一支自己会解释清楚）。
- 不用 200 报"没有这条命令"：那会让"命令执行失败"与"根本没有这条命令"在传输层同形（旧行为正是如此）。
- 自查一条命令在不在镜像里：`GET /config` 的 `supportedCommands` 是全量清单；`invoke` 报错时看 `code`
  比读中文文案可靠（文案是给人看的，`code` 是给脚本分流的）。

### 四a、安全模型（2026-10-30 升级批）——为什么"只绑回环"不够

> 只绑回环只管住"谁能连"，管不住"**用户浏览器里任何一个网页**都能借用户的浏览进程连"。
> 旧宿两样都没有：可伪造 Origin 打 `POST /policy` 加根 → `choose_workspace_root` → `write_file_bytes`
> 真落盘，等于一个无鉴权的本机读写后门（PITFALLS 275）。现在三层：

1. **会话 token**（`debug-cli serve` 每次生成两枚 `crypto.randomBytes(24)` 的 hex，互相独立）：
   - 页面侧 token 写进页面 URL：`…?kojo-debug=<宿端口>&kojo-debug-token=<token>`（`session.url` 与启动浏览器的 URL 都用它）。
   - `POST /invoke`、`GET /events`、`GET /config` 要 `Authorization: Bearer <token>` **或** `?token=<token>`
     （EventSource 改不了请求头，所以给它留了 query 这条腿）。缺 / 不匹配 ⇒ **401**，
     `{ok:false,error:"调试宿鉴权失败：缺 token 或 token 不匹配（以会话文件里的 token 为准）"}`。
   - `GET /health` 永远放行（不带任何秘密）；`/config` 只回 `authRequired: boolean`，**不回显 token 值**。
   - 比较走 `crypto.timingSafeEqual`（长度不等直接失败），不写明文日志。
2. **`/policy` 只认 CLI 专属头**：`x-kojo-policy-token: <policyToken>`。**不接受** query token——
   页面拿不到 `policyToken` 也就改不动读写域（这是本批最关键的一条：光给页面鉴权还不够，
   因为"页面"本身就可能是被伪造的那个）。所有 CLI 的 `/policy` 请求统一走一个 helper 带这枚头，别散落裸 fetch。
3. **Origin 白名单（无论有没有 token 都生效）**：带 `Origin` 头且不是
   `http://127.0.0.1[:port]` / `http://localhost[:port]` / `http://[::1][:port]` ⇒ **403**
   `{ok:false,error:"调试宿拒绝跨站来源：<origin>"}`。合法 Origin 回显自身到 `Access-Control-Allow-Origin`
   （无 Origin 的 CLI/curl 保持 `*`），并带 `Vary: Origin`；`Access-Control-Allow-Headers` 含
   `authorization, x-kojo-policy-token`；`OPTIONS` 预检对合法/无 Origin 仍回 204。

**已知边界（如实）**：① 不给 `--token` 时三层里的前两层**全部不生效**——那是**库形态**，
只供单测与 `tools/debug-web-smoke.mjs` 这类"进程内直连 `createDebugServer`"的测试用，**不要**把它
当对外形态用；`serverOnly` 的 CLI 路径（`serve`）永远带 token。② token 走 URL 意味着会进浏览器历史 /
进程命令行——脱敏只做在 `status` 输出上（`kojo-debug-token=***`），`url` 故意回完整值（它就是给浏览器用的）。
③ Origin 白名单是**进程内判断**，不是 HTTPS：能读到会话文件的本机进程本来就在信任面内
（它拿得到 token）。

**include globs 已镜像（2026-10-30 升级批）**：`search_text` 的 `options.globs` 在调试宿与 Rust 侧同口径——
过滤顺序 **扩展名 → include globs → exclude**，三者是**且**关系；globs 只匹配**相对检索根**的 `/` 形态路径、
any-of；**大小写敏感**（`*.erb` 挡不住 `A.ERB`，与 Rust `glob_to_regex` 一致）；不匹配计入
`skipped.filtered`（与扩展名同一笔账，**不进 `excluded`**）。空数组 / 不传 ⇒ 与改动前逐字一致。
编译不过的 glob 逐条 `console.warn` 后忽略（同 Rust）。

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
  （一次性、**只读**；写审批 `--writable` 如实拒——**安全裁决见下节**。裁决与残余口子见
  `packages/app/src/debug/dialog-policy.ts` 头注 + PITFALLS 230 / 277）。
- **真壳可构建性（2026-10-30 实测，BUILD=ok）**：`cargo build --manifest-path packages/app/src-tauri/Cargo.toml`
  （dev profile）**成功**，冷构建 6m35s wall（cargo 自报 6m31s），产物
  `packages/app/src-tauri/target/debug/kojo-editor.exe`（29,690,368 B ≈ 28.3 MiB），
  只有 2 条 `dead_code` warning、**0 error**。**注意口径**：「可构建」≠「已跑通 E2E」——
  本批**没有**起真壳 GUI 会话（会与其它车道抢 `session.json`），真壳 E2E 由主 agent 在所有车道结束后统一跑。
- 与 smoke-tauri-dom 的分工：那是发版判据一次性冒烟；这是可驻留、可逐步驱动（eval/events/screenshot）的会话。

### `--writable` 在真壳为什么被硬拒（**安全裁决，不是缺陷**）

`shell` 模式下 `open-project … --writable` 直接 **exit 2**，文案指向两条可走的路。这不是"功能没做"，
是**铁律 6/7 的必然结果**：

- 真壳的写域准入（`confirm_write_domain` 那枚**原生是/否确认框**）里，"弹框"与"登记写域"是**同一条命令**。
  调试面要能应答它，就等于让脚本**自己给自己签发写权限**——那正是调试通道必须堵死的那扇门。
  所以 `packages/app/src/debug/dialog-policy.ts` 的 `POLICY_DIALOG_COMMANDS` **刻意只收两条只选取器**
  （`choose_directory` 打开＝读、`pick_save_path` 另存为落点：只交回路径、一字节不写、不授予任何许可），
  `confirm_write_domain` 与 `export_file` / `choose_file` / `choose_workspace_root` **一概不在册**。
  经调试面应答打开的项目天然只能只读浏览——**这是如实行为**，不是 bug（裁决原文见该文件头注）。
- 由此推论：`status` 在 shell 模式恒打 `写权限：只读浏览（debug 通道不代答确认框）`；这条是读数，
  不参与退出码。

**要验写链路，走这两条**（CLI 的拒绝文案里也是这两条）：

1. **web 模式 `serve` 验写链路**（推荐）：`node tools/debug-cli.mjs serve` →
   `open-project <可写目录> --writable`。调试宿有自己的写域登记（`register_write_domain` / sandbox），
   走的是真 `write_file_bytes` 落盘链路，能验"保存后盘上字节对不对"。
2. **真壳对「已授权目录」**：先由**真人**在真壳里对目标目录点一次对话框、批准写域（PITFALLS §160/§161
   的授权记录），之后 `shell` 下 `open-project <该目录>` **不带** `--writable` 即可写——授权记录本身生效，
   调试通道不需要、也不该再代答任何确认框。

```bash
# 会被拒（exit 2），别试第二次
node tools/debug-cli.mjs shell
node tools/debug-cli.mjs open-project "D:/Game/myproject" --writable   # [die] exit 2 + 两条可走路

# 正路 ①：web 宿验写链路
node tools/debug-cli.mjs stop
node tools/debug-cli.mjs serve --headless
node tools/debug-cli.mjs open-project "%TEMP%/kojo-debug/sandbox/mini-game" --writable
# 正路 ②：真人已授权该目录后，真壳只读打开也能写（不加 --writable）
node tools/debug-cli.mjs stop
node tools/debug-cli.mjs shell
node tools/debug-cli.mjs open-project "D:/Game/myproject"
```

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
9. **安全面不变式**：只绑回环**且**要鉴权（`serve` 生成会话 token；`/invoke` `/events` `/config` 认 token，
   `/policy` 只认 `x-kojo-policy-token` 头）+ Origin 白名单（只放行回环来源）——三者缺一不可，
   别把"只绑 127.0.0.1"当成"只有本机可信进程能用"（PITFALLS 275 的完整 PoC）；
   **无 token 的库形态只供测试**（进程内直接 `createDebugServer` 的那条路），不许拿它当对外形态；
   读写域 fail-loud 不静默；`market_*` 一族 fail-closed（不复制 Rust 白名单）；
   对话框只做自动应答 policy。给调试宿加「出网 / 任意路径写 / 免 token 监听」能力之前先过组长。
10. **`__kojoDebug` API 只 additive**：加字段可以，改既有字段语义不可以；破坏性变更抬版本位（`kojoDebug.v2`）。
11. **新能力同步补冒烟**：调试面 / 宿新增可断言能力时，`tools/debug-web-smoke.mjs` 补一条断言（那是这套通道的回归网）。
12. **改了调试模式的验收口径**：`tools/tests/debug-server.test.ts` + `packages/app/tests/debug-*.test.ts`
    （surface / dom-snapshot / language-surface 等）全绿，且 `node tools/debug-web-smoke.mjs` **真跑** rc=0（纯文档批豁免）。
    这条跑在 nightly CI（`.github/workflows/debug-smoke.yml`），**不接 PR 必过门**——它是慢闸（真起浏览器），
    失败时先看是不是本机环境差异（没浏览器 / 端口占用），别直接按红改代码。
13. **多 agent 并发隔离（2026-10-25 反哺立规，PITFALLS 192）**：会话目录＝`sessionDir(仓库根)`
    （`<home>/sessions/<树哈希>/`，`debug-lib.mjs` 单源）——session.json / sandbox / appdata /
    browser-profile / console.log 全在房间里；**`stop` 与 `killProcessesMarked` 只许认领本会话目录**
    （全局杀＝把别人的会话一起收掉）；`status` 首行必须带会话标识（键＋repoRoot），agent 核对
    「量的是不是自己的树」。跨树要共享或接管时走显式 env（`KOJO_DEBUG_SESSION_NAME` /
    `KOJO_DEBUG_SESSION`），不做静默兜底。

## 六、故障定位速查

| 症状 | 先查 |
|---|---|
| 宿回 **401**（文案「调试宿鉴权失败：缺 token 或 token 不匹配」） | 请求没带 token：`curl`/脚本要加 `Authorization: Bearer <session.token>`（或 `?token=`）；页面 URL 里的 `kojo-debug-token` 被手抄丢了 ⇒ 直接用 `node tools/debug-cli.mjs url` 取完整 URL 重开 |
| 宿回 **403**（文案「调试宿拒绝跨站来源」） | 请求带了非回环 `Origin`（从别的站点页面发起 / 反向代理 / 被扩展改写头）。这层**没有开关**，是设计如此；本机脚本别伪造 Origin |
| `POST /policy` 回 401 而 `/invoke` 正常 | 少带 `x-kojo-policy-token`（或带了页面 token 当它用）。`/policy` **只认**这枚头、不认 query token；用 session 里的 `policyToken` |
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
| `open-project` 写不进 | 写域闸如实拒——要么 `--writable`（**仅 web 模式**），要么把项目放进沙盒（§二注） |
| `open-project` 报 `[FAIL] 打开被应用拒绝：<原文>`（exit 1） | **快速失败**，不是超时：应用明确不接受这个目录。看原文（多半「不是可识别的游戏目录」）；换目录或先 `dom` 看通知；判据见 §二「打开失败判据」 |
| `open-project` 报「第 4 步 …ms 内既没等到弹窗也没等到文件树」 | 屏卡在别处（overlay / 遮罩 / 相位半截）：`screenshot` + `dom` 看现场；确认是慢盘再放预算 `--timeout <ms>`；相位 `unknown` 先 `close-project` 重开 |
| 真壳 `open-project --writable` 直接 exit 2 | **设计如此**（安全裁决，非缺陷）：`dialogPolicy` 刻意不代答 `confirm_write_domain`。验写链路走 web `serve`，或对真人已授权目录不加 `--writable` 开（§四b 两条路） |
| `hoverAt` / `suggestAt` / `foldingRanges` **永远** `null` | 先跑 `eval "__kojoDebug.editor.selfCheck()"`：`ok===false` ⇒ Monaco 私有 DOM 形态 / `editor.contrib.folding` 贡献点已变（升级导致），**读数不可信**，去对照 `install-debug.ts` 的选择器；`ok===true` 且 `foldingShape==='promise'` ⇒ 0.57 正常边界（§三「自检」） |
| 工具链整体可疑（起不来 / `status` 与屏上不符 / 端口像是被占） | 先 `node tools/debug-cli.mjs doctor`：八项逐条 PASS/WARN/FAIL + 可复制的 fix。`host-port`/`cdp-port` **FAIL** ⇒ 会话里记着的端口探不通（残会话 / 进程已退，后续每条子命令都会撞 ECONNREFUSED），按 fix 跑 `stop` 再起；`vite-cache` WARN ⇒ `pnpm-lock.yaml` 比缓存新，删 `node_modules/.vite/deps` 再 `serve`；`dist-build` WARN ⇒ 缺 `dist`，只影响真壳 / 静态产物通道（`serve` 走 vite dev 不读它）；`stale-procs` WARN ⇒ 会话里记着已退出的 pid，`stop` 一遍再起 |
| 点击 / 悬停 / 双击 / 拖拽 / 滚轮「没反应」 | 先看有没有 `[debug] ⚠ elementFromPoint 未命中 …`（被 toast / 遮罩 / 粘性工具栏盖住）：有 ⇒ `dom` 查遮罩（`open-project` 已自动关首启遮罩）；没有 ⇒ `state().phase` + `dom` 看是不是压根没点在目标上。`wheel` 还要给滚动量（`--dx/--dy` 全 0 直接 exit 2）；`dblclick` 必须是 clickCount 1→2 那一版，连发两次 click 合成不出 dblclick |
| 语义族一直打 `(空)` | 先确认有焦点编辑器（没开文件时这几条是 exit 2，不是空读数）；再 `eval "__kojoDebug.editor.selfCheck().semantic"`：`providers.* === false` ⇒ 这个语言真没挂 provider，空是**正确**读数；全 `null` ⇒ **再调一次**（首调 DI 未结算）；`true` 却读空 ⇒ 换行列（1 基，别用 0） |
| `invoke <cmd>` 回 **501** `code=mirror_missing` | 这条命令只在真壳里有（缺口清单见 `MIRROR_GAP_COMMANDS`）：换 `node tools/debug-cli.mjs shell` 验；web 模式下它不是"坏了"，是**不存在** |
| `invoke <cmd>` 回 **404** `code=unknown_command` | Rust 与镜像都没有这个名字，多半拼错：看 `suggestions`；全量清单在 `GET /config` 的 `supportedCommands` |
| `type --mode keys` 打出重复字符 / 缺字符 | `keys` 走 `keyDown`+`char`+`keyUp` 三段；输出里的 `fallback=N` 表示这 N 个非 BMP 字符退成了 `insertText`。要逐字对拍长度时用 `[...text].length`（码位）口径，别和 `text.length` 混比 |
