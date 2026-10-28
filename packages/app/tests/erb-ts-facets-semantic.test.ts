import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import type * as Monaco from '../src/monaco/entry';
import {
  ERB_SEMANTIC_FACET,
  ERB_SEMANTIC_LEGEND,
  createErbSemanticTokensProvider,
  encodeErbStructureTokens,
  registerErbSemanticTokensProvider,
  resetErbSemanticWarnings,
  splitErbStructureTokens,
} from '../src/monaco/tree-sitter/erb-semantic';
import { erbCaptureTier, erbSemanticTiers } from '../src/monaco/tree-sitter/erb-tiers';
import {
  degradationNoticeText,
  onStructureDegradation,
  resetStructureDegradationLedger,
} from '../src/monaco/tree-sitter/fallback';
import { token, resetFacetLedgers } from './helpers/erb-ts-facets-kit';
import { decodeWithMonaco } from './helpers/monaco-semantic-decode';

/**
 * ERB-TS-FULL 面③：档位表 / legend / 编码 / provider（纯逻辑，不碰 wasm）。
 *
 * 档位名注记（2026-10-28 拆文件批）：这里喂给编码器的裸控制词档位原写 `keyword.erb`，
 * 那是 LAU-2（角色名收口）之前的旧 token 名——表外档位被 `splitErbStructureTokens`
 * 静默跳过，用例红过，但一直被同文件的 wasm OOM 崩worker 挡在分母外看不见。
 * 现按现表改成 `role.engine`（`@keyword.control` 的现役角色），断言一字不动。
 */

afterAll(resetFacetLedgers);

/**
 * 把 5 元增量数据读回来（**Monaco 自己的解码器**：`toMultilineTokens2`；编码错了这里就歪）。
 * 以前这里自写"从 line = 0 起算"的循环，与编码器同为 1 基 ⇒ 两边一起错、闸一直绿。
 */
async function decode(
  data: Uint32Array,
  legend: readonly string[],
): Promise<Array<{ line: number; startColumn: number; length: number; tier: string }>> {
  return (await decodeWithMonaco(data)).map((decoded) => ({
    line: decoded.line,
    startColumn: decoded.startColumn,
    length: decoded.endColumn - decoded.startColumn,
    tier: legend[decoded.type] ?? '<越界>',
  }));
}

const fakeModel = (lines: readonly string[], languageId = ERB_LANGUAGE_ID): Monaco.editor.ITextModel =>
  ({
    getLanguageId: () => languageId,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 1,
  }) as unknown as Monaco.editor.ITextModel;

const noCancel = { isCancellationRequested: false } as Monaco.CancellationToken;

/* ======================================================================== */
/* ③ 语义 facet：档位表 / legend / 编码 / provider                           */
/* ======================================================================== */

describe('ERB 语义 facet · 档位、编码与 provider 边界', () => {
  beforeEach(() => {
    resetErbSemanticWarnings();
    resetStructureDegradationLedger();
    vi.restoreAllMocks();
  });

  it('档位表的值全部能在主题里取到色（与 KOJO 档位同源）', () => {
    const legend = erbSemanticTiers();
    expect(legend).toEqual([...legend].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(legend).size).toBe(legend.length);
    expect(legend).toEqual(expect.arrayContaining(['role.comment', 'role.directive', 'role.label', 'role.decl', 'role.engine', 'role.string', 'role.interp', 'role.raw']));
    expect(ERB_SEMANTIC_LEGEND.tokenTypes).toEqual(legend);
    expect(ERB_SEMANTIC_LEGEND.tokenModifiers).toEqual([]);
  });

  it('捕获表外返回 null（说一次并不着色）；none 返回 undefined（安静）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(erbCaptureTier('definitely-not-a-capture')).toBeNull();
    expect(erbCaptureTier('none')).toBeUndefined();
    expect(erbCaptureTier('comment')).toBe('role.comment');
    expect(encodeErbStructureTokens([token({ tier: 'sugar.nope' })], { lineCount: 1, maxColumn: () => 10 })).toMatchObject({ data: expect.any(Uint32Array) });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('编码：单行为区间按（行，列）升序，坐标从 1 起', async () => {
    const encoded = encodeErbStructureTokens([token({ startRow: 0, startCol: 0, endRow: 0, endCol: 5, tier: 'role.comment' })], {
      lineCount: 1,
      maxColumn: () => 12,
    });
    expect(await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toEqual([
      { line: 1, startColumn: 1, length: 5, tier: 'role.comment' },
    ]);
  });

  it('编码：内层优先——串里的插值不被整枚串吞掉，外层切开补写', async () => {
    const encoded = encodeErbStructureTokens(
      [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 20, tier: 'role.string' }),
        token({ startRow: 0, startCol: 5, endRow: 0, endCol: 10, tier: 'role.interp' }),
      ],
      { lineCount: 1, maxColumn: () => 21 },
    );
    const decoded = await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes);
    expect(decoded.map((d) => [d.startColumn, d.length, d.tier])).toEqual([
      [1, 5, 'role.string'],
      [6, 5, 'role.interp'],
      [11, 10, 'role.string'],
    ]);
    // 切开是**设计内的补写**（一段都没丢）⇒ 不许计入"丢弃"：算进去就变成每份带插值的口上都
    // 报一条"结构着色没顶上"（2026-10-25 修掉的那条误报）
    expect(encoded.droppedOverlaps).toBe(0);
    // 同一行不重叠（Monaco 的硬要求）：逐条校验
    let end = 0;
    for (const span of decoded) {
      expect(span.startColumn).toBeGreaterThanOrEqual(end);
      end = span.startColumn + span.length;
    }
  });

  it('编码：完全被覆盖的重叠区间丢掉并计数', async () => {
    const encoded = encodeErbStructureTokens(
      [
        token({ startRow: 0, startCol: 2, endRow: 0, endCol: 8, tier: 'role.comment' }),
        token({ startRow: 0, startCol: 2, endRow: 0, endCol: 8, tier: 'role.comment' }),
      ],
      { lineCount: 1, maxColumn: () => 10 },
    );
    expect(encoded.droppedOverlaps).toBe(1);
    expect(await decode(encoded.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toHaveLength(1);
  });

  it('编码：结尾落在下一行第 0 列（裸控制词吃了换行）⇒ 收回上一行，不多铺一行', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 6, startCol: 0, endRow: 7, endCol: 0, tier: 'role.engine' })],
      { lineCount: 10, maxColumn: (lineNumber) => (lineNumber === 7 ? 5 : 9) },
    );
    // 修前：endRow 直接换行号 ⇒ 多铺第 8 行（宽度 0）⇒ droppedEmpty 1 条、每份口上都白报一次
    expect(result.droppedEmpty).toBe(0);
    expect(result.droppedRows).toBe(0);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ line: 7, startColumn: 1, endColumn: 5 });
  });

  it('编码：文件以裸控制词 + 换行结尾时不再判越界（收回后正好落在末行）', () => {
    const result = splitErbStructureTokens([token({ startRow: 2, startCol: 0, endRow: 3, endCol: 0, tier: 'role.engine' })], {
      lineCount: 3,
      maxColumn: () => 8,
    });
    expect(result.droppedRows).toBe(0);
    expect(result.droppedEmpty).toBe(0);
    expect(result.spans).toHaveLength(1);
  });

  it('编码：行越界丢弃、列越界夹取', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 99, endRow: 99 }), token({ startCol: 2, endCol: 99 })],
      { lineCount: 1, maxColumn: () => 6 },
    );
    expect(result.droppedRows).toBe(1);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ line: 1, startColumn: 3, endColumn: 6 });
  });

  it('编码：跨度超上限整条丢掉（错误恢复把块撑到全篇时不许糊屏）', () => {
    const result = splitErbStructureTokens(
      [token({ startRow: 0, endRow: 250, tier: 'role.string' })],
      { lineCount: 400, maxColumn: () => 10 },
    );
    expect(result.droppedWide).toBe(1);
    expect(result.spans).toHaveLength(0);
  });

  it('编码：空 token 表 ⇒ 长度 0 的数据（不是异常）', () => {
    const encoded = encodeErbStructureTokens([], { lineCount: 3, maxColumn: () => 5 });
    expect(encoded.data.length).toBe(0);
    expect(encoded.droppedRows + encoded.droppedEmpty + encoded.droppedWide + encoded.droppedOverlaps).toBe(0);
  });

  it('provider：只认 ERB 语言（别的语言连取数都不问）', async () => {
    let calls = 0;
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['x'], 'plaintext'), null, noCancel)).toBeNull();
    expect(calls).toBe(0);
  });

  it('provider：inactive / 取消 ⇒ null（不问取数）', async () => {
    let calls = 0;
    const inactive = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      isActive: () => false,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(await inactive.provideDocumentSemanticTokens!(fakeModel(['x']), null, noCancel)).toBeNull();
    const cancelled = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        calls++;
        return [];
      },
    });
    expect(
      await cancelled.provideDocumentSemanticTokens!(fakeModel(['x']), null, {
        isCancellationRequested: true,
      } as Monaco.CancellationToken),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it('provider：取数 null / 空数组 ⇒ null（让名字分色的 provider 应答）', async () => {
    const nullProvider = createErbSemanticTokensProvider({ languageId: ERB_LANGUAGE_ID, tokens: async () => null });
    expect(await nullProvider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    const emptyProvider = createErbSemanticTokensProvider({ languageId: ERB_LANGUAGE_ID, tokens: async () => [] });
    expect(await emptyProvider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
  });

  it('provider：有 token ⇒ 编成 Monaco 数据', async () => {
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [token({ startRow: 0, startCol: 0, endRow: 0, endCol: 5, tier: 'role.comment' })],
    });
    const result = (await provider.provideDocumentSemanticTokens!(fakeModel(['hello world']), null, noCancel)) as
      | { data: Uint32Array }
      | null;
    expect(result).not.toBeNull();
    expect(await decode(result!.data, ERB_SEMANTIC_LEGEND.tokenTypes)).toEqual([
      { line: 1, startColumn: 1, length: 5, tier: 'role.comment' },
    ]);
  });

  it('provider：裸控制词的换行尾不再触发回落（真文件的常态不许报"没顶上"）', async () => {
    resetStructureDegradationLedger();
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(d.message));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'role.engine' }),
        token({ startRow: 1, startCol: 0, endRow: 2, endCol: 0, tier: 'role.engine' }),
      ],
    });
    const result = (await provider.provideDocumentSemanticTokens!(
      fakeModel(['IF X', 'ENDIF', 'RETURN 1']),
      null,
      noCancel,
    )) as { data: Uint32Array } | null;
    unsubscribe();
    expect(result).not.toBeNull();
    expect(notices).toEqual([]);
  });

  it('provider：真有段没涂上时文案说"几段没涂上"，不许说"这一面退回了原来的做法"', async () => {
    resetStructureDegradationLedger();
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(degradationNoticeText(d)));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'role.comment' }),
        token({ startRow: 0, startCol: 0, endRow: 0, endCol: 4, tier: 'role.string' }), // 整段被先到的盖住
      ],
    });
    await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel);
    unsubscribe();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('有几段没涂上');
    expect(notices[0]).not.toContain('退回了原来的做法');
  });

  it('provider：取数抛错 ⇒ null + 回落台账说一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage}`));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => {
        throw new Error('client 取数失败（桩）');
      },
    });
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    unsubscribe();
    expect(notices).toEqual(['semantic/parse']);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('client 取数失败'))).toBe(true);
  });

  it('provider：超时 ⇒ null + 回落台账说一次（不把 Monaco 的 promise 挂住）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notices: string[] = [];
    const unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage}`));
    const provider = createErbSemanticTokensProvider({
      languageId: ERB_LANGUAGE_ID,
      timeoutMs: 10,
      tokens: () => new Promise(() => undefined),
    });
    const started = Date.now();
    expect(await provider.provideDocumentSemanticTokens!(fakeModel(['IF X']), null, noCancel)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    unsubscribe();
    expect(notices).toEqual(['semantic/parse']);
    expect(warn).toHaveBeenCalled();
  });

  it('registerErbSemanticTokensProvider：只挂 ERB id，dispose 可重复调用', () => {
    const ids: string[] = [];
    let disposed = 0;
    const monaco = {
      languages: {
        registerDocumentSemanticTokensProvider: (id: string) => {
          ids.push(id);
          return { dispose: () => void disposed++ };
        },
      },
    } as unknown as typeof Monaco;
    const registration = registerErbSemanticTokensProvider(monaco, {
      languageId: ERB_LANGUAGE_ID,
      tokens: async () => [],
    });
    expect(ids).toEqual([ERB_LANGUAGE_ID]);
    registration.dispose();
    registration.dispose();
    // 桩的 dispose 不幂等（真 Monaco IDisposable 是）：这里只钉"连拆两次不抛"
    expect(disposed).toBe(2);
  });

  it('facet 与独立 provider 同源：legend / encode 是同一个函数', () => {
    expect(ERB_SEMANTIC_FACET.legend).toBe(ERB_SEMANTIC_LEGEND);
    expect(ERB_SEMANTIC_FACET.encode).toBe(encodeErbStructureTokens);
  });
});
