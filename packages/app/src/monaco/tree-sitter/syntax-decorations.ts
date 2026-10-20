import type * as Monaco from '../entry';
import { SUGAR_LEXICON_WORDS, type SugarLexiconWord } from '@kojo/plugin-kojo-sugar';
import type { LineDecoration } from '@kojo/plugin-api';
import { KOJO_LANGUAGE_ID, decorationsToMarkers } from '../kojo-language';
import { reportStructureDegradation } from './fallback';
import { KOJO_STRUCTURE_MAX_SYNTAX_FAULTS, type KojoStructureSyntaxFault, type KojoStructureSyntaxKind } from './types';

/**
 * 结构残缺的**上屏层**（TSIT2-D：CST 的 ERROR / MISSING → 作者看得懂的行级波浪线）。
 *
 * ## 为什么单独成文件（而不写进 `providers.ts`）
 *
 * `providers.ts` 是闸门与 provider 注册，本文件是"一份残缺事实怎么变成面上那一条"。
 * 判据（文案、码、去重）全部是**纯函数**，能脱离 Monaco 单测；只有最后那一步
 * `setModelMarkers` 碰 Monaco。混在一起会让"文案对不对"这种必须被钉死的东西
 * 依赖一个起得来的编辑器实例（本池是 node，起不来）。
 *
 * ## 呈现通道 = **独立 owner 的 markers**，不进 `ui.editor.decorator` 那一路
 *
 * 那一路是**同步槽位 + 整档替换**的：`marker-pool.ts` 按贡献顺序合并成一份
 * `LineDecoration[]`，一次刷新 = Monaco 那一个 owner 的 markers **整档替换** +
 * `problem-store` 该文件**整档替换**（`problem-store.setProblems` 的键只有路径，
 * 第二个写者进去就是互相抹）。结构残缺来自 worker，**到货时刻与装饰轮不同拍**，
 * 塞进那一路只有两种坏结果：要么被下一轮整档替换抹掉，要么抹掉转译器的诊断。
 * 所以这里用**自己的 owner**（`kojo-structure-syntax`）挂同一份 model：
 * - 波浪线照画（Monaco 的 markers 按 owner 并存，互不覆盖）；
 * - 「.kojo 校验」面板与「问题」面板**看不到这一层**（它们只读槽位那一路的产出）——
 *   这是取舍，不是遗漏：那两张面板的口径是"转译器对这份源的判定"，
 *   结构层的残缺不是转译器的判断，混进去等于让面板宣称一件它没算过的事（铁律 4 的反面）。
 *
 * ## 不重复计数（同一区间同一严重级只留一条）
 *
 * 规则：**同一行、同为 error、列区间相交**的转译器/装饰通道 marker ⇒ 我们这一条不画，
 * 保留插件侧那一条（它是语义判定的最近邻）；同一行但区间不相交 = 不同问题，各画各的
 * （按行连坐会吞掉同一行另一段的真红线）。判据取自
 * `monaco.editor.getModelMarkers({ owner: 装饰通道 owner, resource })` ——
 * 那是同一份 model 上唯一真源，不另立台账、不猜转译器"会不会"报。
 * 方向也要顾：装饰通道是异步的，比我们先或后都可能 ⇒ 订 `onDidChangeMarkers`，
 * 它的每一次刷新都让我们**按同一判据重算一次**（重算结果与上次逐字相同就不再发，
 * 否则就成了自己触发自己的死循环）。
 *
 * ## 关掉 / 坏了 = 一条都不留
 *
 * 开关翻回关（`providers.ts` 的 `deactivate`）、worker 整档停用、这一面自己抛错
 * （`capability: 'syntax'` 回落）⇒ `clearAll()` 把每个挂过的 model 清成空数组，
 * Monarch 那一路一个字都不动；失败只经 `fallback.ts` 台账**说一次**。
 */

/** 本层的 marker owner（与转译器那一路 `kojo-decorators` 并存、互不覆盖） */
export const STRUCTURE_SYNTAX_OWNER = 'kojo-structure-syntax';

/**
 * 装饰通道（转译器诊断 + 各插件装饰贡献）的 owner——真源在 `ui/EditorPane.tsx` 的
 * `const MARKER_OWNER = 'kojo-decorators'`。这里**只能重抄一遍字符串**：那是 React
 * 组件文件的局部常量，从表现层反向 import 一个组件模块毫无道理。
 * 漂移由 `tests/tree-sitter-diagnostics.test.ts` 读源码钉住（改了那边忘了这里 ⇒ 测试红）。
 */
export const DECORATOR_MARKER_OWNER = 'kojo-decorators';

/** 作者面来源标签（悬浮里说清"这条是谁说的"；不含任何机器词） */
export const STRUCTURE_SYNTAX_SOURCE = '结构解析';

/* ------------------------------- 诊断码（闭集拼法） ------------------------------- */

/**
 * 上屏码 = `kojo.` + 类别名（与 `erb-parser` 的 `erb.${kind}`、`condition-extractor` 的
 * `erb.expr-${kind}` 同一条拼法：字符串形态由**生产方唯一决定**，消费方不许自己拼）。
 * 闭集清单与中文短名住在契约层 `@kojo/plugin-api` 的 `diagnostic-copy.ts`
 * （`KOJO_STRUCTURE_SYNTAX_CODES`），两边逐一对账由 `tests/diagnostic-copy.test.ts` 钉。
 */
export const SYNTAX_CODE_PREFIX = 'kojo.';

export function syntaxErrorCode(kind: KojoStructureSyntaxKind): string {
  return `${SYNTAX_CODE_PREFIX}${kind}`;
}

/* --------------------------------- 文案 --------------------------------- */

/**
 * **机器记号名（tree-sitter 的 MISSING token 名，ASCII）→ 作者要照着补的那个人话名。**
 *
 * 这是"缺的是什么结构"的**唯一映射表**：以后语法加族，只在这张表里补一行，文案与测试
 * 都跟着走——不许在 `syntaxFaultMessage` 的各分支里再写死一个词（那会让同一件事有两处
 * 口径，加族时必漏一处）。
 *
 * 两种登记方式，按记号的性质选：
 * - **显式收束词的族**（`循环` / `出错处理` / `数据表`）给词表的 **KeywordId**：中文写形
 *   （作者要照着补的那几个字）只能从 `@kojo/plugin-kojo-sugar` 的词表派生
 *   （`SUGAR_LEXICON_WORDS`），抄一份进 monaco 层就是第二张投影表——被
 *   `tests/kojo-lexicon-single-source.test.ts` 当场拦住（词形一改，屏上文案与真实写形就
 *   分叉，正是"写得出来读不回来"那类事故）。
 * - **没有中文关键字写形的记号**（台词串的 `speech_close` 就是右引号本身）给 `text`：
 *   它本来就不是词表里的词，不适用上面那条单源纪律。
 *
 * 表外的记号名 ⇒ `missingStructureName()` 回 null，文案退回"它的收束词"，**不编**一个
 * 看起来像的词（`some_new_end` 不会变成"某个新结束"）。
 */
type MissingStructureName = { readonly keywordId: SugarLexiconWord['id'] } | { readonly text: string };

export const MISSING_STRUCTURE_NAMES: Readonly<Record<string, MissingStructureName>> = {
  loop_end: { keywordId: 'block.loopEnd' },
  catch_end: { keywordId: 'block.catchEnd' },
  data_end: { keywordId: 'block.dataTableEnd' },
  // 台词串的收束记号就是右引号：`MISSING:speech_close` 是"这里少了一个」"，不是少一条关键字
  speech_close: { text: '台词右引号' },
};

/** 记号名 → 人话名（null = 表外，不编词） */
export function missingStructureName(expectedToken: string | undefined): string | null {
  if (!expectedToken) return null;
  // 记号名来自 worker 回话（不可信输入）：只认自有的键，别让 `constructor` / `__proto__`
  // 这类名字从原型链上摸到一个"看起来存在"的条目
  if (!Object.hasOwn(MISSING_STRUCTURE_NAMES, expectedToken)) return null;
  const name = MISSING_STRUCTURE_NAMES[expectedToken]!;
  if ('text' in name) return name.text;
  return SUGAR_LEXICON_WORDS.find((w) => w.id === name.keywordId && w.primary)?.word ?? null;
}

/**
 * 收束记号名 → 中文写形（**只认块收束词那一族**；表外的记号回 null）。
 * 与 {@link missingStructureName} 共用同一张表：这里只是把"不是收束词"的记号（台词右引号）
 * 排除掉，免得 `unclosed-block` 文案把一句台词缺的引号说成"块没有收盘"。
 */
export function closeWord(expectedToken: string | undefined): string | null {
  if (!expectedToken || !Object.hasOwn(MISSING_STRUCTURE_NAMES, expectedToken)) return null;
  const name = MISSING_STRUCTURE_NAMES[expectedToken]!;
  return 'keywordId' in name ? missingStructureName(expectedToken) : null;
}

/** 块头文本 → 那一族的字（`循环：` → `循环`、`时机 指令 900：` → `时机`） */
export function blockHeadWord(headText: string | undefined): string | null {
  if (!headText) return null;
  const trimmed = headText.trim();
  if (trimmed === '') return null;
  const cut = trimmed.search(/[：:]/);
  const head = (cut >= 0 ? trimmed.slice(0, cut) : trimmed).trim();
  const firstWord = head.split(/\s+/)[0] ?? '';
  return firstWord === '' ? null : firstWord;
}

/** 一条残缺文案要用的上下文（行号 1 基；缺的人话名可能为 null = 表外记号） */
interface FaultMessageContext {
  /** 作者该看的那一行（块头 / 开引号那一行） */
  readonly line: number;
  /** 缺口实际所在的行（MISSING 插入点 / ERROR 末行） */
  readonly faultLine: number;
  /** 块头族名（`循环` / `出错处理` / `时机`；认不出 = null） */
  readonly blockWord: string | null;
  /** 缺的结构的人话名（见 {@link MISSING_STRUCTURE_NAMES}；表外 = null） */
  readonly missing: string | null;
}

/**
 * **类别 → 文案**的唯一映射（`Record` 而不是 `switch`：`KojoStructureSyntaxKind` 加一类
 * 时这里少一条就是编译期红，不会悄悄回落到一句"读不通"）。
 */
const FAULT_MESSAGE_BUILDERS: Readonly<Record<KojoStructureSyntaxKind, (ctx: FaultMessageContext) => string>> = {
  'unclosed-block': ({ line, faultLine, blockWord, missing }) => {
    const opened = blockWord ? `第 ${line} 行的「${blockWord}」块` : `第 ${line} 行的块`;
    if (missing) {
      return `${opened}没有等到「${missing}」——它一直开到第 ${faultLine} 行；请在收回缩进的那一行补写「${missing}」。`;
    }
    return `${opened}没有等到它的收束词——它一直开到第 ${faultLine} 行；请把这一族该有的收束语句补上。`;
  },
  'unterminated-string': ({ line, missing }) => {
    // 表外的记号也把"缺的是右引号"说出来：这是这一类的定义，不是猜某个新词
    const name = missing ?? '台词右引号';
    return `第 ${line} 行的这句台词开了「，到行尾还没等到「${name}」——请补上它，或在行尾用「续」把这一句接到下一行。`;
  },
  'unterminated-interp': ({ line }) =>
    `第 ${line} 行的插值开了 {，到行尾还没等到 }——插值要写在同一行内，左右花括号都得有。`,
  'unexpected-token': ({ line }) =>
    `第 ${line} 行有结构解析读不通的内容——请检查这一行（以及它的上一行）是否缺了收束词、右引号或右花括号。`,
};

/** 一处残缺 → 作者看得见的那句话（行号 1 基；文案里必须带位置与"期望什么"） */
export function syntaxFaultMessage(fault: KojoStructureSyntaxFault): string {
  return FAULT_MESSAGE_BUILDERS[fault.kind]({
    line: fault.row + 1,
    faultLine: fault.faultRow + 1,
    blockWord: blockHeadWord(fault.blockHeadText),
    missing: missingStructureName(fault.expectedToken),
  });
}

/* ------------------------------ 纯判据（可单测） ------------------------------ */

/**
 * 残缺事实 → 行级装饰（**不做去重**，去重是下一步；两步分开各钉一条测试）。
 *
 * 列口径转换在这里完成一次：`types.ts` 那一侧全是 0 基、`endColumn` 排他，
 * `LineDecoration` 这一侧全是 1 基、终点不含（越界由 `decorationsToMarkers` 夹住）。
 * 落点行按 `row`（残缺事实自己已经选好：块头行 / 出错行），一处一行 ⇒ 同行多处残缺
 * 会被折叠成一条（同一行两条红波浪线读起来就是一条，还多算一次）。
 */
export function syntaxFaultDecorations(faults: readonly KojoStructureSyntaxFault[]): LineDecoration[] {
  const byLine = new Map<number, LineDecoration>();
  for (const fault of faults) {
    if (!Number.isFinite(fault.row) || fault.row < 0) continue;
    const line = fault.row + 1;
    if (byLine.has(line)) continue;
    byLine.set(line, {
      line,
      severity: 'error',
      message: syntaxFaultMessage(fault),
      code: syntaxErrorCode(fault.kind),
      source: STRUCTURE_SYNTAX_SOURCE,
      startColumn: Math.max(1, fault.column + 1),
      endColumn: Math.max(fault.column + 2, fault.endColumn + 1),
    });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * 装饰通道在那一行已经说过话吗（error 级 ⇒ 说过；warning 不顶掉结构残缺）。
 *
 * `startColumn` / `endColumn`（1 基、末端排他）是 additive 的可选区间：装饰通道的
 * marker 自带列，能给就精确到区间；缺省 = **整行**（旧口径：只说"这一行有错"）。
 */
export interface OccupiedLine {
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly startColumn?: number;
  readonly endColumn?: number;
}

/** 两条区间是否相交（缺列 = 整行；零宽/倒挂的列区间同样按整行算，宁多算不少算） */
function rangesOverlap(decoration: LineDecoration, occupied: OccupiedLine): boolean {
  if (decoration.line !== occupied.line) return false;
  const startOf = (start: number | undefined): number => (start !== undefined && Number.isFinite(start) ? start : 1);
  const endOf = (start: number, end: number | undefined): number => {
    if (end === undefined || !Number.isFinite(end) || end <= start) return Number.POSITIVE_INFINITY;
    return end;
  };
  const aStart = startOf(decoration.startColumn);
  const bStart = startOf(occupied.startColumn);
  return Math.max(aStart, bStart) < Math.min(endOf(aStart, decoration.endColumn), endOf(bStart, occupied.endColumn));
}

/**
 * **不重复计数**的那一步：**同一行、同一严重级（error）、列区间相交**的装饰通道条目
 * ⇒ 我们这一条不画。
 *
 * 为什么保留装饰通道（转译器 / 插件）那一条：它是这份源**语义判定的最近邻**——诊断由
 * 转译器自己算出来，列区间也是它给的；结构层是语法树上的第二意见（作者开着结构层才有），
 * 同一区间同一严重级时退让，避免同一个问题在眼前数两遍。
 *
 * 为什么不再"整行连坐"：同一行可以并排站着**不同**的问题（左边一个全角标点、右边一个
 * 没收盘的块）。只看行号会把后者的红线也吞掉——那不是去重，是漏报。区间不相交 ⇒ 各说
 * 各事；缺列（插件只说"这一行有错"）⇒ 仍按整行算，旧行为不退化。
 *
 * 反向也成立且不亏：我们退让的那一段，面板与波浪线都有人负责。
 */
export function dropLinesAlreadyErrored(
  decorations: readonly LineDecoration[],
  occupied: readonly OccupiedLine[],
): LineDecoration[] {
  if (decorations.length === 0 || occupied.length === 0) return [...decorations];
  const taken = occupied.filter((item) => item.severity === 'error');
  if (taken.length === 0) return [...decorations];
  return decorations.filter((decoration) => !taken.some((item) => rangesOverlap(decoration, item)));
}

/** 一份 markers 的可比签名（用于"重算没变就不再发第二次"——防 onDidChangeMarkers 自激） */
function markerSignature(markers: readonly Monaco.editor.IMarkerData[]): string {
  return markers
    .map((m) => `${m.startLineNumber}:${m.startColumn}-${m.endColumn}:${m.message}`)
    .sort()
    .join('\u0001');
}

/* -------------------------------- 上屏执行 -------------------------------- */

export interface StructureSyntaxPresenter {
  /** 结构残缺到货：算好装饰、去过重、换成 markers、挂上去 */
  show(model: Monaco.editor.ITextModel, faults: readonly KojoStructureSyntaxFault[], truncated: boolean): void;
  /** 这一面撤下（关文件 / 换轨 / 停用）：该 model 清空，别的 model 不动 */
  clear(model: Monaco.editor.ITextModel): void;
  /** 整体撤下（关掉开关 / 整档停用）：每个挂过的 model 都清成空 */
  clearAll(): void;
  /** 撤监听 + 清 owner（叠层退场时唯一的收尾动作） */
  dispose(): void;
}

/**
 * 派生预览 model（`EditorPane.applySugarView` 建的 `inmemory://sugar/<组>/<路径>`）。
 *
 * 预览是**只读投影**：结构层仍为它提供着色 / 折叠（语言 id 同为 `kojo-sugar`），但
 * **结构残缺不能画在派生文本上**——投影的一处不完美会变成“正常 ERB 文件报错”，
 * 这正是用户报告的那类假阳性。诊断属于源文件 model（装饰通道与结构层都按源文件路径发布）。
 */
function isDerivedPreviewModel(model: Monaco.editor.ITextModel): boolean {
  const uri = model.uri;
  return uri.scheme === 'inmemory' && uri.authority === 'sugar';
}

/**
 * 建一个上屏器（`providers.ts` 在 `activate()` 里建、`deactivate()` 里 `dispose()`）。
 *
 * 只碰三件 Monaco API：`getModelMarkers`（读装饰通道那一路）、`setModelMarkers`
 * （写自己那一路）、`onDidChangeMarkers`（那一路刷新后按同判据重算）。
 */
export function createStructureSyntaxPresenter(monaco: typeof Monaco): StructureSyntaxPresenter {
  /** 挂过的 model → 最近一次的残缺（marker 变化事件据此知道要重算哪几份） */
  const tracked = new Map<Monaco.editor.ITextModel, readonly KojoStructureSyntaxFault[]>();
  /** model → 上一次发出去的 markers 签名（同签名不再发第二次 ⇒ 不自激） */
  const lastSignature = new Map<Monaco.editor.ITextModel, string>();

  const occupiedLines = (model: Monaco.editor.ITextModel): OccupiedLine[] => {
    const markers = monaco.editor.getModelMarkers({ owner: DECORATOR_MARKER_OWNER, resource: model.uri });
    return markers.map((m) => ({
      line: m.startLineNumber,
      severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
      // marker 自带 1 基列区间（末端排他）；整行 marker 由 decorationsToMarkers 填成 [1, 行尾+1]
      startColumn: m.startColumn,
      endColumn: m.endColumn,
    }));
  };

  const applyTo = (model: Monaco.editor.ITextModel): void => {
    if (model.isDisposed()) return;
    const faults = tracked.get(model);
    if (faults === undefined) return;
    const decorations = dropLinesAlreadyErrored(syntaxFaultDecorations(faults), occupiedLines(model));
    const markers = decorationsToMarkers(monaco, model, decorations);
    const signature = markerSignature(markers);
    if (lastSignature.get(model) === signature) return; // 没变 ⇒ 一个字都不重发（防自激循环）
    lastSignature.set(model, signature);
    monaco.editor.setModelMarkers(model, STRUCTURE_SYNTAX_OWNER, markers);
  };

  const listener = monaco.editor.onDidChangeMarkers((resources) => {
    // 只有"我们盯着的那几份 model"被动过才重算（装饰通道每敲一次键都会刷一次）
    for (const resource of resources) {
      for (const model of [...tracked.keys()]) {
        if (!model.isDisposed() && model.uri.toString() === resource.toString()) applyTo(model);
      }
    }
  });

  return {
    show(model, faults, truncated) {
      if (model.isDisposed() || model.getLanguageId() !== KOJO_LANGUAGE_ID) return;
      if (isDerivedPreviewModel(model)) return; // 派生投影不吃结构诊断（见 isDerivedPreviewModel）
      tracked.set(model, faults);
      if (truncated) {
        reportStructureDegradation({
          capability: 'syntax',
          stage: 'parse',
          message: `一文档的结构残缺超过 ${KOJO_STRUCTURE_MAX_SYNTAX_FAULTS} 处 ⇒ 只标最前 ${KOJO_STRUCTURE_MAX_SYNTAX_FAULTS} 处（再多就是把编辑器变成装饰刷）`,
        });
      }
      applyTo(model);
    },
    clear(model) {
      if (!tracked.delete(model)) return;
      lastSignature.delete(model);
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, STRUCTURE_SYNTAX_OWNER, []);
    },
    clearAll() {
      for (const model of [...tracked.keys()]) this.clear(model);
    },
    dispose() {
      listener.dispose();
      for (const model of [...tracked.keys()]) {
        if (!model.isDisposed()) monaco.editor.setModelMarkers(model, STRUCTURE_SYNTAX_OWNER, []);
      }
      tracked.clear();
      lastSignature.clear();
    },
  };
}
