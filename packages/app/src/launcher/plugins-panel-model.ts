/**
 * 启动器 · 实例详情「游戏插件」面板 —— **纯函数层**（车道 UI-PLUGINS）。
 *
 * 分工与 `content-panel-model.ts` / `saves-panel-model.ts` 同一条纪律：视图
 * （`plugins-panel.tsx`）只做取数、订阅与命令调用；凡是「把读数变成人话」「这道门该不该开」
 * 的判断都住这里——纯函数、零 React、零 IO、零磁盘知识。
 *
 * ## 本层不造第二份真源
 *
 * - 冲突的合法决议由 `launcher-core/plugin-manager.ts::resolveConflictDecisions` 定：
 *   `other-pack` 只接受 `skip` / `replace`（`overwrite` 不转移归属 ⇒ 会被拒）、
 *   `base-file` 只接受 `skip` / `overwrite`、函数冲突只接受 `skip` / `replace`
 *   （`overwrite` 会被拒）。本层只把这套规则投影成按钮，不另立宽容口径；
 * - 任务进度 / 字节 / 通用错误建议复用 `./model`（`taskProgressView` / `formatBytes` /
 *   `describeFailure` / `launcherErrorHint`）；
 * - 诊断的码表就是契约 `PluginDiagnosis.issues[].code` 的七项（内容包四项 + 函数覆盖 /
 *   不兼容 / 加载顺序）：逐码归组，未知码进「其它」而不静默丢弃；
 * - 风险档位、存档影响、信任态的名词表逐字对齐契约注释（§6.7 / §10.4），不自己发明档位。
 *
 * ## 契约缺口（已上报，不擅自扩 `plugin-api`）
 *
 * 1. **「预期重复」没有字段**：`plugin-manager.ts::analyzeFunctionConflicts` 命中 adapter
 *    `conventionPolicy` 的条目**不进** `Plan.functionConflicts`，只在 `plan.warnings` 里留
 *    一行「已按适配器约定策略收敛 N 处预期重复：<理由>」。本层把 `warnings` 原样展示，
 *    并在计划读数旁写一句说明；**没有**拿 `functionConflicts.length` 去冒充「真冲突 + 预期重复」。
 * 2. **`PluginTrust` 没有 `approvedAt` / `approvedBy`**：core 的信任记录加性补了这两个字段，
 *    但契约类型里没有。本层只读契约字段（`state` / `publisher` / `signedAt`），
 *    不探测加性字段——避免把实现细节带进界面口径。
 * 3. **`PluginManager` 没有 `trust` / `untrust`**：风险 `unknown` 的插件在 core 侧要求先经
 *    原生确认框批准（`applyInstall` 会以 `LAUNCHER_PLUGIN_UNTRUSTED` 拒）。本层不伪造
 *    这条授权面：界面上用「高风险确认」勾选表达用户已知情，真正能否落盘由 core 裁决，
 *    被拒时按原码原话展示并给出下一步。
 * 4. **`InstalledPlugin` 没有存档影响 / 兼容性判定读数**：已装列表只能看到 `status`
 *    （`incompatible` 一档），所以兼容徽标对「没记录」如实写「兼容性未记录」，
 *    不拿「正常」冒充「兼容」。
 */

import type {
  FunctionConflict,
  InstalledPlugin,
  LauncherTask,
  PluginApplyOptions,
  PluginCompatibility,
  PluginConflictResolution,
  PluginDiagnosis,
  PluginInstallPlan,
  PluginRisk,
  TaskState,
} from '@kojo/plugin-api';
import { byCodePoint } from '../ui/commands';
import {
  describeFailure,
  formatBytes,
  taskProgressView,
  type FailureView,
  type LauncherTone,
} from './model';

/* ══════════════════════════════════════════════════════════════════════════════
 * 名词 → 中文
 * ══════════════════════════════════════════════════════════════════════════════ */

const RISK_LABELS: Readonly<Record<PluginRisk, string>> = {
  'content-only': '仅内容',
  'extends-logic': '扩展逻辑',
  'overrides-logic': '覆盖逻辑',
  unknown: '风险未知',
};

const RISK_TONES: Readonly<Record<PluginRisk, LauncherTone>> = {
  'content-only': 'ok',
  'extends-logic': 'busy',
  'overrides-logic': 'warn',
  unknown: 'warn',
};

/** 风险档位的人话；未知值回显原值（宿主给了新版没登记的档位时要看得见） */
export function pluginRiskLabel(risk: PluginRisk | string): string {
  return RISK_LABELS[risk as PluginRisk] ?? `未知风险（${risk}）`;
}

export function pluginRiskTone(risk: PluginRisk | string): LauncherTone {
  return RISK_TONES[risk as PluginRisk] ?? 'warn';
}

/**
 * 「高风险」= 会覆盖既有逻辑，或无法归类。
 *
 * 这是**界面的默认拒绝线**：高风险计划即使一切决议齐了，也要用户额外勾选一行确认
 * 才允许点「开始安装」（§10.4：`unknown` 按最高风险展示，装前必须显式确认）。
 */
export function isHighRisk(risk: PluginRisk | string): boolean {
  return risk === 'overrides-logic' || risk === 'unknown';
}

const TRUST_LABELS: Readonly<Record<InstalledPlugin['trust']['state'], string>> = {
  verified: '已验签',
  unverified: '未验签',
  unknown: '信任未知',
};

const TRUST_TONES: Readonly<Record<InstalledPlugin['trust']['state'], LauncherTone>> = {
  verified: 'ok',
  unverified: 'idle',
  unknown: 'warn',
};

export function trustLabel(state: InstalledPlugin['trust']['state'] | string): string {
  return TRUST_LABELS[state as InstalledPlugin['trust']['state']] ?? `未知信任态（${state}）`;
}

export function trustTone(state: InstalledPlugin['trust']['state'] | string): LauncherTone {
  return TRUST_TONES[state as InstalledPlugin['trust']['state']] ?? 'warn';
}

/** 信任行的一句补充（发布者 / 签名时间；都没有就说没有，不编一个「官方」） */
export function trustDetail(trust: InstalledPlugin['trust']): string {
  const publisher = trust.publisher === null ? '发布者未记录' : `发布者：${trust.publisher}`;
  if (trust.signedAt === null) return `${publisher} · 首版没有签名验证`;
  return `${publisher} · 签名时间 ${trust.signedAt}`;
}

const SAVE_IMPACT_LABELS: Readonly<
  Record<PluginInstallPlan['saveImpact'], { label: string; detail: string; tone: LauncherTone }>
> = {
  none: { label: '无存档影响', detail: '清单声明不会动存档；应用前不额外备份。', tone: 'ok' },
  possible: {
    label: '可能影响存档',
    detail: '应用前会先自动备份存档（reason=pre-plugin），备份失败即中止。',
    tone: 'warn',
  },
  unknown: {
    label: '存档影响未知',
    detail: '按最坏情况处理：应用前会先自动备份存档，备份失败即中止。',
    tone: 'warn',
  },
};

export function saveImpactLabel(impact: PluginInstallPlan['saveImpact'] | string): string {
  return (
    SAVE_IMPACT_LABELS[impact as PluginInstallPlan['saveImpact']]?.label ??
    `未知存档影响（${impact}）`
  );
}

export function saveImpactDetail(impact: PluginInstallPlan['saveImpact'] | string): string {
  return (
    SAVE_IMPACT_LABELS[impact as PluginInstallPlan['saveImpact']]?.detail ??
    '这个档位不在契约的三档里：按「可能影响存档」保守处理。'
  );
}

export function saveImpactTone(impact: PluginInstallPlan['saveImpact'] | string): LauncherTone {
  return SAVE_IMPACT_LABELS[impact as PluginInstallPlan['saveImpact']]?.tone ?? 'warn';
}

export interface CompatibilityView {
  readonly label: string;
  readonly tone: LauncherTone;
  /** 谁判的（adapter / 仅清单声明 / 未判定）——避免「看清单以为兼容」 */
  readonly checkedByLabel: string;
  readonly reasons: readonly string[];
  readonly detail: string;
}

const CHECKED_BY_LABELS: Readonly<Record<PluginCompatibility['checkedBy'], string>> = {
  adapter: '适配器判定',
  declared: '仅按清单声明',
  none: '未判定',
};

export function compatibilityView(compat: PluginCompatibility): CompatibilityView {
  const label = compat.ok ? '兼容' : '不兼容';
  const reasons = compat.reasons.filter((reason) => reason.trim() !== '');
  const versions = `游戏版本 ${compat.gameVersion ?? '未知'} · 插件要求 ${compat.requiredGameVersion ?? '未声明'} · 接口版本 ${compat.apiVersion ?? '未声明'}`;
  return {
    label,
    tone: compat.ok ? 'ok' : 'warn',
    checkedByLabel: CHECKED_BY_LABELS[compat.checkedBy] ?? `未知判定来源（${compat.checkedBy}）`,
    reasons,
    detail: `${versions} · 判定：${CHECKED_BY_LABELS[compat.checkedBy] ?? compat.checkedBy}`,
  };
}

/** 已装插件的兼容徽标：只有 `status === 'incompatible'` 是**有记录**的判定，其余如实写「未记录」 */
export function installedCompatibility(plugin: InstalledPlugin): {
  readonly label: string;
  readonly tone: LauncherTone;
} {
  return plugin.status === 'incompatible'
    ? { label: '不兼容', tone: 'warn' }
    : { label: '兼容性未记录', tone: 'idle' };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 已装列表：一行一个插件
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface PluginRowView {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly riskLabel: string;
  readonly riskTone: LauncherTone;
  readonly highRisk: boolean;
  readonly enabled: boolean;
  readonly enabledLabel: string;
  readonly enabledTone: LauncherTone;
  readonly statusLabel: string;
  readonly statusTone: LauncherTone;
  readonly compatibilityLabel: string;
  readonly compatibilityTone: LauncherTone;
  readonly trustLabel: string;
  readonly trustTone: LauncherTone;
  readonly trustDetail: string;
  readonly requiresRestart: boolean;
  readonly order: number;
  readonly rank: number;
  readonly fileCount: number;
  readonly canOpenSource: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

const PLUGIN_STATUS_LABELS: Readonly<
  Record<InstalledPlugin['status'], { label: string; tone: LauncherTone }>
> = {
  ok: { label: '正常', tone: 'ok' },
  conflict: { label: '有冲突', tone: 'warn' },
  incompatible: { label: '不兼容', tone: 'warn' },
  broken: { label: '已损坏', tone: 'warn' },
};

/** 排序键：先 `order`，同序号按名称 / id 码点序（并列 = 加载次序不确定，诊断会点名） */
function sortPlugins(plugins: readonly InstalledPlugin[]): InstalledPlugin[] {
  return [...plugins].sort(
    (a, b) =>
      a.order - b.order ||
      byCodePoint(a.manifest.name, b.manifest.name) ||
      byCodePoint(a.manifest.id, b.manifest.id),
  );
}

export function pluginRows(plugins: readonly InstalledPlugin[]): readonly PluginRowView[] {
  const sorted = sortPlugins(plugins);
  return sorted.map((plugin, index) => {
    const status = PLUGIN_STATUS_LABELS[plugin.status] ?? {
      label: `未知状态（${String(plugin.status)}）`,
      tone: 'warn' as LauncherTone,
    };
    const compat = installedCompatibility(plugin);
    return {
      pluginId: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      riskLabel: pluginRiskLabel(plugin.risk),
      riskTone: pluginRiskTone(plugin.risk),
      highRisk: isHighRisk(plugin.risk),
      enabled: plugin.enabled,
      enabledLabel: plugin.enabled ? '已启用' : '已停用',
      enabledTone: plugin.enabled ? 'ok' : 'idle',
      statusLabel: status.label,
      statusTone: status.tone,
      compatibilityLabel: compat.label,
      compatibilityTone: compat.tone,
      trustLabel: trustLabel(plugin.trust.state),
      trustTone: trustTone(plugin.trust.state),
      trustDetail: trustDetail(plugin.trust),
      requiresRestart: plugin.requiresRestart,
      order: plugin.order,
      rank: index + 1,
      fileCount: plugin.ownedFiles.length,
      canOpenSource: plugin.sourceProjectId !== null,
      canMoveUp: index > 0,
      canMoveDown: index < sorted.length - 1,
    };
  });
}

/**
 * 上移 / 下移一位后的**完整 id 排列**（`null` = 已在边界 / id 不存在）。
 *
 * 与内容包同一条口径：`PluginManager.setOrder` 只接受已装 id 的排列，交整份最不容易
 * 出现「只挪了一侧」的半截状态。
 */
export function movePluginOrder(
  plugins: readonly InstalledPlugin[],
  pluginId: string,
  direction: -1 | 1,
): readonly string[] | null {
  const ids = sortPlugins(plugins).map((plugin) => plugin.manifest.id);
  const index = ids.indexOf(pluginId);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= ids.length) return null;
  const next = [...ids];
  const moved = ids[index] as string;
  const displaced = ids[target] as string;
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 行内确认文案
 * ══════════════════════════════════════════════════════════════════════════════ */

export type PluginRowConfirmKind = 'uninstall' | 'disable' | 'enable' | 'order';

export interface PluginRowConfirmInput {
  readonly kind: PluginRowConfirmKind;
  readonly name: string;
  readonly direction?: 'up' | 'down';
  readonly fileCount?: number;
}

export function pluginRowConfirmText(input: PluginRowConfirmInput): string {
  const count =
    input.fileCount === undefined ? '本包写入的文件' : `本包写入的 ${input.fileCount} 个文件`;
  switch (input.kind) {
    case 'uninstall':
      return `卸载「${input.name}」？只删${count}；别的包或基础游戏写过的同名文件不动，游戏存档不删（插件写过存档数据时，旧存档可能读不出）。`;
    case 'disable':
      return `停用「${input.name}」？本包写入的文件会被撤下、恢复安装前的原文件（下次启动游戏生效）。`;
    case 'enable':
      return `启用「${input.name}」？会重新写入本包的文件并重跑冲突检查（下次启动游戏生效）。`;
    case 'order':
      return `把「${input.name}」${input.direction === 'up' ? '上移' : '下移'}一位？加载顺序会变，下次启动游戏生效。`;
    default:
      return `确认对「${input.name}」执行这项操作？`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 安装计划读数
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface PlanFactRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: LauncherTone;
}

export interface PlanReadout {
  readonly title: string;
  readonly subtitle: string;
  readonly modeLabel: string;
  readonly rows: readonly PlanFactRow[];
  readonly entryCount: number;
  readonly byteTotal: number;
  readonly expired: boolean;
  readonly expiresText: string;
  readonly riskLabel: string;
  readonly riskTone: LauncherTone;
  readonly highRisk: boolean;
  readonly needsSaveAck: boolean;
  readonly needsIncompatibleAck: boolean;
  readonly compatibility: CompatibilityView;
}

function durationText(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 安装计划 → 可渲染读数。
 *
 * 数字逐条来自计划本体（`manifest.files` / `additions` / `overwrites` / `conflicts` /
 * `functionConflicts`），不估算：§10.1 要求「展示的数量与实际应用必须逐条对得上」。
 * `expiresAt` 读不出来按**已过期**处理（陈旧 applies 是这条管线最贵的一种错）。
 */
export function planReadout(plan: PluginInstallPlan, nowMs: number = Date.now()): PlanReadout {
  const entryCount = plan.manifest.files.length;
  const byteTotal = plan.manifest.files.reduce(
    (sum, file) => sum + (Number.isFinite(file.size) && file.size > 0 ? file.size : 0),
    0,
  );
  const deadline = Date.parse(plan.expiresAt);
  const remaining = Number.isFinite(deadline) ? deadline - nowMs : Number.NaN;
  const expired = !Number.isFinite(remaining) || remaining <= 0;
  const expiresText = !Number.isFinite(remaining)
    ? '计划的过期时刻不可读：请重新预检'
    : expired
      ? `计划已过期（${plan.expiresAt}），需要重新预检`
      : `计划还有 ${durationText(remaining)} 到期（${plan.expiresAt}）`;
  const targets =
    plan.targets.length === 0
      ? '（无目标根）'
      : plan.targets.map((target) => target.rootId).join('、');
  const compatibility = compatibilityView(plan.compatibility);
  const highRisk = isHighRisk(plan.risk);

  const rows: PlanFactRow[] = [
    { label: '版本', value: plan.manifest.version },
    { label: '方式', value: plan.mode === 'upgrade' ? '升级（保留启停与顺序）' : '新装' },
    { label: '目标根', value: targets },
    { label: '条目', value: `${entryCount} 个文件 · ${formatBytes(byteTotal)}` },
    { label: '新增', value: `${plan.additions.length} 个` },
    {
      label: '覆盖',
      value: `${plan.overwrites.length} 个`,
      ...(plan.overwrites.length > 0 ? { tone: 'warn' as LauncherTone } : {}),
    },
    {
      label: '文件冲突',
      value: `${plan.conflicts.length} 条`,
      ...(plan.conflicts.length > 0 ? { tone: 'warn' as LauncherTone } : {}),
    },
    {
      label: '函数冲突',
      value: `${plan.functionConflicts.length} 条真冲突`,
      ...(plan.functionConflicts.length > 0 ? { tone: 'warn' as LauncherTone } : {}),
    },
    { label: '兼容性', value: compatibility.label, tone: compatibility.tone },
    {
      label: '存档影响',
      value: saveImpactLabel(plan.saveImpact),
      tone: saveImpactTone(plan.saveImpact),
    },
    { label: '风险', value: pluginRiskLabel(plan.risk), tone: pluginRiskTone(plan.risk) },
    { label: '过期', value: expiresText, ...(expired ? { tone: 'warn' as LauncherTone } : {}) },
  ];

  return {
    title: `${plan.manifest.name}（${plan.manifest.version}）`,
    subtitle: `${plan.manifest.id} · 目标根 ${targets}`,
    modeLabel: plan.mode === 'upgrade' ? '升级' : '新装',
    rows,
    entryCount,
    byteTotal,
    expired,
    expiresText,
    riskLabel: pluginRiskLabel(plan.risk),
    riskTone: pluginRiskTone(plan.risk),
    highRisk,
    needsSaveAck: plan.saveImpact !== 'none',
    needsIncompatibleAck: !plan.compatibility.ok,
    compatibility,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 冲突 → 逐条决议（合法性口径与 launcher-core 同源）
 * ══════════════════════════════════════════════════════════════════════════════ */

export type PluginAction = 'skip' | 'overwrite' | 'replace';

export interface ConflictOption {
  readonly action: PluginAction;
  readonly label: string;
  readonly hint: string;
}

export interface FileConflictRowView {
  readonly key: string;
  readonly path: string;
  readonly kind: 'other-pack' | 'base-file';
  readonly kindLabel: string;
  readonly ownerLabel: string;
  readonly options: readonly ConflictOption[];
}

export interface FunctionConflictRowView {
  readonly key: string;
  readonly functionName: string;
  readonly existingLabel: string;
  readonly incomingLabel: string;
  readonly options: readonly ConflictOption[];
}

const SKIP_HINT = '保留磁盘上现有的那一份，本包这次不写这个文件（包里其余文件照常安装）。';
const REPLACE_HINT = '先备份旧定义所在文件，再覆盖；函数冲突下会覆盖既有定义。';
const REPLACE_OWNER_HINT = '把这条路径的拥有权从那个包转到本包：那个包卸载时就不会再删它。';
const OVERWRITE_HINT = '这是基础游戏文件：会先备份原文件再覆盖，卸载时按备份恢复。';

export function fileConflictKey(ref: {
  readonly rootId: string;
  readonly path: string;
}): string {
  return `${ref.rootId}/${ref.path}`;
}

/** 文件冲突的决议键（与 core 的 `decisionKey` 同一形状：`file|root/path`，大小写无关由 core 兜） */
export function fileConflictDecisionKey(ref: {
  readonly rootId: string;
  readonly path: string;
}): string {
  return `file|${fileConflictKey(ref)}`;
}

/** 函数冲突的决议键（与 core 的 `decisionKey` 同一形状：`function|归一化名`） */
export function functionConflictDecisionKey(functionName: string): string {
  return `function|${functionName.toUpperCase()}`;
}

/**
 * 一条文件冲突的法律选项。
 *
 * `other-pack` 只给 `replace`（转移归属）：`overwrite` 不转移拥有权、core 会直接拒；
 * `base-file` 只给 `overwrite`：`replace` 没有「从谁手里拿」的对象。
 */
export function fileConflictOptions(
  conflict: Pick<PluginInstallPlan['conflicts'][number], 'kind'>,
): readonly ConflictOption[] {
  if (conflict.kind === 'other-pack') {
    return [
      { action: 'skip', label: '跳过', hint: SKIP_HINT },
      { action: 'replace', label: '替换（接管归属）', hint: REPLACE_OWNER_HINT },
    ];
  }
  return [
    { action: 'skip', label: '跳过', hint: SKIP_HINT },
    { action: 'overwrite', label: '覆盖（先备份）', hint: OVERWRITE_HINT },
  ];
}

/**
 * 函数冲突只给 `skip` / `replace`：`overwrite` 在 core 里被显式拒（契约注释 + 实现一致）。
 *
 * `skip` 的代价要说清：宿主没有「只跳一个函数」的写盘能力，core 会把**该函数所在文件
 * 整份跳过**（`resolveConflictDecisions` 的既有取舍），所以按钮文案直接写「整份文件跳过」。
 */
export function functionConflictOptions(): readonly ConflictOption[] {
  return [
    { action: 'skip', label: '保留既有（整份文件跳过）', hint: `${SKIP_HINT}函数级 skip 会连该函数所在文件整份跳过。` },
    { action: 'replace', label: '覆盖（先备份）', hint: REPLACE_HINT },
  ];
}

export function fileConflictRows(
  plan: Pick<PluginInstallPlan, 'conflicts'>,
): readonly FileConflictRowView[] {
  return plan.conflicts.map((conflict) => ({
    key: fileConflictDecisionKey(conflict),
    path: fileConflictKey(conflict),
    kind: conflict.kind,
    kindLabel: conflict.kind === 'other-pack' ? '撞别的包' : '撞基础游戏文件',
    ownerLabel:
      conflict.existingPackId === null
        ? '现有这一份不属于任何已装包'
        : `现有这一份属于 ${conflict.existingPackId}`,
    options: fileConflictOptions(conflict),
  }));
}

export function functionConflictRows(
  plan: Pick<PluginInstallPlan, 'functionConflicts'>,
): readonly FunctionConflictRowView[] {
  return plan.functionConflicts.map((conflict: FunctionConflict) => ({
    key: functionConflictDecisionKey(conflict.functionName),
    functionName: conflict.functionName,
    existingLabel: `${conflict.existing.pluginId === null ? '基础游戏' : conflict.existing.pluginId} · ${conflict.existing.path}:${conflict.existing.line}`,
    incomingLabel: `${conflict.incoming.path}:${conflict.incoming.line}`,
    options: functionConflictOptions(),
  }));
}

export interface ResolutionBuild {
  readonly resolutions: readonly PluginConflictResolution[];
  readonly pending: readonly string[];
}

/**
 * 用户选择 → `PluginConflictResolution[]`。
 *
 * 逐条收集（契约没有 `abort`，取消整装走 UI 的「取消安装」）：漏一条 core 就会整包拒绝，
 * 所以这里先把漏项算出来，让按钮在点之前就是灰的。
 */
export function buildResolutions(
  plan: Pick<PluginInstallPlan, 'conflicts' | 'functionConflicts'>,
  choices: Readonly<Record<string, PluginAction>>,
): ResolutionBuild {
  const resolutions: PluginConflictResolution[] = [];
  const pending: string[] = [];
  for (const conflict of plan.conflicts) {
    const key = fileConflictDecisionKey(conflict);
    const action = choices[key];
    const legal = fileConflictOptions(conflict).some((option) => option.action === action);
    if (action === undefined || !legal) {
      pending.push(key);
      continue;
    }
    resolutions.push({ rootId: conflict.rootId, path: conflict.path, action });
  }
  for (const conflict of plan.functionConflicts) {
    const key = functionConflictDecisionKey(conflict.functionName);
    const action = choices[key];
    const legal = functionConflictOptions().some((option) => option.action === action);
    if (action === undefined || !legal) {
      pending.push(key);
      continue;
    }
    resolutions.push({ functionName: conflict.functionName, action });
  }
  return { resolutions, pending };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 应用门禁：默认拒绝，用户逐项显式勾选才放行
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ApplyGateInputs {
  /** 高风险确认（`overrides-logic` / `unknown` 必须勾） */
  readonly acknowledgeRisk: boolean;
  /** 兼容性不通过仍安装（对应 `PluginApplyOptions.allowIncompatible`） */
  readonly allowIncompatible: boolean;
  /** 已知存档影响（对应 `PluginApplyOptions.acknowledgeSaveImpact`） */
  readonly acknowledgeSaveImpact: boolean;
}

export const INITIAL_GATE: ApplyGateInputs = {
  acknowledgeRisk: false,
  allowIncompatible: false,
  acknowledgeSaveImpact: false,
};

export interface ApplyGateView {
  readonly expired: boolean;
  readonly pendingCount: number;
  readonly needsIncompatible: boolean;
  readonly needsSaveImpact: boolean;
  readonly needsRisk: boolean;
  readonly blockers: readonly string[];
  readonly canApply: boolean;
}

/**
 * 「现在能不能点开始安装」。
 *
 * 四条默认拒绝线（任一未满足 ⇒ 按钮灰、原因逐条列出）：
 * 1. 计划过期 / 冲突没决断 / 依赖缺失（core 会拒）；
 * 2. 兼容性不通过且未勾「仍然安装」；
 * 3. 高风险且未勾确认；
 * 4. `saveImpact != 'none'` 且未勾「已知晓存档影响」（core 的备份闸必需这一项）。
 */
export function applyGate(
  plan: PluginInstallPlan,
  built: ResolutionBuild,
  inputs: ApplyGateInputs,
  nowMs: number = Date.now(),
): ApplyGateView {
  const readout = planReadout(plan, nowMs);
  const needsIncompatible = !plan.compatibility.ok;
  const needsSaveImpact = plan.saveImpact !== 'none';
  const needsRisk = isHighRisk(plan.risk);
  const blockers: string[] = [];
  if (readout.expired) blockers.push('计划已过期：重新预检后再安装。');
  if (built.pending.length > 0) {
    blockers.push(`还有 ${built.pending.length} 条冲突没决断：逐条选「跳过」或「替换 / 覆盖」再安装。`);
  }
  if (plan.missingRequirements.length > 0) {
    blockers.push(
      `依赖未满足：${plan.missingRequirements.join('、')}（首版不自动下载依赖，应用会被拒绝）。`,
    );
  }
  if (needsIncompatible && !inputs.allowIncompatible) {
    blockers.push('兼容性判定不通过：勾选「仍然安装不兼容插件」后才能继续。');
  }
  if (needsRisk && !inputs.acknowledgeRisk) {
    blockers.push(`这是「${pluginRiskLabel(plan.risk)}」插件：勾选高风险确认后才能写盘。`);
  }
  if (needsSaveImpact && !inputs.acknowledgeSaveImpact) {
    blockers.push('这个插件可能影响存档：勾选「已知晓存档影响」后才能继续（应用前会先备份存档）。');
  }
  return {
    expired: readout.expired,
    pendingCount: built.pending.length,
    needsIncompatible,
    needsSaveImpact,
    needsRisk,
    blockers,
    canApply: blockers.length === 0,
  };
}

/**
 * 勾选 → `PluginApplyOptions`。
 *
 * **不勾就不传这个字段**（缺省语义归契约，本层不把默认值抄一遍）；三项都没勾
 * ⇒ `undefined`，`applyInstall` 收到的是「什么都没越闸」。
 */
export function applyOptions(
  plan: PluginInstallPlan,
  inputs: ApplyGateInputs,
): PluginApplyOptions | undefined {
  const options: PluginApplyOptions = {
    ...(plan.compatibility.ok ? {} : { allowIncompatible: inputs.allowIncompatible }),
    ...(plan.saveImpact === 'none'
      ? {}
      : { acknowledgeSaveImpact: inputs.acknowledgeSaveImpact }),
  };
  const meaningful = Object.entries(options).filter(([, value]) => value === true);
  return meaningful.length === 0 ? undefined : options;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 任务 → 三态文案
 * ══════════════════════════════════════════════════════════════════════════════ */

const PLUGIN_TASK_LABELS: Readonly<Record<string, string>> = {
  'plugin-install': '安装插件',
  'plugin-uninstall': '卸载插件',
  'plugin-toggle': '切换插件启停',
  'content-install': '安装插件',
  'content-uninstall': '卸载插件',
  'content-toggle': '切换插件启停',
};

export interface PluginTaskView {
  readonly state: TaskState;
  readonly headline: string;
  readonly detail: string;
  readonly note: string;
  readonly tone: LauncherTone;
  readonly terminal: boolean;
  readonly cancellable: boolean;
  readonly errorText: string | null;
  readonly percent: number | null;
}

/**
 * 任务读数 → 进度 + 三态收尾话术。
 *
 * 插件落盘走宿主的内容管线，任务 `kind` 通常是 `content-*`；本表把同一件事按插件口径
 * 命名（「安装插件」而不是「安装内容包」）。失败 / 取消都意味着宿主走了逆序回滚。
 */
export function pluginTaskView(task: LauncherTask): PluginTaskView {
  const base = taskProgressView(task);
  const label = PLUGIN_TASK_LABELS[task.kind];
  const headline =
    label === undefined
      ? base.headline
      : task.state === 'queued'
        ? `排队等待：${label}`
        : task.state === 'running'
          ? `正在${label}…`
          : task.state === 'succeeded'
            ? `${label}完成`
            : task.state === 'failed'
              ? `${label}失败`
              : `${label}已取消`;
  const note =
    task.state === 'succeeded'
      ? '写盘完成：已装列表、启停状态与顺序以本面板刷新后的读数为准。'
      : task.state === 'failed'
        ? '宿主已按逆序回滚本次写入，磁盘上不应留下半成品；按上面的建议处理后可以重试。'
        : task.state === 'cancelled'
          ? '已取消：宿主已回滚，这次没有写入任何文件。'
          : task.state === 'queued'
            ? '排队中：同一实例同一时刻只跑一条写盘任务（单飞）。'
            : '进行中：可取消的任务会在下方给出取消入口。';
  return {
    state: task.state,
    headline,
    detail: base.detail,
    note,
    tone: base.tone,
    terminal: base.terminal,
    cancellable: base.cancellable,
    errorText: base.errorText,
    percent: base.percent,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 诊断 → 七组
 * ══════════════════════════════════════════════════════════════════════════════ */

export type PluginDiagnosisGroupKey =
  | 'missing'
  | 'tampered'
  | 'conflict'
  | 'function'
  | 'dependency'
  | 'incompatible'
  | 'order'
  | 'other';

export interface DiagnosisItemView {
  readonly key: string;
  readonly pluginId: string;
  readonly path: string | null;
  readonly functionName: string | null;
  /** 原样的人话（core 已加前缀，这里一个字都不改写） */
  readonly message: string;
}

export interface DiagnosisGroupView {
  readonly key: PluginDiagnosisGroupKey;
  readonly label: string;
  readonly explanation: string;
  readonly nextStep: string;
  readonly items: readonly DiagnosisItemView[];
}

export interface DiagnosisView {
  readonly ok: boolean;
  readonly headline: string;
  readonly issueCount: number;
  readonly groups: readonly DiagnosisGroupView[];
}

const GROUP_ORDER: readonly PluginDiagnosisGroupKey[] = [
  'missing',
  'tampered',
  'conflict',
  'function',
  'dependency',
  'incompatible',
  'order',
];

const GROUP_TEXT: Readonly<
  Record<PluginDiagnosisGroupKey, { label: string; explanation: string; nextStep: string }>
> = {
  missing: {
    label: '缺文件',
    explanation: '插件声明要写的文件不在磁盘上：可能被删、被挪走，或半截安装留下的状态。',
    nextStep: '重新安装这个插件（会把缺的文件补回来）；先确认游戏目录没被手工改过。',
  },
  tampered: {
    label: '哈希不符',
    explanation: '文件在安装之后被改动过，哈希与安装记录对不上（也可能是你自己改的）。',
    nextStep: '想保留改动就不动它；要回到安装时的样子就重新安装这个插件（先备份你的改动）。',
  },
  conflict: {
    label: '归属冲突',
    explanation: '同一个文件被多个来源写过，或安装记录与磁盘对不上（孤儿文件也归这一组）。',
    nextStep: '按每条原文处理：重新安装让记录对齐，或卸载这个插件清掉孤儿文件。',
  },
  function: {
    label: '函数覆盖',
    explanation: '插件重新定义了基础游戏或别的插件已有的函数（按归一化名比对）。',
    nextStep: '确认这是有意的覆盖：不是就卸载或重装这个插件；是的话保留并记住启动顺序。',
  },
  dependency: {
    label: '依赖缺失',
    explanation: '插件声明依赖的包没有装（或版本不符）：首版不自动下载依赖。',
    nextStep: '先装上它声明的依赖包（同 id、满足版本），再回来重跑诊断。',
  },
  incompatible: {
    label: '兼容性',
    explanation: '插件与当前游戏版本或插件接口版本不兼容：可能装上了但不会按预期生效。',
    nextStep: '换成对应版本的插件；确定要保留就记住每次启动前的警告。',
  },
  order: {
    label: '顺序异常',
    explanation: '两个启用的插件并列在同一个加载序号上，谁先谁后不确定；同序号会让覆盖结果随机。',
    nextStep: '在已装列表里用上移 / 下移把它们错开，再重跑一次诊断。',
  },
  other: {
    label: '其它问题',
    explanation: '码表里没有更细的档位：原文见每一条。',
    nextStep: '按每条的原文处理；拿不准就把这一条连同插件 id 反馈给开发者。',
  },
};

function groupOfIssue(issue: PluginDiagnosis['issues'][number]): PluginDiagnosisGroupKey {
  switch (issue.code) {
    case 'missing-file':
      return 'missing';
    case 'hash-mismatch':
      return 'tampered';
    case 'conflict':
      return 'conflict';
    case 'function-override':
      return 'function';
    case 'missing-dependency':
      return 'dependency';
    case 'incompatible':
      return 'incompatible';
    case 'load-order':
      return 'order';
    default:
      return 'other';
  }
}

/**
 * 诊断读数 → 七组 + 计数。
 *
 * 七组**恒定存在**（哪怕 0 项）：用户要能一眼看出「哪些类别查过、哪些真有」。
 * 兜底组「其它问题」只在非空时出现。`ok` 只看 `issues` 是否为空。
 */
export function diagnosisView(diagnosis: PluginDiagnosis): DiagnosisView {
  const buckets = new Map<PluginDiagnosisGroupKey, DiagnosisItemView[]>();
  for (const key of [...GROUP_ORDER, 'other'] as PluginDiagnosisGroupKey[]) buckets.set(key, []);
  for (const issue of diagnosis.issues) {
    const list = buckets.get(groupOfIssue(issue)) as DiagnosisItemView[];
    list.push({
      key: `${issue.pluginId}|${issue.code}|${issue.path ?? ''}|${issue.functionName ?? ''}|${issue.message}`,
      pluginId: issue.pluginId,
      path: issue.path ?? null,
      functionName: issue.functionName ?? null,
      message: issue.message,
    });
  }
  const groups: DiagnosisGroupView[] = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_TEXT[key].label,
    explanation: GROUP_TEXT[key].explanation,
    nextStep: GROUP_TEXT[key].nextStep,
    items: buckets.get(key) as DiagnosisItemView[],
  }));
  const other = buckets.get('other') as DiagnosisItemView[];
  if (other.length > 0) {
    groups.push({
      key: 'other',
      label: GROUP_TEXT.other.label,
      explanation: GROUP_TEXT.other.explanation,
      nextStep: GROUP_TEXT.other.nextStep,
      items: other,
    });
  }
  const count = (key: PluginDiagnosisGroupKey): number =>
    (buckets.get(key) as DiagnosisItemView[]).length;
  const issueCount = diagnosis.issues.length;
  const headline =
    issueCount === 0
      ? '未发现问题'
      : `共检出 ${issueCount} 项插件问题（缺文件 ${count('missing')} · 哈希 ${count('tampered')} · 冲突 ${count('conflict')} · 函数覆盖 ${count('function')} · 依赖 ${count('dependency')} · 兼容性 ${count('incompatible')} · 顺序 ${count('order')}${other.length > 0 ? ` · 其它 ${other.length}` : ''}）`;
  return { ok: issueCount === 0, headline, issueCount, groups };
}

interface PluginDiagnosisAdditions {
  readonly warnings?: readonly string[];
  readonly untrusted?: readonly string[];
}

export interface PluginDiagnosisExtras {
  /** core 加性外挂的 warnings（契约 `PluginDiagnosis` 里没有这一栏） */
  readonly warnings: readonly string[];
  /** core 加性外挂的「风险未知且未获确认」插件 id */
  readonly untrusted: readonly string[];
}

/**
 * 读 core 外挂的 `warnings` / `untrusted`（结构探测，读不到就是空）。
 *
 * 契约 `PluginDiagnosis` 只装 `issues`，这两栏是 `launcher-core` 的加性字段
 * （见其文件头「已知契约缺口」）。读不到时不伪造结论——界面只是少两行补充说明。
 */
export function pluginDiagnosisExtras(diagnosis: PluginDiagnosis): PluginDiagnosisExtras {
  const probe = diagnosis as PluginDiagnosis & PluginDiagnosisAdditions;
  const clean = (value: readonly string[] | undefined): readonly string[] =>
    Array.isArray(value)
      ? value.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
      : [];
  return { warnings: clean(probe.warnings), untrusted: clean(probe.untrusted) };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 错误：码与原文都不改写，只补「为什么 + 下一步」
 * ══════════════════════════════════════════════════════════════════════════════ */

export type PluginPanelAction =
  | 'list'
  | 'plan'
  | 'apply'
  | 'uninstall'
  | 'toggle'
  | 'order'
  | 'diagnose'
  | 'open-source';

const PLUGIN_ACTION_TITLES: Readonly<Record<PluginPanelAction, string>> = {
  list: '读取已装插件失败',
  plan: '插件安装预检失败',
  apply: '安装插件失败',
  uninstall: '卸载插件失败',
  toggle: '切换插件启停失败',
  order: '调整插件顺序失败',
  diagnose: '插件诊断失败',
  'open-source': '打开插件源码失败',
};

export interface PluginErrorAdvice {
  readonly heading: string;
  readonly explanation: string;
  readonly nextStep: string;
}

/**
 * 插件能力面最常撞的码：为什么（机制）+ 具体下一步。
 *
 * 与 `launcherErrorHint` 的分工同 `model.launchErrorAdvice`：那张表按码给一句下一步、
 * 覆盖全部码；这张只对插件专属码多说一层原因。码与原文照旧原样显示。
 */
const PLUGIN_ADVICE_BY_CODE: Readonly<Record<string, PluginErrorAdvice>> = {
  LAUNCHER_PLUGIN_CONFLICT: {
    heading: '冲突没有决断（或被冲突规则拒绝）',
    explanation:
      '文件冲突与函数冲突都必须逐条决定「跳过」还是「替换 / 覆盖」：漏一条整包都不落盘。函数冲突的「跳过」会把该函数所在文件整份跳过（宿主没有只切一个函数的能力）。',
    nextStep: '重新预检这个插件，把每条冲突分别选好再点安装；不想动盘就点「取消安装」。',
  },
  LAUNCHER_PLUGIN_INCOMPATIBLE: {
    heading: '插件与当前游戏 / 接口版本不兼容',
    explanation:
      '兼容性判定没通过：要么适配器判定不兼容，要么清单声明的版本对不上。强制安装需要显式勾选，装上的插件会被标「不兼容」，每次启动前都会警告。',
    nextStep: '优先换对应版本的插件；确实要装就勾选「仍然安装不兼容插件」再点安装。',
  },
  LAUNCHER_PLUGIN_SAVE_RISK: {
    heading: '这个插件可能影响存档，需要先确认',
    explanation:
      '声明了存档影响（或无法判定）的插件，应用前必须先备份存档；没有确认或备份失败都会中止安装，不会在没回退点的情况下写盘。',
    nextStep: '勾选「已知晓存档影响」再安装；备份失败时先解决存档目录的写权限 / 空间问题。',
  },
  LAUNCHER_PLUGIN_DEPENDENCY: {
    heading: '插件声明的依赖没满足（或命中 conflicts）',
    explanation:
      '首版不自动下载依赖：缺少 `requires` 里的包、或清单 `conflicts` 命中了已装插件，安装都会被拒。',
    nextStep: '先装上依赖包 / 卸载冲突包，再重新预检。',
  },
  LAUNCHER_PLUGIN_UNTRUSTED: {
    heading: '风险无法归类的插件还没获得你的确认',
    explanation:
      '清单缺字段或落点无法判定时，启动器按最高风险处理：必须先在原生确认框里逐项批准，`applyInstall` 才放行。',
    nextStep: '在确认框里逐项确认后重试；不放心就先不要装，把包反馈给开发者补全清单。',
  },
  LAUNCHER_TASK_BUSY: {
    heading: '这个实例正忙（同一时刻只许一条写盘任务）',
    explanation:
      '插件与内容包共用一把每实例写盘锁：上一个安装 / 卸载 / 启停放定之前，新命令在发到宿主之前就被拒（不排队，否则连点两下会装两遍）。',
    nextStep: '等当前任务在进度里走完（或先取消），再点一次；期间别重复点按钮。',
  },
  LAUNCHER_SOURCE_NOT_APPROVED: {
    heading: '目标内容根还没被授权',
    explanation:
      'shared 实例下写游戏目录要逐根批准（原生目录对话框即授权）；插件要写进的根不在批准表里一律拒绝。',
    nextStep: '用目录对话框逐根批准后再试；或改用「独立副本」实例装这个插件。',
  },
  LAUNCHER_PLATFORM_UNSUPPORTED: {
    heading: '这一版还没有插件安装所需的宿主能力',
    explanation:
      '插件的暂存、函数索引、写盘都在宿主命令里；当前载体没接这条命令，或这个游戏不支持插件安装，都走不到写盘那一步。',
    nextStep: '先继续编辑；等宿主命令补齐后再装。期间手工复制文件时务必先备份。',
  },
};

export function pluginErrorAdvice(code: string | null | undefined): PluginErrorAdvice | null {
  if (code === null || code === undefined) return null;
  return PLUGIN_ADVICE_BY_CODE[code] ?? null;
}

/** 失败读数 = `model.FailureView` + 本层的插件建议（码与原文仍由 `describeFailure` 原样带出） */
export interface PluginFailure extends FailureView {
  readonly advice: PluginErrorAdvice | null;
}

export function describePluginFailure(error: unknown, action: PluginPanelAction): PluginFailure {
  const base = describeFailure(error, 'list');
  return { ...base, title: PLUGIN_ACTION_TITLES[action], advice: pluginErrorAdvice(base.code) };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 「打开源码」：没有源码不是错误，是一句提示
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * `sourceProjectId === null` ⇒ 纯二进制 / 外部 ZIP 安装，没有可开的源。
 *
 * 返回 `null` = 有源可开；否则是那**一句提示**（不是错误条）。
 */
export function openSourceHint(plugin: Pick<InstalledPlugin, 'manifest' | 'sourceProjectId'>): string | null {
  if (plugin.sourceProjectId !== null) return null;
  return `「${plugin.manifest.name}」是外部 ZIP 安装的，没有源码项目可打开（不是故障）。`;
}
