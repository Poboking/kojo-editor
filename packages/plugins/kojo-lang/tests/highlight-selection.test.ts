/**
 * B3f 同符号高亮 / 结构化扩选两条腿的供方闸（`src/highlight.ts` + `src/selection-range.ts` +
 * `plugin.ts` 接线）。
 *
 * 五组断言，各自防一种真实退化：
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——混成空结果会把宿主那门语言自己的
 *    provider 顶掉；
 * 2. **三档都穿过契约**：write / read / text 一格不塌（塌档的表现是"声明与引用同色"）；
 * 3. **位置门在包里**：字符串字面量 / `@原生` 围栏 / 题注里的同名词 / 表体数据行不误报；
 * 4. **空结果语义**：认这门语言、光标下没有声明符号 ⇒ `highlights: []`（**作答**，
 *    不是弃权）；
 * 5. **多位置对齐**：`selections` 与 `positions` 同序同长，越界位点 `null`（不夹取），
 *    且某一格空链不缩短外层。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import {
  createKojoLangPlugin,
  provideDocumentHighlights,
  provideSelectionRanges,
} from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo';

/** 高亮夹具：声明 / 字符串 / 表体 / 原生体 / 旁白 / 插值各占一行 */
const HILITE = [
  '// 心情', // 1 注释
  '# 幕 神社清晨', // 2
  '# 设 心情 整数 = 0 存档', // 3
  '# 设 引号 字符串 = "心情"', // 4 字符串字面量
  '# 对照表 心情表 依据 心情', // 5
  '    0..99 -> 疏远', // 6
  '    100..499 -> 心情', // 7 表体数据行
  '', // 8
  '> 心情', // 9 text 档
  '灵梦：「{心情}今天。」', // 10 插值 = read
  '@原生', // 11
  '    心情 = 1', // 12 原生体（不误报）
].join('\n');

/** 扩选夹具：一个函体 + 一个越界位点的落点 */
const SELECT = ['# 幕 一', '@函 甲()', '    心情 = 1', '', '> 正文'].join('\n');

function highlightRequest(line: number, column: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'documentHighlight' as const,
    path: PATH,
    text: HILITE,
    line,
    column,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

function selectionRequest(
  positions: ReadonlyArray<{ line: number; column: number }>,
  over: Record<string, unknown> = {},
) {
  return {
    kind: 'selectionRange' as const,
    path: PATH,
    text: SELECT,
    project: null,
    languageId: 'kojo2',
    positions,
    ...over,
  } as never;
}

/** 起插件、抓 `ui.editor.languageService` 的贡献（真实接线形状，不手搓注入） */
function activate(): Map<string, EditorLanguageServiceContribution> {
  const contributions = new Map<string, EditorLanguageServiceContribution>();
  const ctx = {
    pluginId: 'kojo-lang',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    slots: {
      register: (slot: string, item: EditorLanguageServiceContribution) => {
        if (slot === 'ui.editor.languageService') contributions.set(item.id, item);
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  createKojoLangPlugin().activate(ctx);
  return contributions;
}

/* ============================== ① 语言过滤 ============================== */

describe('语言过滤：只答 kojo2（其余弃权，不是空结果）', () => {
  it('kind 不对 / languageId 不是 kojo2 / 别家扩展名 ⇒ undefined', () => {
    expect(provideDocumentHighlights(highlightRequest(3, 6, { kind: 'hover' }))).toBeUndefined();
    expect(provideDocumentHighlights(highlightRequest(3, 6, { languageId: 'erb' }))).toBeUndefined();
    expect(provideSelectionRanges(selectionRequest([{ line: 3, column: 5 }], { kind: 'hover' }))).toBeUndefined();
    expect(
      provideSelectionRanges(selectionRequest([{ line: 3, column: 5 }], { languageId: 'kojo-erb' })),
    ).toBeUndefined();
  });

  it('没有 languageId 时退回扩展名：`.kojo2` 认，`.erb` 弃权', () => {
    const kojo = {
      ...(highlightRequest(3, 6) as object),
      languageId: undefined,
      path: 'D:/proj/a.kojo2',
    } as never;
    expect(provideDocumentHighlights(kojo)).toBeDefined();
    const other = {
      ...(selectionRequest([{ line: 3, column: 5 }]) as object),
      languageId: undefined,
      path: 'D:/proj/a.erb',
    } as never;
    expect(provideSelectionRanges(other)).toBeUndefined();
  });
});

/* ============================== ② 高亮：三档全穿过契约 ============================== */

describe('高亮：write / read / text 三档原样穿过契约', () => {
  it('声明名：唯一 write + 代码面 read + 旁白 text + 插值 read', () => {
    const result = provideDocumentHighlights(highlightRequest(3, 6));
    expect(result).toEqual({
      kind: 'documentHighlight',
      highlights: [
        { line: 3, startColumn: 5, endColumn: 7, kind: 'write' },
        { line: 5, startColumn: 14, endColumn: 16, kind: 'read' },
        { line: 9, startColumn: 3, endColumn: 5, kind: 'text' },
        { line: 10, startColumn: 6, endColumn: 8, kind: 'read' },
      ],
    });
  });

  it('三档互不相同（塌成一档的表现是"声明与引用同色"）', () => {
    const kinds = new Set(provideDocumentHighlights(highlightRequest(3, 6))!.highlights.map((hit) => hit.kind));
    expect([...kinds].sort()).toEqual(['read', 'text', 'write']);
  });
});

/* ============================== ③ 位置门：不许误报 ============================== */

describe('位置门：字符串 / `@原生` / 注释 / 表体数据行不误报', () => {
  const hits = provideDocumentHighlights(highlightRequest(3, 6))!.highlights;

  it('字符串字面量 / 注释 / 表体数据行 / 原生体一行都不出现', () => {
    expect(hits.some((hit) => [1, 4, 7, 12].includes(hit.line))).toBe(false);
  });

  it('光标落在字符串里 / `@原生` 体内 ⇒ 空作答（不是弃权）', () => {
    for (const [line, column] of [
      [4, 16], // 字符串里的「心情」
      [12, 5], // @原生 体内
    ] as const) {
      expect(provideDocumentHighlights(highlightRequest(line, column)), `${line}:${column}`).toEqual({
        kind: 'documentHighlight',
        highlights: [],
      });
    }
  });
});

/* ============================== ④ 空结果语义 ============================== */

describe('空结果：认这门语言但光标下没有符号 ⇒ highlights: []', () => {
  it('空白行 ⇒ 空数组（作答）', () => {
    expect(provideDocumentHighlights(highlightRequest(8, 1))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
  });

  it('越界位点 ⇒ 空数组（不抛、不夹取）', () => {
    expect(provideDocumentHighlights(highlightRequest(9_999, 1))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
  });

  it('插件装配：两条腿各一枚贡献、id 稳定，且各自只答自己的 kind', () => {
    const contributions = activate();
    expect(contributions.get('kojo2-documentHighlight')?.order).toBe(10);
    expect(contributions.get('kojo2-selectionRange')?.order).toBe(10);
    const highlight = contributions.get('kojo2-documentHighlight')!;
    const selection = contributions.get('kojo2-selectionRange')!;
    // 高亮贡献收到 selectionRange 请求 ⇒ 弃权（不许替另一条腿作答）
    expect(highlight.provide(selectionRequest([{ line: 3, column: 5 }]))).toBeUndefined();
    expect(selection.provide(highlightRequest(3, 6))).toBeUndefined();
    expect(highlight.provide(highlightRequest(3, 6))?.kind).toBe('documentHighlight');
    expect(selection.provide(selectionRequest([{ line: 3, column: 5 }]))?.kind).toBe('selectionRange');
  });
});

/* ============================== ⑤ 扩选：多位置对齐 ============================== */

describe('扩选：selected 与 positions 同序同长；逐位点空链；越界不夹取', () => {
  it('有效位点给链（最内层范围），顺序与输入一致', () => {
    const result = provideSelectionRanges(
      selectionRequest([
        { line: 3, column: 5 },
        { line: 5, column: 3 },
      ]),
    )!;
    expect(result.selections).toHaveLength(2);
    const first = result.selections[0]!;
    const second = result.selections[1]!;
    expect(first.range).toEqual({ startLine: 3, startColumn: 5, endLine: 3, endColumn: 7 });
    expect(first.parent).toBeDefined();
    expect(second.range.startLine).toBe(5);
  });

  it('越界 / 非法坐标 ⇒ 该位点 null，其它位点不受影响（外层不缩短）', () => {
    const result = provideSelectionRanges(
      selectionRequest([
        { line: 3, column: 5 },
        { line: 9_999, column: 1 },
        { line: 1, column: 0 },
      ]),
    )!;
    expect(result.selections).toHaveLength(3);
    expect(result.selections[0]).not.toBeNull();
    expect(result.selections[1]).toBeNull();
    expect(result.selections[2]).toBeNull();
  });

  it('链是嵌套形状且父恒包住子（宿主摊平前就能验证前缀包含）', () => {
    const chain = provideSelectionRanges(selectionRequest([{ line: 3, column: 5 }]))!.selections[0]!;
    let cursor = chain;
    let depth = 0;
    while (cursor.parent !== undefined) {
      const parent = cursor.parent;
      expect(parent.range.startLine).toBeLessThanOrEqual(cursor.range.startLine);
      expect(parent.range.endLine).toBeGreaterThanOrEqual(cursor.range.endLine);
      cursor = parent;
      depth += 1;
    }
    expect(depth).toBeGreaterThanOrEqual(1);
  });

  it('空文件 ⇒ 与输入同长的全 null（不是少给一条）', () => {
    const result = provideSelectionRanges(
      selectionRequest([{ line: 1, column: 1 }, { line: 2, column: 1 }], { text: '' }),
    )!;
    expect(result.selections).toEqual([null, null]);
  });
});
