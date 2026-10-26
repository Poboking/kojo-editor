/**
 * 启动器 · 实例详情「存档」面板（车道 UI-SAVES）。
 *
 * 一块面板承担六件事，全部只经契约面 `LauncherService.saves`：
 *
 * 1. **存档列表**：按 `rootId` 分组（根标签 + 相对路径），条目给大小与修改时间
 *    （缺失就说「未记录」）；分组与排序是纯函数（`saves-panel-model.groupSaves`）。
 * 2. **备份**：可选理由标签 → `saves.backup` → 任务横幅（进度经 `tasks.subscribe`）；
 *    备份列表给时间 / 理由 / 大小 / 来源（自动 or 手动，来源四档见 `backupOrigin`）。
 * 3. **恢复**：先出二次确认面板，第一句写清「先自动备份当前存档，再覆盖」；
 *    `backupCurrent = false` **只在**用户额外勾选「不保留当前存档」时才下发（默认不勾）。
 *    shared 实例有未授权根 ⇒ 只说原因、**不给**确认按钮（没有「强行恢复」这条路）。
 * 4. **导入**：`onPickArchive` 选包 → `saves.planImport` 只读预检（不写盘的事实写在面板上）
 *    → 用户确认 → `applyImport` → 任务三态。
 * 5. **导出**：走父层给的 `onExport`（原生保存对话框即授权）；返回 `null` = 用户取消，
 *    只留一行说明，不弹错误条。
 * 6. **错误**：码与原文原样显示，另给「为什么 + 下一步」（四类见 `savesErrorAdvice`）。
 *
 * 接线面（组长挂 tab 时按这个形状传）：
 * ```tsx
 * <SavesPanel
 *   service={service} instanceId={selected.id} isolation={selected.isolation === 'copy' ? 'copy' : 'shared'}
 *   onPickArchive={host.pickArchive === undefined ? undefined : () => host.pickArchive!()}
 *   onExport={(req) => service.saves.exportArchive(selected.id, req)}
 * />
 * ```
 * `onPickArchive` / `onExport` 缺席 ⇒ 导入 / 导出按钮禁用并写明原因（不假装可点）。
 *
 * 纪律：本组件只吃 `@kojo/plugin-api` 的**类型**，不 import 插件实现；样式全在
 * `launcher.css` 的 `launcher-saves-*` 段（token 消费，零颜色字面量，状态颜色 + 文字双编码）。
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
  LauncherInstance,
  LauncherService,
  LauncherTask,
  SaveBackup,
  SaveEntry,
  SaveExportRequest,
  SaveImportPlan,
  SaveRootSpec,
} from '@kojo/plugin-api';
import {
  backupBlockedReason,
  backupView,
  describeSavesFailure,
  exportNote,
  groupSaves,
  importPlanView,
  restoreConfirm,
  restoreOptions,
  saveSizeText,
  savesEmptyText,
  savesTaskBanner,
  savesWarnings,
  sortBackups,
  unapprovedRootText,
  type SavesFailure,
} from './saves-panel-model';
import './launcher.css';

export interface SavesPanelProps {
  readonly service: LauncherService;
  readonly instanceId: string;
  /** 是否为 shared 实例（决定"需要逐根授权"的提示口径） */
  readonly isolation: 'shared' | 'copy';
  /** 父层给的原生对话框入口；缺席 = 禁用导入并写明原因 */
  readonly onPickArchive?: () => Promise<string | null>;
  readonly onExport?: (req: SaveExportRequest) => Promise<string | null>;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 取数形状
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SavesData {
  /** 实例快照（只为根标签与 `saveRoots`）；读不到就是 null，列表退化为「根 id 当标签」 */
  readonly instance: LauncherInstance | null;
  readonly roots: readonly SaveRootSpec[];
  readonly entries: readonly SaveEntry[];
  readonly backups: readonly SaveBackup[];
  /** 实现侧外挂的警告（`list()` 装不下它们）；只作补充说明，原样显示 */
  readonly warnings: readonly string[];
}

type SavesBusy = 'pick' | 'plan' | 'apply' | 'backup' | 'restore' | 'export' | null;

const BUSY_TEXT: Readonly<Record<Exclude<SavesBusy, null>, string>> = {
  pick: '正在等待系统文件对话框…',
  plan: '正在预检导入包（只读）…',
  apply: '正在应用导入…',
  backup: '正在请求备份…',
  restore: '正在请求恢复…',
  export: '正在等待系统保存对话框…',
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 失败条（复用 `launcher-failure*` 的既有样式：同一族的错误块，不另造一套）
 * ══════════════════════════════════════════════════════════════════════════════ */

function FailureNotice({
  failure,
  onDismiss,
}: {
  readonly failure: SavesFailure;
  readonly onDismiss: () => void;
}): ReactElement {
  return (
    <div className="launcher-failure launcher-saves-failure" role="alert">
      <div className="launcher-failure-head">
        <strong>{failure.title}</strong>
        <code className="launcher-failure-code">{failure.code ?? '无错误码'}</code>
        <button
          type="button"
          className="ghost small launcher-failure-dismiss"
          onClick={onDismiss}
          aria-label="收起这条错误"
        >
          收起
        </button>
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

export function SavesPanel(props: SavesPanelProps): ReactElement {
  const { service, instanceId, isolation, onPickArchive, onExport } = props;

  const [data, setData] = useState<SavesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<SavesFailure | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busy, setBusy] = useState<SavesBusy>(null);
  /** 进行中 / 刚结束的那一个任务（备份 / 恢复 / 导入各一条，同一时刻至多一条） */
  const [task, setTask] = useState<LauncherTask | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  /** 恢复二次确认的目标备份；非空 = 面板开着 */
  const [restoreTarget, setRestoreTarget] = useState<SaveBackup | null>(null);
  /** 「不保留当前存档」：**默认不勾**（勾了才传 `backupCurrent: false`） */
  const [skipCurrentBackup, setSkipCurrentBackup] = useState(false);
  /** 预检结果（只读产物）；非空 = 等用户确认 */
  const [plan, setPlan] = useState<SaveImportPlan | null>(null);

  const reload = useCallback((): void => setReloadNonce((nonce) => nonce + 1), []);

  /* 换实例：清掉上一份面板状态（别让 A 的备份出现在 B 的恢复面板里） */
  useEffect(() => {
    setTask(null);
    setPlan(null);
    setRestoreTarget(null);
    setSkipCurrentBackup(false);
    setLabel('');
    setNotice(null);
    setFailure(null);
  }, [instanceId]);

  /* 1. 取数：实例快照（只为根标签）+ 存档列表 + 备份列表 */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      let instance: LauncherInstance | null = null;
      try {
        instance = await service.instances.get(instanceId);
      } catch {
        // 实例快照读不到不影响列表本身：根标签退化为根 id，界面上会说这一句
        instance = null;
      }
      const [entries, backups] = await Promise.all([
        service.saves.list(instanceId),
        service.saves.backups(instanceId),
      ]);
      if (cancelled) return;
      setData({
        instance,
        roots: instance?.saveRoots ?? [],
        entries,
        backups,
        warnings: savesWarnings(service.saves, instanceId),
      });
      setFailure(null);
    };
    void load()
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure(describeSavesFailure(error, 'list'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, instanceId, reloadNonce]);

  /* 2. 任务进度：订阅任务中心，任务做完刷一次列表（备份 / 恢复 / 导入都会改列表） */
  const taskId = task?.id ?? null;
  const reloadedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (taskId === null) return;
    const center = service.tasks;
    if (center === undefined || typeof center.subscribe !== 'function') return;
    const apply = (next: LauncherTask): void => {
      if (next.id !== taskId) return;
      setTask((prev) => (prev === null || prev.id !== taskId ? prev : next));
      if (next.state === 'succeeded' && reloadedTaskRef.current !== next.id) {
        reloadedTaskRef.current = next.id;
        reload();
      }
    };
    const off = center.subscribe(apply);
    const snapshot = center.get(taskId);
    if (snapshot !== null) apply(snapshot);
    return off;
  }, [service, taskId, reload]);

  const groups = useMemo(
    () => (data === null ? [] : groupSaves(data.roots, data.entries, isolation)),
    [data, isolation],
  );
  const backupViews = useMemo(
    () => (data === null ? [] : sortBackups(data.backups).map((backup) => backupView(backup))),
    [data],
  );
  const emptyText = data === null ? null : savesEmptyText(data.roots, groups);
  const backupBlocked =
    data === null
      ? loading
        ? '正在读取存档…'
        : '存档列表还没读到：先处理上面的错误，再新建备份。'
      : backupBlockedReason(data.roots);
  const confirmView = restoreTarget === null ? null : restoreConfirm(restoreTarget, groups);
  const planView = plan === null ? null : importPlanView(plan, groups);

  /* ------------------------------ 动作 ------------------------------ */

  const createBackup = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    setBusy('backup');
    setFailure(null);
    setNotice(null);
    try {
      const trimmed = label.trim();
      // 空标签不传（备注是可选信息，不塞一个空串冒充「用户写了理由」）
      const next = await service.saves.backup(
        instanceId,
        trimmed === '' ? { reason: 'manual' } : { reason: 'manual', label: trimmed },
      );
      setTask(next);
      setLabel('');
      reload();
    } catch (error) {
      setFailure(describeSavesFailure(error, 'backup'));
    } finally {
      setBusy(null);
    }
  }, [busy, instanceId, label, reload, service]);

  const runRestore = useCallback(async (): Promise<void> => {
    if (busy !== null || restoreTarget === null || confirmView === null) return;
    if (confirmView.blockedReason !== null) return;
    setBusy('restore');
    setFailure(null);
    setNotice(null);
    try {
      const options = restoreOptions(skipCurrentBackup);
      const next =
        options === undefined
          ? await service.saves.restore(instanceId, restoreTarget.id)
          : await service.saves.restore(instanceId, restoreTarget.id, options);
      setTask(next);
      setRestoreTarget(null);
      setSkipCurrentBackup(false);
      reload();
    } catch (error) {
      setFailure(describeSavesFailure(error, 'restore'));
    } finally {
      setBusy(null);
    }
  }, [busy, confirmView, instanceId, reload, restoreTarget, service, skipCurrentBackup]);

  const startImport = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    if (onPickArchive === undefined) {
      setNotice('这一层没有给导入入口（原生文件对话框不在位）：导入不可用。');
      return;
    }
    setFailure(null);
    setNotice(null);
    setPlan(null);
    setBusy('pick');
    let picked: string | null;
    try {
      picked = await onPickArchive();
    } catch (error) {
      setBusy(null);
      setFailure(describeSavesFailure(error, 'pick-archive'));
      return;
    }
    if (picked === null) {
      // 取消不是错误：停在原处，只说一句「什么都没做」
      setBusy(null);
      setNotice('已取消选择导入包：没有做预检，也没有写任何文件。');
      return;
    }
    setBusy('plan');
    try {
      const next = await service.saves.planImport(instanceId, picked);
      setPlan(next);
      setNotice('预检完成：还没有写盘，确认下面的覆盖清单后再点「确认导入」。');
    } catch (error) {
      setFailure(describeSavesFailure(error, 'plan-import'));
    } finally {
      setBusy(null);
    }
  }, [busy, instanceId, onPickArchive, service]);

  const confirmImport = useCallback(async (): Promise<void> => {
    if (busy !== null || plan === null) return;
    setBusy('apply');
    setFailure(null);
    setNotice(null);
    try {
      const next = await service.saves.applyImport(plan.planId);
      setTask(next);
      setPlan(null);
      reload();
    } catch (error) {
      // 计划作废 / 过期也走这里：码与原文照旧原样显示（不翻译成「失败了」）
      setFailure(describeSavesFailure(error, 'apply-import'));
    } finally {
      setBusy(null);
    }
  }, [busy, plan, reload, service]);

  const startExport = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    if (onExport === undefined) {
      setNotice('这一层没有给导出入口（原生保存对话框不在位）：导出不可用。');
      return;
    }
    setBusy('export');
    setFailure(null);
    setNotice(null);
    try {
      // 空请求 = 导出全部存档根；落点由原生保存对话框决定（对话框即授权）
      const target = await onExport({});
      setNotice(
        target === null
          ? '已取消导出：系统对话框没有选落点，没有写任何文件。'
          : `已导出到：${target}`,
      );
    } catch (error) {
      setFailure(describeSavesFailure(error, 'export'));
    } finally {
      setBusy(null);
    }
  }, [busy, onExport]);

  /* ------------------------------ 渲染 ------------------------------ */

  const banner = task === null ? null : savesTaskBanner(task);

  return (
    <section className="launcher-saves" aria-label="存档">
      <header className="launcher-saves-head">
        <h4 className="launcher-saves-title">存档</h4>
        <span className="launcher-saves-hint">
          列表按存档根分组；备份落在实例备份目录，写回游戏目录要逐根授权。
        </span>
        <button
          type="button"
          className="ghost small launcher-saves-refresh"
          onClick={reload}
          disabled={loading}
        >
          刷新
        </button>
      </header>

      {banner === null ? null : (
        <div className="launcher-saves-task" role="status" aria-label="存档任务进度">
          <div className="launcher-saves-task-head">
            <strong>{banner.title}</strong>
            <span className="launcher-saves-status" data-tone={banner.tone}>
              {banner.phaseLabel}
            </span>
            {banner.terminal ? (
              <button type="button" className="ghost small" onClick={() => setTask(null)}>
                收起
              </button>
            ) : null}
          </div>
          <p className="launcher-saves-note">{banner.detail}</p>
          {banner.percent === null ? null : (
            <progress className="launcher-progress" max={100} value={banner.percent}>
              {banner.percent}%
            </progress>
          )}
          {banner.errorText === null ? null : (
            <p className="launcher-saves-warn">任务失败：{banner.errorText}</p>
          )}
          {banner.terminal ? null : (
            <p className="launcher-saves-note">关掉这个面板不会取消任务；进度由任务中心推送。</p>
          )}
        </div>
      )}

      {failure === null ? null : (
        <FailureNotice failure={failure} onDismiss={() => setFailure(null)} />
      )}
      {busy === null ? null : (
        <p className="launcher-saves-busy" role="status">
          {BUSY_TEXT[busy]}
        </p>
      )}
      {notice === null ? null : (
        <p className="launcher-saves-notice" role="status">
          {notice}
        </p>
      )}

      {/* ------------------------------ 存档列表 ------------------------------ */}
      <div className="launcher-saves-section" aria-label="存档列表">
        {loading && data === null ? (
          <p className="launcher-saves-note" role="status">
            正在读取存档…
          </p>
        ) : null}
        {data !== null && data.instance === null ? (
          <p className="launcher-saves-warn">
            读不到实例快照：根标签退化为根 id，列表照常显示；写回前请先确认实例仍然存在。
          </p>
        ) : null}
        {emptyText === null ? null : <p className="launcher-saves-note">{emptyText}</p>}
        {groups.length === 0 ? null : (
          <div className="launcher-saves-groups">
            {groups.map((group) => (
              <section
                key={group.rootId}
                className="launcher-saves-group"
                data-access={group.access}
                aria-label={`存档根 ${group.label}`}
              >
                <div className="launcher-saves-group-head">
                  <span className="launcher-saves-group-label">{group.label}</span>
                  <span className="launcher-saves-group-path">
                    {group.relativePath ?? `根 id：${group.rootId}（实例里没有声明这个根）`}
                  </span>
                  <span className="launcher-saves-group-count">
                    {group.entries.length} 个 · {saveSizeText(group.totalBytes)}
                  </span>
                </div>
                {group.access === 'needs-approval' ? (
                  <p className="launcher-saves-warn">{unapprovedRootText(group.label)}</p>
                ) : null}
                {group.entries.length === 0 ? (
                  group.access === 'needs-approval' ? null : (
                    <p className="launcher-saves-note">这个根里没有条目。</p>
                  )
                ) : (
                  <ul className="launcher-saves-list">
                    {group.entries.map((entry) => (
                      <li className="launcher-saves-entry" key={entry.key}>
                        <span className="launcher-saves-entry-name">{entry.name}</span>
                        <span className="launcher-saves-entry-path">{entry.path}</span>
                        <span className="launcher-saves-entry-meta">
                          {entry.size} · {entry.time}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
        {data === null || data.warnings.length === 0 ? null : (
          <ul className="launcher-saves-warnings" aria-label="读取时的警告">
            {data.warnings.map((line) => (
              <li className="launcher-saves-note" key={line}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ------------------------------ 备份 ------------------------------ */}
      <section className="launcher-saves-block" aria-label="备份">
        <h5 className="launcher-saves-block-title">备份</h5>
        <div className="launcher-saves-row">
          <input
            className="launcher-saves-input"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="理由标签（可选，例如「打完第三章」）"
            aria-label="备份理由（可选）"
            disabled={busy !== null || backupBlocked !== null}
          />
          <button
            type="button"
            className="primary small"
            onClick={() => void createBackup()}
            disabled={busy !== null || backupBlocked !== null}
          >
            新建备份
          </button>
        </div>
        <p className="launcher-saves-note">
          备份只写实例备份目录，不碰游戏目录 ⇒ 不需要写授权；它是恢复与导入失败时的回退点。
        </p>
        {backupBlocked === null ? null : <p className="launcher-saves-warn">{backupBlocked}</p>}

        {backupViews.length === 0 ? (
          <p className="launcher-saves-note">
            还没有备份：点「新建备份」把当前存档打包一份（写理由能让你以后认得出是哪一次）。
          </p>
        ) : (
          <ul className="launcher-saves-backups">
            {backupViews.map((view) => (
              <li className="launcher-saves-backup" key={view.id} data-origin={view.origin.kind}>
                <div className="launcher-saves-backup-head">
                  <span className="launcher-saves-backup-label">{view.label}</span>
                  <span className="launcher-saves-badge" data-origin={view.origin.kind}>
                    {view.origin.label}
                  </span>
                  <span className="launcher-saves-backup-time">{view.time}</span>
                </div>
                <p className="launcher-saves-backup-meta">
                  {view.size} · {view.entryCount} · {view.origin.detail}
                </p>
                <div className="launcher-saves-row">
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => {
                      setRestoreTarget(
                        data?.backups.find((candidate) => candidate.id === view.id) ?? null,
                      );
                      setSkipCurrentBackup(false);
                    }}
                    disabled={busy !== null}
                  >
                    恢复…
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {confirmView === null ? null : (
          <section className="launcher-saves-confirm" aria-label="恢复确认">
            <h6 className="launcher-saves-confirm-title">{confirmView.title}</h6>
            <ol className="launcher-saves-steps">
              {confirmView.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <label className="launcher-saves-check">
              <input
                type="checkbox"
                checked={skipCurrentBackup}
                onChange={(event) => setSkipCurrentBackup(event.target.checked)}
                disabled={busy !== null || confirmView.blockedReason !== null}
                aria-label="不保留当前存档（跳过自动备份）"
              />
              <span>不保留当前存档（跳过自动备份）</span>
            </label>
            <p className="launcher-saves-note">{confirmView.skipLine}</p>
            {confirmView.blockedReason === null ? null : (
              <p className="launcher-saves-warn">{confirmView.blockedReason}</p>
            )}
            <p className="launcher-saves-note">{confirmView.note}</p>
            <div className="launcher-saves-row">
              {/* 被授权门挡住时**不渲染**确认按钮：没有「强行恢复」这条路 */}
              {confirmView.blockedReason === null ? (
                <button
                  type="button"
                  className="primary small"
                  onClick={() => void runRestore()}
                  disabled={busy !== null}
                >
                  确认恢复
                </button>
              ) : null}
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setRestoreTarget(null);
                  setSkipCurrentBackup(false);
                }}
                disabled={busy === 'restore'}
              >
                取消
              </button>
            </div>
          </section>
        )}
      </section>

      {/* ------------------------------ 导入 / 导出 ------------------------------ */}
      <section className="launcher-saves-block" aria-label="导入与导出">
        <h5 className="launcher-saves-block-title">导入与导出</h5>
        <div className="launcher-saves-row">
          <button
            type="button"
            className="primary small"
            onClick={() => void startImport()}
            disabled={busy !== null || onPickArchive === undefined}
          >
            选择导入包…
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => void startExport()}
            disabled={busy !== null || onExport === undefined}
          >
            导出全部存档…
          </button>
        </div>
        {onPickArchive === undefined ? (
          <p className="launcher-saves-note">
            这一层没有给导入入口（原生文件对话框不在位）：导入按钮不可用，先由外壳接上
            `onPickArchive`。
          </p>
        ) : null}
        {onExport === undefined ? (
          <p className="launcher-saves-note">
            这一层没有给导出入口（原生保存对话框不在位）：导出按钮不可用，先由外壳接上
            `onExport`。
          </p>
        ) : null}
        <p className="launcher-saves-note">{exportNote(groups)}</p>
        <p className="launcher-saves-note">
          落点由系统对话框决定：对话框里确认的路径就是授权，启动器不接受手填的目标路径。
        </p>

        {planView === null ? null : (
          <section className="launcher-saves-import" aria-label="导入预检结果">
            <h6 className="launcher-saves-confirm-title">{planView.title}</h6>
            <p className="launcher-saves-note">{planView.preview}</p>
            <dl className="launcher-facts">
              {planView.rows.map((row) => (
                <div className="launcher-fact" key={row.label} data-tone={row.tone ?? 'idle'}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {planView.warnings.length === 0 ? null : (
              <ul className="launcher-saves-warnings" aria-label="预检警告">
                {planView.warnings.map((line) => (
                  <li className="launcher-saves-note" key={line}>
                    {line}
                  </li>
                ))}
              </ul>
            )}
            {planView.blockedReason === null ? null : (
              <p className="launcher-saves-warn">{planView.blockedReason}</p>
            )}
            <div className="launcher-saves-row">
              {planView.blockedReason === null ? (
                <button
                  type="button"
                  className="primary small"
                  onClick={() => void confirmImport()}
                  disabled={busy !== null}
                >
                  确认导入
                </button>
              ) : null}
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setPlan(null);
                  setNotice('已取消这次导入：预检计划作废，没有写任何文件。');
                }}
                disabled={busy === 'apply'}
              >
                取消
              </button>
            </div>
          </section>
        )}
      </section>
    </section>
  );
}
