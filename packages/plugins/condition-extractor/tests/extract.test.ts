import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { extractFunctionConditions, extractFunctionPredicates } from '../src/extract';

const fn = { normalizedName: 'TEST_FUNC', filePath: 'a.erb', startLine: 1 };

/** 构造控制流语句（kind, expression, depth, line） */
function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

describe('extractFunctionConditions · 基础', () => {
  it('IF 条件 → 依赖与阈值', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['IF', 'CFLAG:2 >= 500 && CFLAG:4 < 300', 0, 3],
        ['ENDIF', '', 0, 4],
      ]),
    );
    expect(r).not.toBeNull();
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(0);
    expect(r!.dependencies.map((d) => [d.key, d.count])).toEqual([
      ['CFLAG:2', 1],
      ['CFLAG:4', 1],
    ]);
    expect(r!.dependencies[0]!.comparisons).toEqual([{ op: '>=', value: 500, text: '500' }]);
    expect(r!.dependencies[1]!.comparisons).toEqual([{ op: '<', value: 300, text: '300' }]);
  });

  it('语言级局部量（LOCAL/ARG/RESULT/COUNT 系）不收录为依赖', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['IF', 'LOCAL', 0, 1],
        ['IF', 'ARG:1 == 1', 1, 2],
        ['IF', 'RESULTS:1 == ""', 2, 3],
        ['IF', 'COUNT == 3 || ARGS:1 != ""', 3, 4],
        ['ENDIF', '', 3, 5],
        ['ENDIF', '', 2, 6],
        ['ENDIF', '', 1, 7],
        ['ENDIF', '', 0, 8],
      ]),
    );
    expect(r!.predicateCount).toBe(4);
    expect(r!.dependencies).toEqual([]);
  });

  it('无任何条件 → null', () => {
    expect(extractFunctionConditions(fn, [])).toBeNull();
    expect(extractFunctionConditions(fn, cf([['IF', 'LOCAL', 0, 1]]))).not.toBeNull();
  });

  it('SIF 与 ELSEIF 同样抽取', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SIF', 'TALENT:恋慕', 0, 1],
        ['IF', 'LOCAL', 0, 2],
        ['ELSEIF', 'TALENT:恋人', 0, 3],
        ['ENDIF', '', 0, 4],
      ]),
    );
    expect(r!.predicateCount).toBe(3);
    expect(r!.dependencies.map((d) => d.key).sort()).toEqual(['TALENT:恋人', 'TALENT:恋慕']);
  });

  it('SIF 行尾逗号（引擎 ReduceArguments(EoL) 静默容忍）不再判 opaque', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SIF', 'FLAG:甲斐性無,', 0, 1],
        ['SIF', 'TALENT:恋慕 && CFLAG:2 >= 500,', 0, 2],
        ['SIF', 'CFLAG:2 & 1p3', 0, 3],
      ]),
    );
    expect(r).not.toBeNull();
    expect(r!.predicateCount).toBe(3);
    expect(r!.unparsedCount).toBe(0);
    // 修复前这三条全 opaque ⇒ 其依赖不收录；修复后依赖照常进表（同键合并计数）
    expect(r!.dependencies.map((d) => d.key).sort()).toEqual(['CFLAG:2', 'FLAG:甲斐性無', 'TALENT:恋慕']);
    expect(r!.dependencies.find((d) => d.key === 'CFLAG:2')!.count).toBe(2);
    expect(r!.dependencies.find((d) => d.key === 'CFLAG:2' && d.comparisons.length > 0)).toMatchObject({
      comparisons: [{ op: '>=', value: 500 }],
    });
  });

  it('SIF 逗号后仍有内容（引擎引数过多报错）→ 照旧 opaque', () => {
    const r = extractFunctionConditions(fn, cf([['SIF', 'A, B', 0, 1]]));
    expect(r!.predicateCount).toBe(1);
    expect(r!.unparsedCount).toBe(1);
  });

  it('比较符翻转（字面量在左）', () => {
    const r = extractFunctionConditions(fn, cf([['IF', '500 <= CFLAG:2', 0, 1]]));
    expect(r!.dependencies[0]!.comparisons).toEqual([{ op: '>=', value: 500, text: '500' }]);
  });

  it('重复引用合并计数、阈值去重', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['IF', 'CFLAG:2 >= 500 && CFLAG:2 <= 800', 0, 1],
        ['ELSEIF', 'CFLAG:2 >= 500', 0, 2],
        ['ENDIF', '', 0, 3],
      ]),
    );
    const dep = r!.dependencies[0]!;
    expect(dep.key).toBe('CFLAG:2');
    expect(dep.count).toBe(3);
    expect(dep.comparisons).toEqual([
      { op: '>=', value: 500, text: '500' },
      { op: '<=', value: 800, text: '800' },
    ]);
  });

  it('无法解析的条件计入 unparsedCount（不中断）', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['IF', 'X = 1', 0, 1],
        ['IF', 'CFLAG:2 >= 1', 0, 2],
      ]),
    );
    expect(r!.predicateCount).toBe(2);
    expect(r!.unparsedCount).toBe(1);
    expect(r!.dependencies.map((d) => d.key)).toEqual(['CFLAG:2']);
  });
});

describe('extractFunctionConditions · SELECTCASE 展开', () => {
  it('等值 / IS / TO / 逗号列表', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SELECTCASE', 'CFLAG:2', 0, 1],
        ['CASE', '300, 400', 0, 2],
        ['CASE', 'IS >= 500', 0, 3],
        ['CASE', '100 TO 200', 0, 4],
        ['CASEELSE', '', 0, 5],
        ['ENDSELECT', '', 0, 6],
      ]),
    );
    expect(r!.predicateCount).toBe(5); // 2 + 1 + 2；CASEELSE 不算
    const dep = r!.dependencies[0]!;
    expect(dep.key).toBe('CFLAG:2');
    expect(dep.comparisons).toEqual([
      { op: '==', value: 300, text: '300' },
      { op: '==', value: 400, text: '400' },
      { op: '>=', value: 500, text: '500' },
      { op: '>=', value: 100, text: '100' },
      { op: '<=', value: 200, text: '200' },
    ]);
  });

  it('字符串 CASE 值（subject 为非语言局部量时保留依赖）', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SELECTCASE', 'KOUJO_MODE', 0, 1],
        ['CASE', '"ENCOUNTER", "SP_EVENT"', 0, 2],
        ['ENDSELECT', '', 0, 3],
      ]),
    );
    const dep = r!.dependencies[0]!;
    expect(dep.key).toBe('KOUJO_MODE');
    expect(dep.comparisons).toEqual([
      { op: '==', value: 'ENCOUNTER', text: '"ENCOUNTER"' },
      { op: '==', value: 'SP_EVENT', text: '"SP_EVENT"' },
    ]);
  });

  it('SELECTCASE ARGS（语言局部量）不产生依赖但谓词照计', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SELECTCASE', 'ARGS', 0, 1],
        ['CASE', '"ENCOUNTER"', 0, 2],
        ['ENDSELECT', '', 0, 3],
      ]),
    );
    expect(r!.predicateCount).toBe(1);
    expect(r!.dependencies).toEqual([]);
  });

  it('嵌套 SELECTCASE：CASE 归属内层 subject；外层后续 CASE 仍用外层', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SELECTCASE', 'A', 0, 1],
        ['CASE', '1', 0, 2],
        ['SELECTCASE', 'B', 1, 3],
        ['CASE', '2', 1, 4],
        ['ENDSELECT', '', 1, 5],
        ['CASE', '3', 0, 6],
        ['ENDSELECT', '', 0, 7],
      ]),
    );
    const byKey = new Map(r!.dependencies.map((d) => [d.key, d]));
    expect(byKey.get('A')!.comparisons).toEqual([
      { op: '==', value: 1, text: '1' },
      { op: '==', value: 3, text: '3' },
    ]);
    expect(byKey.get('B')!.comparisons).toEqual([{ op: '==', value: 2, text: '2' }]);
  });

  it('引号内 TO 不误判为区间', () => {
    const r = extractFunctionConditions(
      fn,
      cf([
        ['SELECTCASE', 'STR_X', 0, 1],
        ['CASE', '"A TO B"', 0, 2],
        ['ENDSELECT', '', 0, 3],
      ]),
    );
    expect(r!.dependencies[0]!.comparisons).toEqual([{ op: '==', value: 'A TO B', text: '"A TO B"' }]);
  });
});

describe('extractFunctionConditions · schema 标注', () => {
  it('lookup 命中时附加 schema（用最后一个索引段查询）', () => {
    const calls: [string, unknown][] = [];
    const r = extractFunctionConditions(
      fn,
      cf([
        ['IF', 'CFLAG:2 >= 500', 0, 1],
        ['IF', 'CFLAG:ARG:口上セレクタ == 1', 0, 2],
      ]),
      {
        lookup: (name, index) => {
          calls.push([name, index]);
          if (name === 'CFLAG' && index === 2) return { name: 'CFLAG', index: 2, description: '好感度' };
          return undefined;
        },
      },
    );
    expect(calls).toContainEqual(['CFLAG', 2]);
    expect(calls).toContainEqual(['CFLAG', '口上セレクタ']);
    const byKey = new Map(r!.dependencies.map((d) => [d.key, d]));
    expect(byKey.get('CFLAG:2')!.schema?.description).toBe('好感度');
    expect(byKey.get('CFLAG:ARG:口上セレクタ')!.schema).toBeUndefined();
  });
});

describe('extractFunctionPredicates · 谓词明细', () => {
  it('保留逐条谓词（kind / 原文 / 行号 / 深度）与骨架', () => {
    const stmts = cf([
      ['IF', 'CFLAG:2 >= 500', 0, 3],
      ['ELSEIF', 'CFLAG:2 >= 300', 0, 5],
      ['ELSE', '', 0, 7],
      ['SIF', 'TALENT:恋慕', 1, 8],
      ['ENDIF', '', 0, 9],
      ['ENDIF', '', 0, 10],
    ]);
    const r = extractFunctionPredicates(fn, stmts);
    expect(r.normalizedName).toBe('TEST_FUNC');
    expect(r.statements).toHaveLength(6);
    expect(r.predicates.map((p) => [p.kind, p.text, p.line, p.depth])).toEqual([
      ['IF', 'CFLAG:2 >= 500', 3, 0],
      ['ELSEIF', 'CFLAG:2 >= 300', 5, 0],
      ['SIF', 'TALENT:恋慕', 8, 1],
    ]);
    expect(r.predicates[0]!.expr.kind).toBe('binary');
  });

  it('CASE 展开为多条谓词（共享来源行）', () => {
    const r = extractFunctionPredicates(
      fn,
      cf([
        ['SELECTCASE', 'CFLAG:2', 0, 1],
        ['CASE', '1, 2', 0, 2],
        ['CASE', 'IS >= 5', 0, 4],
        ['CASEELSE', '', 0, 6],
        ['ENDSELECT', '', 0, 7],
      ]),
    );
    expect(r.predicates).toHaveLength(3);
    expect(r.predicates.every((p) => p.kind === 'CASE')).toBe(true);
    expect(r.predicates[0]!.text).toBe('1, 2');
    expect(r.predicates[0]!.line).toBe(2);
    expect(r.predicates[2]!.text).toBe('IS >= 5');
  });

  it('同一 CASE 多个 TO 区间：每条半边各带 conjunction=\'and\'（分支折叠按对成组的前提）', () => {
    const r = extractFunctionPredicates(
      fn,
      cf([
        ['SELECTCASE', 'CFLAG:2', 0, 1],
        ['CASE', '1 TO 3, 5 TO 7', 0, 2],
        ['ENDSELECT', '', 0, 3],
      ]),
    );
    // 逐部分顺序 push：>=1, <=3, >=5, <=7——每两两一对即一个区间，
    // 折叠层据此成对成组（旧实现把整段 'and' 并成一组会 AND 掉两个区间）。
    expect(r.predicates).toHaveLength(4);
    expect(r.predicates.map((p) => p.conjunction)).toEqual(['and', 'and', 'and', 'and']);
    expect(r.predicates.map((p) => (p.expr.kind === 'binary' ? p.expr.op : p.expr.kind))).toEqual(['>=', '<=', '>=', '<=']);
  });

  it('opaque 谓词保留原文（不聚合、不丢弃）', () => {
    const r = extractFunctionPredicates(fn, cf([['IF', '@@bad@@', 0, 1]]));
    expect(r.predicates).toHaveLength(1);
    expect(r.predicates[0]!.expr.kind).toBe('opaque');
    expect(r.predicates[0]!.text).toBe('@@bad@@');
  });

  it('无谓词 → 空数组（与聚合视图的 null 语义不同）', () => {
    const r = extractFunctionPredicates(fn, cf([['FOR', 'LOCAL:0', 0, 1]]));
    expect(r.predicates).toEqual([]);
  });
});
