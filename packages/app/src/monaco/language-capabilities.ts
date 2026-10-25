/**
 * 一等语言**能力矩阵**（LANG-PARITY-GATE，批次八 2026-10-22）。
 *
 * ## 为什么要有这张表
 *
 * ERB 与 Kojo 2.0 是**同级一等语言**：作者直写 `.erb`、直写 `.kojo2`，两边该看到的语言面
 * 一样多。收口前这条契约靠人记——`erb-implementation` 当年就只注册了 ERB，`.kojo` 里
 * `Ctrl+F12` 哑了很久而没人在测试里看见（见 `register-dialects.ts` 头注）。本表把"哪门语言
 * 承诺了哪些面"变成**数据**，由 `packages/app/tests/language-parity.test.ts` 逐项对注册点
 * 取证：缺一面要么写进 `{ exempt }` 并说明理由，要么就在闸门里红。
 *
 * ## 三档 + 一档豁免（状态的语义写死，别自造第四种）
 *
 * - `builtin` —— Monaco / 语言配置**自带**，语言包不注册 provider（括号配对 = `brackets` /
 *   `autoClosingPairs`；Peek 预览 = Monaco 内建窗，吃 definition / references 的返回）；
 * - `shared` —— **宿主共享收口**：`registerForLanguageServices`（`register-dialects.ts`）把
 *   同一枚 provider 挂到每一门声明 `languageServices: true` 的语言上；或语言无关的共享上屏腿
 *   （v1 的波浪线 = `ui.editor.decorator` 槽 → `setModelMarkers`，ERB / `.kojo` 同一份）；
 * - `self` —— 该语言**专属模块**自建 provider：注册调用里直接写自己的语言 id
 *   （`.erb` 的补全 / 改名，2.0 的各枚 `installKojo2*` 一并算这一档）；
 * - `{ exempt }` —— **已知缺口**，`exempt` 必须是人话理由，且**必须点名下一步接什么**
 *   （2.0 的批次八待接线项要写模块文件名）。闸门对"标了豁免、模块却已经被宿主装配点
 *   `ui/editor-global-providers.ts` 接上"的项会红：那是"接线了忘改矩阵"，不是豁免。
 *
 * ## 单一真源：本表 ↔ descriptor 声明
 *
 * `LanguageDescriptor.capabilities`（`language-registry.ts`，additive 可选字段）**只声明已交付
 * 的面**，取的就是本文件的 {@link ERB_CAPABILITIES} / {@link KOJO2_CAPABILITIES}。两边必须是
 * 同一份事实：本文件的行由「声明表 × 状态表」**对拍生成**，两边打架在模块求值时直接抛
 * （不静默补一个缺省档）；闸门再当断言对一遍。
 *
 * 没写进来的能力 = 宿主没承诺。`LanguageCapability` 加一枚而本表不补：状态表是
 * `Record<LanguageCapability, …>`，**typecheck 先红**；运行时构建函数还会再拦一次。
 *
 * ## 谁消费这张表
 *
 * 今天只有闸门（与 descriptor 的声明字段）。宿主**不按能力矩阵分支行为**——能力事实的
 * 真源仍然是各自的注册点（provider 注册那一行），本表是那批注册点的**清单与承诺**，
 * 不是第二套开关。将来若要"按能力挂面"（例如设置页逐项开关），从 {@link LANGUAGE_CAPABILITY_MATRIX}
 * 取，别在别处再抄一份能力名。
 */
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';

/* ============================== 能力枚举 ============================== */

/**
 * 一等语言的语言面全集（20 项）。**值的字面量是契约**：矩阵、豁免理由、闸门的取证表都按
 * 这些字面量对表，改值等于改契约（闸门里 `REQUIRED_CAPABILITIES` 与它逐字对拍）。
 *
 * 排序 = 任务清单顺序（折叠 / 大纲 / 格式化 / 语义着色 / 缩进 / 括号 / 引用 / 改名 / 签名 /
 * 行内提示 / 行上注解 / 跳实现 / 同符号高亮 / 扩选 / 调用层级 / 补全 / 悬停 / 转定义 /
 * 诊断 / 预览），不是字母序——读表时按同一顺序扫，比按字母序少一次跳读。
 */
export enum LanguageCapability {
  Folding = 'folding',
  Outline = 'outline',
  Format = 'format',
  Semantic = 'semantic',
  Indent = 'indent',
  Brackets = 'brackets',
  References = 'refs',
  Rename = 'rename',
  Signature = 'signature',
  Inlay = 'inlay',
  CodeLens = 'codelens',
  Implementation = 'implementation',
  Highlight = 'highlight',
  Selection = 'selection',
  CallHierarchy = 'callhierarchy',
  Completion = 'completion',
  Hover = 'hover',
  Definition = 'definition',
  Diagnostics = 'diagnostics',
  Preview = 'preview',
}

/** 全部能力（枚举值的冻结快照；算一次，别每轮 `Object.values`） */
export const ALL_LANGUAGE_CAPABILITIES: readonly LanguageCapability[] = Object.freeze(
  Object.values(LanguageCapability) as LanguageCapability[],
);

/* ============================== 状态形状 ============================== */

/** 已交付的三种形态（见模块头「三档 + 一档豁免」） */
export type LanguageCapabilityTier = 'builtin' | 'shared' | 'self';

/** 已知缺口：`exempt` = 理由（必须非空，且点名下一步接什么） */
export interface LanguageCapabilityExemption {
  readonly exempt: string;
}

export type LanguageCapabilityStatus = LanguageCapabilityTier | LanguageCapabilityExemption;

/** 能力矩阵覆盖的语言 = 两门一等语言（v1 的 `.kojo` 不在表里：v1 只作为共享 provider 的供方） */
export type ParityLanguageId = typeof ERB_LANGUAGE_ID | typeof KOJO2_LANGUAGE_ID;

/** 一门语言的整行（每项能力都有状态——缺一项就是漏标） */
export type LanguageCapabilityRow = Readonly<Record<LanguageCapability, LanguageCapabilityStatus>>;

/** 整张矩阵：语言 id → 该语言的行 */
export type LanguageCapabilityMatrix = Readonly<Record<ParityLanguageId, LanguageCapabilityRow>>;

/** 矩阵的两门语言（顺序 = 报告 / 遍历顺序，ERB 先、2.0 后，与 descriptor 注册顺序同向） */
export const PARITY_LANGUAGE_IDS: readonly ParityLanguageId[] = Object.freeze([
  ERB_LANGUAGE_ID,
  KOJO2_LANGUAGE_ID,
]);

/** `{ exempt }` 判别（闸门与将来的设置页共用，别各写一份 `typeof === 'object'`） */
export function isLanguageCapabilityExemption(
  status: LanguageCapabilityStatus,
): status is LanguageCapabilityExemption {
  return typeof status === 'object' && status !== null;
}

/* ============================== 声明表（descriptor 取这一份） ============================== */

/**
 * ERB **已交付**的能力（descriptor 直接引用；也是矩阵该语言行的生成依据）。
 *
 * 排除的一项（矩阵里是 `{ exempt }`，理由见状态表）：
 * `callhierarchy` —— Monaco 0.57 无该 API；纯模型 `erb-call-hierarchy.ts` 与 provider 模块
 * `erb-callhierarchy-provider.ts` 已交付，宿主面板 `ui/CallHierarchyOverlay.tsx` 已按 model
 * 语言分派消费（批次十）。矩阵按**注册面**记账：装配点接 `installErbCallHierarchyProvider`
 * 之前仍记豁免，接线后改 `self`。
 */
export const ERB_CAPABILITIES: readonly LanguageCapability[] = Object.freeze([
  LanguageCapability.Folding,
  LanguageCapability.Outline,
  LanguageCapability.Format,
  LanguageCapability.Semantic,
  LanguageCapability.Indent,
  LanguageCapability.Brackets,
  LanguageCapability.References,
  LanguageCapability.Rename,
  LanguageCapability.Signature,
  LanguageCapability.Inlay,
  LanguageCapability.CodeLens,
  LanguageCapability.Implementation,
  // 批次九：ERB 的同符号高亮与结构化扩选（两语言同权面）
  LanguageCapability.Highlight,
  LanguageCapability.Selection,
  LanguageCapability.Completion,
  LanguageCapability.Hover,
  LanguageCapability.Definition,
  LanguageCapability.Diagnostics,
  LanguageCapability.Preview,
]);

/**
 * Kojo 2.0 **已交付**的能力。
 *
 * 批次八的 refs / rename / signature / inlay / codelens / highlight / selection 七枚模块
 * 已在 `ui/editor-global-providers.ts` 的 2.0 段接线，因此进这份表；`callhierarchy` 的纯模型
 * 已交付、宿主面板 `ui/CallHierarchyOverlay.tsx` 也已按 model 语言分派消费（批次十），但
 * Monaco 0.57 无注册 API、装配点尚未接 `installKojo2CallHierarchyProvider`，矩阵按注册面
 * 仍留豁免；`implementation` 明确不做（2.0 里"跳实现"与"转定义"是同一件事，F12 已覆盖）。
 */
export const KOJO2_CAPABILITIES: readonly LanguageCapability[] = Object.freeze([
  LanguageCapability.Folding,
  LanguageCapability.Outline,
  LanguageCapability.Format,
  LanguageCapability.Semantic,
  LanguageCapability.Indent,
  LanguageCapability.Brackets,
  // 批次八接线（ERB/kojo2 同权）：7 枚语言服务已进 `ui/editor-global-providers.ts` 的 2.0 段
  LanguageCapability.References,
  LanguageCapability.Rename,
  LanguageCapability.Signature,
  LanguageCapability.Inlay,
  LanguageCapability.CodeLens,
  LanguageCapability.Highlight,
  LanguageCapability.Selection,
  LanguageCapability.Completion,
  LanguageCapability.Hover,
  LanguageCapability.Definition,
  LanguageCapability.Diagnostics,
  LanguageCapability.Preview,
]);

/* ============================== 状态表（每语言 × 每项） ============================== */

/**
 * ERB 的状态表。
 *
 * 逐项读法：
 * - 11 枚 `shared` = `registerForLanguageServices` 的通用 provider（折叠 / 大纲 / 文档格式化 /
 *   语义着色 / 引用 / 签名 / 行内提示 / 行上注解 / 跳实现 / 悬停 / 转定义）；
 * - `diagnostics` 也是 `shared`：v1 的波浪线来自 `ui.editor.decorator` 槽 → `setModelMarkers`
 *   这条**语言无关**的上屏腿（ERB 与 `.kojo` 同一份），不是 Monaco 的 provider；
 * - `completion` / `rename` 是 `self`：`.erb` 专属的两枚 provider（`erb-completion.ts` 的装配核
 *   带 `languageId: ERB_LANGUAGE_ID`；`erb-rename.ts` 直挂 `ERB_LANGUAGE_ID`）；
 * - `indent` / `brackets` 是 `builtin`：ERB 的缩进与括对走**语言配置**（`onEnterRules` /
 *   `indentationRules` / `brackets` / `autoClosingPairs`），Monaco 自己按配置做，不注册 provider。
 *   区间格式化 + on-type 在 `kojo-format-range.ts` 里是 ERB 专属（`self`），本行按"文档级 = 共享"
 *   记 `format: shared`——这是**明说的口径**，不是漏记；
 * - `preview` 是 `builtin`：Alt+F12 Peek 是 Monaco 内建窗，只吃 definition / references 的返回。
 */
const ERB_CAPABILITY_STATUS: Readonly<Record<LanguageCapability, LanguageCapabilityStatus>> =
  Object.freeze({
    [LanguageCapability.Folding]: 'shared',
    [LanguageCapability.Outline]: 'shared',
    [LanguageCapability.Format]: 'shared',
    [LanguageCapability.Semantic]: 'shared',
    [LanguageCapability.Indent]: 'builtin',
    [LanguageCapability.Brackets]: 'builtin',
    [LanguageCapability.References]: 'shared',
    [LanguageCapability.Rename]: 'self',
    [LanguageCapability.Signature]: 'shared',
    [LanguageCapability.Inlay]: 'shared',
    [LanguageCapability.CodeLens]: 'shared',
    [LanguageCapability.Implementation]: 'shared',
    [LanguageCapability.Highlight]: 'self',
    [LanguageCapability.Selection]: 'self',
    [LanguageCapability.CallHierarchy]: {
      exempt:
        'Monaco 0.57 无 registerCallHierarchyProvider（PITFALLS §83）；纯模型 monaco/erb-call-hierarchy.ts 与 provider 模块 monaco/erb-callhierarchy-provider.ts 已交付，宿主面板 ui/CallHierarchyOverlay.tsx 已按 model 语言分派消费（批次十）；矩阵按注册面记账，待装配点 ui/editor-global-providers.ts 接 installErbCallHierarchyProvider 后改 self',
    },
    [LanguageCapability.Completion]: 'self',
    [LanguageCapability.Hover]: 'shared',
    [LanguageCapability.Definition]: 'shared',
    [LanguageCapability.Diagnostics]: 'shared',
    [LanguageCapability.Preview]: 'builtin',
  });

/**
 * Kojo 2.0 的状态表。
 *
 * 13 枚 `self` 全是 `installKojo2*` 系列（语言 id 直接写在注册调用里，见
 * `ui/editor-global-providers.ts` 的 2.0 段），且**装配点无条件调用**（K2-SURFACE-DEFAULT：
 * 语言面不读切流开关，`language-parity.test.ts` 逐格对拍"装配点真调了 + 安装器自己不读开关"）；
 * 3 枚 `shared` 是**已交给插件**的三条腿（`outline` 自 B2、`definition` 自 B3b、`inlay` 自 B2c），
 * 宿主只经 `registerForLanguageServices` 带能力名挂上、判据全在 `@kojo/plugin-kojo-lang`；
 * `brackets` / `preview` 与 ERB 同档（语言配置 / Monaco 内建）；`diagnostics` 是 `self`：
 * 2.0 有自己的诊断链（`ui/kojo2-problem-sync.ts` → `setModelMarkers(...,
 * KOJO2_PROBLEM_MARKER_OWNER, …)`，与 v1 的 decorator 腿并行、不共用），同样属语言面
 * （`kojo2DiagnosticsEnabled()` 恒 true，归属逐文件按路由判）。
 *
 * `format` 一格含两条腿：整篇（`installKojo2DocumentFormatter`，Shift+Alt+F）与区间
 * （`installKojo2RangeFormatter`，Ctrl+K Ctrl+F）；两枚 provider 都只挂 `kojo2`，装配点
 * `ui/editor-global-providers.ts` 两枚 installer 都调用（矩阵按注册面记 `self`）。
 *
 * 本表记的是**注册面实际状态**：`self` 项必须在装配点真有一行无条件调用、`shared` 项必须
 * 真有一枚带能力名的 `registerForLanguageServices` 挂它——`language-parity.test.ts` 的
 * "对账"用例把每一格落到这两条形状上，声明有、注册无（例如只剩一个没人调的 import）当场红。
 *
 * 剩余两项豁免：`implementation`（明确不做：2.0 里"跳实现"与"转定义"同义，F12 已覆盖）与
 * `callhierarchy`（Monaco 0.57 无该 API；纯模型 `monaco/kojo2-callhierarchy.ts` 已由宿主面板
 * 按语言分派消费，矩阵待装配点接 `installKojo2CallHierarchyProvider` 后改 `self`）。
 */
const KOJO2_CAPABILITY_STATUS: Readonly<Record<LanguageCapability, LanguageCapabilityStatus>> =
  Object.freeze({
    [LanguageCapability.Folding]: 'self',
    // B2（2026-10-24）：2.0 的大纲改走**共享收口**（`registerForLanguageServices` 带能力名），
    // 宿主侧零原生 provider；供方 = 插件 `@kojo/plugin-kojo-lang`。
    [LanguageCapability.Outline]: 'shared',
    [LanguageCapability.Format]: 'self',
    [LanguageCapability.Semantic]: 'self',
    [LanguageCapability.Indent]: 'self',
    [LanguageCapability.Brackets]: 'builtin',
    [LanguageCapability.References]: 'self',
    [LanguageCapability.Rename]: 'self',
    [LanguageCapability.Signature]: 'self',
    // B2c（2026-10-24）起 `inlay` 走**共享收口**：`kojo-inlay-hints.ts` 的
    // `installInlayHintsProvider` 带能力名 `inlayHint` 挂上（kojo2 descriptor 点名
    // `slotServices: ['inlayHint']`），供方是插件；`monaco/kojo2-inlay.ts` 的原生安装器
    // 已不再是装配路径（只留纯翻译层 `toMonacoInlayHints` 与它的单测）。
    [LanguageCapability.Inlay]: 'shared',
    [LanguageCapability.CodeLens]: 'self',
    [LanguageCapability.Implementation]: {
      exempt:
        '明确不做、无对应模块：2.0 里"跳实现"与"转定义"是同一件事（F12 已覆盖 `@函`/模板落点），v1 的共享跳实现面见 monaco/erb-implementation.ts',
    },
    [LanguageCapability.Highlight]: 'self',
    [LanguageCapability.Selection]: 'self',
    [LanguageCapability.CallHierarchy]: {
      exempt:
        '纯模型 monaco/kojo2-callhierarchy.ts 已交付，宿主面板 ui/CallHierarchyOverlay.tsx 已按 model 语言分派消费（批次十）；Monaco 0.57 无 registerCallHierarchyProvider（PITFALLS §83），待装配点 ui/editor-global-providers.ts 接 installKojo2CallHierarchyProvider 后改 self',
    },
    [LanguageCapability.Completion]: 'self',
    [LanguageCapability.Hover]: 'self',
    // B3b（2026-10-24）：2.0 的转定义改走**共享收口**（`kojo-definition.ts` 的
    // `installDefinitionProvider`，descriptor 点名 `slotServices: ['definition']`），
    // 宿主侧零原生 provider；供方 = 插件 `@kojo/plugin-kojo-lang`（含展开体那两条落点）。
    [LanguageCapability.Definition]: 'shared',
    [LanguageCapability.Diagnostics]: 'self',
    [LanguageCapability.Preview]: 'builtin',
  });

/* ============================== 生成与不变量 ============================== */

/**
 * 把「声明表 × 状态表」对拍成一行。
 *
 * 三条不变量（打架就在**模块求值**时抛，不静默补缺省档——铁律 4）：
 * 1. 状态表缺项 ⇒ 抛（`LanguageCapability` 加一枚而矩阵不补，这是唯一的补法）；
 * 2. 声明表里有、状态却是 `{ exempt }` ⇒ 抛（"想要"不许写进 descriptor 的已交付面）；
 * 3. 状态是已交付档、声明表却没有 ⇒ 抛（交付了却不声明，等于闸门看不见这一面）。
 */
function buildRow(
  label: string,
  declared: readonly LanguageCapability[],
  statuses: Readonly<Record<LanguageCapability, LanguageCapabilityStatus>>,
): LanguageCapabilityRow {
  const declaredSet = new Set<LanguageCapability>(declared);
  const row = {} as Record<LanguageCapability, LanguageCapabilityStatus>;
  for (const capability of ALL_LANGUAGE_CAPABILITIES) {
    if (!Object.hasOwn(statuses, capability)) {
      throw new Error(
        `[language-capabilities] ${label} 的 "${capability}" 没有状态：新增能力必须同时补矩阵`,
      );
    }
    const status = statuses[capability];
    const exempt = isLanguageCapabilityExemption(status);
    if (exempt === declaredSet.has(capability)) {
      throw new Error(
        `[language-capabilities] ${label} 的 "${capability}" 与 capabilities 声明打架：` +
          (exempt
            ? '标了豁免却写进了声明表（descriptor 只声明已交付的面）'
            : '已交付却没写进声明表（闸门会看不见这一面）'),
      );
    }
    row[capability] = status;
  }
  return Object.freeze(row);
}

/**
 * 一等语言能力矩阵：**每门语言 × 每项能力**一格。
 *
 * 行由「声明表（descriptor 取的同一份）× 状态表」对拍生成 ⇒ 矩阵项与 descriptor 声明是同一份
 * 事实的两面，`language-parity.test.ts` 再当断言对一遍（两处都被改错时，生成期就抛）。
 */
export const LANGUAGE_CAPABILITY_MATRIX: LanguageCapabilityMatrix = Object.freeze({
  [ERB_LANGUAGE_ID]: buildRow('ERB', ERB_CAPABILITIES, ERB_CAPABILITY_STATUS),
  [KOJO2_LANGUAGE_ID]: buildRow('kojo2', KOJO2_CAPABILITIES, KOJO2_CAPABILITY_STATUS),
});

/**
 * 某门语言在矩阵里**已交付**（非豁免）的能力——即该语言 descriptor 该声明的那一份。
 *
 * 只做派生，不另存一份清单：顺序取枚举顺序（稳定、可对拍）。
 */
export function deliveredCapabilities(
  languageId: ParityLanguageId,
): readonly LanguageCapability[] {
  const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
  return ALL_LANGUAGE_CAPABILITIES.filter(
    (capability) => !isLanguageCapabilityExemption(row[capability]),
  );
}

/** 某门语言的已知缺口（`{ exempt }` 那几项；报告 / 下一波接线清单的机器可读来源） */
export function exemptedCapabilities(
  languageId: ParityLanguageId,
): readonly LanguageCapability[] {
  const row = LANGUAGE_CAPABILITY_MATRIX[languageId];
  return ALL_LANGUAGE_CAPABILITIES.filter((capability) =>
    isLanguageCapabilityExemption(row[capability]),
  );
}
