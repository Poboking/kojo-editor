/**
 * Kojo 2.0 项目级扫描的**惰性 adapter 薄接线**（K2-PROJECT-WIRE）。
 *
 * ## 为什么单独成文件
 *
 * 生产 adapter 事实住在各自的插件包里（组合根按项目登记进 2.0 登记簿）。项目级分析
 * 只需要它的两个纯数据端口（事件目录 / LayerPolicy），但如果在宿主模块求值或
 * `mountProjectScan` 装配那一刻静态 `import` 任何一枚 adapter 包，整包就会被拽进开机
 * 静态图——PS-10 的体积闸正是钉这件事。本文件只做一件事：把"取 adapter"包成**惰性
 * getter**，让装载留在动态边上；分析器第一次真要判织面时才求值，且同一个 getter 只
 * 求值一次（结果由分析模块按 getter 实例缓存）。
 *
 * LAU-1a（2026-10-25）：装载目标**由宿主注入、按当前项目现取**——本文件不再无条件
 * 拿某一枚游戏的事实（旧默认装载器写死取那一枚常驻适配器，属 §5.1 漏点表第三行）。
 *
 * ## 三条纪律
 *
 * 1. **零动作**：创建装配面的那一刻不 import、不碰 adapter；`enabled()` 为 false 时扫描器
 *    连 getter 都不会调（判据在 `kojo2-project-analysis` 与 `project-diagnostics`）。
 * 2. **失败不炸**：动态装载失败（插件缺席 / 环境不支持）⇒ getter 交 `undefined`，分析器把
 *    它折成 `stats.adapterUnavailable` + 一条可见读数，其余跨文件结论照常跑。
 * 3. **宿主可注入**：`loadAdapter` 是测试与多游戏接线的缝——生产口径下宿主注
 *    "按当前项目取组合根 2.0 登记簿"的装载器（取不到 ⇒ `undefined`，**绝不回落某一枚**）；
 *    缺省装载器是"什么都不取"。测试不真装载插件包（否则测的是插件本身，不是这条接线）。
 *
 * ## 宿主接线（wiring 请求，不在本文件范围）
 *
 * 在 `ui/App.tsx` 的 `mountProjectScan({...})` 调用点按项目工厂注入（LAU-1a）：
 *
 * ```ts
 * import { createLazyKojo2ProjectOptions } from './kojo2-project-scan-adapter';
 * const handle = mountProjectScan({
 *   kernel,
 *   extraRoots: () => extraRootsRef.current,
 *   onNotice: (message) => notify({ kind: 'info', message }),
 *   // 每装配一个项目重造一份装配面：adapter 按当前项目现取，换项目换 getter 实例
 *   // ⇒ 分析侧的 getter 缓存自然重来（不会把上一个项目的事实带到下一个）。
 *   kojo2ProjectFactory: () =>
 *     createLazyKojo2ProjectOptions({
 *       loadAdapter: async () => kojo2AdapterForProject(kernel.project.current()) ?? undefined,
 *     }),
 * });
 * ```
 *
 * 该 import 是静态的，但它拉进来的只有本文件（装载器是宿主递的闭包，动态边不进静态图），
 * PS-10 判据不受影响。
 */
import { kojo2DiagnosticsEnabled } from './kojo2-diagnostics-gate';
import type { Kojo2ProjectAdapterFacts, Kojo2ProjectPassOptions } from './kojo2-project-analysis';

/** 装载器：交出 adapter 事实，或 `undefined` = 本轮拿不到（接线层唯一的失败形态） */
export type Kojo2ProjectAdapterLoader = () => Promise<Kojo2ProjectAdapterFacts | undefined>;

/**
 * 缺省装载：**什么都不取**（LAU-1a，2026-10-25）。
 *
 * 这里原先是无条件动态 `import()` 那一枚**常驻适配器**拿它的事实——打开任何盘
 * 2.0 项目扫描都吃它的事件目录（§5.1 漏点表第三行）。按 D12「未绑定 = 明确降级，
 * 绝不回落到某个默认方言」，缺省装载器交 `undefined`：分析器把它折成
 * `stats.adapterUnavailable` + 一条可见读数，其余跨文件结论照常跑。
 *
 * 生产口径：宿主（`ui/App.tsx` 的 `mountProjectScan` 装配点）**必须注入按当前项目现取
 * 的装载器**（组合根 `bootstrap.ts::kojo2AdapterForProject`，取不到 ⇒ `undefined`）；
 * 并且**每个项目换一份装配面**（分析侧的 getter 缓存按函数实例作键——换装配即重解析，
 * 见 `kojo2-project-analysis` 的 `adapterResolutions` 头注）。
 */
const loadNothing: Kojo2ProjectAdapterLoader = async () => undefined;

/** `createLazyKojo2ProjectOptions` 的注入面（全部可选；缺省即"未接线"的可见降级） */
export interface LazyKojo2ProjectOptionsConfig {
  /**
   * 启用判据（缺省 = 既有 2.0 诊断开关 `kojo2DiagnosticsEnabled`）。
   * 返回 false 时扫描器**零动作**：不读 `.kojo2`、不调 adapter getter。
   */
  readonly isEnabled?: () => boolean;
  /**
   * adapter 装载器（缺省 = {@link loadNothing}，"本轮拿不到"）。
   *
   * 生产与测试都必须显式注入：测试注假装载（避免真插件包进单测图），宿主注
   * "按当前项目取 2.0 登记簿"的装载。本模块不 import 任何组合根或插件包——
   * 它对游戏事实唯一知道的事是"该问谁"。
   */
  readonly loadAdapter?: Kojo2ProjectAdapterLoader;
}

/**
 * 造一份可交给 `mountProjectScan` 的 2.0 项目级装配面。
 *
 * 工厂本身**无副作用**：不 import adapter、不调 `isEnabled`；getter 第一次被分析器调用时
 * 才装载，装载结果（成功或 `undefined`）在本次装配内缓存（换装配 = 新建一份 = 重新尝试）。
 */
export function createLazyKojo2ProjectOptions(
  config: LazyKojo2ProjectOptionsConfig = {},
): Kojo2ProjectPassOptions {
  const isEnabled = config.isEnabled ?? kojo2DiagnosticsEnabled;
  const load = config.loadAdapter ?? loadNothing;
  let pending: Promise<Kojo2ProjectAdapterFacts | undefined> | null = null;

  const adapter = (): Promise<Kojo2ProjectAdapterFacts | undefined> => {
    if (pending === null) {
      pending = (async () => {
        try {
          return await load();
        } catch {
          // 接线层不抛：失败形态固定为 undefined，可见读数归分析器（一次 console.warn
          // 或宿主注入的 onAdapterUnavailable），这里再报一遍就是两条账。
          return undefined;
        }
      })();
    }
    return pending;
  };

  return {
    enabled: () => isEnabled() === true,
    adapter,
  };
}

/** `mountProjectScan` 调用点要摊进去的那一格 */
export interface Kojo2ProjectScanWiring {
  readonly kojo2Project: Kojo2ProjectPassOptions;
}

/**
 * 宿主接线入口：`mountProjectScan({ ..., ...installKojo2ProjectScan() })`。
 *
 * 名字叫 install 是就调用点语义（装一格装配面）；实现是纯工厂，可在测试里反复调。
 */
export function installKojo2ProjectScan(
  config: LazyKojo2ProjectOptionsConfig = {},
): Kojo2ProjectScanWiring {
  return { kojo2Project: createLazyKojo2ProjectOptions(config) };
}
