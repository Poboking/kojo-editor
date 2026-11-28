/**
 * `tools/verify.mjs` 的 MCP 三道闸接线判据（T4）。
 *
 * 要解决的那件事：MCP 的体检 / 盘点 / 协议一致性三道闸以前只能靠人记得手动跑，
 * 跑全量验收的人拿到「全绿」时并不知道 MCP 面是不是红的。这一组判据要证明的是
 * **接线真的通了**（verify 把子进程的非零退出当失败），而不是「注册表里多了一行」。
 *
 * 全部黑盒：spawn 真脚本，不 import verify 内部函数。
 *  V1 `--list` 聚合行含三名 + 三行依赖就绪（证明进了 ALL_NAMES 且 precheck 不挡）。
 *  V2 改坏 README 的夹具 ⇒ `verify mcp-health` 退出码 1、`FAIL  mcp-health`、点名那一格。
 *  V3 同一夹具直接跑 `mcp-health` ⇒ 也退出码 1（对照：V2 的红来自子进程）。
 *  V4 `mcp-inventory --check`：缺源夹具 ⇒ 1 且点名源；真仓库 ⇒ 0。
 *  V5 `mcp-inventory` 不带 `--check` 对同一坏夹具仍 0（默认只读生成器，红线）。
 *  V6 `verify mcp-conformance` ⇒ 0 且 `PASS  mcp-conformance`（真跑 54 条对拍）。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFY = join(REPO_ROOT, 'tools/verify.mjs');
const HEALTH = join(REPO_ROOT, 'tools/mcp-health.mjs');
const INVENTORY = join(REPO_ROOT, 'tools/mcp-inventory.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑真脚本：不吞 stdout/stderr（verify 用 stdio inherit，子进程日志会落在这里）。 */
async function runNode(script: string, args: string[], timeoutMs = 180_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/** 造一个只有「被改坏的 README」的夹具根（tools 86 → 99），照 mcp-health.test.ts ⑥。 */
async function doctoredReadmeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kojo-verify-mcp-readme-'));
  const readme = await readFile(join(REPO_ROOT, 'docs/mcp/README.md'), 'utf8');
  const doctored = readme.replace(/tools \*\*(\d+)\*\*/, 'tools **99**');
  if (doctored === readme) throw new Error('夹具构造失败：README 里没找到 `tools **<n>**` 这一格');
  await mkdir(join(dir, 'docs/mcp'), { recursive: true });
  await writeFile(join(dir, 'docs/mcp/README.md'), doctored, 'utf8');
  return dir;
}

describe('verify · MCP 三道闸接线', () => {
  it('V1 --list：聚合行含三名，三行依赖就绪（进了 ALL_NAMES 且 precheck 不挡）', async () => {
    const { code, stdout } = await runNode(VERIFY, ['--list']);
    expect(code).toBe(0);
    const lines = stdout.split(/\r?\n/);
    const aggregate = lines.find((l) => l.includes('聚合:'));
    expect(aggregate, `没找到聚合行：\n${stdout}`).toBeTruthy();
    for (const name of ['mcp-health', 'mcp-inventory', 'mcp-conformance']) {
      expect(aggregate, `聚合行没含 ${name}（说明没进 ALL_NAMES）`).toContain(name);
      const row = lines.find((l) => new RegExp(`^\\s{2}${name}\\s{2,}`).test(l));
      expect(row, `注册表没列出 ${name}`).toBeTruthy();
      expect(row, `${name} 的前置被挡了：${row}`).not.toContain('缺依赖');
      expect(row, `${name} 的前置有误：${row}`).not.toContain('前置有误');
      expect(row).toContain('依赖就绪');
    }
  }, 60_000);

  it('V2 verify mcp-health 透传失败：改坏的 README ⇒ exit 1 + FAIL 行 + 点名格子', async () => {
    const dir = await doctoredReadmeRoot();
    try {
      const { code, stdout, stderr } = await runNode(VERIFY, ['mcp-health', '--root', dir, '--no-payload']);
      const all = `${stdout}\n${stderr}`;
      expect(code, `verify 没把子进程的失败当失败：\n${all}`).toBe(1);
      expect(stdout).toContain('FAIL  mcp-health');
      expect(all).toContain('tools.total');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('V3 对照：同一夹具直接跑 mcp-health 也是 exit 1（红来自子进程）', async () => {
    const dir = await doctoredReadmeRoot();
    try {
      const { code, stdout, stderr } = await runNode(HEALTH, ['--root', dir, '--no-payload']);
      const all = `${stdout}\n${stderr}`;
      expect(code, `直接跑体检应为 1：\n${all}`).toBe(1);
      expect(all).toContain('tools.total');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('V4 mcp-inventory --check：缺源夹具 exit 1 且点名源；真仓库 exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kojo-verify-mcp-missing-'));
    try {
      // 空目录 ⇒ 四处真源全缺（commands / rust / debug / plugins）。
      const bad = await runNode(INVENTORY, ['--check', '--root', dir]);
      const all = `${bad.stdout}\n${bad.stderr}`;
      expect(bad.code, `缺源时 --check 必须非零：\n${all}`).toBe(1);
      expect(all).toContain('packages/app/src/ui/commands.ts');
      expect(all).toContain('packages/app/src-tauri/src/lib.rs');

      const real = await runNode(INVENTORY, ['--check']);
      expect(real.code, `真仓库 --check 应全绿：\n${real.stdout}\n${real.stderr}`).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('V5 红线：不带 --check 时同一坏夹具仍 exit 0（默认只读生成器）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kojo-verify-mcp-default-'));
    try {
      const { code, stdout } = await runNode(INVENTORY, ['--root', dir, '--print']);
      expect(code, '默认行为是生成器，缺源不判红').toBe(0);
      const inv = JSON.parse(stdout) as { missingSources: string[] };
      expect(inv.missingSources.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('V6 verify mcp-conformance：真跑 54 条对拍 ⇒ exit 0 + PASS 行', async () => {
    const { code, stdout, stderr } = await runNode(VERIFY, ['mcp-conformance']);
    const all = `${stdout}\n${stderr}`;
    expect(code, `协议一致性闸应为 0：\n${all.slice(-4000)}`).toBe(0);
    expect(stdout).toContain('PASS  mcp-conformance');
  }, 180_000);
});
