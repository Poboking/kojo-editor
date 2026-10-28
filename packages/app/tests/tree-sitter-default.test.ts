import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  disposeStructureOverlay,
  installStructureOverlay,
  resolveStructureEnabled,
  resolveStructureFoldsEnabled,
  structureOverlayState,
} from '../src/monaco/tree-sitter/providers';
import { onStructureDegradation, resetStructureDegradationLedger } from '../src/monaco/tree-sitter/fallback';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';
import type { LanguageDescriptor } from '../src/monaco/language-registry';
import { HUGE_FILE_LINES, LARGE_FILE_LINES } from '../src/ui/editor-options';
import {
  TREE_SITTER_DEFAULT,
  loadTreeSitterPref,
  setTreeSitterPref,
  subscribeTreeSitterPref,
} from '../src/ui/tree-sitter-pref';

/**
 * 批次十 TS-DEFAULT：结构层**默认开**的判据（任务四条，逐条落成一组断言）。
 *
 * 1. 默认值 = 开：没存过 / 读不到 / 无 window ⇒ `TREE_SITTER_DEFAULT === true`；
 * 2. 显式关闭：`off` 跨重启保持关，订阅者当场拆 provider，翻回开又能重挂；
 * 3. worker 失败回落：真 `StructureClient` + 起不来的线程 ⇒ provider 回 `null` / `[]`，
 *    台账只说一次（不静默、不刷屏），叠层整档停用；
 * 4. 超大文件跳过：**着色 / 缩进**超过 `LARGE_FILE_LINES` ⇒ 判据为假、provider 让路、
 *    线程一次都不起；**折叠不在此列**（2026-10-28 拆开，它整趟在 worker 里，见
 *    `resolveStructureFoldsEnabled`）。
 *
 * 不 mock `client.ts`：worker 起不来这条走**真 client** 的 `start()` 失败路径（runtime 的
 * `createWorker` 直接抛），比"桩 client 自己回 null"更接近生产形状。真线程 + 真 wasm
 * 的端到端归真壳冒烟（`tools/smoke-tauri-*`），与本文件判据无关。
 */

/** localStorage 假窗（`loadTreeSitterPref` 只认 localStorage） */
function fakeStorage(entries: Iterable<[string, string]> = []): Map<string, string> {
  const store = new Map<string, string>(entries);
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  return store;
}

/** provider 形状（`providers.ts` 注册出去的那两枚；这里只取本文件会调的那一格） */
interface SemanticProvider {
  provideDocumentSemanticTokens(
    model: FakeModel,
    resultId: null,
    token: { isCancellationRequested: boolean },
  ): Promise<unknown>;
}
interface FoldingProvider {
  provideFoldingRanges(model: FakeModel): Promise<unknown[]>;
}

/** 只给装配面要用的那几格（与 `tree-sitter-fallback-wiring.test.ts` 同一形态） */
function fakeMonaco(): {
  monaco: unknown;
  captured: {
    semantic: SemanticProvider | null;
    folding: FoldingProvider | null;
    semanticDisposed: boolean;
    foldingDisposed: boolean;
  };
} {
  const captured = {
    semantic: null as SemanticProvider | null,
    folding: null as FoldingProvider | null,
    semanticDisposed: false,
    foldingDisposed: false,
  };
  const editor = {
    updateOptions: () => undefined,
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  };
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      registerDocumentSemanticTokensProvider: (_id: string, provider: SemanticProvider) => {
        captured.semantic = provider;
        return { dispose: () => (captured.semanticDisposed = true) };
      },
      registerFoldingRangeProvider: (_id: string, provider: FoldingProvider) => {
        captured.folding = provider;
        return { dispose: () => (captured.foldingDisposed = true) };
      },
      setLanguageConfiguration: () => ({ dispose: () => undefined }),
    },
    editor: {
      getEditors: () => [editor],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
      getModelMarkers: () => [],
      setModelMarkers: () => undefined,
      onDidChangeMarkers: () => ({ dispose: () => undefined }),
    },
  };
  return { monaco, captured };
}

interface FakeModel {
  uri: { path: string };
  getLanguageId(): string;
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
  isDisposed(): boolean;
}

const model = (lineCount: number, languageId = KOJO_LANGUAGE_ID, path = '/w/口上.kojo'): FakeModel => ({
  uri: { path },
  getLanguageId: () => languageId,
  getLineCount: () => lineCount,
  getLineMaxColumn: () => 12,
  isDisposed: () => false,
});

/** 单门语言的注入 descriptor（`installStructureOverlay` 的第二参就是给测试用的） */
function kojoDescriptor(runtime: StructureLanguageRuntime): LanguageDescriptor {
  return {
    id: KOJO_LANGUAGE_ID,
    label: 'kojo',
    matchesPath: () => false,
    register: () => undefined,
    structure: { load: async () => runtime },
  };
}

/** worker 起不来的运行时：`createWorker` 调用一次记一次，然后按真 client 的 catch 口径抛 */
function failingRuntime(): { runtime: StructureLanguageRuntime; workerCalls: () => number } {
  let calls = 0;
  const runtime: StructureLanguageRuntime = {
    runtimeWasmUrl: 'runtime.wasm（桩）',
    grammarWasmUrl: 'kojo.wasm（桩）',
    createWorker: () => {
      calls += 1;
      throw new Error('worker 启动失败（桩）');
    },
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
  };
  return { runtime, workerCalls: () => calls };
}

/** `activate()` 是 `void` 出去的异步体（动态 import 走真实模块加载）：把微任务与几拍宏任务都排干净 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 全量并发下 `activate()` 里的动态 import / wasm 装载可能慢于固定拍数：
 * 有界等待 provider 挂上，避免把调度抖动误判成装配面缺失。
 */
async function waitForProviders(
  captured: { semantic: unknown; folding: unknown },
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while ((!captured.semantic || !captured.folding) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const NO_CANCEL = { isCancellationRequested: false };

describe('结构层默认开：偏好与判据', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('(1) 默认值 = 开：没存过 / 无 window / 脏数据都回默认', () => {
    expect(TREE_SITTER_DEFAULT).toBe(true);
    // 无 window（node / 读不到）
    expect(loadTreeSitterPref()).toBe(true);
    // 存过空表
    fakeStorage();
    expect(loadTreeSitterPref()).toBe(true);
    // 脏值不是显式 off ⇒ 默认开（脏数据方向 = 多露，不能把作者未关过的当关）
    fakeStorage([['kojo.ui.treeSitter.v1', 'yes-please']]);
    expect(loadTreeSitterPref()).toBe(true);
  });

  it('(2) 显式关闭持久化：写 off 才算关，写回 on 才算开', () => {
    const store = fakeStorage();
    const seen: boolean[] = [];
    const unsubscribe = subscribeTreeSitterPref(() => seen.push(loadTreeSitterPref()));
    setTreeSitterPref(false);
    expect(store.get('kojo.ui.treeSitter.v1')).toBe('off');
    expect(loadTreeSitterPref()).toBe(false);
    setTreeSitterPref(true);
    expect(store.get('kojo.ui.treeSitter.v1')).toBe('on');
    expect(loadTreeSitterPref()).toBe(true);
    unsubscribe();
    expect(seen).toEqual([false, true]);
  });

  it('(3) resolveStructureEnabled：ERB/.kojo 默认开；kojo2 / JSON / plaintext 不动；着色超大跳过', () => {
    fakeStorage();
    // 结构层两门语言（判据只认 descriptor 的 structure 声明，不认语言名分支）
    expect(resolveStructureEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo', 20)).toBe(true);
    expect(resolveStructureEnabled(ERB_LANGUAGE_ID, '/w/口上.erb', 20)).toBe(true);
    // kojo2 面本来就不该由通用叠层接管（它有自己的 worker）——K2-STRUCTURE-GATE 之后
    // 折叠 / 大纲由宿主直接装配专属 provider，与本叠层是否吞下 kojo2 无关，判定照旧 false。
    expect(resolveStructureEnabled(KOJO2_LANGUAGE_ID, '/w/口上.kojo2', 20)).toBe(false);
    expect(resolveStructureEnabled(JSON_LANGUAGE_ID, '/w/配置.json', 20)).toBe(false);
    // 认不出 = plaintext：不按路径猜
    expect(resolveStructureEnabled('plaintext', '/w/口上.kojo', 20)).toBe(false);
    // 显式关（第四个参数即偏好真源，生产由 localStorage 给）
    expect(resolveStructureEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo', 20, false)).toBe(false);
    // 着色/缩进的体量闸：等于阈值仍算开，超一行就跳过（与 providers 既有 `>` 口径逐字一致）
    expect(resolveStructureEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo', LARGE_FILE_LINES)).toBe(true);
    expect(resolveStructureEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo', LARGE_FILE_LINES + 1)).toBe(false);
  });

  it('(3b) 折叠**没有**行数闸：5,000 行以上照供，只认偏好与语言声明', () => {
    fakeStorage();
    for (const lineCount of [20, LARGE_FILE_LINES, LARGE_FILE_LINES + 1, 24_197, HUGE_FILE_LINES - 1]) {
      expect(
        resolveStructureFoldsEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo'),
        `${lineCount} 行的折叠不该让路（判据里没有 lineCount 这一格）`,
      ).toBe(true);
    }
    // 偏好显式关 ⇒ 折叠也不供（这一条与着色同一条腿）
    expect(resolveStructureFoldsEnabled(KOJO_LANGUAGE_ID, '/w/口上.kojo', false)).toBe(false);
    // 没声明结构面的语言，折叠也不碰（kojo2 有自己的 worker）
    expect(resolveStructureFoldsEnabled(KOJO2_LANGUAGE_ID, '/w/口上.kojo2')).toBe(false);
    expect(resolveStructureFoldsEnabled(JSON_LANGUAGE_ID, '/w/配置.json')).toBe(false);
  });
});

describe('结构层默认开：装配与回落', () => {
  let warnings: ReturnType<typeof vi.spyOn>;
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    resetStructureDegradationLedger();
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    notices = [];
    unsubscribe = onStructureDegradation((degradation) => {
      notices.push(`${degradation.capability}/${degradation.stage}`);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    disposeStructureOverlay();
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  const warnedLines = (): string[] =>
    (warnings.mock.calls as unknown[][]).map((call) => String(call[0] ?? '')).filter((line) => line.length > 0);

  it('(4) 没存过偏好也装配：worker 起不来 ⇒ 两枚 provider 均回落、台账说一次、之后不刷屏', async () => {
    fakeStorage(); // 空表 = 默认开
    const { runtime, workerCalls } = failingRuntime();
    const { monaco, captured } = fakeMonaco();
    installStructureOverlay(monaco as unknown as typeof Monaco, [kojoDescriptor(runtime)]);
    await flush();
    await waitForProviders(captured);
    expect(structureOverlayState()).toMatchObject({ installed: true, active: true });

    const semantic = captured.semantic;
    const folding = captured.folding;
    if (!semantic || !folding) throw new Error('默认开却没注册 provider（装配面漂）');

    // 真 client：track → start() → createWorker 抛 ⇒ fatal（台账 + onFatal）⇒ provider 回 null
    expect(await semantic.provideDocumentSemanticTokens(model(40), null, NO_CANCEL)).toBeNull();
    expect(workerCalls()).toBe(1);
    // 整档停用：这一门语言的 provider 被摘除，叠层回到"没开过"（没有 provider 再挂在那里）
    expect(captured.semanticDisposed).toBe(true);
    expect(captured.foldingDisposed).toBe(true);
    expect(structureOverlayState()).toMatchObject({ installed: true, active: false });
    // 回落看得见，且只一次：作者面订阅与 console.warn 各一条
    expect(notices.filter((line) => line.startsWith('all/'))).toHaveLength(1);
    expect(warnedLines().filter((line) => line.includes('[kojo-structure] all/worker'))).toHaveLength(1);

    // 继续编辑：叠层已停用 ⇒ 一律回落，不再起线程、不再重复告警
    for (let i = 0; i < 5; i++) {
      expect(await semantic.provideDocumentSemanticTokens(model(40), null, NO_CANCEL)).toBeNull();
      expect(await folding.provideFoldingRanges(model(40))).toEqual([]);
    }
    expect(workerCalls()).toBe(1);
    expect(warnedLines().filter((line) => line.includes('all/worker'))).toHaveLength(1);
  });

  it('(5) 超大文件：**着色**让路（判据为假、线程一次都不起、只说一次）；折叠照供', async () => {
    fakeStorage(); // 默认开
    const { runtime, workerCalls } = failingRuntime();
    const { monaco, captured } = fakeMonaco();
    installStructureOverlay(monaco as unknown as typeof Monaco, [kojoDescriptor(runtime)]);
    await flush();
    await waitForProviders(captured);
    expect(structureOverlayState().active).toBe(true);

    const semantic = captured.semantic;
    const folding = captured.folding;
    if (!semantic || !folding) throw new Error('默认开却没注册 provider（装配面漂）');

    const big = model(LARGE_FILE_LINES + 1);
    // 着色这一面仍按体量让路：一次都不问 client，且只说一次
    for (let i = 0; i < 3; i++) {
      expect(await semantic.provideDocumentSemanticTokens(big, null, NO_CANCEL)).toBeNull();
    }
    expect(workerCalls()).toBe(0); // 问都没问 client
    const sizeLines = warnedLines().filter((line) => line.includes('行的文件这次不由结构层着色'));
    expect(sizeLines).toHaveLength(1);
    // 折叠**没有**行数闸（2026-10-28 拆开）：它真的会去问 client——这台 runtime 起不来 ⇒
    // 回落的空数组，但判据已不在行数上（`resolveStructureFoldsEnabled` 里没有 lineCount）
    expect(await folding.provideFoldingRanges(big)).toEqual([]);
    expect(workerCalls()).toBe(1);
  });

  it('(6) 作者显式关掉：订阅者当场拆 provider；翻回开又能重挂（不重开编辑器）', async () => {
    fakeStorage(); // 默认开
    const { runtime } = failingRuntime();
    const { monaco, captured } = fakeMonaco();
    installStructureOverlay(monaco as unknown as typeof Monaco, [kojoDescriptor(runtime)]);
    await flush();
    await waitForProviders(captured);
    expect(structureOverlayState().active).toBe(true);

    setTreeSitterPref(false);
    await flush();
    expect(structureOverlayState().active).toBe(false);
    expect(captured.semanticDisposed).toBe(true);
    expect(captured.foldingDisposed).toBe(true);

    setTreeSitterPref(true);
    await flush();
    expect(structureOverlayState().active).toBe(true);
  });
});
