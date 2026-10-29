/**
 * `runAdapterConformance` 自证：只用 core 的 `FIXTURE_ADAPTER` + `FIXTURE_BACKEND`，
 * 不依赖 eraTW（kit 的游戏事实全部由调用方注入）。
 *
 * 覆盖：契约自检 / backend 读数对拍 / golden 逐字节 / 事件·等待·取色读数 /
 * 诊断码+定位 / 失败报告形状 / smoke 显式 skip。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  type GameAdapter,
  type KojoEmitBackend,
} from '@kojo/kojo-core';
import * as kit from '../src/index.js';
import type { AdapterConformanceCase } from '../src/index.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

const BASIC = read('basic.kojo2');
const BASIC_GOLDEN = read('basic.golden.erb');
const COLOR = read('color.kojo2');
const COLOR_GOLDEN = read('color.golden.erb');

/** fixture adapter 追加 `@着色` 能力（证明取色读数不靠 eraTW） */
const COLOR_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  presentation: {
    ...FIXTURE_ADAPTER.presentation,
    color: { setColor: 'SETCOLOR', resetColor: 'RESETCOLOR', hexPrefix: '0x' },
  },
};

const COLOR_BACKEND: KojoEmitBackend = {
  ...FIXTURE_BACKEND,
  profile: {
    ...FIXTURE_BACKEND.profile,
    presentations: { ...FIXTURE_BACKEND.profile.presentations, color: true },
  },
};

/** fixture adapter 给 `收场` 加守卫：证明守卫读数来自 adapter 事实，kit 不解释表达式 */
const GUARDED_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  eventCatalog: {
    ...FIXTURE_ADAPTER.eventCatalog,
    events: FIXTURE_ADAPTER.eventCatalog.events.map((spec) =>
      spec.event === '收场' ? { ...spec, guard: { text: 'GUARD:7' } } : spec,
    ),
  },
};

function run(
  cases: readonly AdapterConformanceCase[],
  adapter: GameAdapter = FIXTURE_ADAPTER,
  backend: KojoEmitBackend = FIXTURE_BACKEND,
) {
  return kit.runAdapterConformance({ adapter, backend, cases });
}

describe('index · 公共入口', () => {
  it('kit / differential / encoding 三面都在唯一入口导出', () => {
    expect(typeof kit.runAdapterConformance).toBe('function');
    expect(typeof kit.compareArtifacts).toBe('function');
    expect(typeof kit.normalizeArtifact).toBe('function');
    expect(typeof kit.encodeConformanceText).toBe('function');
    expect(typeof kit.decodeConformanceText).toBe('function');
    expect(typeof kit.countArtifactLines).toBe('function');
  });
});

describe('契约自检 + 静态读数', () => {
  it('FIXTURE 契约自洽：0 诊断、profile/事件/守卫读数齐全，smoke 显式 skip', () => {
    const report = run([]);

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.contract.ok).toBe(true);
    expect(report.contract.diagnostics).toEqual([]);
    expect(report.contract.adapterId).toBe('fixture');
    expect(report.contract.backendId).toBe('fixture');

    expect(report.contract.profile).toMatchObject({
      waitDefault: 'wait',
      narrationColor: 'default',
      dialogueColor: 'default',
      colorMode: 'plain',
      poolStyle: 'if',
      randStyle: 'rand-selectcase',
      priorityModel: 'none',
      presentations: { heart: false, color: false, face: false, options: false },
    });
    expect(report.contract.profile.programFeatures).toEqual({
      arrays: false,
      while: false,
      goto: false,
      recursion: false,
      foreach: false,
      repeat: false,
    });

    expect(report.contract.events.map((event) => event.event)).toEqual(['开场', '收场']);
    expect(report.contract.events[0]).toMatchObject({
      event: '开场',
      engine: 'OPEN',
      args: [],
      guard: null,
      forced: true,
    });
    expect(report.contract.events[1]?.args).toEqual(['编号']);

    expect(report.skips.map((skip) => skip.check)).toEqual(['smoke']);
    expect(report.skips[0]?.reason).toContain('真实壳');
    expect(report.summary.byCheck.find((check) => check.check === 'smoke')?.skipped).toBe(1);
  });

  it('adapter 缺 profile.waitDefault → 失败项带 core 码 + 契约定位', () => {
    const broken = {
      ...FIXTURE_ADAPTER,
      profile: { ...FIXTURE_ADAPTER.profile, waitDefault: undefined },
    } as unknown as GameAdapter;

    const report = run([], broken);

    expect(report.ok).toBe(false);
    expect(report.contract.ok).toBe(false);
    const failure = report.contract.failures.find((item) => item.code === 'core/wait/no-profile');
    expect(failure).toBeDefined();
    expect(failure?.check).toBe('contract');
    expect(failure?.location.case).toBe('(contract)');
    expect(failure?.location.field).toBe('adapter');
  });

  it('backend 读数与 adapter 不同源 → conformance/backend（id / profile 两条）', () => {
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      id: 'other-backend',
      profile: { ...FIXTURE_BACKEND.profile, waitDefault: 'continue' },
    };

    const report = run([], FIXTURE_ADAPTER, backend);

    expect(report.ok).toBe(false);
    const idFailure = report.failures.find((item) => item.location.field === 'backend.id');
    expect(idFailure?.code).toBe('conformance/backend');
    expect(idFailure?.expected).toBe('"fixture"');
    expect(idFailure?.actual).toBe('"other-backend"');

    const waitFailure = report.failures.find((item) => item.location.field === 'backend.profile.waitDefault');
    expect(waitFailure?.code).toBe('conformance/backend');
    expect(waitFailure?.expected).toBe('"wait"');
    expect(waitFailure?.actual).toBe('"continue"');
    expect(report.summary.failed).toBe(1);
  });
});

describe('golden · DSL→ERB 逐字节', () => {
  it('basic.kojo2 → basic.golden.erb 通过；产物读数保留在报告里', () => {
    const report = run([
      { kind: 'golden', name: 'fixture basic golden', source: BASIC, expectedErb: BASIC_GOLDEN },
    ]);

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.summary).toMatchObject({ cases: 1, passed: 1, failed: 0, failures: 0 });
    expect(report.summary.byCheck.find((check) => check.check === 'golden')).toMatchObject({
      passed: 1,
      failed: 0,
    });

    const observations = report.cases[0]?.observations;
    expect(observations?.readings?.artifactLines).toBe(7);
    expect(observations?.readings?.sourceMapLines).toBe(7);
    expect(observations?.erbBytes).toBe(new TextEncoder().encode(BASIC_GOLDEN).length);
  });

  it('只有声明、没有正文 → 空产物 golden 合法（0 字节不是失败）', () => {
    const report = run([
      {
        kind: 'golden',
        name: 'declarations only',
        source: '# 设 上限 整数 = 10\n',
        expectedErb: '',
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.cases[0]?.observations.erbBytes).toBe(0);
    expect(report.cases[0]?.observations.readings?.artifactLines).toBe(0);
  });

  it('golden 单字节漂移 → conformance/golden；带首个差异定位 + 逐行 diff', () => {
    const report = run([
      {
        kind: 'golden',
        name: 'golden mismatch',
        source: BASIC,
        expectedErb: BASIC_GOLDEN.replace('/WAIT', '/CONT'),
      },
    ]);

    expect(report.ok).toBe(false);
    const failure = report.failures[0];
    expect(failure?.code).toBe('conformance/golden');
    expect(failure?.check).toBe('golden');
    expect(failure?.message).toContain('首个差异在字节');
    expect(failure?.location.case).toBe('golden mismatch');
    expect(failure?.location.field).toBe('expectedErb');
    expect(failure?.location.artifactLine).toBe(2);
    expect(failure?.location.sourceLine).toBe(4);
    expect(failure?.diff.some((item) => item.kind === 'removed')).toBe(true);
    expect(failure?.diff.some((item) => item.kind === 'added')).toBe(true);
    expect(failure?.expected).toContain('/CONT');
    expect(failure?.actual).toContain('/WAIT');
  });
});

describe('readings · 事件 / 等待 / 取色', () => {
  it('basic：machine 事件 + wait/continue 序列 + source map/产物行数', () => {
    const report = run([
      {
        kind: 'readings',
        name: 'basic readings',
        source: BASIC,
        readings: {
          events: [{ source: 'machine', event: '开场', args: [] }],
          waits: [
            { kind: 'text', wait: 'wait' },
            { kind: 'text', wait: 'wait' },
            { kind: 'blank', wait: 'wait' },
            { kind: 'text', wait: 'continue' },
            { kind: 'blank', wait: 'continue' },
          ],
          slots: [],
          sourceMapLines: 7,
          artifactLines: 7,
        },
      },
    ]);

    expect(report.ok).toBe(true);
    const readings = report.cases[0]?.observations.readings;
    expect(readings?.events).toEqual([
      { source: 'machine', event: '开场', args: [], guard: null, line: 1 },
    ]);
    expect(readings?.waits.map((item) => `${item.kind}:${item.wait}`)).toEqual([
      'text:wait',
      'text:wait',
      'blank:wait',
      'text:continue',
      'blank:continue',
    ]);
    expect(readings?.colors).toEqual([]);
  });

  it('等待读数不符 → conformance/readings + 字段定位', () => {
    const report = run([
      {
        kind: 'readings',
        name: 'wait mismatch',
        source: BASIC,
        readings: { waits: [{ kind: 'text', wait: 'wait' }] },
      },
    ]);

    expect(report.ok).toBe(false);
    const failure = report.failures.find((item) => item.location.field === 'readings.waits');
    expect(failure?.code).toBe('conformance/readings');
    expect(failure?.message).toContain('等待读数条数不一致');
    expect(failure?.expected).toBe('wait');
    expect(failure?.actual).toContain('text:wait');
  });

  it('取色读数：@着色 进入/文本块/复原按发射顺序记录（fixture 派生 adapter，非 eraTW）', () => {
    const report = run(
      [
        {
          kind: 'golden',
          name: 'color golden + readings',
          source: COLOR,
          expectedErb: COLOR_GOLDEN,
          readings: {
            events: [{ source: 'machine', event: '开场' }],
            waits: [
              { kind: 'text', wait: 'wait' },
              { kind: 'text', wait: 'wait' },
            ],
            colors: [
              { source: 'block-enter', value: '0xFF8080' },
              { source: 'text', value: '0xFF8080' },
              { source: 'text', value: '0xFF8080' },
              { source: 'block-exit', value: null },
            ],
          },
        },
      ],
      COLOR_ADAPTER,
      COLOR_BACKEND,
    );

    expect(report.ok).toBe(true);
    expect(report.contract.ok).toBe(true);
    const colors = report.cases[0]?.observations.readings?.colors;
    expect(colors?.map((item) => `${item.source}:${String(item.value)}`)).toEqual([
      'block-enter:0xFF8080',
      'text:0xFF8080',
      'text:0xFF8080',
      'block-exit:null',
    ]);
  });

  it('事件参数 + 守卫读数：`# 机 收场 7` 取 adapter 的 guard.text，kit 不解释表达式', () => {
    const report = run(
      [
        {
          kind: 'readings',
          name: 'guarded event',
          source: '# 机 收场 7\n> 甲\n',
          readings: {
            events: [{ source: 'machine', event: '收场', args: ['7'], guard: 'GUARD:7' }],
            waits: [{ kind: 'text', wait: 'wait' }],
          },
        },
      ],
      GUARDED_ADAPTER,
    );

    expect(report.ok).toBe(true);
    expect(report.cases[0]?.observations.readings?.events).toEqual([
      { source: 'machine', event: '收场', args: ['7'], guard: 'GUARD:7', line: 1 },
    ]);
    expect(report.contract.events.find((event) => event.event === '收场')?.guard).toBe('GUARD:7');
  });
});

describe('诊断期望 · code + 源定位', () => {
  const UNKNOWN_EVENT = '# 机 不存在\n> 甲\n';

  it('expectedDiagnostics 命中 → 用例通过（error 是可验收的输出）', () => {
    const report = run([
      {
        kind: 'readings',
        name: 'unknown event expected',
        source: UNKNOWN_EVENT,
        readings: {},
        expectedDiagnostics: [{ code: 'event/unknown', severity: 'error', line: 1 }],
      },
    ]);

    expect(report.ok).toBe(true);
    expect(report.cases[0]?.observations.readings?.diagnostics.map((item) => item.code)).toEqual([
      'event/unknown',
    ]);
  });

  it('expectedDiagnostics 行号不符 → conformance/diagnostics，定位到实际源行', () => {
    const report = run([
      {
        kind: 'readings',
        name: 'unknown event wrong line',
        source: UNKNOWN_EVENT,
        readings: {},
        expectedDiagnostics: [{ code: 'event/unknown', line: 2 }],
      },
    ]);

    expect(report.ok).toBe(false);
    const failure = report.failures.find((item) => item.code === 'conformance/diagnostics');
    expect(failure).toBeDefined();
    expect(failure?.location.field).toBe('diagnostics[0]');
    expect(failure?.location.sourceLine).toBe(1);
    expect(failure?.actual).toContain('event/unknown');
  });
});
