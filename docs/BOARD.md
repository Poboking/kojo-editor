# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

> ⚠️ **分支模型（2026-10-19 生效，全组必读）**：`master` 已停用并从远端删除。
> **日常落地分支＝`dev`**（一切功能 / 修复 / 文档批的窄门出口），**`main`＝发行版分支**（只在用户点头发版时并入并打 tag）。远端默认分支＝`main`。
> 新批次分支一律从 `origin/dev` 起（先 `git fetch origin --prune`）；落地命令 `git push origin HEAD:dev`。**禁止** `git push … :master`——GitHub 会把它当新分支**创建**（详 PITFALLS §133）。`gh pr create` 日常批须显式 `--base dev`。

## 在办

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
| MK-PUB | **市场发布通道**：CF Worker 上传链——编辑器内一键上传 zip → Worker 校验（schema v1 同判据）→ R2 `pending/` → 自动开 PR 到注册表仓（merge=放行，GitHub 网页即审核后台）；Pages/CI/注册表仓保留原职（兼容源 + 第二道闸），拉取双源回退；Worker 独立仓 `<本机>\DSH\kojo-market-worker`（域名 `market.3625735381.xyz`，开发期 workers.dev）；客户端 additive：契约层 publish 意图/进度事件（照 `MarketDownloadProgress` 形态）+ Rust publish 命令（POST+token+Channel 进度）+ 上传主机闸（allowlist 扩 workers.dev 与自定义域）+ ui-market 发布面板（选 zip→本地 `parseManifest` 预校验→上传→状态行）；不动 `MARKET_DEFAULT_INDEX_URL`、不碰 ADR-0007 封闭集（仍只发声明式数据包） | 判据：Worker 侧 curl 全链可验证（签 token→上传→pending 落 R2→PR 开出）+ 本仓全量不回退 + 双 typecheck + `audit:decoupling` ✅ + cargo；新文案一律中文、拒因人话照 `PLATFORM_FAIL_TEXT` 形态 | 进行中 · 认领：claude 2026-10-16 |
| POS-UTIL | 位置换算分散：tree-sitter 的 0-based 行与 UTF-16 码元、Monaco / plugin-api 的 1-based 行、range 端点各写各的；**否决**前一版建议的 CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关 ⇒ 映射表会空或过期），只收口边界换算 | 判据：所有行列/区间换算走同一模块；边界测试覆盖 CJK、emoji、CRLF、折叠行与生成映射；不新增运行期节点身份映射或第三套坐标系；语义服务与编辑器读数不变 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是主用户群的一等语言，不是 Kojo 的附属/实验位**：口上作者可以直接写 `.erb`，`.kojo` 是可选糖而不是入口前提；语言注册、语言服务、树层叠层、默认语言与能力矩阵都不得只给 Kojo | 判据：ERB / Kojo 走同一 descriptor/registry/engine 基础设施；ERB 直写不依赖 `.kojo`；宿主 provider 双语言对齐（`registerForLanguageServices` 口径）；tree-sitter 能力按 descriptor 选择而非语言名硬编码；不得因 Kojo 特性降低 ERB 默认体验 | 进行中 · 认领：lead 2026-10-20（A3/A4 基础设施已拉平；ERB 结构层已接入、pref 默认仍关） |
| TUT-UGUIDE | 内置教程已按 Kojo 2.0 设计稿补齐（1177b417 / f1554004 / 98c2b044 / cad84d27），但 **`docs/USER-GUIDE.md` 全文 0 处提 2.0**：手册只讲 v1 那条路，而编辑器里已经有第四张教程卡与「文件格式」那一档 ⇒ 两处口径不一致（唯一交叉引用 `USER-GUIDE.md:404` 指的「.kojo 语言教程」第⑪节仍对得上，未受影响） | 判据：手册把「默认档＝只认 v1／切档才认 2.0／`.kojo2` 无落盘产物」三件事写清，**只改冲突行、一行算一行**（§五 文档纪律），不许顺手重写整本；教程那四本已按实现写，手册以它们为准 | 待认领 · 来源：chief 教程批收口 2026-10-22 |
| CMD-NUL-BYTE | `packages/app/src/ui/commands.ts` 是**全仓 1591 个文本文件里唯一带裸 NUL 字节的**（第 275 行缓存键 `` `${nonce}<NUL>${roots.join('\n')}` ``，偏移 12293/12806）⇒ 文件被 `file` 判成二进制、**NUL 之后的行对基于文本扫描的工具失明**（grep/ripgrep/review 脚本一类）；TypeScript 与运行都不受影响，纯卫生与可审性问题 | 判据：一行改动把裸 NUL 换成转义形态（语义逐字节等价，运行期分隔符仍是同一个 `\u0000`）；改完 `node -e "fs.readFileSync(p).includes(0)"` 必须 false，且 `grep -c nonce` 仍数得出 6 处、`ps14-source-cache.test.ts` 全绿。**⚠ 别用 Edit/Write 硬试**：本会话两次尝试都被参数层的 JSON 转义吃掉（一次把 `${nonce}<NUL>` 写成 `${nonce}\u{0}U0000`＝分隔符从 1 字节变 6 字节，一次 0 occurrences），已 `git checkout --` 逐字还原；请用脚本落这一格（见 MEMORY「Edit 工具转义坑」） | 待认领 · 来源：chief 0.4.2-beta.2 实机测试 2026-10-22 |
| MK-SMOKE-RECAL | `smoke-tauri-market.mjs` 本机 4 红（2026-10-22 发行前实测）：f2/g/h 三条 = **锚点过期**（`ANCHOR_BYTES=1612` / `ANCHOR_SHA256=f1b72c01…` / 期望 2 条包，线上实测 4,141 B / sha `e100bb76ea79` / 6 条包——社区投稿已进注册表，钉的是**会变的外部内容**）；k 一条 = **判据踩在自己的采样噪声面上**（`intervalMs=300` 却判「行消失 ≤ 目录消失 + 300ms」，实测 469ms / 2,013ms 两跑皆红，功能面逐字节与记账全对） | 判据：f2/g/h 改成「schema 合规 + 远程与盘上逐字节自洽」为准、锚点只钉**本仓可控**内容（外部注册表内容不钉 sha，或按 `fetchedAt` 分档）；k 的容差须 > 2×采样间隔，或改钉「同一轮内行消失前无二次轮询」这类与粒度无关的判据——**不许**为凑绿把功能断言写松 | 待认领 · 来源：chief 发行前实机测试 2026-10-22 |
| FIX-SUGARJIT | **.kojo 预览开启后恶性崩坏四联**：①编辑界面异常抖动 ②鼠标指针在文本/指针样式间高频抽搐 ③编辑区无法上下滚动 ④语法高亮全灭全白；用户跟进：**所有文件都无法编辑**且抖动既现 ⇒ 疑似编辑器反复重挂载 / readOnly 循环级渲染环 | 判据：四联全消（不抖动 / 指针不抽搐 / 可上下滚动 / 高亮正常）且所有文件可编辑 | 进行中 · 认领：gvm 2026-10-17（dev 基线重建时从旧 master 线迁入：git log 未见交付、dev 看板原未登记） |

## 在办 · Kojo 2.0（设计基线 v0.9）

> **依据**：`docs/KOJO-2.0-LANGUAGE-SPEC.md`（v0.9 设计稿+任务清单合并入库版）。
> **已定**：开发期双前端并存、发布态单一模式（CUTOVER 单批收口）；旧前端只修会被 2.0 复用的后端面。
> **批次一~九已全部落 `dev`**（core 包/程序层/存储·项目·语义接线/迁移引擎含语义升级/切流阶段/编辑器 provider 全量/项目索引/真实语料机/体感验收矩阵），完成行已删、回执在提交信息。

| ID | 任务（落点） | 关键判据 / 已实测事实 | 状态 |
| K2-D0 | **设计冻结与结构裁决**：D0.1–D0.11 + 4 项结构前置落字；定包归属/审计放行、项目级分析层、存储期分配器、多时机拆文件；定旧前端退役时点 | 决策逐条落字；C1 已按 §4.8/§4.13/§10.3/§10.7 约束实现，待追认 | 进行中 · 认领：lead 2026-10-21 |
| K2-CONTRACT | 2.0 契约面：现落 `@kojo/kojo-core`（AST/诊断码/source-map/GameAdapter），**与设计稿 C1.2「扩 plugin-api」的落点偏离**待 D0 裁决；需评估是否 additive 镜像到 plugin-api | additive、旧消费方零改动；双 typecheck；core 零游戏名词；fixture adapter 仅依赖契约编译 | 进行中 · 认领：lead 2026-10-21 |
| K2-CORE-PKG | core 包布局与 audit 放行：`packages/kojo-core` 已建（非插件库，B/C 项不拦）；§15.2 复用清单核对与偏离记账 | audit A–D ✅；复用点可核对；单文件转译纯函数 | 进行中 · 认领：lead 2026-10-21 |
| K2-PRE-REUSE | 旧后端复用面缺陷余项：**①字面量编码器（心形 `@"…"`）④诊断列折回物理行（与 POS-UTIL 合流）**。②③⑤ 已落 dev（`c11cb3d4` 注释穿透 / `08ac046d` 回读回滚 / `51eef191` CJK 函数头） | 每条红→绿用例；只修复用面；全量不回退；①④ 由 lead 定派 | 待派 · 来源：语言实现审阅（① 本组认领后遇 429 未开工） |
| K2-RELEASE | R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真实工程人工验收 | P0 全完成；eraTW 完整体验；反向回滚可用 | 待认领 |
| K2-INCR-HOLES | 增量已知洞：`选项`/BOM 粘性永久全量；整份替换/改 `# 视` 仍整份重建（~200–300ms）；声明单元内编辑 55–75ms；槽族正则只覆盖 `rand/foreach`；构建期自检冷路径 ~300ms | 每次退化可见；与全量逐字节等价不破 | 待认领 · 认领：lead 2026-10-22 |
| K2-CORPUS-SOURCE | 真实语料机**没有输入**：本机 eraTW 4.980 基线是纯游戏盘（无 `.kojo`，递归发现 0 份）；`corpus` 工具已就绪（缺席 rc=2 / 0 份 rc=1 不当绿），需把 `KOJO_CORPUS_DIR` 指向含 v1 作者源的工程或迁移快照盘后再重生成 golden | 发现 ≥1 份 `.kojo` 且状态/原因分类可读 | 待认领 |

## 在办 · 编辑器体感对齐（ERB / kojo2 同权 · 2026-10-22）

> **原则**：ERB 与 kojo2 同为一级语言，能力矩阵由 descriptor 声明 + `LANG-PARITY-GATE` 钉住；禁止"某 provider 只挂一门语言"。

| ID | 任务（落点） | 关键判据 | 状态 |
|---|---|---|---|
| LAUNCH-L1C | 契约收口（L3D 报的端到端断点）：内容/存档 16 条宿主形状进 `plugin-api` §7、内核透传补全、launcher-core 删掉局部重复定义 | 有 P1 方法的假桥装配后 `saves` / `content` 都是真实现；launcher-core 314 例零回退；ps10 不涨 | 进行中 · 认领：qoder-l1c 2026-10-26 |
| LAUNCH-UI-CONTENT | 视图「内容包」面板：已装列表 / 两阶段安装（计划读数 + 冲突选择）/ 启停排序卸载 / 诊断四组 | 组件自取数、不碰原生对话框；纯函数 ≥16 例；开机图不涨 | 进行中 · 认领：qoder-uic 2026-10-26 |
| LAUNCH-UI-SAVES | 视图「存档」面板：按根分组 / 备份 / 恢复（先自动备份）/ 导入预检 / 导出 | shared 未授权根明确拒绝、无"强行恢复"；纯函数 ≥16 例 | 进行中 · 认领：qoder-uis 2026-10-26 |
| LAUNCH-UI-PLUGINS | 视图「游戏插件」面板：已装列表 / 风险与兼容徽标 / 信任 / 启停 / 顺序 / 冲突解决 / 源码项目入口 | 高风险未受信不得安装；函数级冲突按「预期重复」分档展示 | 待派（依赖 L1C 与 L7a/L7b） |
| LAUNCH-L9 | 端到端联调（真壳）：隔离 appData 里种一个夹具实例（宿主现算哈希的信任记录）→ 启动 → 日志有行 → 停止 → 无孙进程；失败路径逐条可见 | 真壳读数（非 Web 调试宿）；不碰真游戏目录；`launcher-smoke` 的 5 件判据逐条落地 | 待派（依赖 L1C / L3D） |

## 在办 · 语言面统一（LAU · 2026-10-25，组长 krosama）

> 规格来源 `docs/ARCH-language-unification.md` **v1.1**（附录 A 有 v1.0→v1.1 的 21 条逐项对照）。
> 七路批（LAU-0/1a/GATE/2a/6a/SYNTAX/FIXTURE/D1a）已落 dev，交付回执在各提交信息里，本表行已删。

| ID | 任务（落点） | 关键判据 | 状态 |
| LAU-BLOCKED | **未排的两枚，卡在人不在码**：LAU-1（协议 v3）与 LAU-D1b（方言解析链上屏）都要等 **K2-CONTRACT / D0** 定契约落点（`plugin-api` vs `kojo-core`，本表第 30-31 行 lead 认领）；LAU-3 / LAU-4 与本表 ERB-PARITY、SDK B4/B5 同文件，须串行 | 落点定了才开实现批；在此之前谁动 `structure-protocol.ts` / `semantic-roles.ts` 的落点都是抢裁 | 待 D0 裁决 · krosama 2026-10-25 |

## 在办 · 启动器落地（2026-10-26，组长 qoder）

> 规格来源 `docs/LAUNCHER-ARCHITECTURE.md` **v0.4**（对照实树修订批，已落 dev `55c0e60b`）。
> 分批顺序见该稿 §15 / §17；**本表由组长统一管理**——车道不直接改 BOARD（五路并发同文件必撞），
> 交付仍按 §五 删行、回执写进各车道提交信息。

| ID | 任务（落点） | 关键判据 | 状态 |
|---|---|---|---|
| LAUNCH-L3B | Rust 宿主内容/存档命令：`launcher_content_*` 七条 + `launcher_save_*` 八条 + `launcher_pick_archive`（staging 两阶段 / ownership / 逆序回滚 / 基础快照不覆盖 / shared 授权根复验） | `cargo test --lib` 绿；ZIP 复用 `archive_guard::extract_staging`，不自造解包器 | 进行中 · 认领：qoder-l3b 2026-10-26 |
| LAUNCH-L3C | 桌面壳桥：`PlatformBridge.launcher` 接 L3a 已存在命令 + 四条事件；Node 桥缺席（= 无此能力） | 命令名/载荷键逐字断言；DTO camelCase 映射；错误码透传 | 进行中 · 认领：qoder-l3c 2026-10-26 |
| LAUNCH-STOP | 优雅停止：`WM_CLOSE` → 优雅期超时 → `TerminateJobObject`；`lastExit.reason` 区分 `user` / `killed` | `force=false` 无窗口子进程不得空等默认 5 s；stopping 期重复 start = BUSY | 进行中 · 认领：qoder-stop 2026-10-26 |
| LAUNCH-L7A | core 插件门禁 `PluginManager`：能力/兼容/函数级冲突（`normalizedName` + `conventionPolicy`）/风险分级/存档影响/依赖，写盘委托内容包管线 | ≥26 例；真冲突与「预期重复」两类分钉；高风险未受信拒装 | 进行中 · 认领：qoder-l7a 2026-10-26 |
| LAUNCH-GATE | 闸与通道复核：懒加载新视图是否动开机图；`smoke-tauri-ipc` / `debug-cli shell` 可用性与 launcher 判据插入点 | 开机图读数逐字引用；通道 rc 实测；零生产码改动 | 待派 |
| LAUNCH-L7B | core 插件源码项目 `PluginProjectService`：工作区项目、`buildZip` 确定性打包、`launcher_project_hash` 摘要、drift 报告 | 同内容两次打包逐字节相同；源码/产物分离；三条写边界 | 待派（依赖 L7A 的清单类型） |
| LAUNCH-L9 | 端到端联调：真宿主 + 真壳（`debug-cli shell`）跑「建实例 → 信任 → 启动 → 装内容包 → 存档恢复」，并把 launcher 判据插进 `smoke-tauri-ipc` | 真壳读数（非 Web 调试宿）；失败路径逐条可见 | 待派（依赖 L3B/L3C） |
