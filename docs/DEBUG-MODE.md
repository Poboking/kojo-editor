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
# 1) 拉起整套（调试宿 + vite + 无头浏览器 + CDP），打印编辑器 URL
node tools/debug-cli.mjs serve --headless
#    ↳ 有窗模式去掉 --headless（真人看屏）；不带浏览器加 --no-browser；
#      挂真实语料只读盘：--readonly "D:/Game/你的语料"（铁律 5：只读，永不写）
# 2) agent 内置浏览器打开它打印的 URL —— 人与 agent 看同一屏
#    该 URL 自带 `&kojo-debug-token=<会话 token>`；`status` 打印时会脱敏成 `kojo-debug-token=***`，
#    要完整 URL 用 `url` 子命令（它就是给浏览器/agent 用的）
# 3) 开项目（真实点击链路：目录对话框自动应答 → 写权限审批）+ 开文件（树自动逐层展开，等路径对拍）
node tools/debug-cli.mjs open-project <项目目录> [--writable]   # 仓库内目录＝只读打开，见下方 ⚠ 注
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
| `status` / `stop` / `url` | 会话健康 / 收会话 / 打印编辑器 URL | 会话文件 `%TEMP%/kojo-debug/session.json`（`KOJO_DEBUG_SESSION` 可指别处）。**`status` 的 exit 0 判据按形态分**：shell 模式 = `viteOk && cdpOk && alive(shellPid)===true`；web 模式维持原判据（宿 + vite + 浏览器腿）。`status` 打印的 URL 里 token 已脱敏，要完整 URL 用 `url` |
| `open-project <dir> [--writable]` | 真实点击链路开项目 | 自动应答目录对话框（web=宿 policy／shell=调试面 dialogPolicy，见 §二对话框流）；`--writable` 批准写权限（**仅 web 模式**，真壳只读），缺省只读浏览；已开同项目幂等直过；结尾硬对拍 `rootDir===请求目录` 防假绿。非 `welcome` 相位时错误文案会直接告诉你先跑 `close-project` |
| `close-project` | 关项目回欢迎相位 | 已在 welcome ⇒ 幂等直过（`[ok] 当前已在欢迎相位`）；否则跑 `workbench.closeProject` 并等 `phase === 'welcome'`（20s）。**切项目不用重启整套**：`close-project` → `open-project` |
| `open-file <路径片段>` | 真实点击文件树开文件 | 角色分组→目录逐层展开；等 Monaco 挂载后回编辑器读数，**结束条件是路径对拍**：`editor.info().path` 归一化后包含该片段（最多 10s、期间重读）；不匹配 / 读到 `null` ⇒ exit 1，错误里带实际 path |
| `commands [过滤]` / `run <id> [--settle ms]` | 列出 / 执行命令面板命令 | **所有功能只要登记了命令就有可编程入口**；`--settle` 缺省 300ms，跑完等这么久再读相位，输出带 `（settle <ms>ms，相位：<phase>）` |
| `wait "<jsExpr>" [--timeout ms]` / `assert "<jsExpr>"` | 等条件成立 / 一次断言 | `wait` 每 200ms 求值一次、truthy 即成功（缺省 30s，超时 exit 1）；`assert` 只求值一次、falsy ⇒ exit 1 并把结果打成 JSON。脚本里替代「`eval` + 人眼看」 |
| `state` / `dom` / `events [n]` | 一屏读数 / DOM 结构快照 / 事件旁听 | 全部 JSON，可断言 |
| `eval "<js>"` | 页内求值（可 await） | 万能逃生口 |
| `invoke <cmd> [json]` | 直达宿主命令 | 与产品同一条 invoke 路 |
| `click <sel>` / `type [<sel>] <文本>` / `key <键> [ctrl+…]` | CDP 真实输入 | click 带 elementFromPoint 自证；**type 省略选择器＝打到当前焦点元素**（命令面板/搜索框先点开或 `key ctrl+p` 再 type）；key 支持 enter/escape/tab/arrow* |
| `screenshot <png> [--full]` | 截图 | 拍前自动 `Page.bringToFront` + 双 rAF 强制产帧，**不吃缓存帧**（切主题/Monaco 重绘后也是新帧）；agent 的「眼睛」 |
| `perf <start\|stop\|quick [ms]>` | UI 卡顿体检（可开关探针） | start/stop 跨命令存活（探针在页内）；报告四路：帧分档 / 长任务×事件 hint / 交互延迟 / 逐源码帧耗时（render 型长帧归 `(render)` 桶） |
| `profile <run [ms]> [--eval "<js>"]` | CPU 采样归因（函数级热点） | selfTime Top25；⚠ 绑 CDP 连接——start/stop 跨调用无效，用 run 一条龙；KOJO_PROFILE_OUT 落 .cpuprofile |

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

**口径（重要）**：这一族**一律不抛**。没有焦点编辑器 / 文件没开 / UI 部件没起来时，
返回 `null`（对象型）、`false`（布尔型）或 `[]`（数组型）。所以脚本里判「功能坏了」不能只看有没有异常，
要看**返回值形状**：`hoverAt` 回 `null` ＝ 没读到（可能 provider 真没内容，也可能位置不对），
`foldingRanges` 回 `null` ＝ 已知边界，都算「形态合法」而非失败。

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

### 四a、安全模型（2026-10-30 升级批）——为什么"只绑回环"不够

> 只绑回环只管住"谁能连"，管不住"**用户浏览器里任何一个网页**都能借用户的浏览进程连"。
> 旧宿两样都没有：可伪造 Origin 打 `POST /policy` 加根 → `choose_workspace_root` → `write_file_bytes`
> 真落盘，等于一个无鉴权的本机读写后门（PITFALLS 264）。现在三层：

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
9. **安全面不变式**：只绑回环**且**要鉴权（`serve` 生成会话 token；`/invoke` `/events` `/config` 认 token，
   `/policy` 只认 `x-kojo-policy-token` 头）+ Origin 白名单（只放行回环来源）——三者缺一不可，
   别把"只绑 127.0.0.1"当成"只有本机可信进程能用"（PITFALLS 264 的完整 PoC）；
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
| `open-project` 写不进 | 写域闸如实拒——要么 `--writable`，要么把项目放进沙盒（§二注） |
