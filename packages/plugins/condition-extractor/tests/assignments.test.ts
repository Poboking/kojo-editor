/**
 * 本地量赋值收集 + 分支上下文 单测（v0.2 第六批；KW-33b 1103 写值口径补全）。
 *
 * 语句序列手工构造（与 scanControlFlow 的 kind/depth 约定一致），
 * 行号与源码行一一对应，验证：
 * - 赋值识别（裸名 / 下标 / `==` 不误匹配 / 复合赋值失效点 / 注释与 SKIP 块跳过）；
 * - 分支上下文路径（IF 内 / ELSE 兄弟段 / 嵌套 / 闭合后回到顶层）；
 * - extractFunctionPredicates(source) → 谓词 context + assignments。
 *
 * KW-33b：逐族「收 / 不收」判据在 `describe('collectAssignments · 写值写法族（KW-33b）')` 一节。
 * 盘上权威枚数（KW-33 批 census4 测绘，4,538 份 .erb/.erh 全语料，函数体内口径）——
 * **这张表既是"收哪些"的依据，也是"其余为什么不收"的留档**：
 *
 * | 族 | total | K49 体内 | 今天(改前)已收 | 本批裁定 |
 * |---|---|---|---|---|
 * | `=` 数字下标 | 131,825 | 2,520 | 131,261 | 已收（564 枚缺口归因见下） |
 * | `+= -= *= /= %=` | 3,370 | 6 | 3,370 | 已收，不动 |
 * | 后缀 `++` | 553 | 3 | 0 | **收，一律 opaque** |
 * | 后缀 `--` | 59 | 1 | 0 | **收，一律 opaque** |
 * | 前缀 `++/--` | 1 | 0 | 0 | 收（同 opaque；1 枚也收，不收得写理由） |
 * | `&= |= ^=` | 3 | 0 | 0 | 收（opaque） |
 * | `<<= >>=` | 0 | 0 | 0 | **收**（引擎记号在册，盘上 0 枚不构成"不管"的理由；不收才要理由） |
 * | `'= 字符串赋值` | 923 | 4 | 0 | **不收**（契约无素书维，见该条判据） |
 * | 动态下标写 `SLOT:(式)` | 86 | 0 | 0 | 不收（钉成反向判据） |
 * | 具名下标写 `SLOT:名` | 299 | 0 | 0 | 不收（钉成反向判据） |
 * | 多维下标写 `SLOT:1:2` | 0 | 0 | 0 | 无物（顺带钉一格，防它长出来） |
 * | `@` 前缀 + 槽位 | **0** | 0 | 0 | **任务书点名的这一族盘上零枚＝前提被证伪**，照实记档、不造判据 |
 * | 动词写值 VARSET/TIMES/SETBIT…/SPLIT | 1,641 / 1,040 / 275 / 87 | 10 / 0 / 1 / 0 | 0 | 不收：那是引擎动词行不是赋值；回放侧要建模它是另一件事 |
 *
 * `'= ` 为什么不收（实现级证据）：`FunctionAssignment['name']` 的值域是
 * `'LOCAL' | 'LOCALS' | 'RESULT' | 'RESULTS' | 'ARG' | 'ARGS'`（plugin-api/src/conditions.ts:173），
 * **没有素书（字符串）这一维**；而 `LOCAL'` 在引擎里是字符串槽、与数值 `LOCAL` 不是同一份存储。
 * 于是把 `LOCAL' = "文字列"` 折成「数值槽 LOCAL 的一次写值」＝拿字符串写当数值读来采信，
 * 是假命中的一种（本系列最贵的那种错）。要收它必须先给契约加 additive 字符串维——另一辆车。
 *
 * 564 枚缺口的归因（`=` 数字下标族 total 131,825 − 改前已收 131,261）：**逐行分桶实测 564/564 全是
 * 「右值为空」**（`RESULTS =` 收尾、或右值整段被行内注释吃掉），改前后同一条判据（右值空不是写值）；
 * 同一份测绘里新判据在该族的收数仍是 131,261——**本批在 `=` 族上零新增、零丢失**，
 * 净增只发生在复合与自增两族（复合 `&= |= ^=` 3 枚、后缀 `++` 553 + `--` 59、前缀 1 枚）。
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

describe('collectAssignments · 写值写法族（KW-33b 1103：逐族收 / 不收）', () => {
  /** 收与不收只看 (name, index, expr.kind, opaque 文本) 四元组——族判据全靠它 */
  const shape = (rows: string[]) =>
    collectAssignments(toLines(rows.join('\n')), 2, rows.length + 1, () => []).map((a) => [
      a.name,
      a.index,
      a.expr.kind,
      a.expr.kind === 'opaque' ? a.expr.text : '',
    ]);

  it('复合赋值逐族收且一律 opaque（`&= |= ^=` 在册 3 枚；盘上 0 枚的 `<<= >>=` 也收）', () => {
    const got = shape([
      '@TEST',
      'LOCAL:2 += 1',
      'LOCAL &= RESULT', // 盘上真形：LOCAL &= RESULT（fromEN/Custom_Commands/Add_Custom_SCOM5…ERB:205）
      'LOCAL |= 1',
      'LOCAL ^= (1 << MAXHOME) - 1', // 盘上真形（贈り物関連/贈り物.ERB:678）
      'LOCAL <<= 2', // 盘上 0 枚：引擎记号在册 ⇒ 收（不收才需要写理由）
      'LOCAL >>= 2',
      'LOCAL:3 %= 4',
      'LOCAL:1 -= 2',
      'LOCAL:2 /= 3',
      'LOCAL:3 *= 4',
    ]);
    expect(got).toEqual([
      ['LOCAL', 2, 'opaque', '+= 1'],
      ['LOCAL', 0, 'opaque', '&= RESULT'],
      ['LOCAL', 0, 'opaque', '|= 1'],
      ['LOCAL', 0, 'opaque', '^= (1 << MAXHOME) - 1'],
      ['LOCAL', 0, 'opaque', '<<= 2'],
      ['LOCAL', 0, 'opaque', '>>= 2'],
      ['LOCAL', 3, 'opaque', '%= 4'],
      ['LOCAL', 1, 'opaque', '-= 2'],
      ['LOCAL', 2, 'opaque', '/= 3'],
      ['LOCAL', 3, 'opaque', '*= 4'],
    ]);
  });

  it('自增自减逐族收：后缀 `++` / 后缀 `--` / 前缀 `++` / 前缀 `--`，全落 opaque', () => {
    // 盘上真形：`LOCAL:1 ++`（ANOTHER_TALK.ERB:1050）· `LOCAL:4--` 无空白（fromEN/MISC.ERB:1802）
    //           `++LOCAL`（MOVEMENTS/MOVEMENT_キャラ移動処理.ERB:182，全语料仅此 1 枚）
    expect(
      shape([
        '@TEST',
        'LOCAL:1 ++',
        'LOCAL ++',
        'LOCAL:4--',
        '++LOCAL',
        '--LOCAL:2',
        'RESULT--',
        'ARG++',
      ]),
    ).toEqual([
      ['LOCAL', 1, 'opaque', '++'],
      ['LOCAL', 0, 'opaque', '++'],
      ['LOCAL', 4, 'opaque', '--'],
      ['LOCAL', 0, 'opaque', '++'],
      ['LOCAL', 2, 'opaque', '--'],
      ['RESULT', 0, 'opaque', '--'],
      ['ARG', 0, 'opaque', '++'],
    ]);
    // 自增没有右值 ⇒ text 空、expr 只能是 opaque：旧值不可知，之后读取一律降级 unknown
    const one = collectAssignments(toLines(['@TEST', 'LOCAL:7 ++'].join('\n')), 2, 3, () => []);
    expect(one[0]!.text).toBe('');
    expect(one[0]!.expr.kind).toBe('opaque');
  });

  it(`'= 字符串赋值一枚都不收（在册 923 枚 ⇒ 反向判据；契约无素书维，收即假命中）`, () => {
    // 反证形态：运算符侧若容得下 `'`，`LOCAL' = "文字列"` 会被折成「数值槽 LOCAL 的一次写值」
    expect(
      shape([
        '@TEST',
        `LOCAL' = "文字列"`,
        `LOCALS' = "笑顔"`, // 盘上真形（GET_BODY_SETS.ERB:174）
        `RESULTS '= @"<img src='bodyGraph_X'>`, // 盘上真形（GET_BODY_SETS.ERB:28）
        `RESULT':1 = "x"`,
        `ARGS' = "y"`,
        `LOCAL'++`,
      ]),
    ).toEqual([]);
  });

  it('非字面下标写不收：动态下标 `SLOT:(式)` / 具名下标 `SLOT:名` / 多维 `SLOT:1:2`', () => {
    expect(
      shape([
        '@TEST',
        'LOCALS:(LOCAL + 1) = 1', // 动态下标（在册 86 枚）
        'RESULT:(LOCAL+1) = 2',
        'RESULT:CNT = PAIR_COLUMN_TYPE:CNT', // 具名下标（在册 299 枚）
        'LOCAL:残りムシ数 = 3', // 具名下标含 CJK
        'LOCAL:1:2 = 4', // 多维（在册 0 枚，顺带钉住防它长出来）
        'LOCALS:1 = 5', // 只有「:数字」这一形是字面下标 ⇒ 收
      ]),
    ).toEqual([['LOCALS', 1, 'literal', '']]);
  });

  it('比较与不等号依旧一枚不匹配（`== != <= >= <>`＝判据本体，扩运算符不许松动）', () => {
    expect(
      shape([
        '@TEST',
        'LOCAL == 1',
        'LOCAL != 1',
        'LOCAL <= 1',
        'LOCAL >= 1',
        'LOCAL <> 1',
        'LOCAL:2 >= 3',
        'LOCAL === 1',
      ]),
    ).toEqual([]);
  });

  it('行内注释切分挪到匹配**前**（回归判据：自增没有右值，匹配后才切就永远收不上）', () => {
    expect(
      shape([
        '@TEST',
        'LOCAL++ ; 注释',
        'LOCAL:2 += 1 ; 注释',
        'LOCAL = 1 ; 注释',
        `LOCALS = "あ;い"`, // 引号内的 `;` 不是注释（切分是引号感知的）
        'LOCAL = ; 整行没有右值',
        'LOCAL += ; 复合赋值也没有右值',
      ]),
    ).toEqual([
      ['LOCAL', 0, 'opaque', '++'],
      ['LOCAL', 2, 'opaque', '+= 1'],
      ['LOCAL', 0, 'literal', ''],
      ['LOCALS', 0, 'literal', ''],
    ]);
  });

  it('裸引用行 / 畸形行不是写值；右值里的 `++` 由赋值档整段接走', () => {
    // `LOCAL = LOCAL++`：先被赋值档收走，RHS 逐字保留（expr 层认后缀 `++` ⇒ unary 节点），
    // 不拆成两条写值；`LOCAL ++ = 1` / `LOCAL + LOCAL ++` 这类没有单一左值的形一律不收。
    expect(shape(['@TEST', 'LOCAL', 'LOCAL:12', 'LOCAL ++ = 1', 'LOCAL + LOCAL ++', 'LOCAL = LOCAL++'])).toEqual([
      ['LOCAL', 0, 'unary', ''],
    ]);
  });

  it('真形回归：`;!;` 代码前缀与 SKIP 块对自增同样有效（切注释 / erbCodeBodyOf 的次序）', () => {
    expect(
      shape(['@TEST', ';!;LOCAL++', '; LOCAL++', '[SKIPSTART]', 'LOCAL++', '[SKIPEND]', 'LOCAL--']),
    ).toEqual([
      ['LOCAL', 0, 'opaque', '++'],
      ['LOCAL', 0, 'opaque', '--'],
    ]);
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
