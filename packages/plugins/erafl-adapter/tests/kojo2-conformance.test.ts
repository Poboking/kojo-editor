/**
 * eraFL 的 Kojo 2.0 面 **conformance 夹具**（方言矩阵第二列）。
 *
 * ## 本文件交付什么（判据写在前面，免得被读成"全绿"）
 *
 * eraFL 的 2.0 面**刻意只做了一半**：`src/kojo2/` 有数据面 + 一枚 `KojoEmitBackend`，
 * 但没有 collections / table(selectcase) / options / foreach 的发射面，也没有 `@织` 装配。
 * ⇒ 夹具跑起来必然有一批红。本批的交付是两件事，缺一件都不算做完：
 *
 * 1. **支持的子集全绿**（§A 契约自检 + §B 52 枚用例）：`runAdapterConformance` 的验收面
 *    （contract / golden / differential / readings / encoding）在 eraFL 真支持的构造上逐格绿，
 *    一条不掺水（golden 20 · differential 3 · readings 13 · fail-visible 14 · encoding 2）；
 * 2. **红名单机器可查**（§F `GAP_ROWS`，14 行）：缺哪一面、缺在哪一格、报哪一枚诊断码——
 *    11 行由 §B 的 fail-visible 用例或 §C 的错配必红用例背书（不是写在注释里的散文），
 *    另 3 行是口径声明（smoke / differential 基线 / migration），由 §A 的 skip 读数与
 *    §F 的专项直读背书，行里 `witness === null` 写死，不许混进"有用例"那一堆。
 *    任何一行"面补上了但夹具没跟上"或"夹具绿了但缺口没销"都会红在这里。
 *
 * §D 另外钉"读数不同源必红"八格（backend 与 adapter 串一档就红在对应字段上），
 * §E 钉事件目录的三层结构（4 条引擎事件 / eraFL 自己包的流程函数 / 作者口上钩子）。
 *
 * ## 事实来源（红线：不许从 eraTW 抄）
 *
 * 每一格的依据都是 eraFL 自己的声明 + 真盘读数，出处写在对应数据文件的头注里：
 * - 四事件（`EVENTFIRST`/`EVENTLOAD`/`EVENTSHOP`/`EVENTBUY`，各一份真定义）→ `kojo2/event-catalog.ts`；
 * - 编码 UTF-8 BOM + CRLF（全树 2,016 份 `.ERB`：1,940 份带 BOM、其中 1,922 份 CRLF、0 份纯 LF、
 *   0 份 UTF-16LE）→ `kojo2/capabilities.ts`；
 * - 演出面只有 `color`（`SETCOLOR` 1,932 / `RESETCOLOR` 841 / `PRINT_FACE` 0 / 口上域选项 UI 2）
 *   → `kojo2/presentation.ts`；
 * - 程序层 `arrays/while/goto/repeat` 开、`recursion/foreach` 关（`WHILE` 123 / `GOTO` 77 /
 *   `REPEAT` 4 / 递归无实证 / `@巡` 零语料）→ `kojo2/program.ts`；
 * - 代词三轴落点 `[$KNAME]`/`[$MNAME]`/`[$TNAME]`（口上域 XML 全树读数 2,875 / 6,951 / 740）
 *   → `kojo2/domain-symbols.ts`。
 *
 * §C 里"把 eraTW 的事实喂给 eraFL"的那些用例，输入用的是 **eraTW 的形状**（eraFL 没有的那五个
 * 引擎事件名、eraTW 的 UTF-16LE 编码、eraTW 的 `# 机 … 310` 带参形状），期望值一律是
 * "必须红 + 红在哪一格"——这正是本列存在的意义：没有第二列，这类断言无处可跑。
 *
 * ## 表达式端口（红名单「表达式端口」那一行的根，读夹具前必须知道）
 *
 * `createEraflEmitBackend` 的 `compileExpression` 由宿主注入；2.0 侧那条管线**还没接**
 * （v1 的 `lowerExpression` 未进 2.0 面）。本夹具因此用**恒等端口** `(expr) => expr.text`，
 * 产物里的 `{我}` 落成 `%我%`、`# 常量 亲近线` 不内联。这不是夹具偷懒，而是把缺口如实钉成
 * 断言（§F 的两枚直读 + `mismatch/代词落点 [$KNAME]…`、`mismatch/常量内联…` 两枚必红用例）：
 * 端口接上那天，这两枚会自动变成"期望不符"，逼着人回来把红名单那一行销掉。
 *
 * ## 真盘用例
 *
 * §E 的盘面分层核对只在 `D:/Game/erafl` 在位时跑（红线 6；本机在位 ⇒ 本批实际跑过）。
 * 合成用例不依赖真盘，独立成立。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameAdapter, KojoEmitBackend } from '@kojo/kojo-core';
import { compileKojoSource } from '@kojo/kojo-core';
import type {
  AdapterConformanceCase,
  AdapterConformanceReport,
  ConformanceCaseReport,
} from '../../../kojo-conformance/src/index.js';
import { encodeConformanceText, runAdapterConformance } from '../../../kojo-conformance/src/index.js';
import {
  ERAFL_CONFORMANCE_SUITE,
  ERAFL_DOMAIN_SYMBOLS,
  ERAFL_ENCODING_POLICY,
  ERAFL_GAME_ADAPTER,
  ERAFL_PRESENTATION,
  ERAFL_PROGRAM_FEATURES,
  createEraflEmitBackend,
} from '../src/kojo2';

/* ============================== 0. 夹具装载 ============================== */

const FIXTURE_DIR = new URL('./fixtures/kojo2-conformance/', import.meta.url);
const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf8');

/** 恒等表达式端口（见文件头"表达式端口"一节；真管线住宿主，本包不 import） */
const identityCompileExpression = (expr: { text: string }): string => expr.text;

const eraflBackend = (): KojoEmitBackend =>
  createEraflEmitBackend({ compileExpression: identityCompileExpression });

/**
 * 支持子集的 golden 用例名（`<名>.kojo2` + `<名>.golden.erb` 成对，产物由真 core +
 * eraFL backend 生成后逐行人眼复核，不是手写）。
 */
const SUPPORTED_GOLDEN_CASES: readonly string[] = Object.freeze([
  'narrative-basic',
  'machine-load',
  'machine-shop',
  'machine-buy',
  'condition-chain',
  'condition-sif',
  'presentation-color',
  'random-printdata',
  'random-selectcase',
  'table-buckets',
  'pool-expand',
  'template-slot',
  'program-while',
  'program-repeat',
  'program-goto',
  'program-function',
  'compute-array',
  'native-xml-register',
  'narrative-interpolation',
  'storage-periods',
]);

/** differential 基线（`<名>.erb`，按落点形状手写的等价物；口径声明见 §F 红名单「套件·differential 基线」行） */
const SUPPORTED_DIFFERENTIAL_CASES: readonly string[] = Object.freeze([
  'narrative-basic',
  'condition-chain',
  'presentation-color',
]);

/* ============================== A1. 读数值（一次写死，逐条对拍） ============================== */

/** §A3 的 readings 期望（数值 = kit 口径实测，探针跑出来后逐条钉死，不许"只要非空"） */
const SUPPORTED_READINGS: readonly AdapterConformanceCase[] = [
  {
    kind: 'readings',
    name: 'readings/叙事与空行三态',
    source: readFixture('narrative-basic.kojo2'),
    expectedDiagnostics: [],
    readings: {
      events: Object.freeze([Object.freeze({ source: 'machine', event: '初见', args: [], guard: null })]),
      waits: Object.freeze([
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'blank', wait: 'wait' }),
        Object.freeze({ kind: 'blank', wait: 'wait' }),
        Object.freeze({ kind: 'blank', wait: 'continue' }),
      ]),
      colors: Object.freeze([]),
      slots: Object.freeze([]),
      sourceMapLines: 8,
      artifactLines: 8,
    },
  },
  {
    kind: 'readings',
    name: 'readings/取色配对（唯一有语料的演出面）',
    source: readFixture('presentation-color.kojo2'),
    expectedDiagnostics: [],
    readings: {
      colors: Object.freeze([
        Object.freeze({ source: 'block-enter', value: '0xFF8080' }),
        Object.freeze({ source: 'text', value: '0xFF8080' }),
        Object.freeze({ source: 'text', value: '0xFF8080' }),
        Object.freeze({ source: 'block-exit', value: null }),
      ]),
      waits: Object.freeze([
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
      ]),
      slots: Object.freeze([]),
      sourceMapLines: 8,
      artifactLines: 8,
    },
  },
  {
    // `# 表` 的两个隐藏槽：int 档 + string 值档（backend 按 core 给的 valueType 落 `#DIM`/`#DIMS`）
    kind: 'readings',
    name: 'readings/表槽（#DIM + #DIMS）',
    source: readFixture('table-buckets.kojo2'),
    expectedDiagnostics: [],
    readings: {
      slots: Object.freeze(['__kojo_table_心情', '__kojo_table_心情__value']),
      waits: Object.freeze([Object.freeze({ kind: 'text', wait: 'wait' })]),
      sourceMapLines: 14,
      artifactLines: 14,
    },
  },
  {
    // 多行/有副作用候选 ⇒ 强制 RAND + SELECTCASE（§8.4），等待轴逐候选可见
    kind: 'readings',
    name: 'readings/随机 selectcase 路',
    source: readFixture('random-selectcase.kojo2'),
    expectedDiagnostics: [],
    readings: {
      slots: Object.freeze(['__kojo_rand_3']),
      waits: Object.freeze([
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'blank', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
      ]),
      sourceMapLines: 12,
      artifactLines: 12,
    },
  },
  {
    // PRINTDATA 路把逐候选等待折成尾部一枚 `WAIT` ⇒ 等待读数为 0 条是**事实**（不是漏测）
    kind: 'readings',
    name: 'readings/随机 printdata 路（等待折叠）',
    source: readFixture('random-printdata.kojo2'),
    expectedDiagnostics: [],
    readings: {
      slots: Object.freeze(['__kojo_rand_3']),
      waits: Object.freeze([]),
      sourceMapLines: 8,
      artifactLines: 8,
    },
  },
  {
    kind: 'readings',
    name: 'readings/引擎事件 读档',
    source: readFixture('machine-load.kojo2'),
    expectedDiagnostics: [],
    readings: {
      events: Object.freeze([Object.freeze({ source: 'machine', event: '读档', args: [], guard: null })]),
      artifactLines: 4,
      sourceMapLines: 4,
    },
  },
  {
    kind: 'readings',
    name: 'readings/引擎事件 商店',
    source: readFixture('machine-shop.kojo2'),
    expectedDiagnostics: [],
    readings: {
      events: Object.freeze([Object.freeze({ source: 'machine', event: '商店', args: [], guard: null })]),
      artifactLines: 4,
      sourceMapLines: 4,
    },
  },
  {
    kind: 'readings',
    name: 'readings/引擎事件 购买',
    source: readFixture('machine-buy.kojo2'),
    expectedDiagnostics: [],
    readings: {
      events: Object.freeze([Object.freeze({ source: 'machine', event: '购买', args: [], guard: null })]),
      artifactLines: 4,
      sourceMapLines: 4,
    },
  },
  {
    // 三个存储期的**声明**不产字节（只有赋值行落产物）⇒ 这一格是红名单「存储期落点」行的背书用例
    kind: 'readings',
    name: 'readings/三存储期声明零落点',
    source: readFixture('storage-periods.kojo2'),
    expectedDiagnostics: [],
    readings: {
      slots: Object.freeze([]),
      waits: Object.freeze([Object.freeze({ kind: 'text', wait: 'wait' })]),
      sourceMapLines: 7,
      artifactLines: 7,
    },
  },
  {
    kind: 'readings',
    name: 'readings/原生围栏逐行透传（成对注册壳）',
    source: readFixture('native-xml-register.kojo2'),
    expectedDiagnostics: [],
    readings: {
      waits: Object.freeze([]),
      slots: Object.freeze([]),
      sourceMapLines: 5,
      artifactLines: 5,
    },
  },
  {
    kind: 'readings',
    name: 'readings/单语句分支落 SIF',
    source: readFixture('condition-sif.kojo2'),
    expectedDiagnostics: [],
    readings: {
      waits: Object.freeze([Object.freeze({ kind: 'text', wait: 'wait' })]),
      artifactLines: 5,
      sourceMapLines: 5,
    },
  },
  {
    kind: 'readings',
    name: 'readings/池编译期展开',
    source: readFixture('pool-expand.kojo2'),
    expectedDiagnostics: [],
    readings: {
      waits: Object.freeze([
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
      ]),
      slots: Object.freeze([]),
      artifactLines: 8,
      sourceMapLines: 8,
    },
  },
  {
    kind: 'readings',
    name: 'readings/模板插槽展开',
    source: readFixture('template-slot.kojo2'),
    expectedDiagnostics: [],
    readings: {
      waits: Object.freeze([
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
        Object.freeze({ kind: 'text', wait: 'wait' }),
      ]),
      slots: Object.freeze([]),
      artifactLines: 6,
      sourceMapLines: 6,
    },
  },
];

/* ============================== A2. fail-visible 子集（缺面如实报错 = 绿） ============================== */

/**
 * "本 adapter 不支持 ⇒ 报错且不产半成品字节"是**正确行为**，所以这些用例在 kit 里是绿的；
 * 它们同时是 §F 红名单的背书证据（码 + 行 + 0 字节三个维度一起钉，缺一维都算没测到）。
 */
const FAIL_VISIBLE_CASES: readonly AdapterConformanceCase[] = [
  /* --- 事件面：eraTW 的九事件里 eraFL 只有四条 --- */
  {
    kind: 'readings',
    name: 'refuses/事件 训练（eraFL 无此引擎事件）',
    source: '# 机 训练\n\n> 这条事件在 eraFL 树里没有定义。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/unknown', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/事件 指令（eraFL 无此引擎事件）',
    source: '# 机 指令\n\n> eraFL 用 KOJO_EVENT_K{n} 那条轴，不是引擎事件。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/unknown', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/事件 训练结束（eraFL 无此引擎事件）',
    source: '# 机 训练结束\n\n> 没有 @EVENTEND。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/unknown', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/事件 回合末（eraFL 只有 @FL_EVENTTURNEND）',
    source: '# 机 回合末\n\n> 被 eraFL 自己的流程函数包了一层。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/unknown', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/事件 指令结束（eraFL 只有 @QST_EVENTCOMEND）',
    source: '# 机 指令结束\n\n> 同上：任务侧自己包的函数，不是引擎事件。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/unknown', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  {
    // eraTW 的 `# 机 指令 310`（COM 编号）形状套到 eraFL 的真事件上：参数轴 eraFL 一条都没有
    kind: 'readings',
    name: 'refuses/事件带编号（四事件 args 全空）',
    source: '# 机 初见 310\n\n> eraFL 的四个引擎事件都不接参。\n',
    expectedDiagnostics: [Object.freeze({ code: 'event/argument', severity: 'error', line: 1 })],
    readings: { artifactLines: 0 },
  },
  /* --- 演出面：只有 color 有语料 --- */
  {
    kind: 'readings',
    name: 'refuses/心形（presentation.heart = null）',
    source: '# 机 初见\n\n> 她别过头，耳尖红了。(心形)\n',
    expectedDiagnostics: [Object.freeze({ code: 'core/feature/unsupported', severity: 'error', line: 3 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/颜绘（PRINT_FACE 真盘 0 处，立绘在 XML 属性侧）',
    source: '# 机 初见\n\n@颜绘 微笑\n',
    expectedDiagnostics: [Object.freeze({ code: 'core/face/unsupported', severity: 'error', line: 3 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/选项（口上域选项 UI 真盘 2 处 ⇒ 不声明）',
    source: '# 机 初见\n\n选项：\n    「甲」：\n        > 甲路。\n    「乙」：\n        > 乙路。\n',
    expectedDiagnostics: Object.freeze([
      Object.freeze({ code: 'core/options/pending', severity: 'warning', line: 3 }),
      Object.freeze({ code: 'core/feature/unsupported', severity: 'error', line: 3 }),
    ]),
    readings: { artifactLines: 0 },
  },
  /* --- 装配面：@织 / @巡 / 递归 / 属性写 --- */
  {
    kind: 'readings',
    name: 'refuses/@织（真盘 #PRI/#LATER/#ONLY 实测 0 处 ⇒ 本版不装配）',
    source: '# 机 初见\n\n> 正文。\n\n@织 初见 之后\n    > 监听体。\n',
    expectedDiagnostics: [Object.freeze({ code: 'unit/backend-incomplete', severity: 'error', line: 5 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/@巡（programFeatures.foreach = false 且无集合声明）',
    source: '# 机 初见\n# 变量 队伍状态 字符串[3]\n\n@巡 队伍状态\n    > {值}。\n',
    expectedDiagnostics: [Object.freeze({ code: 'core/control/unsupported', severity: 'error', line: 4 })],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/递归（无自调用实证）',
    source:
      '# 机 初见\n# 变量 结果 整数\n\n@函 斐波那契(n)\n    ? n <= 1\n        @返 n\n    ? 否\n        @返 斐波那契(n - 1) + 斐波那契(n - 2)\n',
    expectedDiagnostics: [
      Object.freeze({ code: 'core/func/recursion-unsupported', severity: 'error', line: 8 }),
    ],
    readings: { artifactLines: 0 },
  },
  {
    // adapter 声明五条状态线**可写**（`readonly: false`），但表达式管线未接 ⇒ 写入落 unknown-symbol。
    // 声明与产物面互相矛盾 = 红名单「表达式端口」行的子格，本用例把矛盾钉住（销缺口时要连这条一起改）。
    kind: 'readings',
    name: 'refuses/属性写入（声明可写、产物面不认）',
    source: '# 机 初见\n\n@算\n    好感度 += 10\n\n> 涨了。\n',
    expectedDiagnostics: [
      Object.freeze({ code: 'core/expr/unknown-symbol', severity: 'error', line: 4 }),
    ],
    readings: { artifactLines: 0 },
  },
  {
    kind: 'readings',
    name: 'refuses/表缺 否（不引用也报）',
    source: '# 机 初见\n\n# 表 心情 由 依存度\n    0..99 疏远\n\n> {心情}。\n',
    expectedDiagnostics: [Object.freeze({ code: 'core/table/missing-default', severity: 'error', line: 3 })],
    readings: { artifactLines: 0 },
  },
];

/* ============================== A3. 编码面（eraFL = UTF-8 BOM + CRLF，这条要钉） ============================== */

/** UTF-8 BOM + CRLF（真盘主流形态：1,940 份带 BOM、其中 1,922 份 CRLF） */
const BOM_CRLF_BYTES = encodeConformanceText(readFixture('narrative-basic.kojo2'), {
  encoding: 'utf-8-bom',
  eol: 'crlf',
  trailingNewline: true,
});

/** UTF-8 无 BOM + CRLF（真盘既成事实的 76 份：读要能读，保存才按缺省形态） */
const NO_BOM_CRLF_BYTES = encodeConformanceText(readFixture('condition-chain.kojo2'), {
  encoding: 'utf-8',
  eol: 'crlf',
  trailingNewline: true,
});

const SUPPORTED_ENCODING_CASES: readonly AdapterConformanceCase[] = [
  {
    kind: 'encoding',
    name: 'encoding/utf8-bom-crlf（eraFL 缺省形态）',
    bytes: BOM_CRLF_BYTES,
    encoding: Object.freeze({ sourceEncoding: 'utf-8-bom', sourceEol: 'crlf', preserveBom: true, preserveEol: true }),
  },
  {
    kind: 'encoding',
    name: 'encoding/utf8-无BOM-crlf（真盘 76 份既成事实）',
    bytes: NO_BOM_CRLF_BYTES,
    encoding: Object.freeze({ sourceEncoding: 'utf-8', sourceEol: 'crlf', preserveBom: true, preserveEol: true }),
  },
];

/* ============================== A. 支持子集：一次跑完，逐面对拍 ============================== */

const SUPPORTED_CASES: readonly AdapterConformanceCase[] = Object.freeze([
  ...SUPPORTED_GOLDEN_CASES.map((name) => Object.freeze({
    kind: 'golden' as const,
    name: `golden/${name}`,
    source: readFixture(`${name}.kojo2`),
    expectedErb: readFixture(`${name}.golden.erb`),
  })),
  ...SUPPORTED_DIFFERENTIAL_CASES.map((name) => Object.freeze({
    kind: 'differential' as const,
    name: `differential/${name}`,
    source: readFixture(`${name}.kojo2`),
    baseline: readFixture(`${name}.erb`),
  })),
  ...SUPPORTED_READINGS,
  ...FAIL_VISIBLE_CASES,
  ...SUPPORTED_ENCODING_CASES,
]);

const supportedReport = runAdapterConformance({
  adapter: ERAFL_GAME_ADAPTER,
  backend: eraflBackend(),
  cases: SUPPORTED_CASES,
});

const caseByName = (report: AdapterConformanceReport, name: string): ConformanceCaseReport | undefined =>
  report.cases.find((item) => item.name === name);

describe('eraFL 2.0 conformance · §A 契约自检（真 core + eraFL 数据 + eraFL backend）', () => {
  it('validateGameAdapter 零诊断、backend 读数与 adapter 同源', () => {
    expect(supportedReport.contract.ok).toBe(true);
    expect(supportedReport.contract.failures).toEqual([]);
    expect(supportedReport.contract.diagnostics).toEqual([]);
    expect(supportedReport.contract.adapterId).toBe('erafl');
    expect(supportedReport.contract.backendId).toBe('erafl');
  });

  it('backend profile 读数 = eraFL 真盘数值（等待/取色/D 系/池/随机/优先级）', () => {
    expect(supportedReport.contract.profile).toEqual({
      waitDefault: 'wait',
      narrationColor: 'author',
      dialogueColor: 'author',
      colorMode: 'D',
      poolStyle: 'if',
      randStyle: 'printdata',
      priorityModel: 'emuera-buckets',
      presentations: { heart: false, color: true, face: false, options: false },
      programFeatures: {
        arrays: true,
        while: true,
        goto: true,
        recursion: false,
        foreach: false,
        repeat: true,
      },
    });
  });

  it('事件目录读数 = 四条引擎事件（不是 eraTW 的九条）', () => {
    expect(supportedReport.contract.events).toEqual([
      {
        event: '初见',
        engine: 'EVENTFIRST',
        args: [],
        dispatch: 'engine-dispatch',
        priority: 'emuera-buckets',
        guard: null,
        forced: true,
        weavable: true,
      },
      {
        event: '读档',
        engine: 'EVENTLOAD',
        args: [],
        dispatch: 'engine-dispatch',
        priority: 'emuera-buckets',
        guard: null,
        forced: false,
        weavable: true,
      },
      {
        event: '商店',
        engine: 'EVENTSHOP',
        args: [],
        dispatch: 'engine-dispatch',
        priority: 'emuera-buckets',
        guard: null,
        forced: false,
        weavable: true,
      },
      {
        event: '购买',
        engine: 'EVENTBUY',
        args: [],
        dispatch: 'engine-dispatch',
        priority: 'emuera-buckets',
        guard: null,
        forced: false,
        weavable: true,
      },
    ]);
  });

  it('smoke 面由 kit 自己记账为 skip（真实壳不在本包，不伪造 pass）', () => {
    expect(supportedReport.skips.map((skip) => skip.check)).toEqual(['smoke']);
    expect(supportedReport.summary.byCheck.find((item) => item.check === 'smoke')).toEqual({
      check: 'smoke',
      passed: 0,
      failed: 0,
      skipped: 1,
    });
  });
});

describe('eraFL 2.0 conformance · §B 支持的子集全绿', () => {
  it('整个子集零失败（report.ok 与 failures 双钉）', () => {
    expect(supportedReport.failures).toEqual([]);
    expect(supportedReport.ok).toBe(true);
  });

  it('逐面计数：golden 20 / differential 3 / readings 27 / encoding 2 全过', () => {
    expect(supportedReport.summary).toMatchObject({
      cases: 52,
      passed: 52,
      failed: 0,
      failures: 0,
    });
    const byCheck = new Map(supportedReport.summary.byCheck.map((item) => [item.check, item]));
    expect(byCheck.get('golden')).toEqual({ check: 'golden', passed: 20, failed: 0, skipped: 0 });
    expect(byCheck.get('differential')).toEqual({ check: 'differential', passed: 3, failed: 0, skipped: 0 });
    expect(byCheck.get('readings')).toEqual({ check: 'readings', passed: 27, failed: 0, skipped: 0 });
    expect(byCheck.get('encoding')).toEqual({ check: 'encoding', passed: 2, failed: 0, skipped: 0 });
  });

  it('用例名不重复（重复名会让定位失效）', () => {
    const names = SUPPORTED_CASES.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(52);
  });

  it('每一枚 golden 用例都真绿（逐条点名，不靠汇总数）', () => {
    for (const name of SUPPORTED_GOLDEN_CASES) {
      const item = caseByName(supportedReport, `golden/${name}`);
      expect(item, `golden/${name} 缺用例`).toBeDefined();
      expect(item?.ok, `golden/${name} 应当逐字节相等`).toBe(true);
      expect(item?.failures).toEqual([]);
    }
  });

  it('每一枚 fail-visible 用例都绿且 0 字节（fail-closed，不产半成品）', () => {
    for (const testCase of FAIL_VISIBLE_CASES) {
      const item = caseByName(supportedReport, testCase.name);
      expect(item, `${testCase.name} 缺用例`).toBeDefined();
      expect(item?.ok, `${testCase.name} 的诊断码/行与实得不同`).toBe(true);
      expect(item?.observations.readings?.artifactLines).toBe(0);
      expect(item?.observations.erbBytes).toBe(0);
    }
  });

  it('differential 三条逐行等值（行为序列，不比字节）', () => {
    for (const name of SUPPORTED_DIFFERENTIAL_CASES) {
      const item = caseByName(supportedReport, `differential/${name}`);
      expect(item?.ok, `differential/${name} 行为序列不一致`).toBe(true);
      const reading = item?.observations.differential;
      expect(reading?.equal).toBe(true);
      expect(reading?.summary).toMatchObject({ removed: 0, added: 0 });
      expect(reading?.firstDifferenceLine).toBeNull();
    }
  });

  it('编码面：UTF-8 BOM + CRLF 逐字节保留（roundTrip / EOL / BOM 四个不变量齐绿）', () => {
    const bom = caseByName(supportedReport, 'encoding/utf8-bom-crlf（eraFL 缺省形态）');
    const reading = bom?.observations.encoding;
    expect(bom?.ok).toBe(true);
    expect(reading).not.toBeNull();
    expect(reading?.source).toEqual({ encoding: 'utf-8-bom', eol: 'crlf', bom: true, bytes: BOM_CRLF_BYTES.length });
    expect(reading?.output.encoding).toBe('utf-8-bom');
    expect(reading?.output.eol).toBe('crlf');
    expect(reading?.output.bom).toBe(true);
    expect(reading?.roundTrip).toBe(true);
    expect(reading?.eolInvariant).toBe(true);
    expect(reading?.bomInvariant).toBe(true);
    expect(reading?.preservedBom).toBe(true);
    expect(reading?.preservedEol).toBe(true);

    const nobom = caseByName(supportedReport, 'encoding/utf8-无BOM-crlf（真盘 76 份既成事实）');
    expect(nobom?.ok).toBe(true);
    expect(nobom?.observations.encoding?.source).toEqual({
      encoding: 'utf-8',
      eol: 'crlf',
      bom: false,
      bytes: NO_BOM_CRLF_BYTES.length,
    });
    expect(nobom?.observations.encoding?.roundTrip).toBe(true);
  });

  it('eraFL 缺省编码就是 utf-8-bom（照抄 eraTW 的 utf-16le-bom 会静默错）', () => {
    expect(ERAFL_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERAFL_ENCODING_POLICY.allowedEncodings).toEqual(['utf-8-bom', 'utf-8']);
    expect(ERAFL_ENCODING_POLICY.allowedEncodings).not.toContain('utf-16le-bom');
  });
});

/* ============================== C. 方言错配必红（第二列的存在理由） ============================== */

/** eraTW 的形状（训练事件 / 带编号 / 心形 / [$KNAME] / UTF-16LE）喂给 eraFL ⇒ 必须红 */
const MISMATCH_CASES: readonly AdapterConformanceCase[] = [
  {
    kind: 'golden',
    name: 'mismatch/eraTW 事件 训练 的产物形状',
    source: '# 机 训练\n\n> 这条事件在 eraFL 树里没有定义。\n',
    expectedErb: ';kojo2: # 机 训练\n@EVENTTRAIN\n#LATER\n    PRINTFORMW 这条事件在 eraFL 树里没有定义。\n',
  },
  {
    kind: 'golden',
    name: 'mismatch/eraTW 事件 指令 带编号',
    source: '# 机 指令 310\n\n> eraFL 没有 @EVENTCOM。\n',
    expectedErb: ';kojo2: # 机 指令 310\n@EVENTCOM\n#LATER\n    PRINTFORMW eraFL 没有 @EVENTCOM。\n',
  },
  {
    kind: 'golden',
    name: 'mismatch/eraTW 的带参形状套在 eraFL 真事件上',
    source: '# 机 初见 310\n\n> eraFL 的四个引擎事件都不接参。\n',
    expectedErb: ';kojo2: # 机 初见 310\n@EVENTFIRST\n#LATER\n    PRINTFORMW eraFL 的四个引擎事件都不接参。\n',
  },
  {
    kind: 'golden',
    name: 'mismatch/eraTW 的心形落点',
    source: '# 机 初见\n\n> 她别过头，耳尖红了。(心形)\n',
    expectedErb: ';kojo2: # 机 初见\n@EVENTFIRST\n#LATER\n    HPH_PRINT "w"\n    PRINTFORMW 她别过头，耳尖红了。(心形)\n',
  },
  {
    kind: 'golden',
    name: 'mismatch/代词落点 [$KNAME]（表达式端口未接）',
    source: '# 机 初见\n# 视 ティア\n\n> 我是{我}。\n',
    expectedErb: ';kojo2: # 机 初见\n@EVENTFIRST\n#LATER\n    PRINTFORMW 我是[$KNAME]。\n',
  },
  {
    kind: 'differential',
    name: 'mismatch/常量内联（作者手写 500，产物落 亲近线）',
    source: readFixture('condition-chain.kojo2'),
    baseline: '@EVENTFIRST\n#LATER\n    IF RESULTS >= 500\n    PRINTFORML 第一档。\n    ELSEIF RESULTS >= 100\n    PRINTFORMW 第二档。\n    ELSE\n    PRINTFORMW 兜底。\n    ENDIF\n',
  },
  {
    kind: 'encoding',
    name: 'mismatch/eraTW 的 UTF-16LE 源',
    bytes: encodeConformanceText(readFixture('narrative-basic.kojo2'), {
      encoding: 'utf-16le-bom',
      eol: 'crlf',
      trailingNewline: true,
    }),
    encoding: Object.freeze({ sourceEncoding: 'utf-16le-bom', sourceEol: 'crlf' }),
  },
  {
    kind: 'encoding',
    name: 'mismatch/LF 源（eraFL 的 EOL 口径是 crlf）',
    bytes: encodeConformanceText(readFixture('narrative-basic.kojo2'), {
      encoding: 'utf-8-bom',
      eol: 'lf',
      trailingNewline: true,
    }),
    encoding: Object.freeze({ sourceEncoding: 'utf-8-bom', sourceEol: 'lf' }),
  },
];

const mismatchReport = runAdapterConformance({
  adapter: ERAFL_GAME_ADAPTER,
  backend: eraflBackend(),
  cases: MISMATCH_CASES,
});

/** 取某枚错配用例的全部失败码（排序后比较，失败顺序不是契约面） */
function mismatchCodes(name: string): readonly string[] {
  const item = caseByName(mismatchReport, name);
  expect(item, `${name} 缺用例`).toBeDefined();
  return Object.freeze([...(item?.failures.map((failure) => failure.code) ?? [])].sort());
}

/** 取某枚错配用例的失败字段 */
function mismatchFields(name: string): readonly string[] {
  const item = caseByName(mismatchReport, name);
  return Object.freeze([...(item?.failures.map((failure) => failure.location.field) ?? [])].sort());
}

describe('eraFL 2.0 conformance · §C 把 eraTW 的事实喂给 eraFL 必须红', () => {
  it('八条错配用例一条都没被放过（report.ok 必 false，failed 必 8）', () => {
    expect(mismatchReport.ok).toBe(false);
    expect(mismatchReport.summary.failed).toBe(8);
    for (const testCase of MISMATCH_CASES) {
      expect(caseByName(mismatchReport, testCase.name)?.ok, `${testCase.name} 竟然绿了`).toBe(false);
    }
  });

  it('eraTW 第五~九事件在 eraFL 侧红成 event/unknown（红里看得见码与行）', () => {
    expect(mismatchCodes('mismatch/eraTW 事件 训练 的产物形状')).toEqual(['conformance/diagnostics', 'conformance/golden']);
    const training = caseByName(mismatchReport, 'mismatch/eraTW 事件 训练 的产物形状');
    const diagnostic = training?.failures.find((failure) => failure.code === 'conformance/diagnostics');
    expect(diagnostic?.actual).toContain('event/unknown');
    expect(diagnostic?.location.sourceLine).toBe(1);
  });

  it('eraTW 的 `# 机 指令 310` 双重不合：事件不存在 + 参数轴不存在', () => {
    const call = caseByName(mismatchReport, 'mismatch/eraTW 事件 指令 带编号');
    expect(call?.failures.some((failure) => (failure.actual ?? '').includes('event/unknown'))).toBe(true);
    const argument = caseByName(mismatchReport, 'mismatch/eraTW 的带参形状套在 eraFL 真事件上');
    expect(argument?.failures.some((failure) => (failure.actual ?? '').includes('event/argument'))).toBe(true);
    expect(argument?.failures.map((failure) => failure.code).sort()).toEqual([
      'conformance/diagnostics',
      'conformance/golden',
    ]);
  });

  it('eraTW 的心形落点在 eraFL 侧红（且报 core/feature/unsupported，不是静默少一行）', () => {
    expect(mismatchCodes('mismatch/eraTW 的心形落点')).toEqual(['conformance/diagnostics', 'conformance/golden']);
    const item = caseByName(mismatchReport, 'mismatch/eraTW 的心形落点');
    expect(item?.failures.some((failure) => (failure.actual ?? '').includes('core/feature/unsupported'))).toBe(true);
    expect(item?.observations.erbBytes).toBe(0);
  });

  it('代词落点：eraFL 主形 [$KNAME] 现在落不出来（红名单「表达式端口」行的必红见证）', () => {
    expect(mismatchCodes('mismatch/代词落点 [$KNAME]（表达式端口未接）')).toEqual(['conformance/golden']);
    const item = caseByName(mismatchReport, 'mismatch/代词落点 [$KNAME]（表达式端口未接）');
    expect(item?.observations.readings?.artifactLines).toBe(4);
    expect(item?.failures[0]?.actual).toContain('%我%');
    expect(item?.failures[0]?.expected).toContain('[$KNAME]');
  });

  it('常量不内联：作者手写的 500 与 2.0 产物不等价（differential 必红）', () => {
    expect(mismatchCodes('mismatch/常量内联（作者手写 500，产物落 亲近线）')).toEqual(['conformance/differential']);
    const item = caseByName(mismatchReport, 'mismatch/常量内联（作者手写 500，产物落 亲近线）');
    const differential = item?.observations.differential;
    expect(differential?.equal).toBe(false);
    expect(differential?.firstDifferenceLine).not.toBeNull();
    const changed = (item?.failures[0]?.diff ?? []).filter((line) => line.kind !== 'same');
    expect(changed.some((line) => (line.baseline ?? '').includes('>= 500'))).toBe(true);
    expect(changed.some((line) => (line.candidate ?? '').includes('>= 亲近线'))).toBe(true);
  });

  it('编码错配：eraTW 的 UTF-16LE 源被 eraFL 的策略拒绝（红在 allowedEncodings 那一格）', () => {
    expect(mismatchCodes('mismatch/eraTW 的 UTF-16LE 源')).toEqual(['conformance/encoding']);
    expect(mismatchFields('mismatch/eraTW 的 UTF-16LE 源')).toEqual(['adapter.encodingPolicy.allowedEncodings']);
  });

  it('EOL 错配：LF 源踩 eraFL 的 crlf 硬口径（红在 adapter.encodingPolicy.eol 那一格）', () => {
    expect(mismatchCodes('mismatch/LF 源（eraFL 的 EOL 口径是 crlf）')).toEqual(['conformance/encoding']);
    expect(mismatchFields('mismatch/LF 源（eraFL 的 EOL 口径是 crlf）')).toEqual(['adapter.encodingPolicy.eol']);
  });
});

/* ============================== D. 读数不同源必红（第二列也吃同一套闸） ============================== */

interface Mutation {
  readonly name: string;
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly code: string;
  readonly field: string;
}

const BASE_BACKEND = eraflBackend();

function mutateBackend(patch: (backend: KojoEmitBackend) => KojoEmitBackend): KojoEmitBackend {
  return patch(BASE_BACKEND);
}

const MUTATIONS: readonly Mutation[] = Object.freeze([
  {
    name: 'backend.id 串成别的游戏',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({ ...b, id: 'eratw' })),
    code: 'conformance/backend',
    field: 'backend.id',
  },
  {
    name: 'backend 等待缺省不等于 adapter',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({ ...b, profile: { ...b.profile, waitDefault: 'continue' } })),
    code: 'conformance/backend',
    field: 'backend.profile.waitDefault',
  },
  {
    name: 'backend 声称支持心形（eraFL 的 presentation.heart 是 null）',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({
      ...b,
      profile: { ...b.profile, presentations: { ...b.profile.presentations, heart: true } },
    })),
    code: 'conformance/backend',
    field: 'backend.profile.presentations.heart',
  },
  {
    name: 'backend 声称能 foreach（adapter 的 programFeatures.foreach 是 false）',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({
      ...b,
      profile: {
        ...b.profile,
        programFeatures: { arrays: true, while: true, goto: true, recursion: false, foreach: true, repeat: true },
      },
    })),
    code: 'conformance/backend',
    field: 'backend.profile.programFeatures.foreach',
  },
  {
    name: 'backend 取色口径不等于 adapter（author → default）',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({ ...b, profile: { ...b.profile, narrationColor: 'default' } })),
    code: 'conformance/backend',
    field: 'backend.profile.narrationColor',
  },
  {
    name: 'backend 桶优先级被改成 none（事件目录四条都是 emuera-buckets）',
    adapter: ERAFL_GAME_ADAPTER,
    backend: mutateBackend((b) => ({ ...b, profile: { ...b.profile, priorityModel: 'none' } })),
    code: 'conformance/backend',
    field: 'backend.profile.priorityModel',
  },
  {
    name: '事件目录声明了空守卫（core 不解释守卫，但空守卫落不了产物）',
    backend: BASE_BACKEND,
    adapter: {
      ...ERAFL_GAME_ADAPTER,
      eventCatalog: {
        ...ERAFL_GAME_ADAPTER.eventCatalog,
        events: ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) =>
          spec.event === '初见' ? { ...spec, guard: { text: '   ' } } : spec,
        ),
      },
    },
    code: 'conformance/contract',
    field: 'eventCatalog.events.初见.guard',
  },
  {
    name: '一致性套件用例名重复（定位会失效）',
    backend: BASE_BACKEND,
    adapter: {
      ...ERAFL_GAME_ADAPTER,
      conformanceSuite: {
        ...ERAFL_GAME_ADAPTER.conformanceSuite,
        cases: ERAFL_GAME_ADAPTER.conformanceSuite.cases.map((item, index) =>
          index === 1 ? { ...item, name: ERAFL_GAME_ADAPTER.conformanceSuite.cases[0]?.name ?? '' } : item,
        ),
      },
    },
    code: 'conformance/contract',
    field: 'adapter.conformanceSuite.cases',
  },
]);

describe('eraFL 2.0 conformance · §D 读数不同源必红', () => {
  it('八种串读数各红在各自那一格（码 + 字段双钉）', () => {
    expect(MUTATIONS.length).toBe(8);
    for (const mutation of MUTATIONS) {
      const report = runAdapterConformance({ adapter: mutation.adapter, backend: mutation.backend, cases: [] });
      expect(report.contract.ok, `${mutation.name} 竟然过了`).toBe(false);
      const failure = report.contract.failures.find((item) => item.location.field === mutation.field);
      expect(failure, `${mutation.name} 没红在 ${mutation.field}`).toBeDefined();
      expect(failure?.code).toBe(mutation.code);
      expect(failure?.location.case).toBe('(contract)');
    }
  });

  it('未 mutated 的真身在这一组里零失败（对照组，防"整组红"混过关）', () => {
    const report = runAdapterConformance({ adapter: ERAFL_GAME_ADAPTER, backend: BASE_BACKEND, cases: [] });
    expect(report.contract.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

/* ============================== E. 事件分层（4 引擎 + 5 自包 + 作者口上轴） ============================== */

/** eraTW 有、eraFL 树里没有真定义的五个引擎事件（HANDOFF §2.4 的实测名单，判据是 `^@EVENT…\b` 精确匹配定义） */
const ERAFL_ABSENT_ENGINES: readonly string[] = Object.freeze([
  'EVENTTRAIN',
  'EVENTCOM',
  'EVENTEND',
  'EVENTTURNEND',
  'EVENTCOMEND',
]);

const ERAFL_ROOT = 'D:/Game/erafl';
const hasRealDisk = (): boolean => existsSync(ERAFL_ROOT);

describe('eraFL 2.0 conformance · §E 事件三层结构', () => {
  it('层1：2.0 目录只有四条引擎事件（eraTW 的另五条一条都不声明）', () => {
    const engines = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.engine);
    expect(engines.sort()).toEqual(['EVENTBUY', 'EVENTFIRST', 'EVENTLOAD', 'EVENTSHOP']);
    for (const absent of ERAFL_ABSENT_ENGINES) {
      expect(engines).not.toContain(absent);
    }
    expect(ERAFL_GAME_ADAPTER.eventCatalog.events.length).toBe(4);
  });

  it('层1：forced 只给 EVENTFIRST（eraTW 给三条是 eraTW 的事实）', () => {
    expect(ERAFL_GAME_ADAPTER.eventCatalog.events.filter((spec) => spec.forced).map((spec) => spec.engine)).toEqual([
      'EVENTFIRST',
    ]);
  });

  it('层2/层3 的名称不得混进 2.0 目录（流程函数与作者口上钩子不是引擎事件）', () => {
    const eventNames = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    for (const name of ['训练', '指令', '训练结束', '回合末', '指令结束', '口上事件']) {
      expect(eventNames).not.toContain(name);
    }
    expect(ERAFL_GAME_ADAPTER.eventCatalog.defaultEvent).toBeNull();
  });

  it('演出/程序/存储的"不做"是数据层写死的，不是夹具放宽出来的', () => {
    expect(ERAFL_PRESENTATION.heart).toBeNull();
    expect(ERAFL_PRESENTATION.face).toBeNull();
    expect(ERAFL_PRESENTATION.options).toBeNull();
    expect(ERAFL_PROGRAM_FEATURES.foreach).toBe(false);
    expect(ERAFL_PROGRAM_FEATURES.recursion).toBe(false);
    expect(ERAFL_GAME_ADAPTER.foreachCollections).toBeNull();
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsTemplateExpansion).toBe(false);
  });
});

describe('eraFL 2.0 conformance · §E2 真盘盘面分层核对（D:/Game/erafl 不在则跳过）', () => {
  const itReal = hasRealDisk() ? it : it.skip;

  /** 口上域（作者写口上的战场）全部 `.ERB` 的逐行读数；口径写清楚，不冒充全树 */
  function scanKojoDomain(matcher: (line: string) => boolean): number {
    let hits = 0;
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = nodeJoin(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.erb$/i.test(entry.name)) {
          for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
            if (matcher(line)) hits++;
          }
        }
      }
    };
    walk(nodeJoin(ERAFL_ROOT, 'ERB/口上'));
    return hits;
  }

  itReal('层2：回合末/指令结束被 eraFL 自己的流程函数包了一层（文件:行 级）', () => {
    const turnend = readFileSync(nodeJoin(ERAFL_ROOT, 'ERB/SYSTEM/TURNEND.ERB'), 'utf8').split(/\r?\n/);
    expect(turnend[3]?.replace(/^\uFEFF/, '').trim()).toBe('@FL_EVENTTURNEND');
    const quest = readFileSync(nodeJoin(ERAFL_ROOT, 'ERB/QUEST/QUEST_MAIN.ERB'), 'utf8').split(/\r?\n/);
    expect(quest[217]?.replace(/^\uFEFF/, '').trim()).toBe('@QST_EVENTCOMEND()');
  });

  itReal('层3：作者口上钩子 @KOJO_EVENT_K{n}(ARG) 存在但一条都不进 2.0 事件目录', () => {
    // 真盘实测：口上域 4 份定义 + 1 处 TRYCCALLFORM 分发（_KOJO_SYSTEM.ERB:778）
    const dispatcher = readFileSync(nodeJoin(ERAFL_ROOT, 'ERB/口上/_KOJO_SYSTEM.ERB'), 'utf8').split(/\r?\n/);
    expect(dispatcher[777]?.trim()).toBe('TRYCCALLFORM KOJO_EVENT_K{LOCAL:5}, ARG:1');
    expect(scanKojoDomain((line) => /^@KOJO_EVENT_K\d/.test(line))).toBe(4);
    const eventCsv = readFileSync(nodeJoin(ERAFL_ROOT, 'CSV/KojoEvent.CSV'), 'utf8');
    expect(eventCsv).toContain('ファーストキス実行');
    const names = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    for (const name of ['ファーストキス実行', '告白成功']) expect(names).not.toContain(name);
  });

  itReal('判据反例：名字以事件名打头的作者助手函数不得被算成事件（前缀匹配必错）', () => {
    // 口上域实测 12 份 `@EVENTTRAIN_…` / `@EVENTEND_…`（全树 27 份）——它们只是名字像事件
    const helpers = scanKojoDomain((line) => /^@EVENT(?:TRAIN|END)_/.test(line));
    expect(helpers).toBe(12);
    const engines = ERAFL_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.engine);
    for (const absent of ERAFL_ABSENT_ENGINES) expect(engines).not.toContain(absent);
  });

  itReal('装配口径反证：口上域 #PRI/#LATER/#ONLY 实测 0 处（@织 不装配是盘面事实）', () => {
    expect(scanKojoDomain((line) => /^\s*#(?:PRI|LATER|ONLY)\b/i.test(line))).toBe(0);
    // 空扫描会让上面那条永绿 ⇒ 先证扫到了东西
    expect(scanKojoDomain((line) => /^@/.test(line))).toBeGreaterThan(100);
  });
});

/* ============================== F. 红名单（机器可查） ============================== */

interface GapRow {
  /** 缺的是哪一面 */
  readonly face: string;
  /** 缺在哪一格（契约字段 / 产物落点 / 套件面） */
  readonly cell: string;
  /** 今天报什么码（或"红在 conformance/* 的哪一格"） */
  readonly code: string;
  /** 背书用例：报告名 + 用例名（null = 口径声明，由 §F 的专项断言背书） */
  readonly witness: { readonly report: 'supported' | 'mismatch'; readonly case: readonly string[] } | null;
}

const GAP_ROWS: readonly GapRow[] = [
  {
    face: '演出·心形',
    cell: 'presentation.heart = null ⇒ 行尾提示 (心形) 无 ERB 落点',
    code: 'core/feature/unsupported',
    witness: { report: 'supported', case: ['refuses/心形（presentation.heart = null）'] },
  },
  {
    face: '演出·颜绘',
    cell: 'presentation.face = null（立绘在口上 XML 属性 emotion/立绘 XML）',
    code: 'core/face/unsupported',
    witness: { report: 'supported', case: ['refuses/颜绘（PRINT_FACE 真盘 0 处，立绘在 XML 属性侧）'] },
  },
  {
    face: '演出·选项',
    cell: 'presentation.options = null + emit 后端无 optionsBlock',
    code: 'core/feature/unsupported（外加 core/options/pending warning）',
    witness: { report: 'supported', case: ['refuses/选项（口上域选项 UI 真盘 2 处 ⇒ 不声明）'] },
  },
  {
    face: '装配·@织',
    cell: 'weave.weaveHeader 恒 fail-closed（真盘 #PRI/#LATER/#ONLY 0 处）',
    code: 'unit/backend-incomplete',
    witness: { report: 'supported', case: ['refuses/@织（真盘 #PRI/#LATER/#ONLY 实测 0 处 ⇒ 本版不装配）'] },
  },
  {
    face: '程序·@巡',
    cell: 'programFeatures.foreach = false 且 foreachCollections = null（无集合声明、无 emit）',
    code: 'core/control/unsupported',
    witness: { report: 'supported', case: ['refuses/@巡（programFeatures.foreach = false 且无集合声明）'] },
  },
  {
    face: '程序·递归',
    cell: 'programFeatures.recursion = false（无自调用实证）',
    code: 'core/func/recursion-unsupported',
    witness: { report: 'supported', case: ['refuses/递归（无自调用实证）'] },
  },
  {
    face: '事件·eraTW 五缺席',
    cell: 'eventCatalog 只声明四条 ⇒ 训练/指令/训练结束/回合末/指令结束全部未知',
    code: 'event/unknown',
    witness: {
      report: 'mismatch',
      case: ['mismatch/eraTW 事件 训练 的产物形状', 'mismatch/eraTW 事件 指令 带编号'],
    },
  },
  {
    face: '事件·参数轴',
    cell: '四条事件的 args 全空 ⇒ `# 机 <事件> <编号>` 无形状',
    code: 'event/argument',
    witness: { report: 'mismatch', case: ['mismatch/eraTW 的带参形状套在 eraFL 真事件上'] },
  },
  {
    face: '表达式端口',
    cell:
      '域符号 → 引擎引用未接（{我} 不落 [$KNAME]；可写属性写不进去）；内联口径还不一致——' +
      '`# 常量` 在表分档边界上被 core 折成字面量（table-buckets 里 `>= 100`），在表达式切片里原样透传（condition-chain 里 `>= 亲近线`）',
    code: 'conformance/golden / conformance/differential / core/expr/unknown-symbol',
    witness: {
      report: 'mismatch',
      case: [
        'mismatch/代词落点 [$KNAME]（表达式端口未接）',
        'mismatch/常量内联（作者手写 500，产物落 亲近线）',
      ],
    },
  },
  {
    face: '编码·EOL 口径',
    cell: 'allowedEncodings 无 utf-16le-bom；eol = crlf 是硬口径（LF 源即红）',
    code: 'conformance/encoding（field 分别落在 allowedEncodings / eol）',
    witness: {
      report: 'mismatch',
      case: ['mismatch/eraTW 的 UTF-16LE 源', 'mismatch/LF 源（eraFL 的 EOL 口径是 crlf）'],
    },
  },
  {
    face: '存储期落点',
    cell: 'storageClasses 三族（LOCAL/SAVEDATA/TCVAR）只在数据层，产物面无对应字节',
    code: '（无码可报：绿用例读数为 slots=[] / 声明不产字节）',
    witness: { report: 'supported', case: ['readings/三存储期声明零落点'] },
  },
  {
    face: '套件·smoke',
    cell: 'smoke 面零产物（需真桌面壳：本包不 import 宿主，kit 也只登记 skip）',
    code: '（kit 自记 skip：smoke skipped=1，不是 pass）',
    witness: null,
  },
  {
    face: '套件·differential 基线',
    cell: '没有"真盘既有产物"可对拍（真盘零 #LATER、口上真相在 XML）⇒ 三条基线是按落点形状手写的等价物',
    code: '（口径限制，非诊断码）',
    witness: null,
  },
  {
    face: '套件·migration',
    cell: '没有 eraFL 的 v1 → 2.0 迁移管线（v1 转译表住 kojo-sugar/eraTW 侧；eraFL 的 v1 真相是口上 XML）',
    code: '（本列不产迁移读数）',
    witness: null,
  },
];

describe('eraFL 2.0 conformance · §F 红名单机器可查', () => {
  it('红名单 14 行，除三行口径声明外每行都有夹具用例背书', () => {
    expect(GAP_ROWS.length).toBe(14);
    const unbacked = GAP_ROWS.filter((row) => row.witness === null);
    expect(unbacked.map((row) => row.face)).toEqual(['套件·smoke', '套件·differential 基线', '套件·migration']);
  });

  it('每一行的背书用例都在报告里存在、并且"绿面绿、红面红"', () => {
    for (const row of GAP_ROWS) {
      if (row.witness === null) continue;
      const report = row.witness.report === 'supported' ? supportedReport : mismatchReport;
      for (const name of row.witness.case) {
        const item = caseByName(report, name);
        expect(item, `${row.face} 的背书用例 ${name} 不在报告里`).toBeDefined();
        // fail-visible 与错配两类的期望相反，按报告归属判
        const shouldBeRed = row.witness.report === 'mismatch';
        expect(item?.ok, `${row.face} / ${name} 状态与红名单不符`).toBe(!shouldBeRed);
      }
    }
  });

  it('每一行都写了码（码为空的只许是"无码可报"的口径行）', () => {
    for (const row of GAP_ROWS) {
      expect(row.code.length).toBeGreaterThan(0);
      expect(row.cell.length).toBeGreaterThan(8);
    }
    const noCode = GAP_ROWS.filter((row) => row.code.startsWith('（'));
    expect(noCode.map((row) => row.face)).toEqual(['存储期落点', '套件·smoke', '套件·differential 基线', '套件·migration']);
  });

  it('声明的 conformanceSuite 与交付的夹具对得上（smoke 之外每一面都有真实用例）', () => {
    expect(ERAFL_CONFORMANCE_SUITE.required).toEqual(['golden', 'differential', 'smoke', 'encoding']);
    const kinds = new Set<string>(SUPPORTED_CASES.map((item) => item.kind));
    for (const face of ERAFL_CONFORMANCE_SUITE.required) {
      if (face === 'smoke') {
        expect(kinds.has('smoke')).toBe(false);
        continue;
      }
      expect(kinds.has(face), `套件声明了 ${face} 却没有夹具`).toBe(true);
    }
    expect(ERAFL_CONFORMANCE_SUITE.cases.length).toBe(4);
  });

  it('套件声明的两面不再把 golden/differential 引向"XML 编译成 2.0"这条不存在的路', () => {
    const byKind = new Map(ERAFL_CONFORMANCE_SUITE.cases.map((item) => [item.kind, item]));
    expect(byKind.get('golden')?.fixture).toBe('kojo2/golden/erafl-erb-shell');
    expect(byKind.get('differential')?.fixture).toBe('kojo2/differential/erafl-erb-shell');
    expect(byKind.get('encoding')?.name).toContain('UTF-8 BOM');
    for (const item of ERAFL_CONFORMANCE_SUITE.cases) {
      expect(item.fixture.startsWith('kojo2/')).toBe(true);
      expect(item.name).not.toContain('XML 叙事');
    }
  });

  it('代词 requiresView 未进单元校验（声明与闸门的差，直读钉住）', () => {
    const backend = eraflBackend();
    const me = ERAFL_DOMAIN_SYMBOLS.pronouns.find((pronoun) => pronoun.role === 'me');
    expect(me?.requiresView).toBe(true);
    const noView = compileKojoSource({
      source: '# 机 初见\n\n> 我是{我}。\n',
      adapter: ERAFL_GAME_ADAPTER,
      backend,
    });
    // 现状：单元级不报（`# 视` 缺失要留给项目级分析）⇒ 这一格在红名单里，不许当它已验收
    expect(noView.diagnostics).toEqual([]);
    expect(noView.erb).toContain('%我%');
    expect(noView.erb).not.toContain('[$KNAME]');
  });

  it('@函 的函数体不落产物（调用点落、体不落 ⇒ 夹具如实记录）', () => {
    const item = caseByName(supportedReport, 'golden/program-function');
    expect(item?.ok).toBe(true);
    const artifact = readFixture('program-function.golden.erb');
    expect(artifact).toContain('结果 = 问安(1)');
    expect(artifact).not.toContain('问安(n)');
    expect(artifact.split(/\r?\n/).length).toBeLessThanOrEqual(6);
  });

  it('支持子集里没有一条用 skip/todo 遮红（用例数 = 声明数）', () => {
    expect(supportedReport.cases.length).toBe(SUPPORTED_CASES.length);
    expect(mismatchReport.cases.length).toBe(MISMATCH_CASES.length);
  });
});
