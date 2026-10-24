/**
 * eraFL `KojoEmitBackend` 测试（入口 D）。
 *
 * 三层：
 * 1) **数据派生**：`eraflLoweringProfile()` 的每个字段都必须能从 `kojo2/` 的真盘读数
 *    推出来（不是另写一份默认值）；`presentations` 四项按 `ERAFL_PRESENTATION` 的
 *    null/非 null 给——eraFL 只有 `color` 一面有语料。
 * 2) **落点形状**：文本三正交 / 着色配对 / `# 机` wrapper（body 原序 + 缩进）/
 *    `@随机` 两条路（PRINTDATA 与 RAND+SELECTCASE）。
 * 3) **fail-closed**：心形 / 颜绘 / 选项 / `@织` / `@巡` / 未知事件——没有语料证据的
 *    面一律返回诊断，**不产半成品字节、不静默降级**（红线 4）。
 *
 * 为什么这些面要 fail-closed 而不是"尽量落一个像样的产物"：这些字节最终会写进作者的
 * `.ERB`。一个"看起来对、其实属于 eraTW"的落点比一条红波浪线危险得多——作者不会去查
 * 一个能跑通的函数。
 */
import { describe, expect, it } from 'vitest';

import type {
  BlankEmitRequest,
  EmitFailure,
  EmitResult,
  KojoEmitBackend,
  KojoExprText,
  KojoSpan,
  MachineWrapRequest,
  RandomEmitRequest,
  TextEmitRequest,
  WeaveEmitRequest,
} from '@kojo/kojo-core';
import { isEmitFailure } from '@kojo/kojo-core';

import { ERAFL_EVENT_CATALOG } from '../src/kojo2/event-catalog.js';
import { ERAFL_PRESENTATION } from '../src/kojo2/presentation.js';
import { ERAFL_PROGRAM_FEATURES } from '../src/kojo2/program.js';
import { createEraflEmitBackend, eraflLoweringProfile } from '../src/kojo2/backend.js';

/* ============================== 测试替身 ============================== */

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } };

function expr(text: string): KojoExprText {
  return { text, span: SPAN };
}

/**
 * 表达式替身：**只做域符号替换**，不做真正的表达式编译。
 *
 * 真管线由宿主注入（v1 `lowerExpression` 尚未接进 2.0 面）。这里把 `{我}` 一类代词
 * 换成引擎引用，够钉 backend 的产物结构；表达式本身的语义不是本文件的验收面。
 */
function fakeCompileExpression(value: KojoExprText): string {
  return value.text.replaceAll('我', 'MASTER').replaceAll('她', 'TARGET');
}

function backend(): KojoEmitBackend {
  return createEraflEmitBackend({ compileExpression: fakeCompileExpression });
}

function textLine(overrides: Partial<TextEmitRequest> = {}): TextEmitRequest {
  return {
    speech: { kind: 'dialogue', speaker: '蒂娅' },
    speaker: '蒂娅',
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

function asLines(result: EmitResult): readonly string[] {
  if (typeof result === 'string') return [result];
  if (result === null || isEmitFailure(result)) throw new Error('expected lines');
  return result;
}

/* ============================== 1. 数据派生 ============================== */

describe('eraFL backend：profile 逐字段从 kojo2 数据派生', () => {
  it('等待/取色/D 系/池/随机 = adapter profile 的真盘读数', () => {
    const profile = eraflLoweringProfile();
    expect(profile.waitDefault).toBe('wait'); // PRINTFORMW 系 24,047 处
    expect(profile.narrationColor).toBe('author'); // SETCOLOR 1,932 处（口上域 134）
    expect(profile.dialogueColor).toBe('author');
    expect(profile.colorMode).toBe('D'); // PRINTFORMD 481 处
    expect(profile.poolStyle).toBe('if');
    expect(profile.randStyle).toBe('printdata'); // PRINTDATA 404 处
    expect(profile.programFeatures).toEqual(ERAFL_PROGRAM_FEATURES);
  });

  it('presentations 按 ERAFL_PRESENTATION 的 null/非 null 给：只有着色面开', () => {
    expect(eraflLoweringProfile().presentations).toEqual({
      heart: ERAFL_PRESENTATION.heart !== null,
      color: ERAFL_PRESENTATION.color !== null,
      face: ERAFL_PRESENTATION.face !== null,
      random: true,
      options: ERAFL_PRESENTATION.options !== null,
    });
    // 具体读数钉一次：心形 / 颜绘 / 选项三面 eraFL 都没有 ERB 落点
    expect(eraflLoweringProfile().presentations).toEqual({
      heart: false,
      color: true,
      face: false,
      random: true,
      options: false,
    });
  });

  it('priorityModel 由事件目录推：四事件都声明 emuera-buckets → 修饰可用', () => {
    expect(ERAFL_EVENT_CATALOG.events.every((spec) => spec.priority === 'emuera-buckets')).toBe(true);
    expect(eraflLoweringProfile().priorityModel).toBe('emuera-buckets');
  });

  it('profile 冻结（backend 无状态：每次派生同值、且都不可改）', () => {
    expect(Object.isFrozen(eraflLoweringProfile())).toBe(true);
    expect(Object.isFrozen(backend().profile)).toBe(true);
    expect(backend().profile).toEqual(backend().profile);
  });

  it('hintSupport：`心形` 是 eraFL 明确不支持的演出提示，其余一律导演批注', () => {
    const b = backend();
    expect(b.hintSupport('心形')).toBe('unsupported');
    expect(b.hintSupport('微笑')).toBe('annotation');
    expect(b.hintSupport('立绘')).toBe('annotation');
  });
});

/* ============================== 2. 文本三正交 ============================== */

describe('eraFL backend：文本三正交（PRINTFORM 变体）', () => {
  it('旁白 + 作者色 → 非 D：PRINTFORMW', () => {
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

  it('`续` → L：PRINTFORML（等待轴只由 wait 决定）', () => {
    expect(backend().text.line(textLine({ wait: 'continue' }))).toBe('PRINTFORML ……好。');
  });

  it('块色（`@着色` 内）→ 恒非 D（D 系忽略 SETCOLOR）', () => {
    const result = backend().text.line(
      textLine({ color: { kind: 'block', color: expr('0xFF8080') } }),
    );
    expect(result).toBe('PRINTFORMW ……好。');
  });

  it('插值 → %表达式%（端口注入的编译结果）', () => {
    const interp = backend().text.line(
      textLine({
        parts: [
          { kind: 'text', text: '「' },
          { kind: 'interp', expr: expr('我') },
          { kind: 'text', text: '今天来得挺早嘛。」' },
        ],
      }),
    );
    expect(interp).toBe('PRINTFORMW 「%MASTER%今天来得挺早嘛。」');
  });

  it('行内条件插值 → \\@条件?A#B\\@', () => {
    const result = backend().text.line(
      textLine({
        parts: [
          {
            kind: 'interp',
            expr: expr('亲近'),
            cond: { cond: expr('亲近 >= 5'), then: expr('"你最近……不一样。"'), else: expr('"加油。"') },
          },
        ],
      }),
    );
    expect(result).toBe('PRINTFORMW \\@亲近 >= 5?"你最近……不一样。"#"加油。"\\@');
  });

  it('未声明的行尾提示 = 导演批注：不打印，只留 `;` 注释', () => {
    expect(backend().text.line(textLine({ hint: '微笑', hintRole: 'annotation' }))).toBe(
      'PRINTFORMW ……好。 ;(微笑)',
    );
  });

  it('批注里的换行被压成空格（一行产物不能被批注切行）', () => {
    expect(backend().text.line(textLine({ hint: '低头\n又抬眼', hintRole: 'annotation' }))).toBe(
      'PRINTFORMW ……好。 ;(低头 又抬眼)',
    );
  });

  it('空行：`等待` → PRINTFORMDW（colorMode = D）；`续` → PRINTFORML', () => {
    const blankWait: BlankEmitRequest = { wait: 'wait', span: SPAN };
    const blankContinue: BlankEmitRequest = { wait: 'continue', span: SPAN };
    expect(backend().blank.line(blankWait)).toBe('PRINTFORMDW');
    expect(backend().blank.line(blankContinue)).toBe('PRINTFORML');
  });

  it('文本行为空（只有零个片段）→ 走空行指令，不产出 `PRINTFORMW ` 尾空格', () => {
    expect(backend().text.line(textLine({ parts: [] }))).toBe('PRINTFORMDW');
  });
});

/* ============================== 3. 演出面 ============================== */

describe('eraFL backend：演出面（只有着色有语料）', () => {
  it('@着色 → SETCOLOR <编译后的颜色> / RESETCOLOR 配对', () => {
    const b = backend();
    expect(b.presentation.colorEnter(expr('0xFF8080'))).toBe('SETCOLOR 0xFF8080');
    expect(b.presentation.colorExit()).toBe('RESETCOLOR');
  });

  it('颜绘 → fail-closed（eraFL 的立绘在口上 XML 属性侧）', () => {
    const failure = failureOf(
      backend().presentation.face({ parts: [], span: SPAN } as unknown as Parameters<
        KojoEmitBackend['presentation']['face']
      >[0]),
    );
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('XML');
  });

  it('`选项` → fail-closed（口上域无选项 UI）', () => {
    const failure = failureOf(
      backend().presentation.optionsBlock({ items: [], span: SPAN }, () => []),
    );
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
  });

  it('`(心形)` 即便被当成 supported 传进来也 fail-closed（数据没声明就不发字节）', () => {
    const failure = failureOf(
      backend().text.line(textLine({ hint: '心形', hintRole: 'supported' })),
    );
    expect(failure.diagnostics[0]?.message).toContain('presentation.heart');
  });
});

/* ============================== 4. 随机两条路 ============================== */

const RANDOM_SLOT = '__kojo_rand_7';

function randomRequest(purity: RandomEmitRequest['purity'], waits: readonly ('wait' | 'continue')[]): RandomEmitRequest {
  return {
    purity,
    slot: RANDOM_SLOT,
    span: SPAN,
    candidates: waits.map((wait, index) => ({
      kind: 'randomLine' as const,
      span: SPAN,
      line: {
        kind: 'textLine' as const,
        speech: { kind: 'narration' as const },
        parts: [{ kind: 'text' as const, text: `第${index + 1}种` }],
        wait,
        span: SPAN,
      },
    })),
  };
}

describe('eraFL backend：`@随机` 两条路', () => {
  it('纯文本单行 + 全等待 → PRINTDATA/DATAFORM/ENDDATA + WAIT', () => {
    const lines = asLines(
      backend().presentation.randomBlock(randomRequest('single-line-text', ['wait', 'wait']), () => []),
    );
    expect(lines).toEqual(['PRINTDATA', '    DATAFORM 第1种', '    DATAFORM 第2种', 'ENDDATA', 'WAIT']);
  });

  it('纯文本单行 + 全续 → 不补 WAIT', () => {
    const lines = asLines(
      backend().presentation.randomBlock(randomRequest('single-line-text', ['continue', 'continue']), () => []),
    );
    expect(lines).not.toContain('WAIT');
    expect(lines[0]).toBe('PRINTDATA');
  });

  it('等待轴混用 → fail-closed（PRINTDATA 表达不了逐候选等待）', () => {
    const failure = failureOf(
      backend().presentation.randomBlock(randomRequest('single-line-text', ['wait', 'continue']), () => []),
    );
    expect(failure.diagnostics[0]?.message).toContain('等待轴');
  });

  it('有控制流/副作用（purity ≠ single-line-text）→ RAND + SELECTCASE', () => {
    const seen: number[] = [];
    const lines = asLines(
      backend().presentation.randomBlock(randomRequest('control-or-side-effect', ['wait']), (_c, index) => {
        seen.push(index);
        return ['PRINTFORMW 分支', '', 'SETFLAG 1'];
      }),
    );
    expect(seen).toEqual([0]);
    expect(lines).toEqual([
      '__kojo_rand_7 = RAND:1',
      'SELECTCASE __kojo_rand_7',
      '    CASE 0',
      '        PRINTFORMW 分支',
      '',
      '        SETFLAG 1',
      'ENDSELECT',
    ]);
  });
});

/* ============================== 5. `# 机` 落点 ============================== */

const MACHINE = { kind: 'machine' as const, event: '初见', args: ['310'], span: SPAN };

describe('eraFL backend：wrapMachine（`@<引擎事件>` + `#LATER`）', () => {
  it('事件名 → 引擎函数名（查 eventCatalog，不猜）', () => {
    const request: MachineWrapRequest = {
      machine: MACHINE,
      body: ['PRINTFORMW 「……你来了。」'],
      view: null,
      slots: [],
    };
    const lines = asLines(backend().wrapMachine?.(request) ?? null);
    expect(lines).toEqual([
      ';kojo2: # 机 初见 310',
      '@EVENTFIRST',
      '#LATER',
      '    PRINTFORMW 「……你来了。」',
    ]);
  });

  it('四条事件都能落到各自的引擎函数（读数：NEWGAME/SAVELOAD/SHOP）', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['初见', 'EVENTFIRST'],
      ['读档', 'EVENTLOAD'],
      ['商店', 'EVENTSHOP'],
      ['购买', 'EVENTBUY'],
    ];
    for (const [event, engine] of cases) {
      const lines = asLines(
        backend().wrapMachine?.({ machine: { ...MACHINE, event, args: [] }, body: [], view: null, slots: [] }) ?? null,
      );
      expect(lines[1]).toBe(`@${engine}`);
      expect(lines[0]).toBe(`;kojo2: # 机 ${event}`);
    }
  });

  it('body 行按契约原样嵌入（trimStart 逐字相等、顺序一致）', () => {
    const body = ['PRINTFORML ……早。', '', 'CALL FL_GREET(@"……嗯。", 1)'];
    const lines = asLines(backend().wrapMachine?.({ machine: MACHINE, body, view: null, slots: [] }) ?? null);
    const start = lines.findIndex((line) => line.trimStart() === body[0]);
    expect(start).toBeGreaterThan(0);
    for (let i = 0; i < body.length; i += 1) {
      expect(lines[start + i]?.trimStart()).toBe(body[i]);
    }
  });

  it('slots → 紧贴 `#LATER` 之后发 `#DIM/#DIMS`（按 core 给的 valueType，不从名字猜）', () => {
    const request: MachineWrapRequest = {
      machine: MACHINE,
      body: [],
      view: null,
      slots: [
        { name: '__kojo_table_心情', kind: 'table', valueType: 'int' },
        { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string' },
        { name: '__kojo_rand_7', kind: 'random', valueType: 'int' },
      ],
    };
    const lines = asLines(backend().wrapMachine?.(request) ?? null);
    expect(lines[2]).toBe('#LATER');
    expect(lines[3]).toBe('#DIM __kojo_table_心情');
    expect(lines[4]).toBe('#DIMS __kojo_table_心情__value');
    expect(lines[5]).toBe('#DIM __kojo_rand_7');
  });

  it('事件目录里没有的事件名 → fail-closed，文案列出四个真事件', () => {
    const failure = failureOf(
      backend().wrapMachine?.({
        machine: { ...MACHINE, event: '训练' },
        body: [],
        view: null,
        slots: [],
      }) ?? null,
    );
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    const message = failure.diagnostics[0]?.message ?? '';
    for (const name of ['初见', '读档', '商店', '购买']) expect(message).toContain(name);
  });

  it('无状态：两次 wrapMachine 各按自己的 slots 声明，互不影响', () => {
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
});

/* ============================== 6. `@织` / 程序层 ============================== */

describe('eraFL backend：`@织` 与程序层', () => {
  it('`@织` 监听 → fail-closed（全树 #PRI/#LATER/#ONLY 零处，没有语料证据）', () => {
    const request: WeaveEmitRequest = {
      event: '初见',
      args: [],
      modifiers: [],
      span: SPAN,
      slots: [],
    };
    const failure = failureOf(backend().weave.weaveHeader(request));
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('#PRI');
    expect(backend().weave.weaveFooter()).toBeNull();
  });

  it('控制流：IF / ELSEIF / ELSE / ENDIF / SIF（Emuera 语言面）', () => {
    const control = backend().control;
    expect(control.sifSupported).toBe(true);
    expect(control.ifHeader(expr('亲近 >= 5'))).toBe('IF 亲近 >= 5');
    expect(control.elseIfHeader(expr('亲近 >= 3'))).toBe('ELSEIF 亲近 >= 3');
    expect(control.elseHeader()).toBe('ELSE');
    expect(control.ifFooter()).toBe('ENDIF');
    expect(control.sifHeader(expr('亲近 >= 5'))).toBe('SIF 亲近 >= 5');
  });

  it('程序层：赋值 / CALL / 标号 / GOTO / WHILE / REPEAT / 跳出 / RETURN', () => {
    const program = backend().program;
    expect(
      program.assign({ target: { text: 'FLAG:10', span: SPAN }, op: '=', value: expr('1'), span: SPAN }),
    ).toBe('FLAG:10 = 1');
    expect(program.call({ name: 'FL_GREET', args: [expr('1'), expr('"早"')], span: SPAN })).toBe(
      'CALL FL_GREET(1, "早")',
    );
    expect(program.label('循环')).toBe('$循环');
    expect(program.jump('循环')).toBe('GOTO 循环');
    expect(program.whileHeader(expr('1'))).toBe('WHILE 1');
    expect(program.whileFooter()).toBe('WEND');
    expect(program.repeatHeader(expr('3'))).toBe('REPEAT 3');
    expect(program.repeatFooter()).toBe('REND');
    expect(program.loopJump('break')).toBe('BREAK');
    expect(program.loopJump('continue')).toBe('CONTINUE');
    expect(program.returnValue(null)).toBe('RETURN');
    expect(program.returnValue(expr('1'))).toBe('RETURN 1');
  });

  it('`@巡` 未开（programFeatures.foreach = false）⇒ fail-closed，不猜绑定名', () => {
    expect(ERAFL_PROGRAM_FEATURES.foreach).toBe(false);
    const failure = failureOf(backend().program.forEachHeader(expr('角色')));
    expect(failure.diagnostics[0]?.message).toContain('@巡');
  });

  it('沙箱进出没有落点（Emuera 无对应语言面）⇒ null（不是错）', () => {
    expect(backend().program.sandboxEnter()).toBeNull();
    expect(backend().program.sandboxExit()).toBeNull();
  });
});
