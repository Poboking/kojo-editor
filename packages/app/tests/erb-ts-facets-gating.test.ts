import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import type * as Monaco from '../src/monaco/entry';
import { erbBaseIndentPatterns } from '../src/monaco/tree-sitter/erb-indent';
import { ERB_SEMANTIC_FACET, resetErbSemanticWarnings } from '../src/monaco/tree-sitter/erb-semantic';
import { resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { LanguageDescriptor } from '../src/monaco/language-registry';
import type { KojoStructureIndentRules, KojoStructureToken } from '../src/monaco/tree-sitter/types';
import {
  disposeStructureOverlay,
  installStructureOverlay,
  structureOverlayLanguageStates,
} from '../src/monaco/tree-sitter/providers';

/**
 * ERB-TS-FULL 面⑥：闸门——默认关 = 零注册；dispose 幂等；开 = 只挂 ERB 的两枚 provider。
 * client 走桩（`vi.mock`），本面不碰真 wasm。
 */

afterAll(resetStructureDegradationLedger);

const clientStub = vi.hoisted(() => ({
  indentRules: null as KojoStructureIndentRules | null,
  tokens: [] as KojoStructureToken[],
  folds: [] as Array<{ startRow: number; endRow: number }>,
  instances: 0,
}));

vi.mock('../src/monaco/tree-sitter/client', () => {
  class StubStructureClient {
    constructor(_options: unknown) {
      clientStub.instances++;
    }
    get state(): string {
      return 'ready';
    }
    get indent(): KojoStructureIndentRules | null {
      return clientStub.indentRules;
    }
    async tokens(): Promise<readonly KojoStructureToken[] | null> {
      return clientStub.tokens;
    }
    async foldingRanges(): Promise<readonly { startRow: number; endRow: number }[] | null> {
      return clientStub.folds;
    }
    dispose(): void {
      /* 桩不持有资源 */
    }
  }
  return { StructureClient: StubStructureClient, STRUCTURE_REQUEST_TIMEOUT_MS: 1_000 };
});

interface GatingCaptured {
  semanticId: string | null;
  semantic: Monaco.languages.DocumentSemanticTokensProvider | null;
  folding: Monaco.languages.FoldingRangeProvider | null;
  configs: number;
  lastConfig: Monaco.languages.LanguageConfiguration | null;
  disposed: number;
}

function gatingMonaco(): { monaco: typeof Monaco; captured: GatingCaptured } {
  const captured: GatingCaptured = {
    semanticId: null,
    semantic: null,
    folding: null,
    configs: 0,
    lastConfig: null,
    disposed: 0,
  };
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      registerDocumentSemanticTokensProvider: (id: string, provider: Monaco.languages.DocumentSemanticTokensProvider) => {
        captured.semanticId = id;
        captured.semantic = provider;
        return { dispose: () => void captured.disposed++ };
      },
      registerFoldingRangeProvider: (_id: string, provider: Monaco.languages.FoldingRangeProvider) => {
        captured.folding = provider;
        return { dispose: () => void captured.disposed++ };
      },
      setLanguageConfiguration: (_id: string, config: Monaco.languages.LanguageConfiguration) => {
        captured.configs++;
        captured.lastConfig = config;
        return { dispose: () => void captured.disposed++ };
      },
    },
    editor: {
      getEditors: () => [
        {
          updateOptions: () => undefined,
          onDidChangeConfiguration: () => ({ dispose: () => undefined }),
        },
      ],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
      getModelMarkers: () => [],
      setModelMarkers: () => undefined,
      onDidChangeMarkers: () => ({ dispose: () => undefined }),
    },
  } as unknown as typeof Monaco;
  return { monaco, captured };
}

const erbDescriptor = (load: () => Promise<unknown>): LanguageDescriptor => ({
  id: ERB_LANGUAGE_ID,
  label: 'ERB',
  matchesPath: () => false,
  register: () => undefined,
  structure: { load: load as LanguageDescriptor['structure'] extends { load: infer L } ? L : never },
});

function prefEnv(on: boolean): void {
  // TS-DEFAULT 起默认开：要判关必须显式存 off（空表 = 回默认开）
  const store = new Map<string, string>([['kojo.ui.treeSitter.v1', on ? 'on' : 'off']]);
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ERB 结构叠层的闸门 · 显式关零注册 / 开则只挂 ERB', () => {
  beforeEach(() => {
    clientStub.indentRules = null;
    clientStub.tokens = [];
    clientStub.folds = [];
    clientStub.instances = 0;
    resetStructureDegradationLedger();
    resetErbSemanticWarnings();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    disposeStructureOverlay();
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('偏好显式关：ERB descriptor 也不触发任何 Monaco 注册 / 资源装载', () => {
    prefEnv(false);
    const calls: string[] = [];
    const make = (path: string): unknown =>
      new Proxy(() => undefined, {
        get: (_target, prop) => (typeof prop === 'string' ? make(`${path}.${prop}`) : undefined),
        apply: () => {
          calls.push(path);
          return { dispose: () => undefined };
        },
      });
    let loaded = 0;
    installStructureOverlay(make('monaco') as unknown as typeof Monaco, [
      erbDescriptor(async () => {
        loaded++;
        throw new Error('不该加载');
      }),
    ]);
    expect(calls).toEqual([]);
    expect(loaded).toBe(0);
  });

  it('偏好开：只给 ERB 注册语义 + 折叠两枚 provider', async () => {
    prefEnv(true);
    clientStub.indentRules = null;
    const { monaco, captured } = gatingMonaco();
    installStructureOverlay(monaco, [
      erbDescriptor(async () => ({
        runtimeWasmUrl: 'runtime.wasm（桩）',
        grammarWasmUrl: 'erb.wasm（桩）',
        createWorker: () => {
          throw new Error('桩 client 不建线程');
        },
        semantic: ERB_SEMANTIC_FACET,
        baseIndentPatterns: erbBaseIndentPatterns,
      })),
    ]);
    await flush();
    expect(clientStub.instances).toBe(1);
    expect(captured.semanticId).toBe(ERB_LANGUAGE_ID);
    expect(captured.semantic).not.toBeNull();
    expect(captured.folding).not.toBeNull();
    expect(structureOverlayLanguageStates()[ERB_LANGUAGE_ID]).toBe('ready');
  });

  it('语义 provider 拿到空结果 ⇒ null，但缩进配置已同步（基底 SIF / 注释两格不丢）', async () => {
    prefEnv(true);
    clientStub.tokens = [];
    clientStub.indentRules = {
      increasePatterns: ['^[ \\t]*(?:[Ee][Ll][Ss][Ee])(?![A-Za-z_])'],
      decreasePatterns: [],
      enterPatterns: [],
    };
    const { monaco, captured } = gatingMonaco();
    installStructureOverlay(monaco, [
      erbDescriptor(async () => ({
        runtimeWasmUrl: 'runtime.wasm（桩）',
        grammarWasmUrl: 'erb.wasm（桩）',
        createWorker: () => {
          throw new Error('桩 client 不建线程');
        },
        semantic: ERB_SEMANTIC_FACET,
        baseIndentPatterns: erbBaseIndentPatterns,
      })),
    ]);
    await flush();
    const model = {
      getLanguageId: () => ERB_LANGUAGE_ID,
      getLineCount: () => 3,
      getLineMaxColumn: () => 20,
    } as unknown as Monaco.editor.ITextModel;
    expect(await captured.semantic!.provideDocumentSemanticTokens!(model, null, { isCancellationRequested: false } as Monaco.CancellationToken)).toBeNull();
    expect(captured.configs).toBe(1);
    const indentationRules = captured.lastConfig?.indentationRules;
    expect(indentationRules?.indentNextLinePattern).toBeInstanceOf(RegExp);
    expect(indentationRules?.unIndentedLinePattern).toBeInstanceOf(RegExp);
    expect(indentationRules?.increaseIndentPattern.test('ELSE')).toBe(true);
    expect(indentationRules?.increaseIndentPattern.test('IF X')).toBe(true); // 基底那条还在
    expect(captured.lastConfig?.onEnterRules?.length).toBeGreaterThanOrEqual(erbBaseIndentPatterns().indentOnEnter.length);
  });

  it('dispose 幂等：连拆两次不抛，状态回到"没开过"', () => {
    prefEnv(true);
    const { monaco } = gatingMonaco();
    installStructureOverlay(monaco, [erbDescriptor(async () => ({ runtimeWasmUrl: '', grammarWasmUrl: '', createWorker: () => { throw new Error('x'); } }))]);
    expect(() => disposeStructureOverlay()).not.toThrow();
    expect(() => disposeStructureOverlay()).not.toThrow();
    expect(structureOverlayLanguageStates()).toEqual({});
    expect(clientStub.instances).toBe(0); // 没发 parse 就拆：线程都没起
  });
});
