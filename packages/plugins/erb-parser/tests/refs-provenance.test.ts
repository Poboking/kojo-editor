/**
 * REFS-PROVENANCE（2026-10-22）—— refs 溯源位的**调度面**判据。
 *
 * 痛点：名录一变（新增/改名一个函数），PS-3 的溯源巡检把**全部**复用条目判可疑
 * ⇒ 全树重扫（真语料 ~7.4s / 2,325 文件；worker 通道后 ~1.4s，仍是全树）。
 * 本批给每个文件持久化「候选记号位」（扫描时问过 `hasName` 的一切记号），
 * 名录变更时用「变了的名单 ∩ 文件候选集」筛出**受影响文件**，只重扫这些；
 * 其余复用条目的 refs 被证明在当前名录下逐字可信 ⇒ 只补记账（refsNamesFp），不重扫。
 *
 * 本文件钉四条：
 * 1. **新增一个函数名**：只有被改的那棵文件进重扫（改前实现 = 全树 → 必红）；
 * 2. **改名一个函数**：定义文件（stale）+ 文本里提到旧名的文件进重扫，其余免扫；
 * 3. **等价面**：每轮的索引（files/byName/bySymbol/fileMtimes/fileSizes）与
 *    "同一份盘全量重建"逐条目全等（调度面换了，产出一个字不许变）；
 * 4. **收口**：重扫轮之后信封摘要命中 ⇒ 再开（无变更）零重扫；快照里每条目带候选位。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, ErbIndex, ErbParserService, FileIO, FileStat, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { decodeCandidateHashes, hashToken, snapshotKeyFor } from '../src/snapshot';
import { makeComputeStub } from './support';

const ROOT = 'D:/proj/refs-prov';
const KOJO = `${ROOT}/ERB`;
const N_FILES = 30;
const pathOf = (i: number): string => `${KOJO}/f${String(i).padStart(3, '0')}.ERB`;
/** 每棵一个定义 + 一处跨文件 CALL ⇒ 每个名字恰好被两棵文件提到（定义树 + 调用树） */
const srcOf = (i: number): string => `@F${i}\n\tRETURN 1\nCALL F${(i + 1) % N_FILES}\n`;

function freshFiles(): Map<string, { text: string; mtimeMs: number }> {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  for (let i = 0; i < N_FILES; i++) files.set(pathOf(i), { text: srcOf(i), mtimeMs: 100 + i });
  return files;
}

function makeIO(files: Map<string, { text: string; mtimeMs: number }>) {
  type FakeTextFile = { path: string; text: string; encoding: 'utf-8'; eol: 'lf'; mtimeMs: number };
  const textCache = new Map<string, { mtimeMs: number; size: number; tf: FakeTextFile }>();
  const io = {
    readText: async (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      return { path, text: f.text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: f.mtimeMs };
    },
    readTexts: async (paths: readonly string[]) => {
      const out: Array<FakeTextFile | null> = [];
      for (const path of paths) {
        const f = files.get(path);
        if (!f) {
          out.push(null);
          continue;
        }
        const cached = textCache.get(path);
        if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.text.length) {
          out.push(cached.tf);
          continue;
        }
        const tf = { path, text: f.text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: f.mtimeMs };
        textCache.set(path, { mtimeMs: f.mtimeMs, size: f.text.length, tf });
        out.push(tf);
      }
      return out;
    },
    walkDir: async (root: string): Promise<DirEntry[]> =>
      [...files.keys()]
        .filter((p) => p.startsWith(root))
        .sort()
        .map((p) => ({
          name: p.split('/').pop()!,
          path: p,
          isDirectory: false,
          mtimeMs: files.get(p)!.mtimeMs,
          size: files.get(p)!.text.length,
        })),
    stat: async (path: string): Promise<FileStat | null> => {
      const f = files.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return { io: io as unknown as FileIO };
}

function makeStorage() {
  const map = new Map<string, string>();
  const storage: ScopedStorage = {
    get: async <T = unknown>(key: string) => {
      const raw = map.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown) => {
      map.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  };
  return { storage, map };
}

interface Instance {
  service: ErbParserService;
  bus: { emit: (t: string, p: unknown) => void };
  waitIndexed: (timeoutMs?: number) => Promise<void>;
}

function activate(io: FileIO, storage: ScopedStorage, logs?: string[]): Instance {
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
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug() {}, info: (m: string) => logs?.push(m), warn: (m: string) => void logs?.push(m), error() {} },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
  };
  createErbParserPlugin().activate(ctx as never);
  const waitIndexed = (timeoutMs = 8000): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), timeoutMs);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service: provided.get('erb.parser') as ErbParserService, bus, waitIndexed };
}

const openProject = (inst: Instance): void => {
  inst.bus.emit('project.opened', {
    project: { rootDir: ROOT, adapterId: 'eratw', kojoPaths: [KOJO], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
};

/** 插件自己打的读数：refs 段重扫文件数（`refs scan …(rescan N)`） */
const rescanOf = (logs: readonly string[]): number => {
  const m = /refs scan \d+ms \(rescan (\d+)/.exec(logs.join('\n'));
  if (!m) throw new Error(`refs scan 读数行缺失：${logs.join('\n').slice(-600)}`);
  return Number(m[1]);
};

/** 索引的确定性序列化（等价面对拍口径） */
const dumpIndex = (idx: ErbIndex): string =>
  JSON.stringify({
    files: [...idx.files.entries()].map(([p, f]) => [p, f.functions.map((fn) => fn.normalizedName), f.lineCount]),
    byName: [...idx.byName.entries()].map(([n, refs]) => [n, refs.map((r) => [r.filePath, r.startLine, r.endLine])]),
    references: [...(idx.references?.bySymbol.entries() ?? [])].map(([n, list]) => [
      n,
      list.map((r) => [r.filePath, r.line, r.column, r.endColumn, r.kind]),
    ]),
    fileMtimes: [...idx.fileMtimes!.entries()].sort(),
    fileSizes: [...idx.fileSizes!.entries()].sort(),
  });

const waitFor = async (pick: () => boolean, rounds = 800): Promise<void> => {
  for (let i = 0; i < rounds && !pick(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pick()).toBe(true);
};

/** 对照面：同一份盘、空存储域从头全量重建 */
async function coldIndex(files: Map<string, { text: string; mtimeMs: number }>): Promise<ErbIndex> {
  const { io } = makeIO(files);
  const { storage } = makeStorage();
  const inst = activate(io, storage);
  openProject(inst);
  await inst.waitIndexed();
  return inst.service.currentIndex()!;
}

describe('REFS-PROVENANCE：名录变更只重扫受影响文件', () => {
  it('新增一个函数名：只有被改的那棵文件进重扫，其余免扫且索引与全量重建逐字等价', async () => {
    const files = freshFiles();
    const { io } = makeIO(files);
    const { storage, map } = makeStorage();
    const logs: string[] = [];
    const inst = activate(io, storage, logs);
    const key = snapshotKeyFor(ROOT);

    openProject(inst);
    await inst.waitIndexed();
    await waitFor(() => map.has(key) && logs.some((m) => m.includes('Index snapshot saved')));

    // 改 f000：新增一个谁都没提过的函数名 ⇒ 名录变了。其余 29 棵 mtime/size 全没变。
    files.set(pathOf(0), { text: srcOf(0) + '\n@F_NEW\n\tRETURN 1\n', mtimeMs: 999 });
    logs.length = 0;
    openProject(inst);
    await inst.waitIndexed();

    // 判据①：重扫 = f000 那一棵（解析段 stale）。改前实现：全部 30 棵都进重扫（1 stale + 29 可疑）。
    expect(rescanOf(logs)).toBe(1);

    // 判据③：等价面 —— 与同一份盘的全量重建逐字相同
    expect(dumpIndex(inst.service.currentIndex()!)).toBe(dumpIndex(await coldIndex(files)));
  }, 30_000);

  it('改名一个函数：定义树（stale）+ 提到旧名的调用树进重扫，其余 28 棵免扫', async () => {
    const files = freshFiles();
    const { io } = makeIO(files);
    const { storage, map } = makeStorage();
    const logs: string[] = [];
    const inst = activate(io, storage, logs);
    const key = snapshotKeyFor(ROOT);

    openProject(inst);
    await inst.waitIndexed();
    await waitFor(() => map.has(key) && logs.some((m) => m.includes('Index snapshot saved')));

    // f000 把 @F0 改名 @F0X；F0 的唯一调用方是 f029（CALL F0）
    files.set(pathOf(0), { text: srcOf(0).replace('@F0\n', '@F0X\n'), mtimeMs: 999 });
    logs.length = 0;
    openProject(inst);
    await inst.waitIndexed();

    // 判据②：重扫 = f000（stale）+ f029（候选命中）。改前实现：30 棵全扫。
    expect(rescanOf(logs)).toBe(2);
    const salvageLine = logs.find((m) => m.includes('index salvage')) ?? '';
    expect(salvageLine).toContain('溯源补正 1');
    expect(salvageLine).toContain(`候选免扫 ${N_FILES - 2}`);

    // 等价面：F0 没了、F0X 有定义无调用；全量重建对拍
    const hot = inst.service.currentIndex()!;
    expect(hot.byName.has('F0')).toBe(false);
    expect(hot.byName.has('F0X')).toBe(true);
    expect(dumpIndex(hot)).toBe(dumpIndex(await coldIndex(files)));
  }, 30_000);

  it('收口：重扫轮之后信封命中 ⇒ 再开（无变更）零重扫；快照条目带候选位', async () => {
    const files = freshFiles();
    const { io } = makeIO(files);
    const { storage, map } = makeStorage();
    const logs: string[] = [];
    const inst = activate(io, storage, logs);
    const key = snapshotKeyFor(ROOT);

    openProject(inst);
    await inst.waitIndexed();
    await waitFor(() => map.has(key) && logs.some((m) => m.includes('Index snapshot saved')));

    files.set(pathOf(0), { text: srcOf(0) + '\n@F_NEW\n\tRETURN 1\n', mtimeMs: 999 });
    openProject(inst);
    await inst.waitIndexed();
    // 等异步落盘收口（候选位必须已在盘上）
    await waitFor(() => {
      const raw = JSON.parse(map.get(key)!) as { namesFp: unknown; entries: Record<string, unknown[]> };
      return typeof raw.namesFp === 'number' && Object.values(raw.entries).every((t) => t.length >= 11);
    });
    const saved = JSON.parse(map.get(key)!) as { namesFp: unknown; entries: Record<string, unknown[]> };
    expect(typeof saved.namesFp).toBe('number'); // 免扫条目补了账 ⇒ 信封命中
    for (const t of Object.values(saved.entries)) {
      expect(t.length).toBe(11); // 第 11 位 = 候选记号位（v12 起是哈希集的 base64；'' = 已知空）
      expect(typeof t[10]).toBe('string');
      expect(t[10] as string).not.toContain('\n'); // base64 不可能含连接符（v11 的记号串才会）
    }
    // f029 的候选集里必须有 F0（它 CALL F0）——候选位真的是"问过 hasName 的一切记号"。
    // v12 起盘上是哈希集的 base64，成员判定要解出来查哈希（语义与 v11 逐条相同）
    const cand = decodeCandidateHashes(saved.entries[pathOf(N_FILES - 1)]![10] as string)!;
    expect(Array.from(cand)).toContain(hashToken('F0'));

    // 再开（无任何变更）：信封命中 ⇒ 溯源巡检整段跳过，重扫 0
    logs.length = 0;
    openProject(inst);
    await inst.waitIndexed();
    expect(rescanOf(logs)).toBe(0);
    expect(logs.find((m) => m.includes('index salvage')) ?? '').toContain('溯源补正 0');
  }, 30_000);
});
