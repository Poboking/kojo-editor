---
name: kojo-debug
description: >-
  kojo-editor（eraTW 口上编辑器，D:\DSH\kojo-editor-用户反馈组 等工作树）的调试模式：
  不依赖桌面壳，把编辑器拉到浏览器里，用命令行完整驱动（开项目 / 开文件 / 跑命令面板 /
  事件旁听 / DOM 快照 / 截图看 UI / 可开关的 UI 卡顿体检）；另有真桌面壳通道（带 CDP）验
  启动相位 / 无边框 / 窗口几何这类壳专属改动。当用户要你测试、验证、截图、审查 kojo-editor 的
  界面或功能、排查卡顿，或你自己在改这个仓库后想做端到端验证时，使用本技能。
---

# kojo-editor 调试模式（Web 调试宿 + 真壳通道 + CLI 驱动）

> **本文件的真源在仓库：`skills/kojo-debug/SKILL.md`（随 git 走）**；各 agent 专属 skill 目录
> （如 `~/.agents/skills/kojo-debug/`）是同步副本——真源改了要同步过来（`docs/DEBUG-MODE.md` 头部有提醒）。

**完整手册与开发规范在仓库内：`docs/DEBUG-MODE.md`（唯一真源）**——本技能是它的常用子集。
遇到本技能没覆盖的情况，读手册再动手。

## 何时用

- 没有/不能起桌面壳，但要验证编辑器的**体感、UI 观感、功能链路**（多 agent 并行开发的常态）。
- 需要**截图**来亲眼审查 UI（screenshot 出的 PNG 可直接读；不吃缓存帧）。
- 需要以**可编程方式**触发编辑器功能（命令面板注册表＝所有功能的入口）。
- 要回答「**这个界面/操作卡不卡、卡在哪个组件**」——可开关的性能探针（帧分档 / 长任务 /
  交互延迟 / 逐源码文件的帧耗时归因）。

不适用：纯逻辑判据直接写 vitest；发版判据走 `tools/smoke-tauri-*.mjs`（真 Tauri IPC 的一次性冒烟；
shell 通道补的是「可驻留、可逐步驱动」的真壳会话，两者分工见手册 §一）。

## 两条通道

| 通道 | 起法 | 用途 |
|---|---|---|
| **Web 调试宿**（默认） | `debug-cli.mjs serve` | 编辑器跑在浏览器（`?kojo-debug=1`），invoke 走本机调试宿；功能/UI/卡顿验证的主通道 |
| **真桌面壳** | `debug-cli.mjs shell` | 编辑器跑在真 Tauri 壳（页面注入 `?kojo-debug=api`，invoke 走**真 IPC**）；**启动相位 / 无边框 / 窗口几何这类壳专属改动只能用这条**。`--no-debug-api` 保持 pristine boot；`--isolate` 多壳并发 |

两条通道共用同一套子命令与会话房间（同树互斥：先 stop 再换通道）。

## 先判断：这件事该跑哪条

| 手上的问题 | 先跑 | 判断依据 |
|---|---|---|
| 整套起不来 / `status` 读数与屏上对不上 / 端口像被占 | `doctor` | 八项逐条 PASS/WARN/FAIL，每项带可复制的 fix。任一 FAIL ⇒ exit 1；WARN 只提示（不是"跑不起来"） |
| 想知道某屏长什么样 | `serve --headless` → `run <视图命令>` → `screenshot` | PNG 可直接读，不吃缓存帧 |
| 页面「点了没反应」 | 先看有没有 `[debug] ⚠ elementFromPoint 未命中 …`，再 `dom` | 那行 = 坐标落在覆盖层（toast / 遮罩 / 粘性工具栏）上，事件被它吃了；不是功能坏了 |
| 怀疑语言服务没挂上 / 语义读数一直是 `(空)` | `eval "__kojoDebug.editor.selfCheck().semantic"` | `providers.* === false` ⇒ 真没挂（空是正确读数）；全 `null` ⇒ 没问到，**再调一次**；`true` 却读空 ⇒ 位置不对 |
| 要读定义 / 引用 / 代码动作 / 签名 / 符号 / 诊断 | `definition <行> <列>` 一族 | 行列 **1 基**；空是读数不是错误；`code-actions` 只列不 apply |
| 要读 Monaco 的悬停文本 / 补全候选 | `editor.hoverAt()` / `editor.suggestAt()` | 别用鼠标事件：`Input.dispatchMouseEvent` 打在 Monaco 上不出 `.monaco-hover`（PITFALLS 247） |
| 双击 / 拖拽不触发 | `dblclick` / `drag --steps <n>` | 双击必须 `clickCount` 1→2；拖拽必须有中间帧（HTML5 靠 mousemove 累积位移） |
| 输入框里的字不对（自动配对、触发字符、输入法） | `type --mode keys` / `--mode ime` | 只有真实键盘 / 组合事件路径认这些行为；`text` 直插验不出 |
| 调宿主命令报 `调试宿没有实现命令` | 看 `code`：`mirror_missing`(501) / `unknown_command`(404) | 前者换真壳（web 模式本来就没有），后者看 `suggestions` 改拼写 |
| 要把读数喂给脚本 | 任何子命令后加 `--json` | stdout 只有一个 JSON 文档；失败时 stdout 空、stderr + 非 0 |

## 标准工作流（在 kojo-editor 仓库根执行）

```bash
# 0) 起不来 / 读数可疑先体检（八项：node / 仓库根 / 会话文件 / 宿口 / CDP 口 / dist / vite 缓存 / 残留进程）
node tools/debug-cli.mjs doctor          # 任一 FAIL ⇒ exit 1；WARN 只提示；每项带可复制的 fix（只读，不删不杀）
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），前台驻留，打印编辑器 URL
node tools/debug-cli.mjs serve --headless          # 真人看屏去掉 --headless；只读挂真实语料加 --readonly "<语料目录>"
#    ↑ 这条会占住终端；另开终端跑下面的子命令。要测保存链路：把样例复制进它打印的 sandbox 再 open-project 那份
#    ↑ URL 自带 &kojo-debug-token=<会话 token>（宿要鉴权）；status 里脱敏成 ***，取完整值用 `url` 子命令
# 2) （可选）用自己的浏览器打开它打印的 URL——人与 agent 看同一屏
# 3) 驱动
node tools/debug-cli.mjs open-project <目录> [--writable] [--timeout <ms>]
#    ↑ 真实点击链路开项目（对话框自动应答+写权限审批）
#    ↑ **不是工程根＝快速失败**（当场 exit 1 并给应用原文），不再等满 60s 才报超时——
#      看到 [FAIL] 打开被应用拒绝 就读原文换目录，别去加超时；--timeout 只改第 4 步预算（默认 60000，夹 [3000,300000]）
node tools/debug-cli.mjs open-file <路径片段>               # 点文件树开文件（自动逐层展开），等 Monaco 挂载
#    ↑ 结束条件是**路径对拍**：editor.info().path 归一化后必须含你给的片段（最多 10s）；不匹配直接红并回显实际 path
#    ↑ 片段别给成会命中多份的短串（比如只写 "KOJO"），失败信息里的"实际 path"就是用来改片段的
node tools/debug-cli.mjs commands                          # 列出命令面板全部命令（= 所有功能的可编程入口）
node tools/debug-cli.mjs run <命令id> [--settle ms]         # 跑一条命令，与真人按 Ctrl+Shift+P 同一条路（缺省 settle 300ms）
# 4) 取读数 / 等 / 断言 / 截图
node tools/debug-cli.mjs state            # 一屏读数（相位/项目/标签/面板/通知，JSON）
node tools/debug-cli.mjs dom              # DOM 结构快照（只认结构锚，不含文案判据）
node tools/debug-cli.mjs events 30        # 内核事件旁听（最近 30 条）
node tools/debug-cli.mjs wait "__kojoDebug.state().phase === 'project'"      # 每 200ms 求值，truthy 即成功（缺省 30s）
node tools/debug-cli.mjs assert "__kojoDebug.state().tabs.length > 0"        # 一次求值，falsy 就 exit 1 并打 JSON
node tools/debug-cli.mjs screenshot out.png [--full]
node tools/debug-cli.mjs type "<选择器>" "文本" --mode text|keys|ime
#    ↑ text（默认）＝insertText 直插（与旧行为逐字一致：搜索框/命令面板过滤/改名都够用）
#    ↑ keys＝逐字符 keyDown+char+keyUp 走真实键盘路径——**自动配对 / 回车缩进 / 触发字符只有这条路认**；
#      非 BMP（emoji）退化为 insertText 并在输出给 fallback=N
#    ↑ ime＝先 imeSetComposition 起组合再 insertText 上屏（验中文输入法）；CDP 不支持时如实红，不静默退化
node tools/debug-cli.mjs perf quick 5000  # UI 卡顿体检：采样 5s 出报告（帧分档/长任务/交互延迟/逐源码帧耗时）
#    ↑ 想边驱动边量：perf start →（type/run/切主题…）→ perf stop；bySource 按源码文件归因（render 型长帧归 (render) 桶）
node tools/debug-cli.mjs profile run 3000 --eval "<js>"   # 函数级热点：CPU 采样 selfTime Top25（同连接跑负载；KOJO_PROFILE_OUT 落 .cpuprofile 火焰图）
node tools/debug-cli.mjs eval "__kojoDebug.editor.markers()"   # 万能逃生口：页内求值，顶层 await 直接写
node tools/debug-cli.mjs definition 12 5        # 语义读数（行列 1 基）：空 ⇒ 打 (空)、exit 0，不是失败
node tools/debug-cli.mjs symbols                # 文档符号；diagnostics 看当前文档的 marker
node tools/debug-cli.mjs eval "__kojoDebug.editor.selfCheck().semantic"   # providers 三态：false=没挂 / null=没问到（再调一次）
node tools/debug-cli.mjs hover ".tree-row"      # UI 层真鼠标（--settle 静默窗）；Monaco 悬停文本仍用 editor.hoverAt
node tools/debug-cli.mjs drag ".splitter" "900,400" --steps 12   # 端点可混用选择器与 "x,y"（坐标是**一个**参数）
# 5) 换项目**别重启整套**：关掉当前项目再开下一个（vite/CDP/浏览器都还在）
node tools/debug-cli.mjs close-project    # = 工具栏「项目操作」→「关闭项目」，等相位回 welcome
node tools/debug-cli.mjs open-project <另一个目录>
# 6) 收工（必做：会按命令行认领杀掉逃逸的 Edge 子进程）
node tools/debug-cli.mjs stop
```

## 子命令全表（`node tools/debug-cli.mjs <子命令>`）

| 子命令 | 作用 | 要点 |
|---|---|---|
| `serve` | 拉调试宿 + vite + 浏览器 | `--headless`（无窗）/ `--no-browser` / `--record`（console 落盘）/ `--fresh`（清沙盒）/ `--sandbox/--readonly/--port/--vite-port/--cdp-port/--browser` |
| `shell` | 拉真壳（tauri dev）带 CDP | `--isolate`（多壳并发换身份）/ `--no-debug-api`（pristine boot，验启动相位本身） |
| `status` / `stop` / `url` | 会话健康 / 收会话 / 完整编辑器 URL | `status` 首行是会话标识（核对是不是自己的树）；打印的 URL 里 token 已脱敏，取完整值用 `url` |
| `open-project <目录> [--writable] [--timeout <ms>]` | 真实点击链路开项目 | 不是工程根 ⇒ **当场 exit 1** 并给应用原文；`--timeout` 只改第 4 步预算（默认 60000，夹 [3000,300000]）；`--writable` 只对 web 模式有效 |
| `close-project` | 关项目回欢迎相位 | 已在欢迎页幂等直过；等 `phase==='welcome'` 20s，有未保存改动会卡住 |
| `open-file <路径片段>` | 点文件树开文件 | 结束条件＝`editor.info().path` 含该片段（10s）；片段别给会命中多份的短串 |
| `commands [过滤]` / `run <id> [--settle ms]` | 列命令 / 跑命令 | 命令面板注册表＝所有功能的入口；`--settle` 缺省 300ms |
| `wait "<js>" [--timeout ms]` / `assert "<js>"` | 等条件 / 一次断言 | `wait` 每 200ms 求值，缺省 30s；`assert` 一次求值，falsy ⇒ exit 1 并把结果打成 JSON |
| `state` / `dom` / `events [n]` | 一屏读数 / DOM 快照 / 事件旁听 | 全 JSON，可直接断言 |
| `eval "<js>"` | 页内求值（可 await） | 万能逃生口；读不到的新能力先用它探形状 |
| `invoke <cmd> [json]` | 直达宿主命令 | 与产品同一条 invoke 路；报错看 `code`（501 缺口 / 404 拼错） |
| `click <选择器>` | 真实点击 | 元素中心 + `elementFromPoint` 自证 |
| `type [<选择器>] <文本> [--mode text\|keys\|ime]` | 键入 | 省略选择器＝打到当前焦点元素；默认 `text` 直插，`keys` 走真键盘，`ime` 走组合→上屏 |
| `key <键> [ctrl+…]` | 真键事件 | enter/escape/tab/backspace/delete/arrow*/f1–f12；带修饰键时不产字符 |
| `hover <选择器\|"x,y"> [--settle <ms>]` | 真鼠标悬停 | 停住 + 静默窗（默认 120ms，hover 是异步的）；坐标是**一个**参数 |
| `dblclick <选择器\|"x,y">` | 真双击 | `pressed`/`released` 两轮，`clickCount` 1→2 |
| `drag <起点> <终点> [--steps <n>]` | 真拖拽 | 按下 → n 帧带 `buttons:1` 的移动（默认 8）→ 抬起 |
| `wheel <选择器\|"x,y"> [--dx <n>] [--dy <n>]` | 真滚轮 | 先把指针移到目标再滚；两个 delta 都为 0 ⇒ exit 2 |
| `screenshot <png> [--full]` | 截图 | 拍前强制产新帧；agent 的眼睛 |
| `perf <start\|stop\|quick [ms]>` | UI 卡顿体检 | start/stop 跨命令存活（探针在页内） |
| `profile <run [ms]> [--eval "<js>"]` | CPU 采样归因 | 绑 CDP 连接，必须一条龙跑；`KOJO_PROFILE_OUT` 落 .cpuprofile |
| `doctor [--json] [--repo <路径>]` | 工具链体检（八项） | 任一 FAIL ⇒ exit 1，WARN 不算失败；`--repo` 缺省＝本 CLI 所在仓库 |
| `definition <行> <列>` | 转到定义 | 1 基；空 ⇒ `(空)` + exit 0 |
| `references <行> <列>` | 查引用 | 带 `total`；显示 50 条，超出标"已截断" |
| `code-actions <行> <列>` | 列可用的代码动作 | **只列不 apply**；`*` 标 preferred |
| `signature <行> <列>` | 参数签名 | 打印签名、参数列表与当前参数下标（0 基） |
| `symbols` | 文档符号 | 父子压平成缩进层级；不吃行列 |
| `diagnostics` | 当前文档诊断 | Hint/Info/Warning/Error 四档；不吃行列 |

退出码统一口径：`0` 成功 / `1` 失败（断言不成立、对拍不符、体检 FAIL）/ `2` 参数或前置不满足
（没会话、没焦点编辑器、行列非法、浏览器找不到、端口被占）。

## 页内 API

- `?kojo-debug=1`（web 宿）／`?kojo-debug=api`（真壳，invoke 走真 IPC）选入后才有 `__kojoDebug`：
  `state()` · `commands.{list,run}` · `bus.{recent,on}` ·
  `editor.{info,setValue,type,setCursor,markers}`（type 走 executeEdits＝像真人打字）·
  `invoke(cmd,args)` 直达宿主命令 · `dom.snapshot()` · `kernel()` ·
  `perf.{start,stop,isRunning,lastReport,summary}`（关着零开销；报告阈值随行回显）。
- **语言面只读 API**（`editor.*`，全部**不抛**）：`actions()` · `hoverAt(line,col)`（走真 hover provider，
  读 `.monaco-hover`）· `suggestAt(line,col)`（读 `.suggest-widget` 行）· `format()` ·
  `setSelection(a,b,c,d)` · `revealLine(n)` · `foldingRanges()` · `tokens(from,to)`。
  读不到时回 `null`/`false`/`[]`——**判"坏没坏"要看返回值形状，不要靠 try/catch**。
  悬停/补全别用 CDP 模拟鼠标（对 Monaco 不生效）；完整语义见手册 §三「页内 `editor.*` 速查」。
- **语义读数**（`editor.*`，全部**不抛**、**只读不 apply**）：`definitionAt(line,col)` → `[{path,line,column}]` ·
  `referencesAt(line,col)` → `{items,total}` · `codeActionsAt(line,col)` → `[{title,kind,isPreferred,hasEdit}]` ·
  `signatureAt(line,col)` → `{label,parameters,activeParameter}` 或 `null` · `documentSymbols()` →
  `[{name,kind,depth}]` · `diagnostics()` → `[{line,column,severity,message}]`。行列 **1 基**；读不到回
  `[]` / `null` / `{items:[],total:0}`——**空是读数不是失败**（CLI 打 `(空)`、退出码 0）。CLI 对应
  `definition` / `references` / `code-actions` / `signature` / `symbols` / `diagnostics`，只有"没有焦点编辑器"
  才 exit 2（先 `open-project` + `open-file`）。
- **升级 Monaco / 动编辑器依赖后，第一件事跑 `editor.selfCheck()`**（只读、永不抛）：
  `eval "__kojoDebug.editor.selfCheck()"` → `{monacoVersion, languageId, selectors, foldingShape, ok, semantic}`。
  `ok===false` ⇒ 私有 DOM 形态（`.monaco-hover` / `.suggest-widget`）或折叠贡献点
  （`editor.contrib.folding`）在当前构建上已变，**此时 hoverAt/suggestAt/foldingRanges 的 `null` 不可信**
  （会静默退化成"永远 null"，看着像功能没做）；`ok===true` 才可以照旧解读那些 `null`。
  0.57 实测：`ok=true` / `foldingShape='promise'`（折叠区间拿不到是 API 形态，属已知边界）/
  `suggestRow`·`labelName`·`detailsLabel` 为 `false`（候选行改用 `.left`+`IconLabel`，**不参与 ok**，别慌）。
- **`selfCheck().semantic` 是"语义读数有没有货"的读数**，三条口径别读反：
  ① `actions.*.present` 只证明那枚动作**注册着**（Monaco 动作静态注册，没 provider 也照样在），`supported`
  是 `isSupported()` 实测——**两者都不等于 provider 存在**；
  ② `providers.*` 三态：`true`＝可查且有 / `false`＝可查但为空（对应读数**必然**空）/ `null`＝**没问到**
  （首调 DI 服务未结算，**再调一次**）；
  ③ `semantic` **不进 `ok`**——`ok` 仍只由 monacoVersion + hover/suggest/folding 三项决定；
  `providers.diagnostics` **恒 `null`**（诊断是语言服务主动推 marker，没有 provider 可问）。
  用法：语义读数是空 ⇒ 先看 `providers`；`false` 就别改测试（那是正确读数），全 `null` 再调一次，
  `true` 却空就换行列。
- 输出全 ASCII（`[ok]/[FAIL]/[warn]/[shot]/[clean]`），任何终端码页下可读。

## 一键回归

```bash
node tools/debug-web-smoke.mjs   # 端到端冒烟：欢迎页→开项目→开文件→二进制直传→命令表→事件→截图→
                                 # 截图不吃缓存帧→性能探针→语言面（actions/tokens/selection/format/folding/globs）
                                 # **断言条数以脚本本次实际输出为准**（每批都在加，别抄文档里的旧数字）
                                 # 失败自动留取证（屏上文本+失败截图）；rc=0 才算全绿
```

CI 上这条跑在 `.github/workflows/debug-smoke.yml`（nightly + 手动触发，windows-latest 自带 Edge），
**不接 PR 必过门**——PR 上只跑纯逻辑单测，冒烟留在夜里跑。

## 硬边界（别撞）

- **内存在 1G 上下会被 OOM 杀掉浏览器**（2026-10-31）：三件套实测地板 1.0~1.2 GB、峰值 2.6 GB
  （fixture=mini-game）。被杀的是渲染进程，看着像浏览器 bug，其实是容器上限——本仓没有任何浏览器内存闸。
  `serve` 已按预算收敛调试宿堆（1G ⇒ 512 MB，64G ⇒ 4096 MB），`KOJO_DEBUG_HOST_HEAP=<MB>` 可覆盖；
  Windows 容器读不到 Job Object 上限，用 `KOJO_MEM_BUDGET_MB=<MB>` 声明；
  预算 < 2048 MB 时冒烟会先打两行告警（只提示不失败）。判容量还是泄漏：反复开文件后堆单调上涨才是泄漏。
- **多 agent 并发**：会话按仓库工作树自动隔离（`<tmp>/kojo-debug/sessions/<树哈希>/`）——`serve/status/stop`
  只看得见自己这棵树的会话；动手前先 `status` 核首行「会话＝<键>（<你的树路径>）」，别量了别人的树
  （要接管别的会话用 `KOJO_DEBUG_SESSION=<session.json>`，同树第二会话用 `KOJO_DEBUG_SESSION_NAME`）。
- `market_*` 联网命令在调试模式显式失败（安全闸在桌面壳 Rust 侧）；shift_jis **写盘**编码不支持（读取不受影响）。
- 没有本机 Chrome/Edge ⇒ rc=2（设 `KOJO_DEBUG_BROWSER` 指路径）。
- 仓库内目录 open-project 默认只读；要可写先复制进沙盒（serve 打印的 sandbox 路径）。
  真壳模式 `open-project` 现在也点真「打开项目」卡（调试面 `dialogPolicy` 应答 IPC 请求腿）并硬对拍
  `rootDir===请求目录`，**不再有"打开最近项目第一行"那条猜路**。
- **真壳 `--writable` 硬拒（exit 2）是安全裁决，不是缺陷**：调试面刻意不代答 `confirm_write_domain`
  （那条命令里"框"与"登记写域"绑在一起，脚本应答它＝脚本自己签发权限，铁律 6/7）。验写链路两条路：
  ① web 模式 `serve` 后 `open-project <目录> --writable`（宿有自己的写域登记，真写盘链路）；
  ② 真壳里对**真人已授权目录**（PITFALLS §160/§161）**不加** `--writable` 直接开（授权记录本身生效）。
- **不是工程根的目录＝快速失败**：`open-project` 当场 exit 1 并回显应用原文
  （`[FAIL] 打开被应用拒绝：<原文>`——原文可能来自通知，也可能是点完后**新弹出的 toast**，
  打开前就有的旧 toast 会被底片去重，不参与判定），不再等满 60s 才报「写权限审批 / 文件树」。
  看到它就读原文换目录，不要靠 `--timeout` 硬顶（那个只改第 4 步预算，默认 60000，夹 [3000,300000]）。
- **宿有鉴权**（2026-10-30 升级批）：`serve` 每次生成会话 token，页面 URL 带 `kojo-debug-token=…`，
  `/invoke` `/events` `/config` 都要它；`/policy` 只认 CLI 的 `x-kojo-policy-token` 头；Origin 只放行回环来源
  （非回环 `Origin` 一律 403）。所以**别手搓 URL/裸 fetch 打宿**——用 CLI 子命令，或从会话文件里取 token。
  无 token 的库形态（进程内直接 `createDebugServer`）**只供测试**。
- **`/invoke` 的 501 与 404 是两件事**：`code=mirror_missing`（501）＝这条命令在 web 模式**不存在**
  （36 条 `launcher_*` + 旧 base64 通道 `read_file_bytes`），换 `shell` 验，别在 web 里继续查；
  `code=unknown_command`（404）＝Rust 与镜像都没有这个名字，多半拼错，看 `suggestions`。
  页面只读 `body.ok` / `body.error`，所以这两档**不改**真人界面的行为，只给 CLI / curl / 脚本分流用。
- 运行时落点默认在系统临时目录的会话房间里，**永远别把调试残留写进仓库**（会弄红别的工具，见仓库 PITFALLS 190-193）。
- 扩展调试模式本身（加命令 / 加 API / 加探针路）之前，**必读 `docs/DEBUG-MODE.md` §五开发规范**——
  里面有开机图、帧格式、安全面、落点、多 agent 隔离等十三条纪律与对应守门测试。
