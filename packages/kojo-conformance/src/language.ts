/**
 * 语言级全语法一致性套件（K2-LANG-CONFORMANCE；设计稿 §16.2 C2.13 / §16.10 R9.1）。
 *
 * 定位：
 * - 这是**语言面**的 conformance 套件（与 `kit.ts` 的 adapter 契约面互补）：每个 case = 一份
 *   `.kojo2` fixture + 一段期望（`.golden.erb` 逐字节产物，或 `.diagnostics.json` 诊断快照），
 *   覆盖设计稿 §16.2 的全部语法构造；一条命令即可跑完"2.0 golden + 诊断快照"。
 * - **纯逻辑、IO 注入**：不读盘、不 import 宿主/Monaco，也不认识任何具体游戏；fixture 目录与
 *   文件内容全部经 `LanguageIoPort` 注入。默认 adapter/backend 是从 `FIXTURE_ADAPTER` /
 *   `FIXTURE_BACKEND` **派生**的"语言 fixture"（补上 `(心形)` / `@着色` / `@颜绘` / `@随机` /
 *   program 六项能力；事件/符号仍是抽象占位），因此套件**不依赖 eraTW**；调用方可注入任意
 *   adapter/backend 跑同一套（差异如实记账，见下）。
 * - **失败不洗白**：`pass` 只给"产物逐字节等于 golden"或"诊断快照逐条相等且 fail-closed（0 字节）"；
 *   其余一律 `differs`（有证据）或 `blocked`（无法判定），两者都进 `failures` 且让 CLI exit 1。
 *
 * 三种状态（写死）：
 *
 * | status | 含义 |
 * |---|---|
 * | `pass` | golden 逐字节相等；或 diagnostics 快照逐条相等（code / severity / 行 / 列）且产物为空 |
 * | `differs` | 编译成功但与期望不同，或期望失败却没有按快照失败（含"golden 用例编译报错"） |
 * | `blocked` | 无法判定：fixture/期望缺失、读不出、编译抛错、注入的 adapter 缺该 case 需要的能力/事件 |
 *
 * `blocked` 不是通过：它带 `reason`（`fixture-missing` / `golden-missing` / `capability-missing:…` /
 * `event-unknown:…` / `compile-threw` …），并保留**实际编译读数**（diagnostics / artifact）作为证据。
 *
 * Fixture 约定（`tests/fixtures/language/`，只用 `.kojo2`，不污染全仓 v1 扫描）：
 * - `<file>.kojo2`：源；
 * - `<file>.golden.erb`：golden 用例的逐字节期望（真 core + fixture 编译生成，不手写）；
 * - `<file>.diagnostics.json`：失败用例的诊断快照（`{case, diagnostics:[{code,severity,line,column}]}`）。
 *
 * 已知缺口（如实记录，不在套件里伪造覆盖）：
 * - `@函` 的函数体当前不落产物（core 只登记函数供调用点解析）⇒ program 的 `@函`/`@返` 用例
 *   只覆盖调用点与静态分析；`@返` 的"函数外"错误由独立 case 钉住。
 * - `@模` 里 `! 调用` 被 parser 以 `core/template/side-effect` 拒绝 ⇒ 模板嵌套/循环检测不可达，
 *   套件用该守卫的失败快照覆盖"循环检测"当前可达面。
 * - `@跳` 未知标签在编译期不报错（标签属单元语义，留给项目级分析）⇒ 未做成失败 case。
 * - `选项` 仍是 §7.5 待定 UI，不在本套件（避免把待定 API 钉成 golden）。
 */
import type {
  EventSpec,
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoLoweringProfile,
  KojoPresentationCapabilities,
  ProgramFeatureKey,
  ProgramFeatures,
  TextEmitRequest,
} from '@kojo/kojo-core';
import {
  compileKojoSource,
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  resolveProgramFeatures,
} from '@kojo/kojo-core';

import type { ArtifactLineDiff } from './differential.js';
import { diffArtifactLines } from './differential.js';

/* ============================== 1. 分组与状态 ============================== */

/** 套件分组（顺序 = 报告顺序，写死；新增分组追加在末尾） */
export const LANGUAGE_GROUPS = Object.freeze([
  'text',
  'condition',
  'table',
  'pool',
  'template',
  'compute',
  'presentation',
  'random',
  'native',
  'weave',
  'program',
] as const);

export type LanguageGroup = (typeof LANGUAGE_GROUPS)[number];

/** 单 case 的判定状态（见文件头表） */
export type LanguageStatus = 'pass' | 'differs' | 'blocked';

/** 期望种类：逐字节产物 / 诊断快照 */
export type LanguageExpectation = 'golden' | 'diagnostics';

/**
 * case 需要的能力（注入 adapter 缺这项时记 `blocked`，不冒充 `differs`）。
 * 事件能力不在这里声明：从 fixture 的 `# 机 <事件>` 自动读取，与 adapter 事件目录比对。
 */
export type LanguageRequirement =
  | 'presentation.heart'
  | 'presentation.color'
  | 'presentation.face'
  | 'presentation.options'
  | 'presentation.random'
  | `program.${ProgramFeatureKey}`
  | 'priority:emuera-buckets';

/** 套件的默认 fixture 目录（仓库相对路径；CLI 未给 `--dir` 时用它） */
export const LANGUAGE_FIXTURE_DIR = 'packages/kojo-conformance/tests/fixtures/language';

/* ============================== 2. 数据形状 ============================== */

/** 一条诊断读数（`code` + `severity` + 1 基行列是快照契约；message 只进报告） */
export interface LanguageDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
}

/** 诊断快照的比较面（不含 message：文案可变，码/级别/定位是契约） */
export interface LanguageDiagnosticExpectation {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly line: number | null;
  readonly column: number | null;
}

/** `.diagnostics.json` 的文件形状 */
export interface LanguageDiagnosticSnapshot {
  readonly case: string;
  readonly diagnostics: readonly LanguageDiagnosticExpectation[];
}

/** 一条 case 声明（`LANGUAGE_SUITE` 的条目） */
export interface LanguageCase {
  /** 稳定 id（`group/name`），报告与失败清单的定位键 */
  readonly id: string;
  readonly group: LanguageGroup;
  /** fixture 基名（`<file>.kojo2` / `<file>.golden.erb` / `<file>.diagnostics.json`） */
  readonly file: string;
  readonly expectation: LanguageExpectation;
  /** 该 case 钉住的语法构造（§16.2 词表；覆盖度可数） */
  readonly constructs: readonly string[];
  /** 需要的 adapter 能力（缺 → blocked；不满足时不冒充 differs） */
  readonly requires: readonly LanguageRequirement[];
  /** 一句人话说明（为什么这条 case 存在） */
  readonly note: string;
}

/** 单 case 读数（字段序固定：id / group / status / diagnostics / artifact / golden 是契约面） */
export interface LanguageCaseReport {
  readonly id: string;
  readonly group: LanguageGroup;
  readonly status: LanguageStatus;
  /** 实际诊断（编译失败也有；compile 抛错时为空） */
  readonly diagnostics: readonly LanguageDiagnostic[];
  /** 实际产物（fail-closed 时为空串 `''`；不可编译/抛错时 null） */
  readonly artifact: string | null;
  /** 期望产物字节（golden 用例）；诊断用例 / blocked 时为 null */
  readonly golden: string | null;
  /** `status === 'pass'` 的布尔投影（发版机器面按 `ok` 计读数；与 status 同源） */
  readonly ok: boolean;
  /** 诊断用例的期望快照（golden 用例为空数组） */
  readonly expectedDiagnostics: readonly LanguageDiagnosticExpectation[];
  readonly constructs: readonly string[];
  /** differs / blocked 的人话原因（pass 时 null） */
  readonly reason: string | null;
  /** golden 不一致的逐行 diff（其它情况为空数组） */
  readonly diff: readonly ArtifactLineDiff[];
}

/** 分组读数（constructs = 该组钉住的构造并集，稳定排序） */
export interface LanguageGroupSummary {
  readonly group: LanguageGroup;
  readonly cases: number;
  readonly pass: number;
  readonly differs: number;
  readonly blocked: number;
  readonly constructs: readonly string[];
}

export interface LanguageSummary {
  readonly groups: number;
  readonly cases: number;
  readonly pass: number;
  readonly differs: number;
  readonly blocked: number;
  /** 套件钉住的构造总数（去重后） */
  readonly constructs: number;
}

/** 失败项 code（本套件自己的稳定码；不复用 kit 的 `conformance/*`） */
export type LanguageFailureCode =
  | 'language/golden'
  | 'language/diagnostics'
  | 'language/blocked'
  | 'language/input';

/** 一条失败：状态 + code + 定位（源行）+ 期望/实得证据 */
export interface LanguageFailure {
  readonly id: string;
  readonly group: LanguageGroup;
  readonly status: LanguageStatus;
  readonly code: LanguageFailureCode;
  readonly sourceLine: number | null;
  readonly message: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

/** 报告（字段序固定：adapter / backend / root / ok / groups / summary / cases / failures / usage） */
export interface LanguageReport {
  readonly adapter: string;
  readonly backend: string;
  readonly root: string;
  readonly ok: boolean;
  readonly groups: readonly LanguageGroupSummary[];
  readonly summary: LanguageSummary;
  readonly cases: readonly LanguageCaseReport[];
  readonly failures: readonly LanguageFailure[];
  /** 非 null = 用法 / help 文本（exit 2 或 help；`--json` 对它不生效） */
  readonly usage: string | null;
}

/** 注入的 IO 端口：只给文本（fixture 是 UTF-8 文本资产；编码面归 kit 的 encoding 检查） */
export interface LanguageIoPort {
  /** 读一段 UTF-8 文本；不存在/不可读时抛错（runner 记成 blocked，不静默） */
  readonly readText: (path: string) => string;
}

export interface LanguageSuiteInput {
  readonly io: LanguageIoPort;
  /** fixture 目录（仓库相对或绝对；缺省 `LANGUAGE_FIXTURE_DIR`） */
  readonly root?: string;
  readonly adapter?: GameAdapter;
  readonly backend?: KojoEmitBackend;
  /** 报告里的 adapter 标签（缺省取 `adapter.id`） */
  readonly adapterLabel?: string;
  /** 报告里的 backend 标签（缺省取 `backend.id`） */
  readonly backendLabel?: string;
  /** 覆盖套件清单（测试用；缺省 `LANGUAGE_SUITE`） */
  readonly cases?: readonly LanguageCase[];
}

/* ============================== 3. 语言 fixture（从 FIXTURE_* 派生） ============================== */

/** 程序层六项全开（语言套件要覆盖 program 层的全部构造） */
const LANGUAGE_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
});

/** program 能力一项不落时的 extension 白名单（与 adapter 契约的自检口径一致） */
const LANGUAGE_EXTENSION_FEATURES = Object.freeze([
  'program',
  'functions',
  'loops',
  'arrays',
  'goto',
  'recursion',
  'foreach',
  'repeat',
] as const);

/** `(心形)` 在语言 fixture 里的四象限（抽象占位，不是任何游戏的引擎事实） */
const LANGUAGE_HEART_HINT = '心形';

/** 语言 fixture 的演出能力（全开；`选项` 是待定 API，不纳入本套件） */
const LANGUAGE_PRESENTATIONS: KojoPresentationCapabilities = Object.freeze({
  heart: true,
  color: true,
  face: true,
  random: true,
  options: false,
});

function withMachinePriority(event: EventSpec): EventSpec {
  // `@织 之前/之后/接管` 需要 emuera-buckets；fixture 原来全是 load-order，
  // 这里只把优先级模型改成桶模型（事件名/参数/engine 一字不动）。
  return { ...event, priority: 'emuera-buckets' as const };
}

/**
 * 语言 fixture adapter：`FIXTURE_ADAPTER` 的派生面。
 *
 * 只补"语言构造需要的能力声明"（演出四项 + program 六项 + 数组遍历规则 + 桶优先级），
 * 事件名 / 域符号 / 存储期 / 编码策略全部沿用抽象 fixture —— 不含任何游戏事实。
 */
export const LANGUAGE_FIXTURE_ADAPTER: GameAdapter = Object.freeze({
  ...FIXTURE_ADAPTER,
  profile: {
    ...FIXTURE_ADAPTER.profile,
    features: LANGUAGE_EXTENSION_FEATURES,
  },
  eventCatalog: {
    ...FIXTURE_ADAPTER.eventCatalog,
    events: FIXTURE_ADAPTER.eventCatalog.events.map((event) => withMachinePriority(event)),
  },
  presentation: {
    heart: {
      engine: 'HPH_PRINT',
      dialogue: { wait: 'w' as const, continue: 'l' as const },
      narration: { wait: 'dw' as const, continue: 'dl' as const },
    },
    color: { setColor: 'SETCOLOR', resetColor: 'RESETCOLOR', hexPrefix: '0x' },
    face: {
      defaultExpression: '通常',
      calls: [
        { object: 'me' as const, call: 'PRINT_FACE', receiverArg: 'TARGET' },
        { object: 'you' as const, call: 'PRINT_FACE_PLAYER', receiverArg: 'MASTER' },
      ],
      maxArgs: 4,
      placeholder: '""',
    },
    options: null,
  },
  programFeatures: LANGUAGE_PROGRAM_FEATURES,
  foreachCollections: {
    collections: [],
    arrayRule: { base: 0, bindings: ['值', '下标'] as const },
  },
});

/** 语言 fixture 的 profile 读数（演示能力全开 + 桶优先级） */
const LANGUAGE_LOWERING_PROFILE: KojoLoweringProfile = Object.freeze({
  ...FIXTURE_BACKEND.profile,
  priorityModel: 'emuera-buckets',
  presentations: LANGUAGE_PRESENTATIONS,
  programFeatures: LANGUAGE_PROGRAM_FEATURES,
});

const fixtureTextLine = FIXTURE_BACKEND.text.line;

/**
 * 语言 fixture backend：`FIXTURE_BACKEND` 的派生面。
 *
 * - `(心形)` 是"已声明演出"（`hintSupport → supported`），并在产物里追加 ` ;HINT 心形`：
 *   抽象 fixture backend 原本只把批注写进 `;()` 注释，无法在 golden 里区分
 *   "supported / annotation / unsupported" 三态；语言套件必须让这个区分可见。
 * - `@着色` / `@颜绘` / `@随机` / program 落点全部继承 `FIXTURE_BACKEND` 的伪引擎 token。
 */
export const LANGUAGE_FIXTURE_BACKEND: KojoEmitBackend = Object.freeze({
  ...FIXTURE_BACKEND,
  profile: LANGUAGE_LOWERING_PROFILE,
  hintSupport(hint: string): 'supported' | 'annotation' | 'unsupported' {
    return hint === LANGUAGE_HEART_HINT ? 'supported' : 'annotation';
  },
  text: {
    line(request: TextEmitRequest) {
      const rendered = fixtureTextLine(request);
      if (typeof rendered === 'string' && request.hintRole === 'supported' && request.hint !== null) {
        return `${rendered} ;HINT ${request.hint}`;
      }
      return rendered;
    },
  },
});

/** CLI 默认 registry（`--adapter fixture`）；eraTW 等真实 adapter 由调用方注入 */
export function createLanguageAdapters(): Readonly<Record<string, LanguageAdapterRegistration>> {
  return { fixture: { adapter: LANGUAGE_FIXTURE_ADAPTER, backend: LANGUAGE_FIXTURE_BACKEND } };
}

/* ============================== 4. 套件清单 ============================== */

interface CaseInput {
  readonly id: string;
  readonly group: LanguageGroup;
  readonly file: string;
  readonly expectation: LanguageExpectation;
  readonly constructs: readonly string[];
  readonly requires?: readonly LanguageRequirement[];
  readonly note: string;
}

function languageCase(input: CaseInput): LanguageCase {
  return Object.freeze({
    id: input.id,
    group: input.group,
    file: input.file,
    expectation: input.expectation,
    constructs: Object.freeze([...input.constructs]),
    requires: Object.freeze([...(input.requires ?? [])]),
    note: input.note,
  });
}

const g = (file: string): string => file;

/**
 * 语言套件清单（顺序 = 执行序 = 报告序）。
 *
 * 每条 case 至少钉住一个 §16.2 构造；`constructs` 是覆盖度读数的唯一来源
 * （测试按它断言"每个构造都至少有一条 case"）。
 */
export const LANGUAGE_SUITE: readonly LanguageCase[] = Object.freeze([
  /* --- text：文本三正交 --- */
  languageCase({
    id: 'text/dialogue-narration',
    group: 'text',
    file: g('text-dialogue-narration'),
    expectation: 'golden',
    constructs: ['台词', '旁白', '表演提示批注', '域符号插值'],
    note: '台词/旁白两种 speech 与行尾批注提示的逐字节产物',
  }),
  languageCase({
    id: 'text/blank-three',
    group: 'text',
    file: g('text-blank-three'),
    expectation: 'golden',
    constructs: ['空行三态', '等待轴'],
    note: '`空行` / `空行 等待` / `空行 续` 与行尾 `续` 的等待三态',
  }),
  languageCase({
    id: 'text/interpolation',
    group: 'text',
    file: g('text-interpolation'),
    expectation: 'golden',
    constructs: ['插值', '三元插值'],
    note: '`{名字}` 与 `{条件 ? A : B}` 插值的产物形状',
  }),
  languageCase({
    id: 'text/heart-hint',
    group: 'text',
    file: g('text-heart-hint'),
    expectation: 'golden',
    constructs: ['(心形)', '表演提示三态'],
    requires: ['presentation.heart'],
    note: '`(心形)` 在声明了 heart 的 backend 上落"已支持"提示（不是批注）',
  }),
  languageCase({
    id: 'text/bare-quote',
    group: 'text',
    file: g('text-bare-quote'),
    expectation: 'diagnostics',
    constructs: ['台词', '裸引号（禁止）'],
    note: '叙事区裸引号必须 error 且 0 字节（池外不豁免）',
  }),

  /* --- condition：`?` 链 --- */
  languageCase({
    id: 'condition/first-match',
    group: 'condition',
    file: g('condition-first-match'),
    expectation: 'golden',
    constructs: ['? 链', '? 否', 'first-match'],
    note: '多分支 `?` 链按书写顺序 first-match，`? 否` 收束',
  }),
  languageCase({
    id: 'condition/sif',
    group: 'condition',
    file: g('condition-sif'),
    expectation: 'golden',
    constructs: ['? 链', 'SIF'],
    note: '单语句分支降 `SIF`（backend 声明支持时）',
  }),
  languageCase({
    id: 'condition/mixed-if',
    group: 'condition',
    file: g('condition-mixed-if'),
    expectation: 'diagnostics',
    constructs: ['? 链', '旧写法拒绝'],
    note: '同一条链里混用旧 `如果` → error + 迁移批注，不产字节',
  }),

  /* --- table：`# 表` --- */
  languageCase({
    id: 'table/interval',
    group: 'table',
    file: g('table-interval'),
    expectation: 'golden',
    constructs: ['# 表', '闭区间', '开放区间'],
    note: '闭区间 + 开放区间（常量端点）+ `否` 的 IF 链落点',
  }),
  languageCase({
    id: 'table/exact',
    group: 'table',
    file: g('table-exact'),
    expectation: 'golden',
    constructs: ['# 表', '精确值'],
    note: '纯精确值表的等值分档',
  }),
  languageCase({
    id: 'table/mixed',
    group: 'table',
    file: g('table-mixed'),
    expectation: 'golden',
    constructs: ['# 表', '混合区间'],
    note: '开放区间 + 闭区间 + 精确值混排',
  }),
  languageCase({
    id: 'table/missing-default',
    group: 'table',
    file: g('table-missing-default'),
    expectation: 'diagnostics',
    constructs: ['# 表', '缺 否'],
    note: '表缺 `否` → error（不引用也报）',
  }),
  languageCase({
    id: 'table/overlap',
    group: 'table',
    file: g('table-overlap'),
    expectation: 'diagnostics',
    constructs: ['# 表', '静态重叠'],
    note: '静态区间重叠 → error（不进入运行期）',
  }),

  /* --- pool：`# 池` --- */
  languageCase({
    id: 'pool/branch',
    group: 'pool',
    file: g('pool-branch'),
    expectation: 'golden',
    constructs: ['# 池', '池分支', '! 调用'],
    note: '池体 `?` 链 + `! 池名` 编译期展开',
  }),
  languageCase({
    id: 'pool/default-bare-quote',
    group: 'pool',
    file: g('pool-default-bare-quote'),
    expectation: 'golden',
    constructs: ['# 池', '? 否', '裸引号人设'],
    note: '池内裸引号默认说话人 = `# 视` 目标；`? 否` 兜底',
  }),
  languageCase({
    id: 'pool/no-view',
    group: 'pool',
    file: g('pool-no-view'),
    expectation: 'diagnostics',
    constructs: ['# 池', '裸引号人设', '缺 # 视'],
    note: '没有 `# 视` 时池内裸引号 → error',
  }),
  languageCase({
    id: 'pool/missing-default',
    group: 'pool',
    file: g('pool-missing-default'),
    expectation: 'diagnostics',
    constructs: ['# 池', '缺 否'],
    note: '池缺 `? 否` → error',
  }),

  /* --- template：`# 模` --- */
  languageCase({
    id: 'template/slot',
    group: 'template',
    file: g('template-slot'),
    expectation: 'golden',
    constructs: ['# 模', '参数替换', '[插槽]'],
    note: '模板参数替换 + 唯一插槽的展开产物',
  }),
  languageCase({
    id: 'template/nested-slot',
    group: 'template',
    file: g('template-nested-slot'),
    expectation: 'golden',
    constructs: ['# 模', '[插槽]', '条件链'],
    note: '插槽内容带整条 `?` 链与叙事行',
  }),
  languageCase({
    id: 'template/missing-slot',
    group: 'template',
    file: g('template-missing-slot'),
    expectation: 'diagnostics',
    constructs: ['# 模', '[插槽]'],
    note: '模板有插槽、调用处没缩进块 → error',
  }),
  languageCase({
    id: 'template/arg-count',
    group: 'template',
    file: g('template-arg-count'),
    expectation: 'diagnostics',
    constructs: ['# 模', '参数替换'],
    note: '模板实参个数不符 → error',
  }),
  languageCase({
    id: 'template/side-effect',
    group: 'template',
    file: g('template-side-effect'),
    expectation: 'diagnostics',
    constructs: ['# 模', '副作用守卫'],
    note: '模板内 `!` 调用 → error（编译期展开不得有运行期副作用；也是当前循环检测的可达守卫）',
  }),

  /* --- compute：`@算` --- */
  languageCase({
    id: 'compute/assign-call-condition',
    group: 'compute',
    file: g('compute-assign-call-condition'),
    expectation: 'golden',
    constructs: ['@算', '赋值', '增量', '! 调用', '条件'],
    note: '`@算` 内赋值/增量/`!` 调用/`?` 条件',
  }),
  languageCase({
    id: 'compute/unknown-name',
    group: 'compute',
    file: g('compute-unknown-name'),
    expectation: 'diagnostics',
    constructs: ['@算', '未声明名字'],
    note: '给未声明名字赋值 → error（不偷偷造名）',
  }),

  /* --- presentation：`@着色` / `@颜绘`（§16.2 C2.14） --- */
  languageCase({
    id: 'presentation/color',
    group: 'presentation',
    file: g('presentation-color'),
    expectation: 'golden',
    constructs: ['@着色', '取色配对'],
    requires: ['presentation.color'],
    note: '`@着色` 自动配对 SETCOLOR/RESETCOLOR',
  }),
  languageCase({
    id: 'presentation/face',
    group: 'presentation',
    file: g('presentation-face'),
    expectation: 'golden',
    constructs: ['@颜绘', '对象解析'],
    requires: ['presentation.face'],
    note: '`@颜绘` 省略对象 = 我；`你` 解析为玩家对象',
  }),
  languageCase({
    id: 'presentation/nested-color',
    group: 'presentation',
    file: g('presentation-nested-color'),
    expectation: 'diagnostics',
    constructs: ['@着色', '嵌套守卫'],
    requires: ['presentation.color'],
    note: '`@着色` 词法嵌套 → error',
  }),
  languageCase({
    id: 'presentation/face-args',
    group: 'presentation',
    file: g('presentation-face-args'),
    expectation: 'diagnostics',
    constructs: ['@颜绘', '参数上限'],
    requires: ['presentation.face'],
    note: '`@颜绘` 超过 4 参 → error',
  }),

  /* --- random：`@随机` / `@组` --- */
  languageCase({
    id: 'random/purity',
    group: 'random',
    file: g('random-purity'),
    expectation: 'golden',
    constructs: ['@随机', '候选纯度 single-line-text', '候选纯度 control-or-side-effect'],
    requires: ['presentation.random'],
    note: '同一 backend 下两种候选纯度的落点事实',
  }),
  languageCase({
    id: 'random/group',
    group: 'random',
    file: g('random-group'),
    expectation: 'golden',
    constructs: ['@随机', '@组', '候选纯度 group-text'],
    requires: ['presentation.random'],
    note: '多行候选必须包 `@组`；纯度 = group-text',
  }),
  languageCase({
    id: 'random/one-candidate',
    group: 'random',
    file: g('random-one-candidate'),
    expectation: 'diagnostics',
    constructs: ['@随机', '候选数'],
    requires: ['presentation.random'],
    note: '只有一个候选 → error（随机没有分叉）',
  }),
  languageCase({
    id: 'random/bare-control',
    group: 'random',
    file: g('random-bare-control'),
    expectation: 'diagnostics',
    constructs: ['@随机', '裸控制流守卫'],
    requires: ['presentation.random'],
    note: '裸 `?` 链直接做候选 → error（提示用 `@组`）',
  }),

  /* --- native：`@原生` --- */
  languageCase({
    id: 'native/fence',
    group: 'native',
    file: g('native-fence'),
    expectation: 'golden',
    constructs: ['@原生', '围栏', '逐行透传', '空行/`;` 保留'],
    note: '原生块逐行透传（`;` 注释、`[插槽]` 字面量、空行原样）',
  }),
  languageCase({
    id: 'native/dedent',
    group: 'native',
    file: g('native-dedent'),
    expectation: 'golden',
    constructs: ['@原生', '去缩进'],
    note: '去缩进基准 = 非空行最小前导空白；内部相对缩进原样',
  }),
  languageCase({
    id: 'native/empty',
    group: 'native',
    file: g('native-empty'),
    expectation: 'diagnostics',
    constructs: ['@原生', '空块守卫'],
    note: '空 `@原生` 块 → error',
  }),
  languageCase({
    id: 'native/indent',
    group: 'native',
    file: g('native-indent'),
    expectation: 'diagnostics',
    constructs: ['@原生', '缩进守卫'],
    note: '块体行"比块头深但不足一级" → error（不猜归属）',
  }),

  /* --- weave：`@织` --- */
  languageCase({
    id: 'weave/modifiers',
    group: 'weave',
    file: g('weave-modifiers'),
    expectation: 'golden',
    constructs: ['@织', '之前', '之后', '接管'],
    requires: ['priority:emuera-buckets'],
    note: '三个修饰词的监听头落点',
  }),
  languageCase({
    id: 'weave/modifier-conflict',
    group: 'weave',
    file: g('weave-modifier-conflict'),
    expectation: 'diagnostics',
    constructs: ['@织', '修饰词冲突'],
    requires: ['priority:emuera-buckets'],
    note: '`之前 + 之后` 并用 → error',
  }),

  /* --- program：控制流 / 跳转 / 函数 --- */
  languageCase({
    id: 'program/while',
    group: 'program',
    file: g('program-while'),
    expectation: 'golden',
    constructs: ['@循', '@断', '@续'],
    requires: ['program.while'],
    note: '`@循` 条件循环 + `@断` / `@续`',
  }),
  languageCase({
    id: 'program/repeat',
    group: 'program',
    file: g('program-repeat'),
    expectation: 'golden',
    constructs: ['@复', '@续'],
    requires: ['program.repeat'],
    note: '`@复 N` 固定次数 + `@续`',
  }),
  languageCase({
    id: 'program/foreach',
    group: 'program',
    file: g('program-foreach'),
    expectation: 'golden',
    constructs: ['@巡', '数组', '{值} 绑定', '{下标} 绑定'],
    requires: ['program.arrays', 'program.foreach'],
    note: '`@巡` 遍历作者数组：绑定名改写 + 隐藏槽',
  }),
  languageCase({
    id: 'program/labels',
    group: 'program',
    file: g('program-labels'),
    expectation: 'golden',
    constructs: ['@标', '@跳'],
    requires: ['program.goto'],
    note: '`@标` / `@跳`（含向后跳）',
  }),
  languageCase({
    id: 'program/function',
    group: 'program',
    file: g('program-function'),
    expectation: 'golden',
    constructs: ['@函', '@返', '! 调用'],
    note: '`@函` 声明 + 表达式位调用（函数体当前不落产物，见文件头缺口）',
  }),
  languageCase({
    id: 'program/recursion',
    group: 'program',
    file: g('program-recursion'),
    expectation: 'golden',
    constructs: ['@函', '递归', '@返'],
    requires: ['program.recursion'],
    note: '非尾递归 + 每条路径 `@返`',
  }),
  languageCase({
    id: 'program/break-outside',
    group: 'program',
    file: g('program-break-outside'),
    expectation: 'diagnostics',
    constructs: ['@断', '循环外守卫'],
    note: '循环外 `@断` → error',
  }),
  languageCase({
    id: 'program/return-outside',
    group: 'program',
    file: g('program-return-outside'),
    expectation: 'diagnostics',
    constructs: ['@返', '函数外守卫'],
    note: '`@函` 外 `@返` → error',
  }),
  languageCase({
    id: 'program/label-in-block',
    group: 'program',
    file: g('program-label-in-block'),
    expectation: 'diagnostics',
    constructs: ['@标', '块内标签守卫'],
    requires: ['program.goto', 'program.while'],
    note: '`@标` 写进循环体 → error（保证不能跳进结构化块）',
  }),
]);

/* ============================== 5. 能力读数 ============================== */

interface LanguageCapabilities {
  readonly presentations: KojoPresentationCapabilities;
  readonly program: Readonly<Record<ProgramFeatureKey, boolean>>;
  readonly priorityModel: 'emuera-buckets' | 'none' | null;
  readonly events: ReadonlySet<string>;
}

function readCapabilities(adapter: GameAdapter, backend: KojoEmitBackend): LanguageCapabilities {
  const resolved = resolveProgramFeatures(adapter, backend);
  const events = new Set<string>();
  const specs = adapter.eventCatalog?.events;
  if (Array.isArray(specs)) {
    for (const spec of specs) {
      if (typeof spec?.event === 'string' && spec.event.length > 0) events.add(spec.event);
    }
  }
  return {
    presentations: backend.profile.presentations,
    program: resolved.features,
    priorityModel: backend.profile.priorityModel ?? null,
    events,
  };
}

function requirementSatisfied(requirement: LanguageRequirement, capabilities: LanguageCapabilities): boolean {
  if (requirement === 'priority:emuera-buckets') return capabilities.priorityModel === 'emuera-buckets';
  if (requirement.startsWith('presentation.')) {
    const key = requirement.slice('presentation.'.length) as keyof KojoPresentationCapabilities;
    return capabilities.presentations[key] === true;
  }
  const key = requirement.slice('program.'.length) as ProgramFeatureKey;
  return capabilities.program[key] === true;
}

/** fixture 里 `# 机 <事件>` 的事件名（没有 `# 机` 则 null；fixture 格式受控，正则足够） */
export function machineEventOf(source: string): string | null {
  const match = /^[ \t]*#[ \t]*机[ \t]+(\S+)/m.exec(source);
  return match === null ? null : (match[1] ?? null);
}

/* ============================== 6. 纯工具 ============================== */

const BOM = '\uFEFF';

function stripLeadingBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDir(dir: string): string {
  const slashed = dir.replaceAll('\\', '/');
  if (slashed === '/' || slashed === '') return slashed;
  return slashed.replace(/\/+$/, '');
}

function joinPath(dir: string, rel: string): string {
  if (dir === '' || dir === '.') return rel;
  if (dir === '/') return `/${rel}`;
  return `${dir}/${rel}`;
}

function cmpText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 产物行切分（末尾换行不多算一个空行，与 kit 同口径） */
function splitArtifactLines(text: string): readonly string[] {
  if (text.length === 0) return Object.freeze([]);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function toLanguageDiagnostic(diagnostic: KojoDiagnostic): LanguageDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    line: diagnostic.span?.start.line ?? null,
    column: diagnostic.span?.start.column ?? null,
    message: diagnostic.message,
  };
}

function comparable(diagnostic: LanguageDiagnostic | LanguageDiagnosticExpectation): LanguageDiagnosticExpectation {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    line: diagnostic.line,
    column: diagnostic.column,
  };
}

function sameDiagnostics(
  actual: readonly LanguageDiagnostic[],
  expected: readonly LanguageDiagnosticExpectation[],
): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    const left = comparable(actual[i] as LanguageDiagnostic);
    const right = comparable(expected[i] as LanguageDiagnosticExpectation);
    if (
      left.code !== right.code ||
      left.severity !== right.severity ||
      left.line !== right.line ||
      left.column !== right.column
    ) {
      return false;
    }
  }
  return true;
}

function describeDiagnostics(list: readonly LanguageDiagnosticExpectation[]): string {
  if (list.length === 0) return '(none)';
  return list
    .map((item) => `${item.code}@${item.line ?? '?'}:${item.column ?? '?'}[${item.severity}]`)
    .join(' | ');
}

function firstErrorLine(diagnostics: readonly LanguageDiagnostic[]): number | null {
  const first = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  return first?.line ?? null;
}

function diffExcerpt(expected: string, actual: string): {
  readonly diff: readonly ArtifactLineDiff[];
  readonly artifactLine: number | null;
} {
  const diff = diffArtifactLines(splitArtifactLines(expected), splitArtifactLines(actual));
  const first = diff.find((item) => item.kind !== 'same') ?? null;
  const excerpt = diff.filter((item) => item.kind !== 'same').slice(0, 8);
  return { diff: Object.freeze(excerpt), artifactLine: first?.artifactLine ?? null };
}

/* ============================== 7. 快照解析 ============================== */

type SnapshotParse =
  | { readonly ok: true; readonly value: LanguageDiagnosticSnapshot }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSnapshot(text: string): SnapshotParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return { ok: false, reason: `诊断快照不是合法 JSON：${errorMessage(error)}` };
  }
  if (!isRecord(parsed) || typeof parsed.case !== 'string' || !Array.isArray(parsed.diagnostics)) {
    return { ok: false, reason: '诊断快照形状不合法（需要 { case: string, diagnostics: [] }）' };
  }
  const diagnostics: LanguageDiagnosticExpectation[] = [];
  for (const [index, raw] of parsed.diagnostics.entries()) {
    if (!isRecord(raw)) return { ok: false, reason: `诊断快照第 ${index} 项不是对象` };
    const code = raw.code;
    const severity = raw.severity;
    const line = raw.line;
    const column = raw.column;
    if (typeof code !== 'string' || code.length === 0) {
      return { ok: false, reason: `诊断快照第 ${index} 项缺 code` };
    }
    if (severity !== 'error' && severity !== 'warning') {
      return { ok: false, reason: `诊断快照第 ${index} 项的 severity 不是 error/warning` };
    }
    if (!(line === null || typeof line === 'number') || !(column === null || typeof column === 'number')) {
      return { ok: false, reason: `诊断快照第 ${index} 项的 line/column 必须是数字或 null` };
    }
    diagnostics.push({ code, severity, line, column });
  }
  return { ok: true, value: { case: parsed.case, diagnostics: Object.freeze(diagnostics) } };
}

/* ============================== 8. 单 case 执行 ============================== */

interface CaseOutcome {
  readonly report: LanguageCaseReport;
  readonly failure: LanguageFailure | null;
}

interface CaseContext {
  readonly io: LanguageIoPort;
  readonly root: string;
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly capabilities: LanguageCapabilities;
}

function blockedOutcome(
  entry: LanguageCase,
  reason: string,
  diagnostics: readonly LanguageDiagnostic[],
  artifact: string | null,
  failureCode: LanguageFailureCode = 'language/blocked',
): CaseOutcome {
  const report: LanguageCaseReport = {
    id: entry.id,
    group: entry.group,
    status: 'blocked',
    diagnostics,
    artifact,
    golden: null,
    ok: false,
    expectedDiagnostics: Object.freeze([]),
    constructs: entry.constructs,
    reason,
    diff: Object.freeze([]),
  };
  return {
    report,
    failure: {
      id: entry.id,
      group: entry.group,
      status: 'blocked',
      code: failureCode,
      sourceLine: firstErrorLine(diagnostics),
      message: reason,
      expected: null,
      actual: describeDiagnostics(diagnostics.map(comparable)),
    },
  };
}

function runLanguageCase(entry: LanguageCase, context: CaseContext): CaseOutcome {
  const sourcePath = joinPath(context.root, `${entry.file}.kojo2`);
  let source: string;
  try {
    source = stripLeadingBom(context.io.readText(sourcePath));
  } catch (error: unknown) {
    return blockedOutcome(entry, `fixture-missing: 读不到 ${sourcePath}（${errorMessage(error)}）`, Object.freeze([]), null, 'language/input');
  }

  let artifact: string;
  let rawDiagnostics: readonly KojoDiagnostic[];
  try {
    const result = compileKojoSource({ source, adapter: context.adapter, backend: context.backend });
    artifact = result.erb;
    rawDiagnostics = result.diagnostics;
  } catch (error: unknown) {
    return blockedOutcome(entry, `compile-threw: compileKojoSource 抛错（${errorMessage(error)}）`, Object.freeze([]), null);
  }
  const diagnostics = Object.freeze(rawDiagnostics.map(toLanguageDiagnostic));

  /* 注入的 adapter 缺能力 / 缺事件：本 case 无法判定 ⇒ blocked（保留实际编译读数当证据） */
  for (const requirement of entry.requires) {
    if (!requirementSatisfied(requirement, context.capabilities)) {
      return blockedOutcome(
        entry,
        `capability-missing: ${requirement}（注入的 adapter/backend 未声明该能力）`,
        diagnostics,
        artifact,
      );
    }
  }
  const event = machineEventOf(source);
  if (event !== null && !context.capabilities.events.has(event)) {
    return blockedOutcome(
      entry,
      `event-unknown: 注入的 adapter 事件目录没有「${event}」（本 fixture 的 # 机 挂点）`,
      diagnostics,
      artifact,
    );
  }

  if (entry.expectation === 'golden') {
    const goldenPath = joinPath(context.root, `${entry.file}.golden.erb`);
    let golden: string;
    try {
      golden = stripLeadingBom(context.io.readText(goldenPath));
    } catch (error: unknown) {
      return blockedOutcome(entry, `golden-missing: 读不到 ${goldenPath}（${errorMessage(error)}）`, diagnostics, artifact, 'language/input');
    }

    if (artifact === golden) {
      return {
        report: {
          id: entry.id,
          group: entry.group,
          status: 'pass',
          diagnostics,
          artifact,
          golden,
          ok: true,
          expectedDiagnostics: Object.freeze([]),
          constructs: entry.constructs,
          reason: null,
          diff: Object.freeze([]),
        },
        failure: null,
      };
    }

    const excerpt = diffExcerpt(golden, artifact);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    const reason =
      errors.length > 0
        ? `golden 用例编译报错（${errors.length} 条 error：${errors.map((item) => item.code).join(' | ')}），产物不是期望字节`
        : 'golden 逐字节不一致';
    const sourceLine = firstErrorLine(diagnostics) ?? null;
    const firstDiff = excerpt.diff.find((item) => item.kind !== 'same') ?? null;
    return {
      report: {
        id: entry.id,
        group: entry.group,
        status: 'differs',
        diagnostics,
        artifact,
        golden,
        ok: false,
        expectedDiagnostics: Object.freeze([]),
        constructs: entry.constructs,
        reason,
        diff: excerpt.diff,
      },
      failure: {
        id: entry.id,
        group: entry.group,
        status: 'differs',
        code: 'language/golden',
        sourceLine,
        message: `${reason}（首差产物第 ${String(excerpt.artifactLine ?? '?')} 行）`,
        expected: golden,
        actual: artifact,
      },
    };
  }

  /* diagnostics 期望 */
  const snapshotPath = joinPath(context.root, `${entry.file}.diagnostics.json`);
  let snapshotText: string;
  try {
    snapshotText = stripLeadingBom(context.io.readText(snapshotPath));
  } catch (error: unknown) {
    return blockedOutcome(
      entry,
      `snapshot-missing: 读不到 ${snapshotPath}（${errorMessage(error)}）`,
      diagnostics,
      artifact,
      'language/input',
    );
  }
  const parsed = parseSnapshot(snapshotText);
  if (!parsed.ok) {
    return blockedOutcome(entry, `snapshot-invalid: ${parsed.reason}`, diagnostics, artifact, 'language/input');
  }
  const snapshot = parsed.value;
  const actualComparables = diagnostics.map(comparable);
  const ok = snapshot.case === entry.id && sameDiagnostics(diagnostics, snapshot.diagnostics) && artifact === '';
  if (ok) {
    return {
      report: {
        id: entry.id,
        group: entry.group,
        status: 'pass',
        diagnostics,
        artifact,
        golden: null,
        ok: true,
        expectedDiagnostics: snapshot.diagnostics,
        constructs: entry.constructs,
        reason: null,
        diff: Object.freeze([]),
      },
      failure: null,
    };
  }

  const mismatches: string[] = [];
  if (snapshot.case !== entry.id) mismatches.push(`快照 case=${snapshot.case} 与用例 id=${entry.id} 不符`);
  if (!sameDiagnostics(diagnostics, snapshot.diagnostics)) {
    mismatches.push(
      `诊断不匹配：期望 ${describeDiagnostics(snapshot.diagnostics)}；实得 ${describeDiagnostics(actualComparables)}`,
    );
  }
  if (artifact !== '') mismatches.push('失败用例必须 fail-closed（产物应为 0 字节）');
  const reason = `diagnostics 快照不符：${mismatches.join('；')}`;
  return {
    report: {
      id: entry.id,
      group: entry.group,
      status: 'differs',
      diagnostics,
      artifact,
      golden: null,
      ok: false,
      expectedDiagnostics: snapshot.diagnostics,
      constructs: entry.constructs,
      reason,
      diff: Object.freeze([]),
    },
    failure: {
      id: entry.id,
      group: entry.group,
      status: 'differs',
      code: 'language/diagnostics',
      sourceLine: firstErrorLine(diagnostics),
      message: reason,
      expected: describeDiagnostics(snapshot.diagnostics),
      actual: describeDiagnostics(actualComparables),
    },
  };
}

/* ============================== 9. 套件执行与汇总 ============================== */

function buildGroups(reports: readonly LanguageCaseReport[]): readonly LanguageGroupSummary[] {
  const groups: LanguageGroupSummary[] = [];
  for (const group of LANGUAGE_GROUPS) {
    const selected = reports.filter((report) => report.group === group);
    const count = (status: LanguageStatus): number => selected.filter((report) => report.status === status).length;
    const constructs = new Set<string>();
    for (const report of selected) for (const construct of report.constructs) constructs.add(construct);
    groups.push({
      group,
      cases: selected.length,
      pass: count('pass'),
      differs: count('differs'),
      blocked: count('blocked'),
      constructs: Object.freeze([...constructs].sort(cmpText)),
    });
  }
  return Object.freeze(groups);
}

function buildSummary(reports: readonly LanguageCaseReport[]): LanguageSummary {
  const count = (status: LanguageStatus): number => reports.filter((report) => report.status === status).length;
  const constructs = new Set<string>();
  for (const report of reports) for (const construct of report.constructs) constructs.add(construct);
  return {
    groups: LANGUAGE_GROUPS.length,
    cases: reports.length,
    pass: count('pass'),
    differs: count('differs'),
    blocked: count('blocked'),
    constructs: constructs.size,
  };
}

function emptyReport(adapter: string, backend: string, root: string, usage: string | null): LanguageReport {
  return {
    adapter,
    backend,
    root,
    ok: usage === null,
    groups: Object.freeze([]),
    summary: { groups: LANGUAGE_GROUPS.length, cases: 0, pass: 0, differs: 0, blocked: 0, constructs: 0 },
    cases: Object.freeze([]),
    failures: Object.freeze([]),
    usage,
  };
}

/**
 * 跑语言套件（同步、纯函数；IO 只读注入的端口）。
 *
 * 顺序 = `LANGUAGE_SUITE` 顺序；失败清单 = 全部 differs + blocked（每条一行，带 code 与源行），
 * 不存在 warning 降级通道。`ok === false` ⇔ 至少一条失败。
 */
export function runLanguageSuite(input: LanguageSuiteInput): LanguageReport {
  const adapter = input.adapter ?? LANGUAGE_FIXTURE_ADAPTER;
  const backend = input.backend ?? LANGUAGE_FIXTURE_BACKEND;
  const adapterLabel = input.adapterLabel ?? adapter.id;
  const backendLabel = input.backendLabel ?? backend.id;
  const root = normalizeDir(input.root ?? LANGUAGE_FIXTURE_DIR);
  const entries = input.cases ?? LANGUAGE_SUITE;
  const capabilities = readCapabilities(adapter, backend);
  const context: CaseContext = { io: input.io, root, adapter, backend, capabilities };

  const reports: LanguageCaseReport[] = [];
  const failures: LanguageFailure[] = [];
  for (const entry of entries) {
    const outcome = runLanguageCase(entry, context);
    reports.push(outcome.report);
    if (outcome.failure !== null) failures.push(outcome.failure);
  }

  return {
    adapter: adapterLabel,
    backend: backendLabel,
    root,
    ok: failures.length === 0,
    groups: buildGroups(reports),
    summary: buildSummary(reports),
    cases: Object.freeze(reports),
    failures: Object.freeze(failures),
    usage: null,
  };
}

/* ============================== 10. 报告格式 ============================== */

function oneLine(text: string): string {
  return text.replace(/\r\n/g, ' / ').replace(/[\r\n]/g, ' / ');
}

function clip(text: string, limit = 240): string {
  const flat = oneLine(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * 人话报告 / JSON 二选一（字段序由对象字面量固定；`--json` 是纯 JSON）。
 *
 * - `report.usage !== null` 时永远输出 usage（help / 用法错误），`--json` 不生效；
 * - 人话：套件分组计数 → 逐 case 状态 → 失败清单（code / case / 行 / 原因）→ RESULT；
 * - 失败不洗白：`differs` 与 `blocked` 都出现在 FAILURES 里，且 RESULT 为 FAIL。
 */
export function formatLanguageReport(report: LanguageReport, options: { readonly json?: boolean } = {}): string {
  if (report.usage !== null) return `${report.usage}\n`;
  if (options.json === true) return `${JSON.stringify(report, null, 2)}\n`;

  const summary = report.summary;
  const lines: string[] = [
    `kojo-conformance language · adapter=${report.adapter} · backend=${report.backend} · ${summary.cases} cases` +
      ` · pass ${summary.pass} · differs ${summary.differs} · blocked ${summary.blocked}`,
    `root=${report.root}`,
    'groups:',
  ];
  for (const group of report.groups) {
    lines.push(
      `  ${group.group.padEnd(13)} ${String(group.cases).padStart(2)} cases` +
        `  pass ${group.pass} · differs ${group.differs} · blocked ${group.blocked}`,
    );
  }
  lines.push('cases:');
  for (const item of report.cases) {
    const reason = item.reason === null ? '' : `  ${clip(item.reason, 100)}`;
    lines.push(`  ${item.status === 'pass' ? 'PASS' : 'FAIL'}  ${item.id}  [${item.group}]${reason}`);
  }
  if (report.failures.length > 0) {
    lines.push('', `FAILURES (${report.failures.length})`);
    for (const failure of report.failures) {
      const at = failure.sourceLine === null ? '' : `:${failure.sourceLine}`;
      lines.push(`  [${failure.code}] ${failure.id}${at}  ${failure.status}`);
      lines.push(`    ${oneLine(failure.message)}`);
      if (failure.expected !== null) lines.push(`    expected: ${clip(failure.expected)}`);
      if (failure.actual !== null) lines.push(`    actual: ${clip(failure.actual)}`);
    }
  }
  lines.push('', report.ok ? 'RESULT: PASS' : `RESULT: FAIL (${report.failures.length} failures, exit 1)`);
  return `${lines.join('\n')}\n`;
}

/* ============================== 11. CLI（纯逻辑；IO / adapter 注入） ============================== */

export const LANGUAGE_CLI_USAGE = [
  '用法:',
  '  kojo-conformance language [--adapter <名称>] [--dir <fixture 目录>] [--json]',
  '  kojo-conformance language help',
  '',
  '套件约定（<dir>/，默认 packages/kojo-conformance/tests/fixtures/language）:',
  '  <case>.kojo2           2.0 源 fixture（§16.2 全语法；只用 .kojo2）',
  '  <case>.golden.erb      成功用例的逐字节产物 golden（真 core + fixture 编译生成）',
  '  <case>.diagnostics.json 失败用例的诊断快照 {case, diagnostics:[{code,severity,line,column}]}',
  '',
  '--adapter:',
  '  fixture  默认；从 FIXTURE_ADAPTER / FIXTURE_BACKEND 派生的语言 fixture（不依赖任何具体游戏）',
  '  其它名称 = 调用方注入的 registry（仓库运行壳会注入真实 adapter；实际可用名称见下方）',
  '',
  '退出码: 0 全绿 / 1 有失败（differs + blocked）/ 2 用法错误',
].join('\n');

/** 一个可被 `--adapter` 选中的语言 adapter 注册项 */
export interface LanguageAdapterRegistration {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
}

/** CLI 依赖：IO + adapter 注册表 + 缺省值（测试全部注入） */
export interface LanguageCliDeps {
  readonly io: LanguageIoPort;
  readonly adapters: Readonly<Record<string, LanguageAdapterRegistration>>;
  /** 未显式给 `--adapter` 时用哪个（默认 `fixture`） */
  readonly defaultAdapter?: string;
  /** fixture 目录缺省值（默认 `LANGUAGE_FIXTURE_DIR`） */
  readonly defaultRoot?: string;
  readonly cases?: readonly LanguageCase[];
}

export interface LanguageCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: LanguageReport;
  /** 已格式化文本（`--json` 与否由调用方传参决定；这里给默认人话） */
  readonly text: string;
}

interface ParsedLanguageArgs {
  readonly json: boolean;
  readonly adapter: string | null;
  readonly dir: string | null;
  readonly help: boolean;
  readonly error: string | null;
}

function parseLanguageArgs(argv: readonly string[]): ParsedLanguageArgs {
  if (argv.includes('help') || argv.includes('--help') || argv.includes('-h')) {
    return { json: argv.includes('--json'), adapter: null, dir: null, help: true, error: null };
  }
  let json = false;
  let adapter: string | null = null;
  let dir: string | null = null;
  let error: string | null = null;
  const fail = (message: string): void => {
    if (error === null) error = message;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '') {
      fail('空参数');
      continue;
    }
    if (token === 'language') continue;
    if (token === '--json') {
      if (json) fail('重复参数：--json');
      json = true;
      continue;
    }
    if (token === '--adapter' || token === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        fail(`缺少 ${token} 的值`);
        continue;
      }
      i++;
      if (token === '--adapter') {
        if (adapter !== null) fail('重复参数：--adapter');
        else adapter = value;
      } else {
        if (dir !== null) fail('重复参数：--dir');
        else if (value.trim().length === 0) fail('--dir 的值不能为空');
        else dir = value;
      }
      continue;
    }
    if (token.startsWith('-')) {
      fail(`未知参数：${token}`);
      continue;
    }
    fail(`多余的位置参数：${token}`);
  }
  return { json, adapter, dir, help: false, error };
}

function usageResult(adapter: string, backend: string, root: string, reason: string): LanguageCliResult {
  const report = emptyReport(adapter, backend, root, `${LANGUAGE_CLI_USAGE}\n\n错误：${reason}`);
  return { exitCode: 2, report, text: formatLanguageReport(report) };
}

/** help 里补上"本次实际注册了哪些 adapter"（注册表是注入的，源码不写死具体游戏名） */
function helpResult(adapter: string, backend: string, root: string, registered: string): LanguageCliResult {
  const report = emptyReport(adapter, backend, root, `${LANGUAGE_CLI_USAGE}\n\n已注册 adapter：${registered}`);
  return { exitCode: 0, report, text: formatLanguageReport(report) };
}

/**
 * `language` 子命令主入口（纯逻辑；零 `process.exit`、零宿主 API）。
 *
 * `help` → 0 + usage；任何用法错误 → 2 + usage；套件有 differs/blocked → 1。
 * fixture 目录读不出不在这里特判：每个 case 各自 blocked + `language/input`，同样 exit 1。
 */
export function runLanguageCli(argv: readonly string[], deps: LanguageCliDeps): LanguageCliResult {
  const parsed = parseLanguageArgs(argv);
  const defaultAdapter = deps.defaultAdapter ?? 'fixture';
  const defaultRoot = normalizeDir(deps.defaultRoot ?? LANGUAGE_FIXTURE_DIR);
  const names = Object.keys(deps.adapters).sort(cmpText);
  const known = names.length === 0 ? '(无)' : names.join(', ');

  if (parsed.help) return helpResult(defaultAdapter, defaultAdapter, defaultRoot, known);
  if (parsed.error !== null) return usageResult(defaultAdapter, defaultAdapter, defaultRoot, parsed.error);

  const adapterName = parsed.adapter ?? defaultAdapter;
  const registration = deps.adapters[adapterName];
  if (registration === undefined) {
    return usageResult(adapterName, adapterName, defaultRoot, `未知 adapter：${adapterName}（已注册：${known}）`);
  }

  const report = runLanguageSuite({
    io: deps.io,
    root: parsed.dir ?? defaultRoot,
    adapter: registration.adapter,
    backend: registration.backend,
    adapterLabel: adapterName,
    backendLabel: registration.backend.id,
    ...(deps.cases === undefined ? {} : { cases: deps.cases }),
  });
  const exitCode: 0 | 1 = report.ok ? 0 : 1;
  return { exitCode, report, text: formatLanguageReport(report, { json: parsed.json }) };
}
