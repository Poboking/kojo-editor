/**
 * @kojo/plugin-kojo-sugar
 *
 * 语法糖转译插件（服务 `sugar.transpile`；v0.3 批 S2 转译内核 + S3 编译落盘
 * + S5-UI 升糖应用）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 三段式转译器（行式词法 → AST → codegen）——**引擎级语言知识**
 *   （中文表层关键字是跨游戏语言层，契约 `sugar.ts` 头注已定调），零游戏知识；
 * - 变量字典（`VariableSchema`）/ **时机分野命名模板（`KojoFaceTable`）** 来自
 *   **game adapter**（经槽位查询 + `project.adapterId` 过滤后注入转译器）——
 *   本插件只消费，不解释；
 * - 编译落盘（S3 批）：`compileToFile` 走**内核 io 第一道闸**（writablePaths）
 *   + 备份 + 回读验证（安全顺序见 `compile.ts` 头注，复刻注入器范式）；
 *   `parse`/`transpile`/`sourceOf` 仍为纯函数。
 * - 升糖应用（S5-UI 批）：`sugar.liftApply` 与 `compileToFile` **同款写链路**
 *   （见 `lift-apply.ts` 头注），落盘成功后发 `file.changed`。
 */

import type {
  ConditionExpr,
  ConditionExtractorService,
  ControlFlowStatement,
  ErbParserService,
  FileIO,
  GameProject,
  KojoFaceTable,
  KojoInstructionTable,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateReplayService,
  SugarLiftApplyService,
  SugarLiftService,
  SugarPreviewService,
  SugarTranspileService,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createSugarTranspileService } from './service';
import { createSugarPreviewService } from './preview';
import { createSugarLiftService } from './lift';
import { createSugarLiftApplyService } from './lift-apply';
import type { DictionaryLookup } from './types';

export function createKojoSugarPlugin(): Plugin {
  return {
    id: 'kojo-sugar',
    version: '0.3.0',
    provides: [
      WellKnownServices.SugarTranspile,
      WellKnownServices.SugarPreview,
      WellKnownServices.SugarLift,
      WellKnownServices.SugarLiftApply,
    ],
    // S3 批：编译落盘需要内核 io（第一道闸）；Project/Slots 供 adapter 字典查询
    requires: [KernelServices.Project, KernelServices.Slots, KernelServices.IO],
    activate(ctx) {
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /**
       * 状态回放服务（`state.replay`）——**可选消费**（S4 批）。
       *
       * 之所以**不写进 `requires`**：预览在无存档时仍要可用（糖预览是编辑器
       * 常态），把 `state.replay` 做成硬依赖会让"回放插件未激活"直接导致
       * kojo-sugar 静默 inactive——那是本末倒置。故按需**软取**：
       * `ctx.inject` 抛错则回退 undefined，预览走结构化降级
       * （`replay-service-unavailable`，契约已定义）。
       */
      const replayOf = (): StateReplayService | undefined => {
        try {
          return ctx.inject<StateReplayService>(WellKnownServices.StateReplay);
        } catch {
          return undefined;
        }
      };

      /**
       * `erb.parser` 的 `scanControlFlow`（S5 批，软取）——提升建议的**结构**判据。
       *
       * 软取的理由同上：结构扫描缺席只该让提升建议退化为"内置最小扫描"，
       * 不该让整个 kojo-sugar 静默 inactive。
       */
      const scanFlowOf = (): ((text: string) => ControlFlowStatement[]) | undefined => {
        try {
          const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
          return (text: string) => parser.scanControlFlow(text);
        } catch {
          return undefined;
        }
      };

      /**
       * `condition.extractor` 的 `parseExpression`（S5 批，软取）——提升建议的
       * **条件可解析性**判据（`opaque` = 跳过信号）。
       */
      const parseExprOf = (): ((text: string) => ConditionExpr) | undefined => {
        try {
          const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
          return (text: string) => extractor.parseExpression(text);
        } catch {
          return undefined;
        }
      };

      /**
       * 当前适配器的变量字典（按 adapterId 精确匹配；多适配器共存天然正确）。
       *
       * 每次 `transpile` 调用时才查询——适配器可能在项目切换后重建 schema，
       * 转译服务本身保持无状态（纯函数语义）。
       */
      const dictionaryOf = (): DictionaryLookup | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          const vs: VariableSchema | undefined = contribution.adapter.variableSchema;
          if (vs) return makeLookup(vs);
        }
        return undefined;
      };

      /**
       * 当前适配器的**时机分野模板表**（游戏知识；`KojoFaceTable`）。
       *
       * 与 `dictionaryOf` 同源同生命周期（按 `adapterId` 精确匹配 `game.adapter`
       * 槽位）。缺省 = 该适配器未声明 → 转译含 `时机` 块的文档时报
       * `timing-face-unknown`（**fail-closed**，绝不回退到内建模板——回退就是
       * 把游戏知识搬回通用插件，正是本批要根除的）。
       */
      const faceTableOf = (): KojoFaceTable | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          if (contribution.adapter.kojoFaceTemplates) return contribution.adapter.kojoFaceTemplates;
        }
        return undefined;
      };

      /**
       * 当前适配器的**指令名表**（游戏知识；`KojoInstructionTable`；HK-11②）。
       *
       * 与 `faceTableOf` 同源同生命周期（按 `adapterId` 精确匹配 `game.adapter`
       * 槽位；表内容随项目的 `CSV/Train.csv` 变化）。缺省 = 该适配器未声明 →
       * `时机 指令 <中文名>：` 报 `timing-instruction-unknown`（**fail-closed**，
       * 绝不猜——数字编号路径不受影响，逐字节保持旧行为）。
       */
      const instructionTableOf = (): KojoInstructionTable | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          if (contribution.adapter.kojoInstructionTable) return contribution.adapter.kojoInstructionTable;
        }
        return undefined;
      };

      /** 统一的转译器构造（字典 + 分野表 + 指令表同源注入；保证各路径行为一致） */
      const makeTranspiler = (
        deps?: Omit<
          Parameters<typeof createSugarTranspileService>[0],
          'dictionary' | 'faceTable' | 'instructionTable'
        >,
      ) =>
        createSugarTranspileService({
          dictionary: dictionaryOf(),
          faceTable: faceTableOf(),
          instructionTable: instructionTableOf(),
          ...(deps ?? {}),
        });

      const service: SugarTranspileService = {
        parse: (source, options) => makeTranspiler().parse(source, options),
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        sourceOf: (result, generatedLine) =>
          createSugarTranspileService().sourceOf(result, generatedLine),
        // S3：编译落盘一体——转译（带当前 adapter 字典+分野表）+ 双闸写 + 备份 + 回读
        compileToFile: (source, targetPath, options) =>
          makeTranspiler({ io, log: ctx.log }).compileToFile(source, targetPath, options),
        // 导出批：内存编译（零 IO，故不注入 io）——与 compileToFile 共用守卫与编码组装
        compileToBytes: (source, options, targetLabel) =>
          makeTranspiler().compileToBytes(source, options, targetLabel),
        // S7：保存前置检查（纯函数）——推导目标 + 转译 + 全角空格告警，同一转译器
        planSave: (request) => makeTranspiler().planSave(request),
      };

      ctx.provide(WellKnownServices.SugarTranspile, service);

      /**
       * 预览服务（S4 批）——**只读数据层**：转译复用上表同一个转译器
       * （同 adapter 字典 + 分野表），回放软取 `state.replay`，产出三向映射。
       *
       * 事件纪律：预览**不发射任何事件**（`file.changed` 等由内核 io 监视器
       * 产生；预览只消费）。故此处不注册任何 `ctx.bus.on`。
       */
      const previewService: SugarPreviewService = createSugarPreviewService({
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        ...(replayOf() ? { replay: replayOf()! } : {}),
        io,
        log: ctx.log,
      });

      ctx.provide(WellKnownServices.SugarPreview, previewService);

      /**
       * 提升建议服务（S5 批）——**原生 ERB → 糖候选**。
       *
       * 依赖方向（单向，无环；**一律走服务槽**，插件不得交叉 import —— 解耦审计 C 项）：
       * - `transpile` 复用上面同一个转译器（同 adapter 字典）——round-trip 自证
       *   的**唯一**手段；本服务只调用它，不改动转译内核；
       * - `scanControlFlow` 取自 `erb.parser` 服务（块配对 + "糖未覆盖的控制流"判据）；
       * - `parseCondition` 取自 `condition.extractor` 服务的 `parseExpression`
       *   （`opaque` = 跳过信号）。
       *
       * 后两者**软取**（`try/catch` → undefined）：两者缺席时提升建议仍能工作，
       * 只是判据退化（`degraded: true`，`lift.ts` 里已有明确分支）。若写成硬
       * 依赖，"解析器未激活"会让 kojo-sugar 整体静默 inactive——那是本末倒置
       * （与 `state.replay` 的软取同理）。
       *
       * 事件纪律：提升建议是**纯函数式只读**能力（不读盘、不写盘、不发事件），
       * 与预览一致——故此处不注册任何 `ctx.bus.on`。
       */
      const liftService: SugarLiftService = createSugarLiftService({
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        ...(scanFlowOf() ? { scanControlFlow: scanFlowOf()! } : {}),
        ...(parseExprOf() ? { parseCondition: parseExprOf()! } : {}),
        // 变量字典（软取：adapter 未激活时投影退化为"不做属性反糖"，其余照常）
        // `dictionaryOf` 是**每次调用时才查**的函数（适配器可能随项目切换重建 schema）。
        dictionary: () => dictionaryOf(),
        // 时机分野模板表（软取，批 I 的函数头反解用；缺席 = 一个头都不标）
        faceTable: () => faceTableOf(),
      });

      ctx.provide(WellKnownServices.SugarLift, liftService);

      /**
       * 升糖**应用**服务（S5-UI 批）——把候选写回 `.kojo` 源文件。
       *
       * 与 `sugar.lift` 的分工：后者是**只读观察面**（契约明文：不读盘不写盘不发
       * 事件）；写能力必须显式声明成一个独立服务键，否则"哪些插件能写盘"就不再
       * 可审计。**能力面 = 服务键面**。
       *
       * 写链路与 S3 的 `compileToFile` 逐条对齐（编码组装 → 目录 → 备份 → 内核
       * io 写盘〔第一道闸〕→ 回读验证），**不绕过任何一闸**。
       *
       * 事件纪律：本服务**发** `file.changed`（写盘成功路径上）。这与 S4 预览的
       * "只消费、绝不发射"不冲突——预览不写盘，故无变更可报；本服务确实改了盘，
       * 不发事件反而是"内核不静默"铁律的破坏（编辑器不会知道文件变了）。
       * 发口由装配层注入（`onApplied`），实现层零内核依赖。
       */
      const liftApplyService: SugarLiftApplyService = createSugarLiftApplyService({
        io,
        log: ctx.log,
        onApplied: (path: string) => {
          ctx.bus.emit('file.changed', { kind: 'change', path });
        },
      });

      ctx.provide(WellKnownServices.SugarLiftApply, liftApplyService);
    },
  };
}

/**
 * 把 adapter 的 `VariableSchema` 适配为转译器的 `DictionaryLookup`（只读消费）。
 *
 * - `resolveFamily(name)`：变量名字 → 族名。策略：按引擎变量族表逐个
 *   `lookup(FAMILY, name)`，命中即返回该族（**命中不唯一时返回首个**——
 *   规范 §3.8 说"命中不唯一时编辑器弹窗"，那是 S4 编辑体验批的职责；
 *   转译器此处取**确定性**首个命中，不静默猜测顺序之外的语义）；
 * - `resolve(ident)`：裸标识符 → 原样（引擎变量表已收录的族名 + 冒号索引
 *   写法本就合法，不需要改写）；
 * - `unlistedFamilyName(ident)`（P-10③）：`族头:具名索引` 的**名称段**核对——
 *   历史上 `resolve` 只看族头就整串放行，拼错的具名（`NOWEX:噴乳乳瞎写`）零诊断
 *   进产物（违铁律 4）。本方法把"族表在位但该名查无"单独问一次，**不改写产物**，
 *   报警由 `expression.ts` 的族引用放行点决定（**warning 起步**）。
 */
const ENGINE_VARIABLE_FAMILIES: readonly string[] = [
  'CFLAG',
  'TALENT',
  'ABL',
  'EXP',
  'MARK',
  'BASE',
  'PALAM',
  'TEQUIP',
  'TCVAR',
  'FLAG',
  'TFLAG',
  'CALLNAME',
  'NAME',
  'JVEL',
  'STAIN',
  'DOWNBASE',
  'CUP',
  'GOTJUEL',
  'NOWEX',
  'SOURCE',
];

/**
 * **本批具名索引核对的生效族 → 其名称表键候选**（P-10③ 立项；ALS 批 2026-10-14 扩族）。
 *
 * 为什么是"候选表键"而不是"族名一律查自己的表"：引擎把**同一张名字表**挂在两个变量上
 * （`NOWEX` 的具名索引住在 `EX` 的表里、`DOWNBASE` 住在 `BASE` 里），游戏目录里并没有
 * `NOWEX.csv`。别名与上面那张族头清单同性质 —— 是 **ERB 语言层**知识，不是某个游戏的数据
 * （数据本身仍由 adapter 的 CSV/ALS 表注入）。
 *
 * ## 入库判据（ALS 批定死，别照着"看着少"就加）
 *
 * 生效族 = adapter 字典（**已含 `CSV/*.als` 追加名表**，见 eratw-adapter `variable-schema.ts`）
 * 在真语料上把该族的**实际 warn 面打到 0** —— 或者只剩**真阳性**（作者确实写错的名称，
 * 引擎取不到值，正是本核对要抓的东西）。只要残余里还有**一条系统性假阳性类**，该族就不入库。
 *
 * ## 读数（2026-10-14 只读实测，本机语料画蛇添足版 4.980，`ERB/口上・メッセージ関連`
 * 2,317 份 `.ERB`；口径 = 与转译器同一个标识符字符集（`identifier-chars.ts`）扫**非注释行**，
 * 只取 `族头:具名` **二段形**且名称段非纯数字；"实际 warn" = 判表外后再过
 * `expression.ts` 的"名称段是裸引擎全局"放行。表内 `前` = 字典只读 `*.csv`（P-10③ 那批的基线，
 * 逐族与其发布读数**逐字相同**：CFLAG 1,304 / TALENT 567 / FLAG 126 / TCVAR 172 / TEQUIP 75 /
 * PALAM 46 / EXP 33 / ABL 26 / SOURCE 6 ⇒ 本批口径未放宽）。
 *
 * | 族头 | 二段具名引用 | 判表外 前(csv) | 判表外 后(+als) | 实际 warn 后 | 取舍 |
 * | --- | --- | --- | --- | --- | --- |
 * | `MARK` | 10,943 | 0 | 0 | 0 | 保持入库（`Mark.als` 与 `Mark.csv` 逐字节相同） |
 * | `NOWEX` | 5,197 | 7 | 3 | 2 | 保持入库（`ex.als` 简写别名补进表 ⇒ `Ｖ绝顶`×4 归零） |
 * | `DOWNBASE` | 108 | 0 | 0 | 0 | 保持入库 |
 * | `STAIN` | 4 | 0 | 0 | 0 | 保持入库 |
 * | `BASE` | 1,842 | **711** | **0** | **0** | **入库**（`Base.als` 同时给简繁双写：`10,情绪`+`10,情緒`） |
 * | `FLAG` | 3,984 | **126** | **0** | **0** | **入库** |
 * | `TFLAG` | 1,262 | **46** | **0** | **0** | **入库** |
 * | `EX` | 1,068 | 3 | 3 | 2 | **不入库**（`.als` 一条也没替它消掉 ⇒ 零收益；2 条残余见下"第 5 类"） |
 * | `TEQUIP` | 3,462 | **75** | **3** | **1** | **入库**（残余 1 = `TEQUIP:震动棒`，表内是 `振動棒`／`バイブ` ⇒ **真阳性**） |
 * | `EXP` | 2,307 | 33 | 19 | 1 | **不入库**（残余 1 = `EXP:LOCAL`，假阳性类见下） |
 * | `ABL` | 8,245 | 26 | 7 | 5 | **不入库**（残余 = 作者自定义能力名 `ABL:K17C_部位V` 一类） |
 * | `PALAM` | 1,627 | 46 | 43 | 43 | **不入库**（残余 42/43 = `PALAM:LOCAL`） |
 * | `SOURCE` | 1,799 | 6 | 6 | 6 | **不入库**（残余 6/6 = `SOURCE:LOCAL`，`.als` 帮不上） |
 * | `TALENT` | 69,058 | 567 | 80 | 3 | **不入库**（77 = 作用域词；3 = 名称含全角 `／` 被扫描器截断） |
 * | `TCVAR` | 8,427 | 172 | 68 | 68 | **不入库**（残余几乎全是作者自定义名 `TCVAR:K58C_…`） |
 * | `CFLAG` | 8,370 | **1,304** | 589 | 576 | **不入库**（残余 = 自定义名族 `CFLAG:K42C_結婚` 一类，非字典缺表） |
 * | `EQUIP` | 456 | 306 | 305 | 305 | **不入库**（残余是 `EQUIP:下半身内衣` —— 表内是 `下半身内衣１`，全角数字被扫描器截断） |
 * | `ITEM` | 264 | 30 | 25 | 11 | **不入库**（自定义名 + 作用域词 + 异体名） |
 * | `DAY` | 1 | 1 | 1 | 1 | **不入库**（`DAY:晴朗`；且 `DAY.als` 名称段含行内 `;` 注释，见 adapter 测试） |
 * | `CSTR` | 18 | 0 | 0 | 0 | **不入库**（前后皆 0 ⇒ 入库零收益，且样本仅 18 处） |
 * | `JUEL` `BUFF` | 0 | — | — | — | **不入库**（本语料无二段具名引用；`BUFF.als` 只存在于魔王改版） |
 *
 * ### 四类残余（逐条核过 `文件:行`，写在测试与本报告里）
 * 1. **作用域词当名称段**：`PALAM:LOCAL` / `SOURCE:LOCAL` / `EXP:LOCAL` / `ITEM:ARG`。
 *    `TARGET` `MASTER` `PLAYER` `ARG` `RESULT` 已在 `engine-globals.ts` 里、被"裸引擎全局"口径吸收；
 *    **`LOCAL` / `GETNUM` 不在那张表里** ⇒ 它们漏成本批最大的假阳性类（PALAM 43 条里 42 条是它）。
 *    那是 E16 线的判据面（动它会改属性/悬停命中集），**本批不越线补**。补上那一行即可一次性解锁
 *    `EXP` / `PALAM` / `SOURCE` 三族入库（届时各自残余降到 ≤1）。
 * 2. **作者自定义名**：`CFLAG:K42C_結婚`×86、`TCVAR:K58C_胖次剥ぎ重複阻止`×18、`ABL:K17C_部位V`×2 等
 *    —— 住在角色目录 / 各自口上的 `#DIM` 里，游戏 `CSV/*.csv` 与 `*.als` 都不含它。
 *    要治它得给字典加"每角色自定名表"这路数据源（**P-10③ 已立项的另一个方向**，不是本批）。
 * 3. **扫描器字符集截断**：表内名称含全角 `／`（`Talent.csv:24 开朗／阴郁`、`:150 幼児／幼児退行`）
 *    或全角数字（`Equip.csv:5 下半身内衣１`）时，`identifier-chars.ts` 在标点/全角数字处切词
 *    ⇒ 名称段被截成 `开朗` / `下半身内衣`，判表外。属**语言层字符集**口径（与本批正交），
 *    放宽它 = 把全角标点收进标识符（规范 §8 明令要检测的东西）⇒ 本批不动。
 * 4. **真阳性**：`TEQUIP:震动棒`（表内 `振动棒`→`振動棒`／`バイブ`，首字就不同）
 *    `M_KOJO_K55_絶頂.ERB:217`、`TCVAR:口服避孕药`（表内 `口服避孕薬`）—— 引擎本就取不到值，
 *    这类 warn 是功能在起作用，**不算误伤**。
 * 5. **名称段是变量而非常量名**（P-10③ 已有的 `NOWEX:i` 属这一类，本批新增观测到第二条）：
 *    `IF NOWEX:i` 的 `i` 来自 `M_KOJO_K17_絶頂.ERB:64` 的 `FOR i,4,-1,-1`；
 *    `SIF EX:COUNT > EX:BEST` 的 `BEST` 来自同文件 `:4380` 的 `#DIM BEST`（映姫 K30_イベント.ERB:4395）。
 *    字典看不见符号表 ⇒ 这类形态**必然**判表外。`EX` 头因此**不入库**（它同时又是"`.als` 零收益"的头：
 *    前后都是 3 条）。要治它得让核对读别名/`#DIM` 声明，属另一条线。
 *
 * **口径声明**（写给下一个读数的人）：本表用**整行非注释扫描**（与 P-10③ 发布读数同一口径，
 * 故 `前` 列逐字可对照：CFLAG 1,304 / TALENT 567 / FLAG 126 / TCVAR 172 / TEQUIP 75 / PALAM 46 /
 * EXP 33 / ABL 26 / SOURCE 6），包含 `\@ … \@` 行内表达式，也包含散文里出现的 `族头:名字` 字样
 * ⇒ 它是**上界**。转译器真正的报点只在表达式上下文，散文命中不会进产物。
 *
 * 全语料实际 warn 面（本批最终登记态）= **3 条 / 2,317 份 `.ERB`**：
 * `NOWEX:i`×2（第 5 类，P-10③ 既有残余）+ `TEQUIP:震动棒`×1（第 4 类，真阳性）。
 * 对比 P-10③ 交付时的 4 条：汉化追加名 `Ｖ绝顶`×4 已由 `ex.als` 归零（真代码条件头里，
 * `M_KOJO_K72_セクハラコマンド.ERB:5143/5164/5185/5206` `IF NOWEX:TARGET:Ｃ绝顶 || NOWEX:Ｖ绝顶`），
 * 动态索引 `i`×2 原样留着。
 *
 * 另两张盘的对照读数（同一探针、同一口径，2026-10-14）：
 * - **魔王改版**（20 份 `.als`，2,370 份 `.ERB`）：`BASE` 711→0、`FLAG` 132→0、`TFLAG` 43→0、
 *   `TEQUIP` 98→3（实际 warn 1）、`NOWEX` 9→3（实际 warn 2）⇒ 实际 warn 面同样是 **3 条**。
 * - **原生官方版 4.842**（**0 份 `.als`**，1,280 份 `.ERB`）：新入库的 `BASE`/`FLAG`/`TFLAG`
 *   判表外 **0/0/0**（日文盘写日文名，本来就在主表里）⇒ 扩族在这张盘上**零打扰**；
 *   实际 warn 面 3 条 = `NOWEX:i`×2 + `TEQUIP:震动棒`×1（同一个真 bug 也在这张盘里，
 *   `個人口上\聖\M_KOJO_K55_絶頂.ERB:205`）。`.als` 缺席时字典与改前**逐字一致**
 *   （`inputDigest` 相同的断言钉在 adapter 侧 corpus 测试里）。
 */
const CHECKED_FAMILY_NAME_TABLES: Readonly<Record<string, readonly string[]>> = {
  NOWEX: ['NOWEX', 'EX'],
  MARK: ['MARK'],
  DOWNBASE: ['DOWNBASE', 'BASE'],
  STAIN: ['STAIN'],
  // ↓ ALS 批（2026-10-14）：`CSV/*.als` 进字典后按上表读数放开（`BASE` 是既有表键，不新增数据源）
  BASE: ['BASE'],
  FLAG: ['FLAG'],
  TFLAG: ['TFLAG'],
  TEQUIP: ['TEQUIP'],
};

/** 字典 `lookup` 的"真正收录"判据（与 `resolveFamily` 同一口径，不另立标准） */
function isRecorded(info: { description?: string; resolvedIndex?: number } | undefined): boolean {
  return info !== undefined && (info.description !== undefined || info.resolvedIndex !== undefined);
}

export function makeLookup(schema: VariableSchema): DictionaryLookup {
  /**
   * 生效族的**名称表键**：按上面登记的候选依次找（族名自己 → 引擎层同名表姊妹族）；
   * 一张都不在位 → undefined（= 无表 = 不许校验，正是 `service.ts` 头注
   * "字典未加载不误伤"的口径；未登记的族头同样直接返回 undefined）。
   */
  const nameTableKey = (family: string): string | undefined => {
    for (const key of CHECKED_FAMILY_NAME_TABLES[family] ?? []) {
      // 无索引的 lookup：表存在必回一条（哪怕只有变量名），表不存在回 undefined
      if (schema.lookup(key) !== undefined) return key;
    }
    return undefined;
  };
  return {
    resolveFamily(name: string): string | undefined {
      for (const family of ENGINE_VARIABLE_FAMILIES) {
        // lookup 在"表不存在 / 名称不在表内"时返回 undefined 或仅回显 name；
        // 只有**真正收录**（description 或 resolvedIndex 落地）才算命中。
        if (isRecorded(schema.lookup(family, name))) return family;
      }
      return undefined;
    },
    resolve(ident: string): string | undefined {
      // 原生 ERB 变量引用（`CFLAG:2` 形态）与引擎族名——原样保留。
      // **注意**：无族头的**裸引擎全局**（`SELECTCOM` / `PREVCOM` / `ARG` …）不在这里判
      // ——它们不属字典（CSV 建不出"引擎自带标量"这张表），且字典本身是可选注入的，
      // 寄生在这里会让"没打开项目时又写不了"。判据与实测计数见 `engine-globals.ts`，
      // 生效点在 `expression.ts` 的 `resolveBareIdentifier`（E16 批，2026-10-14）。
      // 同一条"可选注入"纪律也约束着具名索引核对——它**不在这里**报（`resolve` 只能
      // 返回原文或 undefined，返回 undefined 会被调用方报成 error），走
      // `unlistedFamilyName`（P-10③，warning 起步）。
      const head = ident.split(':')[0]!.toUpperCase();
      if (ENGINE_VARIABLE_FAMILIES.includes(head)) return ident;
      return undefined;
    },
    unlistedFamilyName(ident: string): { family: string; name: string } | undefined {
      // 只核 `族头:名称` **二段形**（P-10③ 的病根形态）。三段及以上（`CFLAG:TARGET:好感度`、
      // `NOWEX:PLAYER:11`）混着作用域语义，本批不碰——实测它们的表外率高，误伤面大。
      const sep = ident.indexOf(':');
      if (sep <= 0 || ident.indexOf(':', sep + 1) >= 0) return undefined;
      const family = ident.slice(0, sep).toUpperCase();
      const name = ident.slice(sep + 1);
      if (name.length === 0) return undefined;
      // 生效族 = 上面按实测表权威登记的那几张（未登记的族头逐字保持今天的放行）
      if (CHECKED_FAMILY_NAME_TABLES[family] === undefined) return undefined;
      // 纯数字索引是引擎合法写法（`CFLAG:1088`），没有"名称表"可核 ⇒ 放行
      if (/^[0-9]+$/.test(name)) return undefined;
      const table = nameTableKey(family);
      if (table === undefined) return undefined; // 无表则放行
      if (isRecorded(schema.lookup(table, name))) return undefined; // 表内 ⇒ 放行
      return { family, name };
    },
    nameAt(family: string, index: string): string | undefined {
      // 反向查询（升糖投影的属性反糖用）：`lookup(族, 索引).description` 即名称源。
      // 依据 adapter `variable-schema.ts`：编号索引 → `description = byIndex.get(编号)`；
      // 具名索引 → `description = 名称本身`；**未收录 → 无 description**（不猜）。
      const info = schema.lookup(family, index);
      const name = info?.description;
      return name !== undefined && name.length > 0 ? name : undefined;
    },
  };
}

export {
  sugarEditorLexicon,
  SUGAR_LEXICON_WORDS,
  SUGAR_LEXICON_OPERATORS,
  SUGAR_KEYWORD_ROLE_LABEL,
  RESERVED_PRONOUNS,
  CONT_MARKS,
  type SugarEditorLexicon,
  type SugarKeywordRole,
  type SugarLexiconWord,
} from './keywords';
export { createSugarTranspileService, type CreateSugarServiceOptions } from './service';
// HK-11①：系统函数中文别名（单一真源）——宿主 Monaco 层从本包派生高亮/补全
export { SYSTEM_FUNCTION_ALIASES, lowerSystemFunctions } from './system-functions';
// E16：裸引擎全局白名单（`SELECTCOM`/`PREVCOM`/…；判据与实测计数在模块头注）
export { ENGINE_GLOBAL_IDENTIFIERS, resolveEngineGlobal } from './engine-globals';
export {
  createSugarPreviewService,
  foldMessageBlocks,
  foldReachability,
  isEnvelopeChain,
  isStructuralLine,
  preview,
  scanProductFunctions,
  sourceLinesOf,
  type PreviewDeps,
} from './preview';
export type { AliasEntry, AliasTable, DictionaryLookup } from './types';
export { createSugarLiftService, liftSuggest, type LiftDeps } from './lift';
export { liftProject } from './project';
export {
  applyLift,
  applyLiftToFile,
  createSugarLiftApplyService,
  type LiftApplyDeps,
} from './lift-apply';
