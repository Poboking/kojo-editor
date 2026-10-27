/**
 * LAU-6 收尾：`@原生` 注入的**子语言 worker 生命周期装配**（`disposeInjectionClients`）。
 *
 * 三条主张，各一枚用例：
 * 1. **池子本来就会复用**：同一门子语言连发两次子 parse 只建一条线程（别把"每请求一条"当既有行为）；
 * 2. **收账后不涨**：反复「解析 → 收账」N 轮，创建数 = 终止数 = N、存活数恒 0
 *    ——这是"反复开合不涨 worker 数"的判据本体（用**假 runtime 的计数器**量，不起真 wasm 线程）；
 * 3. **生产装配点真的接了**：`disposeGlobalProviders()`（最后一个实例退场 / 注册半途回滚的
 *    唯一出口，`ui/editor-global-providers.ts`）一跑，池子必须被清空——空的是"账"而不是
 *    "线程"的判据：收账后下一趟子 parse **必须新建一条**（若只是把旧客户端标成 dead、
 *    池子没清，下一趟会拿到 `unavailable` 而建不出第二条）。
 *
 * monaco 运行时不进 node（本池 environment = node）⇒ `../src/monaco/entry` 照
 * `editor-global-providers-tables.test.ts` 的先例用代理桩掉：本文件只碰 teardown 的
 * 清账分支（注册面零改动），桩只需"任何属性链可调用"。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StructureLanguageRuntime } from '../src/monaco/tree-sitter/structure-runtime';

const stub = vi.hoisted(() => {
  const universal = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_target, key) =>
        typeof key === 'symbol' || key === 'then' ? undefined : universal(`${path}.${String(key)}`),
      apply: () => ({ dispose: () => undefined }),
      construct: () => ({ stubConstructed: path }),
    });
  return { universal };
});

vi.mock('../src/monaco/entry', () => ({
  editor: stub.universal('monaco.editor'),
  languages: stub.universal('monaco.languages'),
  Uri: stub.universal('monaco.Uri'),
  Range: stub.universal('monaco.Range'),
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
}));

// 动态 import：保证上面的桩先就位
const { disposeInjectionClients, runInjection } = await import('../src/monaco/tree-sitter/injection');
const { disposeGlobalProviders } = await import('../src/ui/editor-global-providers');

/** 子语言声明（本文件只关心"有没有宿主节点"，节点名只做对账） */
const SPECS = [{ languageId: 'erb', hostNode: 'native_body' }] as const;

const TEXT = ['@原生', '    ; 注释', ''].join('\n');

const HOSTS = [
  { languageId: 'erb', hostNode: 'native_body', startRow: 0, startColumn: 3, endRow: 1, endColumn: 7 },
] as const;

/** 假子语言 runtime：`createWorker` / `terminate` 各自计数（存活 = 建 − 拆） */
function countingRuntime(): {
  runtime: StructureLanguageRuntime;
  readonly created: number;
  readonly terminated: number;
  readonly live: number;
} {
  const stats = { created: 0, terminated: 0 };
  const runtime: StructureLanguageRuntime = {
    runtimeWasmUrl: 'fake://web-tree-sitter.wasm',
    grammarWasmUrl: 'fake://erb.wasm',
    createWorker: () => {
      stats.created += 1;
      const worker = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        terminate: (): void => {
          stats.terminated += 1;
        },
        postMessage: (message: Record<string, unknown>): void => {
          const reply =
            message.kind === 'open'
              ? { ok: true, id: message.id, kind: 'ready', protocol: 3, loadMs: 1 }
              : message.kind === 'parse'
                ? {
                    ok: true,
                    id: message.id,
                    kind: 'parse',
                    doc: message.doc,
                    version: message.version,
                    treeId: 'child-tree',
                    incremental: false,
                    facets: { semantic: { names: [], nodes: [], spans: [] }, folds: { spans: [] } },
                    metrics: { parseMs: 0, queryMs: 0, textLength: 0 },
                  }
                : null;
          if (reply !== null) {
            // 同步回话会踩在 `pending.set` 之前（客户端还没登记）⇒ 排到微任务
            queueMicrotask(() => worker.onmessage?.({ data: reply } as MessageEvent<unknown>));
          }
        },
      };
      return worker as unknown as Worker;
    },
  };
  return {
    runtime,
    get created() {
      return stats.created;
    },
    get terminated() {
      return stats.terminated;
    },
    get live() {
      return stats.created - stats.terminated;
    },
  };
}

async function injectOnce(runtime: StructureLanguageRuntime): Promise<void> {
  const outcome = await runInjection({
    text: TEXT,
    version: 1,
    specs: [...SPECS],
    hosts: [...HOSTS],
    loadRuntime: async () => runtime,
  });
  expect(outcome.ok).toBe(true);
}

afterEach(() => {
  // 本文件自己就是量这件事的：兜底也走生产收账口，别留下跨用例的池子
  disposeInjectionClients();
});

describe('注入子通道 · worker 生命周期（LAU-6 收尾）', () => {
  it('池子按子语言复用：连发两次子 parse 只建一条线程', async () => {
    const counters = countingRuntime();
    await injectOnce(counters.runtime);
    await injectOnce(counters.runtime);
    expect(counters.created).toBe(1);
    expect(counters.live).toBe(1);
  });

  it('收账后不涨：反复「解析 → 收账」20 轮，创建 = 终止 = 20、存活恒 0', async () => {
    const counters = countingRuntime();
    for (let round = 0; round < 20; round++) {
      await injectOnce(counters.runtime);
      disposeInjectionClients();
      expect(counters.live).toBe(0); // 每轮收账后一条都不许活
    }
    expect(counters.created).toBe(20);
    expect(counters.terminated).toBe(20);
    expect(counters.live).toBe(0);
  });

  it('生产装配点接了：`disposeGlobalProviders()` 一跑，池子清空（下一趟必须新建）', async () => {
    const counters = countingRuntime();
    await injectOnce(counters.runtime);
    expect(counters.live).toBe(1);

    disposeGlobalProviders();

    expect(counters.terminated).toBe(1);
    expect(counters.live).toBe(0);
    // 账也清了：再发一趟是从零起一条新线程（只标 dead 不清表 ⇒ 这趟会拿 unavailable）
    await injectOnce(counters.runtime);
    expect(counters.created).toBe(2);
    expect(counters.live).toBe(1);
  });
});
