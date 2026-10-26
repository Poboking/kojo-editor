/**
 * 启动器契约（`plugin-api/launcher.ts`）的钉。
 *
 * 三件事各用各的手段，别混着钉：
 * 1. **形状**用 `expectTypeOf`（编译期断言，`tsc --noEmit` 与 vitest 都能证伪）；
 * 2. **键值**用运行期相等（服务键是值导出，漂一个字符就是一个静默找不到的服务）；
 * 3. **不该存在的东西**用类型层反证——尤其「宿主没有任何命令接受目标程序路径」：
 *    这是**启动器最要紧的形状约束**（§13.3 能力面边界），只能靠类型钉，靠肉眼看代码
 *    是看不住的（下一个加命令的人不会读这份注释）。测试里**不引入运行期表**：一旦有表，
 *    它就成了第二份契约，漂了没人知道。
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { KernelServices, WellKnownServices } from '../src/services';
import type {
  ContentManager,
  ContentPackKind,
  ContentPackManifest,
  ContentRootSpec,
  CreateInstanceRequest,
  ExecutableTrust,
  GameAdapter,
  GameLaunchAdapter,
  InstancePatch,
  LauncherError,
  LauncherErrorCode,
  LauncherInstance,
  LauncherService,
  LauncherUpdateService,
  PluginInstallPlan,
  PluginManager,
  PluginSourceManifest,
  ProcessStatus,
  ProcessSupervisor,
  SaveEntry,
} from '../src/index';

describe('启动器契约 · 类型形状', () => {
  it('错误码联合是封闭集：新增/删除一枚都必须同时改这里', () => {
    // 逐字重抄一份是**故意的**：这份重抄就是「钉」。漂了先红在这里，而不是在用户机上
    // 变成「未知错误码 → 显示英文原文」。
    type PinnedCodes =
      | 'LAUNCHER_INSTANCE_NOT_FOUND'
      | 'LAUNCHER_INSTANCE_BUSY'
      | 'LAUNCHER_INSTANCE_NOT_READY'
      | 'LAUNCHER_TRUST_REQUIRED'
      | 'LAUNCHER_TRUST_CHANGED'
      | 'LAUNCHER_EXECUTABLE_INVALID'
      | 'LAUNCHER_RUNTIME_MISSING'
      | 'LAUNCHER_SOURCE_NOT_APPROVED'
      | 'LAUNCHER_PATH_ESCAPE'
      | 'LAUNCHER_ARCHIVE_INVALID'
      | 'LAUNCHER_ARCHIVE_LIMIT'
      | 'LAUNCHER_CONTENT_CONFLICT'
      | 'LAUNCHER_CONTENT_BROKEN'
      | 'LAUNCHER_PLUGIN_CONFLICT'
      | 'LAUNCHER_PLUGIN_INCOMPATIBLE'
      | 'LAUNCHER_PLUGIN_DEPENDENCY'
      | 'LAUNCHER_PLUGIN_SAVE_RISK'
      | 'LAUNCHER_PLUGIN_UNTRUSTED'
      | 'LAUNCHER_PLUGIN_PROJECT_INVALID'
      | 'LAUNCHER_PLUGIN_PROJECT_EXISTS'
      | 'LAUNCHER_PLUGIN_BUILD_FAILED'
      | 'LAUNCHER_PLUGIN_EXTRACT_FAILED'
      | 'LAUNCHER_SAVE_RESTORE_FAILED'
      | 'LAUNCHER_DOWNLOAD_REJECTED'
      | 'LAUNCHER_TASK_CANCELLED'
      | 'LAUNCHER_TASK_BUSY'
      | 'LAUNCHER_SCHEMA_UNSUPPORTED'
      | 'LAUNCHER_PLATFORM_UNSUPPORTED'
      | 'LAUNCHER_INTERNAL';

    expectTypeOf<LauncherErrorCode>().toEqualTypeOf<PinnedCodes>();
    // 错误的 `code` 只许是这一支；`message` 是人话、`retryable` 决定是否给「重试」按钮
    expectTypeOf<LauncherError['code']>().toEqualTypeOf<LauncherErrorCode>();
    expectTypeOf<LauncherError['retryable']>().toEqualTypeOf<boolean>();
    // 宿主 DTO 与契约同形（§7.1）：`detail` 可空、`message` 必填
    expectTypeOf<LauncherError>().toHaveProperty('message').toEqualTypeOf<string>();
  });

  it('清单 `kind` 的收窄：源清单恒 `plugin`，且**不能**冒充制品清单', () => {
    // 源清单（项目内 plugin.json）与制品清单（包内 pack.json）是两个面：
    // 源清单恒是插件，且**没有 files[]/哈希**——所以它不该能当制品清单直接安装。
    expectTypeOf<PluginSourceManifest['kind']>().toEqualTypeOf<'plugin'>();
    expectTypeOf<ContentPackManifest['kind']>().toEqualTypeOf<ContentPackKind>();
    expectTypeOf<ContentPackKind>().toMatchTypeOf<'script' | 'resource' | 'data' | 'plugin' | 'bundle'>();

    // 双向：源清单缺 files[] ⇒ 源清单不是制品清单；反过来制品清单也不能当源清单
    // （制品清单的 roots 映射是构建期的产物，源清单才是作者手写的真源）。
    expectTypeOf<PluginSourceManifest>().not.toExtend<ContentPackManifest>();
    expectTypeOf<ContentPackManifest>().not.toExtend<PluginSourceManifest>();

    // 收窄成「插件档」后仍是同一张清单：插件没有第二套包格式（§5.4 的「一个清单，两档语义」）。
    // 注意 `ContentPackManifest` 是接口而非判别联合，`Extract<>` 取不到（会得 never），
    // 所以收窄用「交叉上字面量 kind」——这也是消费方真正会写的形态。
    type PluginTier = ContentPackManifest & { readonly kind: 'plugin' };
    expectTypeOf<PluginTier['kind']>().toEqualTypeOf<'plugin'>();
    expectTypeOf<PluginTier>().toExtend<ContentPackManifest>();
  });

  it('`GameAdapter` 不带 `launch` 仍合法（旧 adapter 零改）', () => {
    // 只做类型层反证：`launch` 必须是**可选**成员，且类型正好是 `GameLaunchAdapter | undefined`
    expectTypeOf<GameAdapter['launch']>().toEqualTypeOf<GameLaunchAdapter | undefined>();

    // Omit 掉 launch 的形状必须仍可赋给 GameAdapter——这就是「旧 adapter 一个字不改照样编译」
    // 的类型化写法（不用真造一个 adapter 对象，也就不需要它的 detect/loadProject 实现）
    type AdapterWithoutLaunch = Omit<GameAdapter, 'launch'>;
    expectTypeOf<AdapterWithoutLaunch>().toExtend<GameAdapter>();

    // 反方向：不许把 `launch` 变成必填（一旦必填，这条会红）
    type AdapterWithRequiredLaunch = AdapterWithoutLaunch & { readonly launch: GameLaunchAdapter };
    expectTypeOf<AdapterWithRequiredLaunch>().toExtend<GameAdapter>();
    expectTypeOf<AdapterWithoutLaunch>().not.toExtend<AdapterWithRequiredLaunch>();
  });

  it('总门面就是九个子服务 + 生命周期（能力面按服务切开，不糊成一个巨型接口）', () => {
    expectTypeOf<LauncherService['instances']>().not.toBeAny();
    expectTypeOf<LauncherService['processes']>().toEqualTypeOf<ProcessSupervisor>();
    expectTypeOf<LauncherService['content']>().toEqualTypeOf<ContentManager>();
    expectTypeOf<LauncherService['plugins']>().toEqualTypeOf<PluginManager>();
    expectTypeOf<LauncherService['initialize']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<LauncherService['dispose']>().returns.toEqualTypeOf<Promise<void>>();
    // P2 更新服务是**可选**成员：首版可以整块缺席（UI 按存在与否渲染入口）
    expectTypeOf<LauncherService['updates']>().toEqualTypeOf<LauncherUpdateService | undefined>();
  });
});

describe('启动器契约 · 服务键（运行期值）', () => {
  it('宿主桥键 = kernel.launcher', () => {
    expect(KernelServices.LauncherHost).toBe('kernel.launcher');
  });

  it('启动器服务键 = launcher.service', () => {
    expect(WellKnownServices.Launcher).toBe('launcher.service');
  });

  it('新键与既有键互不撞车（同一命名空间里两个键同值 = 静默串线）', () => {
    const kernelKeys = Object.values(KernelServices);
    const wellKnownKeys = Object.values(WellKnownServices);
    expect(kernelKeys.filter((k) => k === 'kernel.launcher')).toHaveLength(1);
    expect(wellKnownKeys.filter((k) => k === 'launcher.service')).toHaveLength(1);
    expect(new Set(kernelKeys).size).toBe(kernelKeys.length);
    expect(new Set(wellKnownKeys).size).toBe(wellKnownKeys.length);
  });
});

describe('启动器契约 · 没有命令接受目标程序路径（§13.3 边界）', () => {
  /**
   * 一次启动**只认实例 id**：目标程序、argv、cwd 全部来自已登记实例 + adapter 的启动
   * 描述，调用方给不了任何路径。这条边界只能用类型钉——`start('C:/somewhere/game.exe')`
   * 在运行期完全「合法」（就是个字符串），只有类型面能证明它不成立。
   *
   * `LauncherHostBridge` 只在这里**按契约形状**复述宿主 P0 命令集（§7.2）：
   * 每个方法的第一参数都是 id 类标识，没有 exe / path / 绝对路径位。
   */
  interface LauncherHostBridge {
    instanceList(): Promise<readonly unknown[]>;
    instanceGet(instanceId: string): Promise<unknown>;
    start(instanceId: string): Promise<ProcessStatus>;
    stop(instanceId: string, opts?: { readonly force?: boolean }): Promise<ProcessStatus>;
    trustExecutable(instanceId: string): Promise<unknown>;
  }

  it('`start` 的参数表只有一格，且是实例 id 字符串', () => {
    expectTypeOf<Parameters<LauncherHostBridge['start']>>().toEqualTypeOf<[instanceId: string]>();
    expectTypeOf<Parameters<LauncherHostBridge['start']>[0]>().toEqualTypeOf<string>();
    // 与真实契约对齐：`ProcessSupervisor.start` 同形（只吃 id）
    expectTypeOf<Parameters<ProcessSupervisor['start']>>().toEqualTypeOf<[id: string]>();
    // 宿主桥里每个方法的首参都是 id 类标识（这行是「谁加了第二个参数」的闸）
    expectTypeOf<LauncherHostBridge['start']>().parameters.toEqualTypeOf<[instanceId: string]>();
  });

  it('任何一层都收不到「目标程序路径」这一形态：exePath / executablePath 不在键集里', () => {
    // 键集反证：命中即红。加一个 `exePath` 参数位是这条边界最容易被悄悄破开的方式。
    expectTypeOf<'exePath' extends keyof LauncherHostBridge ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'executablePath' extends keyof LauncherHostBridge ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'path' extends keyof LauncherHostBridge ? true : false>().toEqualTypeOf<false>();

    // 创建实例的请求同理：只有**已批准的源根**（原生对话框写入）与候选 id，
    // 没有「目标程序绝对路径」这一位——目标程序由 adapter 的 buildProfile 决定。
    expectTypeOf<'exePath' extends keyof CreateInstanceRequest ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'executablePath' extends keyof CreateInstanceRequest ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<CreateInstanceRequest['sourceRoot']>().toEqualTypeOf<string>();
    expectTypeOf<CreateInstanceRequest['candidateId']>().toEqualTypeOf<string>();

    // 可改字段里唯一的程序位是**相对** gameRoot 的路径（§5.1：绝不允许绝对路径/..）
    expectTypeOf<InstancePatch['executableRelativePath']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<'exePath' extends keyof InstancePatch ? true : false>().toEqualTypeOf<false>();
  });

  it('实例清单里的路径字段是「相对」与「宿主现算」两种，没有自由落点', () => {
    expectTypeOf<LauncherInstance['executable']>().toHaveProperty('relativePath');
    expectTypeOf<LauncherInstance['executable']['relativePath']>().toEqualTypeOf<string>();
    // instanceRoot / gameRoot 由宿主按 appData 现算（只读派生，不持久化）
    expectTypeOf<LauncherInstance['instanceRoot']>().toEqualTypeOf<string>();
    expectTypeOf<LauncherInstance['gameRoot']>().toEqualTypeOf<string>();
    // 目标程序的哈希只能由宿主给：JS 没有可写入口（字段是只读的，写入时被忽略）
    expectTypeOf<LauncherInstance['executableTrust']>().toEqualTypeOf<ExecutableTrust | null>();
  });

  it('内容根与安装计划只谈「根 id + 相对路径」，不谈绝对路径', () => {
    expectTypeOf<ContentRootSpec['relativePath']>().toEqualTypeOf<string>();
    expectTypeOf<'absolutePath' extends keyof ContentRootSpec ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<PluginInstallPlan['targets'][number]>().toEqualTypeOf<{
      readonly rootId: string;
      readonly relativePath: string;
    }>();
    // 存档条目同理：path 相对对应 saveRoot
    expectTypeOf<SaveEntry['path']>().toEqualTypeOf<string>();
    expectTypeOf<SaveEntry['rootId']>().toEqualTypeOf<string>();
  });
});
