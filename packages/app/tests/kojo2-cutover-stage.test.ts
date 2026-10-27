/**
 * K2-CUTOVER-STAGE 的判据闸：**开关单源（flag 派生自阶段）+ 旧键兼容 + 设置入口 + 阶段联动**。
 *
 * 五组断言：
 * ① 派生：`isKojo2CutoverEnabled()` 的判据是阶段（`v1-only` = 关），解析顺序写死
 *    （盘上计划 → 旧布尔键 → 控制器 → `v1-only`）；
 * ② 旧键兼容：`'on'` ⇒ 视作 `dual`（迁移规则）；`setKojo2CutoverEnabled` 仍写/删旧键，
 *    宿主开机 `attachStorage` 把 `'on'` 就地迁移成计划（一次）；
 * ③ 阶段联动：改档 ⇒ `refreshAll()` 恰一次、`.kojo` 显式钉 2.0 的 override 在 v1-only 仍被拦
 *    （`.kojo2` 各档照开——K2-SURFACE-DEFAULT：扩展名即声明，语言面不看阶段）、诊断面恒开、
 * ④ 订阅：阶段变化经控制器桥通知 flag 订阅者（只通知真变化，取消即静默）；
 * ⑤ 设置页：三态单选 / 每档人话 / override 清单（可撤）/ 恢复出厂 / 需重载提示。
 *
 * 环境是 node：开关用假 `window.localStorage`（`kojo2-wire.test.ts` 同款），设置页用
 * `renderToStaticMarkup` 直接渲染（组件不 import Monaco，故 import 阶段不摸 window）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_LEGACY_FLAG_KEY,
  createKojo2CutoverController,
  getKojo2CutoverController,
  kojo2StageAllowsLegacy,
  kojo2StageAllowsSurface,
  readKojo2CutoverStage,
  resetKojo2CutoverController,
  stageFromLegacyKojo2Flag,
  type Kojo2CutoverStage,
  type Kojo2CutoverStorage,
} from '../src/ui/kojo2-cutover';
import {
  KOJO2_CUTOVER_KEY,
  clearKojo2CutoverLegacyFlag,
  isKojo2CutoverEnabled,
  resolveKojo2CutoverStage,
  setKojo2CutoverEnabled,
  subscribeKojo2Cutover,
} from '../src/ui/kojo2-flag';
import {
  Kojo2CutoverSettings,
  commitKojo2CutoverStage,
  installKojo2CutoverStageEffects,
  kojo2ReloadNotice,
  kojo2StageNeedsReload,
  resetKojo2CutoverAll,
} from '../src/ui/kojo2-cutover-settings';
import { kojo2StageBlockedReason } from '../src/ui/kojo2-open-paths';
import { kojo2DiagnosticsEnabled, kojo2OwnsDiagnostics } from '../src/ui/kojo2-diagnostics-gate';

const KOJO2_FILE = 'D:/proj/chara/M_KOJO_K12_指令.kojo2';

/* ============================== 假 storage ============================== */

/** 只实现 `Kojo2CutoverStorage` 允许的三格（与 `kojo2-cutover.test.ts` 同形） */
class MemoryStorage implements Kojo2CutoverStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  /** 预置一份合法的切换计划（`version` 缺省 2；迁移用例显式传 1 复刻存量文档） */
  seedPlan(
    stage: Kojo2CutoverStage,
    overrides: Record<string, string> = {},
    version: 1 | 2 = 2,
  ): this {
    this.values.set(KOJO2_CUTOVER_STORAGE_KEY, JSON.stringify({ version, stage, overrides }));
    return this;
  }

  /** 预置旧布尔键 */
  seedLegacy(value: string): this {
    this.values.set(KOJO2_LEGACY_FLAG_KEY, value);
    return this;
  }

  /** 盘上计划（解析失败 = null） */
  plan(): Record<string, unknown> | null {
    const raw = this.values.get(KOJO2_CUTOVER_STORAGE_KEY);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** 装假 `window.localStorage`（返回同一份内存盘，方便断言写入 / 预置） */
function stubWindow(storage: MemoryStorage = new MemoryStorage()): MemoryStorage {
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKojo2CutoverController();
  installKojo2CutoverStageEffects(null);
});

/* ============================== ① 派生 ============================== */

describe('① 开关单源：flag 由阶段派生（v1-only = 关）', () => {
  it('阶段 → 2.0 面：只有 v1-only 不许挂（其余两档逐档放行）', () => {
    expect(kojo2StageAllowsSurface('v1-only')).toBe(false);
    expect(kojo2StageAllowsSurface('dual')).toBe(true);
    expect(kojo2StageAllowsSurface('2.0-default')).toBe(true);
  });

  it('缺省（没 window / 没存过 / 控制器缺省）= 2.0-default，开关缺省即开（LAU-3 翻面）', () => {
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    expect(isKojo2CutoverEnabled()).toBe(true);
    stubWindow();
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    expect(isKojo2CutoverEnabled()).toBe(true);
  });

  it('盘上计划是唯一真源：dual / 2.0-default 都翻成开，v1-only 仍是关', () => {
    const dual = stubWindow(new MemoryStorage().seedPlan('dual'));
    expect(resolveKojo2CutoverStage()).toBe('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);
    dual.seedPlan('v1-only');
    expect(isKojo2CutoverEnabled()).toBe(false);
    dual.seedPlan('2.0-default');
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    expect(isKojo2CutoverEnabled()).toBe(true);
  });

  it('旧键只在「计划缺席或计划仍是缺省档 v1-only」时生效（明确档位不被旧键推翻）', () => {
    const storage = stubWindow(new MemoryStorage().seedPlan('2.0-default').seedLegacy('on'));
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    // `v1-only` 既是缺省值、也是开机自动写下的基线（没人"选"过）⇒ 旧键把它抬成 dual
    storage.seedPlan('v1-only');
    expect(resolveKojo2CutoverStage()).toBe('dual');
    // 坏计划（脏 JSON）⇒ 退回旧键兼容路径，而不是猜
    storage.values.set(KOJO2_CUTOVER_STORAGE_KEY, 'not json');
    expect(resolveKojo2CutoverStage()).toBe('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);
  });

  it('显式改档让旧键退役：之后 v1-only 就是 v1-only（重启也不会被旧键复活）', () => {
    const storage = stubWindow(new MemoryStorage().seedPlan('dual').seedLegacy('on'));
    const controller = getKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('dual');

    controller.setStage('v1-only'); // 显式改档 ⇒ 旧键退役
    expect(storage.values.has(KOJO2_LEGACY_FLAG_KEY)).toBe(false);
    expect(isKojo2CutoverEnabled()).toBe(false);

    resetKojo2CutoverController();
    const restarted = getKojo2CutoverController();
    restarted.attachStorage(storage);
    expect(restarted.getStage()).toBe('v1-only');
    expect(isKojo2CutoverEnabled()).toBe(false);
  });

  it('没有计划也没有旧键 ⇒ 跟随控制器的当前阶段（内存里改过、还没落盘的兜底）', () => {
    stubWindow();
    const controller = getKojo2CutoverController();
    controller.setStage('2.0-default');
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    expect(isKojo2CutoverEnabled()).toBe(true);
    controller.setStage('v1-only');
    expect(isKojo2CutoverEnabled()).toBe(false);
  });

  it('readKojo2CutoverStage 认 version 1 与 2 + 合法阶段（坏版本 / 坏阶段 = null）', () => {
    const storage = new MemoryStorage().seedPlan('dual');
    expect(readKojo2CutoverStage(storage)).toBe('dual');
    // LAU-3 起 v2 是当拍写回的版本：照样读得懂
    storage.values.set(KOJO2_CUTOVER_STORAGE_KEY, JSON.stringify({ version: 2, stage: 'dual' }));
    expect(readKojo2CutoverStage(storage)).toBe('dual');
    // 将来抬到 3：旧版读到 3 一律 null（失败方向 = 少露）
    storage.values.set(KOJO2_CUTOVER_STORAGE_KEY, JSON.stringify({ version: 3, stage: 'dual' }));
    expect(readKojo2CutoverStage(storage)).toBeNull();
    storage.values.set(KOJO2_CUTOVER_STORAGE_KEY, JSON.stringify({ version: 1, stage: '2.0' }));
    expect(readKojo2CutoverStage(storage)).toBeNull();
    expect(readKojo2CutoverStage(null)).toBeNull();
  });

  it('计划解析缓存随原始串失效：盘上改档后下一处读取立刻反映（绝不缓存旧档）', () => {
    const storage = stubWindow(new MemoryStorage().seedPlan('v1-only'));
    expect(isKojo2CutoverEnabled()).toBe(false);
    storage.seedPlan('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);
    storage.seedPlan('2.0-default');
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
    storage.values.delete(KOJO2_CUTOVER_STORAGE_KEY);
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
  });
});

/* ============================== ② 旧键兼容 ============================== */

describe('② 旧键兼容：写死的迁移规则 + 开机迁移一次', () => {
  it("迁移规则写死：只有 'on' ⇒ dual；'off' / 'ON' / '1' / 空 / null 一律不参与", () => {
    expect(stageFromLegacyKojo2Flag('on')).toBe('dual');
    for (const bad of ['off', 'ON', '1', 'true', '', '乱写', null]) {
      expect(stageFromLegacyKojo2Flag(bad), String(bad)).toBeNull();
    }
  });

  it('旧键在原位也算开：没有计划时 `on` ⇒ 解析成 dual（不是 2.0-default，老文件一行都不动）', () => {
    stubWindow(new MemoryStorage().seedLegacy('on'));
    expect(resolveKojo2CutoverStage()).toBe('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);
  });

  it('兼容键常量与 cutover 的旧键是同一枚（全仓没有第二份字面量）', () => {
    expect(KOJO2_CUTOVER_KEY).toBe(KOJO2_LEGACY_FLAG_KEY);
    expect(KOJO2_CUTOVER_KEY).toBe('kojo.ui.kojo2Cutover.v1');
    expect(KOJO2_CUTOVER_STORAGE_KEY).not.toBe(KOJO2_CUTOVER_KEY);
  });

  it('setKojo2CutoverEnabled(true)：写旧键 `on` + 阶段推到 dual；关：删旧键 + 回 v1-only', () => {
    const storage = stubWindow();
    // LAU-3 起缺省已是 2.0 当家；`开` 只把 **v1-only 起步** 推到 dual（不降级，另有用例钉）
    getKojo2CutoverController().setStage('v1-only');
    setKojo2CutoverEnabled(true);
    expect(storage.values.get(KOJO2_CUTOVER_KEY)).toBe('on');
    expect(getKojo2CutoverController().getStage()).toBe('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);

    setKojo2CutoverEnabled(false);
    expect(storage.values.has(KOJO2_CUTOVER_KEY)).toBe(false);
    expect(getKojo2CutoverController().getStage()).toBe('v1-only');
    expect(isKojo2CutoverEnabled()).toBe(false);
  });

  it('开不会把 2.0-default 降级成 dual（旧键只是兼容垫片，真正的档位不被踩掉）', () => {
    stubWindow(new MemoryStorage().seedPlan('2.0-default'));
    getKojo2CutoverController().setStage('2.0-default');
    setKojo2CutoverEnabled(true);
    expect(getKojo2CutoverController().getStage()).toBe('2.0-default');
    expect(resolveKojo2CutoverStage()).toBe('2.0-default');
  });

  it('开机 attachStorage：没有计划 + 旧键 on ⇒ 以 dual 起步并把它写成基线', () => {
    const storage = new MemoryStorage().seedLegacy('on');
    const controller = createKojo2CutoverController();
    expect(controller.getStage()).toBe('2.0-default');
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('dual');
    expect(storage.plan()).toMatchObject({ version: 2, stage: 'dual' });
  });

  it('开机 attachStorage：计划停在缺省档 v1-only + 旧键 on ⇒ 抬到 dual 并写回计划', () => {
    const storage = new MemoryStorage().seedPlan('v1-only').seedLegacy('on');
    const controller = createKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('dual');
    expect(storage.plan()).toMatchObject({ stage: 'dual' });
  });

  it('开机 attachStorage：旧键坏值（off / ON）不迁移，按缺省档写基线', () => {
    for (const bad of ['off', 'ON', '1']) {
      const storage = new MemoryStorage().seedLegacy(bad);
      const controller = createKojo2CutoverController();
      controller.attachStorage(storage);
      expect(controller.getStage(), bad).toBe('2.0-default');
      expect(storage.plan(), bad).toMatchObject({ stage: '2.0-default' });
    }
  });

  it('开机 attachStorage：盘上已有计划 ⇒ 以计划为准（旧键 on 不覆盖它）', () => {
    const storage = new MemoryStorage().seedPlan('2.0-default').seedLegacy('on');
    const controller = createKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('2.0-default');
  });

  it('清除旧键（恢复出厂的一半）：只删那一格 + 通知，阶段不动', () => {
    const storage = stubWindow(new MemoryStorage().seedLegacy('on'));
    getKojo2CutoverController().setStage('dual');
    const listener = vi.fn();
    const off = subscribeKojo2Cutover(listener);
    clearKojo2CutoverLegacyFlag();
    expect(storage.values.has(KOJO2_LEGACY_FLAG_KEY)).toBe(false);
    expect(getKojo2CutoverController().getStage()).toBe('dual');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

/* ============================== ③ 阶段联动 ============================== */

describe('③ 阶段联动：改档即重挂 / 打开闸 / 诊断入口按新阶段重判', () => {
  it('阶段闸只剩切流语义：`.kojo2` 各档照开，老 `.kojo` 钉 2.0 的 override 在 v1-only 仍被拦', () => {
    stubWindow(new MemoryStorage().seedPlan('v1-only'));
    // `kojo2StageBlockedReason` 读的是**控制器**当前档（不是 resolve 出来的盘上档）⇒ 两边对齐到 v1-only
    getKojo2CutoverController().setStage('v1-only');
    expect(isKojo2CutoverEnabled()).toBe(false);
    // K2-SURFACE-DEFAULT：扩展名即声明，阶段不再拦 `.kojo2`
    expect(kojo2StageBlockedReason(KOJO2_FILE, { enabled: true })).toBeNull();

    const v1File = 'D:/proj/chara/M_KOJO_K12_指令.kojo';
    getKojo2CutoverController().setOverride(v1File, 'kojo2');
    expect(kojo2StageBlockedReason(v1File, { enabled: true })).toContain('v1-only');

    commitKojo2CutoverStage('dual');
    expect(kojo2StageBlockedReason(v1File, { enabled: true })).toBeNull();
  });

  it('交接缺口回归：batch-4 基线计划( v1-only ) + 旧键 on ⇒ 开机迁移后 `.kojo2` 直接打得开', () => {
    const storage = stubWindow(new MemoryStorage().seedPlan('v1-only').seedLegacy('on'));
    const controller = getKojo2CutoverController();
    controller.attachStorage(storage); // 开机那一拍（App.tsx 的模块求值）
    expect(controller.getStage()).toBe('dual');
    expect(isKojo2CutoverEnabled()).toBe(true);
    // 修复前：flag 开但阶段停在缺省档 ⇒ 提示「可以开」却打不开
    expect(kojo2StageBlockedReason(KOJO2_FILE)).toBeNull();
    expect(storage.plan()).toMatchObject({ stage: 'dual' });
  });

  it('改档触发 refreshAll 恰一次（同一档再点一次不算切换）', () => {
    stubWindow();
    const refreshAll = vi.fn();
    installKojo2CutoverStageEffects({ refreshAll });

    expect(commitKojo2CutoverStage('dual').stage).toBe('dual');
    expect(refreshAll).toHaveBeenCalledTimes(1);

    commitKojo2CutoverStage('dual'); // no-op
    expect(refreshAll).toHaveBeenCalledTimes(1);

    commitKojo2CutoverStage('2.0-default');
    expect(refreshAll).toHaveBeenCalledTimes(2);
  });

  it('三态可来回：前进两档、退回 v1-only，每次真变化各重挂一次', () => {
    stubWindow();
    const refreshAll = vi.fn();
    const effects = { refreshAll };
    const controller = getKojo2CutoverController();

    expect(commitKojo2CutoverStage('dual', { effects }).stage).toBe('dual');
    expect(commitKojo2CutoverStage('2.0-default', { effects }).stage).toBe('2.0-default');
    expect(controller.canAdvance()).toBe(false);
    expect(commitKojo2CutoverStage('v1-only', { effects }).stage).toBe('v1-only');
    expect(controller.canRollback()).toBe(false);
    expect(refreshAll).toHaveBeenCalledTimes(3);
    // 退回 v1-only：切流开关关了，但 `.kojo2` 不是"切流"，照旧打得开（语言面无条件）
    expect(isKojo2CutoverEnabled()).toBe(false);
    expect(kojo2StageBlockedReason(KOJO2_FILE, { enabled: true })).toBeNull();
  });

  it('诊断面恒开（语言面）；归属仍逐文件按路由：`.kojo2` 归 2.0、`.kojo` 归 v1', () => {
    stubWindow();
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_FILE)).toBe(true);
    expect(kojo2OwnsDiagnostics('D:/proj/chara/M.kojo')).toBe(false);

    // 阶段改来改去不改变"诊断面开"这件事（开关只管写回 / 迁移 / `.kojo` 解析器）
    commitKojo2CutoverStage('dual');
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    commitKojo2CutoverStage('v1-only');
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_FILE)).toBe(true);
    expect(kojo2OwnsDiagnostics('D:/proj/chara/M.kojo')).toBe(false);
  });

  it('显式注入的控制器/效果也能走同一条路（设置页测试用独立实例，不碰单例）', () => {
    const controller = createKojo2CutoverController({ stage: 'v1-only' });
    const refreshAll = vi.fn();
    const snapshot = commitKojo2CutoverStage('2.0-default', {
      controller,
      effects: { refreshAll },
    });
    expect(snapshot.stage).toBe('2.0-default');
    expect(snapshot.stageLabel.length).toBeGreaterThan(0);
    expect(refreshAll).toHaveBeenCalledTimes(1);
    // 单例没被碰：两套各判各的（注入面就是为了这个）
    expect(getKojo2CutoverController().getStage()).toBe('2.0-default');
  });

  it('阶段落盘：改档后计划里就是新阶段，重启也回这一档', () => {
    const storage = stubWindow();
    const controller = getKojo2CutoverController();
    controller.attachStorage(storage);
    commitKojo2CutoverStage('dual');
    expect(storage.plan()).toMatchObject({ stage: 'dual' });
    // "重启"：同一份盘造新控制器
    const restarted = createKojo2CutoverController({ storage });
    expect(restarted.getStage()).toBe('dual');
  });
});

/* ============================== ④ 订阅 ============================== */

describe('④ 订阅：阶段变化经控制器桥即时反映（只通知真变化）', () => {
  it('控制器改档 ⇒ flag 订阅者收到；取消订阅后不再收', () => {
    stubWindow();
    const listener = vi.fn();
    const off = subscribeKojo2Cutover(listener);
    const controller = getKojo2CutoverController();

    controller.setStage('dual');
    expect(listener).toHaveBeenCalledTimes(1);
    controller.setStage('dual'); // no-op：不通知
    expect(listener).toHaveBeenCalledTimes(1);
    controller.setStage('v1-only');
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    controller.setStage('dual');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('多个订阅者各收一次；最后一个走了桥也摘掉（控制器端不再有 flag 监听）', () => {
    stubWindow();
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeKojo2Cutover(a);
    const offB = subscribeKojo2Cutover(b);
    const controller = getKojo2CutoverController();

    controller.setStage('dual');
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    offA();
    offB();
    controller.setStage('2.0-default');
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  });

  it('兼容垫片也走同一条通知路：开 / 关各通知恰一次（不是两次）', () => {
    stubWindow();
    const listener = vi.fn();
    const off = subscribeKojo2Cutover(listener);
    setKojo2CutoverEnabled(true);
    setKojo2CutoverEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

/* ============================== ⑤ 设置页 ============================== */

describe('⑤ 设置页：三态单选 / 人话 / override 清单 / 恢复出厂 / 重载提示', () => {
  function render(controller = createKojo2CutoverController(), boot?: boolean): string {
    return renderToStaticMarkup(
      h(Kojo2CutoverSettings, {
        controller,
        ...(boot === undefined ? {} : { bootSurfaceMounted: boot }),
      }),
    );
  }

  it('三档都在屏上（每档一句人话），当前档标「当前」并选中', () => {
    const html = render(createKojo2CutoverController({ stage: 'dual' }));
    for (const label of ['只认 v1', '双轨', '2.0 默认']) expect(html).toContain(label);
    expect(html).toContain('老 .kojo 一行都不用动，只有 .kojo2 走 2.0');
    expect(html).toContain('data-kojo2-stage="dual" data-kojo2-selected="1"');
    expect(html).toContain('data-kojo2-stage="v1-only" data-kojo2-selected="0"');
    expect(html).toContain('当前');
    // 三个单选同组：切档只有一个 name
    expect(html.match(/name="kojo2-cutover-stage"/g)).toHaveLength(3);
  });

  it('没有 override 时明说"所有文件都按档位走"（不给一个空列表）', () => {
    const html = render();
    expect(html).toContain('还没有任何单文件破例');
    expect(html).toContain('data-kojo2-overrides="empty"');
  });

  it('override 清单：路径 + 生效解析器 + 可撤按钮，数量如实上屏', () => {
    const storage = new MemoryStorage()
      .seedPlan('dual', { [KOJO2_FILE]: 'kojo2', 'D:/proj/a.kojo': 'kojo-v1' });
    const controller = createKojo2CutoverController({ storage });
    const html = render(controller);
    expect(html).toContain('data-kojo2-overrides="2"');
    expect(html).toContain(KOJO2_FILE);
    expect(html).toContain('D:/proj/a.kojo');
    expect(html).toContain('按 2.0');
    expect(html).toContain('按 v1');
    expect(html.match(/>撤销</g)).toHaveLength(2);
  });

  it('需重载提示：v1-only（本窗口挂过 2.0 面）⇒ 明说要重载窗口才彻底摘掉', () => {
    const html = render(createKojo2CutoverController({ stage: 'v1-only' }), true);
    expect(html).toContain('data-kojo2-reload-notice="1"');
    expect(html).toContain('重载窗口');
    // 上屏用作者词「只认 v1」，不把阶段字面量（v1-only）当文案（DOM 属性里的机器值不算文案）
    expect(html).toContain('已退回「只认 v1」');
    expect(kojo2ReloadNotice('v1-only')).not.toContain('v1-only');
  });

  it('需重载提示：本窗口本来没挂、现在切到 dual ⇒ 提示"重载后新开的文件才完整生效"', () => {
    const html = render(createKojo2CutoverController({ stage: 'dual' }), false);
    expect(html).toContain('data-kojo2-reload-notice="1"');
    expect(html).toContain('语言面与配色是在窗口启动时装配的');
  });

  it('没有跨过边界（启动就挂着 + 现在也挂着 / 启动没挂 + 现在也没挂）⇒ 不出提示', () => {
    expect(render(createKojo2CutoverController({ stage: 'dual' }), true)).not.toContain(
      'data-kojo2-reload-notice',
    );
    expect(render(createKojo2CutoverController({ stage: 'v1-only' }), false)).not.toContain(
      'data-kojo2-reload-notice',
    );
  });

  it('kojo2StageNeedsReload / kojo2ReloadNotice 是纯函数（四格真值表 + 两方向都提重载）', () => {
    expect(kojo2StageNeedsReload('dual', false)).toBe(true);
    expect(kojo2StageNeedsReload('2.0-default', false)).toBe(true);
    expect(kojo2StageNeedsReload('dual', true)).toBe(false);
    expect(kojo2StageNeedsReload('v1-only', true)).toBe(true);
    expect(kojo2StageNeedsReload('v1-only', false)).toBe(false);
    for (const stage of ['dual', '2.0-default', 'v1-only'] as const) {
      expect(kojo2ReloadNotice(stage)).toContain('重载窗口');
    }
  });

  it('恢复出厂：回缺省档（2.0 当家）+ 清 override + 删计划 + 删旧键（旧键不清就会把解析拉回 dual）', () => {
    const storage = stubWindow(
      new MemoryStorage().seedPlan('dual', { [KOJO2_FILE]: 'kojo2' }).seedLegacy('on'),
    );
    const controller = getKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('dual');

    const snapshot = resetKojo2CutoverAll(controller);
    expect(snapshot.stage).toBe('2.0-default');
    expect(snapshot.overrides).toEqual([]);
    expect(storage.values.has(KOJO2_CUTOVER_STORAGE_KEY)).toBe(false);
    expect(storage.values.has(KOJO2_LEGACY_FLAG_KEY)).toBe(false);
    expect(isKojo2CutoverEnabled()).toBe(true);
  });

  it('存储不可写时如实说"只在本会话生效"（persisted=false 上屏，不假装存住了）', () => {
    const html = render(createKojo2CutoverController());
    expect(html).toContain('data-kojo2-persisted="0"');
    expect(html).toContain('存储不可写');
  });
});

/* ============================== ⑥ LAU-3：缺省翻面 + 一次性迁移 + kojo1 门 ============================== */

/**
 * LAU-3（2026-10-27）三件套：缺省档从 `v1-only` 翻到 `2.0-default`、存量 v1 计划**一次性迁移**
 * （并留回执）、以及 kojo1 封存门的三档真值表。
 *
 * 迁移为什么必须做：`v1-only` 既是旧缺省、又是开机自动写下的基线 ⇒ 盘上"几乎人人一份 v1-only"，
 * 只改缺省常量对存量用户零效果。
 */
describe('⑥ LAU-3：缺省翻面（存量 v1 计划一次性迁移）+ kojo1 封存门', () => {
  it('kojo1 门三档真值表：只有 2.0-default 封存', () => {
    expect(kojo2StageAllowsLegacy('v1-only')).toBe(true);
    expect(kojo2StageAllowsLegacy('dual')).toBe(true);
    expect(kojo2StageAllowsLegacy('2.0-default')).toBe(false);
  });

  it('v1 计划停在 v1-only（旧缺省基线）⇒ 抬到 2.0-default，快照给一次性回执并当拍写回 v2', () => {
    const storage = new MemoryStorage().seedPlan('v1-only', {}, 1);
    const controller = createKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('2.0-default');
    expect(controller.getSnapshot().migratedFromV1Plan).toBe(true);
    expect(storage.plan()).toMatchObject({ version: 2, stage: '2.0-default' });
    // 写回之后就是普通 v2 计划：下次开机不再出现在回执里
    const restarted = createKojo2CutoverController();
    restarted.attachStorage(storage);
    expect(restarted.getSnapshot().migratedFromV1Plan).toBe(false);
  });

  it('v1 计划显式选了 dual / 2.0-default ⇒ 原样保留（只抬基线，不改选择）', () => {
    for (const stage of ['dual', '2.0-default'] as const) {
      const storage = new MemoryStorage().seedPlan(stage, {}, 1);
      const controller = createKojo2CutoverController();
      controller.attachStorage(storage);
      expect(controller.getStage(), stage).toBe(stage);
    }
  });

  it('被抬上来的 v1 基线 + 旧键 on ⇒ 留在 dual（不把当年翻过开关的人顶进封存档）', () => {
    const storage = new MemoryStorage().seedPlan('v1-only', {}, 1).seedLegacy('on');
    const controller = createKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getStage()).toBe('dual');
    expect(kojo2StageAllowsLegacy(controller.getStage())).toBe(true);
    expect(storage.plan()).toMatchObject({ version: 2, stage: 'dual' });
  });

  it('恢复出厂会清掉迁移回执（作者亲手做的，不该再提示"我们替你抬过档"）', () => {
    const storage = new MemoryStorage().seedPlan('v1-only', {}, 1);
    const controller = createKojo2CutoverController();
    controller.attachStorage(storage);
    expect(controller.getSnapshot().migratedFromV1Plan).toBe(true);
    controller.reset();
    expect(controller.getSnapshot().migratedFromV1Plan).toBe(false);
  });
});
