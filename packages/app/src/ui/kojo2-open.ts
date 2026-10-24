/**
 * `.kojo2` 的**打开 / 新建路由**（K2-EDITOR-WIRE，预演）。
 *
 * ## 为什么不另写一套开文件
 *
 * 宿主真正的开文件链路只有一条：model 池 → 标签组 → 编辑器。本模块的价值只在**判据**——
 * 这份 2.0 文件该走"当前项目内直接打开"，还是"先开它所在的项目、再把文件排进去"
 * （`openProject` 的 `pendingOpenFile` 腿，与欢迎页最近文件点击同一条），以及新建时该交给
 * 哪条既有新建通道。落盘、建 model、激活标签全在**注入的 port** 后面，这里零 IO、零 Monaco。
 *
 * 调用点接上之后，v1 文件仍然走原来的调用路径（本模块对非 `.kojo2` 返回 `not-kojo2`，
 * 零副作用）；开关关着时连判据都不进（返回 `off`，一个 port 都不碰），所以调用方不需要
 * 在每一处再写一次开关判断。
 *
 * ## 只认 `.kojo2`
 *
 * 判据与 `monaco/languages.ts` 的 descriptor 同一条：按**最后一段扩展名**、大小写不敏感。
 * `x.kojo2.bak` 不算（它会被语言层兜底成 plaintext，这里也不接管）。
 *
 * ## 新建的边界
 *
 * 新建只落在**当前项目内**（与文件树内联新建的真实可达范围一致）；没有项目 / 落点跑出
 * 项目根时给一句人话（{@link KOJO2_CREATE_NEEDS_PROJECT_REASON}），不静默返回。
 */
import { extname, isPathUnder, pathKey } from '@kojo/plugin-api';
// 扩展名取**零依赖叶子**（不取 `monaco/kojo2-language`）：本模块的消费方里有拖放/快速打开/
// 项目扫描这些只按后缀收文件的清单，判据只需要一枚字符串，不该为它拖上词表链（同 PS-10）。
import { KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang/constants';
import { isKojo2CutoverEnabled } from './kojo2-flag';

/**
 * 路由结果：
 * - `off` / `not-kojo2` = **不归本模块管**（开关关 / 不是 2.0 文件），调用方照原样继续；
 * - `open` / `open-project` / `create` = 已经（或应当）交给哪条既有通道；
 * - `blocked` = 条件不成立，`reason` 是人话，调用方经 `notify` 说出来。
 */
export type Kojo2OpenPlan =
  | { readonly kind: 'off' }
  | { readonly kind: 'not-kojo2' }
  | { readonly kind: 'open'; readonly path: string }
  | {
      readonly kind: 'open-project';
      readonly rootDir: string;
      readonly pendingOpenFile: string;
    }
  | { readonly kind: 'create'; readonly path: string }
  | { readonly kind: 'blocked'; readonly reason: string };

/** `open`（默认）= 打开盘上已有文件；`create` = 新建后打开 */
export type Kojo2OpenMode = 'open' | 'create';

export interface Kojo2OpenRequest {
  /** 目标文件绝对路径；新建时 = 已经定好的落点 */
  readonly path: string;
  /**
   * 文件所属项目根。当前项目内打开可省略（= {@link Kojo2OpenContext.currentRoot}）；
   * 欢迎页从最近文件进来时由调用方带上（与 `openRecentFile(path, rootDir)` 同参）。
   */
  readonly rootDir?: string | null;
  readonly mode?: Kojo2OpenMode;
}

export interface Kojo2OpenContext {
  /** 当前项目根；null = 欢迎页（没有项目在开） */
  readonly currentRoot: string | null;
  readonly projectOpen: boolean;
}

/**
 * 落地用的既有通道（全部由宿主注入；本模块不认识 App / 文件树的具体实现）：
 *
 * - `openFile`：文件树行点击 / 快速打开走的同一个入口；
 * - `openProject`：开项目并排一张待打开文件（`pendingOpenFile`）；
 * - `createFile`：既有新建通道（文件树内联新建 / 新建向导），落盘与写允许域闸门在它后面；
 * - `notify`：被拦下时说一句人话（铁律 4：不静默）。
 */
export interface Kojo2OpenPorts {
  readonly openFile: (path: string) => void;
  readonly openProject: (
    rootDir: string,
    opts: { readonly pendingOpenFile: string },
  ) => void;
  readonly createFile: (path: string) => void;
  readonly notify: (message: string) => void;
}

/** 没项目可投递（欢迎页直接点了一份 2.0 文件） */
export const KOJO2_NO_PROJECT_REASON =
  '这份 2.0 文件不属于任何已打开的项目，暂时打不开——先打开它所在的项目，再从文件树里点它。';

/** 新建只能在当前项目内落点 */
export const KOJO2_CREATE_NEEDS_PROJECT_REASON =
  '新建 2.0 文件只能落在当前项目里：先打开项目，再从项目里的文件夹新建。';

/** 是否是 2.0 文件（与语言层 descriptor 同一条判据：最后一段扩展名、大小写不敏感） */
export function isKojo2Path(filePath: string): boolean {
  return extname(filePath).toLowerCase() === KOJO2_SOURCE_EXTENSION;
}

/**
 * 开关打开时该补进**按后缀收文件**的那几张清单的条目；关着时是空数组。
 *
 * 拖放（`OPENABLE_EXT`）、快速打开（`QUICK_OPEN_SOURCE_EXTENSIONS`）、项目扫描这些地方
 * 只需要 `[...既有清单, ...kojo2SourceExtensions()]` 追加一次，flag 判断与扩展名都不必在
 * 每个调用点各写一份（开关仍只在一处读）。
 */
export function kojo2SourceExtensions(): readonly string[] {
  return isKojo2CutoverEnabled() ? [KOJO2_SOURCE_EXTENSION] : [];
}

/** 把可缺省的 root 归成"有根 / 无根"（空串是历史口径里的"没有项目"，别当成一个根） */
function rootOf(value: string | null | undefined, fallback: string | null): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

export interface Kojo2RouteOptions {
  /** 显式开关（测试与将来的调试面板用）；缺省现读 localStorage（`ui/kojo2-flag.ts`） */
  readonly enabled?: boolean;
}

/**
 * 只算不落地（纯函数，可单测）：
 *
 * 开关 → 路径判据 → 三条既有通道之一。`create` 额外要求"当前项目开着且落点在项目内"；
 * `open` 要求"有项目根可投递"，否则给 {@link KOJO2_NO_PROJECT_REASON}。
 */
export function planKojo2Open(
  request: Kojo2OpenRequest,
  ctx: Kojo2OpenContext,
  opts?: Kojo2RouteOptions,
): Kojo2OpenPlan {
  const enabled = opts?.enabled ?? isKojo2CutoverEnabled();
  if (!enabled) return { kind: 'off' };
  if (!isKojo2Path(request.path)) return { kind: 'not-kojo2' };

  const rootDir = rootOf(request.rootDir, ctx.currentRoot);

  if ((request.mode ?? 'open') === 'create') {
    if (!ctx.projectOpen || ctx.currentRoot === null || rootDir === null) {
      return { kind: 'blocked', reason: KOJO2_CREATE_NEEDS_PROJECT_REASON };
    }
    if (!isPathUnder(ctx.currentRoot, request.path)) {
      return { kind: 'blocked', reason: KOJO2_CREATE_NEEDS_PROJECT_REASON };
    }
    return { kind: 'create', path: request.path };
  }

  if (rootDir === null) return { kind: 'blocked', reason: KOJO2_NO_PROJECT_REASON };
  if (ctx.projectOpen && ctx.currentRoot !== null && pathKey(rootDir) === pathKey(ctx.currentRoot)) {
    return { kind: 'open', path: request.path };
  }
  return { kind: 'open-project', rootDir, pendingOpenFile: request.path };
}

/**
 * 落地：按 {@link planKojo2Open} 的结果调用注入的既有通道，并返回实际走了哪条
 * （调用方做回执 / 测试断言用）。`off` / `not-kojo2` 时**一个 port 都不调**。
 */
export function routeKojo2Open(
  request: Kojo2OpenRequest,
  ctx: Kojo2OpenContext,
  ports: Kojo2OpenPorts,
  opts?: Kojo2RouteOptions,
): Kojo2OpenPlan {
  const plan = planKojo2Open(request, ctx, opts);
  switch (plan.kind) {
    case 'open':
      ports.openFile(plan.path);
      break;
    case 'open-project':
      ports.openProject(plan.rootDir, { pendingOpenFile: plan.pendingOpenFile });
      break;
    case 'create':
      ports.createFile(plan.path);
      break;
    case 'blocked':
      ports.notify(plan.reason);
      break;
    case 'off':
    case 'not-kojo2':
      break;
  }
  return plan;
}
