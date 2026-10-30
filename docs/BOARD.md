# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**：认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**。
> 报红格式：现象 + 复现 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表。
> **分支模型**：`dev`＝日常落地窄门，`main`＝发行版（只发版时并入并打 tag）。批次分支从 `origin/dev` 起，落地 `git push origin HEAD:dev`；**永不** force 到 `dev` / `main`。

## 在办

| ID | 任务 | 关键判据 | 状态 |
|---|---|---|---|
| MK-PUB | **市场发布通道**：编辑器一键上传 zip → CF Worker 校验 → R2 `pending/` → 自动开 PR 到注册表仓（merge=放行）；客户端 additive：publish 意图/进度事件 + Rust publish 命令 + 上传主机闸 + `ui-market` 发布面板。Worker 独立仓 `DSH/kojo-market-worker`；不动 `MARKET_DEFAULT_INDEX_URL` 与 ADR-0007 封闭集 | Worker 全链 curl 可验证（签 token→上传→pending→PR）+ 全量不回退 + 双 typecheck + audit + cargo；新文案中文 | 进行中 · 认领：claude 2026-10-16 |
| POS-UTIL | 位置换算收口：tree-sitter 0-based 行/UTF-16 码元、Monaco 与 plugin-api 1-based 行、range 端点各写各的。**否决** CST↔AST `PositionMapper`（`.erb` 无 CST、`.kojo` 的 tree-sitter 可选且默认关），只收口边界换算 | 所有行列/区间换算走同一模块；覆盖 CJK、emoji、CRLF、折叠行；不新增运行期节点身份映射或第三套坐标系 | 进行中 · 认领：lead 2026-10-20 |
| ERB-PARITY | **ERB 是一等语言**，不是 Kojo 的附属：语言注册 / 服务 / 树叠层 / 默认语言与能力矩阵都不得只给 Kojo | ERB 与 Kojo 走同一 descriptor/registry/engine；ERB 直写不依赖 `.kojo`；provider 双语言对齐；tree-sitter 按 descriptor 选。**2026-10-31 审计差 9 条（G1–G9），已修 G1（ERB 悬停进槽）/G3（implementation 槽腿）/G4（kojo2 workspaceSymbol）/G6（只读门按 descriptor 声明位）/G7（改名候选 ⊆ 可改集合）/G8（右键语言族按 descriptor）/G9（文档链接按行注释记号判语言），另加 ERB 查引用与补全余项进槽；余 G2（ERB 排版判据本就在 `plugin-kojo-sugar`，只欠注册面进槽——缺"请求带语言身份"的前置，属架构余项）、G5（kojo2 无 structure descriptor，裁决豁免） | 进行中 · 认领：lead 2026-10-20（基础设施已拉平） |
| TUT-UGUIDE | 内置教程已按 2.0 设计稿补齐，但 `docs/USER-GUIDE.md` 全文 0 处提 2.0 ⇒ 手册只讲 v1 | 手册写清「默认档＝只认 v1 / 切档才认 2.0 / `.kojo2` 无落盘产物」；**只改冲突行** | 待认领 · 来源：chief 2026-10-22 |
| CMD-NUL-BYTE | `ui/commands.ts` 是全仓唯一带裸 NUL 的文件（缓存键分隔符）⇒ 被 `file` 判成二进制、NUL 后行对文本扫描失明 | 换成 `\u0000` 转义形态；改完 `fs.readFileSync(p).includes(0)` 为 false、`grep -c nonce` 仍得 6、`ps14-source-cache.test.ts` 全绿。⚠ 别用 Edit 直写（参数层转义会吃掉），用脚本落 | 待认领 · 来源：chief 2026-10-22 |
| MK-SMOKE-RECAL | `smoke-tauri-market.mjs` 本机 4 红：f2/g/h 锚点钉了会变的外部注册表内容；k 的容差（300ms）踩在自己的采样噪声上 | f2/g/h 改为「schema 合规 + 远程与盘上自洽」，锚点只钉本仓可控内容；k 容差 > 2×采样间隔。**不许**为凑绿放宽功能断言 | 待认领 · 来源：chief 2026-10-22 |
| PERF-KOJO2-ANALYSIS | `kojo2-project-analysis.test.ts`「万级 @函 判定中位数 ≤100ms」反复贴阈值；同族 `tree-sitter-parse.perf.test.ts` p95 红绿跟「谁先占满机器」走。定责：import 面只有 `kojo-core` + `app/src/ui`，与适配器零交集 | 判红口径：先看「退回整篇的击键」有无内容，再同机对拍两棵树各跑一次；空闲独跑读数入回执 | 进行中 · 来源：多游戏批 2026-10-26 |
| K2-CORE-PKG | `packages/kojo-core` 布局与 audit 放行（非插件库，B/C 项不拦）；§15.2 复用清单核对与偏离记账 | audit A–D ✅；单文件转译纯函数 | 进行中 · 认领：lead 2026-10-21 |
| K2-PRE-REUSE | 旧后端复用面余项：**①心形字面量编码器 ④诊断列折回物理行（与 POS-UTIL 合流）**；②③⑤ 已落 dev | 每条红→绿用例；只修复用面；全量不回退 | 待派 · 来源：语言实现审阅 |
| K2-RELEASE | R9 发布闸：core/eraTW/program/UI gate + STATE/BOARD 落账 + 双 typecheck/audit + 真实工程人工验收 | eraTW 完整体验；反向回滚可用 | 待认领 |
| K2-INCR-HOLES | 增量已知洞：`选项`/BOM 粘性永久全量；整份替换 / 改 `# 视角` 仍整份重建（~200–300ms）；声明单元内编辑 55–75ms；槽族正则只覆盖 `rand/foreach` | 每次退化可见；与全量逐字节等价不破 | 待认领 · lead 2026-10-22 |
| K2-CORPUS-SOURCE | 真实语料机没有输入：eraTW 4.980 基线盘无 `.kojo`（发现 0 份）；需把 `KOJO_CORPUS_DIR` 指向含 v1 作者源的工程或迁移快照盘后重生成 golden | 发现 ≥1 份 `.kojo` 且状态/原因分类可读 | 待认领 |
| LAU-BLOCKED | **LAU-1 / D2 / 6 / D3 / 2 / 5 已交付**（回执在提交信息）。**2026-10-31 收口波：LAU-4 已落定义/改名/补全（全部 facet）/高亮/扩选/调用层级/implementation/查引用/悬停；SDK B4/B5 已落，B5b 车 1–6 已落**。余项：ERB 排版注册面（判据已在 `plugin-kojo-sugar`，ERB-PARITY G2，属架构余项）；LAU-D4（方言包 + 翻译）未开工；LAU-5 余项：kojo2 自有 worker 不进池（自有协议） | 见各批回执 | 已交付余项 · 2026-10-31 |
| LAUNCH-L7B | core 插件源码项目 `PluginProjectService`：工作区项目、`buildZip` 确定性打包、`launcher_project_hash` 摘要、drift 报告 | 同内容两次打包逐字节相同；源码/产物分离；三条写边界；`launcher_project_hash` / `launcher_runtime_*` 宿主命令须先补 | 待派（依赖 L7A 清单，已落） |
| LAUNCH-P0-RESIDUE | P0 真壳验收余项：② ~10 MB fixture 复制进度；③ 同实例二次 `start` 报 `LAUNCHER_INSTANCE_BUSY`；⑤ 原生信任框确认后启动、篡改报 `TRUST_CHANGED`；⑥ 应用退出杀树 + 下次显示 `app-exit`；① 「经 UI 建 shared 实例」现只由夹具播种覆盖 | 全部在真壳（`debug-cli shell`）取证；⑤ 无人值守点不了 ⇒ 改宿主侧命令取证或如实标 SKIP | 待派 |
| SDK-B5b | 删宿主语言面残留：2.0 宿主文件 **51 枚 / 23,797 行**（语言面 24 / 9,672 行；结构层 8 不算残留）。**2026-10-31 车 1–6 已落**：新建 `monaco/slot-service-providers.ts` 槽腿工厂，删 9 枚 `installKojo2*`（补全/悬停、格式化两腿、签名、引用、改名、高亮、扩选、CodeLens、CodeAction），缩进 on-type 定为引擎面；宿主不再直装上述语言面，M2 142→128 | 宿主不再直装语言面；结构层 8 文件与 `.kojo2` 旧扩展兼容**不算**残留。**余** C 类 8 文件 / 4,954 行（callhierarchy 1,531 行 / dialect-lint / project-index / project-analysis / model-language / problem-sync / diagnostics-gate / scan-adapter）待逐条定"进包 / 留宿主事实" | 进行中 · 认领：lead 2026-10-31 |
| AE-GHOST | `button.ghost` 悬停吃基类实心灰（全站 90+ 处）；改法会压掉三处组件自写标定 | 先给组件自写悬停档让位（`@layer` 基座档或 `:where()` 低特异），再收这一档；不许直接压特异性 | 待认领 · shiori 2026-10-27 |
| AE-SPLIT4 | 六条把手热态色不齐：`.editor-divider` 的 `:hover`/`:active` 共用中性灰；`.dock-cell-resizer` 悬停零反馈 | 先由 `styles-wash-token-discipline.test.ts` owner 把口径从「终值对拍」迁到「落点在册」，再拆块接 `--split-hot` | 待认领 · shiori 2026-10-27 |
| AE-SCROLLFADE | 滚动区边缘渐隐同一份配方抄四遍（editor-tabs / tree-groups / nav-tree / ksp-results） | 由 `ui-chrome-polish.test.ts` owner 把判据迁到「读类名在册」，再落 `--scroll-fade` 单源 | 待认领 · shiori 2026-10-27 |

> 已裁定/已交付行（K2-D0、K2-CONTRACT、SDK-B5a、多游戏适配 P0/P1、编辑器对标 A–E、PS 系列）已删，回执在 git 提交信息。