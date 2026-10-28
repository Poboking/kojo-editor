/**
 * Kojo 2.0 **切流开关**（K2-EDITOR-WIRE）——由三态阶段派生，语言面不读它。
 *
 * ## 管什么
 *
 * 只答两件事：
 * 1. {@link isKojo2CutoverEnabled}：2.0 **工具链**开没开（写回 / 迁移入口 / 存储服务 /
 *    per-file override 的阶段闸）。`v1-only` = 关，`dual` / `2.0-default` = 开；
 * 2. {@link isKojoLegacySyntaxEnabled}：kojo1（封存层）开没开。`2.0-default` = 关。
 *
 * **解析器不归它管**（LAU-3b-FLIP）：`.kojo` / `.kojo2` 恒归 2.0，`.kojo1` 恒归 kojo1，
 * 只看扩展名、不看阶段、不嗅正文。语言面（着色 / 补全 / 诊断 / 缩进 / 格式化…）在
 * `languages.ts` 无条件登记，也不在这里长第二枚守卫。
 *
 * ## 单源与解析顺序
 *
 * 真源是 `kojo2-cutover.ts` 的三态阶段。解析顺序（写死，`kojo2-cutover-stage.test.ts` 钉住）：
 * 盘上计划 → 旧布尔键 `'on'`（视作 `dual`，只在计划缺席 / 停在 `v1-only` / 是被抬上来的
 * v1 基线三种情形下说话）→ 控制器内存阶段 → 控制器默认档。
 *
 * ## 生效时机
 *
 * **现读即生效**：工具链守卫在每次调用时解析阶段；stage 变化经控制器订阅通知本模块的
 * 订阅者。启动时装配的那几件（kojo1 插件族 / 2.0 存储命令）不热装热卸——重开项目或
 * 重载窗口后才按新档来（设置页会如实写明，铁律 4）。
 *
 * 作者面文案不在这里：本模块是机器面，人话由 `ui/kojo2-cutover-settings.tsx` 产出。
 */

import {
  getKojo2CutoverController,
  kojo2StageAllowsLegacy,
  kojo2StageAllowsSurface,
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_LEGACY_FLAG_KEY,
  parseKojo2CutoverPlanStage,
  stageFromLegacyKojo2Flag,
  type Kojo2CutoverStage,
  type ParsedCutoverStage,
} from './kojo2-cutover';

/**
 * 开关键（localStorage；与 `kojo.ui.*.v1` 同一套命名）。
 *
 * 现在只是**兼容键**：真源是阶段。常量与 `kojo2-cutover.ts` 的 `KOJO2_LEGACY_FLAG_KEY`
 * 是同一枚（这里 re-export，全仓没有第二份可漂移的字面量）。
 */
export const KOJO2_CUTOVER_KEY: string = KOJO2_LEGACY_FLAG_KEY;

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
 * 盘上计划的解析缓存（`原始串 → 阶段 + 来历`）。
 *
 * 为什么要有：`kojo2OwnsDiagnostics` 这类判据在**每次击键**上问一次开关，而计划文档还带着
 * override 表——每次 `JSON.parse` 是白烧主线程。这里按"这一格原始串有没有变"决定要不要
 * 重解析：没变就只花一次 `getItem`（与改动前的旧布尔键同量级），变了才解析一次。
 * `undefined` = 还没读过；`null` = 读过、盘上没有/读不了。
 *
 * 缓存**整份解析结果**（不是只缓存阶段）：`liftedFromV1Baseline` 那一格决定旧布尔键能不能
 * 插手（判据见 `kojo2-cutover.ts::ParsedCutoverStage`），只缓存阶段就得再解析一遍。
 */
let cachedPlanRaw: string | null | undefined;
let cachedPlan: ParsedCutoverStage | null = null;

/** 盘上计划（带原始串缓存；坏值 = null） */
function persistedPlan(s: Storage | null): ParsedCutoverStage | null {
  const raw = readRaw(s, KOJO2_CUTOVER_STORAGE_KEY);
  if (raw !== cachedPlanRaw) {
    cachedPlanRaw = raw;
    cachedPlan = parseKojo2CutoverPlanStage(raw);
  }
  return cachedPlan;
}

/**
 * 当前**生效阶段**（本模块唯一的状态解析入口）。
 *
 * 每次现读、不做模块级阶段缓存：真源是盘上计划 + 控制器，devtools / 设置页改了立即反映在
 * **下一处读取**上。解析顺序见模块头（盘上计划 → 旧布尔键 → 控制器 → 默认档），其中旧键
 * 只在"计划缺席 / 计划停在 `v1-only` / 计划是被抬上来的 v1 基线"时生效
 * （{@link stageFromLegacyKojo2Flag}）——三条都与控制器的 `attachStorage` 同一份判据，
 * 两边不可能对同一份盘给出不同阶段。
 */
export function resolveKojo2CutoverStage(): Kojo2CutoverStage {
  const s = storage();
  const plan = persistedPlan(s);
  const migrated = stageFromLegacyKojo2Flag(readRaw(s, KOJO2_CUTOVER_KEY));
  if (migrated !== null && plan === null) return migrated;
  if (plan !== null && migrated !== null && (plan.liftedFromV1Baseline || plan.stage === 'v1-only')) {
    return migrated;
  }
  if (plan !== null) return plan.stage;
  return getKojo2CutoverController().getStage();
}

/**
 * 开关读数 = **阶段是否允许 2.0 的切流语义**（`v1-only` = 关，其余两档 = 开）。
 *
 * 语义与改动前逐字兼容（布尔、坏值不翻成开），只是判据换成阶段 ⇒ 设置页把档位切到 `dual`
 * 后，所有既有 flag 守卫（写回 / 迁移 / 存储服务 / per-file override 的阶段闸）
 * **零改动**地跟着放行。默认档翻到 `2.0-default` 之后（LAU-3），这一格**默认即为真**。
 *
 * **语言面不读这里**：`.kojo` / `.kojo2` 的 descriptor 无条件登记，本读数只决定
 * "要不要写回 / 迁移 / 放行 override"。
 */
export function isKojo2CutoverEnabled(): boolean {
  return kojo2StageAllowsSurface(resolveKojo2CutoverStage());
}

/**
 * kojo1（**封存层**）此刻开没开（LAU-3 的唯一读点；判据在
 * `kojo2-cutover.ts::kojo2StageAllowsLegacy`，这里只做阶段解析）。
 *
 * `v1-only` / `dual` = 开；`2.0-default`（默认）= 关 ⇒ `.kojo1` 认不出、落纯文本，
 * `.kojo 预览`（糖投影）与设置页那一行开关一起封。
 *
 * **四个消费方共用这一枚**，谁都不许自己抄阶段名：
 * ① 语言可用性门（`monaco/language-registry.ts` 的**缺省**谓词——门住注册表里，
 *    见那边的头注）；
 * ② `ui/sugar-view.ts::sugarViewAllowed` 的 `legacySyntaxOn`；
 * ③ `ui/ShellLayout.tsx` 的语言菜单 / 状态栏芯片（封存档标灰 + 说原因）；
 * ④ `ui/SettingsPanel.tsx` 的 `.kojo 预览` 那一行（禁用而非隐藏：偏好值保留，
 *    作者切回 `dual` 就照旧生效）。
 */
export function isKojoLegacySyntaxEnabled(): boolean {
  return kojo2StageAllowsLegacy(resolveKojo2CutoverStage());
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
