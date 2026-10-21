/**
 * fixture emit backend 测试：core 降糖只需要 fixture adapter + 这份 backend 就能跑，
 * 不依赖任何游戏包（§16.3 A3.14 / A3.15 雏形）。
 *
 * 断言重点不是"产物长什么样"（那是伪引擎 token），而是 backend 契约：
 * - profile 读数逐字段来自 fixture adapter，不另抄默认值；
 * - 文本/空行/颜绘每次**至多一行**（`?` 链的 SIF 降级依赖它）；
 * - 没声明演出面时所有行尾提示归"导演批注"，不打印；
 * - fail-closed / 无状态：同输入同输出，模块装载后深冻结。
 */
import { describe, expect, it } from 'vitest';

import type { KojoConditionChain, KojoExprText, KojoSpan, KojoTextLine } from '../src/ast';
import type {
  AssignEmitRequest,
  BlankEmitRequest,
  FaceEmitRequest,
  MachineWrapRequest,
  TextEmitRequest,
  WeaveEmitRequest,
} from '../src/lower/backend';
import { lowerNarrative } from '../src/lower/index';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND, FIXTURE_LOWERING_PROFILE } from '../src/fixture-adapter';

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } };

function expr(text: string): KojoExprText {
  return { text, span: SPAN };
}

function textLine(overrides: Partial<TextEmitRequest> = {}): TextEmitRequest {
  return {
    speech: { kind: 'dialogue', speaker: '我' },
    speaker: '我',
    defaultSpeaker: null,
    parts: [{ kind: 'text', text: '你好，' }, { kind: 'interp', expr: expr('名字') }],
    wait: 'wait',
    color: { kind: 'profile' },
    hint: null,
    hintRole: null,
    span: SPAN,
    ...overrides,
  };
}

describe('fixture backend：profile 读数', () => {
  it('id 与 adapter 一致；取色/等待/池/随机逐字段派生', () => {
    expect(FIXTURE_BACKEND.id).toBe(FIXTURE_ADAPTER.id);
    expect(FIXTURE_LOWERING_PROFILE.waitDefault).toBe(FIXTURE_ADAPTER.profile.waitDefault);
    expect(FIXTURE_LOWERING_PROFILE.narrationColor).toBe(FIXTURE_ADAPTER.profile.narrationColor);
    expect(FIXTURE_LOWERING_PROFILE.dialogueColor).toBe(FIXTURE_ADAPTER.profile.dialogueColor);
    expect(FIXTURE_LOWERING_PROFILE.colorMode).toBe(FIXTURE_ADAPTER.profile.colorMode);
    expect(FIXTURE_LOWERING_PROFILE.poolStyle).toBe(FIXTURE_ADAPTER.profile.poolStyle);
    expect(FIXTURE_LOWERING_PROFILE.randStyle).toBe(FIXTURE_ADAPTER.profile.randStyle);
    expect(FIXTURE_LOWERING_PROFILE.programFeatures).toEqual(FIXTURE_ADAPTER.programFeatures);
  });

  it('fixture 不声明心形/着色/颜绘/选项，只声明随机落点', () => {
    expect(FIXTURE_LOWERING_PROFILE.presentations).toEqual({
      heart: false,
      color: false,
      face: false,
      random: true,
      options: false,
    });
  });

  it('事件表是 load-order → priorityModel = none（@织 修饰词不可用）', () => {
    expect(FIXTURE_LOWERING_PROFILE.priorityModel).toBe('none');
  });
});

describe('fixture backend：文本三正交', () => {
  it('台词一行：说话人 / 正文 / 插值 / 等待轴', () => {
    const line = FIXTURE_BACKEND.text.line(textLine());
    expect(typeof line).toBe('string');
    expect(line).toBe('SAY 我: 你好，{名字} /WAIT');
    expect(String(line)).not.toContain('\n');
  });

  it('旁白落 TELL（`>` 只声明旁白，不声明颜色/等待）', () => {
    const line = FIXTURE_BACKEND.text.line(
      textLine({ speech: { kind: 'narration' }, speaker: null, parts: [{ kind: 'text', text: '雨声。' }] }),
    );
    expect(line).toBe('TELL: 雨声。 /WAIT');
  });

  it('池内裸引号用默认说话人', () => {
    const line = FIXTURE_BACKEND.text.line(
      textLine({ speech: { kind: 'bareQuote' }, speaker: null, defaultSpeaker: '我' }),
    );
    expect(String(line)).toContain('SAY 我:');
  });

  it('`续` → 不等待；块内颜色作为独立轴按原样透传', () => {
    const line = FIXTURE_BACKEND.text.line(
      textLine({ wait: 'continue', color: { kind: 'block', color: expr('0x112233') } }),
    );
    expect(line).toBe('SAY 我: 你好，{名字} COLOR 0x112233 /CONT');
  });

  it('fixture 未声明的行尾提示是导演批注：不打印、只留注释', () => {
    const line = FIXTURE_BACKEND.text.line(textLine({ hint: '微笑', hintRole: 'annotation' }));
    expect(line).toBe('SAY 我: 你好，{名字} /WAIT ;(微笑)');
    expect(FIXTURE_BACKEND.hintSupport('微笑')).toBe('annotation');
  });

  it('空行三态：默认等待 / 强制等待 / 续', () => {
    const blank = (wait: 'wait' | 'continue'): BlankEmitRequest => ({ wait, span: SPAN });
    expect(FIXTURE_BACKEND.blank.line(blank('wait'))).toBe('BLANK /WAIT');
    expect(FIXTURE_BACKEND.blank.line(blank('continue'))).toBe('BLANK /CONT');
  });
});

describe('fixture backend：控制流与演出', () => {
  it('支持 SIF；IF 链头/中/尾各有落点', () => {
    expect(FIXTURE_BACKEND.control.sifSupported).toBe(true);
    expect(FIXTURE_BACKEND.control.sifHeader(expr('a == 1'))).toBe('SIF {a == 1}');
    expect(FIXTURE_BACKEND.control.ifHeader(expr('a == 1'))).toBe('IF {a == 1}');
    expect(FIXTURE_BACKEND.control.elseIfHeader(expr('a == 2'))).toBe('ELSEIF {a == 2}');
    expect(FIXTURE_BACKEND.control.elseHeader()).toBe('ELSE');
    expect(FIXTURE_BACKEND.control.ifFooter()).toBe('ENDIF');
  });

  it('颜绘至多一行（SIF 单行契约），参数按序透传', () => {
    const request: FaceEmitRequest = { object: 'me', args: [expr('笑顔'), expr('服1')], span: SPAN };
    const line = FIXTURE_BACKEND.presentation.face(request);
    expect(line).toBe('FACE me 笑顔, 服1');
    expect(String(line)).not.toContain('\n');
  });

  it('@着色 进入/复原由 backend 出单行指令', () => {
    expect(FIXTURE_BACKEND.presentation.colorEnter(expr('0xFF8080'))).toBe('COLOR.ENTER {0xFF8080}');
    expect(FIXTURE_BACKEND.presentation.colorExit()).toBe('COLOR.EXIT');
  });

  it('@随机 由 backend 组装 头 + 各候选已降糖行 + 尾（候选行来自 core 回调）', () => {
    const lines = FIXTURE_BACKEND.presentation.randomBlock(
      {
        purity: 'single-line-text',
        candidates: [
          { kind: 'randomLine', line: { kind: 'blankLine', wait: 'wait', span: SPAN }, span: SPAN },
        ],
        slot: '__fixture_rand_1',
        span: SPAN,
      },
      (_candidate, index) => [`CANDIDATE ${index}`],
    );
    expect(lines).toEqual(['RANDOM single-line-text 1', 'CANDIDATE 0', 'RANDOM.END']);
  });

  it('选项块同样由 backend 组装头/按钮正文/尾', () => {
    const item = { label: '摸摸头', body: [], span: SPAN };
    const lines = FIXTURE_BACKEND.presentation.optionsBlock({ items: [item], span: SPAN }, (_item, index) => [
      `BUTTON ${index}`,
    ]);
    expect(lines).toEqual(['OPTIONS 1', 'BUTTON 0', 'OPTIONS.END']);
  });
});

describe('fixture backend：program 层落点', () => {
  it('赋值 / 循环 / 跳转 / 返回各有单行落点', () => {
    const assign: AssignEmitRequest = {
      target: { text: '数值', span: SPAN },
      op: '+=',
      value: expr('1'),
      span: SPAN,
    };
    expect(FIXTURE_BACKEND.program.assign(assign)).toBe('SET 数值 += {1}');
    expect(FIXTURE_BACKEND.program.whileHeader(expr('数值 < 3'))).toBe('WHILE {数值 < 3}');
    expect(FIXTURE_BACKEND.program.whileFooter()).toBe('WEND');
    expect(FIXTURE_BACKEND.program.repeatHeader(expr('3'))).toBe('REPEAT {3}');
    expect(FIXTURE_BACKEND.program.repeatFooter()).toBe('REND');
    expect(FIXTURE_BACKEND.program.forEachHeader(expr('队列'))).toBe('FOREACH {队列}');
    expect(FIXTURE_BACKEND.program.forEachFooter()).toBe('NEXT');
    expect(FIXTURE_BACKEND.program.loopJump('break')).toBe('BREAK');
    expect(FIXTURE_BACKEND.program.loopJump('continue')).toBe('CONTINUE');
    expect(FIXTURE_BACKEND.program.jump('开头')).toBe('GOTO 开头');
    expect(FIXTURE_BACKEND.program.label('开头')).toBe('LABEL 开头');
    expect(FIXTURE_BACKEND.program.returnValue(expr('1'))).toBe('RETURN {1}');
    expect(FIXTURE_BACKEND.program.returnValue(null)).toBe('RETURN');
  });

  it('@算 没有运行时表示 → null（不产字节）', () => {
    expect(FIXTURE_BACKEND.program.sandboxEnter()).toBeNull();
    expect(FIXTURE_BACKEND.program.sandboxExit()).toBeNull();
  });

  it('@织 头/尾各一行', () => {
    const request: WeaveEmitRequest = { event: '开场', args: [], modifiers: ['pri'], span: SPAN, slots: [] };
    expect(FIXTURE_BACKEND.weave.weaveHeader(request)).toContain('WEAVE 开场');
    expect(FIXTURE_BACKEND.weave.weaveFooter()).toBe('WEAVE.END');
  });
});

describe('fixture backend × core 降糖：SIF 单行契约', () => {
  /** 单行叙事节点（SIF 白名单形状） */
  function lineNode(text: string): KojoTextLine {
    return {
      kind: 'textLine',
      speech: { kind: 'dialogue', speaker: '我' },
      parts: [{ kind: 'text', text }],
      wait: 'wait',
      span: SPAN,
    };
  }

  function chain(body: readonly KojoTextLine[]): KojoConditionChain {
    return {
      kind: 'conditionChain',
      branches: [{ test: expr('条件'), body, span: SPAN }],
      span: SPAN,
    };
  }

  it('单真分支 + 单行体 → SIF + 恰好一行，无 ENDIF（fixture backend 单行契约的前提）', () => {
    const result = lowerNarrative([chain([lineNode('嗯。')])], { backend: FIXTURE_BACKEND });
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(['SIF {条件}', 'SAY 我: 嗯。 /WAIT']);
    expect(result.lines).not.toContain('ENDIF');
  });

  it('分支体多于一行 → 不走 SIF，回落完整 IF 链（保证结构正确性优先）', () => {
    const result = lowerNarrative([chain([lineNode('甲。'), lineNode('乙。')])], { backend: FIXTURE_BACKEND });
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(['IF {条件}', 'SAY 我: 甲。 /WAIT', 'SAY 我: 乙。 /WAIT', 'ENDIF']);
  });
});

describe('fixture backend：`# 机` 最小 wrapper', () => {
  const MACHINE = {
    kind: 'machine' as const,
    event: '开场',
    args: ['310'],
    span: SPAN,
  };

  function wrapRequest(overrides: Partial<MachineWrapRequest> = {}): MachineWrapRequest {
    return { machine: MACHINE, body: ['SAY 我: 你好 /WAIT'], view: null, slots: [], ...overrides };
  }

  it('头 = `MACHINE <event> [args…]`，尾 = `MACHINE.END`，body 原样嵌在中间', () => {
    const lines = FIXTURE_BACKEND.wrapMachine?.(wrapRequest()) as readonly string[];
    expect(lines[0]).toBe('MACHINE 开场 310');
    expect(lines).toContain('SAY 我: 你好 /WAIT');
    expect(lines[lines.length - 1]).toBe('MACHINE.END');
  });

  it('slots 逐槽一行注释（fixture 不声明真变量；含 valueType 事实）', () => {
    const lines = FIXTURE_BACKEND.wrapMachine?.(
      wrapRequest({
        slots: [
          { name: '__kojo_table_心情', kind: 'table', valueType: 'int' },
          { name: '__kojo_table_心情__value', kind: 'table', valueType: 'string' },
          { name: '__kojo_rand_12', kind: 'random', valueType: 'int' },
        ],
      }),
    ) as readonly string[];
    expect(lines).toEqual([
      'MACHINE 开场 310',
      ';SLOT __kojo_table_心情 table int',
      ';SLOT __kojo_table_心情__value table string',
      ';SLOT __kojo_rand_12 random int',
      'SAY 我: 你好 /WAIT',
      'MACHINE.END',
    ]);
  });

  it('body 行顺序/内容不变（core 用连续子序列找回 source map）', () => {
    const body = ['SAY 我: 甲 /WAIT', 'BLANK /CONT', 'SAY 我: 乙 /WAIT'];
    const lines = FIXTURE_BACKEND.wrapMachine?.(wrapRequest({ body })) as readonly string[];
    const start = lines.indexOf(body[0]!);
    expect(start).toBeGreaterThan(0);
    for (let i = 0; i < body.length; i++) expect(lines[start + i]).toBe(body[i]);
  });
});

describe('fixture backend：冻结与无状态', () => {
  it('backend 与 profile 深冻结', () => {
    expect(Object.isFrozen(FIXTURE_BACKEND)).toBe(true);
    expect(Object.isFrozen(FIXTURE_BACKEND.profile)).toBe(true);
    expect(Object.isFrozen(FIXTURE_BACKEND.presentation)).toBe(true);
    expect(Object.isFrozen(FIXTURE_LOWERING_PROFILE)).toBe(true);
  });

  it('同输入同输出（纯函数，无隐藏状态）', () => {
    const request = textLine();
    expect(FIXTURE_BACKEND.text.line(request)).toBe(FIXTURE_BACKEND.text.line(request));
  });
});
