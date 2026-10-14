/**
 * 语法糖契约单测（v0.3 批 S1）。
 *
 * 本批**不实现转译器**（S2 批），因此本文件只覆盖**类型层行为**：
 * - 别名四右值的类型守卫与只读判别；
 * - SugarNode 判别式 narrow 与位置字段（源映射地基）；
 * - SugarDiagnostic / 诊断码闭集；
 * - 行级源映射查询语义；
 * - golden fixture 文件的存在性与**与规范原文逐字节一致**（规范 §6 的
 *   "golden 契约"前提——若 fixture 被误改，此处先红，避免 S2 拿错基准）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCharacterAlias,
  isConditionalInterpolation,
  isExprNode,
  isHeartLine,
  isNumberAlias,
  isRawNode,
  isReadonlyAlias,
  isStringAlias,
  isTextLine,
  isTopLevelNode,
  isValueInterpolation,
  isVariableAlias,
  isWritableAlias,
  SugarCompileError,
} from '../src/sugar';
import type {
  AliasDecl,
  AliasValue,
  AliasValueKind,
  HeartLine,
  IfBlock,
  IfExpr,
  Interpolation,
  RawFunctionBlock,
  SugarDiagnostic,
  SugarDiagnosticCode,
  SugarDoc,
  SugarNode,
  SugarPosition,
  SugarSourceMapEntry,
  SugarSourceSpan,
  SugarTranspileResult,
  TextLine,
  TimingBlock,
  WhenExpr,
} from '../src/sugar';

/* ------------------------------ 构造工具 ------------------------------ */

const span = (line: number, column = 1, endLine = line, endColumn = 10): SugarSourceSpan => ({
  start: { line, column },
  end: { line: endLine, column: endColumn },
});

const alias = (name: string, value: AliasValue): AliasDecl => ({
  kind: 'aliasDecl',
  name,
  value,
  loc: span(1),
});

/** 四形态别名样本（规范 §3.1 表） */
const VARIABLE_ALIAS = alias('今天已触发', { kind: 'variable', text: 'CFLAG:TARGET:1088' });
const CHARACTER_ALIAS = alias('朋友', { kind: 'character', no: '15' });
const NUMBER_ALIAS = alias('平静', { kind: 'number', text: '0' });
const STRING_ALIAS = alias('昵称', { kind: 'string', text: '小露' });

/* ------------------------------ 别名四右值 ------------------------------ */

describe('别名 · 四种右值的类型守卫', () => {
  it('变量别名被唯一识别，且不与其它三种混淆', () => {
    const v = VARIABLE_ALIAS.value;
    expect(isVariableAlias(v)).toBe(true);
    expect(isCharacterAlias(v)).toBe(false);
    expect(isNumberAlias(v)).toBe(false);
    expect(isStringAlias(v)).toBe(false);
  });

  it('角色别名被唯一识别（携带角色编号）', () => {
    const v = CHARACTER_ALIAS.value;
    expect(isCharacterAlias(v)).toBe(true);
    expect(isVariableAlias(v)).toBe(false);
    // 类型守卫成功后可直接取形状字段（TS7 narrow 在显式守卫下可靠）
    if (isCharacterAlias(v)) expect(v.no).toBe('15');
  });

  it('数值 / 字符串字面量别名各自识别', () => {
    expect(isNumberAlias(NUMBER_ALIAS.value)).toBe(true);
    expect(isStringAlias(NUMBER_ALIAS.value)).toBe(false);
    expect(isStringAlias(STRING_ALIAS.value)).toBe(true);
    expect(isNumberAlias(STRING_ALIAS.value)).toBe(false);
  });

  it('四个守卫对同一组样本恰好各命中一个（互斥且完备）', () => {
    const samples: AliasValue[] = [
      VARIABLE_ALIAS.value,
      CHARACTER_ALIAS.value,
      NUMBER_ALIAS.value,
      STRING_ALIAS.value,
    ];
    for (const v of samples) {
      const hits = [isVariableAlias(v), isCharacterAlias(v), isNumberAlias(v), isStringAlias(v)].filter(Boolean);
      expect(hits).toHaveLength(1);
    }
  });

  it('全部四形态的 kind 取值覆盖 AliasValueKind 闭集', () => {
    const kinds: AliasValueKind[] = [VARIABLE_ALIAS, CHARACTER_ALIAS, NUMBER_ALIAS, STRING_ALIAS].map(
      (a) => a.value.kind,
    );
    expect(new Set(kinds)).toEqual(new Set(['variable', 'character', 'number', 'string']));
  });
});

describe('别名 · 只读判别（规范 §3.1 表的唯一真源）', () => {
  it('只有变量别名可写；其余三种只读', () => {
    expect(isReadonlyAlias(VARIABLE_ALIAS.value)).toBe(false);
    expect(isWritableAlias(VARIABLE_ALIAS.value)).toBe(true);

    for (const a of [CHARACTER_ALIAS, NUMBER_ALIAS, STRING_ALIAS]) {
      expect(isReadonlyAlias(a.value)).toBe(true);
      expect(isWritableAlias(a.value)).toBe(false);
    }
  });

  it('只读与可写互为补集（不存在第三种状态）', () => {
    const all: AliasValue[] = [
      VARIABLE_ALIAS.value,
      CHARACTER_ALIAS.value,
      NUMBER_ALIAS.value,
      STRING_ALIAS.value,
    ];
    for (const v of all) {
      expect(isReadonlyAlias(v)).toBe(!isWritableAlias(v));
    }
  });

  it('字面量别名的两种形态（数值 / 字符串）都只读——`0 = 1` 类产物被堵死', () => {
    expect(isWritableAlias(NUMBER_ALIAS.value)).toBe(false);
    expect(isWritableAlias(STRING_ALIAS.value)).toBe(false);
  });
});

/* ------------------------------ 节点位置 ------------------------------ */

describe('SugarNode · 源位置（源映射地基）', () => {
  it('每个节点都带 1 基行列区间', () => {
    const line: TextLine = {
      kind: 'textLine',
      speech: true,
      wait: true,
      interpolations: [],
      loc: span(6, 5, 6, 20),
    };
    expect(line.loc.start).toEqual<SugarPosition>({ line: 6, column: 5 });
    expect(line.loc.end).toEqual<SugarPosition>({ line: 6, column: 20 });
  });

  it('多行块的位置覆盖块头到块尾', () => {
    const block: IfBlock = {
      kind: 'ifBlock',
      loc: span(10, 5, 14, 1),
      branches: [
        { kind: 'if', condition: '她的恋慕', body: [], loc: span(10, 5, 10, 12) },
        { kind: 'else', condition: '', body: [], loc: span(12, 5, 12, 8) },
      ],
    };
    expect(block.loc.start.line).toBe(10);
    expect(block.loc.end.line).toBe(14);
    expect(block.branches.map((b) => b.kind)).toEqual(['if', 'else']);
  });

  it('插值节点的位置指向 `{}` 自身（可定位到列）', () => {
    const interp: Interpolation = {
      kind: 'interpolation',
      form: 'cond',
      text: '她的恋慕 ? "只有你" : ""',
      condText: '她的恋慕',
      thenText: '只有你',
      elseText: '',
      loc: span(3, 8, 3, 30),
    };
    expect(interp.loc.start.column).toBe(8);
    expect(isConditionalInterpolation(interp)).toBe(true);
  });
});

/* --------------------------- 判别式 narrow --------------------------- */

describe('SugarNode · 判别式 narrow', () => {
  const nodes: SugarNode[] = [
    { kind: 'textLine', speech: false, wait: true, interpolations: [], loc: span(1) },
    { kind: 'heartLine', speech: true, wait: false, interpolations: [], loc: span(2) },
    { kind: 'rawLine', text: 'SETCOLOR 0xFF8080', loc: span(3) },
    { kind: 'rawFunctionBlock', lines: ['@FOO', '#DIM X'], fence: true, loc: span(4, 1, 5, 1) },
    { kind: 'colorBlock', color: '0xFF8080', body: [], loc: span(6, 1, 8, 1) },
    { kind: 'randomBlock', alternatives: [], loc: span(9, 1, 12, 1) },
    { kind: 'randomInline', alternatives: ['「嗯。」', '「哦？」'], loc: span(13) },
    { kind: 'groupBlock', body: [], loc: span(13, 1, 15, 1) },
    { kind: 'choiceBlock', items: [], loc: span(14, 1, 20, 1) },
    { kind: 'whenBlock', subject: 'TFLAG:193', branches: [], loc: span(21, 1, 25, 1) },
    { kind: 'ifBlock', branches: [], loc: span(26, 1, 30, 1) },
  ];

  it('isTextLine / isHeartLine 精确命中', () => {
    expect(nodes.filter(isTextLine)).toHaveLength(1);
    expect(nodes.filter(isHeartLine)).toHaveLength(1);
    expect(nodes.find(isHeartLine)?.wait).toBe(false);
  });

  it('isRawNode 覆盖行直通与块直通两种', () => {
    const raws = nodes.filter(isRawNode);
    expect(raws).toHaveLength(2);
    expect(raws.map((n) => n.kind)).toEqual(['rawLine', 'rawFunctionBlock']);
  });

  it('表达式位置节点与语句位置节点分离', () => {
    const exprNodes: SugarNode[] = [
      { kind: 'ifExpr', target: '心情', block: { kind: 'ifBlock', branches: [], loc: span(1) }, loc: span(1) },
      { kind: 'whenExpr', target: '心情', block: { kind: 'whenBlock', subject: 'x', branches: [], loc: span(2) }, loc: span(2) },
      { kind: 'textLine', speech: true, wait: true, interpolations: [], loc: span(3) },
    ];
    expect(exprNodes.filter(isExprNode)).toHaveLength(2);
    expect(exprNodes.filter(isExprNode).map((n) => n.kind)).toEqual(['ifExpr', 'whenExpr']);
  });

  it('文档级节点守卫覆盖别名声明与时机块', () => {
    const timing: TimingBlock = {
      kind: 'timingBlock',
      face: '指令',
      index: '310',
      namedParams: [{ name: '成否', value: '游戏判定', loc: span(5, 1, 5, 20) }],
      messageCheck: [],
      body: [],
      loc: span(5, 1, 12, 1),
    };
    expect(isTopLevelNode(VARIABLE_ALIAS)).toBe(true);
    expect(isTopLevelNode(timing)).toBe(true);
  });

  it('插值形态守卫：值插值与行内条件互斥', () => {
    const value: Interpolation = { kind: 'interpolation', form: 'expr', text: '她的好感度', loc: span(1) };
    const cond: Interpolation = { kind: 'interpolation', form: 'cond', text: '条件 ? "A" : ""', loc: span(2) };
    expect(isValueInterpolation(value)).toBe(true);
    expect(isConditionalInterpolation(value)).toBe(false);
    expect(isValueInterpolation(cond)).toBe(false);
    expect(isConditionalInterpolation(cond)).toBe(true);
  });

  it('原生直通块保留原始行数组（不透明，不改写）', () => {
    const block = nodes.find((n): n is RawFunctionBlock => n.kind === 'rawFunctionBlock');
    expect(block?.lines).toEqual(['@FOO', '#DIM X']);
    expect(block?.fence).toBe(true);
  });
});

/* ------------------------------ 诊断与产物 ------------------------------ */

describe('SugarDiagnostic · 结构', () => {
  it('带 code / severity / message / loc 四要素', () => {
    const d: SugarDiagnostic = {
      code: 'expr-missing-else',
      severity: 'error',
      message: '赋值位置的「当」缺「否则」分支，左值在部分路径上不会被赋值。',
      loc: { line: 12, column: 9 },
    };
    expect(d.severity).toBe('error');
    expect(d.loc).not.toBeNull();
  });

  it('整文件级诊断允许 loc 为 null（不伪造位置）', () => {
    const d: SugarDiagnostic = {
      code: 'alias-not-in-header',
      severity: 'error',
      message: '「别名」只能写在文件头（所有时机之前）。',
      loc: null,
    };
    expect(d.loc).toBeNull();
  });

  it('诊断码闭集覆盖本批契约声明的家族（抽样校验不漂移）', () => {
    // 只校验集合形状：S2 新增走 minor，但不得临时发明字符串
    const codes: SugarDiagnosticCode[] = [
      'indent-mismatch',
      'block-empty',
      'unclosed-block',
      'expr-missing-else',
      'expr-body-not-expression',
      'rand-case-incomplete',
      'interpolation-block-expression',
      'interpolation-unclosed',
      'interpolation-nested',
      'stray-percent',
      'alias-not-in-header',
      'alias-name-conflict',
      'alias-duplicate',
      'readonly-alias-assignment',
      'alias-unknown-target',
      'timing-face-unknown',
      'timing-duplicate',
      // 产物层撞名（跨分野也算，如 `成否:` 与独立 `时机 成功` 渲染出同一个函数头）
      'function-name-duplicate',
      'timing-empty-body',
      'choice-multiple',
      'choice-nested',
      'cont-inside-quotes',
      'unknown-identifier',
      'notin-complex-operand',
      'raw-block-inline',
      'internal',
    ];
    expect(new Set(codes).size).toBe(codes.length); // 无重复
    expect(codes).toContain('readonly-alias-assignment'); // 只读别名赋值（规范 §3.1 的硬约束）
  });

  it('只读别名赋值诊断携带 span（UI 高亮整段用）', () => {
    const d: SugarDiagnostic = {
      code: 'readonly-alias-assignment',
      severity: 'error',
      message: '「平静」是只读别名（字面量），不能作赋值左值。',
      loc: { line: 20, column: 9 },
      span: span(20, 9, 20, 16),
    };
    expect(d.span?.start.line).toBe(20);
  });
});

describe('SugarTranspileResult · 行级源映射', () => {
  it('sourceMap 按产物行号升序，纯生成行 sourceLine 为 null', () => {
    const result: SugarTranspileResult = {
      erb: 'IF LOCAL\n\tPRINTFORMW 「呀……！」\nENDIF\n',
      sourceMap: [
        { generatedLine: 1, sourceLine: 6, span: span(6, 5, 6, 12) },
        { generatedLine: 2, sourceLine: 6 },
        { generatedLine: 3, sourceLine: null }, // ENDIF 为纯生成行
      ],
      diagnostics: [],
    };
    expect(result.sourceMap.map((e) => e.generatedLine)).toEqual([1, 2, 3]);
    expect(result.sourceMap[2]!.sourceLine).toBeNull();
    expect(result.sourceMap[0]!.span?.start.line).toBe(6);
  });

  it('源折行合并（`\\`）时 sourceLine 取首行，span 覆盖多行', () => {
    const entry: SugarSourceMapEntry = {
      generatedLine: 10,
      sourceLine: 4,
      span: span(4, 5, 6, 20),
    };
    expect(entry.sourceLine).toBe(4);
    expect(entry.span?.end.line).toBe(6);
  });

  it('诊断非空不必然代表失败（warning/info 可继续）', () => {
    const result: SugarTranspileResult = {
      erb: 'RETURN 1\n',
      sourceMap: [],
      diagnostics: [
        { code: 'timing-empty-body', severity: 'info', message: '该时机暂无正文，已生成占位。', loc: null },
      ],
    };
    expect(result.diagnostics.every((d) => d.severity !== 'error')).toBe(true);
  });
});

/* ------------------------------ 文档模型 ------------------------------ */

describe('SugarDoc · 形状', () => {
  it('front-matter 缺省项可不填（工具不生成对应函数）', () => {
    const doc: SugarDoc = {
      filePath: 'C:\\proj\\a.kojo',
      frontMatter: { switches: [], aliases: [] },
      topLevel: [VARIABLE_ALIAS, CHARACTER_ALIAS, NUMBER_ALIAS, STRING_ALIAS],
      diagnostics: [],
    };
    expect(doc.frontMatter.charNo).toBeUndefined();
    expect(doc.frontMatter.family).toBeUndefined();
    expect(doc.topLevel).toHaveLength(4);
    expect(doc.topLevel.every(isTopLevelNode)).toBe(true);
  });

  it('头部别名与时机混排（顺序由解析器保证，校验结果进 diagnostics）', () => {
    const timing: TimingBlock = {
      kind: 'timingBlock',
      face: '指令',
      index: '310',
      namedParams: [],
      messageCheck: [],
      body: [],
      loc: span(9, 1, 20, 1),
    };
    const doc: SugarDoc = {
      filePath: '',
      frontMatter: {
        charNo: '12',
        color: '0xE4FC08',
        narrationColor: '默认',
        switches: [{ name: '眠姦口上有', value: '是', loc: span(6, 5, 6, 16) }],
        aliases: [VARIABLE_ALIAS],
      },
      topLevel: [VARIABLE_ALIAS, timing],
      diagnostics: [
        { code: 'alias-not-in-header', severity: 'error', message: '别名出现在时机之后。', loc: { line: 21, column: 1 } },
      ],
    };
    expect(doc.frontMatter.narrationColor).toBe('默认');
    expect(doc.topLevel[1]!.kind).toBe('timingBlock');
    expect(doc.diagnostics[0]!.severity).toBe('error');
  });

  it('时机命名参数与 MESSAGECHECK 子句按源顺序保留', () => {
    const t: TimingBlock = {
      kind: 'timingBlock',
      face: '指令',
      index: '311',
      namedParams: [
        { name: '成否', value: '游戏判定', loc: span(1, 1, 1, 24) },
        { name: '类型', value: 'SCOM', loc: span(1, 25, 1, 34) },
      ],
      messageCheck: [
        { scope: 'scene', condition: '她睡着了', loc: span(2, 5, 2, 20) },
        { scope: 'kojo', condition: '她睡着了', loc: span(3, 5, 3, 20) },
      ],
      body: [],
      loc: span(1, 1, 8, 1),
    };
    expect(t.namedParams.map((p) => p.name)).toEqual(['成否', '类型']);
    expect(t.messageCheck.map((c) => c.scope)).toEqual(['scene', 'kojo']);
  });

  it('表达式 当/如果 结构：target + 块（分支体为表达式节点）', () => {
    const expr: WhenExpr = {
      kind: 'whenExpr',
      target: '心情',
      block: {
        kind: 'whenBlock',
        subject: '她的好感度',
        branches: [
          { kind: 'case', values: [{ from: '0', to: '99', loc: span(3, 9, 3, 16) }], body: [], loc: span(3, 5, 3, 20) },
          { kind: 'else', values: [], body: [], loc: span(5, 5, 5, 8) },
        ],
        loc: span(2, 5, 5, 8),
      },
      loc: span(2, 5, 5, 8),
    };
    expect(expr.target).toBe('心情');
    expect(expr.block.branches[0]!.values[0]).toMatchObject({ from: '0', to: '99' });
    expect(expr.block.branches.map((b) => b.kind)).toEqual(['case', 'else']);
  });

  it('表达式 如果 结构：target + IF 块', () => {
    const expr: IfExpr = {
      kind: 'ifExpr',
      target: '她的心情',
      block: {
        kind: 'ifBlock',
        branches: [
          { kind: 'if', condition: '她的好感度 >= 500', body: [], loc: span(1, 5, 1, 30) },
          { kind: 'else', condition: '', body: [], loc: span(3, 5, 3, 8) },
        ],
        loc: span(1, 5, 3, 8),
      },
      loc: span(1, 5, 3, 8),
    };
    expect(expr.block.branches[0]!.condition).toBe('她的好感度 >= 500');
  });
});

/* ------------------------------ golden fixture ------------------------------ */

const GOLDENS = path.resolve(import.meta.dirname, '../../plugins/kojo-sugar/tests/goldens');
const SPEC = path.resolve(import.meta.dirname, '../../../docs/SYNTAX-SUGAR-SURFACE-SPEC.md');

const read = (p: string) => fs.readFile(p, 'utf8');

/**
 * 从规范文档抽代码块：**按小节标题 + 其后的第 N 个围栏**锚定。
 *
 * 以前这里写的是 `specSlice(735, 753)` 这样的**行号区间**——规范任何一处增删行都会让
 * 四个 golden 断言整片红（本仓已经因"按行号/第一次匹配的锚点"删错过 2,935 行文档，
 * 见 IMPLEMENTATION-LOG §5.64 的教训记录）。golden 是**内容**契约，不是**行号**契约，
 * 所以锚点必须是标题与围栏这两个语义标记。
 */
async function specCodeBlock(heading: RegExp, blockIndex: number): Promise<string> {
  const lines = (await read(SPEC)).split(/\r?\n/);
  const at = lines.findIndex((l) => heading.test(l));
  if (at < 0) throw new Error(`规范里找不到小节标题 ${heading}`);
  const fences: number[] = [];
  for (let i = at + 1; i < lines.length; i++) if (/^```/.test(lines[i]!)) fences.push(i);
  const open = fences[blockIndex * 2];
  const close = fences[blockIndex * 2 + 1];
  if (open === undefined || close === undefined)
    throw new Error(`规范「${heading}」之后找不到第 ${blockIndex + 1} 个围栏代码块`);
  return `${lines.slice(open + 1, close).join('\n')}\n`;
}

describe('golden fixture · 规范 §6 示例固化', () => {
  it('两份 .kojo 源文件都在（S2 的输入基准）', async () => {
    await expect(read(path.join(GOLDENS, 'spec-6.1-lumia-310.kojo'))).resolves.toBeTruthy();
    await expect(read(path.join(GOLDENS, 'spec-6.2-choice-heart-random.kojo'))).resolves.toBeTruthy();
  });

  it('§6.1 源文件与规范原文逐字节一致', async () => {
    const fixture = await read(path.join(GOLDENS, 'spec-6.1-lumia-310.kojo'));
    // fixture 前两行为本仓注释头（// 起），不计入比对
    const body = fixture.split('\n').filter((l) => !l.startsWith('//')).join('\n');
    expect(body).toBe(await specCodeBlock(/^### 6\.1 /, 0));
  });

  it('§6.2 源文件与规范原文逐字节一致', async () => {
    const fixture = await read(path.join(GOLDENS, 'spec-6.2-choice-heart-random.kojo'));
    const body = fixture.split('\n').filter((l) => !l.startsWith('//')).join('\n');
    expect(body).toBe(await specCodeBlock(/^### 6\.2 /, 0));
  });

  it('§6.1 期望产物与规范原文逐字节一致（含 TAB 缩进与 `記入チェック` 注释行）', async () => {
    const fixture = await read(path.join(GOLDENS, 'spec-6.1-lumia-310.expected.erb.todo'));
    expect(fixture).toBe(await specCodeBlock(/^### 6\.1 /, 1));
    expect(fixture).toContain('\tPRINTFORMW 「呀……！」');
    expect(fixture).toContain(';記入チェック（=0, 非表示、1, 表示）');
    expect(fixture).toContain('@M_KOJO_MESSAGE_COM_K12_310_1');
  });

  it('§6.2 期望产物与规范原文逐字节一致（含 HPH_PRINT 与 RAND 块）', async () => {
    const fixture = await read(path.join(GOLDENS, 'spec-6.2-choice-heart-random.expected.erb.todo'));
    expect(fixture).toBe(await specCodeBlock(/^### 6\.2 /, 1));
    expect(fixture).toContain('CALL HPH_PRINT(@"……嗯。","w")');
    expect(fixture).toContain('LOCAL = RAND:2');
  });

  it('期望产物文件名保持 `.expected.erb.todo`（S1 起的冻结口径，S2 起参与逐字节比较）', async () => {
    const entries = await fs.readdir(GOLDENS);
    expect(entries.filter((e) => e.endsWith('.expected.erb')).length).toBe(0);
    // §6.1 / §6.2（规范原文）+ §3.3 旁白口径成对两张（默认 / 作者色）
    expect(entries.filter((e) => e.endsWith('.expected.erb.todo')).length).toBe(4);
  });
});

describe('编译落盘契约（v0.3 批 S3）', () => {
  it('SugarCompileError：携带目标路径 / 备份位置 / 诊断三要素', () => {
    const err = new SugarCompileError('编译被拒绝', {
      targetPath: '/g/x.ERB',
      backupPath: '/backup/x.bak',
      diagnostics: [],
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SugarCompileError');
    expect(err.targetPath).toBe('/g/x.ERB');
    expect(err.backupPath).toBe('/backup/x.bak');
    expect(err.message).toContain('编译被拒绝');
  });

  it('SugarCompileError：缺省 backupPath 归一为 null（未备份语义显式）', () => {
    const err = new SugarCompileError('写盘前拒绝', { targetPath: '/g/x.ERB' });
    expect(err.backupPath).toBeNull();
    expect(err.diagnostics).toEqual([]);
  });
});
