/**
 * eraTW `KojoEmitBackend` 测试（E4 backend 半边）。
 *
 * 三层：
 * 1) **单元**：文本三正交变体/心形四象限/着色配对/颜绘实参处理/随机两种落点/`@织`
 *    优先级属性/`@算` program/`# 机` wrapper（body 连续子序列 + slots 声明）；
 * 2) **fail-closed**：不可表达构造（作者文本含 NUL、没有口上模板、缺 charNo、@巡 绑定缺失）
 *    必须返回诊断且不产半成品字节；
 * 3) **集成 golden**：`@kojo/plugin-kojo-sugar` 的 `createKojo2TranspileService`
 *    + `ERATW_GAME_ADAPTER` + 本 backend 跑 canonical `.kojo2` → ERB 逐字节 golden。
 */
import { describe, expect, it } from 'vitest';

import type {
  BlankEmitRequest,
  EmitFailure,
  EmitResult,
  FaceEmitRequest,
  KojoEmitBackend,
  KojoExprText,
  KojoSpan,
  MachineWrapRequest,
  RandomEmitRequest,
  TextEmitRequest,
} from '@kojo/kojo-core';
import { isEmitFailure } from '@kojo/kojo-core';

import { createKojo2TranspileService } from '@kojo/plugin-kojo-sugar';

import { ERATW_DOMAIN_SYMBOLS, ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { createEratwEmitBackend, eratwLoweringProfile } from '../../src/kojo2/backend.js';

/* ============================== 测试替身 ============================== */

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } };

function expr(text: string): KojoExprText {
  return { text, span: SPAN };
}

/**
 * 确定性表达式替身（集成 golden 用）：**只做域符号替换**，不做真正的表达式编译。
 *
 * 真管线由宿主注入 v1 `lowerExpression`；这里把 `{我}`/`{你}`/`{她}` 换成引擎引用、
 * 把已声明角色属性换成 `族:TARGET:名`，足够钉 backend 的产物结构。
 * 字符串字面量里的字（`"你最近……"`）是正文，不替换。
 */
function fakeCompileExpression(value: KojoExprText): string {
  const substitute = (chunk: string): string => {
    let text = chunk;
    for (const pronoun of ERATW_DOMAIN_SYMBOLS.pronouns) {
      text = text.replaceAll(pronoun.pronoun, pronoun.engineRef.replaceAll('%', ''));
    }
    for (const attribute of ERATW_DOMAIN_SYMBOLS.attributes) {
      text = text.replaceAll(attribute.name, `${attribute.family}:TARGET:${attribute.name}`);
    }
    return text;
  };
  return value.text
    .split('"')
    .map((chunk, index) => (index % 2 === 0 ? substitute(chunk) : chunk))
    .join('"');
}

function backend(overrides: { charNo?: string } = {}): KojoEmitBackend {
  return createEratwEmitBackend({
    compileExpression: fakeCompileExpression,
    charNo: overrides.charNo ?? '12',
  });
}

function textLine(overrides: Partial<TextEmitRequest> = {}): TextEmitRequest {
  return {
    speech: { kind: 'dialogue', speaker: '灵梦' },
    speaker: '灵梦',
    defaultSpeaker: null,
    parts: [{ kind: 'text', text: '……好。' }],
    wait: 'wait',
    color: { kind: 'profile' },
    hint: null,
    hintRole: null,
    span: SPAN,
    ...overrides,
  };
}

function failureOf(result: EmitResult): EmitFailure {
  if (!isEmitFailure(result)) throw new Error(`expected EmitFailure, got ${JSON.stringify(result)}`);
  return result;
}

const asLines = (result: EmitResult): readonly string[] => {
  if (typeof result === 'string') return [result];
  if (result === null || isEmitFailure(result)) throw new Error('expected lines');
  return result;
};

/* ============================== 1. 数据派生 ============================== */

describe('eraTW backend：profile 从 kojo2 数据派生', () => {
  it('取色/等待/池/随机读数 = adapter profile；演出面 = presentation 非空项', () => {
    const profile = eratwLoweringProfile();
    expect(profile.waitDefault).toBe('wait');
    expect(profile.narrationColor).toBe('author');
    expect(profile.dialogueColor).toBe('author');
    expect(profile.colorMode).toBe('D');
    expect(profile.poolStyle).toBe('if');
    expect(profile.randStyle).toBe('printdata');
    expect(profile.presentations).toEqual({
      heart: true,
      color: true,
      face: true,
      random: true,
      options: true,
    });
    expect(profile.programFeatures).toEqual({ arrays: true, while: true, goto: true, recursion: true, foreach: true, repeat: true });
  });

  it('priorityModel 由事件目录推：九事件全是 emuera-buckets → 修饰词可用', () => {
    expect(eratwLoweringProfile().priorityModel).toBe('emuera-buckets');
  });

  it('hintSupport：只有 `心形` 是 adapter 认的演出提示，其余是导演批注', () => {
    const b = backend();
    expect(b.hintSupport('心形')).toBe('supported');
    expect(b.hintSupport('微笑')).toBe('annotation');
    expect(b.hintSupport('别过头')).toBe('annotation');
  });
});

/* ============================== 2. 文本三正交 ============================== */

describe('eraTW backend：文本三正交（PRINTFORM 变体）', () => {
  it('旁白 + 作者色（narrationColor=author）→ 非 D：PRINTFORMW', () => {
    expect(
      backend().text.line(
        textLine({
          speech: { kind: 'narration' },
          speaker: null,
          parts: [{ kind: 'text', text: '她轻轻关上了门。' }],
        }),
      ),
    ).toBe('PRINTFORMW 她轻轻关上了门。');
  });

  it('台词 → 恒非 D；`续` → L：PRINTFORML', () => {
    expect(backend().text.line(textLine({ wait: 'continue' }))).toBe('PRINTFORML ……好。');
  });

  it('块色（@着色 内）→ 非 D（D 系忽略 SETCOLOR）', () => {
    const result = backend().text.line(
      textLine({
        speech: { kind: 'narration' },
        speaker: null,
        parts: [{ kind: 'text', text: '她的耳朵也红了。' }],
        color: { kind: 'block', color: expr('0xFF8080') },
      }),
    );
    expect(result).toBe('PRINTFORMW 她的耳朵也红了。');
  });

  it('插值拼装：`{你}` → %CALLNAME:MASTER%`（表达式端口注入）', () => {
    const result = backend().text.line(
      textLine({ parts: [{ kind: 'text', text: '{你}今天来得挺早嘛。' }] }),
    );
    // 文本片段里的 `{` 是作者字面量（会被格式串转义），插值走 interp 片段
    expect(result).toBe('PRINTFORMW \\{你\\}今天来得挺早嘛。');

    const interp = backend().text.line(
      textLine({
        parts: [
          { kind: 'text', text: '「' },
          { kind: 'interp', expr: expr('你') },
          { kind: 'text', text: '今天来得挺早嘛。」' },
        ],
      }),
    );
    expect(interp).toBe('PRINTFORMW 「%CALLNAME:MASTER%今天来得挺早嘛。」');
  });

  it('行内条件插值 → \\@条件?A#B\\@', () => {
    const cond = {
      cond: expr('恋慕 >= 亲近线'),
      then: expr('"你最近……有点不一样。"'),
      else: expr('"今天也一起加油吧。"'),
    };
    const result = backend().text.line(
      textLine({ parts: [{ kind: 'interp', expr: expr('恋慕'), cond }] }),
    );
    expect(result).toBe(
      'PRINTFORMW \\@TALENT:TARGET:恋慕 >= 亲近线?"你最近……有点不一样。"#"今天也一起加油吧。"\\@',
    );
  });

  it('未声明的行尾提示 = 导演批注：不打印，只留 `;` 注释', () => {
    const result = backend().text.line(textLine({ hint: '微笑', hintRole: 'annotation' }));
    expect(result).toBe('PRINTFORMW ……好。 ;(微笑)');
  });

  it('`(心形)` 四象限：台词 w/l、旁白 dw/dl', () => {
    const b = backend();
    const heartLine = (speech: 'dialogue' | 'narration', wait: 'wait' | 'continue'): EmitResult =>
      b.text.line(
        textLine({
          speech: speech === 'dialogue' ? { kind: 'dialogue', speaker: '灵梦' } : { kind: 'narration' },
          wait,
          hint: '心形',
          hintRole: 'supported',
        }),
      );
    expect(heartLine('dialogue', 'wait')).toBe('CALL HPH_PRINT(@"……好。","w")');
    expect(heartLine('dialogue', 'continue')).toBe('CALL HPH_PRINT(@"……好。","l")');
    expect(heartLine('narration', 'wait')).toBe('CALL HPH_PRINT(@"……好。","dw")');
    expect(heartLine('narration', 'continue')).toBe('CALL HPH_PRINT(@"……好。","dl")');
  });

  it('空行三态：等待 → PRINTFORMDW，续 → PRINTFORML', () => {
    const b = backend();
    const blank = (wait: 'wait' | 'continue'): BlankEmitRequest => ({ wait, span: SPAN });
    expect(b.blank.line(blank('wait'))).toBe('PRINTFORMDW');
    expect(b.blank.line(blank('continue'))).toBe('PRINTFORML');
  });

  it('作者文本含 NUL → fail-closed（core 编码器给诊断，不产半成品）', () => {
    const result = backend().text.line(
      textLine({ parts: [{ kind: 'text', text: '坏\u0000文本' }] }),
    );
    const failure = failureOf(result);
    expect(failure.diagnostics[0]?.code).toBe('core/expr/bad-literal');
    expect(failure.diagnostics.length).toBeGreaterThan(0);
  });
});

/* ============================== 3. 演出 ============================== */

describe('eraTW backend：着色 / 颜绘', () => {
  it('@着色 → SETCOLOR <表达式> … RESETCOLOR（配对由 core 编排）', () => {
    const b = backend();
    expect(b.presentation.colorEnter(expr('0xFF8080'))).toBe('SETCOLOR 0xFF8080');
    expect(b.presentation.colorExit()).toBe('RESETCOLOR');
  });

  it('@颜绘 我：默认表情补 通常；裸词成字符串字面量', () => {
    const b = backend();
    expect(b.presentation.face({ object: 'me', args: [], span: SPAN })).toBe(
      'CALL PRINT_FACE, TARGET, "通常"',
    );
    expect(
      b.presentation.face({ object: null, args: [expr('笑顔'), expr('服1')], span: SPAN }),
    ).toBe('CALL PRINT_FACE, TARGET, "笑顔", "服1"');
  });

  it('@颜绘 你 → PRINT_FACE_PLAYER, MASTER', () => {
    expect(backend().presentation.face({ object: 'you', args: [expr('自慰'), expr('裸')], span: SPAN })).toBe(
      'CALL PRINT_FACE_PLAYER, MASTER, "自慰", "裸"',
    );
  });

  it('尾部空占位省略、内部 "" 保留（跳过前一格）', () => {
    const b = backend();
    expect(b.presentation.face({ object: 'me', args: [expr('発情'), expr('裸'), expr('')], span: SPAN })).toBe(
      'CALL PRINT_FACE, TARGET, "発情", "裸"',
    );
    expect(b.presentation.face({ object: 'me', args: [expr('発情'), expr(''), expr('_1')], span: SPAN })).toBe(
      'CALL PRINT_FACE, TARGET, "発情", "", "_1"',
    );
  });
});

/* ============================== 4. 随机 ============================== */

function randomRequest(overrides: Partial<RandomEmitRequest> = {}): RandomEmitRequest {
  return {
    purity: 'single-line-text',
    candidates: [],
    slot: '__kojo_rand_9',
    span: SPAN,
    ...overrides,
  };
}

describe('eraTW backend：@随机 两种落点', () => {
  it('纯文本单行 + 全 `续` → PRINTDATA/DATAFORM/ENDDATA', () => {
    const lines = [
      { kind: 'textLine' as const, speech: { kind: 'dialogue' as const, speaker: '灵梦' }, parts: [{ kind: 'text' as const, text: '……呼。' }], wait: 'continue' as const, span: SPAN },
      { kind: 'textLine' as const, speech: { kind: 'dialogue' as const, speaker: '灵梦' }, parts: [{ kind: 'text' as const, text: '再、再摸摸嘛。' }], wait: 'continue' as const, span: SPAN },
    ];
    const request = randomRequest({
      candidates: lines.map((line) => ({ kind: 'randomLine' as const, line, span: SPAN })),
    });
    expect(asLines(backend().presentation.randomBlock(request, () => []))).toEqual([
      'PRINTDATA',
      '    DATAFORM ……呼。',
      '    DATAFORM 再、再摸摸嘛。',
      'ENDDATA',
    ]);
  });

  it('纯文本单行 + 全等待 → PRINTDATA/ENDDATA 后补一行 WAIT', () => {
    const line = {
      kind: 'textLine' as const,
      speech: { kind: 'dialogue' as const, speaker: '灵梦' },
      parts: [{ kind: 'text' as const, text: '……呼。' }],
      wait: 'wait' as const,
      span: SPAN,
    };
    const request = randomRequest({ candidates: [{ kind: 'randomLine' as const, line, span: SPAN }] });
    expect(asLines(backend().presentation.randomBlock(request, () => []))).toEqual([
      'PRINTDATA',
      '    DATAFORM ……呼。',
      'ENDDATA',
      'WAIT',
    ]);
  });

  it('纯文本单行但等待轴混合 → fail-closed（PRINTDATA 不能逐候选等待）', () => {
    const makeLine = (text: string, wait: 'wait' | 'continue'): {
      readonly kind: 'randomLine';
      readonly line: {
        readonly kind: 'textLine';
        readonly speech: { readonly kind: 'dialogue'; readonly speaker: string };
        readonly parts: readonly { readonly kind: 'text'; readonly text: string }[];
        readonly wait: 'wait' | 'continue';
        readonly span: KojoSpan;
      };
      readonly span: KojoSpan;
    } => ({
      kind: 'randomLine',
      line: { kind: 'textLine', speech: { kind: 'dialogue', speaker: '灵梦' }, parts: [{ kind: 'text', text }], wait, span: SPAN },
      span: SPAN,
    });
    const request = randomRequest({ candidates: [makeLine('甲。', 'wait'), makeLine('乙。', 'continue')] });
    const failure = failureOf(backend().presentation.randomBlock(request, () => []));
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('等待轴');
  });

  it('@组 多行候选 → RAND+SELECTCASE（候选行来自 core 回调）', () => {
    const group = { kind: 'randomGroup' as const, body: [], span: SPAN };
    const request = randomRequest({ purity: 'group-text', candidates: [group, group] });
    const lines = asLines(
      backend().presentation.randomBlock(request, (_candidate, index) => [`PRINTFORMW 候选${index}`]),
    );
    expect(lines).toEqual([
      '__kojo_rand_9 = RAND:2',
      'SELECTCASE __kojo_rand_9',
      '    CASE 0',
      '        PRINTFORMW 候选0',
      '    CASE 1',
      '        PRINTFORMW 候选1',
      'ENDSELECT',
    ]);
  });
});

/* ============================== 5. @织 ============================== */

describe('eraTW backend：@织 监听头', () => {
  it('之后 → #LATER；之前 → #PRI；接管 → #ONLY', () => {
    const b = backend();
    expect(asLines(b.weave.weaveHeader({ event: '回合末', args: [], modifiers: ['later'], span: SPAN, slots: [] }))).toEqual([
      ';kojo2: @织 回合末',
      '@EVENTTURNEND',
      '#LATER',
    ]);
    expect(asLines(b.weave.weaveHeader({ event: '初见', args: [], modifiers: ['pri'], span: SPAN, slots: [] }))).toEqual([
      ';kojo2: @织 初见',
      '@EVENTFIRST',
      '#PRI',
    ]);
    expect(asLines(b.weave.weaveHeader({ event: '读档', args: [], modifiers: ['only'], span: SPAN, slots: [] }))).toEqual([
      ';kojo2: @织 读档',
      '@EVENTLOAD',
      '#ONLY',
    ]);
  });

  it('无修饰词 → 普通桶（不发 # 属性）', () => {
    expect(asLines(backend().weave.weaveHeader({ event: '训练', args: [], modifiers: [], span: SPAN, slots: [] }))).toEqual([
      ';kojo2: @织 训练',
      '@EVENTTRAIN',
    ]);
  });

  it('监听函数按自己的 slots 发 #DIM/#DIMS（声明形态取 core 的 valueType 事实）', () => {
    const b = backend();
    const header = asLines(
      b.weave.weaveHeader({
        event: '回合末',
        args: [],
        modifiers: ['later'],
        span: SPAN,
        slots: [
          { name: '__kojo_table_心情', kind: 'table', valueType: 'int' },
          { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string' },
          { name: '__kojo_rand_40', kind: 'random', valueType: 'int' },
          // 池主语槽（kind 是池自己的事实）：声明形态仍只由 valueType 决定 → #DIM
          { name: '__kojo_pool_等级问候', kind: 'pool', valueType: 'int', role: 'pool-subject' },
        ],
      }),
    );
    expect(header).toEqual([
      ';kojo2: @织 回合末',
      '@EVENTTURNEND',
      '#LATER',
      '#DIM __kojo_table_心情',
      '#DIMS __kojo_table_心情__value',
      '#DIM __kojo_rand_40',
      '#DIM __kojo_pool_等级问候',
    ]);
    b.weave.weaveFooter();
  });

  it('未知事件 → fail-closed（core 已校验，backing 仍不猜）', () => {
    expect(failureOf(backend().weave.weaveHeader({ event: '隐藏情景', args: [], modifiers: [], span: SPAN, slots: [] })).diagnostics[0]?.code).toBe(
      'unit/backend-incomplete',
    );
  });
});

/* ============================== 6. program ============================== */

describe('eraTW backend：@算 / program 语句', () => {
  it('赋值/调用/表达式调用/循环/跳转/返回', () => {
    const b = backend();
    expect(b.program.assign({ target: { text: '心情快照', span: SPAN }, op: '=', value: expr('心情'), span: SPAN })).toBe(
      '心情快照 = 心情',
    );
    expect(b.program.assign({ target: { text: '体力恢复', span: SPAN }, op: '+=', value: expr('10'), span: SPAN })).toBe(
      '体力恢复 += 10',
    );
    expect(b.program.call({ name: '记录', args: [expr('"一条记录"')], span: SPAN })).toBe('CALL 记录("一条记录")');
    expect(b.program.exprCall({ call: expr('增加羁绊(目标, 10)'), span: SPAN })).toBe('增加羁绊(目标, 10)');
    expect(b.program.whileHeader(expr('体力恢复 < 100'))).toBe('WHILE 体力恢复 < 100');
    expect(b.program.whileFooter()).toBe('WEND');
    expect(b.program.repeatHeader(expr('3'))).toBe('REPEAT 3');
    expect(b.program.repeatFooter()).toBe('REND');
    expect(b.program.loopJump('break')).toBe('BREAK');
    expect(b.program.loopJump('continue')).toBe('CONTINUE');
    expect(b.program.label('主菜单')).toBe('$主菜单');
    expect(b.program.jump('战斗')).toBe('GOTO 战斗');
    expect(b.program.returnValue(expr('数值'))).toBe('RETURN 数值');
    expect(b.program.returnValue(null)).toBe('RETURN');
    expect(b.program.sandboxEnter()).toBeNull();
    expect(b.program.sandboxExit()).toBeNull();
  });

  it('@巡 绑定未声明 → fail-closed（不猜 {值}/{下标}）', () => {
    const failure = failureOf(backend().program.forEachHeader(expr('队伍')));
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('@巡');
  });
});

/* ============================== 7. # 机 wrapper ============================== */

const MACHINE = {
  kind: 'machine' as const,
  event: '指令',
  args: ['310'],
  span: SPAN,
};

describe('eraTW backend：wrapMachine 事件头', () => {
  it('从 face-templates 派生根机函数名：wrapper + 伴生 _1 + 記入チェック信封', () => {
    const request: MachineWrapRequest = {
      machine: MACHINE,
      body: ['PRINTFORMW 「……好。」'],
      view: '灵梦',
      slots: [],
    };
    const lines = asLines(backend().wrapMachine?.(request) ?? null);
    expect(lines[0]).toBe(';kojo2: # 机 指令 310');
    expect(lines[1]).toBe('@M_KOJO_MESSAGE_COM_K12_310(ARG)');
    expect(lines[2]).toBe('CALL M_KOJO_MESSAGE_COM_K12_310_1(ARG)');
    expect(lines[3]).toBe('RETURN RESULT');
    expect(lines[5]).toBe('@M_KOJO_MESSAGE_COM_K12_310_1(ARG)');
    expect(lines).toContain('LOCAL = 1');
    expect(lines).toContain('IF LOCAL');
    expect(lines).toContain('    PRINTFORMW 「……好。」');
    expect(lines).toContain('ENDIF');
    expect(lines[lines.length - 1]).toBe('RETURN 1');
  });

  it('body 行按契约原样嵌入（trimStart 逐字相等、顺序一致）', () => {
    const body = ['PRINTFORML ……早。', '', 'CALL HPH_PRINT(@"……嗯。","w")'];
    const request: MachineWrapRequest = { machine: MACHINE, body, view: null, slots: [] };
    const lines = asLines(backend().wrapMachine?.(request) ?? null);
    const start = lines.findIndex((line) => line.trimStart() === body[0]);
    expect(start).toBeGreaterThan(0);
    for (let i = 0; i < body.length; i++) {
      expect(lines[start + i]?.trimStart()).toBe(body[i]);
    }
  });

  it('slots → 函数头 `#DIM/#DIMS` 声明（按 core 的 valueType；紧贴 @ 行、不反推 body）', () => {
    const request: MachineWrapRequest = {
      machine: MACHINE,
      body: ['__kojo_rand_9 = RAND:2', 'SELECTCASE __kojo_rand_9'],
      view: null,
      slots: [
        { name: '__kojo_table_心情', kind: 'table', valueType: 'int' },
        { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string' },
        { name: '__kojo_rand_9', kind: 'random', valueType: 'int' },
        // 整数表：判别槽与结果值槽都是 int → 都是 #DIM（不再靠 __value 后缀猜）
        { name: '__kojo_table_档位', kind: 'table', valueType: 'int' },
        { name: '__kojo_table_档位__value', kind: 'table', valueType: 'int' },
        // 池主语槽：kind=pool 与 template 同一落点（#DIM）
        { name: '__kojo_pool_等级问候', kind: 'pool', valueType: 'int', role: 'pool-subject' },
      ],
    };
    const lines = asLines(backend().wrapMachine?.(request) ?? null);
    const head = lines.indexOf('@M_KOJO_MESSAGE_COM_K12_310_1(ARG)');
    expect(lines[head + 1]).toBe('#DIM __kojo_table_心情');
    expect(lines[head + 2]).toBe('#DIMS __kojo_table_心情__value');
    expect(lines[head + 3]).toBe('#DIM __kojo_rand_9');
    expect(lines[head + 4]).toBe('#DIM __kojo_table_档位');
    expect(lines[head + 5]).toBe('#DIM __kojo_table_档位__value');
    expect(lines[head + 6]).toBe('#DIM __kojo_pool_等级问候');
  });

  it('无状态：两次 wrapMachine 各自按自己的 slots 声明，互不影响', () => {
    const b = backend();
    const withSlot = (name: string): MachineWrapRequest => ({
      machine: MACHINE,
      body: [],
      view: null,
      slots: [{ name, kind: 'random', valueType: 'int' }],
    });
    expect(asLines(b.wrapMachine?.(withSlot('__kojo_rand_1')) ?? null)).toContain('#DIM __kojo_rand_1');
    expect(asLines(b.wrapMachine?.(withSlot('__kojo_rand_2')) ?? null)).toContain('#DIM __kojo_rand_2');
  });

  it('缺 charNo（模板要 {n}）→ fail-closed', () => {
    const b = backend({ charNo: '' });
    const failure = failureOf(
      b.wrapMachine?.({ machine: MACHINE, body: ['PRINTFORML x'], view: null, slots: [] }) ?? null,
    );
    expect(failure.diagnostics[0]?.message).toContain('charNo');
  });

  it('没有口上模板的事件（训练）→ fail-closed，不手抄第二套命名', () => {
    const failure = failureOf(
      backend().wrapMachine?.({
        machine: { kind: 'machine', event: '训练', args: [], span: SPAN },
        body: ['PRINTFORML x'],
        view: null,
        slots: [],
      }) ?? null,
    );
    expect(failure.diagnostics[0]?.message).toContain('face-templates');
  });

  it('初见面（无 {i}/无参数）→ @M_KOJO_ENCOUNTER_K12', () => {
    const lines = asLines(
      backend().wrapMachine?.({
        machine: { kind: 'machine', event: '初见', args: [], span: SPAN },
        body: [],
        view: '灵梦',
        slots: [],
      }) ?? null,
    );
    expect(lines[1]).toBe('@M_KOJO_ENCOUNTER_K12');
    expect(lines).toContain('LOCAL = 0');
  });
});

/* ============================== 8. 集成 golden ============================== */

/**
 * canonical 2.0 源（取自 core fixture，去掉两处本批不发射的构造：
 * `选项`（2.0 待定 UI）与 `@巡`（绑定数据待声明））。
 */
const CANONICAL_SOURCE = `# 幕 神社清晨
# 视角 灵梦
# 机 指令 310
# 设 亲近线 整数 = 500
# 设 今天已触发 整数 = 0 存档
# 设 心情快照 字符串 场景
# 设 队列 整数[10]
# 设 队员 字符串[4] 存档
# 设 人数 整数
# 对照表 心情 依据 恋慕
    0..99 -> 疏远
    100..499 -> 平常
    亲近线.. -> 亲近
    否 -> 未知
# 对照表 档位 依据 好感度
    0..99 -> 1
    100..499 -> 2
    否 -> 0
# 池 早安问候
    ? 恋慕 < 100
        「……早。」
    ? 恋慕 < 500
        「早上好，今天天气不错呢。」
    ? 否
        「亲爱的，早安~」(拥抱)
        > 她把脸埋进你的肩膀。
# 模 娇羞退场(原因)
    > （她红着脸，因为{原因}而不知所措）
    [插槽]
    > （随后匆匆跑开了）
@织 回合末 之后
    ? 天气 == 雨
        > 雨声盖住了她的脚步。
    ? 否
        > 她轻轻关上了门。
> 晨光透过鸟居，斑驳地洒在石阶上。
灵梦：「{你}今天来得挺早嘛。」(微笑)
灵梦：「{恋慕 >= 亲近线 ? "你最近……有点不一样。" : "今天也一起加油吧。"}」
> 她今天看起来{心情}。
> 好感度档位：{档位}。
灵梦：「……好。」 续
@算
    心情快照 = 心情
    队列[0] = 3
    人数 = 队列.长度
@着色 0xFF8080
    灵梦：「这行是红色。」
    > 她的耳朵也红了。
@颜绘 笑顔 服1
@颜绘 你 自慰 裸
@随机
    灵梦：「……呼。」
    @组
        灵梦：「再、再摸摸嘛。」
        > 她把脸别了过去。
? 恋慕 >= 500
    灵梦：「其实……{我}一直在等你。」(心形)
? 否
    灵梦：「……早。」
! 早安问候
! 娇羞退场("被夸奖")
    灵梦：「才、才没有很开心呢！」
空行
空行 等待
空行 续
? 心情快照 == "亲近"
    > 她看你的眼神比平时更软。
@原生
    ; 逃生舱：底层 ERB 代码
    CALL HPH_PRINT "w"
@标 主菜单
> 请选择你的行动：
? 人数 == 1
    @跳 战斗
? 否
    @跳 主菜单
@标 战斗
> 你拔出了武器……
`;

/**
 * canonical 源的期望 ERB（**逐字节 golden**）。
 *
 * 结构：`# 机` wrapper（口上函数 `M_KOJO_MESSAGE_COM_K12_310` + 伴生 `_1` + 隐藏槽
 * `#DIM/#DIMS` + v1 記入チェック信封）→ 正文（文本三正交/表/池/模/着色/颜绘/随机/
 * 心形/空行/原生）→ `@织` 独立监听函数（`@EVENTTURNEND` + `#LATER`）。
 */
const CANONICAL_GOLDEN = String.raw`;kojo2: # 机 指令 310
@M_KOJO_MESSAGE_COM_K12_310(ARG)
CALL M_KOJO_MESSAGE_COM_K12_310_1(ARG)
RETURN RESULT

@M_KOJO_MESSAGE_COM_K12_310_1(ARG)
#DIM __kojo_table_心情
#DIMS __kojo_table_心情__value
#DIM __kojo_table_档位
#DIM __kojo_table_档位__value
#DIM __kojo_rand_51
;-------------------------------------------------
;記入チェック（=0, 非表示、1, 表示）
LOCAL = 1
;-------------------------------------------------
IF LOCAL
    PRINTFORMW 晨光透过鸟居，斑驳地洒在石阶上。
    PRINTFORMW %CALLNAME:MASTER%今天来得挺早嘛。 ;(微笑)
    PRINTFORMW \@TALENT:TARGET:恋慕 >= 亲近线?"你最近……有点不一样。"#"今天也一起加油吧。"\@
    __kojo_table_心情 = TALENT:TARGET:恋慕
    IF __kojo_table_心情 >= 0 && __kojo_table_心情 <= 99
    __kojo_table_心情__value = "疏远"
    ELSEIF __kojo_table_心情 >= 100 && __kojo_table_心情 <= 499
    __kojo_table_心情__value = "平常"
    ELSEIF __kojo_table_心情 >= 500
    __kojo_table_心情__value = "亲近"
    ELSE
    __kojo_table_心情__value = "未知"
    ENDIF
    PRINTFORMW 她今天看起来%__kojo_table_心情__value%。
    __kojo_table_档位 = CFLAG:TARGET:好感度
    IF __kojo_table_档位 >= 0 && __kojo_table_档位 <= 99
    __kojo_table_档位__value = 1
    ELSEIF __kojo_table_档位 >= 100 && __kojo_table_档位 <= 499
    __kojo_table_档位__value = 2
    ELSE
    __kojo_table_档位__value = 0
    ENDIF
    PRINTFORMW 好感度档位：%__kojo_table_档位__value%。
    PRINTFORML ……好。
    __kojo_table_心情 = TALENT:TARGET:恋慕
    IF __kojo_table_心情 >= 0 && __kojo_table_心情 <= 99
    __kojo_table_心情__value = "疏远"
    ELSEIF __kojo_table_心情 >= 100 && __kojo_table_心情 <= 499
    __kojo_table_心情__value = "平常"
    ELSEIF __kojo_table_心情 >= 500
    __kojo_table_心情__value = "亲近"
    ELSE
    __kojo_table_心情__value = "未知"
    ENDIF
    心情快照 = __kojo_table_心情__value
    队列[0] = 3
    人数 = 队列.长度
    SETCOLOR 0xFF8080
    PRINTFORMW 这行是红色。
    PRINTFORMW 她的耳朵也红了。
    RESETCOLOR
    CALL PRINT_FACE, TARGET, "笑顔", "服1"
    CALL PRINT_FACE_PLAYER, MASTER, "自慰", "裸"
    __kojo_rand_51 = RAND:2
    SELECTCASE __kojo_rand_51
        CASE 0
            PRINTFORMW ……呼。
        CASE 1
            PRINTFORMW 再、再摸摸嘛。
            PRINTFORMW 她把脸别了过去。
    ENDSELECT
    IF TALENT:TARGET:恋慕 >= 500
    CALL HPH_PRINT(@"其实……%CALLNAME:TARGET%一直在等你。","w")
    ELSE
    PRINTFORMW ……早。
    ENDIF
    IF TALENT:TARGET:恋慕 < 100
    PRINTFORMW ……早。
    ELSEIF TALENT:TARGET:恋慕 < 500
    PRINTFORMW 早上好，今天天气不错呢。
    ELSE
    PRINTFORMW 亲爱的，早安~ ;(拥抱)
    PRINTFORMW 她把脸埋进你的肩膀。
    ENDIF
    PRINTFORMW （她红着脸，因为被夸奖而不知所措）
    PRINTFORMW 才、才没有很开心呢！
    PRINTFORMW （随后匆匆跑开了）
    PRINTFORMDW
    PRINTFORMDW
    PRINTFORML
    SIF 心情快照 == "亲近"
    PRINTFORMW 她看你的眼神比平时更软。
    ; 逃生舱：底层 ERB 代码
    CALL HPH_PRINT "w"
    $主菜单
    PRINTFORMW 请选择你的行动：
    IF 人数 == 1
    GOTO 战斗
    ELSE
    GOTO 主菜单
    ENDIF
    $战斗
    PRINTFORMW 你拔出了武器……
ENDIF
RETURN 1
;kojo2: @织 回合末
@EVENTTURNEND
#LATER
IF 天气 == 雨
PRINTFORMW 雨声盖住了她的脚步。
ELSE
PRINTFORMW 她轻轻关上了门。
ENDIF
`;

describe('eraTW backend：集成 golden（.kojo2 → ERB 逐字节）', () => {
  it('canonical 源编译成功且产物逐字节等于 golden', () => {
    const service = createKojo2TranspileService({
      adapter: ERATW_GAME_ADAPTER,
      backend: backend(),
    });
    const result = service.transpile({ source: CANONICAL_SOURCE, filePath: 'kojo2-canonical.kojo2' });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    // 逐字节 golden（结构关键行都在全文里钉住）
    expect(result.erb).toBe(CANONICAL_GOLDEN);
    expect(result.erb.endsWith('\n')).toBe(true);
    expect(result.sourceMap.lineCount).toBe(result.erb.split('\n').length - 1);
  });

  it('`@织` 监听体用自己的 slots 声明（表/随机槽不串进主场景 wrapper）', () => {
    // 监听体里用表 + @组 随机（group-text → eraTW 回落 RAND+SELECTCASE，随机槽是 int）
    const source = [
      '# 视角 灵梦',
      '# 机 初见',
      '# 对照表 心情 依据 恋慕',
      '    0..99 -> 疏远',
      '    否 -> 未知',
      '@织 回合末 之后',
      '    > 她看起来{心情}。',
      '    @随机',
      '        @组',
      '            灵梦：「甲。」',
      '        @组',
      '            灵梦：「乙。」',
      '> 主场景正文。',
    ].join('\n');
    const service = createKojo2TranspileService({ adapter: ERATW_GAME_ADAPTER, backend: backend() });
    const result = service.transpile({ source, filePath: 'kojo2-weave-slots.kojo2' });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);

    const [main, listener] = result.erb.split(';kojo2: @织 回合末');
    expect(main).toBeDefined();
    expect(listener).toBeDefined();
    // 主场景 wrapper 不带监听体的槽
    expect(main).not.toContain('#DIM __kojo_table_心情');
    expect(main).not.toContain('__kojo_rand_');
    // 监听函数头：属性之后是它自己的 #DIM/#DIMS 声明
    const lines = listener!.split('\n');
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('@EVENTTURNEND');
    expect(lines[2]).toBe('#LATER');
    expect(lines[3]).toBe('#DIM __kojo_table_心情');
    expect(lines[4]).toBe('#DIMS __kojo_table_心情__value');
    expect(lines[5]).toMatch(/^#DIM __kojo_rand_\d+$/);
    expect(listener).toContain('__kojo_table_心情 = TALENT:TARGET:恋慕');
    expect(listener).toMatch(/__kojo_rand_\d+ = RAND:2/);
  });
});
