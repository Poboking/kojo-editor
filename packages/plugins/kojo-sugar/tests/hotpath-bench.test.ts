/**
 * PERF-5 微基准 + 等价性（纯函数，vitest 里做）：`resolveFamily` 索引化 + `makeLookup`
 * 重建成本。读数直接打在测试输出里（回执引用同一组数字）。
 *
 * 三个量：
 * 1. **`resolveFamily` 单次调**：before = 复刻改前的 20 族线性扫（本文件内 `scalarResolve`
 *    = 逐字镜像）；after = `makeLookup` 的名称索引 + 回退记忆。语料形状的合成 schema
 *    （20 族 × 300 名 + 别名/追加/共用名边界行）。
 * 2. **`makeLookup` + `createSugarTranspileService` 每调重建** 的账单（memo 消除的部分）：
 *    实测 ns/op；另有惰性索引的一次性建表成本（随代际 memo 只付一次，门槛门控见
 *    `INDEX_BUILD_AFTER_SCANS`）。
 * 3. **等价性**（硬断言，不是基准）：索引实现 vs 线性扫在全部枚举名 / byName 独有别别名 /
 *    纯数字名 / 未知名 / 追加层 / 跨族同名上逐位一致。
 *
 * 时间断言刻意放很松（只证量级方向，不绑机器）；计数断言是确定性的。
 */

import { describe, expect, it } from 'vitest';
import type { VariableInfo, VariableSchema, SugarSourceMapEntry, SugarTranspileResult } from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES, makeLookup } from '../src/index';
import { createSugarTranspileService } from '../src/service';
import { CONT_MARKS, blockEndWord, primaryWord } from '../src/keywords';
import { classifyLine, splitLogicalLines, stripCont } from '../src/lexer';
import type { DiagnosticSink } from '../src/types';
import { foldGeneratedLine } from '../src/langsvc';
import { stubFaceTable } from './support';

/* ============================== 合成 schema（复刻 adapter 的合并语义） ============================== */

type Tier = 'primary' | 'append';

interface FakeTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
  indexSource: Map<string, Tier>;
  nameSource: Map<string, Tier>;
}

/** 行 = （族, 编号, 名, 层）；合并语义逐字复刻 `eratw-adapter/variable-schema.ts` 的"首个定义优先" */
type Row = readonly [family: string, idx: string, name: string, tier?: Tier];

function makeBenchSchema(rows: readonly Row[]): { schema: VariableSchema; namesCalls: () => number } {
  const tables = new Map<string, FakeTable>();
  const tableOf = (family: string): FakeTable => {
    let t = tables.get(family);
    if (!t) {
      t = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
      tables.set(family, t);
    }
    return t;
  };
  for (const [family, idx, name, tier = 'primary'] of rows) {
    const t = tableOf(family);
    if (!t.byIndex.has(idx)) {
      t.byIndex.set(idx, name);
      t.indexSource.set(idx, tier);
    }
    if (!t.byName.has(name)) {
      t.byName.set(name, idx);
      t.nameSource.set(name, tier);
    }
  }
  let namesCalls = 0;
  const schema: VariableSchema = {
    version: 'bench',
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const t = tables.get(key);
      if (!t) return undefined;
      if (index === undefined) return { name: key, description: '合成标签' };
      const idxStr = String(index);
      const byIdx = t.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        const info: VariableInfo = {
          name: key,
          index,
          description: byIdx,
          source: t.indexSource.get(idxStr) ?? 'primary',
        };
        const n = Number(idxStr);
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      if (t.byName.has(idxStr)) {
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          source: t.nameSource.get(idxStr) ?? 'primary',
        };
        const n = Number(t.byName.get(idxStr));
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      return { name: key, index };
    },
    names(family: string): readonly VariableInfo[] {
      namesCalls++;
      const t = tables.get(family.toUpperCase());
      if (!t) return [];
      const out: VariableInfo[] = [];
      for (const [idxStr, name] of t.byIndex) {
        const n = Number(idxStr);
        const info: VariableInfo = {
          name,
          index: Number.isNaN(n) ? idxStr : n,
          source: t.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        out.push(info);
      }
      return out;
    },
  };
  return { schema, namesCalls: () => namesCalls };
}

/** 20 族 × 300 名 + 边界行（跨族同名 / 追加层 / byName 独有别名 / 纯数字名 / 编号键） */
const PER_FAMILY = 300;
const ROWS: Row[] = [
  ...ENGINE_VARIABLE_FAMILIES.flatMap((family) =>
    Array.from({ length: PER_FAMILY }, (_, i): Row => [family, String(1000 + i), `${family}名${i}`]),
  ),
  // 跨族同名：CFLAG（族表首位）与 TALENT 都有 —— 首命中必须仍是 CFLAG
  ['CFLAG', '9001', '共通名'],
  ['TALENT', '9001', '共通名'],
  // 只属追加名表：主表一轮全不中才给归属
  ['BASE', '2001', '追加专用名', 'append'],
  // byName 独有别名（同编号重名行）：枚举面（byIndex 值）看不见它，只能靠回退扫
  ['BASE', '13', '情绪'],
  ['BASE', '13', '情緒'],
  // 纯数字名（进了枚举面）与"编号键本身被当名字查"（不在枚举面）
  ['FLAG', '77', '77'],
  ['ABL', '55', '力量'],
];

const { schema } = makeBenchSchema(ROWS);

/* ============================== before 参考实现（复刻改前线性扫） ============================== */

function tierOf(info: VariableInfo | undefined): 'primary' | 'append' | undefined {
  if (info === undefined) return undefined;
  if (info.description === undefined && info.resolvedIndex === undefined) return undefined;
  if (info.source === 'const') return undefined;
  return info.source === 'append' ? 'append' : 'primary';
}

/** 逐字镜像改前的 `resolveFamily`（20 族线性扫、两轮分层）——基准的 before 侧 */
function scalarResolve(s: VariableSchema, name: string): string | undefined {
  let appendHit: string | undefined;
  for (const family of ENGINE_VARIABLE_FAMILIES) {
    const tier = tierOf(s.lookup(family, name));
    if (tier === 'primary') return family;
    if (tier === 'append' && appendHit === undefined) appendHit = family;
  }
  return appendHit;
}

/* ============================== 1. 等价性（硬断言） ============================== */

describe('resolveFamily 索引化 · 与线性扫逐位等价', () => {
  it('全枚举名 + 边界行 + 未知名：两者结果一致', () => {
    const lookup = makeLookup(schema);
    const probes: string[] = [];
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      const names = schema.names!(family);
      for (const info of names) probes.push(info.name);
      // 抽样足够覆盖索引面（每族枚举名全量在下面单独对拍，这里先铺满）
    }
    probes.push(
      '情緒', // byName 独有别名（不在枚举面）
      '追加专用名', // 追加层
      '共通名', // 跨族同名 → CFLAG
      '77', // 纯数字名（在枚举面）
      '55', // 编号键本身（不在枚举面 → 回退扫）
      'NoSuchName', // 未知
      '完全不存在的名字',
      '', // 空名
    );
    for (const p of probes) {
      const expected = scalarResolve(schema, p);
      expect(lookup.resolveFamily(p), `name=${p}`).toBe(expected);
    }
  });

  it('对照自证：等价不是因为两边都错——边界名的期望值按规范写死', () => {
    const lookup = makeLookup(schema);
    expect(lookup.resolveFamily('CFLAG名0')).toBe('CFLAG');
    expect(lookup.resolveFamily('共通名')).toBe('CFLAG'); // 族表顺序首个
    expect(lookup.resolveFamily('追加专用名')).toBe('BASE'); // 追加层第二轮
    expect(lookup.resolveFamily('情緒')).toBe('BASE'); // 枚举面外的 byName 别名
    expect(lookup.resolveFamily('55')).toBe('ABL'); // 编号键走回退扫（与改前同口径）
    expect(lookup.resolveFamily('NoSuchName')).toBeUndefined();
  });

  it('门槛门控：稀疏调用（< 64 次真实扫）不付建表账', () => {
    const { schema: fresh, namesCalls: calls } = makeBenchSchema(ROWS);
    const lookup = makeLookup(fresh);
    for (let i = 0; i < 63; i++) expect(lookup.resolveFamily(`稀疏未知名${i}`)).toBeUndefined();
    expect(calls()).toBe(0); // 尚未建表
    // 重复名不再扫（负结果记忆）：再加 10 次同名查询也不推进门槛
    for (let i = 0; i < 10; i++) lookup.resolveFamily('稀疏未知名0');
    expect(calls()).toBe(0);
    // 第 64 个**去重后的真实扫**之后、下一次调用建表
    lookup.resolveFamily('稀疏未知名63'); // 第 64 次扫 → scansSeen=64
    lookup.resolveFamily('CFLAG名0'); // 触发建表 + 索引命中
    expect(calls()).toBeGreaterThan(0);
  });
});

/* ============================== 2. 微基准 ============================== */

function benchMs(fn: () => void, rounds = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('微基准 · resolveFamily（before = 线性扫 / after = 索引+记忆）', () => {
  it('单次调用：索引命中/未命中都是 O(1)；量级方向有硬断言，具体数字打印在输出', () => {
    const lookup = makeLookup(schema);
    // 先把索引建出来（65 个去重名扫过门槛）并预热回退记忆
    for (let i = 0; i < 70; i++) lookup.resolveFamily(`预热未知名${i}`);

    // 查询混合：70% 枚举名命中 + 20% byName 别名/追加 + 10% 未知（典型文档画像）
    const queries: string[] = [];
    for (let i = 0; i < 700; i++) queries.push(`${ENGINE_VARIABLE_FAMILIES[i % ENGINE_VARIABLE_FAMILIES.length]!}名${(i * 7) % PER_FAMILY}`);
    for (let i = 0; i < 200; i++) queries.push(i % 2 === 0 ? '情緒' : '追加专用名');
    for (let i = 0; i < 100; i++) queries.push(`未知量${i % 97}`);

    const iterations = 200; // 200 × 1000 = 20 万次/轮
    const scalarMs = benchMs(() => {
      for (let i = 0; i < iterations; i++) for (const q of queries) scalarResolve(schema, q);
    });
    const indexedMs = benchMs(() => {
      for (let i = 0; i < iterations; i++) for (const q of queries) lookup.resolveFamily(q);
    });
    const ops = iterations * queries.length;
    const perOpScalar = (scalarMs * 1000) / ops;
    const perOpIndexed = (indexedMs * 1000) / ops;
    // eslint-disable-next-line no-console
    console.log(
      `[bench] resolveFamily 单次调：before 线性扫 ${perOpScalar.toFixed(3)} µs/op · after 索引+记忆 ${perOpIndexed.toFixed(3)} µs/op（${(
        perOpScalar / Math.max(perOpIndexed, 1e-6)
      ).toFixed(1)}× · 20 万次/轮 × 3 轮取最快）`,
    );
    expect(indexedMs).toBeLessThan(scalarMs * 0.8); // 量级方向（宽松，不绑机器）
  });

  it('建表成本（一次性，随代际 memo 只付一遍）——数字打印在输出', () => {
    const buildOnce = (): number => {
      const { schema: s2 } = makeBenchSchema(ROWS);
      const l2 = makeLookup(s2);
      for (let i = 0; i < 64; i++) l2.resolveFamily(`预热未知名${i}`); // 门槛内：只记账不建表
      const t0 = performance.now();
      l2.resolveFamily('触发建表'); // scansSeen = 64 ⇒ 本调建表
      return performance.now() - t0;
    };
    const ms = benchMs(buildOnce, 3);
    // eslint-disable-next-line no-console
    console.log(
      `[bench] 名称索引一次性建表（20 族 × ${PER_FAMILY} 名 = ${ENGINE_VARIABLE_FAMILIES.length * PER_FAMILY} 名）：${ms.toFixed(2)} ms`,
    );
    expect(ms).toBeLessThan(60_000);
  });

  it('makeLookup + createSugarTranspileService 每调重建成本（memo 消除的部分）', () => {
    const n = 2000;
    let sink = 0;
    const freshMs = benchMs(() => {
      for (let i = 0; i < n; i++) {
        const s = createSugarTranspileService({ dictionary: makeLookup(schema), faceTable: stubFaceTable() });
        sink += 1 + s.transpileCacheStats().entries;
      }
    });
    const memoed = createSugarTranspileService({ dictionary: makeLookup(schema), faceTable: stubFaceTable() });
    const reuseMs = benchMs(() => {
      for (let i = 0; i < n; i++) sink += 1 + memoed.transpileCacheStats().entries;
    });
    // eslint-disable-next-line no-console
    console.log(
      `[bench] makeTranspiler 每调重建（makeLookup + 服务装配）：before ${((freshMs * 1000) / n).toFixed(2)} µs/op · after（memo 复用）${(
        (reuseMs * 1000) /
        n
      ).toFixed(2)} µs/op · 重建 ${n} 次共 ${freshMs.toFixed(2)} ms（sink=${sink}）`,
    );
    expect(sink).toBeGreaterThanOrEqual(n * 2); // 两个循环各至少跑满一轮
  });
});

/* ============================== PS-8 · 词法动态正则层（词法热路径批） ============================== */

/** 改前口径的逐字镜像：每次调用现建正则（wordTail 词首组 + `stripCont` 两族） */
const escapeReB = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PS8_TAIL_WORDS: readonly string[] = [
  blockEndWord('block.loop'),
  primaryWord('inline.jump'),
  primaryWord('inline.functionJump'),
  primaryWord('inline.label'),
  primaryWord('inline.loopStep'),
  primaryWord('inline.dataEntry'),
  primaryWord('block.when'),
  primaryWord('inline.loopCount'),
  primaryWord('inline.engineEcho'),
];
const PS8_QUOTE_MARKS: readonly string[] = ['续', 'cont', 'continue'];

/** 一行的"动态建形 + exec"工作量（改前词法每行实际付的账，只取正则层） */
function legacyRegexLayer(code: string): number {
  let hits = 0;
  for (const w of PS8_TAIL_WORDS) {
    const m = new RegExp(`^${escapeReB(w)}[ \\t\\u3000]+(.+)$`).exec(code);
    if (m) hits++;
  }
  for (const mark of CONT_MARKS) {
    if (new RegExp(`(?:^|\\s)${escapeReB(mark)}\\s*$`).test(code)) hits++;
  }
  for (const mark of PS8_QUOTE_MARKS) {
    const re = new RegExp(`[「｢][^」｣]*?\\s${escapeReB(mark)}\\s*[」｣]`, 'g');
    if (re.exec(code)) hits++;
  }
  return hits;
}

/** 记忆化后的同一层（本测试自带 Map 记忆 = 生产 `lexer` 同款做法；预建后只剩 exec） */
function memoRegexLayer(code: string): number {
  const cache = memoLayerCache;
  let hits = 0;
  for (const w of PS8_TAIL_WORDS) {
    const m = memoGet(cache, `t:${w}`, () => new RegExp(`^${escapeReB(w)}[ \\t\\u3000]+(.+)$`)).exec(code);
    if (m) hits++;
  }
  for (const mark of CONT_MARKS) {
    if (memoGet(cache, `c:${mark}`, () => new RegExp(`(?:^|\\s)${escapeReB(mark)}\\s*$`)).test(code)) hits++;
  }
  for (const mark of PS8_QUOTE_MARKS) {
    const re = memoGet(cache, `q:${mark}`, () => new RegExp(`[「｢][^」｣]*?\\s${escapeReB(mark)}\\s*[」｣]`, 'g'));
    re.lastIndex = 0;
    if (re.exec(code)) hits++;
  }
  return hits;
}

const memoLayerCache = new Map<string, RegExp>();
function memoGet(cache: Map<string, RegExp>, key: string, build: () => RegExp): RegExp {
  let re = cache.get(key);
  if (re === undefined) {
    re = build();
    cache.set(key, re);
  }
  return re;
}

/** 语料形状的词法行（台词 / 控制 / 原生混合；每行都过改前/记忆两条腿） */
const PS8_LINES: string[] = [];
for (let i = 0; i < 1000; i++) {
  switch (i % 6) {
    case 0:
      PS8_LINES.push(`你「今天的表情有点${i % 30}。」`);
      break;
    case 1:
      PS8_LINES.push(`步进 CFLAG:${i % 50} 加 1`);
      break;
    case 2:
      PS8_LINES.push(`跳到 标签${i % 40}`);
      break;
    case 3:
      PS8_LINES.push(`CALL HPH_PRINT(@"方法名", 1) ; 原生直通`);
      break;
    case 4:
      PS8_LINES.push(`「别停……」续`);
      break;
    default:
      PS8_LINES.push(`如果 LOCAL:2 = ${i % 7}：`);
  }
}

describe('微基准 · PS-8 词法正则层（before = 每行现建 / after = 记忆化）', () => {
  it('每行正则层 µs：记忆化方向性硬断言 + 等价（两腿命中数逐行相等）；数字打印在输出', () => {
    // 等价（确定性，非计时）：同一行两条腿命中数必须逐行相等
    for (const line of PS8_LINES) expect(memoRegexLayer(line)).toBe(legacyRegexLayer(line));
    // 预热记忆腿（首轮把全部 pattern 建完）
    for (const line of PS8_LINES) memoRegexLayer(line);
    const iterations = 10;
    const legacyMs = benchMs(() => {
      for (let r = 0; r < iterations; r++) for (const line of PS8_LINES) legacyRegexLayer(line);
    });
    const memoMs = benchMs(() => {
      for (let r = 0; r < iterations; r++) for (const line of PS8_LINES) memoRegexLayer(line);
    });
    const lines = iterations * PS8_LINES.length;
    // 真实入口对照（after 全词法腿：classifyLine 整行）
    const logical = splitLogicalLines(PS8_LINES.join('\n'));
    const sink: DiagnosticSink = { report: () => undefined, all: () => [] };
    const fullMs = benchMs(() => {
      for (let r = 0; r < iterations; r++)
        for (const l of logical) {
          classifyLine(l);
          if (l.text.includes('「')) stripCont(l.text, sink, l);
        }
    });
    const perLineLegacy = (legacyMs * 1000) / lines;
    const perLineMemo = (memoMs * 1000) / lines;
    const perLineFull = (fullMs * 1000) / lines;
    // eslint-disable-next-line no-console
    console.log(
      `[bench] PS-8 词法正则层：before（每行 12 枚现建+exec）${perLineLegacy.toFixed(3)} µs/行 · after（记忆化 exec）${perLineMemo.toFixed(3)} µs/行（${(perLineLegacy / Math.max(perLineMemo, 1e-6)).toFixed(1)}×）；真实入口对照 classifyLine+stripCont ${perLineFull.toFixed(3)} µs/行（after 全词法）`,
    );
    expect(memoMs).toBeLessThan(legacyMs * 0.5); // 记忆化至少砍半（实测应是数量级）
  });
});

/* ============================== PS-8 · foldGeneratedLine（每滚动全量扫） ============================== */

/** 改前实现逐字镜像（每次调用全量 split + sort + 线性扫） */
function legacyFold(result: SugarTranspileResult, generatedLine: number): number | null {
  const exact = result.sourceMap.find((e) => e.generatedLine === generatedLine);
  if (exact?.sourceLine != null) return exact.sourceLine;
  const lines = result.erb.split('\n');
  const ordered = [...result.sourceMap].sort((a, b) => a.generatedLine - b.generatedLine);
  for (const entry of ordered) {
    if (entry.generatedLine <= generatedLine) continue;
    if (/^@/.test(lines[entry.generatedLine - 1] ?? '')) return null;
    if (entry.sourceLine !== null) return entry.sourceLine;
  }
  return null;
}

function ps8Product(n: number): { result: SugarTranspileResult; queries: number[] } {
  const lines: string[] = [];
  const sourceMap: SugarSourceMapEntry[] = [];
  for (let g = 1; g <= n; g++) {
    if (g % 97 === 0) {
      lines.push(`@GEN_HEAD_${g}`);
      sourceMap.push({ generatedLine: g, sourceLine: null });
    } else {
      lines.push(`\tPRINTFORMW x${g}`);
      sourceMap.push({ generatedLine: g, sourceLine: g });
    }
  }
  const queries: number[] = [];
  for (let i = 0; i < 200; i++) queries.push(13 + ((i * 97) % (n - 26))); // 命中体内生成行的下一位
  return { result: { erb: lines.join('\n'), sourceMap, diagnostics: [] } as unknown as SugarTranspileResult, queries };
}

describe('微基准 · PS-8 foldGeneratedLine（before = 每次全量 split+sort / after = WeakMap 索引）', () => {
  it('3,000 行产物 × 200 提示/滚动：µs/条 与整轮 ms 打印在输出；等价先对拍', () => {
    const { result, queries } = ps8Product(3000);
    for (const q of queries) expect(foldGeneratedLine(result, q)).toBe(legacyFold(result, q));
    const rounds = 20;
    const legacyMs = benchMs(() => {
      for (let r = 0; r < rounds; r++) for (const q of queries) legacyFold(result, q);
    });
    const memoMs = benchMs(() => {
      for (let r = 0; r < rounds; r++) for (const q of queries) foldGeneratedLine(result, q);
    });
    const items = rounds * queries.length;
    const perItemLegacy = (legacyMs * 1000) / items;
    const perItemMemo = (memoMs * 1000) / items;
    // eslint-disable-next-line no-console
    console.log(
      `[bench] PS-8 foldGeneratedLine（3,000 行产物、200 条/滚动）：before ${perItemLegacy.toFixed(2)} µs/条（整轮 ${(legacyMs / rounds).toFixed(2)} ms）· after ${perItemMemo.toFixed(3)} µs/条（整轮 ${(memoMs / rounds).toFixed(2)} ms）（${(perItemLegacy / Math.max(perItemMemo, 1e-6)).toFixed(0)}×）`,
    );
    expect(memoMs).toBeLessThan(legacyMs * 0.5);
  });
});
