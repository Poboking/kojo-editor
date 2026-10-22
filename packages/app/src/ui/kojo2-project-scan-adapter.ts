/**
 * Kojo 2.0 项目级扫描的**惰性 adapter 薄接线**（K2-PROJECT-WIRE）。
 *
 * ## 为什么单独成文件
 *
 * 生产 adapter（`ERATW_GAME_ADAPTER`）住在插件包里。项目级分析只需要它的两个纯数据端口
 * （事件目录 / LayerPolicy），但如果在宿主模块求值或 `mountProjectScan` 装配那一刻静态
 * `import`，整包就会被拽进开机静态图——PS-10 的体积闸正是钉这件事。本文件只做一件事：
 * 把"取 adapter"包成**惰性 getter**，让 `import()` 留在动态边上；分析器第一次真要判织面时
 * 才求值，且同一个 getter 只求值一次（结果由分析模块缓存）。
 *
 * ## 三条纪律
 *
 * 1. **零动作**：创建装配面的那一刻不 import、不碰 adapter；`enabled()` 为 false 时扫描器
 *    连 getter 都不会调（判据在 `kojo2-project-analysis` 与 `project-diagnostics`）。
 * 2. **失败不炸**：动态装载失败（插件缺席 / 环境不支持）⇒ getter 交 `undefined`，分析器把
 *    它折成 `stats.adapterUnavailable` + 一条可见读数，其余跨文件结论照常跑。
 * 3. **宿主可注入**：`loadAdapter` 是测试与未来多游戏接线的缝——默认实现才是动态 import；
 *    测试不真装载插件包（否则测的是插件本身，不是这条接线）。
 *
 * ## 宿主接线（wiring 请求，不在本文件范围）
 *
 * 在 `ui/App.tsx` 的 `mountProjectScan({...})` 调用点把返回值摊进去：
 *
 * ```ts
 * import { installKojo2ProjectScan } from './kojo2-project-scan-adapter';
 * const handle = mountProjectScan({
 *   kernel,
 *   extraRoots: () => extraRootsRef.current,
 *   onNotice: (message) => notify({ kind: 'info', message }),
 *   ...installKojo2ProjectScan(),
 * });
 * ```
 *
 * 该 import 是静态的，但它拉进来的只有本文件（动态 import 不进静态图），PS-10 判据不受影响。
 */
import { kojo2DiagnosticsEnabled } from './kojo2-diagnostics-gate';
import type { Kojo2ProjectAdapterFacts, Kojo2ProjectPassOptions } from './kojo2-project-analysis';

/** 装载器：交出 adapter 事实，或 `undefined` = 本轮拿不到（接线层唯一的失败形态） */
export type Kojo2ProjectAdapterLoader = () => Promise<Kojo2ProjectAdapterFacts | undefined>;

/**
 * 缺省装载：动态 `import()`（Vite 会切成独立 chunk，静态图里只有这一行说明）。
 *
 * 游戏名只出现在这个 spec 里，按既有豁免口径行尾 `audit-allow`；本文件其余部分零游戏名词。
 */
const loadEratwGameAdapter: Kojo2ProjectAdapterLoader = async () => {
  const mod = await import('@kojo/plugin-eratw-adapter'); // audit-allow: 宿主组合根的惰性 adapter 装载点；与 ui/kojo2-problem-wiring.ts 同一豁免口径（动态 import 不进开机静态图）
  return mod.ERATW_GAME_ADAPTER;
};

/** `createLazyKojo2ProjectOptions` 的注入面（全部可选；缺省即生产口径） */
export interface LazyKojo2ProjectOptionsConfig {
  /**
   * 启用判据（缺省 = 既有 2.0 诊断开关 `kojo2DiagnosticsEnabled`）。
   * 返回 false 时扫描器**零动作**：不读 `.kojo2`、不调 adapter getter。
   */
  readonly isEnabled?: () => boolean;
  /** adapter 装载器（缺省 = 动态 import；测试注入假装载，避免真插件包进单测图） */
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
  const load = config.loadAdapter ?? loadEratwGameAdapter;
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
