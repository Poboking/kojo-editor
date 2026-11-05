/**
 * 项目级 `#DIM` 变量的**查找引用**（2026-11-05 项目级索引批）。
 *
 * 这一批把"Shift+F12 只在本文件里列出现点"补成两腿：光标在**全局**声明（文件顶层 /
 * `.ERH`）上 ⇒ 答项目级；光标在**函数体内**的局部声明上 ⇒ 仍只答本文件（`#DIM` 在函数体
 * 里是调用栈局部，真语料 67.7% 的声明是这种，跨函数同名互不相干）。
 *
 * 本文件钉六件事（每条都能单独变红）：
 * 1. **建表**：全局声明名进 `index.dimReferences`，局部声明名**不进**（进了就会串味）；
 * 2. **切段尺子**：`BETA（系列）` 这类含全角括号的真名字能整段匹配（函数记号尺会劈开它）；
 * 3. **项目级作答**：`.ERH` 的声明行上按 Shift+F12 ⇒ 跨文件全部落点；
 * 4. **遮蔽在查询时判**：`@SUB` 里也 `#DIM` 了同名变量 ⇒ 那个函数体里的同名记号**不算**
 *    全局变量的引用（建索引时剔会把结论冻进快照，改回来还得靠重扫）；
 * 5. **局部不吃项目腿**：光标在局部声明上 ⇒ 只有本文件（不把别处同名全局变量算进来）；
 * 6. **降级**：`index` 缺席 / `dimReferences` 未建 ⇒ 与加这一腿之前逐字等价（只看本文件）。
 */
import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  ErbIndex,
  ErbParserService,
  FileIO,
  FileStat,
  GameProject,
  ScopedStorage,
} from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { dimReferencesOf } from '../src/references';
import { erbReferencesAt } from '../src/symbols';
import { makeComputeStub } from './support';

const ROOT = 'D:/proj/dimrefs';
const KOJO = `${ROOT}/ERB`;
const ERH = `${KOJO}/DIM.ERH`;
const A = `${KOJO}/A.ERB`;
const B = `${KOJO}/B.ERB`;

/**
 * 行号与关键列（1 基）：
 * - `DIM.ERH` 2 `#DIMS KOJO_NAME`（名字第 7 列）｜3 `#DIM BETA（系列）`（第 6 列）
 * - `A.ERB` 2 `PRINTL KOJO_NAME`（第 10 列）｜6 `@SUB`｜7 `#DIM KOJO_NAME`（局部，第 7 列）
 *   8 `PRINTL KOJO_NAME`（局部那个）｜9 `Y = BETA（系列）`（第 7 列，仍指全局）
 * - `B.ERB` 2 `PRINTFORML KOJO_NAME`（第 14 列）
 */
const ERH_TEXT = ['; 全局声明', '#DIMS KOJO_NAME', '#DIM BETA（系列）'].join('\n');
const A_TEXT = [
  '@MAIN',
  '  PRINTL KOJO_NAME',
  '  X = BETA（系列）',
  '  CALL SUB',
  '',
  '@SUB',
  '  #DIM KOJO_NAME',
  '  PRINTL KOJO_NAME',
  '  Y = BETA（系列）',
  '  RETURN',
].join('\n');
const B_TEXT = ['@OTHER', '  PRINTFORML KOJO_NAME'].join('\n');

type FakeFiles = Map<string, { text: string; mtimeMs: number }>;

function files(): FakeFiles {
  return new Map([
    [A, { text: A_TEXT, mtimeMs: 100 }],
    [B, { text: B_TEXT, mtimeMs: 200 }],
    [ERH, { text: ERH_TEXT, mtimeMs: 300 }],
  ]);
}

function makeIO(map: FakeFiles): FileIO {
  const io = {
    readText: async (path: string) => {
      const f = map.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      return { path, text: f.text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: f.mtimeMs };
    },
    readTexts: async (paths: readonly string[]) =>
      paths.map((path) => {
        const f = map.get(path);
        return f === undefined
          ? null
          : { path, text: f.text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: f.mtimeMs };
      }),
    walkDir: async (root: string): Promise<DirEntry[]> =>
      [...map.keys()]
        .filter((p) => p.startsWith(root))
        .sort()
        .map((p) => ({
          name: p.split('/').pop()!,
          path: p,
          isDirectory: false,
          mtimeMs: map.get(p)!.mtimeMs,
          size: map.get(p)!.text.length,
        })),
    stat: async (path: string): Promise<FileStat | null> => {
      const f = map.get(path);
      return f ? { size: f.text.length, mtimeMs: f.mtimeMs, isDirectory: false } : null;
    },
  };
  return io as unknown as FileIO;
}

function makeStorage(): ScopedStorage {
  const map = new Map<string, string>();
  return {
    get: async <T = unknown>(key: string) => {
      const raw = map.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown) => void map.set(key, JSON.stringify(value)),
    delete: async (key: string) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

interface Contribution {
  id: string;
  provide: (request: unknown) => unknown;
}

interface Instance {
  service: ErbParserService;
  contributions: Map<string, Contribution>;
  bus: { emit: (t: string, p: unknown) => void };
  waitIndexed: () => Promise<void>;
}

function activate(io: FileIO, storage: ScopedStorage): Instance {
  const provided = new Map<string, unknown>();
  const contributions = new Map<string, Contribution>();
  const handlers = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, h: (p: never) => void) {
      let s = handlers.get(type);
      if (!s) handlers.set(type, (s = new Set()));
      s.add(h);
      return () => s!.delete(h);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload as never);
    },
  };
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (_kind: string, contribution: Contribution) => {
        contributions.set(contribution.id, contribution);
        return () => undefined;
      },
      query: () => [],
    },
    onDispose: (fn: unknown) => fn,
    provide: (key: string, value: unknown) => void provided.set(key, value),
  };
  createErbParserPlugin().activate(ctx as never);
  const waitIndexed = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), 8000);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return { service: provided.get('erb.parser') as ErbParserService, contributions, bus, waitIndexed };
}

async function buildIndex(map: FakeFiles): Promise<{ index: ErbIndex; inst: Instance }> {
  const inst = activate(makeIO(map), makeStorage());
  inst.bus.emit('project.opened', {
    project: { rootDir: ROOT, adapterId: 'eratw', kojoPaths: [KOJO], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
  await inst.waitIndexed();
  return { index: inst.service.currentIndex()!, inst };
}

/** 落点三元组（断言口径：谁、哪一行、第几列） */
const at = (locations: readonly { filePath: string; line: number; column?: number }[]): string[] =>
  locations.map((l) => `${l.filePath === A ? 'A' : l.filePath === B ? 'B' : l.filePath === ERH ? 'DIM' : l.filePath}:${l.line}:${l.column ?? '-'}`);

describe('index.dimReferences · 建表口径', () => {
  it('全局声明进表、局部声明不进（进了就会把 A 函数的变量算到 B 头上）', async () => {
    const { index } = await buildIndex(files());
    const table = index.dimReferences;
    expect(table).toBeDefined();
    expect([...table!.byName.keys()].sort()).toEqual(['BETA（系列）', 'KOJO_NAME']);
    // A.ERB 第 7 行的 `#DIM KOJO_NAME` 是函数体内局部声明 ⇒ 表里没有这一处定义
    // 声明分支**没有** `endColumn`（契约 `ErbDimDefinitionReference`：索引只有行，没有列事实）
    expect(dimReferencesOf(index, 'KOJO_NAME').filter((r) => r.kind === 'definition')).toEqual([
      { filePath: ERH, line: 2, column: 1, kind: 'definition' },
    ]);
  });

  it('全角标点名字整段匹配（函数记号尺会把 `BETA（系列）` 劈成两半，那样一条都收不到）', async () => {
    const { index } = await buildIndex(files());
    expect(at(dimReferencesOf(index, 'BETA（系列）'))).toEqual([
      `A:3:7`,
      `A:9:7`,
      'DIM:3:1', // 声明点：索引无列事实 ⇒ 列恒 1
    ]);
    // 反向恒真：劈开的半截 `BETA` 不是名字，不能凭空多出一条
    expect(dimReferencesOf(index, 'BETA')).toEqual([]);
  });

  it('提及流水按 文件序 → 行 → 列 确定排序，且遮蔽的两处都在（遮蔽是查询时的事）', async () => {
    const { index } = await buildIndex(files());
    expect(at(dimReferencesOf(index, 'KOJO_NAME'))).toEqual([
      'A:2:10',
      'A:8:10', // 局部遮蔽的那一处：表里照记，查询时剔
      'B:2:14',
      'DIM:2:1',
    ]);
  });
});

describe('大小写 · 形状门必须折大小写，否则假阴', () => {
  it('代码里写成小写也认得出（两条腿都要：形状键是两条腿共用的一道门）', async () => {
    // 声明保持大写，只把 A 的两处提及（第 2、8 行）改写成小写：列号不变（同在词首）
    const lowerA = [
      '@MAIN',
      '  PRINTL kojo_name',
      '  X = BETA（系列）',
      '  CALL SUB',
      '',
      '@SUB',
      '  #DIM KOJO_NAME',
      '  PRINTL kojo_name',
      '  Y = BETA（系列）',
      '  RETURN',
    ].join('\n');
    const lowerB = ['@OTHER', '  PRINTFORML kojo_name'].join('\n');
    const map = new Map([
      [A, { text: lowerA, mtimeMs: 100 }],
      [B, { text: lowerB, mtimeMs: 200 }],
      [ERH, { text: ERH_TEXT, mtimeMs: 300 }],
    ]);
    const { index } = await buildIndex(map);
    // 项目腿：B 那处小写必须进表（形状门按原样比就会把它整段否掉）
    expect(at(dimReferencesOf(index, 'KOJO_NAME'))).toEqual(['A:2:10', 'A:8:10', 'B:2:14', 'DIM:2:1']);
    // 本文件腿（`scanDimRefs`）用的是同一道门，同样要认
    expect(at(erbReferencesAt(index, lowerA, A, 7, 8))).toEqual(['A:2:10', 'A:7:8', 'A:8:10']);
  });

  it('全角小写同样折（`ｋｏｊｏ` 与 `ＫＯＪＯ` 是同一个名字）', async () => {
    const full = ['; 全局声明', '#DIMS ＫＯＪＯ', '@M', '  PRINTL ｋｏｊｏ'].join('\n');
    const { index } = await buildIndex(new Map([[ERH, { text: full, mtimeMs: 1 }]]));
    expect(at(dimReferencesOf(index, 'ＫＯＪＯ'))).toEqual(['DIM:2:1', 'DIM:4:10']);
  });
});

describe('查找引用 · 全局声明 ⇒ 项目级', () => {
  it('`.ERH` 的声明行上 Shift+F12：跨文件全部落点，遮蔽的那处被剔掉', async () => {
    const { index } = await buildIndex(files());
    // 光标落在 `#DIMS KOJO_NAME` 的名字上（第 7 列）
    expect(at(erbReferencesAt(index, ERH_TEXT, ERH, 2, 7))).toEqual(['A:2:10', 'B:2:14', 'DIM:2:1']);
  });

  it('声明点给行列但不给 span（索引没有列事实，编一个会让高亮落在 `#DI` 上）', async () => {
    const { index } = await buildIndex(files());
    const locations = erbReferencesAt(index, ERH_TEXT, ERH, 2, 7);
    const decl = locations.find((l) => l.filePath === ERH && l.line === 2)!;
    expect(decl.kind).toBe('definition');
    expect(decl.column).toBe(1);
    expect(decl.span).toBeUndefined();
    // 提及点反之：区间齐备（列 = 名字首字符）
    const mention = locations.find((l) => l.filePath === B)!;
    expect(mention.span).toEqual({ columnStart: 14, columnEnd: 14 + 'KOJO_NAME'.length });
    expect(mention.kind).toBe('mention');
  });

  it('全角名字同一条腿作答（`BETA（系列）` 在 `.ERH` 声明、两处 `.ERB` 使用）', async () => {
    const { index } = await buildIndex(files());
    expect(at(erbReferencesAt(index, ERH_TEXT, ERH, 3, 6))).toEqual(['A:3:7', 'A:9:7', 'DIM:3:1']);
  });
});

describe('查找引用 · 局部声明 ⇒ 只看本文件', () => {
  it('光标在 `@SUB` 里的局部声明上：只答本文件，不把别处同名全局变量算进来', async () => {
    const { index } = await buildIndex(files());
    // 光标落在 `  #DIM KOJO_NAME` 的名字上（第 8 列：两格缩进 + `#DIM `）
    const out = erbReferencesAt(index, A_TEXT, A, 7, 8);
    expect(at(out)).toEqual(['A:2:10', 'A:7:8', 'A:8:10']);
    expect(out.every((l) => l.filePath === A)).toBe(true);
  });

  it('没有索引时，全局声明也只答本文件（降级 = 加这一腿之前的行为）', async () => {
    const { index } = await buildIndex(files());
    const degraded = erbReferencesAt(null, ERH_TEXT, ERH, 2, 7);
    expect(at(degraded)).toEqual(['DIM:2:7']);
    // 有索引但 `dimReferences` 缺席（增量更新后待修复）同样降级，而不是给空答案
    const noDimTable = { ...index, dimReferences: undefined } as ErbIndex;
    expect(at(erbReferencesAt(noDimTable, ERH_TEXT, ERH, 2, 7))).toEqual(['DIM:2:7']);
  });
});

describe('供方接线 · `erb-references` 走同一条判据', () => {
  it('请求 `references` ⇒ 交回项目级落点（宿主只做形状翻译）', async () => {
    const { inst } = await buildIndex(files());
    const provider = inst.contributions.get('erb-references')!.provide;
    const res = provider({ kind: 'references', path: ERH, text: ERH_TEXT, line: 2, column: 7, project: null }) as {
      kind: string;
      locations: { filePath: string; line: number; column?: number }[];
    };
    expect(res.kind).toBe('references');
    expect(at(res.locations)).toEqual(['A:2:10', 'B:2:14', 'DIM:2:1']);
    // 非方言文件不归本包管
    expect(provider({ kind: 'references', path: `${ROOT}/x.txt`, text: '', line: 1, column: 1, project: null })).toBeUndefined();
  });
});
