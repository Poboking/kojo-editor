/**
 * K2-CUTOVER-PRE · 老 `.kojo` → 2.0 的**切换前夜**（双轨 + 开关 + 迁移预览）。
 *
 * ## 本文件不做什么
 *
 * 真正的 cutover（把 `languages.ts` 的 descriptor 指过来、把语言服务 / 结构层 / 保存链路
 * 换成 2.0）是 `K2-CUTOVER`。这里只交付"切得动、切得回、切了能看"的三件前置件：
 *
 * 1. **特性开关**：三态状态机 `v1-only → dual → 2.0-default`，每步都能回退（`advance` /
 *    `rollback` / 逃生门 `setStage`）。默认 `v1-only`：**失败方向永远是"少露"**。
 * 2. **文件路由**：一份文件到底交给 v1 还是 2.0 解析器。判据顺序 = 口诀：
 *    > override 当家，扩展名先说，阶段定老文件，内容只在 2.0-default 里断 `.kojo`。
 *    结果一律可判别（`resolved` / `ambiguous` / `needs-content` / `blocked` / `not-kojo`），
 *    歧义时给**唯一**允许的兜底而不是随手选一个（`ambiguous.fallback === 'kojo-v1'`）。
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
 * "2.0 面要不要挂"的布尔预演开关，本文件是"切到哪一档 + 哪个文件破例"的计划书；
 * K2-CUTOVER 收口时由设置页把两者对齐（见交付报告的 wiring 请求）。
 */

import {
  isKojo2Line,
  migrateKojoSource,
  summarizeMigration,
  type MigrateMetadata,
  type MigrateResult,
} from '@kojo/kojo-core';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { KOJO2_SOURCE_EXTENSION } from '../monaco/kojo2-constants';
import {
  buildMigrateDiff,
  formatMigrateDiff,
  type MigrateDiffLine,
} from './kojo2-migrate-model';

/* ============================== 阶段 ============================== */

/**
 * 三态切换阶段（字符串字面量就是持久化口径；`2.0-default` 带点，读代码时一眼认出）。
 *
 * - `v1-only`：只有 v1。`.kojo` 按 v1，`.kojo2` **不接管**（语言面也没注册，返回 `blocked`）。
 * - `dual`：双轨。老扩展名 `.kojo` 仍按 v1（作者的老工程一行都不用动），新扩展名 `.kojo2` 按 2.0。
 * - `2.0-default`：2.0 默认。`.kojo2` 按 2.0；`.kojo` 交给**内容指纹**判——已是 2.0 写法的
 *   老文件按 2.0 开，还是 v1 写法的仍按 v1，判不出来就报 `ambiguous`（不静默猜）。
 */
export type Kojo2CutoverStage = 'v1-only' | 'dual' | '2.0-default';

/** 阶段序（数组序 = 前进方向；`rollback` 就是下标 -1） */
export const KOJO2_CUTOVER_STAGES: readonly Kojo2CutoverStage[] = [
  'v1-only',
  'dual',
  '2.0-default',
];

/** 缺省阶段：切不动比切错了便宜（`v1-only` 与"2.0 面没接"的现状逐字等价） */
export const KOJO2_CUTOVER_DEFAULT_STAGE: Kojo2CutoverStage = 'v1-only';

/** 每个阶段的人话口径（设置页 / 调试面板直接上屏；本模块不产出别的界面文案） */
export const KOJO2_STAGE_LABELS: Readonly<Record<Kojo2CutoverStage, string>> = {
  'v1-only': '只认 v1：老文件照旧，2.0 面不接管',
  dual: '双轨：老 `.kojo` 仍按 v1，新 `.kojo2` 按 2.0',
  '2.0-default': '2.0 默认：新扩展名按 2.0，老扩展名由内容指纹判',
};

/** 运行期阶段守卫（持久化里读到脏值 / devtools 传错，一律回缺省，不抛） */
export function isKojo2CutoverStage(value: unknown): value is Kojo2CutoverStage {
  return value === 'v1-only' || value === 'dual' || value === '2.0-default';
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
 * v1 源扩展名：**直接取契约那一枚**（`@kojo/plugin-api::KOJO_SOURCE_EXTENSION`），
 * 本文件不抄第二份字面量（`kojo-extension-single-source.test.ts` 的全仓守门就查这个）。
 */
export const KOJO_V1_FILE_EXTENSION: string = KOJO_SOURCE_EXTENSION;

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
  /** `.kojo2` 扩展名（新文件） */
  | 'extension-kojo2'
  /** `v1-only` 阶段的 `.kojo` */
  | 'stage-v1-only'
  /** `dual` 阶段的 `.kojo`（老文件仍按 v1） */
  | 'stage-dual'
  /** `2.0-default` 下内容指纹判 2.0 */
  | 'content-kojo2'
  /** `2.0-default` 下内容指纹判 v1 */
  | 'content-v1'
  /** `2.0-default` 下空文件（两套等价，按 v1 开） */
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

/** 歧义提示（作者面人话；`hint` 只在这里出现一次，调用方原样上屏） */
const AMBIGUOUS_HINT =
  '这份文件两套解析器都说得通（纯台词/纯注释，或刚迁到一半）：先按 v1 打开；确认是 2.0 就给它加一个 per-file override，或改名成 `.kojo2`。';

/** 缺正文时的提示 */
const NEEDS_CONTENT_HINT =
  '2.0 默认阶段下 `.kojo` 要看正文才能定解析器：把文件内容一起传进来（打开后再判），不要只按路径猜。';

/** `v1-only` 阶段碰到 `.kojo2` 的提示 */
const STAGE_BLOCKED_HINT =
  '当前是 v1-only 阶段：2.0 语言面还没挂，`.kojo2` 现在打不开。切到 dual 或 2.0-default 再开。';

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
  /** 文件正文；只有 `2.0-default` 的 `.kojo` 需要它 */
  readonly source?: string;
  /** 显式 per-file override（最高优先级；`null`/缺省 = 没有） */
  readonly override?: Kojo2Parser | null;
}

/**
 * 路由主判据（纯函数）。
 *
 * 口诀：**override 当家，扩展名先说，阶段定老文件，内容只在 2.0-default 里断 `.kojo`。**
 *
 * 为什么 `.kojo2` 在 `v1-only` 下是 `blocked` 而不是"当 v1 开"：2.0 的面在这个阶段根本
 * 没注册（`languages.ts` 按开关决定），拿 v1 词法去啃 2.0 文本等于把整篇染成错色——
 * 宁可显式报"现在打不开"，也不静默降级。
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

  if (extension === KOJO2_FILE_EXTENSION) {
    if (stage === 'v1-only') {
      return { kind: 'blocked', filePath, reason: 'stage-disables-kojo2', hint: STAGE_BLOCKED_HINT };
    }
    return {
      kind: 'resolved',
      filePath,
      parser: 'kojo2',
      reason: 'extension-kojo2',
      fingerprint: null,
    };
  }

  if (extension !== KOJO_V1_FILE_EXTENSION) {
    return { kind: 'not-kojo', filePath, extension };
  }

  if (stage === 'v1-only') {
    return {
      kind: 'resolved',
      filePath,
      parser: 'kojo-v1',
      reason: 'stage-v1-only',
      fingerprint: null,
    };
  }

  if (stage === 'dual') {
    return {
      kind: 'resolved',
      filePath,
      parser: 'kojo-v1',
      reason: 'stage-dual',
      fingerprint: null,
    };
  }

  // 2.0-default：老扩展名只有在**正文**能说话时才换解析器
  if (input.source === undefined) {
    return {
      kind: 'needs-content',
      filePath,
      reason: 'content-required',
      hint: NEEDS_CONTENT_HINT,
    };
  }
  const fingerprint = fingerprintKojo2Source(input.source);
  switch (fingerprint.flavor) {
    case 'kojo2':
      return {
        kind: 'resolved',
        filePath,
        parser: 'kojo2',
        reason: 'content-kojo2',
        fingerprint,
      };
    case 'v1':
      return {
        kind: 'resolved',
        filePath,
        parser: 'kojo-v1',
        reason: 'content-v1',
        fingerprint,
      };
    case 'empty':
      return {
        kind: 'resolved',
        filePath,
        parser: 'kojo-v1',
        reason: 'content-empty',
        fingerprint,
      };
    case 'ambiguous':
      return { kind: 'ambiguous', filePath, fallback: 'kojo-v1', fingerprint, hint: AMBIGUOUS_HINT };
  }
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
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
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

/** 落盘文档（版本位留给将来的字段演进；读不懂的一律回缺省） */
interface PersistedCutoverPlan {
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

/** 读一份持久化计划；坏 JSON / 坏版本 / 坏阶段 → null（调用方回缺省，不抛） */
function readPersistedPlan(
  storage: Kojo2CutoverStorage | null,
  key: string,
): { readonly stage: Kojo2CutoverStage; readonly overrides: ReadonlyMap<string, Kojo2Parser> } | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const document = parsed as { version?: unknown; stage?: unknown; overrides?: unknown };
  if (document.version !== 1 || !isKojo2CutoverStage(document.stage)) return null;

  const overrides = new Map<string, Kojo2Parser>();
  if (document.overrides !== null && typeof document.overrides === 'object') {
    for (const [path, value] of Object.entries(document.overrides as Record<string, unknown>)) {
      if (value !== 'kojo-v1' && value !== 'kojo2') continue; // 脏值丢弃，不猜
      const normalized = normalizePathKey(path);
      if (normalized.length > 0) overrides.set(normalized, value);
    }
  }
  return { stage: document.stage, overrides };
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
  /** 迁移预览（不落盘；与阶段无关，任何阶段都能预演） */
  previewMigration(request: Kojo2MigrationPreviewRequest): Kojo2MigrationPreview;
  /** 订阅状态变化（阶段 / override / 存储挂载）；返回取消订阅 */
  subscribe(listener: (snapshot: Kojo2CutoverSnapshot) => void): () => void;
  /** 挂上持久化端口：先**采纳盘上已有的计划**，没有就把当前状态写下去 */
  attachStorage(storage: Kojo2CutoverStorage | null): void;
  /** 摘掉持久化端口（之后的改动只留在内存） */
  detachStorage(): void;
  /** 恢复出厂：缺省阶段 + 清空 override + 删存储键 */
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
 * 失败方向一律"少露"：持久化坏值回 `v1-only`、写失败只丢这一次落盘（内存状态仍生效，
 * `snapshot.persisted=false` 让调用方看得见），绝不抛进渲染链。
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
  /** 当前状态是否与 storage 一致（没有 storage = false；写失败 = false） */
  let persisted = storage !== null;
  const listeners = new Set<(snapshot: Kojo2CutoverSnapshot) => void>();

  function snapshot(): Kojo2CutoverSnapshot {
    return {
      stage,
      stageLabel: KOJO2_STAGE_LABELS[stage],
      overrides: [...overrides].map(([filePath, parser]) => ({ filePath, parser })),
      persisted,
    };
  }

  function persist(): void {
    if (storage === null) {
      persisted = false;
      return;
    }
    const document: PersistedCutoverPlan = {
      version: 1,
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

  function commitStage(next: Kojo2CutoverStage): Kojo2CutoverStage {
    if (!isKojo2CutoverStage(next) || next === stage) return stage;
    stage = next;
    persist();
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
      const storedKey = findOverrideKey(request.filePath);
      const stored = storedKey === null ? null : (overrides.get(storedKey) ?? null);
      return decideKojo2Route({
        stage,
        filePath: request.filePath,
        ...(request.source === undefined ? {} : { source: request.source }),
        override: request.override ?? stored,
      });
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
      if (plan !== null) {
        stage = plan.stage;
        overrides.clear();
        for (const [path, parser] of plan.overrides) overrides.set(path, parser);
      } else if (next !== null) {
        // 盘上还没有计划：把当前状态写下去（"我看到的这一档"就是基线）
        persist();
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
