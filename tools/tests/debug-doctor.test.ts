/**
 * `tools/debug-doctor.mjs` 的纯逻辑护栏。
 *
 * 造法：`fs.mkdtemp` 起一个**假仓库骨架**（package.json + tools/debug-cli.mjs +
 * 可选的 session/dist/vite 缓存/lock），端口探测与进程判活一律注入桩——
 * 断言只落在 level、退出码、`--json` 的键序与 `ok` 上，**不连任何真端口、不碰真进程**。
 *
 * 六种组合（与需求一一对应）：全绿 / session 坏 JSON / 端口不通 / 缺 dist / 缓存过期 / 无 session。
 * 另加：node 版本过低、缺 package.json、fix 命令形态、人类输出格式。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_IDS, exitCodeFor, formatHuman, parseArgs, runDoctor } from '../debug-doctor.mjs';

const SESSION = {
  sessionId: 'fixture',
  serverPort: 45101,
  vitePort: 45102,
  cdpPort: 45103,
  serverPid: 41001,
  vitePid: 41002,
  browserPid: 41003,
};

const GREEN_LOCK_TIME = new Date('2026-10-01T00:00:00Z');
const GREEN_CACHE_TIME = new Date('2026-10-02T00:00:00Z');

const tmpDirs: string[] = [];

type RepoOptions = {
  packageJson?: boolean;
  cli?: boolean;
  session?: unknown | string | null;
  dist?: boolean;
  viteCache?: boolean | string;
  lock?: boolean;
};

/** 造一个临时仓库骨架；所有写入都落在 mkdtemp 目录里，跑完即删 */
async function makeRepo(opts: RepoOptions = {}): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-doctor-'));
  tmpDirs.push(repo);

  if (opts.packageJson !== false) {
    await fs.writeFile(path.join(repo, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf-8');
  }
  if (opts.cli !== false) {
    await fs.mkdir(path.join(repo, 'tools'), { recursive: true });
    await fs.writeFile(path.join(repo, 'tools', 'debug-cli.mjs'), '// stub\n', 'utf-8');
  }
  if (opts.session !== undefined && opts.session !== null) {
    await fs.mkdir(path.join(repo, '.kojo-debug'), { recursive: true });
    const body = typeof opts.session === 'string' ? opts.session : JSON.stringify(opts.session, null, 2);
    await fs.writeFile(path.join(repo, '.kojo-debug', 'session.json'), body, 'utf-8');
  }
  if (opts.dist) {
    await fs.mkdir(path.join(repo, 'packages', 'app', 'dist'), { recursive: true });
    await fs.writeFile(path.join(repo, 'packages', 'app', 'dist', 'index.html'), '<!doctype html>\n', 'utf-8');
  }
  if (opts.viteCache !== false) {
    const metaPath = path.join(repo, 'node_modules', '.vite', 'deps', '_metadata.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    const body = typeof opts.viteCache === 'string' ? opts.viteCache : JSON.stringify({ optimized: {} });
    await fs.writeFile(metaPath, body, 'utf-8');
    if (opts.lock !== false) {
      await fs.writeFile(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf-8');
      // 默认「锁比缓存旧」= 健康态；过期组合由用例自己改 mtime
      await fs.utimes(path.join(repo, 'pnpm-lock.yaml'), GREEN_LOCK_TIME, GREEN_LOCK_TIME);
      await fs.utimes(metaPath, GREEN_CACHE_TIME, GREEN_CACHE_TIME);
    }
  }
  return repo;
}

const probeAll = async () => true;
const probeNone = async () => false;
const aliveAll = () => true;
const aliveNone = () => false;

function byId(result: any, id: string) {
  return result.checks.find((c: any) => c.id === id);
}

function levels(result: any) {
  return Object.fromEntries(result.checks.map((c: any) => [c.id, c.level]));
}

beforeEach(() => {
  // 会话查找会看环境变量：清掉，免得上一次 serve 的显式指定混进断言
  delete process.env.KOJO_DEBUG_SESSION;
  delete process.env.KOJO_DEBUG_SESSION_NAME;
});

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('debug-doctor · 全绿', () => {
  it('八项全 PASS、ok=true、退出码 0、id 顺序固定', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });

    expect(result.ok).toBe(true);
    expect(levels(result)).toEqual(Object.fromEntries(CHECK_IDS.map((id) => [id, 'PASS'])));
    expect(result.checks.map((c: any) => c.id)).toEqual(CHECK_IDS);
    expect(exitCodeFor(result)).toBe(0);
    expect(byId(result, 'vite-cache').fix).toBeUndefined();
  });

  it('人类输出一行一项，最后一行是汇总', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    const lines = formatHuman(result).split('\n');
    expect(lines).toHaveLength(result.checks.length + 1);
    expect(lines[0]).toMatch(/^\[PASS\] node-version/);
    expect(lines.at(-1)).toContain('FAIL 0');
  });
});

describe('debug-doctor · session 坏 JSON', () => {
  it('session-file FAIL 并给删除命令；端口/判活 WARN 跳过；退出码 1', async () => {
    const repo = await makeRepo({ session: '{"serverPort": 45101, "vitePort":', dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });

    expect(result.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(1);
    expect(byId(result, 'session-file').level).toBe('FAIL');
    expect(byId(result, 'session-file').fix).toContain('rm -f');
    expect(byId(result, 'session-file').fix).toContain('debug-cli.mjs serve');
    expect(byId(result, 'host-port').level).toBe('WARN');
    expect(byId(result, 'cdp-port').level).toBe('WARN');
    expect(byId(result, 'stale-procs').level).toBe('WARN');
    // 残文件不能顺手被删（体检只读）
    await expect(fs.access(path.join(repo, '.kojo-debug', 'session.json'))).resolves.toBeUndefined();
  });
});

describe('debug-doctor · 端口不通', () => {
  it('host-port / cdp-port 双 FAIL，fix 指向 stop', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeNone, isAlive: aliveAll });

    expect(byId(result, 'host-port').level).toBe('FAIL');
    expect(byId(result, 'cdp-port').level).toBe('FAIL');
    expect(byId(result, 'host-port').detail).toContain('45101');
    expect(byId(result, 'cdp-port').detail).toContain('45103');
    expect(byId(result, 'host-port').fix).toBe('node tools/debug-cli.mjs stop');
    expect(result.ok).toBe(false);
    expect(exitCodeFor(result)).toBe(1);
  });

  it('只缺一个端口时只红那一项（其余仍是 PASS）', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const probe = async (port: number) => port === SESSION.serverPort;
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe, isAlive: aliveAll });
    expect(byId(result, 'host-port').level).toBe('PASS');
    expect(byId(result, 'cdp-port').level).toBe('FAIL');
    expect(levels(result)['node-version']).toBe('PASS');
  });
});

describe('debug-doctor · 缺 dist', () => {
  it('dist-build WARN（只影响 shell 模式），不改变 ok/退出码', async () => {
    const repo = await makeRepo({ session: SESSION, dist: false });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });

    expect(byId(result, 'dist-build').level).toBe('WARN');
    expect(byId(result, 'dist-build').detail).toContain('shell');
    expect(result.ok).toBe(true);
    expect(exitCodeFor(result)).toBe(0);
  });
});

describe('debug-doctor · vite 缓存过期', () => {
  it('lock 比缓存新 ⇒ WARN + 删除命令；缓存文件仍在（体检不删）', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const meta = path.join(repo, 'node_modules', '.vite', 'deps', '_metadata.json');
    const lock = path.join(repo, 'pnpm-lock.yaml');
    await fs.utimes(meta, GREEN_LOCK_TIME, GREEN_LOCK_TIME);
    await fs.utimes(lock, GREEN_CACHE_TIME, GREEN_CACHE_TIME);

    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    const cache = byId(result, 'vite-cache');

    expect(cache.level).toBe('WARN');
    expect(cache.detail).toContain('缓存可能过期');
    expect(cache.fix).toContain('rm -rf');
    expect(cache.fix).toContain('node_modules/.vite/deps');
    expect(cache.fix).toContain('debug-cli.mjs serve');
    expect(result.ok).toBe(true);
    await expect(fs.access(meta)).resolves.toBeUndefined();
  });

  it('缓存比 lock 新 ⇒ PASS（对照组，证明上面的 WARN 来自 mtime 而非缺文件）', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    expect(byId(result, 'vite-cache').level).toBe('PASS');
    expect(byId(result, 'vite-cache').fix).toBeUndefined();
  });

  it('缓存元数据坏掉 ⇒ WARN（vite 会重建，不是故障）', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true, viteCache: '{oops' });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    expect(byId(result, 'vite-cache').level).toBe('WARN');
    expect(result.ok).toBe(true);
  });
});

describe('debug-doctor · 没有 session', () => {
  it('session / 端口 / pid 三类都 WARN 跳过，整体仍 OK、退出码 0', async () => {
    const repo = await makeRepo({ dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });

    expect(byId(result, 'session-file').level).toBe('WARN');
    expect(byId(result, 'session-file').detail).toContain('还没起过 serve');
    expect(byId(result, 'host-port').level).toBe('WARN');
    expect(byId(result, 'cdp-port').level).toBe('WARN');
    expect(byId(result, 'stale-procs').level).toBe('WARN');
    expect(result.ok).toBe(true);
    expect(exitCodeFor(result)).toBe(0);
  });
});

describe('debug-doctor · 前置失败与键序', () => {
  it('node 版本低于 22 ⇒ FAIL，detail 带实际版本', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '20.11.1', probe: probeAll, isAlive: aliveAll });
    expect(byId(result, 'node-version').level).toBe('FAIL');
    expect(byId(result, 'node-version').detail).toContain('20.11.1');
    expect(exitCodeFor(result)).toBe(1);
  });

  it('缺 package.json ⇒ FAIL，detail 点名缺哪件', async () => {
    const repo = await makeRepo({ packageJson: false, session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    expect(byId(result, 'repo-root').level).toBe('FAIL');
    expect(byId(result, 'repo-root').detail).toContain('package.json');
    expect(result.ok).toBe(false);
  });

  it('死 pid ⇒ WARN + stop；全部活着 ⇒ PASS', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const dead = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveNone });
    expect(byId(dead, 'stale-procs').level).toBe('WARN');
    expect(byId(dead, 'stale-procs').detail).toContain('browser');
    expect(byId(dead, 'stale-procs').fix).toBe('node tools/debug-cli.mjs stop');
    expect(dead.ok).toBe(true); // 死 pid 不阻塞体检结论

    const alive = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });
    expect(byId(alive, 'stale-procs').level).toBe('PASS');
  });

  it('--json 顶层键序固定为 ok → repo → checks，检查项键序 id → level → detail（+fix）', async () => {
    const repo = await makeRepo({ session: SESSION, dist: true });
    const result = await runDoctor({ repo, nodeVersion: '22.22.2', probe: probeAll, isAlive: aliveAll });

    expect(Object.keys(result)).toEqual(['ok', 'repo', 'checks']);
    expect(result.repo).toBe(path.resolve(repo));
    for (const c of result.checks) {
      expect(Object.keys(c).slice(0, 3)).toEqual(['id', 'level', 'detail']);
      if ('fix' in c) expect(Object.keys(c)).toEqual(['id', 'level', 'detail', 'fix']);
    }
    // 序列化后的键序与对象一致（JSON.stringify 按插入序）
    expect(JSON.stringify(result).indexOf('"ok"')).toBeLessThan(JSON.stringify(result).indexOf('"repo"'));
  });

  it('parseArgs 支持 --json / --repo <路径> / --repo=<路径>，未知参数抛错', () => {
    expect(parseArgs(['--json', '--repo', 'D:/tree'])).toMatchObject({ json: true, repo: path.resolve('D:/tree') });
    expect(parseArgs(['--repo=D:/tree']).repo).toBe(path.resolve('D:/tree'));
    expect(parseArgs([]).json).toBe(false);
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });
});
