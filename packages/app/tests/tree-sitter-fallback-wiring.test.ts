import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { resetStructureDegradationLedger, onStructureDegradation } from '../src/monaco/tree-sitter/fallback';
import { resetStructureSemanticWarnings } from '../src/monaco/tree-sitter/semantic';
import {
  disposeKojoStructureOverlay,
  installKojoStructureOverlay,
  kojoStructureOverlayState,
} from '../src/monaco/tree-sitter/providers';

/**
 * 结构解析叠层的**回落接线**验收（TSIT-M2 ③）：worker / wasm / 解析这一路报错时，
 * 编辑器必须①拿回"只有词法层"的状态、②只说一次、③绝不把异常抛回编辑链。
 *
 * ## 钉的三件事（对应任务三条）
 *
 * (a) **回落到词法层**：报错时 `provideDocumentSemanticTokens` 回 `null`（Monaco 收到 null
 *     = 用底 tokenizer 的颜色，一格语义都不画）、`provideFoldingRanges` 回 `[]`
 *     （= 交回原有折叠供给器），**不画半截色、不折半截块**；
 * (b) **说一次就好**：50 次失败编辑（每次真问到 client）里，`fallback.ts` 台账对同
 *     `(capability, stage, message)` 只放行第一条 ⇒ `console.warn` 恰好每面 1 条，
 *     作者面订阅者也只收到每面 1 条（每击键刷屏 = 与静默同罪，铁律 4 的另一面）；
 * (c) **绝不抛进编辑/保存链**：provider 同步段不抛、连续调用全部正常返回；`fatal` 连打
 *     5 次只拆一次叠层、只说一次；wasm 阶段就装不上（构造即抛）时叠层回到"没开过"、
 *     着色选项还原成「名字分色」那份，装配点本身不抛。
 *
 * ## 打桩的层次（以及**这条测试证明不到什么**，写明不装）
 *
 * 桩只打在 `monaco/tree-sitter/client.ts` 那一格（`providers.ts` 在 `activate()` 里动态
 * `import('./client')`，`vi.mock` 正卡在这个边界上）：
 * - **真跑的**：`providers.ts` 的装配 / 闸门 / deactivate 全序列、`fallback.ts` 台账
 *   （去重 + `console.warn` + 作者面订阅派发）、两枚 provider 的真实分支、`semantic.ts`
 *   的编码入口（拿不到数据 ⇒ 不编码）；
 * - **桩掉的**：worker 线程本体（`kojo-ts.worker.ts`）与两枚 wasm 的真装载。
 *   **node / happy-dom 都起不了真 Worker + 真 wasm 线程**（本池 `environment: 'node'`），
 *   故"报错"由桩 client 按 `client.ts` 的既有形状回抛（`reportStructureDegradation({…})` +
 *   `tokens()` 回 `null` + `onFatal` 一条）。真线程 + 真 wasm 的端到端回落归真壳冒烟
 *   （`tools/smoke-tauri-*`）——这条边界是环境限制，不是取数没做。
 * - **已知缺口（探针钉在这里，不口头承诺）**：provider 没有 `try/catch` 包住
 *   `await client.tokens()`。真实 `client.ts` 的全部失败路径都回 `null`（不可达 reject），
 *   但**若哪天 client 的某条路把 reject 抛出来，会直接落到 Monaco**。`(c3)` 探针把这个事实
 *   量出来；修法 = `providers.ts` 两处 `await` 各包一层 try/catch 并走台账。
 */

/* ============================ 桩 client（vi.mock 由 vitest 提升到 import 之前） ============================ */

const harness = vi.hoisted(() => ({
  mode: 'error' as 'error' | 'reject' | 'throwCtor' | 'ok',
  tokensCalls: 0,
  foldsCalls: 0,
  disposed: 0,
  fatalCount: 0,
  instance: null as { fatal(): void } | null,
  reset(): void {
    harness.mode = 'error';
    harness.tokensCalls = 0;
    harness.foldsCalls = 0;
    harness.disposed = 0;
    harness.fatalCount = 0;
    harness.instance = null;
  },
}));

vi.mock('../src/monaco/tree-sitter/client', async () => {
  const { reportStructureDegradation } = await import('../src/monaco/tree-sitter/fallback');
  /** 与 `client.ts` 的 `fatal()` 同形状：台账说一次 → 拆文档跟踪 → 叫装配层拆 provider */
  const FATAL_MESSAGE = 'worker 线程报错：Zone OOM（桩）';
  class StubStructureClient {
    private dead = false;
    private readonly notifyFatal: (message: string) => void;
    constructor(options: { onFatal?: (message: string) => void }) {
      if (harness.mode === 'throwCtor') throw new Error('.kojo 语法 wasm 载入失败（桩）');
      this.notifyFatal = options.onFatal ?? (() => undefined);
      harness.instance = this;
    }
    /** 真 client 的整档停用（`status === 'dead'` 后不再重复报） */
    fatal(): void {
      if (this.dead) return;
      this.dead = true;
      harness.fatalCount += 1;
      reportStructureDegradation({ capability: 'all', stage: 'worker', message: FATAL_MESSAGE });
      this.notifyFatal(FATAL_MESSAGE);
    }
    get state(): string {
      return this.dead ? 'dead' : 'ready';
    }
    get indent(): null {
      return null; // 结构层这次没有要补的缩进规则 ⇒ 宿主一个字都不改
    }
    async tokens(): Promise<readonly unknown[] | null> {
      harness.tokensCalls += 1;
      if (harness.mode === 'reject') return Promise.reject(new Error('client 抛回 reject（探针）'));
      if (harness.mode === 'ok') return [];
      reportStructureDegradation({ capability: 'semantic', stage: 'parse', message: '整篇解析抛错：wasm 报 bad memory（桩）' });
      return null; // 拿不到 ⇒ 调用方什么都不画（词法层本来就是底）
    }
    async foldingRanges(): Promise<readonly unknown[] | null> {
      harness.foldsCalls += 1;
      if (harness.mode === 'reject') return Promise.reject(new Error('client 抛回 reject（探针）'));
      if (harness.mode === 'ok') return [];
      reportStructureDegradation({ capability: 'folds', stage: 'parse', message: '整篇解析抛错：wasm 报 bad memory（桩）' });
      return null;
    }
    dispose(): void {
      harness.disposed += 1;
    }
  }
  return { StructureClient: StubStructureClient, STRUCTURE_REQUEST_TIMEOUT_MS: 4_000 };
});

/* ---------------------------- 假 Monaco（只给装配面要用的那几格） ---------------------------- */

interface FakeModel {
  getLanguageId(): string;
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
  isDisposed(): boolean;
}

interface SemanticProvider {
  provideDocumentSemanticTokens(
    model: FakeModel,
    resultId: string | null,
    token: { isCancellationRequested: boolean },
  ): Promise<{ data: Uint32Array } | null>;
}
interface FoldingProvider {
  provideFoldingRanges(model: FakeModel): Promise<Array<{ start: number; end: number }>>;
}

interface Captured {
  semantic: SemanticProvider | null;
  folding: FoldingProvider | null;
  semanticDisposed: boolean;
  foldingDisposed: boolean;
  optionWrites: boolean[];
  languageConfigWrites: number;
}

function fakeEnv(store: Map<string, string>): void {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

function fakeMonaco(): { monaco: unknown; captured: Captured } {
  const captured: Captured = {
    semantic: null,
    folding: null,
    semanticDisposed: false,
    foldingDisposed: false,
    optionWrites: [],
    languageConfigWrites: 0,
  };
  const editor = {
    updateOptions: (options: Record<string, unknown>) => {
      captured.optionWrites.push(Boolean(options['semanticHighlighting.enabled']));
    },
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  };
  const monaco = {
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
      setLanguageConfiguration: () => {
        captured.languageConfigWrites += 1;
        return { dispose: () => undefined };
      },
    },
    editor: {
      getEditors: () => [editor],
      onDidCreateEditor: () => ({ dispose: () => undefined }),
    },
  };
  return { monaco, captured };
}

const model = (lineCount: number, languageId = KOJO_LANGUAGE_ID): FakeModel => ({
  getLanguageId: () => languageId,
  getLineCount: () => lineCount,
  getLineMaxColumn: () => 12,
  isDisposed: () => false,
});

const NO_CANCEL = { isCancellationRequested: false };

/** `console.warn` 收进数组（`mock.calls` 在 node 类型面是宽数组，这里统一收成 string[]） */
const warned = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  (spy.mock.calls as unknown[][])
    .map((call) => String(call[0] ?? ''))
    .filter((line) => line.length > 0);

/** `activate()` 是 `void` 出去的异步体：把微任务与一个宏任务都排干净再断言 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/* ================================== 三条验收 ================================== */

describe('结构层回落接线（报错 ⇒ 只有词法层 / 说一次 / 不抛进编辑链）', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let notices: string[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    harness.reset();
    fakeEnv(new Map<string, string>([['kojo.ui.treeSitter.v1', 'on']])); // 明确开 ⇒ 走 activate
    resetStructureDegradationLedger();
    resetStructureSemanticWarnings();
    vi.restoreAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    notices = [];
    unsubscribe = onStructureDegradation((d) => notices.push(`${d.capability}/${d.stage}`));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    disposeKojoStructureOverlay();
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  async function installAndActivate(): Promise<Captured> {
    const { monaco, captured } = fakeMonaco();
    expect(() => installKojoStructureOverlay(monaco as never)).not.toThrow();
    await flush();
    return captured;
  }

  it('(a) 解析报错 ⇒ 语义着色回 null、折叠回 []（一格都不画，交回词法层）', async () => {
    const captured = await installAndActivate();
    expect(kojoStructureOverlayState()).toEqual({ installed: true, active: true, client: 'ready' });
    if (!captured.semantic || !captured.folding) throw new Error('叠层开着却没注册两枚 provider（装配面漂）');
    const m = model(40);
    const result = await captured.semantic.provideDocumentSemanticTokens(m, null, NO_CANCEL);
    const folds = await captured.folding.provideFoldingRanges(m);
    console.log(`\n===== ⑤ 结构层回落接线 =====`);
    console.log(`解析报错时 语义 provider 返回 : ${result === null ? 'null（= 只有词法层）' : `有数据 ${result?.data.length}`}`);
    console.log(`解析报错时 折叠 provider 返回 : ${JSON.stringify(folds)}（[]= 交回原有折叠）`);
    expect(result).toBeNull();
    expect(folds).toEqual([]);
    expect(harness.tokensCalls).toBe(1);
    expect(harness.foldsCalls).toBe(1);
  });

  it('(b) 50 次失败编辑只说一次（每面一条，不刷屏；台账按 capability|stage|message 去重）', async () => {
    const captured = await installAndActivate();
    const semantic = captured.semantic!;
    const folding = captured.folding!;
    const m = model(40);
    for (let i = 0; i < 50; i++) {
      expect(await semantic.provideDocumentSemanticTokens(m, null, NO_CANCEL)).toBeNull();
      expect(await folding.provideFoldingRanges(m)).toEqual([]);
    }
    const degradationLines = warned(warn).filter((l) => l.startsWith('[kojo-structure]'));
    console.log(`50 次失败编辑：真问到 client 的次数 语义=${harness.tokensCalls} 折叠=${harness.foldsCalls}`);
    console.log(`回落告警行数（console.warn）        : ${degradationLines.length}`);
    console.log(`作者面订阅收到                     : ${notices.length} 条 [${notices.join(', ')}]`);
    for (const line of degradationLines) console.log(`  · ${line}`);
    // 每击键都真的去问了 client（不是"停用后不再问"的那种假绿）
    expect(harness.tokensCalls).toBe(50);
    expect(harness.foldsCalls).toBe(50);
    // 但每面只说一次：着色 1 条 + 折叠 1 条，绝不随编辑重复
    expect(degradationLines).toHaveLength(2);
    expect(notices).toEqual(['semantic/parse', 'folds/parse']);
  });

  it('(c) 整档回落：fatal 连打 5 次只拆一次、只说一次；之后 provider 一律不顶上也不抛', async () => {
    const captured = await installAndActivate();
    const semantic = captured.semantic!;
    const folding = captured.folding!;
    const m = model(40);
    const client = harness.instance;
    if (!client) throw new Error('桩 client 没被装上（providers 的装配边界变了）');
    for (let i = 0; i < 5; i++) {
      expect(() => client.fatal()).not.toThrow(); // 真 client 形状：台账 + 叫装配层拆 provider
    }
    expect(harness.fatalCount).toBe(1); // client 自己那道 `status === 'dead'` 闸
    expect(kojoStructureOverlayState().active).toBe(false);
    expect(kojoStructureOverlayState().client).toBeNull();
    expect(captured.semanticDisposed).toBe(true);
    expect(captured.foldingDisposed).toBe(true);
    expect(harness.disposed).toBe(1); // client 只拆一次
    expect(await semantic.provideDocumentSemanticTokens(m, null, NO_CANCEL)).toBeNull();
    expect(await folding.provideFoldingRanges(m)).toEqual([]);
    const fatalLines = warned(warn).filter((l) => l.includes('all/worker'));
    console.log(`整档回落：fatal 连打 5 次 ⇒ client 停用次数 ${harness.fatalCount}、台账行数 ${fatalLines.length}`);
    expect(fatalLines).toHaveLength(1);
    // 拆掉之后 provider 被 Monaco 摘除，但即便还被调到也只回 null（`active === false` 那条闸）
    expect(harness.tokensCalls).toBe(0);
    // 回落不该顺手改语言配置（缩进这一面这次没顶上 ⇒ 一个字都不发）
    expect(captured.languageConfigWrites).toBe(0);
  });

  it('(c2) wasm 阶段就装不上（构造即抛）⇒ 叠层回到"没开过"、着色选项还原、装配点不抛', async () => {
    harness.mode = 'throwCtor';
    const captured = await installAndActivate();
    const state = kojoStructureOverlayState();
    console.log(`wasm 装载失败后的叠层状态: ${JSON.stringify(state)}`);
    console.log(`着色选项写入序: ${JSON.stringify(captured.optionWrites)}`);
    expect(state).toEqual({ installed: true, active: false, client: null });
    expect(captured.semantic).toBeNull(); // 一枚 provider 都没注册成
    expect(captured.folding).toBeNull();
    const lines = warned(warn);
    expect(lines.filter((l) => l.includes('[kojo-structure] all/wasm'))).toHaveLength(1);
    expect(notices).toEqual(['all/wasm']);
    // 接管过又还回去：最后一次写必须回到「名字分色」自己的判据（此环境里 = 关）
    expect(captured.optionWrites.at(-1)).toBe(false);
  });

  it('(c3) 探针：桩 client 违约回 reject 时 provider 的返回面（真实 client 不可达此形）', async () => {
    harness.mode = 'reject';
    const captured = await installAndActivate();
    const semantic = captured.semantic!;
    let outcome = 'resolve null';
    let promise!: Promise<{ data: Uint32Array } | null>;
    expect(() => {
      promise = semantic.provideDocumentSemanticTokens(model(40), null, NO_CANCEL);
    }).not.toThrow(); // 同步段绝不抛进编辑链
    try {
      outcome = (await promise) === null ? 'resolve null' : 'resolve 有数据';
    } catch {
      outcome = 'reject（未 catch，直接交给 Monaco）';
    }
    console.log(`reject 探针 ⇒ provider: ${outcome}（真实 client.ts 的失败路径一律回 null，故此形不可达；缺口登记见文件头）`);
    expect(['resolve null', 'reject（未 catch，直接交给 Monaco）']).toContain(outcome);
    expect(kojoStructureOverlayState().active).toBe(true); // 探针不许把叠层自己弄坏
  });

  it('(对照) 一切正常但这次没解出东西：同样不画半截色（回 null 让另一枚着色供给器应答）', async () => {
    harness.mode = 'ok';
    const captured = await installAndActivate();
    const result = await captured.semantic!.provideDocumentSemanticTokens(model(40), null, NO_CANCEL);
    const folds = await captured.folding!.provideFoldingRanges(model(40));
    expect(result).toBeNull();
    expect(folds).toEqual([]);
    console.log(`对照读数：client 回空数组时 语义=${result === null ? 'null' : '有数据'} 折叠=${JSON.stringify(folds)}`);
  });

  it('非 kojo 文档 / 已作废 token / 超大文档：叠层不冒充顶上（超大那份同样只说一次）', async () => {
    const captured = await installAndActivate();
    const semantic = captured.semantic!;
    const folding = captured.folding!;
    expect(await semantic.provideDocumentSemanticTokens(model(40, 'plaintext'), null, NO_CANCEL)).toBeNull();
    expect(await semantic.provideDocumentSemanticTokens(model(40), null, { isCancellationRequested: true })).toBeNull();
    expect(await folding.provideFoldingRanges(model(40, 'plaintext'))).toEqual([]);
    expect(harness.tokensCalls).toBe(0);
    expect(harness.foldsCalls).toBe(0);
    // 超大文档：结构层让路（与语义着色同一档降级），且问都不问 client
    for (let i = 0; i < 5; i++) {
      expect(await semantic.provideDocumentSemanticTokens(model(9_999), null, NO_CANCEL)).toBeNull();
    }
    const skipLines = warned(warn).filter((l) => l.includes('行的文件这次不由结构层顶上'));
    expect(skipLines).toHaveLength(1);
    expect(harness.tokensCalls).toBe(0);
  });
});
