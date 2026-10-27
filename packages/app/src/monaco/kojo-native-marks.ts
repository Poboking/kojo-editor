import { ERB_SKIP_MARKERS } from '@kojo/plugin-api';
import {
  ERB_DECLARATION_DIRECTIVES,
  ERB_DIRECTIVES,
  ERB_PREPROC_MARKERS,
} from './erb-directives';

/**
 * `.kojo1` 糖区的**原生标记位**（v1.9 P2 补全面）。
 *
 * 写成完整行之前，`#` / `[` / 行首大写指令都还落在 `text`（台词）行类里，
 * 各 source 的位置判据全部落空 ⇒ 作者敲 `#` 看不到 `#DIM`，敲 `[` 看不到 `[IF]`。
 * 本模块只做三件事（纯函数，零 Monaco 依赖）：
 *
 * 1. 认**位置**：`#` 起手 / `[` 起手 / 行首大写指令前缀；
 * 2. 给**替换区间**：必须**含**起手字符（Monaco 的 `getWordUntilPosition` 不含 `#` / `[`，
 *    照它替换会插出 `##DIM` / `[[IF]`）；
 * 3. 给候选：词表全部来自 `erb-directives.ts`（补全侧唯一真源），不在此手抄词形。
 */

export type KojoNativeMarkSlot = 'declaration' | 'preproc' | 'statement';

export interface KojoNativeMarkCandidate {
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
}

const BLANKS = '[ \\t\\u3000]*';
/** `#` + 正在输入的字（其余一律空白） */
const DECL_PREFIX = new RegExp(`^${BLANKS}#[A-Za-z0-9_]*$`);
/** `[` + 正在输入的字（`[[` 属性名位因此天然不命中：第二个 `[` 不在字符集里） */
const PREPROC_PREFIX = new RegExp(`^${BLANKS}\\[[A-Za-z0-9_]*$`);
/** 行首大写原生指令（完整行时已由词法判成 rawLine，这里接住"写完整之前"的那一瞬） */
const STATEMENT_PREFIX = new RegExp(`^${BLANKS}[A-Z][A-Z0-9_]*$`);

/** 光标是否落在某个原生标记位；`col0` = 0 基列 */
export function kojoNativeMarkSlotAt(line: string, col0: number): KojoNativeMarkSlot | null {
  if (!Number.isFinite(col0) || col0 < 0) return null;
  const before = line.slice(0, Math.min(col0, line.length));
  if (DECL_PREFIX.test(before)) return 'declaration';
  if (PREPROC_PREFIX.test(before)) return 'preproc';
  if (STATEMENT_PREFIX.test(before)) return 'statement';
  return null;
}

/**
 * 该位置的替换区间（1 基列，左含右不含）：起点必须回到 `#` / `[` / 词首。
 * 传进来的 `col0` 已被调用点夹进线内。
 */
export function kojoNativeMarkRange(
  line: string,
  col0: number,
): { startColumn: number; endColumn: number } {
  let start = Math.min(Math.max(col0, 0), line.length);
  if (start === 0 || line[start] === '#' || line[start] === '[') {
    // 光标恰在起手字符上：替换从该字符起（含它）
  } else {
    while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1]!)) start--;
    // 词首紧跟在 `#` / `[` 之后 ⇒ 一起替换，否则插出 `##DIM` / `[[IF]`
    if (start > 0 && (line[start - 1] === '#' || line[start - 1] === '[')) start--;
  }
  return { startColumn: start + 1, endColumn: Math.min(col0, line.length) + 1 };
}

const DECLARATION_CANDIDATES: readonly KojoNativeMarkCandidate[] = ERB_DECLARATION_DIRECTIVES.map(
  (word) => ({
    label: `#${word}`,
    insertText: `#${word}`,
    detail: 'ERB 声明族（原生直通，不拆中文写形）',
  }),
);

const PREPROC_CANDIDATES: readonly KojoNativeMarkCandidate[] = [
  ...ERB_PREPROC_MARKERS,
  ERB_SKIP_MARKERS.start,
  ERB_SKIP_MARKERS.end,
].map((mark) => ({
  label: mark,
  insertText: mark,
  detail: '整行标记（引擎按整行严格等值识别）',
}));

const STATEMENT_CANDIDATES: readonly KojoNativeMarkCandidate[] = ERB_DIRECTIVES.map((word) => ({
  label: word,
  insertText: word,
  detail: 'ERB 语句（原生直通）',
}));

/** 位置 → 候选清单（模块级一次构建） */
export function kojoNativeMarkCandidates(
  slot: KojoNativeMarkSlot,
): readonly KojoNativeMarkCandidate[] {
  switch (slot) {
    case 'declaration':
      return DECLARATION_CANDIDATES;
    case 'preproc':
      return PREPROC_CANDIDATES;
    case 'statement':
      return STATEMENT_CANDIDATES;
  }
}
