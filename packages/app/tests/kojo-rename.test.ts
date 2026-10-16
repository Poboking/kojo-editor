/**
 * `.kojo` 用户函数重命名（`kojo-rename.ts`）单测——**不依赖真 Monaco**。
 *
 * Monaco 绑定腿：桩 monaco（只有 `registerRenameProvider`）+ 桩 model + 桩 handlers，
 * 钉死三件行为契约：
 * (a) `resolveRenameLocation` 只给词区间（中文名整串；无词 ⇒ undefined 走 Monaco 缺省回退），
 *     "可不可以改"在编辑期由槽给拒绝理由；
 * (b) 槽的 `rejectReason` 原样透传（monaco 0.57 见理由即丢弃全部编辑只弹 info——全或无）；
 * (c) **落地前现文本验证**：任何一处列区间上的现文本 ≠ `oldName` ⇒ 整次拒绝
 *     （请求与落地之间作者可能已打字，陈旧坐标绝不硬写，部分应用 = 名字分叉）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorRenameEdit } from '@kojo/plugin-api';
import { unicodeTokenAt } from '@kojo/plugin-api';
import { installKojoRename } from '../src/monaco/kojo-rename';

/* ============================== 纯函数：光标词（契约件直用） ============================== */

describe('unicodeTokenAt（kojo-rename 的词区间来源）', () => {
  it('中文名整串命中', () => {
    expect(unicodeTokenAt('函数 问候()：', 5)).toEqual({ text: '问候', startColumn: 4, endColumn: 6 });
  });
});

/* ============================== Monaco 绑定腿（桩） ============================== */

interface Stub {
  provider: Monaco.languages.RenameProvider;
  monaco: typeof Monaco;
}

function stubMonaco(): Stub {
  let provider: Monaco.languages.RenameProvider | undefined;
  const monaco = {
    languages: {
      registerRenameProvider: (_languageId: string, p: Monaco.languages.RenameProvider) => {
        provider = p;
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  installKojoRename(monaco, { canAnswer: () => true, resolve: () => ({ edits: [] }) });
  return { provider: provider!, monaco };
}

function modelOf(...lines: string[]): Monaco.editor.ITextModel {
  return {
    uri: { toString: () => 'file:///t/a.kojo' } as Monaco.Uri,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLineMaxColumn: (n: number) => (lines[n - 1] ?? '').length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

const MODEL = modelOf('函数 问候()：', '    调用 问候()', '    「问候(你)」');

describe('installKojoRename', () => {
  it('resolveRenameLocation：中文名整串区间', () => {
    const stub = stubMonaco();
    const loc = stub.provider.resolveRenameLocation!(MODEL, AT(1, 5), {} as Monaco.CancellationToken);
    expect(loc).toEqual({
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 6 },
      text: '问候',
    });
  });

  it('canAnswer = false ⇒ undefined（派生视图不参与改名）', () => {
    let answer = false;
    const monaco = {
      languages: {
        registerRenameProvider: (_id: string, p: Monaco.languages.RenameProvider) => {
          const loc = p.resolveRenameLocation!(MODEL, AT(1, 5), {} as Monaco.CancellationToken);
          expect(loc).toBeUndefined();
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installKojoRename(monaco, { canAnswer: () => answer, resolve: () => ({ edits: [] }) });
    void answer;
  });

  it('槽给拒绝理由 ⇒ 原样透传（全或无，不做部分应用）', async () => {
    const stub = stubMonaco();
    const monaco = {
      languages: {
        registerRenameProvider: (_id: string, p: Monaco.languages.RenameProvider) => {
          stub.provider = p;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installKojoRename(monaco, {
      canAnswer: () => true,
      resolve: () => ({ edits: [], rejectReason: '不是本文件「函数」声明的名字' }),
    });
    const r = await stub.provider.provideRenameEdits!(MODEL, AT(1, 5), '问好', {} as Monaco.CancellationToken);
    expect(r).toEqual({ edits: [], rejectReason: '不是本文件「函数」声明的名字' });
  });

  it('命中：每处编辑经现文本验证后进 WorkspaceEdit（挂 model 的 uri）', async () => {
    const stub = stubMonaco();
    const edits: readonly EditorRenameEdit[] = [
      { line: 1, startColumn: 4, endColumn: 6, newText: '问好' },
      { line: 2, startColumn: 8, endColumn: 10, newText: '问好' },
    ];
    const monaco = {
      languages: {
        registerRenameProvider: (_id: string, p: Monaco.languages.RenameProvider) => {
          stub.provider = p;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installKojoRename(monaco, { canAnswer: () => true, resolve: () => ({ edits, oldName: '问候' }) });
    const r = await stub.provider.provideRenameEdits!(MODEL, AT(1, 5), '问好', {} as Monaco.CancellationToken);
    expect(r).toEqual({
      edits: [
        {
          resource: MODEL.uri,
          versionId: undefined,
          textEdit: { range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 6 }, text: '问好' },
        },
        {
          resource: MODEL.uri,
          versionId: undefined,
          textEdit: { range: { startLineNumber: 2, startColumn: 8, endLineNumber: 2, endColumn: 10 }, text: '问好' },
        },
      ],
    });
  });

  it('陈旧坐标（区间上已不是原名）⇒ 整次拒绝，绝不硬写', async () => {
    const stale: readonly EditorRenameEdit[] = [{ line: 2, startColumn: 9, endColumn: 11, newText: '问好' }];
    const dirty = modelOf('函数 问候()：', '    调用 问好()'); // 作者已把第 2 行改成新名
    const monaco = {
      languages: {
        registerRenameProvider: async (_id: string, p: Monaco.languages.RenameProvider) => {
          const r = await p.provideRenameEdits!(dirty, AT(1, 5), '问好', {} as Monaco.CancellationToken);
          expect(r).toEqual({ edits: [], rejectReason: expect.stringContaining('坐标失效') });
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installKojoRename(monaco, { canAnswer: () => true, resolve: () => ({ edits: stale, oldName: '问候' }) });
  });
});
