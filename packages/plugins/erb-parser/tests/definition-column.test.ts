/**
 * W-DEF-COL · **「名字起点列」作为索引事实**（转到定义 / 跳到实现的列腿）。
 *
 * ## 这一批把什么从"推断"变成"事实"
 * `startLine` 只能把光标放到**行首**。作者跨文件 F12 落进行首就得再按一次方向键，
 * 而 `Ctrl+F12`（implementation）与定义腿共用同一个 `provideLocations` ⇒ 同一条腿的两面。
 * 根因不在宿主而在索引：**`ErbFunction` 里根本没有"列"这个事实**，任何一侧想给列都得现算，
 * 现算就是第二判据。故：列住在扫描器（`parseFunctionDefinition` 的同一道边界顺带产出偏移），
 * 落点区间住在 `erb-definition` 的映射里，夹取/退化仍单源于宿主的 `reveal-position`。
 *
 * ## 口径（本文件逐条钉住的）
 * - **1 基、UTF-16 码元**（Monaco 的列坐标系）；结束列 = `nameColumn + name.length`，**不含端点**
 *   ——与 `ErbReference.column` / `endColumn` 同一条（代理对名两个码元算两格，见用例）。
 * - **算不出就不给**：旧盘条目缺第 7 位 ⇒ 函数与定义 ref 都不带 `nameColumn` 键，
 *   定义腿退化成"只给行"（**绝不补 `column: 1`**——那是假事实）。
 *
 * ## 回退即红
 * 每条用例都对应一处改动，逐条按 `git checkout HEAD^ -- <文件>` 复跑过红态（见提交信息）。
 */
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex, ErbParserService, FileIO, GameProject, ScopedStorage } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { parseErbText, parseFunctionDefinition } from '../src/scanner';
import { encodeEntries, decodeEntries, aggregateIndex, snapshotKeyFor, SNAPSHOT_VERSION, type SnapshotEntry } from '../src/snapshot';
import { KIND_DEFINITION, forEachRef, scanFileRefs } from '../src/references';
import { makeComputeStub } from './support';

/** 名字区间（半开、1 基）——与 `erb-definition` 交给宿主的 `span` 同一条算式，本文件只读它一次 */
const spanOf = (nameColumn: number | undefined, name: string): { columnStart: number; columnEnd: number } | undefined =>
  nameColumn === undefined ? undefined : { columnStart: nameColumn, columnEnd: nameColumn + name.length };

/* ============================ 1. 扫描器：列是怎么算出来的 ============================ */

describe('erb-parser · 名字起点列（扫描器）', () => {
  it('前导制表符 / 空格 / 混排：列 = 前导宽度 + `@` + 1', () => {
    expect(parseErbText('\t@FOO\n', '/a.ERB').functions[0]!.nameColumn).toBe(3);
    expect(parseErbText('   @FOO\n', '/a.ERB').functions[0]!.nameColumn).toBe(5);
    expect(parseErbText('\t \t@FOO\n', '/a.ERB').functions[0]!.nameColumn).toBe(5);
    expect(parseErbText('@FOO\n', '/a.ERB').functions[0]!.nameColumn).toBe(2);
  });

  it('行首制表符占一格（UTF-16 码元），不是"一个制表位"', () => {
    // 缩进宽度按**码元数**计，与 Monaco 的列一致；此处 1 个 tab ⇒ 名字落在第 3 列
    const text = '\t@LONG_NAME(ARG)\n';
    const fn = parseErbText(text, '/a.ERB').functions[0]!;
    expect(fn.nameColumn).toBe(3);
    expect(spanOf(fn.nameColumn, fn.name)).toEqual({ columnStart: 3, columnEnd: 12 });
  });

  it('三种终止符边界的列与结束列：`@名字(` / `@名字 ：` / `@名字;`', () => {
    const cases: readonly [string, string][] = [
      ['@FOO(ARG)\n', 'FOO'],
      ['@FOO ：备注\n', 'FOO'], // 半角空格先断（`：` 不是终止符，但空白是）
      ['@FOO;注释\n', 'FOO'],
      ['@FOO, ARGS\n', 'FOO'], // 逗号形（真语料 130 处）
      ['@FOO\n', 'FOO'], // 行尾即止
      ['  @FOO\t(ARGS)\n', 'FOO'],
    ];
    for (const [text, name] of cases) {
      const fn = parseErbText(text, '/a.ERB').functions[0]!;
      expect(fn.name).toBe(name);
      const indent = text.length - text.trimStart().length;
      expect(fn.nameColumn).toBe(indent + 2);
      expect(spanOf(fn.nameColumn, fn.name)).toEqual({ columnStart: indent + 2, columnEnd: indent + 2 + name.length });
    }
  });

  it('`@` 与名字之间的前导空白计入列（真语料的全角空白形）', () => {
    const fn = parseErbText('@　FOO(ARGS)\n', '/a.ERB').functions[0]!; // `@` 后是全角空格
    expect(fn.name).toBe('FOO');
    expect(fn.nameColumn).toBe(3);
  });

  it('CJK 名按 UTF-16 码元计列；代理对占两格（与 Monaco 同口径）', () => {
    const cjk = parseErbText('  @無個性_機能\n', '/a.ERB').functions[0]!;
    expect(cjk.name).toBe('無個性_機能');
    expect(cjk.nameColumn).toBe(4); // 缩进 2 + `@` 1 ⇒ 名字首字符在第 4 列
    expect(spanOf(cjk.nameColumn, cjk.name)).toEqual({ columnStart: 4, columnEnd: 10 }); // 6 个码元，不含端点

    const astral = parseErbText('@𪚥FOO\n', '/a.ERB').functions[0]!;
    expect(astral.name).toBe('𪚥FOO');
    expect(astral.name.length).toBe(5); // 增平面字 = 2 个 UTF-16 码元（码点数是 4，**这里不采用**）
    expect([...astral.name].length).toBe(4);
    expect(astral.nameColumn).toBe(2);
    expect(spanOf(astral.nameColumn, astral.name)).toEqual({ columnStart: 2, columnEnd: 7 });
  });

  it('`nameOffset` 与整文件扫描的列**同一道边界**（不另立判据）', () => {
    // 列 = 前导空白宽度 + `parseFunctionDefinition` 报回来的名字偏移 + 1（1 基）。
    // 这条等式就是"没有第二份『什么算函数名』"的证据：偏移换了，这里必红。
    const lines = ['@FOO(ARG)\n', '  @FOO\t(ARGS)\n', '\t@BAR\n', '@Baz;尾注释\n', '@QUX, ARGS\n', '@　ZOZO\n'];
    for (const line of lines) {
      const trimmed = line.trim();
      const def = parseFunctionDefinition(trimmed)!;
      expect(def.nameOffset).toBeGreaterThan(0);
      const indent = line.length - line.trimStart().length;
      const scanned = parseErbText(line, '/a.ERB').functions[0]!;
      expect(scanned.nameColumn).toBe(indent + def.nameOffset + 1);
    }
  });

  it('同一趟里：定义腿的列与反向索引 definition 点的列逐字相同（两份生产者不许漂）', () => {
    const text = '@A\n\tCALL B\n\t\t@B(ARG)\n';
    const parsed = parseErbText(text, '/a.ERB');
    const refs = scanFileRefs(text, (upper) => parsed.functions.some((f) => f.normalizedName === upper));
    let checked = 0;
    forEachRef(refs, (name, _line, column, kind) => {
      if (kind !== KIND_DEFINITION) return;
      const fn = parsed.functions.find((f) => f.normalizedName === name)!;
      expect(fn.nameColumn).toBe(column);
      checked++;
    });
    // 判据不许在"一条都没遍历到"时也绿：两份定义（@A / @B）都必须在 refs 里出现
    expect(checked).toBe(2);
  });
});

/* ============================ 2. 快照：列落盘与旧盘缺位 ============================ */

describe('erb-parser · 名字列的快照面（函数元组第 7 位）', () => {
  const entryOf = (file: ErbFile, mtimeMs = 1000): SnapshotEntry => ({
    mtimeMs,
    size: file.lineCount * 7,
    textLength: file.lineCount * 7,
    file,
    refs: [],
    refsNamesFp: 1,
  });

  it('encode → decode 列逐位相同（"无注释块"要占住第 6 位才排得上第 7 位）', () => {
    const file = parseErbText('\t@FOO(ARG)\n;doc\n@BAR\n', '/a.ERB');
    const payload = JSON.parse(JSON.stringify(encodeEntries({ '/a.ERB': entryOf(file) }))) as Record<string, unknown[]>;
    const fns = payload['/a.ERB']![5] as unknown[][];
    // FOO 无注释块 ⇒ 第 6 位写 null 占位，列才落在第 7 位（可选位不许跳着排）
    expect(fns[0]).toEqual(['FOO', 1, 2, [['ARG', 0]], 0, null, 3]);
    expect(fns[1]).toEqual(['BAR', 3, 4, [], 0, 'doc', 2]); // 有注释块 + 有列
    const back = decodeEntries(payload)!['/a.ERB']!;
    expect(back.file.functions).toEqual(file.functions);
    expect(back.file.functions.map((f) => f.nameColumn)).toEqual([3, 2]);
    // 消费过再编码 = 同一份元组（列不会因为"还原→再编码"漂成 1）
    void back.file.functions;
    expect(encodeEntries({ '/a.ERB': back })['/a.ERB']![5]).toEqual(fns);
  });

  it('旧形态条目（函数元组只有 5/6 位）读回来 ⇒ 没有列这个事实，不抛、不补 1', () => {
    const v8Shape: Record<string, unknown[]> = {
      '/a.ERB': [1000, 20, 20, 2, 0, [['FOO', 1, 2, [], 0], ['BAR', 2, 2, [], 0, ';注']], [], [], [], null, null],
    };
    const decoded = decodeEntries(v8Shape);
    expect(decoded).not.toBeNull();
    const fns = decoded!['/a.ERB']!.file.functions;
    expect(fns.map((f) => f.name)).toEqual(['FOO', 'BAR']);
    for (const fn of fns) {
      expect('nameColumn' in fn).toBe(false); // **缺键**，不是 `undefined` 更不是 1
      expect(fn.nameColumn).toBeUndefined();
    }
    // 聚合出来的定义 ref 同样不带列（定义腿据此只交行）
    const { byName } = aggregateIndex([decoded!['/a.ERB']!.file]);
    const ref = byName.get('FOO')![0]!;
    expect('nameColumn' in ref).toBe(false);
    expect(ref.startLine).toBe(1);
    // 再编码一次仍是旧形态（不许把"不知道"写成"在第 1 列"）
    const reFns = encodeEntries(decoded!)['/a.ERB']![5] as unknown[][];
    expect(reFns[0]!.length).toBe(5);
  });

  it('坏列值（0 / 小数 / 字符串）⇒ 整条判过期（fail-closed，不"修"快照）', () => {
    for (const bad of [0, 1.5, '2', null]) {
      const payload: Record<string, unknown[]> = {
        '/a.ERB': [1000, 20, 20, 1, 0, [['FOO', 1, 1, [], 0, null, bad]], [], [], [], null, ''],
      };
      expect(decodeEntries(payload), `坏值 ${String(bad)}`).toBeNull();
    }
  });

  it('版本判据：当前键带当前版本号；表外旧版（v9）一条都不复用（不静默留缺列）', () => {
    expect(snapshotKeyFor('D:/p')).toContain(`v${SNAPSHOT_VERSION}`);
    // `snapshotKeyCandidatesFor` 只探表内版本：v10/v11/v12 都在表里（同形迁移），
    // v9 不在表 ⇒ 旧盘一条都不复用、一次冷重建。
    // **别用 `SNAPSHOT_VERSION - n` 表示"隔代"**：表里一旦多进一代，那个算式就指向了表内版本，
    // 用例会绿得没道理（见 `snapshot-salvage.test.ts` 顶部同名注）。
    const candidates = [snapshotKeyFor('D:/p'), snapshotKeyFor('D:/p', 9)];
    expect(candidates[1]).toContain('v9');
  });
});

/* ============================ 3. 端到端：erb-definition 交区间 ============================ */

const ROOT = 'D:/proj/eratw';
const KOJO = `${ROOT}/ERB`;
const A = `${KOJO}/a.ERB`;
const B = `${KOJO}/b.ERB`;
/** A 里的定义带缩进（第 3 列起），B 里两处 CALL 分别落在缩进名与普通名上 */
const TEXT_A = '\t@FOO(ARG)\n\tRETURN 1\n';
const TEXT_B = '@CALLER\n\tCALL FOO(1)\n';

interface Harness {
  service: ErbParserService;
  provide(id: string): (request: unknown) => { kind: string; locations: Record<string, unknown>[] } | undefined;
  logs: string[];
  waitIndexed: () => Promise<void>;
  index: () => ErbIndex | null;
}

function makeDisk(files: Record<string, string>, seed: (key: string) => string | undefined) {
  const io = {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1000 };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = files[path];
        return text === undefined ? null : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1000 };
      });
    },
    async stat(path: string) {
      const text = files[path];
      return text === undefined ? null : { size: text.length, mtimeMs: 1000, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop()!, path: p, isDirectory: false, mtimeMs: 1000, size: files[p]!.length }));
    },
  } as unknown as FileIO;
  const map = new Map<string, string>();
  const storage: ScopedStorage = {
    get: async (key: string) => {
      if (map.has(key)) return JSON.parse(map.get(key)!) as never;
      const seeded = seed(key);
      if (seeded === undefined) return undefined;
      map.set(key, seeded);
      return JSON.parse(seeded) as never;
    },
    set: async (key: string, value: unknown) => {
      map.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  };
  return { io, storage, map };
}

function activate(files: Record<string, string>, seedKey: (key: string) => string | undefined = () => undefined): Harness {
  const { io, storage, map } = makeDisk(files, seedKey);
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const contributions = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Set<(p: never) => void>>();
  const bus = {
    on(type: string, h: (p: never) => void) {
      const s = handlers.get(type) ?? new Set<(p: never) => void>();
      s.add(h);
      handlers.set(type, s);
      return () => s.delete(h);
    },
    emit(type: string, payload: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload as never);
    },
  };
  createErbParserPlugin().activate({
    pluginId: 'erb-parser',
    log: { debug() {}, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    bus,
    storage,
    inject: (key: string) => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.compute') return makeComputeStub();
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        if (kind === 'ui.editor.languageService') contributions.set(contribution.id as string, contribution);
        return () => undefined;
      },
      query: () => [],
    },
    onDispose: () => undefined,
    provide: (key: string, value: unknown) => provided.set(key, value),
  } as never);
  const service = provided.get('erb.parser') as ErbParserService;
  bus.emit('project.opened', {
    project: { rootDir: ROOT, adapterId: 'eratw', kojoPaths: [KOJO], writablePaths: [], charaIndex: new Map() } as GameProject,
  });
  const waitIndexed = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting kojo.functionChanged')), 8000);
      const un = bus.on('kojo.functionChanged', () => {
        clearTimeout(t);
        un();
        resolve();
      });
    });
  return {
    service,
    logs,
    index: () => service.currentIndex(),
    provide: (id: string) => (contributions.get(id) as { provide(request: unknown): never }).provide.bind(contributions.get(id)),
    waitIndexed,
  };
}

/** `CALL FOO` 那一处的请求体（B 文件第 2 行第 8 列 = 名字 `FOO` 上） */
const CALL_REQUEST = { kind: 'definition', path: B, text: TEXT_B, line: 2, column: 8, project: null };

describe('erb-parser · erb-definition 装配（列腿端到端）', () => {
  it('端到端：定义腿交 span（缩进过的名字 ⇒ 第 3 列起，不含端点）', async () => {
    const h = activate({ [A]: TEXT_A, [B]: TEXT_B });
    await h.waitIndexed();
    expect(h.provide('erb-definition')(CALL_REQUEST)).toEqual({
      kind: 'definition',
      locations: [{ filePath: A, line: 1, column: 3, span: { columnStart: 3, columnEnd: 6 } }],
    });
  });

  it('索引里的列 = 快照里的列 = 槽交出去的区间（三处一个数）', async () => {
    const h = activate({ [A]: TEXT_A, [B]: TEXT_B });
    await h.waitIndexed();
    const idx = h.index()!;
    const fn = idx.files.get(A)!.functions[0]!;
    const ref = idx.byName.get('FOO')![0]!;
    expect(fn.nameColumn).toBe(ref.nameColumn);
    // 前置：冷重建出来的条目必须带列（缺位只可能来自旧盘，那两条见下面的用例）
    if (typeof ref.nameColumn !== 'number') throw new Error('新盘条目缺列：本用例的前置不成立');
    const column = ref.nameColumn;
    const loc = h.provide('erb-definition')(CALL_REQUEST)!.locations[0]!;
    expect(loc).toMatchObject({ column, span: { columnStart: column, columnEnd: column + ref.name.length } });
  });

  it('旧盘（函数元组缺第 7 位）复用回来 ⇒ 定义腿只给行不给列，不抛', async () => {
    // 当前键、当前版本号，但条目是"没有列这个事实"的形态（等价于旧一代盘上数据被认可续用的情形）
    const legacyEntry: unknown[] = [
      1000, TEXT_A.length, TEXT_A.length, 2, 0,
      [['FOO', 1, 2, [['ARG', 0]], 0]], // 5 位 = v8 形态：无注释块、无列
      [],
      ['FOO', 1, 3, 0], // v13 的扁平流水（步长 REF_STRIDE）
      [],
      null,
      null, // 候选未知（v10 迁移态）：refs 溯源与候选都判可疑 ⇒ refs 重扫，结构照常复用
    ];
    const payload = JSON.stringify({ version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries: { [A]: legacyEntry } });
    const h = activate({ [A]: TEXT_A, [B]: TEXT_B }, (key) => (key === snapshotKeyFor(ROOT) ? payload : undefined));
    let res: unknown;
    await h.waitIndexed();
    expect(() => {
      res = h.provide('erb-definition')(CALL_REQUEST);
    }).not.toThrow();
    expect(res).toEqual({ kind: 'definition', locations: [{ filePath: A, line: 1 }] });
    expect('column' in (res as { locations: Record<string, unknown>[] }).locations[0]!).toBe(false);
    expect('span' in (res as { locations: Record<string, unknown>[] }).locations[0]!).toBe(false);
  });

  it('隔代快照（v9 键 + v9 版本号）不进候选 ⇒ 整份弃用、冷重建出**真**列，不写假列', async () => {
    const staleEntry: unknown[] = [1000, TEXT_A.length, TEXT_A.length, 2, 0, [['FOO', 1, 2, [], 0]], [], [], [], null];
    // 版本号写死 9（表外最年轻的一代）；用 `SNAPSHOT_VERSION - 2` 会在每次 bump 后指向表内版本
    const payload = JSON.stringify({ version: 9, rootDir: ROOT, savedAt: 1, entries: { [A]: staleEntry } });
    const h = activate({ [A]: TEXT_A, [B]: TEXT_B }, (key) => (key === snapshotKeyFor(ROOT, 9) ? payload : undefined));
    await h.waitIndexed();
    // 重建出来的索引带真列（而不是沿用缺位条目 = 静默保留本批要修的症状）
    expect(h.index()!.byName.get('FOO')![0]!.nameColumn).toBe(3);
    expect(h.provide('erb-definition')(CALL_REQUEST)!.locations[0]).toMatchObject({
      column: 3,
      span: { columnStart: 3, columnEnd: 6 },
    });
    // 旧键不在候选列里 ⇒ 从没被读起来当回事（logs 里不该有"复用了 v9"的 salvage 读数）
    expect(h.logs.filter((l) => /salvage/.test(l)).join('\n')).not.toContain('v9');
  });
});
