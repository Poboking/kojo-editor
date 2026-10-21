/**
 * Kojo 2.0 诊断 → 编辑器事件 → 既有问题面板的**接线层**（K2 batch-3）。
 *
 * ## 三层分工（本文件只做第三层）
 *
 * 1. `monaco/kojo2-diagnostics.ts`：core 编译 → markers（纯逻辑，不碰 Monaco 实例）；
 * 2. `ui/kojo2-problem-sync.ts`：debounce / 只认活动 model / 版本过期丢弃 / 清理（纯状态机）；
 * 3. 本文件：把**编辑器事件**（内容变化 / 活动 model 切换）折成第 2 层的
 *    `setActive` + `schedule`，并把结果接到两处**既有**消费点——
 *    - `monaco.editor.setModelMarkers(model, 'kojo2-diagnostics', markers)`（波浪线）；
 *    - `problem-store.setProblems(path, items)`（问题面板的数据源，Ctrl+Shift+M）。
 *    没有新造第二套 UI / 第二个面板。
 *
 * ## 为什么在 bridge 里再加一层 debounce
 *
 * `kojo2-problem-sync.schedule()` 的输入是**源文本字符串**：若在每次
 * `onDidChangeModelContent` 里直接 `model.getValue()`，一份 2 MB 的稿子每敲一个键就整篇
 * 复制一次（本仓对"整篇复制"的代价有一串实测，见 `marker-pool.ts` 头注的 PS-4/PS-5）。
 * 所以本层先按 `KOJO2_PROBLEM_DEBOUNCE_MS` 合并击键，**定时器响时才取一次文本**，再交给
 * 第 2 层（其自身 debounce 置 0：时间轴已在本层走完，重复等待只会让诊断慢 200ms）。
 * 第 2 层仍负责版本/世代判据，这里的文本与 `schedule` 捕获的版本号在同一拍读，不会错位。
 *
 * ## 事件语义
 *
 * - `onDidChangeModelContent`：合并击键 → 取文本 → 诊断（活动 model 才跑）；
 * - `onDidChangeModel`：换 model（切标签 / `setModel`）**立即**跑一次；目标不是 `.kojo2`
 *   （例如切回 `.erb`）⇒ `sync.clear()`（撤旧波浪线 + 撤问题面板条目）。
 * - 卸载：取消定时器 → 撤两个监听 → `sync.dispose()`（幂等）。
 *
 * 路径以 **model 的 URI** 为准（`monaco.Uri.file(path)` 是 model 池建的），`filePathRef`
 * 只做兜底：`onDidChangeModel` 那一拍 `filePathRef` 可能还是上一个标签的值。
 *
 * ## 失败可见（铁律 4）
 *
 * 诊断入口抛错 / 编译入口自报失败 ⇒ 第 2 层清空旧 markers，本层再：
 * ① 往问题面板写一条 `kojo2/diagnostics-unavailable`（不是"没问题"，是"没有诊断"）；
 * ② 经注入的 `notify` 发一条 `error` toast（宿主 UI 的通知中心，非新造 UI）。
 * 两条都有，缺一条都会让"屏上什么都没有"被读成"这份文件是干净的"。
 *
 * ## 装配口径
 *
 * adapter / backend 按 eraTW 的既有装配方式构造：`ERATW_GAME_ADAPTER` +
 * `createEratwEmitBackend(...)`。两处**已知缺口**写在 {@link createEratwKojo2Diagnose} 上：
 * 表达式端口暂用恒等透传（v1 `lowerExpression` 尚未接进 2.0 面）、角色号只能从
 * `GameProject.charaIndex[].kojoDir` 的前缀推（推不到时 backend 会如实报
 * `unit/backend-incomplete`，不静默造一个假函数名）。
 */
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
import { createEratwEmitBackend, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter'; // audit-allow: 诊断接线要具体 adapter 的 2.0 数据/backend 面；与 bootstrap.ts 组合根同一豁免口径
import {
  KOJO2_DIAGNOSTICS_SOURCE,
  createKojo2Diagnostics,
  type Kojo2DiagnosticsArtifacts,
  type Kojo2DiagnosticsInput,
  type Kojo2DiagnosticsResult,
  type Kojo2MarkerSeveritySource,
} from '../monaco/kojo2-diagnostics';
import { buildKojo2SourceMapModel } from '../monaco/kojo2-sourcemap-model';
import type { Kojo2PreviewCompilation } from './kojo2-preview-entry';
import {
  KOJO2_PROBLEM_DEBOUNCE_MS,
  createKojo2ProblemSync,
  type Kojo2DebounceScheduler,
  type Kojo2DiagnoseFn,
  type Kojo2MarkerHost,
} from './kojo2-problem-sync';
import { clearProblems, setProblems, type EditorProblem } from './problem-store';
import type { NoticeInput } from './NotificationCenter';
import { kojo2DiagnosticsEnabled, isKojo2DiagnosticsPath } from './kojo2-diagnostics-gate';

/** 诊断失败在问题面板里的稳定诊断码（不是 core 诊断码；一眼看出这是工具链自己的事） */
export const KOJO2_DIAGNOSTICS_FAILURE_CODE = 'kojo2/diagnostics-unavailable';

/* ============================== adapter / backend 装配 ============================== */

/** `createEratwKojo2Diagnose` 的依赖（全部可注入，测试不需要真 adapter） */
export interface Kojo2DiagnoseFactoryOptions {
  /** Monaco 的 severity 表（宿主传真实例；测试传同形状替身） */
  readonly severitySource: Kojo2MarkerSeveritySource;
  /** 文件路径 → 角色号（缺省 = 不注入，`# 机` 会按 backend 的 fail-closed 如实报缺） */
  readonly charNoForPath?: (filePath: string) => string | undefined;
}

/**
 * **表达式端口**：恒等透传。
 *
 * core 交给 backend 的是表达式源切片（已由 core 做完语法/符号校验）；backend 只负责把它
 * 落成 ERB 表达式。v1 的 `lowerExpression` 尚未接进 2.0 面（切流批的事），所以本批用
 * 恒等透传：**诊断仍然成立**（语法/结构/事件目录/存储期等判据都在 core 与 backend 的
 * 其它腿上），缺的只是"表达式内容在产物里的最终形状"——那不影响波浪线的位置与条数。
 */
function identityCompileExpression(expr: { readonly text: string }): string {
  return expr.text;
}

/** backend 按角色号缓存（`createEratwEmitBackend` 会把 charNo 闭包进事件头模板） */
const BACKEND_CACHE_LIMIT = 32;

/** 同步诊断入口（`createKojo2Diagnostics` 本身是同步纯计算；异步化留给将来的 worker） */
export type Kojo2SyncDiagnoseFn = (input: Kojo2DiagnosticsInput) => Kojo2DiagnosticsResult;

/**
 * 造 eraTW 诊断入口。
 *
 * 每次诊断按 `filePath` 现取角色号（项目可切换、文件可改名），backend 按角色号缓存
 * （有界：角色号种类远小于上限；到顶整体清空重来，绝不无界增长）。
 */
export function createEratwKojo2Diagnose(options: Kojo2DiagnoseFactoryOptions): Kojo2SyncDiagnoseFn {
  const backends = new Map<string, ReturnType<typeof createEratwEmitBackend>>();
  const backendFor = (charNo: string | undefined): ReturnType<typeof createEratwEmitBackend> => {
    const key = charNo ?? '';
    const cached = backends.get(key);
    if (cached !== undefined) return cached;
    const backend = createEratwEmitBackend({
      compileExpression: identityCompileExpression,
      ...(charNo !== undefined && charNo.length > 0 ? { charNo } : {}),
    });
    if (backends.size >= BACKEND_CACHE_LIMIT) backends.clear();
    backends.set(key, backend);
    return backend;
  };
  return (input) => {
    const charNo = options.charNoForPath?.(input.filePath);
    return createKojo2Diagnostics({
      monaco: options.severitySource,
      adapter: ERATW_GAME_ADAPTER,
      backend: backendFor(charNo),
    }).diagnose(input);
  };
}

/**
 * 从 `GameProject.charaIndex` 推角色号：**最长目录前缀**命中者胜（与文件树分组的
 * `kojoOwners` 同一条"长前缀优先"口径，避免嵌套目录误归属）。
 *
 * 纯函数、零 IO；`charaIndex` 缺席 / 文件不在任何 `kojoDir` 下 ⇒ `undefined`（不猜）。
 * 路径归一走契约的 `pathKey`（Windows 分隔符 / 大小写差异下同一个文件必须判得上）。
 */
export function charNoForProjectPath(project: GameProject | null, filePath: string): string | undefined {
  if (project === null) return undefined;
  let bestLength = -1;
  let found: string | undefined;
  for (const chara of project.charaIndex.values()) {
    if (typeof chara.kojoDir !== 'string' || chara.kojoDir.length === 0) continue;
    // 归属判据（分隔符 / 大小写）走契约的 `isPathUnder`，不在这里手写 startsWith——
    // win32 归一化后的分隔符是 `\`，拿 `/` 拼前缀在 Windows 上会恒定判不上。
    if (!isPathUnder(chara.kojoDir, filePath)) continue;
    const length = pathKey(chara.kojoDir).length;
    if (length > bestLength) {
      bestLength = length;
      found = String(chara.no);
    }
  }
  return found;
}

/** 从 kernel 现取项目（项目可开可关；每次诊断再读，不缓存上一个项目的事实） */
function charNoResolverForKernel(kernel: Kernel): (filePath: string) => string | undefined {
  return (filePath) => {
    try {
      return charNoForProjectPath(kernel.project.current(), filePath);
    } catch {
      return undefined;
    }
  };
}

/* ============================== 一次编译两处消费（K2-EDITOR-MOUNT ①） ============================== */

/**
 * 诊断那次 core 编译的**成品缓存**（预览面板的唯一数据源）。
 *
 * ## 为什么必须走缓存端口，而不是让预览自己编译
 *
 * 预览面板要的三格——产物 `erb`、诊断、**与产物同一次**的 source map——都已经在诊断链路
 * 里算出来了（`compileKojoSource` 一次给全）。让预览再编译一次 = 两份结果；哪怕输入一字
 * 不差，source map 也是两个对象，预览模型的"不同源"守卫（行数不等即 TypeError）随时会
 * 因为两次编译之间作者多敲了一个字而误报，而"用 A 次的产物配 B 次的 map"错位跳行是
 * 静默的数据级缺陷。所以本层把**诊断那一份**原样留下，预览只读。
 *
 * ## 口径
 *
 * - 键走契约的 `pathKey`（Windows 分隔符 / 大小写：model URI 与 io 路径不保证同一写法）；
 * - **有界**：只留最近 `limit` 份（缺省 {@link KOJO2_COMPILE_CACHE_LIMIT}）——作者来回切
 *   标签也不必每切一次就重编译一次，但绝不无界增长；
 * - 撤下（换标签 / 关文件 / 编译失败 / 卸载）由诊断接线调用 `forget`：**后台标签不保留
 *   2.0 结论**，与 markers / 问题面板同一条"只认活动 model"的真相。
 */
export interface Kojo2CompileCache {
  /** 该路径**上一次**诊断编译的成品（没有 / 已撤下 ⇒ `null`） */
  getLastCompile(filePath: string): Kojo2PreviewCompilation | null;
  /** 记下这一份（同一路径覆盖；超上限从最久未记的那份开始丢） */
  remember(filePath: string, compilation: Kojo2PreviewCompilation): void;
  /** 撤下这一份（不存在 = no-op） */
  forget(filePath: string): void;
  /** 全部撤下（卸载 / 换项目） */
  clear(): void;
  /** 当前留了几份（观测面：有界性的读数） */
  readonly size: number;
}

/** 缓存上限：远大于"同时开着的标签"，又小到不会留住一整天的产物 */
export const KOJO2_COMPILE_CACHE_LIMIT = 8;

/** 造一份缓存（纯内存、零 IO；宿主在装配那一刻建一份，诊断与预览共用同一个实例） */
export function createKojo2CompileCache(
  options: { readonly limit?: number } = {},
): Kojo2CompileCache {
  const limit = Math.max(1, Math.trunc(options.limit ?? KOJO2_COMPILE_CACHE_LIMIT));
  const entries = new Map<string, Kojo2PreviewCompilation>();
  return {
    getLastCompile(filePath) {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      return entries.get(pathKey(filePath)) ?? null;
    },
    remember(filePath, compilation) {
      if (typeof filePath !== 'string' || filePath.length === 0) return;
      const key = pathKey(filePath);
      // 重插到队尾：Map 的插入序就是这里的 LRU，最近编译的那份最不容易被丢
      entries.delete(key);
      entries.set(key, compilation);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    forget(filePath) {
      if (typeof filePath !== 'string' || filePath.length === 0) return;
      entries.delete(pathKey(filePath));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * 把一次诊断的成品转成预览要的形状；转不出来（没有产物 / 入口不提供）⇒ `null`。
 *
 * source map 模型的构造（O(n) 切行，索引懒建）放在这里而不是预览的渲染链里：
 * 诊断跑完的那一拍是**作者停手之后**，渲染链里只该有模型查询。
 */
export function compilationOfDiagnostics(
  result: Pick<Kojo2DiagnosticsResult, 'diagnostics' | 'artifacts'>,
): Kojo2PreviewCompilation | null {
  const artifacts: Kojo2DiagnosticsArtifacts | null = result.artifacts ?? null;
  if (artifacts === null) return null;
  try {
    return {
      compiled: { erb: artifacts.erb, diagnostics: result.diagnostics },
      sourceMapModel: buildKojo2SourceMapModel(artifacts),
    };
  } catch {
    return null; // 产物/映射本身不自洽 ⇒ 预览不亮（诊断照常，问题面板是真相）
  }
}

/* ============================== markers → 问题面板 ============================== */

function problemSeverityOf(
  severitySource: Kojo2MarkerSeveritySource,
  severity: Monaco.MarkerSeverity,
): EditorProblem['severity'] {
  const table = severitySource.MarkerSeverity;
  if (severity === table.Warning) return 'warning';
  // Hint / Info 在 core 诊断里不存在（只有 error / warning 两档）；意外值按 info 记，
  // 不降级成 error（那会凭空造红线）。
  if (severity === table.Info || severity === table.Hint) return 'info';
  return 'error';
}

/**
 * 一次诊断的 markers → 问题面板条目（**整档替换**语义，与 `problem-store` 一致）。
 *
 * 列区间只在**同一行**时带上（`EditorProblem.line` 是单行；跨行 marker 的行号取起点，
 * 列区间若跨行就落回行级信息——面板的跳转判据 `reveal-position` 自己会退化）。
 */
export function kojo2ProblemsOf(
  filePath: string,
  markers: readonly Monaco.editor.IMarkerData[],
  severitySource: Kojo2MarkerSeveritySource,
): EditorProblem[] {
  return markers.map((marker) => ({
    path: filePath,
    line: marker.startLineNumber,
    ...(marker.endLineNumber === marker.startLineNumber && marker.endColumn > marker.startColumn
      ? { span: { columnStart: marker.startColumn, columnEnd: marker.endColumn } }
      : {}),
    severity: problemSeverityOf(severitySource, marker.severity),
    message: marker.message,
    ...(marker.code !== undefined ? { code: String(marker.code) } : {}),
    source: KOJO2_DIAGNOSTICS_SOURCE,
  }));
}

/** 诊断链路失败时上账的那一条（可见、可点、码稳定；不是"这份文件干净"） */
export function kojo2FailureProblem(filePath: string, message: string): EditorProblem {
  return {
    path: filePath,
    line: 1,
    severity: 'error',
    message: `Kojo 2.0 诊断链路失败：${message}（本文件旧波浪线已清空，修好前不会自动恢复）`,
    code: KOJO2_DIAGNOSTICS_FAILURE_CODE,
    source: KOJO2_DIAGNOSTICS_SOURCE,
  };
}

/* ============================== 编辑器事件 → 问题同步 ============================== */

/** 安装器的注入面（生产走缺省；测试注入假 editor / 假 diagnose / 手动时钟） */
export interface Kojo2ProblemWiringOptions {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly kernel: Kernel;
  /** 兜底路径（model URI 缺席时用；`onDidChangeModel` 那一拍它可能还是上一个标签的值） */
  readonly filePathRef: { current: string };
  /** 糖投影 model 是派生物（没有可诊断的语义）⇒ 跳过；非糖视图可省略 */
  readonly sugarModelRef?: { current: Monaco.editor.ITextModel | null };
  readonly markerHost: Kojo2MarkerHost;
  readonly severitySource: Kojo2MarkerSeveritySource;
  /** 宿主通知中心（失败可见）；缺省 = 只写问题面板 + console.error */
  readonly notify?: (notice: NoticeInput) => void;
  /** 替换诊断入口（测试 / 将来 worker）；缺省 = {@link createEratwKojo2Diagnose} */
  readonly diagnose?: Kojo2DiagnoseFn;
  readonly debounceMs?: number;
  readonly scheduler?: Kojo2DebounceScheduler;
  /** 问题面板写入端（缺省 = `problem-store.setProblems`） */
  readonly writeProblems?: (filePath: string, items: readonly EditorProblem[]) => void;
  /** 问题面板清理端（缺省 = `problem-store.clearProblems`） */
  readonly eraseProblems?: (filePath: string) => void;
  /**
   * **一次编译两处消费**的成品缓存（K2-EDITOR-MOUNT ①）：诊断跑完把这一份留下，
   * 预览面板按路径只读，源码全仓没有第二次 core 编译。省略 = 不缓存（只有诊断）。
   */
  readonly compileCache?: Kojo2CompileCache;
  /**
   * 缓存变化通知：`filePath` = 这一份已可预览；`null` = 这一份被撤下（换标签 / 关文件 /
   * 编译失败 / 卸载）。宿主据此让预览入口 `refresh` / `setFile(null)`——**只有这一条
   * 通知能保证预览与波浪线同源**（两者都是这次编译的产物）。
   */
  readonly onCompile?: (filePath: string | null) => void;
}

const GLOBAL_SCHEDULER: Kojo2DebounceScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * 从 model 上取真实路径（model 池用 `Uri.file(path)` 建 model；桩 model 允许没有 uri）。
 *
 * 导出给预览接线用（K2-EDITOR-MOUNT ①）：切标签那一拍要判"新标签是不是 `.kojo2`"，
 * 判据必须与诊断这条腿同一个（`filePathRef` 在 `onDidChangeModel` 的当拍可能还是旧值）。
 */
export function pathOfKojo2Model(model: Monaco.editor.ITextModel, fallback: string): string {
  const uri = (model as unknown as { uri?: { fsPath?: unknown } }).uri;
  if (uri && typeof uri === 'object' && typeof uri.fsPath === 'string' && uri.fsPath.length > 0) {
    return uri.fsPath;
  }
  return fallback;
}

/**
 * 装上 2.0 诊断接线，返回**幂等**的退场函数。
 *
 * flag 关 ⇒ 立即返回空操作（零监听、零定时器、零端口）。flag 是"装配那一刻"读的：
 * 与语言面 / 主题同一条口径（本批不提供运行时热切换，改开关后重载窗口才生效）。
 */
export function installKojo2ProblemWiring(options: Kojo2ProblemWiringOptions): () => void {
  if (!kojo2DiagnosticsEnabled()) return () => undefined;

  const { editor, kernel } = options;
  const writeProblems = options.writeProblems ?? setProblems;
  const eraseProblems = options.eraseProblems ?? clearProblems;
  const scheduler = options.scheduler ?? GLOBAL_SCHEDULER;
  const debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? KOJO2_PROBLEM_DEBOUNCE_MS));
  const diagnose =
    options.diagnose ??
    createEratwKojo2Diagnose({
      severitySource: options.severitySource,
      charNoForPath: charNoResolverForKernel(kernel),
    });

  const notify = (notice: NoticeInput): void => {
    if (options.notify) {
      options.notify(notice);
      return;
    }
    console.error(`[kojo2-diagnostics] ${notice.message}${notice.detail ? ` · ${notice.detail}` : ''}`);
  };

  /**
   * 把这一轮诊断的成品留下（预览唯一的读入口；K2-EDITOR-MOUNT ①）。
   *
   * 没有产物 / 产物不自洽 ⇒ **撤下**并通知 `null`：预览不能拿上一轮的 map 配这一轮的产物。
   */
  const rememberCompilation = (filePath: string, result: Kojo2DiagnosticsResult): void => {
    const cache = options.compileCache;
    if (cache === undefined) return;
    const compilation = compilationOfDiagnostics(result);
    if (compilation === null) {
      cache.forget(filePath);
      options.onCompile?.(null);
      return;
    }
    cache.remember(filePath, compilation);
    options.onCompile?.(filePath);
  };

  /** 撤下这一份（换标签 / 关文件 / 失败 / 卸载）：预览随之卸载，不留在屏上 */
  const forgetCompilation = (filePath: string): void => {
    if (filePath.length === 0) return;
    options.compileCache?.forget(filePath);
    options.onCompile?.(null);
  };

  const sync = createKojo2ProblemSync({
    markerHost: options.markerHost,
    diagnose,
    // 时间轴在本层（见文件头「为什么再加一层 debounce」）；第 2 层一收到就排下一拍。
    debounceMs: 0,
    ...(options.scheduler !== undefined ? { scheduler } : {}),
    onDiagnostics: ({ filePath, result }) => {
      writeProblems(filePath, kojo2ProblemsOf(filePath, result.markers, options.severitySource));
      rememberCompilation(filePath, result);
    },
    onCleared: ({ filePath }) => {
      // 换标签 / 关文件 / 显式清理：面板里那一份也跟着撤（后台标签不保留 2.0 结论——
      // 第 2 层的判据就是"只认活动 model"，面板与波浪线必须同一个真相）。
      // `filePath` 为空 = 清理时已无从反查（model 已 dispose），没有可撤的条目。
      if (filePath.length > 0) eraseProblems(filePath);
      // 编译成品同一条真相：波浪线撤了，预览必须一起撤（否则作者看的是上一份字节）。
      forgetCompilation(filePath);
    },
    onFailure: ({ filePath, message }) => {
      // 旧波浪线已由第 2 层清掉；这里补"失败本身"的可见面（面板 + toast），
      // 不然"屏上什么都没了"会被读成"这份文件是干净的"。
      writeProblems(filePath, [kojo2FailureProblem(filePath, message)]);
      notify({
        kind: 'error',
        message: 'Kojo 2.0 诊断失败：这份文件暂时没有实时诊断（旧波浪线已清空）。',
        detail: message,
      });
    },
  });

  /** 当前该诊断的目标：活动 model 且是 `.kojo2`（糖投影 = 派生物，跳过） */
  const resolveTarget = (): { model: Monaco.editor.ITextModel; filePath: string } | null => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return null;
    if (options.sugarModelRef?.current === model) return null;
    const filePath = pathOfKojo2Model(model, options.filePathRef.current);
    // 开关已在安装那一刻判过（本批不做运行时热切换）⇒ 热路径只判扩展名，不再摸 localStorage。
    if (filePath.length === 0 || !isKojo2DiagnosticsPath(filePath)) return null;
    return { model, filePath };
  };

  let timer: unknown = null;
  const cancel = (): void => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  /** 定时器响时才取一次文本（见文件头）；取完立刻交给第 2 层并催它跑（其 debounce = 0）。 */
  const run = (): void => {
    const target = resolveTarget();
    if (target === null) {
      sync.clear();
      return;
    }
    sync.setActive(target.model, target.filePath);
    if (!sync.schedule(target.model, target.filePath, target.model.getValue())) return;
    void sync.flush();
  };

  const request = (immediate: boolean): void => {
    cancel();
    if (immediate) {
      run();
      return;
    }
    timer = scheduler.setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  const contentSub = editor.onDidChangeModelContent(() => {
    // 非 2.0 文件不排定时器（`.erb` 的每次击键都排一个 200ms 的空转没有必要）；
    // 目标为空同时意味着"刚切走"——顺手把上一份的结论撤干净。
    if (resolveTarget() === null) {
      cancel();
      sync.clear();
      return;
    }
    request(false);
  });
  const modelSub = editor.onDidChangeModel(() => request(true));
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancel();
    contentSub.dispose();
    modelSub.dispose();
    sync.dispose();
  };
  // 装上就有一次：打开 2.0 文件（或挂载时正停在 2.0 文件上）首屏即诊断，不等人敲键。
  request(true);
  return dispose;
}
