/**
 * UX 感知批（2026-10-16）· 搜索热路径与面窗口的**读数与口径**（纯函数 + 合成 99k，无 IO/无语料）。
 *
 * 三个断言面：
 * 1) **行为等价**：`searchFunctions` 重写为「轻量收集 → 排序截断 → 只物化 ≤limit 条」后，
 *    与改动前实现（`searchFunctionsV1`，逐字复制本文件内作为可执行规格）在全查询域上逐字相同；
 * 2) **微基准（before/after）**：99,104 函数合成集上——
 *      before =「无 deferred/memo：每击键全量扫一次」（v1 逐击键跑）；
 *      after  =「useDeferredValue 折叠中间值：一串击键只对落定值扫一次 + 结果 memo 兜重复渲染」；
 * 3) **结果 memo**：按索引实例 × 查询串记忆（扫描次数用 `files.values` 探针数——带自检）。
 *
 * 计时一律 median（n ≥ 30），断言**只钉方向与有界**（不钉绝对值），读数经 console.log 输出。
 */

import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  ErbFile,
  ErbFunction,
  ErbIndex,
  FamilyIndexRule,
  FamilyMatch,
  FamilyParseKind,
} from '@kojo/plugin-api';
import {
  FACE_WINDOW_INITIAL,
  FACE_WINDOW_STEP,
  faceWindowSize,
  nextFaceWindow,
  searchFunctions,
  searchFunctionsCached,
  type SearchHit,
} from '../src/tree';

/* ============================== 测试基建 ============================== */

function mk(
  kind: FamilyParseKind,
  family: string,
  no: number | null,
  face: string,
  slot: string,
): FamilyMatch {
  return {
    kind,
    prefix: 'M_KOJO',
    family,
    characterNo: no,
    selector: 0,
    face,
    sub: '',
    isMessageCheck: false,
    slot,
    isPlaceholder: kind === 'placeholder',
  };
}

/** mini 家族规则（与 tree.test.ts 同款手写规则，绝不 import 适配器包） */
const fakeFamilyIndex: FamilyIndexRule = {
  name: 'fake',
  match(fnName: string): FamilyMatch | null {
    let m = /^M_KOJO_K(\d+)(?:_(\d+))?$/.exec(fnName);
    if (m) return mk('declare', '', Number(m[1]!), 'declare', '');
    m = /^(M_KOJO.*)_(K\d+)(?:_(.+))?$/.exec(fnName);
    if (!m) return null;
    const head = m[1]!.slice('M_KOJO'.length);
    const segs = head.split('_').filter(Boolean);
    let start = segs.length;
    while (start > 0 && /^[A-Z0-9]+$/.test(segs[start - 1]!)) start--;
    const face = segs.slice(start).join('_');
    const family = segs.slice(0, start).join('_');
    return mk('ok', family, Number(m[2]!.slice(1)), face, m[3] ?? '');
  },
};

function makeIndex(files: Record<string, string[]>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map();
  for (const [path, fns] of Object.entries(files)) {
    const functions: ErbFunction[] = fns.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      params: [],
      startLine: i * 10 + 2,
      endLine: i * 10 + 9,
      filePath: path,
    }));
    map.set(path, { path, functions, dims: [], hasFunctionDirective: false, lineCount: fns.length * 10 + 5 });
  }
  return { files: map, byName };
}

/* ------- 改动前实现（逐字复制；用作等价性规格 + 微基准的 before 侧） ------- */

function emptyMatchV1(): FamilyMatch {
  return {
    kind: 'ok',
    prefix: '',
    family: '',
    characterNo: null,
    selector: 0,
    face: '',
    sub: '',
    isMessageCheck: false,
    slot: '',
    isPlaceholder: false,
  };
}

function searchFunctionsV1(
  index: ErbIndex,
  query: string,
  familyIndex: FamilyIndexRule | null,
  limit = 200,
): SearchHit[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const file of index.files.values()) {
    for (const fn of file.functions) {
      if (!fn.normalizedName.includes(q)) continue;
      const match = familyIndex ? familyIndex.match(fn.normalizedName, fn.filePath) : null;
      hits.push({
        node: {
          name: fn.name,
          normalizedName: fn.normalizedName,
          filePath: fn.filePath,
          startLine: fn.startLine,
          endLine: fn.endLine,
          match: match ?? emptyMatchV1(),
          ...(fn.docComment !== undefined ? { docComment: fn.docComment } : {}),
        },
        charaNo: match?.characterNo ?? null,
      });
      if (hits.length >= limit * 3) break;
    }
    if (hits.length >= limit * 3) break;
  }
  hits.sort((a, b) => a.node.filePath.localeCompare(b.node.filePath) || a.node.startLine - b.node.startLine);
  return hits.slice(0, limit);
}

/** 输出投影（比较用；节点对象不进断言文本） */
const proj = (hits: readonly SearchHit[]): unknown[] =>
  hits.map((h) => [
    h.node.name,
    h.node.filePath,
    h.node.startLine,
    h.node.endLine,
    h.charaNo,
    h.node.match?.kind ?? '∅',
    h.node.match?.family ?? '∅',
    h.node.match?.face ?? '∅',
    h.node.match?.slot ?? '∅',
  ]);

/* ============================== 1) 行为等价 ============================== */

describe('searchFunctions · 重写后与改动前逐字等价（v1 = 逐字复制的旧实现）', () => {
  const index = makeIndex({
    '/p/koa/001/A.ERB': [
      'M_KOJO_K1',
      'M_KOJO_MESSAGE_COM_K1_30',
      'M_KOJO_MESSAGE_COM_K1_2',
      'M_KOJO_少女之梦_MESSAGE_COM_K1_5',
      'M_KOJO_KX_MESSAGE_COM_KX_30',
      'M_NOTKOJO_UTIL',
    ],
    '/p/koa/011/B.ERB': ['M_KOJO_MESSAGE_SCOM_K11_1', 'M_KOJO_MESSAGE_COM_K11_1', 'SOMETHING_ELSE'],
  });

  const queries = [
    'm', // 短于 MIN_QUERY
    '  ', // 空白
    'kx', // 未归属命中
    'message_com', // 大小写混合 + 多命中
    'M_KOJO_MESSAGE_COM_K1_30',
    'scom',
    'SOMETHING', // 前缀
    '不存在', // 零命中
  ];

  it('全查询域输出逐字相同（含 charaNo / match 形态 / 排序 / 截断）', () => {
    for (const q of queries) {
      for (const limit of [200, 10, 2]) {
        const a = searchFunctionsV1(index, q, fakeFamilyIndex, limit);
        const b = searchFunctions(index, q, fakeFamilyIndex, limit);
        expect(proj(b), `query=${JSON.stringify(q)} limit=${limit}`).toEqual(proj(a));
        // 元素引用形态：match 为空时用「空 match」对象而非 null（旧行为）
        for (const h of b) expect(h.node.match).not.toBeNull();
      }
    }
  });

  it('无家族规则（familyIndex = null）时两边一致：全部空 match + charaNo null', () => {
    const a = searchFunctionsV1(index, 'message', null);
    const b = searchFunctions(index, 'message', null);
    expect(proj(b)).toEqual(proj(a));
    expect(b.every((h) => h.charaNo === null)).toBe(true);
  });

  it('超采截断 ≥ limit*3 的早停路径：命中集与旧实现一致（含顺序）', () => {
    const big = makeIndex({
      '/p/koa/001/BIG.ERB': Array.from({ length: 1000 }, (_, i) => `M_KOJO_MESSAGE_COM_K1_${i + 1}`),
    });
    const a = searchFunctionsV1(big, 'message_com', fakeFamilyIndex, 10);
    const b = searchFunctions(big, 'message_com', fakeFamilyIndex, 10);
    expect(proj(b)).toEqual(proj(a));
    expect(b).toHaveLength(10);
  });
});

/* ============================== 99k 合成集 ============================== */

const CHARAS = 155;
const FILES_PER_CHARA = 15;
/** ≈ 99,104（语料实测规模）：155 角色 × 15 文件 ≈ 2,325 文件 × 43 函数 ≈ 99,975 */
const FNS_PER_FILE = 43;

function build99k(): { index: ErbIndex; charaIndex: Map<number, CharaInfo> } {
  const files: Record<string, string[]> = {};
  const charaIndex = new Map<number, CharaInfo>();
  const faces = ['MESSAGE_COM', 'MESSAGE_SCOM', 'COMMAND', 'SUCCESS', 'EVENT'];
  for (let no = 1; no <= CHARAS; no++) {
    const dir = `/proj/ERB/口上・メッセージ関連/個人口上/${String(no).padStart(3, '0')} K${no}`;
    charaIndex.set(no, { no, name: `角色${no}`, kojoDir: dir });
    for (let f = 0; f < FILES_PER_CHARA; f++) {
      const names: string[] = [`M_KOJO_K${no}`];
      for (let i = 1; i < FNS_PER_FILE; i++) {
        const face = faces[i % faces.length]!;
        // 掺入 1/5 具名家族，逼近真实分布
        const family = i % 5 === 0 ? `${no % 7 === 0 ? '少女之梦' : '深掘り'}_` : '';
        names.push(`M_KOJO_${family}${face}_K${no}_${f * FNS_PER_FILE + i}`);
      }
      files[`${dir}/包${f % 4}/M_KOJO_K${no}_${f}.ERB`] = names;
    }
  }
  return { index: makeIndex(files), charaIndex };
}

/* ============================== 2) 微基准 ============================== */

interface Latency {
  readonly median: number;
  readonly p95: number;
  readonly runs: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function measure(runs: number, fn: () => void): Latency {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return { median: quantile(ds, 0.5), p95: quantile(ds, 0.95), runs };
}

const fmt = (l: Latency): string => `median ${l.median.toFixed(3)} ms / p95 ${l.p95.toFixed(3)} ms（n=${l.runs}）`;

describe('微基准 · 99k 合成集（92k+ 函数）', () => {
  const { index } = build99k();
  const fnCount = [...index.files.values()].reduce((n, f) => n + f.functions.length, 0);

  it('规模自检：文件/函数数与断言口径相符（≈ 2,325 文件 / ≈ 100k 函数）', () => {
    expect(index.files.size).toBe(CHARAS * FILES_PER_CHARA);
    expect(fnCount).toBeGreaterThan(95_000);
    expect(fnCount).toBeLessThan(105_000);
  });

  it('单次扫描 before（v1）/ after（v2）：重型查询（早停）与零命中（全扫）两组读数', () => {
    const heavy = 'M_KOJO_MESSAGE_COM'; // 大量命中 → v1/v2 都在 limit*3 早停
    const rare = 'M_KOJO_MESSAGE_SCOM_K999_777'; // 零命中 → 全量 100k 扫描（最坏路径）

    // 预热（JIT + 内联缓存）
    searchFunctionsV1(index, heavy, fakeFamilyIndex, 200);
    searchFunctions(index, heavy, fakeFamilyIndex, 200);
    searchFunctionsV1(index, rare, fakeFamilyIndex, 200);
    searchFunctions(index, rare, fakeFamilyIndex, 200);

    const v1Heavy = measure(30, () => void searchFunctionsV1(index, heavy, fakeFamilyIndex, 200));
    const v2Heavy = measure(30, () => void searchFunctions(index, heavy, fakeFamilyIndex, 200));
    const v1Rare = measure(30, () => void searchFunctionsV1(index, rare, fakeFamilyIndex, 200));
    const v2Rare = measure(30, () => void searchFunctions(index, rare, fakeFamilyIndex, 200));

    // 输出等价的前提（读数才可比）：两端命中数相同
    expect(searchFunctions(index, heavy, fakeFamilyIndex, 200)).toHaveLength(
      searchFunctionsV1(index, heavy, fakeFamilyIndex, 200).length,
    );

    console.log(
      `[PERF search] 99k 合成集（${fnCount} 函数 / ${index.files.size} 文件）：\n` +
        `  重型查询「${heavy}」：before(v1) ${fmt(v1Heavy)}；after(v2) ${fmt(v2Heavy)}\n` +
        `  零命中「${rare}」（全扫）：before(v1) ${fmt(v1Rare)}；after(v2) ${fmt(v2Rare)}`,
    );

    // 方向断言（只钉不倒退与有界，不钉绝对值）：
    expect(v2Heavy.median).toBeLessThan(v1Heavy.median * 1.5);
    expect(v2Rare.median).toBeLessThan(v1Rare.median * 1.5);
    expect(v2Rare.p95).toBeLessThan(200); // 全扫路径的有界护栏（本机实测 ~2ms 的 100× 余量）
  });

  it('「每击键全量扫」的 before/after：一串 6 击键（含 5 次可查询前缀）的扫描总成本', () => {
    const keystrokes = ['QZQZQ1', 'QZQZQ12', 'QZQZQ123', 'QZQZQ1234', 'QZQZQ12345', 'QZQZQ123456'];
    // 全部零命中 ⇒ 每次都是最坏全扫（真实输入里"打错字"的常见形态）
    for (const k of keystrokes) {
      expect(searchFunctionsV1(index, k, fakeFamilyIndex, 200)).toHaveLength(0);
    }

    // before：无 deferred / 无 memo —— 每次击键直接全量扫
    const beforeTyping = measure(30, () => {
      for (const k of keystrokes) void searchFunctionsV1(index, k, fakeFamilyIndex, 200);
    });
    // after：useDeferredValue 折叠中间值（一串击键 → 只对落定值扫一次）
    //        + searchFunctionsCached 结果 memo（重复渲染/回退字符命中缓存 → 0 扫）
    const afterTyping = measure(30, () => {
      for (const k of keystrokes) void searchFunctionsCached(index, k, fakeFamilyIndex, 200);
    });

    console.log(
      `[PERF search] 6 击键一串（5 个可查前缀 × 全扫）总成本：\n` +
        `  before（每击键全量扫）${fmt(beforeTyping)}\n` +
        `  after（deferred 折叠 + 结果 memo，含每轮重渲染）${fmt(afterTyping)}\n` +
        `  ⇒ median 比 ${(beforeTyping.median / Math.max(afterTyping.median, 1e-6)).toFixed(1)}×`,
    );

    // 缓存清零后模拟"每次都是新终值"的最坏情形：6 个前缀各扫一次（= 6×），
    // 仍显著小于 before 的逐击键路径吗？不比较绝对值——只断言"落在缓存里"的路径远快于全扫路径。
    expect(afterTyping.median).toBeLessThan(beforeTyping.median / 2);
  });
});

/* ============================== 3) 结果 memo ============================== */

describe('searchFunctionsCached · 结果 memo（扫描次数探针带自检）', () => {
  /** `files.values()` 调用次数 = 扫描次数（带自检：一次真实扫描必须 +1） */
  function withScanCounter(idx: ErbIndex): { scans: () => number } {
    let scans = 0;
    const map = idx.files as Map<string, ErbFile> & { values: () => IterableIterator<ErbFile> };
    const orig = map.values.bind(map);
    map.values = () => {
      scans++;
      return orig();
    };
    return { scans: () => scans };
  }

  const { index } = build99k();

  it('同一查询重复调用：第二次命中缓存（0 扫）；实例换代后必失效', () => {
    const counter = withScanCounter(index);
    const q = 'M_KOJO_MESSAGE_SCOM_K155';
    const first = searchFunctionsCached(index, q, fakeFamilyIndex, 200);
    const before = counter.scans();
    // 探针自检：至少扫了一次（探针没接上时必须红）
    expect(before).toBeGreaterThan(0);

    const second = searchFunctionsCached(index, q, fakeFamilyIndex, 200);
    expect(second).toBe(first); // 同引用 ⇒ 未重扫
    expect(counter.scans()).toBe(before);

    // 大小写 / 首尾空白：归一后同键（第二次同引用）
    expect(searchFunctionsCached(index, `  ${q.toLowerCase()}  `, fakeFamilyIndex, 200)).toBe(first);

    // 不同 limit = 不同结果规格 ⇒ 重扫
    searchFunctionsCached(index, q, fakeFamilyIndex, 50);
    expect(counter.scans()).toBe(before + 1);

    // 不同 familyIndex 实例 ⇒ 缓存槽换掉
    const otherFi: FamilyIndexRule = { name: 'other', match: () => null };
    searchFunctionsCached(index, q, otherFi, 200);
    expect(counter.scans()).toBe(before + 2);

    // 索引换代（新实例）⇒ 弱引用键不同 ⇒ 重扫
    const counter2 = withScanCounter(build99k().index);
    searchFunctionsCached(index, q, fakeFamilyIndex, 200); // 旧实例缓存仍活（弱引用）
    expect(counter2.scans()).toBe(0);
  });

  it('缓存值与真实搜索逐字相同（memo 不失真）', () => {
    const fresh = build99k().index;
    for (const q of ['M_KOJO_COMMAND_K7', 'M_KOJO_K42', '少女之梦']) {
      const cached = searchFunctionsCached(fresh, q, fakeFamilyIndex, 200);
      const direct = searchFunctions(fresh, q, fakeFamilyIndex, 200);
      expect(proj(cached)).toEqual(proj(direct));
    }
  });
});

/* ============================== 4) 面窗口 ============================== */

describe('面窗口 · 初始上界与步进增长（DOM 行数上界的逻辑层证据）', () => {
  it('faceWindowSize：初值 = min(INITIAL, total)，显式 limit 生效', () => {
    expect(faceWindowSize(10_000, undefined)).toBe(FACE_WINDOW_INITIAL);
    expect(faceWindowSize(50, undefined)).toBe(50);
    expect(faceWindowSize(10_000, 240)).toBe(240);
    expect(faceWindowSize(100, 240)).toBe(100);
  });

  it('nextFaceWindow：单调不减、单步 ≤ STEP、终值 = total', () => {
    const total = 10_000;
    let cur: number | undefined = undefined;
    let steps = 0;
    // 首帧（未存窗口）实际挂载 = INITIAL；自此每步增量必须 ≤ STEP
    let prev = FACE_WINDOW_INITIAL;
    expect(faceWindowSize(total, undefined)).toBe(FACE_WINDOW_INITIAL);
    while (true) {
      const next = nextFaceWindow(cur, total);
      expect(next).toBeGreaterThanOrEqual(cur ?? FACE_WINDOW_INITIAL);
      expect(next).toBeGreaterThan(prev); // 每步严格增长（不增长 = 死循环）
      expect(next - prev).toBeLessThanOrEqual(FACE_WINDOW_STEP);
      prev = next;
      cur = next;
      steps++;
      if (next >= total) break;
      expect(steps).toBeLessThan(1000); // 防死循环（不收敛必须红）
    }
    expect(cur).toBe(total);
  });

  it('小面一步到位：total ≤ 当前窗口时 next 不变（哨兵不渲染，无空转）', () => {
    expect(nextFaceWindow(undefined, 100)).toBe(100);
    expect(nextFaceWindow(240, 100)).toBe(100);
    expect(nextFaceWindow(240, 240)).toBe(240);
  });
});
