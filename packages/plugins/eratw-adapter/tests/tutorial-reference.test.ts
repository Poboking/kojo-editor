/**
 * 附录「kojo 语法全表」的自证守卫（TUT-2 2026-10-16）。
 *
 * 全表是**会过期的代码**：它承诺"覆盖现行全部写法"，那么实现里多一个面、少一个提示码，
 * 这张表就必须跟着变——靠人记得改是守不住的。所以这里不查文风，只查三件可对账的事实：
 *
 * ① **表 ↔ 实现真表**：时机面、文件头词形、中文运算符、系统函数中文名、语句形位原语、
 *    引擎全局白名单、变量族、行尾标记、保留代词、提示码闭集——实现里有的，表里必须在场。
 *    提示码那一份是 `plugin-api/src/sugar.ts` 里的**类型闭集**（没有运行时数组），
 *    于是从源码文本里抽；抽不到就当场红，防止守卫悄悄退化成"永远通过"。
 * ② **样例 ↔ 真转译器**：每条带产物的样例喂给真转译服务，产物逐行必须出现在结果里，
 *    且不许带 error 级诊断。表元数据里的产物是散文，样例才是可对账的那一半。
 * ③ **结构底线**：每行列数 == 表头列数、不空格子、叙述字段零标记残留、
 *    不提已封存功能、不出现内部术语。
 *
 * 测试豁免解耦审计 C 项，故这里可以跨包 import kojo-sugar 的真表（生产代码不行）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TUTORIALS, type TutorialSection } from '../src/tutorial-content';
import { createTutorialOverlay } from '../src/tutorial-overlay';
import { createEratwFaceTable } from '../src/face-templates';
import { FAMILY_ALIASES } from '../src/variable-schema';
import { parseTutorialInline, type TutorialInlineNode } from '../src/tutorial-inline';
import {
  CONT_MARKS,
  RESERVED_PRONOUNS,
  SUGAR_LEXICON_OPERATORS,
  SUGAR_LEXICON_WORDS,
  WAIT_MARKS,
} from '../../kojo-sugar/src/keywords';
import { ENGINE_GLOBAL_IDENTIFIERS } from '../../kojo-sugar/src/engine-globals';
import { ENGINE_VARIABLE_FAMILIES } from '../../kojo-sugar/src/index';
import { STATEMENT_FUNCTIONS } from '../../kojo-sugar/src/statement-functions';
import { SYSTEM_FUNCTION_ALIASES } from '../../kojo-sugar/src/system-functions';
import { createSugarTranspileService } from '../../kojo-sugar/src/service';
import {
  stubCounterTable,
  stubDict,
  stubFaceTable,
  stubInstructionTable,
  stubMutatorTable,
} from '../../kojo-sugar/tests/support';

const REF = TUTORIALS.reference;

/* ------------------------------------------------------------------ 取文本 */

/** 一节的表元数据（表头 + 全部单元格） */
const cellsOf = (s: TutorialSection): string[] =>
  (s.tables ?? []).flatMap((t) => [...t.columns, ...t.rows.flat()]);

/** 一节的叙述文本（标题 / 段落 / 样例说明 / 表说明）——这些走行内标记解析 */
function narrativePlain(s: TutorialSection): string[] {
  return [
    s.heading,
    ...s.paragraphs,
    ...(s.samples ?? []).map((x) => x.caption ?? ''),
    ...(s.tables ?? []).map((t) => t.note ?? ''),
  ];
}

/** 全表可查文本（表元数据 + 叙述 + 标题导语），对账"某一项在不在表里"用它 */
const haystack = REF.sections
  .flatMap((s) => [...cellsOf(s), ...narrativePlain(s)])
  .concat([REF.title, REF.lead])
  .join('\n');

/* ------------------------------------------------------------------ ① 对账 */

describe('全表 ↔ 实现真表（表漂移即红）', () => {
  it('时机面：face 表里每一个键都在这张表里', () => {
    const faces = Object.keys(createEratwFaceTable().faces);
    expect(faces.length).toBeGreaterThanOrEqual(30); // 真表退化也要抓到
    const missing = faces.filter((f) => !haystack.includes(f));
    expect(missing, `全表缺时机面：${missing.join(' / ')}`).toEqual([]);
  });

  it('时机面表的行数与实现里的面数不多不少（表注里那句「N 个面全在这里」不许漂）', () => {
    const faces = Object.keys(createEratwFaceTable().faces);
    const sec = REF.sections.find((s) => s.heading.includes('时机面'));
    if (!sec) throw new Error('目录里没有「时机面」那一节');
    const rows = (sec.tables ?? []).reduce((a, t) => a + t.rows.length, 0);
    expect(rows).toBe(faces.length);
  });

  it('文件头词形：词表里每个中文头部词都在表里', () => {
    const heads = SUGAR_LEXICON_WORDS.filter((w) => w.role === 'head' && w.primary).map((w) => w.word);
    expect(heads.length).toBeGreaterThanOrEqual(8);
    const missing = heads.filter((w) => !haystack.includes(w));
    expect(missing, `全表缺文件头词形：${missing.join(' / ')}`).toEqual([]);
  });

  it('中文运算符：运算符表里每个词形都在表里', () => {
    expect(SUGAR_LEXICON_OPERATORS.length).toBeGreaterThanOrEqual(8);
    const missing = SUGAR_LEXICON_OPERATORS.filter((w) => !haystack.includes(w));
    expect(missing, `全表缺中文运算符：${missing.join(' / ')}`).toEqual([]);
  });

  it('系统函数中文名：每一条都在表里', () => {
    const names = [...SYSTEM_FUNCTION_ALIASES.keys()];
    expect(names.length).toBeGreaterThanOrEqual(30);
    const missing = names.filter((n) => !haystack.includes(n));
    expect(missing, `全表缺中文函数名：${missing.join(' / ')}`).toEqual([]);
  });

  it('语句形位原语：三条都在表里', () => {
    const names = [...STATEMENT_FUNCTIONS.keys()];
    expect(names.length).toBe(3);
    const missing = names.filter((n) => !haystack.includes(n));
    expect(missing, `全表缺语句形原语：${missing.join(' / ')}`).toEqual([]);
  });

  it('引擎全局白名单：17 个名字逐个在表里', () => {
    expect(ENGINE_GLOBAL_IDENTIFIERS.length).toBeGreaterThanOrEqual(17);
    const missing = ENGINE_GLOBAL_IDENTIFIERS.filter((n) => !haystack.includes(n));
    expect(missing, `全表缺引擎全局名：${missing.join(' / ')}`).toEqual([]);
  });

  it('变量族：每个族头都在表里', () => {
    expect(ENGINE_VARIABLE_FAMILIES.length).toBeGreaterThanOrEqual(20);
    const missing = ENGINE_VARIABLE_FAMILIES.filter((f) => !haystack.includes(f));
    expect(missing, `全表缺变量族：${missing.join(' / ')}`).toEqual([]);
  });

  it('中文族头别名：别名表的行由实现生成，条数与内容一致', () => {
    const aliases = Object.keys(FAMILY_ALIASES);
    expect(aliases.length).toBeGreaterThanOrEqual(20);
    const sec = REF.sections.find((s) => s.heading.includes('变量与族'));
    if (!sec) throw new Error('目录里没有「变量与族」那一节');
    const rows = (sec.tables ?? []).flatMap((t) => t.rows);
    const missing = aliases.filter((a) => !rows.some((r) => (r[0] ?? '').includes(a)));
    expect(missing, `别名表缺：${missing.join(' / ')}`).toEqual([]);
  });

  it('行尾标记与保留代词：全部在表里', () => {
    for (const w of [...CONT_MARKS, ...WAIT_MARKS, ...RESERVED_PRONOUNS]) {
      expect(haystack, `全表缺行尾标记/代词：${w}`).toContain(w);
    }
  });

  it('提示码闭集：源码里声明的每一条码都在表里', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../plugin-api/src/sugar.ts', import.meta.url)),
      'utf8',
    );
    const block = /export type SugarDiagnosticCode =([\s\S]*?);/.exec(src);
    if (!block) throw new Error('抽不到 SugarDiagnosticCode 闭集——守卫自身失效，必须查');
    const codes = [...block[1]!.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(25);
    const missing = codes.filter((c) => !haystack.includes(c));
    expect(missing, `全表缺提示码：${missing.join(' / ')}`).toEqual([]);
  });
});

/* ------------------------------------------------------------- ② 真转译对账 */

const svc = createSugarTranspileService({
  dictionary: stubDict,
  faceTable: stubFaceTable(),
  instructionTable: stubInstructionTable(),
  mutatorTable: stubMutatorTable(),
  counterTable: stubCounterTable(),
});

/**
 * 样例是**节选**（一张表里只讲一种写法），所以补成能转译的最小整档：
 * 没有块头的补一层 `时机 指令 310：` 并把样例缩进一级；有块头缺文件头的补 `角色: 12`。
 */
function asFullFile(kojo: string): string {
  const hasTiming = /^时机\s/m.test(kojo);
  const hasChar = /^角色\s*[:：]/m.test(kojo);
  if (hasTiming) return hasChar ? kojo : `角色: 12\n${kojo}`;
  const body = kojo
    .split('\n')
    .map((line) => (line.trim().length > 0 ? `    ${line}` : line))
    .join('\n');
  return `角色: 12\n时机 指令 310：\n${body}\n`;
}

const norm = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0);

describe('全表样例 ↔ 真转译器（产物不许靠手抄）', () => {
  const withProduct = REF.sections.flatMap((s) =>
    (s.samples ?? []).filter((x) => x.erb !== undefined).map((x) => [s, x] as const),
  );

  it('带产物的样例够多（这张表靠对照说话）', () => {
    expect(withProduct.length).toBeGreaterThanOrEqual(8);
  });

  it('每条产物逐行出现在真转译结果里', () => {
    const misses: string[] = [];
    for (const [section, sample] of withProduct) {
      const out = new Set(norm(svc.transpile(asFullFile(sample.kojo)).erb));
      for (const line of norm(sample.erb ?? '')) {
        if (!out.has(line)) misses.push(`${section.heading} → 缺行「${line}」`);
      }
    }
    expect(misses, `产物对不上真转译结果：\n${misses.join('\n')}`).toEqual([]);
  });

  it('样例转译不出 error 级诊断（写了就得真能用）', () => {
    const bad: string[] = [];
    for (const [section, sample] of withProduct) {
      const r = svc.transpile(asFullFile(sample.kojo));
      for (const d of r.diagnostics) {
        if (d.severity === 'error') bad.push(`${section.heading} → ${d.code}: ${d.message}`);
      }
    }
    expect(bad, `样例转译报 error：\n${bad.join('\n')}`).toEqual([]);
  });
});

/* ------------------------------------------------------------- ③ 结构底线 */

/** 解析后仍留在文本里的标记字面（未配对的 `**` 或反引号） */
function residualMarkers(nodes: TutorialInlineNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TutorialInlineNode[]): void => {
    for (const n of list) {
      if (n.kind === 'text') {
        if (/\*\*|`/.test(n.text)) out.push(n.text);
      } else if (n.kind === 'strong') walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

describe('全表结构底线', () => {
  it('节数 ≥ 10，标题非空且互不重复，每节有内容', () => {
    expect(REF.sections.length).toBeGreaterThanOrEqual(10);
    const headings = REF.sections.map((s) => s.heading);
    for (const h of headings) expect(h.trim().length).toBeGreaterThan(0);
    expect(new Set(headings).size).toBe(headings.length);
    for (const s of REF.sections) {
      const filled = s.paragraphs.length + (s.tables?.length ?? 0) + (s.samples?.length ?? 0);
      expect(filled, `节「${s.heading}」既没段落也没表`).toBeGreaterThan(0);
    }
  });

  it('每张表：有列名、每行列数与表头等长、不出现空格子', () => {
    let tables = 0;
    for (const s of REF.sections) {
      for (const t of s.tables ?? []) {
        tables++;
        expect(t.columns.length, `节「${s.heading}」有表没列名`).toBeGreaterThan(0);
        for (const col of t.columns) expect(col.trim().length).toBeGreaterThan(0);
        expect(t.rows.length, `节「${s.heading}」有表没行`).toBeGreaterThan(0);
        t.rows.forEach((row, i) =>
          expect(row.length, `节「${s.heading}」第 ${i + 1} 行列数 ${row.length} ≠ 表头 ${t.columns.length}`).toBe(
            t.columns.length,
          ),
        );
        t.rows.forEach((row, i) =>
          row.forEach((cell, c) =>
            expect(cell.trim().length, `节「${s.heading}」第 ${i + 1} 行第 ${c + 1} 列是空的`).toBeGreaterThan(0),
          ),
        );
      }
    }
    expect(tables).toBeGreaterThanOrEqual(10);
  });

  it('叙述字段零标记残留（未配对的 ** 或反引号不许上屏）', () => {
    for (const s of REF.sections) {
      for (const text of [...narrativePlain(s), REF.title, REF.lead]) {
        expect(residualMarkers(parseTutorialInline(text)), `残留于「${text.slice(0, 40)}」`).toEqual([]);
      }
    }
  });

  it('表元数据里不留未配对标记（单个 * 是运算符，合法）', () => {
    for (const s of REF.sections) {
      for (const cell of cellsOf(s)) {
        expect(residualMarkers(parseTutorialInline(cell)), `表格单元残留：「${cell.slice(0, 40)}」`).toEqual([]);
      }
    }
  });

  it('不提已封存的三件（任何位置，含表元数据与样例）', () => {
    const sealed = ['.kojo 预览', '.kojo 转译检查', '归档浏览器', '糖视图', '语法糖视图', '糖预览'];
    const all =
      haystack +
      REF.sections.flatMap((s) => (s.samples ?? []).flatMap((x) => [x.kojo, x.erb ?? ''])).join('\n');
    for (const word of sealed) {
      expect(all, `全表提到了封存功能：${word}`).not.toContain(word);
    }
  });

  /**
   * 内部术语只查**叙述字段**（标题 / 段 / 样例说明 / 表说明）。表元数据里抄的是屏上原话——
   * 「转译器内部错误：…」「只接受逗号分隔的实参令牌」「展开成字面量」都是面板上的字，
   * 提示原文必须照抄，改字比留个术语更糟。
   */
  it('叙述字段不出现工程内部话', () => {
    const jargon = ['内核', '插件', '契约', '转译器', '降糖', '升糖', '词法', '令牌', '字面量', '标识符'];
    const prose = [REF.title, REF.lead, ...REF.sections.flatMap(narrativePlain)].join('\n');
    for (const word of jargon) {
      expect(prose, `全表的叙述里出现了内部话：${word}`).not.toContain(word);
    }
  });

  it('浮层产出目录条与对照表（渲染树侧的接线）', () => {
    const els: { className?: unknown; id?: unknown }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const el = node as { props?: Record<string, unknown> };
      if (typeof el.props !== 'object' || el.props === null) return;
      els.push(el.props as { className?: unknown; id?: unknown });
      walk(el.props.children);
    };
    walk(createTutorialOverlay({ tutorial: REF, close: () => {} })());
    const classNames = els.map((p) => String(p.className ?? ''));
    expect(classNames.filter((c) => c === 'tutorial-toc').length).toBe(1);
    expect(classNames.filter((c) => c === 'tutorial-toc-item').length).toBe(REF.sections.length);
    expect(classNames.filter((c) => c === 'tutorial-table').length).toBeGreaterThanOrEqual(10);
    // 每一节都有可跳的锚点 id
    const ids = new Set(els.map((p) => String(p.id ?? '')));
    REF.sections.forEach((_, i) => expect(ids.has(`tu-reference-s${i}`), `缺第 ${i} 节锚点`).toBe(true));
  });
});
