/**
 * `@巡` 的 2.0 **主链**用例（K2-FOREACH 接线）：`compileKojoSource` 走真前端 + fixture adapter/backend。
 *
 * 断言面（全是契约事实，不是 ERB 形状）：
 * - 索引循环由 backend 的 `program.forEachLoop` 发（core 只发请求：plan + 已降糖 body）；
 * - 绑定名改写 = 帧作用域（只在该循环体内生效、内层遮蔽外层、出体即失效）；
 * - 数组事实来自作者 `# 变量 名 类型[N]`，长度经 `# 常量` 解析；长度 0 ⇒ 计划写死"整块跳过"；
 * - 隐藏槽（`__kojo_foreach_*`）按 plan 的槽类型记录（int/string + 角色），装配交给 adapter；
 * - fail-closed：未声明集合 / feature 关闭 / backend 缺 `forEachLoop` ⇒ 恰一条 error、零字节、零落点调用。
 */
import { describe, expect, it } from 'vitest';

import type {
  EmitResult,
  ForEachEmitRequest,
  GameAdapter,
  KojoEmitBackend,
  KojoHiddenSlot,
  ProgramFeatures,
} from '../src/index.js';
import { checkProgramFeature, compileKojoSource, FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/index.js';
import type { ForeachCollectionDecl, ForeachDeclarations } from '../src/lower/expand/foreach.js';

/* ============================== 夹具 ============================== */

/** 角色集合：1 号起、引擎计数器长度、`{角}`/`{名}` */
const TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
  bindings: ['角', '名'],
  nameAccessor: 'CALLNAME',
};

const FOREACH_DECLARATIONS: ForeachDeclarations = {
  collections: [TEAM],
  arrayRule: { base: 0, bindings: ['值', '下标'] },
};

const ALL_PROGRAM_FEATURES: ProgramFeatures = {
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
};

/** fixture adapter + `@巡` 集合声明（features 里补 program，契约自洽） */
function foreachAdapter(overrides: Partial<GameAdapter> = {}): GameAdapter {
  return {
    ...FIXTURE_ADAPTER,
    profile: { ...FIXTURE_ADAPTER.profile, features: ['program'] },
    programFeatures: ALL_PROGRAM_FEATURES,
    foreachCollections: FOREACH_DECLARATIONS,
    ...overrides,
  };
}

interface Capture {
  readonly backend: KojoEmitBackend;
  readonly requests: ForEachEmitRequest[];
}

/**
 * fixture backend + 程序层全开（`programFeatureEnabled` 读的是 **backend.profile**，
 * 不是 adapter.programFeatures：块级能力闸归 backend，adapter 侧只给查询/补全口径）。
 */
function baseBackend(programFeatures: ProgramFeatures = ALL_PROGRAM_FEATURES): KojoEmitBackend {
  return {
    ...FIXTURE_BACKEND,
    profile: { ...FIXTURE_BACKEND.profile, programFeatures },
  };
}

/** 捕获 `program.forEachLoop` 请求的 backend：产物是确定性结构编码（不是 ERB） */
function capturingBackend(programFeatures: ProgramFeatures = ALL_PROGRAM_FEATURES): Capture {
  const requests: ForEachEmitRequest[] = [];
  const base = baseBackend(programFeatures);
  const backend: KojoEmitBackend = {
    ...base,
    program: {
      ...base.program,
      forEachLoop(request: ForEachEmitRequest): EmitResult {
        requests.push(request);
        const lines: string[] = [`LOOP|${request.plan.kind}|${request.plan.collection}`];
        for (const binding of request.plan.bindings) lines.push(`BIND|${binding.name}|${binding.slot}`);
        for (const line of request.body) lines.push(line);
        lines.push('LOOP.END');
        return lines;
      },
    },
  };
  return { backend, requests };
}

function compile(source: string, adapter: GameAdapter = foreachAdapter(), backend: KojoEmitBackend = baseBackend()) {
  return compileKojoSource({ source, adapter, backend });
}

function linesOf(erb: string): readonly string[] {
  return erb === '' ? [] : erb.slice(0, -1).split('\n');
}

function errorCodes(result: ReturnType<typeof compile>): readonly string[] {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((diagnostic) => diagnostic.code);
}

/* ============================== 角色集合 ============================== */

const TEAM_SOURCE = ['# 机 开场', '@巡 队伍', '    ? {角} >= 2', '        > 轮到{名}。'].join('\n');

describe('`@巡` 主链 · 角色集合', () => {
  it('索引循环由 backend 发：plan + 槽绑定 + 已降糖 body 一次交给 program.forEachLoop', () => {
    const capture = capturingBackend();
    const result = compile(TEAM_SOURCE, foreachAdapter(), capture.backend);

    expect(errorCodes(result)).toEqual([]);
    expect(capture.requests).toHaveLength(1);
    const request = capture.requests[0]!;
    expect(request.plan.kind).toBe('characters');
    expect(request.plan.collection).toBe('队伍');
    expect(request.plan.slots.map((slot) => slot.name)).toEqual([
      '__kojo_foreach_2_i',
      '__kojo_foreach_2_e',
      '__kojo_foreach_2_n',
    ]);
    // body 已降糖：绑定名已换成槽名，条件/文本都改写过
    expect(request.body).toEqual([
      'SIF {__kojo_foreach_2_e >= 2}',
      'TELL: 轮到{__kojo_foreach_2_n}。 /WAIT',
    ]);
  });

  it('golden：`# 机` 包装 + 隐藏槽声明 + 循环体逐行（core 零引擎关键字）', () => {
    const result = compile(TEAM_SOURCE);

    expect(result.ok).toBe(true);
    expect(linesOf(result.erb)).toEqual([
      'MACHINE 开场',
      ';SLOT __kojo_foreach_2_i foreach int',
      ';SLOT __kojo_foreach_2_e foreach int',
      ';SLOT __kojo_foreach_2_n foreach string',
      'FOREACH|characters|队伍',
      'BIND|角|__kojo_foreach_2_e',
      'BIND|名|__kojo_foreach_2_n',
      'SIF {__kojo_foreach_2_e >= 2}',
      'TELL: 轮到{__kojo_foreach_2_n}。 /WAIT',
      'FOREACH.END',
      'MACHINE.END',
    ]);
    // core 产物里没有引擎关键字：FOR/NEXT 只由 adapter 的 emitter 出
    expect(result.erb).not.toMatch(/\bFOR\b|\bNEXT\b/);
  });

  it('隐藏槽事实：kind=foreach、角色按 plan 的槽角色、string/int 分开', () => {
    const result = compile(TEAM_SOURCE);

    expect(result.slots).toEqual([
      { name: '__kojo_foreach_2_i', kind: 'foreach', valueType: 'int', role: 'foreach-index' },
      { name: '__kojo_foreach_2_e', kind: 'foreach', valueType: 'int', role: 'foreach-element' },
      { name: '__kojo_foreach_2_n', kind: 'foreach', valueType: 'string', role: 'foreach-name' },
    ]);
  });
});

/* ============================== 作者数组 ============================== */

const ARRAY_SOURCE = [
  '# 机 开场',
  '# 变量 队伍状态 字符串[4]',
  '@巡 队伍状态',
  '    > 第{下标 + 1}位：{值}。',
].join('\n');

describe('`@巡` 主链 · 作者数组事实', () => {
  it('`# 变量 名 类型[N]` → 数组事实；值槽承接元素类型，长度取声明值', () => {
    const capture = capturingBackend();
    const result = compile(ARRAY_SOURCE, foreachAdapter(), capture.backend);

    expect(errorCodes(result)).toEqual([]);
    const plan = capture.requests[0]!.plan;
    expect(plan.kind).toBe('array');
    expect(plan.elementType).toBe('string');
    expect(plan.length).toEqual({ kind: 'declared', size: 4 });
    expect(plan.bindings).toEqual([
      { name: '值', source: 'element', valueType: 'string', slot: '__kojo_foreach_3_e' },
      { name: '下标', source: 'index', valueType: 'int', slot: '__kojo_foreach_3_i' },
    ]);
    // 元素槽是 string → 声明走 #DIMS 的事实来源
    expect(result.slots.find((slot) => slot.name === '__kojo_foreach_3_e')?.valueType).toBe('string');
    expect(capture.requests[0]!.body).toEqual(['TELL: 第{__kojo_foreach_3_i + 1}位：{__kojo_foreach_3_e}。 /WAIT']);
  });

  it('长度可以是已声明的整数常量（`# 变量 名 整数[容量]`）', () => {
    const source = [
      '# 机 开场',
      '# 常量 容量 整数 = 3',
      '# 变量 缓冲 整数[容量]',
      '@巡 缓冲',
      '    > {值}',
    ].join('\n');
    const capture = capturingBackend();
    compile(source, foreachAdapter(), capture.backend);

    expect(capture.requests[0]!.plan.length).toEqual({ kind: 'declared', size: 3 });
  });

  it('表达式里的 `{名字}` 简写（§2.5：等价于裸名字）→ 槽名裸写，花括号不落产物', () => {
    const source = [
      '# 机 开场',
      '# 变量 状态 字符串[2]',
      '@巡 状态',
      '    ? {值} == "好"',
      '        > 好',
    ].join('\n');
    const capture = capturingBackend();
    const result = compile(source, foreachAdapter(), capture.backend);

    expect(errorCodes(result)).toEqual([]);
    // fixture 的 SIF 头自己会包一层 `{…}`；源里的花括号已解掉（否则这里是 `{{…}}`）
    expect(capture.requests[0]!.body[0]).toBe('SIF {__kojo_foreach_3_e == "好"}');
  });

  it('长度解析成 0 ⇒ 计划写死"整块跳过"（`FOR i, 0, 0` = 零轮；不先跑一轮空体）', () => {
    const source = [
      '# 机 开场',
      '# 常量 零 整数 = 0',
      '# 变量 空表 整数[零]',
      '@巡 空表',
      '    > 不该出现。',
    ].join('\n');
    const capture = capturingBackend();
    const result = compile(source, foreachAdapter(), capture.backend);

    expect(errorCodes(result)).toEqual([]);
    const plan = capture.requests[0]!.plan;
    expect(plan.length).toEqual({ kind: 'declared', size: 0 });
    expect(plan.skeleton.empty).toBe('skip');
    expect(plan.skeleton.start).toBe(0);
  });

  it('长度解析不出（未声明常量）⇒ 不进数组事实 ⇒ 按未声明报错（不静默放行）', () => {
    const source = ['# 机 开场', '# 变量 缓冲 整数[未声明]', '@巡 缓冲', '    > 一'].join('\n');
    const result = compile(source, foreachAdapter());

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.erb).toBe('');
    expect(result.diagnostics[0]?.message).toContain('数组');
  });
});

/* ============================== 作用域 ============================== */

describe('`@巡` 主链 · 绑定作用域', () => {
  it('出体即失效：循环后的 `{值}` 保持作者原文（不做全局改名）', () => {
    const source = [
      '# 机 开场',
      '# 变量 状态 字符串[2]',
      '@巡 状态',
      '    > 内{值}。',
      '> 外{值}。',
    ].join('\n');
    const result = compile(source);
    const lines = linesOf(result.erb);

    expect(lines).toContain('TELL: 内{__kojo_foreach_3_e}。 /WAIT');
    expect(lines).toContain('TELL: 外{值}。 /WAIT');
  });

  it('嵌套循环：槽名按各自块头行号，内层绑定遮蔽外层、外层绑定在内层仍可见', () => {
    const source = [
      '# 机 开场',
      '# 变量 状态 字符串[2]',
      '@巡 队伍',
      '    @巡 状态',
      '        > {名} / {值} / {下标}',
    ].join('\n');
    const capture = capturingBackend();
    const result = compile(source, foreachAdapter(), capture.backend);

    expect(errorCodes(result)).toEqual([]);
    expect(capture.requests).toHaveLength(2);
    // 体先降糖、头后发射：请求顺序是内层先到（post-order），按集合名取各自计划
    const outer = capture.requests.find((request) => request.plan.collection === '队伍')!;
    const inner = capture.requests.find((request) => request.plan.collection === '状态')!;
    expect(outer.plan.index.name).toBe('__kojo_foreach_3_i');
    expect(inner.plan.index.name).toBe('__kojo_foreach_4_i');
    expect(inner.body).toEqual([
      'TELL: {__kojo_foreach_3_n} / {__kojo_foreach_4_e} / {__kojo_foreach_4_i} /WAIT',
    ]);
    // 槽清单：外层先记、内层后记（声明序 = 首次发射序）
    expect(result.slots.map((slot) => slot.name)).toEqual([
      '__kojo_foreach_3_i',
      '__kojo_foreach_3_e',
      '__kojo_foreach_3_n',
      '__kojo_foreach_4_i',
      '__kojo_foreach_4_e',
    ]);
  });
});

describe('`@巡` 主链 · 隐藏槽作用域（`@织` 监听）', () => {
  it('监听体里的 `@巡` 槽只进该监听自己的声明清单，不串进 `# 机` 主场景', () => {
    const slotLists: KojoHiddenSlot[][] = [];
    const base = baseBackend();
    const backend: KojoEmitBackend = {
      ...base,
      profile: { ...base.profile, priorityModel: 'emuera-buckets' },
      weave: {
        weaveHeader(request): EmitResult {
          slotLists.push([...request.slots]);
          return `WEAVE ${request.event}`;
        },
        weaveFooter(): EmitResult {
          return 'WEAVE.END';
        },
      },
    };
    const source = [
      '# 机 开场',
      '# 变量 状态 字符串[2]',
      '@织 收场 之后',
      '    @巡 状态',
      '        > {值}',
      '> 主场景。',
    ].join('\n');
    const result = compile(source, foreachAdapter(), backend);

    expect(errorCodes(result)).toEqual([]);
    // 主场景没有 @巡 → 没有 foreach 槽
    expect(result.slots).toEqual([]);
    expect(slotLists).toHaveLength(1);
    expect(slotLists[0]!.map((slot) => [slot.name, slot.kind, slot.valueType])).toEqual([
      ['__kojo_foreach_4_i', 'foreach', 'int'],
      ['__kojo_foreach_4_e', 'foreach', 'string'],
    ]);
    expect(result.erb).toContain('WEAVE 收场');
  });
});

/* ============================== fail-closed ============================== */

describe('`@巡` 主链 · fail-closed（恰一条 error、零字节、零落点调用）', () => {
  it('未声明集合：core/expr/unknown-symbol，backend 不被调用', () => {
    const capture = capturingBackend();
    const result = compile(['# 机 开场', '@巡 不存在', '    > 一'].join('\n'), foreachAdapter(), capture.backend);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(errorCodes(result)).toEqual(['core/expr/unknown-symbol']);
    expect(capture.requests).toEqual([]);
  });

  it('adapter 没有集合声明（foreachCollections = null）⇒ 未声明集合，不猜', () => {
    // K2-FEATURE-GATE-UNIFY：能力闸收成单源后，`FIXTURE_ADAPTER`（programFeatures 全关）+ 程序层
    // 全开的 backend 属于**双源不一致**，编译入口会先报 6 条能力闸 error（不再走到集合解析）。
    // 本用例要测的是"能力开着、但集合没声明"⇒ 显式让 adapter 声明 foreach 能力、只把集合留空。
    const result = compile(TEAM_SOURCE, foreachAdapter({ foreachCollections: null }));

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('没有声明任何集合');
  });

  it('feature 关闭（backend profile）：只报一条 core/control/unsupported（与 checkProgramFeature 同码，不双报）', () => {
    const adapter = foreachAdapter();
    const capture = capturingBackend({ ...ALL_PROGRAM_FEATURES, foreach: false });
    const result = compile(TEAM_SOURCE, adapter, capture.backend);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(errorCodes(result)).toEqual(['core/control/unsupported']);
    expect(result.diagnostics).toHaveLength(1);
    // 码口径与 adapter 查询侧一致：同一情形只有一份码
    expect(checkProgramFeature(adapter, 'foreach')).toBeNull();
    // adapter 侧也关闭时，查询与主链同一个码（不出现 core/feature/unsupported 的第二套）
    expect(checkProgramFeature(foreachAdapter({ programFeatures: { ...ALL_PROGRAM_FEATURES, foreach: false } }), 'foreach')?.code).toBe(
      'core/control/unsupported',
    );
    expect(capture.requests).toEqual([]);
  });

  it('backend 没实现 program.forEachLoop ⇒ core/feature/unsupported + 零字节（additive 兼容面）', () => {
    const base = baseBackend();
    const legacy: KojoEmitBackend = {
      ...base,
      program: { ...base.program, forEachLoop: undefined },
    };
    const result = compile(TEAM_SOURCE, foreachAdapter(), legacy);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(errorCodes(result)).toEqual(['core/feature/unsupported']);
    expect(result.diagnostics[0]?.message).toContain('program.forEachLoop');
  });
});
