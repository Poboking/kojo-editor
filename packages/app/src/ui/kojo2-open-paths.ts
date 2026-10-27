/**
 * `.kojo2` 的**打开入口闸**与**宿主能力投影**（K2-EDITOR-OPEN-PATHS）。
 *
 * ## 为什么不重写一遍打开路由
 *
 * 真正的路由判据（当前项目内直接开 / 先开项目再排队 / 新建 / 被拒的人话）已经住在
 * `ui/kojo2-open.ts`（batch-3）。本模块只补两件它按下不表的：
 *
 * 1. **阶段闸**：`kojo2-cutover` 的三态阶段里，`v1-only` **不再拦 `.kojo2`**（K2-SURFACE-DEFAULT：
 *    扩展名即声明、语言面无条件注册），只剩"把老 `.kojo` 显式钉成 2.0"的 override 在
 *    `v1-only` 下被拦（切流语义）。判定与人话都只有 `kojo2-cutover` 一份，这里**取**、不另写；
 *    被拦下时走 `notify` 说一句人话——绝不开一张空编辑器（铁律 4：不静默）。
 * 2. **`UiPrefs.kojo2` 投影**：新建向导是**插件**（只许依赖 `@kojo/plugin-api`），
 *    它要产出"扩展名与模板语言一致"的文件，就需要宿主告诉它 2.0 面开没开、扩展名是哪个。
 *    2.0 扩展名的字面量住在宿主（`monaco/kojo2-constants.ts` 全仓唯一处），插件侧因此
 *    **零** `.kojo2` 字面量。开关关着时这一格**不提供**（`undefined`）⇒ 插件界面逐字不变。
 *
 * ## 开关关着 = 零变化
 *
 * 两道判据都以 `isKojo2CutoverEnabled()` 打头（开关只在一处读：`ui/kojo2-flag.ts`）：
 * 关着时 {@link kojo2StageBlockedReason} 恒 `null`、{@link routeKojo2OpenPath} 直接落到
 * `routeKojo2Open` 的 `off`（一个 port 都不碰）⇒ 调用方照旧走改动前那一条路。
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getKojo2CutoverController, type Kojo2CutoverStage } from './kojo2-cutover';
import { isKojo2CutoverEnabled, subscribeKojo2Cutover } from './kojo2-flag';
import { routeKojo2Open, type Kojo2OpenContext, type Kojo2OpenPlan } from './kojo2-open';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';

/**
 * 宿主下传给贡献方的 2.0 面投影（形状即契约 `UiPrefs.kojo2`；契约里那枚接口未从桶导出，
 * 这里按结构声明一份，赋值方向由 TS 的结构检查兜住）。
 */
export interface Kojo2Surface {
  /** 2.0 源扩展名（含点、小写） */
  readonly extension: string;
}

/** 打开入口要的那几条既有通道（`create` 不在打开语义里 ⇒ 端口形状不带它） */
export interface Kojo2OpenPathPorts {
  /** 文件树行点击 / 快速打开 / 拖放共用的打开入口 */
  readonly openFile: (path: string) => void;
  /** 开项目并排一张待打开文件（欢迎页最近文件切项目那条腿） */
  readonly openProject: (rootDir: string, opts: { readonly pendingOpenFile: string }) => void;
  /** 被拦下时说一句人话 */
  readonly notify: (message: string) => void;
}

export interface Kojo2OpenPathRequest {
  readonly path: string;
  /** 文件所属项目根（欢迎页最近文件带上；当前项目内打开可省 = 当前根） */
  readonly rootDir?: string | null;
}

export interface Kojo2OpenPathOptions {
  /** 显式开关（测试与调试面板用）；缺省现读 localStorage */
  readonly enabled?: boolean;
  /** 显式阶段（测试用）；缺省现读进程级 cutover 控制器 */
  readonly stage?: Kojo2CutoverStage;
}

/**
 * 阶段闸：该文件**打不开**时返回人话，否则 `null`。
 *
 * K2-SURFACE-DEFAULT 之后 `.kojo2` **在任何阶段都打得开**（扩展名即声明，语言面无条件注册），
 * 所以这里不再有"`v1-only` 拦 `.kojo2`"这一格。现在还剩下的唯一 hard block 是**切流语义**：
 * 作者把某个老 `.kojo` 显式钉成 2.0（override），而阶段还在 `v1-only`——那条判定仍住在
 * `decideKojo2Route`，这里经 `controller.routeAt()` 取（存好的 override 由控制器统一持有，
 * 不另拼一份），人话直接用它的 `hint`。
 */
export function kojo2StageBlockedReason(
  filePath: string,
  opts?: Kojo2OpenPathOptions,
): string | null {
  const enabled = opts?.enabled ?? isKojo2CutoverEnabled();
  if (!enabled) return null;
  const controller = getKojo2CutoverController();
  const stage = opts?.stage ?? controller.getStage();
  const decision = controller.routeAt(stage, { filePath });
  return decision.kind === 'blocked' ? decision.hint : null;
}

/**
 * 打开一份文件（**所有入口共用的那一拍**）：先过阶段闸，再过 batch-3 的既有路由。
 *
 * 返回的 plan 与 `routeKojo2Open` 同形（调用方按 `off` / `not-kojo2` 决定是否回落到
 * 改动前那条路；`blocked` 时人话已经经 `notify` 上屏，一个打开通道都没碰）。
 */
export function routeKojo2OpenPath(
  request: Kojo2OpenPathRequest,
  ctx: Kojo2OpenContext,
  ports: Kojo2OpenPathPorts,
  opts?: Kojo2OpenPathOptions,
): Kojo2OpenPlan {
  const blocked = kojo2StageBlockedReason(request.path, opts);
  if (blocked !== null) {
    ports.notify(blocked);
    return { kind: 'blocked', reason: blocked };
  }
  return routeKojo2Open(
    { path: request.path, rootDir: request.rootDir },
    ctx,
    {
      openFile: ports.openFile,
      openProject: ports.openProject,
      // 本入口只有"打开"语义（`mode` 缺省 `open`）⇒ `create` 分支构造上不可达；
      // 端口形状仍要满足，给一个不静默的空动作。
      createFile: () => undefined,
      notify: ports.notify,
    },
    opts?.enabled === undefined ? undefined : { enabled: opts.enabled },
  );
}

/**
 * `UiPrefs.kojo2` 的宿主侧取值（ShellLayout 用；`useSyncExternalStore` 与
 * `panel-prefs` 的偏好投影同款，开关一翻壳层即刻重渲染）。
 *
 * LAU-3b-FLIP（2026-10-27）：新建 2.0 文件落的扩展名就是**主场 `.kojo`**（旧名 `.kojo2`
 * 只作存量兼容，不再新产）。开关关着 ⇒ `undefined`（**不提供**这一格）：贡献方一律按
 * "没有 2.0"编写，界面与改动前逐字相同。对象身份随开关稳定 —— 面板的 `memo` 靠这条不白重渲。
 */
export function useKojo2Surface(): Kojo2Surface | undefined {
  const enabled = useSyncExternalStore(subscribeKojo2Cutover, isKojo2CutoverEnabled, () => false);
  return useMemo(
    () => (enabled ? { extension: KOJO_SOURCE_EXTENSION } : undefined),
    [enabled],
  );
}
