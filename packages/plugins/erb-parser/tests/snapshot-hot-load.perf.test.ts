/**
 * PERF-7 · 快照热载瘦身的**合成读数**（2,000 文件 / 100,000 函数，无 IO、无语料、不挂 `KOJO_SMOKE_PROJECT`）。
 *
 * ## 为什么要合成口径
 * 真语料不在本机（`KOJO_CORPUS_DIR` 解析为空 ⇒ `*.corpus.test.ts` 整批 skip），
 * 而"改好了必须带数"不许拿记忆里的数字交差。这里把热载的两段拿到**同一进程、同一份
 * 盘上 payload** 上做 A/B：**before = v4 的急还原**（decode 里逐字段建 10 万个
 * `ErbFunction` + 逐条复制 refs，聚合再遍历一遍对象），**after = v5 的懒还原**
 * （decode 只校验 + 建外壳，重字段首次消费才建、聚合直吃元组）。
 * before 的函数体照抄改动前的 `decodeEntries`（`git show HEAD:…/snapshot.ts`），
 * 只保留 v5 的元组形状（多一个 `size` 槽，每条约 +8 B，不改时间复杂度）——
 * 否则 A/B 里混进格式差异，量到的就不是"急 vs 懒"。
 *
 * ## 断言口径（照 `app/tests/completion-perf.test.ts`）
 * **钉方向与正确性，不钉死绝对值**：绝对阈值只取本机实测的宽松上界（拦病态回归），
 * 真正必须成立的是 `after ≤ before` 与"两条路径产物逐字段等值"。
 *
 * ## 顺带钉住的口径陷阱（PITFALLS §68）
 * 合成正文是 CJK，UTF-16 码元数（`textLength`）与盘上字节数（`size`）**必然不等**
 * ——直接断言两者不等，防止日后有人拿 `textLength` 去比 stat 的字节数。
 */
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbFunction } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { buildReferenceIndex, REF_STRIDE, scanFileRefs, type FileRefs } from '../src/references';
import {
  aggregateIndex,
  coerceSnapshot,
  createNameInterner,
  decodeEntries,
  encodeEntries,
  SNAPSHOT_VERSION,
  type IndexSnapshot,
  type SnapshotEntry,
} from '../src/snapshot';

/* ============================== 合成语料 ============================== */

const FILES = 2000;
const FN_PER_FILE = 50; // ⇒ 100,000 函数（真语料 99,104 的同量级替身）
const ROOT = 'D:/synthetic/eratw-perf7';
const KOJO = `${ROOT}/ERB`;

/** 一个文件的正文（CJK 注释 ⇒ 码元数 ≠ 字节数；CALL ⇒ 产生引用流水） */
function erbSource(fileIndex: number): string {
  const out: string[] = [];
  for (let i = 0; i < FN_PER_FILE; i++) {
    out.push(
      ';==================================================',
      `; 第 ${fileIndex} 卷 · 函数 ${i} —— 好感度与状态分支（中文注释制造口径差）`,
      ';==================================================',
      `@FUNC_${fileIndex}_${i}( 目标 , 好感度 = 500 )`,
      '#DIM LOCAL, 返回值, 1',
      '\tIF CFLAG:100 >= 500',
      '\t\tPRINTFORMW 你好，世界。',
      `\t\tCALL FUNC_${(fileIndex + i) % FILES}_${(i * 3) % FN_PER_FILE}`,
      '\tELSE',
      '\t\tPRINTFORML 再会。',
      '\tENDIF',
      '\tRETURN 返回值',
      'END',
      '',
    );
  }
  return out.join('\n');
}

const pathOf = (i: number): string => `${KOJO}/M_KOJO_PERF_${String(i).padStart(4, '0')}.ERB`;

/** 生成一次（不计入基准）；字节数用 TextEncoder，与内核 stat 的字节口径对齐 */
function buildSyntheticProject(): { texts: string[]; paths: string[]; bytes: number[] } {
  const encoder = new TextEncoder();
  const texts: string[] = [];
  const paths: string[] = [];
  const bytes: number[] = [];
  for (let i = 0; i < FILES; i++) {
    const t = erbSource(i);
    texts.push(t);
    paths.push(pathOf(i));
    bytes.push(encoder.encode(t).length);
  }
  return { texts, paths, bytes };
}

/* ============================== 计时工具 ============================== */

/** 跑 `runs` 次取中位数（含 JIT 预热的首轮一并参与，取中位数即被压掉） */
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
 * A/B 两条腿**同一窗口交替采样**（每轮各测一次，轮内顺序逐轮反转），各自取中位数。
 *
 * 为什么不能各测各的（口径抄 `semantic-tokens.perf.test.ts` 的 `measureTogether`）：
 * 先后两个独立窗口在 CI 共享 CPU 上**不可比**——`after ≤ before` 的三条红字
 * （217 vs 207、276 vs 246、383 vs 295 ms）就是跨窗互换高低的代价，不是代码变慢。
 * 同窗交替后两条腿的样本均匀铺满同一段负载曲线，窗口漂移与轮内顺序偏差都被摊掉。
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

const FLAG_EXPRESSION = 1;

/** 盘上元组（v6 形状：`[mtime, size, textLength, 行数, #FUNCTION 旗标, 函数, 声明, 引用, 标签]`） */
type Tuple = [number | null, number | null, number, number, 0 | 1, unknown[], unknown[], unknown[], unknown[]];

/**
 * **before 参照实现**＝改动前的 `decodeEntries` 体：同样的逐条校验（fail-closed 一格不缺），
 * 校验之后**当场**建全部函数对象与声明对象，并把 refs 元组逐条复制一遍。
 * 校验必须照抄——否则 A/B 里少了"急还原也付的那一笔校验"，省下的数字就是假的。
 */
function decodeEntriesEager(raw: Record<string, unknown>): Record<string, SnapshotEntry> | null {
  const out: Record<string, SnapshotEntry> = {};
  /**
   * **MEM-4 之后这个参照臂也要过去重表**（2026-10-30 补，MEM-5 批发现）。
   *
   * 这条 A/B 的判据是"懒还原（after）≤ 急还原（before）"，前提是两条腿付**同一笔** decode
   * 成本。MEM-4 给解码加了字符串去重表（约 90 万次 `Map.get`，实测 +66 ms），而 before 臂
   * 是"改动前的解码"冻结副本、不含它 ⇒ 这条闸量到的其实是"去重表的开销"，直接红了
   * （after 165 ms > before 99 ms）。修法是**让 before 臂付同一笔**，不是放宽断言：
   * 参照臂照样是"同一份校验 + 当场建全部对象"，只是字符串也过表（内容不变，只换实例）。
   */
  const interner = createNameInterner();
  for (const [path, value] of Object.entries(raw)) {
    const t = value as unknown[];
    // v7 起条目是 10 位（第 10 位 = refs 名录摘要）、v11 起 11 位（第 11 位 = 候选记号集）；
    // before 参照实现只认到第 9 位为止的字段，多出来的溯源/候选位一律忽略——否则 A/B 里混进
    // "元组 arity 差异"，量到的就不是"急 vs 懒"
    if (
      (t.length !== 9 && t.length !== 10 && t.length !== 11) ||
      (t[0] !== null && typeof t[0] !== 'number') ||
      (t[1] !== null && typeof t[1] !== 'number') ||
      typeof t[2] !== 'number' ||
      typeof t[3] !== 'number' ||
      (t[4] !== 0 && t[4] !== 1) ||
      !Array.isArray(t[5]) ||
      !Array.isArray(t[6]) ||
      !Array.isArray(t[7]) ||
      !Array.isArray(t[8])
    ) {
      return null;
    }
    const [mtimeMs, size, textLength, lineCount, hasDirective, fns, dims, refs, labels] = value as Tuple;
    const okFn = (x: unknown): boolean =>
      Array.isArray(x) &&
      // 第 7 位（名字起点列，v9 起）与第 6 位可以是 null：A/B 的 before 臂照样忽略尾部多出来的位
      (x.length === 5 || x.length === 6 || x.length === 7) &&
      typeof x[0] === 'string' &&
      typeof x[1] === 'number' &&
      typeof x[2] === 'number' &&
      Array.isArray(x[3]) &&
      x[3].every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && (p[1] === 0 || p[1] === 1)) &&
      typeof x[4] === 'number' &&
      // v9 的位置契约：**要落第 7 位就必须先把第 6 位写出来**，无注释块时第 6 位是 `null`
      // （不是"没有这一位"）；第 7 位存在则必须是数字列
      (x.length === 5 || x[5] === null || typeof x[5] === 'string') &&
      (x.length !== 7 || typeof x[6] === 'number');
    /**
     * **MEM-7 之后引用流水是扁平的**（v13：步长 `REF_STRIDE`，第 0 格名字 / 1 行 / 2 列 / 3 旗标）。
     *
     * 参照臂是"改动前的 decode"的冻结副本，但**它读的是当下这份 payload**——盘上形状换了，
     * 校验器就必须跟着认新形状，否则整条 A/B 死在 `return null`（旧的四元组校验撞上
     * "第 0 格是字符串"，直接判整份快照损坏）。这不叫"改判据"，判据仍是"懒还原 ≤ 急还原"；
     * 只是把"同一份校验"对准同一份数据。
     *
     * 成本口径照旧对齐：仍**逐格校验 + 逐条过去重表**（生产 `internEntryStrings` 也是这么做的），
     * 只是省掉"为每条引用造一枚四元组"——那笔开销 MEM-7 已从生产两条腿一起拿掉，
     * 留着它反而会造出"旧形态更贵"的假 gain。
     */
    const okRefRun = (x: unknown): boolean => {
      if (!Array.isArray(x) || x.length % REF_STRIDE !== 0) return false;
      for (let i = 0; i < x.length; i += REF_STRIDE) {
        if (typeof x[i] !== 'string') return false;
        if (typeof x[i + 1] !== 'number' || typeof x[i + 2] !== 'number') return false;
        const k = x[i + 3];
        if (k !== 0 && k !== 1 && k !== 2) return false;
      }
      return true;
    };
    const okLabel = (x: unknown): boolean =>
      Array.isArray(x) && x.length === 3 && typeof x[0] === 'string' && typeof x[1] === 'number' && typeof x[2] === 'number';
    if (!fns.every(okFn)) return null;
    if (!dims.every((d) => Array.isArray(d) && d.length === 3 && typeof d[0] === 'string' && typeof d[1] === 'string' && typeof d[2] === 'number')) {
      return null;
    }
    if (!okRefRun(refs)) return null;
    if (!labels.every(okLabel)) return null;
    const functions: ErbFunction[] = fns.map((x) => {
      const [rawName, startLine, endLine, params, flags, rawDoc, nameColumn] = x as unknown as [
        string,
        number,
        number,
        Array<[string, number]>,
        number,
        string | null | undefined,
        number | null | undefined,
      ];
      // 去重表：与 `internEntryStrings` 同口径（内容不变、只换实例；见函数头注）
      const name = interner.intern(rawName);
      const doc = typeof rawDoc === 'string' ? interner.intern(rawDoc) : rawDoc;
      const fn: ErbFunction = {
        name,
        normalizedName: name.toUpperCase(),
        params: params.map(([pname, hasDefault]) => ({ name: interner.intern(pname), hasDefault: hasDefault === 1 })),
        startLine,
        endLine,
        filePath: path,
        isExpressionFunction: (flags & FLAG_EXPRESSION) !== 0,
        // v9 的位置契约：第 6 位写成 `null` 是"这条函数没有注释块"（不是缺位，缺位是长度到 5）；
        // 第 7 位 `nameColumn` 同理。A/B 要深比 `byName` 的值 ⇒ 参照臂必须把它解出来，
        // "忽略尾位"只适用于条目级那位溯源摘要，不适用于函数元组内的字段。
        ...(doc === undefined || doc === null ? {} : { docComment: doc }),
        ...(nameColumn === undefined || nameColumn === null ? {} : { nameColumn }),
      };
      return fn;
    });
    out[path] = {
      mtimeMs,
      size,
      textLength,
      file: {
        path,
        functions,
        dims: (dims as unknown as Array<[string, string, number]>).map(([name, directive, line]) => ({
          name: interner.intern(name),
          directive,
          line,
        })),
        hasFunctionDirective: hasDirective === 1,
        lineCount,
      },
      // 引用流水：扁平形状下"逐条复制"就是整条复制（`.slice()`），再把名字过一遍去重表。
      // 不复用盘上那枚数组：参照臂的语义是"当场复制一遍"（旧代码 `refs.map(...)` 的等价成本），
      // 而且就地改会让两条腿共用同一枚数组，交替采样互相污染。
      refs: copyFlatRefs(refs as (string | number)[], interner),
    };
  }
  return out;
}

/** 扁平流水的"逐条复制 + 过去重表"（参照臂专用；生产 `internEntryStrings` 是就地换实例）。 */
function copyFlatRefs(refs: readonly (string | number)[], interner: { intern(s: string): string }): FileRefs {
  const out = refs.slice();
  for (let i = 0; i < out.length; i += REF_STRIDE) out[i] = interner.intern(out[i] as string);
  return out;
}

/* ============================== 基准 ============================== */

const project = buildSyntheticProject();

describe('PERF-7 快照热载合成基准（2,000 文件 / 100,000 函数）', () => {
  // ---- 冷建段：read+parse（v4 / v5 同一份代码——懒还原只动"还原"，不动解析） ----
  const coldFiles: ErbFile[] = [];
  for (let i = 0; i < FILES; i++) coldFiles.push(parseErbText(project.texts[i]!, project.paths[i]!));
  const coldParseMs = medianOf(3, () => {
    for (let i = 0; i < FILES; i++) void parseErbText(project.texts[i]!, project.paths[i]!);
  });

  const coldEntries: Record<string, SnapshotEntry> = {};
  // 引用流水照插件的冷建口径来：判据是**全项目名字表**（`byName`），不是本文件的名字表
  const allNames = new Set<string>();
  for (const f of coldFiles) for (const fn of f.functions) allNames.add(fn.normalizedName);
  const coldRefs: FileRefs[] = [];
  for (let i = 0; i < FILES; i++) {
    coldRefs.push(scanFileRefs(project.texts[i]!, (u) => allNames.has(u)));
    const text = project.texts[i]!;
    coldEntries[project.paths[i]!] = {
      mtimeMs: 1000 + i,
      size: project.bytes[i]!,
      textLength: text.length,
      file: coldFiles[i]!,
      refs: coldRefs[i]!,
    };
  }

  it('合成规模自证（100k 函数 / 码元数 ≠ 字节数 / 引用流水非空）', () => {
    let functions = 0;
    for (const f of coldFiles) functions += f.functions.length;
    expect(functions).toBe(FILES * FN_PER_FILE);

    const totalChars = project.texts.reduce((s, t) => s + t.length, 0);
    const totalBytes = project.bytes.reduce((s, b) => s + b, 0);
    expect(totalBytes).toBeGreaterThan(totalChars); // §68：两口径不可互换

    const refsRun = coldRefs.reduce((s, r) => s + r.length, 0);
    console.log(
      `[perf7][synthetic] ${FILES} 文件 · ${functions} 函数 · ${refsRun} 引用流水条 · ` +
        `正文 ${totalChars} 码元 / ${totalBytes} 字节（比值 ${(totalBytes / totalChars).toFixed(2)}` +
        ` ⇒ textLength 不可当 size）· 冷建 read+parse 段 ${ms(coldParseMs)}`,
    );
    expect(refsRun).toBeGreaterThan(0);
  });

  const payloadV5 = encodeEntries(coldEntries);
  const json = JSON.stringify(payloadV5);
  const parsedV5 = JSON.parse(json) as Record<string, unknown>;

  const encodeMs = medianOf(3, () => void JSON.stringify(encodeEntries(coldEntries)));
  const jsonParseMs = medianOf(3, () => void JSON.parse(json));

  // ---- 热载段 1（coerce）+ 段 2（聚合）：**四条腿同一窗口交替**，各自 median ----
  // 为什么要并成一个窗口：`after ≤ before` 与 `afterTotal ≤ beforeTotal` 是跨腿比较，
  // 而先后两个独立 medianOf(5) 窗口在共享 CPU 上不可比（CI 三条红字即此代价）。
  const afterSnap = coerceSnapshot(
    { version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries: parsedV5 } as unknown as IndexSnapshot,
    ROOT,
  )!;
  const afterFiles = Object.values(afterSnap.entries).map((e) => e.file);
  const beforeEntries = decodeEntriesEager(parsedV5)!;
  const beforeFiles = Object.values(beforeEntries).map((e) => e.file);

  const hotLoad = measureTogether(5, [
    () => {
      const snap = coerceSnapshot({ version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries: parsedV5 }, ROOT);
      if (snap === null) throw new Error('coerce failed');
    },
    () => {
      const snap = decodeEntriesEager(parsedV5);
      if (snap === null) throw new Error('eager decode failed');
    },
    () => void aggregateIndex(afterFiles),
    () => void aggregateIndex(beforeFiles),
  ]);
  const afterCoerceMs = hotLoad[0]!;
  const beforeCoerceMs = hotLoad[1]!;
  const afterAggMs = hotLoad[2]!;
  const beforeAggMs = hotLoad[3]!;

  // ---- 热载段 3：反向引用聚合（v4 每次热开都建；v5 推迟到首次消费） ----
  const refsByPath = new Map<string, FileRefs>();
  for (const [path, e] of Object.entries(afterSnap.entries)) refsByPath.set(path, e.refs!);
  const refsAggregateMs = medianOf(3, () => void buildReferenceIndex(beforeFiles, refsByPath));

  it('热载 coerce：懒还原（after）低于急还原（before），产物逐字段等值', () => {
    // 消费一遍才谈得上"等值"——懒还原不许改语义，只改建对象的时机。
    // 深比 100k 对象本身要秒级 ⇒ 抽样逐字段核（全量等值由 byName 那条兜住）。
    for (const path of [pathOf(0), pathOf(500), pathOf(999), pathOf(1234), pathOf(FILES - 1)]) {
      expect(afterSnap.entries[path]!.file).toEqual(beforeEntries[path]!.file);
      expect(afterSnap.entries[path]!.size).toBe(beforeEntries[path]!.size);
      expect(afterSnap.entries[path]!.refs).toEqual(beforeEntries[path]!.refs);
    }
    console.log(
      `[perf7][coerce] before(v4 急还原) ${ms(beforeCoerceMs)} → after(v5 懒还原) ${ms(afterCoerceMs)}` +
        ` ｜ 省 ${ms(beforeCoerceMs - afterCoerceMs)}（after/before = ${(afterCoerceMs / beforeCoerceMs).toFixed(2)}）·` +
        ` payload ${(json.length / 1048576).toFixed(1)} MiB · encode+stringify(冷建落盘) ${ms(encodeMs)}\n` +
        `[perf7][coerce-形状] 同段共有的 JSON.parse ${ms(jsonParseMs)} —— 懒还原把 decode 打到 ${ms(afterCoerceMs)} 之后，` +
        `热载剩余大头**换成了 JSON.parse**（与还原时机无关，属下一刀：分片/二进制），如实记下`,
    );
    expect(afterCoerceMs).toBeLessThanOrEqual(beforeCoerceMs);
    expect(afterCoerceMs).toBeLessThan(6000); // 病态回归兜底（本机实测的量级之上）
  });

  it('热载 aggregate：元组直吃不新建函数对象，byName 与对象路径逐项一致；**净账**才算 gain', () => {
    const a = aggregateIndex(afterFiles);
    const b = aggregateIndex(beforeFiles);
    expect([...a.byName.keys()]).toEqual([...b.byName.keys()]);
    for (const k of a.byName.keys()) expect(a.byName.get(k)).toEqual(b.byName.get(k));
    // 聚合不许把 functions 的 accessor 消费掉（谁问谁付）——挑一条上面没做深比的路径看
    expect(Object.getOwnPropertyDescriptor(a.files.get(pathOf(1))!, 'functions')?.get).toBeTypeOf('function');

    const definitionSites = [...a.byName.values()].reduce((s, l) => s + l.length, 0);
    const beforeTotalMs = beforeCoerceMs + beforeAggMs;
    const afterTotalMs = afterCoerceMs + afterAggMs;
    console.log(
      `[perf7][aggregate] before(v4 遍历已建对象) ${ms(beforeAggMs)} → after(v5 直吃元组) ${ms(afterAggMs)}` +
        ` ｜ byName ${a.byName.size} 键 / ${definitionSites} 定义点\n` +
        `[perf7][hotload-total] before(coerce+aggregate) ${ms(beforeTotalMs)} → after ${ms(afterTotalMs)}` +
        ` ｜ 净省 ${ms(beforeTotalMs - afterTotalMs)}（after/before = ${(afterTotalMs / beforeTotalMs).toFixed(2)}）` +
        ` —— 如实记录：**aggregate 这一段本身没变快**（元组下标取数比对象单态取数略慢），` +
        `gain 全部来自 decode 不再建 100k 函数对象；代价是把那笔构造推迟到首个消费方`,
    );
    expect(definitionSites).toBe(FILES * FN_PER_FILE);
    // 钉的是**净账**（两段之和），不是逐段——逐段会出现"decode 快了、聚合慢了"的假倒退
    expect(afterTotalMs).toBeLessThanOrEqual(beforeTotalMs);
  });

  it('references：热开不建 bySymbol（这笔开销挪到首次查询），且首建量级可见', () => {
    // after：开项目路径完全不建 bySymbol ⇒ 首次消费才付下面这一笔
    const t0 = performance.now();
    const built = buildReferenceIndex(afterFiles, refsByPath);
    const lazyFirstBuildMs = performance.now() - t0;
    let sites = 0;
    for (const l of built.bySymbol.values()) sites += l.length;
    console.log(
      `[perf7][references] 首次消费才聚合 ${ms(lazyFirstBuildMs)}（${sites} 引用点 / ${built.bySymbol.size} 被名）` +
        ` · 对照 v4 口径（每次热开都聚合）${ms(refsAggregateMs)} ——` +
        ` 热开项目若没人查引用，这一段整体归零`,
    );
    expect(sites).toBeGreaterThan(0);
    expect(lazyFirstBuildMs).toBeLessThan(30000);
  });

  it('落盘快路径：未消费的懒条目原样复用元组（存全库不再重建 100k 元组）', () => {
    // 两条腿各自**独立**的 decode 目标：重建那一腿会把懒条目全部消费掉，
    // 与快路径共用同一份对象就会污染快路径的样本（交替采样必须要求两腿互不干扰）。
    const fastTarget = decodeEntries(parsedV5)!;
    const rebuiltTarget = decodeEntries(parsedV5)!;
    // 先钉"零重建"这件事（消费之后就再也拿不到同一对象了）
    // v12 起候选位在内存里是 `Uint32Array`、盘上要 base64 ⇒ 快路径**浅拷一层**元组换形态，
    // 整枚数组的身份保不住；要省的从来是"重建 10 万级函数元组" ⇒ 判据落在函数/声明/引用三格上。
    const fastTuple = encodeEntries(fastTarget)[pathOf(0)] as unknown[];
    const diskTuple = parsedV5[pathOf(0)] as unknown[];
    expect(fastTuple[5]).toBe(diskTuple[5]);
    expect(fastTuple[6]).toBe(diskTuple[6]);
    expect(fastTuple[7]).toBe(diskTuple[7]);
    const together = measureTogether(7, [
      () => void JSON.stringify(encodeEntries(fastTarget)),
      () => {
        for (const e of Object.values(rebuiltTarget)) void (e.file as ErbFile).functions; // 全部消费 ⇒ 快路径失效
        void JSON.stringify(encodeEntries(rebuiltTarget));
      },
    ]);
    const fastMs = together[0]!;
    const rebuilt = together[1]!;
    console.log(
      `[perf7][encode] 未消费(复用盘上元组) ${ms(fastMs)} → 全消费后(逐字段重建再序列化) ${ms(rebuilt)}` +
        `（同窗交替 n=7，median）｜ 增量落盘（改 1 个文件也要存全库）因此同样不吃这笔重建`,
    );
    expect(fastMs).toBeLessThanOrEqual(rebuilt);
  });
});
