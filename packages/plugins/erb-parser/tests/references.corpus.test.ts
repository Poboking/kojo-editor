/**
 * 反向引用索引 · 真实语料自证（H2 批；`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，不在位自动跳过）。
 *
 * 钉死四类事实（全部**实测**，不许引用估计）：
 * 1. **规模与不变量**：引用点总数 / 种类分布 / `bySymbol` 与 `byName` 同键、
 *    定义种类计数 === 函数总数（反向边不漏定义）、路径全部 ∈ 索引文件集；
 * 2. **正确性对拍**：抽样文件用**独立实现的朴素扫描**（无正则 exec、字符串刷白方式不同）
 *    产出逐引用点元组全等；另抽样引用点回原文验证记号边界 / 注释外 / 字符串外；
 * 3. **成本读数**：冷建 refs 段耗时（取自插件 breakdown 日志）+ 独立重扫的分项计时
 *    （读盘 vs 纯扫描）+ 查询均摊；
 * 4. **内存**：references 索引堆增量（`--expose-gc` 时有真读数；无 gc 则报 heapUsed 差值）。
 *    纪律复核：全程文本只逐份在手（412 万行不留驻），驻留的只有紧凑流水与物化引用表。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbIndex, ErbParserService, Logger } from '@kojo/plugin-api';
import { createKernel } from '../../../kernel/src/kernel';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { buildReferenceIndex, referencesOf, scanFileRefs, type FileRefs } from '../src/references';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const KOJO_ROOT_REL = ['ERB', '口上・メッセージ関連', '個人口上'];

const isIdChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isColon = (c: string | undefined): boolean => c === ':' || c === '：';

/**
 * 朴素对拍实现（**故意与 src/references.ts 走不同的代码路径**：手写走位、
 * split 求首词、逐字符构串；同一口径下的第二个独立判定器）。
 */
function naiveScan(text: string, hasName: (upper: string) => boolean): FileRefs {
  const lines = text.split(/\r\n|\r|\n/);
  const CALLS = new Set(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST']);
  const out: [string, number, number, 0 | 1 | 2][] = [];
  let inSkip = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const t = line.trim();
    if (inSkip) {
      if (t === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (t === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (t === '' || t.startsWith(';') || t.startsWith('#') || t.startsWith('$')) continue;
    if (t.startsWith('@')) {
      const at = line.indexOf('@');
      let j = at + 1;
      while (j < line.length && line[j] !== '(' && line[j] !== ' ' && line[j] !== '\t' && line[j] !== ';') j++;
      const slice = line.slice(at + 1, j);
      const upper = slice.trim().toUpperCase();
      if (upper !== '' && hasName(upper)) out.push([upper, li + 1, at + 2 + (slice.length - slice.trimStart().length), 0]);
      continue;
    }
    // 代码视野：配对串刷白；落单引号到行尾；再截第一个 `;`（逐字符构串，非正则替换）
    let code = '';
    let q = false;
    let comment = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (comment) {
        code += ' ';
        continue;
      }
      if (q) {
        if (c === '"') q = false;
        code += ' ';
        continue;
      }
      if (c === '"') {
        q = true;
        code += ' ';
        continue;
      }
      if (c === ';') {
        comment = true;
        code += ' ';
        continue;
      }
      code += c;
    }
    const leadWord = (t.split(/[^A-Za-z0-9_]/)[0] ?? '').toUpperCase();
    const callLine = CALLS.has(leadWord);
    const indent = /^[\t ]*/.exec(line)![0].length;
    const slotStart = callLine ? indent + leadWord.length : -1;
    let i = 0;
    let slotFree = callLine;
    while (i < code.length) {
      if (!isIdChar(code[i])) {
        i++;
        continue;
      }
      let j = i;
      while (isIdChar(code[j])) j++;
      const inSlot = slotFree && i >= slotStart;
      if (inSlot) slotFree = false;
      if (!isColon(code[i - 1]) && !isColon(code[j])) {
        const run = code.slice(i, j).toUpperCase();
        if (hasName(run)) out.push([run, li + 1, i + 1, inSlot ? 1 : 2]);
      }
      i = j;
    }
  }
  return out;
}

/** 固定种子 LCG（语料对拍的抽样必须可复现） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe.skipIf(!SMOKE)('反向引用索引 · 真实语料自证', () => {
  it('规模 / 不变量 / 朴素对拍 / 构建·查询耗时 / 内存驻留', async () => {
    const root = join(SMOKE!, ...KOJO_ROOT_REL);
    const appData = mkdtempSync(join(tmpdir(), 'kojo-refs-'));
    const infoLines: string[] = [];
    const logger: Logger = { ...silent, info: (m: string) => infoLines.push(m) };
    const kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [createErbParserPlugin()],
      storageBackend: new MemoryStorageBackend(),
      logger,
    });
    await kernel.start();
    const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;
    const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    try {
      const parser = kernel.services.get<ErbParserService>('erb.parser');

      // ---- 冷建全量索引（含 refs 段），插件 breakdown 日志给分段读数 ----
      const t0 = performance.now();
      const index = await parser.buildIndex([root]);
      const coldMs = performance.now() - t0;
      const breakdown = infoLines.find((m) => m.includes('index breakdown')) ?? '';
      // PERF-7 起 bySymbol 惰性聚合：buildIndex 只报扫描段（rescan = 全量），
      // 聚合读数在首次消费 `index.references` 时打（下方取用后即可读到）。
      const refsLog = /refs scan (\d+)ms \(rescan (\d+), aggregate deferred\)/.exec(breakdown);
      expect(refsLog, `插件未打出 refs 扫描读数行：${breakdown}`).not.toBeNull();
      void index.references; // 首次消费 ⇒ 触发惰性聚合，下方读 on-demand 读数行
      const onDemand = infoLines.find((m) => m.includes('references built on demand')) ?? '';
      const onDemandLog = /\((\d+) sites, (\d+)ms; scan (\d+)ms, rescan (\d+), snapshot (\d+)\)/.exec(onDemand);
      expect(onDemandLog, `插件未打出惰性聚合读数行：${onDemand}`).not.toBeNull();

      // ---- 1. 规模与不变量 ----
      let functions = 0;
      for (const f of index.files.values()) functions += f.functions.length;
      const refs = index.references!;
      let sites = 0;
      let defSites = 0;
      let callSites = 0;
      for (const list of refs.bySymbol.values()) {
        sites += list.length;
        for (const r of list) {
          if (r.kind === 'definition') defSites++;
          else if (r.kind === 'call') callSites++;
        }
      }
      const walkOrder = new Map<string, number>();
      [...index.files.keys()].forEach((p, i) => walkOrder.set(p, i));
      console.log(
        `[refs] 语料：文件 ${index.files.size} / 函数 ${functions}（去重名 ${index.byName.size}）/ ` +
          `引用点 ${sites}（定义 ${defSites} · 调用 ${callSites} · 提及 ${sites - defSites - callSites}）/ ` +
          `被名 ${refs.bySymbol.size}`,
      );
      console.log(
        `[refs] 冷建：总 ${coldMs.toFixed(0)}ms；扫描 refs scan ${refsLog![1]}ms（重扫 ${refsLog![2]}）· ` +
          `惰性聚合 ${onDemandLog![2]}ms（${onDemandLog![1]} sites），快照路径本批语料未走（service.buildIndex 强制重建）`,
      );

      expect(functions).toBeGreaterThanOrEqual(90_000); // 与 erh 批同闸（历史读数 99,104）
      const missingNames = [...index.byName.keys()].filter((n) => !refs.bySymbol.has(n));
      expect(missingNames, `定义名无反向条目：${missingNames.slice(0, 8).join(' / ')}`).toEqual([]);
      expect(defSites, '定义种类引用点数 === 函数总数（反向边不漏定义）').toBe(functions);
      const leakedPaths = new Set<string>();
      for (const list of refs.bySymbol.values()) for (const r of list) if (!index.files.has(r.filePath)) leakedPaths.add(r.filePath);
      expect([...leakedPaths], '引用点路径必须都在索引文件集里').toEqual([]);

      // 顺序确定性抽样：50 个名的引用表按 (walk序, 行, 列) 单调
      const keys = [...refs.bySymbol.keys()];
      const pick = rng(20261015);
      for (let k = 0; k < 50; k++) {
        const list = refs.bySymbol.get(keys[Math.floor(pick() * keys.length)]!)!;
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1]!;
          const b = list[i]!;
          const ok =
            walkOrder.get(a.filePath)! < walkOrder.get(b.filePath)! ||
            (a.filePath === b.filePath && (a.line < b.line || (a.line === b.line && a.column <= b.column)));
          expect(ok, `引用表乱序：${a.filePath}:${a.line}:${a.column} vs ${b.filePath}:${b.line}:${b.column}`).toBe(true);
        }
      }

      // ---- 2. 朴素对拍：抽样文件逐引用点全等 ----
      const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));
      const allPaths = [...index.files.keys()];
      const hasNameUpper = (u: string): boolean => index.byName.has(u);
      const sampleIdx = [0, 0.13, 0.27, 0.41, 0.55, 0.63, 0.78, 0.86, 0.91, 0.99].map((f) =>
        Math.min(allPaths.length - 1, Math.floor(f * allPaths.length)),
      );
      let oracleFiles = 0;
      let oracleSites = 0;
      let scanOnlyMs = 0;
      let readMs = 0;
      let textMaxLen = 0;
      for (const pi of sampleIdx) {
        const path = allPaths[pi]!;
        const r0 = performance.now();
        const tf = await io.readText(path);
        readMs += performance.now() - r0;
        textMaxLen = Math.max(textMaxLen, tf.text.length);
        const s0 = performance.now();
        const got = scanFileRefs(tf.text, hasNameUpper).map((r) => r.join(':')).sort();
        const want = naiveScan(tf.text, hasNameUpper).map((r) => r.join(':')).sort();
        scanOnlyMs += performance.now() - s0;
        expect(got, `朴素对拍不符：${path}`).toEqual(want);
        oracleFiles++;
        oracleSites += got.length;
      }
      console.log(
        `[refs] 对拍：${oracleFiles} 份文件 / ${oracleSites} 个引用点与朴素实现全等；` +
          `纯扫描 ${scanOnlyMs.toFixed(0)}ms（读盘 ${readMs.toFixed(0)}ms 另计）`,
      );

      // ---- 2b. 抽样引用点回原文验证：边界 / 注释外 / 字符串外 / 种类判据 ----
      let checked = 0;
      for (let k = 0; k < 40; k++) {
        const nk = keys[Math.floor(pick() * keys.length)]!;
        const list = refs.bySymbol.get(nk)!;
        if (list.length === 0) continue;
        const r = list[Math.floor(pick() * list.length)]!;
        const tf = await io.readText(r.filePath);
        const line = tf.text.split(/\r\n|\r|\n/)[r.line - 1]!;
        const slice = line.slice(r.column - 1, r.endColumn - 1);
        expect(slice.toUpperCase(), `引用点原文不符：${r.filePath}:${r.line}`).toBe(nk);
        expect(isIdChar(line[r.column - 2]), `左边界粘连：${r.filePath}:${r.line}:${r.column}`).toBe(false);
        expect(isIdChar(line[r.endColumn - 1]), `右边界粘连：${r.filePath}:${r.line}`).toBe(false);
        // 注释/字符串外：column 之前的引号数必须成对，且 `;`（引号外）不早于 column
        let quotes = 0;
        let semi = -1;
        for (let i = 0; i < r.column - 1; i++) {
          const c = line[i]!;
          if (c === '"') quotes++;
          else if (c === ';' && quotes % 2 === 0 && semi < 0) semi = i;
        }
        expect(quotes % 2, `落在字符串里：${r.filePath}:${r.line}:${r.column}`).toBe(0);
        expect(semi < 0, `落在注释里：${r.filePath}:${r.line}:${r.column}`).toBe(true);
        if (r.kind === 'definition') expect(line.trim().startsWith(`@${slice}`), `定义行形态不符：${r.filePath}:${r.line}`).toBe(true);
        if (r.kind === 'call') {
          const lead = (line.trim().split(/[^A-Za-z0-9_]/)[0] ?? '').toUpperCase();
          expect(['CALL', 'TRYCALL', 'TRYCCALL', 'TRYCALLLIST', 'TRYCCALLLIST'], `调用行首词不符：${line}`).toContain(lead);
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(20);

      // ---- 3. 查询耗时：全量名 referencesOf（含命中与未命中）----
      const q0 = performance.now();
      let qHits = 0;
      for (let i = 0; i < 20_000; i++) {
        const n = keys[i % keys.length]!;
        qHits += referencesOf(index, n.toLowerCase()).length;
        referencesOf(index, `NOT_A_NAME_${i}`);
      }
      const qMs = performance.now() - q0;
      console.log(
        `[refs] 查询：40,000 次 referencesOf（含大小写混查与未命中）共 ${qMs.toFixed(1)}ms，` +
          `命中总表长 ${qHits}，均摊 ${((qMs * 1000) / 40_000).toFixed(2)}µs/次`,
      );
      expect(qMs / 40_000).toBeLessThan(1); // 均摊 <1ms（纯内存 Map 查询）

      // ---- 4. 内存驻留：references 索引本体堆增量 ----
      gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const refsByPath = new Map<string, FileRefs>();
      let fullScanMs = 0;
      let fullReadMs = 0;
      for (const path of allPaths) {
        const r0 = performance.now();
        const tf = await io.readText(path);
        fullReadMs += performance.now() - r0;
        const s0 = performance.now();
        refsByPath.set(path, scanFileRefs(tf.text, hasNameUpper));
        fullScanMs += performance.now() - s0;
      }
      const filesIterable = [...index.files.values()];
      const standalone = buildReferenceIndex(filesIterable, refsByPath);
      let standaloneSites = 0;
      for (const l of standalone.bySymbol.values()) standaloneSites += l.length;
      expect(standaloneSites, '独立重建的引用点总数必须与冷建逐位一致').toBe(sites);
      gc?.();
      const heapAfter = process.memoryUsage().heapUsed;
      const delta = heapAfter - heapBefore;
      console.log(
        `[refs] 全库独立重扫：读盘 ${fullReadMs.toFixed(0)}ms + 纯扫描 ${fullScanMs.toFixed(0)}ms（${allPaths.length} 份）；` +
          `驻留增量 ${mb(delta)}（流水+索引，${gc ? 'gc 校准' : 'heapUsed 粗测'}），` +
          `平均每引用点 ${(delta / Math.max(1, standaloneSites)).toFixed(1)}B；` +
          `文本驻留复核：单次最大一份 ${mb(textMaxLen * 2)}（无整库留驻）`,
      );
      expect(delta, '引用索引驻留必须有硬上界').toBeLessThan(512 * 1024 * 1024);
      expect(fullScanMs).toBeLessThan(coldMs); // 纯扫描必须显著轻于整条冷建（分母=412万行级）
    } finally {
      await kernel.stop();
    }
  }, 600_000);
});
