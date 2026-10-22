/**
 * eraTW profile 覆盖测试（K2-ADAPTER-PROFILE / 设计稿 §16.3 A3.4）。
 *
 * 钉四件事：
 * 1. **缺省逐字节不变**：不传覆盖时 `resolveEratwProfile()` 与 `eratwLoweringProfile()` 同值，
 *    产物与既有 golden 一致（本文件的端到端 golden 另钉一份，`backend.test.ts` 的 canonical
 *    golden 一行不改也仍然全绿 = 硬判据）；
 * 2. **六个字段各自可覆盖**（`narrationColor` / `dialogueColor` / `waitDefault` / `colorMode` /
 *    `poolStyle` / `randStyle`）+ 子对象逐键深合并；
 * 3. **adapter 声明 → 落点** 的映射表：只搬六个落点字段，`features` / `programFeatures` /
 *    `presentations` / `priorityModel` 不搬（双源对拍纪律不被覆盖悄悄取消）；
 * 4. **fail-closed**：非法值 / 未知键一律抛（不静默回缺省）。
 */
import { describe, expect, it } from 'vitest';

import type {
  AdapterProfile,
  BlankEmitRequest,
  EmitFailure,
  EmitResult,
  KojoEmitBackend,
  KojoSpan,
  RandomEmitRequest,
  TextEmitRequest,
} from '@kojo/kojo-core';
import { isEmitFailure, type KojoExprText } from '@kojo/kojo-core';

import { createKojo2TranspileService } from '@kojo/plugin-kojo-sugar';

import { ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { createEratwEmitBackend, eratwLoweringProfile } from '../../src/kojo2/backend.js';
import {
  ERATW_ADAPTER_PROFILE_LANDING,
  ERATW_ADAPTER_PROFILE_LANDING_FIELDS,
  ERATW_DEFAULT_LOWERING_PROFILE,
  eratwAdapterProfileOverrides,
  resolveEratwProfile,
} from '../../src/kojo2/index.js';
import type { EratwProfileOverrides } from '../../src/kojo2/index.js';

/* ============================== 夹具 ============================== */

const SPAN: KojoSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } };

/** 类型闸之外的非法覆盖（测 fail-closed 用：`as` 收口，不让 tsc 先拦住） */
const asOverrides = (value: unknown): EratwProfileOverrides => value as EratwProfileOverrides;

function expr(text: string): KojoExprText {
  return { text, span: SPAN };
}

function backendOf(
  deps: { readonly profile?: EratwProfileOverrides; readonly adapterProfile?: AdapterProfile } = {},
): KojoEmitBackend {
  return createEratwEmitBackend({
    compileExpression: (value) => value.text,
    charNo: '12',
    ...(deps.profile === undefined ? {} : { profile: deps.profile }),
    ...(deps.adapterProfile === undefined ? {} : { adapterProfile: deps.adapterProfile }),
  });
}

function textLineRequest(overrides: Partial<TextEmitRequest> = {}): TextEmitRequest {
  return {
    speech: { kind: 'narration' },
    speaker: null,
    defaultSpeaker: null,
    parts: [{ kind: 'text', text: '她点了点头。' }],
    wait: 'wait',
    color: { kind: 'profile' },
    hint: null,
    hintRole: null,
    span: SPAN,
    ...overrides,
  };
}

const narrationLine = (overrides: Partial<TextEmitRequest> = {}): TextEmitRequest =>
  textLineRequest({ speech: { kind: 'narration' }, speaker: null, ...overrides });

const dialogueLine = (overrides: Partial<TextEmitRequest> = {}): TextEmitRequest =>
  textLineRequest({ speech: { kind: 'dialogue', speaker: '灵梦' }, speaker: '灵梦', ...overrides });

const failureOf = (result: EmitResult): EmitFailure => {
  if (!isEmitFailure(result)) throw new Error(`expected EmitFailure, got ${JSON.stringify(result)}`);
  return result;
};

const asLines = (result: EmitResult): readonly string[] => {
  if (typeof result === 'string') return [result];
  if (result === null || isEmitFailure(result)) throw new Error('expected lines');
  return result;
};

/** 单行纯文本候选的 `@随机` 请求（默认落 PRINTDATA，可被 randStyle 改写） */
function randomRequest(): RandomEmitRequest {
  const line = {
    kind: 'textLine' as const,
    speech: { kind: 'narration' as const },
    parts: [{ kind: 'text' as const, text: '……呼。' }],
    wait: 'continue' as const,
    span: SPAN,
  };
  return {
    purity: 'single-line-text',
    candidates: [{ kind: 'randomLine', line, span: SPAN }],
    slot: '__kojo_rand_9',
    span: SPAN,
  };
}

/* ============================== 1. 缺省：同值 / 冻结 / 确定性 ============================== */

describe('resolveEratwProfile：缺省 = adapter 数据（逐字段不变）', () => {
  it('无覆盖时与 eratwLoweringProfile() 逐字段同值', () => {
    expect(resolveEratwProfile()).toEqual(eratwLoweringProfile());
    expect(resolveEratwProfile()).toEqual(ERATW_DEFAULT_LOWERING_PROFILE);
  });

  it('缺省读数逐字段钉死（与今天一致，改动即红线）', () => {
    const profile = resolveEratwProfile();
    expect(profile.waitDefault).toBe('wait');
    expect(profile.narrationColor).toBe('author');
    expect(profile.dialogueColor).toBe('author');
    expect(profile.colorMode).toBe('D');
    expect(profile.poolStyle).toBe('if');
    expect(profile.randStyle).toBe('printdata');
    expect(profile.priorityModel).toBe('emuera-buckets');
    expect(profile.presentations).toEqual({ heart: true, color: true, face: true, random: true, options: true });
    expect(profile.programFeatures).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: true,
      foreach: true,
      repeat: true,
    });
  });

  it('深冻结：顶层与两个子对象都冻结（实例内不可变）', () => {
    const profile = resolveEratwProfile();
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.presentations)).toBe(true);
    expect(Object.isFrozen(profile.programFeatures)).toBe(true);
  });

  it('纯函数确定性：同输入多次调用逐字段相等，且缺省对象不被调用污染', () => {
    const a = resolveEratwProfile({ narrationColor: 'default' });
    const b = resolveEratwProfile({ narrationColor: 'default' });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // 无覆盖的子对象按不可变共享（都冻结）——共享不是可变副作用：改不动
    expect(Object.isFrozen(a.presentations)).toBe(true);
    expect(Object.isFrozen(a.programFeatures)).toBe(true);
    // 缺省对象没有被调用污染
    expect(ERATW_DEFAULT_LOWERING_PROFILE.narrationColor).toBe('author');
    expect(ERATW_DEFAULT_LOWERING_PROFILE.presentations).toEqual({
      heart: true,
      color: true,
      face: true,
      random: true,
      options: true,
    });
  });

  it('null / undefined 层 = 这一层不参与（不是"清空覆盖"）', () => {
    const base = resolveEratwProfile();
    expect(resolveEratwProfile(undefined)).toEqual(base);
    expect(resolveEratwProfile(null)).toEqual(base);
    expect(resolveEratwProfile(null, undefined, { narrationColor: 'default' }, null)).toEqual(
      resolveEratwProfile({ narrationColor: 'default' }),
    );
  });

  it('冻结的入参不会让 resolve 抛（只读，不写回一层）', () => {
    const frozen = Object.freeze({ narrationColor: 'default' as const });
    expect(resolveEratwProfile(frozen).narrationColor).toBe('default');
  });
});

/* ============================== 2. 深合并 ============================== */

describe('深合并：子对象逐键、缺键回缺省、层序后者盖前者', () => {
  it('presentations 只给 heart=false：其余键保持缺省（键一个不丢）', () => {
    const profile = resolveEratwProfile({ presentations: { heart: false } });
    expect(profile.presentations).toEqual({ heart: false, color: true, face: true, random: true, options: true });
  });

  it('programFeatures 只给 while=false：其余五项仍开（键一个不丢）', () => {
    const profile = resolveEratwProfile({ programFeatures: { while: false } });
    expect(profile.programFeatures).toEqual({
      arrays: true,
      while: false,
      goto: true,
      recursion: true,
      foreach: true,
      repeat: true,
    });
  });

  it('多层叠加：标量后者盖前者、子对象逐键跨层合并', () => {
    const profile = resolveEratwProfile(
      { narrationColor: 'default', presentations: { heart: false } },
      { presentations: { color: false } },
    );
    expect(profile.narrationColor).toBe('default');
    expect(profile.presentations).toEqual({ heart: false, color: false, face: true, random: true, options: true });
  });
});

/* ============================== 3. 六个字段各自生效（落点像素） ============================== */

describe('narrationColor：旁白 D 系落点', () => {
  it('缺省 author → 非 D；覆盖 default → PRINTFORMDW / PRINTFORMDL', () => {
    expect(backendOf().text.line(narrationLine())).toBe('PRINTFORMW 她点了点头。');
    expect(backendOf({ profile: { narrationColor: 'default' } }).text.line(narrationLine())).toBe(
      'PRINTFORMDW 她点了点头。',
    );
    expect(
      backendOf({ profile: { narrationColor: 'default' } }).text.line(narrationLine({ wait: 'continue' })),
    ).toBe('PRINTFORMDL 她点了点头。');
  });

  it('@着色 块内恒非 D（块色要 SETCOLOR，D 系忽略它）', () => {
    const line = backendOf({ profile: { narrationColor: 'default' } }).text.line(
      narrationLine({ color: { kind: 'block', color: expr('0xFF8080') } }),
    );
    expect(line).toBe('PRINTFORMW 她点了点头。');
  });

  it('auto 不是"默认色"证据 → 保守非 D（不替作者猜）', () => {
    expect(backendOf({ profile: { narrationColor: 'auto' } }).text.line(narrationLine())).toBe(
      'PRINTFORMW 她点了点头。',
    );
  });
});

describe('dialogueColor：台词取色策略', () => {
  it('缺省 author → 台词非 D；覆盖 default → 台词落 D（含池内裸引号）', () => {
    expect(backendOf().text.line(dialogueLine())).toBe('PRINTFORMW 她点了点头。');
    const dialogueDefault = backendOf({ profile: { dialogueColor: 'default' } });
    expect(dialogueDefault.text.line(dialogueLine())).toBe('PRINTFORMDW 她点了点头。');
    expect(
      dialogueDefault.text.line(textLineRequest({ speech: { kind: 'bareQuote' }, defaultSpeaker: '灵梦' })),
    ).toBe('PRINTFORMDW 她点了点头。');
  });

  it('只有台词覆盖、旁白仍按 author → 旁白非 D（两轴互不串）', () => {
    const backend = backendOf({ profile: { dialogueColor: 'default' } });
    expect(backend.text.line(dialogueLine())).toBe('PRINTFORMDW 她点了点头。');
    expect(backend.text.line(narrationLine())).toBe('PRINTFORMW 她点了点头。');
  });
});

describe('colorMode：D 系可用性', () => {
  it('plain ⇒ 旁白即使取默认色也不落 D（D 系不可用）', () => {
    const backend = backendOf({ profile: { colorMode: 'plain', narrationColor: 'default' } });
    expect(backend.text.line(narrationLine())).toBe('PRINTFORMW 她点了点头。');
    expect(backend.text.line(narrationLine({ wait: 'continue' }))).toBe('PRINTFORML 她点了点头。');
  });

  it('plain ⇒ 空行等待形不落 D；续写形恒 PRINTFORML（两种 colorMode 都一样）', () => {
    const blank = (wait: 'wait' | 'continue'): BlankEmitRequest => ({ wait, span: SPAN });
    const plain = backendOf({ profile: { colorMode: 'plain' } });
    const withD = backendOf();
    expect(plain.blank.line(blank('wait'))).toBe('PRINTFORMW');
    expect(plain.blank.line(blank('continue'))).toBe('PRINTFORML');
    expect(withD.blank.line(blank('wait'))).toBe('PRINTFORMDW');
    expect(withD.blank.line(blank('continue'))).toBe('PRINTFORML');
  });

  it('plain ⇒ 空文本体的裸指令同样不落 D（防御性空体与空行同口径）', () => {
    const empty = narrationLine({ parts: [] });
    expect(backendOf({ profile: { colorMode: 'plain' } }).text.line(empty)).toBe('PRINTFORMW');
    expect(backendOf().text.line(empty)).toBe('PRINTFORMDW');
  });
});

describe('waitDefault：无「续」时的等待轴（core 读 backend.profile）', () => {
  const SOURCE = ['# 视 灵梦', '# 机 指令 310', '> 她点了点头。', '灵梦：「今天也来训练了？」', ''].join('\n');
  const compile = (backend: KojoEmitBackend): string =>
    createKojo2TranspileService({ adapter: ERATW_GAME_ADAPTER, backend }).transpile({
      source: SOURCE,
      filePath: 'kojo2-wait-default.kojo2',
    }).erb;

  it('缺省 wait → 无「续」的行落 W', () => {
    expect(compile(backendOf())).toContain('    PRINTFORMW 她点了点头。');
    expect(compile(backendOf())).toContain('    PRINTFORMW 今天也来训练了？');
  });

  it('覆盖 continue → 无「续」的行落 L（等待不再被默认补上）', () => {
    const erb = compile(backendOf({ profile: { waitDefault: 'continue' } }));
    expect(erb).toContain('    PRINTFORML 她点了点头。');
    expect(erb).toContain('    PRINTFORML 今天也来训练了？');
    expect(erb).not.toContain('PRINTFORMW 她点了点头。');
  });
});

describe('randStyle：@随机 落点', () => {
  it('缺省 printdata → 单行纯文本候选落 PRINTDATA（回归：不变）', () => {
    expect(asLines(backendOf().presentation.randomBlock(randomRequest(), () => []))).toEqual([
      'PRINTDATA',
      '    DATAFORM ……呼。',
      'ENDDATA',
    ]);
  });

  it('覆盖 rand-selectcase → 同一请求改落 RAND+SELECTCASE（不再 PRINTDATA）', () => {
    const lines = asLines(
      backendOf({ profile: { randStyle: 'rand-selectcase' } }).presentation.randomBlock(randomRequest(), () => [
        'PRINTFORML 候选',
      ]),
    );
    expect(lines[0]).toBe('__kojo_rand_9 = RAND:1');
    expect(lines).toContain('SELECTCASE __kojo_rand_9');
    expect(lines.at(-1)).toBe('ENDSELECT');
    expect(lines).not.toContain('PRINTDATA');
  });

  it('覆盖 printdatal（DATALIST 落点无数据）→ fail-closed，不静默回退 PRINTDATA', () => {
    const failure = failureOf(
      backendOf({ profile: { randStyle: 'printdatal' } }).presentation.randomBlock(randomRequest(), () => []),
    );
    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('printdatal');
  });
});

describe('poolStyle：落点事实面读数（声明口径，不改等值分派旁路）', () => {
  it('覆盖值进入 backend.profile（core / 一致性套件读的就是它）', () => {
    const profile = resolveEratwProfile({ poolStyle: 'selectcase' });
    expect(profile.poolStyle).toBe('selectcase');
    expect(backendOf({ profile: { poolStyle: 'selectcase' } }).profile.poolStyle).toBe('selectcase');
  });

  it('产物不随它开关：可证等值的池在两种 poolStyle 下逐字节相同', () => {
    // `# 池` 的等值分派是"等值可证时的语义等价优化"（core pool-plan 判据），
    // poolStyle 声明的是"不可证时的兜底形状"（core 自己的 IF 链）——两者不是互斥开关。
    const SOURCE = [
      '# 视 灵梦',
      '# 机 初见',
      '# 池 等级问候',
      '    ? 好感 == 0',
      '        > 嗯。',
      '    ? 好感 == 1',
      '        > 早上好。',
      '    ? 好感 == 2',
      '        > 亲爱的，早安。',
      '    ? 否',
      '        > ……？',
      '! 等级问候',
      '',
    ].join('\n');
    const compile = (profile: EratwProfileOverrides | undefined): string =>
      createKojo2TranspileService({ adapter: ERATW_GAME_ADAPTER, backend: backendOf({ profile }) }).transpile({
        source: SOURCE,
        filePath: 'kojo2-pool-style.kojo2',
      }).erb;
    const byDefault = compile(undefined);
    expect(byDefault).toContain('SELECTCASE __kojo_pool_等级问候');
    expect(compile({ poolStyle: 'if' })).toBe(byDefault);
    expect(compile({ poolStyle: 'selectcase' })).toBe(byDefault);
  });
});

describe('presentations：演出能力面覆盖（core 的能力闸读 backend.profile）', () => {
  it('heart=false → hintSupport 报 unsupported（不生成无效 HPH_PRINT）', () => {
    expect(backendOf().hintSupport('心形')).toBe('supported');
    expect(backendOf({ profile: { presentations: { heart: false } } }).hintSupport('心形')).toBe('unsupported');
  });

  it('其余键不受影响（深合并），options=false 也能读到', () => {
    const backend = backendOf({ profile: { presentations: { options: false } } });
    expect(backend.profile.presentations).toEqual({ heart: true, color: true, face: true, random: true, options: false });
  });
});

/* ============================== 4. adapter 声明 → 落点（映射表） ============================== */

describe('adapterProfile：声明 → 落点的写死映射表', () => {
  it('映射表正好是六个落点字段（features / programFeatures / presentations / priorityModel 不在其中）', () => {
    expect(ERATW_ADAPTER_PROFILE_LANDING_FIELDS).toEqual([
      'narrationColor',
      'dialogueColor',
      'waitDefault',
      'colorMode',
      'poolStyle',
      'randStyle',
    ]);
    for (const field of ERATW_ADAPTER_PROFILE_LANDING_FIELDS) {
      expect(ERATW_ADAPTER_PROFILE_LANDING[field]).toBe(field);
    }
    expect(Object.keys(ERATW_ADAPTER_PROFILE_LANDING)).not.toContain('features');
    expect(Object.keys(ERATW_ADAPTER_PROFILE_LANDING)).not.toContain('programFeatures');
  });

  it('映射函数只搬六个字段：adapter 的 features 不进覆盖对象', () => {
    const overrides = eratwAdapterProfileOverrides(ERATW_GAME_ADAPTER.profile);
    expect(Object.keys(overrides).sort()).toEqual([...ERATW_ADAPTER_PROFILE_LANDING_FIELDS].sort());
    expect(overrides).toEqual({
      narrationColor: 'author',
      dialogueColor: 'author',
      waitDefault: 'wait',
      colorMode: 'D',
      poolStyle: 'if',
      randStyle: 'printdata',
    });
  });

  it('adapter 声明 default ⇒ backend 落点同源（旁白真的落 D 系）', () => {
    const adapterProfile: AdapterProfile = Object.freeze({
      ...ERATW_GAME_ADAPTER.profile,
      narrationColor: 'default',
    });
    const backend = backendOf({ adapterProfile });
    expect(backend.profile.narrationColor).toBe('default');
    expect(backend.text.line(narrationLine())).toBe('PRINTFORMDW 她点了点头。');
  });

  it('声明不搬 programFeatures / presentations / priorityModel（双源对拍纪律照旧）', () => {
    const backend = backendOf({ adapterProfile: ERATW_GAME_ADAPTER.profile });
    // 这三个面由 kojo2 数据派生，与 adapter 声明无关
    expect(backend.profile.programFeatures).toEqual(ERATW_DEFAULT_LOWERING_PROFILE.programFeatures);
    expect(backend.profile.presentations).toEqual(ERATW_DEFAULT_LOWERING_PROFILE.presentations);
    expect(backend.profile.priorityModel).toBe(ERATW_DEFAULT_LOWERING_PROFILE.priorityModel);
  });

  it('显式 profile 盖 adapterProfile 同字段（生效覆盖最高优先级）', () => {
    const backend = backendOf({
      adapterProfile: Object.freeze({ ...ERATW_GAME_ADAPTER.profile, narrationColor: 'default' }),
      profile: { narrationColor: 'author' },
    });
    expect(backend.profile.narrationColor).toBe('author');
    expect(backend.text.line(narrationLine())).toBe('PRINTFORMW 她点了点头。');
  });

  it('传缺省 adapter 声明 ⇒ 与完全不传逐字段相同（映射是缺省保真的）', () => {
    expect(backendOf({ adapterProfile: ERATW_GAME_ADAPTER.profile }).profile).toEqual(backendOf().profile);
  });
});

/* ============================== 5. fail-closed（不静默用默认） ============================== */

describe('fail-closed：非法覆盖抛错，且不静默回缺省', () => {
  const BAD_ENUM: readonly (readonly [string, string])[] = [
    ['narrationColor', 'none'],
    ['dialogueColor', 'auto'],
    ['waitDefault', 'sometimes'],
    ['colorMode', 'd'],
    ['poolStyle', 'switch'],
    ['randStyle', 'datalist'],
  ];

  it.each(BAD_ENUM)('%s 非法值 → RangeError（消息点名该字段）', (field, value) => {
    expect(() => resolveEratwProfile(asOverrides({ [field]: value }))).toThrowError(
      new RegExp(`profile\\.${field} 非法`),
    );
  });

  it('非落点字段 features → TypeError，并指出该走 adapter.profile', () => {
    expect(() => resolveEratwProfile(asOverrides({ features: ['program'] }))).toThrowError(/features/);
    expect(() => resolveEratwProfile(asOverrides({ features: ['program'] }))).toThrowError(/adapter\.profile/);
  });

  it('priorityModel 不接受覆盖（由事件目录推）', () => {
    expect(() => resolveEratwProfile(asOverrides({ priorityModel: 'none' }))).toThrowError(/priorityModel/);
  });

  it('完全陌生的键 → TypeError（拼错不静默忽略）', () => {
    expect(() => resolveEratwProfile(asOverrides({ narrationColour: 'default' }))).toThrowError(
      /narrationColour/,
    );
  });

  it('presentations 未知键 / 非布尔 / 非对象 → TypeError', () => {
    expect(() => resolveEratwProfile(asOverrides({ presentations: { hearts: true } }))).toThrowError(/hearts/);
    expect(() => resolveEratwProfile(asOverrides({ presentations: { heart: 'yes' } }))).toThrowError(
      /必须是布尔值/,
    );
    expect(() => resolveEratwProfile(asOverrides({ presentations: [] }))).toThrowError(/必须是对象/);
  });

  it('programFeatures 未知键 → TypeError', () => {
    expect(() => resolveEratwProfile(asOverrides({ programFeatures: { switch: false } }))).toThrowError(
      /programFeatures\.switch/,
    );
  });

  it('工厂不吞错：非法覆盖在 createEratwEmitBackend 就抛（不产"看起来能用"的实例）', () => {
    expect(() => backendOf({ profile: asOverrides({ waitDefault: 'maybe' }) })).toThrowError(/waitDefault/);
  });

  it('adapter 声明里的非法值同样 fail-closed（不"顺手修成缺省"）', () => {
    const broken = asOverrides({ ...ERATW_GAME_ADAPTER.profile, colorMode: 'd' }) as unknown as AdapterProfile;
    expect(() => backendOf({ adapterProfile: broken })).toThrowError(/colorMode/);
  });
});

/* ============================== 6. 端到端 golden（`# 机` + 旁白） ============================== */

const E2E_SOURCE = [
  '# 视 灵梦',
  '# 机 指令 310',
  '> 她点了点头。',
  '> 她叹了口气。 续',
  '灵梦：「今天也来训练了？」',
  '',
].join('\n');

function compileE2E(profile: EratwProfileOverrides | undefined): string {
  return createKojo2TranspileService({ adapter: ERATW_GAME_ADAPTER, backend: backendOf({ profile }) }).transpile({
    source: E2E_SOURCE,
    filePath: 'kojo2-profile-override.kojo2',
  }).erb;
}

const E2E_HEAD = `;kojo2: # 机 指令 310
@M_KOJO_MESSAGE_COM_K12_310(ARG)
CALL M_KOJO_MESSAGE_COM_K12_310_1(ARG)
RETURN RESULT

@M_KOJO_MESSAGE_COM_K12_310_1(ARG)
;-------------------------------------------------
;記入チェック（=0, 非表示、1, 表示）
LOCAL = 1
;-------------------------------------------------
IF LOCAL
`;

describe('端到端 golden：`# 机` + 旁白（缺省 vs narrationColor=default）', () => {
  it('缺省（adapter 作者色）→ 旁白非 D 系', () => {
    expect(compileE2E(undefined)).toBe(`${E2E_HEAD}    PRINTFORMW 她点了点头。
    PRINTFORML 她叹了口气。
    PRINTFORMW 今天也来训练了？
ENDIF
RETURN 1
`);
  });

  it('narrationColor=default → 旁白落 D 系（PRINTFORMDW / PRINTFORMDL），台词仍非 D', () => {
    expect(compileE2E({ narrationColor: 'default' })).toBe(`${E2E_HEAD}    PRINTFORMDW 她点了点头。
    PRINTFORMDL 她叹了口气。
    PRINTFORMW 今天也来训练了？
ENDIF
RETURN 1
`);
  });

  it('两份 golden 只差 D 字母（覆盖只动取色轴，不动结构/台词）', () => {
    const byDefault = compileE2E(undefined).split('\n');
    const byDefaultColor = compileE2E({ narrationColor: 'default' }).split('\n');
    expect(byDefaultColor.length).toBe(byDefault.length);
    byDefault.forEach((line, index) => {
      const expected =
        line === '    PRINTFORMW 她点了点头。'
          ? '    PRINTFORMDW 她点了点头。'
          : line === '    PRINTFORML 她叹了口气。'
            ? '    PRINTFORMDL 她叹了口气。'
            : line;
      expect(byDefaultColor[index]).toBe(expected);
    });
  });

  it('与 v1 口径对照：迁移语料 case 的旁白行在 default 下与 v1 产物同形', () => {
    // 语料 `narration-spec-default` 的 v1 真产物就是 PRINTFORMDW / PRINTFORMDL 两条旁白
    // （见 packages/kojo-core/tests/fixtures/migrate-corpus/narration-spec-default.v1.erb），
    // 本端到端只证 2.0 侧在 default 下能产出同形落点——语料 golden 的再生成不在本包范围。
    const erb = compileE2E({ narrationColor: 'default' });
    expect(erb).toContain('    PRINTFORMDW 她点了点头。');
    expect(erb).toContain('    PRINTFORMDL 她叹了口气。');
  });
});
