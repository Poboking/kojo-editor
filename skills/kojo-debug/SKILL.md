---
name: kojo-debug
description: >-
  kojo-editor（eraTW 口上编辑器，D:\DSH\kojo-editor-用户反馈组 等工作树）的调试模式：
  不依赖桌面壳，把编辑器拉到浏览器里，用命令行完整驱动（开项目 / 开文件 / 跑命令面板 /
  事件旁听 / DOM 快照 / 截图看 UI）。当用户要你测试、验证、截图、审查 kojo-editor 的
  界面或功能，或你自己在改这个仓库后想做端到端验证时，使用本技能。
---

# kojo-editor 调试模式（Web 调试宿 + CLI 驱动）

> **本文件的真源在仓库：`skills/kojo-debug/SKILL.md`（随 git 走）**；各 agent 专属 skill 目录
> （如 `~/.agents/skills/kojo-debug/`）是同步副本——真源改了要同步过来（`docs/DEBUG-MODE.md` 头部有提醒）。

**完整手册与开发规范在仓库内：`docs/DEBUG-MODE.md`（唯一真源）**——本技能是它的常用子集。
遇到本技能没覆盖的情况，读手册再动手。

## 何时用

- 没有/不能起桌面壳，但要验证编辑器的**体感、UI 观感、功能链路**（多 agent 并行开发的常态）。
- 需要**截图**来亲眼审查 UI（screenshot 出的 PNG 可直接读）。
- 需要以**可编程方式**触发编辑器功能（命令面板注册表＝所有功能的入口）。

不适用：纯逻辑判据直接写 vitest；真 Tauri IPC / 发版判据走 `tools/smoke-tauri-*.mjs`。

## 标准工作流（在 kojo-editor 仓库根执行）

```bash
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），前台驻留，打印编辑器 URL
node tools/debug-cli.mjs serve --headless          # 真人看屏去掉 --headless；只读挂真实语料加 --readonly "<语料目录>"
#    ↑ 这条会占住终端；另开终端跑下面的子命令。要测保存链路：把样例复制进它打印的 sandbox 再 open-project 那份
# 1b) 改的是**壳专属**东西（启动相位 / 无边框 / 窗口几何 / 真 Tauri IPC）？Web 宿复现不了——改用真壳：
#     node tools/debug-cli.mjs shell   # 真桌面壳带 CDP；子命令照用；验启动相位本身加 --no-debug-api
# 2) （可选）用自己的浏览器打开它打印的 URL——人与 agent 看同一屏
# 3) 驱动
node tools/debug-cli.mjs open-project <目录> [--writable]   # 真实点击链路开项目（对话框自动应答+写权限审批）
node tools/debug-cli.mjs open-file <路径片段>               # 点文件树开文件（自动逐层展开），等 Monaco 挂载
node tools/debug-cli.mjs commands                          # 列出命令面板全部命令（= 所有功能的可编程入口）
node tools/debug-cli.mjs run <命令id>                      # 跑一条命令，与真人按 Ctrl+Shift+P 同一条路
# 4) 取读数 / 断言 / 截图
node tools/debug-cli.mjs state            # 一屏读数（相位/项目/标签/面板/通知，JSON）
node tools/debug-cli.mjs dom              # DOM 结构快照（只认结构锚，不含文案判据）
node tools/debug-cli.mjs events 30        # 内核事件旁听（最近 30 条）
node tools/debug-cli.mjs screenshot out.png [--full]
node tools/debug-cli.mjs eval "__kojoDebug.editor.markers()"   # 万能逃生口：页内求值，可 await
# 5) 收工（必做：会按命令行认领杀掉逃逸的 Edge 子进程）
node tools/debug-cli.mjs stop
```

## 页内 API（`?kojo-debug=1` 选入后才有）

`__kojoDebug`：`state()` · `commands.{list,run}` · `bus.{recent,on}` ·
`editor.{info,setValue,type,setCursor,markers}`（type 走 executeEdits＝像真人打字）·
`invoke(cmd,args)` 直达宿主命令 · `dom.snapshot()` · `kernel()`。

## 一键回归

```bash
node tools/debug-web-smoke.mjs   # 9 断言端到端：欢迎页→开项目→开文件→命令表→事件→截图；失败自动留取证
```

## 硬边界（别撞）

- **多 agent 并发**：会话按仓库工作树自动隔离（`<tmp>/kojo-debug/sessions/<树哈希>/`）——`serve/status/stop`
  只看得见自己这棵树的会话；动手前先 `status` 核首行「会话＝<键>（<你的树路径>）」，别量了别人的树
  （要接管别的会话用 `KOJO_DEBUG_SESSION=<session.json>`，同树第二会话用 `KOJO_DEBUG_SESSION_NAME`）。
- `market_*` 联网命令在调试模式显式失败（安全闸在桌面壳 Rust 侧）；shift_jis **写盘**编码不支持（读取不受影响）。
- 没有本机 Chrome/Edge ⇒ rc=2（设 `KOJO_DEBUG_BROWSER` 指路径）。
- 仓库内目录 open-project 默认只读；要可写先复制进沙盒（serve 打印的 sandbox 路径）。
- 运行时落点默认在系统临时目录的会话房间里，**永远别把调试残留写进仓库**（会弄红别的工具，见仓库 PITFALLS 190-193）。
- 扩展调试模式本身（加命令 / 加 API）之前，**必读 `docs/DEBUG-MODE.md` §五开发规范**——
  里面有开机图、帧格式、安全面、落点、多 agent 隔离等十三条纪律与对应守门测试。
