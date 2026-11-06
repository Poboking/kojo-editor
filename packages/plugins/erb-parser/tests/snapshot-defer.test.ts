/**
 * MCP-PERF-S16 · 索引快照保存后台化（去抖）判据（假 io + 假存储域，无 IO、无语料）。
 *
 * ## 侦察结论（改前形状，本文件先红的依据）
 * `build()` 的 commit 尾段（`gen === generation` 门内、广播 `kojo.functionChanged` 之前）
 * 同步跑完 `mergeEntries → attachRefs → 两个信封摘要 → encodeEntries` 并**当场调用**
 * `storage.set`（fire-and-forget，但调用点在应答路径上）。整扫 promise 是
 * `ensureIndex()`（MCP semantic 腿）/ `rebuildNow()`（增量回退，`applyFileChanges` 契约
 * 被 `erb-index-sync` await）/ `project.opened` 级联的共同 await 对象——这条应答墙钟因此
 * 含快照组装 + 编码；真语料 18MB payload 实测 storage.set 落定 565–619ms（TRAE P1）。
 *
 * ## 改后形状（本文件钉住的判据）
 * commit 段只捕获 build 闭包的**不可变材料**（snapshot / allFiles / fresh / refsByPath /
 * namesFp / candidatesByPath / dimRefsByPath 全是 build 局部量，提交后无人 mutate）并
 * `schedule(key, make)`；组装 / 编码 / 落盘全部挪进 `SNAPSHOT_SAVE_DEBOUNCE_MS` 去抖回调：
 * - **应答先收口**：广播（=工具应答链起点）resolve 时 `storage.set` 一次都未被调用；
 * - **换代节流语义保留**：`gen === generation` 排程门逐字保留；同一 key 窗内再排 = 替换
 *   （只落最新一代、只落一次），窗内换代 = 新代重付组装，绝不落半代（make 闭包只读
 *   单轮不可变材料，无跨轮混账）；
 * - **CRASH 安全取舍（写明）**：窗宽 300ms = 本插件既有增量去抖（INCREMENTAL_DEBOUNCE_MS）
 *   同 cadence，一处"后台窗"心智；MCP 应答在微任务级收口，300ms 足以让定时器回调整批
 *   落在应答之后。窗内进程崩溃 = 盘上快照比内存旧一代（≤300ms）：下次冷开热载旧代后由
 *   逐文件 mtime+size 判据补差（diffSnapshot）或整轮冷建重付——快照是缓存不是数据，
 *   不损数据、不静默（成功 / 失败 / 弃用都有日志行）。插件 dispose 丢待落盘（同崩溃
 *   语义）；关项目不禁（最后一代照落，下次开同项目热载）。salvage 改写回写键同样延迟
 *   300ms：窗内退出 = 下轮重付一次 salvage 巡检，闭环条件（作废不连坐）不破。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, ErbParserService, FileIO, FileStat, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { SNAPSHOT_VERSION, snapshotKeyFor } from '../src/snapshot';
import { makeComputeStub } from './support';

const ROOT = 'D:/proj/eratw';
const KOJO = `${ROOT}/ERB`;
const P1 = `${KOJO}/M_KOJO_K1.ERB`;
const P2 = `${KOJO}/M_KOJO_K2.ERB`;

const SRC1 = '@FOO_A\n\tPRINTFORMW 甲。\nRETURN 1\n\n@FOO_B\n\tPRINTFORML 乙。\nRETURN 1\n';
const SRC2 = '@BAR_A\n\tPRINTFORMW 丙。\nRETURN 1\n';
const SRC1_TOUCHED = `${SRC1}@FOO_C\nRETURN 1\n`;

interface FakeFile {
  text: string;
  mtimeMs: number;
}

/** 假 io（与 snapshot-flow 同形）：内存 FS + 读计数 + withMetadata 顺带带回 */
function makeIO(files: Map<string, FakeFile>) {
  let reads = 0;
  const readOne = (path: string): { path: string; text: string; encoding: 'utf-8'; eol: 'lf'; mtimeMs: number } => {
    const f = files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    reads++;
    return { path, text: f.text, encoding: 'utf-8', eol: 'lf', mtimeMs: f.mtimeMs };
  };
  const io = {
    readText: async (path: string) => readOne(path),
    readTexts: async (paths: readonly string[]) => paths.map((p) => (files.has(p) ? readOne(p) : null)),
    walkDir: async (root: string): Promise<DirEntry[]> =>
      [...files.keys()]
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop()!, path: p, isDirectory: false, mtimeMs: files.get(p)!.mtimeMs, size: files.get(p)!.text.length })),
    stat: async (path: string): Promise<FileStat | null> => {
      const f = files.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return { io: io as unknown as FileIO, readsOf: () => reads };
}

/** 假存储域：真 JSON 往返 + **同步调用计数与时刻**（A/B 探针的量测面） */
function makeStorage() {
  const map = new Map<string, string>();
  let sets = 0;
  let setCallAt = 0;
  const storage: ScopedStorage = {
    get: async <T = unknown>(key: string) => {
      const raw = map.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown) => {
      sets++;
      setCallAt = performance.now();
      map.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
  return { storage, map, setsOf: () => sets, setCallAtOf: () => setCallAt };
}

function activate(io: FileIO, storage: ScopedStorage, logs?: string[]) {
  const provided = new Map<string, unknown>();
  const handlers = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, h: (p: never) => void) {
      let s = handlers.get(type);
      if (!s) {
        s = new Set();
        handlers.set(type, s);
      }
      s.add(h);
      return () => s!.delete(h);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload as never);
    },
  };
  const disposers: (() => void)[] = [];
  const ctx = {
    pluginId: 'erb-parser',
    log: {
      debug() {},
      info: (m: string) => logs?.push(m),
      warn: (m: string) => logs?.push(m),
      error() {},
    },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => void disposers.push(fn as () => void),
    provide: (key: string, value: unknown) => void provided.set(key, value),
  };
  createErbParserPlugin().activate(ctx as never);
  const service = provided.get('erb.parser') as ErbParserService;
  const waitIndexed = (timeoutMs = 2000): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), timeoutMs);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service, bus, waitIndexed, unload: () => disposers.forEach((d) => d()) };
}

const openProject = (bus: { emit: (t: string, p: unknown) => void }): void => {
  bus.emit('project.opened', {
    project: { rootDir: ROOT, adapterId: 'eratw', kojoPaths: [KOJO], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
};

/** 去抖窗 + 落地的轮询等待（5ms × 2s ≥ 窗宽 300ms，绝不 sleep 死等） */
async function waitFor(pick: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !pick(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pick()).toBe(true);
}

describe('MCP-PERF-S16 快照保存后台化', () => {
  it('应答先收口：广播 resolve 时 storage.set 尚未调用，去抖窗后才落盘', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io, readsOf } = makeIO(files);
    const { storage, map, setsOf, setCallAtOf } = makeStorage();
    const { service, bus, waitIndexed } = activate(io, storage);

    openProject(bus);
    const t0 = performance.now();
    await waitIndexed(); // 整扫应答（ensureIndex / 广播级联的共同 await 对象）
    const responseAt = performance.now();
    // A/B 核心：应答收口那一刻，快照落盘（组装 + 编码 + set 调用）还一笔都没付
    expect(setsOf()).toBe(0);
    const key = snapshotKeyFor(ROOT);
    await waitFor(() => map.has(key)); // 去抖窗后照常落盘
    expect(setsOf()).toBe(1);
    console.log(
      `[snapshot-defer] 应答墙钟 ${(responseAt - t0).toFixed(1)}ms · set 调用晚于应答 ` +
        `${(setCallAtOf() - responseAt).toFixed(1)}ms（改前 = 负值：调用点在应答路径上）`,
    );
    const raw = JSON.parse(map.get(key)!) as { version: number; rootDir: string; entries: Record<string, unknown> };
    expect(raw.version).toBe(SNAPSHOT_VERSION);
    expect(raw.rootDir).toBe(ROOT);
    expect(Object.keys(raw.entries).sort()).toEqual([P1, P2]);

    const readsAfterCold = readsOf();
    openProject(bus); // 热载零回退：盘上这份照常命中（复用 2/2，一次读都不多付）
    await waitIndexed();
    expect(readsOf()).toBe(readsAfterCold);
    expect(service.currentIndex()!.files.size).toBe(2);
  });

  it('窗内换代：只落最新一代、整窗只落一次（旧代重付，绝不落半代）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io } = makeIO(files);
    const { storage, map, setsOf } = makeStorage();
    const { bus, waitIndexed } = activate(io, storage);
    const key = snapshotKeyFor(ROOT);

    openProject(bus);
    await waitIndexed(); // 代 A 提交并排程（尚未落盘）
    files.set(P1, { text: SRC1_TOUCHED, mtimeMs: 300 });
    openProject(bus); // 代 B：换代发生在 A 的去抖窗内
    await waitIndexed();
    await waitFor(() => {
      const raw = map.get(key);
      return raw !== undefined && raw.includes('FOO_C'); // 落的是最新一代
    });
    expect(setsOf()).toBe(1); // 改前红：两代各落一次 = 2
    expect(map.size).toBe(1);
  });

  it('dispose 丢待落盘：卸载后去抖窗内不再落盘（崩溃同语义，不静默）', async () => {
    const files = new Map<string, FakeFile>([
      [P1, { text: SRC1, mtimeMs: 100 }],
      [P2, { text: SRC2, mtimeMs: 200 }],
    ]);
    const { io } = makeIO(files);
    const { storage, map, setsOf } = makeStorage();
    const { bus, waitIndexed, unload } = activate(io, storage);
    const key = snapshotKeyFor(ROOT);

    openProject(bus);
    await waitIndexed(); // 已排程、未落盘
    unload();
    await new Promise((r) => setTimeout(r, 2 * 300 + 50)); // 越过去抖窗
    expect(setsOf()).toBe(0); // 改前红：当场已落 = 1
    expect(map.has(key)).toBe(false);
  });
});
