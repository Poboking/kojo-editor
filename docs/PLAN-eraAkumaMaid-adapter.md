# eraAkumaMaid 适配方案（初步 · v1）

> 任务：让 kojo-editor 适配 era 系游戏 **eraAkumaMaid**（语料目录 `C:\game\eraAkumaMaid`）。
> 角色：本任务小组组长 / 项目负责人之一。原则：**优先参考 eratw 适配层设计，内核零改动，一切游戏知识进适配器插件**。
> 本文 = 调研结论 + 适配策略 + 分期计划 + 风险与验证口径。实现认领走 `docs/BOARD.md`，本文不代替看板。

---

## 一、结论摘要（先看这段）

1. **架构层面完全接得住**：eraAkumaMaid 与 eraTW 同属 Emuera 引擎生态，CHARA CSV 格式、CSV 变量名表、`.ERB`/`.ERH` 文件体系、`TRYCALLFORM` 分发机制全部同构。`GameAdapter` 契约（`plugin-api/src/game.ts`）无需任何修改；内核 / erb-parser / condition-extractor / convention-linter / state-replay / sav-parser / kojo-sugar **零改动**。
2. **口上命名体系不同，是新适配器的主要工作量**：eraTW 是中缀式 `M_KOJO_K{n}_{家族}`；eraAkumaMaid 是**后缀式 `{家族}_K{n}`**（如 `KOJO_MESSAGE_COM_K1`、`CNAME_K1`），eraTW 的 family-index 规则**不可直接复用**，需新写一份（纯函数规则，可对照其 97.88% 覆盖率口径验收）。
3. **交付形态**：新增一个插件 `packages/plugins/eraakumamaid-adapter`（包名 `@kojo/plugin-eraakumamaid-adapter`），在 `bootstrap.ts` 注册、`audit-decoupling.mjs` 的 `ADAPTER_PLUGIN_DIRS` 登记豁免。这正是架构文档 §1.1 / §7「v2.0 多游戏验证」里程碑的首次实战（原定 eraK，本任务以 eraAkumaMaid 落地）。
4. **分期建议**：P0 布线 → P1 识别与导航（核心回路）→ P2 语义层（变量字典/指令表/调用协议）→ P3 校验与糖 → P4 周边（脚手架/文案/远期 sav）。**P1 完成后编辑器即可真正用于该游戏的口上浏览、定位、检索。**
5. **两个决策点已拍板（2026-10-18 用户令）**：① **糖语言只服务中文社区**——不为日文社区兼容性追加任何设计；eraAkumaMaid 侧糖面模板按 eratw 既有首批平移即可（服务中文作者），不因日文社区诉求扩大范围（P3 优先级因此可弹性下调，主链路优先）。② **向导族抽取共享骨架（尽可能解耦）**——不把 eratw 向导代码复制进本包；P4 以共享骨架落地、两适配器共用，本适配器只通过契约能力（如角色源、模板源）向共享骨架供数。

---

## 二、目标游戏调研结论（eraAkumaMaid 实测，2026-10-18）

### 2.1 基本盘

| 项 | 实测读数 |
|---|---|
| 引擎 | Emuera 1824 + v18（**私家改造版**；ReadMe 自述「-part 基于过去作品 eraSQN」） |
| 语言 | 日文原版（ReadMe/更新履歴为 Shift-JIS；ERB/CSV 为 **UTF-8-BOM**） |
| 目录指纹 | `ERB/EVENT_K/` + `CSV/CHARA/` + 根目录 `Emuera1824+v18.exe`、`口上テンプレート/` |
| 存档 | **无 `sav/` 目录**（引擎运行时才创建）⇒ 状态回放/注入线初期不可用 |
| 规模 | 全 `ERB` 859 份；口上域（`ERB/EVENT_K/`）558 份 / **3,344 个 `@` 函数**；对比 eraTW 基线语料 4,385 份 ERB / 2,285 口上 ⇒ 体量约 1/5，**首个非 eraTW 真实语料** |
| 角色 | `CSV/CHARA/CHARA{n}.csv` 77 份（0–100，有缺号）；口上目录 75 个编号目录（`{no} {名前}`）+ `00 あなた`（玩家） |

### 2.2 口上域结构（`ERB/EVENT_K/`）

- **编号角色目录**（`01 フェリシエル`、`100 パトラ` …）：每角色 6 份文件
  `EVENT_K{n}.ERB`（主）/ `_CLOTHES` / `_COMM` / `_DAILY` / `_SELECT` / `_SHOP`
- **根层共享文件**（无编号，适配器加载时需跳过，与 eraTW 处理個人口上根杂项同构）：
  `EVENT_K.ERB`（**主路由**，等价 eraTW 的 `KOJO_MESSAGE.ERB`）、`CALL_NAME.ERB`、`EVENT_K_DAILY.ERB`、`EVENT_K_FUNCTION.ERB`、`EVENT_K_TALKCOMM.ERB`、`TVOICE.ERB`、`EVENT_COMM系用槞彁セリフ.ERB`、`汎用喘ぎ/`（目录）
- **分发机制**：`TRYCALLFORM {家族}_K{NO:TARGET}`（路由器 + 散点调用，与 eraTW 同形态）
- **模板包**（脚手架数据来源）：`口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_{X1,67,68}`，占位形态 `_KX1`（如 `CNAME_KX1`、`KOJO_MESSAGE_COM_KX1`）

### 2.3 函数家族清单（后缀式 `{家族}_K{n}`）

路由器权威声明（`EVENT_K.ERB` / `CALL_NAME.ERB` / `EVENT_K_DAILY.ERB`）+ 逐角色实测 + 模板包三方合并：

| 族 | 中文标签（建议） | 来源 |
|---|---|---|
| `KOJO_MESSAGE_COM` | 指令口上 | 主路由 |
| `KOJO_MESSAGE_COMING` | 绝顶口上 | 主路由 |
| `KOJO_MESSAGE_BEFORE_COM` | 指令前口上 | 主路由 |
| `KOJO_MESSAGE_PALAMCNG` | 参数变动 | 主路由 |
| `KOJO_MESSAGE_MARKCNG` | 刻印变化 | 主路由 |
| `KOJO_MESSAGE_SHOOT` | 射精 | 主路由 |
| `KOJO_MESSAGE_SAMEN_AND_EXTACY` | 射精与绝顶 | 主路由 |
| `KOJO_MESSAGE_BEFORE_TARGETSHOOT` / `_AFTERSHOOTCHANGE` | 对象射精前 / 射精变化后 | 主路由 |
| `KOJO_MESSAGE_DAISYUKI` | 大欢喜 | 主路由 |
| `KOJO_ENDCOM` | 指令结束 | 主路由 |
| `KOJO_COUNTER` | 计数器 | 主路由 |
| `KOJO_EVENT` / `KOJO_EVENTL` | 事件 | 主路由 |
| `KOJO_GUEST` | 客人 | 主路由 |
| `CNAME` / `CNAMET` | 称呼 | CALL_NAME.ERB |
| `EVENT_PROFILE` | 角色简介 | 日常路由 |
| `KOJO_DAILY` / `KOJO_DAILYCOM` / `KOJO_DATE` / `KOJO_GREETING(S)` / `KOJO_LOAD` / `KOJO_SHOP` / `KOJO_WISH` / `KOJO_SLEEP` | 日常 / 日常指令 / 约会 / 问候 / 读档 / 商店 / 愿望 / 睡前 | 日常路由 + `_DAILY` / `_SHOP` 文件 |
| `CLOTHES` | 服装 | `_CLOTHES` 文件 |
| `KOJO_COMM` / `CREATE_MOB` | 通信 / 生成 mob | `_COMM` 文件 |
| `KOJO_DAILY2_{n}_ADDSELECT` / `DAILY2_{n}_ADDSELECT` / `DUMMYKOJO_DAILYCOM` | 日常追加选项 | `_SELECT` 文件 |
| `IS_SINGLE_ENDING` / `SINGLE_ENDING` / `MENU_SINGLE_ENDING` | 单结局系 | 逐角色 |
| `TIMEEVENT` / `PRE_EVENTTRAIN` / `SETFLAG_BEFORE_TRAIN` / `ADDCOND` | 时段事件 / 训练前 / 设置 / 条件追加 | 逐角色 + 模板 |
| `K{n}_KOJO2` / `KOJO_K{n}_DAILY_TALK` / `KOJO_K{n}_LOCAL_STRING` | 剧本私有函数（中缀 K 编号） | 逐角色 |
| 共享无编号：`TEXT_RELATION`、`CtoC_Comm_K15`、`SUCCUBUS_ESCAPE`、`ONE_ON_ONE`、`HITANDBLOW` | — | 归「其它」 |

### 2.4 已知坑（实现时必须处理）

1. **每角色重复定义无后缀函数**：`EVENT_K{n}.ERB` 里定义 `@EVENTTRAIN` / `@EVENTEND`（无 `_K` 后缀，靠 `SIF NO:TARGET != n RETURN 1` 自守卫），与 `TRAIN/EVETRAIN.ERB`、`TRAIN/AFTERTRA.ERB` 的同名函数并存 ⇒ **同名多定义**，erb-parser 索引/导航树对重复名的处理需在 P1 验证（歧义可见，不静默）。
2. **无 `sav/`** ⇒ `GameProject.savDir` 缺省（契约可选字段），sav-parser / state-replay / ui-state-replay / ui-snapshot-injector 自动进入 `inactive-for-project`，插件状态面板可见——这是契约设计内的优雅降级，不是缺陷。作者实机跑过一次游戏生成 sav 后，再评估 sav 二进制协议接入（Emuera 1824 的 sav 格式需独立取证，**eraTW 的 sav-parser 结论不可假定平移**）。
3. **`KOJO_K{n}_DAILY_TALK` 类中缀编号**：家族段中间嵌 `_K{n}_`，后缀锚定规则需专门用例。
4. **非编号根层条目**：`EVENT_K` 根的 `.ERB` 文件与 `汎用喘ぎ/` 目录在绑定 charaIndex 时必须跳过。

---

## 三、适配性总评（对照 eratw-adapter 逐项过契约）

| `GameAdapter` 契约能力 | 本游戏现状 | 需要的工作 |
|---|---|---|
| `detect` / `loadProject` | 目录指纹清晰（`ERB/EVENT_K/EVENT_K.ERB` 主路由 + `CSV/CHARA/`），与 eraTW detect（要求 `ERB/口上・メッセージ関連`）**无交集**，多命中冲突不存在 | 新插件实现；内核轮询逻辑（`kernel/src/project.ts`）已支持多适配器，**零改动** |
| `charaIndex` / `kojoPaths` | CHARA CSV 与 eraTW **逐字同格式**（`番号/名前/呼び名`）；目录名约定 `{no} {名前}` 也相同 | 插件内重写一份薄解析（审计 C 禁插件间 import，不能 import eratw-adapter 的 `chara-csv.ts`） |
| `functionFamilyIndex` | **后缀式命名，规则不可复用** | 新写规则 + 中文面标签表 + `instructionFaces`；对照 eraTW 97.88% 覆盖率口径验收 |
| `variableSchema` | `CSV/{CFLAG,TALENT,ABL,BASE,EXP,PALAM,SOURCE,TEQUIP,TCVAR,TFLAG,MARK,STAIN,CSTR,EX,ITEM,FLAG,…}.csv` 同 emuera 惯例；`.als` 追加表、`.ERH` 作者自定名表机制预计同构（P2 取证） | 插件内重写 loader（同上，禁交叉 import）；**可分期**——缺省时条件抽取照常工作，只是没有变量中文标签 |
| `conventions` | 需按本游戏重新取证 | 首批候选：`_KX\d+` 占位符残留（模板 X1→K{n} 漏改）、缺核心族提示、FORM 三连符号（引擎通用可平移）；原则不变：宁可漏报不可误报 |
| `kojoCallProtocol` | 主路由 `EVENT_K.ERB` 形态与 eraTW `KOJO_MESSAGE.ERB` 类似 | P2 解析路由表得槽位语义表 |
| `kojoInstructionTable` | `CSV/Train.csv` 存在（同款 loader 可仿制） | P2 |
| `kojoFaceTemplates`（.kojo 糖） | 目标函数名形态不同 ⇒ **eraTW 的 37 面表不可用** | 新表（约 20 面）；契约保证缺面 `face-table-missing` fail-closed，**可增量交付** |
| ~~`stateModel`~~ / sav 注入 | 无 sav | 不设 `savDir`；相关插件自动 inactive-for-project。**2026-10-22 契约瘦身批：`stateModel` 已从契约删除**（零消费方） |
| ~~`scaffold`~~ | 游戏自带模板包 `KOJOPackage_{X1,67,68}` | 骨架来源仍是模板包；**但落盘走 `deps.scaffold` 通道**（adapter 供数 → 共享向导落到工作区），`GameAdapter.scaffold` 槽位 2026-10-22 已删（零调用方，且会绕过「工作区为权威」） |
| `nameGlossary` | 日文游戏 | 可选（日→中对照），P4 评估 |

**架构结论**：改动面 = ① 新插件包；② `packages/app/src/bootstrap.ts` 注册一行；③ `tools/audit-decoupling.mjs` 豁免登记一行；④（可选）`WelcomeView.tsx` 品牌文案「eraTW 口上编辑器」→「era 系口上编辑器」评估。**内核 / 契约 / Rust 宿主 diff 为空**——这就是架构铁律的验收时刻。

---

## 四、适配器插件设计（`packages/plugins/eraakumamaid-adapter`）

### 4.1 标识与布线

- `gameId: 'eraakumamaid'`，`displayName: 'eraAkumaMaid'`
- 包名 `@kojo/plugin-eraakumamaid-adapter`（`workspace:*` 依赖 `@kojo/plugin-api`；peer react）
- `bootstrap.ts` 注册（排在 eratw-adapter 之后即可；detect 无交集，顺序不影响判定）
- `audit-decoupling.mjs` 的 `ADAPTER_PLUGIN_DIRS` 加 `'eraakumamaid-adapter'`（D 项豁免；注意黑名单词根 `eraK/eraSQN/eraNAS` 与 "eraAkumaMaid" 均不匹配，但豁免登记仍是硬要求）

### 4.2 模块划分（对照 eratw-adapter 同构瘦身）

| 模块 | 职责 | 分期 |
|---|---|---|
| `constants.ts` | detect 指纹（`ERB/EVENT_K` + `EVENT_K.ERB` 主路由；`CSV/CHARA`）、paths、`savDir` 不设 | P1 |
| `plugin.ts` | detect / loadProject（charaIndex 绑定、kojoPaths=`[ERB/EVENT_K]`、writablePaths=`[ERB/EVENT_K]`、inputDigest） | P1 |
| `chara-csv.ts` | CSV 薄解析 + 目录名 `{no} {名前}` + 文件名 `EVENT_K{n}` 反推编号（eraTW 回退链同款） | P1 |
| `family-index.ts` | 后缀式规则 + 中文面标签表 + instructionFaces + memo | P1 |
| `variable-schema.ts` | CSV 名称表 loader（主表 + `.als` 追加 + `.ERH` 自定名表三层） | P2 |
| `instruction-table.ts` / `call-protocol.ts` | `CSV/Train.csv` / `EVENT_K.ERB` 路由表 | P2 |
| `conventions.ts` | 首批约定规则（分区复用形态照 eratw 抄结构） | P3 |
| `face-templates.ts` | `.kojo` 分野模板表 | P3 |
| `scaffold.ts` | 读 `口上テンプレート/新キャラ追加用パッケージ` 生成骨架 | P4 |

### 4.3 family-index 规则设计要点（P1 核心）

- **主路径**：锚定名字中最后一个 `_K(\d+)`（后缀式），head 段按已知面表分解（最长优先）；`_KX\d+` → `kind: 'placeholder'`（占位符，可按 filePath 的 `EVENT_K{n}` 还原编号，照 eratw 的 `alignPlaceholderToPath` 同款思路）
- **中缀特例**：`KOJO_K{n}_DAILY_TALK`（`_K{n}_` 后还有面段）——用「最后一个 `_K{n}` 之后仍有面表命中」的判据分流，或显式白名单；**拿不准就归「其它」，不猜**
- **无后缀每角色函数**（`EVENTTRAIN`/`EVENTEND`）：可选按 filePath 归属目录编号（规则第二参 additive，消费由本实现自定）
- **验收口径**：对 `ERB/EVENT_K` 全量 558 份 / 3,344 函数实测解析覆盖率（目标对齐 eraTW 的 97.88% 口径，未命中部分须逐类有理由）；memo 化（eraTW 实测 4 遍扫描 → 1 遍的优化同款）

### 4.4 loadProject 要点

- `charaIndex`：扫 `CSV/CHARA/*.csv`（77 份）→ 编号/名前/呼び名；再扫 `ERB/EVENT_K` 编号目录绑定 `kojoDir`；`00 あなた`（no=0）与「目录在、CSV 缺」按 eraTW 同款回退链（补最小条目、显式 warn，不静默丢弃）
- 跳过 `EVENT_K` 根层非编号条目（`.ERB` 文件、`汎用喘ぎ/` 目录）
- `writablePaths: [ERB/EVENT_K]`（口上作者主战场；用户批准后内核 io 放行）
- `savDir`：**不设**（目录不存在）⇒ 状态类插件 inactive-for-project
- `inputDigest`：CHARA 表正文 + 目录名 + 变量名表摘要折入（照 eratw，派生缓存判据）

---

## 五、分阶段实施计划

| 期 | 内容 | 验收判据 | 估时 |
|---|---|---|---|
| **P0 布线** | 建包（package.json / tsconfig 同构）；`bootstrap.ts` 注册；`audit-decoupling.mjs` 豁免登记；`BOARD.md` 认领一行；建批次分支 `b/<agent>/<MMDD>-akuma-adapter`（从 origin/dev） | `pnpm install` + 双 typecheck + `audit:decoupling` ✅（插件可先只注册空壳）；测试数不回退 | 0.5 天 |
| **P1 识别与导航** | detect/loadProject/chara-csv/family-index + 插件单测（对照 eratw-adapter 测试形态） | 桌面壳打开 `C:\game\eraAkumaMaid`：角色索引、函数树导航（角色→家族→面→函数）、文件树、全文检索可用；家族解析覆盖率实测读数；同名多定义（EVENTTRAIN）在导航/索引中不静默；**内核/parser diff 为空** | 2–3 天 |
| **P2 语义层** | variable-schema（CSV 主表 + `.als` + `.ERH`）、instruction-table、call-protocol | 条件抽取带变量中文标签；糖指令名可解析；派生缓存 inputDigest 口径不破坏 eraTW 侧（快照版本/判据 additive） | 2 天 |
| **P3 校验与糖** | conventions 首批（`_KX\d+` 占位符 / 缺族提示 / FORM 三连符号）+ face-templates 首批（主链路 8–10 面） | 校验面板对真实语料跑出可操作清单（零误报门槛）；`.kojo` 主链路可转译、缺面 fail-closed 报错不静默 | 3–4 天 |
| **P4 周边与收尾** | scaffold（模板包）、nameGlossary 评估、WelcomeView 文案评估、向导共享化决策、（远期）sav 接入验证 | 全量验证矩阵绿（见 §七）；落地窄门过 dev | 2 天+ |

> 每期独立可交付、可回滚；P1 是「编辑器真正可用于该游戏」的最小回路。

**P4 落地实况（2026-10-18，`63786c1` 之后）**：

| P4 子项 | 状态 | 落地形态 |
|---|---|---|
| 向导族**共享骨架**（用户决策②） | ✅ 已抽 | 新建 `plugin-api/src/scaffold.ts`（目录名消毒 / `{作品}-{角色} v{版本}` / 空壳段落 / README 四段 / 输入兜底 / 装配次序）。**不含任何游戏名词**（A 项门禁即判据），面清单/案例/部署路径/许可文本一律由 adapter 注入。`eratw-adapter/src/scaffold.ts` 改为「数据 + 委派」薄层，产物逐字不变（29 条既有测试零改动全绿） |
| scaffold（模板包为骨架来源） | ✅ 已交付 | 新 `eraakumamaid-adapter/src/scaffold.ts`：以游戏自带 `口上テンプレート/新キャラ追加用パッケージ` 的 7 文件布局为清单（实测 `grep ^@` 逐文件函数归属），产物按**游戏根相对路径**铺开（`CSV/CHARA/CHARA<n>.csv` + `ERB/EVENT_K/<n>/*.kojo`），与社区分发形态同构 |
| WelcomeView 文案 | ✅ 已改 | `eraTW 口上编辑器` → `era 口上编辑器`（多游戏品牌位；功能文案本就游戏无关） |
| nameGlossary 评估 | ✅ 已结 | P3 已交付 45 条词条（变量名 37 + 文件族 8）；角色名 0 条＝本游戏角色名即日文名、无对照需求 |
| **向导族 UI 接线**（新建/导入/部署/发布浮层） | ✅ 已交付（2026-10-19） | 新建共享包 **`packages/kojo-project-kit`**：原住 eratw-adapter 的 11 个模块（四个向导 + 项目面板 + 包操作 + 发布纯函数 + 署名 / 制品 / 许可 / 新建条目 / 部署，约 3.7k 行）经 grep 实测**零 eraTW 知识**（游戏名 / 口上前缀 / 日文路径 0 命中）⇒ 整体上移。adapter 侧只剩「数据 + 委派」薄层与 `overlay-ids.ts`（overlay 命名空间归各游戏，两 adapter 同名会互相顶掉）。游戏差异全部改由 deps 注入：脚手架（`deps.scaffold`）、核心面数、附加下拉字段（eraTW 的「剧本号」→ `extraFields`，AM 不提供 ⇒ 连那一行都不渲染）、预览补充说明。**AM 首次接上面板 + 四个向导**，与 eratw 能力对齐（`openTutorial` 改可选 ⇒ 无内置教程的游戏不渲染教程区） |
| **`GameAdapter.scaffold?()` 契约** | ✅ 已兑现（2026-10-19） | 该契约位（落盘态 `{createdFiles, report}`）**此前两个 adapter 都是空的**。共享 helper `writeScaffoldFiles`（逐字节写、不覆盖、可只写点名文件）+ 两 adapter 各自的落点口径：eraTW 落角色个人口上目录、eraAkumaMaid 落游戏根子树（`ERB/EVENT_K/<n>/` + `CSV/CHARA/`）——**照搬 eraTW 的落点会把文件铺错层**，这是两个游戏的真实差异。7 条契约测试钉住落点 / 不覆盖 / `faces` 筛选 / CSV 单 BOM |
| sav 接入 | ⏳ 远期 | 本游戏无 `sav/`，不做 |

**P5 落地实况（2026-10-19，用户指令「填补空缺 1~3,5」）**——P4 收口后按 eratw-adapter
逐项对表盘出的缺口，本批清掉 1~3 与 5（教程内容另议）：

| P5 子项 | 状态 | 落地形态 |
|---|---|---|
| `watch-scope` / `search-scope` 上移共享层 | ✅ 已交付 | 两者本就零游戏知识（只吃契约字段 `CharaInfo.kojoDir`），P4-2 被「整文件 grep 命中数」误挡在外——**命中全在注释里**。上移 `kojo-project-kit` 后 AM 侧接线：注册 `search.scope`（下拉可按角色收窄检索，此前只能在整棵树搜）+ 订阅 `file.changed`（此前**零订阅** ⇒ 外部往工作区丢文件时面板不刷新，用户感知是「面板显示不对但重开就好」） |
| `kojoLibraryTable`（函数中文化） | ✅ 已交付 | 新 `src/library-table.ts`，**45 条**。语料普查：`ERB/EVENT_K/` 558 份口上文件；基础库（`@` 定义不在口上域）301 份 / 1,900 个定义；口上域真实调用到的基础库函数 153 条，取高频且语义可核的 45 条。**eraTW 的 138 条一条都不能平移**（本游戏是日文原版，命名体系完全不同：`TEXTR` / `COND` / `FIRSTCOM` 一族） |
| `kojoMutatorTable`（数值增减） | ✅ 已交付（**含契约扩展**） | 5 族 `CFLAG` / `BASE` / `EXP` / `PALAM` / `ABL`。关键事实：本游戏**零个增减封装函数**（`CHANGE_CFLAG` / `BUFF_BASE` 全语料 0 处），增减一律直写 `族:对象:槽 += n` ⇒ 契约 `KojoMutatorSpec` 由单接口扩为 `form: 'call' | 'assign'` 判别联合（`assign` 只需 `template` + `slotMode`）。**硬填 `engine` 只会降出一条调不存在函数的 `CALL`**，这不是"该族没登记"而是该游戏的增减语义不经过函数。不收 `JUEL` / `SOURCE`（一维，无「对象」段）与 `TALENT`（位标志，改法是置位不是加减） |
| face-templates 增量 12 面 | ✅ 已交付 | 10 → **22 面**：客人 / 指令后 / 问候 / 日常指令 / 日期 / 愿望 / 商店 / 交流 / 角色介绍 / 射精后 / 对方射精前 / 大喜欢。逐面复核路由后发现两处「域与文件不重合」：`愿望` 属日常域却定义在 `_SHOP` 文件、`角色介绍` 属日常域却住在主文件；另发现**第三个路由文件** `EVENT_K_COMM.ERB`（`交流` 独占）。`_ADDSELECT`（73 处）是兄弟函数不是编号尾，不声明 `indexKind` |
| `stateLinePresets`（条件矩阵剧情线） | ✅ 已交付 | 四条：好感（`CFLAG:好感度`/`2`）、恋慕（`TALENT:恋慕`/`150`）、相愛（`TALENT:相思相愛`/`152`）、生育（`TALENT:出産経験`/`22`）。选键口径 = **语料条件位出现次数**（333 / 16,934 / 805 / 269）；特意弃掉 `片思い`（条件位 **0** 处）与 `同棲`（`EVENT_K/` **0** 处）——收进来只会得到一个永远筛不出行的按钮 |
| 教程内容 | ⏳ 另行立批 | 结构已就绪（`openTutorial` 可选 ⇒ 不传即整块不渲染），缺的是面向中文社区的内容本身（eratw 有 7 个 `tutorial-*` 模块） |
| sav 接入 | ⏳ 远期 | 同 P4：本游戏无 `sav/`，不做 |

读数：全量 **8438 passed / 49 skipped（8487）· 0 failed · 486 文件** · root + app 双 typecheck 0 ·
`audit:decoupling` ✅ 20 插件 A–D。新增用例 33 条（library-table 9 / mutator-table 8 /
增减直写 11 / 接线 5）+ scope 拆分 4 条。拆两段读：本批自身 **+37 条 / +4 文件**（rebase 前于旧基
实测，旧基读数 8245/49〔8294〕· 475 文件），rebase 带入 master `e2da2ef` 的 18 个上游提交再
**+193 条 / +11 文件**，相加即得上行。

---

## 六、风险与对策

| # | 风险 | 级别 | 对策 |
|---|---|---|---|
| 1 | **`tools/corpus.mjs` 语料劫持**：该工具自动扫 `C:/game/*` 且内容条件仅 `ERB/`+`CSV/`——`eraAkumaMaid` 完全符合！当前 eraTW 语料 3 份在位（画蛇添足版有 sav，排序第一）暂不劫持；但**一旦 eraTW 语料暂离，eraAkumaMaid 会被选为语料**，语料门（library-coverage / integration-plugins / encoding-roundtrip 等）全部对着错误游戏跑，误红或误绿 | **高** | ① 本机跑验证矩阵一律显式 `KOJO_CORPUS_DIR=<eraTW 基线盘>`；② 中期给 corpus.mjs 加内容指纹（如要求 `tool/erb_check.py` 或口上域目录特征）——动共享工具，需团队拍板后单独立项 |
| 2 | sav 缺失 ⇒ 状态回放/注入全线 inactive | 中 | 契约内优雅降级（状态面板可见）；作者实机生成 sav 后独立取证 Emuera 1824 sav 协议，**不假定 eraTW 结论平移** |
| 3 | 同名多定义（`EVENTTRAIN`/`EVENTEND` 每角色一份 + TRAIN/ 一份） | 中 | P1 验收项：erb-parser 索引/导航树对重名可见（分组或歧义标记），不静默合并 |
| 4 | `.kojo` 糖面表工作量大（eraTW 37 面，本游戏约 20 面但函数名全异） | 中 | fail-closed 契约保证不产错产物；按主链路增量交付；**日文社区是否优先做糖语言需用户拍板** |
| 5 | 「我的口上项目」向导族（新建/导入/部署/发布）现住 eratw-adapter，第二个游戏面临「复制一份」vs「抽取共享骨架进 kernel/plugin-api」 | 中 | **已闭环（2026-10-19）**：抽共享骨架、不复制。落地形态是**新包 `packages/kojo-project-kit`** 而非塞进 `plugin-api`——契约包零依赖（连 React 都没有），而向导是 React 组件（`createElement` 风格）；新包放在 `packages/` 而不是 `packages/plugins/` 下，于是 C 项（插件禁交叉 import）不适用，同时把它的 `src` 加进 A 项零游戏名词区。⚠ 剩余**唯一**未共享的是「宿主接线」段（谁注入什么、监听哪些事件）——那是组合根职责，两 adapter 各留一份是对的；**要小心的是别把它当成"又复制了"而硬抽一个公共件**，那会把宿主服务装配变成参数地狱 |
| 6 | 审计合规（新插件必须进 `ADAPTER_PLUGIN_DIRS`；游戏名词只准住 adapter） | 低 | P0 布线时一并登记；`pnpm audit:decoupling` 每期必跑 |
| 7 | 日文游戏的 UI 标签/糖表层语言策略（.kojo 表层是中文语言层，住契约） | 低 | P3 决策点：糖语言对日文社区的价值排序 |

---

## 七、验证矩阵（照 `AGENTS.md` §三，每期结束跑）

```bash
pnpm install
pnpm test                                    # 全量；测试数不许回退（基线见 docs/STATE.md）
pnpm typecheck                               # root
pnpm --filter @kojo/app typecheck            # app 另跑，两套都算数
pnpm audit:decoupling                        # 必须 ✅（插件数 +1）
# 真实壳冒烟（打开 eraAkumaMaid）：
node tools/smoke-tauri-dom.mjs
node tools/smoke-tauri-ipc.mjs
# 语料门（⚠ 显式指定，防 corpus.mjs 劫持，见风险 #1）：
KOJO_CORPUS_DIR="C:/game/eratw-画蛇添足版eratw4.980" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts
```

> 注：`docs/STATE.md` 现记「语料暂离、语料门转 skip」已过期——本机 `C:/game` 现有 eraTW 三盘（画蛇添足版 4.980 / 原生官方 4.842 / 魔王改版）+ eraAkumaMaid；语料门按实际盘面复跑，SKIP 口径以复跑为准（STATE.md 基线行顺手更新）。
> Rust 未改则不重跑 cargo；改了才跑（经 node 起，见 PITFALLS）。

---

## 八、立即行动项

1. `docs/BOARD.md` 写认领行（`eraAkumaMaid 适配：<主机> <日期>`）；
2. 建批次分支 `b/<agent>/<MMDD>-akuma-adapter`（从 `origin/dev`，不在本地 dev 直接提交）；
3. 开工 P0 布线；
4. （已完成 2026-10-18）两个决策点已获用户批复：**糖语言只服务中文社区**（不为日文社区兼容性追加设计）；**向导族抽取共享骨架**（尽可能解耦，不复制 eratw 向导代码）；
5. 风险 #1（corpus.mjs 劫持）通报全组——**任何 agent 在本机跑语料门命令前先设 `KOJO_CORPUS_DIR`**。

---

## 九、实施记录（2026-10-18 · 批次分支 `b/lead/eraakumamaid-adapter`）

组长制并行实施：9 个子 agent 各管一个模块文件（文件集互不相交），组长持 `constants.ts` / `plugin.ts` / `index.ts` / 包配置 / 根配置（tsconfig、vitest.config）。

| agent | 文件 | 内容 |
|---|---|---|
| wire | `packages/app/src/bootstrap.ts` + `tools/audit-decoupling.mjs` + `packages/app/package.json` 由组长加依赖 | 注册 + D 项豁免登记 |
| chara-csv | `src/chara-csv.ts` + tests | CSV 薄解析 / 目录名 `{no} {名前}` / `EVENT_K{n}` 反推编号 |
| family-index | `src/family-index.ts` + tests | 后缀式规则 + 中文面标签 + memo |
| variable-schema | `src/variable-schema.ts` + tests | CSV 主表 + `.als` 追加 + `.ERH` 作者自定三层 |
| instruction-table | `src/instruction-table.ts` + tests | `CSV/Train.csv` |
| call-protocol | `src/call-protocol.ts` + tests | `EVENT_K.ERB` 路由表 |
| conventions | `src/conventions.ts` + tests | 首批规则（KX 占位 / 缺核心族 / FORM 三连 / …） |
| face-templates | `src/face-templates.ts` + tests | 糖面主链路（AM 实测函数名形态） |
| name-glossary | `src/name-glossary.ts` + tests | 日→中对照词典（宁缺勿编） |

**已实测落定的关键命名事实**（写任务书用）：`KOJO_MESSAGE_COM_K1` 是**单函数内 `IF SELECTCOM == n` 分派**（无 eraTW 式 `_K{n}_{指令号}` 尾槽）⇒ `instructionFaces` 为空、糖面「指令」模板无 `{i}`；路由行为 `TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}`（无实参转发）；中缀例外 `KOJO_DAILY2_K1_ADDSELECT` / `K1_KOJO2`；无后缀重复定义 `@EVENTTRAIN` / `@EVENTEND`（每角色一份，`SIF NO:TARGET != n` 守卫，不得当家族）。

---

*调研基准：eraAkumaMaid 盘面实测 2026-10-18（859 ERB / 558 口上文件 / 3,344 函数 / 77 CHARA CSV / 75 编号口上目录）；契约与架构以仓库现状为准（`plugin-api/src/game.ts`、`docs/ARCHITECTURE.md` §5.1/§5.7）。*
