/**
 * `window.__kojoDebug` 调试面的安装器（2026-10-24 调试模式批）。
 *
 * **只在选入调试模式时进页面**（`main.tsx` 里 `?kojo-debug=1` 才动态 import 本模块）：
 * 开机图（ps10-eager-graph 闸）一个字节都不受影响；桌面壳与未选入的浏览器页
 * 永远不执行这里的代码。
 *
 * 暴露的分面（全部只读优先，写动作显式命名）：
 * - `mode` / `host`：当前跑在哪（shell = 桌面壳；web-debug = 浏览器 + 调试宿）；
 * - `state()`：一屏聚合读数（相位 / 主题 / 标签 / 面板 / 通知 / 树 / 状态栏 / 当前项目）；
 * - `kernel()`：活内核对象（services / plugins / bus / project 的完整面，高级用法）；
 * - `commands.list() / run(id)`：命令面板注册表——**所有功能只要登记了命令就有一个
 *   可编程入口**，与真人按 Ctrl+Shift+P 走的是同一条路；
 * - `bus.recent(n) / on(name, cb)`：内核事件总线的旁听（环形缓冲 + 订阅）；
 * - `editor.*`：焦点编辑器的读数与受控写（经 editor-pane-registry 的登记簿，
 *   不碰 EditorPane 源码）：info / setValue / type / setCursor / markers；
 * - `invoke(cmd, args)`：直达宿主命令（桌面壳 = 真 Tauri IPC；浏览器 = 调试宿）；
 * - `perf.*`：UI 卡顿体检探针（可开关；帧分档 / 长任务×事件相关性 / 交互延迟 /
 *   逐源码文件的帧耗时归因——口径与阈值见 `perf-probe-core.ts`）；
 * - `dom.snapshot()`：结构快照（`dom-snapshot.ts` 的口径）。
 */
import { invoke, isTauri } from '../bridge/invoke';
import { KERNEL_EVENT_NAMES, type GameProject, type KernelEventName } from '@kojo/plugin-api';
import { version as APP_VERSION } from '../../package.json';
import type { Kernel } from '@kojo/kernel';
import { getDebugCommandRunner, whenDebugKernel } from './debug-registry';
import { webHostActive, webHostOrigin } from './web-host-transport';
import { snapshotDocument, type DomSnapshot } from './dom-snapshot';
import { createPerfProbe, type PerfProbe } from './perf-probe';
import { summarizeReport } from './perf-probe-core';
// 编辑器登记簿（只 import 这一个轻模块；Monaco 运行时按需再动态取）
import { focusedCtx } from '../ui/editor-pane-registry';

export interface DebugStateReading extends DomSnapshot {
  readonly ready: true;
  readonly project: { rootDir: string; adapterId: string; kojoPaths: string[]; gameVersion?: string } | null;
}

export interface KojoDebugApi {
  readonly mode: 'shell' | 'web-debug';
  readonly appVersion: string;
  readonly host: string | null;
  state(): DebugStateReading;
  kernel(): Promise<Kernel>;
  commands: {
    list(): readonly { id: string; title: string; category?: string; keybinding?: string }[] | { error: string };
    run(id: string): Promise<void>;
  };
  bus: {
    recent(n?: number): readonly BusRecord[];
    on(name: string, cb: (payload: unknown) => void): () => void;
  };
  editor: {
    info(): EditorInfo | null;
    setValue(text: string): boolean;
    /** 在光标处插入文本（走 executeEdits，进撤销栈——与真人打字同路） */
    type(text: string): boolean;
    setCursor(line: number, column: number): boolean;
    markers(): Promise<{ resource: string; severity: number; message: string; line: number }[]>;
  };
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** UI 卡顿体检（可开关；关着零开销）：start → 交互 → stop 出报告 */
  perf: {
    start(opts?: { blockingSampleMs?: number }): { started: true; note: string };
    stop(): ReturnType<PerfProbe['stop']>;
    isRunning(): boolean;
    lastReport(): ReturnType<PerfProbe['lastReport']>;
    /** 上一轮报告的人读摘要行（无报告 ⇒ null） */
    summary(): string[] | null;
  };
  dom: { snapshot(): DomSnapshot };
}

export interface BusRecord {
  readonly t: number;
  readonly name: string;
  readonly payload: unknown;
}

export interface EditorInfo {
  readonly path: string;
  readonly languageId: string;
  readonly eol: 'lf' | 'crlf';
  readonly lineCount: number;
  readonly value: string;
  readonly cursor: { readonly line: number; readonly column: number };
  readonly selection: string | null;
}

const BUS_RING_LIMIT = 500;
const busRing: BusRecord[] = [];

/** kernel 的同步缓存（装配完成即写入）：`state()` 这类同步读数从它取，不 await */
let kernelNow: Kernel | null = null;

function recordBus(name: string, payload: unknown): void {
  // 时基与探针同域（口径修②，2026-10-25 反馈）：performance.now() 与
  // PerformanceObserver 条目的 startTime 同钟——hintForTask 才能对上；
  // Date.now() 是墙钟，两域混用 ⇒ 长任务 hint 恒 null（实测三条全 null）。
  // 消费方（bus.recent 的展示）只相对排序，无墙钟依赖。
  busRing.push({ t: performance.now(), name, payload });
  if (busRing.length > BUS_RING_LIMIT) busRing.splice(0, busRing.length - BUS_RING_LIMIT);
}

/** 事件载荷太大时会拖垮 JSON 序列化：旁听面只留摘要形态（数值 / 短串 / 浅结构） */
export function slimPayload(payload: unknown, depth = 0): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (typeof payload === 'string') return payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  if (Array.isArray(payload)) {
    const arr = payload as unknown[];
    return { __arr: arr.length, sample: arr.slice(0, 5).map((p) => slimPayload(p, depth + 1)) };
  }
  if (typeof payload === 'object') {
    if (depth >= 2) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 12)) {
      out[k] = slimPayload(v, depth + 1);
    }
    return out;
  }
  return String(payload);
}

export function installDebug(): KojoDebugApi {
  // 总线旁听：kernel 到场即挂全量已知事件（环形缓冲 + slim）
  void whenDebugKernel().then((kernel) => {
    kernelNow = kernel;
    for (const name of KERNEL_EVENT_NAMES) {
      kernel.bus.on(name as KernelEventName, (payload: unknown) => recordBus(name, slimPayload(payload)));
    }
  });

  // 性能探针（关着零开销；bus 相关性在 stop 时从环形缓冲取，不在采集期加订阅）
  const probe = createPerfProbe({ getBusRecent: (n) => busRing.slice(-n) });

  const api: KojoDebugApi = {
    mode: isTauri() ? 'shell' : 'web-debug',
    appVersion: APP_VERSION,
    host: webHostActive() ? webHostOrigin() : null,
    state() {
      const p: GameProject | null = kernelNow?.project.current() ?? null;
      return {
        ...snapshotDocument(document),
        ready: true,
        project: p
          ? {
              rootDir: p.rootDir,
              adapterId: p.adapterId,
              kojoPaths: p.kojoPaths,
              ...(p.gameVersion !== undefined ? { gameVersion: p.gameVersion } : {}),
            }
          : null,
      };
    },
    kernel() {
      return whenDebugKernel();
    },
    commands: {
      list() {
        const runner = getDebugCommandRunner();
        if (!runner) return { error: '命令注册表未登记（ShellLayout 未挂载或未注册调试通道）' };
        return runner.list();
      },
      async run(id) {
        const runner = getDebugCommandRunner();
        if (!runner) throw new Error('命令注册表未登记（ShellLayout 未挂载或未注册调试通道）');
        await runner.run(id);
      },
    },
    bus: {
      recent(n = 40) {
        return busRing.slice(-n);
      },
      on(name, cb) {
        let un: (() => void) | null = null;
        void whenDebugKernel().then((kernel) => {
          un = (kernel.bus as unknown as {
            on(n: string, cb: (p: unknown) => void): () => void;
          }).on(name, cb);
        });
        return () => {
          un?.();
        };
      },
    },
    editor: {
      info() {
        const ctx = focusedCtx();
        const ed = ctx?.editorRef.current;
        if (!ctx || !ed) return null;
        const model = ed.getModel();
        const pos = ed.getPosition();
        const sel = ed.getSelection();
        return {
          path: ctx.filePathRef.current,
          languageId: model?.getLanguageId() ?? '',
          eol: model?.getEOL() === '\r\n' ? ('crlf' as const) : ('lf' as const),
          lineCount: model?.getLineCount() ?? 0,
          value: model?.getValue() ?? '',
          cursor: { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 },
          selection: sel && !sel.isEmpty() ? ((model?.getValueInRange(sel) ?? null) as string | null) : null,
        };
      },
      setValue(text) {
        const model = focusedCtx()?.editorRef.current?.getModel();
        if (!model) return false;
        model.setValue(text);
        return true;
      },
      type(text) {
        const ed = focusedCtx()?.editorRef.current;
        const pos = ed?.getPosition();
        if (!ed || !pos) return false;
        // executeEdits 进 undo 栈（setValue 不进）——「像真人一样改」用它
        ed.executeEdits('kojo-debug', [
          {
            range: {
              startLineNumber: pos.lineNumber,
              startColumn: pos.column,
              endLineNumber: pos.lineNumber,
              endColumn: pos.column,
            },
            text,
            forceMoveMarkers: true,
          },
        ]);
        return true;
      },
      setCursor(line, column) {
        const ed = focusedCtx()?.editorRef.current;
        if (!ed) return false;
        ed.setPosition({ lineNumber: line, column });
        return true;
      },
      async markers() {
        const monaco = await import('../monaco/entry');
        return monaco.editor
          .getModelMarkers({})
          .map((m) => ({ resource: m.resource.toString(), severity: m.severity, message: m.message, line: m.startLineNumber }));
      },
    },
    invoke(cmd, args) {
      return invoke(cmd, args);
    },
    perf: {
      start: (opts) => probe.start(opts),
      stop: () => probe.stop(),
      isRunning: () => probe.isRunning(),
      lastReport: () => probe.lastReport(),
      summary: () => {
        const r = probe.lastReport();
        return r ? summarizeReport(r) : null;
      },
    },
    dom: {
      snapshot() {
        return snapshotDocument(document);
      },
    },
  };
  (window as unknown as { __kojoDebug?: KojoDebugApi }).__kojoDebug = api;
  console.info(
    `[kojo-debug] 调试面已安装（mode=${api.mode}，host=${api.host ?? '（桌面壳直连 IPC）'}；API 见 window.__kojoDebug）`,
  );
  return api;
}
