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
 * ④ **末尾六节（`.kojo2`）**单独立闸，见文件下半部：在场 / 逐字溯源 / 原话对账 / 覆盖面。
 *
 * 测试豁免解耦审计 C 项，故这里可以跨包 import kojo-sugar 的真表（生产代码不行）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TUTORIALS, type TutorialSection } from '../src/tutorial-content';
import { createTutorialOverlay } from '../src/tutorial-overlay';
import { createEratwFaceTable } from '../src/face-templates';
import { FAMILY_ALIASES } from '../src/variable-schema';
import { parseTutorialInline, type TutorialInlineNode } from '../src/tutorial-inline';
import {
  KOJO2_MIGRATION_HINT_COLUMNS,
  KOJO2_SCREEN_MESSAGE_COLUMNS,
  KOJO2_SECTIONS,
  KOJO2_VERBATIM_COLUMNS,
} from '../src/tutorial-reference-kojo2';
import { TARGET_HINTS } from '../../../kojo-core/src/migrate/classify';
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
    expect(tables).toBeGreaterThanOrEqual(45); // 十三节 v1 表 + 末尾六节 2.0 的十七张表（下限抬到含新表，见④族）
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
    expect(classNames.filter((c) => c === 'tutorial-table').length).toBeGreaterThanOrEqual(45); // 含末尾六节的十七张表
    // 每一节都有可跳的锚点 id
    const ids = new Set(els.map((p) => String(p.id ?? '')));
    REF.sections.forEach((_, i) => expect(ids.has(`tu-reference-s${i}`), `缺第 ${i} 节锚点`).toBe(true));
  });
});

/* ------------------------------------------ ④ Kojo 2.0 那六张表（本批补的闸） */

/**
 * 上一批把 2.0 的六张表装配进了全表，却一条守卫都没留——这张表承诺"覆盖 2.0 现行写法"，
 * 没闸就是**假绿**。这里只钉四件能真失败的事实（编号用甲乙丙丁，避开本文件①②③那三族）：
 *
 * 甲 **在场**：六节挂在装配目录末尾、节数/表数到下限；§12.1 那张整表**逐行**在场——
 *    行名直接从设计稿那份 markdown 现读（不是抄一份数），文档改一行、表没跟上就红，
 *    表里凭空多出行外写法也红。行数用抽到的数自证，抽不到就当场抛，不判"都有"。
 * 乙 **逐字溯源**：「正典例」「夹具原句」两列的每一格必须是某份 2.0 夹具里的**整行**
 *    （剥掉包裹的反引号后逐字命中）。同一条闸先自证十一份夹具逐份读到了行、行集合够大——
 *    路径没解析出来时"每一格都对得上"是空集上的真命题，那才是这里最大的假绿来源。
 * 丙 **原话对账**：「屏上那句话」每一格必须能在实现源码的字符串面里找到。模板消息按
 *    `${…}` 切段后**逐段全等**：首段贴头、末段贴尾、中间每一段自身逐字出现且保持同序，
 *    段与段之间只许插一小截占位内容（`PIECE_GAP_LIMIT`）——头尾照抄、中间自己编一句话，
 *    在这一族里必须红，那才是"屏上原话"这四个字的本意。「迁移向导里那句」必须先对
 *    `TARGET_HINTS` 那份运行期表，对不上再退回源码字面量。抽不到字面量 = 守卫自身失效，当场红。
 * 丁 **覆盖面与作者面底线**：2.0 构造名逐个点名；已封存的三件不提；工程内部话不进叙述字段。
 *
 * **行长度那一闸不另起一套**：上面③里「每张表：有列名、每行列数与表头等长、不出现空格子」
 * 遍历的就是 `REF.sections`，这六节本就在里面（甲钉住了它们确实在），只把它的表数下限
 * 从 10 抬到 45（十三节 v1 表 + 2.0 十七张表）。
 *
 * 测试豁免解耦审计 C 项，故这里可以直接 import kojo-core 的运行期表。
 */

/** 2.0 六节的全部表（取数据件那份，与装配里的六节同源） */
const KOJO2_TABLES = KOJO2_SECTIONS.flatMap((s) => s.tables ?? []);

/** 2.0 六节可查文本（表格单元 + 叙述 + 样张），覆盖面点名用它 */
const kojo2Text = KOJO2_SECTIONS.flatMap((s) => [
  ...cellsOf(s),
  ...narrativePlain(s),
  ...(s.samples ?? []).map((x) => x.kojo),
]).join('\n');

/** 相对本测试文件起算（**不许手拆 `import.meta.url.pathname`**：中文路径 checkout 上必 ENOENT，PITFALLS 172） */
const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/* ---------------- 乙 用：2.0 夹具的行集合 ---------------- */

const KOJO2_FIXTURE_PATHS: readonly string[] = [
  '../../../kojo-core/tests/fixtures/kojo2-canonical.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/canonical.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/machine.kojo2',
  '../../../kojo-core/tests/fixtures/e2e/random.kojo2',
  '../../../kojo-core/tests/fixtures/migrate/mechanical.kojo2',
  '../../../kojo-core/tests/fixtures/migrate/semantic.kojo2',
  '../../../kojo-conformance/tests/fixtures/basic.kojo2',
  '../../../kojo-conformance/tests/fixtures/color.kojo2',
  '../../../app/tests/fixtures/kojo2/completion.kojo2',
  '../../../app/tests/fixtures/kojo2/hover-definition.kojo2',
  '../../../app/tests/fixtures/kojo2/sourcemap-preview.kojo2',
].map(abs);

/** 去 BOM（用码元判，别在源码里留一个看不见的字符） */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** 归一：去 BOM、统一换行、去行首空白（截取时剥过缩进）、丢空行 */
const normalizedLines = (path: string): string[] =>
  stripBom(readFileSync(path, 'utf8'))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0);

const FIXTURE_LINES_BY_FILE = KOJO2_FIXTURE_PATHS.map(normalizedLines);
const KOJO2_FIXTURE_LINES = new Set(FIXTURE_LINES_BY_FILE.flat());

/** 表格里裹一层反引号的格子 → 夹具那半（没裹就原样） */
const unwrap = (cell: string): string => cell.replace(/^`([\s\S]*)`$/u, '$1');

/** 某一列的全部格子（连出处，报错要能指到第几行） */
function cellsOfColumn(
  columns: readonly string[],
): { readonly where: string; readonly text: string }[] {
  return KOJO2_SECTIONS.flatMap((s) =>
    (s.tables ?? []).flatMap((t) =>
      t.columns.flatMap((col, index) =>
        columns.includes(col)
          ? t.rows.map((row, i) => ({
              where: `${s.heading} →「${col}」第 ${i + 1} 行`,
              text: unwrap(row[index] ?? ''),
            }))
          : [],
      ),
    ),
  );
}

const VERBATIM_CELLS = cellsOfColumn(KOJO2_VERBATIM_COLUMNS);

/* ---------------- 丙 用：实现源码里的诊断原话 ---------------- */

/** 2.0 的原话只可能出自这两处（core 词法/语法/降糖/迁移 + eraTW 对应表） */
const IMPL_SRC_DIRS: readonly string[] = [abs('../../../kojo-core/src'), abs('../src/kojo2')];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    return entry.isDirectory() ? tsFilesUnder(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** 一条可出现的原话：整串逐字，或模板按 `${…}` 切成的段（**每一段**都要逐字出现，见 `messageMatches`） */
type MessageForm = { readonly exact: string } | { readonly pieces: readonly string[] };

/** 反斜杠 / 反引号按码元取（正则以字面量写法在这里容易写劈，源码里也别留看不见的东西） */
const BS = String.fromCharCode(92);
const BT = String.fromCharCode(96);

/** 把源码字面量里的 `\`` 与 `\\` 还原成字符本身 */
const unescapeLiteral = (raw: string): string => raw.split(BS + BT).join(BT).split(BS + BS).join(BS);

const IMPL_MESSAGES: MessageForm[] = IMPL_SRC_DIRS.flatMap(tsFilesUnder)
  .map((path) => readFileSync(path, 'utf8'))
  .flatMap((text) => {
    const out: MessageForm[] = [];
    for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.push({ exact: unescapeLiteral(m[1]!) });
    for (const m of text.matchAll(new RegExp(BT + '((?:[^' + BT + '\\\\]|\\\\.)*)' + BT, 'g'))) {
      const raw = unescapeLiteral(m[1]!);
      const pieces = raw.split(/\$\{[^}]*\}/u);
      if (pieces.length === 1) {
        out.push({ exact: raw });
        continue;
      }
      /**
       * 带占位的模板只有在"骨架够长、首尾都不是空段、段是单行"时才算证据。
       * `${x}` / `` `${a}` 不能嵌套（§8.5）。`` 这类壳子的首段是空串，能匹配任何格子，
       * 留着就等于给这条闸开了个永远绿灯的后门；跨行的模板不是屏上一句话，也不算。
       * **段数不设上限**：切出几段就要求几段（`messageMatches` 逐段验），免得一整条原话
       * 因为占位多就被丢掉、那一格只能被"头一段＋尾一段"的别的字面蒙过去。
       */
      if (pieces.join('').length < 20) continue;
      if (pieces.some((p) => p.length === 0)) continue;
      if (pieces.some((p) => p.includes('\n'))) continue;
      if (pieces[0]!.length < 6 || pieces[pieces.length - 1]!.length < 6) continue;
      out.push({ pieces });
    }
    return out;
  });

/**
 * 段与段之间只许插**一小截**占位内容——那正是 `${…}` 的位置：一个名字、一枚编号、一小段字面。
 * 上限按观测给：本表走模板对账的那一格，占位只有 1 个字（`~`）；实现里插进消息的名字与表达式
 * 也在这一档长度内。有了这条上限，"头一句照抄、中间自己编、末一句照抄"必须红——
 * 那正是只比前缀与后缀时兜不住的形状。要放宽请先带上"哪一条原话真的会插这么长"的证据。
 */
const PIECE_GAP_LIMIT = 12;

/**
 * **按段全等**：模板切出来的每一个非空段，都必须在被钉文本里逐字出现、且保持同序；
 * 首段贴在被钉文本开头、末段收在被钉文本结尾，相邻两段之间只许插不超过 `PIECE_GAP_LIMIT`
 * 个字的占位内容。不是只比头一段与尾一段，也不许把原话夹在自己编的长句中间。
 * 整串原话仍旧逐字相等才算。
 */
function messageMatches(cell: string): boolean {
  return IMPL_MESSAGES.some((form) => {
    if ('exact' in form) return form.exact === cell;
    const pieces = form.pieces;
    if (pieces.length < 2) return false;
    if (!cell.startsWith(pieces[0]!)) return false;
    let at = pieces[0]!.length;
    for (let i = 1; i < pieces.length; i++) {
      const piece = pieces[i]!;
      /** 末段只能贴在尾巴上：中间出现一次不算，被钉文本必须以原话的最后一句收口 */
      const isLast = i === pieces.length - 1;
      const hit = isLast ? (cell.endsWith(piece) ? cell.length - piece.length : -1) : cell.indexOf(piece, at);
      if (hit < at) return false;
      if (hit - at > PIECE_GAP_LIMIT) return false;
      at = hit + piece.length;
    }
    return true;
  });
}

const SCREEN_MESSAGE_CELLS = cellsOfColumn(KOJO2_SCREEN_MESSAGE_COLUMNS);
const MIGRATION_HINT_CELLS = cellsOfColumn(KOJO2_MIGRATION_HINT_COLUMNS);
const TARGET_HINT_VALUES = new Set(Object.values(TARGET_HINTS));

/** 抽到的模板证据（走按段验的那一路）；一条都没有 = 采集漂了，这条闸就退化成只认整串相等 */
const TEMPLATE_FORMS: readonly (readonly string[])[] = IMPL_MESSAGES.flatMap((f) =>
  'exact' in f ? [] : [f.pieces],
);

describe('2.0 六张表在装配里在场（甲）', () => {
  it('装配目录末尾就是这六节，标题与顺序一个字不许漂', () => {
    const heads = KOJO2_SECTIONS.map((s) => s.heading.replace(/^「/u, '').replace(/」$/u, ''));
    expect(heads.length).toBe(6);
    expect(REF.sections.slice(-6).map((s) => s.heading)).toEqual(heads);
  });

  it('节数与表数到下限（整节或整张表被删掉必须红）', () => {
    expect(REF.sections.length).toBeGreaterThanOrEqual(19);
    expect(KOJO2_SECTIONS.length).toBeGreaterThanOrEqual(6);
    expect(KOJO2_TABLES.length).toBeGreaterThanOrEqual(17);
    for (const s of KOJO2_SECTIONS) {
      expect((s.tables ?? []).length, `2.0 节「${s.heading}」的表少于两张`).toBeGreaterThanOrEqual(2);
      expect(s.paragraphs.length, `2.0 节「${s.heading}」没段落`).toBeGreaterThan(0);
    }
  });

  it('§12.1 整表逐行在场：行名与行数都从设计稿现读，缺一条就红', () => {
    const doc = stripBom(
      readFileSync(fileURLToPath(new URL('../../../../docs/KOJO-2.0-LANGUAGE-SPEC.md', import.meta.url)), 'utf8'),
    )
      .replace(/\r\n/g, '\n')
      .split('\n');
    const from = doc.findIndex((line) => line.startsWith('### 12.1'));
    if (from < 0) throw new Error('设计稿里抽不到 §12.1 的标题——守卫自身失效，必须查');
    const specRows: string[][] = [];
    for (let i = from + 1; i < doc.length; i++) {
      const line = doc[i]!;
      if (!line.startsWith('|')) {
        if (specRows.length > 0) break;
        continue;
      }
      const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
      if (cells[0] === '写法' || /^[-:\s]*$/u.test(cells[0]!)) continue;
      specRows.push(cells);
    }
    if (specRows.length < 30) {
      throw new Error(`§12.1 只抽到 ${specRows.length} 行——文档那张表换了形态，守卫得跟着改，不许判成"表里都有"`);
    }
    const table = KOJO2_TABLES.find((t) => t.columns.includes('归属层'));
    if (!table) throw new Error('2.0 表里找不到 §12.1 那张整表（列名里没有「归属层」）');
    const left = table.rows.map((row) => row[0] ?? '');
    const missing = specRows.filter((row) => !left.includes(row[0]!)).map((row) => row[0]!);
    expect(missing, `§12.1 整表缺行：${missing.join(' / ')}`).toEqual([]);
    expect(left.length, `§12.1 整表行数漂了（文档 ${specRows.length} 行，表 ${left.length} 行）`).toBe(
      specRows.length,
    );
    const extra = left.filter((name) => !specRows.some((row) => row[0] === name));
    expect(extra, `表里有 §12.1 之外的写法：${extra.join(' / ')}`).toEqual([]);
  });
});

describe('2.0 表的逐字溯源（乙：例子不许凭印象编）', () => {
  it('十一份夹具逐份读到行，合起来的行集合大到不可能是路径没解析', () => {
    expect(KOJO2_FIXTURE_PATHS.length).toBe(11);
    FIXTURE_LINES_BY_FILE.forEach((lines, i) =>
      expect(lines.length, `这份夹具没读到任何行（路径没解析出来？）：${KOJO2_FIXTURE_PATHS[i]}`).toBeGreaterThan(
        0,
      ),
    );
    expect(KOJO2_FIXTURE_LINES.size).toBeGreaterThan(150);
    expect(KOJO2_FIXTURE_LINES.has('# 对照表 心情 依据 恋慕')).toBe(true);
    expect(KOJO2_FIXTURE_LINES.has('灵梦：「{你}今天来得挺早嘛。」(微笑)')).toBe(true);
  });

  it('「正典例」「夹具原句」每一格都是某份夹具里的整行，一个字符都不许改', () => {
    expect(VERBATIM_CELLS.length).toBeGreaterThanOrEqual(25);
    const drift = VERBATIM_CELLS.filter((c) => !KOJO2_FIXTURE_LINES.has(c.text)).map((c) => `${c.where} → ${c.text}`);
    expect(drift, `表里的例子在 2.0 夹具里找不到整行：\n${drift.join('\n')}`).toEqual([]);
  });

  it('这条闸自己抓得住：少一个字、造一个没写过的名字都必须飘红', () => {
    expect(KOJO2_FIXTURE_LINES.has('灵梦：「……好。」 续')).toBe(true);
    // 近miss：少了 `续` 前那个空格 / 把表的主语换成没声明过的名字
    expect(KOJO2_FIXTURE_LINES.has('灵梦：「……好。」续')).toBe(false);
    expect(KOJO2_FIXTURE_LINES.has('# 对照表 心情 依据 爱欲')).toBe(false);
    expect(unwrap('`# 机 指令 310`')).toBe('# 机 指令 310');
  });
});

describe('2.0 表的原话对账（丙：屏上那句话不许手抄）', () => {
  it('实现源码那份原话真的抽到了（抽不到就是守卫失效，不是"表都对"）', () => {
    expect(IMPL_SRC_DIRS.length).toBe(2);
    expect(IMPL_MESSAGES.length).toBeGreaterThanOrEqual(300);
    expect(TARGET_HINT_VALUES.size).toBeGreaterThanOrEqual(20);
    // 模板那一族也得在场，且**四段以上**的骨架不能是零：采集若把它们丢掉，多段原话就只能
    // 靠"头一段＋尾一段"的别的字面蒙过去（那正是这条闸要避免的事）。
    expect(TEMPLATE_FORMS.length).toBeGreaterThanOrEqual(40);
    expect(TEMPLATE_FORMS.filter((ps) => ps.length >= 4).length).toBeGreaterThanOrEqual(3);
  });

  it('「屏上那句话」每一格都对得上实现里的原话', () => {
    expect(SCREEN_MESSAGE_CELLS.length).toBeGreaterThanOrEqual(70);
    const bad = SCREEN_MESSAGE_CELLS.filter((c) => !messageMatches(c.text)).map((c) => `${c.where} → ${c.text}`);
    expect(bad, `屏上那句话在实现里找不到原话：\n${bad.join('\n')}`).toEqual([]);
  });

  it('「迁移向导里那句」每一格都是迁移向导真会说的话（先对运行期那份表）', () => {
    expect(MIGRATION_HINT_CELLS.length).toBeGreaterThanOrEqual(13);
    const bad = MIGRATION_HINT_CELLS.filter(
      (c) => !TARGET_HINT_VALUES.has(c.text) && !messageMatches(c.text),
    ).map((c) => `${c.where} → ${c.text}`);
    expect(bad, `迁移向导那句既不在 TARGET_HINTS 里、也不在实现源码里：\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * 每条负样本都配一条"同形的正样本"在前面对打：改的字落在段内、段被跳掉、占位区被写成
   * 一整句、节号被换、原话被夹进自己编的长句里——五种形状各自必须红。
   * 最后那条（占位区塞一整句）是这条闸从"前缀＋后缀"加严到"按段全等"才抓得住的形状。
   */
  it('这条闸自己抓得住：改一个字、少一个空格、改一个节号、中间塞一整句都必须飘红', () => {
    // —— 整串逐字那一路
    expect(messageMatches('`@随机` 不能嵌套（§8.4）。')).toBe(true);
    expect(messageMatches('`@随机` 不能嵌套（§8.5）。')).toBe(false);
    expect(messageMatches('池里的裸引号要写成台词（§4.10）。')).toBe(false);
    // —— 模板那一路：实现原话是 `行尾等待别名 `${别名}` 已退场：2.0 只写 `续`（§12.1）。`
    const tpl = '行尾等待别名 `~` 已退场：2.0 只写 `续`（§12.1）。';
    expect(messageMatches(tpl)).toBe(true);
    // 段内改两个字（退场 → 改行）
    expect(messageMatches(tpl.replace('已退场', '已改行'))).toBe(false);
    // 段内少一个空格（空格也是字）
    expect(messageMatches(tpl.replace('`~` 已退场', '`~`已退场'))).toBe(false);
    // 节号被换
    expect(messageMatches(tpl.replace('§12.1', '§9.9'))).toBe(false);
    // 占位区被改写成一整句话：两段都还在、顺序也对，中间的字是编的
    expect(messageMatches(tpl.replace('`~`', '这一族早就删掉了你别再写了，真的'))).toBe(false);
    // 原话不许夹在自己编的长句中间（首段必须贴头）
    expect(messageMatches('我抄给你看：' + tpl)).toBe(false);
    // —— 四段以上的骨架：每一段都得在场，跳掉中间那一段必须红
    const four =
      '文件内命名空间重名：「心情」在 `# 设` 再次声明（首个声明 `# 设`）' +
      '——变量/常量/表/池/模板/函数共用同一文件名字空间，后声明者会静默遮蔽前者，已阻断。';
    expect(messageMatches(four)).toBe(true);
    expect(messageMatches(four.replace('（首个声明 `# 设`）', ''))).toBe(false);
  });
});

describe('2.0 六张表的覆盖面与作者面底线（丁）', () => {
  it('2.0 构造名逐个点名（漏了一整个构造才是这里要抓的）', () => {
    for (const name of [
      '# 幕',
      '# 视角',
      '# 机',
      '# 设',
      '# 设',
      '# 对照表',
      '# 池',
      '# 模',
      '@算',
      '@着色',
      '@颜绘',
      '@随机',
      '@组',
      '@织',
      '@原生',
      '@循',
      '@断',
      '@续',
      '@复',
      '@巡',
      '@标',
      '@跳',
      '@函',
      '@返',
      '?',
      '否',
      '[插槽]',
      '续',
      '空行',
      '选项',
      '//',
    ]) {
      expect(kojo2Text, `2.0 六张表漏了构造：${name}`).toContain(name);
    }
  });

  it(`十六个调度词、九个事件、七个声明词都按实现那份词表点名（少一个就是语言改了而表没跟上）`, () => {
    for (const word of ['算', '着色', '颜绘', '随机', '组', '循', '复', '巡', '函', '织', '标', '跳', '返', '断', '续', '原生']) {
      expect(kojo2Text, `@ 家族缺调度词：@${word}`).toContain(`@${word}`);
    }
    for (const event of ['初见', '训练', '读档', '商店', '购买', '指令', '训练结束', '回合末', '指令结束']) {
      expect(kojo2Text, `缺事件名：${event}`).toContain(event);
    }
    for (const word of ['幕', '视角', '机', '设', '对照表', '池', '模']) {
      expect(kojo2Text, `缺声明词：# ${word}`).toContain(`# ${word}`);
    }
    for (const period of ['场景', '存档', '会话']) {
      expect(kojo2Text, `缺存储期：${period}`).toContain(period);
    }
    for (const attr of ['好感度', '恋慕', '恋人', '爱欲']) {
      expect(kojo2Text, `缺角色属性：${attr}`).toContain(attr);
    }
  });

  it('不提已封存的三件（2.0 这一族自己也要过这一条）', () => {
    for (const sealed of ['语法糖视图', '糖预览面板', '归档浏览器', '糖视图', '糖预览', '归档', '视图']) {
      expect(kojo2Text, `2.0 表里提到了封存功能：${sealed}`).not.toContain(sealed);
    }
  });

  /**
   * 只查**叙述字段**（标题 / 段 / 表上方那句）：表格单元里抄的是屏上原话与引擎名字，
   * 「改用 adapter 变量映射」这类字面是面板上的，改字比留个术语更糟。
   */
  it('2.0 六节的叙述字段不出现工程内部话', () => {
    const prose = KOJO2_SECTIONS.flatMap(narrativePlain).join('\n');
    for (const word of ['内核', '插件', '契约', 'adapter', 'Adapter', 'AST', 'diagnostic', 'lowering', 'core/']) {
      expect(prose, `2.0 表的叙述里出现了内部话：${word}`).not.toContain(word);
    }
  });
});
