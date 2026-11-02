// @vitest-environment happy-dom
/**
 * codeLens 槽腿 · 大文件上的**真 ERB 供方**（KW2，2026-11-02，拆闸车道）。
 *
 * `slot-service-providers.ts` 的 `codeLensProvider` 曾在 `LARGE_FILE_LINES`（5,000）之上
 * 不问供方直接 `emptyLensList()`——那是把 A 批（2026-10-28，`5e53a7f8`）按实测撤掉的闸
 * 经 LAU-DUALLEG（ERB 的 codeLens 改由本槽腿应答）**静默装了回来**。本文件钉两格：
 *
 * 1. **拆闸判据（真供方）**：~52,000 行合成 ERB 走真 `erb-usage-lens` 贡献，
 *    `provideCodeLenses` 必须仍然问得到、答得出（假供方的同形判据在
 *    `kojo2-codelens.test.ts` ⑤ 与两枚诚实回落一起钉）；
 * 2. **成本读数（可复跑）**：一次 `provideCodeLenses` 的整篇耗时——A 批在语料 52,602 行
 *    那篇的读数是**整篇 provide 5.8 ms（124 处定义出 62 条）**，本文件同形状同量级。
 *    **刻意不做计时断言**：`tools/perf-suite.mjs` 会把「含 `performance.now(` + 对墙钟量的
 *    比较断言」的文件整份划进串行计时池（STATE §五那条更隐蔽的账），而本文件的判据必须
 *    留在功能并行池；读数 `console.info` 打印、进提交信息当回执。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ComputePool,
  EditorLanguageServiceContribution,
  ErbParserService,
  FileIO,
  PluginContext,
  Unsubscribe,
} from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import type * as Monaco from '../src/monaco/entry';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installSlotServiceLegs, type SlotServiceHost } from '../src/monaco/slot-service-providers';

/* ============================== 合成 ~52,000 行 ERB ============================== */

const DEF_COUNT = 124; // 与 A 批语料最大那篇的定义数同档
const PER_DEF_LINES = 420; // 124 × 420 ≈ 52,080 行（≥ HUGE 档以下的语料真实形态）

/** 每个函数 1 处同文件 `CALL`（usage-lens 只给有可证明引用的定义出注解）+ 注释占位行 */
function syntheticErbText(): string {
  const lines: string[] = ['#FUNCTION', '; KW2 拆闸成本读数·合成文件（非语料）'];
  for (let i = 0; i < DEF_COUNT; i++) {
    const name = `SYNF${i}`;
    lines.push(`@${name}()`);
    lines.push('\tCALL ' + name + '(1)');
    for (let k = 2; k < PER_DEF_LINES - 1; k++) lines.push(`; 占位 ${i}/${k}`);
    lines.push('\tRETURN 1');
  }
  return `${lines.join('\n')}\n`;
}

const SYNTH_PATH = '/t/SYNTH.ERB';
const SYNTH_TEXT = syntheticErbText();
const SYNTH_LINES = SYNTH_TEXT.split(/\r\n|\r|\n/).length;

/* ============================== 真供方：erb-parser 插件按测试夹具装配 ============================== */

/** `compute` 替身：只实现本插件用到的面（语义同 `erb-parser/tests/support.ts` 那枚） */
function makeComputeStub(): ComputePool {
  const tasks = new Map<string, (payload: never) => unknown>();
  const noChannel = () => ({ parallel: false, dispatched: 0, fellBack: 0, inline: 0 });
  return {
    async yieldToMain(): Promise<void> {},
    async runSliced<T, R>(
      items: readonly T[],
      opts: { concurrency?: number },
      fn: (item: T, index: number) => R | Promise<R>,
    ): Promise<R[]> {
      const window = Math.max(1, Math.floor(opts.concurrency ?? 1));
      const out: R[] = new Array(items.length) as R[];
      for (let i = 0; i < items.length; i += window) {
        const end = Math.min(i + window, items.length);
        const done = await Promise.all(items.slice(i, end).map((item, k) => fn(item, i + k)));
        for (let k = 0; k < done.length; k++) out[i + k] = done[k]!;
      }
      return out;
    },
    runLatest: <R,>(_key: string, _opts: unknown, fn: () => R | Promise<R>): Promise<R> =>
      Promise.resolve(fn()),
    busyInteractive: () => false,
    registerTask: (kind: string, impl: (payload: never) => unknown) => {
      tasks.set(kind, impl);
    },
    parallel: () => false,
    attachTransport: () => undefined,
    async offload<R = unknown>(kind: string, payload: unknown): Promise<R> {
      const impl = tasks.get(kind);
      if (!impl) throw new Error(`No local implementation registered for compute task '${kind}'`);
      return (await impl(payload as never)) as R;
    },
    stats: () => ({ tasks: [], yields: 0, interactiveActive: false, offload: noChannel() }),
    resetStats: () => undefined,
  } as unknown as ComputePool;
}

function fakeIO(): FileIO {
  const read = (path: string) =>
    path === SYNTH_PATH
      ? { path, text: SYNTH_TEXT, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null }
      : null;
  return {
    async walkDir(root: string) {
      return SYNTH_PATH.startsWith(root)
        ? [{ name: 'SYNTH.ERB', path: SYNTH_PATH, isDirectory: false }]
        : [];
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((p) => read(p));
    },
    async readText(path: string) {
      const file = read(path);
      if (!file) throw new Error(`not found: ${path}`);
      return file;
    },
    async stat(path: string) {
      return path === SYNTH_PATH
        ? { size: SYNTH_TEXT.length, mtimeMs: null, isDirectory: false }
        : null;
    },
  } as unknown as FileIO;
}

/** 装真 erb-parser、建好索引，取回 `erb-usage-lens` 那一枚贡献（单答裁决由槽腿去做） */
async function activateErbUsageLens(): Promise<EditorLanguageServiceContribution> {
  const registered: EditorLanguageServiceContribution[] = [];
  const services = new Map<string, unknown>();
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: {
      on: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      emit: noop,
    },
    inject: <T,>(key: string): T => {
      if (key === KernelServices.IO) return fakeIO() as unknown as T;
      if (key === KernelServices.Compute) return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => void services.set(key, value),
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      keys: async () => [],
    },
    slots: {
      register: (_kind: string, contribution: EditorLanguageServiceContribution) => {
        registered.push(contribution);
        return noop;
      },
      query: () => [],
    },
    onDispose: (fn: () => void) => void fn(),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  const parser = services.get('erb.parser') as ErbParserService;
  await parser.buildIndex(['/t']);
  const lens = registered.find((c) => c.id === 'erb-usage-lens');
  if (!lens) throw new Error('erb-usage-lens 未注册');
  return lens;
}

/* ============================== 槽腿 provider（真 model 桩） ============================== */

type KernelLike = Parameters<typeof setGlobalKernel>[0];

function installKernel(contributions: readonly EditorLanguageServiceContribution[]): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => ({ adapterId: 'synthetic-kw2' }) },
  } as unknown as KernelLike);
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function fakeMonaco(): { monaco: typeof Monaco; registrations: Monaco.languages.CodeLensProvider[] } {
  const registrations: Monaco.languages.CodeLensProvider[] = [];
  const fake = {
    languages: {
      registerCodeLensProvider: (
        _selector: string,
        provider: Monaco.languages.CodeLensProvider,
      ): Monaco.IDisposable => {
        registrations.push(provider);
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: fake as unknown as typeof Monaco, registrations };
}

function erbModel(): Monaco.editor.ITextModel {
  return {
    getValue: () => SYNTH_TEXT,
    getLineCount: () => SYNTH_LINES,
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    isDisposed: () => false,
    uri: { scheme: 'file', path: SYNTH_PATH, fsPath: SYNTH_PATH },
  } as unknown as Monaco.editor.ITextModel;
}

/** 槽腿挂上后取 ERB 那一格的 provider（装配点保证 codeLens 恰一枚由 LAU-DUALLEG 的矩阵钉，这里只取用） */
function erbLegProvider(options: SlotServiceHost = {}): Monaco.languages.CodeLensProvider {
  const fake = fakeMonaco();
  installSlotServiceLegs(fake.monaco, ['codeLens'], options);
  if (fake.registrations.length === 0) throw new Error('codeLens 槽腿没有挂上任何 provider');
  return fake.registrations[0]!;
}

function unpack(
  result: ReturnType<Monaco.languages.CodeLensProvider['provideCodeLenses']>,
): readonly Monaco.languages.CodeLens[] | null {
  if (result === undefined || result === null) return null;
  return Array.isArray(result) ? result : (result as Monaco.languages.CodeLensList).lenses;
}

afterEach(() => {
  setGlobalKernel(undefined as unknown as KernelLike);
});

describe('codeLens 拆闸 · 真 ERB 供方在 5 万行上仍被问', () => {
  it('合成文件本身要越过被撤的闸（否则本文件钉不住任何东西）', () => {
    expect(SYNTH_LINES).toBeGreaterThan(LARGE_FILE_LINES);
  });

  it('52,000+ 行的 model：`provideCodeLenses` 问真 `erb-usage-lens` 并拿到实答复（不是空列表顶掉）', async () => {
    installKernel([await activateErbUsageLens()]);
    const lenses = unpack(erbLegProvider().provideCodeLenses(erbModel(), TOKEN));
    expect(lenses, '无人应答时槽腿交 undefined；这里必须是真答复').not.toBeNull();
    // 每个定义都有一处同文件 CALL ⇒ 注解条数应与定义数同量级（孤儿剔重在供方口径里，不另判）。
    expect(lenses!.length).toBeGreaterThan(0);
  });

  it('成本读数（可复跑，进提交信息当回执；刻意不做计时断言——见文件头注）', async () => {
    const provider = erbLegProvider();
    installKernel([await activateErbUsageLens()]);
    const model = erbModel();
    const t0 = performance.now();
    const first = unpack(provider.provideCodeLenses(model, TOKEN))!;
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    const again = unpack(provider.provideCodeLenses(model, TOKEN))!;
    const hotMs = performance.now() - t1;
    console.info(
      `[KW2] 合成 ${SYNTH_LINES} 行 ERB（${DEF_COUNT} 处定义）· 一次 provideCodeLenses（真 erb-usage-lens，` +
        `走槽腿全通道）：冷 ${coldMs.toFixed(1)} ms → 热 ${hotMs.toFixed(1)} ms，出 ${first.length} 条` +
        `（对照 A 批语料读数：52,602 行整篇 provide 5.8 ms 出 62 条）`,
    );
    // 判据是行为的、不是墙钟的：拆闸后供方每次都照常应答（闸若还在，两趟都是空列表）。
    expect(first.length).toBe(again.length);
    expect(first.length).toBeGreaterThan(0);
  });
});
