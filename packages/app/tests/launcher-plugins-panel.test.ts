// @vitest-environment happy-dom
/**
 * 游戏插件面板（车道 UI-PLUGINS）——纯函数逐条 + 渲染行为。
 *
 * 纯函数面点名七件事：风险 / 信任 / 兼容 / 存档影响四张名词表、已装列表排序与位次、
 * 顺序调整的整份排列、计划读数与过期、文件 / 函数冲突的合法决议、应用门禁（默认拒绝线）、
 * 任务三态、诊断七组、错误码建议、打开源码的「一句提示」。
 *
 * 渲染面沿用 `launcher-content-panel.test.ts` 的同一基座（happy-dom + `act` + 10 s 墙钟
 * `waitFor`）：读已装取数用当前实例 id、高风险默认不可 apply、冲突逐条决议后才放行、
 * 三项勾选下发到 `applyInstall`、无选择器时按钮禁用并写明、打开源码失败只提示。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ContentPackManifest,
  FunctionConflict,
  InstalledPlugin,
  LauncherService,
  LauncherTask,
  PluginDiagnosis,
  PluginInstallPlan,
} from '@kojo/plugin-api';
import {
  INITIAL_GATE,
  applyGate,
  applyOptions,
  buildResolutions,
  compatibilityView,
  describePluginFailure,
  diagnosisView,
  fileConflictDecisionKey,
  fileConflictOptions,
  fileConflictRows,
  functionConflictDecisionKey,
  functionConflictOptions,
  functionConflictRows,
  installedCompatibility,
  isHighRisk,
  movePluginOrder,
  openSourceHint,
  planReadout,
  pluginDiagnosisExtras,
  pluginRiskLabel,
  pluginRiskTone,
  pluginRowConfirmText,
  pluginRows,
  pluginTaskView,
  pluginErrorAdvice,
  saveImpactDetail,
  saveImpactLabel,
  saveImpactTone,
  trustDetail,
  trustLabel,
  trustTone,
} from '../src/launcher/plugins-panel-model';
import { PluginsPanel } from '../src/launcher/plugins-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = 'a'.repeat(64);

/* ══════════════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════════════ */

function manifest(overrides: Partial<ContentPackManifest> = {}): ContentPackManifest {
  return {
    schemaVersion: 1,
    id: 'author.plugin-a',
    name: '示例插件',
    version: '1.0.0',
    kind: 'plugin',
    gameId: 'game-a',
    files: [{ rootId: 'scripts', path: 'plugin.erb', sha256: HASH, size: 2048 }],
    loadOrder: 0,
    capabilities: ['add-content'],
    saveImpact: 'none',
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: manifest(),
    enabled: true,
    order: 0,
    installedAt: '2026-10-01T00:00:00.000Z',
    ownedFiles: [
      { rootId: 'scripts', path: 'plugin.erb' },
      { rootId: 'scripts', path: 'plugin-2.erb' },
    ],
    risk: 'extends-logic',
    requiresRestart: true,
    status: 'ok',
    sourceProjectId: 'proj-a',
    trust: { state: 'unverified', publisher: '作者甲', signedAt: null },
    ...overrides,
  };
}

function fileConflict(
  overrides: Partial<PluginInstallPlan['conflicts'][number]> = {},
): PluginInstallPlan['conflicts'][number] {
  return {
    rootId: 'scripts',
    path: 'base.erb',
    kind: 'base-file',
    existingPackId: null,
    resolution: 'abort',
    ...overrides,
  };
}

function functionConflict(overrides: Partial<FunctionConflict> = {}): FunctionConflict {
  return {
    functionName: 'EVENTTRAIN',
    existing: { pluginId: null, path: 'erb/base.erb', line: 12 },
    incoming: { path: 'plugins/x/plugin.erb', line: 3 },
    resolution: 'abort',
    ...overrides,
  };
}

function planFixture(overrides: Partial<PluginInstallPlan> = {}): PluginInstallPlan {
  return {
    planId: 'plan-1',
    mode: 'install',
    manifest: manifest({
      files: [
        { rootId: 'scripts', path: 'plugin.erb', sha256: HASH, size: 2048 },
        { rootId: 'scripts', path: 'extra.erb', sha256: HASH, size: 1024 },
      ],
    }),
    targets: [{ rootId: 'scripts', relativePath: 'plugins/x' }],
    additions: [{ rootId: 'scripts', path: 'extra.erb' }],
    overwrites: [],
    conflicts: [],
    functionConflicts: [],
    missingRequirements: [],
    compatibility: {
      ok: true,
      gameVersion: '1.0',
      requiredGameVersion: '1.0',
      apiVersion: '1',
      checkedBy: 'adapter',
      reasons: [],
    },
    saveImpact: 'none',
    risk: 'content-only',
    requiresRestart: false,
    warnings: [],
    // 默认相对**真墙钟**给未来时刻（渲染冒烟里组件按 Date.now() 判过期）
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    ...overrides,
  };
}

function task(overrides: Partial<LauncherTask> = {}): LauncherTask {
  return {
    id: 'task-1',
    kind: 'content-install',
    instanceId: 'i-1',
    state: 'succeeded',
    progress: { done: 2, total: 2, unit: 'files', message: '写入完成' },
    createdAt: '2026-10-26T00:00:00.000Z',
    startedAt: '2026-10-26T00:00:01.000Z',
    endedAt: '2026-10-26T00:00:02.000Z',
    error: null,
    result: null,
    cancellable: false,
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 名词表
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 名词表', () => {
  it('风险四档逐档有人话；未知值回显原值而不是装作认识', () => {
    expect(pluginRiskLabel('content-only')).toBe('仅内容');
    expect(pluginRiskLabel('extends-logic')).toBe('扩展逻辑');
    expect(pluginRiskLabel('overrides-logic')).toBe('覆盖逻辑');
    expect(pluginRiskLabel('unknown')).toBe('风险未知');
    expect(pluginRiskLabel('brand-new')).toBe('未知风险（brand-new）');
  });

  it('风险档位映射到语义色，只有覆盖逻辑 / 未知算高风险', () => {
    expect(pluginRiskTone('content-only')).toBe('ok');
    expect(pluginRiskTone('extends-logic')).toBe('busy');
    expect(pluginRiskTone('overrides-logic')).toBe('warn');
    expect(pluginRiskTone('unknown')).toBe('warn');
    expect(pluginRiskTone('brand-new')).toBe('warn');
    expect(isHighRisk('content-only')).toBe(false);
    expect(isHighRisk('extends-logic')).toBe(false);
    expect(isHighRisk('overrides-logic')).toBe(true);
    expect(isHighRisk('unknown')).toBe(true);
  });

  it('信任态三档 + 发布者 / 签名读数如实展示', () => {
    expect(trustLabel('verified')).toBe('已验签');
    expect(trustLabel('unverified')).toBe('未验签');
    expect(trustLabel('unknown')).toBe('信任未知');
    expect(trustLabel('weird')).toBe('未知信任态（weird）');
    expect(trustTone('verified')).toBe('ok');
    expect(trustTone('unverified')).toBe('idle');
    expect(trustTone('unknown')).toBe('warn');
    expect(trustDetail({ state: 'unverified', publisher: '作者甲', signedAt: null })).toBe(
      '发布者：作者甲 · 首版没有签名验证',
    );
    expect(trustDetail({ state: 'unknown', publisher: null, signedAt: '2026-10-01' })).toBe(
      '发布者未记录 · 签名时间 2026-10-01',
    );
  });

  it('兼容性读数说清「谁判的」与版本事实', () => {
    const ok = compatibilityView({
      ok: true,
      gameVersion: '1.0',
      requiredGameVersion: '1.0',
      apiVersion: '2',
      checkedBy: 'adapter',
      reasons: [],
    });
    expect(ok.label).toBe('兼容');
    expect(ok.tone).toBe('ok');
    expect(ok.checkedByLabel).toBe('适配器判定');
    expect(ok.detail).toContain('判定：适配器判定');

    const bad = compatibilityView({
      ok: false,
      gameVersion: null,
      requiredGameVersion: '2.0',
      apiVersion: null,
      checkedBy: 'declared',
      reasons: ['版本对不上'],
    });
    expect(bad.label).toBe('不兼容');
    expect(bad.tone).toBe('warn');
    expect(bad.checkedByLabel).toBe('仅按清单声明');
    expect(bad.reasons).toEqual(['版本对不上']);

    expect(
      compatibilityView({
        ok: true,
        gameVersion: null,
        requiredGameVersion: null,
        apiVersion: null,
        checkedBy: 'none',
        reasons: [],
      }).checkedByLabel,
    ).toBe('未判定');
  });

  it('已装插件的兼容徽标：没记录就写「未记录」，不拿「正常」冒充兼容', () => {
    expect(installedCompatibility(installed({ status: 'ok' }))).toEqual({
      label: '兼容性未记录',
      tone: 'idle',
    });
    expect(installedCompatibility(installed({ status: 'incompatible' }))).toEqual({
      label: '不兼容',
      tone: 'warn',
    });
  });

  it('存档影响三档的人话与色调；未知值按最坏情况说', () => {
    expect(saveImpactLabel('none')).toBe('无存档影响');
    expect(saveImpactLabel('possible')).toBe('可能影响存档');
    expect(saveImpactLabel('unknown')).toBe('存档影响未知');
    expect(saveImpactLabel('weird')).toBe('未知存档影响（weird）');
    expect(saveImpactTone('none')).toBe('ok');
    expect(saveImpactTone('possible')).toBe('warn');
    expect(saveImpactDetail('none')).toContain('不额外备份');
    expect(saveImpactDetail('none').length).toBeGreaterThan(0);
    expect(saveImpactTone('weird')).toBe('warn');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 已装列表与顺序
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 已装列表', () => {
  it('按 order 排序、按位次给 canMoveUp / canMoveDown，并带风险 / 信任读数', () => {
    const rows = pluginRows([
      installed({
        manifest: manifest({ id: 'b', name: 'B 插件' }),
        order: 2,
        risk: 'unknown',
        trust: { state: 'unknown', publisher: null, signedAt: null },
      }),
      installed({
        manifest: manifest({ id: 'a', name: 'A 插件' }),
        order: 1,
        risk: 'overrides-logic',
        enabled: false,
        sourceProjectId: null,
      }),
    ]);
    expect(rows.map((row) => row.pluginId)).toEqual(['a', 'b']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(rows[0]?.canMoveUp).toBe(false);
    expect(rows[0]?.canMoveDown).toBe(true);
    expect(rows[1]?.canMoveUp).toBe(true);
    expect(rows[1]?.canMoveDown).toBe(false);
    expect(rows[0]?.riskLabel).toBe('覆盖逻辑');
    expect(rows[0]?.highRisk).toBe(true);
    expect(rows[0]?.enabledLabel).toBe('已停用');
    expect(rows[0]?.canOpenSource).toBe(false);
    expect(rows[1]?.trustLabel).toBe('信任未知');
    expect(rows[1]?.riskTone).toBe('warn');
  });

  it('状态徽标四档、需重启标记与文件数进派生读数', () => {
    const row = pluginRows([
      installed({ status: 'broken', requiresRestart: true, ownedFiles: [{ rootId: 'scripts', path: 'x.erb' }] }),
    ])[0]!;
    expect(row.statusLabel).toBe('已损坏');
    expect(row.statusTone).toBe('warn');
    expect(row.requiresRestart).toBe(true);
    expect(row.fileCount).toBe(1);
    expect(row.compatibilityLabel).toBe('兼容性未记录');
  });

  it('上移 / 下移返回整份排列；边界与未知 id 返回 null', () => {
    const plugins = [
      installed({ manifest: manifest({ id: 'a' }), order: 0 }),
      installed({ manifest: manifest({ id: 'b' }), order: 1 }),
      installed({ manifest: manifest({ id: 'c' }), order: 2 }),
    ];
    expect(movePluginOrder(plugins, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movePluginOrder(plugins, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(movePluginOrder(plugins, 'a', -1)).toBeNull();
    expect(movePluginOrder(plugins, 'c', 1)).toBeNull();
    expect(movePluginOrder(plugins, 'missing', 1)).toBeNull();
  });

  it('行内确认文案逐种动作说清后果（卸载不删存档）', () => {
    expect(pluginRowConfirmText({ kind: 'uninstall', name: 'A', fileCount: 3 })).toContain(
      '本包写入的 3 个文件',
    );
    expect(pluginRowConfirmText({ kind: 'uninstall', name: 'A' })).toContain('游戏存档不删');
    expect(pluginRowConfirmText({ kind: 'disable', name: 'A' })).toContain('撤下');
    expect(pluginRowConfirmText({ kind: 'enable', name: 'A' })).toContain('重跑冲突检查');
    expect(pluginRowConfirmText({ kind: 'order', name: 'A', direction: 'up' })).toContain('上移');
    expect(pluginRowConfirmText({ kind: 'order', name: 'A', direction: 'down' })).toContain('下移');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 计划读数
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 计划读数', () => {
  const NOW = Date.parse('2026-10-26T00:00:00.000Z');

  it('数字逐条来自计划本体：条目 / 体积 / 新增 / 覆盖 / 文件冲突 / 函数冲突', () => {
    const readout = planReadout(
      planFixture({
        overwrites: [{ rootId: 'scripts', path: 'base.erb' }],
        conflicts: [fileConflict()],
        functionConflicts: [functionConflict()],
        expiresAt: new Date(NOW + 60_000).toISOString(),
      }),
      NOW,
    );
    expect(readout.title).toBe('示例插件（1.0.0）');
    expect(readout.entryCount).toBe(2);
    expect(readout.byteTotal).toBe(3072);
    expect(readout.modeLabel).toBe('新装');
    expect(readout.expired).toBe(false);
    const value = (label: string): string | undefined =>
      readout.rows.find((row) => row.label === label)?.value;
    expect(value('新增')).toBe('1 个');
    expect(value('覆盖')).toBe('1 个');
    expect(value('文件冲突')).toBe('1 条');
    expect(value('函数冲突')).toBe('1 条真冲突');
    expect(value('存档影响')).toBe('无存档影响');
    expect(value('风险')).toBe('仅内容');
    expect(value('过期')).toContain('计划还有');
  });

  it('过期时刻不可读按已过期处理；升级模式与门禁标记进读数', () => {
    const readout = planReadout(
      planFixture({
        mode: 'upgrade',
        expiresAt: 'not-a-date',
        risk: 'overrides-logic',
        saveImpact: 'unknown',
        compatibility: {
          ok: false,
          gameVersion: null,
          requiredGameVersion: '2.0',
          apiVersion: null,
          checkedBy: 'none',
          reasons: [],
        },
      }),
      NOW,
    );
    expect(readout.expired).toBe(true);
    expect(readout.expiresText).toContain('不可读');
    expect(readout.modeLabel).toBe('升级');
    expect(readout.highRisk).toBe(true);
    expect(readout.needsSaveAck).toBe(true);
    expect(readout.needsIncompatibleAck).toBe(true);
    expect(readout.rows.find((row) => row.label === '过期')?.tone).toBe('warn');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 冲突决议
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 冲突决议', () => {
  it('文件冲突：撞别的包只给 skip / replace，撞基础文件只给 skip / overwrite', () => {
    expect(fileConflictOptions({ kind: 'other-pack' }).map((option) => option.action)).toEqual([
      'skip',
      'replace',
    ]);
    expect(fileConflictOptions({ kind: 'base-file' }).map((option) => option.action)).toEqual([
      'skip',
      'overwrite',
    ]);
    const rows = fileConflictRows(planFixture({ conflicts: [fileConflict()] }));
    expect(rows[0]?.key).toBe(fileConflictDecisionKey({ rootId: 'scripts', path: 'base.erb' }));
    expect(rows[0]?.kindLabel).toBe('撞基础游戏文件');
    expect(rows[0]?.ownerLabel).toContain('不属于任何已装包');
  });

  it('函数冲突只给 skip / replace（overwrite 会被 core 拒），并说清 skip 是整份文件跳过', () => {
    expect(functionConflictOptions().map((option) => option.action)).toEqual(['skip', 'replace']);
    expect(functionConflictOptions()[0]?.label).toContain('整份文件跳过');
    const rows = functionConflictRows(planFixture({ functionConflicts: [functionConflict()] }));
    expect(rows[0]?.key).toBe(functionConflictDecisionKey('EVENTTRAIN'));
    expect(rows[0]?.existingLabel).toBe('基础游戏 · erb/base.erb:12');
    expect(rows[0]?.incomingLabel).toBe('plugins/x/plugin.erb:3');
  });

  it('决议逐条收集：文件 + 函数都齐才没有 pending', () => {
    const plan = planFixture({
      conflicts: [
        fileConflict(),
        fileConflict({ path: 'other.erb', kind: 'other-pack', existingPackId: 'author.pack-b' }),
      ],
      functionConflicts: [functionConflict()],
    });
    const none = buildResolutions(plan, {});
    expect(none.resolutions).toEqual([]);
    expect(none.pending).toHaveLength(3);

    const built = buildResolutions(plan, {
      [fileConflictDecisionKey({ rootId: 'scripts', path: 'base.erb' })]: 'overwrite',
      [fileConflictDecisionKey({ rootId: 'scripts', path: 'other.erb' })]: 'replace',
      [functionConflictDecisionKey('EVENTTRAIN')]: 'skip',
    });
    expect(built.pending).toEqual([]);
    expect(built.resolutions).toEqual([
      { rootId: 'scripts', path: 'base.erb', action: 'overwrite' },
      { rootId: 'scripts', path: 'other.erb', action: 'replace' },
      { functionName: 'EVENTTRAIN', action: 'skip' },
    ]);
  });

  it('非法动作算未决断（overwrite 对函数冲突 / replace 对基础文件）', () => {
    const plan = planFixture({
      conflicts: [fileConflict()],
      functionConflicts: [functionConflict()],
    });
    const built = buildResolutions(plan, {
      [fileConflictDecisionKey({ rootId: 'scripts', path: 'base.erb' })]: 'replace',
      [functionConflictDecisionKey('EVENTTRAIN')]: 'overwrite',
    });
    expect(built.resolutions).toEqual([]);
    expect(built.pending).toHaveLength(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 应用门禁
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 应用门禁', () => {
  const NOW = Date.parse('2026-10-26T00:00:00.000Z');
  const fresh = (overrides: Partial<PluginInstallPlan> = {}): PluginInstallPlan =>
    planFixture({ expiresAt: new Date(NOW + 60_000).toISOString(), ...overrides });

  it('低风险、无冲突、无存档影响：直接可 apply；选项一项都不传', () => {
    const plan = fresh();
    const gate = applyGate(plan, buildResolutions(plan, {}), INITIAL_GATE, NOW);
    expect(gate.canApply).toBe(true);
    expect(gate.blockers).toEqual([]);
    expect(applyOptions(plan, INITIAL_GATE)).toBeUndefined();
  });

  it('冲突没决断 / 依赖缺失 / 计划过期：按钮灰且逐条列原因', () => {
    const plan = fresh({
      conflicts: [fileConflict()],
      missingRequirements: ['author.base'],
      expiresAt: new Date(NOW - 1_000).toISOString(),
    });
    const gate = applyGate(plan, buildResolutions(plan, {}), INITIAL_GATE, NOW);
    expect(gate.canApply).toBe(false);
    expect(gate.expired).toBe(true);
    expect(gate.pendingCount).toBe(1);
    expect(gate.blockers).toHaveLength(3);
    expect(gate.blockers.join(' ')).toContain('计划已过期');
    expect(gate.blockers.join(' ')).toContain('还有 1 条冲突没决断');
    expect(gate.blockers.join(' ')).toContain('依赖未满足');
  });

  it('兼容性不通过：必须勾「仍然安装」才放行，勾了才下发 allowIncompatible', () => {
    const plan = fresh({
      compatibility: {
        ok: false,
        gameVersion: null,
        requiredGameVersion: '2.0',
        apiVersion: null,
        checkedBy: 'declared',
        reasons: ['对不上'],
      },
    });
    const built = buildResolutions(plan, {});
    const blocked = applyGate(plan, built, INITIAL_GATE, NOW);
    expect(blocked.needsIncompatible).toBe(true);
    expect(blocked.canApply).toBe(false);
    expect(applyOptions(plan, INITIAL_GATE)).toBeUndefined();

    const allowed = { ...INITIAL_GATE, allowIncompatible: true };
    expect(applyGate(plan, built, allowed, NOW).canApply).toBe(true);
    expect(applyOptions(plan, allowed)).toEqual({ allowIncompatible: true });
  });

  it('高风险（覆盖逻辑 / 未知）：不勾确认绝不放行', () => {
    for (const risk of ['overrides-logic', 'unknown'] as const) {
      const plan = fresh({ risk });
      const built = buildResolutions(plan, {});
      const blocked = applyGate(plan, built, INITIAL_GATE, NOW);
      expect(blocked.needsRisk).toBe(true);
      expect(blocked.canApply).toBe(false);
      expect(blocked.blockers.join(' ')).toContain(pluginRiskLabel(risk));
      const acked = { ...INITIAL_GATE, acknowledgeRisk: true };
      expect(applyGate(plan, built, acked, NOW).canApply).toBe(true);
      // 高风险确认是界面门禁，不进 PluginApplyOptions
      expect(applyOptions(plan, acked)).toBeUndefined();
    }
  });

  it('可能影响存档：必须勾「已知晓」才放行，勾了才下发 acknowledgeSaveImpact', () => {
    const plan = fresh({ saveImpact: 'possible' });
    const built = buildResolutions(plan, {});
    const blocked = applyGate(plan, built, INITIAL_GATE, NOW);
    expect(blocked.needsSaveImpact).toBe(true);
    expect(blocked.canApply).toBe(false);
    expect(blocked.blockers.join(' ')).toContain('可能影响存档');

    const acked = { ...INITIAL_GATE, acknowledgeSaveImpact: true };
    expect(applyGate(plan, built, acked, NOW).canApply).toBe(true);
    expect(applyOptions(plan, acked)).toEqual({ acknowledgeSaveImpact: true });
  });

  it('兼容 + 存档 + 高风险同时存在：勾齐才放行，两个字段一起下发', () => {
    const plan = fresh({
      risk: 'unknown',
      saveImpact: 'unknown',
      compatibility: {
        ok: false,
        gameVersion: null,
        requiredGameVersion: null,
        apiVersion: null,
        checkedBy: 'none',
        reasons: [],
      },
    });
    const built = buildResolutions(plan, {});
    const gate = applyGate(plan, built, INITIAL_GATE, NOW);
    expect(gate.blockers).toHaveLength(3);
    const all = { acknowledgeRisk: true, allowIncompatible: true, acknowledgeSaveImpact: true };
    expect(applyGate(plan, built, all, NOW).canApply).toBe(true);
    expect(applyOptions(plan, all)).toEqual({
      allowIncompatible: true,
      acknowledgeSaveImpact: true,
    });
  });

  it('不勾的项不传（缺省语义归契约，本层不把默认值抄一遍）', () => {
    const plan = fresh({ saveImpact: 'possible' });
    expect(applyOptions(plan, { ...INITIAL_GATE, acknowledgeSaveImpact: false })).toBeUndefined();
    expect(
      applyOptions(plan, { ...INITIAL_GATE, acknowledgeSaveImpact: true }),
    ).toEqual({ acknowledgeSaveImpact: true });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数 · 任务 / 诊断 / 错误 / 源码
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('plugins-panel-model · 任务与诊断', () => {
  it('任务三态按插件口径命名，失败 / 取消都说清宿主已回滚', () => {
    const running = pluginTaskView(
      task({ state: 'running', kind: 'content-install', progress: { done: 1, total: 2, unit: 'files', message: '' } }),
    );
    expect(running.headline).toBe('正在安装插件…');
    expect(running.percent).toBe(50);
    expect(running.terminal).toBe(false);

    const failed = pluginTaskView(
      task({
        state: 'failed',
        error: { code: 'LAUNCHER_PLUGIN_CONFLICT', message: '冲突没决断', retryable: false },
      }),
    );
    expect(failed.headline).toBe('安装插件失败');
    expect(failed.note).toContain('逆序回滚');
    expect(failed.errorText).toBe('冲突没决断');

    const cancelled = pluginTaskView(task({ state: 'cancelled', kind: 'content-uninstall' }));
    expect(cancelled.headline).toBe('卸载插件已取消');
    expect(cancelled.note).toContain('没有写入任何文件');
  });

  it('诊断按七码归组；七组恒在，兜底组只在真有未知码时出现', () => {
    const diagnosis: PluginDiagnosis = {
      instanceId: 'i-1',
      issues: [
        { pluginId: 'a', code: 'missing-file', path: 'x.erb', message: '文件缺失：x.erb' },
        { pluginId: 'a', code: 'hash-mismatch', path: 'x.erb', message: '哈希不符' },
        { pluginId: 'b', code: 'conflict', message: '归属冲突' },
        { pluginId: 'b', code: 'function-override', functionName: 'K1', message: '函数覆盖' },
        { pluginId: 'b', code: 'missing-dependency', message: '缺依赖 author.base' },
        { pluginId: 'b', code: 'incompatible', message: '不兼容' },
        { pluginId: 'b', code: 'load-order', message: '加载顺序异常' },
      ],
    };
    const view = diagnosisView(diagnosis);
    expect(view.ok).toBe(false);
    expect(view.issueCount).toBe(7);
    expect(view.groups.map((group) => group.key)).toEqual([
      'missing',
      'tampered',
      'conflict',
      'function',
      'dependency',
      'incompatible',
      'order',
    ]);
    expect(view.groups.every((group) => group.items.length === 1)).toBe(true);
    expect(view.headline).toContain('函数覆盖 1');
    expect(view.groups[3]?.items[0]?.functionName).toBe('K1');

    const ok = diagnosisView({ instanceId: 'i-1', issues: [] });
    expect(ok.ok).toBe(true);
    expect(ok.headline).toBe('未发现问题');
    expect(ok.groups).toHaveLength(7);

    const unknown = diagnosisView({
      instanceId: 'i-1',
      issues: [
        {
          pluginId: 'c',
          // 契约外的新码（宿主升级后可能出现）：进兜底组，不静默丢弃
          code: 'brand-new' as PluginDiagnosis['issues'][number]['code'],
          message: '未知问题',
        },
      ],
    });
    expect(unknown.groups.at(-1)?.key).toBe('other');
    expect(unknown.groups.at(-1)?.items[0]?.message).toBe('未知问题');
  });

  it('core 外挂的 warnings / untrusted 结构探测：读不到就是空，不伪造结论', () => {
    const bare: PluginDiagnosis = { instanceId: 'i-1', issues: [] };
    expect(pluginDiagnosisExtras(bare)).toEqual({ warnings: [], untrusted: [] });
    const enriched = {
      instanceId: 'i-1',
      issues: [],
      warnings: ['共检出 1 项插件问题', '  '],
      untrusted: ['a：风险无法归类且未获确认'],
    } as unknown as PluginDiagnosis;
    expect(pluginDiagnosisExtras(enriched)).toEqual({
      warnings: ['共检出 1 项插件问题'],
      untrusted: ['a：风险无法归类且未获确认'],
    });
  });

  it('错误读数：码与原文原样，插件专属码另给「为什么 + 下一步」；无码不伪造', () => {
    const structured = describePluginFailure(
      {
        code: 'LAUNCHER_PLUGIN_INCOMPATIBLE',
        message: '插件与当前游戏版本或插件接口版本不兼容，已拒绝安装',
        detail: 'a 1.0.0：对不上',
        retryable: false,
      },
      'apply',
    );
    expect(structured.title).toBe('安装插件失败');
    expect(structured.code).toBe('LAUNCHER_PLUGIN_INCOMPATIBLE');
    expect(structured.detail).toBe('a 1.0.0：对不上');
    expect(structured.advice?.heading).toContain('不兼容');
    expect(structured.hint.length).toBeGreaterThan(0);

    const raw = describePluginFailure(new Error('炸了'), 'list');
    expect(raw.title).toBe('读取已装插件失败');
    expect(raw.code).toBeNull();
    expect(raw.message).toBe('炸了');
    expect(raw.advice).toBeNull();

    expect(pluginErrorAdvice('LAUNCHER_PLUGIN_SAVE_RISK')?.heading).toContain('存档');
    expect(pluginErrorAdvice('LAUNCHER_NOT_A_CODE')).toBeNull();
    expect(pluginErrorAdvice(null)).toBeNull();
  });

  it('打开源码：有源返回 null；外部 ZIP 返回一句提示（不是错误）', () => {
    expect(openSourceHint(installed({ sourceProjectId: 'proj-a' }))).toBeNull();
    const hint = openSourceHint(installed({ sourceProjectId: null, manifest: manifest({ name: '外部插件' }) }));
    expect(hint).toContain('外部插件');
    expect(hint).toContain('没有源码项目可打开');
    expect(hint).toContain('不是故障');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 组件渲染
 * ══════════════════════════════════════════════════════════════════════════════ */

interface Recorded {
  readonly list: string[];
  readonly plan: { readonly instanceId: string; readonly archivePath: string }[];
  readonly apply: {
    readonly planId: string;
    readonly resolutions: readonly unknown[] | undefined;
    readonly options: Record<string, unknown> | undefined;
  }[];
  readonly uninstall: { readonly instanceId: string; readonly pluginId: string }[];
  readonly toggle: { readonly instanceId: string; readonly pluginId: string; readonly enabled: boolean }[];
  readonly order: { readonly instanceId: string; readonly ids: readonly string[] }[];
  readonly openSource: { readonly instanceId: string; readonly pluginId: string }[];
  diagnose: number;
}

interface FakeOptions {
  readonly plugins?: readonly InstalledPlugin[];
  readonly plan?: PluginInstallPlan;
  readonly diagnosis?: PluginDiagnosis;
  readonly openSourceError?: unknown;
}

function fakeService(options: FakeOptions = {}): { service: LauncherService; recorded: Recorded } {
  const recorded: Recorded = {
    list: [],
    plan: [],
    apply: [],
    uninstall: [],
    toggle: [],
    order: [],
    openSource: [],
    diagnose: 0,
  };
  const service = {
    plugins: {
      list: async (instanceId: string) => {
        recorded.list.push(instanceId);
        return options.plugins ?? [];
      },
      planInstall: async (instanceId: string, archivePath: string) => {
        recorded.plan.push({ instanceId, archivePath });
        return options.plan ?? planFixture();
      },
      applyInstall: async (
        planId: string,
        resolutions?: readonly unknown[],
        opts?: Record<string, unknown>,
      ) => {
        recorded.apply.push({ planId, resolutions, options: opts });
        return task();
      },
      uninstall: async (instanceId: string, pluginId: string) => {
        recorded.uninstall.push({ instanceId, pluginId });
        return task({ id: 'task-uninstall', kind: 'content-uninstall' });
      },
      setEnabled: async (instanceId: string, pluginId: string, enabled: boolean) => {
        recorded.toggle.push({ instanceId, pluginId, enabled });
        return task({ id: 'task-toggle', kind: 'content-toggle' });
      },
      setOrder: async (instanceId: string, pluginIds: readonly string[]) => {
        recorded.order.push({ instanceId, ids: pluginIds });
      },
      diagnose: async () => {
        recorded.diagnose += 1;
        return options.diagnosis ?? { instanceId: 'i-1', issues: [] };
      },
      openSource: async (instanceId: string, pluginId: string) => {
        recorded.openSource.push({ instanceId, pluginId });
        if (options.openSourceError !== undefined) throw options.openSourceError;
      },
    },
    tasks: {
      list: () => [],
      get: () => null,
      cancel: async () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as LauncherService;
  return { service, recorded };
}

describe('PluginsPanel · 渲染行为', () => {
  let container: HTMLElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = undefined;
  });

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (check()) return;
      await settle();
    }
    throw new Error(`等待超时：${label}`);
  }

  async function mount(service: LauncherService, onPickArchive?: () => Promise<string | null>): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        h(PluginsPanel, {
          service,
          instanceId: 'i-1',
          ...(onPickArchive === undefined ? {} : { onPickArchive }),
        }),
      );
    });
    await settle();
  }

  async function click(element: Element): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  /** 勾选框走原生 `click()`：React 的 onChange 对 checkbox 认的是 click 而不是 change */
  async function toggle(box: HTMLInputElement): Promise<void> {
    await act(async () => {
      box.click();
    });
    await settle();
  }

  function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
    return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(text),
    );
  }

  function groupByLabel(label: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
    if (found === null) throw new Error(`找不到决议组：${label}`);
    return found;
  }

  it('挂载即用当前实例 id 取数；风险 / 兼容 / 信任三枚徽标都在行上', async () => {
    const { service, recorded } = fakeService({
      plugins: [
        installed({
          manifest: manifest({ name: '覆盖型插件' }),
          risk: 'overrides-logic',
          status: 'incompatible',
          sourceProjectId: null,
          trust: { state: 'unknown', publisher: null, signedAt: null },
        }),
      ],
    });
    await mount(service);

    await waitFor(() => container.querySelector('.launcher-plugins-row') !== null, '插件行');
    expect(recorded.list).toEqual(['i-1']);
    expect(container.textContent).toContain('覆盖型插件');
    expect(container.textContent).toContain('覆盖逻辑');
    expect(container.textContent).toContain('不兼容');
    expect(container.textContent).toContain('信任未知');
    const open = buttonByText('打开源码');
    expect(open?.title).toContain('没有源码项目');
  });

  it('宿主没有 pickArchive：选择按钮禁用并写明原因', async () => {
    const { service } = fakeService();
    await mount(service);
    const pick = buttonByText('选择插件包');
    expect(pick).toBeDefined();
    expect(pick!.disabled).toBe(true);
    expect(container.textContent).toContain('宿主未提供选择器');
  });

  it('高风险 + 存档影响 + 不兼容 + 两类冲突：决议与勾选齐了才允许 apply，且字段逐项下发', async () => {
    const plan = planFixture({
      risk: 'overrides-logic',
      saveImpact: 'possible',
      compatibility: {
        ok: false,
        gameVersion: null,
        requiredGameVersion: '2.0',
        apiVersion: null,
        checkedBy: 'declared',
        reasons: ['版本对不上'],
      },
      conflicts: [fileConflict()],
      functionConflicts: [functionConflict()],
      warnings: ['已按适配器约定策略收敛 2 处预期重复：逐角色口上'],
    });
    const { service, recorded } = fakeService({ plan });
    await mount(service, async () => 'C:/packs/plugin.zip');

    await click(buttonByText('选择插件包')!);
    await waitFor(() => recorded.plan.length === 1, '预检被调用');
    expect(recorded.plan[0]).toEqual({ instanceId: 'i-1', archivePath: 'C:/packs/plugin.zip' });
    await waitFor(() => container.textContent?.includes('示例插件（1.0.0）') === true, '计划上屏');

    // 「预期重复」的缺口如实展示：只在警告行里，函数冲突栏写明是真冲突
    expect(container.textContent).toContain('预期重复');
    expect(container.textContent).toContain('1 条真冲突');

    const apply = buttonByText('开始安装')!;
    expect(apply.disabled).toBe(true);
    expect(container.textContent).toContain('还有 2 条冲突没决断');

    // 冲突逐条决议
    await click(buttonByText('覆盖（先备份）', groupByLabel('文件冲突决议：scripts/base.erb'))!);
    await click(buttonByText('保留既有', groupByLabel('函数冲突决议：EVENTTRAIN'))!);
    await settle();
    expect(apply.disabled).toBe(true);
    expect(container.textContent).toContain('勾选「仍然安装不兼容插件」');
    expect(container.textContent).toContain('勾选高风险确认');
    expect(container.textContent).toContain('勾选「已知晓存档影响」');

    // 三项显式勾选（缺省全不勾）
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    for (const box of boxes) await toggle(box);

    await waitFor(() => buttonByText('开始安装')!.disabled === false, 'apply 放行');
    await click(buttonByText('开始安装')!);
    await waitFor(() => recorded.apply.length === 1, 'apply 被调用');
    expect(recorded.apply[0]?.planId).toBe('plan-1');
    expect(recorded.apply[0]?.resolutions).toEqual([
      { rootId: 'scripts', path: 'base.erb', action: 'overwrite' },
      { functionName: 'EVENTTRAIN', action: 'skip' },
    ]);
    expect(recorded.apply[0]?.options).toEqual({
      allowIncompatible: true,
      acknowledgeSaveImpact: true,
    });

    // 任务成功 → 列表刷新（第二次 list）+ 结果横幅
    await waitFor(() => recorded.list.length >= 2, '成功后刷新列表');
    expect(container.textContent).toContain('安装插件完成');
  });

  it('没有源码项目：点「打开源码」只给一句提示，不调宿主也不出错误条', async () => {
    const { service, recorded } = fakeService({
      plugins: [installed({ sourceProjectId: null })],
    });
    await mount(service);
    await click(buttonByText('打开源码')!);
    expect(recorded.openSource).toEqual([]);
    expect(container.textContent).toContain('没有源码项目可打开');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('打开源码失败：只留一句提示（码与原文在内），不是错误条', async () => {
    const { service, recorded } = fakeService({
      plugins: [installed({ sourceProjectId: 'proj-a' })],
      openSourceError: {
        code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
        message: '当前宿主未提供打开插件源码项目的通道',
        retryable: false,
      },
    });
    await mount(service);
    await click(buttonByText('打开源码')!);
    expect(recorded.openSource).toEqual([{ instanceId: 'i-1', pluginId: 'author.plugin-a' }]);
    expect(container.textContent).toContain('打开插件源码失败');
    expect(container.textContent).toContain('LAUNCHER_PLATFORM_UNSUPPORTED');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('上移把整份排列交给 setOrder；卸载先过确认条', async () => {
    const plugins = [
      installed({ manifest: manifest({ id: 'a', name: 'A 插件' }), order: 0 }),
      installed({ manifest: manifest({ id: 'b', name: 'B 插件' }), order: 1 }),
    ];
    const { service, recorded } = fakeService({ plugins });
    await mount(service);

    const rowB = container.querySelectorAll('.launcher-plugins-row')[1]!;
    await click(buttonByText('上移', rowB)!);
    expect(recorded.order).toEqual([]);
    expect(container.textContent).toContain('加载顺序会变');
    await click(buttonByText('确认')!);
    await waitFor(() => recorded.order.length === 1, 'setOrder 被调用');
    expect(recorded.order[0]).toEqual({ instanceId: 'i-1', ids: ['b', 'a'] });

    const rowA = container.querySelectorAll('.launcher-plugins-row')[0]!;
    await click(buttonByText('卸载', rowA)!);
    expect(recorded.uninstall).toEqual([]);
    expect(container.textContent).toContain('游戏存档不删');
    await click(buttonByText('确认')!);
    await waitFor(() => recorded.uninstall.length === 1, 'uninstall 被调用');
    expect(recorded.uninstall[0]).toEqual({ instanceId: 'i-1', pluginId: 'a' });
  });

  it('诊断：逐组人话 + 计数；core 外挂的 warnings 原样补充', async () => {
    const diagnosis = {
      instanceId: 'i-1',
      issues: [
        { pluginId: 'a', code: 'missing-file', path: 'x.erb', message: '文件缺失：x.erb' },
        { pluginId: 'a', code: 'load-order', message: '加载顺序异常：与 b 并列在 0' },
      ],
      warnings: ['共检出 2 项插件问题'],
      untrusted: ['a：风险无法归类且未获确认，下次安装 / 升级会被拒绝'],
    } as unknown as PluginDiagnosis;
    const { service, recorded } = fakeService({ diagnosis });
    await mount(service);

    await click(buttonByText('诊断')!);
    await waitFor(() => recorded.diagnose === 1, 'diagnose 被调用');
    await waitFor(() => container.textContent?.includes('共检出 2 项插件问题') === true, '诊断上屏');
    expect(container.textContent).toContain('缺文件');
    expect(container.textContent).toContain('顺序异常');
    expect(container.textContent).toContain('未获确认');
  });
});
