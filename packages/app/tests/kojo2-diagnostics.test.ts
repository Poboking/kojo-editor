/**
 * K2-EDITOR-DIAGNOSTICS 的行为闸：core 诊断 → Monaco markers + 问题同步时间轴。
 *
 * 覆盖四面（题面验收：错误 / 警告 / span / 版本过期 / 清理）：
 * - **真 core**：`compileKojoSource` 走 fixture 诊断模式，错误与警告各出一档；
 * - **坐标安全**：跨行、零宽、缺 span、越界、代理对、CRLF 都不越出模型；
 * - **问题同步**：debounce 只编译最后一版、非活动 model 不排队、版本过期结果丢弃；
 * - **清理不静默**：换标签 / 显式 clear / dispose / 诊断失败都真的写空 markers 并回调。
 */

import { describe, expect, it } from 'vitest';
import type { GameAdapter, KojoDiagnostic, KojoEmitBackend } from '@kojo/kojo-core';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';
import type * as Monaco from '../src/monaco/entry';
import { kojo2DocumentDiagnostics } from '@kojo/kojo-lang/diagnostics';
import {
  KOJO2_DIAGNOSTICS_SOURCE,
  kojo2DiagnosticsToMarkers,
} from '../src/ui/kojo2-problem-wiring';
import type {
  Kojo2DiagnosticsInput,
  Kojo2DiagnosticsResult,
  Kojo2MarkerSeveritySource,
} from '../src/ui/kojo2-problem-sync';
import {
  KOJO2_PROBLEM_MARKER_OWNER,
  createKojo2ProblemSync,
  type Kojo2DebounceScheduler,
  type Kojo2MarkerHost,
  type Kojo2ProblemSyncCleared,
  type Kojo2ProblemSyncFailure,
} from '../src/ui/kojo2-problem-sync';

/* ============================== 假 Monaco（只给换算要用的 severity 表） ============================== */

const SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const MONACO = { MarkerSeverity: SEVERITY } as unknown as Kojo2MarkerSeveritySource;

function diagnostic(
  code: string,
  severity: KojoDiagnostic['severity'],
  message: string,
  span: KojoDiagnostic['span'],
): KojoDiagnostic {
  return { code, severity, message, span } as KojoDiagnostic;
}

/**
 * 判据搬家后的**测试脚手架**：B3 收口把 `createKojo2Diagnostics` 整块搬进
 * `@kojo/kojo-lang/diagnostics`。这里只保留"两面必须成对"这一道宿主旧契约的守门，
 * 判据本体（编译 / 落点 / 失败口径）一律走包内的 `kojo2DocumentDiagnostics`，
 * markers 一律走宿主那枚纯翻译 `kojo2DiagnosticsToMarkers`——测试里不重建第二份判据。
 */
interface FakeDiagnoseOptions {
  readonly monaco: Kojo2MarkerSeveritySource;
  readonly adapter?: GameAdapter;
  readonly backend?: KojoEmitBackend;
  readonly compile?: (input: Kojo2DiagnosticsInput) => {
    readonly diagnostics: readonly KojoDiagnostic[];
    readonly erb?: string;
    readonly sourceMap?: import('@kojo/kojo-core').SourceMap;
  };
}

function createKojo2Diagnostics(options: FakeDiagnoseOptions) {
  if ((options.adapter === undefined) !== (options.backend === undefined)) {
    throw new TypeError('adapter 与 backend 必须成对注入');
  }
  return {
    diagnose(input: Kojo2DiagnosticsInput): Kojo2DiagnosticsResult {
      let diagnostics: readonly KojoDiagnostic[] = [];
      let error: string | null = null;
      let artifacts: Kojo2DiagnosticsResult['artifacts'] = null;
      if (options.compile !== undefined) {
        try {
          const compiled = options.compile(input);
          diagnostics = compiled.diagnostics;
          if (typeof compiled.erb === 'string' && compiled.sourceMap !== undefined) {
            artifacts = { erb: compiled.erb, sourceMap: compiled.sourceMap };
          }
        } catch (thrown) {
          error = thrown instanceof Error ? thrown.message : String(thrown);
          diagnostics = [];
          artifacts = null;
        }
      } else {
        const compiled = kojo2DocumentDiagnostics({
          source: input.source,
          filePath: input.filePath,
          adapter: options.adapter ?? FIXTURE_ADAPTER,
          backend: options.backend ?? FIXTURE_BACKEND,
        });
        diagnostics = compiled.diagnostics;
        error = compiled.error;
        artifacts = compiled.artifacts;
      }
      const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
      const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;
      return {
        filePath: input.filePath,
        diagnostics,
        markers: kojo2DiagnosticsToMarkers(options.monaco, diagnostics, input.source),
        artifacts,
        error,
        errorCount,
        warningCount,
        ok: error === null && errorCount === 0,
      };
    },
  };
}

function markerOf(result: Kojo2DiagnosticsResult, diagnosticIndex: number): Monaco.editor.IMarkerData {
  const marker = result.markers[diagnosticIndex];
  if (marker === undefined) throw new Error(`没有生成第 ${diagnosticIndex} 个 marker`);
  return marker;
}

/* ============================== 真 core：错误 / 警告分档 ============================== */

describe('kojo2 诊断 · 真 core（诊断模式）', () => {
  it('错误诊断：code / source / severity / 区间全部落到 marker', () => {
    const service = createKojo2Diagnostics({ monaco: MONACO });
    const source = ['# 机 开场', '# 视角 我', '@算', '    1 + 2', ''].join('\n');
    const result = service.diagnose({ source, filePath: 'ERB/错误.kojo2' });

    expect(result.filePath).toBe('ERB/错误.kojo2');
    expect(result.error).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.markers).toHaveLength(result.diagnostics.length);

    const errorIndex = result.diagnostics.findIndex((item) => item.severity === 'error');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    const error = result.diagnostics[errorIndex]!;
    const marker = markerOf(result, errorIndex);
    expect(marker.severity).toBe(SEVERITY.Error);
    expect(marker.code).toBe(error.code);
    expect(marker.source).toBe(KOJO2_DIAGNOSTICS_SOURCE);

    // span 非零宽时逐列对得上（零宽由 marker 换算扩成一格，单独测）
    if (error.span !== null) {
      const zeroWidth =
        error.span.start.line === error.span.end.line &&
        error.span.start.column === error.span.end.column;
      expect(marker.startLineNumber).toBe(error.span.start.line);
      expect(marker.endLineNumber).toBe(error.span.end.line);
      if (!zeroWidth) {
        expect(marker.startColumn).toBe(error.span.start.column);
        expect(marker.endColumn).toBe(error.span.end.column);
      }
      expect(marker.startColumn).toBeGreaterThanOrEqual(1);
      expect(marker.endColumn).toBeGreaterThan(marker.startColumn);
    }
  });

  it('警告诊断：`选项` 待定 UI 走 Warning 档，且不阻断（ok 仍为 true）', () => {
    // `选项` 主链 fail-closed：adapter 不声明 UI 只出 error、零字节（K2-WIRE-OPTIONS 口径）。
    // 要测"待定 warning 不阻断"，adapter 必须真声明 options，backend profile 也随之开启。
    const adapter: GameAdapter = {
      ...FIXTURE_ADAPTER,
      presentation: {
        ...FIXTURE_ADAPTER.presentation,
        options: {
          status: 'pending',
          button: 'BUTTON',
          input: 'INPUTS',
          result: 'RESULTS',
          maxPerScene: 1,
        },
      },
    };
    const backend: KojoEmitBackend = {
      ...FIXTURE_BACKEND,
      profile: {
        ...FIXTURE_BACKEND.profile,
        presentations: { ...FIXTURE_BACKEND.profile.presentations, options: true },
      },
    };
    const service = createKojo2Diagnostics({
      monaco: MONACO,
      adapter,
      backend,
    });
    const source = [
      '# 机 开场',
      '# 视角 我',
      '选项：',
      '    「标签」：',
      '        > 选项正文。',
      '',
    ].join('\n');
    const result = service.diagnose({ source, filePath: 'ERB/警告.kojo2' });

    expect(result.error).toBeNull();
    expect(result.warningCount).toBeGreaterThan(0);
    const warningIndex = result.diagnostics.findIndex((item) => item.severity === 'warning');
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    const warning = result.diagnostics[warningIndex]!;
    expect(warning.code).toBe('core/options/pending');
    const marker = markerOf(result, warningIndex);
    expect(marker.severity).toBe(SEVERITY.Warning);
    expect(marker.code).toBe('core/options/pending');
    expect(marker.source).toBe(KOJO2_DIAGNOSTICS_SOURCE);
    expect(result.ok).toBe(true);
  });

  it('编译入口抛错：返回 error 读数且 markers 为空（不伪造诊断）', () => {
    const service = createKojo2Diagnostics({
      monaco: MONACO,
      compile: () => {
        throw new Error('后端炸了');
      },
    });
    const result = service.diagnose({ source: '> 随便', filePath: 'ERB/炸.kojo2' });
    expect(result.error).toContain('后端炸了');
    expect(result.markers).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('adapter / backend 只给一个 ⇒ 调用点立即抛 TypeError（不猜另一半）', () => {
    expect(() =>
      createKojo2Diagnostics({
        monaco: MONACO,
        adapter: FIXTURE_ADAPTER,
      }),
    ).toThrow(TypeError);
  });
});

/* ============================== 坐标安全（纯函数） ============================== */

describe('kojo2 诊断 · span 落点安全', () => {
  it('零宽扩成一格；跨行保留；缺 span 退到文件头', () => {
    const source = 'abc\ndefg';
    const diagnostics = [
      diagnostic('core/lex/anchor', 'error', '零宽', {
        start: { line: 2, column: 3 },
        end: { line: 2, column: 3 },
      }),
      diagnostic('core/table/overlap', 'error', '跨行', {
        start: { line: 1, column: 2 },
        end: { line: 2, column: 3 },
      }),
      diagnostic('core/expr/unknown-symbol', 'warning', '无落点', null),
    ];
    const markers = kojo2DiagnosticsToMarkers(MONACO, diagnostics, source);

    expect(markers[0]).toMatchObject({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 4,
    });
    expect(markers[1]).toMatchObject({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 3,
    });
    expect(markers[2]).toMatchObject({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
  });

  it('越界 / 逆序：夹回最后一行与行宽，终点不小于起点', () => {
    const source = 'abc\ndefg';
    const diagnostics = [
      diagnostic('core/lex/indent', 'error', '越界', {
        start: { line: 99, column: 99 },
        end: { line: 99, column: 99 },
      }),
      diagnostic('core/lex/indent', 'error', '逆序', {
        start: { line: 2, column: 4 },
        end: { line: 1, column: 1 },
      }),
    ];
    const markers = kojo2DiagnosticsToMarkers(MONACO, diagnostics, source);

    // 第 2 行 "defg" 行宽 5（列 5 = 行尾光标位）；零宽在行尾向左扩一格
    expect(markers[0]).toMatchObject({
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 5,
    });
    expect(markers[1]).toMatchObject({
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 5,
    });
  });

  it('代理对：零宽落在 emoji 上不切断 UTF-16 码元', () => {
    const source = '😀';
    const atStart = kojo2DiagnosticsToMarkers(
      MONACO,
      [
        diagnostic('core/lex/anchor', 'error', '起点', {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 1 },
        }),
      ],
      source,
    );
    expect(atStart[0]).toMatchObject({ startColumn: 1, endColumn: 3 });

    // 列 2 落在低代理上：向左含住高代理
    const atLow = kojo2DiagnosticsToMarkers(
      MONACO,
      [
        diagnostic('core/lex/anchor', 'error', '低代理', {
          start: { line: 1, column: 2 },
          end: { line: 1, column: 2 },
        }),
      ],
      source,
    );
    expect(atLow[0]).toMatchObject({ startColumn: 1, endColumn: 3 });

    // 列 3 = 行尾光标位：向左扩仍覆盖整个代理对
    const atEnd = kojo2DiagnosticsToMarkers(
      MONACO,
      [
        diagnostic('core/lex/anchor', 'error', '行尾', {
          start: { line: 1, column: 3 },
          end: { line: 1, column: 3 },
        }),
      ],
      source,
    );
    expect(atEnd[0]).toMatchObject({ startColumn: 1, endColumn: 3 });
  });

  it('CRLF：列号按行内码元算，行尾 `\\r` 不撑宽行宽', () => {
    const source = 'a\r\nb';
    const markers = kojo2DiagnosticsToMarkers(
      MONACO,
      [
        diagnostic('core/lex/anchor', 'error', '第二行', {
          start: { line: 2, column: 1 },
          end: { line: 2, column: 2 },
        }),
      ],
      source,
    );
    expect(markers[0]).toMatchObject({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 2,
    });
  });
});

/* ============================== 问题同步（时间轴 / 清理） ============================== */

class FakeModel {
  disposed = false;
  version = 1;
  isDisposed(): boolean {
    return this.disposed;
  }
  getVersionId(): number {
    return this.version;
  }
}

function modelOf(model: FakeModel): Monaco.editor.ITextModel {
  return model as unknown as Monaco.editor.ITextModel;
}

interface MarkerCall {
  readonly model: FakeModel;
  readonly owner: string;
  readonly markers: Monaco.editor.IMarkerData[];
}

function createMarkerHost(): { host: Kojo2MarkerHost; calls: MarkerCall[] } {
  const calls: MarkerCall[] = [];
  return {
    calls,
    host: {
      editor: {
        setModelMarkers(model, owner, markers) {
          calls.push({
            model: model as unknown as FakeModel,
            owner,
            markers: [...markers],
          });
        },
      },
    },
  };
}

function lastCallFor(calls: readonly MarkerCall[], model: FakeModel): MarkerCall | undefined {
  return [...calls].reverse().find((call) => call.model === model);
}

class ManualScheduler implements Kojo2DebounceScheduler {
  private readonly tasks = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(callback: () => void): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  get pending(): number {
    return this.tasks.size;
  }

  run(): void {
    const callbacks = [...this.tasks.values()];
    this.tasks.clear();
    for (const callback of callbacks) callback();
  }
}

function marker(message: string): Monaco.editor.IMarkerData {
  return {
    severity: SEVERITY.Error,
    message,
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 2,
  };
}

function diagnosticsResult(
  filePath: string,
  markers: readonly Monaco.editor.IMarkerData[] = [],
  overrides: Partial<Kojo2DiagnosticsResult> = {},
): Kojo2DiagnosticsResult {
  return {
    filePath,
    diagnostics: [],
    markers,
    error: null,
    errorCount: markers.length,
    warningCount: 0,
    ok: true,
    ...overrides,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((reason: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value) {
      resolveFn?.(value);
    },
    reject(reason) {
      rejectFn?.(reason);
    },
  };
}

describe('kojo2 问题同步', () => {
  it('debounce：连续编辑只编译最后一版，且 owner / markers 都落到活动 model', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const compiled: string[] = [];
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      debounceMs: 200,
      diagnose: ({ source }) => {
        compiled.push(source);
        return diagnosticsResult('a.kojo2', [marker(source)]);
      },
    });
    const fake = new FakeModel();
    const model = modelOf(fake);
    sync.setActive(model, 'a.kojo2');

    expect(sync.schedule(model, 'a.kojo2', '第一版')).toBe(true);
    expect(sync.schedule(model, 'a.kojo2', '第二版')).toBe(true);
    expect(scheduler.pending).toBe(1);

    scheduler.run();
    await sync.flush();

    expect(compiled).toEqual(['第二版']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.owner).toBe(KOJO2_PROBLEM_MARKER_OWNER);
    expect(calls[0]!.markers[0]!.message).toBe('第二版');
  });

  it('仅活动 model：非活动 model 不排队；换标签清旧 markers 并回调', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const cleared: Kojo2ProblemSyncCleared[] = [];
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      onCleared: (event) => cleared.push(event),
      diagnose: ({ source }) => diagnosticsResult('a.kojo2', [marker(source)]),
    });
    const fakeA = new FakeModel();
    const fakeB = new FakeModel();
    const modelA = modelOf(fakeA);
    const modelB = modelOf(fakeB);

    sync.setActive(modelA, 'a.kojo2');
    expect(sync.schedule(modelB, 'b.kojo2', '不该跑')).toBe(false);
    expect(scheduler.pending).toBe(0);

    expect(sync.schedule(modelA, 'a.kojo2', 'A')).toBe(true);
    scheduler.run();
    await sync.flush();
    expect(lastCallFor(calls, fakeA)?.markers[0]?.message).toBe('A');

    sync.setActive(modelB, 'b.kojo2');
    expect(lastCallFor(calls, fakeA)?.markers).toEqual([]);
    expect(cleared.at(-1)).toMatchObject({ reason: 'inactive', filePath: 'a.kojo2' });
    expect(sync.schedule(modelA, 'a.kojo2', '旧标签')).toBe(false);
    expect(sync.schedule(modelB, 'b.kojo2', '新标签')).toBe(true);
  });

  it('版本过期：旧请求晚回来不覆盖新 markers', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const first = deferred<Kojo2DiagnosticsResult>();
    const second = deferred<Kojo2DiagnosticsResult>();
    const pending = [first.promise, second.promise];
    let diagnoseCalls = 0;
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      diagnose: () => {
        const promise = pending[diagnoseCalls];
        diagnoseCalls += 1;
        if (promise === undefined) throw new Error('诊断次数超出预期');
        return promise;
      },
    });
    const fake = new FakeModel();
    const model = modelOf(fake);
    sync.setActive(model, 'a.kojo2');

    expect(sync.schedule(model, 'a.kojo2', '旧文本')).toBe(true);
    scheduler.run();
    fake.version = 2;
    expect(sync.schedule(model, 'a.kojo2', '新文本')).toBe(true);
    scheduler.run();
    expect(diagnoseCalls).toBe(2);

    first.resolve(diagnosticsResult('a.kojo2', [marker('旧')]));
    second.resolve(diagnosticsResult('a.kojo2', [marker('新')]));
    await sync.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.markers[0]!.message).toBe('新');
  });

  it('清理不静默：空诊断也写空 markers；clear / dispose 都通知', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const cleared: Kojo2ProblemSyncCleared[] = [];
    const applied: string[] = [];
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      onCleared: (event) => cleared.push(event),
      onDiagnostics: (event) => applied.push(event.filePath),
      diagnose: () => diagnosticsResult('a.kojo2', []),
    });
    const fake = new FakeModel();
    const model = modelOf(fake);
    sync.setActive(model, 'a.kojo2');

    sync.schedule(model, 'a.kojo2', '没有问题的文本');
    scheduler.run();
    await sync.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.markers).toEqual([]);
    expect(applied).toEqual(['a.kojo2']);

    sync.clear(model);
    expect(lastCallFor(calls, fake)?.markers).toEqual([]);
    expect(cleared.at(-1)).toMatchObject({ reason: 'explicit', filePath: 'a.kojo2' });

    // clear 之后重新挂上，再验证 dispose 的收尾（已清过的 model 不该重复通知）
    sync.setActive(model, 'a.kojo2');
    sync.schedule(model, 'a.kojo2', '再次挂上');
    scheduler.run();
    await sync.flush();
    sync.dispose();
    expect(lastCallFor(calls, fake)?.markers).toEqual([]);
    expect(cleared.at(-1)).toMatchObject({ reason: 'dispose', filePath: 'a.kojo2' });
    expect(sync.schedule(model, 'a.kojo2', 'dispose 之后')).toBe(false);
  });

  it('诊断失败可见：清旧 markers + onFailure 带原因', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const failures: Kojo2ProblemSyncFailure[] = [];
    const cleared: Kojo2ProblemSyncCleared[] = [];
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      onFailure: (event) => failures.push(event),
      onCleared: (event) => cleared.push(event),
      diagnose: () => {
        throw new Error('编译链路炸了');
      },
    });
    const fake = new FakeModel();
    const model = modelOf(fake);
    sync.setActive(model, 'a.kojo2');
    sync.schedule(model, 'a.kojo2', '文本');
    scheduler.run();
    await sync.flush();

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain('编译链路炸了');
    expect(failures[0]!.filePath).toBe('a.kojo2');
    expect(cleared.at(-1)).toMatchObject({ reason: 'failure', filePath: 'a.kojo2' });
    expect(lastCallFor(calls, fake)?.markers).toEqual([]);
  });

  it('诊断结果自报 error：同样撤掉旧波浪线并通知失败（不静默当无问题）', async () => {
    const scheduler = new ManualScheduler();
    const { host, calls } = createMarkerHost();
    const failures: Kojo2ProblemSyncFailure[] = [];
    const sync = createKojo2ProblemSync({
      markerHost: host,
      scheduler,
      onFailure: (event) => failures.push(event),
      diagnose: () => diagnosticsResult('a.kojo2', [], { error: '编译入口返回了 error', ok: false }),
    });
    const fake = new FakeModel();
    const model = modelOf(fake);
    sync.setActive(model, 'a.kojo2');
    sync.schedule(model, 'a.kojo2', '文本');
    scheduler.run();
    await sync.flush();

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe('编译入口返回了 error');
    expect(lastCallFor(calls, fake)?.markers).toEqual([]);
  });
});
