/**
 * Kojo 2.0 **预演开关**（K2-EDITOR-WIRE）—— K2-CUTOVER-STAGE 起**由切换阶段派生**。
 *
 * ## 单源：阶段说了算
 *
 * 真源是 `ui/kojo2-cutover.ts` 的三态阶段（`v1-only → dual → 2.0-default`）：
 * **`stage !== 'v1-only'` 即"2.0 面开启"**。本模块不再自己存一份布尔，只做三件事：
 * ① 把阶段解析出来（{@link resolveKojo2CutoverStage}）；② 给既有 flag 守卫一个稳定的
 * `isKojo2CutoverEnabled()`；③ 变更订阅（设置页改档 ⇒ 语言重挂 / 派生清单即时反映）。
 *
 * 解析顺序（**写死**，`kojo2-cutover-stage.test.ts` 逐条钉住）：
 *
 * 1. 盘上的切换计划 `kojo.ui.kojo2Cutover.plan.v1`（version 1 + 合法阶段）⇒ 以它为准；
 * 2. 旧布尔键 `kojo.ui.kojo2Cutover.v1` === `'on'` ⇒ 视作 `dual`（迁移规则见
 *    {@link stageFromLegacyKojo2Flag}；`'off'` / `'ON'` / 坏值一律不参与）。这一条**只在
 *    计划缺席、或计划还停在缺省档 `v1-only`** 时生效：`v1-only` 既是缺省值、也是开机自动
 *    写下的基线，不该把 batch-3/4 里翻过旧开关的人静默关掉；作者在新设置页显式改过档之后
 *    旧键已被删掉，阶段独占真源；
 * 3. 进程内切换控制器的当前阶段（内存里改过、还没落盘的兜底）；
 * 4. 兜底 `v1-only`（失败方向永远是"少露"，不是"多露"）。
 *
 * ## 旧键兼容（读 + 写）
 *
 * - **读**：见上第 2 条；
 * - **写**：{@link setKojo2CutoverEnabled} 仍写 / 删旧键（旧读者、devtools、老文档还能对上），
 *   同时把阶段推到等价的一档（开 ⇒ 至少 `dual`，关 ⇒ `v1-only`）；它**不再是真源**；
 * - **退役**：任何显式改档（`advance` / `rollback` / `setStage` / 设置页）都会删掉旧键
 *   （控制器的提交路径负责），从此只有阶段说话。
 * - **开机迁移**：`attachStorage` 发现计划缺席、或计划停在 `v1-only` 且旧键为 `'on'` 时，
 *   直接以 `dual` 起步并写回计划（控制器负责，见 `kojo2-cutover.ts`）。
 *
 * ## 生效时机：装配那一刻
 *
 * `monaco/languages.ts` / 主题 / 诊断接线在**模块求值**时读一次本开关：descriptor 表是
 * 进程级只增表，跨过 `v1-only` 边界后要重载窗口才换表（设置页把这条提示摆在明处）。
 * 已打开的标签另有一条热路：`kojo2-cutover` 的订阅会 `refreshAll()` 重挂 model 语言。
 *
 * ## 作者面文案
 *
 * 本模块是机器面（devtools / 设置页），标识符与键名可以和代码对得上；真要上屏时由调用方
 * 写人话（见 `ui/kojo2-cutover-settings.tsx`），这里不产出任何界面文案。
 */

import {
  getKojo2CutoverController,
  kojo2StageAllowsSurface,
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_LEGACY_FLAG_KEY,
  parseKojo2CutoverStage,
  stageFromLegacyKojo2Flag,
  type Kojo2CutoverStage,
} from './kojo2-cutover';

/**
 * 开关键（localStorage；与 `kojo.ui.*.v1` 同一套命名）。
 *
 * 现在只是**兼容键**：真源是阶段。常量与 `kojo2-cutover.ts` 的 `KOJO2_LEGACY_FLAG_KEY`
 * 是同一枚（这里 re-export，全仓没有第二份可漂移的字面量）。
 */
export const KOJO2_CUTOVER_KEY: string = KOJO2_LEGACY_FLAG_KEY;

/** 缺省 = 关（缺省阶段 `v1-only` ⇒ 2.0 面不挂；见模块头「单源」） */
export const KOJO2_CUTOVER_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读一格原始字符串（读抛错 / 没 window 一律 null） */
function readRaw(s: Storage | null, key: string): string | null {
  if (s === null) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 盘上计划的解析缓存（`原始串 → 阶段`）。
 *
 * 为什么要有：`kojo2OwnsDiagnostics` 这类判据在**每次击键**上问一次开关，而计划文档还带着
 * override 表——每次 `JSON.parse` 是白烧主线程。这里按"这一格原始串有没有变"决定要不要
 * 重解析：没变就只花一次 `getItem`（与改动前的旧布尔键同量级），变了才解析一次。
 * `undefined` = 还没读过；`null` = 读过、盘上没有/读不了。
 */
let cachedPlanRaw: string | null | undefined;
let cachedPlanStage: Kojo2CutoverStage | null = null;

/** 盘上阶段（带原始串缓存；坏值 = null） */
function persistedStage(s: Storage | null): Kojo2CutoverStage | null {
  const raw = readRaw(s, KOJO2_CUTOVER_STORAGE_KEY);
  if (raw !== cachedPlanRaw) {
    cachedPlanRaw = raw;
    cachedPlanStage = parseKojo2CutoverStage(raw);
  }
  return cachedPlanStage;
}

/**
 * 当前**生效阶段**（本模块唯一的状态解析入口）。
 *
 * 每次现读、不做模块级阶段缓存：真源是盘上计划 + 控制器，devtools / 设置页改了立即反映在
 * **下一处读取**上。解析顺序见模块头（盘上计划 → 旧布尔键 → 控制器 → `v1-only`），其中
 * 旧键只在"计划缺席或计划还是缺省档 `v1-only`"时生效（{@link stageFromLegacyKojo2Flag}）。
 */
export function resolveKojo2CutoverStage(): Kojo2CutoverStage {
  const s = storage();
  const persisted = persistedStage(s);
  const migrated = stageFromLegacyKojo2Flag(readRaw(s, KOJO2_CUTOVER_KEY));
  if (migrated !== null && (persisted === null || persisted === 'v1-only')) return migrated;
  if (persisted !== null) return persisted;
  return getKojo2CutoverController().getStage();
}

/**
 * 开关读数 = **阶段是否允许 2.0 面**（`v1-only` = 关，其余两档 = 开）。
 *
 * 语义与改动前逐字兼容（布尔、缺省关、坏值不翻成开），只是判据换成阶段 ⇒ 设置页把档位
 * 切到 `dual` 后，所有既有 flag 守卫（语言面 / 主题 / 诊断 / 预览 / 拖放 / 快速打开）
 * **零改动**地跟着放行。
 */
export function isKojo2CutoverEnabled(): boolean {
  return kojo2StageAllowsSurface(resolveKojo2CutoverStage());
}

/** 变更订阅表（`set` / 阶段变化后逐一通知；设置页 / 调试面板订这张表） */
const listeners = new Set<() => void>();

/** 阶段变化的桥（第一次有人订阅才挂；最后一个订阅者走了就摘，零常驻监听） */
let controllerBridge: (() => void) | null = null;

/** 通知本模块的订阅者（拷贝一份再遍历：订阅者里取消订阅不会打乱本次通知） */
function notifyAll(): void {
  for (const listener of [...listeners]) listener();
}

/** 懒挂阶段桥：控制器变化 ⇒ 本模块订阅者（同一份快照语义，不另造缓存） */
function ensureControllerBridge(): void {
  if (controllerBridge !== null) return;
  controllerBridge = getKojo2CutoverController().subscribe(() => {
    notifyAll();
  });
}

/**
 * 写开关 + 通知订阅者（**兼容垫片**：真源是阶段）。
 *
 * - 开 ⇒ 旧键写 `'on'`，阶段至少推到 `dual`（已经是 `2.0-default` 不降级）；
 * - 关 ⇒ 删旧键，阶段回 `v1-only`；
 * - 写不进去（隐私模式 / 配额满）静默降级为"本次会话不生效"，但**绝不抛进渲染链**。
 *
 * 通知只走一条路：阶段真变了由控制器 emit → 桥 → 订阅者（恰一次）；阶段没变（例如在
 * `dual` 上再开一次）补一次直接通知，保持改动前"每次写入都通知"的口径。
 */
export function setKojo2CutoverEnabled(on: boolean): void {
  const controller = getKojo2CutoverController();
  const before = controller.getStage();
  const next: Kojo2CutoverStage = on ? (before === 'v1-only' ? 'dual' : before) : 'v1-only';
  if (next !== before) controller.setStage(next); // 显式改档：旧键会被退役

  // 旧键**最后**写：阶段提交会退役旧键，先写后提交等于白写。开 ⇒ 写 `'on'`（旧读者仍看得见），
  // 关 ⇒ 删（不留 `off` 残值，与本仓布尔偏好同一口径）。
  const s = storage();
  if (s) {
    try {
      if (on) s.setItem(KOJO2_CUTOVER_KEY, 'on');
      else s.removeItem(KOJO2_CUTOVER_KEY);
    } catch {
      /* 隐私模式 / 配额满：只丢掉这一次选择，不抛 */
    }
  }

  // 阶段真变了 ⇒ 控制器 emit 已经经桥通知过（恰一次）；没变（例如在 dual 上再开一次）
  // 补一次直接通知，保持改动前"每次写入都通知"的口径。
  if (next === before) notifyAll();
}

/**
 * 删掉旧布尔键（**恢复出厂**用；真源阶段由控制器 `reset()` 另行清）。
 *
 * 只删这一格 + 通知：计划一旦被重置删掉，旧键 `'on'` 会重新把解析拉回 `dual`，所以
 * "恢复出厂"必须两件一起做（设置页就是 `clearKojo2CutoverLegacyFlag()` + `reset()`）。
 */
export function clearKojo2CutoverLegacyFlag(): void {
  const s = storage();
  if (s) {
    try {
      s.removeItem(KOJO2_CUTOVER_KEY);
    } catch {
      /* 读不到 / 删不掉：本次会话按内存阶段走，不抛 */
    }
  }
  notifyAll();
}

/**
 * 订阅开关变化（返回取消订阅函数；组件卸载时必须取消）。
 *
 * 除了本模块自己的写入，**阶段切换**（设置页 / devtools / 控制器 advance / rollback）也会
 * 通知：第一次有人订阅时懒挂一条控制器桥，最后一个订阅者取消时摘掉——没人看的时候
 * 一个监听都不挂（与"没有任何 2.0 面"时逐字等价）。
 */
export function subscribeKojo2Cutover(listener: () => void): () => void {
  ensureControllerBridge();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && controllerBridge !== null) {
      const off = controllerBridge;
      controllerBridge = null;
      off();
    }
  };
}
