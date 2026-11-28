/**
 * `tools/mcp-health.mjs` 判据（WP-4 余项 · 五格体检）。
 *
 * 要解决的那件事：**能力面的五个读数分散在四个地方**——枚数在 `mcp-inventory --json`、
 * 帧余量在载荷量具、缺口分布在 `coverage.byReason`、孤儿写腿在两个数组里、
 * 而 README 的数字是**人手抄的**。于是「文档说 86、代码算出 85」这种事只能靠人肉对账，
 * 上一批（WP-6a）就真的踩到「文档 11 / 代码 10 互相冤枉」。
 *
 * 这一条把它收成一个命令：**一次跑完五格，漂移即非零退出，并点名是哪一格**。
 *
 * 判据（全部黑盒：spawn 真脚本，不 import 内部函数）：
 *  1. `--json` 稳定 schema：五格齐全（counts / payload / gaps / orphanWires / readme）。
 *  2. 枚数与 `buildInventory` **同一真源**（不是另算一份）：tools 86 = read 41 / edit 15 / privileged 30。
 *  3. 帧余量与能力面**同一量具**：`payload.faces.*.frameBytes` 逐字等于
 *     `kojo://server/capability-face` 报给模型的同一档数字（同一个 id、同一个函数）。
 *  4. 缺口分布合得上：`byReason` 各档之和 === `deferredGaps`。
 *  5. 孤儿写腿两处都摊开：`coverage.orphanedWires` 与 `writeLegs` 的 NOT_WIRED 各自点名。
 *  6. README 漂移**真的会红**：拿一份改坏数字的夹具跑，必须 exit 1 且点名那一格（否则这条是假绿）。
 *  7. `--no-payload`：测不到的格子给 `null` + 原因，不冒充 0、不算漂移。
 *  8. 参数错 exit 2；真树全绿 exit 0。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../mcp-inventory.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEALTH = join(REPO_ROOT, 'tools/mcp-health.mjs');

interface HealthReport {
  schemaVersion: number;
  counts: {
    tools: { total: number; read: number; edit: number; privileged: number };
    resourcesSpecs: number | null;
    resourcesInjected: number | null;
    resourcesRuntime: number | null;
    prompts: number | null;
    registryResources: number | null;
    registryPrompts: number | null;
  };
  payload: {
    transportLimitBytes: number | null;
    faces: Record<string, { toolCount: number; frameBytes: number; headroomBytes: number }>;
    unavailable?: string | null;
  };
  gaps: { totalGaps: number; wiredGaps: number; deferredGaps: number; byReason: Record<string, number> };
  orphanWires: { coverage: string[]; writeLegs: string[] };
  readme: { cells: { field: string; readme: number | null; actual: number | null; ok: boolean | null }[]; drift: string[] };
  ok: boolean;
}

/** 跑真脚本：**不吞 stderr**，失败时把 stderr 原样带进断言消息。 */
async function runHealth(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [HEALTH, ...args], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const parse = (stdout: string): HealthReport => JSON.parse(stdout) as HealthReport;

describe('mcp-health 五格体检', () => {
  it('① --json 稳定 schema：五格齐全', async () => {
    const { code, stdout, stderr } = await runHealth(['--json']);
    expect(stderr, `脚本 stderr：${stderr}`).toBe('');
    expect(code, '真树体检必须全绿（红就先修文档或代码，别放宽判据）').toBe(0);
    const r = parse(stdout);
    expect(r.schemaVersion).toBe(1);
    for (const key of ['counts', 'payload', 'gaps', 'orphanWires', 'readme']) {
      expect(r, `缺第 ${key} 格`).toHaveProperty(key);
    }
    expect(r.ok).toBe(true);
  });

  it('② 枚数与 buildInventory 同一真源，不另算一份', async () => {
    const inv = (await buildInventory(REPO_ROOT)) as {
      coverage: { tools: { total: number; read: number; edit: number; privileged: number } };
    };
    const r = parse((await runHealth(['--json'])).stdout);
    expect(r.counts.tools).toEqual({
      total: inv.coverage.tools.total,
      read: inv.coverage.tools.read,
      edit: inv.coverage.tools.edit,
      privileged: inv.coverage.tools.privileged,
    });
    // 这两个数必须分开报（规格 ≠ 运行期），WP-6a 就是在这里踩过「文档 11 / 代码 10」。
    expect(r.counts.resourcesSpecs).toBe(11);
    expect(r.counts.resourcesInjected).toBe(1);
    expect(r.counts.resourcesRuntime).toBe(12);
    // 装载了注册表时，注册表自己的读数必须等于规格数（多一条就说明有人绕过规格表加资源）。
    expect(r.counts.registryResources).toBe(r.counts.resourcesSpecs);
  });

  it('③ 帧余量与能力面同一量具：同一个 id、同一个函数、同一档数字', async () => {
    const r = parse((await runHealth(['--json'])).stdout);
    const full = r.payload.faces.full!;
    expect(r.payload.transportLimitBytes).toBe(1024 * 1024);
    expect(full.headroomBytes).toBe(r.payload.transportLimitBytes - full.frameBytes);
    expect(full.toolCount).toBe(r.counts.tools.total);

    // 能力面资源报的是「本会话可见面」，全量批准会话那一档必须与这里的 full 逐字相等。
    const hostUrl = pathToFileURL(join(REPO_ROOT, 'packages/mcp-host/src/index.ts')).href;
    const probe = `
      import { CAPABILITY_FACE_URI, createMcpCapabilityRegistry, SEMANTIC_TOOL_SPECS, KERNEL_IO_TOOL_SPECS, SUPPLEMENTAL_TOOL_SPECS } from '${hostUrl}';
      const all = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
      const reg = createMcpCapabilityRegistry({});
      const scope = { sessionId: 's', clientId: 'c', tier: 'privileged', approvedRoots: [], approvedTools: all.map((s) => s.name) };
      const r = await reg.readResource(CAPABILITY_FACE_URI, scope);
      console.log(JSON.parse(r.contents[0].text).payload.toolsListFrameBytes);
    `;
    const dir = await mkdtemp(join(tmpdir(), 'kojo-health-probe-'));
    try {
      const file = join(dir, 'probe.mts');
      await writeFile(file, probe, 'utf8');
      const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', file], { cwd: REPO_ROOT });
      expect(full.frameBytes).toBe(Number(stdout.trim()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('④ 缺口分布合得上：byReason 之和 === deferredGaps', async () => {
    const r = parse((await runHealth(['--json'])).stdout);
    const sum = Object.values(r.gaps.byReason).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.gaps.deferredGaps);
    expect(r.gaps.totalGaps).toBe(r.gaps.wiredGaps + r.gaps.deferredGaps);
  });

  it('⑤ 孤儿写腿两处都摊开（数组形态，缺席也要是空数组而不是 undefined）', async () => {
    const r = parse((await runHealth(['--json'])).stdout);
    expect(Array.isArray(r.orphanWires.coverage)).toBe(true);
    expect(Array.isArray(r.orphanWires.writeLegs)).toBe(true);
    expect(r.orphanWires.coverage).toEqual([]);
    expect(r.orphanWires.writeLegs).toEqual([]);
  });

  it('⑥ README 漂移真的会红：改坏一格数字必须 exit 1 并点名', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kojo-health-fixture-'));
    try {
      const readme = await (await import('node:fs/promises')).readFile(join(REPO_ROOT, 'docs/mcp/README.md'), 'utf8');
      // 只改 tools 总数那一格（86 → 99），其余逐字不动。
      const doctored = readme.replace(/tools \*\*(\d+)\*\*/, 'tools **99**');
      expect(doctored).not.toBe(readme);
      await mkdir(join(dir, 'docs/mcp'), { recursive: true });
      await writeFile(join(dir, 'docs/mcp/README.md'), doctored, 'utf8');

      const { code, stdout } = await runHealth(['--json', '--root', dir, '--no-payload']);
      expect(code, '改坏的 README 必须让体检非零退出').toBe(1);
      const r = parse(stdout);
      expect(r.ok).toBe(false);
      const cell = r.readme.cells.find((c) => c.field === 'tools.total')!;
      expect(cell).toMatchObject({ readme: 99, actual: 0, ok: false });
      expect(r.readme.drift).toContain('tools.total');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('⑦ --no-payload：只少测帧那一格，枚数照样静态算得出（不冒充 0、也不算漂移）', async () => {
    const { code, stdout } = await runHealth(['--json', '--no-payload']);
    const r = parse(stdout);
    expect(code, '--no-payload 只是少测一格，不是失败').toBe(0);
    expect(r.payload.unavailable).toBeTruthy();
    expect(r.payload.transportLimitBytes).toBeNull();
    expect(r.payload.faces).toEqual({});
    // 资源 / 提示词的枚数是**静态**算的（规格清单 + 注入集合差 + 骨架条目），不依赖注册表装载。
    expect(r.counts.resourcesRuntime).toBe(12);
    expect(r.counts.prompts).toBe(3);
    expect(r.counts.registryResources).toBeNull();
    const cell = r.readme.cells.find((c) => c.field === 'resources')!;
    expect(cell.ok, '静态能算的格子不许因为 --no-payload 就装死').toBe(true);
  });

  it('⑨ README 少了一节 ⇒ 该格判红（措辞变了也是漂移，不许静默通过）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kojo-health-nosection-'));
    try {
      // 整节 §10.5 删掉：数读不到 ⇒ 必须红，而不是「读不到就当没漂移」。
      const readme = await (await import('node:fs/promises')).readFile(join(REPO_ROOT, 'docs/mcp/README.md'), 'utf8');
      const stripped = readme.replace(/### 10\.5[\s\S]*?(?=\n#{2,3} )/, '');
      expect(stripped.length).toBeLessThan(readme.length);
      await mkdir(join(dir, 'docs/mcp'), { recursive: true });
      await writeFile(join(dir, 'docs/mcp/README.md'), stripped, 'utf8');

      const { code, stdout } = await runHealth(['--json', '--root', dir, '--no-payload']);
      expect(code).toBe(1);
      const r = parse(stdout);
      expect(r.readme.drift).toContain('tools.total');
      expect(r.readme.cells.find((c) => c.field === 'tools.total')).toMatchObject({ readme: null, ok: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('⑧ 参数错 exit 2', async () => {
    const { code } = await runHealth(['--root']);
    expect(code).toBe(2);
  });
});
