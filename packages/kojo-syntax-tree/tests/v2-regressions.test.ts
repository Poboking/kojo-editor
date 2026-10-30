import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, type Node } from 'web-tree-sitter';

/**
 * Kojo 2.0 CST 回归闸（2026-10-26 用户反馈批，组长用出货 wasm 实测证死的三条）。
 *
 * 三条都是**静默**缺陷——没有 ERROR 或 ERROR 落在错的地方，作者看不出写坏了：
 *  1. `? 否定的变量 == 1` 被劈成 `(else_head)(assignment)`：`else_head` 的
 *     `\?[W]*否[W]*` 没有右边界，`否` 后面跟 `定` 也照样命中，于是整行条件被切成
 *     「否则 + 赋值」，后面的缩进块挂到赋值上，`hasError=false`。
 *  2. `@原生` 块内用 Tab 缩进 ⇒ `hasError=true`，还吐 `(UNEXPECTED '\t')` 并造出
 *     假的 `(table_range)`；而 core 明确允许 Tab 只出现在 `@原生` 块体里
 *     （`packages/kojo-core/src/lexer.ts` 的 Tab 口径、`parser.ts` 的「Tab 原样」）。
 *     块内 Tab 必须与 4 空格**同一棵结构**；块外的 Tab 仍然只打那一行
 *     （见 `v2-error-recovery.test.ts` 的 `broken-tab-indent.kojo2`）。
 *  3. 表端点 `否定` 被兜底 `否` 吃掉：`table_else` 只认单字 `否`，`否定 0` 解成
 *     range=`否` / value=`定 0` —— 端点名字里首字 `否` 的那一半被静默吞掉。
 *
 * 一律解析出货 wasm（`tree-sitter-kojo2.wasm`），与本包其它 v2 闸同口径。
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  const language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
}, 120_000);

function parseText(text: string): Node {
  const tree = parser.parse(text);
  if (!tree) throw new Error('解析没产出树');
  return tree.rootNode;
}

function faultsOf(root: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'ERROR' || n.isMissing) {
      out.push(`${n.isMissing ? 'MISSING:' : 'ERROR'} '${n.type}'@行${n.startPosition.row + 1}`);
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function count(root: Node, type: string): number {
  return root.descendantsOfType(type).length;
}

describe('`? 否` 必须行尾收口：`? 否定…` 是一个条件块，不是「否则 + 赋值」', () => {
  const text = ['# 设 否定的变量 整数', '', '? 否定的变量 == 1', '    > 一', ''].join('\n');

  it('零故障，且不产 else_head / assignment', () => {
    const root = parseText(text);
    expect(faultsOf(root), '整段是合法 2.0，不该有故障').toEqual([]);
    expect(count(root, 'else_head'), '`? 否…` 被当成「否则」了').toBe(0);
    expect(count(root, 'assignment'), '条件行被劈成了赋值').toBe(0);
    expect(count(root, 'condition_head')).toBe(1);
  });

  it('条件头吃掉整行条件，缩进块挂在同一个 condition 块上', () => {
    const root = parseText(text);
    const head = root.descendantsOfType('condition_head')[0]!;
    expect(head.text, '条件头必须整行（含 `否定` 全名）').toBe('? 否定的变量 == 1');
    const block = root
      .descendantsOfType('block')
      .find((b) => b.childForFieldName('open')?.type === 'condition_head');
    expect(block ?? null, '条件必须长成 block（否则后面的缩进块会挂到赋值上）').not.toBeNull();
    const body = block!.childForFieldName('body')!;
    const narrations = root.descendantsOfType('narration');
    expect(narrations.length).toBe(1);
    expect(narrations[0]!.startPosition.row).toBe(3);
    expect(body.startPosition.row).toBeLessThanOrEqual(narrations[0]!.startPosition.row);
    expect(body.endPosition.row).toBeGreaterThanOrEqual(narrations[0]!.endPosition.row);
    // 上一行的变量声明不被卷进条件里
    expect(root.descendantsOfType('set_decl')[0]!.text).toBe('# 设 否定的变量 整数');
  });

  it('`?` 后不空格（`?否定变量 …`）也不许被劈成「否则 + 赋值」', () => {
    // §2.4 要求 `?` 后有空白；这一形不合规范，但"空格丢了"绝不能变成"条件被静默劈成赋值"——
    // 语法层仍按条件整行收（缺空白的口径留给语义层），兜底 `否` 不许抢走一个名字的前缀。
    const root = parseText('?否定变量 == 1\n    > 一\n');
    expect(count(root, 'else_head')).toBe(0);
    expect(count(root, 'assignment')).toBe(0);
    expect(root.descendantsOfType('condition_head')[0]?.text).toBe('?否定变量 == 1');
  });

  it('`? 否` 单独仍是否则（默认分支）', () => {
    const root = parseText(['? 1 == 1', '    > 一', '? 否', '    > 二', ''].join('\n'));
    expect(faultsOf(root)).toEqual([]);
    expect(count(root, 'else_head')).toBe(1);
    expect(count(root, 'condition_head')).toBe(1);
    expect(root.descendantsOfType('else_head')[0]!.text.trim()).toBe('? 否');
  });
});

describe('`@原生` 块内 Tab 缩进与 4 空格同一棵结构', () => {
  const tabbed = '@原生\n\tIF X\n\tENDIF\n';
  const spaced = '@原生\n    IF X\n    ENDIF\n';

  it('零故障、无假表行，raw 行里的 Tab 原样保留', () => {
    const root = parseText(tabbed);
    expect(faultsOf(root), '@原生 块内 Tab 是 core 明确允许的').toEqual([]);
    expect(count(root, 'native_head')).toBe(1);
    expect(count(root, 'native_line')).toBe(2);
    expect(count(root, 'table_range'), 'Tab 行被误解成表范围').toBe(0);
    expect(root.descendantsOfType('native_line').map((n) => n.text)).toEqual(['\tIF X', '\tENDIF']);
  });

  it('与 4 空格版同构（同 str）', () => {
    expect(parseText(tabbed).toString()).toBe(parseText(spaced).toString());
  });

  it('块外 Tab 仍然只打那一行（与 broken-tab-indent 同口径）', () => {
    const root = parseText(['@算', '\t甲 = 1', '> 这一行必须照常解析。', ''].join('\n'));
    const faults = faultsOf(root);
    expect(faults.length).toBeGreaterThanOrEqual(1);
    expect(faults.every((f) => f.endsWith('@行2')), `Tab 缩进错误必须只落在那一行：${faults.join(', ')}`).toBe(true);
    expect(count(root, 'narration')).toBe(1);
  });
});

describe('`@原生{ … }` 花括号收口（§8.5 新典）', () => {
  it('紧跟 `@原生{`：head / body / close 三件齐全，收口行不进 body', () => {
    const root = parseText('@原生{\n    MOV 1 2\n}\n');
    expect(faultsOf(root)).toEqual([]);
    expect(count(root, 'native_head_braced')).toBe(1);
    expect(count(root, 'native_line')).toBe(1);
    expect(count(root, 'native_close')).toBe(1);
  });

  it('空格写法 `@原生 {` 与紧跟写法同构（与 core 词法同判，同一棵树）', () => {
    const attached = parseText('@原生{\n    MOV 1 2\n}\n');
    const spaced = parseText('@原生 {\n    MOV 1 2\n}\n');
    expect(faultsOf(spaced), '空格写法零故障').toEqual([]);
    expect(spaced.toString()).toBe(attached.toString());
  });

  it('缺收口 → 故障不可静默（MISSING native_close 占位）', () => {
    const root = parseText('@原生{\n    MOV 1 2\n');
    expect(faultsOf(root).length).toBeGreaterThanOrEqual(1);
    const closes = root.descendantsOfType('native_close');
    expect(closes.length).toBe(1);
    expect(closes[0]!.isMissing, '收口是 MISSING 占位而非实体匹配').toBe(true);
  });
});

describe('表端点 `否定` 不被兜底 `否` 吞掉', () => {
  const text = ['# 对照表 心情 依据 恋慕', '    0..99 -> 疏远', '    否定 -> 0', '    否定线.. -> 亲近', '    否 -> 未知', ''].join(
    '\n',
  );

  it('`否定 -> 0` = range `否定` / value `0`；`否 -> 未知` 仍是兜底行', () => {
    const root = parseText(text);
    expect(faultsOf(root)).toEqual([]);
    const rows = root.descendantsOfType('table_row');
    expect(rows.length).toBe(4);
    const shape = rows.map((r) => [r.childForFieldName('range')?.type, r.childForFieldName('range')?.text, r.childForFieldName('value')?.text]);
    expect(shape).toEqual([
      ['table_range', '0..99', '疏远'],
      ['table_range', '否定', '0'],
      ['table_range', '否定线..', '亲近'],
      ['table_else', '否', '未知'],
    ]);
  });
});
