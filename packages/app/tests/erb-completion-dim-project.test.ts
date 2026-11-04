/**
 * `dimNames` 事实格的**项目级口径**（ERH 批，2026-11-04）。
 *
 * Emuera 预载 `ERB/` 下全部 `.erb` / `.erh`（`Preload.cs`），语料里 0 处 `#INCLUDE`
 * ⇒ `.ERH` 与 `.ERB` 是同一个编译单元的两片：`DIM.ERH` 里声明的名字在任何 `.ERB` 里都可见。
 * 事实侧因此要交**全项目**的声明名，而不是只交当前文件那几条——后者会让"正文里写
 * `DIM.ERH` 声明过的变量"一条候选都弹不出来。
 *
 * 这里只测装配件 `dimNamesFor`（纯函数，不碰内核 / Monaco）：`erbCompletionFactsOf` 需要
 * `ITextModel` 与内核登记簿，那是 `erb-completion.test.ts` 那一层的活。六条判据：
 * 1. `.ERH` 里的声明出现在 `.ERB` 的名字表里；
 * 2. 名录按索引遍历顺序交出（**不按当前文件重排**：候选最终按 `sortText` 排序，插入序不参与）；
 * 3. 同一索引下**不同文件共享同一个数组**（按文件派生副本会在堆里按"打开过的文件数"堆名录）；
 * 4. 大小写不敏感去重（同名常量散在多份 `DIM.ERH` 里是常态）；
 * 5. 三态：索引缺席 / 路径不在索引里 ⇒ `undefined`（回退缓冲区），索引确无声明 ⇒ `[]`；
 * 6. 缓存按索引对象失效：同一索引下重复取是同一个数组引用，索引重建后新名字立刻可见。
 *
 * 末尾一条**规模用例**：15 万条合成声明量一次首建与命中，读数打进 stdout（回执要用）。
 */
import { describe, expect, it } from 'vitest';
import { functionLookupOf } from '@kojo/plugin-api';
import type { ErbDim, ErbFile, ErbIndex } from '@kojo/plugin-api';
import { projectDeclaredNames, provideErbCompletion } from '@kojo/plugin-erb-parser';
import { dimNamesFor } from '../src/monaco/erb-completion-facts';

const FILE_ERH = 'C:/game/ERB/RENAME/DIM.ERH';
const FILE_ERB = 'C:/game/ERB/MAIN.ERB';
const FILE_OTHER_ERH = 'C:/game/ERB/RENAME/DIM_MOD.ERH';

function dim(name: string, line: number, directive = 'DIM'): ErbDim {
  return { name, directive, line };
}

function file(path: string, dims: ErbDim[]): ErbFile {
  return { path, functions: [], dims, hasFunctionDirective: false, lineCount: dims.length + 10 };
}

function makeIndex(files: ErbFile[]): ErbIndex {
  return {
    files: new Map(files.map((f) => [f.path, f])),
    byName: functionLookupOf([]),
  } as ErbIndex;
}

describe('dimNamesFor：全项目 #DIM 名', () => {
  const erh = file(FILE_ERH, [dim('好感度', 3), dim('警戒', 4)]);
  const erb = file(FILE_ERB, [dim('本文件变量', 12)]);
  const modErh = file(FILE_OTHER_ERH, [dim('好感度', 7, 'DIMS'), dim('MOD_FLAG', 8)]);
  const index = makeIndex([erh, erb, modErh]);

  it('`.ERH` 里声明的名字进 `.ERB` 的名字表（跨文件可见）', () => {
    const names = dimNamesFor(index, erb);
    expect(names).toBeDefined();
    expect(names).toContain('好感度');
    expect(names).toContain('警戒');
    expect(names).toContain('MOD_FLAG');
  });

  it('名录按索引遍历顺序交出（`files` 插入序 × 文件内声明序），不按当前文件重排', () => {
    expect(dimNamesFor(index, erb)!.slice(0, 4)).toEqual(['好感度', '警戒', '本文件变量', 'MOD_FLAG']);
  });

  it('同一索引下**不同文件**共享同一个数组（不按文件派生副本）', () => {
    // 这条是内存判据：按文件合并出来的每份都是十几万条，下游折叠序索引还会为每份再排
    // 一份副本 ⇒ 堆按"打开过的文件数"线性增长。共享一份就没有这个面。
    expect(dimNamesFor(index, erb)).toBe(dimNamesFor(index, erh));
    expect(dimNamesFor(index, erh)).toBe(dimNamesFor(index, modErh));
  });

  it('按大写归一去重：同名常量散在多份 ERH 里只出一个（首见者原形）', () => {
    const names = dimNamesFor(index, erb)!;
    expect(names.filter((n) => n.toUpperCase() === '好感度')).toEqual(['好感度']);
    expect(names.length).toBe(4);
  });

  it('三态：索引缺席 / 路径不在索引里 ⇒ undefined（回退缓冲区）；索引确无声明 ⇒ []', () => {
    expect(dimNamesFor(null, erb)).toBeUndefined();
    expect(dimNamesFor(index, null)).toBeUndefined();

    const empty = makeIndex([file(FILE_ERB, [])]);
    expect(dimNamesFor(empty, empty.files.get(FILE_ERB)!)).toEqual([]);
  });

  it('缓存：同一索引下重复取是同一引用；索引重建后新名字立刻可见', () => {
    const first = dimNamesFor(index, erb);
    expect(dimNamesFor(index, erb)).toBe(first);

    const rebuilt = makeIndex([file(FILE_ERH, [dim('新加的', 9)]), file(FILE_ERB, [])]);
    const names = dimNamesFor(rebuilt, rebuilt.files.get(FILE_ERB)!)!;
    expect(names).toContain('新加的');
    expect(names).not.toContain('好感度');
    expect(names).not.toBe(first);
  });
});

describe('dimNamesFor：15 万条规模', () => {
  const FILES = 500;
  const PER_FILE = 300; // 15 万条声明
  const files: ErbFile[] = [];
  for (let f = 0; f < FILES; f++) {
    const dims: ErbDim[] = [];
    for (let i = 0; i < PER_FILE; i++) {
      // 每 10 条重名一次：模拟 `DIM.ERH` 被多份 mod 各带一份的重复面
      dims.push(dim(`PROJECT_VAR_${String(i % 270)}_${String(f)}`, i + 1));
    }
    files.push(file(`C:/game/ERB/F${String(f)}.ERH`, dims));
  }
  const target = file('C:/game/ERB/MAIN.ERB', [dim('PROJECT_VAR_0_0', 1), dim('OWN_ONLY', 2)]);

  const build = (): ErbIndex => {
    const index = makeIndex(files);
    index.files.set(target.path, target);
    return index;
  };

  it('首建与命中读数（回执用），首建是一次线性扫描 + 一次归一去重', () => {
    const t0 = performance.now();
    const first = dimNamesFor(build(), target)!;
    const coldMs = performance.now() - t0;

    const warm = build();
    const t1 = performance.now();
    projectDeclaredNames(warm); // 基础名录（`dim-index.ts` 的一次性成本，导航 / 诊断共摊）
    const baseMs = performance.now() - t1;

    const t2 = performance.now();
    const built = dimNamesFor(warm, target)!;
    const dedupeMs = performance.now() - t2;

    const t3 = performance.now();
    const again = dimNamesFor(warm, target)!;
    const hitMs = performance.now() - t3;

    console.log(
      `[dimNamesFor] 声明 ${String(FILES * PER_FILE)} 条 / 去重后 ${String(first.length)} 条：` +
        `冷启 ${coldMs.toFixed(1)}ms（其中基础名录 ${baseMs.toFixed(1)}ms + 本格去重 ` +
        `${dedupeMs.toFixed(1)}ms）/ 命中 ${hitMs.toFixed(3)}ms`,
    );

    expect(first.length).toBe(270 * FILES + 1); // 去重后 + 当前文件独占那一条
    expect(first[0]).toBe('PROJECT_VAR_0_0');
    expect(first).toContain('OWN_ONLY');
    expect(built).toEqual(first);
    expect(again).toBe(built); // 第二轮零成本（同一索引共享同一个数组）
    // 读数只用于回执：这里不断言墙钟阈值——本仓把"带墙钟断言的用例"划进串行计时池
    // （`tools/perf-suite.mjs` 的源码谓词），那样它就进不了 `erb-completion` 这一组功能用例。
    expect([coldMs, baseMs, dedupeMs, hitMs].every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});

describe('全项目名录喂给补全供方', () => {
  /** 15 万条同名族的名字（模拟 `DIM.ERH` 级别）；前缀命中数远超装配上限 */
  const dims = Array.from({ length: 150000 }, (_, i) => `PROJECT_VAR_${String(i)}`);

  const ask = (text: string, column: number) =>
    provideErbCompletion({
      kind: 'completion',
      languageId: 'kojo-erb',
      path: 'C:/game/ERB/MAIN.ERB',
      version: 1,
      project: null,
      text: `${text}\n`,
      line: 1,
      column,
      facts: { dimNames: dims },
    });

  it('前缀命中数千条时按装配上限封顶（不再把整张名录造成候选）', () => {
    const result = ask('  PROJECT_VAR_1', '  PROJECT_VAR_1'.length + 1);
    const items = result?.kind === 'completion' ? result.items : [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(1000);
  });

  it('整名前缀仍给出精确那一条（排序档 0 在前）', () => {
    const line = '  PROJECT_VAR_149999';
    const result = ask(line, line.length + 1);
    const items = result?.kind === 'completion' ? result.items : [];
    expect(items[0]?.label).toBe('PROJECT_VAR_149999');
  });
});

describe('对拍：旧（全量线性扫）vs 新（折叠序前缀索引）', () => {
  /**
   * 1,000 条 + 几枚大小写/非 ASCII 特例。名录规模压在千条以内是为了让"前缀命中"始终
   * 远小于装配上限——上限一旦介入，新旧两条路的截断口径就不同了，对拍会变成测上限。
   */
  const dims: string[] = [];
  for (let i = 0; i < 1000; i++) dims.push(`変数_${String(i)}`);
  dims.push('ABC_1', 'abc_1', 'ABC_2', 'Z_9', 'ｱｲｳ');

  /** 改前 `declaredCandidates` 的循环原样搬来当参照（只造候选，不做 merge） */
  function oldPath(prefix: string): readonly string[] {
    const needle = prefix.toUpperCase();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of dims) {
      if (name.length === 0) continue;
      const upper = name.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      if (needle.length > 0 && !upper.startsWith(needle)) continue;
      out.push(name);
    }
    return out;
  }

  /** 供方输出里只留声明名那一路（`detail` 是这条腿独有的字面） */
  function newPath(prefix: string): readonly string[] {
    const text = `  ${prefix}`;
    const result = provideErbCompletion({
      kind: 'completion',
      languageId: 'kojo-erb',
      path: 'C:/game/ERB/MAIN.ERB',
      version: 1,
      project: null,
      text: `${text}\n`,
      line: 1,
      column: text.length + 1,
      facts: { dimNames: dims },
    });
    const items = result?.kind === 'completion' ? result.items : [];
    return items.filter((i) => i.detail === '#DIM 声明').map((i) => i.label);
  }

  for (const prefix of ['変', '変数_9', '変数_99', 'ABC', 'abc', 'ABC_1', 'Z_', 'ｱ']) {
    it(`前缀「${prefix}」：两条路的候选集合逐条相等`, () => {
      const want = [...oldPath(prefix)].sort();
      const got = [...newPath(prefix)].sort();
      expect(got).toEqual(want);
      expect(got.length).toBeGreaterThan(0);
      // 大小写不同的同名（ABC_1 / abc_1）只出一个，且是名录里先出现的那一个
      if (prefix.toUpperCase() === 'ABC_1') expect(got).toEqual(['ABC_1']);
    });
  }
});
