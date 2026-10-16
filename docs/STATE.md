# STATE.md — 项目现状（数字的唯一真源；有变动顺手改这里）

> 读数字先读本文件，别信记忆和旧文档。历史的逐批读数在 `docs/archive/IMPLEMENTATION-LOG.md`（冻结）。

## 一、基线（2026-10-15 凌晨，E14 拖拽打开 + E15 亲密面方案 + HK-4 UI-4/5/6 + 糖复杂场景审计修复 + 条件矩阵时机细化 · 中日对照 · 多剧本编号上树 · 直连模式开关 + E16 拆解析墙 + HK-17 多版本口上识别 + 语料认内容不认名 + 159 先代占位文件名回退 + SV-1 糖视图原生对齐 + E13/P-1 段块糖与段级吸收 + L1 首屏白屏批 + HK-19 回放伪变量回收 + FT-2 方言口径收口 + FT-1 `.ERH` 作者自定名表 + 亲密面扩糖 P-3/P-4/P-6 + P-7 HPH 连续块 / P-8 MESSAGECHECK 数字返回投影 + HK-20 call-context 推导 + ALS-R3 验收产物落点外搬 + HK-23 未知率口径拆分 + UX 术语清扫（`.kojo 语言` / `.kojo 预览`）与预览默认关 + ALS-R1 字典来源分层 / ALS-R2 SOURCE 入库 + REL-1 自动更新链路 / REL-2 设置页（检查更新·开发者卡·反馈入口）+ 正式 logo + 转公开前脱敏 / GPL-3.0 本机实测 + 糖 1/2/4/5/7 五批（初回 ONCE · 询问/确认 ASK_M/ASK_YN · 单行条件 SIF · 函数前缀 · 文件级常量）+ 常量宏化（跨文件同名撞引擎修复：去 `#DIM CONST` 发射、改编译期展开 + 字典遮蔽守门）+ 段头改形 `若`（P-1R）+ 用户函数形参默认值（`形参 = 整数` → `ARG = 整数`）+ `face-table-missing` 两成因文案互斥可区分 + `函数前缀:` 诊断带真实位置 + 1016 性能攻坚七批（首屏引导层与懒分割 · 批量读 IPC 与会话文本缓存 · Monaco 自装配 · 糖线共享缓存 · 树与面板提速 · 装饰器池化 · 快照 v5 懒还原）+ 1016 编辑器能力六批（E3 全部修复 · C3 领域限定检索 · G1 跳到命中状态 · G3 修法聚合视图 · B6 名字按角色分色 · B8 行上内联注解）

| 项 | 读数 |
|---|---|
| 全量测试 | **4271 passed / 50 skipped（4321）**；256 文件过 / 17 跳（273）（2026-10-16 本机实测于 PERF-8 批树〔= origin/master `4de688b` + 1 提交，落地后即 master `dda9e75`〕；本批新增 9 条〔`kernel/tests/walkdir-bridge-equivalence` 4 + `eratw-adapter/tests/variable-schema.walkdir-ipc` 5——断言「读了哪几份、几趟」而非返回值，见 PITFALLS 73〕）。⚠ 此前并发恒红的三条挂钟闸（`file-tree` 微基准 / `marker-hotpath` ×2 / `workspace-symbols`）已确认为负载形，见 PITFALLS 72 |
| 全量测试（挂语料 `KOJO_SMOKE_PROJECT`） | **3591 passed / 1 skipped / ⚠ 1 failed（3593）**；221 文件过 / 1 挂（222）。失败 = `sugar-projection.corpus.test.ts` 台词行覆盖 **62.5%（`339a0ca`）/ 69.7%（本批后）**，门槛 99% —— **由 `ff1b8ae`（P-1R 手段 3「函数级 all-or-nothing」）引入，非本批**（`12ed541` 同用例 99.2%）；本批另跑 `integration-plugins` 3/3 过（2026-10-16 本机实测，语料在位 `C:\game\eratw-画蛇添足版eratw4.980`） |
| typecheck | root + app **双跑 exit 0**（`pnpm typecheck` + `pnpm --filter @kojo/app typecheck`） |
| 审计 | `pnpm audit:decoupling` ✅（19 插件；A–D 四项全绿） |
| Rust | `cargo test --lib` **74 passed / 0 failed / 5 ignored**（市场批新增 `market_tests` 24 项：ZIP 落盘 / 单文件 sha256 / 写域拒绝与原子替换 / 容器名守门；1016 批量 IO 批 47→54；旧记 24 项系滞后；改了 Rust 才跑；必须经 node 起，见 PITFALLS） |
| app build | ✓ **21.7s / 产物 13 件 5.5 MB**（1016 终验于 master `70b7bf9`；改前：97 件 15.2 MB、38.71s）。**开机关键路径入口块 4,995 kB → 865.9 kB（gzip 1,352→286.8 kB，−83%）**：懒分割把 Monaco 整段（`entry` 3,978.1 kB，gzip 1,026.6 kB）推到进项目时才加载，`ProjectView` 132.9 kB 同为懒块；ts/css/html/json 四个 worker（9.0 MB）随 B 档砍除从构建面消失。⚠ 入口大头本是 `editor.main` 的 contrib 段（语言与重型 feature 历来是懒 chunk），故自装配单看只 −67 kB——真正的收益在分割与 worker 面 |

⚠ skipped 跨主机不必相等：存档 / 语料在位与否会让 corpus 用例在 passed / skipped 间移动。

## 二、语料读数（真实工程；语料 2026-10-15 曾暂离本机、2026-10-16 已回归〔回归后复测在案：BOARD §R CR-1/CR-2〕——以下为各口径最后一次实测冻结值）

- 索引：**99,228 函数 / 2,325 文件**（2026-10-16 真语料壳内读数：`Condition index: 99228 functions` / 状态栏「2325 文件 · 99228 函数」；FT-2 起 `.ERH` 声明文件进面：+31 份，函数计数不变——声明文件 0 个 `@` 定义，由 `erh-index.corpus.test.ts` 钉死），全量索引剖面 **walk 183ms · snapshot 510ms（get 494 / coerce 15）· aggregate 63ms · read+parse 0ms**（1016 实测，替旧「2.9s 历史口径」）；家族覆盖率 **98.91%**。
- 性能（**2026-10-16 真语料桌面壳两轮复测**，dev 口径；点击「最近项目」后的**页内墙钟**；复跑 `node tools/boot-watermarks.mjs`，机器空闲时才是可比读数，PITFALLS 74）：**PERF-8 修复后（master `dda9e75`）＝让位 冷 1.40s / 热 1.20s、索引可用 2.68 / 2.72s、点开文件→Monaco 挂载（自点项目算）4.22 / 3.32s、校验有结果 9.78 / 3.42s**；修复前（同工具同语料）＝让位 26.6 / 25.2s、索引可用 27.9 / 26.6s、Monaco 挂载 28.8 / 27.0s、校验有结果 28.8 / 27.4s ⇒ **进项目到能用 −84%（约 7×）**，`boot.editorInteractive` 31.9s → 7.8s。
  根因与取舍记 PITFALLS 73：`walkDir` 的函数型 `filter` 跨 IPC 被静默丢 ⇒ ERB 根 **4,519 份**被逐份串行读+哈希（该读的 `.ERH` 只有 **153 份**），adapter 变量字典一段独占 **24.4s**（冷热同值⇒非预热）。产品日志自证：修复前「自定名表（*.ERH 具名常量）：4519 份」，修复后「153 份，收录 5755 个名字」；守门 9 条用例（`walkdir-bridge-equivalence` 4 + `variable-schema.walkdir-ipc` 5，断言「读了哪几份、几趟」而非返回值；在 master `45121fd` 上 7 failed 后才修的）。
  ⚠ **修复把冷开级联的真实成本露出来了**：修复后冷轮 `project.opened→条件可用 / 校验有结果` = **10.6 / 8.4s**（热轮 2.1 / 2.2s），而修复前冷轮只报 2.18 / 2.39s——那不是变慢了，是**旧 bug 顺手把整棵 ERB 根读进了会话文本缓存**，级联于是零盘读白捡；现在级联自己读，才见真实冷开盘账（索引段依旧快：`walk 185ms · snapshot 543ms · aggregate 68ms`，条件扫描 20ms／复用 2,325）。⇒ 冷开条件/校验段 8–10.6s 已立 **BOARD §S PERF-9**（增量抽取/校验那条老欠账现在是头号）。旧口径（热开 0.63/1.57/1.60s、全冷 7.5/26.3/21.0s、读盘 45.1s÷并发 8、扫描 2,285 次）系 1016 批量 IO / 快照 v5 之前所测，**由本行替**。
- 首屏（1016 本机实测，无项目态）：**dev** `htmlParsed 99.9 / firstPaint 444.0 / welcomeInteractive 3740.4 ms`（改前页内白屏 5.7s、墙钟 15.1s）；**release 终验于 `70b7bf9` 新编 exe**：冷开 `65.9 / 399.5（帧后近似上界）/ 220.9 ms`，reload 轮 `29.1 / 38.0 / 143.1 ms`、**白屏段 Δ=8.9ms**（改前 release 首绘 492ms、可点 686ms）。两条硬断言皆真：①内联底色==挂载后计算底色（`rgb(30,34,39)`）+ splash 已撤；②**CDP Network 域**取证——可点前 28 条请求零 monaco、可点后 idle 预取拉到 1 条（匹配面有效的反假绿自证）。复跑：`node tools/boot-marks.mjs --exe <release exe>`（release）与 `node tools/smoke-tauri-dom.mjs`（dev 同口径）。⚠ 页内 `performance.getEntriesByType('resource')` 在 WebView2 数不全（曾见 total=29/0）⇒ 断言②只认 Network 域。`boot.editorInteractive` 真语料读数（1016 复测，dev 壳，口径＝自导航起点）：**冷 31,886ms / 热 32,875ms**——这条标记把「点开项目后等的那二十几秒」也计了进去，用户口径应读作 **点击项目 → Monaco 挂载 28.8s（冷）/ 27.0s（热）**，其中编辑器自身只占 **216ms / 183ms**（大头归 PERF-8，见上一行）。本轮 dev 首屏三段实测：冷 `104.0 / 464 / 3108.4ms`、热 `43.7 / 68 / 508.5ms`。
- 批量读（1016，合成 2,000 文件 / 160.9 MB 口径）：冷开一次**正文单文件读 8,000 → 2,000**（抽取/校验/refs 命中会话缓存零读盘）、IPC **≈16,000 → 48 趟批**；快照 size 参与失效 + refs 懒聚合：索引热载净账 **113.9 → 75.4ms**、抽取装载 **93.7 → 36.9ms**、**交替开项目不再互踩**（旧 prune 语义实测 6 轮全冷 0/200，修复后首轮冷、此后 200/200）。
- 交互（1016，合成 6,000 行 ERB + 2,000 行 `.kojo`）：装饰同步轮主线程 **48.5/52.7 → 0.48/0.41ms**（两路重装饰）、三路合计 **78.0 → 0.19ms**、切回未改动标签 **0 次重算**（`.kojo` 转译刻意不入 worker——字典/时机表是项目态，硬搬造假错）；糖线保存 **2→1** 次转译、三消费者 **3→1**、`resolveFamily` **~45×**；树与面板：99,975 函数单扫 **4.48 → 3.88ms**、六连击搜索串 **21.37 → 0.002ms**、文件树 3,000 命中一帧行构造 **28.9 → 1.06ms**、冷开左栏改由 `walkDir` 即时出树、`PanelBody` memo 化。
- 条件抽取（2026-10-16 真语料壳内读数）：**99,228 函数中 31,630 含状态依赖**；谓词 493,857、未解析 187＝**0.04%**；依赖 164,958；单轮扫描 **22–23ms**（复用 2,325 份）。
- 状态回放（save03 × K49）：未知率 **31.9%**（3,732 谓词；exact 837 函数）；**口径拆分（HK-23）**：不可约真随机（RAND）**1,820** ⇒ **可判定率 83.6%**（同分母、可比历史 62.9→48.5→32.0）＋ **能力覆盖率 80.6%**，基线不变式钉在测试里。
- 结构闸门（§5.109）：**3,971 文件（正文 3,818 + 声明 153）/ 4,126,929 行**零误报（FT-2 扩面后本机复跑），最慢单文件体检 30.0ms（历史读数，本轮冷跑见过 50.7ms 未采信）；"删 `ENDIF` → 💡 补回 → 复检为零"闭环过。
- 编码：utf-8-bom / utf-8 / shift_jis / utf-16 读写往返；golden 六档存档 roundtrip 全等。

## 三、环境与路径（按主机而定；路径类细节不在本文存档）

- 工作树：本 clone 路径按主机而定；同一台机器上可能并存多个工作树——**动别人的树前先问**。
- 真实语料：**认内容不认名**——目录名会被反复重排，且**可能整目录暂离**（实测过 `C:\game` 不存在 ⇒ 挂语料用例自动 skip；回位后按同口径重测）。一律经 `tools/corpus.mjs` 解析（`--corpus` > `KOJO_CORPUS_DIR` > 扫 `C:\game\*` 筛 `ERB/`+`CSV/`；多命中判据 ①`sav/` 非空 ②`.ERB` 数 ③目录名）；**整体只读，零写入是硬约束**。
- 语料盘面（ERB 数 = `ERB/` 下 `.erb` 递归计数，工具打印同口径）：基线盘（画蛇添足版 4.980）3,818 / CSV 33 / `.als` 19 / `sav` **6** / 有 `erb_check.py` ＝ **本项目全部基线所依据的那份**；改版盘 3,931 / 38 / 20 / `sav` 0 / 有；官方盘 4.842 2,223 / 25 / 0 / 0 / 无。
- 存档库：与语料同级的 `eratw-save\sav\` 与语料内 `sav\` **六档逐字节同容**（两处均只读；**面板读语料内 `sav\`**——adapter 固定 `<游戏目录>\sav`；注入前须去 R，见 PITFALLS §二）。
- 代理：github 直连不稳的环境，给本 clone 配 repo 本地代理（`git config http.proxy <本机代理>`；新 clone 配一次；**永不改全局配置**）；引擎类工具的代理经 `KOJO_GIT_PROXY` 提供。
- 桌面壳：`pnpm --filter @kojo/app tauri dev`；CDP 9222；**同一工作树只能一个桌面实例**。
- 自动更新（REL-1）：签名密钥在构建机 `%USERPROFILE%\.tauri\kojo-editor.key`（**永不入库**；CI 走 secrets，**Secret 内容 = 密钥文件原样单行 base64**，`tauri signer generate` 的输出即此形态——再包一层 base64 会报 `Missing encoded key`）；endpoint 指 GitHub Releases latest.json；**v0.0.1 端到端已验证**（2026-10-15：check() → 拉取 latest.json → 签名验证 → 版本比较 → 已是最新，CDP 探针 `.local/test-updater.mjs`）；注意插件 `check` 命令的 `timeout` 单位是**毫秒**、`headers` 是序列、可选 `proxy` 参数（`http://…` 字符串）；**本机直连 GitHub Releases 时通时断 ⇒ 探针走 7890 代理**，「updater 跟随环境代理」为下批待办（Rust 侧读 env 后经 check 的 proxy 参数传入，或前端设置项）。

## 四、剩余欠账（数字/方向性的；认领的活在 BOARD.md）

- **v0.4.0-beta.1 发版余项**：真实终端手工勾验（保存闭环 §2.J / 文件监视）+ 桌面壳深度冒烟 + NSIS 打包产物干净目录安装验证 + 面向用户的安装/使用文档；自动更新链路代码侧已闭环（REL-1），端到端待首次真实 release。
- ERB 波浪线两层：**结构类**（三类可证明错误，erb-parser，error）；**表达式级**已落地（E8，condition-extractor 复用自研表达式解析器，IF/ELSEIF/SIF/WHILE/SELECTCASE 条件表达式的词法/语法错，warning，code `erb.expr-*`；保守排除 CASE/PRINTDATA）。
- `.kojo 预览`（旧称"糖视图"）：**不走虚拟文档**（原三问废止）；已交付为常态功能——只读内存 model 原生渲染（2026-10-14 SV-1），**默认不开启**且不再受「显示已封存功能」总闸管辖（同日 UX-2；总闸现只管 `.kojo 转译检查` 与归档浏览器两只面板）；作者-facing 术语已去「语法糖」一族，统一 `.kojo 语言 / .kojo 预览 / .kojo 校验 / .kojo 转译检查`（守卫 `packages/app/tests/no-sugar-jargon.test.ts`）。

## 五、版图速览（代码地图）

插件 19：`erb-parser` / `eratw-adapter` / `convention-linter` / `condition-extractor` / `sav-parser` / `state-replay` / `kojo-market` / `kojo-sugar` / `ui-convention-report` / `ui-kojo-navigator` / `ui-market` / `ui-condition-matrix` / `ui-state-replay` / `ui-archive-browser` / `ui-snapshot-injector` / `ui-plugin-status` / `ui-sugar-preview` / `ui-sugar-editor` / `ui-sugar-lift`。
目录结构与关键文件注释见 `docs/ARCHITECTURE.md`；批次明细在 `docs/log/`。