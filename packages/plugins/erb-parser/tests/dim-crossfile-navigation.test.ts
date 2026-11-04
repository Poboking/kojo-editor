/**
 * 跨文件 `#DIM` 的 F12 / 悬停（2026-11-04 ERH 批消费侧）。
 *
 * `.ERH` 不是"被 include 的头文件"——引擎把 `.erb` / `.erh` 一起预载（8 盘语料 0 处
 * `#INCLUDE`），名字在 `.ERH` 声明、在 `.ERB` 使用是常态。此前两条腿都只吃当前文件：
 * F12 得到空、悬停什么也不出。本文件钉四件事：
 *
 * 1. **跨文件能答**：`.ERB` 引用 → `.ERH` 的声明行；
 * 2. **不伪造列**：跨文件落点 `column` 恒 1、**不带 `span`**（索引只有行事实）；
 * 3. **本文件优先**：当前文件里就有同名声明时，不把别处的同名常量塞进结果（F12 不是选择题）；
 * 4. **`index` 缺省 = 旧行为**：老调用方一行不改，拿到的东西与加这一腿之前逐字相同。
 */

import { describe, expect, it } from 'vitest';
import { functionLookupOf } from '@kojo/plugin-api';
import type { EditorLanguageServiceRequest, ErbDim, ErbFile, ErbIndex } from '@kojo/plugin-api';
import { provideErbDefinition } from '../src/plugin';
import { resolveErbHoverAt } from '../src/completion';
import { resolveErbDimDefinition } from '../src/symbols';

const ERH = 'C:/game/ERB/DIM.ERH';
const ERB = 'C:/game/ERB/口上・メッセージ関連/KOJO.ERB';

/** 只有声明事实的索引（`dims` 的行号是这份索引唯一能保证的东西） */
function makeIndex(files: ErbFile[]): ErbIndex {
  return {
    files: new Map(files.map((f) => [f.path, f])),
    byName: functionLookupOf([]),
  } as unknown as ErbIndex;
}

function dim(name: string, directive: string, line: number): ErbDim {
  return { name, directive, line };
}

function file(path: string, dims: ErbDim[], lineCount = 40): ErbFile {
  return { path, functions: [], dims, hasFunctionDirective: false, lineCount };
}

/** `.ERH` 第 3 行声明 `KOJO_ACTIVE_NAME`（`DIMS` 字符串型，与真实语料同形） */
const ERH_FILE = file(ERH, [dim('KOJO_ACTIVE_NAME', 'DIMS', 3)]);

/** `.ERB` 里只有**使用**，没有声明 */
const USE_TEXT = ['@MAIN', '  PRINTL KOJO_ACTIVE_NAME', '  KOJO_ACTIVE_NAME = "x"'].join('\n');
const USE_INDEX = makeIndex([ERH_FILE, file(ERB, [], 3)]);

const defReq = (line: number, column: number, text = USE_TEXT, path = ERB): EditorLanguageServiceRequest =>
  ({ kind: 'definition', path, text, line, column, project: null }) as EditorLanguageServiceRequest;

describe('F12 · `.ERB` 的引用 → `.ERH` 的声明', () => {
  it('跨文件命中：落点给 `文件 + 行`，列恒 1、不给 span（索引无列事实）', () => {
    const out = provideErbDefinition(defReq(2, 10), USE_INDEX);
    expect(out).toEqual({
      kind: 'definition',
      locations: [{ filePath: ERH, line: 3, column: 1 }],
    });
    // 不编区间：`span` 一旦出现，宿主就会按它高亮——那是假事实
    expect(out!.locations[0]!.span).toBeUndefined();
  });

  it('直接调判据同样跨文件（`index` 是可选第 5 参）', () => {
    expect(resolveErbDimDefinition(USE_TEXT, 2, 10, ERB, USE_INDEX)).toEqual([
      { filePath: ERH, line: 3, column: 1 },
    ]);
  });

  it('`index` 缺省 / 为 null ⇒ 与旧行为逐字一致（空），本文件腿也不受影响', () => {
    expect(resolveErbDimDefinition(USE_TEXT, 2, 10, ERB)).toEqual([]);
    expect(resolveErbDimDefinition(USE_TEXT, 2, 10, ERB, null)).toEqual([]);
    expect(provideErbDefinition(defReq(2, 10), null)).toEqual({ kind: 'definition', locations: [] });
  });

  it('本文件有同名声明 ⇒ 只答本文件（列精确、带 span），不混入 `.ERH` 的同名常量', () => {
    const text = ['@MAIN', '  #DIMS KOJO_ACTIVE_NAME = "局部"', '  PRINTL KOJO_ACTIVE_NAME'].join('\n');
    const index = makeIndex([ERH_FILE, file(ERB, [dim('KOJO_ACTIVE_NAME', 'DIMS', 2)], 3)]);
    const out = provideErbDefinition(defReq(3, 10, text), index);
    expect(out!.locations).toEqual([
      { filePath: ERB, line: 2, column: 9, span: { columnStart: 9, columnEnd: 25 } },
    ]);
  });

  it('索引里根本没有这个名字 ⇒ 仍作答（空数组），不是弃权', () => {
    expect(provideErbDefinition(defReq(3, 10, '  KOJO_ACTIVE_NAME = "x"'), USE_INDEX)).toEqual({
      kind: 'definition',
      locations: [],
    });
  });
});

describe('悬停 · 跨文件声明', () => {
  /** 与产品同一条取法：`erbIndex` 是惰性 getter */
  const tables = { erbIndex: () => USE_INDEX };

  it('命中 `.ERH`：正文给出「声明于 文件:行」，不编初值 / 类型', () => {
    const hit = resolveErbHoverAt('  PRINTL KOJO_ACTIVE_NAME', 10, tables, ERB);
    expect(hit?.kind).toBe('#DIMS 声明');
    expect(hit?.name).toBe('KOJO_ACTIVE_NAME');
    expect(hit?.lines).toEqual([`声明于 \`${ERH}:3\``]);
    expect(hit?.source).toEqual({ filePath: ERH, line: 3 });
    // 手上没有那一行原文 ⇒ 不许写「声明：」「初值：」，也不许说"本文件"
    expect(hit?.lines?.some((l) => l.includes('初值') || l.includes('本文件'))).toBe(false);
  });

  it('落点很多时只列前几处，余下折成一行指路（提示框不是选择器）', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      file(`C:/game/ERB/mod${i + 1}/DIM.ERH`, [dim('KOJO_ACTIVE_NAME', 'DIMS', i + 1)], 12),
    );
    const index = makeIndex([...many, file(ERB, [], 3)]);
    const hit = resolveErbHoverAt('  PRINTL KOJO_ACTIVE_NAME', 10, { erbIndex: () => index }, ERB);
    expect(hit?.lines).toHaveLength(7);
    expect(hit?.lines?.slice(0, 6)).toEqual(
      many.slice(0, 6).map((f) => `声明于 \`${f.path}:${f.dims[0]!.line}\``),
    );
    expect(hit?.lines?.[6]).toBe('另有 3 处同名声明（F12 看全部）');
    // 落点仍是第一处：折叠不改"去哪一行"的默认答案
    expect(hit?.source).toEqual({ filePath: many[0]!.path, line: 1 });
  });

  it('本文件就有声明时走原路（声明原文 / 初值照旧，落点是本文件）', () => {
    const text = ['#DIMS KOJO_ACTIVE_NAME = "小明"', '  PRINTL KOJO_ACTIVE_NAME'].join('\n');
    const index = makeIndex([file(ERB, [dim('KOJO_ACTIVE_NAME', 'DIMS', 1)], 2)]);
    const hit = resolveErbHoverAt(text.split('\n')[1]!, 10, { erbIndex: () => index }, ERB, {
      line: 2,
      readSourceLine: (n) => text.split('\n')[n - 1],
    });
    expect(hit?.lines?.[0]).toBe(`声明于 \`${ERB}:1\``);
    expect(hit?.lines).toContain('声明：`#DIMS KOJO_ACTIVE_NAME = "小明"`');
    expect(hit?.lines).toContain('初值：`"小明"`');
  });
});
