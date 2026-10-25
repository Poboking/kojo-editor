/**
 * LAU-1a · 宿主惰性装载点**按当前项目取 2.0 事实**的验收闸（2026-10-25）。
 *
 * 规格出处：`docs/ARCH-language-unification.md` §5.1 事实 1 的漏点表 + §8 LAU-1a 行。
 * 2.0 主入口那处写死已由入口 A 修掉（`kojo2AdapterForProject` 按 `project.adapterId`
 * 现取、取不到给 `null`）；本批把**同族漏点**收成同一口径：
 *
 * ① eraFL 工程：迁移向导的事件面词/参数形状、存储注入的指纹/存储期、项目扫描的
 *    adapter 事实 ⇒ 全部拿到 **eraFL 的**或空形态，响应里**一个 eraTW 事实名都不许出现**；
 * ② 四个没有 2.0 面的适配器（eraakumamaid / erakoumakan / erasqc / eratohok）⇒
 *    null/undefined，**不借 eraTW**（D12：未绑定 = 明确降级，绝不回落默认方言）；
 * ③ 六枚适配器的 2.0 登记结果与改前**逐一致**（eraTW 走 boot 静态路径、eraFL 走
 *    清单驱动的泛化登记、其余四家不进表）；
 * ④ 无项目态（欢迎页）⇒ 全腿空形态（迁移 undefined / 存储 null / 扫描 undefined）；
 * ⑤ 源码闸：游戏名退出 App.tsx 与扫描接线文件；bootstrap 不再出现 `'erafl'` 字面量
 *    （erafl 的导出名从此只住在 `adapter-manifest.ts`——审计钦定的法定落点）。
 *
 * 装载器与 getter 的**行为**钉在 `kojo2-project-scan-adapter.test.ts`，登记簿语义钉在
 * `kojo2-adapter-table.test.ts`；本文件钉的是"按项目取"这条合批口径。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { projectEventArgs } from '@kojo/kojo-core';
import { ERATW_EVENT_NAMES, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERAFL, ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter';
import { ADAPTER_MANIFEST, projectAdapters } from '../src/adapter-manifest';
import {
  kojo2AdapterForProject,
  kojo2BackendFactoryForProject,
  kojo2MigrateEventArgs,
  kojo2MigrateEventNames,
  kojo2StorageFacts,
  registerKojo2SurfacesFromModules,
} from '../src/bootstrap';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/** eraTW 独有、eraFL 目录里**不存在**的事件名（eraFL 只声明 4/9，见其包头注） */
const ERATW_ONLY_EVENTS = ['训练', '指令', '训练结束', '回合末', '指令结束'];
/** eraFL 四事件的**手抄字面真值**（源：erafl-adapter `kojo2/event-catalog.ts`；独立于被测投影） */
const ERAFL_EVENT_NAMES_LITERAL = ['初见', '读档', '商店', '购买'];

/** 走生产同一条路把项目级 adapter 登记进 2.0 表：清单条目 + 真包模块命名空间 */
async function registerProjectSurfaces(): Promise<void> {
  const entries = projectAdapters();
  const modules = await Promise.all(entries.map((entry) => entry.load!()));
  registerKojo2SurfacesFromModules(entries, modules);
}

// 与生产 `loadProjectPlugins` 同一入口：先登记，再逐腿验"按项目取"。
beforeAll(registerProjectSurfaces);

describe('LAU-1a ① · eraFL 项目拿到 eraFL 事实，零 eraTW 泄漏', () => {
  const eraflProject = { adapterId: ERAFL.gameId };

  it('迁移向导事件面词 = eraFL 四事件；eraTW 独有的五个一名都不出现', () => {
    const names = kojo2MigrateEventNames(eraflProject);
    expect(names).toEqual(ERAFL_EVENT_NAMES_LITERAL);
    expect(names).toHaveLength(4);
    for (const eraTwOnly of ERATW_ONLY_EVENTS) {
      expect(names).not.toContain(eraTwOnly);
    }
    // 与 eraTW 的名录不是同一枚对象，也逐字不相等
    expect(names).not.toEqual(ERATW_EVENT_NAMES);
  });

  it('迁移向导参数形状 = eraFL 事件目录的投影；键里没有 eraTW 独有事件', () => {
    const args = kojo2MigrateEventArgs(eraflProject);
    expect(args).toBeDefined();
    expect(args).toEqual(projectEventArgs(ERAFL_GAME_ADAPTER.eventCatalog));
    expect(Object.keys(args ?? {})).toEqual(ERAFL_EVENT_NAMES_LITERAL);
    for (const eraTwOnly of ERATW_ONLY_EVENTS) {
      expect(args).not.toHaveProperty(eraTwOnly);
    }
  });

  it('存储事实 = eraFL 自己的指纹与声明过的存储期', () => {
    const facts = kojo2StorageFacts(eraflProject);
    expect(facts).not.toBeNull();
    expect(facts!.gameFingerprint).toBe(ERAFL_GAME_ADAPTER.gameFingerprint.digest);
    // 指纹与 eraTW 不同源：拿错指纹正是旧实现（无条件 eraTW）写进账本的那格
    expect(ERAFL_GAME_ADAPTER.gameFingerprint.digest).not.toBe(ERATW_GAME_ADAPTER.gameFingerprint.digest);
    expect([...facts!.declaredPeriods].sort()).toEqual(
      [...new Set(ERAFL_GAME_ADAPTER.storageClasses.classes.map((spec) => spec.period))].sort(),
    );
  });
});

describe('LAU-1a ② · 无 2.0 面的四家适配器 ⇒ 空形态，不借 eraTW', () => {
  const noKojo2Surface = ADAPTER_MANIFEST.filter(
    (entry) => entry.scope === 'project' && entry.kojo2AdapterExport === undefined,
  ).map((entry) => entry.id);

  it('清单里确有这四家没有 2.0 面（eraakumamaid / erakoumakan / erasqc / eratohok）', () => {
    expect(noKojo2Surface.sort()).toEqual(['eraakumamaid', 'erakoumakan', 'erasqc', 'eratohok']);
  });

  for (const id of noKojo2Surface) {
    it(`adapterId='${id}' 的工程：登记簿给 null，三条腿都是各自的空形态`, () => {
      // eraTW 常驻在场也不借（"错误事实不报错"正是这类 bug 的病灶）
      expect(kojo2AdapterForProject({ adapterId: id })).toBeNull();
      expect(kojo2BackendFactoryForProject({ adapterId: id })).toBeNull();
      expect(kojo2MigrateEventNames({ adapterId: id })).toBeUndefined();
      expect(kojo2MigrateEventArgs({ adapterId: id })).toBeUndefined();
      expect(kojo2StorageFacts({ adapterId: id })).toBeNull();
    });
  }
});

describe('LAU-1a ③ · 六枚适配器的登记结果与改前逐一致', () => {
  it('eraTW（boot 静态路径）：adapter 与 backend 都在表里，且与改前同为包导出本体', () => {
    expect(kojo2AdapterForProject({ adapterId: 'eratw' })).toBe(ERATW_GAME_ADAPTER);
    expect(typeof kojo2BackendFactoryForProject({ adapterId: 'eratw' })).toBe('function');
  });

  it('eraFL（清单驱动的泛化登记）：两面都进表，键 = v1 gameId = 清单 id，值 = 包导出本体', () => {
    expect(ERAFL.gameId).toBe('erafl'); // 键口径：原实现取 ERAFL.gameId，泛化后取 entry.id，两者必须同值
    expect(kojo2AdapterForProject({ adapterId: 'erafl' })).toBe(ERAFL_GAME_ADAPTER);
    expect(typeof kojo2BackendFactoryForProject({ adapterId: 'erafl' })).toBe('function');
  });

  it('其余四家（仅 v1 面）：两面都不在表里', () => {
    for (const id of ['eraakumamaid', 'erakoumakan', 'erasqc', 'eratohok']) {
      expect(kojo2AdapterForProject({ adapterId: id })).toBeNull();
      expect(kojo2BackendFactoryForProject({ adapterId: id })).toBeNull();
    }
  });

  it('导出名住在清单而不许住进组合根的分支', () => {
    const eraflEntry = ADAPTER_MANIFEST.find((entry) => entry.id === 'erafl')!;
    expect(eraflEntry.kojo2AdapterExport).toBe('ERAFL_GAME_ADAPTER');
    expect(eraflEntry.kojo2BackendFactoryExport).toBe('createEraflEmitBackend');
    // 卫语句仍在（导出缺席 ⇒ 跳过），且缺席时代码路径不抛
    expect(() =>
      registerKojo2SurfacesFromModules([eraflEntry], [{ notTheExport: 1 } as Record<string, unknown>]),
    ).not.toThrow();
  });
});

describe('LAU-1a ④ · 无项目态（欢迎页）与陈旧 adapterId 的空形态', () => {
  it('project 为 null / adapterId 缺席 ⇒ 三条腿全空形态（零候选、不抛、不猜）', () => {
    for (const project of [null, {} as { adapterId?: string }]) {
      expect(kojo2AdapterForProject(project)).toBeNull();
      expect(kojo2MigrateEventNames(project)).toBeUndefined();
      expect(kojo2MigrateEventArgs(project)).toBeUndefined();
      expect(kojo2StorageFacts(project)).toBeNull();
    }
  });

  it('未知 adapterId（盘不在清单 / 清单外游戏）⇒ 同样空形态', () => {
    expect(kojo2MigrateEventNames({ adapterId: 'no-such-game' })).toBeUndefined();
    expect(kojo2StorageFacts({ adapterId: 'no-such-game' })).toBeNull();
  });
});

describe('LAU-1a ⑤ · 源码闸：游戏名退出被修的四处', () => {
  it('ui/App.tsx：不再直接 import 任何适配器包，惰性装载点全部改走组合根', () => {
    const source = read('packages/app/src/ui/App.tsx');
    expect(source).not.toMatch(/@kojo\/plugin-[a-z0-9-]+-adapter/);
    expect(source).not.toMatch(/ERATW_|ERAFL_/);
    expect(source).not.toMatch(/eratw|erafl/i);
    // 三条腿按项目取的接线在场
    expect(source).toContain('kojo2MigrateEventNames');
    expect(source).toContain('kojo2MigrateEventArgs');
    expect(source).toContain('kojo2StorageFacts');
    expect(source).toContain('kojo2ProjectFactory');
  });

  it('bootstrap.ts：组合根不再出现 erafl **代码行**字面量（导出名只剩清单；注释里的历史说明按审计同口径豁免）', () => {
    const source = read('packages/app/src/bootstrap.ts');
    const codeLines = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(codeLines).not.toMatch(/erafl/i);
    // 泛化入口在场，且 boot 静态路径（eraTW 常驻）保持不变
    expect(source).toContain('registerKojo2SurfacesFromModules');
    expect(source).toContain('registerKojo2Adapter(ERATW.gameId, ERATW_GAME_ADAPTER)');
  });

  it('ui/kojo2-project-scan-adapter.ts：装载目标完全由宿主注入（文件本体零游戏知识）', () => {
    const source = read('packages/app/src/ui/kojo2-project-scan-adapter.ts');
    expect(source).not.toMatch(/@kojo\/plugin-[a-z0-9-]+-adapter/);
    expect(source).not.toMatch(/eratw|erafl/i);
  });
});
