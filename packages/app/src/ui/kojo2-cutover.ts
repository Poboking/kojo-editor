/**
 * K2-CUTOVER-PRE · 老 `.kojo` → 2.0 的**切换前夜**（双轨 + 开关 + 迁移预览）。
 *
 * ## 本文件不做什么
 *
 * 真正的 cutover（把 `languages.ts` 的 descriptor 指过来、把语言服务 / 结构层 / 保存链路
 * 换成 2.0）是 `K2-CUTOVER`。这里只交付"切得动、切得回、切了能看"的三件前置件：
 *
 * 1. **特性开关**：三态状态机 `v1-only → dual → 2.0-default`，每步都能回退（`advance` /
 *    `rollback` / 逃生门 `setStage`）。默认（保底档）`2.0-default`（LAU-3 翻面）。
 * 2. **文件路由**：一份文件交给 v1 还是 2.0 解析器。LAU-3b-FLIP 之后口诀只剩两句：
 *    > override 当家，扩展名定归属。
 *    `.kojo` / `.kojo2` → 2.0，`.kojo1` → kojo1；阶段不再参与路由（只管封存层可见性与
 *    2.0 工具链），正文指纹也不再参与（退居迁移 / 改名工具的提示面）。结果仍是可判别的
 *    （`resolved` / `blocked` / `not-kojo`；`ambiguous` / `needs-content` 只作为历史成员
 *    保留在联合类型里，路由不再产出）。
 * 3. **迁移预览**：对一份 v1 源文本跑 `@kojo/kojo-core` 的迁移引擎（分类 + 改写），返回
 *    diff 摘要 / 预计改动行数 / 不可自动迁移台账。**没有写盘通路**：入参是字符串，出参是
 *    readonly 快照，连一个 IO 端口都不收——"不落盘"是签名保证，不是调用方自觉。
 *
 * ## 依赖纪律
 *
 * 纯 TS：零 React、零 Monaco 类型、零 DOM。词法与分类全部取 core 的单源
 * （`isKojo2Line` 是"这一行能不能过 2.0 词法"的既有判据，**不在这里手抄第二份**）；
 * 逐行 diff 复用 `kojo2-migrate-model.ts` 的 `buildMigrateDiff`（与迁移向导同一套行对齐，
 * 不另跑 LCS，也就不会出现"预览说三行、向导说五行"的第二份真源）。
 * 扩展名取自 `monaco/kojo2-constants.ts`：那是一个**连 type import 都没有**的身份叶子，
 * 带不进来任何 Monaco 运行时（K2-CUTOVER-THEME 之前这里被迫抄一份字面量，见下方常量注释）。
 *
 * ## 持久化
 *
 * 状态与 per-file override 只经注入的 {@link Kojo2CutoverStorage}（`getItem`/`setItem`/
 * `removeItem` 三格，`localStorage` 天然满足）。本文件**从不**碰 `window`——node 测试里
 * 传一个 Map 假体即可，全局零污染。宿主开机时把 `window.localStorage` 交进来：
 *
 * ```ts
 * getKojo2CutoverController().attachStorage(window.localStorage);
 * ```
 *
 * 存储键与既有预演开关 `ui/kojo2-flag.ts` 的 `kojo.ui.kojo2Cutover.v1` **分开**：那一格是
 * "2.0 面要不要挂"的布尔预演开关，本文件是"切到哪一档 + 哪个文件破例"的计划书。
 *
 * **K2-CUTOVER-STAGE 起两者已对齐**：阶段是唯一真源，`kojo2-flag` 反过来由阶段派生
 * （`stage !== 'v1-only'` 即"2.0 面开启"）。旧布尔键只作**兼容读**：`'on'` 视作 `dual`
 * （规则见 {@link stageFromLegacyKojo2Flag}，宿主开机 `attachStorage` 时正好迁移一次）。
 */

import {
  isKojo2Line,
  migrateKojoSource,
  summarizeMigration,
  type MigrateMetadata,
  type MigrateResult,
} from '@kojo/kojo-core';
import { KOJO_LEGACY_SOURCE_EXTENSION, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { splitEolLines } from '@kojo/plugin-api/eol';
import { KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang/constants';
import {
  buildMigrateDiff,
  formatMigrateDiff,
  type MigrateDiffLine,
} from './kojo2-migrate-model';

/* ============================== 阶段 ============================== */

/**
 * 三态切换阶段（字符串字面量就是持久化口径；`2.0-default` 带点，读代码时一眼认出）。
 *
 * ⚠ **2026-10-27 翻转（LAU-3b-FLIP）之后，阶段不再决定任何一份文件用哪个解析器**：
 * `.kojo` / `.kojo2` 恒归 2.0，`.kojo1` 恒归 kojo1，只认扩展名。阶段只剩两件事：
 *
 * - **封存层可不可见**（{@link kojo2StageAllowsLegacy}：`v1-only` / `dual` 为开，
 *   `2.0-default` 关——关着时 `.kojo1` 打开是纯文本 + 首开说明）；
 * - **2.0 工具链挂不挂**（写回 / 迁移 / 存储服务等，`isKojo2CutoverEnabled()` 派生）。
 *
 * 三档的名字沿用历史，读法改成"封存层与工具链的档位"：
 *
 * - `v1-only`：只保留 kojo1 那条工具链（2.0 写回 / 迁移不接管）。`.kojo` 仍按 kojo（2.0）打开；
 * - `dual`：两边都能用（封存层开、2.0 工具链开）；
 * - `2.0-default`：kojo（2.0）默认，kojo1 封存（切到「双轨」/「只认 v1」才上色）。
 */
export type Kojo2CutoverStage = 'v1-only' | 'dual' | '2.0-default';

/** 阶段序（数组序 = 前进方向；`rollback` 就是下标 -1） */
export const KOJO2_CUTOVER_STAGES: readonly Kojo2CutoverStage[] = [
  'v1-only',
  'dual',
  '2.0-default',
];

/**
 * 默认阶段（保底档）：**`2.0-default`**（用户 2026-10-27 口径「默认 kojo2」）。
 *
 * 旧默认是 `v1-only`（"切不动比切错了便宜"）。翻面之后失败方向也跟着翻：坏值 / 读不到
 * 一律回 `2.0-default`，即"当前语言是 kojo（2.0）"；kojo1 成了要显式开启的封存层
 * （见 {@link kojo2StageAllowsLegacy} 与 `monaco/languages.ts` 的 `availability:'legacy'`）。
 * 存量 v1 计划的迁移规则见 {@link LegacyPersistedCutoverPlan}。
 */
export const KOJO2_CUTOVER_DEFAULT_STAGE: Kojo2CutoverStage = '2.0-default';

/** 每个阶段的人话口径（设置页 / 调试面板直接上屏；本模块不产出别的界面文案） */
export const KOJO2_STAGE_LABELS: Readonly<Record<Kojo2CutoverStage, string>> = {
  'v1-only': '只留 kojo1 工具链：2.0 的写回 / 迁移不接管；`.kojo` 仍按 kojo（2.0）打开',
  dual: '双轨：kojo1 可用，`.kojo` / `.kojo2` 按 kojo（2.0）',
  '2.0-default': 'kojo（2.0）默认：`.kojo` / `.kojo2` 按 2.0；kojo1 封存（切到前两档才上色）',
};

/** 运行期阶段守卫（持久化里读到脏值 / devtools 传错，一律回缺省，不抛） */
export function isKojo2CutoverStage(value: unknown): value is Kojo2CutoverStage {
  return value === 'v1-only' || value === 'dual' || value === '2.0-default';
}

/* ---------------------- 2.0 面开没开：阶段派生的唯一判据 ---------------------- */

/**
 * 旧布尔预演键（K2-CUTOVER-STAGE 之前 `ui/kojo2-flag.ts` 的唯一真源）。
 *
 * 现在它只是**兼容读**：盘上没有切换计划时才看它。键名常量住在这里、由
 * `ui/kojo2-flag.ts` re-export 同一枚（全仓不再有第二份可漂移的字面量）。
 */
export const KOJO2_LEGACY_FLAG_KEY = 'kojo.ui.kojo2Cutover.v1';

/**
 * 这一档挂不挂 2.0 **工具链**（`v1-only` = 不挂；`dual` / `2.0-default` = 挂）。
 *
 * 这是 `isKojo2CutoverEnabled()` 的**唯一**语义来源：既有 flag 守卫（写回 / 迁移 /
 * 存储服务 / 拖放清单）零改动，只是背后的判据从"布尔键"换成了"阶段"。
 * **语言面（着色 / 语言服务 / 诊断 / 缩进 / 格式化 / 折叠…）不读本判据**；`.kojo` 的
 * 解析器归属也只认扩展名（LAU-3b-FLIP 之后不再由阶段切换）。
 */
export function kojo2StageAllowsSurface(stage: Kojo2CutoverStage): boolean {
  return stage !== 'v1-only';
}

/**
 * 这一档**开没开 kojo1（封存层）**（LAU-3 的 `availability:'legacy'` 门的唯一真源）。
 *
 * `v1-only` / `dual` = 开（`.kojo1` 按 kojo1 上色/分析）；`2.0-default` = 关（作者选了「2.0 默认」档）。
 * 一物三用、**不许各写一份**：① 语言可用性门的缺省谓词（`monaco/language-registry.ts`）；
 * ② `.kojo 预览`（`ui/sugar-view.ts`）；③ 语言菜单 / 状态栏的可选性（`ui/ShellLayout.tsx`）。
 * 与 {@link kojo2StageAllowsSurface} 的分工：那一格答"2.0 切流语义开没开"（语言面无条件登记）。
 */
export function kojo2StageAllowsLegacy(stage: Kojo2CutoverStage): boolean {
  return stage !== '2.0-default';
}

/**
 * 旧布尔键 → 阶段的**迁移规则（写死）**：只有 `'on'` 算数，映射到 `dual`。
 *
 * 旧键的语义只是"把 2.0 面挂上"，不是"老文件按内容指纹改判"：映射到 `dual` ⇒ 老 `.kojo`
 * 一行都不动、`.kojo2` 打得开，正是旧键当年承诺的效果；坏值一律不参与（失败方向 = 少露）。
 * 适用面：**计划缺席、或计划是被抬上来的 v1 基线、或 v2 里显式停在 `v1-only`**
 * （与 `ui/kojo2-flag.ts` 的解析顺序同一条）。作者显式改档后旧键即被删掉，阶段独占真源。
 */
export function stageFromLegacyKojo2Flag(raw: string | null): Kojo2CutoverStage | null {
  return raw === 'on' ? 'dual' : null;
}

/** 阶段下标（未知 = 缺省位置 0） */
function stageIndex(stage: Kojo2CutoverStage): number {
  const index = KOJO2_CUTOVER_STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

/* ============================== 解析器 / 锚点 ============================== */

/** 两套解析器：v1 的糖层与 2.0 的 lexer/parser 是两份实现，路由只能二选一 */
export type Kojo2Parser = 'kojo-v1' | 'kojo2';

/** 五锚点（2.0 每行的第一眼；`#` 是声明、`@` 是调度、`>` 旁白、`?` 条件、`!` 触发） */
export const KOJO2_ANCHOR_MARKS = ['#', '@', '>', '?', '!'] as const;

export type Kojo2AnchorMark = (typeof KOJO2_ANCHOR_MARKS)[number];

/**
 * 2.0 源扩展名：**直接取零依赖叶子的那一枚**（`monaco/kojo2-constants.ts`）。
 *
 * 这里曾经有一份字面量，因为本模块刻意零 Monaco、零 DOM，而 `KOJO2_SOURCE_EXTENSION`
 * 住在 `monaco/kojo2-language.ts`（一加载就拖 `@kojo/plugin-kojo-sugar` 的 ~900 KB 词表链）。
 * K2-CUTOVER-THEME 把语言 id / 扩展名下沉到零 import 叶子后，路由层取的就是**同一个
 * 字面源**：`kojo2-language.ts` 只是 re-export 同一对象，全仓不再有第二份可漂移的拷贝
 * （守门见 `kojo-extension-single-source.test.ts` 的 `.kojo2` 单源断言）。
 */
export const KOJO2_FILE_EXTENSION: string = KOJO2_SOURCE_EXTENSION;

/**
 * v1 源扩展名：**直接取契约那一枚封存标记**（`@kojo/plugin-api::KOJO_LEGACY_SOURCE_EXTENSION`
 * ＝ `.kojo1`），本文件不抄第二份字面量（`kojo-extension-single-source.test.ts` 的全仓守门就查这个）。
 *
 * 2026-10-27 翻转（LAU-3b-FLIP，用户口径「`.kojo` 当场让给 2.0」）之后，`.kojo` 不再是
 * v1 的源——**v1 只剩 `.kojo1`**。这个名字保留下来是因为上层（诊断门 / 测试）按
 * 「v1 文件扩展名」的语义在用它，与 {@link KOJO_V1_LEGACY_FILE_EXTENSION} 同值。
 */
export const KOJO_V1_FILE_EXTENSION: string = KOJO_LEGACY_SOURCE_EXTENSION;

/**
 * 封存层（kojo1）的源扩展名：见到 `.kojo1` 不再嗅正文，恒按 v1 解析。
 *
 * 与 {@link KOJO_V1_FILE_EXTENSION} 同值（翻转后 v1 只剩这一枚），两枚名字并存只为
 * 读代码时的语义清晰：一个说"v1 的源"，一个说"这是封存标记"。
 */
export const KOJO_V1_LEGACY_FILE_EXTENSION: string = KOJO_LEGACY_SOURCE_EXTENSION;

/**
 * 2.0 的源扩展名全集：`.kojo`（主场，LAU-3b-FLIP 之后归 2.0）与 `.kojo2`（旧名，兼容）。
 *
 * 两枚都从契约 / 零依赖叶子现算，不抄字面量。
 */
export const KOJO2_FILE_EXTENSIONS: readonly string[] = [KOJO_SOURCE_EXTENSION, KOJO2_FILE_EXTENSION];

/* ============================== 内容指纹 ============================== */

/** 内容指纹的结论：能不能只看正文就断定这是 2.0 写法 */
export type Kojo2SourceFlavor = 'kojo2' | 'v1' | 'ambiguous' | 'empty';

/** 一行 v1 反例（带 1 基行号，供作者面/日志直接引用） */
export interface Kojo2SourceCounterExample {
  /** 1 基行号 */
  readonly line: number;
  /** 该行正文（已去行首空白） */
  readonly text: string;
}

/**
 * 内容指纹（纯函数产物）。
 *
 * 判据全部来自 core：`isKojo2Line(body)` 就是 2.0 词法的行判据；锚点只是额外的"骨架证据"
 * （`#DIM X` 以 `#` 开头但过不了 2.0 词法，所以光数锚点会把它误判成 2.0）。
 */
export interface Kojo2SourceFingerprint {
  /** 非空行数 */
  readonly lineCount: number;
  /** 行首是五锚点之一的行数（缩进后算） */
  readonly anchorLines: number;
  /** 能过 2.0 词法的非空行数 */
  readonly kojo2Lines: number;
  /** 过不了 2.0 词法的非空行数 */
  readonly v1Lines: number;
  /** 前几条 v1 反例（最多 3 条；行号 1 基） */
  readonly v1Samples: readonly Kojo2SourceCounterExample[];
  readonly flavor: Kojo2SourceFlavor;
}

/** 行首空白（半角空格 / TAB / 全角空格；与迁移引擎 `readSource` 同一字符集） */
const LEAD_RE = /^[ \t\u3000]+/;

/** 判断这一行正文的首字符是不是五锚点 */
function startsWithAnchor(body: string): boolean {
  const first = body[0];
  return first !== undefined && (KOJO2_ANCHOR_MARKS as readonly string[]).includes(first);
}

/**
 * 算一份源文本的内容指纹（纯函数、零 IO）。
 *
 * 结论口径（顺序即优先级）：
 * 1. 没有非空行 → `empty`（空文件两套解析器等价，路由按 v1 开，标 `content-empty`）；
 * 2. 全部过 2.0 词法 + 至少一个锚点 → `kojo2`（**唯一**算"断定"的情形）；
 * 3. 全部过 2.0 词法但一个锚点都没有 → `ambiguous`（纯台词/纯注释在 v1 与 2.0 里长得一样）；
 * 4. 有 v1 反例但 2.0 行占多数且带锚点 → `ambiguous`（混排：多半是刚迁了一半）；
 * 5. 其余 → `v1`。
 */
export function fingerprintKojo2Source(source: string): Kojo2SourceFingerprint {
  const rawLines = source.split(/\r\n|\r|\n/);
  const v1Samples: Kojo2SourceCounterExample[] = [];
  let lineCount = 0;
  let anchorLines = 0;
  let kojo2Lines = 0;
  let v1Lines = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const body = (rawLines[i] ?? '').replace(LEAD_RE, '');
    if (body.trim().length === 0) continue;
    lineCount += 1;
    if (startsWithAnchor(body)) anchorLines += 1;
    if (isKojo2Line(body)) {
      kojo2Lines += 1;
    } else {
      v1Lines += 1;
      if (v1Samples.length < 3) v1Samples.push({ line: i + 1, text: body });
    }
  }

  return {
    lineCount,
    anchorLines,
    kojo2Lines,
    v1Lines,
    v1Samples,
    flavor: flavorOf(lineCount, anchorLines, kojo2Lines, v1Lines),
  };
}

function flavorOf(
  lineCount: number,
  anchorLines: number,
  kojo2Lines: number,
  v1Lines: number,
): Kojo2SourceFlavor {
  if (lineCount === 0) return 'empty';
  if (v1Lines === 0) return anchorLines > 0 ? 'kojo2' : 'ambiguous';
  if (anchorLines > 0 && kojo2Lines > v1Lines) return 'ambiguous';
  return 'v1';
}

/* ============================== 路由 ============================== */

/** 做出这次判定的依据（`resolved` 必带；测试与日志据此复述"为什么"） */
export type Kojo2RouteReason =
  /** per-file override（显式破例，优先级最高） */
  | 'override'
  /**
   * 2.0 的源扩展名（`.kojo` / `.kojo2`）。
   *
   * LAU-3b-FLIP：2026-10-27 起 `.kojo` 归 2.0，与阶段、正文都无关——这一条是主路，
   * 不是"新文件"才走的分支。
   */
  | 'extension-kojo2'
  /** `.kojo1` 扩展名（封存标记：不嗅正文，恒按 v1） */
  | 'extension-kojo1'
  /**
   * 历史原因，**路由已不再产生**：翻转前 `.kojo` 要按阶段 / 正文判定，那些结论类型
   * 仍留着（诊断门与题板接线按判别联合写死，删成员要连带改三处消费方）。
   * 新代码不要按它们分支——`.kojo` 现在走 {@link 'extension-kojo2'}。
   */
  | 'stage-v1-only'
  | 'stage-dual'
  | 'content-kojo2'
  | 'content-v1'
  | 'content-empty';

/** 路由判定：判别联合，**没有**"猜一个"的返回值 */
export type Kojo2RouteDecision =
  | {
      readonly kind: 'resolved';
      readonly filePath: string;
      readonly parser: Kojo2Parser;
      readonly reason: Kojo2RouteReason;
      /** 走了内容判据时给指纹；扩展名/阶段判据时为 null */
      readonly fingerprint: Kojo2SourceFingerprint | null;
    }
  | {
      readonly kind: 'ambiguous';
      readonly filePath: string;
      /**
       * 不决定时**唯一**允许的兜底（永远是 `kojo-v1`）：调用方照此打开，但必须把
       * `hint` 露给作者（换 override 或改成 `.kojo2`），不许悄悄按 2.0 上屏。
       */
      readonly fallback: 'kojo-v1';
      readonly fingerprint: Kojo2SourceFingerprint;
      readonly hint: string;
    }
  | {
      readonly kind: 'needs-content';
      readonly filePath: string;
      readonly reason: 'content-required';
      readonly hint: string;
    }
  | {
      readonly kind: 'blocked';
      readonly filePath: string;
      readonly reason: 'stage-disables-kojo2';
      readonly hint: string;
    }
  | {
      readonly kind: 'not-kojo';
      readonly filePath: string;
      /** 最后一段扩展名（含点、小写；没有扩展名为空串） */
      readonly extension: string;
    };

/**
 * `v1-only` 阶段被要求"把某个文件按 2.0 解析"时的提示。
 *
 * 翻转之后 `.kojo` / `.kojo2` 恒归 2.0，**阶段拦不到它们**；这条只剩 per-file override
 * 那一条路（作者把 `.erb` 之类显式钉成 2.0）。
 */
const STAGE_BLOCKED_HINT =
  '当前是 v1-only 阶段：把非 kojo 文件显式钉成 2.0 解析这件事被阶段挡住了。切到 dual 或 2.0-default 再试。';

/** 取路径最后一段扩展名（小写、含点；`x.kojo.bak` → `.bak`，无扩展名 → 空串） */
export function extensionOf(filePath: string): string {
  const slashed = filePath.replace(/\\/g, '/');
  const base = slashed.slice(slashed.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 纯函数路由入参（controller 把持久化的 override 解出来之后交给它；测试可绕过 controller） */
export interface Kojo2RouteInput {
  readonly stage: Kojo2CutoverStage;
  /** 目标文件路径（扩展名判据 + override 键归一都用它） */
  readonly filePath: string;
  /**
   * 文件正文。
   *
   * **路由已不再读它**（LAU-3b-FLIP：`.kojo` 由扩展名定，不嗅正文）；保留字段是为了
   * 不打断既有调用方，正文的用处只剩内容指纹（迁移候选 / 改名工具 / 诊断提示），
   * 那些都直接调 `fingerprintKojo2Source`。
   */
  readonly source?: string;
  /** 显式 per-file override（最高优先级；`null`/缺省 = 没有） */
  readonly override?: Kojo2Parser | null;
}

/**
 * 路由主判据（纯函数）。
 *
 * 口诀：**override 当家，扩展名定解析器。**
 *
 * 2026-10-27（LAU-3b-FLIP，用户口径「`.kojo` 当场让给 2.0」）之后：`.kojo` / `.kojo2`
 * 恒归 2.0，`.kojo1` 恒归 v1，与切流阶段、正文都无关——这里没有"猜"，也没有
 * "按阶段把老扩展名留给 v1"那一档。切流三档管的只剩**封存层可不可见**
 * （`kojo2StageAllowsLegacy`）与迁移提示，不再决定任何一份文件用哪个解析器。
 *
 * override 仍是最高优先级；`v1-only` 阶段拦的只有"把非 kojo 文件显式钉成 2.0"
 * 这一条（切流语义），`.kojo` 本身不受影响。
 */
export function decideKojo2Route(input: Kojo2RouteInput): Kojo2RouteDecision {
  const { stage, filePath } = input;
  const extension = extensionOf(filePath);

  if (input.override !== undefined && input.override !== null) {
    if (input.override === 'kojo2' && stage === 'v1-only') {
      return { kind: 'blocked', filePath, reason: 'stage-disables-kojo2', hint: STAGE_BLOCKED_HINT };
    }
    return {
      kind: 'resolved',
      filePath,
      parser: input.override,
      reason: 'override',
      fingerprint: null,
    };
  }

  if (KOJO2_FILE_EXTENSIONS.includes(extension)) {
    // LAU-3b-FLIP（2026-10-27 用户口径）：`.kojo` 与 `.kojo2` 都是 2.0 的源。
    // 扩展名自带"这是 2.0 文件"的声明，语言面无条件注册 ⇒ 与阶段、正文都无关。
    // 盘上还没迁移的 v1 旧文件不会再被"正文嗅探"悄悄接走——它们要么由迁移原地改写成
    // 2.0，要么由改名工具标成 `.kojo1`；这份确定性正是翻转要买的东西。
    return {
      kind: 'resolved',
      filePath,
      parser: 'kojo2',
      reason: 'extension-kojo2',
      fingerprint: null,
    };
  }

  if (extension === KOJO_V1_FILE_EXTENSION) {
    // `.kojo1` 是封存标记：与阶段、正文都无关，恒按 v1。
    return {
      kind: 'resolved',
      filePath,
      parser: 'kojo-v1',
      reason: 'extension-kojo1',
      fingerprint: null,
    };
  }

  return { kind: 'not-kojo', filePath, extension };
}

/* ============================== 迁移预览 ============================== */

/** 一条不可自动迁移项的上屏形态（带原行文本，作者不用回头数行号） */
export interface Kojo2MigrationBlocker {
  /** v1 源 1 基行号 */
  readonly line: number;
  readonly construct: string;
  readonly targetHint: string;
  /** core 诊断码（`core/migration/*` / `core/narrative/*` …） */
  readonly code: string;
  /** 该行原文（预览里原样展示"哪一句没迁"） */
  readonly sourceLine: string;
}

/** 一条迁移警告的上屏形态（可迁移但需人工复核；`line` 为 null = 不指某一行） */
export interface Kojo2MigrationWarning {
  /** core 诊断码（如 `core/migration/version`） */
  readonly code: string;
  readonly message: string;
  /** 1 基行号；诊断没带 span = null */
  readonly line: number | null;
}

/** 迁移预览（纯快照；`code` 仅供预览，**没有**任何写盘入口） */
export interface Kojo2MigrationPreview {
  readonly filePath: string;
  /** core 口径：全部行机械迁移成功才 true；false ⇒ 这份文件不许落盘 */
  readonly ok: boolean;
  readonly changed: boolean;
  /**
   * 预计改动行数 = 被改写的**旧行**数（同一旧行拆成多行只算一行）。
   *
   * 与 `removedLineCount` 数值相同：diff 里每一条 `removed` 都对应一条旧行，
   * 保留两个名字是为了调用方按"改动行 / 增删行"两种口径取数时不至于再算一遍。
   */
  readonly changedLineCount: number;
  readonly addedLineCount: number;
  readonly removedLineCount: number;
  /** 迁移后行数 */
  readonly newLineCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  /** 第一条阻断行（1 基；没有阻断 = null） */
  readonly firstBlockedLine: number | null;
  readonly blockers: readonly Kojo2MigrationBlocker[];
  /** 可迁移但需复核的警告（迁移器口径；不阻断落盘） */
  readonly warnings: readonly Kojo2MigrationWarning[];
  /** 从 v1 文件头搬去 adapter / 工程配置的元数据（预览里让作者知道"这几行会离开脚本"） */
  readonly metadata: MigrateMetadata;
  /** 逐行 diff 摘要（与迁移向导同一套行对齐） */
  readonly diff: readonly MigrateDiffLine[];
  /** unified diff 文本（hunk 上下文 3 行；直接塞预览框） */
  readonly diffText: string;
  /** 迁移结果正文（预览用；本函数没有写盘通路） */
  readonly code: string;
}

/** 迁移预览入参 */
export interface Kojo2MigrationPreviewRequest {
  readonly filePath: string;
  readonly source: string;
  /** v1 文件头缺 `角色:` 时给裸台词的说话人兜底（与迁移引擎同参） */
  readonly speaker?: string;
}

/** 去掉末尾换行后的物理行（与迁移引擎 `readSource` 的"不产生伪行"同口径） */
function splitSourceLines(source: string): string[] {
  const lines = splitEolLines(source);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 产出迁移预览：**分类 + 改写 + 逐行 diff + 阻断台账**，一次纯计算。
 *
 * 不落的盘：本函数签名里没有 io / kernel / file 参数；它甚至不知道文件在哪（`filePath`
 * 只用来生成 diff 头与回显）。调用方拿到 `ok=false` 即应拒绝写盘（core 的既有契约）。
 */
export function previewKojo2Migration(
  request: Kojo2MigrationPreviewRequest,
): Kojo2MigrationPreview {
  const result: MigrateResult = migrateKojoSource(
    request.source,
    request.speaker === undefined ? {} : { speaker: request.speaker },
  );
  const diff = buildMigrateDiff(request.source, result.code, result.sourceMap);
  const summary = summarizeMigration(result);
  const sourceLines = splitSourceLines(request.source);
  const changedOldLines = new Set<number>();
  let addedLineCount = 0;
  for (const line of diff) {
    if (line.kind === 'added') addedLineCount += 1;
    else if (line.kind === 'removed' && line.oldLine !== null) changedOldLines.add(line.oldLine);
  }

  return {
    filePath: request.filePath,
    ok: result.ok,
    changed: result.code !== request.source,
    changedLineCount: changedOldLines.size,
    addedLineCount,
    removedLineCount: changedOldLines.size,
    newLineCount: splitSourceLines(result.code).length,
    warningCount: summary.warningCount,
    errorCount: summary.errorCount,
    firstBlockedLine: summary.firstBlockedLine,
    blockers: result.unsupported.map((item) => ({
      line: item.line,
      construct: item.construct,
      targetHint: item.targetHint,
      code: item.code,
      sourceLine: sourceLines[item.line - 1] ?? '',
    })),
    warnings: result.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        line: diagnostic.span?.start.line ?? null,
      })),
    metadata: result.metadata,
    diff,
    diffText: formatMigrateDiff(request.filePath, diff),
    code: result.code,
  };
}

/* ============================== 持久化 ============================== */

/**
 * 注入的存储端口（`localStorage` / `Storage` 天然满足；测试传 Map 假体）。
 *
 * 只列三格：读、写、删。**不做** `clear()` / `key()` / `length`——本模块只能碰自己那一个键，
 * 物理上碰不动别人的偏好。
 */
export interface Kojo2CutoverStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 存储键（与 `ui/kojo2-flag.ts` 的 `kojo.ui.kojo2Cutover.v1` 分开，见模块头注） */
export const KOJO2_CUTOVER_STORAGE_KEY = 'kojo.ui.kojo2Cutover.plan.v1';

/** 从注入 storage 读一格原始字符串（读抛错 / 没挂 storage 一律 null，不抛进调用方） */
function readStorageString(storage: Kojo2CutoverStorage | null, key: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 一份计划文档解析出的阶段 + **它是怎么来的**。
 *
 * `liftedFromV1Baseline` = 这份是 v1 计划且停在 `v1-only`，被读侧抬到了新默认档。为什么要
 * 带出来：v1 的 `v1-only` 与"没人选过"不可区分，抬走它就必须允许**旧布尔键**把它拉回来——
 * 翻过旧开关的人不该因为"我们改了默认"被顶到 `2.0-default`（那一档连 kojo1 一起封）。
 * 显式选过的档（v1 的另两档、任何 v2 计划）不带这一格 ⇒ 旧键无从插手。
 */
export interface ParsedCutoverStage {
  readonly stage: Kojo2CutoverStage;
  readonly liftedFromV1Baseline: boolean;
}

/**
 * 解析一份计划文档的**阶段与来历**（纯函数：不读 storage、不碰全局、不看别的键）。
 * 坏 JSON / 坏版本 / 坏阶段一律 `null`（失败方向 = 少露）；认 version 1 与 2。
 * 与 {@link readPersistedPlan} 同一份判据（那边多带 override 表）⇒ 控制器与
 * `ui/kojo2-flag.ts` 的热路径**不可能对同一份文档给出不同阶段**。
 */
export function parseKojo2CutoverPlanStage(raw: string | null): ParsedCutoverStage | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const document = parsed as { version?: unknown; stage?: unknown };
  if (document.version !== 1 && document.version !== 2) return null;
  if (!isKojo2CutoverStage(document.stage)) return null;
  const liftedFromV1Baseline = document.version === 1 && document.stage === 'v1-only';
  return {
    stage: liftedFromV1Baseline ? KOJO2_CUTOVER_DEFAULT_STAGE : document.stage,
    liftedFromV1Baseline,
  };
}

/**
 * 薄壳：只要阶段、不问来历（`ui/kojo2-flag.ts` 的热路径缓存用）。要参与旧布尔键那条
 * 规则的地方请直接用带来历的那一枚。
 */
export function parseKojo2CutoverStage(raw: string | null): Kojo2CutoverStage | null {
  return parseKojo2CutoverPlanStage(raw)?.stage ?? null;
}

/**
 * 读盘上的阶段（**清过坏值**：坏 JSON / 坏版本 / 坏阶段一律 null，调用方自行兜底）。
 *
 * 导出给 `ui/kojo2-flag.ts` 单源派生用：那边只认"盘上有没有一档"，不需要 override 清单。
 * 本函数不碰全局 `localStorage`——`storage` 是注入进来的那一份（与控制器同一纪律）。
 */
export function readKojo2CutoverStage(
  storage: Kojo2CutoverStorage | null,
  key: string = KOJO2_CUTOVER_STORAGE_KEY,
): Kojo2CutoverStage | null {
  return parseKojo2CutoverStage(readStorageString(storage, key));
}

/** 落盘文档（版本位留给将来的字段演进；读不懂的一律回缺省） */
interface PersistedCutoverPlan {
  readonly version: 2;
  readonly stage: Kojo2CutoverStage;
  readonly overrides: Readonly<Record<string, Kojo2Parser>>;
}

/**
 * v1 计划（**只读**，用于一次性迁移）。
 *
 * 为什么必须迁：`v1-only` 既是旧默认、又是开机自动写下的基线（`attachStorage` 在没有计划
 * 时 `persist()` 一次）⇒ 盘上"几乎人人有一份 v1-only"，只改默认常量对存量用户零效果。
 * 规则写死：`v1-only` → `2.0-default`（并留 `migratedFromV1Plan` 让设置页如实说一句，
 * 不静默改档位）；`dual` / `2.0-default` 原样保留（那是显式选择）。
 */
interface LegacyPersistedCutoverPlan {
  readonly version: 1;
  readonly stage: Kojo2CutoverStage;
  readonly overrides: Readonly<Record<string, Kojo2Parser>>;
}

/** 路径键归一：统一斜杠、折叠重复、去掉尾斜杠（UNC 的 `//` 保留） */
export function normalizePathKey(filePath: string): string {
  const slashed = filePath.trim().replace(/\\/g, '/');
  const unc = slashed.startsWith('//');
  const collapsed = slashed.replace(/\/{2,}/g, '/');
  const restored = unc ? `/${collapsed}` : collapsed;
  return restored.length > 1 ? restored.replace(/\/+$/, '') : restored;
}

/** 一次读盘的结论（`migratedFromV1` = 这份计划是 v1 升上来的，调用方据此写回 v2 并如实上屏） */
export interface PersistedCutoverPlanRead {
  readonly stage: Kojo2CutoverStage;
  readonly overrides: ReadonlyMap<string, Kojo2Parser>;
  readonly migratedFromV1: boolean;
  /** 阶段是"v1 基线被抬上来的"⇒ 旧布尔键仍可把它拉回 `dual`（判据见 {@link ParsedCutoverStage}） */
  readonly liftedFromV1Baseline: boolean;
}

/**
 * 读一份持久化计划；坏 JSON / 坏版本 / 坏阶段 → null（调用方回缺省，不抛）。
 * 阶段那一份判据**复用** {@link parseKojo2CutoverPlanStage}（这里只多解 override 表）——
 * 两处各写一遍版本 / 迁移规则，早晚有一天控制器与热路径解析对不上。
 */
function readPersistedPlan(
  storage: Kojo2CutoverStorage | null,
  key: string,
): PersistedCutoverPlanRead | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  const parsedStage = parseKojo2CutoverPlanStage(raw);
  if (parsedStage === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const document = parsed as { version?: unknown; overrides?: unknown };

  const overrides = new Map<string, Kojo2Parser>();
  if (document.overrides !== null && typeof document.overrides === 'object') {
    for (const [path, value] of Object.entries(document.overrides as Record<string, unknown>)) {
      if (value !== 'kojo-v1' && value !== 'kojo2') continue; // 脏值丢弃，不猜
      const normalized = normalizePathKey(path);
      if (normalized.length > 0) overrides.set(normalized, value);
    }
  }
  return {
    stage: parsedStage.stage,
    overrides,
    migratedFromV1: document.version === 1,
    liftedFromV1Baseline: parsedStage.liftedFromV1Baseline,
  };
}

/* ============================== 控制器 ============================== */

/** 控制器快照（订阅者 / 设置页 / 调试面板共用一份只读视图） */
export interface Kojo2CutoverSnapshot {
  readonly stage: Kojo2CutoverStage;
  readonly stageLabel: string;
  readonly overrides: readonly { readonly filePath: string; readonly parser: Kojo2Parser }[];
  /**
   * 当前状态是否与注入的 storage **一致**（没有 storage / 最近一次写入失败 = false）。
   *
   * 不是"是否支持持久化"：`attachStorage` 之后盘上还没有计划时，当前状态就是基线
   * （下次启动读到的正是它），这里照样是 true；只有"内存变了但没写下去"才是 false。
   */
  readonly persisted: boolean;
  /**
   * 本次读到的计划是 **v1 升上来的**（一次性事实，写回 v2 之后即消失）。
   *
   * 为什么必须带出来：默认档从 `v1-only` 翻到 `2.0-default` 会把存量用户的档位抬走，
   * 而"没人选过的基线"与"显式选了 v1-only"在 v1 计划里**不可区分**（见
   * {@link LegacyPersistedCutoverPlan}）。抬了就必须说（铁律 4），设置页据此给一行回执。
   */
  readonly migratedFromV1Plan: boolean;
}

/** 控制器构造参数 */
export interface Kojo2CutoverControllerOptions {
  /** 持久化端口；缺省 null = 只在内存里（测试默认值，全局零污染） */
  readonly storage?: Kojo2CutoverStorage | null;
  /** 存储键覆盖（多工作区 / 测试隔离用） */
  readonly storageKey?: string;
  /** 初始阶段；**持久化里已有计划时以盘上为准**（"重启后回到你上次停的那一档"） */
  readonly stage?: Kojo2CutoverStage;
}

export interface Kojo2CutoverController {
  /** 当前阶段 */
  getStage(): Kojo2CutoverStage;
  /** 只读快照（每次现算，不缓存） */
  getSnapshot(): Kojo2CutoverSnapshot;
  canAdvance(): boolean;
  canRollback(): boolean;
  /** 前进一步（到顶 = no-op，不抛） */
  advance(): Kojo2CutoverStage;
  /** 回退一步（到底 = no-op，不抛） */
  rollback(): Kojo2CutoverStage;
  /** 回退到任意**更早**阶段（2.0-default → v1-only 的紧急回退）；目标在当前之后 = 不动 */
  rollbackTo(stage: Kojo2CutoverStage): Kojo2CutoverStage;
  /** 逃生门：任意方向跳（devtools / 测试用；未知值 = 不动） */
  setStage(stage: Kojo2CutoverStage): Kojo2CutoverStage;
  /** 给单个文件钉解析器（显式 override） */
  setOverride(filePath: string, parser: Kojo2Parser): void;
  /** 撤掉单个文件的 override（没有 = no-op） */
  clearOverride(filePath: string): void;
  /** 该文件当前生效的 override（没有 = null） */
  getOverride(filePath: string): Kojo2Parser | null;
  /** 路由判定（存好的 override 参与，`request.override` 更优先） */
  route(request: Kojo2RouteRequest): Kojo2RouteDecision;
  /**
   * 以**指定阶段**路由（K2-CUTOVER-ROUTE）。
   *
   * 为什么需要这一格：控制器的内存阶段与 `ui/kojo2-flag.ts` 解析出的「生效阶段」在开机
   * `attachStorage` 之后逐字相等，但**测试 / 调试面板**可能只喂了盘上计划而没挂存储端；
   * 诊断/问题归属要跟"作者此刻看到的档位"走，就得不改控制器状态地把阶段交进来。
   * 存好的 override 仍由控制器统一持有（调用方不必自己拼一份）。
   */
  routeAt(stage: Kojo2CutoverStage, request: Kojo2RouteRequest): Kojo2RouteDecision;
  /** 迁移预览（不落盘；与阶段无关，任何阶段都能预演） */
  previewMigration(request: Kojo2MigrationPreviewRequest): Kojo2MigrationPreview;
  /** 订阅状态变化（阶段 / override / 存储挂载）；返回取消订阅 */
  subscribe(listener: (snapshot: Kojo2CutoverSnapshot) => void): () => void;
  /** 挂上持久化端口：先**采纳盘上已有的计划**，没有就把当前状态写下去 */
  attachStorage(storage: Kojo2CutoverStorage | null): void;
  /** 摘掉持久化端口（之后的改动只留在内存） */
  detachStorage(): void;
  /**
   * 恢复出厂：默认阶段 + 清空 override + 删存储键。
   *
   * 只动**计划**这一格。旧布尔键不在这里删（本模块只碰自己那一个键的历史记账）：宿主做
   * "恢复出厂"要两件一起做——用 `ui/kojo2-cutover-settings.tsx` 的 `resetKojo2CutoverAll`
   * （先删旧键再 `reset`），否则计划一删，旧键 `'on'` 会把解析拉回 `dual`。
   */
  reset(): void;
}

/** `route` 入参（`override` 一次性覆盖存好的那份） */
export interface Kojo2RouteRequest {
  readonly filePath: string;
  readonly source?: string;
  readonly override?: Kojo2Parser | null;
}

/**
 * 造一个切换控制器（每次调用一个独立实例；宿主的进程级单例见
 * {@link getKojo2CutoverController}）。
 *
 * 失败方向：持久化坏值回 {@link KOJO2_CUTOVER_DEFAULT_STAGE}（＝`2.0-default`）、写失败
 * 只丢这一次落盘（内存状态仍生效，`snapshot.persisted=false` 让调用方看得见），绝不抛进渲染链。
 */
export function createKojo2CutoverController(
  options: Kojo2CutoverControllerOptions = {},
): Kojo2CutoverController {
  const storageKey = options.storageKey ?? KOJO2_CUTOVER_STORAGE_KEY;
  let storage: Kojo2CutoverStorage | null = options.storage ?? null;
  const persistedPlan = readPersistedPlan(storage, storageKey);
  const seededStage =
    options.stage !== undefined && isKojo2CutoverStage(options.stage)
      ? options.stage
      : KOJO2_CUTOVER_DEFAULT_STAGE;
  let stage: Kojo2CutoverStage = persistedPlan?.stage ?? seededStage;
  const overrides = new Map<string, Kojo2Parser>(persistedPlan?.overrides ?? []);
  /** v1 计划升上来的一次性回执（写回 v2 后下次开机即为 false） */
  let migratedFromV1Plan = persistedPlan?.migratedFromV1 ?? false;
  /** 当前状态是否与 storage 一致（没有 storage = false；写失败 = false） */
  let persisted = storage !== null;
  const listeners = new Set<(snapshot: Kojo2CutoverSnapshot) => void>();

  function snapshot(): Kojo2CutoverSnapshot {
    return {
      stage,
      stageLabel: KOJO2_STAGE_LABELS[stage],
      overrides: [...overrides].map(([filePath, parser]) => ({ filePath, parser })),
      persisted,
      migratedFromV1Plan,
    };
  }

  function persist(): void {
    if (storage === null) {
      persisted = false;
      return;
    }
    const document: PersistedCutoverPlan = {
      version: 2,
      stage,
      overrides: Object.fromEntries(overrides),
    };
    try {
      storage.setItem(storageKey, JSON.stringify(document));
      persisted = true;
    } catch {
      // 隐私模式 / 配额满：只丢掉这一次落盘，内存状态照常生效（不抛进调用方）
      persisted = false;
    }
  }

  function emit(): void {
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  }

  /**
   * 显式改档 = 迁移完成：把旧布尔键删掉（只删**存在**的那一格，免得给"删了几次"记账添噪）。
   *
   * 不删的后果：计划一旦被 `reset()` 删掉，旧键 `'on'` 会重新把解析拉回 `dual`——"恢复出厂
   * 了但 2.0 面还开着"。删不掉的后果只是"旧键继续生效"（读侧规则不变），不抛进调用方。
   */
  function retireLegacyFlag(): void {
    if (storage === null) return;
    if (readStorageString(storage, KOJO2_LEGACY_FLAG_KEY) === null) return;
    try {
      storage.removeItem(KOJO2_LEGACY_FLAG_KEY);
    } catch {
      /* 删不掉：旧键留着，读侧仍按 {@link stageFromLegacyKojo2Flag} 的规则解释 */
    }
  }

  function commitStage(next: Kojo2CutoverStage): Kojo2CutoverStage {
    if (!isKojo2CutoverStage(next) || next === stage) return stage;
    stage = next;
    persist();
    retireLegacyFlag();
    emit();
    return stage;
  }

  function findOverrideKey(filePath: string): string | null {
    const key = normalizePathKey(filePath);
    if (overrides.has(key)) return key;
    const lower = key.toLowerCase();
    for (const stored of overrides.keys()) {
      if (stored.toLowerCase() === lower) return stored;
    }
    return null;
  }

  /**
   * 路由的**唯一**执行体：`route`（控制器当前阶段）与 `routeAt`（外部指定阶段）共用。
   *
   * override 的优先级写死在这里：一次性 `request.override` > 存好的那一份 > 无。
   * 阶段脏值不猜——回控制器当前阶段（与 `setStage` 的失败方向同一条）。
   */
  function routeDecision(
    stageToUse: Kojo2CutoverStage,
    request: Kojo2RouteRequest,
  ): Kojo2RouteDecision {
    const storedKey = findOverrideKey(request.filePath);
    const stored = storedKey === null ? null : (overrides.get(storedKey) ?? null);
    return decideKojo2Route({
      stage: isKojo2CutoverStage(stageToUse) ? stageToUse : stage,
      filePath: request.filePath,
      ...(request.source === undefined ? {} : { source: request.source }),
      override: request.override ?? stored,
    });
  }

  return {
    getStage: () => stage,
    getSnapshot: snapshot,
    canAdvance: () => stageIndex(stage) < KOJO2_CUTOVER_STAGES.length - 1,
    canRollback: () => stageIndex(stage) > 0,
    advance() {
      const index = stageIndex(stage);
      const next = KOJO2_CUTOVER_STAGES[index + 1];
      return next === undefined ? stage : commitStage(next);
    },
    rollback() {
      const index = stageIndex(stage);
      const next = KOJO2_CUTOVER_STAGES[index - 1];
      return next === undefined ? stage : commitStage(next);
    },
    rollbackTo(target) {
      if (!isKojo2CutoverStage(target)) return stage;
      return stageIndex(target) <= stageIndex(stage) ? commitStage(target) : stage;
    },
    setStage(target) {
      return isKojo2CutoverStage(target) ? commitStage(target) : stage;
    },
    setOverride(filePath, parser) {
      if (parser !== 'kojo-v1' && parser !== 'kojo2') return;
      const key = normalizePathKey(filePath);
      if (key.length === 0 || overrides.get(key) === parser) return;
      overrides.set(key, parser);
      persist();
      emit();
    },
    clearOverride(filePath) {
      const key = findOverrideKey(filePath);
      if (key === null) return;
      overrides.delete(key);
      persist();
      emit();
    },
    getOverride(filePath) {
      const key = findOverrideKey(filePath);
      return key === null ? null : (overrides.get(key) ?? null);
    },
    route(request) {
      return routeDecision(stage, request);
    },
    routeAt(stageToUse, request) {
      return routeDecision(stageToUse, request);
    },
    previewMigration: (request) => previewKojo2Migration(request),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachStorage(next) {
      storage = next;
      persisted = next !== null;
      const plan = readPersistedPlan(next, storageKey);
      const legacy = stageFromLegacyKojo2Flag(
        readStorageString(next, KOJO2_LEGACY_FLAG_KEY),
      );
      if (plan !== null) {
        stage = plan.stage;
        overrides.clear();
        for (const [path, parser] of plan.overrides) overrides.set(path, parser);
        migratedFromV1Plan = plan.migratedFromV1;
        // v1 计划当拍写回 v2（读侧只认 1/2、写侧只写 2 ⇒ 迁移一次性）；快照的
        // `migratedFromV1Plan` 让设置页如实说一句。
        if (plan.migratedFromV1) persist();
        // 旧键（`'on'` ⇒ `dual`）仍能说话的两处：计划显式停在 `v1-only`；或阶段是**被抬上来的
        // v1 基线**（翻过旧开关的人不该被顶到 `2.0-default`——那一档连 kojo1 一起封）。
        // 显式选过 `dual` / `2.0-default` 的计划不受它影响（阶段独占真源）。
        if ((stage === 'v1-only' || plan.liftedFromV1Baseline) && legacy !== null && legacy !== stage) {
          stage = legacy;
          persist();
        }
      } else if (next !== null) {
        // 盘上还没有计划：旧键 `'on'` ⇒ 以 `dual` 起步，再把手里的这一档写成基线。
        if (legacy !== null) stage = legacy;
        persist();
      } else {
        migratedFromV1Plan = false;
      }
      emit();
    },
    detachStorage() {
      storage = null;
      persisted = false;
      emit();
    },
    reset() {
      stage = KOJO2_CUTOVER_DEFAULT_STAGE;
      overrides.clear();
      migratedFromV1Plan = false; // 恢复出厂＝作者亲手做的，不需要再给迁移回执
      if (storage !== null) {
        try {
          storage.removeItem(storageKey);
          persisted = true;
        } catch {
          persisted = false;
        }
      } else {
        persisted = false;
      }
      emit();
    },
  };
}

/* ============================== 进程级单例 ============================== */

let defaultController: Kojo2CutoverController | null = null;

/**
 * 宿主的进程级控制器（惰性建、无 storage）。
 *
 * 开机时把持久化端口挂上即可（一次性）：
 * `getKojo2CutoverController().attachStorage(window.localStorage)`。
 * 单例形态与 `editor-model-pool-instance.ts` 同一先例：语言/路由是进程级事实，
 * 每个标签各造一份等于各判各的。
 */
export function getKojo2CutoverController(): Kojo2CutoverController {
  if (defaultController === null) defaultController = createKojo2CutoverController();
  return defaultController;
}

/**
 * 丢掉进程级单例（**只给测试 / 宿主重启用**）。
 *
 * 不用 `vi.resetModules` 也能回到干净态：旧实例的订阅者不会被通知（它们本来就该随
 * 宿主一起销毁）。
 */
export function resetKojo2CutoverController(): void {
  defaultController = null;
}
