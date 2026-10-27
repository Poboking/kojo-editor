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
 * - `onDidChangeModel`：换 model（切标签 / `setModel`）**立即**跑一次；目标按**路由**不归
 *   2.0 管（例如切回 `.erb`，或 `2.0-default` 下内容仍是 v1 的 `.kojo`）⇒ `sync.clear()`
 *   （撤旧波浪线 + 撤问题面板条目）。
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
 * ## 装配口径（入口 D 改）
 *
 * adapter / backend **不在本文件里挑**：两者都由组合根的两张登记簿按
 * `project.adapterId` 现取（`bootstrap.ts::kojo2SurfaceForProject`），本文件只接一个
 * `surfaceFor` 端口。此前写死 `ERATW_GAME_ADAPTER` + `createEratwEmitBackend`——
 * 打开 eraFL 工程时波浪线是拿 eraTW 的落点规则算出来的，不报错、只是错。
 * 取不到两面 ⇒ **抛错**（走 {@link KOJO2_DIAGNOSTICS_FAILURE_CODE} 那条可见面），
 * 不给空诊断（空诊断会被读成"这份文件干净"）。
 *
 * 剩余两处**已知缺口**写在 {@link createProjectKojo2Diagnose} 上：表达式端口暂用恒等
 * 透传（v1 `lowerExpression` 尚未接进 2.0 面）、角色号只能从
 * `GameProject.charaIndex[].kojoDir` 的前缀推（推不到时 backend 会如实报
 * `unit/backend-incomplete`，不静默造一个假函数名）。
 */
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
// 只吃**契约类型**（`GameAdapter` / `KojoEmitBackend`），不吃任何具体 adapter：
// 入口 D（2026-10-25）之前这里静态 import 了 eraTW 的 `ERATW_GAME_ADAPTER` +
// `createEratwEmitBackend`，于是打开 eraFL 工程时波浪线是拿 eraTW 的落点规则算的
// ——不报错、只是错。现在两面都从组合根（`bootstrap.ts` 的两张登记簿）按项目现取。
import type {
  DialectBindingResolution,
  EmitFailure,
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoExprText,
} from '@kojo/kojo-core';
import {
  KOJO2_DIAGNOSTICS_SOURCE,
  createKojo2Diagnostics,
  kojo2DiagnosticsToMarkers,
  type Kojo2DiagnosticsArtifacts,
  type Kojo2DiagnosticsInput,
  type Kojo2DiagnosticsResult,
  type Kojo2MarkerSeveritySource,
} from '../monaco/kojo2-diagnostics';
import { buildKojo2SourceMapModel } from '@kojo/kojo-lang';
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
import {
  isKojo2RouteablePath,
  kojo2DiagnosticsEnabled,
  kojo2RouteForPath,
} from './kojo2-diagnostics-gate';

/** 诊断失败在问题面板里的稳定诊断码（不是 core 诊断码；一眼看出这是工具链自己的事） */
export const KOJO2_DIAGNOSTICS_FAILURE_CODE = 'kojo2/diagnostics-unavailable';

/* ============================== adapter / backend 装配 ============================== */

/**
 * 一份 2.0 诊断需要的**两面**（与 `bootstrap.ts` 的 `Kojo2GameSurface` 同形）。
 *
 * 为什么不在这里直接 import 某个 adapter：那是入口 A 修掉的 bug 形态——诊断链写死
 * eraTW 时，打开 eraFL 工程算出来的波浪线拿的是 eraTW 的落点规则，**不报错、只是错**。
 * 具体游戏由组合根（`kojo2SurfaceForProject`）按 `project.adapterId` 现取，本文件只
 * 负责"拿到两面之后怎么跑一轮诊断"。
 */
export interface Kojo2DiagnoseSurface {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
}

/** 宿主注入的表达式端口签名（`compileTarget` 等可选项由 backend 自己收口） */
export interface Kojo2SurfaceDeps {
  readonly compileExpression: (expr: KojoExprText) => string | EmitFailure;
  /** 文件级角色号（推不到 ⇒ 不传；不用它的 backend 忽略） */
  readonly charNo?: string;
}

/**
 * 按项目取两面的端口 = `bootstrap.ts::kojo2SurfaceForProject` 的形状。
 *
 * 参数收结构最小投影（`{ adapterId?: string } | null`）：`GameProject | null` 天然可传，
 * 测试不必造整枚项目，也不必为了"换一枚 adapter"去改宿主。
 */
export type Kojo2SurfaceResolver = (
  project: { readonly adapterId?: string } | null,
  deps: Kojo2SurfaceDeps,
) => Kojo2DiagnoseSurface | null;

/**
 * **表达式端口**：恒等透传（导出给宿主装配用：组合根那张表只差这一个端口）。
 *
 * core 交给 backend 的是表达式源切片（已由 core 做完语法/符号校验）；backend 只负责把它
 * 落成 ERB 表达式。v1 的 `lowerExpression` 尚未接进 2.0 面（切流批的事），所以本批用
 * 恒等透传：**诊断仍然成立**（语法/结构/事件目录/存储期等判据都在 core 与 backend 的
 * 其它腿上），缺的只是"表达式内容在产物里的最终形状"——那不影响波浪线的位置与条数。
 */
export function kojo2IdentityCompileExpression(expr: { readonly text: string }): string {
  return expr.text;
}

/** 同步诊断入口（`createKojo2Diagnostics` 本身是同步纯计算；异步化留给将来的 worker） */
export type Kojo2SyncDiagnoseFn = (input: Kojo2DiagnosticsInput) => Kojo2DiagnosticsResult;

/**
 * 方言诊断端口（LAU-D1b）：解析一次，把 `core/dialect/*` 那几条并进同一轮诊断。
 *
 * 语义全在 `@kojo/kojo-core` 的 `resolveDialectBinding`；本文件只做**并集**：
 * 方言诊断先上（无 span 的落在文件头），编译诊断照旧在后，markers 由同一份 source 重算。
 * 不给这个端口 ⇒ 这一批诊断与旧行为逐字相同（既有调用方零改动）。
 */
export interface Kojo2DialectDeps {
  readonly resolve: (input: {
    readonly project: GameProject | null;
    readonly filePath: string;
    readonly source: string;
  }) => DialectBindingResolution;
}

/**
 * 把方言诊断并进一次已完成的 2.0 诊断（纯函数；导出给 node 池直测）。
 *
 * 计数三格（`errorCount` / `warningCount` / `ok`）全部按并集重算——**不许**保留编译那次
 * 的读数：`core/dialect/mismatch` 是 error，留在旧读数里会让问题面板表头与状态栏对不上。
 * `artifacts` 原样保留（产物与 source map 仍只属于那一次编译）。
 */
export function withDialectDiagnostics(
  result: Kojo2DiagnosticsResult,
  dialectDiagnostics: readonly KojoDiagnostic[],
  severitySource: Kojo2MarkerSeveritySource,
  source: string,
): Kojo2DiagnosticsResult {
  if (dialectDiagnostics.length === 0) return result;
  const diagnostics = [...dialectDiagnostics, ...result.diagnostics];
  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;
  return {
    ...result,
    diagnostics,
    markers: kojo2DiagnosticsToMarkers(severitySource, diagnostics, source),
    errorCount,
    warningCount,
    ok: result.error === null && errorCount === 0,
  };
}

/** `createProjectKojo2Diagnose` 的依赖（组合根给的两面解析 + Monaco severity 表） */
export interface Kojo2ProjectDiagnoseOptions {
  /** Monaco 的 severity 表（宿主传真实例；测试传同形状替身） */
  readonly severitySource: Kojo2MarkerSeveritySource;
  /** **当前项目**（每次诊断现取：项目可开可关，不缓存上一个项目的事实） */
  readonly project: () => GameProject | null;
  /** 组合根的两面解析（生产传 `kojo2SurfaceForProject` 函数本身） */
  readonly surfaceFor: Kojo2SurfaceResolver;
  /** 方言诊断端口（LAU-D1b，可选；省略 ⇒ 不并方言诊断） */
  readonly dialect?: Kojo2DialectDeps;
}

/**
 * 造**按项目选 adapter + backend** 的诊断入口（入口 D 的接线面）。
 *
 * ## 为什么取不到两面就抛错，而不是给一份空诊断
 *
 * `kojo2-problem-sync` 的 `onFailure` 专治这种情况：清旧波浪线 → 问题面板写
 * `kojo2/diagnostics-unavailable` → 通知中心发 toast。返回"空诊断"会被读成
 * **这份文件是干净的**——那正是本仓红线 4 禁止的静默降级。抛错则三种可见面齐亮，
 * 作者看到的是"这个工程还没有 2.0 诊断面"，而不是一片虚假的绿。
 *
 * ## 为什么不做 backend 缓存
 *
 * backend 构造是纯数据整形（`eraflLoweringProfile()` / `resolveEratwProfile()` 都是几枚
 * 冻结对象），与同一轮里每拍新建 `createKojo2Diagnostics(...).diagnose` 同阶；而缓存要
 * 按 `(gameId, charNo)` 建键，**项目中途换游戏时旧 backend 就是错误事实**。这段路
 * 每 200ms 才走一次，省不下什么，却要背一条失效判据——不设缓存。
 */
export function createProjectKojo2Diagnose(options: Kojo2ProjectDiagnoseOptions): Kojo2SyncDiagnoseFn {
  return (input) => {
    let project: GameProject | null = null;
    try {
      project = options.project();
    } catch {
      // 取不到项目 = 没有两面（下面统一抛）；不在诊断链里猜。
      project = null;
    }
    const charNo = charNoForProjectPath(project, input.filePath);
    const surface = options.surfaceFor(project, {
      compileExpression: kojo2IdentityCompileExpression,
      ...(charNo !== undefined && charNo.length > 0 ? { charNo } : {}),
    });
    if (surface === null) {
      throw new Error(
        `当前项目没有 2.0 诊断面（adapterId = ${project?.adapterId ?? '（无项目）'}）：` +
          '该游戏未登记 2.0 adapter 或 backend，本文件不做 2.0 诊断（不回退到其它游戏的事实）。',
      );
    }
    const result = createKojo2Diagnostics({
      monaco: options.severitySource,
      adapter: surface.adapter,
      backend: surface.backend,
    }).diagnose(input);
    // LAU-D1b：方言诊断与编译诊断走**同一轮**、同一份 markers / 问题面板条目。
    // 方言侧不另开通道（铁律 4 的"冲突必须 error"就落在既有问题面板上）。
    if (options.dialect === undefined) return result;
    const resolution = options.dialect.resolve({
      project,
      filePath: input.filePath,
      source: input.source,
    });
    return withDialectDiagnostics(result, resolution.diagnostics, options.severitySource, input.source);
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
  // 契约上 `charaIndex` 是必填，但 `kernel.project.current()` 交给这里的是**运行期对象**：
  // 工程正在装载时它可能还是半成品。少了索引就让"这条链路抛 TypeError"顶掉真正的诊断
  // 结论（`onFailure` 会把 `Cannot read properties of undefined` 原样抖给作者），
  // 而正确语义是"推不出角色号"——由 backend 的 fail-closed 如实报缺。
  const index: GameProject['charaIndex'] | undefined = project.charaIndex;
  if (index === undefined || index === null || typeof index.values !== 'function') return undefined;
  let bestLength = -1;
  let found: string | undefined;
  for (const chara of index.values()) {
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
function projectOfKernel(kernel: Kernel): GameProject | null {
  try {
    return kernel.project.current();
  } catch {
    return null;
  }
}

/**
 * 宿主没注入两面解析时的诊断入口：**必抛**。
 *
 * 不返回空诊断——那会让问题面板显示"这份文件干净"。抛错走 `onFailure`，三种可见面
 * （清旧波浪线 / 面板条目 / toast）齐亮，缺了哪一环都是静默降级。
 */
function unregisteredSurfaceDiagnose(): never {
  throw new Error(
    '宿主没有注入 2.0 两面解析（`surfaceFor`）：本文件不做 2.0 诊断，也不回退到任何游戏的默认事实。',
  );
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
  /** 替换诊断入口（测试 / 将来 worker）；缺省 = 由 {@link surfaceFor} 现造 */
  readonly diagnose?: Kojo2DiagnoseFn;
  /**
   * 按当前项目取 2.0 两面（adapter + backend）。生产传组合根的
   * `kojo2SurfaceForProject` 函数本身；**不给** ⇒ 诊断入口一律抛错（fail-visible：
   * 面板写 `kojo2/diagnostics-unavailable` + toast），绝不回退到某个游戏的默认事实。
   */
  readonly surfaceFor?: Kojo2SurfaceResolver;
  /**
   * 方言诊断端口（LAU-D1b，可选）：给 `createProjectKojo2Diagnose` 用；与 `diagnose`
   * 互斥（自定义入口自带方言逻辑时不再叠）。省略 ⇒ 不并方言诊断（旧调用方零改动）。
   */
  readonly dialect?: Kojo2DialectDeps;
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
 * 诊断是**语言面**（K2-SURFACE-DEFAULT）：`.kojo2` 一打开就归 2.0 管，不看切流阶段。
 * 保留 {@link kojo2DiagnosticsEnabled} 这一拍只是让装配处只有一个门（调用方零改动），
 * 它现在恒 `true`；真正的归属逐文件判（`kojo2OwnsDiagnostics`）。
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
    (options.surfaceFor === undefined
      ? unregisteredSurfaceDiagnose
      : createProjectKojo2Diagnose({
          severitySource: options.severitySource,
          project: () => projectOfKernel(kernel),
          surfaceFor: options.surfaceFor,
          ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
        }));

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

  /**
   * 归 2.0 的文件这一拍**拿不到正文**时的可见提示（同一份只吵一次）。
   *
   * LAU-3b-FLIP 之后归属只认扩展名（`.kojo` / `.kojo2` 恒归 2.0），不再有"要正文才能
   * 定解析器"那一档；但诊断本身仍要正文——读不到就这一拍跳过，**不静默**：作者得知道
   * 波浪线为什么没亮，否则"屏上什么都没有"会被读成"这份文件是干净的"。
   */
  const warnedUnreadable = new Set<string>();
  const noteUnreadable = (filePath: string): void => {
    if (warnedUnreadable.has(filePath)) return;
    warnedUnreadable.add(filePath);
    notify({
      kind: 'info',
      message: 'Kojo 2.0：这份文件当前取不到正文，诊断这一拍先跳过（下次内容变化会重试）。',
      detail: filePath,
    });
  };

  /** 本轮诊断目标（`source` 只在归属判据必须读正文时带上，`run` 复用它不二次整篇复制） */
  interface WiringTarget {
    readonly model: Monaco.editor.ITextModel;
    readonly filePath: string;
    readonly source?: string;
  }

  /**
   * 当前该诊断的目标：活动 model 且**路由**判定归 2.0 管（糖投影 = 派生物，跳过）。
   *
   * 判据与语言面同一个入口（`kojo2-diagnostics-gate` 的 `kojo2RouteForPath`）：LAU-3b-FLIP
   * 之后扩展名即归属——`.kojo` / `.kojo2` ⇒ 接管，`.kojo1` / 非 kojo ⇒ 不接管。
   * `readSource=false` 只判路径（击键热路径）；`readSource=true` 才读正文，读不到就这一拍
   * **跳过**并露一句话（{@link noteUnreadable}），不猜、不静默。
   */
  const resolveTarget = (readSource: boolean): WiringTarget | null => {
    const model = editor.getModel();
    if (!model || model.isDisposed()) return null;
    if (options.sugarModelRef?.current === model) return null;
    const filePath = pathOfKojo2Model(model, options.filePathRef.current);
    // 便宜预筛：`.erb` / `.json` 之类每次击键都不该摸阶段与正文
    if (filePath.length === 0 || !isKojo2RouteablePath(filePath)) return null;

    const pathDecision = kojo2RouteForPath(filePath);
    if (pathDecision.kind !== 'resolved' || pathDecision.parser !== 'kojo2') return null;
    if (!readSource) return { model, filePath };
    try {
      return { model, filePath, source: model.getValue() };
    } catch {
      noteUnreadable(filePath);
      return null;
    }
  };

  let timer: unknown = null;
  const cancel = (): void => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };

  /** 定时器响时才取一次文本（见文件头）；取完立刻交给第 2 层并催它跑（其 debounce = 0）。 */
  const run = (): void => {
    const target = resolveTarget(true);
    if (target === null) {
      sync.clear();
      return;
    }
    sync.setActive(target.model, target.filePath);
    const source = target.source ?? target.model.getValue();
    if (!sync.schedule(target.model, target.filePath, source)) return;
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
    // `needs-content` 也算"候选"：正文留到定时器响时只读一次，不在这里逐键扫全文。
    if (resolveTarget(false) === null) {
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
