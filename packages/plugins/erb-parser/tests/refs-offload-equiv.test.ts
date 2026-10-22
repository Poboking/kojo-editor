/**
 * REFS-WORKER（2026-10-21）—— 引用段搬进并行通道之后的**逐条目等价**对拍。
 *
 * 本批的判据只有一条：**搬运输层，不搬判据**。`scanFileRefs` 一个字没改，改的是
 * "名字是不是项目里的某个函数"这条谓词怎么跨线程递（闭包 `byName.has` → 名录数据 +
 * worker 侧建 Set）。所以本文件钉的全是"新旧路径逐字同产出"，而不是"扫得像不像"：
 *
 * 1. **纯函数面**：对抗性随机文本（固定种子、CJK / 全角 / 代理对 / 落单代理项 /
 *    落单引号 / 串内名字 / `[SKIPSTART]` / `#` `$` `@` 行 / CALL 族 / 半全角冒号成员访问）
 *    上 `scanRefsBatch` ≡ 逐文件 `scanFileRefs(text, u => names.has(u))`，
 *    **含缓存命中轮与未命中轮各一遍**（名录 Set 建没建过，产出不许有一个字符的差别）；
 * 2. **名录自证**：`namesJoined` 拆出的条数与 `namesCount` 不符 ⇒ 显式抛错
 *    （残缺名录绝不拿去扫）；
 * 3. **插件接线面**：≥ 门槛的块确实走 `compute.offload('erb.scanRefs', …)`，
 *    而 `index.references.bySymbol` 与"老路径（主线程直接扫）"独立重建的结果**逐条目全等**；
 * 4. **门槛以下零回退**：小块留在主线程内联 ⇒ 零 offload 调用、产出同样全等
 *    （热轮"改一棵"那一支的墙钟判据）；
 * 5. **回退＝老路径**：offload 抛错 ⇒ 该块内联重扫、出一声 warn、产出与全内联逐条目全等；
 * 6. **读盘失败只 warn 跳过**的口径在两条路径下同形（null 位不进 `refsByPath`，
 *    其余文件逐条目不受影响）。
 *
 * 语料级（2,316 份真文件）的同一把尺子在 `tools` 取证轮里量过（交付读数），
 * 真壳 A/B 见 `node tools/boot-watermarks.mjs`；本文件只负责**默认门里跑得动**的等价面。
 */
import { describe, expect, it } from 'vitest';
import type {
  ComputePool,
  ErbFile,
  ErbParserService,
  ErbReference,
  ErbReferenceIndex,
  FileIO,
  PluginContext,
} from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { SCAN_REFS_TASK, scanRefsBatch, scanRefsNamesOf, refsNameCacheState, type ScanRefsFileResult, type ScanRefsPayload } from '../src/offload';
import { buildReferenceIndex, erbReferenceLocationsAt, scanFileRefs, type FileRefs } from '../src/references';
import { nameSetDigest } from '../src/snapshot';
import { parseErbText } from '../src/scanner';
import { makeComputeStub } from './support';

/* ============================== 对抗性随机文本（固定种子；本文件自带一份生成器） ============================== */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x4294967296;
  };
}

const PIECES = [
  'CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST', 'call', 'tryCall',
  'SIF', 'PRINTFORML', 'PRINT', 'JUMP', 'GOTO', 'CALLFORM', 'IF', 'ENDIF',
  'ALPHA', 'alpha', 'ＢＥＴＡ', 'ｂｅｔａ', '無個性', '＿Ａ', '123', '_x9', 'A.B', 'A,B',
  'ALPHA:FLAG', 'FLAG:ALPHA', 'CFLAG:alpha', '：ALPHA', 'ALPHA：',
  '"', '"ALPHA in string"', '";COMMENT"', '; 尾注', ';ALPHA', '"落单', '"串尾;',
  '(', ')', '[', ']', '.', '@ALPHA', '@ alpha_x ', '@ＦＵＮ_１', '@A,B(C=1)',
  '#DIM ALPHA[3]', '#FUNCTION', '$ALPHA', '$ 标签', '[SKIPSTART]', '[SKIPEND]',
  '\t', ' ', '　', '\r', ',', ':', '：', '𝐀', '𝐚', '\uD835', '\uDC00', '\uD800', '😀', 'αβ',
  'M_KOJO_無個性_関数', 'x\uD835y', 'a😀b', '𝐀:FLAG', 'FLAG:𝐀', 'ＣＦＬＡＧ', 'ｃｆｌａｇ', '',
] as const;

function randomText(r: () => number): string {
  const nLines = 1 + Math.floor(r() * 14);
  const lines: string[] = [];
  for (let i = 0; i < nLines; i++) {
    const nPieces = Math.floor(r() * 10);
    let s = '';
    for (let k = 0; k < nPieces; k++) s += PIECES[Math.floor(r() * PIECES.length)]!;
    lines.push(s);
  }
  return lines.join(r() < 0.3 ? '\r\n' : '\n');
}

const DICT = [
  'ALPHA',
  'ＢＥＴＡ',
  '無個性',
  '_Ａ',
  'A.B',
  'FLAG',
  'CFLAG',
  'Ｍ_ＫＯＪＯ_無個性_関数',
  'ＦＵＮ_１',
  '𝐀',
  '😀',
];

/** 逐条目序列化（对拍用：元组形态原样进 JSON，不做任何归一） */
const encode = (refs: readonly ScanRefsFileResult[]): string => JSON.stringify(refs);

/**
 * 对照面（REFS-PROVENANCE 起 scanRefsBatch 交回 {refs, candidates} 对）：
 * refs 用老谓词直扫，候选集用同一个 `scanFileRefs` 的收集位收——
 * 这正是"收集是 additive、refs 判据一字未动"的两面。
 */
const expectOf = (text: string, names: ReadonlySet<string>): ScanRefsFileResult => {
  const candidates = new Set<string>();
  const refs = scanFileRefs(text, (u) => names.has(u), (u) => {
    candidates.add(u);
  });
  return { refs, candidates: [...candidates].join('\n') };
};

function payloadOf(names: readonly string[], texts: string[]): ScanRefsPayload {
  const part = scanRefsNamesOf(nameSetDigest(names), names);
  return { ...part, texts };
}

describe('scanRefsBatch · 与主线程内联路径逐条目全等', () => {
  it('600 份对抗性随机文本 × 3 组名录：冷缓存轮与热缓存轮都等于直接扫', () => {
    const r = rng(20261021);
    const texts = Array.from({ length: 600 }, () => randomText(r));
    const dicts: readonly string[][] = [DICT, DICT.slice(0, 3), []];
    for (const names of dicts) {
      const set = new Set(names);
      const want = texts.map((t) => expectOf(t, set));
      const payload = payloadOf(names, texts);
      // 冷轮：指纹是新的 ⇒ worker 侧走"建 Set"那一条
      const cold = scanRefsBatch({ ...payload, namesFp: nameSetDigest(names) + 1_000_003 });
      // 热轮：同指纹再来一遍 ⇒ 命中缓存
      const warm = scanRefsBatch(payload);
      const again = scanRefsBatch(payload);
      expect(encode(cold)).toBe(encode(want));
      expect(encode(warm)).toBe(encode(want));
      expect(encode(again)).toBe(encode(want));
    }
  });

  it('名录缓存按指纹换 Set：fp 变了必须重建，产出随新名录走', () => {
    const text = 'CALL ALPHA\nCALL BETA\n';
    const first = scanRefsBatch(payloadOf(['ALPHA'], [text]));
    expect(refsNameCacheState()?.fp).toBe(nameSetDigest(['ALPHA']));
    const second = scanRefsBatch(payloadOf(['BETA'], [text]));
    expect(refsNameCacheState()?.fp).toBe(nameSetDigest(['BETA']));
    expect(encode(first)).toBe(encode([expectOf(text, new Set(['ALPHA']))]));
    expect(encode(second)).toBe(encode([expectOf(text, new Set(['BETA']))]));
    // 候选集与命中无关（收集发生在判定前）：换名录不换候选
    expect(first[0]!.candidates).toBe('CALL\nALPHA\nBETA');
    expect(second[0]!.candidates).toBe('CALL\nALPHA\nBETA');
    // 再回第一枚名录：缓存只留最新一份，回退重建后产出仍与首轮逐字相同
    expect(encode(scanRefsBatch(payloadOf(['ALPHA'], [text])))).toBe(encode(first));
  });

  it('名录条数自证：拆出的条数不符就显式抛错（残缺名录绝不拿去扫）', () => {
    // 用一份**别处没缓存过**的名录（缓存按指纹命中，命中就不再看条数 ⇒ 冷路径才是自证生效的那一条）
    const names = ['ALPHA', 'BETA', 'DELTA'];
    const poisoned = { ...payloadOf(names, ['CALL ALPHA\n']), namesJoined: 'ALPHA\nBETA\nDELTA\nGAMMA' };
    expect(() => scanRefsBatch(poisoned)).toThrow(/name set unusable/);
    // 反恒真：同一份 texts 在合规名录下是能扫出东西的（抛的是自证失败，不是"空结果"）
    expect(encode(scanRefsBatch(payloadOf(['ALPHA'], ['CALL ALPHA\n'])))).toBe(
      encode([{ refs: [['ALPHA', 1, 6, 1]] as unknown as FileRefs, candidates: 'CALL\nALPHA' }]),
    );
  });
});

/* ============================== 插件接线面（伪 io + 计算池替身） ============================== */

/** 造 N 份口上文件：每份一个定义 + 一处跨文件 CALL（保证反向边真的存在） */
function fixtureFiles(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const next = `F${(i + 1) % count}`;
    out[`/root/f${String(i).padStart(3, '0')}.ERB`] =
      `@F${i}\nPRINTL 口上行 ${i}\nCALL ${next}\n; CALL F0 注释里的不算引用\n`;
  }
  return out;
}

interface IoOpts {
  /** 第几次 `readTexts` 起，这些路径返回 null 位（＝"重读失败"那一条口径） */
  failFromCall?: number;
  failPaths?: readonly string[];
}

function fakeIo(files: Record<string, string>, opts: IoOpts = {}): { io: FileIO; readCalls: () => number } {
  let calls = 0;
  const readTexts = async (paths: readonly string[]) => {
    calls++;
    return paths.map((path) => {
      const text = files[path];
      if (text === undefined) return null;
      if (opts.failFromCall !== undefined && calls >= opts.failFromCall && opts.failPaths?.includes(path)) return null;
      return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
    });
  };
  const io = {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
    },
    readTexts,
    async stat(path: string) {
      const text = files[path];
      return text === undefined ? null : { size: text.length, mtimeMs: 1_700_000_000_000, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(root))
        .sort()
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
  return { io, readCalls: () => calls };
}

/** 计算池替身 + offload 观察（`kind` 与载荷都记下来；本地实现＝worker 侧那一份同一函数） */
function spyCompute(opts: { rejectRefs?: boolean } = {}): {
  compute: ComputePool;
  kinds: string[];
  refPayloads: ScanRefsPayload[];
} {
  const base = makeComputeStub();
  const kinds: string[] = [];
  const refPayloads: ScanRefsPayload[] = [];
  const compute = {
    ...base,
    async offload<R = unknown>(kind: string, payload: unknown): Promise<R> {
      kinds.push(kind);
      if (kind === SCAN_REFS_TASK) {
        const p = payload as ScanRefsPayload;
        refPayloads.push(p);
        if (opts.rejectRefs) throw new Error('refs transport down (test)');
      }
      return base.offload<R>(kind, payload);
    },
  } as unknown as ComputePool;
  return { compute, kinds, refPayloads };
}

function activate(io: FileIO, compute: ComputePool): { services: Map<string, unknown>; logs: string[] } {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m), error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.compute') return compute as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: (() => {
      const map = new Map<string, string>();
      return {
        get: async (key: string) => (map.has(key) ? (JSON.parse(map.get(key)!) as unknown) : undefined),
        set: async (key: string, value: unknown) => {
          map.set(key, JSON.stringify(value));
        },
        delete: async (key: string) => {
          map.delete(key);
        },
        keys: async () => [...map.keys()],
      };
    })(),
    slots: { register: () => noop, query: () => [] },
    onDispose: noop,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, logs };
}

/** 反向索引的可比形态（键序 = 聚合序；条目逐个字段序列化，不做排序"宽容"） */
function encodeRefs(refs: ErbReferenceIndex | undefined): string {
  const bySymbol = refs?.bySymbol ?? new Map<string, readonly ErbReference[]>();
  return JSON.stringify(
    [...bySymbol.entries()].map(([name, list]) => [name, list.map((r) => [r.filePath, r.line, r.column, r.endColumn, r.kind])]),
  );
}

/**
 * 老路径（改前那段代码的等价复现）：同一个索引、同一个 `byName` 谓词，
 * 逐文件在主线程直接 `scanFileRefs`，再按同一顺序聚合。
 * 它是本文件所有"全等"判据的对照面——**不是**按预期手搓的结果。
 */
function legacyReferences(
  files: ReadonlyMap<string, ErbFile>,
  texts: ReadonlyMap<string, string>,
  hasName: (upper: string) => boolean,
): string {
  const refsByPath = new Map<string, FileRefs>();
  for (const path of files.keys()) {
    const text = texts.get(path);
    if (text === undefined) continue; // 与"重读失败只 warn 跳过"同口径：该文件不进表
    refsByPath.set(path, scanFileRefs(text, hasName));
  }
  return encodeRefs(buildReferenceIndex(files.values(), refsByPath));
}

describe('erb-parser 引用段 · 进并行通道的新旧路径对拍', () => {
  it('批量（≥ 门槛）走 offload，且 bySymbol 与老路径逐条目全等', async () => {
    const files = fixtureFiles(20);
    const { io } = fakeIo(files);
    const { compute, kinds, refPayloads } = spyCompute();
    const { services, logs } = activate(io, compute);
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/root']);

    // 判据①：确实走通道（kind 逐字对），且载荷是"名录 + 整块正文"而不是逐文件一条
    expect(kinds).toContain(SCAN_REFS_TASK);
    expect(refPayloads.length).toBe(1);
    expect(refPayloads[0]!.texts.length).toBe(20);
    expect(refPayloads[0]!.namesCount).toBe(index.byName.size);
    expect(refPayloads[0]!.namesFp).toBe(nameSetDigest(index.byName.keys()));

    // 判据②：产出与老路径逐条目全等（键序 + 每条五元组）
    const texts = new Map(Object.entries(files));
    const want = legacyReferences(index.files, texts, (u) => index.byName.has(u));
    expect(encodeRefs(index.references)).toBe(want);
    // 反恒真：索引里真的有跨文件引用（否则"全等"是同归于空）
    let sites = 0;
    for (const list of index.references!.bySymbol.values()) sites += list.length;
    expect(sites).toBe(40); // 20 定义 + 20 调用（注释里那条不算）
    expect(logs.some((m) => m.includes('index refs: 1 chunk(s) offloaded / 0 inline / 0 fallback'))).toBe(true);
  });

  it('不足门槛的小块留在主线程内联：零 offload 调用、产出与老路径逐条目全等', async () => {
    const files = fixtureFiles(15);
    const { io } = fakeIo(files);
    const { compute, kinds } = spyCompute();
    const { services, logs } = activate(io, compute);
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/root']);
    expect(kinds.filter((k) => k === SCAN_REFS_TASK)).toEqual([]);
    expect(encodeRefs(index.references)).toBe(
      legacyReferences(index.files, new Map(Object.entries(files)), (u) => index.byName.has(u)),
    );
    expect(logs.some((m) => m.includes('index refs: 0 chunk(s) offloaded / 1 inline / 0 fallback'))).toBe(true);
  });

  it('offload 抛错 ⇒ 该块内联重扫 + 出声；产出与全内联逐条目全等（回退＝老路径）', async () => {
    const files = fixtureFiles(20);
    const { io } = fakeIo(files);
    const { compute } = spyCompute({ rejectRefs: true });
    const { services, logs } = activate(io, compute);
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/root']);
    expect(encodeRefs(index.references)).toBe(
      legacyReferences(index.files, new Map(Object.entries(files)), (u) => index.byName.has(u)),
    );
    expect(logs.filter((m) => m.includes('Refs offload failed')).length).toBe(1);
    expect(logs.some((m) => m.includes('/ 1 fallback'))).toBe(true);
  });

  it('重读失败位只 warn 跳过（两条路径同口径）：失败文件不进表，其余逐条目不变', async () => {
    const files = fixtureFiles(20);
    const victim = '/root/f007.ERB';
    const allTexts = new Map(Object.entries(files));
    // 老路径的既有口径就是"重读失败 ⇒ 该文件不进 refsByPath"（只 warn 不猜），
    // 所以对照面同样把这一棵摘掉；这一条不是自我实现：下面两枚反恒真各钉一头。
    const texts = new Map(allTexts);
    texts.delete(victim);
    // 第 2 趟起（＝引用段那一趟）让 victim 返回 null
    const big = fakeIo(files, { failFromCall: 2, failPaths: [victim] });
    const bigRun = activate(big.io, spyCompute().compute);
    const bigIndex = await (bigRun.services.get('erb.parser') as ErbParserService).buildIndex(['/root']);
    expect(bigRun.logs.filter((m) => m.includes(`Refs scan skipped (reread failed): ${victim}`)).length).toBe(1);
    expect(encodeRefs(bigIndex.references)).toBe(
      legacyReferences(bigIndex.files, texts, (u) => bigIndex.byName.has(u)),
    );
    // 反恒真①：对照面若把 victim 也算进去就一定不等（＝"摘掉"这一步真的在判据上）
    expect(legacyReferences(bigIndex.files, allTexts, (u) => bigIndex.byName.has(u))).not.toBe(
      encodeRefs(bigIndex.references),
    );
    // 该文件的引用确实一条没有（不是"全等于一份也少了它的对照"这种空断言 ⇒ 单独点名的话）
    const stillThere = bigIndex.references!.bySymbol.get('F7');
    expect(stillThere?.some((r) => r.filePath === victim) ?? false).toBe(false);
    expect(stillThere!.length).toBe(1); // 只剩 f006 那一处 CALL F7
    // 反恒真②：这一轮走的确实是**通道**那一支（不是被门槛顺手关回内联）
    expect(bigRun.logs.some((m) => m.includes('index refs: 1 chunk(s) offloaded'))).toBe(true);

    // 小批（内联）路径同一判据
    const smallFiles = fixtureFiles(10);
    const smallVictim = '/root/f003.ERB';
    const smallTexts = new Map(Object.entries(smallFiles));
    const smallExpected = new Map(smallTexts);
    smallExpected.delete(smallVictim);
    const small = fakeIo(smallFiles, { failFromCall: 2, failPaths: [smallVictim] });
    const smallRun = activate(small.io, spyCompute().compute);
    const smallIndex = await (smallRun.services.get('erb.parser') as ErbParserService).buildIndex(['/root']);
    expect(smallRun.logs.filter((m) => m.includes(`Refs scan skipped (reread failed): ${smallVictim}`)).length).toBe(1);
    expect(encodeRefs(smallIndex.references)).toBe(
      legacyReferences(smallIndex.files, smallExpected, (u) => smallIndex.byName.has(u)),
    );
    expect(legacyReferences(smallIndex.files, smallTexts, (u) => smallIndex.byName.has(u))).not.toBe(
      encodeRefs(smallIndex.references),
    );
    expect(smallRun.logs.some((m) => m.includes('index refs: 0 chunk(s) offloaded / 1 inline'))).toBe(true);
  }, 30_000);

  it('载荷里的名录与索引 `byName` 同源：换个名录指纹就换一套产出（不是常量替身）', async () => {    // 同一批文件跑两轮，第二轮多出一枚函数名 ⇒ 第一轮的 CALL 才在第二轮进表
    const base = fixtureFiles(20);
    const first = activate(fakeIo(base).io, makeComputeStub());
    const indexA = await (first.services.get('erb.parser') as ErbParserService).buildIndex(['/root']);
    const withExtra = { ...base, '/root/z.ERB': '@F20\nCALL F0\n' };
    const second = activate(fakeIo(withExtra).io, makeComputeStub());
    const indexB = await (second.services.get('erb.parser') as ErbParserService).buildIndex(['/root']);
    expect(indexB.byName.size).toBe(indexA.byName.size + 1);
    expect(indexA.references!.bySymbol.get('F20')?.length ?? 0).toBe(0);
    expect(indexB.references!.bySymbol.get('F20')!.length).toBe(1);
    expect(indexB.references!.bySymbol.get('F20')![0]!.filePath).toBe('/root/z.ERB');
    // 老路径对照（同一份名录谓词）仍逐条目全等
    expect(encodeRefs(indexB.references)).toBe(
      legacyReferences(indexB.files, new Map(Object.entries(withExtra)), (u) => indexB.byName.has(u)),
    );
    // parseErbText 的形态自证：本文件用到的 fixture 确实按预期解析（防"全等于一份同样错的"）
    expect(parseErbText(withExtra['/root/z.ERB']!, '/root/z.ERB').functions.map((f) => f.normalizedName)).toEqual(['F20']);
  }, 30_000);
});

describe('查找引用 / 重命名取数面 · 通道产出直接喂下游同结果', () => {
  it('referencesTo 与光标处引用点（erbReferenceLocationsAt）在两条路径下逐条全等', async () => {
    const files = fixtureFiles(20);
    const off = activate(fakeIo(files).io, spyCompute().compute);
    const offIndex = await (off.services.get('erb.parser') as ErbParserService).buildIndex(['/root']);
    expect(off.services.get('erb.parser') !== undefined).toBe(true);

    // 老路径重建同一份反向索引（逐文件内联扫 + 同序聚合），作为下游取数的对照面
    const refsByPath = new Map<string, FileRefs>();
    for (const [path, text] of Object.entries(files)) refsByPath.set(path, scanFileRefs(text, (u) => offIndex.byName.has(u)));
    const legacyIndex = buildReferenceIndex(offIndex.files.values(), refsByPath);

    const parser = off.services.get('erb.parser') as ErbParserService;
    const names = [...offIndex.byName.keys()];
    expect(names.length).toBe(20);
    for (const name of names) {
      // ① 服务出口（find-references / rename / 台账都只走这一条）
      expect(JSON.stringify(parser.referencesTo!(name))).toBe(JSON.stringify(legacyIndex.bySymbol.get(name) ?? []));
      // ② 光标处引用点（F12 / 查找引用同一条腿）
      for (const ref of legacyIndex.bySymbol.get(name) ?? []) {
        const text = files[ref.filePath]!;
        const viaOff = erbReferenceLocationsAt(offIndex, text, ref.line, ref.column);
        const legacyAt = {
          files: offIndex.files,
          byName: offIndex.byName,
          references: legacyIndex,
          fingerprint: offIndex.fingerprint,
          fileMtimes: offIndex.fileMtimes,
          fileSizes: offIndex.fileSizes,
        } as unknown as typeof offIndex;
        expect(JSON.stringify(viaOff)).toBe(JSON.stringify(erbReferenceLocationsAt(legacyAt, text, ref.line, ref.column)));
      }
    }
    // 反恒真：至少有一处光标查询真的返回了多条（否则"逐条全等"是同归于空）
    const multi = names.filter((n) => (legacyIndex.bySymbol.get(n)?.length ?? 0) >= 2);
    expect(multi.length).toBe(20);
  }, 60_000);
});
