# STATE.md — 项目现状（数字的唯一真源；有变动顺手改这里）

> 读数字先读本文件，别信记忆和旧文档。历史逐批读数在 git 提交信息里（旧全量在 `docs/archive/IMPLEMENTATION-LOG.md`，冻结，不再追加）。

## 一、基线（2026-10-31 语言面搬家第七波（G2 排版进槽 + 判据出宿主 7 枚）；E 批 · R6 快照保存链屏障；LAU-4 收口波 / SDK-B5b 六车）

| 项 | 读数 |
|---|---|
| 全量测试 | **语言面搬家第七波（2026-10-31，开工点 `71393098`）**：功能池 **1,141 文件 · 21,752 passed / 0 failed / 143 skipped（21,895）**——同尺对拍：开工点 `71393098` 实测 1,141 / 21,729 ⇒ 本批 **+23 条、文件数不变**（conformance 六空窗 +11、`format-notice-ledger` 31→40 +9、ERB 区间前缀 ①-b +1、`erb-lang` 高亮扩选第三枚贡献与判据抛错上探 +2）；⚠ **本行是 JSON reporter 口径**（`--reporter=json --maxWorkers=8` 的 `testResults.length`），与 console 的「N 文件过 + M 跳」不同尺（本机 1,141 ≈ 旧口径 1,109+23），跨尺相减会得出假的"用例回退"；计时池 **31 文件过 + 5 跳（36）· 322 passed / 12 skipped（334）· 155.39s**（与上一档逐字相同，本批未碰 perf 用例）；双 typecheck rc=0；decoupling ✅**31**；audit:language **M1 3 / M2 125 / M3 64**（M2 随 `--update-baseline` **126 → 125** 收紧：`kojo-format-range.ts` 少一枚按语言 id 分支）；ps10 **199 文件 / 3,502 KB · 3,586,474 B**（闸值不动，**字节余量只剩 86 B**：进图只有契约 `slots.ts` +385 B，其余全在懒边——拆的壳、退役的宿主模块、新叶子都只加 `exports` 不进桶）；产物 **98 件 · 11,754,395 B（11.21 MiB）· 入口 276,473 B**，`exceeded: []`。并行期跑全量**必须限并发**，否则整轮 Zone OOM 打死（PITFALLS 295）。 |
| 全量测试（挂语料 `KOJO_SMOKE_PROJECT`） | **旧口径子集（2026-10-20 冻结，非当日常规全量）**：功能池 **10,516 passed / 8 skipped（10,524）· 0 failed · 595 文件全过**；计时池 **221 passed / 12 skipped（233）· 0 failed**（2026-10-20 冻结值，空闲独跑）。当日常规全量见上一行（21,633 例）；本行只作"挂真语料"那一档的参照。`[idx-state]` 自证：2 根 / 2,325 方言文件 / 名录 99,218 名 / 未读入 0。语料以 `node tools/corpus.mjs --print` 为准（不在 `C:/game` 时用 `KOJO_CORPUS_SCAN_DIRS` 指定扫描根，正斜杠经变量传递）。纪律：挂语料全量必须空闲独跑；计时池若红先按负载假红复跑再判（PITFALLS 146） |
| typecheck | root + app **双跑 exit 0**（`pnpm typecheck` + `pnpm --filter @kojo/app typecheck`） |
| 审计 | `pnpm audit:decoupling` ✅（**31** 插件——2026-10-31 复跑实测 31（LAU-4 起 `erb-lang` 供方插件按磁盘目录进表）；2026-10-27 补全线 IC 批加通用插件 `inline-completion-local`（幽灵文本本地候选源，槽 `completion.source` 第一家）从 29 进到 30；2026-10-26 多游戏批加 `eraav-adapter` / `eratohoreverse-adapter` 从 27 进到 29；更早 `launcher-core` 骨架批从 26 进到 27，新包按磁盘目录自动进表；A–D 四项全绿。视觉批十六遗留的 `ShellLayout.tsx:2374` 注释裸游戏名由上游设置页批改成中性词，A 项归零。**2026-10-25 多游戏适配收口批起，两份名单不再手工维护**：`ADAPTER_PLUGIN_DIRS` 由磁盘 `packages/plugins/*-adapter` 目录派生，A / D 的游戏名词由 `packages/app/src/adapter-manifest.ts` 的 `auditWord` 派生（读不到清单＝fail-closed 直接判红，绝不「读不到就当没有」）。补录史（此前每接一游戏手工补一次）：eratohoK / eraSQC / eraKoumakan / eraFL——其中 eraFL 批做过变异实测：通用插件插一行 `'eraFL'` 字面量 D 项即红，还原即全绿。新口径的同形自证在 `packages/app/tests/adapter-manifest.test.ts`：审计脚本的**代码行**里出现任何清单游戏名即红（词表只能由清单派生），别名陈旧项与 root↔vitest 漂移同样判红）。`pnpm audit:language` ✅（**2026-10-25 LAU 七路批新立**的**第二份**审计（第一份是 `audit-decoupling`）：语言面棘轮，`tools/audit-language.mjs` + `tools/audit-language-baseline.json`。M1 游戏名·引擎词汇 **3 处（基线 3）**、M2 语言 id 分支 **125 行（基线 125）**、M3 旧 token 名 **64 行（基线 64）**——2026-10-31 语言面搬家第七波随 `--update-baseline` 把 M2 **126 → 125** 收紧（ERB 区间排版腿出宿主后 `kojo-format-range.ts` 少一枚按语言 id 分支），**终态是零命中，但棘轮只认真能红**，基线钉当日实测、只降不升；豁免口径逐字继承 `audit-decoupling` 的 `audit-allow` / 注释行 / 组合根三条，读不到基线文件＝fail-closed 判红。三族各注入一条违规的变异实测在 `tools/tests/audit-language.test.ts`） |
| Rust | `cargo test --lib` **297 passed / 0 failed / 7 ignored**（2026-10-28 写域出路批实测，23.33s；上一钉＝274（2026-10-26 启动器第一/二波：L3a 232 → L3b 268 → STOP 优雅停止 274），其间启动器并行/终态两批把 `write_domain_tests` 之外抬到 291，本批 +6 枚全在写域面：`confirm_target_guard` 四枚（现有目录放行 / 缺失·文件·卷根三枚不弹框）+ `human_root_path` 剥 `\\?\` 前缀 + 确认框正文"同一目录不重复刷屏、落点不同才补一行"。`src/launcher/**` 共 13 个模块。进程用例全走「测试二进制自我重启」夹具、零外部 exe，含真窗口 WM_CLOSE 夹具。改了 Rust 才跑；必须经 node 起，见 PITFALLS） |
| app build | ✓ **语言面搬家第七波（2026-10-31，开工点 `71393098`）**：`node tools/release-gate.mjs --only artifact-audit --build` **PASS**（buildRc=0，39.6s）；dist **98 件 · 11,754,395 B（11.21 MiB）**；入口块 **276,473 B**；三枚闸 ≤98 件 / **≤11.25 MiB** / ≤1,100 KB，`exceeded: []`。**总量上限随本批 11.2 → 11.25 MiB**：同命令实测开工点 dev 尖端 = 98 件 / **11,753,031 B** / 入口 276,375 B，已越旧线 **8,980 B**（上游合流推高 63,713 B、96 → 98 件而未随钉，红在开工前就挂着）；本批自身逐枚点名净 **+1,364 B、零新增分块**（`lazy-plugin-ui` +8,339 对 `languages` −8,146，其余是契约 `options` 一格与槽腿错态回调）。件数仍**顶格 98**——下一批先问能不能并块。⚠ 不带 `--build` 时这一项会**跳过构建**仍报 PASS，取数必须带它。 |

⚠ skipped 跨主机不必相等：存档 / 语料在位与否会让 corpus 用例在 passed / skipped 间移动。

## 二、语料读数（真实工程，工具只读；以下为各口径最后一次实测冻结值）

- 索引（2026-10-28 项目级索引批起＝**整棵 ERB**，口上根 + 只读基座库经祖先折叠后同一个扫描根）：**110,049 函数 / 3,971 方言文件**（其中 `.ERB` 正文 3,818；名录 110,049 名）——旧「只扫個人口上」口径为 2,285 文件 / 99,030 名。真语料冷开剖面 **walk 759ms · read+parse 3,043ms · aggregate 88ms · refs scan 7,284ms（62 chunk 分片）/ 合计 11,203ms**（热载走快照；`integration-plugins.test.ts` 实测）。家族覆盖率（作者口上域口径，基座库不计）**98.91%**。
- 性能（真语料桌面壳、空闲机、`node tools/boot-watermarks.mjs`，点击「最近项目」后的页内墙钟）：稳态冷 / 热＝让位 1.41 / 1.21s、索引可用 2.71 / 2.45s、点开文件→Monaco 挂载 198–675ms（自点文件算）、编辑器可用 4.01–4.63 / 3.03s、校验有结果 3.38 / 3.21s；对比修复前（让位 / 索引可用 / Monaco 挂载均 ~26–28s）**进项目到能用 −84%（约 7×）**。冷≈热；旧「冷开级联」口径已废弃（系一次性快照重建，非热点）。根因与守门见 PITFALLS 73。
- **内存（2026-10-29 MEM 批，`node tools/mem-readings.mjs`，真语料 eraNAS 4,145 份 / 1.137 亿码元 / 100,320 名，内核 + 解析/适配/校验/抽取四插件同进程）**：稳态 **493.6 MB → 276.5 MB（−217.1 MB / −44%）**；索引就绪那一刻的峰值几乎不动（493.6 → 494.4 MB——突发期文本缓存照旧装满，这正是"索引/抽取/校验三段零重读"的成立条件，**不拿首屏速度换内存**）。两处根因、一处联动：① 解析产物里的函数名 / 形参名 / `#DIM` 名 / `$` 标签名 / 注释块都是正文的切片，V8 的 `SlicedString` 顺着父串把**整库正文**钉在堆里（纯索引口径 **242.0 → 96.7 MB**；`normalizedName` 因 `toUpperCase()` 对全大写串原样返回接收者，是最容易漏的一格，值 130 MB 量级）；② 会话文本缓存留到进程结束（4,340 份 / 1.14 亿码元 / 218 MB）⇒ 改成"空闲 20s 整表释放 + `project.closed` 立刻释放"，`[io]` 一行 info 记量；③ 联动：切片不先摊平，①的缓存释放是假动作——同一发释放实测从 **23 MB** 变成 **217.9 MB**。索引构建耗时未退化（12.5s 量级，与改前同档）；功能池与 typecheck 计数不变。
- **内存·真壳（2026-10-29 MEM 批补量，`node tools/mem-shell.mjs` + 堆快照；tauri dev + WebView2，eraNAS 冷开＝无快照全量重建 4,146 文件 / 100,393 函数，索引就绪 16.0–17.3s）**：页面堆（快照 `self_size` 合计）**578.4 → 362.5 MB（−215.9 / −37.3%）**，两版唯一动的是 `native` 桶 **302.5 → 87.0 MB**，`string` 110.4 → 110.0、`object` 72.5 → 72.3、`array` 71.8 → 71.7、`code` 15.7 全不动——**WebView2 把 Rust 侧传来的正文串做成外部串，记在 `native` 桶**（所以 CDP 的 `JSHeapUsedSize` 看不见它，见 PITFALLS 256）。功能性旁证：壳内 `text.files` 4,342 → 0、`chars` 1.14 亿 → 0，`hits` 4,324 / `misses` 4,179 保留。进程树（应用＝`kojo-editor.exe` + 5 个 `msedgewebview2.exe`，工具链 vite/esbuild/cargo 另计）：冷开峰值 ~2.6 GB（两版同档，构建瞬时垃圾）、静置 45s 后 **1,167 MB（改后）/ 1,345 MB（改前）**——**OS 工作集在 1 分钟内基本不反映这次释放**，归因只认堆快照。
- **内存·同口径复量与热载路径（2026-10-29 MEM 批收尾，`node tools/mem-readings.mjs --warm`，两趟两进程）**：上一条的 493.6/276.5 是旧量具读的（量稳态时没等快照落盘，把 in-flight 的编码串与大 Map 算成了常驻，见 PITFALLS 257）。同一把尺子重量的四格：**冷建索引就绪 493.1 → 494.4 MB（不动）**、**冷建稳态 457.3 → 240.8 MB（−216.5 / −47.3%）**、**热载索引就绪 200.1 → 200.9 MB（不动）**、热载耗时 2.21 → 2.26 s。**热载（用户每次启动真正走的路，`reused 4145/4145` / `read+parse 0ms` / `refs scan 2ms`）的索引常驻与耗时本批一概不动**——MEM-1 摊平的是冷建时才存在的切片串，MEM-2 释放的是冷建才装满的会话缓存；热载那 200.9 MB 的构成是：插件跨轮保留的解码后快照条目 ~112 MB、`byName` 引用 **67.1 MB**（消融 `byName.clear`）、`bySymbol` **未实体化**（热载走延迟聚合，消融只掉 0.2 MB）。⇒ 下一批要压热载，目标只能是快照条目与 `byName` 的形态，不是反向引用。MEM-3（`byName` 直接复用 `ErbFunction` 省 7.6 MB）试过并**已回退**：只在冷建成立、且让形状随路径分裂（PITFALLS 258）。
- **内存·热载稳态归因与 MEM-4（2026-10-29，`--warm --samples N` 多采样取下界；真语料 eraNAS 4,145 份 / 100,393 函数）**：热载（用户每次启动真正走的路）稳态 **297.3 → 271.8 MB（−25.5 / −8.6%）**，索引就绪 **220.9 → 195.4 MB**。这一批的**靶子是量出来的、不是推的**：按插件逐级少装得到预算 **erb 169.9 / 条件抽取器 98.6 / 校验器 2.8 / boot（内核+适配器）26.1 MB**；快照里 945,125 个字符串中**有 772,329 个是内容重复的独立实例（31.3 MB）**——同一个函数名在 61 万条引用里各存一份（`ADD_FAMILY_NAME_K` 一个名字 154,975 个实例 / 5.9 MB），同一条注释块 2,576 份。修法：解码期加一张**同内容去重表**（`snapshot.ts` 的 `NameInterner`，表只活到解码结束、不进稳态），把函数名 / 归一化名 / 注释块 / 形参名 / 声明名 / 引用名 / 标签名统一过表；顺带 `detachString` 摊平解码出来的切片串。复核：重复实例 772,329 → 640,309（剩余是条件抽取器 AST 里的运算符与字面量，不是名字）。**零格式变更、零契约变更**（快照仍是 v11），用例 715 全绿。索引本身（`files`+`byName`+跨轮快照条目）在稳态只占 **30.4 MB**——不是之前倒推的 175 MB（见 PITFALLS 259③）。
- **内存·热载稳态归因与 MEM-5 列式依赖表（2026-10-30，`--warm --settle 45000 --samples 3`；语料换成 **eraTW 4.980**（3,971 份 ERB / 110,049 函数 / 603,340 谓词 / 211,985 依赖）——上一条的 eraNAS 盘已不在位，两批读数**不可跨语料相减**）**：热载稳态 **272.4 → 203.1 MB（−69.3 / −25.4%）**，其中条件抽取器自身 **105.8 → 36.5 MB（−69.3 / −65.5%）**（同口径按插件少装：全开 272.4 / 去掉它 166.6 MB）。靶子是堆快照量的：`Array` 头 **50.0 MB / 163.8 万个**、元素区 **76.2 MB / 134.8 万个**，属本快照的是 21.2 万个 `DependencyTuple` + 21.2 万个 `indices` 数组 + 18.4 万个比较式数组 + 18.4 万个 `ComparisonTuple`（**≈79 万个 JSArray**）；元组里的字符串**几乎全可去重**——`op` 只有 **6** 种却存 18.4 万份（`==` 一种 154,949 份 / 3.5 MB）、`text` 只有 **5,707** 种（3.1%）却存 18.4 万份、`indices` 只有 **3,446** 种却存 21.3 万份（`恋慕` 20,194 份）。修法：解码结果换成**一张列式表**（依赖级 8 列 + 比较式级 5 列 + 索引池，15 个 TypedArray 共 **11.4 MB**，加 4 个字符串池），`dependencies` 仍是首次读才物化的 getter。**盘上格式零变更**（仍是 v9，旧快照照读）；新旧解码在整份真实快照上**逐字段等价**（含键序、值类型、schema 内容；物化耗时 249 / 256 ms）。代价：装载 **591 → 748 ms**（一次开项目付一次，见 PITFALLS 262）。
- **内存·候选记号集哈希化与 MEM-6（2026-10-30，`--warm --settle 2000 --samples 3`；同一份 eraTW 4.980 语料，与上一条**可直接相减**）**：热载稳态 **202.9 → 171.7 MB（−31.2 / −15.4%）**，索引就绪 **190.0 → 158.8 MB**。靶子是**消融 + 持有链**一起量的：`candidates`（每文件的候选记号集，REFS-PROVENANCE 的免扫证明原料）在稳态占 **32.0 MB**（`--ablate-only=candidates` 实测 −32.0 MB，与"16,968,188 字符 × 2 B/字符 = 32.36 MB"逐字对上），而它**只在"名录变了"那一刻被读一次**。堆快照的持有链先给出"两处持有"（`SnapshotEntry.candidates` + 惰性壳的 RAW 元组第 11 位，同一枚串 ⇒ 只清一处报 `+1.5 MB`，见 PITFALLS 267）。修法：第 11 位从"`\n` 连接的记号串"换成**记号 32 位哈希集**（内存 `Uint32Array`，盘上 base64），1,703,214 枚 × 4 B = **6.5 MB**；`refsProvableUnchanged` 改为"遍历本文件哈希、查名录侧哈希集"，**碰撞只会多扫、不会漏扫**（全局唯一记号 1,189,209 → 唯一哈希 1,189,047，162 处碰撞 = 0.014%）。**快照 v11 → v12**：v11 的串能就地哈希（`candidateHashesFromTokens`）⇒ **迁移免费、一个文件都不重扫**（真语料实测 `index salvage: 3971/3971（丢 0, 溯源补正 0, 候选免扫 0）`）；盘上同时从 41.6M 字符降到 32.0M 字符（−23%），落盘 **1001 → 642 ms**。同批补上 `salvageEntries` 缺的 MEM-4 去重表（版本换代后那一轮此前白丢 26 MB：salvage 轮 184.7 / 纯热轮 158.8 MB）。
- **内存·引用流水扁平化与 MEM-7（2026-10-30，`--warm --settle 2000 --samples 2`；同一份 eraTW 4.980 语料，与上一条**可直接相减**）**：热载稳态 **171.7 → 153.4 MB（−18.3 / −10.7%）**，索引就绪 **158.8 → 140.5 MB**。靶子仍然是量出来的：先把量具修对（`--arrays` 只数 `element` 边 ⇒ 727,391 个数组全报"长度 0"，见 PITFALLS 269），真实分布是 **33.1 MB / 501,457 枚"长度 1"的 JSArray** + **22.4 MB 槽 9 属性块** + 43 万份 3 元素函数元组；逐项消融点出最大单一数组是 **`refs` 引用流水 −29.1 MB**（341,779 条 × 4 元组 `[name, line, column, kind]`，JSArray 头 32 B + 底层 FixedArray ≈ 69 B/枚）。修法：每文件一枚扁平 `(string|number)[]`、步长 `REF_STRIDE = 4`，3 格是 Smi（内联不装箱）、第 0 格是已去重的名字指针，布局只许住在 `forEachRef` 里；`push` 出来的增长余量用 `out.slice()` 裁掉（`length = length` 是空操作，1,367,116 格被撑到 1.45 倍 ≈ 2.4 MB，见 PITFALLS 271）。**快照 v12 → v13**：v12 的四元组就在盘上，就地摊平 ⇒ **迁移免费、一个文件不重读、一次 refs 不重扫**（真语料实测 `index salvage: 3971/3971（丢 0, 溯源补正 0, 候选免扫 0, 旧形态 0, 键 index-v12-ad0d3e1e）`、`read+parse 0ms`）；落盘 **35,054,111 B**，同内容按 v12 重编码对照 32,025,675 → **31,342,117 字符（−683,558）**。耗时账（PITFALLS 263 要求）：`snapshot-hot-load.perf.test.ts` 同窗交替仍绿——合成 payload 14.9 MiB、coerce 懒还原 **180.2 ms** vs 急还原 257.6 ms（0.70）、净账 **288.0 ≤ 346.1 ms**；真语料 `refs scan 2ms` 不变。纪律验证：`erb-parser` 单测 **723 passed / 0 failed**、类型检查全绿、开机图闸 **199 文件 / 3,182 KB ≤ 3,184**（逐文件点名 +4,817 / +2,479 / +132 = +7,428 B，零新进图模块）。
- **内存·条件壳形状与 MEM-8（2026-10-30，`--warm --settle 2000 --samples 2`；同语料，可与上一条直接相减）**：热载稳态 **153.4 MB 不变**——这一批压的不是热载路径。靶子来自"谁持有 `(object properties)` 那 25.1 MB"的反查（`C:/tmp/propowners2.mjs`）：**22.4 MB / 52,424 枚挂在 `context:cond`**（闭包变量），即条件抽取器的函数条件壳，而非 `byName` 值对象或快照条目；对应 `condition-extractor/src/snapshot.ts` 里 `Object.defineProperty(cond, 'dependencies', {value: built})`——V8 的"访问器 → 数据属性"重新定义会 `NormalizeProperties`，把整枚对象转字典模式（453 B/枚 vs 快路径 ~56 B）。修法：删掉那句 `defineProperty`、改闭包缓存，访问器一直留着（`Object.keys` / `JSON.stringify` / `toEqual` 口径逐字不变，用例断言改成钉这三条契约而不是钉"读后变数据属性"这个手法）。**未归因**：同规模合成复现（52,435 壳 / 211,985 依赖、同一条 `decodeBuckets`）里旧写法**并没有**转字典态（274 枚 / 0 枚 `context:cond`）⇒ 真实壳还有第三个因素，按 PITFALLS 272 记成"未归因"，不编解释。同批修 `tools/mem-readings.mjs` 的自举解析钩子（只认裸包名 ⇒ 新包 `@kojo/erb-vocab/control-flow` 一落地就 `ERR_MODULE_NOT_FOUND`，见 PITFALLS 273）。验证：`condition-extractor` 203 passed、`erb-parser` 723 passed、全量 typecheck 绿。
- **内存·`byName` 容器起步容量与 MEM-9（2026-10-30，`--warm --settle 2000 --samples 2`；同语料，可与上一条直接相减）**：热载稳态 **153.4 → 140.0 MB（−13.4 / −8.7%）**，索引就绪 **140.5 → 127.1 MB**。靶子先量准：隔离探针（只 decode 真实快照 + `aggregateIndex`，不挂其它插件）给出 `byName + files Map` = **33.2 MB / 110,049 键 / 110,073 条定义 ⇒ 311 B/条**，其中 110,043 个名字只有一条定义。先排除了"对象形状"这条直觉——条件展开 33.2 / 补位 35.7 / 四种完整字面量 32.8，**三条路线都不赢**；真凶是 `const refs = byName.get(name) ?? []; refs.push(ref)`：空字面量是零容量，`push` 第一枚时 V8 按"需求 + 16"重分配 ⇒ **17 槽 / 底层 152 B**，而"恰好 1 槽"只要 24 B ⇒ 白占 13.5 MB。修法：首条定义用 `[ref]` 字面量、已有条目才 `push`（顺带省掉每次 `set`）。隔离探针 **33.2 → 19.7 MB**、真机 **−13.4 MB**，两个口径逐字对上；`aggregateIndex` 的两条路径（RAW 元组 / 对象）共用新的 `makeRef`，键序与"缺席 = 没有这个键"的契约不变。**`byName` 剩下的 19.7 MB 是结构成本**（11 万枚 1 元素数组 + 11 万枚对象 + 11 万条 Map 项 + 11 万条大写名串），再压只能列式化 + 视图（会动 `ErbFunctionRef[]` 这个跨包类型与 15+ 处消费方）⇒ **单独立项，不在本批**。验证：`erb-parser` 723 passed、热载 perf 基准 5 passed、全量 typecheck 绿、开机图闸 199 文件 / 3,185 KB ≤ 3,188（零新进图模块，+2,503 B 全在 `snapshot.ts`）。
- **内存·五路并行 MEM-10~14（2026-10-30，`--warm --settle 2000 --samples 2`，v14 盘、无迁移；同语料可与上一条直接相减）**：热载稳态 **140.0 → 132.3 MB（−7.7 / −5.5%）**，索引就绪 **127.1 → 120.6 MB**，`idle` 141 → **109.7 MB**。五个子任务按包切、互不重叠，逐项读数：
  ① **MEM-10 erb-parser 条目侧**（子 agent A）：形参 / 声明 / 标签从"一条一枚小数组"摊成扁平流水（`PARAM/DIM/LABEL_STRIDE` + `forEachParam/Dim/Label`，空形参共用冻结空数组），**快照 v13 → v14**（v13 进准入表、就地摊平 ⇒ 迁移 340–351 ms、0 条丢弃、不重读不重扫）。隔离探针：条目常驻 **60.64 → 54.43 MB（−6.21）**，decode 349 → 338 ms，盘上 31.34 → 31.21 MB。语义对拍 209 文件 / 2,073 形参 / 1,783 声明 / 107 标签**0 处不同**。函数元组本身（110,073 枚 5~7 槽）未动——预估 ~7 MB，但要改 `aggregateIndex` 的元组直吃路径，留作下一刀。
  ② **MEM-11 condition-extractor**（子 agent B）：**PITFALLS 272 结案**——真凶是字面量里"每枚一枚闭包"的 `get dependencies()`，V8 只能把它放进字典模式（decode 完、一条依赖都没读就已 52,435/52,435 字典态）。修法：数据属性字面量 + `defineProperty` 补**共享**访问器 + 区间/物化数组放 `WeakMap`。`(object properties)` 那 **22.75 MB → 0.35 MB**；隔离探针 decode 后 heapUsed **46.6 → 21.8 MB**、读完全部依赖 **115.9 → 90.3 MB**；盘上格式与字段清单不动。
  ③ **MEM-12 宿主侧**（子 agent C）：前缀索引 9.39 → **0.16 MB**（建索引 157–183 → 21–23 ms）、族索引 35.9 → **0.7 MB**（首问 541–1008 → 24 ms）、`erb-completion` memo 140 → 67 ms。**textCache 未改**：实测 3× 放大来自 kernel `normalizeEol` 的 `replace` 生成 ConsString 绳索（持解码串 13.68 MB / 持归一化串 40.74 MB，2.00 vs 6.24 B/字符），要改得动 kernel 契约 ⇒ 留作下一刀。
  ④ **MEM-13 量具**（子 agent D）：`heap-aggregate.mjs` 加 `--owners`（`--owners-of/-like/-type/-slots/-hops`，按"目标原尺寸"逐层归属），`mem-readings.mjs` 的 `--ablate-only` 扩到 `entries/cond/textCache` 且不必再配 `--ablate`。归属结论：`elements` 里 22.1 MB 是每文件 fns/dims/labels 元组、10.5 MB 是 `entry.refs` 扁平流水、2.5 MB 是 byName 的 `[ref]`；`ArrayBuffer` 里 **6.5 MB / 3,453 枚是每条目的 `candidateHashes`**（可从 refs 重算，下一刀）、11.4 MB 是同一枚 5.96 MB WASM 内存被两个视图各计一次（不可动）；"43.7 万单元素数组"**不是闭包 TDZ**（Context:fns 仅 558 枚），110,351 枚就是 byName 的 `[ref]`。
  ⑤ **MEM-14 校验器与适配器**（子 agent E）：`lastRun.mtimes` 由"每轮抄一份 4,258 条 Map"改为持索引引用、装饰视图改惰性 ⇒ 合计 **1.51 → 1.36 MB**（无装饰请求 1.20 MB）；**四个适配器 0 改动**（`byName` 全量遍历都是纯遍历，中间数组随 ctx 一起死，三遍堆增量 11/1/6/42 KB）。
  合并口径：七枚源文件合计 +24,114 B，但开机图只涨 **+16,979 B**（图内仅 `erb-parser/src/snapshot.ts` +13,450 与 `condition-extractor/src/snapshot.ts` +3,529；另五枚在懒边），闸 **3,188 → 3,204**（读数 3,202 KB / 3,278,930 B）；两枚被写成 CRLF 的文件已按 PITFALLS 268 的二进制口径改回 LF。验证：`erb-parser` 723 + `condition-extractor` 204 + `convention-linter` 153 = **1080 passed**，`app` **9544 passed**（余 2 条为已知常红：`adapter-cross-detect` 缺 `KOJO_GAME_ROOT`、ps10 已抬闸）、四个适配器逐项不降、`npm run typecheck` 零错误。
- **内存·遗留清零 MEM-15~18（2026-10-30，A/B 口径：`git worktree add <C:/tmp> HEAD --detach` 起游离树，两棵树同一语料、同一工具、同一跑法 ⇒ 本行差值为真 A/B）**：语料口径 **4,258 文件 / 117,032 名**（`D:\Game\eraTW4.981-261017-EAGLOV3`；上一条是 3,971 口径，**跨行不可相减**）。热载稳态 **140.5 → 127.6 MB（−12.9 / −9.2%）**、索引就绪 **128.7 → 122.6 MB**、`idle` **116.9 → 110.5 MB**、`cond` **141.8 → 128.9 MB**。四项读数：
  ① **MEM-15 erb-parser（函数摊成流水 + 候选哈希 32→16 位，快照 v14 → v15）**：`ArrayBuffer` 里那笔候选记号哈希 **6.5 → 3.6 MB**（3,536 枚 `Uint16Array`，`candidateHash = hashToken >>> 16`，盘上高字节在前；碰撞方向只能多扫、不会漏扫）；函数从"每枚 5~7 槽元组"摊成 `FN_STRIDE` 流水（`forEachFn` 唯一读入口），隔离探针条目常驻 **−3.37 MB**。**真实语料迁移实测**（v14 盘直接喂新码）：`salvage 4258/4258（丢 0、旧形态 0、溯源补正 0）`、`read+parse 0ms`、refs 重扫 0、迁移 676ms、落 v15 键 + 清 1 枚旧键，迁移后稳态 127.7 MB（与原生 v15 盘 127.6 同档）；形参/声明/标签/候选集语义对拍 0 处不同。
  ② **MEM-16 kernel 文本缓存绳索**：`normalizeEol` / `applyEol` / `reconstructEol` 三处改 `indexOf('\r')` 零拷贝快路 + `split/join`（`replace` 与逐段 `+=` 在 V8 上都产 ConsString，见 PITFALLS 280）。**冷建口径**（4,258 文件 / 116.58M 字符全文缓存）会话文本缓存常驻 **230.6 → 202.9 MB（−27.7 / −12%）**；**热载口径只有 420 文件 / 1.09 MB 正文 ⇒ 两棵树驻留都是 1.3 MB**（这条路上本来就没进绳索，如实记账，别把冷建的 27.7 MB 记到热载头上）。
  ③ **MEM-17 条件壳装载**：非零依赖壳改 `__defineGetter__` 装同一枚共享访问器、零依赖壳（25.3%，13,249/52,435）直接给数据属性 `[]`。真实快照装载 **19.55 → 14.14 ms**，壳仍 0 枚字典态；`cond` 态 **141.8 → 128.9 MB**。
  ④ **MEM-18 量具**（本批唯一跑真机的一路）：`tools/mem-readings.mjs` 自举钩子修 `@kojo/plugin-api` 被 `plugin-` 前缀误指到 `packages/plugins/api`（游离树无 node_modules 就 `ERR_MODULE_NOT_FOUND`，见 PITFALLS 282）；`heap-aggregate --owners` 与 `mem-readings --ablate-only` 复核上列四项目标，冷/热两种口径分开报。
  顺带修：`tools/tests/release-gate.test.ts` 自 `74843330` 起恒红（那次只改 `release-gate.mjs` 的常量 94→96 件 / 11.1→11.2 MiB、漏改用例，见 PITFALLS 281；落 `dev` 前上游 `89c57df7` 已按「单一真源常量 + 渲染面换算」重写该用例，rebase 时取上游版本）。验证（rebase 到 `7133c87f` 后）：`erb-parser` 725 + `kernel` 438/8 skipped + `condition-extractor` 205；全量 **21,262 passed / 143 skipped / 0 failed**（1,091 文件通过 / 23 skipped；上游 `1bdebb4d`~`16e07bd4` 已把 B3 收口留下的 9 条存量红清零、`adapter-cross-detect` 改显式声明）；perf 套件 **312 passed / 18 skipped**（rebase 前读数，本批未在 `7133c87f` 上复跑）；双 `typecheck` 零错误；`audit:decoupling` A–D ✅；开机图闸 **199 文件 / 3,223 KB ≤ 3,225**（3,299,843 B = B3 的 3,281,250 + 本批 18,593，逐文件点名、图内四枚合计与总量精确相等）。
- **内存·`byName` 列式化 MEM-19 / MEM-20（2026-10-30，结清 MEM-9 的尾巴；A/B 口径同上一行——`git worktree add /c/tmp/kojo-baseline 11b274c5 --detach` 起游离树，两棵树**各自独立** `KOJO_MEM_STORAGE_DIR`、同一语料、同一跑法 `--warm --settle 2000 --samples 2`，两趟日志都是 `reused 4258/4258` + `read+parse 0ms` ⇒ 本行差值为真 A/B）**：语料口径 **4,258 文件 / 117,032 名**（`D:\Game\eraTW4.981-261017-EAGLOV3`）。热载 **稳态 126.5 → 115.4 MB（−11.1 / −8.8%）**、索引就绪 **121.5 → 110.4 MB**、`idle` **109.4 → 98.3 MB**、`cond` **127.8 → 116.7 MB**——**四个口径同差 −11.1 MB**，说明省掉的是一块与状态无关的常驻。代价：索引就绪 **1,807 → 1,954 ms（+147 ms）**，来自每定义多 5 次数组 `push`（不是对象分配：试着让 `ErbFunctionDef` 可变、一枚对象复用到底，读数 1,954 → 1,959，**零收益**，已回退，契约保持只读）。
  ① **MEM-19 契约**：`ErbIndex.byName` 由 `Map<string, ErbFunctionRef[]>` 换成 `ErbFunctionLookup`，落在 `plugin-api/src/erb.ts`（与 `ErbFunctionRef` 同源）。**坑先记一笔**：它起先在独立模块 `erb-function-lookup.ts`（10,386 B），`index.ts` 一导出就进开机图 ⇒ **文件闸顶到 200**；并回 `erb.ts` 才守住 199。读法一一对应：`get(n)?.[0]` → `firstOf(n)`、`get(n) ?? []` → `defsOf(n)`、`get(n)?.length ?? 0` → `countOf(n)`、`has`/`size`/`keys()` 原样、直接 `for…of byName` → `entries()`（或 `keys()` + 命中后 `defsOf()`，别让全量遍历为 11 万名字各造一组数组）。构造入口两条：生产侧 `buildFunctionLookup(visit)` 回调喂事实（不要求先物化 `ErbFunction[]`——快照懒外壳靠这条才不用为建索引还原每文件的函数对象）、测试与个位数小表用 `functionLookupOf(iterable)`。语义逐位保留：`keys()` = 归一化名**首次出现序**（旧 `Map` 插入序）、组内序 = 喂入序、缺席 = 没有该键。
  ② **MEM-19 实现**：列式存储 = `keyOrder`（名字，保插入序）+ `bucketOf`（名字→桶号）+ 两枚 `Uint32Array`（每名字一段连续区间的起点/条数）+ `bucketOrdinals`（定义序号流）+ 每定义五列（文件序号 / 起止行 / 名字列 / 注释序号）；`ErbFunctionRef` 对象**只在 `firstOf`/`defsOf`/`values`/`entries`/`forEachDef` 被调用时构造**。**第二笔坑**：第一版写成 `buildFunctionLookup` 里的一段，构建缓冲（`startLines`/`endLines`/`columns`/`defFile`/`buckets` 各 11 万格 + `ordinalsOfName` 里 11 万枚单元素数组）被返回的闭包上下文整体留住（V8 不为闭包按需裁剪作用域）⇒ 稳态反而 **+4.0 MB**（`array (object elements)` 涨 9.2 MB）。拆成独立函数 `collectFunctionFacts` 后缓冲在返回时整层不可达，才落到 −11.1 MB（见 PITFALLS 287）。堆快照对拍（`--snapshot-after` + `heap-aggregate --top`）：`object Object` **201,560 个 / 12.1 MB → 84,497 个 / 3.2 MB（−8.9 MB）**——正是 110,073 枚 `ErbFunctionRef` 没进常驻；`native (ArrayBufferData)` 21.4 → 24.6 MB（新增七枚 TypedArray 约 3.1 MB，抵掉的是上面那 8.9 MB）。
  ③ **MEM-20 生产侧与消费方**：生产构造点全仓只有一处（`erb-parser/src/snapshot.ts` 的 `aggregateIndex`，全量重建与快照复用共用），改回调喂数后净删 1,232 B；`ui-condition-matrix/src/workspace-index.ts` 的 `byNameOf` 同形态改写（工作区索引个位数文件，只为与契约同形）。读法改造 15 处：`erb-parser` 内部 6 处（`symbols` / `arity` / `inlay-hints` / `plugin` 的 `definitionsOf` / `workspace-symbols`）、插件 8 处（`condition-extractor` 引擎、七个 adapter 的 `conventions.ts`——多数是 `.values()` 原样，只有 `erafl` 的 `for…of` 改 `keys()`+`defsOf()`）、app 5 处（`erb-call-hierarchy` / `erb-completion` / `kojo-hover` / `editor-global-providers` / `erb-rename` 的类型标注）。**`kojo2-storage-registry` 与各 adapter `variable-schema` 里的 `byName` 是同名无关物，未动。**
  ④ **MEM-20 测试面**：契约换形态后先有 **57 处类型错误**（多数是 `byName: new Map(...)` 传给 `ErbIndex`），机械改成 `functionLookupOf(...)` 后类型全绿；**但全量跑出 10 个文件 / 58 条运行时红**——`as unknown as ErbIndex` 把类型检查绕过了，`new Map()` 到运行时没有 `defsOf`（见 PITFALLS 286）。真依赖行为的 fixture 全改成 `functionLookupOf`（`erb-hover-dim` / `erb-hover-functions` / `erb-completion` / `find-references` / `inlay-hints` / `arity` / `label-definition` / `label-navigation` / `detail-cache-cap`），`inline-completion-local` 的 `fakeIndex` 走既有 `byNameExtras` 口。
  ⑤ 验证（rebase 到 `f7222bd1` 后重跑，不是旧基底那组数）：单元 **21,398 passed / 143 skipped / 0 failed**（1,102 文件通过 / 23 skipped——较变基前的 21,262 多 136 条、多 11 个文件，全是上游 LAU-4 第二批与 `erb-vocab` 分层守卫那批新用例，本批只改 fixture 未增删）；perf **310 passed / 12 skipped / 0 failed**；双 `typecheck` 零错误；`audit:decoupling` A–D ✅；开机图闸 **199 文件 / 3,350 KB ≤ 3,352**（3,430,610 B = 上游 3,417,916 + 12,694，图内五枚逐文件点名后与总量差 24 B = KB 取整）。**变基这一趟另抓到两条上游新用例的红**：`erb-parser/tests/definition-locals.test.ts` 与 `app/tests/erb-definition-slot.test.ts`（LAU-4 第二步的"标签 → 声明 → 函数索引"序）都用 `byName: new Map(...)` + `as unknown as ErbIndex` 造夹具，正是 PITFALLS 286 那条——编译期绕过去、运行期函数腿答空（`expected [] to deeply equal [2, 9]`），改 `functionLookupOf` 后绿。
- **性能线并入主干（2026-10-31，`b/workbuddy/1029-perf-trunk`）**：这条线放了两个月、落后 `origin/dev` **129 个提交**（中间横着 SDK-B5b 那批"宿主语言面整块搬进插件"）。本地 27 条提交里 **14 条 git 已判"上游已应用"**（同一主题早已进过），真正要重放 **13 条**：6 条代码 + 7 条纯记账（STATE/PITFALLS 的每批读数）。**逐条 rebase 会把同一个语义决定解十几次**（同一条腿在 A/B/C/D 四批里反复动，而上游又重写了它落脚的模块），于是改用**一次三方合并**（`git merge --squash`）解一遍：25 个冲突文件逐个判定，判据是"上游是否已经有一份更好的实现"。
  ① **取上游（性能线那一笔已被取代）**：`erb-parser/src/references.ts`（引用流水由元组数组改成扁平 `(string|number)[]` + `forEachRef`/`KIND_DEFINITION`）、`erb-parser/src/semantic-tokens.ts`（同一 API 的消费方）、`scanner.ts`（上游自己加了 `detachString`）、`plugin.ts`（`slot-service-providers` 那套槽腿装配）、`undefined-name.ts`（`did-you-mean` 已并入本文件，性能线的 `import './did-you-mean'` 落空）、app 的 `editor-global-providers.ts` / `kojo-semantic-tokens.ts` / `erb-highlight.ts` / `languages.ts` / `language-registry.ts`（B3+B5b 之后宿主不再认识具体腿名）。**净效果是"性能线在那几个模块里加的行，上游已经用另一种写法加过了"**，不是丢功能。
  ② **留性能线（上游还没有的）**：①**折叠单源 R5**——`descriptor.structure.folds?: boolean` 新成员 + `providers.ts` 的 `servesStructureFolds()`（ERB 的折叠只由 `erb-folding` 供，结构层不再注册/不再要 `folds`）+ `tree-sitter/client.ts` 的 `absent()` 三档（`not-wanted` / `later` / `lost`：把"压根没要"与"要了没来"分开，前者静默判死、不报假警报）；②**R4b 批量语义诊断**——`erb.semanticDiagnosticsBulk` 任务 + `EditorDecoratorBulkPayload`/`Result` 与 `EditorDecoratorContribution.bulk`（additive 契约，回退路径逐字保留）+ 宿主 `project-diagnostics.ts` 的多块派发（每块 128 上限 / 在飞 4 / 下界 16）；③`arity.ts` 把 `agreedParamsOf(refs, paramsOf)` 从 `arityParamsOf` 里抽出来，批量腿与编辑器腿共用同一条"同名定义是否一致"的判据；④`folding.ts` 的行切分改走 `references.ts` 的 `splitErbLines`（原 `normalizeEol` 已是私有）。
  ③ **破环与文件闸**：R4b 把语义诊断的合并出口拆成独立模块 `semantic-diagnostics.ts`（破 `plugin.ts ↔ offload.ts` 的模块环）——并进主干后它是**第 200 枚进图模块**，撞 `ps10-eager-graph` 的文件闸（顶格 199）。它的消费者只有两处（`plugin.ts` 的 `erb-semantics` 贡献 + `offload.ts` 的批量任务），于是**并回 `offload.ts`**（`plugin.ts` 本来就在 import 它，环不存在），文件闸回到 199。`plugin.ts` 里那份**内联的同名收集器同时删掉**（合并时两侧各有一份，属静默双实现）——现在全仓只有 `offload.ts` 一处。
  ④ **账**：7 条纯记账提交跳过（它们记的是性能线自己的基线，而上游这 129 个提交把 STATE 整段重写过两轮），合并后只写这一条；原文与逐批读数留在 `backup/perfline-1029` 与标签 `backup/perfline-pre-rebase-1031-0903`。
  ⑤ 验证：单元 **21,524 passed / 143 skipped / 0 failed**（1,109 文件通过 / 23 skipped）、perf **322 passed / 12 skipped / 0 failed**；双 `typecheck` 零错误；`audit:decoupling` A–D ✅；开机图 **199 文件 / 3,493 KB ≤ 3,493**（3,576,406 B = 上游 3,537,725 + 38,681，图内九枚逐枚点名）。**性能线自报的读数（未在合并后复测口径）**：400 文件整项目扫描主线程 7,231.6 → 36.9 ms（R4b）、ERB 首解折叠 186.4 → 86.7 ms（R5）、400 文件语义腿 5.9 s → 1.5 s（C 批遗留）。
- **量具·热载稳态读数口径（2026-10-30，MEM-6 同批）**：`tools/mem-readings.mjs` 加**静默判据**（连续 4 次 gc 后采样落在 0.4 MB 内，`--quiesce`）与**两状态分开报**（`idle` = 条件抽取器未跑 / `cond` = 显式 `ensureIndex()` 跑完）。原因：同一份代码同一份语料能读出 202.9 与 298.2 两个"都很稳"的数（差 95 MB），因为热载下抽取器**压根不触发**（3,971 份全复用 ⇒ 零 `kojo.functionChanged`），而它冷重建时另算一个状态——见 PITFALLS 264。**此前台账里只报一个 `steady` 的读数，都要按这条重新理解。**
- 首屏（1016 实测）：dev `htmlParsed 99.9 / firstPaint 444.0 / welcomeInteractive 3740.4ms`；release 终验冷开 `65.9 / 399.5 / 220.9ms`、白屏段 Δ=8.9ms；硬断言只认 **CDP Network 域**（WebView2 页内 `resource` 数不全）。复跑：`node tools/boot-marks.mjs --exe <release exe>` / `node tools/smoke-tauri-dom.mjs`。
- 批量读（合成 2,000 文件 / 160.9 MB）：正文单文件读 **8,000 → 2,000**、IPC **≈16,000 → 48 趟批**；交替开项目不再互踩（修复后首轮冷、此后 200/200）。
- 交互（合成 6,000 行 ERB + 2,000 行 `.kojo`）：装饰同步轮主线程 **0.48 / 0.41ms**、切回未改动标签 **0 次重算**；99,975 函数单扫 3.88ms、六连击搜索串 0.002ms、文件树 3,000 命中一帧行构造 1.06ms。
- 快照两态（口径务必写命中 / 未命中，PITFALLS 80）：**命中**轮索引可用 ~3s；**未命中**轮 ~17s（read+parse + refs 全量重扫）。未命中触发已归因（`tools/snapshot-invalidate.mjs` 受控复现）：失效输入位共 8 处，均为**该失效**而非误判；优化面＝冷启动 fire-and-forget 保存链会被窗口关闭 / 切项目静默丢掉（丢了下次冷进必全量重扫）。**这条已于 E 批·R6 收口（见 §四）：两条退出路径各挂一道落盘屏障；崩溃退出仍会丢整轮。**
- 校验分区复用（PERF-12b/13 落地面，`fe84c44` / 后续止血）：跨文件规则按 `ConventionProjectPartition` 逐文件缓存——合成盘「改一棵 ÷ 全量」校验段比值 **200 棵 0.308 / 2,000 棵 0.459**（改前破 1）；真壳热轮校验段 delta **+37.7ms**（回到位）、预取 4,058ms→1ms、主快照载荷 5.95→1.43MB；体感判据钉「**校验段 delta ≤500ms**」，余下两趟 IPC 合并立项 PERF-14（内核 storage）。等价对拍：`convention-linter/tests/partition.test.ts` 等三份。
- 快照 salvage（PERF-12a，`eeeb631`，`SNAPSHOT_VERSION` 7）：条目级 salvage——rootDir 写法不符 / 单条目损坏 / 条目级差集三面 ≤命中轮 ×3 达成；真·冷与换代面按等价判据须一次全树补扫（非回退）。对拍 15 例 `erb-parser/tests/snapshot-salvage.test.ts`。
- 条件抽取（W8-B/C2 收口）：**99,228 函数中 31,632 含状态依赖**、依赖 165,148、单轮扫描 22–23ms；`1pN` 位字面量、顶层行尾逗号、CASE `{`…`}` 行连接均已按引擎语义收口，opaque **89 → 31**；对账闸 `case-values.corpus.test.ts` + `expr-false-positive.corpus.test.ts`。
- ERB 结构语法（2026-10-26 A2 后，8 盘全量 **14,147 份 / 12,191,015 行**）：ERROR / MISSING / 崩溃 **58 / 0 / 0**，**新增 offender 0**——58 条全是既有：57 条集中在 eraNAS 的 7 份（与 HEAD 基线 157E/6M/14 份逐行同源，本批顺带修好另 7 份）、1 条在 eratw `fromEN/QOL/QoL_Misc.ERB:1907`（基线版同样报），其余 6 盘 0/0；全量解析 70.7s（均 5.0ms/份，逐盘 p95 7.6–55.1ms），wasm 1.03→1.23MB。折叠对拍 erafl 2,128 份：`uncontained` 仍是基线那 5 条（4 条空函数体 + 1 条尾空行），**无新增少折**。增量重解口径（52,603 行档首解 295ms、击键 p95 4.54ms）为 2026-10-20 读数，本批未复测。
- 状态回放（save03 × K49）：未知率 **31.9%**；HK-23 口径拆分＝不可约真随机剥离后**可判定率 83.6%** ＋ **能力覆盖率 80.6%**，基线不变式钉在测试里。
- 结构闸门：**3,971 文件（正文 3,818 + 声明 153）/ 4,126,929 行**零误报；「删 `ENDIF` → 💡 补回 → 复检为零」闭环过。
- `.ERH` 形态（A4，2026-10-26）：8 盘 **648 份**（`ERB/` 下 638；eraSQC 的 `ERB/` 下 0 份）/ 53,867 行 / **34,466 条有效逻辑行**（`#DIM` 32,642 + `#DIMS` 1,660 + `#DEFINE` 164，按 `ReadEnabledLine` 的 `{}` 合流口径计数）；其中 54 份用 `{}` 行连接摊初值表；**不合规 0**（`erb-parser/tests/erh.test.ts` 逐盘闸，解码走 `io.readText`：utf-8-bom 452 / utf-8 179 / utf-16le 17）。
- 编码：utf-8-bom / utf-8 / shift_jis / utf-16 读写往返；golden 六档存档 roundtrip 全等。

## 三、环境与路径（按主机而定；路径类细节不在本文存档）

- 工作树：本 clone 路径按主机而定；同一台机器上可能并存多个工作树——**动别人的树前先问**。
- 真实语料：**认内容不认名**——目录名会被反复重排，且**可能整目录暂离**（不在位 ⇒ 挂语料用例自动 skip，回位后按同口径重测）。一律经 `tools/corpus.mjs` 解析（`--corpus` > `KOJO_CORPUS_DIR` > 扫 `C:\game\*` 筛 `ERB/`+`CSV/`）；**整体只读，零写入是硬约束**。本机语料现于 `D:/Game`（非 `C:/game`），ipc 冒烟须显式传在册语料目录——自动发现会选中未在册盘而 fail-close 拒写，那是设计不是红。
- 语料盘面（ERB 数 = `ERB/` 下 `.erb` 递归计数）：基线盘（4.980）3,818 / CSV 33 / `.als` 19 / `sav` 6 ＝ **本项目全部基线所依据的那份**；改版盘 3,931 / 38 / 20 / `sav` 0；官方盘 4,842 2,223 / 25。
- 存档库：与语料同级的 `eratw-save\sav\` 与语料内 `sav\` 六档逐字节同容（两处均只读；面板读语料内 `sav\`；注入前须去 R，见 PITFALLS §二）。
- 代理：github 直连不稳的环境，给本 clone 配 repo 本地代理（`git config http.proxy <本机代理>`；**永不改全局配置**）；引擎类工具的代理经 `KOJO_GIT_PROXY`。
- 桌面壳：`pnpm --filter @kojo/app tauri dev`；CDP 9222；**同一工作树只能一个桌面实例**。
- 自动更新（REL-1）：签名密钥在构建机 `%USERPROFILE%\.tauri\kojo-editor.key`（**永不入库**；CI Secret = 密钥文件原样单行 base64，再包一层会报 `Missing encoded key`）；`check` 的 `timeout` 单位是**毫秒**、可选 `proxy` 参数；环境代理透传已落地（Rust 读 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 经 `updater_env_proxy` 交前端）；端到端 v0.0.1 已验证，真实 release 待首次发版。

## 四、剩余欠账（数字/方向性的；认领的活在 BOARD.md）

- **v0.4.0-beta.1 发版余项**：真实终端手工勾验（保存闭环 §2.J / 文件监视）+ NSIS **干净目录人工安装勾验**（产物已构建并审计，2026-10-22 `33c02392`；逐步清单在 `MANUAL-CHECKLIST-v0.4.0-beta.1`）；自动更新链路代码侧已闭环，端到端待首次真实 release。
- **B3 语言面收口**：B3c–B3j 已落 dev（2026-10-30 收口：行上注解 / 折叠区间 / 缩进·回车 / 一键迁移 codeAction）；**语义着色（B3 语义收口）与文档级诊断（B3 收口最后一格）同日进槽**——判据在 `@kojo/kojo-lang`（`semantic` / `diagnostics` + `diagnostic-result`）、供方在 `@kojo/plugin-kojo-lang`（诊断走专用槽 `ui.editor.decorator`，宿主只剩调度 / markers 翻译 / 降级；项目级扫描轮 `bulk` 弃权，项目级结论仍只归 `kojo2-project-analysis`），其后是 B5b（删宿主残留）与 LAU-4 余项（ERB 的补全 / 改名 / 调用层级等仍住 `monaco/erb-*.ts`；高亮 / 扩选已进同一槽）。
- ERB 波浪线：结构类与表达式级均已落地（结构 error / 表达式 warning，code `erb.expr-*`）；**CASE/PRINTDATA 条件保守排除**，仍是已知盲区。
- `.kojo 预览`：已交付为常态功能（只读内存 model 原生渲染，默认不开启）；作者-facing 术语统一 `.kojo 语言 / .kojo 预览 / .kojo 校验 / .kojo 转译检查`，口径靠 review 维持。
- **整条性能线曾并入主干（2026-10-29，`b/workbuddy/1029-perf-trunk`；合并落定版见 §二 2026-10-31 条）**：本地 `dev` 当时落后 `origin/dev` **65 条**，17 条性能批（P0-2 冷开 / P0-3 检索与大文件 / 折叠拆闸 / A 批 / B 批）只在本地；一次性变基到 `c8521419`，21 个重叠文件里两处**真语义冲突**——`src-tauri/src/lib.rs`（上游排除规则 WS-10 × 本线并行 `threads`，`walk_consider` 补排除腿与独立计数）与 `tree-sitter/client.ts`（上游 `docIdOf` 号段 × 本线分拍 `postParse`，两者都留）。变基带出**一处真回归**：`tree-sitter-client-real-model` 7 条全红（用例仍发 v3 形状的 `ready`，v4 收件闸要 `docBase`，缺了就整条降级），补上即绿。开机图 **199 文件 / 3,132 KB**，闸 **3,090 → 3,140**：**零新进图模块**，净 **+42,167 B ≈ 41 KB** 全落在图内既有文件（逐枚台账在 `ps10-eager-graph.test.ts`）——这是 17 条**首次到账**，不是单批膨胀。
- **B 批：语义着色走 `edits` 增量 + 首帧三拍（R3 / R8）**：R3 是**两刀**——24,197 行整腿 73.5 ms 里
  `scanFileRefs` 占 **64.7 ms（88%）**、`edits` 通道本身只值 **0.58 ms** ⇒ 先让供方按窗口取数
  （`EditorSemanticTokenRequest.range`）再做通道增量。实测 24,197 行 1 行窗口 p95 **1.25 ms**、
  169,379 行 **3.93 ms**（判据 <3 / <5，整篇对照 84.3 / 355.0 ms）；等价性由 `semantic-token-delta`
  三个 seed × 100 步随机编辑钉成"`edits` 累积 ≡ 逐字节全量"，窗口路径在**切片上重跑判据**不与整篇分叉。
  R8 拆三拍（folds → semantic → indent+syntax）：折叠 **186.4 ms**（判据 <220）、着色 **245.1 ms**
  （改前 392.0）。三拍不劣化的前提是引擎"同一份文本再问一次不重解"那道闸（`parseMs=0`、树身份不换）。
  **欠账**：真壳端到端只到"机制 + 钉子"级——Monaco 0.57 的 `ModelSemanticColoring` 初次取数
  `schedule(0)`（不防抖）、打字走 `RunOnceScheduler` + `REQUEST_MIN_DELAY`（一次停顿一次取数），
  这条"并批"语义已由 `kojo-semantic-tokens.test.ts` 的新钉子覆盖；真壳上的 `edits` 落地读数仍缺。
- **C 批 1/2：项目扫描不算 did-you-mean（R4a，2026-10-29）**：路线图原写"`toEditorProblem` 不带
  `suggestions`"——**不成立**：`EditorProblem` 从来没有这一格，候选在生成那一刻就拼进 `message` 了
  （`buildMessage`）。真实改法是让扫描把 `maxSuggestions: 0` 传下去（旋钮一直在，只是没有调用方）：
  契约 `EditorDecoratorContribution.decorate(file)` additive 加 `bulk?: boolean`，
  `decorateScanFile` 统一传 `true`，`erb-parser` 按它掐掉候选。真语料 400 个 ERB（4.7 MB、6,315 条问题）：
  **1,065.6 ms → 570.3 ms（省 495.2 ms / 46.5%）**，**判据面（条数/位置/severity/code）逐条相等**，
  只少文案尾巴。边界：`index=null` 的**保守**取法（真索引下候选更少、省下的绝对毫秒更少）；
  只测语义诊断这一腿，**不宣称**"整轮 <7.3 s"。**R4b 未开工**：设计已定——批量任务
  `erb.semanticDiagnosticsBulk`（跨文件上下文一次序列化随批带走），扫描循环从"文件 × 贡献"
  翻成"贡献 × 批"，判据 400 文件主线程 <0.5 s + 诊断逐条等价。
- **E 批 · R6：快照保存链——能救的只有"数据还在内存里"的那一拍（2026-10-31）**：路线图 R6 原写
  「落一枚几字节的 pending 标记，启动时发现它就续跑那次写」——**做不出来，也做出来没用**。
  ① 写不进去的原因不是崩溃，是**窗口关闭 / 切项目时没人等那条 fire-and-forget 的 `storage.set`**
  （本文件 §二「快照两态」那条已归因的丢写），进程一退无从续跑；② 真要续跑得带上**载荷**
  （42.68M 码元 / 落盘 54.66 MB），几字节标记指不回来；③ 更关键——`snapshotDirty` 的三个触发源
  （`needsRewrite`／`fresh.size > 0`／条目数 ≠ 文件数）**每轮重算**，丢了一轮下一轮必然重来，
  "续跑"根本不缺执行机会（见 PITFALLS 290，含三场景反证）。**真改法是给保存链加一道能等的边界**：
  kernel `storage` 长出**在飞写登记表** + `flush(timeoutMs): StorageFlushReport { pending, drained, ms }`
  （只等"叫它的那一刻已在飞"的那一批，不等之后新起的写），`kernel.stop()` 末尾也挂一次；
  两条退出路径共用 `flushStorageBarrier`：**关项目**（`closeProjectSession` 开头等 1,200 ms，超时只报
  「还有 N 笔缓存没写完（等了 Xms 先放行），下次打开会重新算一遍」不阻断拆除）与**关窗口**（`window-close-guard` 从两档判据长出
  第三档：无脏也要 `preventDefault()` → 等屏障 → 自调 `bridge.close()`；`WindowCloseBridge` 加可选
  `close()`，无此桥则退回旧行为）。**写本身不必防撕裂**：两枚 bridge 的 `writeFileBytes` 都是
  同目录 tmp + rename 的原子写（Rust `atomic_write` / `NodeBridge`）⇒ 风险面只有"整轮丢失"，从无"快照损坏"。
  读数：一笔写 `set()` **565–619 ms**；写到 343 ms 时叫屏障，多等 **222 ms** 把它等完
  （`pending=1 / drained=true`）；写完之后再叫 **0 ms** ⇒ 预算取 1,200 ms ≈ 两倍余量。
  开机图 **199 文件 / 3,502 KB**（闸 3,493 → 3,502；E·R6 六枚 8,267 B + 家族锚点 `family-index.ts` +1,329 B）。
  **欠账**：①真壳端到端未跑（关闭窗口时确有写、且确被等完，读数全在单元 / Node 探针级）；
  ②只有两条退出路径挂了屏障，**崩溃**（进程被杀 / OOM）仍会丢整轮——那条要靠"写前落标记"但见上文第 ③ 点；
  ③屏障只保证"这一批落地"，不保证"数据是最新的"（更新一轮仍走 `snapshotDirty` 的正常节奏）；
  ④`window-close-guard` 的第三档在 `bridge.close()` 缺席时仍是旧行为，只有 Tauri 那侧提供 `close` 才生效。
- **路线图 v2 复核（2026-10-31）**：F 批（R7 冷开归因 + R10 `perf-ab` 量具）已落地（见 §五）。R7 的旧读数（冷开 10,249 ms）**已被批量路径推翻**：walk **759** / read+parse **3,043** / aggregate **88** / refs 扫描 **7,284 ms**，新量具重取为 read+parse **5,632** / refs **3,011** / 端到端 **11,496 ms**；R10 `tools/perf-ab.mjs`（同树 A/B 出读数、带 `--corpus` 与判据模板）**已交付**。
- **行内提示视口化 + 两处撤闸（A 批，2026-10-28，`5e53a7f8`）**：`EditorInlayHintRequest.range`
  进**输入**（外加 `startOffset` 那一格行首偏移，宿主 `getOffsetAt` 一次二分填），供方只判这一段。
  52,601 行实测整篇 **28–34 ms** → 400 行窗口 **0.44 ms**（文末同价 0.42；不给偏移的老路 2.64），
  判据 <1 ms 达成 ⇒ ERB 的体量闸**删除**。同批撤掉 code-lens 的体量闸（代价曲线是平的：52,602 行
  5.8 ms vs 4,353 行 7.1–9.4 ms）与面包屑的体量闸（24,197 行 parse+符号 4.31 ms）。
  **R9 只撤一处**：`document-words`（4,999 行冷 22.4 / 热 2.6 ms，跑在补全每击键）与
  `TIER_HUGE` 折叠（24,197 行 26.4 / 52,601 行 51.0 ms，每停笔一拍）按读数**保留**，理由从
  "行数"换成"这条路径多久跑一次"。欠账：①真壳端到端未跑（读数全在单元/探针级）；
  ②`document-words` 要撤闸须先做增量索引。回执 `.workbuddy-ai/reports/2026-10-28-a-batch-inlay-window.md`。
- **结构层折叠（2026-10-28 拆闸，`4b88228a`）**：折叠不再按行数让路（`resolveStructureFoldsEnabled` 判据里没有 `lineCount`）；`FOLDING_MAX_RANGES` 5,000 → **20,000**，并与 Monaco 的 `foldingMaximumRegions` 同源（它截是静默的）。真语料 24,197 行有 **8,066 条**折叠区间（改前被截到 5,000）；同批把击键路径从 `getValue()` 差集（**10.7 ms/击键**）改成事件驱动（**0.01 ms**），并修掉"Monaco `changes` 是降序"导致的每次多光标编辑白跑整篇。稳态每击键在 worker 里（24,000 行合成档 32 击）：`folds+indent+syntax` **p50 24.1 / p95 30.0 ms**，四面 36.2 / 42.5 ms ⇒ 放开折叠不占主线程，且按面取数在击键路径上仍省三分之一。**欠账三条**：①真壳端到端复测（24,197 行上折叠可折、击键无长任务）**未跑**，证据只到单元级 + 探针级；②`TIER_HUGE`（≥50,000 行）仍 `folding:false`——那档读数是"折叠一开多一次整篇 copy（9 → 10）"，与时长无关，本批没动；③结构层折叠与插件折叠 99.96% 重合（6,926 条里 6,923 条两套都给）**未合并**，前提是先把缩进规则从折叠那条腿上解耦。
- **启动器设计稿**：`docs/LAUNCHER-ARCHITECTURE.md`（**v0.4，2026-10-26**）＝**现行设计提案、待评审**——不是过时存档，评审与落地以此稿为准；v0.4 是对照实树逐条核验后的修订批（打包改走 `zip.ts::buildZip`、函数级冲突改走 `ErbIndex` + `conventionPolicy`、限额单源改指 `ZIP_EXTRACT_LIMITS` + 共享 contract 表、补开机图 / 产物闸与真壳验收通道、键位改未占用项）；落地前须按其文首建议立 ADR-0008/0009/0010，并把「编辑器不静默改；启动器只做显式、可回滚的插件安装」写进上位文档铁律。

## 五、版图速览（代码地图）

插件 31：`erb-parser` / `eratw-adapter` / `eraakumamaid-adapter` / `eraav-adapter` / `erafl-adapter` / `erakoumakan-adapter` / `erasqc-adapter` / `eratohok-adapter` / `eratohoreverse-adapter` / `convention-linter` / `condition-extractor` / `sav-parser` / `state-replay` / `kojo-lang` / `kojo-market` / `kojo-sugar` / `erb-lang` / `inline-completion-local` / `launcher-core` / `ui-convention-report` / `ui-kojo-navigator` / `ui-kojo-xml` / `ui-market` / `ui-condition-matrix` / `ui-state-replay` / `ui-archive-browser` / `ui-snapshot-injector` / `ui-plugin-status` / `ui-sugar-preview` / `ui-sugar-editor` / `ui-sugar-lift`。
目录结构与关键文件注释见 `docs/ARCHITECTURE.md`；批次回执在 git 提交信息（`docs/log/` 为旧制存档，不再新增）。
- **条件矩阵建索引时的死循环（2026-11 修复，`eratw-adapter/src/family-index.ts::splitAtLastKAnchor`）**：
  症状是"打开项目、等索引时大幅滚动 ⇒ 编辑器彻底卡死"（满核自旋、CDP 投递不进去、`--cpu-prof` 无产物）。
  真因与滚动无关：锚点搜索退到 `k === 0` 后，下一轮 `lastIndexOf('_K', -1)` 被 JS 把负 position
  **钳到 0**，若名字以 `_K` 开头则 `k` 原地不动 ⇒ `for(;;)` 空转。触发形态是「剥前缀后以 `_KX` 开头」，
  而 `_KX` 正是同文件下方显式支持的占位符形态（`/_KX(?:_|$)/`）——不在锚点搜索里止血，那一支永远
  执行不到。eraTW 语料 **120,284** 个函数名里 **4 个**命中。卡死时刻恒等于 `[ix] settled`（索引完成那一拍），
  与是否开文件、是否滚动无关。
  修法两层：`if (k === 0) return null;`（语义修复）+ 把 `for (;;)` 换成 `for (step < (s.length >> 1) + 2)`
  （结构性保险：`_K` 最多出现 `floor(len/2)` 次，有效轮数天然有界）。**理由是失败代价**——该函数跑在
  UI 主线程的微任务里（条件矩阵 `buildCharacterIndex` → `factsOfFile` → 这里），一次不终止就是整个
  编辑器不可用，宁可退化成"拒绝判定"。
  读数：修复前 `活=2 死=32`（3.6s 起永久失联）、`首次失败原因：CDP 超时`、CPU 稳定 **1.00 核**；
  修复后 `活=40 死=0`（60s 全程）、`[ix] microtask-alive / build done / macrotask-alive` 全部恢复、
  `首次失败原因：（一直活着）`。索引本身耗时不变（13.2s / 4,258 文件 / 117,032 函数）。
  测试：`family-index.test.ts` **46 条全绿**（含 4 条新回归用例，用真实触发名 + `timeout: 2000` 做终止性兜底）；
  eratw-adapter + ui-condition-matrix **1,073 条全绿**；`tsc --noEmit` 零错。
  **顺带修好一个更隐蔽的账**：这份 350 行的核心测试文件此前**从未进过主套件**——`tools/perf-suite.mjs`
  会把「含 `performance.now()` + 比较断言」的文件自动划进 perf 池，它因一处计时断言被整份踢出。新用例
  刻意不加计时断言（改用用例超时），已回到功能池（1,133 个文件）。教训入 PITFALLS 291。
  **新欠账一条**：`matrix-store` 的 `refresh()` 把 `rebuild(index)`（全量 117k 函数聚合，实测 **292 ms**）
  直接放在 `ensureIndex().then()` 里同步跑，等于占掉一帧；`navigator-store` 早已用 `scheduleRebuild` +
  `setTimeout` 推到宏任务。同一形态应收口（未做，本批只修卡死）。
- **F 批 · R10 量具 + R7 冷开归因（2026-10-31，`tools/perf-ab.mjs` + `tools/perf-cold-open.mjs`）**：
  性能路线图 v2 的最后一格落地。R10 交付**同树 A/B 量具**：`--a/--b` 接 git ref 或现成目录
  （ref 自动建游离树、自动 junction `node_modules`、自动补探针），交替跑 + 中位数 + 极差，
  A/A 同 ref 时套 **1.00±0.08** 判据。R7 用新量具重取了冷开剖面（真语料 4,258 文件 / 117,032 函数）。
  **三项验收**：①A/A 自证 `total_ms` **1.007**、`index_ms` **1.005**、`build_ms` **1.005**（A 侧极差
  仅 2.0% / 1.8% / 1.6%）；②灵敏度对烤（`--probe-a --parallel --probe-a 0` vs 自动并行）给出
  `total_ms` **0.748** / `build_ms` **0.726** / `seg_refs` **0.582**，且 `parallel_effective` 0→1 自证开关生效；
  ③旧读数被推翻：`read+parse` 不是 3,043ms 而是 **5,632ms**，冷开端到端 **11,496ms**（open 1,049 + index 10,446）。
  **冷开剖面（4 轮中位数，并行 4 槽）**：`walk` 988 · `stat` 2 · `snapshot` 1 · **`read+parse` 5,632** ·
  `aggregate` 181 · **`refs scan` 3,011**（rescan 4,258 全量）· 后台 `lint` 2,265；分段相加 9,812 ≈ `build_ms` 9,866。
  ⇒ **88% 是两遍全量文本扫描**（**修正：全量是 1.17 亿码元**`cache_chars=116,582,751`，这里原写的
  42.7M 是文本缓存的**残留样本**不是全量，两者差 2.7 倍；见 PITFALLS 296⑤），两者都已并行、参数已调优
  （`PARSE_CONCURRENCY` 4 / `REFS_WINDOW` 4 / `READ_BATCH` 64）、逐字符实现也已优化过
  （`tokenCharLen` 有 ASCII 快路径 + 星面字符缓存）⇒ **当前架构下没有安全的低垂果实**。
  `debugCaches()` 实测 `hits 11,141 / misses 4,321`：解析段冷读一遍，refs / 条件抽取 / lint 各走一遍缓存
  ——真正的重复成本是**四次序列化进 worker + 多次切行**，不是盘 IO。
  **探针代表性**：不吃默认参数，必须 `--parallel auto` 才与真实应用同形
  （`bootstrap.installComputeTransport` = `min(核数-1, 4)`）。串行探针会把 refs 段量成 7,605ms、
  端到端量成 17.7s，是真实形状的 1.6 倍——归因若建立在串行读数上会瞄准一个并行下不存在的瓶颈。
  **后续（R7B，2026-10-31 交付）**：这条"88% 是两遍扫描"的归因**在并行形状下不成立**——
  worker 侧全量解析只有 1,225ms（单线程）/ 约 290ms（4 槽摊薄），`read+parse` 段 94% 是**主线程**
  的读盘 2,232 + 解码 1,039 + EOL 探测/归一 1,375。"合并两遍遍历"因此没有 1.5–2.5s 的空间
  （且要"名录先行"多跑一趟，等于贴回去）。R7B 实际交付的是**换行归一收口**（26 份判据 → 1 份，
  `@kojo/plugin-api/eol`）+ `detectEol` 跳跃式 + `readTexts` 冷开不白发 stat：
  A/B 交替 4 轮中位 `seg_readparse` 5,889 → **5,642**（0.958）、`total_ms` 0.991 —— **架构收益大、
  性能收益小**，两栏分开记账（PITFALLS 296）。
  已知偏差：探针的 `walk` 走 `NodeBridge`（纯 Node 递归）比真壳 Rust `walk_consider` 慢，
  988ms 不可直接当产品读数；`cond_ms` 在并行下常抓不到（条件抽取日志被 tail 窗截断），
  属"没量到"而非"没跑"，主判据只用 `index_ms`。
