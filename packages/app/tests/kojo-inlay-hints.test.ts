/**
 * 行内提示 · 宿主接线（LS-R6：`inlayHintsAffordable` / `collectInlayHints` /
 * `toMonacoInlayHints` / `installInlayHintsProvider`）单测。
 *
 * 桩 monaco（只给注册面 + 枚举）+ 桩 model（行数与行宽），同 `kojo-code-lens.test.ts` 口径。
 * 覆盖五件事：(a) 体量档的界线——R1（2026-10-28）起**按语言分流**：按窗口取数的 ERB
 * 没有行数闸，整篇取数的 `.kojo1` / kojo2 照旧；(b) 合并三态、抛错隔离、去重（行+列+文本键，
 * 同格不同文本保留）；(c) 越界行**丢弃**（不夹取）与列夹到行尾、Monaco 形状（Parameter 种类、
 * tooltip / paddingLeft 缺省不出现）；(d) 注册 ERB + `.kojo` + kojo2 三门语言、注册与回收成对、
 * resolve 抛错退空不崩、**Monaco 给的行窗口原样下传**。**宿主零判据**：这里没有一条断言
 * 认识「形参槽」是什么意思。
 *
 * B2c（2026-10-24）起注册面是**三门**语言：kojo2 的 descriptor 点名了
 * `slotServices: ['inlayHint']`，共享收口于是也给它挂上同一枚 provider（供方是插件
 * `@kojo/plugin-kojo-lang`）。断言的意图（"注册面拉平、判据全在 resolve 里逐次现判"）
 * 不变，变的只是数量——所以这里跟着改数字，**不是**放宽。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorInlayHint,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  collectInlayHints,
  inlayHintsAffordable,
  inlayHintsWindowed,
  installInlayHintsProvider,
  toMonacoInlayHints,
  type InlayHintHandlers,
} from '../src/monaco/kojo-inlay-hints';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'inlayHint',
  path: 'C:/p/a.ERB',
  text: '@A\nCALL A, 1',
  project: null,
  lineCount: 2,
};

const hint = (line: number, column: number, label: string): EditorInlayHint => ({ line, column, label });

const contribution = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

const modelWith = (lineCount: number, maxColumn = 40): Monaco.editor.ITextModel =>
  ({
    getLineCount: () => lineCount,
    getLineMaxColumn: () => maxColumn,
  }) as unknown as Monaco.editor.ITextModel;

/** 桩 monaco：注册面捕获 provider + 语言 id（同 erb-rename.test.ts 口径） */
function stubMonaco() {
  const providers: Monaco.languages.InlayHintsProvider[] = [];
  const languageIds: string[] = [];
  const subs: Array<{ disposed: boolean }> = [];
  const monaco = {
    languages: {
      registerInlayHintsProvider: (lang: string, provider: Monaco.languages.InlayHintsProvider) => {
        providers.push(provider);
        languageIds.push(lang);
        const sub = { disposed: false };
        subs.push(sub);
        return { dispose: () => void (sub.disposed = true) };
      },
      InlayHintKind: { Type: 1, Parameter: 2 },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, providers, subs, languageIds };
}

describe('inlayHintsAffordable · 体量档（判在问供方之前）', () => {
  it('按窗口取数的语言（ERB）**没有行数闸**：52,601 行照办', () => {
    // R1（2026-10-28）：ERB 供方把 Monaco 的 range 吃进了输入，单价正比于视口
    // （52,601 行整篇 32.9 ms → 中段 400 行 0.6 ms），行数不再是判据。
    for (const lineCount of [1, LARGE_FILE_LINES - 1, LARGE_FILE_LINES, 24_197, 52_601]) {
      expect(inlayHintsAffordable(ERB_LANGUAGE_ID, lineCount), `${lineCount} 行`).toBe(true);
    }
  });

  it('整篇取数的腿（`.kojo1` 糖线 / kojo2）照旧吃 LARGE_FILE_LINES', () => {
    for (const languageId of [KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]) {
      expect(inlayHintsAffordable(languageId, LARGE_FILE_LINES - 1), languageId).toBe(true);
      expect(inlayHintsAffordable(languageId, LARGE_FILE_LINES), languageId).toBe(false);
    }
  });

  it('`inlayHintsWindowed` 只认 ERB：判据是供方的代价形状，不是语言偏好', () => {
    expect(inlayHintsWindowed(ERB_LANGUAGE_ID)).toBe(true);
    expect(inlayHintsWindowed(KOJO_LANGUAGE_ID)).toBe(false);
    expect(inlayHintsWindowed(KOJO2_LANGUAGE_ID)).toBe(false);
    expect(inlayHintsWindowed('json')).toBe(false);
  });
});

describe('collectInlayHints · 合并三态 / 抛错隔离 / 去重', () => {
  it('`undefined` 跳过、空数组不加、别的判别成员不打扰本面', () => {
    const out = collectInlayHints(
      [
        contribution('nope', () => undefined),
        contribution('none', () => ({ kind: 'inlayHint', hints: [] })),
        contribution('other', () => ({ kind: 'foldingRange', ranges: [] })),
        contribution('hit', () => ({ kind: 'inlayHint', hints: [hint(2, 8, 'ARG')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([hint(2, 8, 'ARG')]);
  });

  it('单枚贡献抛错不影响其余（能力出错退化可见）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectInlayHints(
      [
        contribution('boom', () => {
          throw new Error('boom');
        }),
        contribution('ok', () => ({ kind: 'inlayHint', hints: [hint(1, 1, '甲:')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([hint(1, 1, '甲:')]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('去重键 = 行+列+文本；同格不同文本保留', () => {
    const out = collectInlayHints(
      [
        contribution('a', () => ({ kind: 'inlayHint', hints: [hint(2, 8, 'ARG'), hint(2, 8, 'ARG:1')] })),
        contribution('b', () => ({ kind: 'inlayHint', hints: [hint(2, 8, 'ARG')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([hint(2, 8, 'ARG'), hint(2, 8, 'ARG:1')]);
  });

  it('按行、列升序输出', () => {
    const out = collectInlayHints(
      [
        contribution(
          'a',
          () => ({ kind: 'inlayHint', hints: [hint(3, 2, '乙'), hint(2, 9, '丁'), hint(2, 3, '丙')] }),
        ),
      ],
      REQUEST,
    );
    expect(out.map((h) => h.label)).toEqual(['丙', '丁', '乙']);
  });
});

describe('toMonacoInlayHints · Monaco 形状', () => {
  it('越界行丢弃（不夹取）；列夹到行尾；Parameter 种类；tooltip / paddingLeft 缺省不出现', () => {
    const { monaco } = stubMonaco();
    const hints = [
      hint(2, 8, 'ARG'), // 合法
      hint(9, 1, '幽灵'), // 行越界 ⇒ 丢
      hint(1, 999, '越列'), // 列越界 ⇒ 夹到行尾
    ];
    const out = toMonacoInlayHints(monaco, modelWith(2, 30), hints);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ position: { lineNumber: 2, column: 8 }, label: 'ARG', kind: 2 });
    expect(out[0]!.tooltip).toBeUndefined();
    expect(out[0]!.paddingLeft).toBeUndefined();
    expect(out[1]).toMatchObject({ position: { lineNumber: 1, column: 30 }, label: '越列' });
  });

  it('tooltip / paddingLeft 原样透传', () => {
    const { monaco } = stubMonaco();
    const hints = [{ ...hint(1, 1, '甲:'), tooltip: '第 1 参：甲', paddingLeft: true }];
    const out = toMonacoInlayHints(monaco, modelWith(1), hints);
    expect(out[0]).toMatchObject({ tooltip: '第 1 参：甲', paddingLeft: true });
  });
});

describe('installInlayHintsProvider · 注册与回收', () => {
  const handlers: InlayHintHandlers = {
    resolve: (model) => collectInlayHints(
      [contribution('x', () => ({ kind: 'inlayHint', hints: [hint(1, 1, 'ARG')] }))],
      { ...REQUEST, lineCount: model.getLineCount() },
    ),
  };

  it('ERB / `.kojo` / kojo2 三门语言同供方（注册面拉平，W6）；dispose 成对', () => {
    const { monaco, subs, providers, languageIds } = stubMonaco();
    const disposer = installInlayHintsProvider(monaco, handlers);
    // 判据全在 `resolve` 里逐次现判 ⇒ 注册面多一门语言零代价，`.kojo` / kojo2 都不必回来改这里
    expect([...languageIds].sort()).toEqual(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID].sort(),
    );
    expect(providers).toHaveLength(3);
    disposer.dispose();
    expect(subs.every((s) => s.disposed)).toBe(true);
  });

  it('resolve 抛错 ⇒ 空提示 + warn（不把编辑器输入链带崩）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, providers } = stubMonaco();
    installInlayHintsProvider(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const result = providers[0]!.provideInlayHints(modelWith(1), { startLineNumber: 1, endLineNumber: 1 } as Monaco.Range, {
      isCancellationRequested: false,
    } as Monaco.CancellationToken) as { hints: unknown[] };
    expect(result.hints).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('Monaco 给的行窗口**原样**交给 resolve（R1：窗口就是这条腿的输入）', () => {
    const { monaco, providers } = stubMonaco();
    const seen: Array<Monaco.IRange | undefined> = [];
    installInlayHintsProvider(monaco, {
      resolve: (_model, range) => {
        seen.push(range);
        return [];
      },
    });
    const range = { startLineNumber: 20_000, startColumn: 1, endLineNumber: 20_400, endColumn: 1 } as Monaco.Range;
    providers[0]!.provideInlayHints(modelWith(52_601), range, {
      isCancellationRequested: false,
    } as Monaco.CancellationToken);
    providers[0]!.provideInlayHints(modelWith(52_601), undefined as unknown as Monaco.Range, {
      isCancellationRequested: false,
    } as Monaco.CancellationToken);
    expect(seen[0]).toBe(range);
    expect(seen[1]).toBeUndefined();
  });
});
