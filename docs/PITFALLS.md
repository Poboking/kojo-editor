# PITFALLS.md — 环境坑与探针纪律（写盘 / 探针 / 多 agent 前后扫一眼）

> 来源：原 HANDOFF §七/§八/§九（已冻结进 `docs/archive/HANDOFF.md`，细节可去那查原文）。
> **新坑追加 = 一行**，写进对应小节；**不再往 archive 写任何东西**。

## 一、安全模型（写文件功能必读）

- 写入仅允许 `writablePaths`（用户批准 + 持久化于 kernel 存储域 `_global`），越权抛 `WriteNotAllowedError`；
- **双闸并存**：kernel io 白名单（第一道）+ Rust 宿主写允许域（第二道：项目根整体 + appDataDir，`project.opened` 注册 / `project.closed` 清除），语义**以更严者为准**；
- 写回**保编码保换行**（首读探测缓存：utf-8-bom / utf-8 / shift_jis / utf-16；eol 多数派）；原子写（临时文件 + rename）+ 自动备份 `{appData}/backup/{hash}/`（保留 20 版）；
- UI「只读浏览」永远可用（未批准 = 不可写，不阻塞浏览）；
- **常驻可写根**：作者工作区根经 `io.setAppWritableRoots` 登记，不受 `setWritableRoots([])` 收回影响——工作区恒可写独立于游戏目录授权周期；
- **导出是唯一法定绕闸通道**（`exportFile`，§5.97 起独任）：落点**刻意**不过写允许域（导出的意义就是落到域外），授权来自系统对话框的显式选择；对话框 + 写盘绑在同一 Rust 命令内，JS 只传文件名与字节 ⇒ 无越权面。取消返回 `null`（正常路径不算失败）。四条断言钉在 `kernel/tests/io.test.ts`；
- **部署三道前置判定全在动盘之前**：源必须是目录 / 目标不得已存在（报错不覆盖）/ 目标必须在写白名单内（未授权**连目录都不建**）。字节级复制，刻意不转码；
- **ERB 只读口径**（写权限 × 糖视图）：见 `adr/0005`——目录分野定默认可写性（**工作区 ERB 恒可编辑**），显式解锁只管「游戏目录里这一份、这一次」；
- ⛔ **新增"写到域外"的能力必须照 `exportFile` 形态**（对话框即授权、对话框与写盘同命令），**不得开放任意目标路径参数**。

## 二、环境坑速查（本机，2026-10 实测）

| 坑 | 对策 |
|---|---|
| 沙箱注入 `HTTP(S)_PROXY=127.0.0.1:8587` 是**坏的** | git/curl 别用它；用 repo 本地代理（见 `STATE.md` §三） |
| **`(git fetch \| tail) \|\| 兜底` 是假兜底**：管道只交回 `tail` 的退出码 0 | fetch/push 单独成句，看 `rc=$?` 或 `${PIPESTATUS[0]}`；在过期 `origin/master` 视图上开工 = 撞号/覆盖的总根源 |
| **`npx vitest` 吞环境变量** ⇒ `KOJO_SMOKE_PROJECT` 整组静默 skip、看起来像"通过" | 带变量一律 `node node_modules/vitest/vitest.mjs run <file>` |
| **`cat >> 文件` 会把内容插到文件开头**（本机 shell；已两次酿成大文件首部被覆盖） | 追加用 Edit/Write 或 `node -e fs.appendFileSync`；改大文件前先 `cp`，复原前与 HEAD 逐字节核对 |
| Git-Bash `TMP=/tmp` 让 MSVC `link.exe` 报 `LNK1104` ⇒ cargo 直接跑必挂 | cargo 经 node 起（node 继承真 Windows TMP）：`node -e "execSync('cargo test --lib',{cwd:'…/src-tauri'})"` |
| `window.__TAURI_INTERNALS__.invoke` 是 non-writable ⇒ monkey-patch 数不上 IPC | 数次数用 app 自己日志；测成本用受控实验；**任何计数探针必须带自检** |
| 探针 fatal 路径不收子进程 ⇒ 1420 被占死；`taskkill /PID` 经 MSYS 会被改写成 `<Git 安装目录>/PID` | spawn 后立刻 `process.on('exit')` 里 taskkill（node 参数数组、不经 shell）；事后 `netstat` 确认端口空 |
| **同一工作树只能一个桌面实例**：另一发 `tauri dev` 占着二进制（os error 5）与 WebView2 数据目录 | 复测前 `tasklist` 看 `kojo-editor.exe` 是谁的会话——**先问用户、经授权才杀** |
| 临时探针进程退出截断 fire-and-forget 落盘（12MB 只留 `.tmp` 孤儿）⇒ 量出"缓存没收益"的假结论（`tauri dev` 探针同款，§5.130 差点再犯） | 原子写以 rename 收尾 ⇒ 轮询「目标文件 mtime 比进本轮时新」才算完成（全命中那轮断言 mtime 未变）；收进程前**等完成日志**（`Condition snapshot saved`）再杀 |
| `ConditionIndex.durationMs` 不含快照读盘 ⇒ 量到的是"汇合耗时" | 量级联某段 = 从 `project.open()` 起算的**水位差** |
| bash coreutils 时常 127；`node -e` 多层引号/反引号必翻车（反引号会被 shell 当命令替换吃掉、不报错） | 一律落成临时 `.mjs`/`.cjs` 文件再 `node` 跑；**改 docs 尤其** |
| Edit 偶发"声称成功未落盘"；同文件并行 Edit 必 EBUSY | 关键修改后读回验证；**同一文件多次 Edit 必须串行** |
| vitest 把 `console.log` 首行并进用例头行 ⇒ grep 水位行漏读 | 探针输出重定向到文件再 grep，或关键数字放非首行 |
| 模板字符串里写 Markdown 反引号会截断 TS 模板串 | 用「」代替 |
| cargo 输出带 ANSI 色码 | 正则匹配前先 stripAnsi |
| 同工作区并行线 WIP 让集成冒烟断言误红（如 ruleCount 5→6） | 先 `audit` 粗判；只提交自己边界内文件；别用 `git stash` 动共享树 |
| **rebase 判为"自动合并"的文件可能内嵌冲突标记**；`git add -A` 会把它提交进历史 | 逐文件 add + `git diff --cached` 过目；提交后扫 `^(<<<<<<<\|=======\|>>>>>>>)( \|$)`（带后缀才算真标记） |
| 中文输入法合成期按键穿透全局快捷键（合成期 Esc 会误关设置页/全禅） | 判据单源 `shell-keys.isComposingEvent`（三条叠用 + 捕获阶段）；**失焦必须清会话标志**；模态栈挂同一门后 |
| 真实壳 DOM 探针两类假失败：按钮 `title` 带快捷键后缀（「 (Ctrl+J)」）；固定 sleep 等不到首屏 | 先怀疑仪器再怀疑被测物；轮询目标元素；**派事件前自检仪器**（合成事件带没带上 `isComposing`） |
| 量"改前"时动别人工作副本 = 抢端口 + 可能撞未提交树 | `git worktree add <临时目录> HEAD --detach` 起游离树；`CARGO_TARGET_DIR` 指已有 target 免冷编译 |
| CDP 探针四类假失败：场景串反引号截断 / 旧 `kojo-editor.exe` 还占 9222 应答旧构建 / Monaco 视口虚拟化（渲染行数 ≠ 缓冲长度）/ 活动栏图标是**切换式**（再点已激活的会把视图藏掉） | 开跑前端口预检清场；量行文本集合大小；**先测目标元素在不在再点** |
| `tauri dev` 首轮冷启 vite `Re-optimizing` 会 HMR 回欢迎页 | 已知抖动，二次稳定；`smoke-tauri-ipc.mjs` 已加预检 + 180s 等待 |
| `packages/app/tsconfig.json` 的 types 只有 `vite/client` | 测试里显式 `import 'node:fs'` 可用；报 TS2307 时改测试写法，**别**往 app 配置塞 node 全局 |
| vite build `prepare-out-dir` 偶发 EPERM（文件瞬时占用） | 手动 `rmSync(dist)` 后重试，不是代码问题 |
| 语料 `sav\`（与 `C:\game\eratw-save\sav\` 六档逐字节同容）**全带只读属性** ⇒ 注入写盘必失败（原子写 rename 收尾，覆盖只读目标 = EPERM；Rust 未做去 R） | 注入测试先造可写副本：`cmd copy save03.sav save90.sav`（cmd copy **不**继承 R；node `fs.copyFileSync` **会**继承 ⇒ 补 `attrib -R` 兜底），只对副本注入 |

## 三、会话坑（一行制；1–50 = 原 §九去重名单，51 起为重构后新增，细节在 `docs/archive/HANDOFF.md` §九）

1. 规则先核验引擎源码再定语义——FORM 三连符号初版 239 条误报，收窄为排除 `+++` + 每文件每符号聚合后 8 条真实事故。
2. 插件订阅/清理必经 `ctx.onDispose`，否则停用后残留 handler。
3. 新增插件包**四处登记**：自身 `package.json`、root `tsconfig.json` paths、`vitest.config.ts` aliases、`app/vite.config.ts` aliases + `app/package.json` deps（漏一处 resolve 失败）。
4. 真实语料是解析器验收标准：**先 dump 真实失败样本再定语法扩展**（`[[词]]` 与括号索引段两缺口补齐后未解析率 0.04%）。
5. 具名索引反查：数字索引查名、具名索引自描述——两个方向别混（`TALENT:恋慕` 的 description 应取名称本身）。
6. `CASE` 文本不能整体 parse：SELECTCASE 语法必须在抽取层展开为 `subject == 值` 再逐条 parse。
7. 双 lib 类型环境（node vs DOM）对 Web API 严格度不同：`new Blob([bytes])` 要复制到独立 ArrayBuffer；**tsc 必须 root + app 双跑**。
8. 批次史勘误（留档）：第三批 = 条件抽取、第四批 = sav-parser。
9. TS7 对"联合字面量属性"判别式 narrow 不可靠 ⇒ 用显式类型守卫。
10. 变量寻址语义必须回引擎源码逐行核验（`CFLAG:2` ≡ `CFLAG[TARGET,2]`、裸 `CFLAG` ≡ `CFLAG[TARGET,0]`，出自 `VariableParser.ReduceVariable`）——不是直觉推断。
11. JS 与 C# 两处硬差异：整数除法**截断**（`Math.trunc`，非 floor）；位运算 32 位 ⇒ `1<<40` 必须 BigInt 中转。
12. vitest 4 没有 `--reporter=basic`（传了 Startup Error），用默认 reporter。
13. **先测量再定语义**（多次应验）：批五断言"未知主因 = ARG"被实测推翻——LOCAL 系 60% 才是大头；方法 = 临时 dump 真实构成再排优先级。
14. 块注释里写 `TRY*/PRINTDATA*` 会提前终止注释（TS1127）——措辞改"TRY 系"。
15. 引擎参数槽语义回源码：签名第 i 个**声明槽**按序赋值、声明槽被调用必有值、未声明却引用报警告、`CALL FOO` 无括号取全部默认——别凭直觉。
16. 模块循环依赖规避：`builtins` 接收 `evalExpr` 参数（依赖单向 evaluate → builtins）。
17. 解释器"到达方式"双语义（假跳转 vs 自然掉落）是隐坑——编译期改写（假跳转绕过 ELSE op）+ 运行期 `pendingEval` 标记两层修。
18. `preanalyze` 预热第一步必须 `ensureAnalyzed(自身名)`，否则自身不在缓存、resolveCall 全 miss。
19. `resolveCall` 同步契约 vs 文件读取异步：两阶段（先 await preanalyze，热路径同步查缓存必命中；miss = 竞态 log warn 回落 unknown）。
20. Bash 工具 cwd 不可靠（`cd X && cmd` 前缀偶发被吞）⇒ 一律 `pnpm -C <绝对路径>` / node 绝对路径脚本。
21. 文档追加编辑的"标题吞噬"（连续三次误删标题）⇒ 追加小节用 node 行号 splice；每次编辑后 `grep -n "^## \|^### "` 读回验证层级。
22. 回放链路行号坐标系三处来源：`statements` / `predicates` / `assignments` / `returns` **四个数组的 line 都要同源平移**，只改一处不算改。
23. "读不到就默认 0"让夹具写错变成"看起来对但走向错"（TFLAG 是全局变量，放错层级静默读 0）⇒ 夹具放对层级 + 用"不同状态 → 不同走向"对照断言。
24. 折叠类逻辑的"任一/所有"是隐蔽分水岭：可达性折叠须"**每一条**覆盖链都通过"，写成"任一条命中即可达"会恒真。
25. 自己生成的骨架守卫会污染语义判定（`IF LOCAL` 让每块都变 unknown）⇒ 旁路判据必须**纯源映射**（链头产物行 `sourceLine === null`），别带引擎知识。
26. 读 Monaco 行高必须读 `.view-line`（单数）——`.view-lines` 容器上只有 `white-space: nowrap`，读它拿到继承值 → NaN 静默退回兜底（改了等于没改且不报错）。
27. `pnpm tauri dev` 撞占用 1420 的旧 vite 会**连坐杀掉正在跑的桌面实例**；跨过一次 merge 的旧 `.vite` 缓存必白屏（别把绕过 beforeDevCommand 当捷径）⇒ 先确认 1420 空闲 → 必要时 `rm -rf node_modules/.vite` → 再起。
28. "对基线"要认各批自记的数，别拿汇总行当准（汇总行滞后一批，会得出"+90 对不上"的假警报）。
29. "把成本从 A 挪到 B"别读成"在 A 发现了浪费"（kx-placeholder 387→58ms 但 completeness 36→364ms 是同一笔账换了付款人）⇒ 量净变化，别量单条规则。
30. 按截图坐标点对话框右下角按钮不可靠（命中落在遮罩）⇒ 验流程用 CDP 拿 DOM；实在要点，先做"点禁用按钮应不关窗"的命中测试。
31. 别在还挂着 `tauri dev` 的工作树里跑"改源码看谁红"的反证——HMR 会把你临时改的作品 HMR 进被驱动的窗口；反证与实机不同时进行。
32. CDP 驱动 Monaco 打字：走 Chromium **EditContext** 通道（真点 `.view-lines` → `rawKeyDown` + `char`(带 text) + `keyUp`），**别动焦点**、别用 `Input.insertText`（对 readonly textarea 空转）——否则"一个字都不进"会看起来像只读锁泄漏。
33. 收尾杀进程按 **PID 树**；`msedgewebview2.exe` 是全机共用渲染进程，按名强杀会误伤别人开着的窗口。
34. CDP 合成 `Escape` 关不掉 picker：picker 监听的是**它输入框里冒泡上来的事件**（Esc 链第一句把键盘语义让给它）⇒ 对 `.picker input` 派冒泡 keydown，别从 window 派。
35. 写作模式（zen）跨次保留会把侧栏选择器全部打空（看起来像"文件树坏了"）⇒ 量测开头先测 `.shell.zen`，或走 Ctrl+P 拿文件。
36. 活动栏图标是切换式：目标视图**已可见**时再点它的图标 = 把它藏掉 ⇒ **先测目标元素在不在，再决定点不点**。
37. 中文输入法合成期 = 全局快捷键（实机缺陷）：判据单源 `shell-keys.isComposingEvent`，监听走捕获阶段，**必须配失焦清除**（否则"合成期不消费"退化成"永久不消费"，比原缺陷更坏）。
38. 上游已搬走的逻辑不要再抽成第二个文件（同一张动作表两个真源比没测更坏）⇒ 抽纯前先 `git log -- <path>` 看上游搬到哪。
39. 扫"冲突残留"的正则**本身是判据**：`^(<<<<<<<|=======|>>>>>>>)$` 只命中孤立的 `=======`，真实标记带后缀 ⇒ 口径 `^(<<<<<<<|=======|>>>>>>>)( |$)`。
40. 界面文案被刻意做成恒定后，探针判据必须改读**状态属性**（`aria-pressed`）——按旧文案判"要不要点它"条件永远不成立。
41. 探针自己的偏好会毒死下一轮也毒死用户（写掉 `prompted` 标记 ⇒ 须知再也不弹）⇒ 开跑存档、**终态按整套算**、测分层前先清场并把清场写成断言；探针文件用唯一名。
42. **"菜单有这一项" ≠ "这一项有落脚点"**（反馈 6 真凶）：加菜单落点时同时确认"该作用域有渲染槽位"+"建完看得见"（盘上有、面上无 = 用户读来仍是没生效）。
43. Monaco 波浪线不在 `.view-line` 里（独立 overlay 层）：按 **squiggle 矩形与各行矩形 top 差最小**反查归属；`.view-lines` 虚拟化，"行数"只能当可见行读。
44. Monaco 把整行**每个空格**渲染成 U+00A0：对 `.view-line` 文本的任何匹配先过同一个归一函数（`replace(/\u00a0/g," ")`）；`trim()` 会剥掉边缘 nbsp 把坑自己藏住。同族：应用启动会恢复上次会话脏标签 ⇒ 探针文件用唯一名 + 断言"屏上就是盘上那份"。
45. 标签的类是 `.editor-tab` / `.tab-dirty` / `.tab-close`（不是 `.tab`）——选择器写错时"关标签"静默失败，后续每条"重开"量的都是同一个没关掉的实例。涉及"关掉/重开"先断**标签数真的变了**。
46. 口上项目面板：包行是 `.kp-artifact-btn`、`.kp-dir-btn` 只是子目录；两级 caret 都是切换式（`▸` 才点）。**Ctrl+P 快速打开不含工作区文件**（列表来自项目索引）——验"工作区 ERB 恒可编辑"走口上项目面板或文件树。清场按标签 `title`（绝对路径）判别人的在制品，不动它。
47. **判据本身可以错得让产品看起来有缺陷**：给 7.14 加的"收起后文件行必须为 0"与 `FileTree.tsx:513` 的"追加式、平铺列表原地不动"设计相反。⇒ **写判据前先问"这条判据在什么情况下会红"**；先 dump 再决定点不点，断言前**重新查询节点**（旧引用在重渲染后过期）。
48. Monaco 的菜单是 `position: fixed`，别用 `offsetParent` 判"可见"（真行 `offsetParent` 恒为 null，会把真行滤掉只留隐藏占位行，照着它点 = 点空处）⇒ 菜单行选择器收敛 `.context-view .monaco-list-row.action`，可见性用**几何**（`w>150 && h>0`）；`.lightBulbWidget` 需**先 hover 再点**。
49. UI harness（`tools/ui-measure.mjs`）必须每次从同一处起步（开头 `location.reload()` 回欢迎页），否则两次 run 覆盖元素集不同 = 聚合数假绿 ⇒ 任何"前后对比"探针先自证"同一输入跑两次同一输出"。
50. **判据"比同一个元素"就是空判据**（`scrollHeight - clientHeight` 对内容撑开的元素恒 0 = 一路绿灯）⇒ 真对象是**内容高 vs 盒子高（两个不同元素）**；同类：量"盒子高是行高整数倍"也证明不了内容不溢出。
51. 临时探针是**一次性工具放 `%TEMP%` / `.local/`、不入库**；但探针的**断言清单与读数必须随批写进 `docs/log/`**（同族：探针跨进程留的锁/端口/残留偏好——9222 旧进程、1420 占用、localStorage 标记——是下一轮"产品缺陷"假红的来源，开跑前统一清场）。
52. 测试替身与实现必须**形状同构**：`stats()` 替身第一版回同一个对象 ⇒ "前后之差"恒 0 = 空断言还全绿；真池返回的是拷贝（`{ ...offloadStat }`），替身必须同款（§5.130；同族第 50 条）。
53. 共享树的残留 stash 实体（`feedback3-wip-2026-10-13`）：代码主体**已被 §5.88 以另一形态取代，别按旧方案原样复用**；独有可用件＝图标 PNG 生成器 + `app-icon.png`（取法见 `docs/archive/HANDOFF.md` §十二-7 ④）。
54. **pnpm 脚本里的内联 POSIX env 写法（`FOO=1 vitest …`）在 win32 必挂**（cmd 把 `FOO=1` 当命令：`'FOO=1' 不是内部或外部命令`，实测 `test:erbcheck` 原写法 exit 1）⇒ 脚本要么写成 `node 文件`（env 由 JS spawn 注入，见 `tools/verify.mjs` erbcheck 条目），要么调用方 shell 预设；`pnpm verify` 系列已统一走后者。
55. **糖「某个写法今天能不能写」不许靠读码推断，必须跑真转译**：`resolve`（`kojo-sugar/src/index.ts:313-318`）只看**族头** ⇒ `NOWEX:噴乳`、`NOWEX:噴乳乳瞎写`（拼错名）**一律零 error 放行**；反而 `SELECTCOM`（无族头的引擎全局）与 `NOWEX:Ｃ絶頂`（全角拉丁字母被 `isIdentPart` 切断，`expression.ts:43`/`system-functions.ts:90` 两处副本）报 `unknown-identifier` 而**产物仍正确**——只报不纠最坑。E15 方案原稿四条"现状糖"判断全因此写反（校准见 `docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md` §3.0 探针矩阵）。判法＝`createSugarTranspileService({ dictionary: loadEratwVariableSchema(真语料 CSV 目录), faceTable: createEratwFaceTable() })`，装配照 `eratw-adapter/tests/scaffold-cases.test.ts` 的可写性守卫（其 `DictionaryLookup` 是产品 `makeLookup` 的逐字镜像，可直接拿来用）。
56. **win32 上 `path.dirname('profile')` 返回 `'.'` 而不是 `''`** ⇒ 用 `!path.dirname(rel)` 判"根级文件"**恒假**：`tools/engine-loadtest.mjs` 的"根级强制真副本"名单因此形同虚设，镜像里**所有**根级文件都是硬链接，引擎退出时的就地重写直接溅射到真实语料盘（实测已把 `C:\game\<基线语料>\profile` 改写一次、无备份可还原——**语料只读是硬约束，这条是已发生的事故不是理论风险**）。判"根级"只能用 `rel` 里不含 `/`；凡"引擎会就地改写的文件"一律真副本，且**建完镜像必须比 inode 自检**（`mustRealCopy` / `assertRealCopies` 已钉进 `engine-loadtest.mjs`，跑前跑后还要对拍语料根级文件 `ino/nlink/size/mtime`）。同族坑：`profile` 在语料里是**文件**不是目录，任何按目录前缀（`'profile/'`）或具体文件名的猜法都会漏。
57. **`Read` 可能返回陈旧快照、`Edit` 会对个别文件静默不落地（报成功、盘上没变）**：本轮改 `docs/STATE.md` 实测中招（Edit 预览已是新内容，`git status` 却无改动，重试仍不落）。⇒ 凡改**基线数字 / 判据类**文件，改完必须用 Shell 读回取证（`Get-Content` 跳行读或 `git diff <file>`），别只信 Edit 回显。
58. **`io.walkDir(path, { filter })` 的 filter 返回 `false` 会**连目录一起剪掉***：写成 `filter: (e) => !e.isDirectory && /方言扩展名/.test(e.name)` 只拿到根层 3 份（应 153 份）⇒ **静默少收 98%**，不报错、日志也看不出。正确写法 `e => e.isDirectory || 判定(e.name)`（扩展名筛只作用于文件侧），且凡"递归找某类文件"的用法**必须拿独立枚举对拍份数**（FT-1 的 `variable-schema.erh.corpus.test.ts` 用 `readdirSync` 自己数一遍正是为此）。同族：`tools/corpus.mjs` 的语料发现也走"内容条件 + 份数"两条对拍。
59. **上屏文案有第二消费者：CDP 探针的选择器与 fixture 生成器**——`tools/smoke-tauri-ipc.mjs` 用 `.modal[aria-label="语法糖视图"]` 找弹窗、`tools/gen-fixtures.mjs` 里存着 `fixtures/sugar/sample-310.kojo` 头注释的**副本**；只改 src 字符串 ⇒ 探针**静默不匹配**（返回 `no-intro` 继续跑，不报错）＋ 样例与教程两处措辞分叉。⇒ 改名/改文案必须连带扫 `tools/*.[cm]js` 与 `fixtures/**`，并留一条守卫（`packages/app/tests/no-sugar-jargon.test.ts`：状态机先抹注释与正则、再取字符串字面量 + JSX 文本，实测一跑就抓到上述两处）。
60. **真机冒烟红先分"环境红"还是"我改红"**：`smoke-tauri-ipc` 的 b1（打字→解锁弹窗）与 `ui-measure` 的 `04-打开ERB…` 之后，在 **origin/master / 上一提交 / 本批三态上逐字同红**（本机 `store/_global/approved-writable.json` 已含语料目录、开大 ERB 时级联占满主线程），与改动无关。判法＝**同树 A/B**：工作树干净时 `git checkout origin/master -- packages/app tools` 复跑对照 → `git checkout HEAD -- packages/app tools` 收回；跑完把"哪几项红、三态是否同红"写进回执，**绝不为凑绿放宽产品判据**（已立项＝BOARD HK-28）。
61. **`KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)"` 在语料暂离时会全量崩（152 文件 failed / no tests）**：corpus.mjs 报 FAIL（rc=1）⇒ 命令替换产出**空串** ⇒ 仍设置了该变量 ⇒ 语料面 setup 硬失败把**所有**测试文件拖红（2026-10-15 实测）。⇒ 挂语料前先 `node tools/corpus.mjs --print` 看退出码，rc≠0 就跑普通全量（语料面用例自动 skip 是正常水位）；AGENTS §三的命令已加前置警示。
62. **「每角色自定名表」（原 BOARD ZH-F3）是死路——前提实测不成立，别照旧方向再立一次项**：per-character `*用DIM.ERH` **本就在 FT-1 递归扫描面内**（`K42C_結婚`=1100 / `K58C_胖次剥ぎ重複阻止`=350 / `K17C_部位V` 三者 `lookup` 已回 `source:'const'` + `resolvedIndex`——改前先自己跑一遍 `lookup` 再信）。真残余 80 处构成（画蛇添足 4.980，二段具名口径同 ALS-R2）：`CFLAG` **55/69 = 标识符字符集截断**（表内名含全角数字/`～`，`isIdentPart` 把已解析名切短 ⇒ 属字符集线，不是字典缺表）＋ `TCVAR` **8/9 = 可写 `#DIM NAME = n`**（FT-1 明令不收，收了就是猜；余 1 条 `口服避孕药` 是真阳性）＋ `ABL` 2/2 = 作用域词 `TARGET`/`MASTER`（warn 0）。唯一"合格但占空"的源 = `.ERB` **函数体**内 `#DIM CONST`（249 条 / 171 名；**顶层 0 条**），而它只贡献 **1 处**（K49 局部 `无自觉姦`），且把函数局部常量并进全局表本身即"同一类猜测"。跨角色 const 同名不同值 **0 组**（所以"并表安全"是真的、但"没可用数据"也是真的）。⇒ 结论：warn 面 3 → 3 不变、增益 1 处，**不立项、不写码**。
63. **挂语料跑"全量"时，corpus 用例会假红（超时形与"单跑几百毫秒却红"的时序形都实测到）——同命令重跑即绿，别当回退去找代码原因**：2026-10-15 落 `b/lsp/1015-symbol-channel` + `b/search/1015-fulltext` 后实测，合并树 `KOJO_SMOKE_PROJECT=… node node_modules/vitest/vitest.mjs run` 首跑 **1 failed / 2793 passed**（`erh-index.corpus.test.ts` 单跑 20111ms 贴 `testTimeout: 20000`），同命令第二跑 **175 文件全过（rc=0）**；同一批另一轮另红在 `variable-schema.erh.corpus.test.ts > 摘要…`（该文件单跑 7 例全过、摘要项 401ms ⇒ **非超时形**），复跑即绿。⇒ corpus 单文件耗时随冷热在 **2.4s↔103s** 间跳动，判法＝单跑该文件对照 + 同命令重跑一次，别据此判回退。与 §61（语料暂离致全量崩）是两种不同的"挂语料假红"。
64. **改 `docs/STATE.md` 基线数字会与并发的落地批反复撞车——别用"两次提交 + amend"的姿势，直接一次一改动**：2026-10-15 实测，同一时段有 3 条 lane 各自刷新那两行（分别写 2615 / 2606 / 2577），且**三份都比真值低**（它们各自在 rebase 前的旧基线上跑），`git rebase` 每次都在这 2 行上报 conflict。⇒ 落地前先 `git show origin/master:docs/STATE.md` 看别人刷成了什么；**数字要写就一次写成**（别先写一版再补一版，中间那次 sync 会平白多解一次冲突）；`git rebase … | tail` 会把 rc 吞掉（`echo rc=$?` 拿到的是 `tail` 的 0），**必须单独成句看 rc**（AGENTS §四 同款陷阱，本轮实测踩到两次）。
65. **同一文件的多处 `Edit` 并行提交会互相覆盖（非重叠区域也丢）**：2026-10-15 解 `codegen.ts` 三处并集冲突时一次发 3 条 Edit，只见最后 1 条落盘（前两条回显 success，Shell 读回依旧 `<<<<<<<`）。⇒ 同文件多处改动一律**串行**；冲突文件若"报成功但读回仍有标记"，别再重试 Edit，直接整文件重写（`[System.IO.File]::ReadAllText` 取原文 → 正则 `(?ms)^<<<<<<< HEAD\r?\n(.*?)^=======\r?\n(.*?)^>>>>>>> [^\r\n]*\r?\n` 替换为 `$1$2` 取并集 → 按原 BOM 口径写回），**写完立刻 `git add`**（`git rebase --continue` 提交的是索引，不依赖工作树）。
66. **改作者样例文件（`fixtures/sugar/*.kojo`）有三条连带，缺一即红**：①新加的 `;` 注释会**逐字进产物**（golden 跟着变）；②`packages/app/tests/no-sugar-jargon.test.ts` 连"样例文件 + tools 脚本"一起扫术语，**注释里出现「糖」字也算命中**（2026-10-15 实测：写「糖里零硬编码」当场红，改成「转译器里零硬编码」即绿）；③新增关键字必须在该样例里**真用过**（挂语料的 `sugar-releasecheck.transpile.test.ts` 覆盖率断言会报缺词清单，且 `mustContain` 的产物片段得照**实际产物**写——中文变量名落产物是 `CFLAG:TARGET:好感度` 这种形态，别按源文写）。⇒ 改样例后一律先 `RELEASE_GOLDEN_WRITE=1` 重生 golden、再**不带该变量**复跑一次确认逐字节相等，最后带 `KOJO_SMOKE_PROJECT` 跑全量。
