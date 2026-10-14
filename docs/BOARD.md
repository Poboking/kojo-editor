# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## B. 本组任务（haruki 线）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| HK-4 | UI 打磨（常任；目标「专业 · 克制 · 流畅 · 高效 · 耐看」，VSCode 为基准） | 自拟六项按序推进：UI-1 字号尺度 ✅§5.121 / UI-2 圆角·边框·阴影 ✅§5.122 / **UI-3 图标 emoji→单色 SVG ✅**（`docs/log/2026-10-13-ui-icons.md`；宿主层渲染面归零；插件自绘面板符号＝跨包图标通道是契约问题，留欠账） → **UI-4 焦点环与键盘可达 ✅**（roving tabindex 漫游 + `:focus-visible` 焦点环） → **UI-5 动效可关 ✅**（设置项 + `<html data-motion>`） → **UI-6 底部问题面板 ✅**（ERB 结构/表达式两层波浪线汇总、点击跳源行；状态栏 ✕/⚠/ℹ 计数经 `kojo.problems` 展开，Ctrl+Shift+M）；每项带可复跑量化判据 | 进行中 · 认领：hk4ui 2026-10-14 |
| HK-14 | 条件矩阵面板（状态 × 时机网格；替代被搁置的拖拽可视化视图） | 点格跳源码行；空白格视觉可辨；布局与 `ui-snapshot-injector` 同构（对象选择 → 定位 → 详情三段式）；数据走既有 condition-extractor 的 `StateDependency`，不新造抽取 | 认领：haruki 2026-10-14 |

## D. 已拍板（用户 2026-10-13 反馈批）

- **糖视图**：**不走虚拟文档**（原三问废止）；封存现效果（设置页「显示已封存功能」总开关可临时恢复）；新方向＝「升糖语法直接写进编辑器原生显示、替代原 ERB 代码块」（不保存 / 不改原文件），未立项。

## E. 用户反馈批（2026-10-13 试用反馈，决议性入册）

> 来源：用户对 0.4.0-beta.1 试用后的 13 条反馈（要点摘进各行，关键短语保留原话）。
> **当务之急 = E1**；E5–E8 为修复 / 新增。已拍板的总纲见 §D。

| ID | 任务 | 关键判据 / 口径（含原话摘引） | 认领 |
|---|---|---|---|
| E13 | **报红 · 升糖投影产出「不可写糖形」**（E7② 实测暴露；归 `kojo-sugar` 线） | **现象**：库里主流的「`@M_KOJO_MESSAGE_{COM|SCOM}_K<号>_<i>` ＝ `LOCAL` 信封 ＋ 委托到 `_1`」形态，`liftProject` 投出的是**给人看的显示注记**，不是作者能照抄的糖形。**复现**：取 `049 Satori [さとり]/古明地觉TOKI/古明地觉/M_KOJO_K49_奉仕系コマンド.ERB :: @M_KOJO_TOKI_MESSAGE_COM_K49_88_1`，或 `101 Tokiko [朱鷺子]/朱鷺子/M_KOJO_K101_絶頂 .ERB :: @M_KOJO_MESSAGE_PALAMCNG_B_K101`，把投影结果原样贴进 `.kojo` 保存。**期望**：投影输出即转译零 error 的可写糖形。**实际**：报 `indent-mismatch`（`LOCAL = 1` 留在 0 列、块体没缩进）＋ 中文指令名查不到。**屏上原样文案**：`时机 指令 88_1（TOKI版）：`、`时机 指令 317_1（RBK自制版）：`（`kojo-sugar/src/lexer.ts:367-408` 只认纯数字编号或纯中文指令名，这种 token 会被当指令名去查表）。**可借用判据**：`packages/plugins/eratw-adapter/tests/scaffold-cases.test.ts` 的「可写性守卫」（案例拼成最小文档过真实转译、零 error）及其自证用例。受影响面＝性交指令 / 奉仕指令 / 爱抚指令 / 绝顶，这四面脚手架案例按**宁缺勿编**暂缺，E13 修好即可补上 | 待认领 |
| E16 | **报红 · 糖条件里两类标识符解析墙**（E15 通读实测暴露；归 `kojo-sugar` 线，方案见 `docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md` §3.0 / P-10） | **现象 A（只报不纠，最坏的一类诊断）**：`如果 NOWEX:Ｃ絶頂 == 3：` 报 `unknown-identifier`，但**转译产物仍逐字正确**（`IF NOWEX:Ｃ絶頂 == 3`）——全角拉丁字母 `Ｃ` 把标识符切断。四面族受影响 **2,471 处 / 152 份**（`Ａ/Ｂ/Ｃ/Ｖ/Ｍ絶頂` 全家，`Ｃ絶頂` 525 处）。**根因**：`kojo-sugar/src/expression.ts:43-45` 与 `src/system-functions.ts:90-92` 两处 `isIdentPart` 副本的类表缺 `\uFF21-\uFF3A\uFF41-\uFF5A` ⇒ **两处一起改 + 一条 golden**。**现象 B**：`SELECTCOM` / `PREVCOM` 这类**无族头的引擎全局**不可写（`如果 首次(SELECTCOM)：`、`当 SELECTCOM： 是 接吻：` 均报 error），退路 `别名 当前指令 = SELECTCOM` 也在声明处报同一码——**别名目标自己就要能解析**。**根因**：`src/index.ts:313-318` `resolve` 只认族头 ⇒ 需加常量白名单（ERB 通用标识符，零游戏名词入内核）。**屏上原样文案**：`未定义的标识符「SELECTCOM」——若它是自定义变量名或角色引用，请先在文件头用「别名」声明。`。**复现最小文档**：`角色: 1` + `时机 绝顶：` + `如果 NOWEX:Ｃ絶頂 == 3：` + 一行台词。**另附同族缺口（不在本行必修）**：`resolve` 族头直通 ⇒ `如果 NOWEX:噴乳乳瞎写：` 实测**零 error 并进产物**（违铁律 4），修法见方案 P-10③（预量代价：表外名仅 132 次且几乎全是注释残片 ⇒ 先 warn 后 error）。E13 修好不等于本行修好，两条独立 | 认领：haruki 2026-10-14 |
| E17 | **随机块「一档多句」边界写清 + `当 RAND:n：` 缺档诊断**（方案 1，语法零改动；全文 `docs/SUGAR-RANDOM-CANDIDATE-PROPOSAL.md` §2） | ① 教程⑬（`tutorial-content.ts:446`）补「候选=一行；一档说多句改用 `当 随机数：`」+ 对照迷你例——样例受溯源守卫管：先加 `fixtures/sugar/teaching-full.kojo`、`TEACHING_GOLDEN_WRITE=1` 真链路重生成 `.expected.erb`（**禁手写 golden**）；② 新增诊断 `rand-case-incomplete`（error）：`当 RAND:n：`（常量 n≥1、无 `否则`）档位未盖满 0..n-1——实测现在**零诊断静默**（`当 RAND:3：` 只写两档通过，掷到 2 永远沉默）；③ SPEC §3.6 边界句 + §8 lint 表加行。验收：全量不回退 + 双 typecheck + audit + teaching 链路真跑 | 待认领 |
| E18 | **`随机：` 候选组 `组：`（方案 2；一档多行）**（全文 `…PROPOSAL.md` §3） | `组：`+缩进多行 = 一个候选（英别名 `group`；空组报错；`组：` 后不跟内容报错）。落点全为既有扩展点：`plugin-api/sugar.ts` additive 契约 + `keywords.ts:47` 一行（高亮/补全自动派生）+ `lexer.ts` 块头 + `parser.ts`（groupBlock / isBlockNode / mergeBlockBody）+ `codegen.ts:973` 透传；lift 多行体改产 `组：`（E18b：探针 E 形 `roundtrip-mismatch` 转自证通过）。与 E17a 同域（⑬章 + teaching fixtures）→ **串行认领、后到 rebase**。验收：混排/空组/组内注释单测 + 全量不回退 | 待认领 |

## F. 调试/验证强化线（k12cli 会话立项，2026-10-14；E1 的延伸）

| ID | 任务 | 关键判据 / 形态（已定死，勿再议形） | 认领 |
|---|---|---|---|
| V3 | **title fatal 定位（timebox 30 分钟）** | 关兼容开关「解釈不可能な行があっても実行する」跑 V1 镜像抓 file:line；仍无行号→给自建 SKIA fork 打 error-事件带行号补丁（引擎自己编，永远有兜底）。结论二选一：可绕→title 流程并入 V2 场景面；不可绕→板上钉"加载实测=SKIA 天花板"止损 | 待认领 |
| V4 | `verify engine-setup`（引擎资产入库） | clone gitgud `develop-skiasharp`（直连/代理交替）→ `dotnet publish` → 落 `KOJO_CLIDBG_DIR`；缺 SDK=FAIL+winget 提示，**不自动装** | 待认领 |
