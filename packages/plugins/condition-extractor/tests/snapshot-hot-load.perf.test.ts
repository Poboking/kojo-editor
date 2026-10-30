/**
 * PERF-7 · 抽取快照热载的**合成读数**（2,000 文件 / 28,000 函数桶 / 168,000 依赖）。
 *
 * 与 erb-parser 那份同源同口径：**语料不在本机 ⇒ 用合成项目量**（`*.corpus.test.ts` 这批
 * 在本机整批 skip，而"改好了必须带数"不接受记忆里的数字）。同一进程、同一份盘上 payload
 * 做 A/B：
 * - **before = v4 急还原**：`decodeBuckets` 校验之后当场把 16.8 万个 `StateDependency`
 *   （各带一条 `comparisons` 数组）与 2.8 万个 `FunctionConditions` 建出来；
 * - **after = v5 懒还原**：装载只做"校验 + 建桶壳"，`dependencies` 是 getter，
 *   开项目级联（`mergeBuckets` 只吃 `normalizedName` 与桶级 stats）一个对象都不碰。
 * before 的函数体照抄改动前的 `decodeBuckets`（含同一趟校验——少校验一次就是把收益报大），
 * 只把桶元组的第 2 位补成 v5 的 `size` 槽。
 *
 * 断言口径照 `app/tests/completion-perf.test.ts`：钉方向、钉等值，绝对值只留病态兜底。
 */
import { describe, expect, it } from 'vitest';
import { dependencyKey } from '@kojo/plugin-api';
import type { ConditionComparison, FunctionConditions, StateDependency, VariableInfo } from '@kojo/plugin-api';
import {
  EXTRACT_SNAPSHOT_FORMAT,
  decodeBuckets,
  encodeBuckets,
  planReuse,
  type ExtractExpect,
  type FileBucket,
  type StoredConditionIndex,
} from '../src/snapshot';

/* ============================== 合成项目 ============================== */

const FILES = 2000;
const FN_PER_FILE = 14; // ⇒ 28,000 函数桶
const DEP_PER_FN = 6; // ⇒ 168,000 依赖条（真语料 164,910 的同量级替身）
const NAME_KINDS = 120; // 依赖名只有百来种（语料里 1,176 种 ⇒ 字典去重收益同源）
const EXPECT: ExtractExpect = { projectRoot: 'D:/synthetic/eratw-perf7', adapterId: 'eratw', inputDigest: 'csv-digest-1' };

/** 造 v5 桶：`size` 与 mtime 都是真判据的一部分，不能只喂 mtime */
function syntheticBuckets(): Map<string, FileBucket> {
  const buckets = new Map<string, FileBucket>();
  for (let f = 0; f < FILES; f++) {
    const path = `D:/synthetic/eratw-perf7/ERB/f${String(f).padStart(4, '0')}.ERB`;
    const conds: FunctionConditions[] = [];
    for (let k = 0; k < FN_PER_FILE; k++) {
      const dependencies: StateDependency[] = [];
      for (let d = 0; d < DEP_PER_FN; d++) {
        const name = `CFLAG${(f * 7 + k * 3 + d) % NAME_KINDS}`;
        const indices = [String((d * 11) % 500)];
        dependencies.push({
          key: dependencyKey({ name, indices }),
          name,
          indices,
          count: d + 1,
          comparisons: [{ op: '>=', value: 500, text: '500' }],
          firstLine: 10 + k,
          schema: { name, index: 2, description: `状态${d}` } satisfies VariableInfo,
        });
      }
      conds.push({
        normalizedName: `M_KOJO_PERF_${f}_${k}`,
        filePath: path,
        startLine: 10 + k * 20,
        predicateCount: 3,
        unparsedCount: 1,
        dependencies,
      });
    }
    buckets.set(path, {
      mtimeMs: 1000 + f,
      size: 8192 + f,
      stats: {
        functions: FN_PER_FILE,
        functionsWithDeps: FN_PER_FILE,
        predicates: FN_PER_FILE * 3,
        unparsed: FN_PER_FILE,
        dependencies: FN_PER_FILE * DEP_PER_FN,
      },
      conds,
    });
  }
  return buckets;
}

/* ============================== 计时工具 ============================== */

function medianOf(runs: number, fn: () => void): number {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)]!;
}

/**
 * 两条腿**同一窗口交替采样**（每轮各测一次，轮内顺序逐轮反转），各自取中位数。
 * 口径抄 `packages/plugins/erb-parser/tests/semantic-tokens.perf.test.ts` 的 `measureTogether`：
 * 先后两个独立窗口在 CI 共享 CPU 上不可比（`afterLoadMs` 47.7 vs `beforeLoadMs` 41.7 那次红
 * 就是跨窗互换高低）。同窗交替后两条腿铺满同一段负载曲线，窗口漂移被摊掉。
 * @returns 与 `fns` 同序的中位数数组
 */
function measureTogether(runs: number, fns: readonly (() => void)[]): number[] {
  const buckets: number[][] = fns.map(() => []);
  const idx = fns.map((_, f) => f);
  for (let i = 0; i < runs; i++) {
    for (const f of i % 2 === 0 ? idx : [...idx].reverse()) {
      const t0 = performance.now();
      fns[f]!();
      buckets[f]!.push(performance.now() - t0);
    }
  }
  return buckets.map((ds) => {
    ds.sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)]!;
  });
}

const ms = (n: number): string => `${n.toFixed(1)}ms`;

/* ============================== before：v4 急还原 ============================== */

type CondT = [string, number, number, number, DepT[]];
type DepT = [number, string[], number, number, [string, number | string, string][], number];
type BucketT = [number | null, number | null, [number, number, number, number, number], CondT[]];

/**
 * **before 参照实现**＝改动前的 `decodeBuckets` 体：同一趟全局判据 + 同一趟逐条校验
 * （名字/标签下标越界照查），校验过后**当场**建全部 `FunctionConditions` 与 `StateDependency`。
 */
function decodeBucketsEager(
  raw: unknown,
  expect: ExtractExpect,
): { buckets: Record<string, FileBucket>; schemas: readonly (VariableInfo | null)[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredConditionIndex>;
  if (s.format !== EXTRACT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot || s.adapterId !== expect.adapterId || s.inputDigest !== expect.inputDigest) {
    return null;
  }
  if (!Array.isArray(s.schemas) || !s.schemas.every((v) => v === null || typeof v === 'object')) return null;
  if (!Array.isArray(s.names) || !s.names.every((v) => typeof v === 'string')) return null;
  const names = s.names as readonly string[];
  const schemas = s.schemas as readonly (VariableInfo | null)[];

  const isDep = (t: unknown): boolean => {
    if (!Array.isArray(t) || t.length !== 6) return false;
    const [nameIx, indices, count, firstLine, cmp, sIdx] = t as unknown[];
    if (typeof nameIx !== 'number' || !Number.isInteger(nameIx) || nameIx < 0 || nameIx >= names.length) return false;
    if (!Array.isArray(indices) || !indices.every((x) => typeof x === 'string')) return false;
    if (typeof count !== 'number' || typeof firstLine !== 'number') return false;
    if (!Array.isArray(cmp) || !cmp.every((c) => Array.isArray(c) && c.length === 3)) return false;
    if (typeof sIdx !== 'number' || sIdx < -1 || sIdx >= schemas.length) return false;
    return true;
  };

  const out: Record<string, FileBucket> = {};
  for (const [path, tuple] of Object.entries(s.buckets as Record<string, unknown>)) {
    const t = tuple as unknown as BucketT;
    if (!Array.isArray(t) || t.length !== 4) return null;
    const [mtimeMs, size, st, conds] = t;
    if (!Array.isArray(st) || st.length !== 5 || !st.every((n) => typeof n === 'number')) return null;
    if (!Array.isArray(conds) || !conds.every((c) => Array.isArray(c) && c.length === 5 && c[4].every(isDep))) {
      return null;
    }
    out[path] = {
      mtimeMs,
      size,
      stats: {
        functions: st[0],
        functionsWithDeps: st[1],
        predicates: st[2],
        unparsed: st[3],
        dependencies: st[4],
      },
      conds: conds.map(
        ([normalizedName, startLine, predicateCount, unparsedCount, deps]): FunctionConditions => {
          const dependencies: StateDependency[] = deps.map(
            ([nameIx, indices, count, firstLine, comparisons, sIdx]): StateDependency => {
              const name = names[nameIx]!;
              const dep: StateDependency = {
                key: dependencyKey({ name, indices }),
                name,
                indices,
                count,
                comparisons: comparisons.map(
                  (cmp): ConditionComparison => ({ op: cmp[0], value: cmp[1], text: cmp[2] }),
                ),
                firstLine,
              };
              if (sIdx >= 0) dep.schema = schemas[sIdx] as VariableInfo;
              return dep;
            },
          );
          return { normalizedName, filePath: path, startLine, predicateCount, unparsedCount, dependencies };
        },
      ),
    };
  }
  return { buckets: out, schemas };
}

/* ============================== 基准 ============================== */

const srcBuckets = syntheticBuckets();
const payload = encodeBuckets({ buckets: srcBuckets, expect: EXPECT, savedAt: 999 });
const json = JSON.stringify(payload);
const parsed = JSON.parse(json) as unknown;

describe('PERF-7 抽取快照热载合成基准（2,000 文件 / 28k 函数桶 / 168k 依赖）', () => {
  const encodeMs = medianOf(3, () => void JSON.stringify(encodeBuckets({ buckets: srcBuckets, expect: EXPECT })));
  const jsonParseMs = medianOf(3, () => void JSON.parse(json));
  // 装载段的 A/B **必须在同一窗口里交替**（跨窗口的 median 不可比，理由见 measureTogether）
  const hotLoad = measureTogether(5, [
    () => {
      if (decodeBuckets(parsed, EXPECT) === null) throw new Error('decode failed');
    },
    () => {
      if (decodeBucketsEager(parsed, EXPECT) === null) throw new Error('eager decode failed');
    },
  ]);
  const afterLoadMs = hotLoad[0]!;
  const beforeLoadMs = hotLoad[1]!;
  const after = decodeBuckets(parsed, EXPECT)!;
  const before = decodeBucketsEager(parsed, EXPECT)!;
  const consumeMs = medianOf(3, () => {
    // 全部消费一遍 = "每个函数都被问过依赖"的最坏口径（开项目级联实际一个都不问）
    const fresh = decodeBuckets(parsed, EXPECT)!;
    for (const b of Object.values(fresh.buckets)) for (const c of b.conds) void c.dependencies.length;
  });

  it('合成规模自证（28k 桶 / 168k 依赖 / 盘上有体积）', () => {
    let deps = 0;
    let conds = 0;
    for (const b of srcBuckets.values()) {
      conds += b.conds.length;
      deps += b.conds.reduce((n, c) => n + c.dependencies.length, 0);
    }
    expect(conds).toBe(FILES * FN_PER_FILE);
    expect(deps).toBe(FILES * FN_PER_FILE * DEP_PER_FN);
    console.log(
      `[perf7][ce-synthetic] ${FILES} 文件 · ${conds} 函数桶 · ${deps} 依赖条 · payload ` +
        `${(json.length / 1048576).toFixed(1)} MiB（真语料 v4 实测 9.01 MB 的同量级替身）· ` +
        `encode+stringify ${ms(encodeMs)} · JSON.parse ${ms(jsonParseMs)}`,
    );
  });

  it('热载装载段：懒还原（after）低于急还原（before），产物逐字段等值', () => {
    for (const path of [...srcBuckets.keys()].slice(0, 3).concat([...srcBuckets.keys()].slice(-1))) {
      expect(after.buckets[path]!.mtimeMs).toBe(before.buckets[path]!.mtimeMs);
      expect(after.buckets[path]!.size).toBe(before.buckets[path]!.size);
      expect(after.buckets[path]!.stats).toEqual(before.buckets[path]!.stats);
      expect(after.buckets[path]!.conds).toEqual(before.buckets[path]!.conds); // 深比 = 触发 getter
    }
    // 没被问过的那批仍是 accessor —— 这正是开项目级联不付的那一笔
    const untouchedPath = [...srcBuckets.keys()][3]!;
    expect(Object.getOwnPropertyDescriptor(after.buckets[untouchedPath]!.conds[0]!, 'dependencies')?.get).toBeTypeOf(
      'function',
    );
    console.log(
      `[perf7][ce-load] before(v4 急还原) ${ms(beforeLoadMs)} → after(v5 懒还原) ${ms(afterLoadMs)}` +
        `（同窗交替 n=5，median）` +
        ` ｜ 省 ${ms(beforeLoadMs - afterLoadMs)}（after/before = ${(afterLoadMs / beforeLoadMs).toFixed(2)}）·` +
        ` 全消费最坏口径 ${ms(consumeMs)}（= 装载 + 每个函数都被问一次）· 同段共有的 JSON.parse ${ms(jsonParseMs)}`,
    );
    /**
     * **判据从"after ≤ before"放宽到"after ≤ before × 1.15"，并如实记账**（MEM-11，2026-10-30）。
     *
     * 为什么放宽：MEM-11 把条件壳从"字面量里写 `get dependencies()`"改成"数据属性字面量 +
     * `defineProperty` 补**共享**访问器 + 状态放 `WeakMap`"。后者每枚壳多两次调用
     * （`defineProperty` + `WeakMap.set`），实测 **109.3 ms vs before 99.8 ms（1.10×，+9.5 ms）**；
     * 换来的是**形状从字典态回到快路径**：`(object properties)` 22.75 MB → **0.35 MB**，
     * 真实快照 decode 后 heapUsed **46.6 → 21.8 MB**。
     *
     * 也就是说：这条闸原本量的"懒还原比急还原便宜"，现在**不成立了**——懒还原要多付一笔
     * 固定的"装访问器"成本（52k 枚 × 0.18 µs）。但**净账仍是压倒性的**：一次开项目 +9.5 ms，
     * 常驻 −22 MB。按 PITFALLS 263 的纪律，这里不删闸、不假装没变慢，而是**把 1.20× 写成
     * 明确的可接受上界**（实测两轮 1.10 / 1.14；留到 1.20 是防共享 CPU 的抖动，不是放宽账），
     * 并把两个数（+9.5~13.7 ms / −22 MB）留在日志与台账里。
     * 若要重新拿回这 9.5 ms，唯一出路是"不装自有访问器"（走原型访问器），但那会改
     * `Object.keys` / `toEqual` 的口径 ⇒ 不在本批。
     *
     * **MEM-17（2026-10-30）把这笔成本收回来了**：共享访问器改用 `__defineGetter__`，
     * 零依赖壳（真实语料 25.3%，13,249/52,435）直接给数据属性 `[]`。真实快照
     * `decodeBuckets` A/B（同一窗口交替 n=5，新/旧/新自对照；自对照本身差 ~20 ms）实测**旧
     * 236~295 ms → 新 152~183 ms（−65~85 ms）**。本闸九轮 after/before 中位 **1.01**
     * （0.93~1.11；机器静下来的四轮 0.93 / 0.99 / 0.94 / 0.98 ⇒ 已不慢于急还原）。判据上界
     * 仍是 1.20，那是防共享 CPU 抖动，不是留着让懒还原变慢。
     */
    expect(afterLoadMs).toBeLessThanOrEqual(beforeLoadMs * 1.2);
    expect(afterLoadMs).toBeLessThan(8000);
  });

  it('逐文件判据（mtime + size）：改一个文件只重算那一个，缺 size 信号时退回纯 mtime', () => {
    const stampsAll = Object.entries(after.buckets).map(([path, b]) => ({ path, mtimeMs: b.mtimeMs, size: b.size }));
    expect(planReuse(after.buckets, stampsAll).allHit).toBe(true);

    const touched = stampsAll.map((s, i) => (i === 0 ? { ...s, size: s.size! + 1 } : s));
    const p1 = planReuse(after.buckets, touched);
    expect(p1.stale).toEqual([stampsAll[0]!.path]); // mtime 没变、字节数变了 ⇒ 只有它过期

    const p2 = planReuse(after.buckets, stampsAll.map((s) => ({ ...s, size: null })));
    expect(p2.allHit).toBe(true); // 索引没提供 size ⇒ 不把"没信号"当"过期"
    console.log(
      `[perf7][ce-plan] 2,000 桶全命中 · size+1 的单文件判过期（其余 ${p1.reusable.size} 复用）· size 缺位退回纯 mtime`,
    );
  });
});
