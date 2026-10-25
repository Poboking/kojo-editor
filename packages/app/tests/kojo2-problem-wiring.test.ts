/**
 * Kojo 2.0 诊断接线（K2 batch-3）的闸：编辑器事件 → 问题同步 → 既有问题面板。
 *
 * 钉六件事：
 * 1. **门**：flag 关 ⇒ 零监听 / 零诊断 / 零面板写入；flag 开只认 `.kojo2`；
 * 2. **内容变化**：合并击键（定时器响之前不取文、不诊断），响一次才跑一轮；
 * 3. **活动 model 切换**：立即诊断新文件；切回非 2.0 文件 ⇒ 旧 markers 清空 + 面板撤条；
 * 4. **失败可见**：诊断抛错 ⇒ markers 清空、问题面板写 `kojo2/diagnostics-unavailable`、
 *    通知中心收一条 error（不是"这份文件干净"）；
 * 5. **dispose 幂等**：监听只撤一次，退场后事件不再触发诊断；
 * 6. **adapter/backend 装配**：角色号从 `charaIndex[].kojoDir` 最长前缀推；eraTW backend
 *    真跑一遍（有 charNo 能装配 `# 机`，没有则如实 fail-closed）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { GameProject } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { KOJO2_PROBLEM_MARKER_OWNER, type Kojo2DiagnoseFn } from '../src/ui/kojo2-problem-sync';
import {
  KOJO2_DIAGNOSTICS_FAILURE_CODE,
  charNoForProjectPath,
  createProjectKojo2Diagnose,
  installKojo2ProblemWiring,
  kojo2ProblemsOf,
  type Kojo2SurfaceResolver,
} from '../src/ui/kojo2-problem-wiring';
import { kojo2OwnsDiagnostics } from '../src/ui/kojo2-diagnostics-gate';
import type { EditorProblem } from '../src/ui/problem-store';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================== 基座 ============================== */

const SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const SEVERITY_SOURCE = { MarkerSeverity: SEVERITY } as unknown as Parameters<
  typeof createProjectKojo2Diagnose
>[0]['severitySource'];

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

interface MarkerCall {
  readonly model: Monaco.editor.ITextModel;
  readonly owner: string;
  readonly markers: readonly Monaco.editor.IMarkerData[];
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

/** 一轮"成功"的诊断入口（markers 可定制） */
function diagnoseReturning(markers: readonly Monaco.editor.IMarkerData[]) {
  return vi.fn(async (input: { source: string; filePath: string }) => {
    void input;
    return {
      filePath: input.filePath,
      diagnostics: [],
      markers: [...markers],
      error: null,
      errorCount: 0,
      warningCount: 0,
      ok: true,
    };
  });
}

const MARKER: Monaco.editor.IMarkerData = {
  severity: SEVERITY.Error,
  message: '示例错误',
  code: 'core/example',
  startLineNumber: 2,
  startColumn: 3,
  endLineNumber: 2,
  endColumn: 6,
};

function baseWiring(
  fake: FakeEditor,
  options: {
    readonly diagnose: Kojo2DiagnoseFn;
    readonly scheduler?: ManualScheduler;
    readonly path: string;
    readonly notify?: (notice: { kind: 'info' | 'error'; message: string; detail?: string }) => void;
  },
) {
  const markerCalls: MarkerCall[] = [];
  const written: { path: string; items: readonly EditorProblem[] }[] = [];
  const erased: string[] = [];
  const dispose = installKojo2ProblemWiring({
    editor: fake.editor,
    kernel: fakeKernel(),
    filePathRef: { current: options.path },
    markerHost: {
      editor: {
        setModelMarkers: (model, owner, markers) => {
          markerCalls.push({ model, owner, markers });
        },
      },
    },
    severitySource: SEVERITY_SOURCE,
    diagnose: options.diagnose,
    ...(options.scheduler ? { scheduler: options.scheduler.scheduler, debounceMs: 200 } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    writeProblems: (path, items) => {
      written.push({ path, items });
    },
    eraseProblems: (path) => {
      erased.push(path);
    },
  });
  return { dispose, markerCalls, written, erased };
}

/* ============================== 门 ============================== */

describe('门：语言面不读切流开关，只认 `.kojo2`', () => {
  it('默认档（flag 关）也接线：装上即诊断一次，只服务 `.kojo2`', async () => {
    stubFlag(false);
    const model = fakeModel('D:/p/a.kojo2', '# 幕\n');
    const fake = fakeEditor(model.model);
    const diagnose = diagnoseReturning([MARKER]);
    const wiring = baseWiring(fake, { diagnose, path: model.path });
    await flushMicrotasks();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(wiring.markerCalls[0]!.owner).toBe(KOJO2_PROBLEM_MARKER_OWNER);
    wiring.dispose();
  });

  it('kojo2OwnsDiagnostics：只认 `.kojo2`（大小写不敏感），与切流开关无关', () => {
    stubFlag(false);
    expect(kojo2OwnsDiagnostics('D:/p/a.kojo2')).toBe(true);
    stubFlag(true);
    expect(kojo2OwnsDiagnostics('D:/p/a.kojo2')).toBe(true);
    expect(kojo2OwnsDiagnostics('D:/p/A.KOJO2')).toBe(true);
    expect(kojo2OwnsDiagnostics('D:/p/a.kojo')).toBe(false);
    expect(kojo2OwnsDiagnostics('D:/p/a.erb')).toBe(false);
  });
});

/* ============================== 内容变化 / 切换 ============================== */

describe('内容变化与活动 model 切换', () => {
  it('装上即诊断一次；内容变化先合并击键，定时器响一次才取文并再诊断', async () => {
    stubFlag(true);
    const model = fakeModel('D:/p/a.kojo2', '# 幕\n');
    const fake = fakeEditor(model.model);
    const scheduler = manualScheduler();
    const diagnose = diagnoseReturning([MARKER]);
    const wiring = baseWiring(fake, { diagnose, scheduler, path: model.path });

    await flushMicrotasks();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0]![0]).toEqual({ source: '# 幕\n', filePath: model.path });
    expect(wiring.markerCalls[0]!.owner).toBe(KOJO2_PROBLEM_MARKER_OWNER);
    expect(wiring.markerCalls[0]!.markers).toEqual([MARKER]);
    expect(wiring.written[0]!.items).toEqual([
      {
        path: model.path,
        line: 2,
        span: { columnStart: 3, columnEnd: 6 },
        severity: 'error',
        message: '示例错误',
        code: 'core/example',
        source: 'Kojo 2.0',
      },
    ]);

    model.setText('# 幕 改\n', 2);
    fake.fireContent();
    fake.fireContent(); // 两次击键合并成一个定时器
    expect(scheduler.pending()).toBe(1);
    expect(diagnose).toHaveBeenCalledTimes(1); // 定时器响之前一次都不跑（也不取文）
    scheduler.runAll();
    await flushMicrotasks();
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(diagnose.mock.calls[1]![0]).toEqual({ source: '# 幕 改\n', filePath: model.path });
    wiring.dispose();
  });

  it('切回非 2.0 文件 ⇒ 旧 markers 清空、面板条目撤下（不把旧结论留在屏上）', async () => {
    stubFlag(true);
    const kojo2 = fakeModel('D:/p/a.kojo2', '# 幕\n');
    const erb = fakeModel('D:/p/a.erb', '; x\n');
    const fake = fakeEditor(kojo2.model);
    const diagnose = diagnoseReturning([MARKER]);
    const wiring = baseWiring(fake, { diagnose, path: kojo2.path });
    await flushMicrotasks();
    expect(wiring.markerCalls).toHaveLength(1);

    fake.setModel(erb.model);
    await flushMicrotasks();
    expect(wiring.markerCalls.at(-1)!.markers).toEqual([]);
    expect(wiring.markerCalls.at(-1)!.model).toBe(kojo2.model);
    expect(wiring.erased).toContain(kojo2.path);
    expect(diagnose).toHaveBeenCalledTimes(1);
    wiring.dispose();
  });

  it('dispose 幂等：监听只撤一次，退场后内容事件不再触发诊断', async () => {
    stubFlag(true);
    const model = fakeModel('D:/p/a.kojo2', '# 幕\n');
    const fake = fakeEditor(model.model);
    const scheduler = manualScheduler();
    const diagnose = diagnoseReturning([MARKER]);
    const wiring = baseWiring(fake, { diagnose, scheduler, path: model.path });
    await flushMicrotasks();
    wiring.dispose();
    wiring.dispose();
    expect(fake.contentListeners()).toBe(0);
    expect(fake.modelListeners()).toBe(0);
    expect(scheduler.pending()).toBe(0);
    fake.fireContent();
    await flushMicrotasks();
    expect(diagnose).toHaveBeenCalledTimes(1);
  });
});

/* ============================== 失败可见 ============================== */

describe('失败可见：清 markers + 面板写失败条目 + error 通知', () => {
  it('诊断入口抛错 ⇒ markers 清空、写 `kojo2/diagnostics-unavailable`、发 error toast', async () => {
    stubFlag(true);
    const model = fakeModel('D:/p/a.kojo2', '# 幕\n');
    const fake = fakeEditor(model.model);
    const notify = vi.fn();
    const diagnose = vi.fn(() => {
      throw new Error('编译入口炸了');
    });
    const wiring = baseWiring(fake, { diagnose, path: model.path, notify });
    await flushMicrotasks();
    expect(wiring.markerCalls.at(-1)!.markers).toEqual([]);
    const failure = wiring.written.at(-1)!;
    expect(failure.path).toBe(model.path);
    expect(failure.items).toHaveLength(1);
    expect(failure.items[0]!.code).toBe(KOJO2_DIAGNOSTICS_FAILURE_CODE);
    expect(failure.items[0]!.severity).toBe('error');
    expect(failure.items[0]!.message).toContain('编译入口炸了');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].kind).toBe('error');
    expect(String(notify.mock.calls[0]![0].detail)).toContain('编译入口炸了');
    wiring.dispose();
  });
});

/* ============================== markers → 面板 ============================== */

describe('kojo2ProblemsOf：marker 坐标 / severity / code 的翻译', () => {
  it('同行带 span；跨行落回行级；warning / info 分档', () => {
    const problems = kojo2ProblemsOf(
      'D:/p/a.kojo2',
      [
        MARKER,
        { ...MARKER, severity: SEVERITY.Warning, startLineNumber: 4, endLineNumber: 6, message: '跨行' },
        { ...MARKER, severity: SEVERITY.Info, startLineNumber: 8, endLineNumber: 8, startColumn: 1, endColumn: 1 },
      ],
      SEVERITY_SOURCE,
    );
    expect(problems[0]).toEqual({
      path: 'D:/p/a.kojo2',
      line: 2,
      span: { columnStart: 3, columnEnd: 6 },
      severity: 'error',
      message: '示例错误',
      code: 'core/example',
      source: 'Kojo 2.0',
    });
    expect(problems[1]!.severity).toBe('warning');
    expect(problems[1]!.span).toBeUndefined();
    expect(problems[2]!.severity).toBe('info');
    expect(problems[2]!.span).toBeUndefined(); // 零宽不造 span
  });
});

/* ============================== eraTW 装配 ============================== */

function projectWithCharas(): GameProject {
  return {
    charaIndex: new Map([
      [12, { no: 12, name: '灵梦', kojoDir: 'D:/game/口上/12' }],
      [12_3, { no: 123, name: '嵌套', kojoDir: 'D:/game/口上/12/nested' }],
    ]),
  } as unknown as GameProject;
}

describe('adapter / backend 装配（按项目取两面 · 入口 D 改）', () => {
  it('角色号按 `kojoDir` 最长前缀推；不在任何口上目录下 = undefined', () => {
    const project = projectWithCharas();
    expect(charNoForProjectPath(project, 'D:/game/口上/12/场景.kojo2')).toBe('12');
    expect(charNoForProjectPath(project, 'D:\\game\\口上\\12\\nested\\x.kojo2')).toBe('123');
    expect(charNoForProjectPath(project, 'D:/game/口上/99/x.kojo2')).toBeUndefined();
    expect(charNoForProjectPath(null, 'D:/game/口上/12/x.kojo2')).toBeUndefined();
  });

  it('组合根解析出的两面被原样用掉：带 charNo 能装配 `# 机`，缺 charNo 由 backend 如实 fail-closed', async () => {
    // 这里只验"接线把两面送到了 core"，不验 eraTW 的落点细节（那是 eraTW 自己的测试）。
    // 用真 eraTW backend 走一遍：它是唯一同时有 `charNo` 语义与 `# 机` 落点的实现，
    // 换成桩就测不到"charNo 有没有被送进去"这件事。
    const { createEratwEmitBackend, ERATW_GAME_ADAPTER } = await import('@kojo/plugin-eratw-adapter');
    const project = projectWithCharas();
    const surfaceFor: Kojo2SurfaceResolver = (_project, deps) => ({
      adapter: ERATW_GAME_ADAPTER,
      backend: createEratwEmitBackend({
        compileExpression: (expr) => expr.text,
        ...(deps.charNo !== undefined ? { charNo: deps.charNo } : {}),
      }),
    });

    const diagnose = createProjectKojo2Diagnose({
      severitySource: SEVERITY_SOURCE,
      project: () => project,
      surfaceFor,
    });
    const ok = diagnose({ source: '# 机 指令 310\n', filePath: 'D:/game/口上/12/x.kojo2' });
    expect(ok.error).toBeNull();
    expect(ok.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);

    const failed = diagnose({ source: '# 机 指令 310\n', filePath: 'D:/p/x.kojo2' });
    expect(failed.error).toBeNull();
    expect(failed.errorCount).toBeGreaterThan(0);
    expect(failed.diagnostics.some((item) => String(item.code).startsWith('unit/'))).toBe(true);
  });

  it('取不到两面 ⇒ **抛错**（不回退到任何游戏的事实、不给空诊断）', () => {
    const diagnose = createProjectKojo2Diagnose({
      severitySource: SEVERITY_SOURCE,
      project: () => ({ adapterId: 'eraakumamaid' } as unknown as GameProject),
      surfaceFor: () => null,
    });
    expect(() => diagnose({ source: '# 幕\n', filePath: 'D:/p/a.kojo2' })).toThrow(/没有 2\.0 诊断面/);
  });

  it('取项目时 kernel 抛错 ⇒ 按"没有项目"处理（同样抛错，不静默）', () => {
    const diagnose = createProjectKojo2Diagnose({
      severitySource: SEVERITY_SOURCE,
      project: () => {
        throw new Error('kernel disposed');
      },
      surfaceFor: () => null,
    });
    expect(() => diagnose({ source: '# 幕\n', filePath: 'D:/p/a.kojo2' })).toThrow(/无项目/);
  });
});
