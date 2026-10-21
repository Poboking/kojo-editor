/**
 * `选项`（2.0 待定 UI，§7.5）展开测试。
 *
 * 三层：
 * 1) **ETB 计划**：按钮顺序 / 回传值分配 / 输入步 / 分支骨架纯结构断言；
 * 2) **降糖**：块体走 2.0 叙事 lower（含条件链）、plan 原样交给 adapter、pending warning 只一次；
 * 3) **fail-closed**：adapter 未声明 `presentation.options` / backend profile 未开 ⇒
 *    `core/feature/unsupported` error、零 adapter 调用、零半成品字节。
 *
 * 走真实前端（`parseSource`）取 AST，不手搭节点；adapter 用到位字段扩展的 fixture。
 */
import { describe, expect, it } from 'vitest';
import type {
  EmitResult,
  GameAdapter,
  KojoEmitBackend,
  KojoLoweringProfile,
  KojoOptionsBlock,
  OptionsEmitRequest,
  OptionsPresentation,
} from '../src/index.js';
import {
  compileKojoSource,
  createDiagnosticSink,
  createEmitBuffer,
  createLowerState,
  FIXTURE_BACKEND,
  lowerNarrativeNodes,
  parseSource,
} from '../src/index.js';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter.js';
import type { DiagnosticSink } from '../src/diagnostics.js';
import type { LowerState } from '../src/lower/state.js';
import {
  lowerOptionsBlockExpanded,
  planOptionsBlock,
  type OptionsEtbPlan,
} from '../src/lower/expand/options.js';
import { ALL_PRESENTATIONS, createFakeBackend } from './lower-fake-backend.js';

/* ============================== 夹具 ============================== */

const MACHINE = '# 机 开场\n';

const OPTIONS_UI: OptionsPresentation = {
  status: 'pending',
  button: 'BTN',
  input: 'INPUTS',
  result: 'RESULTS',
  maxPerScene: 1,
};

/** fixture adapter + 声明了 `选项` UI 的变体（深冻结对象用展开复制，不改原件） */
function adapterWithOptions(): GameAdapter {
  return {
    ...FIXTURE_ADAPTER,
    presentation: { ...FIXTURE_ADAPTER.presentation, options: OPTIONS_UI },
  };
}

function optionsNode(source: string): KojoOptionsBlock {
  const file = parseSource(source);
  for (const scene of file.scenes) {
    for (const node of scene.items) {
      if (node.kind === 'optionsBlock') return node;
    }
  }
  throw new Error('fixture 里没有 `选项` 块');
}

interface Capture {
  readonly backend: KojoEmitBackend;
  readonly requests: OptionsEmitRequest[];
}

/** 捕获 optionsBlock 请求的 fake backend：头 + 各按钮正文 + 尾（确定性 token） */
function capturingBackend(
  presentations: KojoLoweringProfile['presentations'] = ALL_PRESENTATIONS,
): Capture {
  const base = createFakeBackend({ profile: { presentations } });
  const requests: OptionsEmitRequest[] = [];
  const backend: KojoEmitBackend = {
    ...base,
    presentation: {
      ...base.presentation,
      optionsBlock(request, lowerItem): EmitResult {
        requests.push(request);
        const lines: string[] = [`OPTIONS|${request.items.map((item) => item.label).join('|')}`];
        request.items.forEach((item, index) => {
          lines.push(...lowerItem(item, index));
        });
        lines.push('OPTIONSEND');
        return lines;
      },
    },
  };
  return { backend, requests };
}

interface RunResult {
  readonly lines: readonly string[];
  readonly sink: DiagnosticSink;
  readonly state: LowerState;
}

function run(
  node: KojoOptionsBlock,
  env: { readonly adapter: GameAdapter },
  backend: KojoEmitBackend,
  sink: DiagnosticSink = createDiagnosticSink(),
): RunResult {
  const state = createLowerState({ backend, buffer: createEmitBuffer(16), sink, view: null });
  lowerOptionsBlockExpanded(node, env, state, (child, item) => lowerNarrativeNodes(item.body, child));
  return { lines: state.buffer.finish().lines, sink, state };
}

const codesOf = (sink: DiagnosticSink): readonly string[] => sink.all.map((diagnostic) => diagnostic.code);
const pendingOf = (sink: DiagnosticSink): number =>
  sink.all.filter((diagnostic) => diagnostic.code === 'core/options/pending').length;

const TWO_BUTTONS = [
  MACHINE,
  '选项：',
  '    「用亲吻代替回答」：',
  '        灵梦：「……唔。」',
  '    「摸摸头」：',
  '        灵梦：「……好。」',
  '',
].join('\n');

/* ============================== 1. ETB 计划 ============================== */

describe('`选项` ETB 计划：按钮顺序 / 回传值 / 输入步 / 分支骨架', () => {
  it('按钮按书写顺序编号，回传值 `1..n`，分支与按钮一一对应', () => {
    const node = optionsNode(TWO_BUTTONS);
    const plan: OptionsEtbPlan = planOptionsBlock(node);

    expect(plan.buttons.map((button) => [button.order, button.value, button.label])).toEqual([
      [1, '1', '用亲吻代替回答'],
      [2, '2', '摸摸头'],
    ]);
    expect(plan.input).toEqual({
      kind: 'button-input',
      dispatch: 'button-value',
      values: ['1', '2'],
    });
    expect(plan.branches.map((branch) => [branch.order, branch.value])).toEqual([
      [1, '1'],
      [2, '2'],
    ]);
    // 分支正文仍是 2.0 AST（不在这里丢块体）
    expect(plan.branches[0]!.item).toBe(node.items[0]);
    expect(plan.branches[1]!.item).toBe(node.items[1]);
    expect(plan.span).toEqual(node.span);
  });

  it('空选项块：零按钮 / 零值 / 零分支（不发散、不造假档位）', () => {
    const node = optionsNode(`${MACHINE}选项：\n`);
    const plan = planOptionsBlock(node);
    expect(plan.buttons).toEqual([]);
    expect(plan.input.values).toEqual([]);
    expect(plan.branches).toEqual([]);
  });
});

/* ============================== 2. 降糖：块体不丢 ============================== */

describe('`选项` 降糖：块体走 2.0 叙事 lower', () => {
  it('两个按钮的正文按书写顺序进入产物；plan 原样交给 adapter', () => {
    const node = optionsNode(TWO_BUTTONS);
    const capture = capturingBackend();
    const result = run(node, { adapter: adapterWithOptions() }, capture.backend);

    expect(result.lines).toEqual([
      'OPTIONS|用亲吻代替回答|摸摸头',
      'T|dialogue|灵梦||wait|profile|||……唔。',
      'T|dialogue|灵梦||wait|profile|||……好。',
      'OPTIONSEND',
    ]);
    expect(capture.requests).toHaveLength(1);
    const request = capture.requests[0]!;
    expect(request.plan).toBeDefined();
    expect(request.plan?.buttons.map((button) => [button.order, button.value])).toEqual([
      [1, '1'],
      [2, '2'],
    ]);
    expect(request.plan?.branches).toHaveLength(2);
    expect(request.items).toBe(node.items);
  });

  it('块体内的条件链照常 lower（SIF/IF 链、两分支文本都在）', () => {
    const node = optionsNode(
      [
        MACHINE,
        '选项：',
        '    「甲」：',
        '        ? 恋慕 >= 100',
        '            灵梦：「喜欢。」',
        '        ? 否',
        '            灵梦：「不喜欢。」',
        '',
      ].join('\n'),
    );
    const capture = capturingBackend();
    const result = run(node, { adapter: adapterWithOptions() }, capture.backend);

    expect(result.lines).toContain('IF|恋慕 >= 100');
    expect(result.lines).toContain('ELSE');
    expect(result.lines).toContain('ENDIF');
    expect(result.lines.some((line) => line.endsWith('喜欢。') && !line.includes('不喜欢'))).toBe(true);
    expect(result.lines.some((line) => line.endsWith('不喜欢。'))).toBe(true);
  });

  it('待定 warning 是 warning 级且同一块只报一次', () => {
    const node = optionsNode(TWO_BUTTONS);
    const capture = capturingBackend();
    const result = run(node, { adapter: adapterWithOptions() }, capture.backend);
    expect(pendingOf(result.sink)).toBe(1);
    expect(result.sink.all.find((diagnostic) => diagnostic.code === 'core/options/pending')?.severity).toBe('warning');
  });

  it('parser 阶段已在同一行报过 pending：降糖不再重复（真 pipeline 的去重）', () => {
    const file = parseSource(TWO_BUTTONS);
    const node = optionsNode(TWO_BUTTONS);
    const sink = createDiagnosticSink();
    // 模拟 compile：解析诊断先并入同一 sink
    for (const diagnostic of file.diagnostics) sink.report(diagnostic);
    // parser 的 warning span 只覆盖块头行；块节点 span 覆盖整个块 ⇒ 去重必须按起始行判
    expect(file.diagnostics.filter((diagnostic) => diagnostic.code === 'core/options/pending')).toHaveLength(1);

    const capture = capturingBackend();
    run(node, { adapter: adapterWithOptions() }, capture.backend, sink);
    expect(pendingOf(sink)).toBe(1);
    expect(capture.requests).toHaveLength(1);
  });
});

/* ============================== 3. fail-closed ============================== */

describe('`选项` 能力闸：未声明即 fail-closed', () => {
  it('adapter 未声明 presentation.options：error + 零调用 + 零字节（body 也不半产）', () => {
    const node = optionsNode(TWO_BUTTONS);
    const capture = capturingBackend();
    const result = run(node, { adapter: FIXTURE_ADAPTER }, capture.backend);

    expect(codesOf(result.sink)).toEqual(['core/options/pending', 'core/feature/unsupported']);
    expect(result.sink.all[1]?.severity).toBe('error');
    expect(capture.requests).toEqual([]);
    expect(result.lines).toEqual([]);
  });

  it('adapter 声明了但 backend profile 未开：同样 fail-closed，不产半成品', () => {
    const node = optionsNode(TWO_BUTTONS);
    const capture = capturingBackend({ heart: true, color: true, face: true, random: true, options: false });
    const result = run(node, { adapter: adapterWithOptions() }, capture.backend);

    expect(codesOf(result.sink)).toEqual(['core/options/pending', 'core/feature/unsupported']);
    expect(capture.requests).toEqual([]);
    expect(result.lines).toEqual([]);
  });
});

/* ============================== 4. 主链（compileKojoSource） ============================== */

/** 主链 backend：fixture 的 `# 机` wrapper + 按 ETB 计划出「按钮 / 输入 / 分派」确定性骨架 */
function compileBackend(): Capture {
  const requests: OptionsEmitRequest[] = [];
  const backend: KojoEmitBackend = {
    ...FIXTURE_BACKEND,
    profile: {
      ...FIXTURE_BACKEND.profile,
      presentations: { ...FIXTURE_BACKEND.profile.presentations, options: true },
    },
    presentation: {
      ...FIXTURE_BACKEND.presentation,
      optionsBlock(request, lowerItem): EmitResult {
        requests.push(request);
        const plan = request.plan;
        if (plan === undefined) return ['OPTIONS|no-plan'];
        const lines: string[] = [];
        for (const button of plan.buttons) lines.push(`BTN|${button.label}|${button.value}`);
        lines.push('INPUT');
        for (const branch of plan.branches) {
          lines.push(`SELECT|${branch.value}`);
          lines.push(...lowerItem(branch.item, branch.order - 1));
        }
        lines.push('SELECT.END');
        return lines;
      },
    },
  };
  return { backend, requests };
}

describe('`选项` 主链：compileKojoSource 走真前端 + `# 机` 包装', () => {
  it('`# 机` 包装后出现按钮/输入/分派骨架，正文落在自己的档位里', () => {
    const capture = compileBackend();
    const result = compileKojoSource({
      source: TWO_BUTTONS,
      adapter: adapterWithOptions(),
      backend: capture.backend,
    });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(capture.requests).toHaveLength(1);

    // adapter 拿到的计划是主链算的 ETB 结构（不是 adapter 猜的）
    expect(capture.requests[0]?.plan?.buttons.map((button) => [button.order, button.value, button.label])).toEqual([
      [1, '1', '用亲吻代替回答'],
      [2, '2', '摸摸头'],
    ]);
    expect(capture.requests[0]?.plan?.input).toEqual({
      kind: 'button-input',
      dispatch: 'button-value',
      values: ['1', '2'],
    });

    const lines = result.erb.slice(0, -1).split('\n');
    expect(lines[0]).toBe('MACHINE 开场');
    expect(lines.at(-1)).toBe('MACHINE.END');
    expect(lines).toContain('BTN|用亲吻代替回答|1');
    expect(lines).toContain('BTN|摸摸头|2');
    expect(lines).toContain('INPUT');
    // 正文不丢，且落在自己的分派档位里（顺序 = 书写顺序）
    const case1 = lines.indexOf('SELECT|1');
    const case2 = lines.indexOf('SELECT|2');
    expect(case1).toBeGreaterThan(lines.indexOf('INPUT'));
    expect(case2).toBeGreaterThan(case1);
    expect(lines.indexOf('SAY 灵梦: ……唔。 /WAIT')).toBeGreaterThan(case1);
    expect(lines.indexOf('SAY 灵梦: ……唔。 /WAIT')).toBeLessThan(case2);
    expect(lines.indexOf('SAY 灵梦: ……好。 /WAIT')).toBeGreaterThan(case2);
    expect(lines.indexOf('SAY 灵梦: ……好。 /WAIT')).toBeLessThan(lines.indexOf('SELECT.END'));
  });

  it('golden：`# 机` + 选项块的真实 compile 产物逐字节', () => {
    const capture = compileBackend();
    const result = compileKojoSource({
      source: TWO_BUTTONS,
      adapter: adapterWithOptions(),
      backend: capture.backend,
    });

    expect(result.erb).toBe(
      [
        'MACHINE 开场',
        'BTN|用亲吻代替回答|1',
        'BTN|摸摸头|2',
        'INPUT',
        'SELECT|1',
        'SAY 灵梦: ……唔。 /WAIT',
        'SELECT|2',
        'SAY 灵梦: ……好。 /WAIT',
        'SELECT.END',
        'MACHINE.END',
      ].join('\n') + '\n',
    );
    expect(result.sourceMap.lineCount).toBe(10);
  });

  it('主链 fail-closed：adapter 未声明 UI ⇒ error、零字节、零 adapter 调用', () => {
    const capture = compileBackend();
    const result = compileKojoSource({
      source: TWO_BUTTONS,
      adapter: FIXTURE_ADAPTER,
      backend: capture.backend,
    });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'core/feature/unsupported' && diagnostic.severity === 'error',
      ),
    ).toBe(true);
    expect(capture.requests).toEqual([]);
  });
});
