/**
 * 行内提示 · 宿主接线（LS-R6：`inlayHintsAffordable` / `collectInlayHints` /
 * `toMonacoInlayHints` / `installInlayHintsProvider`）单测。
 *
 * 桩 monaco（只给注册面 + 枚举）+ 桩 model（行数与行宽），同 `kojo-code-lens.test.ts` 口径。
 * 覆盖四件事：(a) 体量档的界线；(b) 合并三态、抛错隔离、去重（行+列+文本键，同格
 * 不同文本保留）；(c) 越界行**丢弃**（不夹取）与列夹到行尾、Monaco 形状（Parameter 种类、
 * tooltip / paddingLeft 缺省不出现）；(d) 注册 ERB + `.kojo` 两门语言、注册与回收成对、
 * resolve 抛错退空不崩。**宿主零判据**：这里没有一条断言认识「形参槽」是什么意思。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorInlayHint,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  collectInlayHints,
  inlayHintsAffordable,
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
  it('界线就是 LARGE_FILE_LINES：到线即不办（与 stickyScroll / 面包屑 / codeLens 同一条线）', () => {
    expect(inlayHintsAffordable(LARGE_FILE_LINES - 1)).toBe(true);
    expect(inlayHintsAffordable(LARGE_FILE_LINES)).toBe(false);
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

  it('ERB + `.kojo` 两门语言同供方（注册面拉平，W6）；dispose 成对', () => {
    const { monaco, subs, providers, languageIds } = stubMonaco();
    const disposer = installInlayHintsProvider(monaco, handlers);
    // 判据全在 `resolve` 里逐次现判 ⇒ 注册面多一门语言零代价，`.kojo` 不必回来改这里
    expect([...languageIds].sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    expect(providers).toHaveLength(2);
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
});
