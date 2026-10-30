/**
 * LANG-UX-MATRIX 的护栏（批次九，2026-10-22）。
 *
 * 钉的是**矩阵骨架本身**，不是壳里的观感：
 * 1. 表完整性：两门语言 × 每项能力都有 automated 项；`manual` 覆盖全部交付面；
 * 2. automated 判定真的读源码：删掉注册行 / 档位断言 / 豁免理由 / 单测文件，必须 FAIL
 *    （并且 FAIL 不会被洗成 SKIP——skip 只许来自矩阵真源的 `{ exempt }` + 可读理由）；
 * 3. JSON 形状稳定（消费方：release-gate 接线 / STATE 读数）；
 * 4. 壳冒烟读数解析以 **rc 为准**（✅ 文案不能把 rc≠0 洗绿），且真跑入口可注入假 runner；
 * 5. 不联网、不引新依赖（只用 node: 内置模块）。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  LANGUAGES,
  SCHEMA_VERSION,
  SHELL_SMOKES,
  USAGE,
  classifySmokeOutput,
  createFsReader,
  evaluateMatrix,
  extractEnumCapabilities,
  extractTestNames,
  parseArgs,
  parseStatusTable,
  runShellReadings,
} from '../lang-ux-matrix.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../lang-ux-matrix.mjs', import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const BASE = createFsReader();

/** 失败注入读取器：`overrides` 换掉某几份文件的文本，`missing` 假装某几份文件不存在 */
function fixtureReader(
  overrides: Record<string, string> = {},
  missing: string[] = [],
): typeof BASE {
  return {
    root: BASE.root,
    readFile: (rel: string) => (Object.hasOwn(overrides, rel) ? overrides[rel] : BASE.readFile(rel)),
    exists: (rel: string) => !missing.includes(rel) && BASE.exists(rel),
    listSourceFiles: () => BASE.listSourceFiles(),
  };
}

/** 真实仓库的读数：automated 40 pass / 0 fail / 3 skip；manual 39 */
const LIVE = evaluateMatrix();

function itemOf(report: typeof LIVE, id: string): any {
  const found = report.automated.items.find((item: any) => item.id === id);
  if (found === undefined) throw new Error(`报告里没有 ${id}`);
  return found;
}

function matrixItems(report: typeof LIVE): any[] {
  return report.automated.items.filter((item: any) => item.id !== 'matrix/enum-parity');
}

/* ============================== 表完整性 ============================== */

describe('表完整性：两语言 × 能力都有项', () => {
  it('恰两门语言、21 项能力（20 项 Monaco 能力 + 面包屑宿主面）', () => {
    expect(LANGUAGES.map((language: any) => language.id)).toEqual(['erb', 'kojo2']);
    expect(CAPABILITIES).toHaveLength(21);
    expect(CAPABILITIES.filter((entry: any) => entry.monaco)).toHaveLength(20);
    expect(CAPABILITIES.filter((entry: any) => !entry.monaco).map((entry: any) => entry.id)).toEqual([
      'breadcrumb',
    ]);
  });

  it('矩阵项 = 2 × 21 = 42，且每门语言 × 每项能力都有一格（id 唯一）', () => {
    const items = matrixItems(LIVE);
    expect(items).toHaveLength(LANGUAGES.length * CAPABILITIES.length);
    expect(items).toHaveLength(42);
    expect(new Set(items.map((item: any) => item.id)).size).toBe(items.length);
    for (const language of LANGUAGES as any[]) {
      for (const capability of CAPABILITIES as any[]) {
        expect(
          items.some((item: any) => item.language === language.id && item.capability === capability.id),
          `${language.id}/${capability.id} 缺项`,
        ).toBe(true);
      }
    }
  });

  it('每格都是 automated 且档位是三档之一 / exempt / host', () => {
    const allowed = new Set(['self', 'shared', 'builtin', 'exempt', 'host']);
    for (const item of matrixItems(LIVE)) {
      expect(item.check).toBe('automated');
      expect(allowed.has(item.tier), `${item.id} 档位认不出：${item.tier}`).toBe(true);
    }
  });

  it('工具表与 language-capabilities.ts 的枚举逐项一致（新能力只加枚举，矩阵自证项红）', () => {
    const enums = extractEnumCapabilities(read('packages/app/src/monaco/language-capabilities.ts'));
    expect([...enums.keys()].sort()).toEqual(
      CAPABILITIES.filter((entry: any) => entry.monaco)
        .map((entry: any) => entry.id)
        .sort(),
    );
    expect(itemOf(LIVE, 'matrix/enum-parity').status).toBe('pass');
  });

  it('两语言的交付/豁免面来自真源：ERB 20 交付 1 豁免，2.0 19 交付 2 豁免（含面包屑宿主面）', () => {
    expect(LIVE.languages.erb.delivered).toHaveLength(20);
    expect(LIVE.languages.erb.exempt.map((entry: any) => entry.capability).sort()).toEqual([
      'callhierarchy',
    ]);
    expect(LIVE.languages.kojo2.delivered).toHaveLength(19);
    expect(LIVE.languages.kojo2.exempt.map((entry: any) => entry.capability).sort()).toEqual([
      'callhierarchy',
      'implementation',
    ]);
  });
});

/* ============================== automated 判定 ============================== */

describe('automated：真读源码，读不到就红', () => {
  it('真实仓库全绿：40 pass / 0 fail / 3 skip（skip 全是矩阵豁免）', () => {
    expect(LIVE.automated.pass).toBe(40);
    expect(LIVE.automated.fail).toBe(0);
    expect(LIVE.automated.skip).toBe(3);
    expect(LIVE.exitCode).toBe(0);
    const skipIds = LIVE.automated.items.filter((item: any) => item.status === 'skip').map((item: any) => item.id);
    expect(skipIds.sort()).toEqual([
      'erb/callhierarchy',
      'kojo2/callhierarchy',
      'kojo2/implementation',
    ]);
  });

  it('每个 pass 都带 ≥2 条证据（注册行/装配行/parity 档位/单测 it 名），不是空证', () => {
    for (const item of LIVE.automated.items.filter((entry: any) => entry.status === 'pass')) {
      expect(item.evidence.length, `${item.id} 证据太少`).toBeGreaterThanOrEqual(2);
      expect(item.reason).toBeNull();
    }
  });

  it('每个 skip 都带真源里的可读理由，且豁免已进 language-parity.test.ts 豁免清单', () => {
    for (const item of LIVE.automated.items.filter((entry: any) => entry.status === 'skip')) {
      expect(typeof item.reason).toBe('string');
      expect(item.reason.trim().length).toBeGreaterThanOrEqual(8);
      expect(item.reason).not.toMatch(/^\s*(todo|tbd|待补|待定)\s*$/i);
      expect(item.evidence.join('\n')).toContain('language-parity.test.ts 豁免清单含该项');
    }
  });

  it('删掉 ERB folding 的 shared 注册行 ⇒ erb/folding FAIL 且 rc=1（不洗成 skip）', () => {
    const rel = 'packages/app/src/monaco/kojo-folding.ts';
    const report = evaluateMatrix({
      reader: fixtureReader({ [rel]: BASE.readFile(rel).replace('registerFoldingRangeProvider', 'registerFoldingRangeProviderGone') }),
    });
    const item = itemOf(report, 'erb/folding');
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('registerFoldingRangeProvider');
    expect(report.exitCode).toBe(1);
  });

  it('删掉 kojo2 rename 的表项（槽腿工厂）⇒ kojo2/rename FAIL', () => {
    // SDK-B5b 车 3（2026-10-31）：改名那枚安装器并进语言无关的槽腿工厂
    // （`monaco/slot-service-providers.ts` 的 `legOf('rename', …)`），取证点随之搬家。
    const rel = 'packages/app/src/monaco/slot-service-providers.ts';
    const report = evaluateMatrix({
      reader: fixtureReader({ [rel]: BASE.readFile(rel).replace('registerRenameProvider', 'registerRenameProviderGone') }),
    });
    const item = itemOf(report, 'kojo2/rename');
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('registerRenameProvider');
  });

  it('language-parity.test.ts 的档位清单被改掉 ⇒ 对应能力 FAIL（矩阵声明与闸门断言必须同源）', () => {
    const rel = 'packages/app/tests/language-parity.test.ts';
    const report = evaluateMatrix({
      reader: fixtureReader({ [rel]: read(rel).replaceAll("'folding'", "'folding-renamed'") }),
    });
    expect(itemOf(report, 'erb/folding').status).toBe('fail');
    expect(itemOf(report, 'kojo2/folding').status).toBe('fail');
    expect(report.exitCode).toBe(1);
  });

  it('豁免理由被掏空 ⇒ FAIL（不许用空理由换 skip）', () => {
    const rel = 'packages/app/src/monaco/language-capabilities.ts';
    const source = BASE.readFile(rel);
    const mutated = source.replace(
      "        'Monaco 0.57 无 registerCallHierarchyProvider（PITFALLS §83）；判据住 @kojo/plugin-erb-parser（槽 ui.editor.languageService 的 callHierarchy 成员，LAU-4 调用层级腿），provider 模块 monaco/erb-callhierarchy-provider.ts 与宿主面板 ui/CallHierarchyOverlay.tsx 已交付；矩阵按注册面记账，待装配点 ui/editor-global-providers.ts 接 installErbCallHierarchyProvider 后改 self',",
      "        '',",
    );
    expect(mutated).not.toBe(source);
    const report = evaluateMatrix({ reader: fixtureReader({ [rel]: mutated }) });
    expect(itemOf(report, 'erb/callhierarchy').status).toBe('fail');
    expect(report.exitCode).toBe(1);
  });

  it('单测文件不存在 ⇒ 该项 FAIL（单测登记不是摆设）', () => {
    const report = evaluateMatrix({
      reader: fixtureReader({}, ['packages/app/tests/kojo2-inlay.test.ts']),
    });
    const item = itemOf(report, 'kojo2/inlay');
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('单测文件不存在');
  });

  it('枚举新增一项而工具表没登记 ⇒ matrix/enum-parity FAIL', () => {
    const rel = 'packages/app/src/monaco/language-capabilities.ts';
    const source = BASE.readFile(rel);
    const mutated = source.replace("Preview = 'preview',", "Preview = 'preview',\n  Extra = 'extra',");
    expect(mutated).not.toBe(source);
    const report = evaluateMatrix({ reader: fixtureReader({ [rel]: mutated }) });
    const item = itemOf(report, 'matrix/enum-parity');
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('extra');
    expect(report.exitCode).toBe(1);
  });
});

/* ============================== manual ============================== */

describe('manual：真壳人工步骤必须可执行', () => {
  it('交付面 × 两语言 = 39 项，id 唯一', () => {
    expect(LIVE.manual).toHaveLength(39);
    expect(new Set(LIVE.manual.map((item: any) => item.id)).size).toBe(LIVE.manual.length);
  });

  it('每项至少 2 步、读数槽非空、`{sample}` 已被替换成该语言的语料形状', () => {
    for (const item of LIVE.manual) {
      expect(item.check).toBe('manual');
      expect(item.steps.length, `${item.id} 没有步骤`).toBeGreaterThanOrEqual(2);
      expect(item.expected.trim().length, `${item.id} 没有读数槽`).toBeGreaterThan(0);
      for (const step of item.steps) {
        expect(step.trim().length).toBeGreaterThan(0);
        expect(step).not.toContain('{sample}');
      }
    }
  });

  it('豁免面不产生 manual 项，但在 manualGaps 里点名理由（不静默）', () => {
    expect(LIVE.readings.manualGaps).toHaveLength(3);
    for (const gap of LIVE.readings.manualGaps) {
      expect(gap.reason.trim().length).toBeGreaterThanOrEqual(8);
      expect(LIVE.manual.some((item: any) => item.language === gap.language && item.capability === gap.capability)).toBe(
        false,
      );
    }
  });
});

/* ============================== JSON 形状 ============================== */

describe('JSON 结构稳定（release-gate 接线 / STATE 读数的消费面）', () => {
  it('顶层键与 schemaVersion 固定', () => {
    expect(LIVE.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Object.keys(LIVE)).toEqual([
      'schemaVersion',
      'generatedAt',
      'languages',
      'capabilities',
      'automated',
      'manual',
      'readings',
      'exitCode',
    ]);
    expect(Object.keys(LIVE.automated).sort()).toEqual(['fail', 'items', 'pass', 'skip']);
    expect(Object.keys(LIVE.languages).sort()).toEqual(['erb', 'kojo2']);
  });

  it('计数自洽：pass+fail+skip = items 数；manual 计数与数组一致', () => {
    expect(LIVE.automated.pass + LIVE.automated.fail + LIVE.automated.skip).toBe(LIVE.automated.items.length);
    expect(LIVE.readings.counts.automated).toEqual({
      pass: LIVE.automated.pass,
      fail: LIVE.automated.fail,
      skip: LIVE.automated.skip,
    });
    expect(LIVE.readings.counts.manual).toBe(LIVE.manual.length);
    expect(LIVE.readings.matrix.parityTests.length).toBeGreaterThanOrEqual(10);
    expect(LIVE.readings.shell.requested).toBe(false);
    expect(LIVE.readings.shell.note).toContain('--shell');
  });
});

/* ============================== 解析器 ============================== */

describe('源码解析器：形状守卫', () => {
  it('parseStatusTable 认三档字面量与多行 { exempt }', () => {
    const source = [
      'const DEMO_CAPABILITY_STATUS = Object.freeze({',
      "  [LanguageCapability.Folding]: 'shared',",
      '  [LanguageCapability.Highlight]: {',
      '    exempt:',
      "      '没有 provider，下一步接 monaco/erb-highlight.ts',",
      '  },',
      '});',
    ].join('\n');
    const parsed = parseStatusTable(source, 'DEMO_CAPABILITY_STATUS');
    expect(parsed.error).toBeNull();
    expect(parsed.statuses.Folding).toEqual({ tier: 'shared' });
    expect(parsed.statuses.Highlight.exempt).toContain('erb-highlight.ts');
  });

  it('parseStatusTable 缺块 / 值认不出时返回 error（不猜档位）', () => {
    expect(parseStatusTable('const X = 1;', 'MISSING').error).toContain('找不到');
    const bad = parseStatusTable(
      ['const X = Object.freeze({', '  [LanguageCapability.Folding]: 42,', '});'].join('\n'),
      'X',
    );
    expect(bad.error).toContain('既不是档位字面量');
  });

  it('extractTestNames 抽 it / it.each 的名字', () => {
    const names = extractTestNames(
      ["it('甲', () => {});", 'it.each([1])("乙", () => {});', 'describe("x", () => {});'].join('\n'),
    );
    expect(names).toEqual(['甲', '乙']);
  });
});

/* ============================== 壳冒烟读数 ============================== */

describe('壳冒烟读数：rc 为准，blocked 不当通过', () => {
  it('✅ 且 rc=0 ⇒ pass', () => {
    const parsed = classifySmokeOutput('✅ tauri DOM smoke passed', 0);
    expect(parsed.verdict).toBe('pass');
  });

  it('✅ 但 rc≠0 ⇒ fail（文案不能洗绿）', () => {
    const parsed = classifySmokeOutput('✅ tauri DOM smoke passed', 1);
    expect(parsed.verdict).toBe('fail');
    expect(parsed.reason).toContain('以 rc 为准');
  });

  it('DOM 红 + 「未满足」文案 ⇒ fail 且原因逐字带出', () => {
    const parsed = classifySmokeOutput(
      '❌ tauri DOM smoke failed\n[smoke] 未满足：vite 1420 未监听（IPv4/IPv6 都试过）',
      1,
    );
    expect(parsed.verdict).toBe('fail');
    expect(parsed.reason).toContain('vite 1420 未监听');
  });

  it('rc=2 + 无游戏语料 ⇒ blocked（没得跑 ≠ 通过）', () => {
    const parsed = classifySmokeOutput(
      '❌ 游戏目录不存在：（未发现任何符合内容条件的语料目录）\n   盘上候选: 无（需 ERB/ 与 CSV/）\n   用法：node tools/smoke-tauri-ipc.mjs "<目录>"',
      2,
    );
    expect(parsed.verdict).toBe('blocked');
    expect(parsed.reason).toContain('未发现任何符合内容条件的语料目录');
  });

  it('rc=2 + 端口占用 ⇒ blocked 且点名端口', () => {
    const parsed = classifySmokeOutput(
      '[smoke] 端口已被占用：1420 / 9222 —— 先按 PID 认属主再清',
      2,
    );
    expect(parsed.verdict).toBe('blocked');
    expect(parsed.reason).toContain('1420 / 9222');
  });

  it('runShellReadings 可注入假 runner：读数含 rc/ms/verdict/reason，任一项非 pass ⇒ exitCode=1', async () => {
    const fake = async (request: any) => {
      if (request.id === 'smoke-dom') {
        return { rc: 0, stdout: '✅ tauri DOM smoke passed', stderr: '', timedOut: false, ms: 1234 };
      }
      return {
        rc: 2,
        stdout: '❌ 游戏目录不存在：\n   盘上候选: 无（需 ERB/ 与 CSV/）',
        stderr: '',
        timedOut: false,
        ms: 4321,
      };
    };
    const shell = await runShellReadings({ run: fake as any });
    expect(shell.requested).toBe(true);
    expect(shell.items).toHaveLength(2);
    expect(shell.items[0]).toMatchObject({ id: 'smoke-dom', rc: 0, verdict: 'pass', ms: 1234 });
    expect(shell.items[1]).toMatchObject({ id: 'smoke-ipc', rc: 2, verdict: 'blocked', ms: 4321 });
    expect(shell.exitCode).toBe(1);
    const report = evaluateMatrix({ shell });
    expect(report.exitCode).toBe(1);
    expect(report.readings.shell.requested).toBe(true);
  });

  it('runner 抛错 ⇒ rc=127 + fail（不静默吞）', async () => {
    const fake = async () => {
      throw new Error('spawn EPERM');
    };
    const shell = await runShellReadings({ run: fake as any });
    expect(shell.items[0]).toMatchObject({ rc: 127, verdict: 'fail' });
    expect(shell.items[0].reason).toContain('EPERM');
  });

  it('SHELL_SMOKES 的命令与 release-gate --shell 的两项同源', () => {
    expect(SHELL_SMOKES.map((item: any) => item.id)).toEqual(['smoke-dom', 'smoke-ipc']);
    expect(SHELL_SMOKES.map((item: any) => item.command)).toEqual([
      'node tools/smoke-tauri-dom.mjs',
      'node tools/smoke-tauri-ipc.mjs',
    ]);
  });
});

/* ============================== CLI ============================== */

describe('CLI：--json 真跑 + 用法错误', () => {
  it('node tools/lang-ux-matrix.mjs --json ⇒ rc=0、JSON 可解析、形状与 evaluateMatrix 一致', async () => {
    const result = await run('node', [SCRIPT, '--json'], { cwd: REPO_ROOT });
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.exitCode).toBe(0);
    expect(report.automated.fail).toBe(0);
    expect(report.manual).toHaveLength(39);
    expect(report.readings.shell.requested).toBe(false);
  });

  it('--help ⇒ rc=0 并打印用法；未知参数 ⇒ 解析层报错', async () => {
    const help = await run('node', [SCRIPT, '--help'], { cwd: REPO_ROOT });
    expect(help.stdout).toContain('lang-ux-matrix');
    expect(help.stdout).toContain('--shell');
    expect(USAGE).toContain('WIRING');
    const parsed = parseArgs(['--json', '--shell', '--shell-timeout=5000']);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options).toEqual({ json: true, shell: true, shellTimeout: 5000, help: false });
    expect(parseArgs(['--nope']).errors[0]).toContain('未知参数');
    expect(parseArgs(['--shell-timeout=0']).errors[0]).toContain('正整数');
  });

  it('不联网、不引新依赖：只用 node: 内置模块，没有 fetch/http/axios', () => {
    const source = read('tools/lang-ux-matrix.mjs');
    const imports = [...source.matchAll(/^import\s+[\s\S]*?\s+from\s+'([^']+)'/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('node:'), `${spec} 不是 node 内置模块`).toBe(true);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("node:http");
    expect(source).not.toContain('axios');
  });
});


