/**
 * Kojo 2.0 **诊断/问题归属 + 路由入口**的纯判据（K2 batch-3 · K2-CUTOVER-ROUTE 收口）。
 *
 * ## 为什么单独成文件
 *
 * `EditorPane.tsx` 是冲突热点，它只需要"这一份文件的波浪线归不归 2.0 管"这一个布尔，
 * 不该为了这个布尔把整条诊断链路（core 编译 + eraTW backend）静态拖进自己的模块图。
 * 判据本身零副作用、零 Monaco、node 可单测。
 *
 * ## 判据 = 路由，不是扩展名（K2-CUTOVER-ROUTE）
 *
 * 切流控制器 `ui/kojo2-cutover.ts` 的 `route({ filePath, source })` 已经把
 * "override 当家 → 扩展名 → 阶段 → 内容指纹"这条口诀实现完了；这里只做两件事：
 * ① 把"path+source → route"的读取收敛到**这一处**（{@link kojo2RouteFor} /
 *    {@link kojo2RouteForText} / {@link kojo2RouteForPath}），消费方不再各拼一次
 *    `controller.route(...)` 或 `decideKojo2Route(...)`；
 * ② 从路由结论里取"归不归 2.0"（{@link kojo2OwnsRoute} = `kind === 'resolved' &&
 *    parser === 'kojo2'`）。
 *
 * 这样 `2.0-default` 阶段下"内容已经是 2.0 写法"的 `.kojo` 也归 2.0 管——语言面与诊断面
 * 从此同一条判据，不会一个重挂、一个不认。
 *
 * ## 三处消费同一个答案
 *
 * - `EditorPane.refreshMarkers`：`true` ⇒ **让路**（v1 装饰轮不发布，否则它整档写空会把
 *   2.0 刚上账的问题抹掉）；
 * - `use-monaco-instance.ts`：`true` ⇒ 装诊断接线；
 * - `kojo2-problem-wiring.ts`：活动 model 判定改用 {@link kojo2RouteForPath} /
 *   {@link kojo2RouteForText}（带正文判据与 EditorPane 同源）。
 *
 * ## 只有路径时怎么办（EditorPane 那一腿）
 *
 * `2.0-default` 的 `.kojo` 只有正文能定归属。带正文的路由（诊断接线 / 语言面 / 打开链路）
 * 会把结论记进一张**有界备忘**（按 `pathKey` + 阶段 + override 失效），于是只有路径的
 * `kojo2OwnsDiagnostics(path)` 也能读到同一份结论；没有结论时**不接管**（`needs-content`
 * 不是"2.0 的"，失败方向 = 不抢 v1 的活）。
 *
 * ## flag 关 / 阶段 v1-only
 *
 * 恒 `false`：v1 行为逐字不变（不装监听、不让路、一个端口都不碰、一次存储之外的东西都不读）。
 */
import {
  KOJO_V1_FILE_EXTENSION,
  KOJO2_FILE_EXTENSION,
  decideKojo2Route,
  extensionOf,
  getKojo2CutoverController,
  normalizePathKey,
  type Kojo2CutoverStage,
  type Kojo2Parser,
  type Kojo2RouteDecision,
} from './kojo2-cutover';
import { isKojo2CutoverEnabled, resolveKojo2CutoverStage } from './kojo2-flag';
import { isKojo2Path } from './kojo2-open';

/** flag 开没开（与语言面 / 主题同一口径：阶段 `v1-only` = 关） */
export function kojo2DiagnosticsEnabled(): boolean {
  return isKojo2CutoverEnabled();
}

/**
 * 纯扩展名判据（**不读开关**）：只回答"这是不是 `.kojo2`"。
 *
 * 给热路径用（诊断接线在每次击键上判目标）：开关在装配那一刻已经读过一次，没必要每个
 * 事件再摸一次 localStorage。判据与 `languages.ts` 的 descriptor 同一条（最后一段扩展名、
 * 大小写不敏感）。
 */
export function isKojo2DiagnosticsPath(filePath: string): boolean {
  return isKojo2Path(filePath);
}

/**
 * 便宜预筛：这份路径**可能**归 2.0 管吗（扩展名 + 显式破例；不读阶段 / 开关 / 正文）。
 *
 * 热路径（每次击键）先用它挡掉 `.erb` / `.json` 之类：路由要读生效阶段（摸一次
 * `localStorage.getItem`），不该为"根本不可能归 2.0"的文件每键摸一次。
 * 带 override 的文件一律放行（override 当家，`.erb` 也可能被钉成 2.0）——
 * 放行只多问一次路由，不会多判一个结论。它**不是**判据，真正归不归由
 * {@link kojo2RouteForPath} 定。
 */
export function isKojo2RouteablePath(filePath: string): boolean {
  const extension = extensionOf(filePath);
  if (extension === KOJO2_FILE_EXTENSION || extension === KOJO_V1_FILE_EXTENSION) return true;
  return getKojo2CutoverController().getOverride(filePath) !== null;
}

/** 路由结论里"问题是否由 2.0 诊断链路独占"（唯一判据，别在调用方再写一遍 `parser ===`） */
export function kojo2OwnsRoute(route: Kojo2RouteDecision): boolean {
  return route.kind === 'resolved' && route.parser === 'kojo2';
}

/* ============================== path+source → route 单入口 ============================== */

/** 本模块眼里的一份 model（路径 + 正文）——故意不引 `Monaco.editor.ITextModel` */
export interface Kojo2RouteModelLike {
  /** Monaco 的 model URI（`Uri.file(path)` 建的）；桩 model 允许没有 */
  readonly uri?: { readonly fsPath?: unknown };
  getValue(): string;
}

export interface Kojo2RouteForOptions {
  /**
   * 宿主已知的路径（`onDidChangeModel` 那一拍 `filePathRef` 可能还是旧标签的值，
   * 所以 model URI 优先；URI 缺席时才回落到它）。
   */
  readonly filePath?: string;
  /** 一次性破例（缺省 = 用控制器里存好的那份） */
  readonly override?: Kojo2Parser | null;
  /** 指定阶段（缺省 = `resolveKojo2CutoverStage()` 的生效阶段） */
  readonly stage?: Kojo2CutoverStage;
}

/** 从 model 取路径（URI 优先；没有 URI / 空串时回落 `fallback`，都没有 = 空串） */
export function pathOfKojo2RouteModel(
  model: Kojo2RouteModelLike,
  fallback?: string,
): string {
  const uri = model.uri;
  const fsPath = uri === undefined ? undefined : uri.fsPath;
  if (typeof fsPath === 'string' && fsPath.length > 0) return fsPath;
  return typeof fallback === 'string' ? fallback : '';
}

/**
 * 只按**路径 + 阶段 + override** 路由（不读正文；不碰备忘）。
 *
 * `2.0-default` 的 `.kojo` 返回 `needs-content`（正文才能定解析器）——调用方必须把它当
 * "还没定"而不是"2.0 的"：{@link kojo2OwnsRoute} 对它是 `false`。
 */
export function kojo2RouteForPath(filePath: string): Kojo2RouteDecision {
  const controller = getKojo2CutoverController();
  return decideKojo2Route({
    stage: resolveKojo2CutoverStage(),
    filePath,
    override: controller.getOverride(filePath),
  });
}

/** 阶段脏值 / 缺省一律回生效阶段（失败方向与 `stageFromLegacyKojo2Flag` 同一条：少露） */
function stageOrDefault(stage: Kojo2CutoverStage | undefined): Kojo2CutoverStage {
  return stage ?? resolveKojo2CutoverStage();
}

/**
 * **path + source → route** 的唯一入口（K2-CUTOVER-ROUTE）。
 *
 * - `source === undefined` ⇒ 相当于 {@link kojo2RouteForPath}（`2.0-default` 的 `.kojo`
 *   仍可能给 `needs-content`）；
 * - 带正文算出的结论会记进"只有路径"的备忘（见模块头），让 `EditorPane.refreshMarkers`
 *   那一腿与诊断接线同源；
 * - 一次性 `override` 的结果不记备忘（那不是"这份文件的稳定事实"）。
 */
export function kojo2RouteForText(
  filePath: string,
  source: string | undefined,
  options: Kojo2RouteForOptions = {},
): Kojo2RouteDecision {
  const controller = getKojo2CutoverController();
  const stage = stageOrDefault(options.stage);
  const decision = controller.routeAt(stage, {
    filePath,
    ...(source === undefined ? {} : { source }),
    ...(options.override === undefined ? {} : { override: options.override }),
  });
  if (source !== undefined && options.override === undefined && decision.kind !== 'needs-content') {
    rememberRoute(decision, stage, controller.getOverride(filePath));
  }
  return decision;
}

/**
 * 一份 model 的路由（**小包装**：路径取 URI、正文取 `getValue()`，一次读全）。
 *
 * 正文取不到（model 已在销毁途中）⇒ 按"没有正文"路由（`2.0-default` 的 `.kojo` 落
 * `needs-content`，调用方据此**不接管**并露一句话，绝不猜成 2.0）。
 */
export function kojo2RouteFor(
  model: Kojo2RouteModelLike,
  options: Kojo2RouteForOptions = {},
): Kojo2RouteDecision {
  const filePath = pathOfKojo2RouteModel(model, options.filePath);
  let source: string | undefined;
  try {
    source = model.getValue();
  } catch {
    source = undefined;
  }
  return kojo2RouteForText(filePath, source, options);
}

/* ============================== 只有路径时的结论备忘 ============================== */

/**
 * 一份"带正文的路由结论"（只服务 {@link kojo2OwnsDiagnostics} 的路径形入参）。
 *
 * 上限很小：诊断只关心"同时开着的标签"这一量级，超出按最久未用丢——绝不无界增长。
 * 阶段 / override 一变，旧结论立即失效（比较两张事实，不靠显式清表）。
 */
interface Kojo2RouteMemoEntry {
  readonly stage: Kojo2CutoverStage;
  readonly override: Kojo2Parser | null;
  readonly decision: Kojo2RouteDecision;
}

const KOJO2_ROUTE_MEMO_LIMIT = 16;
const routeMemo = new Map<string, Kojo2RouteMemoEntry>();

/** 备忘键：与 override 的路径归一同一口径（分隔符 / 大小写差异下同一个文件必须命中） */
function routeMemoKey(filePath: string): string {
  return normalizePathKey(filePath).toLowerCase();
}

function rememberRoute(
  decision: Kojo2RouteDecision,
  stage: Kojo2CutoverStage,
  override: Kojo2Parser | null,
): void {
  if (decision.filePath.length === 0) return;
  const key = routeMemoKey(decision.filePath);
  routeMemo.delete(key); // 重插到队尾：Map 插入序就是这里的 LRU
  routeMemo.set(key, { stage, override, decision });
  while (routeMemo.size > KOJO2_ROUTE_MEMO_LIMIT) {
    const oldest = routeMemo.keys().next();
    if (oldest.done) break;
    routeMemo.delete(oldest.value);
  }
}

/** 读备忘；阶段 / override 对不上 ⇒ 当作没有（旧阶段 / 旧破例的结论不许续命） */
function recallRoute(filePath: string): Kojo2RouteDecision | null {
  const entry = routeMemo.get(routeMemoKey(filePath));
  if (entry === undefined) return null;
  if (entry.stage !== resolveKojo2CutoverStage()) return null;
  if (entry.override !== getKojo2CutoverController().getOverride(filePath)) return null;
  return entry.decision;
}

/**
 * 丢掉"只有路径"的备忘（**只给测试 / 宿主重启**）。
 *
 * 正常失效不靠它：每条备忘都带阶段与 override，比较不过就不采信。
 */
export function clearKojo2RouteMemo(): void {
  routeMemo.clear();
}

/* ============================== 归属判据 ============================== */

/** `kojo2OwnsDiagnostics` 的对象形入参（`source` 缺省 = 只有路径） */
export interface Kojo2DiagnosticsOwnershipInput {
  /** 目标文件路径（与 `EditorPane` / model URI 同一写法均可） */
  readonly path: string;
  /**
   * 文件正文（调用方手上有就传：`2.0-default` 的 `.kojo` **只有正文能定归属**）。
   * 缺省 = 用最近一次带正文路由的备忘；备忘也没有 ⇒ 不接管（`needs-content`）。
   */
  readonly source?: string;
}

/**
 * 这一份文件的问题是否由 2.0 诊断链路**独占**。
 *
 * 兼容两种入参（旧调用点 `EditorPane.refreshMarkers` 只传路径，逐字不用改）：
 * - `kojo2OwnsDiagnostics(path)` —— 路径形：先读带正文的备忘，没有就按路径路由；
 * - `kojo2OwnsDiagnostics({ path, source })` —— 对象形：按正文路由（结论进备忘）。
 *
 * 判据 = flag 开 **且** 路由结论的 parser 是 `kojo2`。flag 关 / `v1-only` / 非 kojo 文件 /
 * `needs-content` / `ambiguous` ⇒ `false`，调用方照原样继续（v1 诊断不让路）。
 */
export function kojo2OwnsDiagnostics(filePath: string): boolean;
export function kojo2OwnsDiagnostics(input: Kojo2DiagnosticsOwnershipInput): boolean;
export function kojo2OwnsDiagnostics(input: string | Kojo2DiagnosticsOwnershipInput): boolean {
  if (!kojo2DiagnosticsEnabled()) return false;
  const path = typeof input === 'string' ? input : input.path;
  if (typeof path !== 'string' || path.length === 0) return false;
  // 便宜预筛：`.erb` / `.json` 之类连阶段都不必读（判据恒 false，与路由结论一致）
  if (!isKojo2RouteablePath(path)) return false;
  const source = typeof input === 'string' ? undefined : input.source;
  const route =
    source === undefined
      ? (recallRoute(path) ?? kojo2RouteForPath(path))
      : kojo2RouteForText(path, source);
  return kojo2OwnsRoute(route);
}
