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

## 标准工作流（在 kojo-editor 仓库根执行）

```bash
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），前台驻留，打印编辑器 URL
node tools/debug-cli.mjs serve --headless          # 真人看屏去掉 --headless；只读挂真实语料加 --readonly "<语料目录>"
#    ↑ 这条会占住终端；另开终端跑下面的子命令。要测保存链路：把样例复制进它打印的 sandbox 再 open-project 那份
#    ↑ URL 自带 &kojo-debug-token=<会话 token>（宿要鉴权）；status 里脱敏成 ***，取完整值用 `url` 子命令
# 2) （可选）用自己的浏览器打开它打印的 URL——人与 agent 看同一屏
# 3) 驱动
node tools/debug-cli.mjs open-project <目录> [--writable]   # 真实点击链路开项目（对话框自动应答+写权限审批）
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
node tools/debug-cli.mjs perf quick 5000  # UI 卡顿体检：采样 5s 出报告（帧分档/长任务/交互延迟/逐源码帧耗时）
#    ↑ 想边驱动边量：perf start →（type/run/切主题…）→ perf stop；bySource 按源码文件归因（render 型长帧归 (render) 桶）
node tools/debug-cli.mjs profile run 3000 --eval "<js>"   # 函数级热点：CPU 采样 selfTime Top25（同连接跑负载；KOJO_PROFILE_OUT 落 .cpuprofile 火焰图）
node tools/debug-cli.mjs eval "__kojoDebug.editor.markers()"   # 万能逃生口：页内求值，顶层 await 直接写
# 5) 换项目**别重启整套**：关掉当前项目再开下一个（vite/CDP/浏览器都还在）
node tools/debug-cli.mjs close-project    # = 工具栏「项目操作」→「关闭项目」，等相位回 welcome
node tools/debug-cli.mjs open-project <另一个目录>
# 6) 收工（必做：会按命令行认领杀掉逃逸的 Edge 子进程）
node tools/debug-cli.mjs stop
```

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

- **多 agent 并发**：会话按仓库工作树自动隔离（`<tmp>/kojo-debug/sessions/<树哈希>/`）——`serve/status/stop`
  只看得见自己这棵树的会话；动手前先 `status` 核首行「会话＝<键>（<你的树路径>）」，别量了别人的树
  （要接管别的会话用 `KOJO_DEBUG_SESSION=<session.json>`，同树第二会话用 `KOJO_DEBUG_SESSION_NAME`）。
- `market_*` 联网命令在调试模式显式失败（安全闸在桌面壳 Rust 侧）；shift_jis **写盘**编码不支持（读取不受影响）。
- 没有本机 Chrome/Edge ⇒ rc=2（设 `KOJO_DEBUG_BROWSER` 指路径）。
- 仓库内目录 open-project 默认只读；要可写先复制进沙盒（serve 打印的 sandbox 路径）。
  真壳模式 `open-project` 现在也点真「打开项目」卡（调试面 `dialogPolicy` 应答 IPC 请求腿）并硬对拍
  `rootDir===请求目录`，**不再有"打开最近项目第一行"那条猜路**；`--writable` 在真壳如实拒（只读开）。
- **宿有鉴权**（2026-10-30 升级批）：`serve` 每次生成会话 token，页面 URL 带 `kojo-debug-token=…`，
  `/invoke` `/events` `/config` 都要它；`/policy` 只认 CLI 的 `x-kojo-policy-token` 头；Origin 只放行回环来源
  （非回环 `Origin` 一律 403）。所以**别手搓 URL/裸 fetch 打宿**——用 CLI 子命令，或从会话文件里取 token。
  无 token 的库形态（进程内直接 `createDebugServer`）**只供测试**。
- 运行时落点默认在系统临时目录的会话房间里，**永远别把调试残留写进仓库**（会弄红别的工具，见仓库 PITFALLS 190-193）。
- 扩展调试模式本身（加命令 / 加 API / 加探针路）之前，**必读 `docs/DEBUG-MODE.md` §五开发规范**——
  里面有开机图、帧格式、安全面、落点、多 agent 隔离等十三条纪律与对应守门测试。
