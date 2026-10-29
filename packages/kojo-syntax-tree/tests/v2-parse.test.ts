import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, type Node } from 'web-tree-sitter';

/**
 * Kojo 2.0 CST 正样本闸（U6 语法树 · v2）。
 *
 * 钉住三件事：
 *  1. 合法 fixtures **零 ERROR / 零 MISSING**（含 CRLF、无尾换行、Tab 只在 `@原生` 内）；
 *  2. 2.0 的每一档结构都真的落成对应节点（5 锚点 / 声明 / 缩进块 / 台词 / 旁白 / 插值 /
 *     表行 / 池内无符号台词 / `@原生` raw / 赋值 / 调用 / `续` / 表演提示）；
 *  3. 块的行跨度由缩进记号精确界定（块头行 = 起点，体末行 = 终点）。
 *
 * 解析一律走出货 wasm（`tree-sitter-kojo2.wasm`），不另建 native 依赖。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');
const FIXTURES = join(pkgRoot, 'tests', 'v2-fixtures');
const BROKEN = join(FIXTURES, 'broken');

let language: Language;
let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
}, 120_000);

interface Fault {
  type: string;
  row: number;
  stRow: number;
  enRow: number;
}

/** 全文扫 ERROR / MISSING（行号为 0 基；`type` 对 MISSING 带前缀，报错时人可直读）。 */
function faultsOf(root: Node): Fault[] {
  const out: Fault[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'ERROR' || n.isMissing) {
      out.push({
        type: n.isMissing ? `MISSING:${n.type}` : 'ERROR',
        row: n.startPosition.row,
        stRow: n.startPosition.row,
        enRow: n.endPosition.row,
      });
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function parseFile(file: string): { text: string; root: Node; faults: Fault[] } {
  const text = readFileSync(file, 'utf8');
  const tree = parser.parse(text);
  if (!tree) throw new Error(`解析没产出树：${file}`);
  const root = tree.rootNode;
  return { text, root, faults: faultsOf(root) };
}

/** 递归收集 .kojo（跳过 broken/ 与 node_modules）。 */
function collect(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === BROKEN) continue;
      collect(p, out);
    } else if (e.name.endsWith('.kojo2')) out.push(p);
  }
  return out;
}

const validFixtures = collect(FIXTURES, []).sort();
const rel = (file: string): string => file.slice(FIXTURES.length + 1).replaceAll('\\', '/');

describe('合法 fixtures：零 ERROR / 零 MISSING', () => {
  it(`正样本都至少两份（实收 ${validFixtures.length}）：full.kojo2 + crlf.kojo2`, () => {
    expect(validFixtures.length, 'v2 正样本 fixture 缺失').toBeGreaterThanOrEqual(2);
  });

  it('逐个解析，故障必须为空', () => {
    const offenders: string[] = [];
    for (const file of validFixtures) {
      const { faults } = parseFile(file);
      if (faults.length > 0) {
        offenders.push(`${rel(file)} :: ${faults.map((f) => `${f.type}@行${f.row + 1}`).join(', ')}`);
      }
    }
    expect(offenders, '合法 2.0 写法出现 ERROR/MISSING ⇒ 语法比规范严，必须修语法').toEqual([]);
  });

  it('CRLF 文件与 LF 文件解析结果同构（换行只由 blank_line 认领）', () => {
    const crlf = readFileSync(join(FIXTURES, 'crlf.kojo2'), 'utf8');
    expect(crlf.includes('\r\n'), 'crlf.kojo2 必须真的是 CRLF').toBe(true);
    const { root, faults } = parseFile(join(FIXTURES, 'crlf.kojo2'));
    expect(faults).toEqual([]);
    // 有台词、有 `续`、有 @算 块：CRLF 下缩进/行尾判定与 LF 同口径
    expect(root.descendantsOfType('speech').length).toBe(1);
    expect(root.descendantsOfType('continue_mark').length).toBe(1);
    expect(root.descendantsOfType('block').length).toBe(1);
  });
});

describe('full.kojo2：2.0 语法面全部落成 CST 节点', () => {
  let root: Node;
  let text: string;

  beforeAll(() => {
    const r = parseFile(join(FIXTURES, 'full.kojo2'));
    root = r.root;
    text = r.text;
  });

  it('5 个锚点 + 无符号台词都有节点', () => {
    const wanted = [
      // `#` 声明
      'scene_decl',
      'view_decl',
      'event_decl',
      'set_decl',
      // `@` 调度
      'calc_head',
      'color_head',
      'random_head',
      'group_head',
      'while_head',
      'foreach_head',
      'repeat_head',
      'function_head',
      'weave_head',
      'face_command',
      'return_stmt',
      'break_stmt',
      'continue_stmt',
      'label_stmt',
      'jump_stmt',
      'native_head',
      // `>` 旁白 / `?` 条件 / `!` 触发 / 无符号台词
      'narration',
      'condition_head',
      'else_head',
      'trigger',
      'bare_speech',
      // 块 / 行内结构 / 调度区裸写 / 表 / 杂项
      'block',
      'indent',
      'dedent',
      'speech',
      'speaker',
      'interpolation',
      'interp_body',
      'interp_close',
      'presentation_hint',
      'continue_mark',
      'assignment',
      'call_line',
      'table_row',
      'table_range',
      'table_else',
      'table_value',
      'slot_marker',
      'comment',
      'blank_line',
      'native_line',
    ];
    const present = new Set<string>();
    const walk = (n: Node): void => {
      present.add(n.type);
      for (const c of n.children) walk(c);
    };
    walk(root);
    const missing = wanted.filter((t) => !present.has(t));
    expect(missing, `full.kojo2 缺这些 CST 节点：${missing.join(', ')}`).toEqual([]);
  });

  it('台词：说话人 + 「…」 + 行内插值 + 行尾提示', () => {
    const speech = root.descendantsOfType('speech');
    expect(speech.length).toBeGreaterThanOrEqual(10);
    const withInterp = speech.find((s) => s.descendantsOfType('interpolation').length > 0);
    expect(withInterp ?? null, '台词文本里的 {…} 必须是 interpolation 子节点').not.toBeNull();
    const speakerTexts = speech.map((s) => s.childForFieldName('speaker')?.text ?? '');
    expect(speakerTexts.some((t) => t.startsWith('灵梦'))).toBe(true);
    expect(speakerTexts.some((t) => t.startsWith('{我}')), '域符号说话人 {我}：').toBe(true);
    const hints = root.descendantsOfType('presentation_hint').map((n) => n.text);
    expect(hints).toContain('(心形)');
  });

  it('旁白：> 锚点、正文分段、插值、行尾 续', () => {
    const narrations = root.descendantsOfType('narration');
    expect(narrations.length).toBeGreaterThanOrEqual(10);
    const withInterp = narrations.find((n) => n.children.some((c) => c.type === 'interpolation'));
    expect(withInterp ?? null, '旁白 {心情} 必须是 interpolation 子节点').not.toBeNull();
    expect(root.descendantsOfType('continue_mark').length).toBeGreaterThanOrEqual(1);
  });

  it('@原生：整块 raw（`;` `{}` Tab `[插槽]` `//` 都是正文，不解析成 2.0 结构）', () => {
    const nativeBlocks = root
      .descendantsOfType('block')
      .filter((b) => b.childForFieldName('open')?.type === 'native_head');
    expect(nativeBlocks.length).toBe(1);
    const block = nativeBlocks[0]!;
    const raw = block.descendantsOfType('native_line');
    expect(raw.length).toBeGreaterThanOrEqual(6);
    const joined = raw.map((n) => n.text).join('\n');
    expect(joined).toContain('; 逃生舱');
    expect(joined).toContain('PRINTFORML {　}');
    expect(joined).toContain('[插槽] 只是普通字符');
    expect(joined).toContain('// 这里不是 2.0 注释');
    expect(joined, 'raw 行里的 Tab 必须原样保留').toContain('\tSETCOLOR');
    // raw 体内绝不产 2.0 结构节点
    expect(block.descendantsOfType('interpolation').length).toBe(0);
    expect(block.descendantsOfType('comment').length).toBe(0);
    expect(block.descendantsOfType('slot_marker').length).toBe(0);
  });

  it('# 对照表：块 + 两列表行 + 否 兜底', () => {
    const tableBlock = root
      .descendantsOfType('block')
      .find((b) => b.childForFieldName('open')?.type === 'table_head');
    expect(tableBlock ?? null).not.toBeNull();
    const rows = tableBlock!.descendantsOfType('table_row');
    expect(rows.length).toBe(4);
    const ranges = rows.map((r) => r.childForFieldName('range')?.text ?? '');
    expect(ranges).toEqual(['0..99', '100..499', '亲近线..', '否']);
    const values = rows.map((r) => r.childForFieldName('value')?.text ?? '');
    expect(values).toEqual(['疏远', '平常', '亲近', '未知']);
  });

  it('# 池：条件台词池里有裸引号 = 无符号台词', () => {
    const pool = root
      .descendantsOfType('block')
      .find((b) => b.childForFieldName('open')?.type === 'pool_head');
    expect(pool ?? null).not.toBeNull();
    const bare = pool!.descendantsOfType('bare_speech');
    expect(bare.length).toBeGreaterThanOrEqual(3);
    expect(bare.map((b) => b.text).some((t) => t.startsWith('「'))).toBe(true);
    // 池体内是 `?` 链：三个分支
    expect(pool!.descendantsOfType('condition_head').length).toBe(2);
    expect(pool!.descendantsOfType('else_head').length).toBe(1);
  });

  it('缩进块：块起点 = 块头行、体 = 更深一级；30 个块都闭合', () => {
    const blocks = root.descendantsOfType('block');
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    for (const b of blocks) {
      const open = b.childForFieldName('open');
      expect(open, '每个 block 必须有 open 字段').not.toBeNull();
      expect(b.startPosition.row, '块起点必须正好是块头所在行').toBe(open!.startPosition.row);
      expect(b.endPosition.row, '块终点不得早于块头行').toBeGreaterThanOrEqual(open!.startPosition.row);
      expect(b.childForFieldName('body') ?? null, '每个 block 必须有 body 字段').not.toBeNull();
    }
    // indent / dedent 必须一一配对（外部记号每层开一次、收一次）
    expect(root.descendantsOfType('indent').length).toBe(root.descendantsOfType('dedent').length);
  });

  it('文件里没有 ERROR/MISSING 混进来（与上面逐条断言互证）', () => {
    expect(faultsOf(root)).toEqual([]);
  });
});

describe('边界：空文件 / 无尾换行 / 未知行不整篇崩', () => {
  it('空文件 = 零故障', () => {
    const tree = parser.parse('');
    expect(tree).not.toBeNull();
    expect(faultsOf(tree!.rootNode)).toEqual([]);
  });

  it('最后一行没有换行也能解析', () => {
    const tree = parser.parse('# 机 指令 907\n> 甲。');
    expect(tree).not.toBeNull();
    expect(faultsOf(tree!.rootNode)).toEqual([]);
    expect(tree!.rootNode.descendantsOfType('narration').length).toBe(1);
  });

  it('裸文本 / #DIM / @未知 / 行首 = 都落 ERROR，但后续正常行照常解析', () => {
    const text = [
      '# 机 指令 906',
      '',
      '随便一行裸文本',
      '#DIM 甲, 1',
      '@未知 指令',
      '= 1',
      '> 这一行必须照常解析。',
      '',
    ].join('\n');
    const tree = parser.parse(text);
    expect(tree).not.toBeNull();
    const faults = faultsOf(tree!.rootNode);
    expect(faults.length, '上面每一行坏写法都应有可定位故障').toBeGreaterThanOrEqual(3);
    // 不得吞成声明节点
    expect(tree!.rootNode.descendantsOfType('variable_decl').length).toBe(0);
    expect(tree!.rootNode.descendantsOfType('calc_head').length).toBe(0);
    // 最后一枚好行仍解析
    const narrations = tree!.rootNode.descendantsOfType('narration');
    expect(narrations.length).toBe(1);
    expect(narrations[0]!.text).toContain('这一行必须照常解析');
    // 没有跨行 ERROR：坏写法各占自己那一行
    for (const f of faults) expect(f.enRow, `${f.type} 跨了多行`).toBe(f.stRow);
  });
});
