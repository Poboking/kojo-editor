/**
 * K2-CUTOVER-ROUTE 的判据闸：**诊断/问题归属按路由**（LAU-3b-FLIP 之后路由只认扩展名）。
 *
 * 钉六件事：
 * 1. **单入口**：`path+source → route` 只有 `kojo2RouteFor` / `kojo2RouteForText` /
 *    `kojo2RouteForPath` 三格（分别对应 model / 正文 / 只有路径），结论与
 *    `decideKojo2Route` 逐字一致；
 * 2. **扩展名即归属**：`.kojo` / `.kojo2` 在任何阶段都归 2.0（正文、空文件、歧义都不看）；
 *    `.kojo1` 恒归 kojo1；
 * 3. **override 当家**：显式破例压过扩展名；`v1-only` 下只拦"把非 kojo 文件钉成 2.0"；
 * 4. **只有路径那一腿**（`EditorPane.refreshMarkers`）：不再需要正文结论，路径形与带
 *    正文形同源同值；override 一变立即失效；
 * 5. **诊断接线**：`.kojo` / `.kojo2` 一打开就诊断（语言面），`.kojo1` 让路；正文取不到
 *    ⇒ 这一拍跳过且**不静默**（info 通知一次）；
 * 6. **阶段与开关不改变归属**：`v1-only` / `dual` / `2.0-default` 三档结论一致。
 *
 * 环境是 node：开关用假 `window.localStorage`（计划文档 + 旧布尔键），诊断入口注入假体。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { Kernel } from '@kojo/kernel';
import {
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_LEGACY_FLAG_KEY,
  getKojo2CutoverController,
  resetKojo2CutoverController,
  type Kojo2CutoverStage,
  type Kojo2CutoverStorage,
  type Kojo2Parser,
} from '../src/ui/kojo2-cutover';
import {
  clearKojo2RouteMemo,
  isKojo2RouteablePath,
  kojo2DiagnosticsEnabled,
  kojo2OwnsDiagnostics,
  kojo2OwnsRoute,
  kojo2RouteFor,
  kojo2RouteForPath,
  kojo2RouteForText,
} from '../src/ui/kojo2-diagnostics-gate';
import { installKojo2ProblemWiring } from '../src/ui/kojo2-problem-wiring';
import type { Kojo2DiagnoseFn } from '../src/ui/kojo2-problem-sync';
import type { EditorProblem } from '../src/ui/problem-store';

/* ============================== 夹具 ============================== */

/** 已是 2.0 写法（正文内容已不参与路由，留着只为证明"看也不看"） */
const KOJO2_SAMPLE = '# 机 指令 310\n灵梦：「你好。」\n';
/** 真实 v1 片段（放在 `.kojo` 里也照样按 2.0 开） */
const V1_SAMPLE = '角色: 灵梦\n时机 指令 310：\n「你好。」\n';

const KOJO_PATH = 'C:/proj/chara/M_KOJO_K12_指令.kojo';
const KOJO2_PATH = 'C:/proj/chara/M_KOJO_K12_指令.kojo2';
const KOJO1_PATH = 'C:/proj/chara/M_KOJO_K12_指令.kojo1';

class MemoryStorage implements Kojo2CutoverStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** 装假 `window.localStorage`（不挂控制器：只有开关的派生路径看它） */
function stubWindow(storage: MemoryStorage = new MemoryStorage()): MemoryStorage {
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

/**
 * 开机：盘上计划 + 控制器 `attachStorage`（真宿主的同一拍）。
 * 不挂存储时 `resolveKojo2CutoverStage()` 与控制器阶段就会分叉——本文件不制造那种分叉。
 */
function boot(
  stage: Kojo2CutoverStage,
  overrides: Readonly<Record<string, Kojo2Parser>> = {},
): MemoryStorage {
  const storage = new MemoryStorage();
  storage.values.set(
    KOJO2_CUTOVER_STORAGE_KEY,
    JSON.stringify({ version: 2, stage, overrides }),
  );
  stubWindow(storage);
  getKojo2CutoverController().attachStorage(storage);
  return storage;
}

/** 改盘上的计划（模拟设置页改档）：生效阶段立刻跟着变 */
function commitPlan(storage: MemoryStorage, stage: Kojo2CutoverStage): void {
  storage.values.set(
    KOJO2_CUTOVER_STORAGE_KEY,
    JSON.stringify({ version: 2, stage, overrides: {} }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKojo2CutoverController();
  clearKojo2RouteMemo();
  vi.restoreAllMocks();
});

/* ============================== ① 单入口 ============================== */

describe('① 单入口：path+source → route 只有一处', () => {
  it('全新装机（没有计划、没有旧键）⇒ 缺省档 2.0-default：`.kojo` / `.kojo2` 恒归、`.kojo1` 不归', () => {
    stubWindow();
    getKojo2CutoverController(); // 惰性单例 = 缺省档 `2.0-default`
    expect(kojo2DiagnosticsEnabled()).toBe(true);

    for (const path of [KOJO_PATH, KOJO2_PATH]) {
      expect(kojo2RouteForPath(path), path).toMatchObject({
        kind: 'resolved',
        parser: 'kojo2',
        reason: 'extension-kojo2',
      });
      expect(kojo2OwnsDiagnostics(path), path).toBe(true);
    }
    // 正文是 v1 也不看：`.kojo` 已让给 2.0。
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: V1_SAMPLE })).toBe(true);
    expect(kojo2RouteForPath(KOJO1_PATH)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'extension-kojo1',
    });
    expect(kojo2OwnsDiagnostics(KOJO1_PATH)).toBe(false);
  });

  it('`kojo2RouteFor(model)`：URI 路径优先 + 结论与正文无关', () => {
    boot('2.0-default');
    const model = {
      uri: { fsPath: KOJO_PATH },
      getValue: () => KOJO2_SAMPLE,
    };
    const route = kojo2RouteFor(model);
    expect(route).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'extension-kojo2',
      filePath: KOJO_PATH,
      fingerprint: null,
    });
    expect(kojo2OwnsRoute(route)).toBe(true);
  });

  it('`kojo2RouteFor(model)`：没有 URI 时回落 `options.filePath`（切标签那一拍的口径）', () => {
    boot('2.0-default');
    const route = kojo2RouteFor(
      { getValue: () => V1_SAMPLE },
      { filePath: KOJO_PATH },
    );
    expect(route).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'extension-kojo2',
      filePath: KOJO_PATH,
    });
    expect(kojo2OwnsRoute(route)).toBe(true);
  });

  it('`kojo2RouteFor` 与 `kojo2RouteForText` 同源：同一路径 / 正文给同一份结论', () => {
    boot('2.0-default');
    const fromModel = kojo2RouteFor({ uri: { fsPath: KOJO_PATH }, getValue: () => KOJO2_SAMPLE });
    const fromText = kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE);
    expect(fromModel.kind).toBe(fromText.kind);
    expect(fromModel.kind === 'resolved' ? fromModel.parser : null).toBe(
      fromText.kind === 'resolved' ? fromText.parser : null,
    );
    expect(fromModel.kind === 'resolved' ? fromModel.reason : null).toBe(
      fromText.kind === 'resolved' ? fromText.reason : null,
    );
  });

  it('`kojo2RouteForText(path, undefined)` = 只有路径：`.kojo` 也是 resolved（不再要正文）', () => {
    boot('2.0-default');
    const route = kojo2RouteForText(KOJO_PATH, undefined);
    expect(route).toMatchObject({ kind: 'resolved', parser: 'kojo2', reason: 'extension-kojo2' });
    expect(kojo2OwnsRoute(route)).toBe(true);
  });
});

/* ============================== ② 各阶段 / 各扩展名 ============================== */

describe('② 扩展名即归属：三档阶段下结论一致', () => {
  it.each(['v1-only', 'dual', '2.0-default'] as const)('阶段 %s：`.kojo` / `.kojo2` 照归，`.kojo1` 不归', (stage) => {
    boot(stage);
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    for (const path of [KOJO_PATH, KOJO2_PATH]) {
      expect(kojo2OwnsDiagnostics(path), `${stage} ${path}`).toBe(true);
      expect(kojo2OwnsDiagnostics({ path, source: V1_SAMPLE }), `${stage} ${path}`).toBe(true);
      expect(isKojo2RouteablePath(path), `${stage} ${path}`).toBe(true);
    }
    expect(kojo2OwnsDiagnostics(KOJO1_PATH)).toBe(false);
    expect(kojo2OwnsDiagnostics({ path: KOJO1_PATH, source: KOJO2_SAMPLE })).toBe(false);
    // 预筛放行 `.kojo1`（它需要读 override 才能断言"不归"），但归属恒 false。
    expect(isKojo2RouteablePath(KOJO1_PATH)).toBe(true);
  });

  it('`.kojo2` 大写形态同样归 2.0', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics(KOJO2_PATH.toUpperCase())).toBe(true);
  });

  it('`.kojo` / `.kojo2` 被 override 钉回 v1 ⇒ 不归（显式破例最高优先级）', () => {
    boot('2.0-default', { [KOJO2_PATH]: 'kojo-v1', [KOJO_PATH]: 'kojo-v1' });
    for (const path of [KOJO_PATH, KOJO2_PATH]) {
      expect(kojo2RouteForPath(path), path).toMatchObject({
        kind: 'resolved',
        parser: 'kojo-v1',
        reason: 'override',
      });
      expect(kojo2OwnsDiagnostics(path), path).toBe(false);
    }
  });

  it('`.kojo1` 被 override 钉成 2.0（dual）⇒ 归 2.0；v1-only 下钉不住（blocked）', () => {
    boot('dual', { [KOJO1_PATH]: 'kojo2' });
    expect(kojo2OwnsDiagnostics(KOJO1_PATH)).toBe(true);

    boot('v1-only', { [KOJO1_PATH]: 'kojo2' });
    expect(kojo2RouteForPath(KOJO1_PATH)).toMatchObject({
      kind: 'blocked',
      reason: 'stage-disables-kojo2',
    });
    expect(kojo2OwnsDiagnostics(KOJO1_PATH)).toBe(false);
  });

  it('非 kojo 文件（`.erb` / `.txt` / `.kojo.bak`）在所有阶段都不归', () => {
    for (const stage of ['v1-only', 'dual', '2.0-default'] as const) {
      boot(stage);
      for (const path of ['C:/p/a.erb', 'C:/p/readme.txt', 'C:/p/a.kojo.bak']) {
        expect(kojo2OwnsDiagnostics(path), `${stage} ${path}`).toBe(false);
        expect(kojo2OwnsDiagnostics({ path, source: KOJO2_SAMPLE }), `${stage} ${path}`).toBe(
          false,
        );
        expect(isKojo2RouteablePath(path), path).toBe(false);
      }
    }
  });

  it('非 kojo 文件被 override 钉成 2.0 ⇒ 仍按路由归 2.0（override 当家，预筛不挡破例）', () => {
    boot('2.0-default', { 'C:/p/a.erb': 'kojo2' });
    expect(isKojo2RouteablePath('C:/p/a.erb')).toBe(true);
    expect(kojo2OwnsDiagnostics('C:/p/a.erb')).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: 'C:/p/a.erb', source: '# 机 指令 310\n' })).toBe(true);
    // 同一目录下没有破例的 `.erb` 仍不归
    expect(kojo2OwnsDiagnostics('C:/p/b.erb')).toBe(false);
  });

  it('空路径 / 非字符串路径不猜（恒 false，不抛）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics('')).toBe(false);
    expect(
      kojo2OwnsDiagnostics({ path: '   ' } as unknown as { path: string }),
    ).toBe(false);
  });
});

/* ============================== ③ 正文不参与 ============================== */

describe('③ 正文不参与路由：`.kojo` 里写什么都归 2.0', () => {
  it('2.0 正文 / v1 正文 / 空文件 / 纯台词 ⇒ 同一份结论（fingerprint 恒 null）', () => {
    boot('2.0-default');
    for (const source of [KOJO2_SAMPLE, V1_SAMPLE, '', '   \n\t\n', '灵梦：「你好。」\n']) {
      const route = kojo2RouteForText(KOJO_PATH, source);
      expect(route).toMatchObject({
        kind: 'resolved',
        parser: 'kojo2',
        reason: 'extension-kojo2',
        fingerprint: null,
      });
      expect(kojo2OwnsRoute(route)).toBe(true);
    }
  });

  it('一次性 override 只作用于这一问（不写进"只有路径"的备忘）', () => {
    boot('2.0-default');
    const oneShot = kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE, { override: 'kojo-v1' });
    expect(oneShot).toMatchObject({ kind: 'resolved', parser: 'kojo-v1', reason: 'override' });
    // 备忘没被这次一次性破例污染：同一路径仍归 2.0
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
  });

  it('改档不改变 `.kojo` 的归属（阶段只管写回 / 迁移 / 封存层可见性）', () => {
    const storage = boot('2.0-default');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    commitPlan(storage, 'dual');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    commitPlan(storage, 'v1-only');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
  });
});

/* ============================== ④ 只有路径那一腿 ============================== */

describe('④ 只有路径（EditorPane）：与带正文同源同值，不再需要备忘', () => {
  it('没有正文结论也判归 2.0（路径形直接按扩展名路由）', () => {
    boot('2.0-default');
    clearKojo2RouteMemo();
    expect(kojo2RouteForPath(KOJO_PATH)).toMatchObject({ kind: 'resolved', parser: 'kojo2' });
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    // 路径写法差异（反斜杠 / 大小写）同一结论
    expect(kojo2OwnsDiagnostics('C:\\proj\\chara\\M_KOJO_K12_指令.KOJO')).toBe(true);
  });

  it('`.kojo1` 只有路径也不归（v1 装饰轮照常发布）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics(KOJO1_PATH)).toBe(false);
    expect(kojo2OwnsDiagnostics('C:\\proj\\chara\\M_KOJO_K12_指令.KOJO1')).toBe(false);
  });

  it('改 override 即失效：钉回 v1 之后路径形跟着不归', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    getKojo2CutoverController().setOverride(KOJO_PATH, 'kojo-v1');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('控制器重置回缺省档 ⇒ 归属不变（扩展名说了算）', () => {
    boot('v1-only');
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    vi.unstubAllGlobals();
    resetKojo2CutoverController();
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
  });

  it('旧布尔键 `on` ⇒ dual（迁移规则不变）：`.kojo` 也归 2.0', () => {
    const storage = stubWindow();
    storage.values.set(KOJO2_LEGACY_FLAG_KEY, 'on');
    getKojo2CutoverController();
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
  });
});

/* ============================== ⑤ 诊断接线 ============================== */

const SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const SEVERITY_SOURCE = { MarkerSeverity: SEVERITY } as unknown as Parameters<
  typeof installKojo2ProblemWiring
>[0]['severitySource'];

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly path: string;
  setText(text: string, version?: number): void;
}

function fakeModel(path: string, initialText: string, initialVersion = 1): FakeModel {
  let text = initialText;
  let version = initialVersion;
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

/** 正文取不到（model 已在销毁途中）：`isDisposed` 仍是 false，`getValue` 抛 */
function unreadableModel(path: string): Monaco.editor.ITextModel {
  return {
    getValue: () => {
      throw new Error('取值失败');
    },
    getVersionId: () => 1,
    isDisposed: () => false,
    getLineCount: () => 1,
    getLineMaxColumn: () => 1,
    uri: { fsPath: path },
  } as unknown as Monaco.editor.ITextModel;
}

interface FakeEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  setModel(model: Monaco.editor.ITextModel): void;
  fireContent(): void;
  readonly contentListeners: () => number;
  readonly modelListeners: () => number;
}

function fakeEditor(initial: Monaco.editor.ITextModel): FakeEditor {
  const content = new Set<() => void>();
  const switched = new Set<() => void>();
  let model = initial;
  const editor = {
    getModel: () => model,
    onDidChangeModelContent: (callback: () => void): Monaco.IDisposable => {
      content.add(callback);
      return { dispose: () => content.delete(callback) };
    },
    onDidChangeModel: (callback: () => void): Monaco.IDisposable => {
      switched.add(callback);
      return { dispose: () => switched.delete(callback) };
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
    contentListeners: () => content.size,
    modelListeners: () => switched.size,
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

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function fakeKernel(): Kernel {
  return { project: { current: () => null } } as unknown as Kernel;
}

/** 一轮"成功"的诊断入口（markers 固定；测试要数调用次数，故保留 vi 的 `.mock` 面） */
function diagnoseReturning() {
  return vi.fn(async (input: { source: string; filePath: string }) => ({
    filePath: input.filePath,
    diagnostics: [],
    markers: [
      {
        severity: SEVERITY.Error,
        message: '示例错误',
        code: 'core/example',
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
      },
    ] as Monaco.editor.IMarkerData[],
    error: null,
    errorCount: 0,
    warningCount: 0,
    ok: true,
  }));
}

function wire(
  fake: FakeEditor,
  options: {
    readonly path: string;
    readonly diagnose?: Kojo2DiagnoseFn;
    readonly scheduler?: ManualScheduler;
    readonly notify?: (notice: { kind: 'info' | 'error'; message: string; detail?: string }) => void;
  },
) {
  const markerCalls: { readonly model: Monaco.editor.ITextModel; readonly markers: readonly Monaco.editor.IMarkerData[] }[] = [];
  const written: { path: string; items: readonly EditorProblem[] }[] = [];
  const erased: string[] = [];
  // 测试要数调用次数：默认入口就是 vi.fn；显式注入那几格（失败形）不数 `.mock`
  const diagnose = (options.diagnose ?? diagnoseReturning()) as unknown as ReturnType<
    typeof diagnoseReturning
  > & Kojo2DiagnoseFn;
  const dispose = installKojo2ProblemWiring({
    editor: fake.editor,
    kernel: fakeKernel(),
    filePathRef: { current: options.path },
    markerHost: {
      editor: {
        setModelMarkers: (model, _owner, markers) => {
          markerCalls.push({ model, markers });
        },
      },
    },
    severitySource: SEVERITY_SOURCE,
    diagnose,
    ...(options.scheduler ? { scheduler: options.scheduler.scheduler, debounceMs: 200 } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    writeProblems: (path, items) => {
      written.push({ path, items });
    },
    eraseProblems: (path) => {
      erased.push(path);
    },
  });
  return { dispose, markerCalls, written, erased, diagnose };
}

describe('⑤ 诊断接线：扩展名即归属', () => {
  it('`.kojo` 内容 v1 ⇒ 照样接管（正文不看），装上即诊断、markers 上屏', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO_PATH, V1_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);
    expect(wiring.diagnose.mock.calls[0]![0]).toEqual({
      source: V1_SAMPLE,
      filePath: KOJO_PATH,
    });
    expect(wiring.markerCalls).toHaveLength(1);
    expect(wiring.markerCalls[0]!.markers).toHaveLength(1);
    // 让路判据与诊断同源：EditorPane 的 path-only 调用也判归 2.0
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    wiring.dispose();
  });

  it('内容从 v1 改成 2.0 ⇒ 下一次停手再诊断一次（归属不变）', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO_PATH, V1_SAMPLE);
    const fake = fakeEditor(model.model);
    const scheduler = manualScheduler();
    const wiring = wire(fake, { path: model.path, scheduler });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);

    model.setText(KOJO2_SAMPLE, 2);
    fake.fireContent();
    expect(scheduler.pending()).toBe(1);
    scheduler.runAll();
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(2);
    expect(wiring.markerCalls.at(-1)!.markers).toHaveLength(1);
    wiring.dispose();
  });

  it('切到不归 2.0 的文件 ⇒ 撤旧 markers / 面板条目（切到 `.kojo1`）', async () => {
    boot('2.0-default');
    const kojo = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const legacy = fakeModel(KOJO1_PATH, V1_SAMPLE);
    const fake = fakeEditor(kojo.model);
    const wiring = wire(fake, { path: kojo.path });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);

    fake.setModel(legacy.model);
    await flushMicrotasks();
    expect(wiring.markerCalls.at(-1)!.markers).toEqual([]);
    expect(wiring.erased).toContain(KOJO_PATH);
    wiring.dispose();
  });

  it('正文取不到 ⇒ 这一拍跳过、不静默：不跑诊断，info 通知恰一次（归属仍是 2.0）', async () => {
    boot('2.0-default');
    const model = unreadableModel(KOJO_PATH);
    const fake = fakeEditor(model);
    const scheduler = manualScheduler();
    const notify = vi.fn();
    const wiring = wire(fake, { path: KOJO_PATH, scheduler, notify });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    expect(wiring.markerCalls).toEqual([]);
    expect(wiring.written).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].kind).toBe('info');
    expect(notify.mock.calls[0]![0].message).toContain('取不到正文');
    expect(notify.mock.calls[0]![0].detail).toBe(KOJO_PATH);

    // 同一份文件的后续击键不再刷屏
    fake.fireContent();
    scheduler.runAll();
    await flushMicrotasks();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(wiring.diagnose).not.toHaveBeenCalled();
    wiring.dispose();
  });

  it('dual 下 `.kojo` 与 `.kojo2` 都接管（阶段不改变归属）', async () => {
    boot('dual');
    const kojo = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(kojo.model);
    const wiring = wire(fake, { path: kojo.path });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);

    const kojo2 = fakeModel(KOJO2_PATH, KOJO2_SAMPLE);
    fake.setModel(kojo2.model);
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(2);
    wiring.dispose();
  });

  it('v1-only 下 `.kojo` 也照常诊断（语言面无条件；阶段只拦显式破例）', async () => {
    boot('v1-only');
    const model = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    expect(fake.contentListeners()).toBe(1);
    expect(fake.modelListeners()).toBe(1);
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);
    wiring.dispose();
  });

  it('`.kojo1` 任何阶段都不诊断（封存层 = v1 的活）', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO1_PATH, V1_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    expect(wiring.markerCalls).toEqual([]);
    wiring.dispose();
  });
});
