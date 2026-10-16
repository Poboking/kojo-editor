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
import { buildReferenceIndex, scanFileRefs, type FileRefs } from '../src/references';
import {
  aggregateIndex,
  coerceSnapshot,
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
  for (const [path, value] of Object.entries(raw)) {
    const t = value as unknown[];
    if (
      t.length !== 9 ||
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
      (x.length === 5 || x.length === 6) &&
      typeof x[0] === 'string' &&
      typeof x[1] === 'number' &&
      typeof x[2] === 'number' &&
      Array.isArray(x[3]) &&
      x[3].every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && (p[1] === 0 || p[1] === 1)) &&
      typeof x[4] === 'number' &&
      (x.length === 5 || typeof x[5] === 'string');
    const okRef = (x: unknown): boolean =>
      Array.isArray(x) &&
      x.length === 4 &&
      typeof x[0] === 'string' &&
      typeof x[1] === 'number' &&
      typeof x[2] === 'number' &&
      (x[3] === 0 || x[3] === 1 || x[3] === 2);
    const okLabel = (x: unknown): boolean =>
      Array.isArray(x) && x.length === 3 && typeof x[0] === 'string' && typeof x[1] === 'number' && typeof x[2] === 'number';
    if (!fns.every(okFn)) return null;
    if (!dims.every((d) => Array.isArray(d) && d.length === 3 && typeof d[0] === 'string' && typeof d[1] === 'string' && typeof d[2] === 'number')) {
      return null;
    }
    if (!refs.every(okRef)) return null;
    if (!labels.every(okLabel)) return null;
    const functions: ErbFunction[] = fns.map((x) => {
      const [name, startLine, endLine, params, flags, doc] = x as unknown as [
        string,
        number,
        number,
        Array<[string, number]>,
        number,
        string?,
      ];
      const fn: ErbFunction = {
        name,
        normalizedName: name.toUpperCase(),
        params: params.map(([pname, hasDefault]) => ({ name: pname, hasDefault: hasDefault === 1 })),
        startLine,
        endLine,
        filePath: path,
        isExpressionFunction: (flags & FLAG_EXPRESSION) !== 0,
        ...(doc === undefined ? {} : { docComment: doc }),
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
          name,
          directive,
          line,
        })),
        hasFunctionDirective: hasDirective === 1,
        lineCount,
      },
      refs: (refs as unknown as Array<[string, number, number, 0 | 1 | 2]>).map(
        ([name, line, column, kind]) => [name, line, column, kind] as never,
      ),
    };
  }
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

  // ---- 热载段 1：coerce（JSON.parse 之后 → 条目可用） ----
  const afterCoerceMs = medianOf(5, () => {
    const snap = coerceSnapshot({ version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries: parsedV5 }, ROOT);
    if (snap === null) throw new Error('coerce failed');
  });
  const beforeCoerceMs = medianOf(5, () => {
    const snap = decodeEntriesEager(parsedV5);
    if (snap === null) throw new Error('eager decode failed');
  });

  // ---- 热载段 2：聚合（byName） ----
  const afterSnap = coerceSnapshot(
    { version: SNAPSHOT_VERSION, rootDir: ROOT, savedAt: 1, entries: parsedV5 } as unknown as IndexSnapshot,
    ROOT,
  )!;
  const afterFiles = Object.values(afterSnap.entries).map((e) => e.file);
  const beforeEntries = decodeEntriesEager(parsedV5)!;
  const beforeFiles = Object.values(beforeEntries).map((e) => e.file);

  const afterAggMs = medianOf(5, () => void aggregateIndex(afterFiles));
  const beforeAggMs = medianOf(5, () => void aggregateIndex(beforeFiles));

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
    const decoded = decodeEntries(parsedV5)!;
    // 先钉"零重建"这件事（消费之后就再也拿不到同一对象了）
    expect(encodeEntries(decoded)[pathOf(0)]).toBe(parsedV5[pathOf(0)]);
    const fastMs = medianOf(3, () => void JSON.stringify(encodeEntries(decoded)));
    const rebuilt = medianOf(3, () => {
      for (const e of Object.values(decoded)) void (e.file as ErbFile).functions; // 全部消费 ⇒ 快路径失效
      void JSON.stringify(encodeEntries(decoded));
    });
    console.log(
      `[perf7][encode] 未消费(复用盘上元组) ${ms(fastMs)} → 全消费后(逐字段重建再序列化) ${ms(rebuilt)}` +
        ` ｜ 增量落盘（改 1 个文件也要存全库）因此同样不吃这笔重建`,
    );
    expect(fastMs).toBeLessThanOrEqual(rebuilt);
  });
});
