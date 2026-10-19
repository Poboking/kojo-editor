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
 * ## 不重复计数（同一行只许一条红）
 *
 * 规则：**本行的转译器/装饰通道已经有 error 级 marker ⇒ 我们这一条不画**。
 * 判据取自 `monaco.editor.getModelMarkers({ owner: 装饰通道 owner, resource })` ——
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
 * 收束记号名（语法层的 token 名，ASCII）→ 词表的 **KeywordId**（也是 ASCII 标识）。
 *
 * **这里一个字都不抄中文词形**：中文写形（作者要照着补的那几个字）只能从
 * `@kojo/plugin-kojo-sugar` 的词表派生（`SUGAR_LEXICON_WORDS`），抄一份进 monaco 层就是
 * 第二张投影表——被 `tests/kojo-lexicon-single-source.test.ts` 当场拦住（词形一改，
 * 屏上文案与真实写形就分叉，正是"写得出来读不回来"那类事故）。
 *
 * 只此三枚：本 DSL 只有 `循环` / `出错处理` / `数据表` 三族登记了显式收束词，其余族靠回缩收盘
 * （语法包头注与 `packages/kojo-syntax-tree/tests/fixtures/broken-unclosed-block.kojo` 都写明了）。
 * 表外的记号名 ⇒ `closeWord()` 回 null，文案退回"没有等到它的收束词"，**不编**一个看起来像的词。
 */
const CLOSE_KEYWORD_ID: Readonly<Record<string, SugarLexiconWord['id']>> = {
  loop_end: 'block.loopEnd',
  catch_end: 'block.catchEnd',
  data_end: 'block.dataTableEnd',
};

/** 记号名 → 中文写形（查不到 = null；宁可少说一句，不造一个词） */
export function closeWord(expectedToken: string | undefined): string | null {
  if (!expectedToken) return null;
  const id = CLOSE_KEYWORD_ID[expectedToken];
  if (!id) return null;
  return SUGAR_LEXICON_WORDS.find((w) => w.id === id && w.primary)?.word ?? null;
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

/** 一处残缺 → 作者看得见的那句话（行号 1 基；文案里必须带位置与"期望什么"） */
export function syntaxFaultMessage(fault: KojoStructureSyntaxFault): string {
  const line = fault.row + 1;
  const faultLine = fault.faultRow + 1;
  switch (fault.kind) {
    case 'unclosed-block': {
      const word = blockHeadWord(fault.blockHeadText);
      const expected = closeWord(fault.expectedToken);
      const opened = word ? `第 ${line} 行的「${word}」块` : `第 ${line} 行的块`;
      if (expected) {
        return `${opened}没有等到「${expected}」——它一直开到第 ${faultLine} 行；请在收回缩进的那一行补写「${expected}」。`;
      }
      return `${opened}没有等到它的收束词——它一直开到第 ${faultLine} 行；请把这一族该有的收束语句补上。`;
    }
    case 'unterminated-string':
      return `第 ${line} 行的这句台词开了「，到行尾还没等到」——请补上右引号，或在行尾用「续」把这一句接到下一行。`;
    case 'unterminated-interp':
      return `第 ${line} 行的插值开了 {，到行尾还没等到 }——插值要写在同一行内，左右花括号都得有。`;
    case 'unexpected-token':
      return `第 ${line} 行有结构解析读不通的内容——请检查这一行（以及它的上一行）是否缺了收束词、右引号或右花括号。`;
  }
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

/** 装饰通道在那一行已经说过话吗（error 级 ⇒ 说过；warning 不顶掉结构残缺） */
export interface OccupiedLine {
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'info';
}

/**
 * **不重复计数**的那一步：同一行已有 error 级装饰（转译器或别的插件已经指出这一行）
 * ⇒ 我们这一条不画。
 *
 * 判据只看"那一行有没有一条 error 在那里"，不看码：两个来源对同一行的定位本来就等价于
 * 同一件事（作者眼前就是那一行红了），叠两条只会让他数两遍。
 * 反向也成立且不亏：我们不画的那一行，面板与波浪线都有人负责。
 */
export function dropLinesAlreadyErrored(
  decorations: readonly LineDecoration[],
  occupied: readonly OccupiedLine[],
): LineDecoration[] {
  if (decorations.length === 0 || occupied.length === 0) return [...decorations];
  const taken = new Set<number>();
  for (const item of occupied) if (item.severity === 'error') taken.add(item.line);
  if (taken.size === 0) return [...decorations];
  return decorations.filter((d) => !taken.has(d.line));
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
