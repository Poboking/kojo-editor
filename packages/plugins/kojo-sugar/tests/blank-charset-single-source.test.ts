/**
 * CHARSET-SS · 空白 / 缩进字符集的**单源闸**（2026-10-20）。
 *
 * ## 收口前：三处各自手写
 *
 * | # | 位置 | 行首缩进集 | 行尾去空白集 | 缩进折算 |
 * |---|---|---|---|---|
 * | 1 | `src/lexer.ts`（`splitLogicalLines` 的 `rawIndent`、`indentLevel`、`contentOf`） | `[ \t\u3000]` | **`\s+`**（JS 宽集：含 NBSP / `\v` / `\f` / `U+2003`…） | tab=1、全角=2 宽、`ceil(空格/4)` |
 * | 2 | `src/sugar-ident.ts`（`contentOf` / `trimTrailingSpace` / `indentLevelOf`） | `[ \t　]` | `[ \t　]+$`（窄集） | 同上（**第二份实现**） |
 * | 3 | `src/formatter.ts`（`isIndentChar` / `leadingIndent` / `isAllIndent`） | `' ' \|\| '\t' \|\| U+3000` | 无（格式化器不动行尾） | 不自算，用 `logical.indent` |
 *
 * ## 收口后：唯一真源 `src/blank-charset.ts`（`[ \t\u3000]`，NBSP 不是空白）
 *
 * 口径依据是仓库既有单源结论（`packages/app/src/monaco/kojo-completion-position.ts` 的
 * `BLANK_CLASS_STR` 与 `packages/app/tests/completion-blank-class.test.ts` 的
 * `isBlank('\u00a0') === false`），不是本批新立；真实语料 3,818 份 `.ERB` 零命中 NBSP。
 *
 * ## 对照表（同一批样例 · 改前 → 改后；**加粗** = 改前分叉、改后同判）
 *
 * | 样例 | 行分类（lexer `classifyLine`） | lexer `contentOf` | `sugar-ident.contentOf` | formatter erb / kojo |
 * |---|---|---|---|---|
 * | `''` | blank | `""` | `""` | 不动 / 不动 |
 * | `'\t甲'` | text | `甲` | `甲` | 不动 / 不动 |
 * | `'    甲'` | text | `甲` | `甲` | 不动 / 不动 |
 * | `'\u3000甲'` | text | `甲` | `甲` | `'  甲'` / 同（折 2 半角） |
 * | `'\u3000\u3000甲'` | text | `甲` | `甲` | `'    甲'` / 同 |
 * | `'\u00a0甲'` | text | `\u00a0甲` | `\u00a0甲` | 不动 / 不动 |
 * | `' \t\u3000甲'` | text | `甲` | `甲` | `' \t  甲'` / 同 |
 * | `'\u3000\t甲'` | text | `甲` | `甲` | `'  \t甲'` / 同 |
 * | `'甲\u3000'` | text | `甲` | `甲` | 不动 / 不动（不动行尾） |
 * | `'甲\u00a0'` | text | **`甲` → `甲\u00a0`** | `甲\u00a0` | 不动 / 不动 |
 * | `'甲 '` | text | `甲` | `甲` | 不动 / 不动 |
 * | `'甲\u2003'` | text | **`甲` → `甲\u2003`** | `甲\u2003` | 不动 / 不动 |
 * | `'\u3000'` | blank | `""` | `""` | 清空 / 清空 |
 * | `'\u00a0'` | **blank → text** | **`""` → `\u00a0`** | `\u00a0` | 不动 / **清空 → 不动** |
 * | `'\u2003'` | **blank → text** | **`""` → `\u2003`** | `\u2003` | 不动 / **清空 → 不动** |
 * | `'\t \u3000'` | blank | `""` | `""` | 清空 / 清空 |
 *
 * 缩进深度（lexer `LogicalLine.indent` ⇄ `sugar-ident.indentLevelOf`，改前改后**逐例相同**——
 * 折算算法本来一致，分叉只在"两份实现"这个事实上）：
 * `\t甲`=1、4 空格=1、`\u3000甲`=1、双全角=1、` \t\u3000甲`=2、`\u3000\t甲`=2、
 * `\t \u3000`=2、其余（含 NBSP / `U+2003` 开头）=0。
 *
 * ## 有意保留的差异（不是漏收口）
 *
 * - **formatter 不动行尾**：`甲\u3000` / `甲 ` / `甲\u00a0` 三种行尾格式化器一律原样——台词行尾的
 *   全角空格是要打印的字（见 `formatter.ts` 文件头"明确不做"）。行首与"整行是否空白"两列则与
 *   前两处同判；下表用"行尾 run 原样保留"逐例钉住这条。
 * - **formatter 的 `ERB_CANDIDATE_HEAD_RE`** 用 ECMA-262 `trim()` 宽集：它是块标记**预筛**，
 *   宽集只多放过、不可能认错，判据仍只在 `erbBodyStep`（见该常量注释）。
 * - 写回链路（`src/lift-apply.ts` 的 `leadOf` / `indentOf` / `isBlank`）已在
 *   W6-A 批收口到本模块：`isBlank(trim)` 的宽集同步收窄——NBSP / `U+2003` 独占行是**正文**，
 *   该批用 `lift-apply-blank-charset.test.ts` 钉住（真实 fixtures 零 NBSP，round-trip 不受影响）。
 */

import { describe, expect, it } from 'vitest';

import {
  BLANK_CHARS,
  indentLevelOf as sharedIndentLevelOf,
  isAllBlank,
  isBlankChar,
  leadingBlank,
  trimTrailingBlank,
} from '../src/blank-charset';
import {
  classifyLine,
  contentOf,
  splitLogicalLines,
  stripInlineComment,
  type LogicalLine,
} from '../src/lexer';
import {
  contentOf as identContentOf,
  indentLevelOf as identIndentLevelOf,
  trimTrailingSpace,
} from '../src/sugar-ident';
import { formatText } from '../src/formatter';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';

const FF = '\u3000'; // 全角空格 U+3000
const NBSP = '\u00a0'; // 不换行空格（**不是**空白）
const EM_SP = '\u2003'; // EM SPACE（**不是**空白）

interface Row {
  readonly name: string;
  readonly sample: string;
  /** 收口后的统一行分类（`blank` 以外都是"有内容"） */
  readonly blank: boolean;
  /** 收口后的统一内容（三处必须逐字相等） */
  readonly content: string;
  /** 收口后的统一缩进层级（两处必须相等） */
  readonly indent: number;
}

/** 对照表的机器可读版（与文件头表逐行对应；改前值见上表加粗项） */
const ROWS: readonly Row[] = [
  { name: '空串', sample: '', blank: true, content: '', indent: 0 },
  { name: 'TAB+甲', sample: '\t甲', blank: false, content: '甲', indent: 1 },
  { name: '4空格+甲', sample: '    甲', blank: false, content: '甲', indent: 1 },
  { name: '全角+甲', sample: `${FF}甲`, blank: false, content: '甲', indent: 1 },
  { name: '双全角+甲', sample: `${FF}${FF}甲`, blank: false, content: '甲', indent: 1 },
  { name: 'NBSP+甲', sample: `${NBSP}甲`, blank: false, content: `${NBSP}甲`, indent: 0 },
  { name: '混合空格TAB全角+甲', sample: ` \t${FF}甲`, blank: false, content: '甲', indent: 2 },
  { name: '全角TAB+甲', sample: `${FF}\t甲`, blank: false, content: '甲', indent: 2 },
  { name: '甲+行尾全角', sample: `甲${FF}`, blank: false, content: '甲', indent: 0 },
  { name: '甲+行尾NBSP', sample: `甲${NBSP}`, blank: false, content: `甲${NBSP}`, indent: 0 },
  { name: '甲+行尾空格', sample: '甲 ', blank: false, content: '甲', indent: 0 },
  { name: '甲+行尾U2003', sample: `甲${EM_SP}`, blank: false, content: `甲${EM_SP}`, indent: 0 },
  { name: '仅全角', sample: FF, blank: true, content: '', indent: 1 },
  { name: '仅NBSP', sample: NBSP, blank: false, content: NBSP, indent: 0 },
  { name: '仅U2003', sample: EM_SP, blank: false, content: EM_SP, indent: 0 },
  { name: '纯空白混合', sample: `\t ${FF}`, blank: true, content: '', indent: 2 },
];

const logicalOf = (sample: string): LogicalLine => splitLogicalLines(sample)[0]!;

/** 行尾空白 run（窄集；formatter 必须原样保留它） */
const trailingRun = (s: string): string => new RegExp(`[ \t${FF}]+$`).exec(s)?.[0] ?? '';

describe('真源自证（`blank-charset.ts` 是唯一一张表）', () => {
  it('字符集恰为：半角空格 / TAB / 全角空格 U+3000', () => {
    expect(BLANK_CHARS).toEqual([' ', '\t', FF]);
    expect(BLANK_CHARS).toHaveLength(3);
  });

  it('全角空格与契约层导出值逐字相等（blank-charset 为构建期裸 Node 链不 import 契约层，靠本闸钉住）', () => {
    expect(FF).toBe(FULLWIDTH_SPACE);
    expect(BLANK_CHARS).toContain(FULLWIDTH_SPACE);
  });

  it('`isBlankChar`：三枚真、NBSP / EM SPACE / 空串 / 多字符一律假', () => {
    for (const ch of BLANK_CHARS) expect(isBlankChar(ch)).toBe(true);
    for (const ch of [NBSP, EM_SP, '\v', '\f', '\u2028', '\r', '\n', '', '  ']) {
      expect(isBlankChar(ch), JSON.stringify(ch)).toBe(false);
    }
  });

  it('`leadingBlank` / `trimTrailingBlank` / `isAllBlank` / `indentLevelOf` 的边界', () => {
    expect(leadingBlank(` \t${FF}甲`)).toBe(` \t${FF}`);
    expect(leadingBlank(`${NBSP}甲`)).toBe(''); // NBSP 不是缩进
    expect(leadingBlank('')).toBe('');

    expect(trimTrailingBlank(`甲 \t${FF}`)).toBe('甲');
    expect(trimTrailingBlank(`甲${NBSP}`)).toBe(`甲${NBSP}`); // NBSP 是内容
    expect(trimTrailingBlank(`甲${EM_SP}`)).toBe(`甲${EM_SP}`);
    expect(trimTrailingBlank(` ${FF}`)).toBe('');

    expect(isAllBlank('')).toBe(true);
    expect(isAllBlank(` \t${FF}`)).toBe(true);
    expect(isAllBlank(NBSP)).toBe(false);
    expect(isAllBlank(` ${NBSP}`)).toBe(false);

    // 折算：TAB=1 级；全角=2 宽；空格每 4 个 1 级（余数进 1）
    expect(sharedIndentLevelOf('\t甲')).toBe(1);
    expect(sharedIndentLevelOf('    甲')).toBe(1);
    expect(sharedIndentLevelOf(`${FF}甲`)).toBe(1); // 2 宽 → ceil(2/4)=1
    expect(sharedIndentLevelOf(`${FF}${FF}甲`)).toBe(1); // 4 宽 → 1
    expect(sharedIndentLevelOf(` \t${FF}甲`)).toBe(2); // tab 1 + ceil(3/4)
    expect(sharedIndentLevelOf(`${NBSP}甲`)).toBe(0);
  });
});

describe('三处逐例同判（同一批样例 × 行分类 / 内容 / 缩进 / 格式化）', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const logical = logicalOf(row.sample);
    const cls = classifyLine(logical);

    // ① 行分类：lexer `classifyLine` ⇔ sugar-ident 的"内容为空" ⇔ formatter 的"整行空白"
    expect(cls.kind === 'blank', 'lexer 行分类').toBe(row.blank);
    expect(identContentOf(row.sample) === '', 'sugar-ident 内容为空').toBe(row.blank);
    expect(isAllBlank(row.sample), 'formatter 的空白判据').toBe(row.blank);

    // ② 去尾空白 / 内容：lexer `contentOf` 与 sugar-ident `contentOf` 逐字相等，且等于对照表
    expect(contentOf(logical), 'lexer contentOf').toBe(row.content);
    expect(identContentOf(row.sample), 'sugar-ident contentOf').toBe(row.content);
    expect(trimTrailingSpace(row.sample), 'sugar-ident trimTrailingSpace').toBe(
      trimTrailingBlank(row.sample),
    );

    // ③ 缩进深度：lexer `LogicalLine.indent` ⇔ sugar-ident `indentLevelOf`
    expect(logical.indent, 'lexer indent').toBe(row.indent);
    expect(identIndentLevelOf(row.sample), 'sugar-ident indentLevelOf').toBe(row.indent);
    expect(logical.rawIndent, 'lexer rawIndent').toBe(leadingBlank(row.sample));

    // ④ 格式化器的可见结果：空白行清空、非空白行不清空；行尾 run 一律原样（有意设计）
    for (const dialect of ['erb', 'kojo'] as const) {
      const out = formatText(row.sample, dialect).text;
      if (row.blank) {
        expect(out, `${dialect} 空白行清空`).toBe('');
      } else {
        expect(out, `${dialect} 非空白行不清空`).not.toBe('');
        expect(trailingRun(out), `${dialect} 不动行尾`).toBe(trailingRun(row.sample));
      }
    }
  });
});

describe('改前分叉的四个样例（回归钉）', () => {
  it('仅 NBSP 行：lexer 判 text（改前 blank）、格式化两个方言都不清空（改前 kojo 清空）', () => {
    const logical = logicalOf(NBSP);
    expect(classifyLine(logical).kind).toBe('text');
    expect(contentOf(logical)).toBe(NBSP);
    expect(identContentOf(NBSP)).toBe(NBSP);
    expect(formatText(NBSP, 'erb').text).toBe(NBSP);
    expect(formatText(NBSP, 'kojo').text).toBe(NBSP);
  });

  it('仅 EM SPACE 行：同一判据（NBSP 之外的其他 `\\s` 也不认）', () => {
    expect(classifyLine(logicalOf(EM_SP)).kind).toBe('text');
    expect(contentOf(logicalOf(EM_SP))).toBe(EM_SP);
    expect(formatText(EM_SP, 'erb').text).toBe(EM_SP);
    expect(formatText(EM_SP, 'kojo').text).toBe(EM_SP);
  });

  it('行尾 NBSP / EM SPACE 不再被 lexer 剥掉（改前 `contentOf` 的 `\\s+` 会剥）', () => {
    expect(contentOf(logicalOf(`甲${NBSP}`))).toBe(`甲${NBSP}`);
    expect(contentOf(logicalOf(`甲${EM_SP}`))).toBe(`甲${EM_SP}`);
    // 而三枚真源空白照旧剥
    expect(contentOf(logicalOf(`甲${FF}`))).toBe('甲');
    expect(contentOf(logicalOf('甲 '))).toBe('甲');
    expect(contentOf(logicalOf('甲\t'))).toBe('甲');
  });

  it('行内注释剥离后的行尾也走同一张表（NBSP 不剥、全角剥）', () => {
    // 结构化行的 `;` 行内注释：截到 `;` 前，再按统一字符集去尾（`stripInlineComment`）
    expect(stripInlineComment(`结算 X = 1${FF}; 注释`)).toBe('结算 X = 1');
    expect(stripInlineComment(`结算 X = 1${NBSP}; 注释`)).toBe(`结算 X = 1${NBSP}`);
    expect(stripInlineComment(`结算 X = 1; 注释`)).toBe('结算 X = 1');
    // 台词行不经此函数（`;` 是要打印的字），上面四条只作用于结构化行
    expect(classifyLine(logicalOf(`结算 X = 1${FF}; 注释`)).kind).toBe('settle');
  });
});
