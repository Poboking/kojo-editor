/**
 * K2-RELEASE-GATE · `tools/release-gate.mjs` 的纯逻辑护栏（注入假 runner，不起真进程）。
 *
 * 钉住发布门槛的契约：
 *   ① 项清单与顺序（双 typecheck / audit / conformance / 两池 / 可选 build）；
 *   ② `--only` / `--skip-tests` / `--build` / `--fail-fast` 的选择语义；
 *   ③ 全绿 PASS、单项 rc 非 0 / 超时 / runner 抛错一律 FAIL（绝不洗成 warning）；
 *   ④ 默认失败隔离，`--fail-fast` 才提前停，且未跑项有记录；
 *   ⑤ `--json` 结构稳定（顶层与每项键序固定），人类输出必带 `RESULT: PASS|FAIL`；
 *   ⑥ 每项读数来自真实输出解析（tsc / audit / conformance / vitest / build）。
 */
import { describe, expect, it } from 'vitest';
import {
  CORPUS_INTEGRATION,
  createReleaseGate,
  DEFAULT_ITEMS,
  formatReport,
  ITEM_IDS,
  parseArgs,
  parseAuditOutput,
  parseBuildOutput,
  parseConformanceJson,
  parseSmokeOutput,
  parseTypecheckOutput,
  parseVitestSummary,
  probeCorpus,
  resolveSelectedItems,
  runReleaseGate,
  TAIL_LINES,
} from '../release-gate.mjs';

const CONFORMANCE_GREEN = {
  adapter: 'fixture',
  files: [],
  cases: [
    { name: 'builtin/golden-narration', kind: 'golden', ok: true },
    { name: 'builtin/readings-narration', kind: 'readings', ok: true },
    { name: 'builtin/encoding', kind: 'encoding', ok: true },
  ],
  failures: [],
  readings: { contract: { ok: true, adapterId: 'fixture', events: 2 } },
  usage: null,
};

const VITEST_GREEN = [
  ' Test Files  3 passed (3)',
  '      Tests  40 passed (40)',
  '   Duration  1.25s (transform 100ms)',
].join('\n');

type RunnerReply = { rc: number; stdout?: string; stderr?: string; timedOut?: boolean };
type Handler = (request: { id: string }) => RunnerReply;

function greenHandlers(): Record<string, Handler> {
  return {
    'typecheck-root': () => ({ rc: 0, stdout: '', stderr: '' }),
    'typecheck-app': () => ({ rc: 0, stdout: '', stderr: '' }),
    audit: () => ({
      rc: 0,
      stdout: '=== 「一切皆插件」解耦审计 ===\n\n✅ 全部通过：\n   B. 插件（20 个）：未依赖 @kojo/kernel\n',
      stderr: '',
    }),
    conformance: () => ({ rc: 0, stdout: JSON.stringify(CONFORMANCE_GREEN, null, 2), stderr: '' }),
    'test-unit': () => ({ rc: 0, stdout: VITEST_GREEN, stderr: '' }),
    'test-perf': () => ({ rc: 0, stdout: VITEST_GREEN, stderr: '' }),
    'build-app': () => ({ rc: 0, stdout: 'dist/index.js  1.2 kB\n✓ built in 26.5s', stderr: '' }),
  };
}

function makeRunner(handlers: Record<string, Handler>) {
  const calls: Array<{ id: string; command: string; args: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> }> = [];
  const run = async (request: { id: string; command: string; args: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> }) => {
    calls.push(request);
    const handler = handlers[request.id];
    if (handler === undefined) throw new Error(`测试未给 ${request.id} 配 handler`);
    return handler(request);
  };
  return { calls, run };
}

async function runGate(argv, handlers = greenHandlers()) {
  const { calls, run } = makeRunner(handlers);
  const out = [];
  const err = [];
  const result = await runReleaseGate({
    argv,
    run,
    now: () => 1000,
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
  });
  return { ...result, calls, out: out.join(''), err: err.join('') };
}

const itemIds = (report) => report.items.map((item) => item.id);

describe('release-gate · 参数与选项目', () => {
  it('parseArgs 认全部开关，--only 去重且容忍空白', () => {
    const { options, errors } = parseArgs([
      '--json',
      '--skip-tests',
      '--fail-fast',
      '--build',
      '--corpus',
      '--shell',
      '--only=audit, conformance',
      '--only=audit',
    ]);
    expect(errors).toEqual([]);
    expect(options).toEqual({
      json: true,
      skipTests: true,
      failFast: true,
      build: true,
      corpus: true,
      shell: true,
      only: ['audit', 'conformance'],
      help: false,
    });
  });

  it('parseArgs 对未知参数 / 缺值 / 空 --only 记错误（exit 2 的输入面）', () => {
    expect(parseArgs(['--wat']).errors).toHaveLength(1);
    expect(parseArgs(['--only']).errors).toContain('--only 需要一个值');
    expect(parseArgs(['--only=']).errors).toContain('--only= 需要至少一个项 id');
    expect(parseArgs(['--only', 'audit']).options.only).toEqual(['audit']);
  });

  it('默认选项目 = 6 个核心项（4 个可选项全 SKIP 且原因各自可读），顺序固定', () => {
    const selected = resolveSelectedItems({});
    expect(selected.error).toBeUndefined();
    expect(selected.items.map((item) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
    ]);
    expect(selected.skipped.map((entry) => entry.id)).toEqual(['build-app', 'corpus', 'smoke-dom', 'smoke-ipc']);
    expect(selected.skipped.find((entry) => entry.id === 'build-app')?.reason).toBe('可选：未传 --build');
    expect(selected.skipped.find((entry) => entry.id === 'corpus')?.reason).toContain('语料');
    expect(selected.skipped.find((entry) => entry.id === 'smoke-dom')?.reason).toContain('桌面壳');
    // build-app 仍排在第 7 位（既有 JSON 消费方按位置认它），新可选项一律追加在后
    expect(ITEM_IDS).toEqual([...ITEM_IDS.slice(0, 6), 'build-app', 'corpus', 'smoke-dom', 'smoke-ipc']);
    expect(ITEM_IDS).toHaveLength(10);
  });

  it('--skip-tests 剔三池（含 corpus），未跑项带原因；核心项一个不少', () => {
    const selected = resolveSelectedItems({ skipTests: true });
    expect(selected.items.map((item) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
    ]);
    expect(selected.skipped.map((entry) => entry.id)).toEqual([
      'test-unit',
      'test-perf',
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
    ]);
    expect(selected.skipped.filter((entry) => entry.reason === '--skip-tests')).toHaveLength(3);
    expect(selected.items.some((item) => item.kind === 'test')).toBe(false);
  });

  it('--only 按项清单顺序执行，不按参数顺序；未知项直接报错', () => {
    const selected = resolveSelectedItems({ only: ['conformance', 'audit'] });
    expect(selected.items.map((item) => item.id)).toEqual(['audit', 'conformance']);
    const bad = resolveSelectedItems({ only: ['audit', 'nope'] });
    expect(bad.error).toContain('未知项：nope');
    expect(bad.error).toContain('typecheck-root');
  });

  it('--skip-tests 不压过显式 --only 指定的测试项（只跑单池的用法）', () => {
    const selected = resolveSelectedItems({ only: ['test-unit'], skipTests: true });
    expect(selected.items.map((item) => item.id)).toEqual(['test-unit']);
    expect(selected.skipped.some((entry) => entry.id === 'test-unit')).toBe(false);
  });

  it('--build / --only=build-app 都能把可选构建项拉进来', () => {
    expect(resolveSelectedItems({ build: true }).items.map((item) => item.id)).toContain('build-app');
    expect(resolveSelectedItems({ only: ['build-app'] }).items.map((item) => item.id)).toEqual(['build-app']);
  });
});

describe('release-gate · 执行与失败语义', () => {
  it('全绿 = PASS / exit 0 / 6 项全跑 / failed 为空', async () => {
    const { code, report, calls } = await runGate([]);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.exitCode).toBe(0);
    expect(report.failed).toEqual([]);
    expect(calls).toHaveLength(6);
    expect(itemIds(report)).toEqual(DEFAULT_ITEMS.slice(0, 6).map((item) => item.id));
  });

  it('每项严格输出 { id, cmd, rc, ms, readings, tail } 六键，readings 必为对象', async () => {
    const { report } = await runGate([]);
    for (const item of report.items) {
      expect(Object.keys(item)).toEqual(['id', 'cmd', 'rc', 'ms', 'readings', 'tail']);
      expect(typeof item.id).toBe('string');
      expect(typeof item.cmd).toBe('string');
      expect(Number.isInteger(item.rc)).toBe(true);
      expect(Number.isInteger(item.ms)).toBe(true);
      expect(item.ms).toBeGreaterThanOrEqual(0);
      expect(item.readings).toBeTypeOf('object');
      expect(Array.isArray(item.readings)).toBe(false);
      expect(typeof item.tail).toBe('string');
    }
  });

  it('单项失败 = FAIL，后续项仍执行（默认失败隔离），失败项进 failed 清单', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({ rc: 1, stdout: '❌ 发现 3 处违规：\n[GAME] x.ts:1', stderr: '' });
    const { code, report, calls } = await runGate([], handlers);
    expect(code).toBe(1);
    expect(report.result).toBe('FAIL');
    expect(report.exitCode).toBe(1);
    expect(report.failed).toEqual(['audit']);
    // 审计之后的 conformance / 两池都跑过 ⇒ 不是 fail-fast
    expect(calls.map((call) => call.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
    ]);
    expect(report.items.find((item) => item.id === 'audit').rc).toBe(1);
    expect(report.items.find((item) => item.id === 'audit').readings.violations).toBe(3);
  });

  it('rc 原样传播（非 0 不归一成 1），最终退出码统一为 1', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({ rc: 7, stdout: '', stderr: 'boom' });
    const { code, report } = await runGate([], handlers);
    expect(report.items.find((item) => item.id === 'audit').rc).toBe(7);
    expect(code).toBe(1);
    expect(report.result).toBe('FAIL');
  });

  it('超时 = rc 124 + readings.timeout，即使 runner 自称 rc 0 也判 FAIL', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({ rc: 0, timedOut: true, stdout: 'partial', stderr: '' });
    const { code, report } = await runGate([], handlers);
    const item = report.items.find((entry) => entry.id === 'audit');
    expect(item.rc).toBe(124);
    expect(item.readings.timeout).toBe(true);
    expect(report.result).toBe('FAIL');
    expect(code).toBe(1);
  });

  it('runner 抛错 = rc 127 + FAIL，且不打断后续项', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => {
      throw new Error('注入的执行器异常');
    };
    const { code, report, calls } = await runGate([], handlers);
    const item = report.items.find((entry) => entry.id === 'audit');
    expect(item.rc).toBe(127);
    expect(item.tail).toContain('runner 抛错');
    expect(item.tail).toContain('注入的执行器异常');
    expect(report.failed).toEqual(['audit']);
    expect(calls.some((call) => call.id === 'conformance')).toBe(true);
    expect(code).toBe(1);
  });

  it('--fail-fast 在首红处停，未跑项记为 --fail-fast', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({ rc: 1, stdout: '', stderr: 'red' });
    const { report, calls } = await runGate(['--fail-fast'], handlers);
    expect(calls.map((call) => call.id)).toEqual(['typecheck-root', 'typecheck-app', 'audit']);
    expect(report.failed).toEqual(['audit']);
    expect(report.skipped).toContainEqual({ id: 'conformance', reason: '--fail-fast' });
    expect(report.skipped).toContainEqual({ id: 'test-unit', reason: '--fail-fast' });
    expect(report.skipped).toContainEqual({ id: 'test-perf', reason: '--fail-fast' });
  });

  it('--fail-fast 全绿时不误跳任何项（只留 4 个可选项的默认 SKIP）', async () => {
    const { report, calls } = await runGate(['--fail-fast']);
    expect(calls).toHaveLength(6);
    expect(report.skipped.map((entry) => entry.id)).toEqual(['build-app', 'corpus', 'smoke-dom', 'smoke-ipc']);
    expect(report.skipped.every((entry) => entry.reason.startsWith('可选：'))).toBe(true);
  });

  it('--only 只执行选中项，其余进 skipped；--skip-tests 真跑快速档', async () => {
    const only = await runGate(['--only=audit,conformance']);
    expect(only.calls.map((call) => call.id)).toEqual(['audit', 'conformance']);
    expect(only.report.skipped.map((entry) => entry.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'test-unit',
      'test-perf',
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
    ]);

    const fast = await runGate(['--skip-tests']);
    expect(fast.calls.map((call) => call.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
    ]);
    expect(fast.report.skipped).toContainEqual({ id: 'test-unit', reason: '--skip-tests' });
    expect(fast.report.skipped).toContainEqual({ id: 'test-perf', reason: '--skip-tests' });
  });
});

describe('release-gate · 输出契约', () => {
  it('--json 是纯 JSON，顶层键序稳定，含 result / exitCode / items / failed / skipped', async () => {
    const { text, report } = await runGate(['--json']);
    expect(text.trimStart().startsWith('{')).toBe(true);
    expect(text).not.toContain('RESULT:');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      'tool',
      'schemaVersion',
      'result',
      'exitCode',
      'durationMs',
      'items',
      'failed',
      'skipped',
    ]);
    expect(parsed).toEqual(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.tool).toBe('release-gate');
    for (const item of parsed.items) {
      expect(Object.keys(item)).toEqual(['id', 'cmd', 'rc', 'ms', 'readings', 'tail']);
    }
    for (const entry of parsed.skipped) expect(Object.keys(entry)).toEqual(['id', 'reason']);
  });

  it('人类 PASS 输出带 RESULT: PASS 与逐项读数', async () => {
    const { text } = await runGate([]);
    expect(text).toContain('RESULT: PASS');
    expect(text).toContain('typecheck-root');
    expect(text).toContain('readings:');
    expect(text).not.toContain('RESULT: FAIL');
  });

  it('人类 FAIL 输出带 RESULT: FAIL、失败项清单和 tail', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({ rc: 1, stdout: '', stderr: '违规细节-A' });
    const { text } = await runGate([], handlers);
    expect(text).toContain('RESULT: FAIL');
    expect(text).toContain('failed: audit');
    expect(text).toContain('违规细节-A');
  });

  it('tail 只留最后 TAIL_LINES 行，且 ANSI 已剥掉', async () => {
    const handlers = greenHandlers();
    handlers.audit = () => ({
      rc: 0,
      stdout: Array.from({ length: 100 }, (_, index) => `\u001B[31mline-${String(index).padStart(2, '0')}\u001B[0m`).join('\n'),
      stderr: '',
    });
    const { report } = await runGate([], handlers);
    const tail = report.items.find((item) => item.id === 'audit').tail;
    expect(tail.split('\n')).toHaveLength(TAIL_LINES);
    expect(tail).toContain('line-99');
    expect(tail).not.toContain('line-00');
    expect(tail).not.toContain('\u001B');
  });

  it('--help = exit 0 + 用法/项清单，不执行任何项；用法错误 = exit 2 + stderr', async () => {
    const help = await runGate(['--help']);
    expect(help.code).toBe(0);
    expect(help.text).toContain('用法：node tools/release-gate.mjs');
    expect(help.text).toContain('typecheck-root');
    expect(help.calls).toHaveLength(0);

    const bad = await runGate(['--only=nope']);
    expect(bad.code).toBe(2);
    expect(bad.report).toBeNull();
    expect(bad.err).toContain('未知项：nope');
    expect(bad.calls).toHaveLength(0);
  });
});

describe('release-gate · 读数解析（真实输出形态）', () => {
  it('tsc：错误数与涉及文件数', () => {
    expect(parseTypecheckOutput('')).toEqual({ errors: 0, files: 0 });
    expect(
      parseTypecheckOutput(
        'src/a.ts(1,2): error TS2322: bad\nsrc/a.ts(3,4): error TS1005: worse\nsrc/b.ts(1,1): error TS1: x\n',
      ),
    ).toEqual({ errors: 3, files: 2 });
  });

  it('audit：成功给插件数 + 0 违规；失败给违规数；认不出不猜 0', () => {
    expect(parseAuditOutput('✅ 全部通过：\n   B. 插件（20 个）：未依赖 @kojo/kernel')).toEqual({
      plugins: 20,
      violations: 0,
    });
    expect(parseAuditOutput('❌ 发现 3 处违规：\n[GAME] x.ts:1')).toEqual({ plugins: null, violations: 3 });
    expect(parseAuditOutput('完全无关的输出')).toEqual({ plugins: null, violations: null });
  });

  it('conformance：从 --json 报告取 cases / passed / failed / contractOk；坏 JSON = parsed:false', () => {
    const readings = parseConformanceJson(`some log line\n${JSON.stringify(CONFORMANCE_GREEN)}\n`);
    expect(readings).toMatchObject({
      parsed: true,
      adapter: 'fixture',
      cases: 3,
      passed: 3,
      failed: 0,
      failures: 0,
      contractOk: true,
    });
    expect(parseConformanceJson('not json')).toEqual({ parsed: false });
    expect(parseConformanceJson('{"cases": [')).toEqual({ parsed: false });
  });

  it('vitest：两行汇总计数 + duration 换算', () => {
    const readings = parseVitestSummary(
      [
        ' Test Files  2 failed | 3 passed | 1 skipped (6)',
        '      Tests  9 failed | 40 passed | 2 skipped (51)',
        '   Duration  1.25s (transform 100ms)',
      ].join('\n'),
    );
    expect(readings).toEqual({
      parsed: true,
      files: { passed: 3, failed: 2, skipped: 1, todo: 0, total: 6 },
      tests: { passed: 40, failed: 9, skipped: 2, todo: 0, total: 51 },
      durationMs: 1250,
    });
    expect(parseVitestSummary('no summary here')).toEqual({ parsed: false });
  });

  it('build：耗时与产物条数', () => {
    expect(parseBuildOutput('dist/index.js  1.2 kB\ndist/assets/x.css  0.4 kB\n✓ built in 26.5s')).toEqual({
      parsed: true,
      builtInMs: 26500,
      assets: 2,
    });
    expect(parseBuildOutput('nothing')).toEqual({ parsed: false, assets: 0 });
  });

  it('createReleaseGate 的 runner 契约收到 id / command / args / cwd / timeoutMs', async () => {
    const seen = [];
    const gate = createReleaseGate({
      run: async (request) => {
        seen.push(request);
        return { rc: 0, stdout: '', stderr: '' };
      },
      now: () => 1000,
    });
    await gate.execute([DEFAULT_ITEMS[0]]);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('typecheck-root');
    expect(DEFAULT_ITEMS[0].cmd).toBe('pnpm typecheck');
    expect(seen[0].args.join(' ')).toContain('typecheck');
    expect(typeof seen[0].command).toBe('string');
    expect(typeof seen[0].cwd).toBe('string');
    expect(seen[0].timeoutMs).toBeGreaterThan(0);
  });

  it('conformance rc=1 但 JSON 合法 ⇒ FAIL，读数仍记下失败 case 数（不吞账）', async () => {
    const handlers = greenHandlers();
    handlers.conformance = () => ({
      rc: 1,
      stdout: JSON.stringify({
        ...CONFORMANCE_GREEN,
        cases: [{ ok: true }, { ok: false }],
        failures: [{ message: 'boom' }],
      }),
      stderr: '',
    });
    const { report } = await runGate([], handlers);
    const item = report.items.find((entry) => entry.id === 'conformance');
    expect(item.rc).toBe(1);
    expect(item.readings.failed).toBe(1);
    expect(item.readings.failures).toBe(1);
    expect(report.failed).toEqual(['conformance']);
  });

  it('formatReport 对空 skipped / 空 failed 也稳定', async () => {
    const { report } = await runGate(['--only=audit', '--build']);
    const human = formatReport({ ...report, skipped: [] });
    expect(human).toContain('RESULT: PASS');
    expect(human).not.toContain('SKIP');
  });
});

/* ------------------------------------------------------------------ *
 * K2-RELEASE-CI：三个可选项（corpus / smoke-dom / smoke-ipc）与 SKIP 口径
 * 铁律：缺前置 ⇒ SKIP + 原因（不是 FAIL、不是静默）；前置坏了 / 项本身红了 ⇒ FAIL。
 * ------------------------------------------------------------------ */

const CORPUS_DIR = 'C:/game/eraTW-corpus';

/** 只跑语料项时的最小 handler 面：探针 + 集成测试 */
function corpusHandlers({ probe = () => ({ rc: 0, stdout: `${CORPUS_DIR}\n`, stderr: '' }) } = {}) {
  return {
    'corpus-probe': probe,
    corpus: () => ({ rc: 0, stdout: VITEST_GREEN, stderr: '' }),
  };
}

const DOM_SMOKE_GREEN = [
  '[smoke] checks: {"viteUp":true,"hostLaunched":true,"cdpUp":true,"domRendered":true,"originChecked":true} exited=false',
  '✅ tauri DOM smoke passed',
].join('\n');

const IPC_SMOKE_GREEN = [
  '================ 冒烟汇总 ================',
  'PASS a   真实 IPC 双闸: ok',
  'PASS b   写盘边界: ok',
  '共 12 项；FAIL 0',
  '✅ tauri IPC 冒烟全部通过',
].join('\n');

describe('release-gate · 可选项与 SKIP 口径', () => {
  it('--shell 拉进两项壳冒烟、--corpus 只拉语料项，其余可选项仍 SKIP', () => {
    const shell = resolveSelectedItems({ shell: true });
    expect(shell.items.map((item) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
      'smoke-dom',
      'smoke-ipc',
    ]);
    expect(shell.skipped.map((entry) => entry.id)).toEqual(['build-app', 'corpus']);

    const corpus = resolveSelectedItems({ corpus: true });
    expect(corpus.items.map((item) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
      'corpus',
    ]);
    expect(corpus.skipped.map((entry) => entry.id)).toEqual(['build-app', 'smoke-dom', 'smoke-ipc']);
  });

  it('--only 点名的可选项无视开关（不带 --shell / --corpus 也跑），skip-tests 也压不过它', () => {
    expect(resolveSelectedItems({ only: ['smoke-dom'] }).items.map((item) => item.id)).toEqual(['smoke-dom']);
    expect(resolveSelectedItems({ only: ['smoke-ipc'] }).items.map((item) => item.id)).toEqual(['smoke-ipc']);
    expect(resolveSelectedItems({ only: ['corpus'], skipTests: true }).items.map((item) => item.id)).toEqual(['corpus']);
    // 但没点名的 corpus 会被 --skip-tests 剔掉（快速档不跑语料）
    const fast = resolveSelectedItems({ corpus: true, skipTests: true });
    expect(fast.items.some((item) => item.id === 'corpus')).toBe(false);
    expect(fast.skipped.find((entry) => entry.id === 'corpus')?.reason).toBe('--skip-tests');
  });

  it('语料缺位（探针 rc=1）⇒ SKIP + 原因，报告仍 PASS / exit 0，且不为了面子把缺失判红', async () => {
    const handlers = corpusHandlers({
      probe: () => ({
        rc: 1,
        stdout: '',
        stderr: '[FAIL] 盘上未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；设 KOJO_CORPUS_DIR=<语料目录> 可指定',
      }),
    });
    const { code, report, calls, text } = await runGate(['--only=corpus'], handlers);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.items).toEqual([]);
    expect(report.failed).toEqual([]);
    const skip = report.skipped.find((entry) => entry.id === 'corpus');
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain('语料不在位');
    expect(skip?.reason).toContain('rc=1');
    expect(skip?.reason).toContain('未发现符合内容条件的语料目录');
    expect(text).toContain('SKIP corpus');
    expect(text).toContain('RESULT: PASS');
    // 只跑了探针，集成测试一步都没起（缺语料时不空跑 vitest）
    expect(calls.map((call) => call.id)).toEqual(['corpus-probe']);
  });

  it('探针 rc=0 但没打印目录 ⇒ 仍 SKIP（不静默、不当作跑通），原因写明输出异常', async () => {
    const handlers = corpusHandlers({ probe: () => ({ rc: 0, stdout: '  \n', stderr: '' }) });
    const { code, report, calls } = await runGate(['--only=corpus'], handlers);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.skipped.find((entry) => entry.id === 'corpus')?.reason).toContain('未打印目录');
    expect(calls.map((call) => call.id)).toEqual(['corpus-probe']);
  });

  it('探针 rc=2（KOJO_CORPUS_DIR 指了坏路径）⇒ FAIL 且 rc 原样传播，不洗成 SKIP', async () => {
    const handlers = corpusHandlers({
      probe: () => ({
        rc: 2,
        stdout: '',
        stderr: '[FAIL] KOJO_CORPUS_DIR 指向的目录不存在: D:/nope\n  盘上候选: （盘上无符合 ERB/+CSV/ 的目录）',
      }),
    });
    const { code, report, calls } = await runGate(['--only=corpus'], handlers);
    expect(code).toBe(1);
    expect(report.result).toBe('FAIL');
    expect(report.failed).toEqual(['corpus']);
    const item = report.items.find((entry) => entry.id === 'corpus');
    expect(item?.rc).toBe(2);
    expect(item?.readings.phase).toBe('corpus-probe');
    expect(item?.readings.corpusPresent).toBeNull();
    expect(item?.tail).toContain('KOJO_CORPUS_DIR 指向的目录不存在');
    expect(report.skipped.some((entry) => entry.id === 'corpus')).toBe(false);
    expect(calls.map((call) => call.id)).toEqual(['corpus-probe']);
  });

  it('探针超时 ⇒ rc 124 + readings.timeout + FAIL（前置卡死不能被当成缺语料）', async () => {
    const handlers = corpusHandlers({ probe: () => ({ rc: 0, timedOut: true, stdout: '', stderr: '探针卡住' }) });
    const { code, report } = await runGate(['--only=corpus'], handlers);
    const item = report.items.find((entry) => entry.id === 'corpus');
    expect(item?.rc).toBe(124);
    expect(item?.readings.timeout).toBe(true);
    expect(report.result).toBe('FAIL');
    expect(code).toBe(1);
  });

  it('探针抛错 ⇒ rc 127 + FAIL，tail 留探针异常原文（不吞成 SKIP）', async () => {
    const handlers = corpusHandlers({
      probe: () => {
        throw new Error('注入的语料探针异常');
      },
    });
    const { code, report } = await runGate(['--only=corpus'], handlers);
    const item = report.items.find((entry) => entry.id === 'corpus');
    expect(item?.rc).toBe(127);
    expect(item?.tail).toContain('语料探针抛错');
    expect(item?.tail).toContain('注入的语料探针异常');
    expect(report.failed).toEqual(['corpus']);
    expect(code).toBe(1);
  });

  it('语料在位 ⇒ 集成测试收到 KOJO_SMOKE_PROJECT，命令就是 AGENTS §三 那条，读数带目录与 vitest 汇总', async () => {
    const handlers = corpusHandlers();
    const { code, report, calls } = await runGate(['--only=corpus'], handlers);
    expect(code).toBe(0);
    expect(calls.map((call) => call.id)).toEqual(['corpus-probe', 'corpus']);

    const probe = calls[0];
    expect(probe.args[0].replaceAll('\\', '/')).toContain('tools/corpus.mjs');
    expect(probe.args).toContain('--print');
    expect(probe.timeoutMs).toBeGreaterThan(0);

    const integration = calls[1];
    expect(integration.env).toEqual({ KOJO_SMOKE_PROJECT: CORPUS_DIR });
    expect(integration.args).toContain('run');
    expect(integration.args.join(' ')).toContain(CORPUS_INTEGRATION);

    const item = report.items.find((entry) => entry.id === 'corpus');
    expect(item?.rc).toBe(0);
    expect(item?.cmd).toContain('KOJO_SMOKE_PROJECT');
    expect(item?.cmd).toContain(CORPUS_INTEGRATION);
    expect(item?.readings).toMatchObject({
      phase: 'corpus-probe',
      corpusPresent: true,
      corpusDir: CORPUS_DIR,
      parsed: true,
    });
    expect(item?.readings.tests).toMatchObject({ passed: 40, failed: 0, total: 40 });
    expect(report.result).toBe('PASS');
  });

  it('smoke-dom 跑通 ⇒ PASS + 读数认出 DOM checks；smoke-ipc 读汇总项数', async () => {
    const handlers = greenHandlers();
    handlers['smoke-dom'] = () => ({ rc: 0, stdout: DOM_SMOKE_GREEN, stderr: '' });
    handlers['smoke-ipc'] = () => ({ rc: 0, stdout: IPC_SMOKE_GREEN, stderr: '' });
    const { code, report, calls } = await runGate(['--shell'], handlers);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(calls.filter((call) => call.id.startsWith('smoke-')).length).toBe(2);
    for (const call of calls.filter((entry) => entry.id.startsWith('smoke-'))) {
      expect(call.args[0].replaceAll('\\', '/')).toContain('tools/smoke-tauri-');
      expect(call.timeoutMs).toBeGreaterThan(0);
    }
    const dom = report.items.find((entry) => entry.id === 'smoke-dom');
    expect(dom?.readings).toMatchObject({ parsed: true, verdict: 'passed', checks: 5, failed: 0 });
    const ipc = report.items.find((entry) => entry.id === 'smoke-ipc');
    expect(ipc?.readings).toMatchObject({ parsed: true, verdict: 'passed', total: 12, failed: 0 });
  });

  it('壳冒烟 rc=1 ⇒ FAIL（显式点名就不许被 SKIP 洗白），阅读数仍记 verdict=failed', async () => {
    const handlers = greenHandlers();
    handlers['smoke-dom'] = () => ({ rc: 1, stdout: '❌ tauri DOM smoke failed\n[smoke] 未满足：CDP 9222 未监听', stderr: '' });
    const { code, report } = await runGate(['--only=smoke-dom'], handlers);
    expect(code).toBe(1);
    expect(report.failed).toEqual(['smoke-dom']);
    expect(report.items[0].readings.verdict).toBe('failed');
    expect(report.items[0].tail).toContain('CDP 9222 未监听');
  });

  it('壳冒烟超时 ⇒ rc 124 + FAIL（壳挂死不是「没得跑」）', async () => {
    const handlers = greenHandlers();
    handlers['smoke-ipc'] = () => ({ rc: 0, timedOut: true, stdout: 'partial', stderr: '' });
    const { code, report } = await runGate(['--only=smoke-ipc'], handlers);
    const item = report.items[0];
    expect(item.rc).toBe(124);
    expect(item.readings).toMatchObject({ timeout: true, parsed: false });
    expect(report.result).toBe('FAIL');
    expect(code).toBe(1);
  });

  it('parseSmokeOutput 认不出就说 parsed:false（不猜绿）', () => {
    expect(parseSmokeOutput('完全无关的输出')).toEqual({ parsed: false });
    expect(parseSmokeOutput('')).toEqual({ parsed: false });
    expect(parseSmokeOutput('共 3 项；FAIL 1')).toMatchObject({ parsed: true, total: 3, failed: 1, verdict: null });
  });

  it('--shell --corpus --json 的 JSON 结构照样稳定：顶层键序、每项六键、skipped 两键、items 顺序', async () => {
    const handlers = { ...greenHandlers(), ...corpusHandlers() };
    handlers['smoke-dom'] = () => ({ rc: 0, stdout: DOM_SMOKE_GREEN, stderr: '' });
    handlers['smoke-ipc'] = () => ({ rc: 0, stdout: IPC_SMOKE_GREEN, stderr: '' });
    const { text } = await runGate(['--shell', '--corpus', '--json'], handlers);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      'tool',
      'schemaVersion',
      'result',
      'exitCode',
      'durationMs',
      'items',
      'failed',
      'skipped',
    ]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.items.map((item: { id: string }) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
    ]);
    for (const item of parsed.items) expect(Object.keys(item)).toEqual(['id', 'cmd', 'rc', 'ms', 'readings', 'tail']);
    for (const entry of parsed.skipped) expect(Object.keys(entry)).toEqual(['id', 'reason']);
    // 唯一没跑的可选项只剩 build-app（且仍在第 7 位之前被跳过，不插进 items）
    expect(parsed.skipped).toEqual([{ id: 'build-app', reason: '可选：未传 --build' }]);
  });

  it('probeCorpus 是纯函数式探针：缺 run / 回报结构符合契约', async () => {
    await expect(probeCorpus({})).rejects.toThrow(/probeCorpus/);
    const skip = await probeCorpus({ run: async () => ({ rc: 1, stdout: '', stderr: '[FAIL] 没有语料' }) });
    expect(skip).toEqual({ skip: expect.stringContaining('语料不在位') });
    const dir = await probeCorpus({ run: async () => ({ rc: 0, stdout: `${CORPUS_DIR}\n`, stderr: '' }) });
    expect(dir.env).toEqual({ KOJO_SMOKE_PROJECT: CORPUS_DIR });
    expect(dir.readings).toMatchObject({ corpusPresent: true, corpusDir: CORPUS_DIR });
  });

  it('语料项在默认账之外但描述符自洽：可选项、有探针、超时为正', () => {
    const ids = DEFAULT_ITEMS.map((item) => item.id);
    expect(ids.indexOf('build-app')).toBe(6);
    const corpus = DEFAULT_ITEMS.find((item) => item.id === 'corpus');
    expect(corpus?.optional).toBe('corpus');
    expect(typeof corpus?.preflight).toBe('function');
    expect(corpus?.timeoutMs).toBeGreaterThan(0);
    for (const id of ['smoke-dom', 'smoke-ipc']) {
      const item = DEFAULT_ITEMS.find((entry) => entry.id === id);
      expect(item?.optional).toBe('shell');
      expect(item?.timeoutMs).toBeGreaterThan(0);
    }
  });
});
