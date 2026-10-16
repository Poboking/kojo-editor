/**
 * 查找所有引用（`find-references.ts`）单测——**不依赖真 Monaco**。
 *
 * 纯逻辑腿：多贡献方合并的隔离（单个抛错不影响其余）与去重（文件+行列键）。
 * Monaco 绑定腿：桩 monaco（`registerReferenceProvider` / `registerEditorOpener` /
 * `Uri.file`）+ 桩 model，钉死三条腿的行为契约：
 * (a) 已打开文件用真 model 的 uri（Peek 预览与就地跳的数据源）；
 * (b) 未打开文件发 file URI（ReferencesModel 逐条 catch，树项保留、计数不说谎），
 *     且点击经本模块的 opener 落回 `navigate` 通道；
 * (c) 已打开文件的 URI **不进** opener 反查表（不抢 kojo-definition opener 的活）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorLanguageServiceContribution, EditorSymbolLocation } from '@kojo/plugin-api';
import { collectReferenceLocations, installReferenceProvider } from '../src/monaco/find-references';

/* ============================== 纯逻辑：合并与去重 ============================== */

const contributionOf = (
  id: string,
  locations: readonly EditorSymbolLocation[],
  boom = false,
): EditorLanguageServiceContribution => ({
  id,
  order: 20,
  provide: (request) => {
    if (request.kind !== 'references') return undefined;
    if (boom) throw new Error(id + ' 炸了');
    return { kind: 'references', locations };
  },
});

describe('collectReferenceLocations', () => {
  it('按槽序合并；同文件同行同列去重', () => {
    const locations = collectReferenceLocations(
      [
        contributionOf('a', [
          { filePath: '/t/A.ERB', line: 1, column: 2 },
          { filePath: '/t/B.ERB', line: 3 },
        ]),
        contributionOf('b', [{ filePath: '/t/A.ERB', line: 1, column: 2 }]),
      ],
      { kind: 'references', path: '/t/A.ERB', text: '', line: 1, column: 1, project: null },
    );
    expect(locations).toEqual([
      { filePath: '/t/A.ERB', line: 1, column: 2 },
      { filePath: '/t/B.ERB', line: 3 },
    ]);
  });

  it('单个贡献方抛错不影响其余（隔离：能力退化可见，不让整条查找消失）', () => {
    const locations = collectReferenceLocations(
      [
        contributionOf('bad', [], true),
        contributionOf('good', [{ filePath: '/t/A.ERB', line: 1 }]),
      ],
      { kind: 'references', path: '/t/A.ERB', text: '', line: 1, column: 1, project: null },
    );
    expect(locations).toEqual([{ filePath: '/t/A.ERB', line: 1 }]);
  });
});

/* ============================== Monaco 绑定腿（桩） ============================== */

interface Stub {
  providers: { languageId: string; provider: Monaco.languages.ReferenceProvider }[];
  monaco: typeof Monaco;
  readonly opener: Monaco.editor.ICodeEditorOpener | undefined;
}

function stubMonaco(): Stub {
  const providers: Stub['providers'] = [];
  let openerRef: Monaco.editor.ICodeEditorOpener | undefined;
  const monaco = {
    languages: {
      registerReferenceProvider: (languageId: string, provider: Monaco.languages.ReferenceProvider) => {
        providers.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: {
      registerEditorOpener: (o: Monaco.editor.ICodeEditorOpener) => {
        openerRef = o;
        return { dispose: () => undefined };
      },
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }),
    },
  } as unknown as typeof Monaco;
  return { providers, monaco, get opener() { return openerRef; } };
}

function modelOf(path: string, lines: readonly string[]): Monaco.editor.ITextModel {
  return {
    uri: { fsPath: path, toString: () => `file:///${path.replace(/\\/g, '/')}` } as Monaco.Uri,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

const LOCATIONS: readonly EditorSymbolLocation[] = [
  { filePath: '/t/A.ERB', line: 1, column: 6 },
  { filePath: '/t/B.ERB', line: 4, column: 8 },
];

describe('installReferenceProvider', () => {
  it('为 ERB 与 .kojo 两种语言 id 注册同一 provider', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, { resolve: () => [], navigate: () => undefined });
    expect(stub.providers.map((p) => p.languageId).sort()).toEqual(['kojo-erb', 'kojo-sugar']);
  });

  it('已打开文件用真 model 的 uri；未打开文件发 file URI 且不进 opener 反查表', () => {
    const stub = stubMonaco();
    const openB = modelOf('/t/B.ERB', ['x', 'y', 'z']);
    installReferenceProvider(stub.monaco, {
      resolve: () => LOCATIONS,
      navigate: () => undefined,
      openModelFor: (p) => (p === '/t/B.ERB' ? openB : undefined),
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(modelOf('/t/A.ERB', ['CALL ALPHA']), AT(1, 6), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken) as Monaco.languages.Location[];
    expect(out).toHaveLength(2);
    expect(out[0]!.uri.toString()).toBe('file:////t/A.ERB'); // 未打开 → file URI（Peek 物化逐条 catch，树项保留）
    expect(out[1]!.uri.toString()).toBe('file:////t/B.ERB');
  });

  it('未打开文件的引用点击 → opener 反查路径 → navigate（跨文件跳转可达）', () => {
    const stub = stubMonaco();
    const navigated: EditorSymbolLocation[] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => LOCATIONS,
      navigate: (l) => navigated.push(l),
      openModelFor: () => undefined,
    });
    const provider = stub.providers[0]!.provider;
    provider.provideReferences!(modelOf('/t/A.ERB', ['CALL ALPHA']), AT(1, 6), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken);
    const landed = stub.opener!.openCodeEditor(
      modelOf('/t/A.ERB', ['CALL ALPHA']) as unknown as Monaco.editor.ICodeEditor,
      { toString: () => 'file:////t/B.ERB' } as Monaco.Uri,
      { lineNumber: 4, column: 8 },
    );
    expect(landed).toBe(true);
    expect(navigated).toEqual([{ filePath: '/t/B.ERB', line: 4, column: 8 }]);
  });

  it('不是本 provider 发过的 URI → opener 返回 false（不抢别人的请求）', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, { resolve: () => [], navigate: () => undefined });
    const landed = stub.opener!.openCodeEditor(
      modelOf('/t/A.ERB', ['x']) as unknown as Monaco.editor.ICodeEditor,
      { toString: () => 'file:////other.ERB' } as Monaco.Uri,
      { lineNumber: 1, column: 1 },
    );
    expect(landed).toBe(false);
  });

  it('resolve 抛错 ⇒ undefined（不让 Shift+F12 崩编辑器）', () => {
    const stub = stubMonaco();
    installReferenceProvider(stub.monaco, {
      resolve: () => {
        throw new Error('宿主炸了');
      },
      navigate: () => undefined,
    });
    const provider = stub.providers[0]!.provider;
    const out = provider.provideReferences!(modelOf('/t/A.ERB', ['x']), AT(1, 1), {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken);
    expect(out).toBeUndefined();
  });
});
