/**
 * eraTW 2.0 profile **解析**（K2-ADAPTER-PROFILE / 设计稿 §16.3 A3.4）：
 * 把"adapter 缺省数据 + 调用方覆盖（project / file profile）"解析成**唯一一份**落点事实
 * `KojoLoweringProfile`。
 *
 * ## 为什么要这一层
 *
 * `backend.profile` 是 core 与发射器共同读的**落点事实**（`lower/text.ts` 读 `waitDefault`、
 * `lower/expand/walk.ts` 读 `randStyle`、`lower/presentation.ts` 读 `presentations`、
 * `lower/weave.ts` 读 `priorityModel`）。此前 backend 在工厂里**写死**
 * `eratwLoweringProfile()`，调用方把 `narrationColor` 覆盖到 adapter profile 上根本到不了
 * backend ⇒ v1（缺省 D 系）与 2.0（作者色非 D 系）在迁移 differential 里必然 `differs`
 * （本批看板 K2-ADAPTER-PROFILE）。
 *
 * ## 三层与优先级（写死，别改）
 *
 * ```
 * ① adapter 缺省（本文件的 DEFAULT_PROFILE：全部从 kojo2 数据派生）
 * ② adapterProfile（GameAdapter.profile 的**声明**，按 ERATW_ADAPTER_PROFILE_LANDING 搬六个字段）
 * ③ profile（调用方生效覆盖：project / file profile —— 落点事实，最高优先级）
 * ```
 *
 * 逐字段后者盖前者；`presentations` / `programFeatures` 子对象**逐键合并**（缺键回上一层）。
 *
 * ## 两侧的分工（与 core `resolveProgramFeatures` 同一纪律）
 *
 * - `adapter.profile` = **声明**（作者能写什么、core 自检与查询面读它）；
 * - `backend.profile` = **落点事实**（产物真能发成什么样）；
 * - 两边**不各写一份**：声明侧进落点只走本文件的映射表（`②`），而且**只搬落点字段**：
 *   - `features` 不搬：它是 extension 白名单（声明面），落点面的对应物是 `programFeatures`；
 *   - `programFeatures` / `presentations` / `priorityModel` 不从 `adapter.profile` 搬：
 *     它们由 kojo2 数据（`program.ts` / `presentation.ts` / `event-catalog.ts`）派生，
 *     并且 `programFeatures` 必须与 adapter 侧逐键**对拍**（`resolveProgramFeatures` 的双源
 *     冲突检查）——把声明搬进落点会让那条检查变成恒等式，等于取消检查。
 *
 * ## fail-closed
 *
 * 覆盖值是配置事实，不是作者源码：非法值**抛错**（`RangeError` / `TypeError`），
 * **绝不静默回缺省**（静默回缺省 = 作者以为改了 profile、产物却按缺省发）。
 * 未知键同样抛错（防止把 `features` 这类非落点字段当落点字段传进来）。
 *
 * 本模块纯函数、零 IO、零模块级可变状态：同输入同输出。
 */
import type {
  AdapterProfile,
  ColorMode,
  DialogueColorPolicy,
  KojoLoweringProfile,
  KojoPresentationCapabilities,
  KojoProgramFeatures,
  NarrationColorPolicy,
  PoolStyle,
  RandStyle,
  WaitDefault,
} from '@kojo/kojo-core';

import { ERATW_EVENT_CATALOG } from './event-catalog.js';
import { ERATW_PRESENTATION } from './presentation.js';
import { ERATW_PROFILE } from './profile.js';
import { ERATW_PROGRAM_FEATURES } from './program.js';

/* ============================== 1. 覆盖面（调用方可写的字段） ============================== */

/**
 * 调用方对落点 profile 的**覆盖**（project / file profile 的注入形态）。
 *
 * 字段 = `KojoLoweringProfile` 里可覆盖的落点字段；全部可选（缺省 = 回上一层/缺省）。
 * 注意**不收** `features`（声明面）与 `priorityModel`（由事件目录推）：
 * 传进来会 fail-closed 抛错并指出该走哪条路——避免"以为改了声明面"。
 */
export interface EratwProfileOverrides {
  readonly narrationColor?: NarrationColorPolicy;
  readonly dialogueColor?: DialogueColorPolicy;
  readonly waitDefault?: WaitDefault;
  readonly colorMode?: ColorMode;
  readonly poolStyle?: PoolStyle;
  readonly randStyle?: RandStyle;
  /** 演出能力面（逐键合并；缺键回缺省） */
  readonly presentations?: Partial<KojoPresentationCapabilities>;
  /** 程序层落点能力（逐键合并；缺键回缺省） */
  readonly programFeatures?: Partial<KojoProgramFeatures>;
}

/** 一层覆盖；`null` / `undefined` = 这一层不参与（方便调用方直接传 optional 依赖） */
export type EratwProfileLayer = EratwProfileOverrides | null | undefined;

/** 可覆盖字段清单（运行时投影；未知键的报错按它列允许项） */
const OVERRIDABLE_FIELDS = Object.freeze([
  'narrationColor',
  'dialogueColor',
  'waitDefault',
  'colorMode',
  'poolStyle',
  'randStyle',
  'presentations',
  'programFeatures',
] as const);

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/** 非落点字段 → 该走哪条路的提示（fail-closed 报错时给人话，不让人猜） */
const NOT_OVERRIDABLE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  features:
    '`features` 是**声明面**（作者能写哪些 extension 白名单），不是落点字段；要改声明请改 `adapter.profile.features`（core 的能力闸读声明 + `programFeatures`）。',
  priorityModel:
    '`priorityModel` 由事件目录（`event-catalog` 的 priority 模型）推出，不接受覆盖：覆盖它等于让 `@织` 的修饰词落点与目录事实脱钩。',
});

/* ============================== 2. 值集（契约类型的运行时投影） ============================== */

/**
 * 每个枚举字段的合法值。
 *
 * **单一真源是契约类型**（`NarrationColorPolicy` 等），这里只是运行时投影——`satisfies`
 * 让两者对不上时**编译期**就报错（表里少一个值 / 多一个值都过不了 typecheck）。
 */
const PROFILE_VALUE_SETS = {
  narrationColor: ['author', 'default', 'auto'],
  dialogueColor: ['author', 'default'],
  waitDefault: ['wait', 'continue'],
  colorMode: ['D', 'plain'],
  poolStyle: ['if', 'selectcase'],
  randStyle: ['printdata', 'printdatal', 'rand-selectcase'],
} as const satisfies {
  readonly narrationColor: readonly NarrationColorPolicy[];
  readonly dialogueColor: readonly DialogueColorPolicy[];
  readonly waitDefault: readonly WaitDefault[];
  readonly colorMode: readonly ColorMode[];
  readonly poolStyle: readonly PoolStyle[];
  readonly randStyle: readonly RandStyle[];
};

/* ============================== 3. 缺省 profile（全部数据派生） ============================== */

/**
 * `priorityModel` 由事件目录事实推：只要声明了 emuera 桶事件，才允许 之前/之后/接管。
 * （与 `eratwLoweringProfile()` 的历史口径逐字一致。）
 */
function derivePriorityModel(): 'emuera-buckets' | 'none' {
  const buckets = ERATW_EVENT_CATALOG.events.filter((spec) => spec.priority === 'emuera-buckets');
  return buckets.length > 0 ? 'emuera-buckets' : 'none';
}

/**
 * adapter 缺省落点 profile（**全部从 kojo2 数据派生**，不写第二份默认值）。
 *
 * 深冻结：resolve 每次都从它拷贝，调用方拿到的是新对象，改动不会回流到缺省。
 */
export const ERATW_DEFAULT_LOWERING_PROFILE: KojoLoweringProfile = Object.freeze({
  waitDefault: ERATW_PROFILE.waitDefault,
  narrationColor: ERATW_PROFILE.narrationColor,
  dialogueColor: ERATW_PROFILE.dialogueColor,
  colorMode: ERATW_PROFILE.colorMode,
  poolStyle: ERATW_PROFILE.poolStyle,
  randStyle: ERATW_PROFILE.randStyle,
  priorityModel: derivePriorityModel(),
  presentations: Object.freeze({
    heart: ERATW_PRESENTATION.heart !== null,
    color: ERATW_PRESENTATION.color !== null,
    face: ERATW_PRESENTATION.face !== null,
    // `randStyle` 在 adapter profile 里声明了 → 随机落点可用
    random: ERATW_PROFILE.randStyle !== undefined,
    options: ERATW_PRESENTATION.options !== null,
  }),
  programFeatures: ERATW_PROGRAM_FEATURES,
});

/* ============================== 4. 校验小工具 ============================== */

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `数组(${value.length})`;
  return typeof value;
}

/** 枚举字段：必须是值集里的字面量；否则 `RangeError`（不静默回缺省） */
function pickEnum<K extends keyof typeof PROFILE_VALUE_SETS>(
  field: K,
  value: unknown,
): (typeof PROFILE_VALUE_SETS)[K][number] {
  const allowed: readonly string[] = PROFILE_VALUE_SETS[field];
  if (typeof value === 'string' && allowed.includes(value)) {
    return value as (typeof PROFILE_VALUE_SETS)[K][number];
  }
  throw new RangeError(
    `profile.${field} 非法：${describeValue(value)}（允许 ${allowed.join(' / ')}）。profile 覆盖 fail-closed：不静默回缺省。`,
  );
}

/**
 * 布尔子对象（`presentations` / `programFeatures`）：逐键合并，键集以**缺省对象**为唯一真源。
 *
 * - 未知键 / 非布尔值 / 非对象 → 抛错（拼错一个键就静默无效，是配置类 bug 的经典来源）；
 * - `undefined` 值 = 这一层没声明该键（回上一层），不当作 `false`。
 */
function mergeFlags<K extends string>(
  where: string,
  base: Readonly<Record<K, boolean>>,
  value: unknown,
): Readonly<Record<K, boolean>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} 必须是对象（逐键合并布尔开关），实得 ${describeValue(value)}。`);
  }
  const next: Record<string, boolean> = { ...base };
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      throw new TypeError(
        `${where}.${key} 不是合法键（允许 ${Object.keys(base).join(' / ')}）。profile 覆盖 fail-closed：未知键不静默忽略。`,
      );
    }
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      throw new TypeError(`${where}.${key} 必须是布尔值，实得 ${describeValue(raw)}。`);
    }
    next[key] = raw;
  }
  return Object.freeze(next) as Readonly<Record<K, boolean>>;
}

/** 一层覆盖的形状闸：必须是普通对象，且键都在可覆盖清单里 */
function readLayer(layer: EratwProfileOverrides): Readonly<Record<string, unknown>> {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
    throw new TypeError(`profile 覆盖必须是对象，实得 ${describeValue(layer)}。`);
  }
  const record = layer as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((OVERRIDABLE_FIELDS as readonly string[]).includes(key)) continue;
    const hint = NOT_OVERRIDABLE_HINTS[key];
    throw new TypeError(
      `profile.${key} 不是可覆盖的落点字段${hint === undefined ? '' : `——${hint}`}（允许 ${OVERRIDABLE_FIELDS.join(' / ')}）。`,
    );
  }
  return record;
}

/* ============================== 5. 解析 ============================== */

/**
 * 解析落点 profile：**纯函数**，同输入同输出；层序 = 参数序（后者盖前者）。
 *
 * ```ts
 * resolveEratwProfile()                                        // adapter 缺省
 * resolveEratwProfile({ narrationColor: 'default' })           // project/file 覆盖
 * resolveEratwProfile(adapterLayer, projectLayer, fileLayer)   // 三层叠加
 * ```
 *
 * @throws RangeError 枚举字段非法值
 * @throws TypeError  形状坏 / 未知键 / 非布尔开关
 */
export function resolveEratwProfile(...layers: readonly EratwProfileLayer[]): KojoLoweringProfile {
  const base = ERATW_DEFAULT_LOWERING_PROFILE;
  let narrationColor = base.narrationColor;
  let dialogueColor = base.dialogueColor;
  let waitDefault = base.waitDefault;
  let colorMode = base.colorMode;
  let poolStyle = base.poolStyle;
  let randStyle = base.randStyle;
  let presentations = base.presentations;
  // 缺省里 `programFeatures` 恒有值（DEFAULT 就由 `ERATW_PROGRAM_FEATURES` 派生）；
  // 契约类型里它是 optional，这里显式收口一次，后续合并不必再判 undefined。
  let programFeatures: KojoProgramFeatures = base.programFeatures ?? ERATW_PROGRAM_FEATURES;

  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    const record = readLayer(layer);

    if (record['narrationColor'] !== undefined) narrationColor = pickEnum('narrationColor', record['narrationColor']);
    if (record['dialogueColor'] !== undefined) dialogueColor = pickEnum('dialogueColor', record['dialogueColor']);
    if (record['waitDefault'] !== undefined) waitDefault = pickEnum('waitDefault', record['waitDefault']);
    if (record['colorMode'] !== undefined) colorMode = pickEnum('colorMode', record['colorMode']);
    if (record['poolStyle'] !== undefined) poolStyle = pickEnum('poolStyle', record['poolStyle']);
    if (record['randStyle'] !== undefined) randStyle = pickEnum('randStyle', record['randStyle']);
    if (record['presentations'] !== undefined) {
      presentations = mergeFlags('profile.presentations', presentations, record['presentations']);
    }
    if (record['programFeatures'] !== undefined) {
      programFeatures = mergeFlags('profile.programFeatures', programFeatures, record['programFeatures']);
    }
  }

  return Object.freeze({
    waitDefault,
    narrationColor,
    dialogueColor,
    colorMode,
    poolStyle,
    randStyle,
    priorityModel: base.priorityModel,
    presentations,
    programFeatures,
  });
}

/* ============================== 6. adapter 声明 → 落点 的映射表 ============================== */

/**
 * adapter 声明字段 → 落点字段的**映射表**（写死）。
 *
 * 为什么是显式表而不是 `{...adapterProfile}`：
 * 1. 两边的字段集**不一样**——`features` 只存在于声明面，`programFeatures` / `presentations` /
 *    `priorityModel` 只存在于落点面（且后两者由数据派生、必须与声明面对拍，不能搬）；
 *    整对象展开会把"声明"偷偷变成"落点"，双源冲突检查随之失效；
 * 2. 将来某个游戏要"声明 A、落 B"（例如声明 `author` 而落 `default`），改这里一处即可，
 *    不必在 backend 的每个落点再散一份判断。
 *
 * 现在六个字段都是**同名直映**（eraTW 的声明口径与落点口径一致）。
 */
export const ERATW_ADAPTER_PROFILE_LANDING = Object.freeze({
  narrationColor: 'narrationColor',
  dialogueColor: 'dialogueColor',
  waitDefault: 'waitDefault',
  colorMode: 'colorMode',
  poolStyle: 'poolStyle',
  randStyle: 'randStyle',
} as const satisfies {
  readonly narrationColor: keyof Pick<KojoLoweringProfile, 'narrationColor'>;
  readonly dialogueColor: keyof Pick<KojoLoweringProfile, 'dialogueColor'>;
  readonly waitDefault: keyof Pick<KojoLoweringProfile, 'waitDefault'>;
  readonly colorMode: keyof Pick<KojoLoweringProfile, 'colorMode'>;
  readonly poolStyle: keyof Pick<KojoLoweringProfile, 'poolStyle'>;
  readonly randStyle: keyof Pick<KojoLoweringProfile, 'randStyle'>;
});

export type EratwAdapterProfileLandingField = keyof typeof ERATW_ADAPTER_PROFILE_LANDING;

/** 映射表里的字段清单（顺序 = 表序；报错/测试按它遍历，不另抄一份） */
export const ERATW_ADAPTER_PROFILE_LANDING_FIELDS: readonly EratwAdapterProfileLandingField[] = Object.freeze(
  Object.keys(ERATW_ADAPTER_PROFILE_LANDING) as EratwAdapterProfileLandingField[],
);

/**
 * `GameAdapter.profile`（声明）→ 落点覆盖（只挑映射表里的字段）。
 *
 * 只做搬运，**不校验值**：校验统一在 {@link resolveEratwProfile} 里（一处；bad adapter
 * 也 fail-closed，不会被"顺手修一下"成缺省）。`features` 等非落点字段**不进结果**。
 */
export function eratwAdapterProfileOverrides(
  profile: Partial<AdapterProfile> | null | undefined,
): EratwProfileOverrides {
  if (profile === null || profile === undefined) return Object.freeze({});
  const out: Record<string, unknown> = {};
  for (const field of ERATW_ADAPTER_PROFILE_LANDING_FIELDS) {
    const value = profile[field];
    if (value !== undefined) out[field] = value;
  }
  return Object.freeze(out) as EratwProfileOverrides;
}
