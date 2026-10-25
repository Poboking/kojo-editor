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
  },
  {
    id: 'erakoumakan',
    dir: 'erakoumakan-adapter',
    packageName: '@kojo/plugin-erakoumakan-adapter',
    factory: 'createKoumakanAdapterPlugin',
    scope: 'project',
    auditWord: 'erakoumakan',
    load: () => import('@kojo/plugin-erakoumakan-adapter'),
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
