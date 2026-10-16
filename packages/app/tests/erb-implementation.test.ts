/**
 * 跳到实现（`erb-implementation.ts`）单测——**不依赖真 Monaco**（桩同 `erb-rename.test.ts`）。
 *
 * 纯函数腿：词定位（复用 erb-rename 的字符集）+ byName 命中判定（引擎系统函数 /
 * 拼错词 / $ 标签一律 miss）。Monaco 绑定腿钉死三件行为契约：
 * (a) 索引未建 / 名字不认 ⇒ `undefined`（不报错，Monaco 提示"未找到实现"是真话）；
 * (b) 全部目标有 live model ⇒ 返回真 `LocationLink[]`（且绝不携带未建 model 的 URI）；
 * (c) 有目标缺 model ⇒ 走 `navigate` 事件通道并返回 `undefined`；构造期 model 消失
 *     ⇒ 同样退事件通道（双保险）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbIndex } from '@kojo/plugin-api';
import {
  installImplementationProvider,
  resolveImplementationTarget,
  type ImplementationHandlers,
} from '../src/monaco/erb-implementation';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';

const TOKEN = { isCancellationRequested: false } as Monaco.CancellationToken;

/* ============================== 纯函数：名字判定 ============================== */

const byName = new Map(['FOO_BAR', 'M_KOJO_霊夢'].map((n) => [n, []]));

describe('resolveImplementationTarget', () => {
  it('词中 / 词尾后一格命中；命中按归一化大写', () => {
    const line = 'CALL foo_bar, 1';
    expect(resolveImplementationTarget(line, 7, byName)).toEqual({ kind: 'hit', normalizedName: 'FOO_BAR' });
    expect(resolveImplementationTarget(line, 13, byName)).toEqual({ kind: 'hit', normalizedName: 'FOO_BAR' });
  });

  it('CJK 函数名与 ASCII 连成一词', () => {
    const line = 'CALL M_KOJO_霊夢';
    expect(resolveImplementationTarget(line, 9, byName)).toEqual({ kind: 'hit', normalizedName: 'M_KOJO_霊夢' });
  });

  it('引擎系统函数（不在索引）/ $ 标签 / 拼错词 ⇒ miss（真话：没有实现）', () => {
    expect(resolveImplementationTarget('CALL TRAIN_MESSAGE', 7, byName)).toEqual({ kind: 'miss' });
    expect(resolveImplementationTarget('GOTO *retry', 8, byName)).toEqual({ kind: 'miss' });
    expect(resolveImplementationTarget('CALL FOO_BAZ', 7, byName)).toEqual({ kind: 'miss' });
  });

  it('光标不在词上 ⇒ miss', () => {
    expect(resolveImplementationTarget('CALL FOO_BAR', 5, byName)).toEqual({ kind: 'miss' });
  });
});

/* ============================== Monaco 绑定腿 ============================== */

interface ModelOpts {
  lineContent: string;
  word?: { startColumn: number; endColumn: number } | null;
}

const stubModel = ({ lineContent, word = null }: ModelOpts): Monaco.editor.ITextModel =>
  ({
    getLineContent: () => lineContent,
    getLineCount: () => 20,
    getLineMaxColumn: () => lineContent.length + 1,
    getWordAtPosition: () => word,
    uri: { toString: () => 'file:///x.ERB' },
  }) as unknown as Monaco.editor.ITextModel;

const indexWith = (name: string, defs: Array<{ file: string; line: number }>): ErbIndex =>
  ({
    byName: new Map([
      [name, defs.map((d) => ({ name, normalizedName: name, filePath: d.file, startLine: d.line, endLine: d.line + 1 }))],
    ]),
    files: new Map(),
  }) as unknown as ErbIndex;

/** 桩 monaco：只给注册面（同 erb-rename.test.ts 口径） */
function stubMonaco() {
  const registered: Array<{ language: string; provider: Monaco.languages.ImplementationProvider }> = [];
  const monaco = {
    languages: {
      registerImplementationProvider: (_lang: string, provider: Monaco.languages.ImplementationProvider) => {
        registered.push({ language: _lang, provider });
        return { dispose: () => undefined };
      },
      InlayHintKind: { Type: 1, Parameter: 2 },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

const makeHandlers = (overrides: Partial<ImplementationHandlers> = {}) => ({
  canAnswer: () => true,
  currentIndex: () => indexWith('FOO_BAR', [{ file: 'C:/p/a.ERB', line: 10 }]),
  navigate: () => undefined,
  openModelFor: () => undefined,
  ...overrides,
});

describe('installImplementationProvider · 绑定契约', () => {
  it('只对 ERB 方言注册', () => {
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, makeHandlers());
    expect(registered.map((r) => r.language)).toEqual([ERB_LANGUAGE_ID]);
  });

  it('名字不认 / 索引未建 ⇒ undefined（不报错）', () => {
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, makeHandlers());
    const { provider } = registered[0]!;
    const model = stubModel({ lineContent: 'CALL TRAIN_MESSAGE' });
    expect(provider.provideImplementation(model, { lineNumber: 1, column: 7 } as Monaco.Position, TOKEN)).toBeUndefined();
    expect(
      installProviderWith(indexWith('FOO_BAR', [])).provideImplementation(model, { lineNumber: 1, column: 7 } as Monaco.Position, TOKEN),
    ).toBeUndefined();
  });

  it('目标没开标签 ⇒ navigate 事件通道 + undefined', () => {
    const navigated: unknown[] = [];
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, makeHandlers({ navigate: (l) => navigated.push(l) }));
    const { provider } = registered[0]!;
    const model = stubModel({ lineContent: 'CALL FOO_BAR' });
    expect(provider.provideImplementation(model, { lineNumber: 1, column: 7 } as Monaco.Position, TOKEN)).toBeUndefined();
    expect(navigated).toEqual([{ filePath: 'C:/p/a.ERB', line: 10 }]);
  });

  it('目标已开 ⇒ 返回 LocationLink（uri = 打开 model 的 uri，不携带未建 model 的 URI）', () => {
    const targetModel = stubModel({ lineContent: '@FOO_BAR' });
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(
      monaco,
      makeHandlers({ openModelFor: () => targetModel }),
    );
    const { provider } = registered[0]!;
    const model = stubModel({
      lineContent: 'CALL FOO_BAR',
      word: { startColumn: 6, endColumn: 13 },
    });
    const links = provider.provideImplementation(model, { lineNumber: 1, column: 7 } as Monaco.Position, TOKEN);
    expect(Array.isArray(links)).toBe(true);
    const link = (links as Monaco.languages.LocationLink[])[0]!;
    expect(link.uri).toBe(targetModel.uri);
    expect(link.targetSelectionRange!.startLineNumber).toBe(10);
    expect(link.originSelectionRange).toEqual({
      startLineNumber: 1,
      startColumn: 6,
      endLineNumber: 1,
      endColumn: 13,
    });
  });

  function installProviderWith(index: ErbIndex): Monaco.languages.ImplementationProvider {
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, makeHandlers({ currentIndex: () => index }));
    return registered[0]!.provider;
  }
});
