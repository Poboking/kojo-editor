/**
 * 启动器 · 实例详情的「内容包」面板（UI-CONTENT 车道交付面）。
 *
 * ## 这个面板负责什么
 *
 * 一条完整的**安装管线 + 日常维护**，全部走 `service.content.*`，不碰磁盘、不拼路径：
 * 1. 已装列表：名称 / 版本 / kind / 启用态 / 顺序（上移下移）/ 状态徽标；空态引导安装；
 * 2. 安装（同一面板内）：选包 → `planInstall` 读数（条目 / 字节 / 冲突 / 过期）→
 *    逐条 `ConflictResolution` 决议 → `applyInstall` → 任务进度 → 成功 / 失败 / 取消；
 * 3. 启停 / 排序 / 卸载：每颗按钮各自带确认条（卸载说清「只删本包写入的文件」）；
 * 4. 诊断：`diagnose` 分「缺失 / 篡改 / 孤儿 / 顺序异常」四组，每组人话 + 计数。
 *
 * ## 两条硬约束（写代码前先看）
 *
 * - **不弹原生对话框、不选文件**：安装入口只有一条 `onPickArchive?: () => Promise<string | null>`
 *   （由父层给，父层再走 `host.pickArchive`）。本组件**不 import 桥、不 import kernel**，
 *   拿不到这条回调就禁用按钮并写明「宿主未提供选择器」——不假装能选。
 * - **样式**：全部 `launcher-content-*` + 复用的 `launcher-*` 类，颜色一律吃 token
 *   （`launcher.css`，由 `LauncherView.tsx` 引入）。本文件零颜色字面量、零新依赖。
 *
 * ## 任务进度从哪来（如实写在界面上）
 *
 * 订阅优先：`tasks.subscribe`（宿主推来的快照才是真相）；服务没有推送能力时退化为
 * `CONTENT_TASK_POLL_INTERVAL_MS`（800 ms）轮询 `tasks.get`。见
 * `content-panel-model.ts::watchContentTask` 与 `taskWatchMode`——界面上那行小字
 * 就是它算出来的，不让用户猜。
 *
 * ## 装载纪律（PS-10）
 *
 * 本组件只被 `LauncherView`（懒 chunk）静态引用，**没有任何开机图入口**；
 * 由组长接线成详情页的一个 tab。
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
  ContentDiagnosis,
  ContentInstallPlan,
  InstalledContent,
  LauncherService,
  LauncherTask,
} from '@kojo/plugin-api';
import {
  buildResolutions,
  contentRows,
  contentTaskView,
  conflictRows,
  describeContentFailure,
  diagnosisView,
  moveOrder,
  planReadout,
  rowConfirmText,
  taskWatchMode,
  watchContentTask,
  type ContentAction,
  type ContentConflictAction,
  type ContentFailure,
  type RowConfirmKind,
} from './content-panel-model';

export interface ContentPanelProps {
  /** 启动器门面（`launcher.service`）；本面板只用 `content` 与 `tasks` 两条腿 */
  readonly service: LauncherService;
  readonly instanceId: string;
  /**
   * 选安装包的**唯一入口**（父层给；父层内部走 `host.pickArchive`，本组件不 import 桥）。
   * 缺席 ⇒ 安装按钮禁用并写明「宿主未提供选择器」。
   */
  readonly onPickArchive?: () => Promise<string | null>;
}

/** 安装流程的阶段（同一面板内的线性状态机） */
type InstallStage = 'idle' | 'picking' | 'planning' | 'planned' | 'applying' | 'done';

interface InstallState {
  readonly stage: InstallStage;
  /** 已选中的安装包路径（`planInstall` 的入参；只由 `onPickArchive` 回执写入） */
  readonly archivePath: string | null;
  readonly plan: ContentInstallPlan | null;
  /** 冲突键（`rootId/path`）→ 用户选择的决议 */
  readonly choices: Readonly<Record<string, ContentConflictAction>>;
  readonly task: LauncherTask | null;
  readonly failure: ContentFailure | null;
  /** 一行说明（取消选择 / 漏决断等不是错误的提示） */
  readonly notice: string | null;
}

const IDLE_INSTALL: InstallState = {
  stage: 'idle',
  archivePath: null,
  plan: null,
  choices: {},
  task: null,
  failure: null,
  notice: null,
};

interface RowBusy {
  readonly packId: string;
  readonly text: string;
}

interface RowConfirm {
  readonly kind: RowConfirmKind;
  readonly packId: string;
  readonly direction?: 'up' | 'down';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 小块：失败读数 / 进度条
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 失败读数：标题 / 码 / 原文 / 为什么 / 下一步（码与原文一个字都不改写） */
function FailureBlock({ failure }: { readonly failure: ContentFailure }): ReactElement {
  return (
    <div className="launcher-failure" role="alert">
      <div className="launcher-failure-head">
        <strong>{failure.title}</strong>
        <code className="launcher-failure-code">{failure.code ?? '无错误码'}</code>
      </div>
      {failure.advice === null ? null : (
        <p className="launcher-failure-heading" data-tone="warn">
          {failure.advice.heading}
        </p>
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

export function ContentPanel({ service, instanceId, onPickArchive }: ContentPanelProps): ReactElement {
  /* ------------------------------ 已装列表 ------------------------------ */
  const [packs, setPacks] = useState<readonly InstalledContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [listFailure, setListFailure] = useState<ContentFailure | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  /* ------------------------------ 安装流程 ------------------------------ */
  const [install, setInstall] = useState<InstallState>(IDLE_INSTALL);

  /* ------------------------------ 行内动作 ------------------------------ */
  const [busy, setBusy] = useState<RowBusy | null>(null);
  const [rowTask, setRowTask] = useState<LauncherTask | null>(null);
  const [rowFailure, setRowFailure] = useState<ContentFailure | null>(null);
  const [confirm, setConfirm] = useState<RowConfirm | null>(null);

  /* ------------------------------ 诊断 ------------------------------ */
  const [diagnosis, setDiagnosis] = useState<ContentDiagnosis | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagFailure, setDiagFailure] = useState<ContentFailure | null>(null);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  /* 1. 读已装清单（失败不静默：错误条 + 列表保持上一次读数） */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void service.content
      .list(instanceId)
      .then((list) => {
        if (cancelled) return;
        setPacks(list);
        setListFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListFailure(describeContentFailure(error, 'list'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, instanceId, reloadNonce]);

  /* 2. 预检（选包之后 / 重新预检都走这里） */
  const planFor = useCallback(
    async (archivePath: string): Promise<void> => {
      setInstall({ ...IDLE_INSTALL, stage: 'planning', archivePath });
      try {
        const plan = await service.content.planInstall(instanceId, archivePath);
        setInstall({ ...IDLE_INSTALL, stage: 'planned', archivePath, plan, choices: {} });
      } catch (error) {
        setInstall({
          ...IDLE_INSTALL,
          archivePath,
          failure: describeContentFailure(error, 'plan'),
        });
      }
    },
    [service, instanceId],
  );

  /* 3. 选包：唯一的路径来源是 `onPickArchive` 的回执（对话框即授权；取消不是错误） */
  const runPick = useCallback(async (): Promise<void> => {
    if (onPickArchive === undefined) return;
    setInstall({ ...IDLE_INSTALL, stage: 'picking' });
    let picked: string | null;
    try {
      picked = await onPickArchive();
    } catch (error) {
      setInstall({ ...IDLE_INSTALL, failure: describeContentFailure(error, 'plan') });
      return;
    }
    if (picked === null || picked.trim() === '') {
      setInstall({ ...IDLE_INSTALL, notice: '已取消选择安装包：没有做任何改动。' });
      return;
    }
    await planFor(picked.trim());
  }, [onPickArchive, planFor]);

  /* 4. 应用（决议必须逐条齐；漏一条按钮就是灰的，这里再兜一次） */
  const runApply = useCallback(async (): Promise<void> => {
    if (install.plan === null) return;
    const built = buildResolutions(install.plan, install.choices);
    if (built.pending.length > 0) {
      setInstall((prev) => ({
        ...prev,
        notice: `还有 ${built.pending.length} 条冲突没决断：逐条选「跳过」或「替换 / 覆盖」再安装。`,
      }));
      return;
    }
    setInstall((prev) => ({ ...prev, stage: 'applying', failure: null, notice: null }));
    try {
      const task = await service.content.applyInstall(
        install.plan.planId,
        built.resolutions.length === 0 ? undefined : built.resolutions,
      );
      setInstall((prev) =>
        prev.stage === 'applying'
          ? { ...prev, task, stage: contentTaskView(task).terminal ? 'done' : 'applying' }
          : prev,
      );
    } catch (error) {
      // 预检产物保持可见：失败的下一步往往是改决议再来一次，而不是从头选包
      setInstall((prev) => ({
        ...prev,
        stage: 'planned',
        failure: describeContentFailure(error, 'apply'),
      }));
    }
  }, [install.plan, install.choices, service]);

  const cancelInstall = useCallback((): void => {
    setInstall(IDLE_INSTALL);
  }, []);

  /* 5. 行内动作：卸载 / 启停（各自先过确认条） */
  const runRowTask = useCallback(
    async (kind: RowConfirmKind, pack: InstalledContent): Promise<void> => {
      setConfirm(null);
      setRowFailure(null);
      setRowTask(null);
      const action: ContentAction = kind === 'uninstall' ? 'uninstall' : 'toggle';
      setBusy({
        packId: pack.manifest.id,
        text:
          kind === 'uninstall'
            ? '正在卸载…'
            : pack.enabled
              ? '正在停用…'
              : '正在启用…',
      });
      try {
        const task =
          kind === 'uninstall'
            ? await service.content.uninstall(instanceId, pack.manifest.id)
            : await service.content.setEnabled(instanceId, pack.manifest.id, !pack.enabled);
        setRowTask(task);
      } catch (error) {
        setRowFailure(describeContentFailure(error, action));
      } finally {
        setBusy(null);
      }
    },
    [service, instanceId],
  );

  /** 上移 / 下移：给 `setOrder` 交**整份排列**（边界返回 null ⇒ 什么都不做） */
  const runMove = useCallback(
    async (pack: InstalledContent, direction: -1 | 1): Promise<void> => {
      setConfirm(null);
      const next = moveOrder(packs, pack.manifest.id, direction);
      if (next === null) return;
      setRowFailure(null);
      setBusy({ packId: pack.manifest.id, text: '正在调整加载顺序…' });
      try {
        await service.content.setOrder(instanceId, next);
        reload();
      } catch (error) {
        setRowFailure(describeContentFailure(error, 'order'));
      } finally {
        setBusy(null);
      }
    },
    [packs, service, instanceId, reload],
  );

  /* 6. 诊断（只读；结果留在面板里直到用户收起或列表变化） */
  const runDiagnose = useCallback(async (): Promise<void> => {
    setDiagBusy(true);
    setDiagFailure(null);
    try {
      const report = await service.content.diagnose(instanceId);
      setDiagnosis(report);
    } catch (error) {
      setDiagnosis(null);
      setDiagFailure(describeContentFailure(error, 'diagnose'));
    } finally {
      setDiagBusy(false);
    }
  }, [service, instanceId]);

  /* 7. 任务进度：订阅优先 / 轮询兜底（见模块头；模式如实写在界面上） */
  const installTaskId = install.task?.id ?? null;
  const rowTaskId = rowTask?.id ?? null;
  const activeTaskId = installTaskId ?? rowTaskId;
  /**
   * 「这条任务的终态已经处理过一次」的记号。
   *
   * 少了它会重复刷新：先读快照（`tasks.get`）再订阅，同一个终态可能到两次 ⇒ 两次 list。
   * 记号按 `任务 id + 状态` 记，同一个终态只收一次。
   */
  const settledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (activeTaskId === null) return;
    return watchContentTask(service.tasks, activeTaskId, (task) => {
      const view = contentTaskView(task);
      if (installTaskId === activeTaskId) {
        setInstall((prev) =>
          prev.task?.id === activeTaskId
            ? { ...prev, task, stage: view.terminal ? 'done' : prev.stage }
            : prev,
        );
      } else {
        setRowTask((prev) => (prev !== null && prev.id === activeTaskId ? task : prev));
      }
      if (!view.terminal) return;
      const key = `${task.id}:${task.state}`;
      if (settledRef.current.has(key)) return;
      settledRef.current.add(key);
      if (task.state === 'succeeded') {
        reload();
        setDiagnosis(null); // 磁盘变了，旧诊断不再成立
      }
    });
  }, [activeTaskId, installTaskId, service, reload]);

  /* ------------------------------ 派生读数 ------------------------------ */
  const rows = useMemo(() => contentRows(packs), [packs]);
  const planView = useMemo(() => (install.plan === null ? null : planReadout(install.plan)), [install.plan]);
  const conflictView = useMemo(
    () => (install.plan === null ? [] : conflictRows(install.plan)),
    [install.plan],
  );
  const built = useMemo(
    () => (install.plan === null ? null : buildResolutions(install.plan, install.choices)),
    [install.plan, install.choices],
  );
  const taskView = useMemo(() => (install.task === null ? null : contentTaskView(install.task)), [install.task]);
  const rowTaskView = useMemo(() => (rowTask === null ? null : contentTaskView(rowTask)), [rowTask]);
  const diagView = useMemo(() => (diagnosis === null ? null : diagnosisView(diagnosis)), [diagnosis]);
  const watchMode = useMemo(() => taskWatchMode(service.tasks), [service]);

  const canPick = onPickArchive !== undefined;
  const installRunning = install.stage === 'picking' || install.stage === 'planning' || install.stage === 'applying';
  const showFlow =
    install.stage !== 'idle' || install.failure !== null || install.notice !== null;

  const chooseAction = (key: string, action: ContentConflictAction): void => {
    setInstall((prev) => ({
      ...prev,
      choices: { ...prev.choices, [key]: action },
      notice: null,
    }));
  };

  return (
    <section className="launcher-content" aria-label="内容包">
      <header className="launcher-content-head">
        <h4 className="launcher-content-title">
          内容包
          <span className="launcher-content-count">
            {loading ? '读取中…' : `已装 ${packs.length} 个`}
          </span>
        </h4>
        <div className="launcher-content-head-actions">
          <button type="button" className="ghost small" onClick={() => void runDiagnose()} disabled={diagBusy}>
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
            title={canPick ? '选一个 ZIP，先看计划再决定要不要写盘' : '这一版宿主没有提供选择器'}
          >
            选择安装包…
          </button>
          {canPick ? null : <span className="launcher-content-hint">宿主未提供选择器</span>}
        </div>
      </header>

      {loading && packs.length === 0 ? (
        <p className="launcher-note" role="status">
          正在读取已装内容…
        </p>
      ) : null}
      {listFailure === null ? null : <FailureBlock failure={listFailure} />}

      {packs.length === 0 ? (
        loading ? null : (
          <div className="launcher-content-empty">
            <p>还没有安装内容包</p>
            <p className="launcher-content-hint">
              点「选择安装包…」选一个 ZIP：预检会先解到暂存、算清条目 / 体积 / 冲突，
              你确认之后才真正写进实例的内容根。卸载或停用后可回滚，游戏存档不受影响。
            </p>
          </div>
        )
      ) : (
        <ul className="launcher-content-list" aria-label="已装内容包">
          {rows.map((row) => (
            <li className="launcher-content-row" key={row.packId} data-enabled={row.enabled ? 'true' : 'false'}>
              <div className="launcher-content-row-head">
                <span className="launcher-content-name">{row.name}</span>
                <span className="launcher-badge">{row.version}</span>
                <span className="launcher-badge">{row.kindLabel}</span>
                <span className="launcher-status" data-tone={row.enabledTone}>
                  {row.enabledLabel}
                </span>
                <span className="launcher-status" data-tone={row.statusTone}>
                  {row.statusLabel}
                </span>
              </div>
              <p className="launcher-content-hint">
                顺序 {row.rank} · {row.packId} · 本包写入 {row.fileCount} 个文件
              </p>
              <div className="launcher-content-row-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() => setConfirm({ kind: row.enabled ? 'disable' : 'enable', packId: row.packId })}
                >
                  {row.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={!row.canMoveUp || busy !== null}
                  onClick={() => setConfirm({ kind: 'order', packId: row.packId, direction: 'up' })}
                >
                  上移
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={!row.canMoveDown || busy !== null}
                  onClick={() => setConfirm({ kind: 'order', packId: row.packId, direction: 'down' })}
                >
                  下移
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null}
                  onClick={() => setConfirm({ kind: 'uninstall', packId: row.packId })}
                >
                  卸载
                </button>
                {busy !== null && busy.packId === row.packId ? (
                  <span className="launcher-busy" role="status">
                    {busy.text}
                  </span>
                ) : null}
              </div>
              {confirm !== null && confirm.packId === row.packId ? (
                <div className="launcher-content-confirm" role="group" aria-label="确认操作">
                  <p className="launcher-content-confirm-text">
                    {rowConfirmText({
                      kind: confirm.kind,
                      name: row.name,
                      direction: confirm.direction,
                      fileCount: row.fileCount,
                    })}
                  </p>
                  <div className="launcher-content-row-actions">
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => {
                        const pack = packs.find((entry) => entry.manifest.id === row.packId);
                        if (pack === undefined) return;
                        if (confirm.kind === 'order') {
                          void runMove(pack, confirm.direction === 'up' ? -1 : 1);
                          return;
                        }
                        void runRowTask(confirm.kind, pack);
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

      {showFlow ? (
        <section className="launcher-content-flow" aria-label="安装内容包">
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
              正在预检：解到暂存、校验清单、算冲突（这一步不碰实例内容根）…
            </p>
          ) : null}

          {install.stage === 'planned' && planView !== null && install.plan !== null ? (
            <>
              <div className="launcher-content-plan-head">
                <strong>{planView.title}</strong>
                <span className="launcher-status" data-tone={planView.expired ? 'warn' : 'busy'}>
                  {planView.expired ? '计划已过期' : '计划有效'}
                </span>
              </div>
              <p className="launcher-content-hint">{planView.subtitle}</p>
              <dl className="launcher-facts launcher-content-facts" aria-label="安装计划读数">
                {planView.rows.map((row) => (
                  <div className="launcher-fact" key={row.label} data-tone={row.tone ?? 'idle'}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {install.plan.missingRequirements.length === 0 ? null : (
                <p className="launcher-warn-note">
                  依赖未满足：{install.plan.missingRequirements.join('、')}（应用会被拒绝）
                </p>
              )}
              {install.plan.warnings.length === 0 ? null : (
                <ul className="launcher-content-warnings">
                  {install.plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              <div className="launcher-content-conflicts-head">
                <strong>冲突（{conflictView.length} 条）</strong>
                <span className="launcher-content-hint">
                  {conflictView.length === 0
                    ? '没有文件冲突：本包只新增文件。'
                    : '每条都要决断：漏一条整包都不落盘。'}
                </span>
              </div>
              {conflictView.length === 0 ? null : (
                <ul className="launcher-content-conflicts">
                  {conflictView.map((row) => {
                    const chosen = install.choices[row.key];
                    const chosenOption = row.options.find((option) => option.action === chosen) ?? null;
                    return (
                      <li className="launcher-content-conflict" key={row.key} data-kind={row.kind}>
                        <span className="launcher-content-conflict-path">{row.path}</span>
                        <span className="launcher-content-hint">
                          {row.kindLabel} · {row.ownerLabel}
                        </span>
                        <div
                          className="launcher-content-row-actions"
                          role="group"
                          aria-label={`冲突决议：${row.path}`}
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
                          <button type="button" className="ghost small" onClick={cancelInstall}>
                            取消
                          </button>
                          <span className="launcher-content-hint">
                            {chosenOption === null ? '未决断' : chosenOption.hint}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="launcher-content-row-actions">
                <button
                  type="button"
                  className="primary small"
                  disabled={planView.expired || (built !== null && built.pending.length > 0)}
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
                {built !== null && built.pending.length > 0 ? (
                  <span className="launcher-content-hint">还有 {built.pending.length} 条冲突没决断</span>
                ) : null}
              </div>
            </>
          ) : null}

          {install.stage === 'applying' && taskView !== null ? (
            <div className="launcher-content-task" role="status" aria-label="安装进度">
              <div className="launcher-content-plan-head">
                <strong>{taskView.headline}</strong>
                <span className="launcher-status" data-tone={taskView.tone}>
                  {taskView.terminal ? '已结束' : '进行中'}
                </span>
              </div>
              <p className="launcher-content-hint">{taskView.detail}</p>
              <p className="launcher-content-hint">
                进度来源：{watchMode === 'subscribe' ? '任务中心订阅（tasks.subscribe）' : '轮询（每 0.8 秒读一次任务快照）'}
              </p>
              {taskView.percent === null ? null : (
                <progress className="launcher-progress" max={100} value={taskView.percent}>
                  {taskView.percent}%
                </progress>
              )}
              <div className="launcher-content-row-actions">
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
            <div className="launcher-content-task" aria-label="安装结果">
              <div className="launcher-content-plan-head">
                <strong>{taskView.headline}</strong>
                <span className="launcher-status" data-tone={taskView.tone}>
                  {taskView.state === 'succeeded'
                    ? '成功'
                    : taskView.state === 'failed'
                      ? '失败'
                      : '已取消'}
                </span>
              </div>
              <p className="launcher-content-hint">{taskView.detail}</p>
              <p className="launcher-content-hint">{taskView.note}</p>
              {taskView.errorText === null ? null : (
                <p className="launcher-warn-note">任务失败：{taskView.errorText}</p>
              )}
              <div className="launcher-content-row-actions">
                <button type="button" className="ghost small" onClick={cancelInstall}>
                  收起
                </button>
              </div>
            </div>
          ) : null}

          {install.stage === 'idle' ? (
            <div className="launcher-content-row-actions">
              <button type="button" className="ghost small" onClick={cancelInstall}>
                收起
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {rowTaskView === null ? null : (
        <section className="launcher-content-task" aria-label="内容包任务进度">
          <div className="launcher-content-plan-head">
            <strong>{rowTaskView.headline}</strong>
            <span className="launcher-status" data-tone={rowTaskView.tone}>
              {rowTaskView.terminal ? '已结束' : '进行中'}
            </span>
            <button type="button" className="ghost small" onClick={() => setRowTask(null)}>
              收起
            </button>
          </div>
          <p className="launcher-content-hint">{rowTaskView.detail}</p>
          <p className="launcher-content-hint">{rowTaskView.note}</p>
          {rowTaskView.errorText === null ? null : (
            <p className="launcher-warn-note">任务失败：{rowTaskView.errorText}</p>
          )}
        </section>
      )}
      {rowFailure === null ? null : <FailureBlock failure={rowFailure} />}

      {diagFailure === null ? null : <FailureBlock failure={diagFailure} />}
      {diagView === null ? null : (
        <section className="launcher-content-diagnosis" aria-label="内容诊断">
          <div className="launcher-content-plan-head">
            <strong>{diagView.headline}</strong>
            <button type="button" className="ghost small" onClick={() => setDiagnosis(null)}>
              收起
            </button>
          </div>
          {diagView.ok ? (
            <p className="launcher-content-hint">
              归属文件、哈希与加载顺序都与安装记录一致（只读检查，没有改动任何文件）。
            </p>
          ) : (
            <ul className="launcher-content-groups">
              {diagView.groups.map((group) => (
                <li className="launcher-content-group" key={group.key} data-group={group.key}>
                  <div className="launcher-content-group-head">
                    <span className="launcher-content-group-label">{group.label}</span>
                    <span className="launcher-badge">{group.items.length} 项</span>
                  </div>
                  <p className="launcher-content-hint">{group.explanation}</p>
                  {group.items.length === 0 ? null : (
                    <ul className="launcher-content-group-items">
                      {group.items.map((item) => (
                        <li key={item.key}>
                          <code className="launcher-content-group-pack">{item.packId}</code>
                          {item.path === null ? '' : ` ${item.path} · `}
                          {item.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {group.items.length === 0 ? null : (
                    <p className="launcher-content-hint">下一步：{group.nextStep}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
