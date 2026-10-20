import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Language, Node, Parser, Query, Tree } from 'web-tree-sitter';
import { compileQuery, createParser, foldRanges, loadLanguage, parseStructureText } from '../src/index';

/**
 * 结构闸：用真 wasm 解析本地 fixtures，钉住
 * - 合法文件 **0 ERROR / 0 MISSING**（行式结构 / 函数头三形 / 控制流配对 / 停用区 / 字符串与 FORM 切分）；
 * - 故意残缺的样本**可定位**（未收盘块落 MISSING 收束词，而不是静默吞成文本）；
 * - 折叠查询 `folds.scm` 的区间语义（块跨度 / 分支段 / 函数边界 / 空块不产区间）。
 *
 * 语料只读纪律：本文件只读 `tests/fixtures/`，不碰游戏目录；真实语料读数走 tools/parse-corpus.mjs。
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const WASM = join(PKG, 'tree-sitter-erb.wasm');
const FIXTURES = join(PKG, 'tests', 'fixtures');

let parser: Parser;
let language: Language;
let foldsQuery: Query;

beforeAll(async () => {
  language = await loadLanguage(WASM);
  parser = await createParser(WASM);
  foldsQuery = compileQuery(language, readFileSync(join(PKG, 'queries', 'folds.scm'), 'utf8'));
}, 180_000);

interface Fault {
  type: string;
  row: number;
}

function faultsOf(root: Node): Fault[] {
  const out: Fault[] = [];
  const walk = (n: Node): void => {
    if (n.isMissing || n.type === 'ERROR') out.push({ type: n.isMissing ? `MISSING:${n.type}` : 'ERROR', row: n.startPosition.row });
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

function allOf(root: Node, type: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (n.type === type) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

function typeCounts(root: Node): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (n: Node): void => {
    out[n.type] = (out[n.type] ?? 0) + 1;
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

function parse(text: string): Tree {
  const tree = parseStructureText(parser, text);
  expect(tree, 'parser 没产出树').not.toBeNull();
  return tree as Tree;
}

function expectClean(text: string): Tree {
  const tree = parse(text);
  const faults = faultsOf(tree.rootNode);
  tree.delete();
  expect(faults, `不应有 ERROR/MISSING：${JSON.stringify(faults)}`).toEqual([]);
  return tree;
}

describe('合法结构 fixture：0 ERROR / 0 MISSING', () => {
  const text = readFileSync(join(FIXTURES, 'valid-structure.erb'), 'utf8');

  it('整份文件零故障，且函数 / 控制流块全部成块', () => {
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    const c = typeCounts(tree.rootNode);
    // 函数：裸头 / 括号头 / 逗号头各一
    expect(c.function_block).toBe(3);
    expect(c.function_head).toBe(3);
    expect(c.function_name).toBe(3);
    // 控制流：IF 嵌套 SELECT/FOR/PRINTDATA，ELSE 支内 REPEAT/WHILE/DO/TRY/FUNCLIST
    for (const t of ['if_block', 'select_block', 'for_block', 'repeat_block', 'while_block', 'do_block', 'data_block', 'list_block', 'noskip_block', 'try_block', 'funclist_block']) {
      expect(c[t], `缺 ${t}`).toBeGreaterThan(0);
    }
    // 分支段：ELSEIF / ELSE / CASE / CASEELSE / CATCH 都产 branch_block
    expect(c.branch_block).toBeGreaterThanOrEqual(6);
    // 停用区内的 `@NOT_A_FUNCTION` 没有被当成函数
    expect(c.skip_block).toBe(1);
    expect(c.skip_body).toBe(1);
    // 指令 / 标签 / 单行控制
    expect(c.dim_directive).toBe(4);
    expect(c.directive_line).toBe(2);
    expect(c.label_line).toBe(1);
    expect(c.sif_line).toBe(1);
    tree.delete();
  });

  it('函数头三形都能被识别（括号 / 逗号 / 裸形 + CJK 名）', () => {
    const tree = parse(text);
    const names = allOf(tree.rootNode, 'function_name').map((n) => n.text);
    expect(names).toEqual(['BATTLE_SYSTEM', 'COMMA_FORM', '肉体情報_M']);
    const heads = allOf(tree.rootNode, 'function_head').map((n) => n.text);
    expect(heads[0]).toBe('@BATTLE_SYSTEM(ARG, ARG:1 = 3, ref X, ARGS:2 = "VOID")');
    expect(heads[1]).toBe('@COMMA_FORM, ARGS, ARG, ARGS:1, ARG:1');
    expect(heads[2]).toBe('@肉体情報_M(選択中キャラID)');
    tree.delete();
  });

  it('停用区：原文一句不解析（含 @ 头 / 控制词 / 未闭合引号）', () => {
    const tree = parse(text);
    const body = allOf(tree.rootNode, 'skip_body')[0]!;
    expect(body.text).toContain('@NOT_A_FUNCTION(IGNORED)');
    expect(body.text).toContain('IF THIS IS RAW');
    expect(body.text).toContain('"unterminated');
    expect(body.text).toContain('ENDSELECT ???');
    // 区间内没有函数/块节点（skip_body 是 opaque token）
    expect(allOf(body, 'function_head')).toEqual([]);
    expect(allOf(body, 'if_block')).toEqual([]);
    tree.delete();
  });

  it('控制流开/收字段逐块对得上（不是只按词出现的散节点）', () => {
    const tree = parse(text);
    const ifBlock = allOf(tree.rootNode, 'if_block')[0]!;
    // 控制行 token 以行尾换行为终点（短词不吃长词前缀），节点文本带一个尾换行
    expect(ifBlock.childForFieldName('open')?.text.trim()).toBe('IF A == "x;y" ; inline comment');
    expect(ifBlock.childForFieldName('close')?.text.trim()).toBe('ENDIF');
    const select = allOf(tree.rootNode, 'select_block')[0]!;
    expect(select.childForFieldName('open')?.text?.trim()).toBe('SELECTCASE LOCAL');
    expect(select.childForFieldName('close')?.text?.trim()).toBe('ENDSELECT');
    const forBlock = allOf(tree.rootNode, 'for_block')[0]!;
    expect(forBlock.childForFieldName('close')?.text?.trim()).toBe('NEXT');
    const tryBlock = allOf(tree.rootNode, 'try_block')[0]!;
    expect(tryBlock.childForFieldName('open')?.text?.trim()).toBe('TRYCCALLFORM FOO_{ARG}');
    expect(tryBlock.childForFieldName('close')?.text?.trim()).toBe('ENDCATCH');
    tree.delete();
  });

  it('字符串与 FORM 切分：引号内分号不算注释，{…} / %…% 成为子节点', () => {
    const tree = parse(text);
    const subs = allOf(tree.rootNode, 'form_substitution').map((n) => n.text);
    expect(subs).toContain('%CALLNAME:MASTER%');
    const inters = allOf(tree.rootNode, 'form_interpolation').map((n) => n.text);
    expect(inters).toContain('{FLAG:人数}');
    // `IF A == "x;y"` 是控制流整行 token，不拆串；此处用一条 FORM 语句钉引号内分号
    const t2 = parse('PRINTFORM "a;b" ; tail\n');
    const strings = allOf(t2.rootNode, 'string');
    expect(strings.map((n) => n.text)).toEqual(['"a;b"']);
    // 行内注释 token 会带上与 `;` 同行的前导 ASCII 空格（extras 与 `_line_chunk` 的同位竞争），
    // 判据只认「注释从分号起、串内分号没被误拆」。
    expect(allOf(t2.rootNode, 'comment_inline').map((n) => n.text.trim())).toEqual(['; tail']);
    t2.delete();
    tree.delete();
  });
});

describe('大小写 / 换行 / BOM / 容错', () => {
  it('控制词大小写不敏感；#DIM 族同样不敏感', () => {
    const text = 'if a\nrepeat\nprintl x\nrend\nendif\n#dim x\n';
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'if_block')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'repeat_block')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'dim_directive')).toHaveLength(1);
    tree.delete();
  });

  it('缩进的 @ 函数头 / $ 标签仍成节点（不被语句行吞掉）', () => {
    const text = '\uFEFF\t@F\n\t$LABEL\n\tPRINTL x\n';
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'function_head')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'label_line')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'statement_line')).toHaveLength(1);
    tree.delete();
  });

  it('CRLF + BOM：BOM 与 CR 都当 extras，块/行跨度不受影响', () => {
    const text = '\uFEFF@F()\r\nIF X\r\nPRINTL hi\r\nENDIF\r\n';
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    const head = allOf(tree.rootNode, 'function_head')[0]!;
    expect(head.text).toBe('@F()');
    expect(head.startPosition.row).toBe(0);
    const ifBlock = allOf(tree.rootNode, 'if_block')[0]!;
    expect(ifBlock.startPosition.row).toBe(1);
    // 控制行 token 吃掉自己的尾换行 ⇒ 块终点落在下一行行首（0 基 4）；折叠区间由 foldRanges 回退一行
    expect(ifBlock.endPosition.row).toBe(4);
    expect(ifBlock.endPosition.column).toBe(0);
    tree.delete();
  });

  it('未闭合引号不制造 ERROR（ERB 真实存在裸引号/续行）', () => {
    const tree = parse('@F\nPRINTL "abc\n');
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'string').map((n) => n.text)).toEqual(['"abc']);
    tree.delete();
  });

  it('行首 @" 续行不冒充函数头', () => {
    const tree = parse('@F\n@"<div>"\n"裸引号\n');
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'function_head')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'at_string')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'string_line')).toHaveLength(1);
    tree.delete();
  });

  it('停用区：全小写 [skipstart] 不认（与真源严格等值同判），走 bracket_line', () => {
    const tree = parse('[skipstart]\nraw\n[skipend]\n');
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'skip_block')).toEqual([]);
    expect(allOf(tree.rootNode, 'bracket_line')).toHaveLength(2);
    tree.delete();
  });

  it('停用区：空体 / 尾注不收 / EOF 无收区标记都不崩', () => {
    const empty = parse('[SKIPSTART]\n[SKIPEND]\n');
    expect(faultsOf(empty.rootNode)).toEqual([]);
    expect(allOf(empty.rootNode, 'skip_block')).toHaveLength(1);
    empty.delete();

    // 尾注 `[SKIPEND] ;x` 不是整行等值 ⇒ 不算收区；体继续到 EOF
    const withTail = parse('[SKIPSTART]\nraw\n[SKIPEND] ;not-a-marker\n');
    expect(faultsOf(withTail.rootNode)).toEqual([]);
    const body = allOf(withTail.rootNode, 'skip_body')[0]!;
    expect(body.text).toContain('[SKIPEND] ;not-a-marker');
    expect(allOf(withTail.rootNode, 'skip_end')).toEqual([]);
    withTail.delete();

    const noClose = parse('[SKIPSTART]\nraw @ IF\n');
    expect(faultsOf(noClose.rootNode)).toEqual([]);
    expect(allOf(noClose.rootNode, 'skip_block')).toHaveLength(1);
    expect(allOf(noClose.rootNode, 'skip_end')).toEqual([]);
    noClose.delete();
  });

  it('顶层孤儿收束 / 分支行有单行落点，不产块', () => {
    const tree = parse('ENDIF\nELSE\nCASE 1\n');
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'if_block')).toEqual([]);
    expect(allOf(tree.rootNode, 'endif_line')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'else_line')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'case_line')).toHaveLength(1);
    tree.delete();
  });

  it('控制词紧贴标识符是语句行（IFDr / NEXTX / IFPf），不被当成控制块开头', () => {
    const text = '@F\nIFDr = 1\nNEXTX = 2\nIFPf=!IFPf\nIF X\nENDIF\n';
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'if_block')).toHaveLength(1);
    expect(allOf(tree.rootNode, 'next_block')).toEqual([]);
    // 三行变量赋值都在，且不是控制行节点
    for (const type of ['if_line', 'next_line']) {
      expect(allOf(tree.rootNode, type).every((n) => !n.text.trim().startsWith('IFDr') && !n.text.trim().startsWith('NEXTX'))).toBe(true);
    }
    tree.delete();
  });

  it('行内控制词不劈行：语句行中间的 for / if 只是文本（真语料整段 ERROR 的根因）', () => {
    const text =
      '@F\nSELECTCASE X\n\tCASE 0\n\t\tDEBUGPRINTFORML Value of SOURCE {X} for %NAME% was {Y}.\n\t\tZ = 1\nENDSELECT\n';
    const tree = parse(text);
    expect(faultsOf(tree.rootNode)).toEqual([]);
    expect(allOf(tree.rootNode, 'for_block')).toEqual([]);
    expect(allOf(tree.rootNode, 'if_block')).toEqual([]);
    const stmt = allOf(tree.rootNode, 'statement_line').find((n) => n.text.includes('for'));
    expect(stmt, '整行应留在同一条 statement_line').toBeTruthy();
    expect(stmt!.text).toContain('for %NAME% was');
    tree.delete();
  });

  it('未收盘控制块落 MISSING 收束词（可定位，不静默）', () => {
    const tree = parse('@F\nIF X\nPRINTL hi\n');
    const fs = faultsOf(tree.rootNode);
    expect(fs.some((f) => f.type === 'MISSING:endif_line'), JSON.stringify(fs)).toBe(true);
    expect(fs[0]!.row).toBeGreaterThanOrEqual(2);
    tree.delete();
  });
});

describe('折叠查询 folds.scm', () => {
  it('函数 / 控制流 / 分支段 / 停用区都产区间；空函数与空块不产', () => {
    const text = readFileSync(join(FIXTURES, 'valid-structure.erb'), 'utf8');
    const tree = parse(text);
    const ranges = foldRanges(foldsQuery, tree);
    const has = (s: number, e: number) => ranges.some((r) => r.startRow === s && r.endRow === e);
    // 0 基行：函数 1 = 12..44（下一条 @ 在 45 行；44 行是 `$` 标签，仍属函数体），
    // 函数 2 = 45..47（下一条 @ 在 48 行），函数 3 = 48..61（到 EOF）
    expect(has(12, 44), `函数 1 折叠区间：${JSON.stringify(ranges.filter((r) => r.startRow === 12))}`).toBe(true);
    expect(has(45, 47), '函数 2（逗号头）折叠区间').toBe(true);
    expect(has(48, 61), '函数 3（CJK 括号头）折叠区间').toBe(true);
    // IF 14..43；分支段 28..35 / 36..42；SELECT 15..27，CASE 段 16..19 / 20..21 / 22..26
    expect(has(14, 43), 'IF 块 14..43').toBe(true);
    expect(has(15, 27), 'SELECT 块 15..27').toBe(true);
    expect(has(16, 19), 'CASE 分支段 16..19').toBe(true);
    expect(has(28, 35), 'ELSEIF 分支段 28..35').toBe(true);
    expect(has(36, 42), 'ELSE 分支段 36..42').toBe(true);
    expect(has(38, 39), 'CATCH 分支段 38..39').toBe(true);
    // 停用区 6..11
    expect(has(6, 11), '停用区折叠').toBe(true);
    // 无零跨度区间
    expect(ranges.every((r) => r.endRow > r.startRow)).toBe(true);
    tree.delete();
  });

  it('空函数 / 空块不产折叠（query 捕获到了也由 foldRanges 滤掉）', () => {
    const tree = parse('@EMPTY\n@F\nIF X\nENDIF\n');
    const ranges = foldRanges(foldsQuery, tree);
    // @EMPTY 是零跨度；@F 的 IF 块也是一行开一行收但块跨度 2..3 可折
    expect(ranges).toContainEqual({ startRow: 1, endRow: 3 });
    expect(ranges.every((r) => r.endRow > r.startRow)).toBe(true);
    tree.delete();
  });
});
