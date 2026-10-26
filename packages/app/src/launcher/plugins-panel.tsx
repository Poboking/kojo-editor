/**
 * 启动器 · 实例详情「游戏插件」面板（车道 UI-PLUGINS）。
 *
 * 一块面板承担四件事，全部只经契约面 `LauncherService.plugins`，不碰磁盘、不拼路径：
 *
 * 1. **已装插件**：名称 / 版本 / 风险徽标 / 兼容徽标 / 信任态 / 启用开关 / 顺序上移下移 /
 *    卸载确认；「打开源码」走 `service.plugins.openSource`——没有源码项目时是**一句提示**，
 *    不是错误条（契约 §6.7：无源不是故障）；
 * 2. **两阶段安装**：`onPickArchive` 选包 → `planInstall` 只读预检（新增 / 覆盖 / 文件冲突 /
 *    函数冲突 / 兼容性 / 存档影响 / 风险）→ 逐条决议 + 三项显式勾选 → `applyInstall` → 任务进度；
 * 3. **默认拒绝**：高风险（`overrides-logic` / `unknown`）与「可能影响存档」缺省都不放行，
 *    必须用户逐项勾选；`allowIncompatible` / `acknowledgeSaveImpact` 缺省 false（契约要求）；
 * 4. **诊断**：`diagnose` 分「缺文件 / 哈希不符 / 归属冲突 / 函数覆盖 / 依赖缺失 / 兼容性 /
 *    顺序异常」七组，每组人话 + 计数；core 外挂的 `warnings` / `untrusted` 原样补充展示。
 *
 * ## 接线面（组长挂 tab 时按这个形状传）
 *
 * ```tsx
 * <PluginsPanel service={service} instanceId={instance.id} onPickArchive={onPickArchive} />
 * ```
 * `onPickArchive` 缺席（宿主没有 `pickArchive`）⇒ 安装按钮禁用并写明「宿主未提供选择器」。
 *
 * ## 契约缺口（如实展示，不自己扩字段）
 *
 * 函数冲突只包含**真冲突**：命中 adapter `conventionPolicy` 的「预期重复」在
 * `launcher-core` 内部就被收敛了，契约没有承载它的字段，只剩 `plan.warnings` 里一行
 * 「已按适配器约定策略收敛 N 处预期重复：<理由>」。本面板把 warnings 原样列出并在旁边
 * 说明这件事，不把「函数冲突 0 条」读成「没有重复定义」。
 *
 * 纪律：本组件只吃 `@kojo/plugin-api` 的**类型**（不 import 插件实现 / 桥 / kernel）；
 * 样式全在 `launcher.css` 的 `launcher-plugins-*` 段（token 消费，零颜色字面量）。
 * 装载纪律（PS-10）：只被懒加载的 `LauncherView` 静态引用，**没有开机图入口**。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type {
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
  describePluginFailure,
  diagnosisView,
  fileConflictRows,
  functionConflictRows,
  movePluginOrder,
  openSourceHint,
  planReadout,
  pluginDiagnosisExtras,
  pluginRowConfirmText,
  pluginRows,
  pluginTaskView,
  saveImpactDetail,
  saveImpactLabel,
  type ApplyGateInputs,
  type PluginAction,
  type PluginFailure,
  type PluginRowConfirmKind,
} from './plugins-panel-model';
import { isTerminalTaskState, taskWatchMode, watchContentTask } from './content-panel-model';
import './launcher.css';

export interface PluginsPanelProps {
  /** 启动器门面（`launcher.service`）；本面板只用 `plugins` 与 `tasks` 两条腿 */
  readonly service: LauncherService;
  readonly instanceId: string;
  /** 选插件包的**唯一入口**（父层给；父层内部走 `host.pickArchive`） */
  readonly onPickArchive?: () => Promise<string | null>;
}

/** 安装流程的阶段（同一面板内的线性状态机） */
type InstallStage = 'idle' | 'picking' | 'planning' | 'planned' | 'applying' | 'done';

interface InstallState {
  readonly stage: InstallStage;
  readonly archivePath: string | null;
  readonly plan: PluginInstallPlan | null;
  /** 决议键（`file|root/path` / `function|NAME`）→ 用户选择 */
  readonly choices: Readonly<Record<string, PluginAction>>;
  readonly gate: ApplyGateInputs;
  readonly task: LauncherTask | null;
  readonly failure: PluginFailure | null;
  readonly notice: string | null;
}

const IDLE_INSTALL: InstallState = {
  stage: 'idle',
  archivePath: null,
  plan: null,
  choices: {},
  gate: INITIAL_GATE,
  task: null,
  failure: null,
  notice: null,
};

interface RowBusy {
  readonly pluginId: string;
  readonly text: string;
}

interface RowConfirm {
  readonly kind: PluginRowConfirmKind;
  readonly pluginId: string;
  readonly direction?: 'up' | 'down';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 小块：失败读数（复用 `launcher-failure*` 既有样式）
 * ══════════════════════════════════════════════════════════════════════════════ */

function FailureBlock({ failure }: { readonly failure: PluginFailure }): ReactElement {
  return (
    <div className="launcher-failure" role="alert">
      <div className="launcher-failure-head">
        <strong>{failure.title}</strong>
        <code className="launcher-failure-code">{failure.code ?? '无错误码'}</code>
      </div>
      {failure.advice === null ? null : (
        <p className="launcher-failure-heading">{failure.advice.heading}</p>
      )}
      <p className="launcher-failure-message">{failure.message}</p>
      {failure.detail === null ? null : <p className="launcher-failure-detail">{failure.detail}</p>}
      {failure.advice === null ? null : (
        <p className="launcher-failure-why">{failure.advice.explanation}</p>
      )}
      <p className="launcher-failure-hint">
        {failure.advice === null ? failure.hint : failure.advice.nextStep}
      </p>
      <p className="launcher-failure-hint">
        {failure.retryable ? '按上面的建议处理后可以重试。' : '这个错误重试通常无效。'}
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 面板本体
 * ══════════════════════════════════════════════════════════════════════════════ */

export function PluginsPanel({ service, instanceId, onPickArchive }: PluginsPanelProps): ReactElement {
  /* ------------------------------ 已装列表 ------------------------------ */
  const [plugins, setPlugins] = useState<readonly InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [listFailure, setListFailure] = useState<PluginFailure | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  /* ------------------------------ 安装流程 ------------------------------ */
  const [install, setInstall] = useState<InstallState>(IDLE_INSTALL);

  /* ------------------------------ 行内动作 ------------------------------ */
  const [busy, setBusy] = useState<RowBusy | null>(null);
  const [rowTask, setRowTask] = useState<LauncherTask | null>(null);
  const [rowFailure, setRowFailure] = useState<PluginFailure | null>(null);
  const [rowNotice, setRowNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RowConfirm | null>(null);

  /* ------------------------------ 诊断 ------------------------------ */
  const [diagnosis, setDiagnosis] = useState<PluginDiagnosis | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagFailure, setDiagFailure] = useState<PluginFailure | null>(null);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  /* 1. 读已装插件（失败不静默：错误条 + 列表保持上一次读数） */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void service.plugins
      .list(instanceId)
      .then((list) => {
        if (cancelled) return;
        setPlugins(list);
        setListFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListFailure(describePluginFailure(error, 'list'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, instanceId, reloadNonce]);

  /* 2. 预检 */
  const planFor = useCallback(
    async (archivePath: string): Promise<void> => {
      setInstall({ ...IDLE_INSTALL, stage: 'planning', archivePath });
      try {
        const plan = await service.plugins.planInstall(instanceId, archivePath);
        setInstall({
          ...IDLE_INSTALL,
          stage: 'planned',
          archivePath,
          plan,
          choices: {},
          gate: INITIAL_GATE,
        });
      } catch (error) {
        setInstall({ ...IDLE_INSTALL, archivePath, failure: describePluginFailure(error, 'plan') });
      }
    },
    [service, instanceId],
  );

  /* 3. 选包：唯一路径来源是 `onPickArchive` 的回执（取消不是错误） */
  const runPick = useCallback(async (): Promise<void> => {
    if (onPickArchive === undefined) return;
    setInstall({ ...IDLE_INSTALL, stage: 'picking' });
    let picked: string | null;
    try {
      picked = await onPickArchive();
    } catch (error) {
      setInstall({ ...IDLE_INSTALL, failure: describePluginFailure(error, 'plan') });
      return;
    }
    if (picked === null || picked.trim() === '') {
      setInstall({ ...IDLE_INSTALL, notice: '已取消选择插件包：没有做任何改动。' });
      return;
    }
    await planFor(picked.trim());
  }, [onPickArchive, planFor]);

  /* 4. 应用（决议齐 + 门禁勾选齐才放行；这里再兜一次） */
  /**
   * 「这条任务的终态已经处理过一次」的记号。
   *
   * 少了它会重复刷新：先读快照（`tasks.get`）再订阅，同一个终态可能到两次 ⇒ 两次 list。
   * 记号按「任务 id + 状态」记，同一个终态只收一次。
   */
  const settledRef = useRef<Set<string>>(new Set());
  const settleTask = useCallback(
    (next: LauncherTask): void => {
      if (!isTerminalTaskState(next.state)) return;
      const key = `${next.id}:${next.state}`;
      if (settledRef.current.has(key)) return;
      settledRef.current.add(key);
      if (next.state === 'succeeded') {
        reload();
        setDiagnosis(null); // 磁盘变了，旧诊断不再成立
      }
    },
    [reload],
  );

  const runApply = useCallback(async (): Promise<void> => {
    if (install.plan === null) return;
    const built = buildResolutions(install.plan, install.choices);
    const gate = applyGate(install.plan, built, install.gate);
    if (!gate.canApply) {
      setInstall((prev) => ({
        ...prev,
        notice: gate.blockers.length === 0 ? null : gate.blockers.join(' '),
      }));
      return;
    }
    setInstall((prev) => ({ ...prev, stage: 'applying', failure: null, notice: null }));
    try {
      const options = applyOptions(install.plan, install.gate);
      const task = await service.plugins.applyInstall(
        install.plan.planId,
        built.resolutions.length === 0 ? undefined : built.resolutions,
        options,
      );
      setInstall((prev) =>
        prev.stage === 'applying'
          ? { ...prev, task, stage: pluginTaskView(task).terminal ? 'done' : 'applying' }
          : prev,
      );
      // 服务直接返回终态时不等订阅：收尾（刷新列表 / 作废旧诊断）就在这一拍
      settleTask(task);
    } catch (error) {
      // 预检产物保持可见：失败后的下一步往往是改决议 / 补勾选，而不是从头选包
      setInstall((prev) => ({
        ...prev,
        stage: 'planned',
        failure: describePluginFailure(error, 'apply'),
      }));
    }
  }, [install.plan, install.choices, install.gate, service, settleTask]);

  const cancelInstall = useCallback((): void => {
    setInstall(IDLE_INSTALL);
  }, []);

  const chooseAction = (key: string, action: PluginAction): void => {
    setInstall((prev) => ({
      ...prev,
      choices: { ...prev.choices, [key]: action },
      notice: null,
    }));
  };

  const setGate = (patch: Partial<ApplyGateInputs>): void => {
    setInstall((prev) => ({ ...prev, gate: { ...prev.gate, ...patch }, notice: null }));
  };

  /* 5. 行内动作：卸载 / 启停（各自先过确认条） */
  const runRowTask = useCallback(
    async (kind: PluginRowConfirmKind, plugin: InstalledPlugin): Promise<void> => {
      setConfirm(null);
      setRowFailure(null);
      setRowTask(null);
      setRowNotice(null);
      const action = kind === 'uninstall' ? 'uninstall' : 'toggle';
      setBusy({
        pluginId: plugin.manifest.id,
        text:
          kind === 'uninstall' ? '正在卸载…' : plugin.enabled ? '正在停用…' : '正在启用…',
      });
      try {
        const task =
          kind === 'uninstall'
            ? await service.plugins.uninstall(instanceId, plugin.manifest.id)
            : await service.plugins.setEnabled(instanceId, plugin.manifest.id, !plugin.enabled);
        setRowTask(task);
        // 服务直接返回终态时不等订阅（与安装那条腿同一收尾口径）
        settleTask(task);
      } catch (error) {
        setRowFailure(describePluginFailure(error, action));
      } finally {
        setBusy(null);
      }
    },
    [service, instanceId, settleTask],
  );

  const runMove = useCallback(
    async (plugin: InstalledPlugin, direction: -1 | 1): Promise<void> => {
      setConfirm(null);
      const next = movePluginOrder(plugins, plugin.manifest.id, direction);
      if (next === null) return;
      setRowFailure(null);
      setRowNotice(null);
      setBusy({ pluginId: plugin.manifest.id, text: '正在调整加载顺序…' });
      try {
        await service.plugins.setOrder(instanceId, next);
        reload();
      } catch (error) {
        setRowFailure(describePluginFailure(error, 'order'));
      } finally {
        setBusy(null);
      }
    },
    [plugins, service, instanceId, reload],
  );

  /**
   * 「打开源码」：没有源码项目 ⇒ 一句提示；有源但打开失败也**只提示**（不是错误条）。
   * 失败读数仍按动作分标题（`open-source`），码与原话原样带出。
   */
  const runOpenSource = useCallback(
    async (plugin: InstalledPlugin): Promise<void> => {
      setRowFailure(null);
      setRowNotice(null);
      const hint = openSourceHint(plugin);
      if (hint !== null) {
        setRowNotice(hint);
        return;
      }
      setBusy({ pluginId: plugin.manifest.id, text: '正在打开源码项目…' });
      try {
        await service.plugins.openSource(instanceId, plugin.manifest.id);
        setRowNotice(`已在编辑器里请求打开「${plugin.manifest.name}」的源码项目。`);
      } catch (error) {
        const failure = describePluginFailure(error, 'open-source');
        setRowNotice(`${failure.title}：${failure.code ?? '无错误码'} · ${failure.message}`);
      } finally {
        setBusy(null);
      }
    },
    [service, instanceId],
  );

  /* 6. 诊断（只读） */
  const runDiagnose = useCallback(async (): Promise<void> => {
    setDiagBusy(true);
    setDiagFailure(null);
    setRowNotice(null);
    try {
      const report = await service.plugins.diagnose(instanceId);
      setDiagnosis(report);
    } catch (error) {
      setDiagnosis(null);
      setDiagFailure(describePluginFailure(error, 'diagnose'));
    } finally {
      setDiagBusy(false);
    }
  }, [service, instanceId]);

  /* 7. 任务进度：订阅优先 / 轮询兜底（复用内容面板同一条实现） */
  const installTaskId = install.task?.id ?? null;
  const rowTaskId = rowTask?.id ?? null;
  const activeTaskId = installTaskId ?? rowTaskId;

  useEffect(() => {
    if (activeTaskId === null) return;
    return watchContentTask(service.tasks, activeTaskId, (task) => {
      const view = pluginTaskView(task);
      if (installTaskId === activeTaskId) {
        setInstall((prev) =>
          prev.task?.id === activeTaskId
            ? { ...prev, task, stage: view.terminal ? 'done' : prev.stage }
            : prev,
        );
      } else {
        setRowTask((prev) => (prev !== null && prev.id === activeTaskId ? task : prev));
      }
      settleTask(task);
    });
  }, [activeTaskId, installTaskId, service, settleTask]);

  /* ------------------------------ 派生读数 ------------------------------ */
  const rows = useMemo(() => pluginRows(plugins), [plugins]);
  const planView = useMemo(
    () => (install.plan === null ? null : planReadout(install.plan)),
    [install.plan],
  );
  const built = useMemo(
    () => (install.plan === null ? null : buildResolutions(install.plan, install.choices)),
    [install.plan, install.choices],
  );
  const gateView = useMemo(
    () =>
      install.plan === null || built === null
        ? null
        : applyGate(install.plan, built, install.gate),
    [install.plan, built, install.gate],
  );
  const fileConflicts = useMemo(
    () => (install.plan === null ? [] : fileConflictRows(install.plan)),
    [install.plan],
  );
  const functionConflicts = useMemo(
    () => (install.plan === null ? [] : functionConflictRows(install.plan)),
    [install.plan],
  );
  const taskView = useMemo(
    () => (install.task === null ? null : pluginTaskView(install.task)),
    [install.task],
  );
  const rowTaskView = useMemo(
    () => (rowTask === null ? null : pluginTaskView(rowTask)),
    [rowTask],
  );
  const diagView = useMemo(
    () => (diagnosis === null ? null : diagnosisView(diagnosis)),
    [diagnosis],
  );
  const diagExtras = useMemo(
    () => (diagnosis === null ? null : pluginDiagnosisExtras(diagnosis)),
    [diagnosis],
  );
  const watchMode = useMemo(() => taskWatchMode(service.tasks), [service]);

  const canPick = onPickArchive !== undefined;
  const installRunning =
    install.stage === 'picking' || install.stage === 'planning' || install.stage === 'applying';
  const showFlow = install.stage !== 'idle' || install.failure !== null || install.notice !== null;

  return (
    <section className="launcher-plugins" aria-label="游戏插件">
      <header className="launcher-plugins-head">
        <h4 className="launcher-plugins-title">
          游戏插件
          <span className="launcher-plugins-count">
            {loading ? '读取中…' : `已装 ${plugins.length} 个`}
          </span>
        </h4>
        <div className="launcher-plugins-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => void runDiagnose()}
            disabled={diagBusy}
          >
            {diagBusy ? '诊断中…' : '诊断'}
          </button>
          <button type="button" className="ghost small" onClick={reload} disabled={loading}>
            刷新
          </button>
          <button
            type="button"
            className="primary small"
            onClick={() => void runPick()}
            disabled={!canPick || installRunning}
            title={canPick ? '选一个插件 ZIP，先看计划再决定要不要写盘' : '这一版宿主没有提供选择器'}
          >
            选择插件包…
          </button>
          {canPick ? null : <span className="launcher-plugins-hint">宿主未提供选择器</span>}
        </div>
      </header>

      {loading && plugins.length === 0 ? (
        <p className="launcher-note" role="status">
          正在读取已装插件…
        </p>
      ) : null}
      {listFailure === null ? null : <FailureBlock failure={listFailure} />}

      {plugins.length === 0 ? (
        loading ? null : (
          <div className="launcher-plugins-empty">
            <p>还没有安装游戏插件</p>
            <p className="launcher-plugins-hint">
              点「选择插件包…」选一个 ZIP：预检会先解到暂存、算清文件 / 函数冲突、兼容性与存档影响，
              你逐项确认之后才真正写进实例的内容根。装前会先停游戏，失败按逆序回滚。
            </p>
          </div>
        )
      ) : (
        <ul className="launcher-plugins-list" aria-label="已装游戏插件">
          {rows.map((row) => (
            <li
              className="launcher-plugins-row"
              key={row.pluginId}
              data-enabled={row.enabled ? 'true' : 'false'}
            >
              <div className="launcher-plugins-row-head">
                <span className="launcher-plugins-name">{row.name}</span>
                <span className="launcher-badge">{row.version}</span>
                <span className="launcher-status" data-tone={row.riskTone}>
                  {row.riskLabel}
                </span>
                <span className="launcher-status" data-tone={row.compatibilityTone}>
                  {row.compatibilityLabel}
                </span>
                <span className="launcher-status" data-tone={row.trustTone}>
                  {row.trustLabel}
                </span>
                <span className="launcher-status" data-tone={row.enabledTone}>
                  {row.enabledLabel}
                </span>
                {row.statusTone === 'ok' ? null : (
                  <span className="launcher-status" data-tone={row.statusTone}>
                    {row.statusLabel}
                  </span>
                )}
              </div>
              <p className="launcher-plugins-hint">
                顺序 {row.rank} · {row.pluginId} · 本包写入 {row.fileCount} 个文件 · {row.trustDetail}
                {row.requiresRestart ? ' · 装 / 卸 / 启停后需重启游戏' : ''}
              </p>
              <div className="launcher-plugins-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() =>
                    setConfirm({ kind: row.enabled ? 'disable' : 'enable', pluginId: row.pluginId })
                  }
                >
                  {row.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={!row.canMoveUp || busy !== null}
                  onClick={() =>
                    setConfirm({ kind: 'order', pluginId: row.pluginId, direction: 'up' })
                  }
                >
                  上移
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={!row.canMoveDown || busy !== null}
                  onClick={() =>
                    setConfirm({ kind: 'order', pluginId: row.pluginId, direction: 'down' })
                  }
                >
                  下移
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  title={
                    row.canOpenSource
                      ? '在编辑器里打开这个插件的源码项目'
                      : '外部 ZIP 安装：没有源码项目（点了只会给一句提示）'
                  }
                  onClick={() => {
                    const plugin = plugins.find((entry) => entry.manifest.id === row.pluginId);
                    if (plugin !== undefined) void runOpenSource(plugin);
                  }}
                >
                  打开源码
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() => setConfirm({ kind: 'uninstall', pluginId: row.pluginId })}
                >
                  卸载
                </button>
                {busy !== null && busy.pluginId === row.pluginId ? (
                  <span className="launcher-busy" role="status">
                    {busy.text}
                  </span>
                ) : null}
              </div>
              {confirm !== null && confirm.pluginId === row.pluginId ? (
                <div className="launcher-plugins-confirm" role="group" aria-label="确认操作">
                  <p className="launcher-plugins-confirm-text">
                    {pluginRowConfirmText({
                      kind: confirm.kind,
                      name: row.name,
                      direction: confirm.direction,
                      fileCount: row.fileCount,
                    })}
                  </p>
                  <div className="launcher-plugins-actions">
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => {
                        const plugin = plugins.find((entry) => entry.manifest.id === row.pluginId);
                        if (plugin === undefined) return;
                        if (confirm.kind === 'order') {
                          void runMove(plugin, confirm.direction === 'up' ? -1 : 1);
                          return;
                        }
                        void runRowTask(confirm.kind, plugin);
                      }}
                    >
                      确认
                    </button>
                    <button type="button" className="ghost small" onClick={() => setConfirm(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {rowNotice === null ? null : (
        <p className="launcher-plugins-notice" role="status">
          {rowNotice}
        </p>
      )}

      {showFlow ? (
        <section className="launcher-plugins-flow" aria-label="安装游戏插件">
          {install.failure === null ? null : <FailureBlock failure={install.failure} />}
          {install.notice === null ? null : (
            <p className="launcher-note" role="status">
              {install.notice}
            </p>
          )}

          {install.stage === 'picking' ? (
            <p className="launcher-note" role="status">
              正在等待系统选择器…
            </p>
          ) : null}
          {install.stage === 'planning' ? (
            <p className="launcher-note" role="status">
              正在预检：解到暂存、校验清单、算文件 / 函数冲突、兼容性与存档影响（不碰游戏根）…
            </p>
          ) : null}

          {install.stage === 'planned' && planView !== null && install.plan !== null ? (
            <>
              <div className="launcher-plugins-plan-head">
                <strong>{planView.title}</strong>
                <span className="launcher-badge">{planView.modeLabel}</span>
                <span className="launcher-status" data-tone={planView.riskTone}>
                  {planView.riskLabel}
                </span>
                <span className="launcher-status" data-tone={planView.expired ? 'warn' : 'busy'}>
                  {planView.expired ? '计划已过期' : '计划有效'}
                </span>
              </div>
              <p className="launcher-plugins-hint">{planView.subtitle}</p>
              <dl className="launcher-facts launcher-plugins-facts" aria-label="插件安装计划读数">
                {planView.rows.map((row) => (
                  <div className="launcher-fact" key={row.label} data-tone={row.tone ?? 'idle'}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="launcher-plugins-gate">
                <p className="launcher-plugins-gate-title">兼容性</p>
                <p className="launcher-plugins-hint">
                  {planView.compatibility.label} · {planView.compatibility.detail}
                </p>
                {planView.compatibility.reasons.length === 0 ? null : (
                  <ul className="launcher-plugins-warnings">
                    {planView.compatibility.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                <p className="launcher-plugins-gate-title">存档影响</p>
                <p className="launcher-plugins-hint">
                  {saveImpactLabel(install.plan.saveImpact)} · {saveImpactDetail(install.plan.saveImpact)}
                </p>
                <p className="launcher-plugins-gate-title">来源与信任</p>
                <p className="launcher-plugins-hint">
                  作者：{install.plan.manifest.author ?? '未声明'} · 外部 ZIP 未验签（首版没有签名验证）。
                  风险无法归类的插件还会在 core 侧被原生确认框再拦一次（未获确认会被拒）。
                </p>
              </div>

              {install.plan.missingRequirements.length === 0 ? null : (
                <p className="launcher-warn-note">
                  依赖未满足：{install.plan.missingRequirements.join('、')}（应用会被拒绝，首版不自动下载依赖）
                </p>
              )}
              {install.plan.warnings.length === 0 ? null : (
                <>
                  <p className="launcher-plugins-gate-title">门禁读数与警告（原样来自启动器内核）</p>
                  <ul className="launcher-plugins-warnings">
                    {install.plan.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <p className="launcher-plugins-hint">
                    函数冲突一栏只列「真冲突」：命中适配器约定策略的「预期重复」在 core 内部被收敛，
                    契约没有单独字段，收敛条数只出现在上面的警告行里。
                  </p>
                </>
              )}

              <div className="launcher-plugins-conflicts-head">
                <strong>文件冲突（{fileConflicts.length} 条）</strong>
                <span className="launcher-plugins-hint">
                  {fileConflicts.length === 0
                    ? '没有文件冲突：本包只新增文件。'
                    : '每条都要决断：漏一条整包都不落盘。'}
                </span>
              </div>
              {fileConflicts.length === 0 ? null : (
                <ul className="launcher-plugins-conflicts">
                  {fileConflicts.map((row) => {
                    const chosen = install.choices[row.key];
                    const chosenOption = row.options.find((option) => option.action === chosen) ?? null;
                    return (
                      <li className="launcher-plugins-conflict" key={row.key} data-kind={row.kind}>
                        <span className="launcher-plugins-conflict-path">{row.path}</span>
                        <span className="launcher-plugins-hint">
                          {row.kindLabel} · {row.ownerLabel}
                        </span>
                        <div
                          className="launcher-plugins-actions"
                          role="group"
                          aria-label={`文件冲突决议：${row.path}`}
                        >
                          {row.options.map((option) => (
                            <button
                              key={option.action}
                              type="button"
                              className="ghost small"
                              aria-pressed={chosen === option.action}
                              title={option.hint}
                              onClick={() => chooseAction(row.key, option.action)}
                            >
                              {option.label}
                            </button>
                          ))}
                          <span className="launcher-plugins-hint">
                            {chosenOption === null ? '未决断' : chosenOption.hint}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="launcher-plugins-conflicts-head">
                <strong>函数冲突（{functionConflicts.length} 条真冲突）</strong>
                <span className="launcher-plugins-hint">
                  {functionConflicts.length === 0
                    ? '没有真冲突（「预期重复」见上面的警告行）。'
                    : '逐条决定：保留既有定义（整份文件跳过）或覆盖（先备份）。'}
                </span>
              </div>
              {functionConflicts.length === 0 ? null : (
                <ul className="launcher-plugins-conflicts">
                  {functionConflicts.map((row) => {
                    const chosen = install.choices[row.key];
                    const chosenOption = row.options.find((option) => option.action === chosen) ?? null;
                    return (
                      <li className="launcher-plugins-conflict" key={row.key} data-kind="function">
                        <span className="launcher-plugins-conflict-path">{row.functionName}</span>
                        <span className="launcher-plugins-hint">
                          既有：{row.existingLabel} · 本次：{row.incomingLabel}
                        </span>
                        <div
                          className="launcher-plugins-actions"
                          role="group"
                          aria-label={`函数冲突决议：${row.functionName}`}
                        >
                          {row.options.map((option) => (
                            <button
                              key={option.action}
                              type="button"
                              className="ghost small"
                              aria-pressed={chosen === option.action}
                              title={option.hint}
                              onClick={() => chooseAction(row.key, option.action)}
                            >
                              {option.label}
                            </button>
                          ))}
                          <span className="launcher-plugins-hint">
                            {chosenOption === null ? '未决断' : chosenOption.hint}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <fieldset className="launcher-plugins-gate">
                <legend className="launcher-plugins-gate-title">写盘前确认（缺省一律不放行）</legend>
                {gateView !== null && gateView.needsIncompatible ? (
                  <label className="launcher-plugins-check">
                    <input
                      type="checkbox"
                      checked={install.gate.allowIncompatible}
                      onChange={(event) => setGate({ allowIncompatible: event.target.checked })}
                    />
                    <span>仍然安装不兼容插件（会标「不兼容」，并在每次启动前警告）</span>
                  </label>
                ) : null}
                {gateView !== null && gateView.needsRisk ? (
                  <label className="launcher-plugins-check">
                    <input
                      type="checkbox"
                      checked={install.gate.acknowledgeRisk}
                      onChange={(event) => setGate({ acknowledgeRisk: event.target.checked })}
                    />
                    <span>
                      我已知晓这是「{planView.riskLabel}」插件：会覆盖既有逻辑或风险无法归类，确认安装
                    </span>
                  </label>
                ) : null}
                {gateView !== null && gateView.needsSaveImpact ? (
                  <label className="launcher-plugins-check">
                    <input
                      type="checkbox"
                      checked={install.gate.acknowledgeSaveImpact}
                      onChange={(event) => setGate({ acknowledgeSaveImpact: event.target.checked })}
                    />
                    <span>
                      我已知晓存档影响（{saveImpactLabel(install.plan.saveImpact)}）：应用前会先自动备份存档
                    </span>
                  </label>
                ) : null}
                <p className="launcher-plugins-hint">
                  这三项缺省都不勾：勾了才把对应字段交给 `applyInstall`（`allowIncompatible` /
                  `acknowledgeSaveImpact`），不勾就是不传。
                </p>
              </fieldset>

              {gateView !== null && gateView.blockers.length > 0 ? (
                <ul className="launcher-plugins-blockers" aria-label="还不能开始安装的原因">
                  {gateView.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}

              <div className="launcher-plugins-actions">
                <button
                  type="button"
                  className="primary small"
                  disabled={gateView === null || !gateView.canApply}
                  onClick={() => void runApply()}
                >
                  开始安装
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={install.archivePath === null}
                  onClick={() => {
                    if (install.archivePath !== null) void planFor(install.archivePath);
                  }}
                >
                  重新预检
                </button>
                <button type="button" className="ghost small" onClick={cancelInstall}>
                  取消安装
                </button>
                {gateView !== null && !gateView.canApply ? (
                  <span className="launcher-plugins-hint">
                    还有 {gateView.blockers.length} 项未满足（见上方清单）
                  </span>
                ) : null}
              </div>
            </>
          ) : null}

          {install.stage === 'applying' && taskView !== null ? (
            <div className="launcher-plugins-task" role="status" aria-label="安装进度">
              <div className="launcher-plugins-plan-head">
                <strong>{taskView.headline}</strong>
                <span className="launcher-status" data-tone={taskView.tone}>
                  {taskView.terminal ? '已结束' : '进行中'}
                </span>
              </div>
              <p className="launcher-plugins-hint">{taskView.detail}</p>
              <p className="launcher-plugins-hint">
                进度来源：
                {watchMode === 'subscribe'
                  ? '任务中心订阅（tasks.subscribe）'
                  : '轮询（每 0.8 秒读一次任务快照）'}
              </p>
              {taskView.percent === null ? null : (
                <progress className="launcher-progress" max={100} value={taskView.percent}>
                  {taskView.percent}%
                </progress>
              )}
              <div className="launcher-plugins-actions">
                {taskView.cancellable && install.task !== null ? (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => {
                      const id = install.task?.id;
                      if (id !== undefined) void service.tasks.cancel(id);
                    }}
                  >
                    取消任务
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {install.stage === 'done' && taskView !== null ? (
            <div className="launcher-plugins-task" aria-label="安装结果">
              <div className="launcher-plugins-plan-head">
                <strong>{taskView.headline}</strong>
                <span className="launcher-status" data-tone={taskView.tone}>
                  {taskView.state === 'succeeded'
                    ? '成功'
                    : taskView.state === 'failed'
                      ? '失败'
                      : '已取消'}
                </span>
              </div>
              <p className="launcher-plugins-hint">{taskView.detail}</p>
              <p className="launcher-plugins-hint">{taskView.note}</p>
              {taskView.errorText === null ? null : (
                <p className="launcher-warn-note">任务失败：{taskView.errorText}</p>
              )}
              <div className="launcher-plugins-actions">
                <button type="button" className="ghost small" onClick={cancelInstall}>
                  收起
                </button>
              </div>
            </div>
          ) : null}

          {install.stage === 'idle' ? (
            <div className="launcher-plugins-actions">
              <button type="button" className="ghost small" onClick={cancelInstall}>
                收起
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {rowTaskView === null ? null : (
        <section className="launcher-plugins-task" aria-label="插件任务进度">
          <div className="launcher-plugins-plan-head">
            <strong>{rowTaskView.headline}</strong>
            <span className="launcher-status" data-tone={rowTaskView.tone}>
              {rowTaskView.terminal ? '已结束' : '进行中'}
            </span>
            <button type="button" className="ghost small" onClick={() => setRowTask(null)}>
              收起
            </button>
          </div>
          <p className="launcher-plugins-hint">{rowTaskView.detail}</p>
          <p className="launcher-plugins-hint">{rowTaskView.note}</p>
          {rowTaskView.errorText === null ? null : (
            <p className="launcher-warn-note">任务失败：{rowTaskView.errorText}</p>
          )}
        </section>
      )}
      {rowFailure === null ? null : <FailureBlock failure={rowFailure} />}

      {diagFailure === null ? null : <FailureBlock failure={diagFailure} />}
      {diagView === null ? null : (
        <section className="launcher-plugins-diagnosis" aria-label="插件诊断">
          <div className="launcher-plugins-plan-head">
            <strong>{diagView.headline}</strong>
            <button type="button" className="ghost small" onClick={() => setDiagnosis(null)}>
              收起
            </button>
          </div>
          {diagView.ok ? (
            <p className="launcher-plugins-hint">
              归属文件、哈希、函数覆盖与加载顺序都与安装记录一致（只读检查，没有改动任何文件）。
            </p>
          ) : (
            <ul className="launcher-plugins-groups">
              {diagView.groups.map((group) => (
                <li className="launcher-plugins-group" key={group.key} data-group={group.key}>
                  <div className="launcher-plugins-group-head">
                    <span className="launcher-plugins-group-label">{group.label}</span>
                    <span className="launcher-badge">{group.items.length} 项</span>
                  </div>
                  <p className="launcher-plugins-hint">{group.explanation}</p>
                  {group.items.length === 0 ? null : (
                    <ul className="launcher-plugins-group-items">
                      {group.items.map((item) => (
                        <li key={item.key}>
                          <code className="launcher-plugins-group-plugin">{item.pluginId}</code>
                          {item.path === null ? '' : ` ${item.path}`}
                          {item.functionName === null ? '' : ` · ${item.functionName}`}
                          {` · ${item.message}`}
                        </li>
                      ))}
                    </ul>
                  )}
                  {group.items.length === 0 ? null : (
                    <p className="launcher-plugins-hint">下一步：{group.nextStep}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {diagExtras === null ||
          (diagExtras.warnings.length === 0 && diagExtras.untrusted.length === 0) ? null : (
            <ul className="launcher-plugins-warnings" aria-label="诊断补充读数">
              {diagExtras.warnings.map((line) => (
                <li key={`w:${line}`}>{line}</li>
              ))}
              {diagExtras.untrusted.map((line) => (
                <li key={`u:${line}`}>{line}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
