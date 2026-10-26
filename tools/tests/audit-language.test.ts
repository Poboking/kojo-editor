/**
 * audit-language.mjs（LAU 语言面棘轮闸）的回归护栏。
 *
 * 与 tools/tests/audit-decoupling.test.ts 同族：不 import 被测脚本的内部，
 * 而是造沙箱根目录后用 `--root/--baseline` 真跑子进程，验退出码与报告文本——
 * 闸只认"真能红"。口径要点：
 *   - 棘轮：命中数 ≤ 基线即绿，> 基线（含基线里没有的新文件）即红；
 *   - 豁免口径（2026-10-26 收紧）：必须是**注释位**（整行注释或行尾注释）且带**非空理由**；
 *     字符串/标识符里的同名串不算；豁免行数单独计数、同样按文件棘轮（只许降不许升）；
 *   - 扫描面：M2 覆盖宿主整树（monaco + ui + 其余），扩展名含 ts/tsx/mts/cts/js/mjs/cjs/rs；
 *   - fail-closed：读不到基线直接红，绝不"没基线=没问题"。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = fileURLToPath(new URL('../audit-language.mjs', import.meta.url));

const CHECK_IDS = ['M1(游戏名·引擎词汇)', 'M2(语言id分支)', 'M3(旧token名)'];

/** 全零基线：任何代码行命中都算"超基线"（棘轮最严形态，便于逐族验红） */
function zeroBaseline(): string {
  return JSON.stringify({
    checks: Object.fromEntries(
      CHECK_IDS.map((id) => [id, { total: 0, files: {}, exempt: { total: 0, files: {} } }]),
    ),
  });
}

/** 全零命中 + 指定文件钉一格豁免：豁免行数与命中同口径按文件棘轮，合法豁免要在基线里显式留位。 */
function baselineWithExempt(file: string, lines: number): string {
  return JSON.stringify({
    checks: Object.fromEntries(
      CHECK_IDS.map((id) => [
        id,
        { total: 0, files: {}, exempt: { total: lines, files: { [file]: lines } } },
      ]),
    ),
  });
}

async function runGate(
  files: Record<string, string>,
  opts: { baseline?: string | null } = {},
): Promise<{ code: number; output: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-lang-'));
  try {
    // 清单是 M1 词表来源，fail-closed：夹具必须自带，否则脚本加载即判红（那是特性不是事故）
    await fs.mkdir(path.join(tmp, 'packages', 'app', 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'packages', 'app', 'src', 'adapter-manifest.ts'),
      "export const ADAPTER_MANIFEST = [{ auditWord: 'fakegame' }];\n",
      'utf8',
    );
    const baselinePath = path.join(tmp, 'tools', 'audit-language-baseline.json');
    if (opts.baseline !== null) {
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(baselinePath, opts.baseline ?? zeroBaseline(), 'utf8');
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
    const args = [SCRIPT, '--root', tmp];
    if (opts.baseline !== null) args.push('--baseline', baselinePath);
    try {
      const res = await run('node', args);
      return { code: 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      };
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('audit-language · 三族各能红', () => {
  it('M1：游戏名（清单 auditWord）或引擎词汇进代码行 ⇒ 红，并点名文件', async () => {
    const game = await runGate({ 'packages/app/src/probe-m1.ts': "export const G = 'fakegame';\n" });
    expect(game.code).toBe(1);
    expect(game.output).toContain('M1(游戏名·引擎词汇)');
    expect(game.output).toContain('probe-m1.ts');
    const engine = await runGate({ 'packages/kojo-lang/src/probe.ts': "export const F = 'CFLAG';\n" });
    expect(engine.code).toBe(1);
    expect(engine.output).toContain('M1(游戏名·引擎词汇)');
  });

  it('M2：monaco 语言层按具体语言 id 分支 ⇒ 红', async () => {
    const { code, output } = await runGate({
      'packages/app/src/monaco/probe-m2.ts': 'if (langId === ERB_LANGUAGE_ID) bind();\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('M2(语言id分支)');
    expect(output).toContain('probe-m2.ts');
  });

  it('M2 扫宿主整树：语言 id 分支出现在 ui/ 等 monaco 之外也记 M2 账', async () => {
    const { code, output } = await runGate({
      'packages/app/src/ui/probe-outside.ts': 'if (langId === ERB_LANGUAGE_ID) bind();\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('M2(语言id分支)');
    expect(output).toContain('ui/probe-outside.ts');
  });

  it('扩展名覆盖：.js / .mts / .cjs 也在扫描面内（曾漏扫）', async () => {
    for (const ext of ['js', 'mts', 'cjs']) {
      const { code, output } = await runGate({
        [`packages/app/src/probe-ext.${ext}`]: "export const G = 'fakegame';\n",
      });
      expect(code, `.${ext} 没进扫描面`).toBe(1);
      expect(output).toContain(`probe-ext.${ext}`);
    }
  });

  it('M3：旧 token 名（sugar.*/kojo2.*/keyword.erb*）⇒ 红', async () => {
    const { code, output } = await runGate({
      'packages/app/src/ui/probe-m3.ts': "export const T = 'kojo2.section.body';\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('M3(旧token名)');
    expect(output).toContain('probe-m3.ts');
  });
});

describe('audit-language · 豁免口径（注释位 + 非空理由 + 行数棘轮）', () => {
  it('注释行 / 行尾 audit-allow（带理由）/ adapter-manifest.ts 整文件：全不红', async () => {
    const { code, output } = await runGate(
      {
        'packages/app/src/probe.ts': [
          "// fakegame CFLAG ERB_LANGUAGE_ID sugar.view —— 注释里的元描述不算泄漏",
          '/* kojo2.block 块注释同理 */',
          'export const X = 1; // audit-allow: 组合根示例行，erafl 在此是装载坐标',
          '',
        ].join('\n'),
        // 清单本身就是游戏名法定落点
        'packages/app/src/adapter-manifest.ts': "export const ADAPTER_MANIFEST = [{ auditWord: 'fakegame' }];\n",
      },
      { baseline: baselineWithExempt('packages/app/src/probe.ts', 1) },
    );
    expect(code).toBe(0);
    expect(output).toContain('✅');
  });

  it('audit-allow 写在字符串里（非注释位）⇒ 不算豁免，照样红', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe.ts':
        "export const G = 'fakegame'; export const NOTE = 'audit-allow: 行中随手写不该免责';\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('M1(游戏名·引擎词汇)');
  });

  it('注释位 audit-allow 但理由为空 ⇒ 不算豁免，照样红', async () => {
    const { code } = await runGate({
      'packages/app/src/probe.ts': "export const G = 'fakegame'; // audit-allow:\n",
    });
    expect(code).toBe(1);
  });

  it('豁免行数单独进棘轮：基线里没有的新 audit-allow 行 ⇒ 红（哪怕这一行没有命中）', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe.ts': 'export const X = 1; // audit-allow: 新开的口子\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('豁免 1 行 > 基线 0 行');
  });
});

describe('audit-language · 棘轮与 fail-closed', () => {
  it('命中数 ≤ 基线即绿（存量放行），超过 1 行即红（新增即拦）', async () => {
    const files = { 'packages/app/src/probe.ts': "export const A = 'fakegame';\nexport const B = 'fakegame';\n" };
    const pinned = JSON.stringify({
      checks: {
        'M1(游戏名·引擎词汇)': {
          total: 2,
          files: { 'packages/app/src/probe.ts': 2 },
          exempt: { total: 0, files: {} },
        },
        'M2(语言id分支)': { total: 0, files: {}, exempt: { total: 0, files: {} } },
        'M3(旧token名)': { total: 0, files: {}, exempt: { total: 0, files: {} } },
      },
    });
    expect((await runGate(files, { baseline: pinned })).code).toBe(0);
    const oneMore = await runGate({
      ...files,
      'packages/app/src/probe.ts': `${files['packages/app/src/probe.ts']}export const C = 'fakegame';\n`,
    }, { baseline: pinned });
    expect(oneMore.code).toBe(1);
    expect(oneMore.output).toContain('命中 3 行 > 基线 2 行');
  });

  it('读不到基线 ⇒ 直接红（无基线 = 无闸，绝不放行）', async () => {
    const { code, output } = await runGate({ 'packages/app/src/probe.ts': 'export const X = 1;\n' }, { baseline: null });
    expect(code).toBe(1);
    expect(output).toContain('读不到基线');
  });

  // 真跑两次子进程（`--selftest` 七向 + 主闸），单跑 ~6.8 s；满载并行池里会被挤过默认
  // 20 s 而**假红**（2026-10-26 全量跑实测：报错是 `Test timed out in 20000ms`，不是断言失败）。
  // 重 IO / 子进程用例给显式预算，是本仓既有口径（`docs/PITFALLS.md` §81）：
  // 别把"机器忙"读成"闸坏了"。判据与断言一条没动，只给时间。
  it('仓库真跑：--selftest 七向全过（三族红 + 合法绿 + 收紧豁免两红），主闸对真基线绿', async () => {
    const self = await run('node', [SCRIPT, '--selftest']);
    expect(self.stdout).toContain('自证通过');
    const main = await run('node', [SCRIPT]);
    expect(main.stdout).toContain('✅ 语言面审计：三类检查均未超出基线。');
  }, 120_000);
});
