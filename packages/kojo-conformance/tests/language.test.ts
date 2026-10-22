/**
 * 语言级全语法一致性套件单测（K2-LANG-CONFORMANCE；§16.2 C2.13 / §16.10 R9.1）。
 *
 * 覆盖：
 * - **覆盖度可数**：每个 group 至少一条 case、§16.2 构造词表全部被钉住、case 数按 group 固定；
 * - **golden 逐字节**：报告里的 artifact 与磁盘 `.golden.erb` 再独立对拍一遍；
 * - **诊断快照**：失败用例 fail-closed（0 字节），快照只锚 code / severity / 行 / 列；
 * - **失败不洗白**：坏 golden / 坏快照 / 缺失 fixture / golden 用例编译报错都必须是 differs/blocked；
 * - **注入 eraTW 与 fixture 的差异可见**：同一套 case，换 adapter 后状态与失败原因如实变化；
 * - **JSON 结构稳定**：顶层 / group / case / diagnostic 的键序固定；
 * - **CLI 退出码**：0 全绿 / 1 有失败 / 2 用法错误（含 `runMain` 的 language 分发）。
 *
 * 测试读真 fixture 目录（golden 是仓库基线资产，不是每次重写）；CLI 用内存 IO 验纯逻辑。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEratwEmitBackend, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import type { GameAdapter, KojoEmitBackend } from '@kojo/kojo-core';
import { describe, expect, it } from 'vitest';

import type {
  LanguageCase,
  LanguageDiagnosticExpectation,
  LanguageGroup,
  LanguageIoPort,
  LanguageReport,
} from '../src/language.js';
import {
  createLanguageAdapters,
  formatLanguageReport,
  LANGUAGE_FIXTURE_ADAPTER,
  LANGUAGE_FIXTURE_BACKEND,
  LANGUAGE_FIXTURE_DIR,
  LANGUAGE_GROUPS,
  LANGUAGE_SUITE,
  machineEventOf,
  runLanguageCli,
  runLanguageSuite,
} from '../src/language.js';
import { runMain } from '../src/main.js';

/* ============================== 固定夹具 ============================== */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/language', import.meta.url));

const readIo: LanguageIoPort = {
  readText: (target): string => readFileSync(target, 'utf8'),
};

function runSuite(overrides: Partial<Parameters<typeof runLanguageSuite>[0]> = {}): LanguageReport {
  return runLanguageSuite({ io: readIo, root: FIXTURE_DIR, ...overrides });
}

const BASELINE = runSuite();

/** eraTW 真注入（adapter 事实 + backend 工厂；与 `tools/kojo-conformance.mjs` 同一条线） */
function eratwRegistration(): { adapter: GameAdapter; backend: KojoEmitBackend } {
  return {
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' }),
  };
}

/* ============================== 内存 IO（CLI 纯逻辑用） ============================== */

class MemoryIo implements LanguageIoPort {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];

  add(target: string, text: string): this {
    this.files.set(target, text);
    return this;
  }

  readText(target: string): string {
    this.reads.push(target);
    const text = this.files.get(target);
    if (text === undefined) throw new Error(`ENOENT: ${target}`);
    return text;
  }

  listFiles(dir: string): readonly string[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...this.files.keys()]
      .filter((target) => target.startsWith(prefix))
      .map((target) => target.slice(prefix.length))
      .sort();
  }
}

/** 把真 fixture 目录整份搬进内存（CLI 成功/失败都在这份副本上做，不动磁盘） */
function loadFixtureSet(root = '/lang'): MemoryIo {
  const io = new MemoryIo();
  for (const name of readdirSync(FIXTURE_DIR)) {
    io.add(`${root}/${name}`, readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  }
  return io;
}

const CASE_BY_ID = new Map(LANGUAGE_SUITE.map((entry) => [entry.id, entry]));

function caseOf(id: string): LanguageCase {
  const entry = CASE_BY_ID.get(id);
  if (entry === undefined) throw new Error(`套件里没有 case：${id}`);
  return entry;
}

function reportOf(report: LanguageReport, id: string): LanguageReport['cases'][number] {
  const found = report.cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`报告里没有 case：${id}`);
  return found;
}

const GOLDEN_CASES = LANGUAGE_SUITE.filter((entry) => entry.expectation === 'golden');
const DIAGNOSTIC_CASES = LANGUAGE_SUITE.filter((entry) => entry.expectation === 'diagnostics');

/* ============================== 覆盖度 ============================== */

describe('语言套件 · 覆盖度可数', () => {
  it('每个 group 至少一条 case（分组清单固定 11 组）', () => {
    expect(LANGUAGE_GROUPS).toHaveLength(11);
    const counts = new Map<LanguageGroup, number>();
    for (const entry of LANGUAGE_SUITE) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
    for (const group of LANGUAGE_GROUPS) {
      expect(counts.get(group) ?? 0, `group=${group} 没有 case`).toBeGreaterThan(0);
    }
  });

  it('case 数按 group 固定（覆盖度不许悄悄缩水）', () => {
    const expected: Readonly<Record<LanguageGroup, number>> = {
      text: 5,
      condition: 3,
      table: 5,
      pool: 4,
      template: 5,
      compute: 2,
      presentation: 4,
      random: 4,
      native: 4,
      weave: 2,
      program: 9,
    };
    for (const group of LANGUAGE_GROUPS) {
      const count = LANGUAGE_SUITE.filter((entry) => entry.group === group).length;
      expect(count, `group=${group}`).toBe(expected[group]);
    }
    expect(LANGUAGE_SUITE).toHaveLength(47);
  });

  it('§16.2 构造词表全部被钉住（含 @织 三修饰词与程序层全部构造）', () => {
    const pinned = new Set(LANGUAGE_SUITE.flatMap((entry) => entry.constructs));
    const required = [
      '台词',
      '旁白',
      '空行三态',
      '插值',
      '(心形)',
      '? 链',
      '? 否',
      'SIF',
      '# 表',
      '# 池',
      '# 模',
      '@算',
      '@随机',
      '@组',
      '@着色',
      '@颜绘',
      '@原生',
      '@织',
      '之前',
      '之后',
      '接管',
      '@循',
      '@复',
      '@巡',
      '@标',
      '@跳',
      '@断',
      '@续',
      '@函',
      '@返',
      '数组',
    ];
    for (const construct of required) {
      expect(pinned.has(construct), `构造「${construct}」没有 case`).toBe(true);
    }
  });

  it('每条 case 至少一个构造、id 唯一、期望文件真实存在（且只用 .kojo2）', () => {
    expect(new Set(LANGUAGE_SUITE.map((entry) => entry.id)).size).toBe(LANGUAGE_SUITE.length);
    for (const entry of LANGUAGE_SUITE) {
      expect(entry.constructs.length, `${entry.id} 没有构造`).toBeGreaterThan(0);
      expect(existsSync(path.join(FIXTURE_DIR, `${entry.file}.kojo2`)), `${entry.file}.kojo2`).toBe(true);
      const sidecar = entry.expectation === 'golden' ? '.golden.erb' : '.diagnostics.json';
      expect(existsSync(path.join(FIXTURE_DIR, `${entry.file}${sidecar}`)), `${entry.file}${sidecar}`).toBe(true);
    }
    const polluted = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.kojo'));
    expect(polluted, 'fixture 不许用 .kojo 后缀（会污染全仓 v1 扫描）').toEqual([]);
  });

  it('报告按 group 汇总：每组 pass = cases，套件构造数去重可数', () => {
    expect(BASELINE.groups).toHaveLength(LANGUAGE_GROUPS.length);
    for (const group of BASELINE.groups) {
      expect(group.pass, `group=${group.group}`).toBe(group.cases);
      expect(group.differs).toBe(0);
      expect(group.blocked).toBe(0);
    }
    const unique = new Set(LANGUAGE_SUITE.flatMap((entry) => entry.constructs)).size;
    expect(BASELINE.summary.constructs).toBe(unique);
    expect(BASELINE.summary.constructs).toBeGreaterThan(40);
  });
});

/* ============================== golden 逐字节 ============================== */

describe('语言套件 · golden 逐字节', () => {
  it('fixture 全绿：47 pass / 0 differs / 0 blocked', () => {
    expect(BASELINE.ok).toBe(true);
    expect(BASELINE.failures).toEqual([]);
    expect(BASELINE.summary).toMatchObject({ cases: 47, pass: 47, differs: 0, blocked: 0 });
  });

  it('每条 golden 的 artifact 与磁盘 .golden.erb 再独立对拍一遍（逐字节）', () => {
    for (const entry of GOLDEN_CASES) {
      const report = reportOf(BASELINE, entry.id);
      const disk = readFileSync(path.join(FIXTURE_DIR, `${entry.file}.golden.erb`), 'utf8');
      expect(report.status, entry.id).toBe('pass');
      expect(report.artifact, entry.id).toBe(disk);
      expect(report.golden, entry.id).toBe(disk);
    }
  });

  it('golden 产物形状：末尾恰一个 LF，不含 CRLF', () => {
    for (const entry of GOLDEN_CASES) {
      const artifact = reportOf(BASELINE, entry.id).artifact ?? '';
      expect(artifact.length, entry.id).toBeGreaterThan(0);
      expect(artifact.endsWith('\n'), entry.id).toBe(true);
      expect(artifact.endsWith('\n\n'), entry.id).toBe(false);
      expect(artifact.includes('\r'), entry.id).toBe(false);
    }
  });

  it('golden 真的来自 core 编译（构造特征出现在产物里，不是空占位）', () => {
    const heart = reportOf(BASELINE, 'text/heart-hint').artifact ?? '';
    expect(heart).toContain(';HINT 心形');
    expect(heart).toContain(';(微笑)');

    const table = reportOf(BASELINE, 'table/interval').artifact ?? '';
    expect(table).toContain('__kojo_table_心情');
    expect(table).toContain('ELSE');

    const random = reportOf(BASELINE, 'random/group').artifact ?? '';
    expect(random).toContain('RANDOM group-text 2');

    const native = reportOf(BASELINE, 'native/dedent').artifact ?? '';
    expect(native).toContain('    CALL A');
    expect(native).toContain('CALL C');

    const weave = reportOf(BASELINE, 'weave/modifiers').artifact ?? '';
    expect(weave).toContain('WEAVE 开场 pri');
    expect(weave).toContain('WEAVE 开场 later');
    expect(weave).toContain('WEAVE 开场 only');
  });
});

/* ============================== 诊断快照 ============================== */

describe('语言套件 · 诊断快照', () => {
  it('失败用例全部 pass（按快照失败）且 fail-closed：artifact 为空串', () => {
    expect(DIAGNOSTIC_CASES.length).toBe(20);
    for (const entry of DIAGNOSTIC_CASES) {
      const report = reportOf(BASELINE, entry.id);
      expect(report.status, entry.id).toBe('pass');
      expect(report.artifact, entry.id).toBe('');
      expect(report.golden, entry.id).toBeNull();
      expect(report.expectedDiagnostics.length, entry.id).toBeGreaterThan(0);
      expect(report.diagnostics.length, entry.id).toBe(report.expectedDiagnostics.length);
      for (const diagnostic of report.diagnostics) expect(diagnostic.severity).toBe('error');
    }
  });

  it('快照只锚 code / severity / 行 / 列（不锚文案）', () => {
    for (const entry of DIAGNOSTIC_CASES) {
      const snapshot = JSON.parse(
        readFileSync(path.join(FIXTURE_DIR, `${entry.file}.diagnostics.json`), 'utf8'),
      ) as unknown;
      expect(snapshot).toMatchObject({ case: entry.id });
      const diagnostics = (snapshot as { diagnostics: unknown[] }).diagnostics;
      for (const raw of diagnostics) {
        expect(Object.keys(raw as Record<string, unknown>)).toEqual(['code', 'severity', 'line', 'column']);
      }
    }
  });

  it('快照读数与 core 当前诊断一致（抽样：表重叠 / 裸引号 / @断 循环外）', () => {
    const overlap = reportOf(BASELINE, 'table/overlap');
    expect(overlap.diagnostics.map((item) => [item.code, item.line, item.column])).toEqual([
      ['core/table/overlap', 3, 5],
    ]);

    const bare = reportOf(BASELINE, 'text/bare-quote');
    expect(bare.diagnostics.map((item) => [item.code, item.severity, item.line])).toEqual([
      ['core/narrative/bare-quote', 'error', 4],
    ]);

    const breakOutside = reportOf(BASELINE, 'program/break-outside');
    expect(breakOutside.diagnostics[0]?.code).toBe('core/control/break-outside');
    expect(breakOutside.diagnostics[0]?.line).toBe(3);
  });

  it('`@原生` 空块/缩进、`# 模` 插槽/参数、`@着色` 嵌套各自只报自己的码', () => {
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['native/empty', 'core/native/empty'],
      ['native/indent', 'core/native/indent'],
      ['template/missing-slot', 'core/template/missing-slot'],
      ['template/arg-count', 'core/template/arg-count'],
      ['template/side-effect', 'core/template/side-effect'],
      ['presentation/nested-color', 'core/color/nested'],
      ['presentation/face-args', 'core/face/args'],
      ['pool/no-view', 'core/pool/no-view'],
      ['pool/missing-default', 'core/pool/no-default'],
      ['table/missing-default', 'core/table/missing-default'],
      ['condition/mixed-if', 'core/migration/if'],
      ['weave/modifier-conflict', 'core/weave/modifier-conflict'],
      ['program/return-outside', 'core/func/return-outside'],
      ['program/label-in-block', 'core/goto/label-in-block'],
      ['random/one-candidate', 'core/random/one-candidate'],
    ];
    for (const [id, code] of expectations) {
      const report = reportOf(BASELINE, id);
      expect(report.diagnostics.map((item) => item.code), id).toEqual([code]);
    }
  });
});

/* ============================== 失败不洗白 ============================== */

describe('语言套件 · 失败不洗白', () => {
  it('坏 golden → differs + language/golden（不降成 warning、不记 pass）', () => {
    const io = loadFixtureSet();
    io.add('/lang/text-dialogue-narration.golden.erb', 'MACHINE 开场\nTELL: 手写脏基线 /WAIT\nMACHINE.END\n');
    const report = runLanguageSuite({ io, root: '/lang' });
    const item = reportOf(report, 'text/dialogue-narration');
    expect(report.ok).toBe(false);
    expect(item.status).toBe('differs');
    expect(item.reason).toContain('golden 逐字节不一致');
    expect(item.diff.length).toBeGreaterThan(0);
    expect(report.failures.map((failure) => failure.code)).toContain('language/golden');
  });

  it('坏诊断快照 → differs + language/diagnostics（期望/实得都进证据）', () => {
    const io = loadFixtureSet();
    io.add(
      '/lang/table-overlap.diagnostics.json',
      `${JSON.stringify(
        { case: 'table/overlap', diagnostics: [{ code: 'core/table/nope', severity: 'error', line: 3, column: 5 }] },
        null,
        2,
      )}\n`,
    );
    const report = runLanguageSuite({ io, root: '/lang' });
    const item = reportOf(report, 'table/overlap');
    expect(item.status).toBe('differs');
    expect(item.reason).toContain('诊断不匹配');
    expect(item.diagnostics[0]?.code).toBe('core/table/overlap');
    const failure = report.failures.find((entry) => entry.id === 'table/overlap');
    expect(failure?.code).toBe('language/diagnostics');
    expect(failure?.expected).toContain('core/table/nope');
    expect(failure?.actual).toContain('core/table/overlap');
  });

  it('golden 用例编译报错 → differs（不许因为"源能跑"就记 pass）', () => {
    const io = loadFixtureSet();
    const entry = caseOf('text/dialogue-narration');
    io.add(`/lang/${entry.file}.kojo2`, '# 机 开场\n\n如果 外部计数 > 1\n    > 旧写法。\n');
    const report = runLanguageSuite({ io, root: '/lang' });
    const item = reportOf(report, entry.id);
    expect(item.status).toBe('differs');
    expect(item.reason).toContain('编译报错');
    expect(item.artifact).toBe('');
    expect(report.ok).toBe(false);
  });

  it('缺 golden / 缺 fixture → blocked + language/input（不判定、也不冒充通过）', () => {
    const missingGolden = loadFixtureSet();
    missingGolden.files.delete('/lang/native-dedent.golden.erb');
    const goldenReport = runLanguageSuite({ io: missingGolden, root: '/lang' });
    const goldenItem = reportOf(goldenReport, 'native/dedent');
    expect(goldenItem.status).toBe('blocked');
    expect(goldenItem.reason).toContain('golden-missing');
    expect(goldenReport.failures.find((entry) => entry.id === 'native/dedent')?.code).toBe('language/input');

    const missingSource = loadFixtureSet();
    missingSource.files.delete('/lang/text-blank-three.kojo2');
    const sourceReport = runLanguageSuite({ io: missingSource, root: '/lang' });
    const sourceItem = reportOf(sourceReport, 'text/blank-three');
    expect(sourceItem.status).toBe('blocked');
    expect(sourceItem.reason).toContain('fixture-missing');
    expect(sourceReport.ok).toBe(false);
  });

  it('注入缺能力的 adapter → 相关 case blocked 且带 capability-missing（不是 pass/differs）', () => {
    const registrations = createLanguageAdapters();
    const fixture = registrations.fixture;
    if (fixture === undefined) throw new Error('默认 fixture 注册缺失');
    // 抹掉 program 六项：只留叙事能力，program 用例必须 blocked
    const backend = {
      ...fixture.backend,
      profile: {
        ...fixture.backend.profile,
        programFeatures: { arrays: false, while: false, goto: false, recursion: false, foreach: false, repeat: false },
      },
    };
    const adapter = {
      ...fixture.adapter,
      programFeatures: { arrays: false, while: false, goto: false, recursion: false, foreach: false, repeat: false },
    };
    const report = runLanguageSuite({ io: readIo, root: FIXTURE_DIR, adapter, backend, adapterLabel: 'fixture-no-program' });
    const item = reportOf(report, 'program/while');
    expect(item.status).toBe('blocked');
    expect(item.reason).toContain('capability-missing: program.while');
    expect(report.failures.find((entry) => entry.id === 'program/while')?.code).toBe('language/blocked');
  });
});

/* ============================== 注入 eraTW ============================== */

describe('语言套件 · 注入 eraTW 与 fixture 的差异可见', () => {
  const eraReport = runSuite({ ...eratwRegistration(), adapterLabel: 'eratw' });

  it('报告标签不同、全绿读数塌陷：pass 47 → 5，blocked 0 → 42，失败 0 → 42', () => {
    expect(BASELINE.adapter).toBe('fixture');
    expect(eraReport.adapter).toBe('eratw');
    expect(eraReport.summary.cases).toBe(BASELINE.summary.cases);
    expect(eraReport.summary.pass).toBeGreaterThan(0);
    expect(eraReport.summary.pass).toBeLessThan(BASELINE.summary.pass);
    expect(eraReport.summary.blocked).toBeGreaterThan(0);
    expect(eraReport.failures.length).toBe(eraReport.summary.blocked + eraReport.summary.differs);
    expect(eraReport.ok).toBe(false);
  });

  it('叙事/程序类 case 在 eraTW 下 blocked，原因点名事件目录（不是静默 pass）', () => {
    for (const id of ['text/dialogue-narration', 'table/interval', 'program/while', 'weave/modifiers']) {
      const item = reportOf(eraReport, id);
      expect(item.status, id).toBe('blocked');
      expect(item.reason, id).toContain('event-unknown');
      expect(item.reason, id).toContain('开场');
      // blocked 仍保留实际编译读数：core 真的报了 event/unknown
      expect(item.diagnostics.some((diagnostic) => diagnostic.code === 'event/unknown'), id).toBe(true);
    }
    expect(eraReport.failures.every((failure) => failure.code === 'language/blocked')).toBe(true);
  });

  it('声明级 fixture（无 # 机）在 eraTW 下仍 pass：同一份 core 诊断可跨 adapter 复跑', () => {
    const adapterIndependent = [
      'table/missing-default',
      'table/overlap',
      'pool/no-view',
      'pool/missing-default',
      'template/side-effect',
    ];
    for (const id of adapterIndependent) {
      expect(reportOf(eraReport, id).status, id).toBe('pass');
    }
    expect(eraReport.summary.pass).toBe(adapterIndependent.length);
  });

  it('eraTW 真 emitter + fixture 事件头（测试专用组合）：产物级差异可见，`@原生` 仍逐字节一致', () => {
    const base = createEratwEmitBackend({ compileExpression: (expr) => expr.text, charNo: '12' });
    const report = runSuite({
      adapter: { ...ERATW_GAME_ADAPTER, eventCatalog: LANGUAGE_FIXTURE_ADAPTER.eventCatalog },
      backend: { ...base, wrapMachine: LANGUAGE_FIXTURE_BACKEND.wrapMachine },
      adapterLabel: 'eratw-emitters',
    });
    // 事件头沿用 fixture（抽象挂点），正文/演出/程序落点全部走 eraTW emitter ⇒ 产物必须不同
    expect(report.summary.differs).toBeGreaterThan(0);
    const heart = reportOf(report, 'text/heart-hint');
    expect(heart.status).toBe('differs');
    expect(heart.artifact).not.toBeNull();
    expect(heart.artifact).not.toBe(heart.golden);
    // `@原生` 是逐行透传：与 adapter 无关，必须逐字节一致
    const native = reportOf(report, 'native/dedent');
    expect(native.status).toBe('pass');
    expect(native.artifact).toBe(native.golden);
  });
});

/* ============================== JSON 结构 ============================== */

describe('语言套件 · JSON 结构稳定', () => {
  const json = formatLanguageReport(BASELINE, { json: true });

  it('顶层字段序固定：adapter / backend / root / ok / groups / summary / cases / failures / usage', () => {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'adapter',
      'backend',
      'root',
      'ok',
      'groups',
      'summary',
      'cases',
      'failures',
      'usage',
    ]);
    expect(json.endsWith('\n')).toBe(true);
    expect(json.trimStart().startsWith('{')).toBe(true);
    expect(json).not.toContain('RESULT:');
  });

  it('每 case 字段序固定（前六格 = id / group / status / diagnostics / artifact / golden）', () => {
    const parsed = JSON.parse(json) as LanguageReport;
    for (const item of parsed.cases) {
      expect(Object.keys(item)).toEqual([
        'id',
        'group',
        'status',
        'diagnostics',
        'artifact',
        'golden',
        'ok',
        'expectedDiagnostics',
        'constructs',
        'reason',
        'diff',
      ]);
      // 发版机器面（tools/release-gate.mjs::parseLanguageSuiteJson）按每 case 的 ok 计读数
      expect(item.ok).toBe(item.status === 'pass');
    }
    const withDiagnostics = parsed.cases.find((item) => item.diagnostics.length > 0);
    if (withDiagnostics === undefined) throw new Error('没有带诊断的 case');
    expect(Object.keys(withDiagnostics.diagnostics[0] as object)).toEqual([
      'code',
      'severity',
      'line',
      'column',
      'message',
    ]);
  });

  it('summary / group 字段序与计数自洽', () => {
    const parsed = JSON.parse(json) as LanguageReport;
    expect(Object.keys(parsed.summary)).toEqual(['groups', 'cases', 'pass', 'differs', 'blocked', 'constructs']);
    expect(parsed.summary.cases).toBe(parsed.cases.length);
    expect(parsed.summary.pass + parsed.summary.differs + parsed.summary.blocked).toBe(parsed.summary.cases);
    for (const group of parsed.groups) {
      expect(Object.keys(group)).toEqual(['group', 'cases', 'pass', 'differs', 'blocked', 'constructs']);
      expect(group.pass + group.differs + group.blocked).toBe(group.cases);
    }
  });

  it('失败报告：ok=false 且 failures 非空（JSON 里同样不洗白）', () => {
    const io = loadFixtureSet();
    io.add('/lang/text-blank-three.golden.erb', 'MACHINE 开场\nMACHINE.END\n');
    const report = runLanguageSuite({ io, root: '/lang' });
    const parsed = JSON.parse(formatLanguageReport(report, { json: true })) as LanguageReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.failures.length).toBeGreaterThan(0);
    expect(parsed.failures.every((failure) => failure.status !== 'pass')).toBe(true);
  });

  it('usage 非 null 时 --json 不生效（永远输出用法文本）', () => {
    const result = runLanguageCli(['language', '--wat'], {
      io: loadFixtureSet(),
      adapters: createLanguageAdapters(),
      defaultRoot: '/lang',
    });
    const text = formatLanguageReport(result.report, { json: true });
    expect(text.startsWith('用法:')).toBe(true);
    expect(text).toContain('错误：未知参数：--wat');
    expect(() => JSON.parse(text)).toThrow();
  });
});

/* ============================== CLI ============================== */

describe('语言套件 · CLI 退出码', () => {
  const deps = { io: loadFixtureSet(), adapters: createLanguageAdapters(), defaultRoot: '/lang' } as const;

  it('全绿：exit 0 + 纯 JSON（--json）', () => {
    const result = runLanguageCli(['language', '--json'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    const parsed = JSON.parse(result.text) as LanguageReport;
    expect(parsed.summary.pass).toBe(parsed.summary.cases);
  });

  it('有失败：exit 1（坏 golden）', () => {
    const io = loadFixtureSet();
    io.add('/lang/random-group.golden.erb', 'MACHINE 开场\nMACHINE.END\n');
    const result = runLanguageCli(['language'], { ...deps, io });
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('RESULT: FAIL');
    expect(result.text).toContain('FAILURES');
  });

  it('用法错误 exit 2：未知 adapter / 未知参数 / 缺值 / 重复 --json', () => {
    const unknownAdapter = runLanguageCli(['language', '--adapter', 'nope'], deps);
    expect(unknownAdapter.exitCode).toBe(2);
    expect(unknownAdapter.report.usage).toContain('未知 adapter：nope');
    expect(unknownAdapter.report.usage).toContain('fixture');

    expect(runLanguageCli(['language', '--nope'], deps).exitCode).toBe(2);
    expect(runLanguageCli(['language', '--dir'], deps).exitCode).toBe(2);
    expect(runLanguageCli(['language', '--json', '--json'], deps).exitCode).toBe(2);
    expect(runLanguageCli(['language', 'stray'], deps).exitCode).toBe(2);
  });

  it('help：exit 0 + usage（含 language 与 fixture 约定）', () => {
    const result = runLanguageCli(['language', 'help'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.report.usage).toContain('kojo-conformance language');
    expect(result.report.usage).toContain('.diagnostics.json');
    expect(result.text.startsWith('用法:')).toBe(true);
  });

  it('--adapter eratw：registry 可注入，exit 1 且标签可区分', () => {
    const result = runLanguageCli(['language', '--adapter', 'eratw'], {
      ...deps,
      adapters: { ...createLanguageAdapters(), eratw: eratwRegistration() },
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.adapter).toBe('eratw');
    expect(result.report.backend).toBe('eratw');
    expect(result.report.summary.blocked).toBeGreaterThan(0);
  });

  it('`--dir` 覆盖 fixture 目录（同一套 case 可在别处复跑）', () => {
    const result = runLanguageCli(['language', '--dir', '/lang2', '--json'], {
      io: loadFixtureSet('/lang2'),
      adapters: createLanguageAdapters(),
      defaultRoot: '/unused',
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.root).toBe('/lang2');
    expect(result.report.summary.cases).toBe(LANGUAGE_SUITE.length);
  });

  it('`runMain` 真分发给 language：退出码 + stdout 走注入端口', () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runMain({
      argv: ['language', '--json'],
      io: loadFixtureSet(),
      languageAdapters: createLanguageAdapters(),
      languageRoot: '/lang',
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const parsed = JSON.parse(out.join('')) as LanguageReport;
    expect(parsed.adapter).toBe('fixture');
    expect(parsed.summary.cases).toBe(LANGUAGE_SUITE.length);

    const usageOut: string[] = [];
    const usageErr: string[] = [];
    const usageCode = runMain({
      argv: ['language', '--adapter', 'nope'],
      io: loadFixtureSet(),
      languageAdapters: createLanguageAdapters(),
      languageRoot: '/lang',
      writeOut: (text) => usageOut.push(text),
      writeErr: (text) => usageErr.push(text),
    });
    expect(usageCode).toBe(2);
    expect(usageOut).toEqual([]);
    expect(usageErr.join('')).toContain('未知 adapter：nope');
  });
});

/* ============================== 纯逻辑细节 ============================== */

describe('语言套件 · 纯逻辑细节', () => {
  it('machineEventOf 只认 `# 机 <事件>`，没有则 null', () => {
    expect(machineEventOf('# 机 开场\n> 甲\n')).toBe('开场');
    expect(machineEventOf('# 视 灵梦\n# 机   指令 310\n> 甲\n')).toBe('指令');
    expect(machineEventOf('# 表 档 由 外部计数\n    0..9 甲\n')).toBeNull();
    expect(machineEventOf('> 甲\n')).toBeNull();
  });

  it('可注入 case 子集：只跑指定用例，其它组记 0（不伪造覆盖）', () => {
    const subset = runLanguageSuite({
      io: readIo,
      root: FIXTURE_DIR,
      cases: [caseOf('text/dialogue-narration')],
    });
    expect(subset.summary.cases).toBe(1);
    expect(subset.summary.pass).toBe(1);
    expect(subset.groups).toHaveLength(LANGUAGE_GROUPS.length);
    expect(subset.groups.filter((group) => group.cases > 0).map((group) => group.group)).toEqual(['text']);
  });

  it('默认 root 是仓库相对路径；fixture 目录常量可被 CLI 直接使用', () => {
    expect(LANGUAGE_FIXTURE_DIR).toBe('packages/kojo-conformance/tests/fixtures/language');
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    expect(existsSync(path.resolve(repo, LANGUAGE_FIXTURE_DIR))).toBe(true);
  });

  it('诊断快照类型：expectedDiagnostics 与磁盘快照逐字段一致', () => {
    for (const entry of DIAGNOSTIC_CASES) {
      const snapshot = JSON.parse(
        readFileSync(path.join(FIXTURE_DIR, `${entry.file}.diagnostics.json`), 'utf8'),
      ) as { case: string; diagnostics: LanguageDiagnosticExpectation[] };
      const report = reportOf(BASELINE, entry.id);
      expect(report.expectedDiagnostics).toEqual(snapshot.diagnostics);
      expect(snapshot.case).toBe(entry.id);
    }
  });
});
