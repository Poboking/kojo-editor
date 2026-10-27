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
  ARTIFACT_LIMITS,
  buildCargoTestScript,
  CARGO_TEST_DIR,
  CORPUS_INTEGRATION,
  createReleaseGate,
  DEFAULT_ITEMS,
  findEntryRel,
  formatReport,
  inspectArtifacts,
  inspectVersionSync,
  ITEM_IDS,
  measureArtifacts,
  parseArgs,
  parseAuditOutput,
  parseBuildOutput,
  parseCargoTestOutput,
  parseConformanceJson,
  parseLauncherSmokeLine,
  parseLanguageSuiteJson,
  parseSmokeOutput,
  parseTypecheckOutput,
  parseVitestSummary,
  probeCorpus,
  RELEASE_ITEM_IDS,
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

const VERSION_GREEN = { root: '0.4.2-beta.2', app: '0.4.2-beta.2', tauri: '0.4.2-beta.2' };

/** 假 readText：按路径尾段认文件（tauri.conf.json 先认，免得被 package.json 抢） */
function versionReadText(versions: { root: string; app: string; tauri: string } = VERSION_GREEN) {
  return async (absPath: string): Promise<string> => {
    const norm = String(absPath).replaceAll('\\', '/');
    if (norm.endsWith('src-tauri/tauri.conf.json')) return JSON.stringify({ version: versions.tauri });
    if (norm.endsWith('packages/app/package.json')) return JSON.stringify({ version: versions.app });
    return JSON.stringify({ version: versions.root });
  };
}

/** 与 docs/STATE.md 基线同形的产物清单：13 件 / ≈2.3 MiB / 入口 865.9 kB ⇒ 三项全达标 */
function baselineDistFiles() {
  const files = [
    { rel: 'index.html', bytes: 7_233 },
    { rel: 'assets/index-entry.js', bytes: 865_900 },
    { rel: 'assets/entry.css', bytes: 175_373 },
    { rel: 'assets/tree-sitter-kojo.wasm', bytes: 821_724 },
    { rel: 'assets/tree-sitter-erb.wasm', bytes: 384_062 },
  ];
  for (let index = 0; index < 8; index += 1) files.push({ rel: `assets/chunk-${index}.js`, bytes: 20_000 });
  return files;
}

const ENTRY_HTML = '<script type="module" crossorigin src="/assets/index-entry.js"></script>';

/** 假 readDist：默认给达标的基线产物；present:false 模拟「构建没跑/清了 dist」 */
function distReader(
  files: Array<{ rel: string; bytes: number }> = baselineDistFiles(),
  options: { present?: boolean; indexHtml?: string; dir?: string } = {},
) {
  const { present = true, indexHtml = ENTRY_HTML, dir = 'packages/app/dist' } = options;
  return async () => (present === true ? { present: true, dir, files, indexHtml } : { present: false, dir });
}

const CARGO_GREEN = [
  'running 194 tests',
  'test result: ok. 194 passed; 0 failed; 5 ignored; 0 measured; 0 filtered out; finished in 12.34s',
].join('\n');
const LANGUAGE_GREEN = JSON.stringify({ cases: [{ ok: true }, { ok: true }], failures: [] });
const LANGUAGE_NO_SUBCOMMAND = ['用法:', '  kojo-conformance check --dir <目录>', '', '错误：未知命令：language'].join('\n');

type RunnerReply = { rc: number; stdout?: string; stderr?: string; timedOut?: boolean };
type Handler = (request: { id: string }) => RunnerReply;
type GateDeps = {
  readText?: (absPath: string) => Promise<string>;
  readDist?: (request: { root?: string }) => Promise<unknown>;
};

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
    'artifact-audit-build': () => ({ rc: 0, stdout: 'dist/index.js  1.2 kB\n✓ built in 26.5s', stderr: '' }),
    'cargo-test': () => ({ rc: 0, stdout: CARGO_GREEN, stderr: '' }),
    'language-suite': () => ({ rc: 0, stdout: LANGUAGE_GREEN, stderr: '' }),
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

async function runGate(argv, handlers = greenHandlers(), deps: GateDeps = {}) {
  const { calls, run } = makeRunner(handlers);
  const out = [];
  const err = [];
  const result = await runReleaseGate({
    argv,
    run,
    now: () => 1000,
    // 本地检查（version-sync / artifact-audit）走注入的假盘：默认三处版本一致 + 达标产物
    readText: deps.readText ?? versionReadText(),
    readDist: deps.readDist ?? distReader(),
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
      '--launcher-smoke',
      '--only=audit, conformance',
      '--only=audit',
    ]);
    expect(errors).toEqual([]);
    expect(options).toEqual({
      json: true,
      release: false,
      skipTests: true,
      failFast: true,
      build: true,
      corpus: true,
      shell: true,
      launcherSmoke: true,
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

  it('默认选项目 = 6 个核心项（可选项全 SKIP 且原因各自可读），顺序固定', () => {
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
    expect(selected.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
    ]);
    expect(selected.skipped.find((entry) => entry.id === 'build-app')?.reason).toBe('可选：未传 --build');
    expect(selected.skipped.find((entry) => entry.id === 'corpus')?.reason).toContain('语料');
    expect(selected.skipped.find((entry) => entry.id === 'smoke-dom')?.reason).toContain('桌面壳');
    // build-app 仍排在第 7 位（既有 JSON 消费方按位置认它），新项一律追加在后
    expect(ITEM_IDS).toEqual([
      ...ITEM_IDS.slice(0, 10),
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
    ]);
    expect(ITEM_IDS).toHaveLength(15);
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
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
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

  it('--fail-fast 全绿时不误跳任何项（只留可选 / releaseOnly 的默认 SKIP）', async () => {
    const { report, calls } = await runGate(['--fail-fast']);
    expect(calls).toHaveLength(6);
    expect(report.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
    ]);
    expect(report.skipped.every((entry) => entry.reason.startsWith('可选：') || entry.reason.startsWith('仅 --release'))).toBe(
      true,
    );
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
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
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
    expect(shell.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'corpus',
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
    ]);

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
    expect(corpus.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'smoke-dom',
      'smoke-ipc',
      'version-sync',
      'cargo-test',
      'artifact-audit',
      'language-suite',
      'launcher-smoke',
    ]);
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
    // 没跑的可选项只剩 build-app（且仍在 items 之外，不插进顺序），四个 releaseOnly 项照记 SKIP
    expect(parsed.skipped).toEqual([
      { id: 'build-app', reason: '可选：未传 --build' },
      { id: 'version-sync', reason: '仅 --release 或 --only=version-sync 时跑（三处版本同步闸）' },
      { id: 'cargo-test', reason: '仅 --release 或 --only=cargo-test 时跑（需 Rust 工具链，15 分钟上限）' },
      { id: 'artifact-audit', reason: '仅 --release 或 --only=artifact-audit 时跑（先构建 app，再量 dist 上界）' },
      {
        id: 'language-suite',
        reason: '仅 --release 或 --only=language-suite 时跑（语言面套件；子命令不存在则 SKIP 并说明）',
      },
      { id: 'launcher-smoke', reason: '可选：需真桌面壳（未传 --launcher-smoke / --only=launcher-smoke）' },
    ]);
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

/* ------------------------------------------------------------------ *
 * K2-RELEASE-AUTOMATION：`--release` 档（§16.10 R9.5–R9.7 的发版机器面）
 * 四个 releaseOnly 项：version-sync / cargo-test / artifact-audit / language-suite。
 * 铁律：默认档账不变（CI 快速档零改动）；`--release` 顺序由 RELEASE_ITEM_IDS 钉住；
 * 缺前置只允许 SKIP（带原因），真红一律 FAIL；volume/件数超限必须打印实测值。
 * ------------------------------------------------------------------ */

describe('release-gate · --release 档选项目', () => {
  it('parseArgs 认 --release，且可与 --json 组合', () => {
    const { options, errors } = parseArgs(['--release', '--json']);
    expect(errors).toEqual([]);
    expect(options.release).toBe(true);
    expect(options.json).toBe(true);
    expect(parseArgs([]).options.release).toBe(false);
  });

  it('--release 默认 10 项，项序 = RELEASE_ITEM_IDS（version-sync 第一、cargo-test 最后）', () => {
    const selected = resolveSelectedItems({ release: true });
    expect(selected.error).toBeUndefined();
    expect(selected.items.map((item) => item.id)).toEqual([...RELEASE_ITEM_IDS]);
    expect(RELEASE_ITEM_IDS).toEqual([
      'version-sync',
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'language-suite',
      'test-unit',
      'test-perf',
      'artifact-audit',
      'cargo-test',
    ]);
    expect(selected.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
      'launcher-smoke',
    ]);
    // 四个 releaseOnly 项都在默认账之外，且都声明了可读原因
    for (const id of ['version-sync', 'cargo-test', 'artifact-audit', 'language-suite']) {
      const item = DEFAULT_ITEMS.find((entry) => entry.id === id);
      expect(item?.releaseOnly).toBe(true);
      expect(typeof item?.skipReason).toBe('string');
    }
  });

  it('默认档（无 --release）不含四个 releaseOnly 项，SKIP 原因点名 --release 与 --only', () => {
    const selected = resolveSelectedItems({});
    expect(selected.items.map((item) => item.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'test-unit',
      'test-perf',
    ]);
    for (const id of ['version-sync', 'cargo-test', 'artifact-audit', 'language-suite']) {
      const reason = selected.skipped.find((entry) => entry.id === id)?.reason ?? '';
      expect(reason).toContain('仅 --release');
      expect(reason).toContain(`--only=${id}`);
    }
  });

  it('--release 可与 --shell / --corpus / --build 组合：追加项接在末尾、顺序固定（launcher-smoke 仍 SKIP）', () => {
    const all = resolveSelectedItems({ release: true, shell: true, corpus: true, build: true });
    expect(all.items.map((item) => item.id)).toEqual([
      ...RELEASE_ITEM_IDS,
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
    ]);
    expect(all.skipped).toEqual([
      { id: 'launcher-smoke', reason: '可选：需真桌面壳（未传 --launcher-smoke / --only=launcher-smoke）' },
    ]);
  });

  it('--only 优先于 --release（单点复跑不被全量档拐走）', () => {
    const selected = resolveSelectedItems({ release: true, only: ['audit'] });
    expect(selected.items.map((item) => item.id)).toEqual(['audit']);
    expect(selected.skipped.find((entry) => entry.id === 'version-sync')?.reason).toContain('仅 --release');
  });

  it('--release --skip-tests 去掉两池，仍留 artifact-audit / cargo-test', () => {
    const selected = resolveSelectedItems({ release: true, skipTests: true });
    expect(selected.items.map((item) => item.id)).toEqual([
      'version-sync',
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'language-suite',
      'artifact-audit',
      'cargo-test',
    ]);
    expect(selected.skipped.find((entry) => entry.id === 'test-unit')?.reason).toBe('--skip-tests');
    expect(selected.skipped.find((entry) => entry.id === 'test-perf')?.reason).toBe('--skip-tests');
  });

  it('--release 全绿 = PASS / exit 0 / 10 项 / 只跳 5 个可选项', async () => {
    const { code, report, calls } = await runGate(['--release']);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.failed).toEqual([]);
    expect(report.items.map((item) => item.id)).toEqual([...RELEASE_ITEM_IDS]);
    expect(report.skipped.map((entry) => entry.id)).toEqual([
      'build-app',
      'corpus',
      'smoke-dom',
      'smoke-ipc',
      'launcher-smoke',
    ]);
    // version-sync / artifact-audit 是进程内检查：不起子进程；artifact-audit 的构建经 runner 走
    expect(calls.map((call) => call.id)).toEqual([
      'typecheck-root',
      'typecheck-app',
      'audit',
      'conformance',
      'language-suite',
      'test-unit',
      'test-perf',
      'artifact-audit-build',
      'cargo-test',
    ]);
  });

  it('--release 失败隔离：version-sync 红，后面 9 项照跑（一次拿全账）', async () => {
    const { code, report, calls } = await runGate(['--release'], greenHandlers(), {
      readText: versionReadText({ root: '0.4.2-beta.2', app: '0.4.2-beta.1', tauri: '0.4.2-beta.1' }),
    });
    expect(code).toBe(1);
    expect(report.result).toBe('FAIL');
    expect(report.failed).toEqual(['version-sync']);
    expect(report.items).toHaveLength(10);
    expect(calls.some((call) => call.id === 'cargo-test')).toBe(true);
    expect(calls.some((call) => call.id === 'artifact-audit-build')).toBe(true);
  });

  it('--release --fail-fast：version-sync（首项）红即停，未跑项记 --fail-fast', async () => {
    const { report, calls } = await runGate(['--release', '--fail-fast'], greenHandlers(), {
      readText: versionReadText({ root: '0.4.2-beta.2', app: '0.4.2-beta.1', tauri: '0.4.2-beta.1' }),
    });
    expect(calls).toEqual([]);
    expect(report.failed).toEqual(['version-sync']);
    expect(report.items).toHaveLength(1);
    expect(report.skipped).toContainEqual({ id: 'typecheck-root', reason: '--fail-fast' });
    expect(report.skipped).toContainEqual({ id: 'cargo-test', reason: '--fail-fast' });
  });

  it('--release --json 结构稳定：顶层 8 键 / 每项 6 键 / items 顺序 = RELEASE_ITEM_IDS', async () => {
    const { text } = await runGate(['--release', '--json']);
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
    expect(parsed.items.map((item: { id: string }) => item.id)).toEqual([...RELEASE_ITEM_IDS]);
    for (const item of parsed.items) expect(Object.keys(item)).toEqual(['id', 'cmd', 'rc', 'ms', 'readings', 'tail']);
    for (const entry of parsed.skipped) expect(Object.keys(entry)).toEqual(['id', 'reason']);
  });
});

describe('release-gate · version-sync（三处 version 逐字相等）', () => {
  it('三处一致 ⇒ PASS，readings 带三值 + matched', async () => {
    const { code, report } = await runGate(['--only=version-sync']);
    expect(code).toBe(0);
    const item = report.items[0];
    expect(item.id).toBe('version-sync');
    expect(item.readings).toMatchObject({
      present: true,
      rootPkg: '0.4.2-beta.2',
      appPkg: '0.4.2-beta.2',
      tauriConf: '0.4.2-beta.2',
      matched: true,
    });
    expect(item.tail).toContain('三处 version 一致');
  });

  it('任一处不一致 ⇒ FAIL / exit 1，tail 打印三值供逐字对比', async () => {
    const { code, report } = await runGate(['--only=version-sync'], greenHandlers(), {
      readText: versionReadText({ root: '0.4.2-beta.2', app: '0.4.2-beta.1', tauri: '0.4.2-beta.1' }),
    });
    expect(code).toBe(1);
    expect(report.result).toBe('FAIL');
    expect(report.failed).toEqual(['version-sync']);
    const item = report.items[0];
    expect(item.rc).toBe(1);
    expect(item.readings).toMatchObject({
      present: true,
      matched: false,
      rootPkg: '0.4.2-beta.2',
      appPkg: '0.4.2-beta.1',
      tauriConf: '0.4.2-beta.1',
    });
    expect(item.tail).toContain('三处 version 不一致');
    expect(item.tail).toContain('package.json = 0.4.2-beta.2');
    expect(item.tail).toContain('packages/app/package.json = 0.4.2-beta.1');
    expect(item.tail).toContain('packages/app/src-tauri/tauri.conf.json = 0.4.2-beta.1');
  });

  it('文件读不到 / JSON 坏 / version 为空 ⇒ FAIL 且点名文件与原因（不猜绿）', async () => {
    const missing = await inspectVersionSync({
      readText: async (absPath: string) => {
        if (String(absPath).includes('tauri.conf.json')) throw new Error('ENOENT: no such file');
        return JSON.stringify({ version: '0.4.2-beta.2' });
      },
    });
    expect(missing.rc).toBe(1);
    expect(missing.readings).toMatchObject({ present: false, matched: false, tauriConf: null });
    expect(missing.tail).toContain('读不到文件');
    expect(missing.tail).toContain('tauri.conf.json');

    const broken = await inspectVersionSync({ readText: async () => '{ not json' });
    expect(broken.rc).toBe(1);
    expect(broken.tail).toContain('JSON 解析失败');

    const empty = await inspectVersionSync({ readText: async () => JSON.stringify({ version: '   ' }) });
    expect(empty.rc).toBe(1);
    expect(empty.readings.matched).toBe(false);
    expect(empty.tail).toContain('version 缺失');
  });

  it('version-sync 可经 --only 单跑，也可在 --release 里作为第一项（先于任何子进程）', async () => {
    const single = await runGate(['--only=version-sync']);
    expect(single.calls).toEqual([]);
    const release = await runGate(['--release']);
    expect(release.report.items[0].id).toBe('version-sync');
    expect(release.calls.some((call) => call.id === 'version-sync')).toBe(false);
  });
});

describe('release-gate · artifact-audit（dist 上界）', () => {
  it('阈值常量随 LAU-6/D3 收尾批重钉：入口 1,100 kB / dist 11.1 MiB / 93 件', () => {
    // 2026-10-26 启动器落地批：85 件 / 10.5 MiB → 90 件 / 11.0 MiB（逐块归因见
    // `tools/release-gate.mjs` 的 `ARTIFACT_LIMITS` 注释）。这条断言是"改阈值必须留痕"的闸：
    // 抬数时先改注释说清增量来自哪里，再改这里。
    // 2026-10-27 LAU-3b 收尾批：90 → 92 件（改名对话框懒块 + `kit-check` 共享块抽取；
    // 改前/改后各真实构建一次，`dist/assets` 89 → 91），总量与入口不动。
    // 2026-10-27 LAU-3b-FLIP 批：92 → 93 件——增量属变基拉上的上游五笔（本支自身那次
    // 构建仍是 92 件 / assets 91 枚，入口 249,187 → 253,055 B），未拆到单一 chunk。
    // 2026-10-27 LAU-1 / D2 合流批：93 → 95 件、11.0 → 11.1 MiB——`protocol-*.js` 1.9 KB
    // 与 `edit-*.js` 0.6 KB 两枚共享块（v3 主路 + v2 回滚路共同引用），入口不动。
    // 2026-10-27 LAU-6 注入批：95 → 96 件——`injection-*.js` 7.6 KB 共享块（`@原生`
    // 子树执行器，被 semantic 与 worker 侧两块共同引用），总量 11.06 MiB / 入口不动。
    // 2026-10-27 LAU-6/D3 收尾批：96 → 93 件——`disposeInjectionClients()` 把它接成
    // `editor-global-providers` 的静态边，`injection-*.js` 与 `protocol-*.js` 并回该块。
    expect(ARTIFACT_LIMITS).toEqual({ entryBytes: 1_100_000, distBytes: Math.round(11.1 * 1024 * 1024), files: 93 });
  });

  it('达标 ⇒ PASS，readings 记件数 / 总量 / 入口，tail 打印实测值', async () => {
    const { code, report } = await runGate(['--only=artifact-audit']);
    expect(code).toBe(0);
    const item = report.items[0];
    expect(item.id).toBe('artifact-audit');
    expect(item.readings).toMatchObject({
      present: true,
      files: 13,
      entry: 'assets/index-entry.js',
      entryBytes: 865_900,
      entryKB: 866,
      exceeded: [],
    });
    expect(item.readings.distMiB).toBeCloseTo(2.32, 1);
    expect(item.tail).toContain('实测');
    expect(item.tail).toContain('1,100 kB');
  });

  it('入口块超 1,100 kB ⇒ FAIL，tail 打印实测值与上限', async () => {
    const files = baselineDistFiles();
    files[1] = { rel: 'assets/index-entry.js', bytes: 1_250_000 };
    const { code, report } = await runGate(['--only=artifact-audit'], greenHandlers(), { readDist: distReader(files) });
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.rc).toBe(1);
    expect(item.readings.exceeded).toEqual(['entry']);
    expect(item.readings.entryKB).toBe(1250);
    expect(item.tail).toContain('产物超出上界');
    expect(item.tail).toContain('1250 kB ＞ 上限 1,100 kB');
  });

  it('dist 总量超上限 ⇒ FAIL（件数仍达标，只报总量一项）', async () => {
    const files = [...baselineDistFiles(), { rel: 'assets/huge.wasm', bytes: ARTIFACT_LIMITS.distBytes }];
    const { code, report } = await runGate(['--only=artifact-audit'], greenHandlers(), { readDist: distReader(files) });
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.readings.exceeded).toEqual(['dist']);
    expect(item.readings.files).toBe(14);
    expect(item.tail).toMatch(/dist 总量 = [\d.]+ MiB ＞ 上限 11\.1 MiB/);
  });

  it('产物件数超上限 ⇒ FAIL，tail 打印实测件数与当前上界', async () => {
    const files = [{ rel: 'assets/index-entry.js', bytes: 800_000 }];
    for (let index = 0; index < ARTIFACT_LIMITS.files; index += 1) {
      files.push({ rel: `assets/c-${index}.js`, bytes: 1_000 });
    }
    const { code, report } = await runGate(['--only=artifact-audit'], greenHandlers(), { readDist: distReader(files) });
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.readings.files).toBe(ARTIFACT_LIMITS.files + 1);
    expect(item.readings.exceeded).toEqual(['files']);
    expect(item.tail).toContain(`产物件数 = ${ARTIFACT_LIMITS.files + 1} ＞ 上限 ${ARTIFACT_LIMITS.files}`);
  });

  it('缺 dist ⇒ FAIL 且 tail 可读：点名目录 + 下一步该跑什么', async () => {
    const { code, report } = await runGate(['--only=artifact-audit'], greenHandlers(), {
      readDist: distReader([], { present: false }),
    });
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.rc).toBe(1);
    expect(item.readings.present).toBe(false);
    expect(item.tail).toContain('产物目录不存在或为空');
    expect(item.tail).toContain('packages/app/dist');
    expect(item.tail).toContain('pnpm --filter @kojo/app build');
  });

  it('构建失败 ⇒ FAIL，rc 取构建的 rc、tail 带构建输出', async () => {
    const handlers = greenHandlers();
    handlers['artifact-audit-build'] = () => ({ rc: 1, stdout: 'vite v7 building for production...', stderr: 'error during build: 3 errors' });
    const { code, report } = await runGate(['--only=artifact-audit'], handlers);
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.rc).toBe(1);
    expect(item.readings.phase).toBe('artifact-build');
    expect(item.readings.buildRc).toBe(1);
    expect(item.tail).toContain('error during build: 3 errors');
  });

  it('构建超时 ⇒ rc 124 + readings.timeout（不量盘、不猜绿）', async () => {
    const handlers = greenHandlers();
    handlers['artifact-audit-build'] = () => ({ rc: 0, timedOut: true, stdout: 'still building', stderr: '' });
    const { code, report } = await runGate(['--only=artifact-audit'], handlers);
    const item = report.items[0];
    expect(item.rc).toBe(124);
    expect(item.readings.timeout).toBe(true);
    expect(code).toBe(1);
  });

  it('measureArtifacts / findEntryRel：入口取 index.html 的 module script，认不出退最大 .js', () => {
    expect(findEntryRel(ENTRY_HTML, baselineDistFiles())).toBe('assets/index-entry.js');
    expect(
      findEntryRel('<html></html>', [
        { rel: 'assets/small.js', bytes: 1 },
        { rel: 'assets/big.js', bytes: 100 },
      ]),
    ).toBe('assets/big.js');
    expect(findEntryRel('', [])).toBeNull();
    const measured = measureArtifacts({ files: baselineDistFiles(), indexHtml: ENTRY_HTML });
    expect(measured).toMatchObject({ files: 13, entry: 'assets/index-entry.js', entryBytes: 865_900, exceeded: [] });
    expect(measureArtifacts({ files: [], indexHtml: '' }).exceeded).toEqual(['entry-missing']);
  });

  it('真目录读数不抛错：dist 在不在都给出可读账（CI 无构建产物时也不红）', async () => {
    const result = await inspectArtifacts();
    expect(typeof result.readings.present).toBe('boolean');
    expect([0, 1]).toContain(result.rc);
    if (result.readings.present === false) expect(result.tail).toContain('产物目录不存在或为空');
  });
});

describe('release-gate · cargo-test（只在 --release / --only 跑）', () => {
  it('默认档不跑，--only=cargo-test 与 --release 才出现', () => {
    expect(resolveSelectedItems({}).items.some((item) => item.id === 'cargo-test')).toBe(false);
    expect(resolveSelectedItems({ shell: true }).items.some((item) => item.id === 'cargo-test')).toBe(false);
    expect(resolveSelectedItems({ only: ['cargo-test'] }).items.map((item) => item.id)).toEqual(['cargo-test']);
    expect(resolveSelectedItems({ release: true }).items.map((item) => item.id)).toContain('cargo-test');
  });

  it('cargo 经 node 起、15 分钟上限、cwd 指向 src-tauri，并把 TMP 兜底成 Windows 形态', () => {
    const cargo = DEFAULT_ITEMS.find((item) => item.id === 'cargo-test');
    expect(cargo?.timeoutMs).toBe(15 * 60 * 1000);
    expect(cargo?.command).toBe(process.execPath);
    expect(cargo?.args[0]).toBe('-e');
    expect(cargo?.args[1]).toContain('cargo test --lib');
    expect(CARGO_TEST_DIR).toBe('packages/app/src-tauri');
    // 路径分隔符随平台：只钉「cwd 落在 src-tauri 里」这一事实
    expect(String(cargo?.args[1])).toContain('src-tauri');
    expect(cargo?.cmd).toContain('cargo test --lib');

    const win = buildCargoTestScript({ root: 'C:/repo', platform: 'win32', tmpdir: 'C:\\Users\\x\\AppData\\Local\\Temp' });
    expect(win).toContain('TMP:');
    expect(win).toContain('AppData');
    expect(win).toContain('cargo test --lib');
    expect(buildCargoTestScript({ platform: 'linux' })).not.toContain('TMP:');
  });

  it('cargo 绿 ⇒ PASS + 读最后一段 test result（194/0/5）', async () => {
    const { code, report, calls } = await runGate(['--only=cargo-test']);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('-e');
    expect(report.items[0].readings).toMatchObject({
      parsed: true,
      verdict: 'ok',
      passed: 194,
      failed: 0,
      ignored: 5,
    });
  });

  it('cargo 红 ⇒ FAIL（rc 原样传播），读数为 FAILED 段', async () => {
    const handlers = greenHandlers();
    handlers['cargo-test'] = () => ({
      rc: 101,
      stdout: 'test result: FAILED. 193 passed; 1 failed; 5 ignored; 0 measured; 0 filtered out',
      stderr: '',
    });
    const { code, report } = await runGate(['--only=cargo-test'], handlers);
    expect(code).toBe(1);
    const item = report.items[0];
    expect(item.rc).toBe(101);
    expect(item.readings).toMatchObject({ verdict: 'FAILED', passed: 193, failed: 1 });
    expect(report.failed).toEqual(['cargo-test']);
  });

  it('cargo 超时 ⇒ rc 124 + timeout 读数 ⇒ FAIL', async () => {
    const handlers = greenHandlers();
    handlers['cargo-test'] = () => ({ rc: 0, timedOut: true, stdout: 'running 194 tests', stderr: '' });
    const { code, report } = await runGate(['--only=cargo-test'], handlers);
    expect(code).toBe(1);
    expect(report.items[0].rc).toBe(124);
    expect(report.items[0].readings.timeout).toBe(true);
  });

  it('parseCargoTestOutput：多段取最后、认不出 parsed:false', () => {
    const text = [
      'test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: ok. 194 passed; 0 failed; 5 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    expect(parseCargoTestOutput(text)).toMatchObject({ parsed: true, passed: 194, ignored: 5, suites: 2 });
    expect(parseCargoTestOutput('cargo: command not found')).toEqual({ parsed: false });
  });
});

describe('release-gate · language-suite（子命令不存在 ⇒ SKIP 并说明）', () => {
  it('「未知命令：language」（rc=2）⇒ SKIP + 原因，报告仍 PASS / exit 0', async () => {
    const handlers = greenHandlers();
    handlers['language-suite'] = () => ({ rc: 2, stdout: '', stderr: LANGUAGE_NO_SUBCOMMAND });
    const { code, report, calls, text } = await runGate(['--only=language-suite'], handlers);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.items).toEqual([]);
    const skip = report.skipped.find((entry) => entry.id === 'language-suite');
    expect(skip?.reason).toContain('尚无 language 子命令');
    expect(skip?.reason).toContain('另一条线');
    expect(text).toContain('SKIP language-suite');
    // 该命令确实起过一次（不是凭 --release 推断出来的 SKIP）
    expect(calls.map((call) => call.id)).toEqual(['language-suite']);
  });

  it('真跑绿（rc=0 + JSON）⇒ PASS + 读数 cases/passed/failed', async () => {
    const { code, report } = await runGate(['--only=language-suite']);
    expect(code).toBe(0);
    expect(report.items[0].readings).toMatchObject({ parsed: true, cases: 2, passed: 2, failed: 0 });
  });

  it('真跑红（rc=1）⇒ FAIL，不被 SKIP 洗白', async () => {
    const handlers = greenHandlers();
    handlers['language-suite'] = () => ({
      rc: 1,
      stdout: JSON.stringify({ cases: [{ ok: true }, { ok: false }], failures: [{ message: 'boom' }] }),
      stderr: '',
    });
    const { code, report } = await runGate(['--only=language-suite'], handlers);
    expect(code).toBe(1);
    expect(report.failed).toEqual(['language-suite']);
    expect(report.items[0].readings).toMatchObject({ cases: 2, passed: 1, failed: 1, failures: 1 });
    expect(report.skipped.some((entry) => entry.id === 'language-suite')).toBe(false);
  });

  it('rc=2 但不是「未知命令」⇒ FAIL（SKIP 口径不扩大）', async () => {
    const handlers = greenHandlers();
    handlers['language-suite'] = () => ({ rc: 2, stdout: '', stderr: '错误：--json 需要子命令' });
    const { code, report } = await runGate(['--only=language-suite'], handlers);
    expect(code).toBe(1);
    expect(report.failed).toEqual(['language-suite']);
  });

  it('language 超时 ⇒ rc 124 + FAIL', async () => {
    const handlers = greenHandlers();
    handlers['language-suite'] = () => ({ rc: 0, timedOut: true, stdout: '{"cases":', stderr: '' });
    const { code, report } = await runGate(['--only=language-suite'], handlers);
    expect(code).toBe(1);
    expect(report.items[0].rc).toBe(124);
    expect(report.items[0].readings.timeout).toBe(true);
  });

  it('parseLanguageSuiteJson：有 cases 记用例数，坏 JSON 说 parsed:false', () => {
    expect(parseLanguageSuiteJson(LANGUAGE_GREEN)).toMatchObject({ parsed: true, cases: 2, passed: 2, failed: 0 });
    expect(parseLanguageSuiteJson('{"generated": true, "summary": "ok"}')).toMatchObject({ parsed: true, cases: null });
    expect(parseLanguageSuiteJson('no json here')).toEqual({ parsed: false });
  });
});

/* ------------------------------------------------------------------ *
 * 车道 GATE：`launcher-smoke` 可选项（启动器真壳冒烟）
 * 口径：默认 SKIP；显式点名后 rc=2（通道不可用）改判 SKIP 并带原因；rc=1（断言红）仍是 FAIL。
 * ------------------------------------------------------------------ */

describe('release-gate · launcher-smoke 可选项', () => {
  const SKIP_REASON = '可选：需真桌面壳（未传 --launcher-smoke / --only=launcher-smoke）';

  it('描述符自洽：可选项解锁键 = launcherSmoke，命令指向 tools/launcher-smoke.mjs，超时为正', () => {
    const item = DEFAULT_ITEMS.find((entry) => entry.id === 'launcher-smoke');
    expect(item?.optional).toBe('launcherSmoke');
    expect(item?.kind).toBe('shell');
    expect(item?.skipReason).toBe(SKIP_REASON);
    expect(item?.timeoutMs).toBeGreaterThan(0);
    expect(String(item?.args?.[0] ?? '').replaceAll('\\', '/')).toMatch(/\/tools\/launcher-smoke\.mjs$/);
    expect(item?.args).toContain('--start');
    expect(item?.releaseOnly).toBeUndefined();
  });

  it('默认档 / --release / --shell 都不收它（只在点名时跑），原因可读', () => {
    for (const options of [{}, { release: true }, { shell: true }, { corpus: true, build: true }]) {
      const selected = resolveSelectedItems(options);
      expect(selected.items.map((entry) => entry.id)).not.toContain('launcher-smoke');
      expect(selected.skipped).toContainEqual({ id: 'launcher-smoke', reason: SKIP_REASON });
    }
  });

  it('--only=launcher-smoke 与 --launcher-smoke 都能把它拉进来', () => {
    expect(resolveSelectedItems({ only: ['launcher-smoke'] }).items.map((entry) => entry.id)).toEqual(['launcher-smoke']);
    const appended = resolveSelectedItems({ launcherSmoke: true }).items.map((entry) => entry.id);
    expect(appended[appended.length - 1]).toBe('launcher-smoke');
    expect(appended.slice(0, 6)).toEqual(DEFAULT_ITEMS.slice(0, 6).map((entry) => entry.id));
  });

  it('rc=2 + SKIP 行 ⇒ 改判 SKIP 且原因来自脚本自报（不是一句糊话）', async () => {
    const handlers = {
      ...greenHandlers(),
      'launcher-smoke': () => ({
        rc: 2,
        stdout: '[launcher-smoke] SKIP reason=本工作树没有在跑的会话\n[launcher-smoke] cmd="x" rc=2 elapsed=3ms assertions=0 passed=0 failed=0 mode=?\n',
        stderr: '',
      }),
    };
    const { code, report } = await runGate(['--only=launcher-smoke'], handlers);
    expect(code).toBe(0);
    expect(report.result).toBe('PASS');
    expect(report.skipped.find((entry) => entry.id === 'launcher-smoke')).toEqual({
      id: 'launcher-smoke',
      reason: '本工作树没有在跑的会话',
    });
  });

  it('rc=2 但没有 SKIP 行 ⇒ 仍 SKIP，但原因写明「未给出原因」（不静默）', async () => {
    const handlers = { ...greenHandlers(), 'launcher-smoke': () => ({ rc: 2, stdout: '', stderr: 'boom' }) };
    const { code, report } = await runGate(['--only=launcher-smoke'], handlers);
    expect(code).toBe(0);
    const entry = report.skipped.find((item) => item.id === 'launcher-smoke');
    expect(entry?.reason).toContain('未给出原因');
  });

  it('rc=1（断言红）⇒ FAIL，不被 rc=2 的 SKIP 口径洗白', async () => {
    const handlers = {
      ...greenHandlers(),
      'launcher-smoke': () => ({
        rc: 1,
        stdout: '[launcher-smoke] cmd="x" rc=1 elapsed=9ms assertions=17 passed=16 failed=1 mode=shell\n',
        stderr: '',
      }),
    };
    const { code, report } = await runGate(['--only=launcher-smoke'], handlers);
    expect(code).toBe(1);
    expect(report.failed).toEqual(['launcher-smoke']);
    expect(report.items[0].rc).toBe(1);
  });

  it('读数行被解析成可断言的字段（含 boot 段），认不出说 parsed:false', () => {
    const line =
      '[launcher-smoke] cmd="node tools/launcher-smoke.mjs --start" rc=0 elapsed=42435ms assertions=17 passed=17 failed=0 mode=shell boot=42216ms';
    expect(parseLauncherSmokeLine(line)).toEqual({
      parsed: true,
      rc: 0,
      elapsedMs: 42435,
      assertions: 17,
      passed: 17,
      failed: 0,
      mode: 'shell',
      bootMs: 42216,
    });
    expect(parseLauncherSmokeLine('nothing here')).toEqual({ parsed: false });
  });
});
