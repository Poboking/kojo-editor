/**
 * LS-B0 · 四条取数腿（`completion` / `hover` / `formatting` / `signatureHelp`）单测。
 *
 * 本文件只测**合并纪律**，不测任何语言知识——四条腿里没有一行认识 ERB、`.kojo`、
 * 游戏名词或 Monaco 协议。判据分三类：
 *
 * 1. **弃权就跳过**（每个 kind 一条，B0 的 DoD 明确要求）：`undefined` 的贡献方不被
 *    当成"答了空"，下一家照问；
 * 2. **空结果也是作答**（单答型三个 kind 各一条）：`''` / `[]` 之后不再问下一家——
 *    这一条是"不猜"的另一半，混掉它，兜底就会在供方明确说了没话说的地方冒出来；
 * 3. **集合型取并集 + 去重**（`completion`）：`label`+`insertText`+`kind` 三者全同才算重复。
 *
 * 另加抛错隔离（一家炸了只让这家缺席）与 `formattingRequestOf` 的行数口径。
 *
 * B3c 追加两组：`collectHoverResult`（整块响应腿——单答口径必须与 `collectHoverContents`
 * 逐字一致，`''` 与 `undefined` 的分家是它的存在理由）与 `completionRequestOf` /
 * `hoverRequestOf` 两枚请求构造器（同源形状：缺省键不出现 + `lineCount` 同一把尺）。
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  EditorCompletionItem,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSignature,
} from '@kojo/plugin-api';
import {
  collectCompletionItems,
  collectFormattingEdits,
  collectHoverContents,
  collectHoverResult,
  collectSignatureHelp,
  completionRequestOf,
  formattingRequestOf,
  hoverRequestOf,
} from '../src/monaco/kojo-language-service-legs';

/** 一条只答一件事的贡献（`provide` 的返回由用例决定） */
const answer = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

/** 只认 `completion`、其余一律弃权的贡献 */
const completionOnly = (
  id: string,
  items: readonly EditorCompletionItem[],
): EditorLanguageServiceContribution =>
  answer(id, (request) =>
    request.kind === 'completion' ? { kind: 'completion', items } : undefined,
  );

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'completion',
  path: 'C:/p/a.ERB',
  text: 'CALL ',
  line: 1,
  column: 6,
  project: null,
  lineCount: 1,
};

const item = (label: string, extra: Partial<EditorCompletionItem> = {}): EditorCompletionItem => ({
  label,
  ...extra,
});

describe('completion · 集合型（并集 + 去重）', () => {
  it('两家候选并集交回', () => {
    const items = collectCompletionItems(
      [completionOnly('a', [item('GETBIT')]), completionOnly('b', [item('CFLAG')])],
      REQUEST,
    );
    expect(items.map((i) => i.label)).toEqual(['GETBIT', 'CFLAG']);
  });

  it('label + insertText + kind 三者全同才算重复；缺 insertText 时按 label 比', () => {
    const items = collectCompletionItems(
      [
        completionOnly('a', [item('X', { kind: 'function' })]),
        completionOnly('b', [
          item('X', { kind: 'function' }), // 全同 ⇒ 去掉
          item('X', { kind: 'variable' }), // kind 不同 ⇒ 保留
          item('X', { kind: 'function', insertText: 'X()' }), // 插法不同 ⇒ 保留
        ]),
      ],
      REQUEST,
    );
    expect(items.map((i) => `${i.label}/${i.kind ?? ''}/${i.insertText ?? ''}`)).toEqual([
      'X/function/',
      'X/variable/',
      'X/function/X()',
    ]);
  });

  it('弃权的贡献方被跳过（不认这个 kind ⇒ undefined）', () => {
    const items = collectCompletionItems(
      [
        answer('hover-only', () => ({ kind: 'hover', contents: '无关' })),
        completionOnly('real', [item('A')]),
      ],
      REQUEST,
    );
    expect(items.map((i) => i.label)).toEqual(['A']);
  });

  it('一家抛错只让这家缺席，其余照收', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = collectCompletionItems(
      [
        answer('boom', () => {
          throw new Error('炸了');
        }),
        completionOnly('real', [item('A')]),
      ],
      REQUEST,
    );
    expect(items.map((i) => i.label)).toEqual(['A']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('boom');
    warn.mockRestore();
  });

  it('空候选 = 认这个位置但没有候选（返回空数组，不是 undefined）', () => {
    expect(collectCompletionItems([completionOnly('a', [])], REQUEST)).toEqual([]);
  });
});

describe('hover · 单答型（第一家说了算）', () => {
  const hoverRequest: EditorLanguageServiceRequest = { ...REQUEST, kind: 'hover', column: 1 };

  it('第一家作答后不再问下一家', () => {
    const second = vi.fn(() => ({ kind: 'hover' as const, contents: '第二家' }));
    const contents = collectHoverContents(
      [
        answer('a', () => ({ kind: 'hover', contents: '第一家' })),
        answer('b', second),
      ],
      hoverRequest,
    );
    expect(contents).toBe('第一家');
    expect(second).not.toHaveBeenCalled();
  });

  it('弃权（undefined）时继续问下一家', () => {
    const contents = collectHoverContents(
      [
        answer('skip', () => undefined),
        answer('skip2', () => ({ kind: 'completion', items: [] })),
        answer('real', () => ({ kind: 'hover', contents: '轮到我' })),
      ],
      hoverRequest,
    );
    expect(contents).toBe('轮到我');
  });

  it('空串是作答（`\'\'` 与 `undefined` 必须分得开）', () => {
    const second = vi.fn(() => ({ kind: 'hover' as const, contents: '不该出现' }));
    const contents = collectHoverContents(
      [answer('a', () => ({ kind: 'hover', contents: '' })), answer('b', second)],
      hoverRequest,
    );
    expect(contents).toBe('');
    expect(second).not.toHaveBeenCalled();
  });

  it('无人应答 = undefined（宿主该退回自己的兜底）', () => {
    expect(collectHoverContents([answer('a', () => undefined)], hoverRequest)).toBeUndefined();
  });
});

describe('formatting · 单答型', () => {
  const fmtRequest: EditorLanguageServiceRequest = {
    ...REQUEST,
    kind: 'formatting',
    text: 'a\nb\n',
    lineCount: 3,
  };

  it('编辑按 (startLine, startColumn) 升序交回（落地端只需 reverse）', () => {
    const edits = collectFormattingEdits(
      [
        answer('a', () => ({
          kind: 'formatting',
          edits: [
            { startLine: 3, endLine: 3, newText: 'C' },
            { startLine: 1, endLine: 1, startColumn: 5, newText: 'B' },
            { startLine: 1, endLine: 1, startColumn: 2, newText: 'A' },
          ],
        })),
      ],
      fmtRequest,
    );
    expect(edits?.map((e) => `${e.startLine}:${e.startColumn ?? 0}:${e.newText}`)).toEqual([
      '1:2:A',
      '1:5:B',
      '3:0:C',
    ]);
  });

  it('空编辑是作答（不再问下一家）', () => {
    const second = vi.fn(() => ({ kind: 'formatting' as const, edits: [] }));
    const edits = collectFormattingEdits(
      [
        answer('a', () => ({ kind: 'formatting', edits: [] })),
        answer('b', second),
      ],
      fmtRequest,
    );
    expect(edits).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it('弃权时继续问下一家', () => {
    const edits = collectFormattingEdits(
      [answer('a', () => undefined), answer('b', () => ({ kind: 'formatting', edits: [{ startLine: 1, endLine: 1, newText: 'x' }] }))],
      fmtRequest,
    );
    expect(edits).toHaveLength(1);
  });

  it('坐标非法的编辑被丢弃并 warn（宁可少改一处，不可错改一处）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const edits = collectFormattingEdits(
      [
        answer('a', () => ({
          kind: 'formatting',
          edits: [
            { startLine: Number.NaN, endLine: 1, newText: 'bad' },
            { startLine: 1, endLine: 1, startColumn: Number.POSITIVE_INFINITY, newText: 'bad' },
            { startLine: 1, endLine: 1, newText: 'good' },
          ],
        })),
      ],
      fmtRequest,
    );
    expect(edits?.map((e) => e.newText)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('signatureHelp · 单答型', () => {
  const sigRequest: EditorLanguageServiceRequest = {
    ...REQUEST,
    kind: 'signatureHelp',
    column: 8,
  };
  const sig = (label: string): EditorSignature => ({ label, parameters: [], activeParameter: 0 });

  it('第一家说了算', () => {
    const signatures = collectSignatureHelp(
      [
        answer('a', () => ({ kind: 'signatureHelp', signatures: [sig('A(1)')] })),
        answer('b', () => ({ kind: 'signatureHelp', signatures: [sig('B(2)')] })),
      ],
      sigRequest,
    );
    expect(signatures?.map((s) => s.label)).toEqual(['A(1)']);
  });

  it('空签名是作答（光标不在实参里 ⇒ 宿主不弹，也不问下一家）', () => {
    const second = vi.fn(() => ({ kind: 'signatureHelp' as const, signatures: [sig('X')] }));
    const signatures = collectSignatureHelp(
      [answer('a', () => ({ kind: 'signatureHelp', signatures: [] })), answer('b', second)],
      sigRequest,
    );
    expect(signatures).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it('无人应答 = undefined（宿主该退回自己的兜底签名面）', () => {
    expect(collectSignatureHelp([answer('a', () => undefined)], sigRequest)).toBeUndefined();
  });
});

describe('formattingRequestOf · 请求构造', () => {
  it('空文本算 1 行（与 Monaco getLineCount 同口径）', () => {
    expect(formattingRequestOf({ path: 'a.ERB' }, '', null).lineCount).toBe(1);
  });

  it('按 \\n 计数 + 1，行尾换行不多算一行', () => {
    expect(formattingRequestOf({ path: 'a.ERB' }, 'a\nb\nc', null).lineCount).toBe(3);
    expect(formattingRequestOf({ path: 'a.ERB' }, 'a\nb\nc\n', null).lineCount).toBe(4);
  });

  it('identity 的 languageId / version 透传，缺省不出现在对象里', () => {
    const bare = formattingRequestOf({ path: 'a.ERB' }, 'x', null);
    expect('languageId' in bare).toBe(false);
    expect('version' in bare).toBe(false);

    const full = formattingRequestOf({ path: 'a.ERB', languageId: 'erb', version: 7 }, 'x', null);
    expect(full.languageId).toBe('erb');
    expect(full.version).toBe(7);
    expect(full.kind).toBe('formatting');
  });
});

/* ======================= B3c：悬停整块响应腿 + 两枚请求构造器 ======================= */

describe('collectHoverResult · 整块响应（单答口径与 collectHoverContents 逐字一致）', () => {
  const hoverRequest: EditorLanguageServiceRequest = { ...REQUEST, kind: 'hover', column: 1 };

  it('第一家作答后不再问下一家，且交回的是**整个响应**（format/range 不丢）', () => {
    const second = vi.fn(() => ({ kind: 'hover' as const, contents: '第二家' }));
    const result = collectHoverResult(
      [
        answer('a', () => ({
          kind: 'hover',
          contents: '**第一家**',
          format: 'markdown' as const,
          range: { line: 3, startColumn: 1, endColumn: 6 },
        })),
        answer('b', second),
      ],
      hoverRequest,
    );
    expect(result).toEqual({
      kind: 'hover',
      contents: '**第一家**',
      format: 'markdown',
      range: { line: 3, startColumn: 1, endColumn: 6 },
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('弃权（undefined）继续问下一家；`contents === \'\'` 是作答、整块交回', () => {
    const skipped = collectHoverResult(
      [answer('skip', () => undefined), answer('real', () => ({ kind: 'hover', contents: '轮到我' }))],
      hoverRequest,
    );
    expect(skipped?.contents).toBe('轮到我');

    const second = vi.fn(() => ({ kind: 'hover' as const, contents: '不该出现' }));
    const answered = collectHoverResult(
      [answer('empty', () => ({ kind: 'hover', contents: '' })), answer('b', second)],
      hoverRequest,
    );
    expect(answered).toEqual({ kind: 'hover', contents: '' });
    expect(second).not.toHaveBeenCalled();
  });

  it('无人应答 = undefined（不是 `{contents:\'\'}`——顶掉宿主兜底就是从这里区分出来的）', () => {
    expect(collectHoverResult([answer('a', () => undefined)], hoverRequest)).toBeUndefined();
  });

  it('一家抛错只让这家缺席（warn 带贡献 id），下一家照常作答', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = collectHoverResult(
      [
        answer('boom', () => {
          throw new Error('炸了');
        }),
        answer('real', () => ({ kind: 'hover', contents: '还在' })),
      ],
      hoverRequest,
    );
    expect(result?.contents).toBe('还在');
    expect(String(warn.mock.calls[0]?.[0])).toContain('boom');
    warn.mockRestore();
  });

  it('与 collectHoverContents 对拍：同一家作答时两腿的 contents 逐字相同', () => {
    const contributions = [
      answer('skip', () => undefined),
      answer('real', () => ({ kind: 'hover', contents: '同一条正文', format: 'markdown' as const })),
    ];
    expect(collectHoverContents(contributions, hoverRequest)).toBe(
      collectHoverResult(contributions, hoverRequest)?.contents,
    );
    const emptyFirst = [answer('a', () => ({ kind: 'hover', contents: '' }))];
    expect(collectHoverContents(emptyFirst, hoverRequest)).toBe('');
    expect(collectHoverResult(emptyFirst, hoverRequest)?.contents).toBe('');
  });
});

describe('completionRequestOf / hoverRequestOf · 请求构造（与 formattingRequestOf 同源形状）', () => {
  it('completion：kind/坐标/project 就位，lineCount 与 formatting 同一把尺', () => {
    const req = completionRequestOf({ path: 'a.ERB' }, 'a\nb\nc\n', 1, 6, null);
    expect(req.kind).toBe('completion');
    expect(req.path).toBe('a.ERB');
    expect(req.line).toBe(1);
    expect(req.column).toBe(6);
    expect(req.project).toBeNull();
    expect(req.lineCount).toBe(4);
    expect(completionRequestOf({ path: 'a.ERB' }, '', 1, 1, null).lineCount).toBe(1);
  });

  it('completion：`triggerCharacter` 不给 = 键不出现在对象里（缺省 = 手动触发）', () => {
    const manual = completionRequestOf({ path: 'a.ERB' }, 'x', 1, 2, null);
    expect('triggerCharacter' in manual).toBe(false);
    const typed = completionRequestOf({ path: 'a.ERB' }, 'x', 1, 2, null, ':');
    expect(typed.triggerCharacter).toBe(':');
  });

  it('hover：同源形状、无触发字符位', () => {
    const req = hoverRequestOf({ path: 'a.ERB', languageId: 'erb', version: 7 }, 'x', 2, 3, null);
    expect(req.kind).toBe('hover');
    expect(req.languageId).toBe('erb');
    expect(req.version).toBe(7);
    expect(req.line).toBe(2);
    expect(req.column).toBe(3);
    expect(req.lineCount).toBe(1);
    expect('triggerCharacter' in req).toBe(false);
  });

  it('两枚构造器都保持"identity 缺省键不出现"的旧口径（与 formattingRequestOf 逐字同规）', () => {
    const c = completionRequestOf({ path: 'a.ERB' }, 'x', 1, 1, null);
    expect('languageId' in c).toBe(false);
    expect('version' in c).toBe(false);
    const h = hoverRequestOf({ path: 'a.ERB' }, 'x', 1, 1, null);
    expect('languageId' in h).toBe(false);
    expect('version' in h).toBe(false);
  });
});
