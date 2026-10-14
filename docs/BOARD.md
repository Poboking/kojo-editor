# BOARD.md — 在办看板（活的：完成即删行，历史由 git 保留）

> **协议**（2026-10-13 二改：文档只做认领与交付）：
> ① 认领 = 写一行「认领：<主机> <日期>」；交付 = **删行**，回执（读数 + 取舍）**写进提交信息**，不另写文档。
> ② 报红格式：现象 + 复现步骤 + 期望 vs 实际 + **屏上原样文案**。跨主机沟通只有这张表——写在别处的反馈等于没写。
> ③ 人工勾验 / 封存 / 性能线三类行**不设**（用户 2026-10-13 令）；已收行不在此表，历史由 git 保留。

## B. 本组任务（haruki 线）

| ID | 任务 | 关键判据 / 已实测事实 | 状态 |
|---|---|---|---|
| HK-4 | UI 打磨（常任；目标「专业 · 克制 · 流畅 · 高效 · 耐看」，VSCode 为基准） | 自拟六项按序推进：UI-1 字号尺度 ✅§5.121 / UI-2 圆角·边框·阴影 ✅§5.122 / **UI-3 图标 emoji→单色 SVG ✅**（`docs/log/2026-10-13-ui-icons.md`；宿主层渲染面归零；插件自绘面板符号＝跨包图标通道是契约问题，留欠账） → **UI-4 焦点环与键盘可达 ✅**（roving tabindex 漫游 + `:focus-visible` 焦点环） → **UI-5 动效可关 ✅**（设置项 + `<html data-motion>`） → **UI-6 底部问题面板 ✅**（ERB 结构/表达式两层波浪线汇总、点击跳源行；状态栏 ✕/⚠/ℹ 计数经 `kojo.problems` 展开，Ctrl+Shift+M）；每项带可复跑量化判据 | 进行中 · 认领：hk4ui 2026-10-14 |

## D. 已拍板（用户 2026-10-13 反馈批）

- **糖视图**：**不走虚拟文档**（原三问废止）；封存现效果（设置页「显示已封存功能」总开关可临时恢复）；新方向＝「升糖语法直接写进编辑器原生显示、替代原 ERB 代码块」（不保存 / 不改原文件），未立项。

## E. 用户反馈批（2026-10-13 试用反馈，决议性入册）

> 来源：用户对 0.4.0-beta.1 试用后的 13 条反馈（要点摘进各行，关键短语保留原话）。
> **当务之急 = E1**；E5–E8 为修复 / 新增。已拍板的总纲见 §D。

| ID | 任务 | 关键判据 / 口径（含原话摘引） | 认领 |
|---|---|---|---|
| E13 | **报红 · 升糖投影产出「不可写糖形」**（E7② 实测暴露；归 `kojo-sugar` 线） | **现象**：库里主流的「`@M_KOJO_MESSAGE_{COM|SCOM}_K<号>_<i>` ＝ `LOCAL` 信封 ＋ 委托到 `_1`」形态，`liftProject` 投出的是**给人看的显示注记**，不是作者能照抄的糖形。**复现**：取 `049 Satori [さとり]/古明地觉TOKI/古明地觉/M_KOJO_K49_奉仕系コマンド.ERB :: @M_KOJO_TOKI_MESSAGE_COM_K49_88_1`，或 `101 Tokiko [朱鷺子]/朱鷺子/M_KOJO_K101_絶頂 .ERB :: @M_KOJO_MESSAGE_PALAMCNG_B_K101`，把投影结果原样贴进 `.kojo` 保存。**期望**：投影输出即转译零 error 的可写糖形。**实际**：报 `indent-mismatch`（`LOCAL = 1` 留在 0 列、块体没缩进）＋ 中文指令名查不到。**屏上原样文案**：`时机 指令 88_1（TOKI版）：`、`时机 指令 317_1（RBK自制版）：`（`kojo-sugar/src/lexer.ts:367-408` 只认纯数字编号或纯中文指令名，这种 token 会被当指令名去查表）。**可借用判据**：`packages/plugins/eratw-adapter/tests/scaffold-cases.test.ts` 的「可写性守卫」（案例拼成最小文档过真实转译、零 error）及其自证用例。受影响面＝性交指令 / 奉仕指令 / 爱抚指令 / 绝顶，这四面脚手架案例按**宁缺勿编**暂缺，E13 修好即可补上 | 待认领 |
| E17 | **随机块「一档多句」边界写清 + `当 RAND:n：` 缺档诊断**（方案 1，语法零改动；全文 `docs/SUGAR-RANDOM-CANDIDATE-PROPOSAL.md` §2） | ① 教程⑬（`tutorial-content.ts:446`）补「候选=一行；一档说多句改用 `当 随机数：`」+ 对照迷你例——样例受溯源守卫管：先加 `fixtures/sugar/teaching-full.kojo`、`TEACHING_GOLDEN_WRITE=1` 真链路重生成 `.expected.erb`（**禁手写 golden**）；② 新增诊断 `rand-case-incomplete`（error）：`当 RAND:n：`（常量 n≥1、无 `否则`）档位未盖满 0..n-1——实测现在**零诊断静默**（`当 RAND:3：` 只写两档通过，掷到 2 永远沉默）；③ SPEC §3.6 边界句 + §8 lint 表加行。验收：全量不回退 + 双 typecheck + audit + teaching 链路真跑 | 认领：haruki 2026-10-14 |
| E18 | **`随机：` 候选组 `组：`（方案 2；一档多行）**（全文 `…PROPOSAL.md` §3） | `组：`+缩进多行 = 一个候选（英别名 `group`；空组报错；`组：` 后不跟内容报错）。落点全为既有扩展点：`plugin-api/sugar.ts` additive 契约 + `keywords.ts:47` 一行（高亮/补全自动派生）+ `lexer.ts` 块头 + `parser.ts`（groupBlock / isBlockNode / mergeBlockBody）+ `codegen.ts:973` 透传；lift 多行体改产 `组：`（E18b：探针 E 形 `roundtrip-mismatch` 转自证通过）。与 E17a 同域（⑬章 + teaching fixtures）→ **串行认领、后到 rebase**。验收：混排/空组/组内注释单测 + 全量不回退 | 认领：haruki 2026-10-14 |
| P-1 | **段块糖（多信封分段）+ 投影段级吸收** | **P-3 初回段的硬前置**（`段 首次：` 是 P-1 的保留段名、`FIRSTTIME(SELECTCOM)` 整串硬编译 ⇒ **P-3 不单独开工**）；E13-2 的 `indent-mismatch` 病根也在这（`LOCAL` 信封槽 G1，不在 NOWEX）。频次之王：信封 7,252 / 段门 445~639（提案 P0） | 待认领 |
| ALS | **`CSV/*.als` 追加名表进字典**（P-10③ 实测暴露的**唯一前置**；提案外新发现） | 现状 `eratw-adapter/src/variable-schema.ts:142` 只扫 `CSV/*.csv`（`if (!/.csv$/i.test(e.name)) continue`）⇒ 汉化追加名与角色级自定名天然查无。**盘上实存 19 份 `.als`**（Abl·Base·CFLAG·CSTR·DAY·Equip·Item·Juel·Mark·Palam·Stain·TCVAR·TFLAG·Talent·Tequip·exp·ex·source），逐字实证：`TCVAR.als:76 = 145,泥酔`、`ex.als:2 = 1,Ｖ绝顶`。**不扩表就扩族 = warn 海**（P-10③ 正因如此只敢入库 4 族）——同批只读实测的大户表外数：`CFLAG` 19,999 refs/**1,304** · `TALENT` 72,442/**567** · `FLAG` 18,117/126 · `TCVAR` 17,722/172 · `TEQUIP` 5,284/75 · `ABL` 8,754/26 · `PALAM` 1,724/46 · `EXP` 2,628/33 · `SOURCE` 1,840/6。**判据**：① 先实测复核 `.als` 是否确与 `.csv` 同 `编号,名称[,注释]` 行格式（不同则按实际格式写解析，别照抄）；② 同名表并存（`ex.csv` + `ex.als`）的**合并口径**（并集？后者覆盖前者？编号撞车怎么办）必须定死并钉进测试；③ 合并后 `泥酔`/`Ｖ绝顶` 查得到（负自证：不合并时它们必须查无）；④ 随后把 `kojo-sugar/src/index.ts` 的 `CHECKED_FAMILY_NAME_TABLES` 扩族，复跑全语料 warn 面读数——**表外应趋零**，残余逐条列 名+文件:行；⑤ 全量不回退 + 双 typecheck + `audit:decoupling` ✅。附带线索：盘上是 `Juel.als` ⇒ `ENGINE_VARIABLE_FAMILIES` 里的 `JVEL` 疑为笔误（P-10③ 已记录，归属性/悬停线 owner，别在 ALS 批顺手改） | 待认领 |

