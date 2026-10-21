/**
 * program feature 能力闸的**单源**（K2-FEATURE-GATE-UNIFY；设计稿 §16.4 P5.8 / §16.3 A3.7）。
 *
 * 问题（batch-3 遗留，报告已点名）：能力闸有两个真源——
 * lowering 主链读 `backend.profile.programFeatures`，查询/诊断面读 `adapter.programFeatures`
 * （`checkProgramFeature`）。两者不一致时产物面与诊断面会分叉（`while` / `repeat` / `foreach`
 * 同模式）：
 * - adapter 关、backend 开 ⇒ 产物照出，但查询面报"未开启"（作者被自相矛盾的诊断包围）；
 * - adapter 开、backend 关 ⇒ 产物不出，但查询面说"支持"（编辑器放行、编译报错）。
 *
 * 收口（本文件是**唯一**判定点）：
 * - `adapter.programFeatures` = **声明真源**（作者能不能写这个构造）；
 * - `backend.profile.programFeatures` = **落点能力**（产物能不能发出来）；
 * - 两侧都有 programFeatures 记录且逐键不一致 ⇒ error（码取既有的 `PROGRAM_FEATURE_CODES`，
 *   与 batch-3 的 `core/control/unsupported` 等同码），闸值折为 false（fail-closed：有分歧零字节）；
 * - 只有一侧有记录 ⇒ 按那一侧判（查询面没有 backend 可比 / 通用 lower 没有 adapter）；
 * - 两侧都没有记录 ⇒ 全关（既有语义）。
 *
 * 两条纪律：
 * 1. 主链（`expand/walk.ts`、`program.ts`）与查询面（`adapter.ts::checkProgramFeature`）都只经
 *    `checkFeature` 取结论——不再有第二处读 `profile.programFeatures` 的判断；
 * 2. 同一情形只报一条：双源冲突由 `resolveProgramFeatures().diagnostics` 报一次
 *    （span = null，声明面事实），use-site 的 `checkFeature` 对已冲突的键返回
 *    `diagnostic: null`（不重复喊"未开启"）；调用方拿到的诊断再按 `featureDiagnosticKey`
 *    去重（同一 `(code, span)` = 同一情形，重复命中只留一条）。
 *
 * 本文件零游戏名词、零 IO、零模块级可变状态：解析是纯函数，逐次 compile 现算。
 */
import type { KojoSpan } from '../ast.js';
import type { GameAdapter, ProgramFeatureKey } from '../adapter.js';
import type { CoreDiagnosticCode, KojoDiagnostic } from '../diagnostics.js';
import { severityOf } from '../diagnostics.js';
import type { KojoEmitBackend } from './backend.js';

/* ============================== 1. 键 / 码 / 源端写法 ============================== */

/** 程序层键的**唯一真源**（`adapter.ts` 从这里再导出；校验与补全按它遍历，不另写字符串表） */
export const PROGRAM_FEATURE_KEYS: readonly ProgramFeatureKey[] = Object.freeze([
  'arrays',
  'while',
  'goto',
  'recursion',
  'foreach',
  'repeat',
] as const);

/** 程序层键 → 源端构造（诊断文案用；构造名是 core 语言词，不是游戏知识） */
export const PROGRAM_FEATURE_SYNTAX: Readonly<Record<ProgramFeatureKey, string>> = Object.freeze({
  arrays: '数组 [ ]',
  while: '@循',
  goto: '@标 / @跳',
  recursion: '@函 递归',
  foreach: '@巡',
  repeat: '@复',
});

/** 未声明 feature 时的 core 诊断码（码表 §11.3 的细分映射，唯一真源） */
export const PROGRAM_FEATURE_CODES: Readonly<Record<ProgramFeatureKey, CoreDiagnosticCode>> = Object.freeze({
  arrays: 'core/array/unsupported',
  while: 'core/control/unsupported',
  goto: 'core/goto/unsupported',
  recursion: 'core/func/recursion-unsupported',
  foreach: 'core/control/unsupported',
  repeat: 'core/control/unsupported',
});

/** 全关（`none` 象限与逐键初值；冻结，别改） */
const ALL_OFF: Readonly<Record<ProgramFeatureKey, boolean>> = Object.freeze({
  arrays: false,
  while: false,
  goto: false,
  recursion: false,
  foreach: false,
  repeat: false,
});

/** 逃生舱文案（每一条 feature 诊断都要指出可替代写法，§10.10） */
const ESCAPE_HATCH = '或用 `@原生` 写等价物。';

/* ============================== 2. 类型 ============================== */

/**
 * 声明面（adapter）：`programFeatures` 是必填记录。
 *
 * 用 `Pick` 而不是 `GameAdapter`：查询/补全与单测只需要这两项，不逼调用方凑齐整个契约。
 */
export type ProgramFeatureDeclaringAdapter = Pick<GameAdapter, 'id' | 'programFeatures'>;

/** 落点面（backend）：`profile.programFeatures` 可缺省（缺省 = 该项能力没有落点声明）。 */
export type ProgramFeatureLandingBackend = Pick<KojoEmitBackend, 'id' | 'profile'>;

/** 本次解析实际存在的记录来源（供测试/诊断断言，不参与判定） */
export type ProgramFeatureSource = 'both' | 'adapter-only' | 'backend-only' | 'none';

/** 一次解析的完整结论（`checkFeature` 的唯一输入） */
export interface ResolvedProgramFeatures {
  /**
   * 单源能力表（**唯一**闸值；`true` 才允许发字节）。
   * 语义 = 声明 ∧ 落点（fail-closed）；冲突键折为 `false`。
   */
  readonly features: Readonly<Record<ProgramFeatureKey, boolean>>;
  /**
   * 双源不一致的 error（每条都写明两侧来源与修法；span 恒为 null：这是声明面事实，
   * 没有具体源行）。编译入口报一次；use-site 不再重复。
   */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 记录来源（`both` / `adapter-only` / `backend-only` / `none`） */
  readonly source: ProgramFeatureSource;
  /** 双源不一致的键（已进 `diagnostics`；use-site 靠它抑制重复报） */
  readonly conflicts: readonly ProgramFeatureKey[];
  /** 声明面 id（诊断文案用；没有声明面则 null） */
  readonly adapterId: string | null;
  /** 落点面 id（诊断文案用；没有落点面则 null） */
  readonly backendId: string | null;
}

/** 一次能力闸查询的结论：能不能落 + 要不要报（二者分开，主链才敢"报完即返回"） */
export interface FeatureCheck {
  /** 单源闸值：`false` ⇒ 零字节（fail-closed） */
  readonly enabled: boolean;
  /** 要报的 error；`null` = 不报（已开启 / 冲突已由 `resolveProgramFeatures` 报过） */
  readonly diagnostic: KojoDiagnostic | null;
}

const ENABLED: FeatureCheck = Object.freeze({ enabled: true, diagnostic: null });

/* ============================== 3. 解析（单源） ============================== */

function makeDiagnostic(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): KojoDiagnostic {
  return { code, severity: severityOf(code), message, span };
}

/** 双源不一致的文案：两侧 id + 两侧字段名 + 方向（谁开了谁没开）都写清 */
function conflictMessage(
  key: ProgramFeatureKey,
  declared: boolean,
  adapterId: string | null,
  backendId: string | null,
): string {
  const syntax = PROGRAM_FEATURE_SYNTAX[key];
  const sides = `adapter（${adapterId ?? '?'}）.programFeatures.${key} 与 backend（${backendId ?? '?'}）.profile.programFeatures.${key}`;
  const direction = declared
    ? 'adapter 声明支持但后端落点未开启'
    : '后端能落但 adapter 未声明';
  return `${syntax} 的能力闸双源不一致：${direction}（${sides}）。请两边对齐，${ESCAPE_HATCH}`;
}

/** 关闭（无冲突）的文案：按记录来源点名是哪一侧没开，并给逃生舱 */
function disabledMessage(features: ResolvedProgramFeatures, key: ProgramFeatureKey): string {
  const syntax = PROGRAM_FEATURE_SYNTAX[key];
  if (features.source === 'adapter-only') {
    return `${syntax} 未开启：当前 adapter（${features.adapterId ?? '?'}）的 programFeatures 没有 ${key}；请开启，${ESCAPE_HATCH}`;
  }
  if (features.source === 'both') {
    return `${syntax} 未开启：adapter（${features.adapterId ?? '?'}）与 backend（${features.backendId ?? '?'}）都没有开启 programFeatures.${key}；请两边对齐，${ESCAPE_HATCH}`;
  }
  return `${syntax} 未开启：backend（${features.backendId ?? '?'}）的 profile.programFeatures.${key} 未开启；请开启，${ESCAPE_HATCH}`;
}

/**
 * 解析能力闸（**唯一**真源；纯函数、无副作用）。
 *
 * @param adapter 声明面；`null`/`undefined` = 没有 adapter（通用 lower 的块级预览路径）
 * @param backend 落点面；`null`/`undefined` = 没有 backend 可比（查询/补全面）
 */
export function resolveProgramFeatures(
  adapter: ProgramFeatureDeclaringAdapter | null | undefined,
  backend: ProgramFeatureLandingBackend | null | undefined,
): ResolvedProgramFeatures {
  const declared = adapter === null || adapter === undefined ? undefined : adapter.programFeatures;
  const landed = backend === null || backend === undefined ? undefined : backend.profile.programFeatures;
  const source: ProgramFeatureSource =
    declared !== undefined && landed !== undefined
      ? 'both'
      : declared !== undefined
        ? 'adapter-only'
        : landed !== undefined
          ? 'backend-only'
          : 'none';

  const adapterId = adapter?.id ?? null;
  const backendId = backend?.id ?? null;
  const features: Record<ProgramFeatureKey, boolean> = { ...ALL_OFF };
  const conflicts: ProgramFeatureKey[] = [];
  const diagnostics: KojoDiagnostic[] = [];

  for (const key of PROGRAM_FEATURE_KEYS) {
    const isDeclared = declared?.[key] === true;
    const isLanded = landed?.[key] === true;
    if (declared === undefined) {
      // 没有声明面：落点说了算（旧 lower 路径零改动）
      features[key] = isLanded;
      continue;
    }
    if (backend === null || backend === undefined) {
      // 查询面：没有落点可比 ⇒ 只按声明面判（与 batch-3 之前的查询口径一致）
      features[key] = isDeclared;
      continue;
    }
    // 主链：声明 ∧ 落点（fail-closed）；不一致 = error 且零字节
    features[key] = isDeclared && isLanded;
    if (isDeclared !== isLanded) {
      conflicts.push(key);
      diagnostics.push(makeDiagnostic(PROGRAM_FEATURE_CODES[key], conflictMessage(key, isDeclared, adapterId, backendId), null));
    }
  }

  return Object.freeze({
    features: Object.freeze(features),
    diagnostics: Object.freeze(diagnostics),
    source,
    conflicts: Object.freeze(conflicts),
    adapterId,
    backendId,
  });
}

/* ============================== 4. 统一入口 ============================== */

/**
 * 统一闸入口：**主链与查询面都调它**（不再有第二处读 `profile.programFeatures`）。
 *
 * 返回 `{ enabled, diagnostic }`：`enabled` 决定发不发字节，`diagnostic` 决定报不报。
 * 冲突键的 `diagnostic` 恒为 `null`——冲突已由 `resolveProgramFeatures().diagnostics`
 * 报过一次（同一情形只报一条），use-site 只负责"不发字节"。
 */
export function checkFeature(
  features: ResolvedProgramFeatures,
  key: ProgramFeatureKey,
  span: KojoSpan | null = null,
): FeatureCheck {
  if (features.features[key] === true) return ENABLED;
  if (features.conflicts.includes(key)) return Object.freeze({ enabled: false, diagnostic: null });
  return Object.freeze({ enabled: false, diagnostic: makeDiagnostic(PROGRAM_FEATURE_CODES[key], disabledMessage(features, key), span) });
}

/**
 * 诊断去重键：`code@start.line:start.column-end.line:end.column`（无 span 用 `-`）。
 *
 * 口径写死：同一 `(code, span)` = 同一情形（模板/池多次展开同一源行、块级预览重复走同一节点）。
 * 主链报 feature 诊断前用 `state.reportedFeatures` 查它（见 `lower/state.ts::reportFeature`）。
 */
export function featureDiagnosticKey(diagnostic: KojoDiagnostic): string {
  const span = diagnostic.span;
  const where =
    span === null
      ? '-'
      : `${span.start.line}:${span.start.column}-${span.end.line}:${span.end.column}`;
  return `${diagnostic.code}@${where}`;
}
