/**
 * `@kojo/plugin-erb-lang` 两条腿的供方闸（LAU-4 第一步）。
 *
 * 六组断言，各自防一种真实退化：
 * 1. **语言分派 + 双向弃权**：非 ERB ⇒ `undefined`；ERB ⇒ 作答；**且** kojo2 那家对 ERB
 *    请求弃权——两家认的语言 id 互不重叠，同一请求永远只有一家作答（混成空结果会把那门
 *    语言自己的 provider 顶掉）；
 * 2. **三档都穿过契约**：write / read / text 一格不塌（塌档的表现是"声明与引用同色"）；
 * 3. **位置门在包里**：字符串字面量 / 整行注释 / `[SKIPSTART]` 死区不误报；
 * 4. **空作答语义**：认这门语言、光标下没有可证明符号 ⇒ `highlights: []`（**作答**，
 *    不是弃权）；
 * 5. **多位置对齐**：`selections` 与 `positions` 同序同长，越界位点 `null`（不夹取），
 *    且某一格空链不缩短外层；
 * 6. **插件装配**：两枚贡献分枚注册、id 稳定、order 相同、不吃任何服务。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import {
  provideDocumentHighlights as provideKojo2Highlights,
  provideSelectionRanges as provideKojo2Selections,
} from '@kojo/plugin-kojo-lang';
import {
  createErbLangPlugin,
  isErbRequest,
  provideDocumentHighlights,
  provideSelectionRanges,
} from '../src/index';

const PATH = 'D:/proj/ERB/口上/1_测试.erb';

/** 高亮夹具：注释 / 声明 / 标签 / 控制块 / 字符串 / 死区 / 散文提及各占一行 */
const HILITE: string = [
  '; 顶部注释：IF / CALL FUNC / $LOOP 都不是符号',
  '#DIM CNT, 10',
  '@FUNC(A, B)',
  '    $LOOP',
  '    IF A AND B',
  '        PRINTL "字符串里的 IF 与 FUNC"',
  '        CALL OTHER(1)',
  '        CALL FUNC(A)',
  '        PRINTL FUNC について',
  '        SIF A > 1',
  '        PRINTLX',
  '    ELSE',
  '        CALL FUNC(B)',
  '    ENDIF',
  '    [SKIPSTART]',
  '    IF A',
  '    CALL FUNC(A)',
  '    [SKIPEND]',
  '    JUMP LOOP',
  '    IF A',
  '        PRINTL 未闭合',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** 扩选夹具：两层控制块（IF ⊃ SELECTCASE）+ 一个分支段 + 两个函数 */
const SELECT: string = [
  '; 头部',
  '@FUNC(A)',
  '    IF A',
  '        SELECTCASE A',
  '            CASE 1',
  '                PRINTL 一',
  '        ENDSELECT',
  '    ENDIF',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

function highlightRequest(line: number, column: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'documentHighlight' as const,
    path: PATH,
    text: HILITE,
    line,
    column,
    project: null,
    languageId: 'kojo-erb',
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
    languageId: 'kojo-erb',
    positions,
    ...over,
  } as never;
}

/** 格式化请求（ERB-PARITY G2）：`lineRange` 缺席 = 整篇；给 = 区间（1 基闭区间） */
function formattingRequest(text: string, lineRange?: { startLine: number; endLine: number }) {
  return {
    kind: 'formatting' as const,
    path: PATH,
    languageId: 'kojo-erb',
    text,
    project: null,
    lineCount: text.split('\n').length,
    ...(lineRange === undefined ? {} : { lineRange }),
  } as never;
}

/* ============================== ① 语言分派 ============================== */

describe('语言分派：只答 ERB（其余弃权，不是空结果）', () => {
  it('有 languageId 就以它为准：`kojo-erb` / `erb` 认，`kojo2` / 别家不认', () => {
    expect(isErbRequest({ languageId: 'kojo-erb', path: 'D:/x/a.kojo' })).toBe(true);
    expect(isErbRequest({ languageId: 'erb', path: 'D:/x/a.kojo2' })).toBe(true);
    expect(isErbRequest({ languageId: 'kojo2', path: 'D:/x/a.erb' })).toBe(false);
    expect(isErbRequest({ languageId: 'plaintext', path: 'D:/x/a.erb' })).toBe(false);
  });

  it('没有 languageId 才退回路径：三种方言扩展名都认、大小写不敏感，`.kojo` 不认', () => {
    expect(isErbRequest({ path: 'D:/x/a.erb' })).toBe(true);
    expect(isErbRequest({ path: 'D:/x/a.ERH' })).toBe(true);
    expect(isErbRequest({ path: 'D:/x/a.erm' })).toBe(true);
    expect(isErbRequest({ path: 'D:/x/a.kojo' })).toBe(false);
    expect(isErbRequest({ path: 'D:/x/a.kojo2' })).toBe(false);
  });

  it('kind 不对 / languageId 是 kojo2 ⇒ `undefined`（不是空数组）', () => {
    expect(provideDocumentHighlights(highlightRequest(3, 6, { kind: 'hover' }))).toBeUndefined();
    expect(provideDocumentHighlights(highlightRequest(3, 6, { languageId: 'kojo2' }))).toBeUndefined();
    expect(
      provideSelectionRanges(selectionRequest([{ line: 3, column: 5 }], { kind: 'definition' })),
    ).toBeUndefined();
    expect(
      provideSelectionRanges(selectionRequest([{ line: 3, column: 5 }], { languageId: 'kojo2' })),
    ).toBeUndefined();
  });

  it('没有 languageId 时退回扩展名：`.erb` 认，`.kojo2` 弃权', () => {
    const erb = {
      ...(highlightRequest(3, 6) as object),
      languageId: undefined,
      path: 'D:/proj/a.ERB',
    } as never;
    expect(provideDocumentHighlights(erb)).toBeDefined();
    const kojo = {
      ...(selectionRequest([{ line: 3, column: 5 }]) as object),
      languageId: undefined,
      path: 'D:/proj/a.kojo2',
    } as never;
    expect(provideSelectionRanges(kojo)).toBeUndefined();
  });
});

/* ============================== ② 双向弃权（跨供方） ============================== */

describe('双向弃权：同一请求永远只有一家作答', () => {
  const KOJO2_PATH = 'D:/proj/口上/1_测试.kojo';

  it('erb 供方对 kojo2 请求弃权；kojo2 供方对 erb 请求也弃权', () => {
    const kojo2Ask = {
      kind: 'documentHighlight',
      path: KOJO2_PATH,
      text: ['# 幕 一', '# 设 心情 整数 = 0 存档', '> 心情'].join('\n'),
      line: 2,
      column: 6,
      project: null,
      languageId: 'kojo2',
    } as never;
    expect(provideDocumentHighlights(kojo2Ask)).toBeUndefined();
    expect(provideKojo2Highlights(kojo2Ask)).toBeDefined();

    const erbAsk = highlightRequest(3, 6);
    expect(provideKojo2Highlights(erbAsk)).toBeUndefined();
    expect(provideDocumentHighlights(erbAsk)).toBeDefined();
  });

  it('扩选那条腿同样双向弃权（`undefined` 是整条能力弃权，不是"整排空链"）', () => {
    const kojo2Ask = {
      kind: 'selectionRange',
      path: KOJO2_PATH,
      text: ['# 幕 一', '@函 甲()', '    心情 = 1'].join('\n'),
      project: null,
      languageId: 'kojo2',
      positions: [{ line: 2, column: 4 }],
    } as never;
    expect(provideSelectionRanges(kojo2Ask)).toBeUndefined();
    expect(provideKojo2Selections(kojo2Ask)).toBeDefined();

    const erbAsk = selectionRequest([{ line: 6, column: 17 }]);
    expect(provideKojo2Selections(erbAsk)).toBeUndefined();
    expect(provideSelectionRanges(erbAsk)).toBeDefined();
  });
});

/* ============================== ③ 高亮：三档全穿过契约 ============================== */

describe('高亮：write / read / text 三档原样穿过契约', () => {
  it('控制流块：开块 write + 分支 text + 收束 read', () => {
    const result = provideDocumentHighlights(highlightRequest(5, 6))!;
    expect(result.kind).toBe('documentHighlight');
    expect(result.highlights).toEqual([
      { line: 5, startColumn: 5, endColumn: 7, kind: 'write' },
      { line: 12, startColumn: 5, endColumn: 9, kind: 'text' },
      { line: 14, startColumn: 5, endColumn: 10, kind: 'read' },
    ]);
  });

  it('函数名：声明写 + `CALL` 读 + 散文提及 text（一处不漏、档位不塌）', () => {
    const result = provideDocumentHighlights(highlightRequest(3, 3))!;
    expect(result.highlights).toEqual([
      { line: 3, startColumn: 2, endColumn: 6, kind: 'write' },
      { line: 8, startColumn: 14, endColumn: 18, kind: 'read' },
      { line: 9, startColumn: 16, endColumn: 20, kind: 'text' },
      { line: 13, startColumn: 14, endColumn: 18, kind: 'read' },
      { line: 23, startColumn: 10, endColumn: 14, kind: 'read' },
    ]);
  });

  it('`$` 标签：定义写 + 跳转读', () => {
    const result = provideDocumentHighlights(highlightRequest(4, 6))!;
    expect(result.highlights).toEqual([
      { line: 4, startColumn: 6, endColumn: 10, kind: 'write' },
      { line: 19, startColumn: 10, endColumn: 14, kind: 'read' },
    ]);
  });
});

/* ============================== ④ 位置门 / 空作答 ============================== */

describe('位置门与空作答（都在包里，供方只搬运）', () => {
  it('字符串内容 / 整行注释 / 死区 ⇒ 空作答（不是弃权）', () => {
    expect(provideDocumentHighlights(highlightRequest(6, 20))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
    expect(provideDocumentHighlights(highlightRequest(1, 12))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
    expect(provideDocumentHighlights(highlightRequest(17, 12))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
  });

  it('越界位点 / 空文本 ⇒ 空作答（`[]` 是作答，`undefined` 才是弃权）', () => {
    expect(provideDocumentHighlights(highlightRequest(9_999, 1))).toEqual({
      kind: 'documentHighlight',
      highlights: [],
    });
    const empty = { ...(highlightRequest(1, 1) as object), text: '' } as never;
    expect(provideDocumentHighlights(empty)).toEqual({ kind: 'documentHighlight', highlights: [] });
  });
});

/* ============================== ⑤ 扩选：对齐版 ============================== */

describe('扩选：与位点同序同长、某位点空链不缩短外层', () => {
  it('单光标：七级链原样穿过契约（字段名两边一致）', () => {
    const result = provideSelectionRanges(selectionRequest([{ line: 6, column: 17 }]))!;
    expect(result.kind).toBe('selectionRange');
    expect(result.selections).toHaveLength(1);
    const flat: Array<[number, number, number, number]> = [];
    let cursor = result.selections[0];
    while (cursor !== null && cursor !== undefined) {
      flat.push([
        cursor.range.startLine,
        cursor.range.startColumn,
        cursor.range.endLine,
        cursor.range.endColumn,
      ]);
      cursor = cursor.parent;
    }
    expect(flat).toEqual([
      [6, 17, 6, 23],
      [6, 1, 6, 25],
      [5, 1, 6, 25],
      [4, 1, 7, 18],
      [3, 1, 8, 10],
      [2, 1, 8, 10],
      [1, 1, 10, 17],
    ]);
  });

  it('多光标：越界位点 `null`，其余位点照常（不夹取、不缩短）', () => {
    const result = provideSelectionRanges(
      selectionRequest([
        { line: 6, column: 17 },
        { line: 9_999, column: 1 },
        { line: 10, column: 10 },
      ]),
    )!;
    expect(result.selections).toHaveLength(3);
    expect(result.selections[0]).not.toBeNull();
    expect(result.selections[1]).toBeNull();
    expect(result.selections[2]).not.toBeNull();
  });

  it('空文件 ⇒ 与输入同长的全空链（不是空数组）', () => {
    const result = provideSelectionRanges(
      selectionRequest([{ line: 1, column: 1 }, { line: 2, column: 1 }], { text: '' }),
    )!;
    expect(result.selections).toEqual([null, null]);
  });
});

/* ============================== ⑥ 插件装配 ============================== */

describe('插件装配', () => {
  function activate(): Array<{ slot: string; item: EditorLanguageServiceContribution }> {
    const registered: Array<{ slot: string; item: EditorLanguageServiceContribution }> = [];
    const ctx = {
      pluginId: 'erb-lang',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots: {
        register: (slot: string, item: EditorLanguageServiceContribution) => {
          registered.push({ slot, item });
          return () => undefined;
        },
      },
    } as unknown as PluginContext;
    createErbLangPlugin().activate(ctx);
    return registered;
  }

  it('三枚贡献分枚注册，id 稳定、order 相同、同一个槽（ERB-PARITY G2 起含 formatting）', () => {
    const registered = activate();
    expect(registered.map((r) => r.item.id)).toEqual([
      'erb-documentHighlight',
      'erb-selectionRange',
      'erb-formatting',
    ]);
    expect(new Set(registered.map((r) => r.slot))).toEqual(new Set(['ui.editor.languageService']));
    const orders = new Set(registered.map((r) => r.item.order));
    expect(orders.size).toBe(1);
    // 与 kojo2 那家同权（同一条槽、同一个 order 档）
    expect([...orders]).toEqual([10]);
  });

  it('贡献真的接到供方上（不是空壳）：经槽问一次能拿到 ERB 的作答', () => {
    const contributions = new Map<string, EditorLanguageServiceContribution>();
    for (const { item } of activate()) contributions.set(item.id, item);
    const highlight = contributions.get('erb-documentHighlight')!.provide(highlightRequest(5, 6));
    expect(highlight).toMatchObject({ kind: 'documentHighlight' });
    const selection = contributions.get('erb-selectionRange')!.provide(
      selectionRequest([{ line: 6, column: 17 }]),
    );
    expect(selection).toMatchObject({ kind: 'selectionRange' });
    // 格式化：整篇 / 区间两条请求都由这枚供方作答（区间 = 整篇算完按行裁剪，同一把尺子）
    const formatting = contributions.get('erb-formatting')!;
    const full = formatting.provide(formattingRequest(`\u3000PRINTFORMW 甲\nENDIF`, undefined));
    expect(full).toMatchObject({ kind: 'formatting' });
    if (full?.kind !== 'formatting') throw new Error('整篇请求应以 formatting 作答（不是弃权）');
    expect(full.edits.length).toBeGreaterThan(0);
    const clipped = formatting.provide(formattingRequest(`\u3000PRINTFORMW 甲\nENDIF`, { startLine: 2, endLine: 2 }));
    if (clipped?.kind !== 'formatting') throw new Error('区间裁剪仍应是作答（空表），不是弃权');
    expect(clipped.edits).toEqual([]); // 第 2 行本就规范 ⇒ 裁剪后零编辑（作答，不是弃权）
  });

  it('判据抛错**上抛**（G2 收尾：不再吞成弃权——吞了就与"没有供方应答"同形，降级台账会静默）', () => {
    const contributions = new Map<string, EditorLanguageServiceContribution>();
    for (const { item } of activate()) contributions.set(item.id, item);
    const formatting = contributions.get('erb-formatting')!;
    // 规则开关递一枚"读任何键都抛"的代理：computeFormatEdits 在取规则处炸 ⇒ 异常原样上抛
    const poisonedRules = new Proxy(
      {},
      {
        get() {
          throw new Error('桩：判据炸了');
        },
      },
    );
    expect(() =>
      formatting.provide({
        kind: 'formatting',
        languageId: 'kojo-erb',
        path: 'x.ERB',
        text: '\u3000PRINTFORMW 甲',
        project: null,
        lineCount: 1,
        options: poisonedRules,
      } as unknown as Parameters<EditorLanguageServiceContribution['provide']>[0]),
    ).toThrow('桩：判据炸了');
    // 非 ERB 的抛错请求照旧**弃权**（不进入判据，异常无从谈起）——认语言在先、算规则在后
    expect(
      formatting.provide({
        kind: 'formatting',
        languageId: 'not-erb',
        path: 'x.txt',
        text: 'ignored',
        project: null,
        lineCount: 1,
      } as unknown as Parameters<EditorLanguageServiceContribution['provide']>[0]),
    ).toBeUndefined();
  });

  it('id 与版本是契约的一部分；零依赖（不吃任何服务）', () => {
    const plugin = createErbLangPlugin();
    expect(plugin.id).toBe('erb-lang');
    expect(plugin.version).toBe('0.0.0');
    expect(plugin.requires ?? []).toEqual([]);
  });
});
