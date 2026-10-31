/**
 * A4（语言无关叠层）的判据钉子：**每门声明 `structure` 的语言各起一条线程**，
 * provider 按语言分派，邻居的 wasm 失败 / 资源缺席不许带走别人。
 *
 * 这是 ERB 一等支持的基础设施验收：ERB 的结构运行时只要往 descriptor 的
 * `structure.load()` 里一挂，叠层就自动为它注册；`providers.ts` 不再认识任何语言名。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { LanguageDescriptor } from '../src/monaco/language-registry';
import {
  disposeStructureOverlay,
  installStructureOverlay,
  structureOverlayLanguageStates,
  structureOverlayState,
} from '../src/monaco/tree-sitter/providers';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    readonly runtime: { grammarWasmUrl: string };
    readonly options: {
      onSyntax?: (model: unknown, faults: readonly unknown[], truncated: boolean) => void;
      onSyntaxClear?: (model: unknown) => void;
    };
    readonly state: string;
    readonly disposed: boolean;
    fatal(message?: string): void;
    readonly foldsCalls: number;
  }>,
  /** DIAG-GATE-1033 接线取证：通用上屏器（桩）收到的每一次 show/clear */
  presenterShows: [] as Array<{ model: unknown; languageId: string }>,
  presenterClears: [] as unknown[],
  ownPresented: 0,
}));

// 通用上屏器换成桩：本档只钉「providers 交下去的语言 id = 本叠层 descriptor.id」这一枚接线，
// 上屏器自身的去重/撤下行为由 `tree-sitter-diagnostics.test.ts` 逐条钉着。
vi.mock('../src/monaco/tree-sitter/syntax-decorations', () => ({
  DECORATOR_MARKER_OWNER: 'kojo-decorators',
  STRUCTURE_SYNTAX_OWNER: 'kojo-structure-syntax',
  createStructureSyntaxPresenter: () => ({
    show: (model: unknown, _faults: readonly unknown[], _truncated: boolean, languageId: string) => {
      harness.presenterShows.push({ model, languageId });
    },
    clear: (model: unknown) => {
      harness.presenterClears.push(model);
    },
    clearAll: () => undefined,
    dispose: () => undefined,
  }),
}));

vi.mock('../src/monaco/tree-sitter/client', () => {
  class StubStructureClient {
    readonly runtime: { grammarWasmUrl: string };
    readonly options: {
      onFatal?: (message: string) => void;
      onSyntax?: (model: unknown, faults: readonly unknown[], truncated: boolean) => void;
      onSyntaxClear?: (model: unknown) => void;
    };
    private dead = false;
    disposed = false;
    foldsCalls = 0;
    constructor(options: { runtime: { grammarWasmUrl: string }; onFatal?: (message: string) => void }) {
      this.runtime = options.runtime;
      this.options = options;
      harness.instances.push(this as unknown as (typeof harness)['instances'][number]);
    }
    get state(): string {
      return this.dead ? 'dead' : 'ready';
    }
    get indent(): null {
      return null;
    }
    async tokens(): Promise<null> {
      return null;
    }
    async foldingRanges(): Promise<Array<{ startRow: number; endRow: number }>> {
      this.foldsCalls += 1;
      return [{ startRow: 0, endRow: 1 }];
    }
    dispose(): void {
      this.disposed = true;
    }
    fatal(message = 'wasm 炸了'): void {
      this.dead = true;
      (this.options.onFatal ?? (() => undefined))(message);
    }
  }
  return { StructureClient: StubStructureClient, STRUCTURE_REQUEST_TIMEOUT_MS: 4_000 };
});

function fakeRuntime(id: string, semantic: boolean): StructureLanguageRuntime {
  return {
    runtimeWasmUrl: `${id}.runtime.wasm`,
    grammarWasmUrl: `${id}.grammar.wasm`,
    createWorker: () => {
      throw new Error('桩 client 不建线程');
    },
    ...(semantic
      ? {
          semantic: {
            legend: { tokenTypes: [], tokenModifiers: [] },
            encode: () => ({
              data: new Uint32Array(0),
              droppedRows: 0,
              droppedEmpty: 0,
              droppedWide: 0,
              droppedOverlaps: 0,
            }),
          },
        }
      : {}),
  };
}

function descriptor(id: string, runtime?: StructureLanguageRuntime): LanguageDescriptor {
  return {
    id,
    label: id,
    matchesPath: () => false,
    register: () => undefined,
    ...(runtime ? { structure: { load: async () => runtime } } : {}),
  };
}

interface ProviderMap {
  readonly semantic: Map<string, { provideDocumentSemanticTokens(...args: never[]): Promise<unknown> }>;
  readonly folding: Map<string, { provideFoldingRanges(model: { getLineCount(): number }): Promise<Array<{ start: number; end: number }>> }>;
  readonly disposed: Set<string>;
}

function fakeMonaco(): { monaco: typeof Monaco; providers: ProviderMap } {
  const providers: ProviderMap = { semantic: new Map(), folding: new Map(), disposed: new Set() };
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      registerDocumentSemanticTokensProvider: (id: string, provider: never) => {
        providers.semantic.set(id, provider);
        return { dispose: () => void providers.disposed.add(`semantic:${id}`) };
      },
      registerFoldingRangeProvider: (id: string, provider: never) => {
        providers.folding.set(id, provider);
        return { dispose: () => void providers.disposed.add(`folding:${id}`) };
      },
      setLanguageConfiguration: () => ({ dispose: () => undefined }),
    },
    editor: {
      getEditors: () => [],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
      getModelMarkers: () => [],
      setModelMarkers: () => undefined,
      onDidChangeMarkers: () => ({ dispose: () => undefined }),
    },
  } as unknown as typeof Monaco;
  return { monaco, providers };
}

function fakeModel(languageId: string): { getLanguageId(): string; getLineCount(): number; getLineMaxColumn(): number; isDisposed(): boolean } {
  return {
    getLanguageId: () => languageId,
    getLineCount: () => 20,
    getLineMaxColumn: () => 10,
    isDisposed: () => false,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('installStructureOverlay · 逐语言装配与隔离', () => {
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.instances.length = 0;
    harness.presenterShows.length = 0;
    harness.presenterClears.length = 0;
    harness.ownPresented = 0;
    resetStructureDegradationLedger();
    notices = [];
    unsubscribe = onStructureDegradation((notice) =>
      notices.push(`${notice.capability}/${notice.stage}:${notice.message}`),
    );
    const store = new Map<string, string>([['kojo.ui.treeSitter.v1', 'on']]);
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    };
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    disposeStructureOverlay();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('每门声明 structure 的语言各起一条 client；semantic 面按运行时声明注册', async () => {
    const { monaco, providers } = fakeMonaco();
    installStructureOverlay(monaco, [
      descriptor('lang-a', fakeRuntime('a', true)),
      descriptor('lang-b', fakeRuntime('b', false)),
      descriptor('lang-c'), // 没有结构层 ⇒ 不参与
    ]);
    await flush();

    expect(harness.instances.map((instance) => instance.runtime.grammarWasmUrl)).toEqual([
      'a.grammar.wasm',
      'b.grammar.wasm',
    ]);
    expect([...providers.semantic.keys()]).toEqual(['lang-a']);
    expect([...providers.folding.keys()].sort()).toEqual(['lang-a', 'lang-b']);
    expect(structureOverlayLanguageStates()).toEqual({ 'lang-a': 'ready', 'lang-b': 'ready' });
  });

  it('折叠请求按语言落到各自的 client（A 的模型不经过 B 的线程）', async () => {
    const { monaco, providers } = fakeMonaco();
    installStructureOverlay(monaco, [
      descriptor('lang-a', fakeRuntime('a', true)),
      descriptor('lang-b', fakeRuntime('b', false)),
    ]);
    await flush();

    const providerA = providers.folding.get('lang-a')!;
    const providerB = providers.folding.get('lang-b')!;
    expect(await providerA.provideFoldingRanges(fakeModel('lang-a'))).toEqual([{ start: 1, end: 2 }]);
    expect(harness.instances[0]!.foldsCalls).toBe(1);
    expect(harness.instances[1]!.foldsCalls).toBe(0);

    expect(await providerB.provideFoldingRanges(fakeModel('lang-b'))).toEqual([{ start: 1, end: 2 }]);
    expect(harness.instances[1]!.foldsCalls).toBe(1);

    // 语言对不上 ⇒ 原样退场（另一门语言的线程一次都不碰）
    expect(await providerA.provideFoldingRanges(fakeModel('lang-b'))).toEqual([]);
    expect(harness.instances[0]!.foldsCalls).toBe(1);
  });

  it('一门语言的 wasm 失败只拆它自己，邻居照常活着；全部死完才整档退场', async () => {
    const { monaco, providers } = fakeMonaco();
    installStructureOverlay(monaco, [
      descriptor('lang-a', fakeRuntime('a', true)),
      descriptor('lang-b', fakeRuntime('b', false)),
    ]);
    await flush();

    harness.instances[0]!.fatal('A 的 wasm 炸了');
    expect(structureOverlayState().active).toBe(true);
    expect(structureOverlayLanguageStates()).toEqual({ 'lang-b': 'ready' });
    expect(providers.disposed.has('semantic:lang-a')).toBe(true);
    expect(providers.disposed.has('folding:lang-a')).toBe(true);
    expect(providers.folding.has('lang-b')).toBe(true);

    harness.instances[1]!.fatal('B 的 wasm 炸了');
    expect(structureOverlayState()).toEqual({ installed: true, active: false, client: null });
  });

  it('一门语言的资源装载失败不拖累另一门（ERB 未达质量闸时的形态）', async () => {
    const { monaco, providers } = fakeMonaco();
    const missing: LanguageDescriptor = {
      ...descriptor('lang-missing'),
      structure: {
        load: async () => {
          throw new Error('grammar 还没装配');
        },
      },
    };
    installStructureOverlay(monaco, [missing, descriptor('lang-b', fakeRuntime('b', false))]);
    await flush();

    expect(structureOverlayLanguageStates()).toEqual({ 'lang-b': 'ready' });
    expect(providers.folding.has('lang-missing')).toBe(false);
    expect(notices.some((line) => line.includes('资源装载失败'))).toBe(true);
  });

  it('结构残缺接线（DIAG-GATE-1033）：通用上屏只接本叠层自己的 descriptor.id；运行时自带 presentSyntax 的一枚都不碰通用器', async () => {
    const { monaco } = fakeMonaco();
    const ownSyntaxRuntime: StructureLanguageRuntime = {
      ...fakeRuntime('b', false),
      presentSyntax: ({ model }) => {
        harness.ownPresented += 1;
        void model;
      },
      clearSyntax: () => undefined,
    };
    installStructureOverlay(monaco, [
      descriptor('lang-a', fakeRuntime('a', false)), // 不声明 presentSyntax ⇒ 走通用上屏器（今天只有 `.kojo` 这条腿）
      descriptor('lang-b', ownSyntaxRuntime), // ERB 的形状：上屏方式由运行时自己声明
    ]);
    await flush();
    expect(harness.instances).toHaveLength(2);
    const [clientA, clientB] = harness.instances;
    // 残缺到货 ⇒ providers 交下去的语言 id 就是这条叠层自己的（宿主不认识任何具体语言名）；
    // 语言身份过滤在通用上屏器里做（改判据形态的同结果钉在 `tree-sitter-diagnostics.test.ts`）
    clientA!.options.onSyntax!(fakeModel('lang-a'), [], false);
    expect(harness.presenterShows).toHaveLength(1);
    expect(harness.presenterShows[0]!.languageId).toBe('lang-a');
    // 撤下走通用上屏器的 clear
    clientA!.options.onSyntaxClear!(fakeModel('lang-a'));
    expect(harness.presenterClears).toHaveLength(1);
    // 声明了 presentSyntax 的运行时 ⇒ 通用上屏器一枚都不接（ERB 的文案路不被串台）
    harness.presenterShows.length = 0;
    harness.presenterClears.length = 0;
    clientB!.options.onSyntax!(fakeModel('lang-b'), [], false);
    clientB!.options.onSyntaxClear!(fakeModel('lang-b'));
    expect(harness.ownPresented).toBe(1);
    expect(harness.presenterShows).toHaveLength(0);
    expect(harness.presenterClears).toHaveLength(0);
  });
});
