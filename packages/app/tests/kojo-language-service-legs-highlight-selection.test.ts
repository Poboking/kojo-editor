/**
 * B3f · 同符号高亮 / 结构化扩选的**取数腿**
 * （`kojo-language-service-legs` 的四个新函数）。
 *
 * 这一层只做两件事，一行语言知识都没有：
 * 1. **请求构造**：身份三格（缺省就不出现）/ 全文 / 行数口径 / 位点数组原样递交；
 * 2. **单答裁决**：`undefined` = 无人应答（继续问下一家）；空结果 = 作答（不再问）。
 *    抛错按贡献隔离（warn 带 id）。
 *
 * 扩选那条一次多位置、**整包作答**：某位点 `null`（空链）原样保留——宿主安装层按位点
 * 摊平，不许在这里被"过滤掉"变成错位。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import {
  collectDocumentHighlights,
  collectSelectionRanges,
  documentHighlightRequestOf,
  selectionRangeRequestOf,
} from '../src/monaco/kojo-language-service-legs';

const IDENTITY = { path: 'D:/p/a.kojo', languageId: 'kojo2', version: 3 };
const PROJECT = { adapterId: 'proj-a' } as never;

/** 只答 `kind` 的那一条贡献 */
function answerKind(
  id: string,
  kind: 'documentHighlight' | 'selectionRange',
  result: unknown,
): EditorLanguageServiceContribution {
  return {
    id,
    provide: (request) => (request.kind === kind ? result : undefined),
  } as EditorLanguageServiceContribution;
}

/* ============================== ① 请求构造 ============================== */

describe('documentHighlightRequestOf：身份缺省键不出现 + 行数口径', () => {
  it('身份三格齐全时逐格递；lineCount = 行数', () => {
    const request = documentHighlightRequestOf(IDENTITY, 'a\nb\nc', 2, 4, PROJECT);
    expect(request).toMatchObject({
      kind: 'documentHighlight',
      path: 'D:/p/a.kojo',
      languageId: 'kojo2',
      version: 3,
      text: 'a\nb\nc',
      line: 2,
      column: 4,
      lineCount: 3,
    });
  });

  it('身份缺 languageId / version ⇒ 那两格不出现（不补假值）', () => {
    const request = documentHighlightRequestOf({ path: 'D:/p/a.kojo' }, '', 1, 1, null);
    expect(Object.hasOwn(request, 'languageId')).toBe(false);
    expect(Object.hasOwn(request, 'version')).toBe(false);
    expect(request.lineCount).toBe(1);
  });
});

describe('selectionRangeRequestOf：位点数组原样递（不排序、不去重、不夹取）', () => {
  it('positions 同序同长进入请求，身份与项目照旧', () => {
    const positions = [
      { line: 3, column: 5 },
      { line: 9_999, column: 1 },
      { line: 1, column: 1 },
    ];
    const request = selectionRangeRequestOf(IDENTITY, 'a\nb\nc', positions, PROJECT);
    expect(request.kind).toBe('selectionRange');
    expect(request.path).toBe('D:/p/a.kojo');
    expect(request.languageId).toBe('kojo2');
    expect(request.version).toBe(3);
    expect(request.positions).toEqual(positions);
    expect(request.lineCount).toBe(3);
    expect(request.project).toBe(PROJECT);
  });

  it('空位点数组 ⇒ 请求仍构造（行数与身份照给），由供方交空作答', () => {
    const request = selectionRangeRequestOf({ path: 'D:/p/a.kojo' }, 'x', [], null);
    expect(request.positions).toEqual([]);
    expect(Object.hasOwn(request, 'languageId')).toBe(false);
    expect(request.lineCount).toBe(1);
  });
});

/* ============================== ② 单答裁决：高亮 ============================== */

describe('collectDocumentHighlights：第一家作答说了算', () => {
  it('无人应答 ⇒ undefined（宿主据此交 undefined，不顶掉下一家）', () => {
    const contributions = [answerKind('a', 'documentHighlight', undefined)];
    const request = documentHighlightRequestOf(IDENTITY, 'x', 1, 1, null);
    expect(collectDocumentHighlights(contributions, request)).toBeUndefined();
  });

  it('空表也是作答：不再问下一家', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    const contributions = [
      answerKind('first', 'documentHighlight', { kind: 'documentHighlight', highlights: [] }),
      { id: 'second', provide: second } as EditorLanguageServiceContribution,
    ];
    const result = collectDocumentHighlights(
      contributions,
      documentHighlightRequestOf(IDENTITY, 'x', 1, 1, null),
    );
    expect(result).toEqual({ kind: 'documentHighlight', highlights: [] });
    expect(second).not.toHaveBeenCalled();
  });

  it('第一家抛错 ⇒ 隔离（warn 带 id），下一家接上', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const contributions: EditorLanguageServiceContribution[] = [
      {
        id: 'boom',
        provide: () => {
          throw new Error('桩：炸了');
        },
      } as unknown as EditorLanguageServiceContribution,
      answerKind('ok', 'documentHighlight', {
        kind: 'documentHighlight',
        highlights: [{ line: 1, startColumn: 2, endColumn: 3, kind: 'write' }],
      }),
    ];
    const result = collectDocumentHighlights(
      contributions,
      documentHighlightRequestOf(IDENTITY, 'x', 1, 1, null),
    );
    expect(result?.highlights).toHaveLength(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("'boom'"))).toBe(true);
    warn.mockRestore();
  });

  it('答别的 kind ⇒ 跳过（不会把邻腿结果当自己的）', () => {
    const contributions = [
      answerKind('selection', 'selectionRange', { kind: 'selectionRange', selections: [] }),
      answerKind('highlight', 'documentHighlight', {
        kind: 'documentHighlight',
        highlights: [{ line: 1, startColumn: 2, endColumn: 3, kind: 'read' }],
      }),
    ];
    const result = collectDocumentHighlights(
      contributions,
      documentHighlightRequestOf(IDENTITY, 'x', 1, 1, null),
    );
    expect(result?.highlights).toHaveLength(1);
  });
});

/* ============================== ③ 单答裁决：扩选 ============================== */

describe('collectSelectionRanges：整包作答，位点空链原样保留', () => {
  const positions = [
    { line: 1, column: 2 },
    { line: 9_999, column: 1 },
  ];

  it('无人应答 ⇒ undefined（与"某位点空链"是两件事）', () => {
    expect(
      collectSelectionRanges(
        [answerKind('a', 'selectionRange', undefined)],
        selectionRangeRequestOf(IDENTITY, 'x', positions, null),
      ),
    ).toBeUndefined();
  });

  it('作答的 null 逐格保留（同长；不许在这里被过滤成短数组）', () => {
    const chain = { range: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 } };
    const result = collectSelectionRanges(
      [answerKind('first', 'selectionRange', { kind: 'selectionRange', selections: [chain, null] })],
      selectionRangeRequestOf(IDENTITY, 'x', positions, null),
    );
    expect(result?.selections).toEqual([chain, null]);
    expect(result?.selections).toHaveLength(positions.length);
  });

  it('空 selections 也是作答：不再问下一家', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    const result = collectSelectionRanges(
      [
        answerKind('first', 'selectionRange', { kind: 'selectionRange', selections: [] }),
        { id: 'second', provide: second } as EditorLanguageServiceContribution,
      ],
      selectionRangeRequestOf(IDENTITY, 'x', positions, null),
    );
    expect(result).toEqual({ kind: 'selectionRange', selections: [] });
    expect(second).not.toHaveBeenCalled();
  });

  it('任一家的 provide 抛错只让这家缺席（扩选仍由下一家作答）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = collectSelectionRanges(
      [
        {
          id: 'boom',
          provide: () => {
            throw new Error('桩：炸了');
          },
        } as unknown as EditorLanguageServiceContribution,
        answerKind('ok', 'selectionRange', { kind: 'selectionRange', selections: [null, null] }),
      ],
      selectionRangeRequestOf(IDENTITY, 'x', positions, null),
    );
    expect(result?.selections).toEqual([null, null]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* ============================== ④ 与邻腿互不串味 ============================== */

describe('两条腿的请求 kind 不同、互不认领', () => {
  it('高亮腿收到扩选请求 / 扩选腿收到高亮请求 ⇒ 都不作答（undefined）', () => {
    const highlightRequest: EditorLanguageServiceRequest = documentHighlightRequestOf(
      IDENTITY,
      'x',
      1,
      1,
      null,
    );
    const selectionRequest: EditorLanguageServiceRequest = selectionRangeRequestOf(
      IDENTITY,
      'x',
      positionsOf(),
      null,
    );
    const both = [
      answerKind('highlight', 'documentHighlight', { kind: 'documentHighlight', highlights: [] }),
      answerKind('selection', 'selectionRange', { kind: 'selectionRange', selections: [] }),
    ];
    expect(collectSelectionRanges(both, highlightRequest)).toBeUndefined();
    expect(collectDocumentHighlights(both, selectionRequest)).toBeUndefined();
  });
});

function positionsOf(): ReadonlyArray<{ line: number; column: number }> {
  return [{ line: 1, column: 1 }];
}
