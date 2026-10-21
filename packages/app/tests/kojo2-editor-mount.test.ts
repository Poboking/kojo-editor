/**
 * K2-EDITOR-MOUNT · 预览面板挂载 / 一次编译两处消费 / retarget 接线 / 真壳冒烟。
 *
 * ## 钉什么
 *
 * 1. **挂载点**：底部区那只内建视图（flag 关 ⇒ 连 tab 都没有）、宿主组件在
 *    「无入口 / 未就绪 / 就绪」三态下的产出，以及切标签后的卸载；
 * 2. **一次编译两处消费**：诊断那次 core 编译的成品留在缓存里，预览**只读**它
 *    （对象同一性 + 诊断调用计数都不许涨）；缓存有界、按 `pathKey` 命中、能撤下；
 * 3. **刷新链**：编辑器事件 → 诊断 → `onCompile` → 入口 `refresh`/`setFile` → 面板 props；
 * 4. **真壳冒烟**（假 Monaco + 假编辑器 + **真 core 编译** + 真诊断接线 + 真预览入口 +
 *    真面板渲染）：只出 2.0 来源、切标签撤条、失败 toast 一次、面板挂载/卸载、flag 关
 *    零挂载；
 * 5. **retarget**：另存为 / 改名后仍活着的 model 立刻重判语言面（判据纯函数、可单测）。
 *
 * 仓库测试环境是 node（无 jsdom）：面板渲染走 `react-dom/server` 静态渲染（与
 * `kojo2-preview-panel.test.ts` 同一条手法），DOM 事件层只测纯回调。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { UIPanelContribution } from '@kojo/plugin-api';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  createSourceMapBuilder,
} from '@kojo/kojo-core';
import { createKojo2Diagnostics, type Kojo2DiagnosticsInput } from '../src/monaco/kojo2-diagnostics';
import { buildKojo2SourceMapModel, splitKojo2GeneratedLines } from '../src/monaco/kojo2-sourcemap-model';
import { revealLocationOf } from '../src/monaco/reveal-position';
import {
  KOJO2_COMPILE_CACHE_LIMIT,
  compilationOfDiagnostics,
  createKojo2CompileCache,
  installKojo2ProblemWiring,
  pathOfKojo2Model,
  type Kojo2CompileCache,
} from '../src/ui/kojo2-problem-wiring';
import type { Kojo2DiagnoseFn } from '../src/ui/kojo2-problem-sync';
import { KOJO2_PROBLEM_MARKER_OWNER } from '../src/ui/kojo2-problem-sync';
import type { EditorProblem } from '../src/ui/problem-store';
import {
  createKojo2PreviewEntry,
  type Kojo2PreviewEntry,
} from '../src/ui/kojo2-preview-entry';
import {
  KOJO2_PREVIEW_VIEW_ID,
  Kojo2PreviewHost,
  currentKojo2PreviewEntry,
  kojo2PreviewBottomView,
  kojo2PreviewBridgeRevision,
  publishKojo2PreviewEntry,
  subscribeKojo2PreviewBridge,
} from '../src/ui/kojo2-preview-host';
import { Kojo2PreviewPanel } from '../src/ui/kojo2-preview-panel';
import { buildKojo2PreviewModel } from '../src/ui/kojo2-preview-model';
import { defaultActiveOf, organizePanels } from '../src/ui/layout';
import {
  createKojo2ModelLanguageController,
  retargetKojo2ModelPath,
  type Kojo2LanguageModelLike,
} from '../src/ui/kojo2-model-language';

/* ============================== 基座 ============================== */

const FIXTURE = readFileSync(
  fileURLToPath(new URL('./fixtures/kojo2/sourcemap-preview.kojo2', import.meta.url)),
  'utf8',
);

const KOJO2_PATH = 'D:/p/口上/神社.kojo2';
const ERB_PATH = 'D:/p/口上/场景.erb';

const SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const SEVERITY_SOURCE = { MarkerSeverity: SEVERITY } as unknown as Parameters<
  typeof createKojo2Diagnostics
>[0]['monaco'];

/** 真 core 编译（fixture adapter/backend：任何宿主测试都能跑出真产物 + 真 source map） */
const CORE_DIAGNOSTICS = createKojo2Diagnostics({
  monaco: SEVERITY_SOURCE,
  adapter: FIXTURE_ADAPTER,
  backend: FIXTURE_BACKEND,
});

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  publishKojo2PreviewEntry(null); // 桥是模块级单例：每条用例后清干净
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/* ------------------------------ 假 model / 假 editor ------------------------------ */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly path: string;
  setText(text: string, version?: number): void;
}

function fakeModel(path: string, initialText: string): FakeModel {
  let text = initialText;
  let version = 1;
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => false,
    getLineCount: () => text.split('\n').length,
    getLineMaxColumn: (line: number) => (text.split('\n')[line - 1] ?? '').length + 1,
    uri: { fsPath: path },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    path,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
  };
}

interface FakeEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  setModel(model: Monaco.editor.ITextModel): void;
  fireContent(): void;
  fireCursor(line: number): void;
  contentListeners(): number;
  modelListeners(): number;
  cursorListeners(): number;
}

function fakeEditor(initial: Monaco.editor.ITextModel): FakeEditor {
  const content = new Set<() => void>();
  const switched = new Set<() => void>();
  const cursor = new Set<(event: { position: { lineNumber: number } }) => void>();
  let model = initial;
  let cursorLine = 1;
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: cursorLine, column: 1 }),
    onDidChangeModelContent: (callback: () => void): Monaco.IDisposable => {
      content.add(callback);
      return { dispose: () => content.delete(callback) };
    },
    onDidChangeModel: (callback: () => void): Monaco.IDisposable => {
      switched.add(callback);
      return { dispose: () => switched.delete(callback) };
    },
    onDidChangeCursorPosition: (
      callback: (event: { position: { lineNumber: number } }) => void,
    ): Monaco.IDisposable => {
      cursor.add(callback);
      return { dispose: () => cursor.delete(callback) };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  return {
    editor,
    setModel(next) {
      model = next;
      for (const callback of [...switched]) callback();
    },
    fireContent() {
      for (const callback of [...content]) callback();
    },
    fireCursor(line) {
      cursorLine = line;
      for (const callback of [...cursor]) callback({ position: { lineNumber: line } });
    },
    contentListeners: () => content.size,
    modelListeners: () => switched.size,
    cursorListeners: () => cursor.size,
  };
}

interface ManualScheduler {
  readonly scheduler: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  runAll(): void;
  pending(): number;
}

function manualScheduler(): ManualScheduler {
  const timers = new Map<number, () => void>();
  let seq = 0;
  return {
    scheduler: {
      setTimeout(callback) {
        seq += 1;
        timers.set(seq, callback);
        return seq;
      },
      clearTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    runAll() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => timers.size,
  };
}

interface BusEvent {
  readonly event: string;
  readonly payload: unknown;
}

/* ------------------------------ 真壳挂载夹具 ------------------------------ */

interface HarnessOptions {
  readonly flagOn?: boolean;
  readonly path?: string;
  readonly text?: string;
  readonly scheduler?: ManualScheduler;
  readonly diagnose?: Kojo2DiagnoseFn;
  /** 不带缓存（模拟"只接诊断"的宿主） */
  readonly withoutCache?: boolean;
}

interface Harness {
  readonly fake: FakeEditor;
  readonly sink: FakeModel;
  readonly entry: Kojo2PreviewEntry | null;
  readonly cache: Kojo2CompileCache;
  readonly diagnose: Kojo2DiagnoseFn;
  readonly markerCalls: Array<{
    model: Monaco.editor.ITextModel;
    owner: string;
    markers: readonly Monaco.editor.IMarkerData[];
  }>;
  readonly written: Array<{ path: string; items: readonly EditorProblem[] }>;
  readonly erased: string[];
  readonly compiled: string[];
  readonly bus: BusEvent[];
  readonly notify: ReturnType<typeof vi.fn>;
  readonly scheduler: ManualScheduler;
  dispose(): void;
}

/**
 * 按 `use-monaco-instance.ts` 的**同一次序**装一遍：建缓存 → 建预览入口 → 挂光标 →
 * 发布宿主桥 → 切标签监听 → 装诊断接线（带缓存 + onCompile）。真 core 编译走
 * `createKojo2Diagnostics`（fixture adapter/backend），只有 Monaco / 编辑器是假的。
 */
function mountHarness(options: HarnessOptions = {}): Harness {
  stubFlag(options.flagOn ?? true);
  const scheduler = options.scheduler ?? manualScheduler();
  const path = options.path ?? KOJO2_PATH;
  const sink = fakeModel(path, options.text ?? FIXTURE);
  const fake = fakeEditor(sink.model);
  const cache = createKojo2CompileCache();
  const markerCalls: Harness['markerCalls'] = [];
  const written: Harness['written'] = [];
  const erased: string[] = [];
  const compiled: string[] = [];
  const bus: BusEvent[] = [];
  const notify = vi.fn();
  const kernel = {
    project: { current: () => null },
    bus: {
      emit: (event: string, payload: unknown) => {
        bus.push({ event, payload });
      },
    },
  } as unknown as Kernel;

  const entry = createKojo2PreviewEntry({
    compile: (filePath) => cache.getLastCompile(filePath),
    onJumpToSource: (filePath, line, column) => {
      kernel.bus.emit(
        'editor.revealLocation',
        revealLocationOf({ path: filePath, line, column }, '编译预览'),
      );
    },
  });
  const unpublish = publishKojo2PreviewEntry(entry);
  const detachCursor = entry?.attachCursor(fake.editor) ?? (() => undefined);
  const modelSub =
    entry === null
      ? null
      : fake.editor.onDidChangeModel(() => {
          const model = fake.editor.getModel();
          const next = model === null ? '' : pathOfKojo2Model(model, path);
          entry.setFile(next.endsWith('.kojo2') || next.endsWith('.KOJO2') ? next : null);
        });

  const diagnose: Kojo2DiagnoseFn =
    options.diagnose ??
    vi.fn((input: Kojo2DiagnosticsInput) => {
      compiled.push(input.filePath);
      return CORE_DIAGNOSTICS.diagnose(input);
    });

  const disposeWiring = installKojo2ProblemWiring({
    editor: fake.editor,
    kernel,
    filePathRef: { current: path },
    markerHost: {
      editor: {
        setModelMarkers: (model, owner, markers) => {
          markerCalls.push({ model, owner, markers });
        },
      },
    },
    severitySource: SEVERITY_SOURCE,
    diagnose,
    scheduler: scheduler.scheduler,
    debounceMs: 200,
    notify,
    writeProblems: (filePath, items) => {
      written.push({ path: filePath, items });
    },
    eraseProblems: (filePath) => {
      erased.push(filePath);
    },
    ...(options.withoutCache === true ? {} : { compileCache: cache }),
    onCompile: (filePath) => {
      if (entry === null) return;
      if (filePath === null) entry.setFile(null);
      else if (entry.snapshot().filePath !== filePath) entry.setFile(filePath);
      else entry.refresh();
    },
  });

  return {
    fake,
    sink,
    entry,
    cache,
    diagnose,
    markerCalls,
    written,
    erased,
    compiled,
    bus,
    notify,
    scheduler,
    dispose() {
      disposeWiring();
      detachCursor();
      modelSub?.dispose();
      unpublish();
      entry?.dispose();
      cache.clear();
    },
  };
}

/** 断言入口存在并返回它（flag 开的用例全都该有） */
function requireEntry(harness: Harness): Kojo2PreviewEntry {
  const entry = harness.entry;
  if (entry === null) throw new Error('flag 开着却没建出预览入口');
  return entry;
}

function renderHost(): string {
  return renderToStaticMarkup(createElement(Kojo2PreviewHost));
}

/* ============================== ① 挂载点 ============================== */

describe('挂载点：底部区内建视图（flag 闸）', () => {
  it('flag 关 ⇒ 视图贡献为 null（底部区连 tab 都不出现，零挂载）', () => {
    stubFlag(false);
    expect(kojo2PreviewBottomView()).toBeNull();
  });

  it('flag 开 ⇒ 底部区贡献：稳定 id / 标题 / 预览图标 / order 45 / 不抢默认激活', () => {
    stubFlag(true);
    const view = kojo2PreviewBottomView();
    expect(view).not.toBeNull();
    const contribution = view as UIPanelContribution;
    expect(contribution.id).toBe(KOJO2_PREVIEW_VIEW_ID);
    expect(contribution.title).toBe('编译预览');
    expect(contribution.icon).toBe('preview');
    expect(contribution.location).toBe('bottom');
    expect(contribution.order).toBe(45);
    expect(contribution.defaultActive).toBe(false);
    expect(contribution.component).toBe(Kojo2PreviewHost); // 模块级函数：壳层重渲不重挂
  });

  it('与「问题」同容器：order 排在问题之后、默认激活仍是问题（预览不自抢）', () => {
    stubFlag(true);
    const preview = kojo2PreviewBottomView() as UIPanelContribution;
    const problems: UIPanelContribution = {
      id: 'kojo.problems',
      title: '问题',
      order: 40,
      location: 'bottom',
      defaultActive: false,
      component: () => null,
    };
    const org = organizePanels([preview, problems], {});
    expect(org.bottom.map((panel) => panel.id)).toEqual(['kojo.problems', KOJO2_PREVIEW_VIEW_ID]);
    expect(defaultActiveOf(org).bottom.active).toBe('kojo.problems');
  });

  it('flag 关 ⇒ 宿主组件渲染 0 字节（即使桥上已发布入口）', () => {
    const harness = mountHarness({ flagOn: true });
    stubFlag(false); // 装配后把开关关掉：宿主必须立刻不挂
    expect(renderHost()).toBe('');
    harness.dispose();
  });

  it('flag 开但没有入口 ⇒ 只画一句 idle 说明，不挂面板本体', () => {
    stubFlag(true);
    publishKojo2PreviewEntry(null);
    const html = renderHost();
    expect(html).toContain('kojo2-preview__idle');
    expect(html).not.toContain('class="kojo2-preview"');
  });

  it('入口就绪 ⇒ 挂上真面板（产物行数来自真 core 编译）', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const entry = requireEntry(harness);
    expect(entry.snapshot().mounted).toBe(true);
    const html = renderHost();
    expect(html).toContain('class="kojo2-preview"');
    expect(html).toContain('编译预览');
    expect(html).toContain(`data-lines="${entry.snapshot().compilation!.compiled.erb.split('\n').length - 1}"`);
    harness.dispose();
  });

  it('切到非 .kojo2 标签 ⇒ 入口 setFile(null)，宿主退回 idle（面板卸载）', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    expect(renderHost()).toContain('class="kojo2-preview"');

    const erb = fakeModel(ERB_PATH, '; x\n');
    harness.fake.setModel(erb.model);
    expect(requireEntry(harness).snapshot().filePath).toBeNull();
    const html = renderHost();
    expect(html).not.toContain('class="kojo2-preview"');
    expect(html).toContain('kojo2-preview__idle');
    harness.dispose();
  });

  it('桥：发布 / 撤下都通知订阅者，注销只撤自己（后一个实例不被前一个清理误清）', () => {
    stubFlag(true);
    const notified: number[] = [];
    const unsubscribe = subscribeKojo2PreviewBridge(() => {
      notified.push(kojo2PreviewBridgeRevision());
    });
    const first = createKojo2PreviewEntry({ compile: () => null, onJumpToSource: () => undefined });
    const second = createKojo2PreviewEntry({ compile: () => null, onJumpToSource: () => undefined });
    const undoFirst = publishKojo2PreviewEntry(first);
    const undoSecond = publishKojo2PreviewEntry(second);
    expect(notified.length).toBe(2);
    expect(currentKojo2PreviewEntry()).toBe(second);

    undoFirst(); // 旧实例的清理：不许把新实例从桥上摘掉
    expect(currentKojo2PreviewEntry()).toBe(second);
    undoSecond();
    expect(currentKojo2PreviewEntry()).toBeNull();
    expect(notified.length).toBe(3);
    unsubscribe();
  });
});

/* ============================== ② 一次编译两处消费 ============================== */

describe('一次编译两处消费：缓存是预览的唯一数据源', () => {
  it('缓存按 pathKey 命中（分隔符 / 大小写不同的同一份文件）', () => {
    const cache = createKojo2CompileCache();
    const compilation = compilationOfDiagnostics(CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH }))!;
    expect(compilation).not.toBeNull();
    cache.remember(KOJO2_PATH, compilation);
    expect(cache.getLastCompile('d:\\p\\口上\\神社.kojo2')).toBe(compilation);
    expect(cache.getLastCompile(KOJO2_PATH.toUpperCase())).toBe(compilation);
    expect(cache.getLastCompile('D:/p/口上/别的.kojo2')).toBeNull();
    expect(cache.getLastCompile('')).toBeNull();
  });

  it('缓存有界：超过上限时丢最久的那一份（不无界增长）', () => {
    const cache = createKojo2CompileCache({ limit: 2 });
    const compilation = compilationOfDiagnostics(CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH }))!;
    cache.remember('D:/p/a.kojo2', compilation);
    cache.remember('D:/p/b.kojo2', compilation);
    cache.remember('D:/p/c.kojo2', compilation);
    expect(cache.size).toBe(2);
    expect(cache.getLastCompile('D:/p/a.kojo2')).toBeNull();
    expect(cache.getLastCompile('D:/p/b.kojo2')).toBe(compilation);
    // 再记一次 a：重插到队尾，b 变成最旧的
    cache.remember('D:/p/a.kojo2', compilation);
    cache.remember('D:/p/d.kojo2', compilation);
    expect(cache.getLastCompile('D:/p/a.kojo2')).toBe(compilation);
    expect(cache.getLastCompile('D:/p/b.kojo2')).toBeNull();
    cache.forget('D:/p/a.kojo2');
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(KOJO2_COMPILE_CACHE_LIMIT).toBeGreaterThan(1);
  });

  it('compilationOfDiagnostics：产物与 source map **同源**（行数相等才成立）', () => {
    const result = CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH });
    expect(result.artifacts).not.toBeNull();
    const compilation = compilationOfDiagnostics(result)!;
    expect(splitKojo2GeneratedLines(compilation.compiled.erb)).toHaveLength(
      compilation.sourceMapModel.generatedLineCount,
    );
    // 真能建出预览模型（不同源会在 buildKojo2PreviewModel 里抛 TypeError）
    expect(buildKojo2PreviewModel(compilation.compiled, compilation.sourceMapModel).lineCount).toBe(
      compilation.sourceMapModel.generatedLineCount,
    );
  });

  it('诊断入口不提供产物（只有诊断）⇒ 缓存不写、预览不挂（onCompile(null)）', async () => {
    const harness = mountHarness({
      diagnose: () =>
        ({
          filePath: KOJO2_PATH,
          diagnostics: [],
          markers: [],
          error: null,
          errorCount: 0,
          warningCount: 0,
          ok: true,
        }) as never,
    });
    await flushMicrotasks();
    expect(harness.cache.size).toBe(0);
    expect(requireEntry(harness).snapshot().mounted).toBe(false);
    expect(renderHost()).toContain('kojo2-preview__idle');
    harness.dispose();
  });

  it('预览只读缓存：反复 refresh 不产生第二次 core 编译，两份产出是**同一对象**', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const entry = requireEntry(harness);
    const callsAfterMount = (harness.diagnose as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(callsAfterMount).toBe(1);

    const stored = harness.cache.getLastCompile(KOJO2_PATH)!;
    for (let i = 0; i < 5; i += 1) entry.refresh();
    expect((harness.diagnose as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    const props = entry.panelProps()!;
    expect(props.compiled).toBe(stored.compiled); // 同一次编译的两个半：不许重建
    expect(props.sourceMapModel).toBe(stored.sourceMapModel);
    harness.dispose();
  });

  it('不同源守卫保留：产物行数与 map 行数不等 ⇒ 面板画错误说明，不画错位的行', () => {
    const result = CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH });
    const compilation = compilationOfDiagnostics(result)!;
    const tampered = buildKojo2SourceMapModel({
      erb: '只留一行\n',
      sourceMap: createSourceMapBuilder().build(),
    });
    const html = renderToStaticMarkup(
      createElement(Kojo2PreviewPanel, {
        compiled: compilation.compiled,
        sourceMapModel: tampered,
        onJumpToSource: () => undefined,
      }),
    );
    expect(html).toContain('kojo2-preview__error');
    expect(html).toContain('不同源');
    expect(html).not.toContain('class="kojo2-preview__row"');
  });
});

/* ============================== ③ 真壳冒烟 ============================== */

describe('真壳冒烟：假 Monaco + 假编辑器 + 真 core 编译', () => {
  it('首屏一次编译：markers 与问题面板都上账，缓存与预览同时就绪', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    expect(harness.compiled).toEqual([KOJO2_PATH]);
    expect(harness.markerCalls).toHaveLength(1);
    expect(harness.markerCalls[0]!.owner).toBe(KOJO2_PROBLEM_MARKER_OWNER);
    expect(harness.written).toHaveLength(1);
    expect(harness.written[0]!.path).toBe(KOJO2_PATH);
    expect(harness.cache.getLastCompile(KOJO2_PATH)).not.toBeNull();
    expect(requireEntry(harness).snapshot().mounted).toBe(true);
    harness.dispose();
  });

  it('只出现 2.0 来源：每条 marker / 问题条目的 source 都是「Kojo 2.0」', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    for (const call of harness.markerCalls) {
      for (const marker of call.markers) expect(marker.source).toBe('Kojo 2.0');
    }
    for (const batch of harness.written) {
      for (const item of batch.items) expect(item.source).toBe('Kojo 2.0');
    }
    harness.dispose();
  });

  it('击键合并：两次输入只排一个定时器，响一次只编译一次并刷新预览', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const entry = requireEntry(harness);
    const before = harness.cache.getLastCompile(KOJO2_PATH);

    harness.sink.setText(`${FIXTURE}\n# 幕 加一场\n`, 2);
    harness.fake.fireContent();
    harness.fake.fireContent();
    expect(harness.scheduler.pending()).toBe(1);
    expect(harness.compiled).toHaveLength(1);

    harness.scheduler.runAll();
    await flushMicrotasks();
    expect(harness.compiled).toHaveLength(2);
    expect(harness.cache.getLastCompile(KOJO2_PATH)).not.toBe(before); // 新一轮编译的新成品
    expect(entry.snapshot().mounted).toBe(true);
    harness.dispose();
  });

  it('切标签撤条：.kojo2 → .erb ⇒ 旧 markers 清空、问题条目撤下、缓存撤下、预览卸载', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    expect(harness.cache.size).toBe(1);

    const erb = fakeModel(ERB_PATH, '; x\n');
    harness.fake.setModel(erb.model);
    await flushMicrotasks();

    const lastMarkers = harness.markerCalls.at(-1)!;
    expect(lastMarkers.markers).toEqual([]);
    expect(lastMarkers.model).toBe(harness.sink.model); // 撤的是上一份（旧标签）的波浪线
    expect(harness.erased).toContain(KOJO2_PATH);
    expect(harness.cache.getLastCompile(KOJO2_PATH)).toBeNull();
    expect(requireEntry(harness).snapshot().mounted).toBe(false);
    expect(harness.compiled).toHaveLength(1); // 非 2.0 文件不跑编译
    harness.dispose();
  });

  it('切回 .kojo2 标签 ⇒ 立即重编译、重新挂上预览（缓存命中同一路径）', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const erb = fakeModel(ERB_PATH, '; x\n');
    harness.fake.setModel(erb.model);
    await flushMicrotasks();
    expect(requireEntry(harness).snapshot().mounted).toBe(false);

    harness.fake.setModel(harness.sink.model);
    await flushMicrotasks();
    expect(harness.compiled).toHaveLength(2);
    expect(requireEntry(harness).snapshot().filePath).toBe(KOJO2_PATH);
    expect(renderHost()).toContain('class="kojo2-preview"');
    harness.dispose();
  });

  it('编译失败：清 markers + 写失败条目 + toast **一次** + 预览卸载', async () => {
    const harness = mountHarness({
      diagnose: vi.fn(() => {
        throw new Error('编译器炸了');
      }) as unknown as Kojo2DiagnoseFn,
    });
    await flushMicrotasks();

    expect(harness.markerCalls.at(-1)!.markers).toEqual([]);
    const failure = harness.written.at(-1)!;
    expect(failure.items).toHaveLength(1);
    expect(failure.items[0]!.code).toBe('kojo2/diagnostics-unavailable');
    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notify.mock.calls[0]![0].kind).toBe('error');
    expect(String(harness.notify.mock.calls[0]![0].detail)).toContain('编译器炸了');
    expect(requireEntry(harness).snapshot().mounted).toBe(false);
    expect(renderHost()).not.toContain('class="kojo2-preview"');
    harness.dispose();
  });

  it('flag 关 ⇒ 零监听 / 零编译 / 零缓存 / 无入口 / 宿主 0 字节', async () => {
    const harness = mountHarness({ flagOn: false });
    await flushMicrotasks();
    expect(harness.entry).toBeNull();
    expect(harness.fake.contentListeners()).toBe(0);
    expect(harness.fake.modelListeners()).toBe(0);
    expect(harness.fake.cursorListeners()).toBe(0);
    expect(harness.compiled).toEqual([]);
    expect(harness.cache.size).toBe(0);
    expect(harness.markerCalls).toEqual([]);
    expect(harness.entry).toBeNull();
    expect(renderHost()).toBe('');
    harness.fake.fireContent();
    await flushMicrotasks();
    expect(harness.compiled).toEqual([]);
    harness.dispose();
  });

  it('光标事件 ⇒ 面板拿到 1 基源行（attach 时先播种，同一行内的列变化不重复通知）', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const entry = requireEntry(harness);
    // attachCursor 那一刻先按编辑器现位置播种（面板首帧就有同步行，不等人动鼠标）
    expect(entry.panelProps()!.sourceCursorLine).toBe(1);

    harness.fake.fireCursor(12);
    expect(entry.panelProps()!.sourceCursorLine).toBe(12);
    harness.fake.fireCursor(12); // 同行再报一次：快照不抖
    expect(entry.panelProps()!.sourceCursorLine).toBe(12);
    harness.fake.fireCursor(0); // 非法行号按"没有光标"处理
    expect(entry.panelProps()!.sourceCursorLine).toBeNull();
    harness.dispose();
  });

  it('跳回源码：面板点行的回调发既有 `editor.revealLocation`（载荷由唯一构造点折出）', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    const props = requireEntry(harness).panelProps()!;
    props.onJumpToSource(7, 3);
    expect(harness.bus).toHaveLength(1);
    expect(harness.bus[0]!.event).toBe('editor.revealLocation');
    expect(harness.bus[0]!.payload).toEqual(
      revealLocationOf({ path: KOJO2_PATH, line: 7, column: 3 }, '编译预览'),
    );
    harness.dispose();
  });

  it('pathOfKojo2Model：model URI 优先，没有 uri 时回落到宿主路径（切标签那一拍的口径）', () => {
    const withUri = fakeModel(KOJO2_PATH, '').model;
    expect(pathOfKojo2Model(withUri, ERB_PATH)).toBe(KOJO2_PATH);
    const noUri = { uri: undefined } as unknown as Monaco.editor.ITextModel;
    expect(pathOfKojo2Model(noUri, ERB_PATH)).toBe(ERB_PATH);
  });

  it('卸载 ：监听与桥一起撤回，卸载后事件零动作', async () => {
    const harness = mountHarness();
    await flushMicrotasks();
    harness.dispose();
    expect(harness.fake.contentListeners()).toBe(0);
    expect(harness.fake.modelListeners()).toBe(0);
    expect(harness.fake.cursorListeners()).toBe(0);
    expect(currentKojo2PreviewEntry()).toBeNull();
    const before = harness.compiled.length;
    harness.fake.fireContent();
    await flushMicrotasks();
    expect(harness.compiled).toHaveLength(before);
  });
});

/** flag 关时断言"根本没有入口"（把判断写在一处，避免用例里撒 `!`） */
function requireNoEntry(harness: Harness): boolean {
  return harness.entry === null;
}
/* ============================== ④ retarget 接线 ============================== */

describe('retarget 接线：另存为 / 改名改了扩展名后立刻重判语言面', () => {
  interface FakeLanguageModel extends Kojo2LanguageModelLike {
    readonly applied: string[];
  }

  function languageModel(languageId: string, path: string): FakeLanguageModel {
    const listeners = new Set<() => void>();
    const applied: string[] = [];
    let current = languageId;
    return {
      applied,
      getValue: () => '# 幕\n',
      getLanguageId: () => current,
      onDidChangeContent: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      onWillDispose: () => ({ dispose: () => undefined }),
      // `setModelLanguage` 由注入的端口落到这里
      setLang(next: string) {
        current = next;
        applied.push(next);
      },
      path,
    } as FakeLanguageModel & { setLang(next: string): void };
  }

  function controllerWith(pool: Map<string, Kojo2LanguageModelLike>, enabled = true) {
    return createKojo2ModelLanguageController({
      isEnabled: () => enabled,
      resolveLanguage: (path) => (path.toLowerCase().endsWith('.kojo2') ? 'kojo2' : 'kojo'),
      setModelLanguage: (model, languageId) => {
        (model as unknown as { setLang(next: string): void }).setLang(languageId);
      },
      schedule: () => () => undefined,
    });
  }

  it('活着的 model 换了扩展名 ⇒ retarget 命中并把语言重挂成 kojo2', () => {
    stubFlag(true);
    const model = languageModel('kojo', 'D:/p/口号.kojo');
    const pool = new Map<string, Kojo2LanguageModelLike>([['D:/p/口号.kojo', model]]);
    const controller = controllerWith(pool);
    controller.attach(model, 'D:/p/口号.kojo', { languageId: 'kojo' });

    const hit = retargetKojo2ModelPath(
      { fromPath: 'D:/p/口号.kojo', nextPath: 'D:/p/口号.kojo2' },
      {
        liveModel: (path) => pool.get(path),
        retarget: (target, nextPath) => controller.retarget(target, nextPath),
      },
    );
    expect(hit).toBe(true);
    expect(model.getLanguageId()).toBe('kojo2');
    expect(controller.stats().remounts).toBe(1);
  });

  it('retarget 幂等：新路径仍判成同一语言 ⇒ 只更新路径、不再重挂', () => {
    stubFlag(true);
    const model = languageModel('kojo', 'D:/p/口号.kojo');
    const pool = new Map<string, Kojo2LanguageModelLike>([['D:/p/口号.kojo', model]]);
    const controller = controllerWith(pool);
    const handle = controller.attach(model, 'D:/p/口号.kojo', { languageId: 'kojo' });
    const remountsAtStart = controller.stats().remounts;

    const hit = retargetKojo2ModelPath(
      { fromPath: 'D:/p/口号.kojo', nextPath: 'D:/p/口号.改名.kojo' },
      {
        liveModel: (path) => pool.get(path),
        retarget: (target, nextPath) => controller.retarget(target, nextPath),
      },
    );
    expect(hit).toBe(true); // 命中了一份挂载……
    expect(controller.stats().remounts).toBe(remountsAtStart); // ……但语言没变，不重挂
    expect(handle.path).toBe('D:/p/口号.改名.kojo');
  });

  it('判据：from === to / 空新路径 ⇒ false（零动作）', () => {
    const model = languageModel('kojo', 'D:/p/a.kojo');
    const calls: string[] = [];
    const deps = {
      liveModel: () => model as Kojo2LanguageModelLike,
      retarget: (_target: Kojo2LanguageModelLike, next: string) => {
        calls.push(next);
        return true;
      },
    };
    expect(retargetKojo2ModelPath({ fromPath: 'D:/p/a.kojo', nextPath: 'D:/p/a.kojo' }, deps)).toBe(false);
    expect(retargetKojo2ModelPath({ fromPath: 'D:/p/a.kojo', nextPath: '' }, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('池里没有这一份（改名链路重建了 model）⇒ false，不去猜新 model', () => {
    let asked = 0;
    const hit = retargetKojo2ModelPath(
      { fromPath: 'D:/p/a.kojo', nextPath: 'D:/p/a.kojo2' },
      {
        liveModel: () => {
          asked += 1;
          return undefined;
        },
        retarget: () => true,
      },
    );
    expect(hit).toBe(false);
    expect(asked).toBe(1);
  });

  it('注入面抛错 ⇒ false（绝不把异常抛进壳层的事件链）', () => {
    expect(
      retargetKojo2ModelPath(
        { fromPath: 'D:/p/a.kojo', nextPath: 'D:/p/a.kojo2' },
        {
          liveModel: () => {
            throw new Error('池炸了');
          },
          retarget: () => true,
        },
      ),
    ).toBe(false);
    expect(
      retargetKojo2ModelPath(
        { fromPath: 'D:/p/a.kojo', nextPath: 'D:/p/a.kojo2' },
        {
          liveModel: () => languageModel('kojo', 'D:/p/a.kojo'),
          retarget: () => {
            throw new Error('重挂炸了');
          },
        },
      ),
    ).toBe(false);
  });

  it('flag 关 ⇒ 控制器没有挂载，retarget 一律 false（零监听、v1 行为不变）', () => {
    stubFlag(false);
    const model = languageModel('kojo', 'D:/p/a.kojo');
    const pool = new Map<string, Kojo2LanguageModelLike>([['D:/p/a.kojo', model]]);
    const controller = controllerWith(pool, false);
    controller.attach(model, 'D:/p/a.kojo'); // flag 关：返回 no-op 手柄，不订阅
    expect(controller.stats().attached).toBe(0);
    const hit = retargetKojo2ModelPath(
      { fromPath: 'D:/p/a.kojo', nextPath: 'D:/p/a.kojo2' },
      {
        liveModel: (path) => pool.get(path),
        retarget: (target, nextPath) => controller.retarget(target, nextPath),
      },
    );
    expect(hit).toBe(false);
    expect(model.getLanguageId()).toBe('kojo');
  });
});

/* ============================== ⑤ 编译成品 → 预览 props 的形状 ============================== */

describe('编译成品 → 面板 props：一次编译喂两口（产物 / 诊断 / 光标 / 跳转）', () => {
  it('缓存里的产物体与核心编译逐字一致（不是副本，也不是重新编译的结果）', () => {
    const direct = compileKojoSource({
      source: FIXTURE,
      filePath: KOJO2_PATH,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });
    const result = CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH });
    const compilation = compilationOfDiagnostics(result)!;
    expect(compilation.compiled.erb).toBe(direct.erb);
    expect(compilation.compiled.diagnostics).toBe(result.diagnostics);
    expect(compilation.sourceMapModel.generatedLineCount).toBe(
      splitKojo2GeneratedLines(direct.erb).length,
    );
  });

  it('同一份诊断只留一份成品：重复 remember 覆盖而不是追加', () => {
    const cache = createKojo2CompileCache();
    const first = compilationOfDiagnostics(CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH }))!;
    const second = compilationOfDiagnostics(CORE_DIAGNOSTICS.diagnose({ source: '# 幕\n', filePath: KOJO2_PATH }))!;
    cache.remember(KOJO2_PATH, first);
    cache.remember(KOJO2_PATH, second);
    expect(cache.size).toBe(1);
    expect(cache.getLastCompile(KOJO2_PATH)).toBe(second);
  });

  it('entries 顺序 = 最近编译优先（来回切标签不必每切一次就重编译）', () => {
    const cache = createKojo2CompileCache({ limit: 2 });
    const compilation = compilationOfDiagnostics(CORE_DIAGNOSTICS.diagnose({ source: FIXTURE, filePath: KOJO2_PATH }))!;
    cache.remember('D:/p/a.kojo2', compilation);
    cache.remember('D:/p/b.kojo2', compilation);
    cache.getLastCompile('D:/p/a.kojo2'); // 只读不改变顺序（读不是"最近编译"）
    cache.remember('D:/p/c.kojo2', compilation);
    expect(cache.getLastCompile('D:/p/a.kojo2')).toBeNull();
    expect(cache.getLastCompile('D:/p/b.kojo2')).toBe(compilation);
    expect(cache.getLastCompile('D:/p/c.kojo2')).toBe(compilation);
  });
});
