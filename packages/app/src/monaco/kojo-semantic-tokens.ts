import type * as Monaco from './entry';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSemanticTokenModifier,
  EditorSemanticTokenSpan,
  EditorSemanticTokenType,
} from '@kojo/plugin-api';
import {errorText,  EDITOR_SEMANTIC_TOKEN_MODIFIERS, EDITOR_SEMANTIC_TOKEN_TYPES } from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';
import { HUGE_FILE_LINES } from '../ui/editor-options';

/**
 * 结构化着色的**宿主接线**（B6，2026-10-16 结构化着色批）。
 *
 * ## 分层（与 `kojo-folding` / `kojo-symbols` 逐字同款）
 *
 * 判据全在插件：`@` 是不是定义、`CALL` 后面那个名字是不是本项目有的函数、`函数 X(…)`
 * 里的 `X` 声明在几列——这些是 ERB / 糖的结构事实，宿主**一个都不认识**。
 * 宿主只干四件事：**legend 归一 → 区间整理 → delta 编码 → 注册 provider**。
 * （`pnpm audit:decoupling` 的 A 项把本目录收进射程不是装饰：这里出现一个 `CFLAG`
 * 或 `时机`，铁律 1 就破了。）
 *
 * ## 词法 vs 语义的分工（本文件的契约，不是建议）
 *
 * Monaco 的合并规则是**覆盖区间上语义 token 优先**（`standaloneThemeService` 用
 * `[type, ...modifiers].join('.')` 去匹配主题规则，命中的那条直接顶掉 Monarch 给同一
 * 区间的样式）。所以：
 *
 * - **词法归 Monarch**（`erb-language.ts` / `kojo-language.ts`）：关键字、字符串、数字、
 *   注释、变量族多段引用——凡"看形状就能判"的；
 * - **结构归这里**：定义 vs 调用、形参槽、声明出的名字——凡"只有解析器/字典知道角色"的。
 *
 * 贡献方交出的每个 span 都必须落在第二类。**重画词法已经着色的区间 = 造第二真相源**：
 * 同一个名字今天吃词法色、明天吃语义色，漂移没有任何判据能拦住。这条边界写进了两个
 * 贡献方的头注（`erb-parser/src/semantic-tokens.ts`、`kojo-sugar/src/semantic-tokens.ts`），
 * 三处同文，改一处就要改三处——这是有意的摩擦。
 *
 * ## legend 单一真源在本文件
 *
 * 词表的**名字**住在契约（`EDITOR_SEMANTIC_TOKEN_TYPES` / `..._MODIFIERS`，否则贡献方
 * 无法类型标注）；**legend 本身**（实际交给 Monaco 的那两份数组，以及哪些类别真有颜色）
 * 归宿主：主题规则在叶子 `kojo-theme-rules.ts`（本文件按同对象 re-export），合并进
 * `kojo-dark`。
 * 贡献方给出 legend 里没有的名字 ⇒ 该 span **不着色**，并且 `console.warn` 一次
 * （铁律 4：退化可见；静默丢色会被当成"插件没生效"猜半天）。
 */

/** 交给 Monaco 的 legend（下标即 delta 数据里的类型序号；顺序 = 契约词表顺序，不许本地重排） */
export const KOJO_SEMANTIC_TOKEN_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: [...EDITOR_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...EDITOR_SEMANTIC_TOKEN_MODIFIERS],
};

/**
 * `kojo-dark` 里语义类别的主题规则。
 *
 * **定义处已下沉**零 import 叶子 `kojo-theme-rules.ts`（PS-10 断链：本文件经
 * `register-dialects → kojo-language` 拖着 `@kojo/plugin-kojo-sugar`，而 `theme.ts`
 * 在开机静态图里）。此处按**同一数组本体** re-export（`monaco-theme.test.ts` 等既有
 * import 点读到的对象不变，别复制第二份）。
 *
 * token 名就是 `type.modifier…` 那条点分串（standalone 主题服务原文这么匹配），
 * 所以 `function.declaration` 比 `function` 更具体 = 定义点与调用点两种色。
 * 取色一律**复用既有词法色**（蓝 = 函数、黄 = 声明、橙 = 数/参数位），不引入新配色：
 * 作者看到的应当是"同一类东西同一个色"，而不是"新机制带来第七种蓝"。
 */
export { KOJO_SEMANTIC_THEME_RULES } from '@kojo/kojo-lang/theme-rules';

/** 类别名 → legend 下标；`-1` = legend 里没有（不着色 + 一次性告警） */
const TYPE_INDEX = new Map<string, number>(EDITOR_SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i]));
const MODIFIER_BITS = new Map<string, number>(EDITOR_SEMANTIC_TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));
const warnedUnknown = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(`[kojo-semantic-tokens] ${message}`);
}

/**
 * 类别名 → 类型序号；未知名字 → `-1` 并告警（**不猜**：legend 之外就没有颜色，
 * 而不是挑个"最像的"类别凑数）。
 */
export function semanticTokenTypeIndex(tokenType: EditorSemanticTokenType): number {
  const at = TYPE_INDEX.get(tokenType);
  if (at !== undefined) return at;
  warnOnce(
    `type:${tokenType}`,
    `类别 "${tokenType}" 不在宿主 legend（${EDITOR_SEMANTIC_TOKEN_TYPES.join('/')}）里 ⇒ 该类 span 不着色；` +
      '要么给契约词表补这一类并在主题里给它颜色，要么删掉这条产出',
  );
  return -1;
}

/** 修饰名 → 位掩码；未知名字同样告警并**丢掉这个修饰**（类别本身照旧着色） */
export function semanticTokenModifierBits(modifiers: readonly EditorSemanticTokenModifier[] | undefined): number {
  let bits = 0;
  for (const modifier of modifiers ?? []) {
    const bit = MODIFIER_BITS.get(modifier);
    if (bit === undefined) {
      warnOnce(
        `modifier:${modifier}`,
        `修饰 "${modifier}" 不在宿主 legend（${EDITOR_SEMANTIC_TOKEN_MODIFIERS.join('/')}）里 ⇒ 该修饰被丢掉`,
      );
      continue;
    }
    bits |= bit;
  }
  return bits;
}

/**
 * 合并全部贡献方的着色 span（隔离与去重口径同 `collectFoldingRanges`：
 * 单枚贡献抛错不许让整篇着色消失——着色是只读呈现面，少一家只是少一层颜色）。
 *
 * 三态照旧：`undefined` = 不认这个文件；空数组 = 认但无可着色 span。
 */
export function collectSemanticTokenSpans(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorSemanticTokenSpan[] {
  const out: EditorSemanticTokenSpan[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-semantic-tokens] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'semanticToken') continue;
    for (const span of result.spans) {
      const key = `${span.line}\u0000${span.startColumn}\u0000${span.endColumn}\u0000${span.tokenType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(span);
    }
  }
  return out;
}

/** 一次整理的产物：可编码的区间 + 被丢掉的条数（丢多少要能报出去，不许静默） */
export interface NormalizedSemanticSpans {
  readonly spans: readonly EditorSemanticTokenSpan[];
  /** 行号不在模型里（陈旧/越界）而被丢掉的条数 */
  readonly droppedLines: number;
  /** 列区间塌成空（夹完 `end <= start`）而被丢掉的条数 */
  readonly droppedEmpty: number;
}

/** 模型几何（与 `reveal-position.ts` 的 `RevealGeometry` 同一条口径，由调用方从 model 现取） */
export interface SemanticGeometry {
  readonly lineCount: number;
  /** 该行最后一个合法列（Monaco `getLineMaxColumn` = 行长度 + 1） */
  maxColumn(lineNumber: number): number;
}

/**
 * 越界处理：**列夹取、行丢弃**——这里与 `clampRevealPosition` 有意不对称，理由是
 * 两种"夹"的代价不同。
 *
 * - 列：贡献方给的列可能超过行长（同一串文本，插件按 `length` 算、Monaco 按 UTF-16
 *   码元算，代理对一进来就差一格）。夹到 `[1, maxColumn]` 仍画在**正确的那一行**上，
 *   只是少画一格 ⇒ 安全。
 * - 行：行号越界只可能是**陈旧数据**（贡献方看的是另一份文本）。把 3000 行夹到 12 行
 *   等于在第 12 行画一根不相干的下划线——错位置比没位置危险得多，所以直接丢，
 *   并把丢掉了几条**报出去**（`encodeSemanticTokens` 的告警；铁律 4 不静默）。
 */
export function normalizeSemanticSpans(spans: readonly EditorSemanticTokenSpan[], geometry: SemanticGeometry): NormalizedSemanticSpans {
  const out: EditorSemanticTokenSpan[] = [];
  let droppedLines = 0;
  let droppedEmpty = 0;
  for (const span of spans) {
    if (!Number.isFinite(span.line) || span.line < 1 || span.line > geometry.lineCount) {
      droppedLines++;
      continue;
    }
    const line = Math.trunc(span.line);
    const cap = geometry.maxColumn(line);
    const startColumn = Math.min(Math.max(1, Math.trunc(span.startColumn) || 1), cap);
    const endColumn = Math.min(Math.max(startColumn, Math.trunc(span.endColumn) || startColumn), cap);
    if (endColumn <= startColumn) {
      droppedEmpty++;
      continue;
    }
    out.push({ line, startColumn, endColumn, tokenType: span.tokenType, ...(span.modifiers ? { modifiers: span.modifiers } : {}) });
  }
  return { spans: out, droppedLines, droppedEmpty };
}

/**
 * 区间 → Monaco `SemanticTokens.data`（每 token 五个 `uint32`：
 * `deltaLine`、`deltaStart`、`length`、`tokenType`、`tokenModifiers`）。
 *
 * 三条编码纪律（错一条 Monaco 就把整篇颜色画歪，而且歪得看不出原因）：
 * 1. **必须按 (行, 起始列) 升序**——`deltaLine` 是相对上一个 token 的行差，`deltaStart`
 *    是**同行时**相对上一个 token 起始列的差（换行则取绝对列），倒序 = 负增量；
 * 2. **同行不得重叠**：Monaco 按到达顺序覆盖，重叠区画给后到的那条。这里判定为冲突并
 *    **保留先到的**（`collectSemanticTokenSpans` 的去重键已含类别，同名同区间的重复
 *    直接合掉；同类别不同区间的重叠说明两枚贡献方口径打架，丢后者并告警）；
 * 3. 长度为 0 的区间不进数据（编码上 `length` 是 token 宽度，0 宽 = 无意义）。
 *
 * ## 基数是 0，不是 1（2026-10-26 坐标错位批）
 *
 * 本函数吃的是**模型坐标**（1 基行、1 基 UTF-16 码元列，契约 `slots.ts` 原文），但
 * `SemanticTokens.data` 的协议口径是 **0 基**：Monaco 0.57 的解码器
 * （`esm/vs/editor/common/services/semanticTokensProviderStyling.js` 的
 * `toMultilineTokens2`）从 `lastLineNumber = 1` / `lastStartCharacter = 0` 起算，
 * `lineNumber = lastLineNumber + deltaLine`、`startCharacter = deltaLine === 0 ?
 * lastStartCharacter + deltaCharacter : deltaCharacter`。所以：
 *
 * - **绝对**分量必须减一：首 token 与每个换行后的 token 写 `line - 1`、`startColumn - 1`；
 * - **同行增量**是两点之差，与基数无关，照旧 `startColumn - previousStart`（两者同基）。
 *
 * 旧版把 1 基值原样写进去，真机症状（调试宿、同一 ERB、只翻结构解析器）：第 11 行
 * `IF LOCAL` 的结构色整体落到第 10 行、并从第 2 列起——下游 `tests/` 里自写的解码器
 * 也从 `line = 0` 起算，两边一起错，闸一直是绿的。**闸只认真 Monaco 解码器**，
 * 见 `tests/helpers/monaco-semantic-decode.ts`。
 *
 * 空输入返回**长度 0 的数组**（= "认这个文件，但整篇没有要着色的名字"）。
 */
export function encodeSemanticTokens(spans: readonly EditorSemanticTokenSpan[]): Uint32Array {
  const sorted = [...spans].sort(
    (a, b) => a.line - b.line || a.startColumn - b.startColumn || b.endColumn - a.endColumn,
  );
  const data = new Uint32Array(sorted.length * 5);
  let written = 0;
  let previousLine = 0;
  let previousStart = 0;
  let lastEndOnLine = 0;
  let skippedOverlaps = 0;
  for (const span of sorted) {
    const length = span.endColumn - span.startColumn;
    if (length <= 0) continue;
    const typeIndex = semanticTokenTypeIndex(span.tokenType);
    if (typeIndex < 0) continue; // legend 之外 ⇒ 不着色（已经告过一次）
    if (span.line === previousLine && span.startColumn < lastEndOnLine) {
      skippedOverlaps++;
      continue; // 与已写入的同行区间重叠：保留先到的，丢后者
    }
    const sameLine = span.line === previousLine && written > 0;
    // 绝对分量必须 0 基（见头注）；同行增量与基无关，用 1 基相减即可。
    const deltaLine = written === 0 ? span.line - 1 : span.line - previousLine;
    const deltaStart = sameLine ? span.startColumn - previousStart : span.startColumn - 1;
    data[written * 5] = deltaLine;
    data[written * 5 + 1] = deltaStart;
    data[written * 5 + 2] = length;
    data[written * 5 + 3] = typeIndex;
    data[written * 5 + 4] = semanticTokenModifierBits(span.modifiers);
    written++;
    previousLine = span.line;
    previousStart = span.startColumn;
    lastEndOnLine = span.endColumn;
  }
  if (skippedOverlaps > 0) {
    warnOnce(
      `overlap:${skippedOverlaps}`,
      `${skippedOverlaps} 条着色区间与先到的重叠 ⇒ 保留先到的（词法与结构的分工被越界了，检查贡献方是否在重画同一 span）`,
    );
  }
  return written === sorted.length ? data : data.slice(0, written * 5);
}

/** 一次整篇着色 = 三条贡献方各一遍单遍扫描 + 排序 + 编码，全压在**主线程**上。
 *  阈值 2026-10-28 从 5,000（照 Monaco 全文特性抄）抬到 50,000：本供方只是一趟线性扫描，
 *  24,197 行实测 43.9 ms；169,247 行那份 435 ms + 16.8 万 span 仍留在闸外。 */
export const SEMANTIC_TOKEN_MAX_LINES = HUGE_FILE_LINES;

/** 该不该为这份文档算着色（**纯函数**，与 Monaco 无关） */
export function shouldComputeSemanticTokens(lineCount: number): boolean {
  return Number.isFinite(lineCount) && lineCount > 0 && lineCount <= SEMANTIC_TOKEN_MAX_LINES;
}

/** 宿主注入：怎么问（含糖视图 / 活动标签判据 + 三态合并）——与 `FoldingRangeHandlers` 同款 */
export interface SemanticTokenHandlers {
  resolve(model: Monaco.editor.ITextModel): EditorSemanticTokenSpan[];
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册语义 token provider。
 *
 * **注册与开关分离**：provider 常驻（注册两次很便宜），开关走 Monaco 自己的
 * `editor.semanticHighlighting.enabled`——standalone 的 `DocumentSemanticTokensFeature`
 * 监听那条配置项并在开/关时逐 model 挂卸着色器，所以设置页一翻就立即生效，
 * 不需要重开文件（见 `semantic-color-pref.ts` 的 `applySemanticColorPref`）。
 *
 * 抛错不许冒到 Monaco：着色是只读呈现面，出错就"没颜色"（并 warn 出去）。
 */
export function installSemanticTokensProvider(
  monaco: typeof Monaco,
  handlers: SemanticTokenHandlers,
): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentSemanticTokensProvider = {
    getLegend: () => KOJO_SEMANTIC_TOKEN_LEGEND,
    provideDocumentSemanticTokens(model) {
      let spans: EditorSemanticTokenSpan[];
      try {
        spans = handlers.resolve(model);
      } catch (e: unknown) {
        console.warn(`[kojo-semantic-tokens] resolve 抛错：${errorText(e)}`);
        return { data: new Uint32Array(0) };
      }
      const normalized = normalizeSemanticSpans(spans, {
        lineCount: model.getLineCount(),
        maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
      });
      if (normalized.droppedLines + normalized.droppedEmpty > 0) {
        console.warn(
          `[kojo-semantic-tokens] ${model.uri.toString()} 丢掉 ${normalized.droppedLines} 条越界行 / ` +
            `${normalized.droppedEmpty} 条空区间（陈旧或列口径不符）`,
          spans,
        );
      }
      return { data: encodeSemanticTokens(normalized.spans) };
    },
    releaseDocumentSemanticTokens: () => undefined,
  };
  return registerForLanguageServices(monaco, (m, id) =>
    m.languages.registerDocumentSemanticTokensProvider(id, provider),
  );
}
