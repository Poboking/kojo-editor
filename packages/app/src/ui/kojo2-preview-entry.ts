/**
 * Kojo 2.0 预览面板的**宿主接线**（K2-PREVIEW-PANEL）——**零 React、零 Monaco 运行时**。
 *
 * ## 为什么单独一层
 *
 * 面板组件（`kojo2-preview-panel.tsx`）只认四样 props：编译结果、同源 source map、
 * 跳转回调、光标行。把"编译结果从哪来、光标事件怎么订"塞进组件，组件就会变成第二个
 * 组合根（还得在 node 测试里伪造 Monaco）。所以这一层只做三件机器事：
 *
 * 1. **认文件**：`setFile(path)` / `refresh()` 经注入的 {@link Kojo2PreviewEntryOptions.compile}
 *    取一次结果（**本层不跑编译**，只缓存宿主给的那一份）；
 * 2. **认光标**：`attachCursor(...)` 只要求"取行号 + 订变化"两格（Monaco 的
 *    `onDidChangeCursorPosition` / `getPosition` 结构兼容），事件折成一个 1 基行号；
 * 3. **整形 props**：`panelProps()` 把快照变成组件 props（未就绪 = `null`）。
 *
 * ## flag 关 = 整个入口不存在
 *
 * {@link createKojo2PreviewEntry} 在**装配那一刻**读开关（与语言面 / 诊断接线同一口径，
 * 本批不做运行时热切换）：关 ⇒ 返回 `null`。宿主拿到 `null` 就什么都不挂——零监听、
 * 零端口、零组件。这是"少露"方向的失败，不是缺省开着再想办法藏。
 *
 * ## 两种事件都只产生一次读
 *
 * 光标每移动一行发一次快照；同一行内的列变化不通知（面板只按行同步）。
 * `setFile` / `refresh` 每次重新取一遍编译结果；宿主切文件时旧的编译结果**立即作废**，
 * 不会拿 A 文件的产物去画 B 文件的预览（两份模型不同源时面板另有守卫）。
 */
import type { Kojo2SourceMapModel } from '@kojo/kojo-lang';
import type { Kojo2PreviewCompileResult } from './kojo2-preview-model';
import type { Kojo2PreviewMetrics, Kojo2PreviewPanelProps } from './kojo2-preview-panel';
import { isKojo2CutoverEnabled } from './kojo2-flag';

/** 一次编译的两份产出：产物 + 诊断，与它**同一次**编译的 source map 模型 */
export interface Kojo2PreviewCompilation {
  readonly compiled: Kojo2PreviewCompileResult;
  readonly sourceMapModel: Kojo2SourceMapModel;
}

/** 接线层的注入面（宿主给编译结果与跳转，测试给桩） */
export interface Kojo2PreviewEntryOptions {
  /**
   * 按路径取宿主的编译结果（**同步**、可返回 `null` = 还没编译出来 / 编译失败）。
   * 本层只调用它，不在内部跑 core 编译：预览必须与编辑器波浪线、保存链路用同一份结果。
   */
  readonly compile: (filePath: string) => Kojo2PreviewCompilation | null;
  /** 跳回源码（宿主把路径 + 1 基位置落到编辑器；本层只补上当前文件路径） */
  readonly onJumpToSource: (filePath: string, line: number, column: number) => void;
  /** 初始文件（缺省 = 没有文件，等 `setFile`） */
  readonly filePath?: string | null;
  /** 首帧 / 无 DOM 环境的预览度量（原样转给组件） */
  readonly metrics?: Partial<Kojo2PreviewMetrics>;
  /** 开关读取（缺省 = `isKojo2CutoverEnabled`；测试注入） */
  readonly flag?: () => boolean;
}

/** 接线层快照（`subscribe` 的载荷；只读、每次现算） */
export interface Kojo2PreviewEntrySnapshot {
  /** 当前文件路径（`null` = 没有可预览的文件） */
  readonly filePath: string | null;
  /** 该文件的编译结果（`null` = 还没取到 / 编译失败） */
  readonly compilation: Kojo2PreviewCompilation | null;
  /** 外部源光标行（1 基；`null` = 没有光标） */
  readonly sourceCursorLine: number | null;
  /** 面板此刻挂不挂得上（`filePath` 与 `compilation` 都在） */
  readonly mounted: boolean;
}

/**
 * 编辑器光标的**最小面**（`monaco.editor.IStandaloneCodeEditor` 结构兼容）：
 * 只需取当前位置与订阅光标变化两格。
 */
export interface Kojo2PreviewCursorSource {
  getPosition(): { readonly lineNumber: number } | null;
  onDidChangeCursorPosition(
    listener: (event: { readonly position: { readonly lineNumber: number } }) => void,
  ): { dispose(): void };
}

/** 接线层句柄（宿主在面板生命周期里持一份；`dispose` 后全部方法变成空操作） */
export interface Kojo2PreviewEntry {
  snapshot(): Kojo2PreviewEntrySnapshot;
  /** 订阅快照变化（返回取消订阅；`dispose` 后调用是空操作） */
  subscribe(listener: (snapshot: Kojo2PreviewEntrySnapshot) => void): () => void;
  /** 切换当前文件（`null` = 关掉预览）；立即取一次编译结果 */
  setFile(filePath: string | null): void;
  /** 宿主重新编译完回填：按当前文件再取一次 */
  refresh(): void;
  /** 直接推光标行（没有光标源、或宿主已有一份行号时用；1 基） */
  setCursorLine(line: number | null): void;
  /** 挂上光标事件源；返回**只摘自己**的卸载函数（换源不会误摘新源） */
  attachCursor(cursor: Kojo2PreviewCursorSource | null): () => void;
  /** 面板 props（未就绪 / flag 关 = `null`，宿主据此不挂载） */
  panelProps(): Kojo2PreviewPanelProps | null;
  dispose(): void;
}

/** 开关的公开判据（宿主在创建入口前想先问一句时用同一格） */
export function kojo2PreviewEnabled(flag: () => boolean = isKojo2CutoverEnabled): boolean {
  try {
    return flag();
  } catch {
    return false; // 开关读不出来按"关"（失败方向：少露）
  }
}

function normalizeCursorLine(line: number | null | undefined): number | null {
  if (line === null || line === undefined) return null;
  if (!Number.isFinite(line) || line < 1) return null;
  return Math.trunc(line);
}

/**
 * 造一个预览接线入口；**flag 关直接返回 `null`**（宿主不挂载任何东西）。
 *
 * 失败方向全部"少露"：编译提供方抛错 ⇒ 当作"这一份没编译好"（`compilation: null`），
 * 不把异常抛进渲染链；快照订阅者里的异常也不该拖垮宿主（调用方自己兜）。
 */
export function createKojo2PreviewEntry(
  options: Kojo2PreviewEntryOptions,
): Kojo2PreviewEntry | null {
  if (!kojo2PreviewEnabled(options.flag ?? isKojo2CutoverEnabled)) return null;

  let filePath: string | null = options.filePath ?? null;
  let compilation: Kojo2PreviewCompilation | null = null;
  let sourceCursorLine: number | null = null;
  let cursor: Kojo2PreviewCursorSource | null = null;
  let cursorSubscription: { dispose(): void } | null = null;
  let disposed = false;
  const listeners = new Set<(snapshot: Kojo2PreviewEntrySnapshot) => void>();

  function snapshot(): Kojo2PreviewEntrySnapshot {
    return {
      filePath,
      compilation,
      sourceCursorLine,
      mounted: filePath !== null && compilation !== null,
    };
  }

  function emit(): void {
    if (disposed) return;
    const current = snapshot();
    for (const listener of [...listeners]) listener(current);
  }

  function readCompilation(path: string | null): Kojo2PreviewCompilation | null {
    if (path === null) return null;
    try {
      return options.compile(path);
    } catch {
      return null; // 编译提供方抛错 = 这一份没有可预览的结果（面板会显示空态）
    }
  }

  function cursorLineFromSource(): number | null {
    if (cursor === null) return null;
    try {
      return normalizeCursorLine(cursor.getPosition()?.lineNumber);
    } catch {
      return null;
    }
  }

  function detachCursor(): void {
    cursorSubscription?.dispose();
    cursorSubscription = null;
    cursor = null;
  }

  function setCursorLine(line: number | null): void {
    if (disposed) return;
    const next = normalizeCursorLine(line);
    if (next === sourceCursorLine) return;
    sourceCursorLine = next;
    emit();
  }

  const entry: Kojo2PreviewEntry = {
    snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setFile(next) {
      if (disposed) return;
      filePath = next;
      compilation = readCompilation(next);
      sourceCursorLine = cursorLineFromSource();
      emit();
    },
    refresh() {
      if (disposed) return;
      compilation = readCompilation(filePath);
      emit();
    },
    setCursorLine,
    attachCursor(next) {
      if (disposed) return () => undefined;
      detachCursor();
      if (next === null) {
        emit();
        return () => undefined;
      }
      const attached = next;
      cursor = attached;
      try {
        cursorSubscription = attached.onDidChangeCursorPosition((event) => {
          setCursorLine(event.position.lineNumber);
        });
      } catch {
        cursorSubscription = null; // 订阅失败：只丢光标同步，面板照常按行渲染
      }
      sourceCursorLine = cursorLineFromSource();
      emit();
      return () => {
        if (cursor !== attached) return; // 已经被换源 / 卸载：不误摘新源
        detachCursor();
      };
    },
    panelProps() {
      if (disposed || filePath === null || compilation === null) return null;
      const currentPath = filePath;
      const current = compilation;
      return {
        compiled: current.compiled,
        sourceMapModel: current.sourceMapModel,
        sourceCursorLine,
        onJumpToSource: (line, column) => {
          options.onJumpToSource(currentPath, line, column);
        },
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachCursor();
      listeners.clear();
    },
  };

  compilation = readCompilation(filePath);
  return entry;
}
