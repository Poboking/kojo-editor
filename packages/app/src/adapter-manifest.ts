/**
 * 适配器清单（组合根的唯一名单）。
 *
 * 过去「接一个新游戏要改哪几处」散在六七个文件里：组合根的 import 与工厂调用、
 * 开机次序测试的期望数组、审计的豁免名单、tsconfig / vitest 的路径别名、
 * app 包的依赖声明。漏一处不会立刻红，只会在某个别的机器上以别的形态炸。
 *
 * 这份清单把**身份**收成一处：`id`（= gameId）/ `dir`（插件目录）/ `packageName`
 * （包名）/ `factory`（工厂函数名）/ `scope`（常驻 or 项目级）/ `auditWord`
 * （审计词表用的游戏名词）。其余散点（别名、依赖、次序期望）由
 * `packages/app/tests/adapter-manifest.test.ts` 双向自证——清单说有的，文件里必须真有；
 * 文件里有的，清单里必须列得下。
 *
 * 组合根与 `bootstrap.ts` 同属宿主接线层：这里出现游戏 id 是**注册元数据**，
 * 不是游戏知识（识别规则、变量表、约定规则一律住在各自 adapter 包内）。
 */
import type { Plugin } from '@kojo/plugin-api';

export type AdapterScope = 'boot' | 'project';

export interface AdapterManifestEntry {
  /** 适配器 id（= `GameAdapter.gameId`；也进 `GameProject.adapterId`） */
  readonly id: string;
  /** 插件目录名（`packages/plugins/<dir>`） */
  readonly dir: string;
  /** 包名（`@kojo/plugin-<dir>`） */
  readonly packageName: string;
  /** 工厂函数名（插件导出名） */
  readonly factory: string;
  /**
   * 装载时机：
   * - `'boot'`：常驻（欢迎页也有它的贡献面），随内核一起起；
   * - `'project'`：项目级（欢迎页无贡献面），`ensureProjectPlugins` 在
   *   `project.open()` 之前装载。
   */
  readonly scope: AdapterScope;
  /** 审计词表用的游戏名词（审计脚本从本清单读取，新增 adapter 不用再改审计） */
  readonly auditWord: string;
  /** 动态装载（仅项目级需要；常驻包由组合根静态 import，理由见各自注释） */
  readonly load?: () => Promise<Record<string, unknown>>;
  /**
   * 2.0 事实面（`GameAdapter`）在包里的**导出名**（可选；LAU-1a 泛化）。
   *
   * 组合根装载该包后按存在性卫语句登记进 2.0 登记簿（键 = `id` = v1 `gameId`）：
   * 导出缺席 ⇒ 跳过（该项目走 `null` 语义），**绝不借别游戏的事实**。
   * 导出名写在清单里而不是在循环里猜命名约定：加一个 era 只加数据（D9 / §5.6 判据）。
   */
  readonly kojo2AdapterExport?: string;
  /** 2.0 落点面（`KojoEmitBackend` 工厂）在包里的**导出名**（可选；口径与上一条逐字相同） */
  readonly kojo2BackendFactoryExport?: string;
  /**
   * 表层↔原生映射表在包里的**导出名**（可选；LAU-SURFACE-WIRE 批）。
   *
   * 表**刻意不进 `GameAdapter`**：方言包总装 `*_GAME_ADAPTER` 落在开机静态依赖图里
   * （PS-10 今天 200 文件 / 3,509 KB 双双顶格），挂进去就是新增一枚在图文件 ⇒ 当场撞闸
   * （车② 的取舍，见 `packages/kojo-core/src/surface-map.ts` 头注）。所以表走**包 exports
   * 的懒边**，由本清单点名导出名 + 一条 `loadSurfaceMap` 动态装载；宿主只认清单，
   * 不认识任何游戏名（识别规则、表本体一律住在各自 adapter 包内）。
   */
  readonly surfaceMapExport?: string;
  /** 表层映射表的懒装载（与 `load` 同形；只有声明了 `surfaceMapExport` 的方言才需要） */
  readonly loadSurfaceMap?: () => Promise<Record<string, unknown>>;
}

/**
 * 全部适配器（**按注册次序**排列）。
 *
 * 次序说明：内核在 `project.open()` 时轮询**全部**候选，多命中即报冲突
 * （见 `AdapterConflictError`），所以这里不再靠「谁排前面谁赢」。
 */
export const ADAPTER_MANIFEST: readonly AdapterManifestEntry[] = [
  {
    // eraTW 是 `scope:'boot'` 常驻项：v1 插件与 2.0 两面（adapter / backend）都在
    // `bootstrap.ts` 静态 import、模块加载即进表，**不走**下面两条清单驱动的懒登记路
    // （静态路径是 PS-10 开机图的既有口径，本批保持不变）。
    id: 'eratw',
    dir: 'eratw-adapter',
    packageName: '@kojo/plugin-eratw-adapter',
    factory: 'createEratwAdapterPlugin',
    scope: 'boot',
    auditWord: 'eratw',
    // 表层↔原生映射表（LAU-SURFACE-WIRE）：表本体在包 exports 的懒叶上，**不随常驻包静态
    // 进图**——只有真去查"这个原生写法作者叫什么"时才把这一枚拉起来（PS-10 顶格）。
    surfaceMapExport: 'ERATW_SURFACE_MAP',
    loadSurfaceMap: () => import('@kojo/plugin-eratw-adapter/kojo2-surface-map'),
  },
  {
    id: 'erafl',
    dir: 'erafl-adapter',
    packageName: '@kojo/plugin-erafl-adapter',
    factory: 'createEraflAdapterPlugin',
    scope: 'project',
    auditWord: 'erafl',
    load: () => import('@kojo/plugin-erafl-adapter'),
    kojo2AdapterExport: 'ERAFL_GAME_ADAPTER',
    kojo2BackendFactoryExport: 'createEraflEmitBackend',
  },
  {
    id: 'eraakumamaid',
    dir: 'eraakumamaid-adapter',
    packageName: '@kojo/plugin-eraakumamaid-adapter',
    factory: 'createErakumamaidAdapterPlugin',
    scope: 'project',
    auditWord: 'eraakumamaid',
    load: () => import('@kojo/plugin-eraakumamaid-adapter'),
    kojo2AdapterExport: 'ERAAKUMAMAID_GAME_ADAPTER',
  },
  {
    id: 'erakoumakan',
    dir: 'erakoumakan-adapter',
    packageName: '@kojo/plugin-erakoumakan-adapter',
    factory: 'createKoumakanAdapterPlugin',
    scope: 'project',
    auditWord: 'erakoumakan',
    load: () => import('@kojo/plugin-erakoumakan-adapter'),
    kojo2AdapterExport: 'ERAKOUMAKAN_GAME_ADAPTER',
  },
  {
    id: 'erasqc',
    dir: 'erasqc-adapter',
    packageName: '@kojo/plugin-erasqc-adapter',
    factory: 'createErasqcAdapterPlugin',
    scope: 'project',
    auditWord: 'erasqc',
    load: () => import('@kojo/plugin-erasqc-adapter'),
    kojo2AdapterExport: 'ERASQC_GAME_ADAPTER',
  },
  {
    id: 'eratohok',
    dir: 'eratohok-adapter',
    packageName: '@kojo/plugin-eratohok-adapter',
    factory: 'createTohokAdapterPlugin',
    scope: 'project',
    auditWord: 'eratohok',
    load: () => import('@kojo/plugin-eratohok-adapter'),
    kojo2AdapterExport: 'ERATOHOK_GAME_ADAPTER',
  },
  {
    // eraAV（2026-10-26 批，P0+P1+P2+2.0 数据面）。2.0 事实面逐项真盘裁决
    // （8/9 事件——无 EVENTLOAD；CRLF + BOM 470/471；`#PRI` 共享钩子），
    // backend 仍缺席（发射面未交付 ⇒ null 是可见降级）。
    id: 'eraav',
    dir: 'eraav-adapter',
    packageName: '@kojo/plugin-eraav-adapter',
    factory: 'createEraavAdapterPlugin',
    scope: 'project',
    auditWord: 'eraav',
    load: () => import('@kojo/plugin-eraav-adapter'),
    kojo2AdapterExport: 'ERAAV_GAME_ADAPTER',
  },
  {
    // eratohoReverse（2026-10-26 批，P0+P1+P2+2.0 数据面）。2.0 事实面逐项真盘裁决
    // （8/9 事件——无 EVENTBUY；LF + BOM 100%；KCOLOR.ERB 共享钩子），
    // backend 仍缺席（发射面未交付 ⇒ null 是可见降级）。
    id: 'eratohoreverse',
    dir: 'eratohoreverse-adapter',
    packageName: '@kojo/plugin-eratohoreverse-adapter',
    factory: 'createEratohoreverseAdapterPlugin',
    scope: 'project',
    auditWord: 'eratohoreverse',
    load: () => import('@kojo/plugin-eratohoreverse-adapter'),
    kojo2AdapterExport: 'ERATOHOREVERSE_GAME_ADAPTER',
  },
];

/** 项目级适配器（组合根装载的就是这一批） */
export function projectAdapters(): readonly AdapterManifestEntry[] {
  return ADAPTER_MANIFEST.filter((entry) => entry.scope === 'project');
}

/** 按 id 取清单项（找不到 ⇒ 抛错，不静默回退） */
export function adapterEntry(id: string): AdapterManifestEntry {
  const found = ADAPTER_MANIFEST.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`适配器清单里没有 '${id}'`);
  return found;
}

/** 从已装载的模块命名空间里取出工厂并调用（工厂名缺失 ⇒ 抛错，不静默跳过） */
export function createAdapterPlugin(entry: AdapterManifestEntry, mod: Record<string, unknown>): Plugin {
  const factory = mod[entry.factory];
  if (typeof factory !== 'function') {
    throw new Error(`适配器 ${entry.packageName} 没有导出工厂 ${entry.factory}`);
  }
  return (factory as () => Plugin)();
}

/* --------------------------- 表层映射表：懒装载 + 同步快照（LAU-SURFACE-WIRE） --------------------------- */

/**
 * 表是**只读数据、按 adapter id 恒定**，所以缓存键就是 id、值就是那一份表本体。
 * 值是 `Promise` 而不是表：并发首问只拉一次（与 `languageFeaturesService` 同款"踢一脚"形态）。
 */
const surfaceMapLoads = new Map<string, Promise<unknown | null>>();
/** 结算后的同步快照：读表的一方（悬停那条同步腿）等不了 Promise，只读它 */
const surfaceMapNow = new Map<string, unknown | null>();

/**
 * 当前 adapter 的表：**同步交回已结算的那一份**，没结算就先踢一脚装载。
 *
 * 为什么同步：悬停 provider 是同步的（改异步会动到一整片既有判据的取数口径），而表只是
 * "多一条反向名"的增益——首次悬停读到 `null` 就等于"这一版还没装好"，第二次就有。为了不让
 * 首屏那一次白丢，`editorTables()`（每个 provider 调用都会走）顺手把装载踢起来，正常使用时
 * 早就热了。
 *
 * 三态与铁律 4 同口径：**没声明**（清单里没 `surfaceMapExport`）⇒ 恒 `null`，不判不猜；
 * 装载失败 / 导出名对不上 ⇒ `null`（不编造一张空表——空表会被读表面当成"声明了但一条都没有"）；
 * 装载成功 ⇒ 表本体（读表函数自己会做 `readSurfaceMap` 的形状校验）。
 */
export function surfaceMapNowOf(adapterId: string | null | undefined): unknown | null {
  if (typeof adapterId !== 'string' || adapterId.length === 0) return null;
  const settled = surfaceMapNow.get(adapterId);
  // 结算过就是答案（`null` 也是答案：没声明 / 装载失败），不再重试
  if (settled !== undefined) return settled;
  const entry = ADAPTER_MANIFEST.find((candidate) => candidate.id === adapterId);
  if (entry === undefined || entry.surfaceMapExport === undefined || entry.loadSurfaceMap === undefined) {
    surfaceMapNow.set(adapterId, null);
    return null;
  }
  void surfaceMapOf(entry);
  return null;
}

/** 装载一份表（幂等；失败 ⇒ `null` 并**缓存这个失败**，不让每次悬停都重试一次 IO） */
export function surfaceMapOf(entry: AdapterManifestEntry): Promise<unknown | null> {
  const cached = surfaceMapLoads.get(entry.id);
  if (cached !== undefined) return cached;
  const exportName = entry.surfaceMapExport;
  const load = entry.loadSurfaceMap;
  if (exportName === undefined || load === undefined) return Promise.resolve(null);
  const pending = (async (): Promise<unknown | null> => {
    try {
      const mod = await load();
      const table = mod[exportName];
      surfaceMapNow.set(entry.id, table ?? null);
      return table ?? null;
    } catch {
      // 打包器不认 exports 叶子 / 包被裁剪：这条懒边在当前构建上不通 ⇒ 如实 null（不猜）
      surfaceMapNow.set(entry.id, null);
      return null;
    }
  })();
  surfaceMapLoads.set(entry.id, pending);
  return pending;
}
