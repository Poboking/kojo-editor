/**
 * 本地量赋值收集 + 分支上下文 单测（v0.2 第六批）。
 *
 * 语句序列手工构造（与 scanControlFlow 的 kind/depth 约定一致），
 * 行号与源码行一一对应，验证：
 * - 赋值识别（裸名 / 下标 / `==` 不误匹配 / 复合赋值失效点 / 注释与 SKIP 块跳过）；
 * - 分支上下文路径（IF 内 / ELSE 兄弟段 / 嵌套 / 闭合后回到顶层）；
 * - extractFunctionPredicates(source) → 谓词 context + assignments。
 */
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { buildContextLookup, collectAssignments, extractFunctionPredicates } from '../src/extract';

const fn = { normalizedName: 'TEST_FUNC', filePath: 'a.erb', startLine: 1 };

function cf(rows: [string, string, number, number][]): ControlFlowStatement[] {
  return rows.map(([kind, expression, depth, line]) => ({ kind, expression, depth, line }));
}

/** 与 scanner 相同的 EOL 规范化切分 */
function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

describe('collectAssignments · 识别', () => {
  it('裸名与下标赋值；缺省下标 = 0', () => {
    const lines = toLines(['@TEST', 'LOCAL = 1', '\tLOCAL:10 = 2', 'RESULTS = "あ"'].join('\n'));
    const got = collectAssignments(lines, 2, 4, () => []);
    expect(got.map((a) => [a.name, a.index, a.text])).toEqual([
      ['LOCAL', 0, '1'],
      ['LOCAL', 10, '2'],
      ['RESULTS', 0, '"あ"'],
    ]);
  });

  it('ARG/ARGS 参数槽赋值（v0.2 第七批：口上参数补位惯用法）', () => {
    // 陷落状态（K49）的真实形态：SIF !ARG / ARG = TARGET
    const lines = toLines(['@TEST(ARG)', 'ARG = TARGET', '\tARG:1 = 0', 'ARGS = "あ"'].join('\n'));
    const got = collectAssignments(lines, 2, 4, () => []);
    expect(got.map((a) => [a.name, a.index, a.text])).toEqual([
      ['ARG', 0, 'TARGET'],
      ['ARG', 1, '0'],
      ['ARGS', 0, '"あ"'],
    ]);
  });

  it('`==` 不误匹配；复合赋值记为 opaque 失效点', () => {
    const lines = toLines(['@TEST', 'LOCAL == 1', 'LOCAL != 1', 'LOCAL >= 1', 'LOCAL:2 += 1'].join('\n'));
    const got = collectAssignments(lines, 2, 6, () => []);
    expect(got).toHaveLength(1);
    expect(got[0]!.index).toBe(2);
    expect(got[0]!.expr).toEqual({ kind: 'opaque', text: '+= 1' });
  });

  it('注释 / @#$ / SKIP 块内的行不收', () => {
    const lines = toLines([
      '@TEST',
      '; LOCAL = 99',
      '$LABEL',
      '#DIM HOGE',
      '[SKIPSTART]',
      'LOCAL = 88',
      '[SKIPEND]',
      'LOCAL = 7',
    ].join('\n'));
    const got = collectAssignments(lines, 2, 9, () => []);
    expect(got.map((a) => [a.line, a.text])).toEqual([[8, '7']]);
  });

  it('RHS 表达式解析（引用 / 算术 / 函数调用）；行内注释截断', () => {
    const lines = toLines([
      '@TEST',
      'LOCAL:2 = EXP:0 - EXP:1 ; メモ',
      'LOCAL:3 = MASTER_POSE(SET_M,1,1)',
    ].join('\n'));
    const got = collectAssignments(lines, 2, 4, () => []);
    expect(got[0]!.expr).toEqual({
      kind: 'binary',
      op: '-',
      left: { kind: 'ref', name: 'EXP', indices: ['0'], text: 'EXP:0' },
      right: { kind: 'ref', name: 'EXP', indices: ['1'], text: 'EXP:1' },
    });
    expect(got[1]!.expr).toEqual({
      kind: 'call',
      name: 'MASTER_POSE',
      args: [
        { kind: 'ref', name: 'SET_M', indices: [], text: 'SET_M' },
        { kind: 'literal', value: 1, text: '1' },
        { kind: 'literal', value: 1, text: '1' },
      ],
    });
  });
});

describe('collectAssignments · 分支上下文路径', () => {
  it('IF 内 / ELSE 兄弟段 / 嵌套 / 闭合后回到顶层', () => {
    const lines = toLines([
      '@TEST', // 1
      'LOCAL = 1', // 2        ctx []
      'IF CFLAG:2 >= 1', // 3  open d0
      'LOCAL:1 = 1', // 4      ctx [s1]
      'IF LOCAL:1', // 5       open d1
      'LOCAL:2 = 2', // 6      ctx [s1,s2]
      'ENDIF', // 7            close d1
      'ELSE', // 8             branch d0（替换 s1 段）
      'LOCAL:1 = 9', // 9      ctx [s3]（与 L4 不同段）
      'ENDIF', // 10           close d0
      'LOCAL:3 = LOCAL:1', // 11 ctx []
    ].join('\n'));
    const stmts = cf([
      ['IF', 'CFLAG:2 >= 1', 0, 3],
      ['IF', 'LOCAL:1', 1, 5],
      ['ENDIF', '', 1, 7],
      ['ELSE', '', 0, 8],
      ['ENDIF', '', 0, 10],
    ]);
    const lookup = buildContextLookup(stmts);
    const got = collectAssignments(lines, 2, 11, lookup);

    expect(got.map((a) => [a.line, a.context.length])).toEqual([
      [2, 0],
      [4, 1],
      [6, 2],
      [9, 1],
      [11, 0],
    ]);
    // 兄弟分支：同深度不同段 id
    expect(got[1]!.context).not.toEqual(got[3]!.context);
    // 嵌套：外段是内段的前缀
    expect(got[2]!.context.slice(0, 1)).toEqual(got[1]!.context);
  });
});

describe('extractFunctionPredicates · source 注入', () => {
  it('谓词获得 context；assignments 随明细产出', () => {
    const lines = toLines(['@TEST', 'LOCAL = 1', 'IF LOCAL', 'LOCAL:1 = 1', 'ENDIF'].join('\n'));
    const stmts = cf([
      ['IF', 'LOCAL', 0, 3],
      ['ENDIF', '', 0, 5],
    ]);
    const detail = extractFunctionPredicates(fn, stmts, { endLine: 5, lines });
    expect(detail.assignments.map((a) => [a.name, a.index, a.line])).toEqual([
      ['LOCAL', 0, 2],
      ['LOCAL', 1, 4],
    ]);
    expect(detail.predicates).toHaveLength(1);
    expect(detail.predicates[0]!.context).toEqual([]);
  });

  it('不提供 source → assignments 为空（聚合路径零开销）', () => {
    const detail = extractFunctionPredicates(fn, cf([['IF', 'CFLAG:2', 0, 3]]));
    expect(detail.assignments).toEqual([]);
    expect(detail.predicates[0]!.context).toBeUndefined();
  });
});
