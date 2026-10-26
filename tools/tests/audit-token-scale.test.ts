/**
 * audit-token-scale.mjs（刻度面棘轮闸：Z1 z-index 裸值 / D1 动效裸时长）的回归护栏。
 *
 * 与 tools/tests/audit-language.test.ts 同族：不 import 被测脚本的内部，而是造沙箱根目录后用
 * `--root/--baseline` 真跑子进程，验退出码与报告文本——**闸只认"真能红"**。口径要点：
 *   - 棘轮：命中数 ≤ 基线即绿，> 基线（含基线里没有的新文件）即红；
 *   - 豁免口径逐字继承 audit-decoupling / audit-language：必须落在**注释位**且带**非空理由**
 *     （`'audit-allow: …'` 这类字符串里的同名串不算；块注释收尾记号与尾随空白不算理由）；
 *     豁免行数与命中同样**按文件棘轮**（只许降不许升）；
 *   - 注释位跳过：CSS 块注释里的 `z-index: 9999` 是散文不是泄漏（注释行的 CSS 等价物）；
 *   - 数值真源文件（tokens.css / themes/*.css）= 本闸的"组合根"，整体不扫；
 *   - fail-closed：读不到基线直接红，绝不"没基线 = 没问题"；
 *   - **每族各注入一条变异实测必红**（Z1 / D1 各一条，另加多行 transition 与 animation-delay
 *     两条形态，防止"只认单行写法"的假绿）。
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
const SCRIPT = fileURLToPath(new URL('../audit-token-scale.mjs', import.meta.url));

const CHECK_IDS = ['Z1(z-index裸值)', 'D1(动效裸时长)'];

/** 全零基线：任何代码行命中都算"超基线"（棘轮最严形态，便于逐族验红） */
function zeroBaseline(): string {
  return JSON.stringify({
    checks: Object.fromEntries(
      CHECK_IDS.map((id) => [id, { total: 0, files: {}, exempt: { total: 0, files: {} } }]),
    ),
  });
}

/** 全零命中 + 指定文件钉一格豁免位：豁免行数与命中同口径按文件棘轮，合法豁免要显式留位 */
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-audit-scale-'));
  try {
    const baselinePath = path.join(tmp, 'tools', 'audit-token-scale-baseline.json');
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

describe('audit-token-scale · 两族各能红（变异实测）', () => {
  it('Z1：裸 z-index 进代码行 ⇒ 红，并点名文件与行', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe-z1.css': '.x { z-index: 1200; }\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('Z1(z-index裸值)');
    expect(output).toContain('probe-z1.css');
    expect(output).toContain('z-index: 1200');
  });

  it('Z1：槽位兜底形态（var(--sticky-z, 1)）也记 Z1 账——绕开 --z-* 族就是第二张嘴', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe-slot.css': '.s { z-index: var(--sticky-z, 1); }\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('Z1(z-index裸值)');
  });

  it('D1：单行与**多行** transition、以及 animation-delay 的裸时长都要抓到', async () => {
    const single = await runGate({ 'packages/app/src/probe-d1.css': '.a { transition: opacity 200ms ease; }\n' });
    expect(single.code).toBe(1);
    expect(single.output).toContain('D1(动效裸时长)');

    const multi = await runGate({
      'packages/app/src/probe-d1-multi.css': '.b {\n  transition:\n    left 320ms var(--ease-out),\n    color var(--dur-1) var(--ease-out);\n}\n',
    });
    expect(multi.code).toBe(1);
    expect(multi.output).toContain('probe-d1-multi.css');

    const delay = await runGate({ 'packages/app/src/probe-delay.css': '.c > * { animation-delay: 45ms; }\n' });
    expect(delay.code).toBe(1);
    expect(delay.output).toContain('probe-delay.css');
  });

  it('合规形态不红：token 消费、calc 派生、以及缓动函数里的数字都不记账', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe-ok.css': [
        '.a { z-index: var(--z-modal); }',
        '.b { z-index: calc(var(--z-modal) + 1); }',
        '.c { transition: background-color var(--dur-1) var(--ease-out); }',
        '.d { animation: spin var(--anim-spin) linear infinite; }',
        '.e { animation-delay: calc(var(--stagger) * 2); }',
        '',
      ].join('\n'),
    });
    expect(code, output).toBe(0);
    expect(output).toContain('✅');
  });

  it('扫描面覆盖：嵌套 at-rule（@media）里的违规同样记账', async () => {
    const { code, output } = await runGate({
      // 夹具取值必须是"上全局阶梯"的裸值（组长重划 Z1 后 <10 与 auto 属组件内部叠序、不记账）。
      // 这条判据量的是扫描面伸不伸得进嵌套 at-rule，换值不换意图。
      'packages/app/src/probe-media.css': '@media (width >= 900px) {\n  .m { z-index: 1200; }\n}\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('probe-media.css');
  });
});

describe('audit-token-scale · 豁免口径（注释位 + 非空理由 + 行数棘轮 + 组合根）', () => {
  it('CSS 块注释里的裸值不算泄漏；行尾 audit-allow（带理由）免责', async () => {
    const { code, output } = await runGate(
      {
        'packages/app/src/probe-comment.css': [
          '/* 说明：这里曾写 z-index: 9999 与 transition: all 5s，注释不是代码位 */',
          '.a { z-index: var(--z-toast); }',
          '.b { z-index: 4321; /* audit-allow: 本面自成一档，档位表登记见 BOARD VIS-21 */ }',
          '',
        ].join('\n'),
      },
      { baseline: baselineWithExempt('packages/app/src/probe-comment.css', 1) },
    );
    expect(code, output).toBe(0);
    expect(output).toContain('✅');
  });

  it('audit-allow 不在注释位（写在串里）⇒ 不豁免，照样红', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe-string.css': '.z { z-index: 1200; content: "audit-allow: 行中随手写不该免责"; }\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('Z1(z-index裸值)');
  });

  it('注释位但理由为空 ⇒ 不豁免，照样红', async () => {
    const { code } = await runGate({
      'packages/app/src/probe-noreason.css': '.w { z-index: 1200; /* audit-allow: */ }\n',
    });
    expect(code).toBe(1);
  });

  it('豁免行数单独进棘轮：基线里没有的新 audit-allow 行 ⇒ 红（哪怕这一行不再命中）', async () => {
    const { code, output } = await runGate({
      'packages/app/src/probe-newallow.css': '.n { z-index: 1200; /* audit-allow: 新开的口子 */ }\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('豁免 1 行 > 基线 0 行');
  });

  it('数值真源文件（tokens.css / themes/*.css）＝组合根：那里的字面量不扫', async () => {
    const { code, output } = await runGate({
      'packages/app/src/tokens.css': ':root {\n  --z-toast: 1200;\n  --dur-1: 120ms;\n  animation: x 999ms;\n}\n',
      'packages/app/src/themes/light.css': ":root[data-theme='light'] {\n  --z-modal: 7;\n}\n",
    });
    expect(code, output).toBe(0);
    expect(output).toContain('✅');
  });
});

describe('audit-token-scale · 棘轮与 fail-closed', () => {
  it('命中数 ≤ 基线即绿（存量放行），超过 1 行即红（新增即拦）', async () => {
    const base = 'packages/app/src/probe.css';
    // 夹具取"上全局阶梯"的裸值（Z1 重划后 <10 / auto 不记账，用 1/2/3 会让这条棘轮
    // 悄悄变成"零命中对零基线"——算术仍在测，但测的是空集）。换值不换意图。
    const twoLines = '.a { z-index: 1200; }\n.b { z-index: 1300; }\n';
    const pinned = JSON.stringify({
      checks: {
        'Z1(z-index裸值)': { total: 2, files: { [base]: 2 }, exempt: { total: 0, files: {} } },
        'D1(动效裸时长)': { total: 0, files: {}, exempt: { total: 0, files: {} } },
      },
    });
    expect((await runGate({ [base]: twoLines }, { baseline: pinned })).code).toBe(0);
    const oneMore = await runGate(
      { [base]: `${twoLines}.c { z-index: 1400; }\n` },
      { baseline: pinned },
    );
    expect(oneMore.code).toBe(1);
    expect(oneMore.output).toContain('命中 3 行 > 基线 2 行');
  });

  it('读不到基线 ⇒ 直接红（无基线 = 无闸，绝不放行）', async () => {
    const { code, output } = await runGate({ 'packages/app/src/probe.css': '.a { color: red; }\n' }, { baseline: null });
    expect(code).toBe(1);
    expect(output).toContain('读不到基线');
  });

  it('仓库真跑：--selftest 五向全过（两族红 + 合法绿 + 收紧豁免两红），主闸对真基线绿', async () => {
    const self = await run('node', [SCRIPT, '--selftest']);
    expect(self.stdout).toContain('自证通过');
    const main = await run('node', [SCRIPT]);
    expect(main.stdout).toContain('✅ 刻度面审计：两类检查均未超出基线。');
  });

  it('基线文件在册且两族都有条目（防"空基线假绿"）', async () => {
    const raw = await fs.readFile(path.join(REPO_ROOT, 'tools', 'audit-token-scale-baseline.json'), 'utf8');
    const json = JSON.parse(raw) as { checks: Record<string, { total: number; files: Record<string, number> }> };
    expect(Object.keys(json.checks).sort()).toEqual([...CHECK_IDS].sort());
    for (const id of CHECK_IDS) {
      expect(json.checks[id].total).toBeGreaterThan(0); // 今天还没清零：清零后这一条要跟着改口径
      expect(Object.keys(json.checks[id].files).length).toBeGreaterThan(0);
    }
  });
});
