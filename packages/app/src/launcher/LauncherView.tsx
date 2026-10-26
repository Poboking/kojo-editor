/**
 * 启动器视图 · 实例库 + 详情骨架（L5）。
 *
 * 这一批交付的是**能开、能看、能点**的骨架，不是完整启动器：
 * - 实例库：名称 / 隔离模式 / 状态（颜色 + 文字双编码）/ 上次启动 + 搜索过滤；
 * - 空状态：说明下一步（从目录创建），按钮**禁用并写明「宿主未就绪」**——
 *   宿主命令（§7.2 的 `launcher_create_instance` 一族）还没接入，假装能点才是撒谎；
 * - 详情：路径 / 运行时 / 信任三块**只读事实** + 启动 / 停止（调 `processes.start/stop`）；
 * - 失败：错误码**原样**显示、原文不翻译成「出错了」，另给下一步建议；
 * - 拿不到 `launcher.service`：说清缺哪一块（插件没进表 / 激活报错 / 缺宿主桥），
 *   异常原样带出，不吞。
 *
 * 装载纪律（PS-10）：本组件只经 `App.tsx` 的 `lazy(() => import('./launcher/LauncherView'))`
 * 进入，插件本体由 `bootstrap.ts::ensureLauncherPlugin` 的字面量动态 import 装载
 * ⇒ 开机图**零新增文件**。样式全部走 `launcher.css`（token 消费，零颜色字面量）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type {
  InstanceInspection,
  LauncherInstance,
  LauncherService,
  ProcessStatus,
} from '@kojo/plugin-api';
import { Icon } from '../ui/icons';
import {
  detailFacts,
  detailHeadline,
  describeFailure,
  filterInstances,
  instanceRowView,
  instanceStatusLine,
  isolationLabel,
  sortInstances,
  startStopControls,
  type FactRow,
  type FailureView,
} from './model';
import { resolveLauncherService } from './launcher-service';
import './launcher.css';

export interface LauncherViewProps {
  /** 组合根内核；`null` = 还在启动（视图照常打开，给一句人话而不是空白） */
  readonly kernel: Kernel | null;
  readonly onClose: () => void;
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly gap: string; readonly failure: FailureView | null }
  | { readonly kind: 'ready'; readonly service: LauncherService };

/** 失败读数（标题 / 码 / 原文 / 建议）——码与原文都不改写，只补人话建议 */
function FailureNotice({
  failure,
  onDismiss,
}: {
  readonly failure: FailureView;
  readonly onDismiss?: () => void;
}): ReactElement {
  return (
    <div className="launcher-failure" role="alert">
      <div className="launcher-failure-head">
        <strong>{failure.title}</strong>
        <code className="launcher-failure-code">{failure.code ?? '无错误码'}</code>
        {onDismiss === undefined ? null : (
          <button
            type="button"
            className="ghost small launcher-failure-dismiss"
            onClick={onDismiss}
            aria-label="收起这条错误"
          >
            <Icon name="close" size="xs" />
          </button>
        )}
      </div>
      <p className="launcher-failure-message">{failure.message}</p>
      {failure.detail === null ? null : <p className="launcher-failure-detail">{failure.detail}</p>}
      <p className="launcher-failure-hint">{failure.hint}</p>
      <p className="launcher-failure-hint">
        {failure.retryable ? '按上面的建议处理后可以重试。' : '这个错误重试通常无效。'}
      </p>
    </div>
  );
}

/** 详情里的一块只读事实（路径 / 运行时 / 信任） */
function FactBlock({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly FactRow[];
}): ReactElement {
  return (
    <section className="launcher-block" aria-label={title}>
      <h4 className="launcher-block-title">
        {title}
        <span className="launcher-block-note">只读</span>
      </h4>
      <dl className="launcher-facts">
        {rows.map((row) => (
          <div className="launcher-fact" key={row.label} data-tone={row.tone ?? 'idle'}>
            <dt>{row.label}</dt>
            <dd>
              {row.value}
              {row.hint === undefined ? null : <span className="launcher-fact-hint">{row.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 空状态：解释下一步做什么，并如实说明创建入口为什么还不能用 */
function EmptyLibrary({ onRefresh }: { readonly onRefresh: () => void }): ReactElement {
  return (
    <div className="empty-state">
      <p>还没有实例</p>
      <p className="dim">
        实例 = 一个游戏目录 + 一份隔离配置。从目录创建需要宿主确认路径并落盘，这一版还没接入。
      </p>
      <div className="empty-actions">
        <button
          type="button"
          className="primary"
          disabled
          title="宿主未就绪：实例创建命令还没接入这一版"
        >
          从目录创建
        </button>
        <button type="button" className="ghost" onClick={onRefresh}>
          刷新列表
        </button>
      </div>
      <p className="dim">宿主未就绪：等进程与实例命令接上后，这里就能直接选目录。</p>
    </div>
  );
}

export function LauncherView({ kernel, onClose }: LauncherViewProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  /** 手动刷新：递增即重新解析服务并重读实例库（错误态也走这条路出来） */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [instances, setInstances] = useState<readonly LauncherInstance[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProcessStatus>>(new Map());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InstanceInspection | null>(null);
  const [listFailure, setListFailure] = useState<FailureView | null>(null);
  const [inspectFailure, setInspectFailure] = useState<FailureView | null>(null);
  const [actionFailure, setActionFailure] = useState<FailureView | null>(null);
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  /* 1. 解析服务（缺席时由 model 说清缺哪一块；异常原样进 failure） */
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    void resolveLauncherService(kernel)
      .then((resolution) => {
        if (cancelled) return;
        setPhase(
          resolution.kind === 'ready'
            ? { kind: 'ready', service: resolution.service }
            : resolution,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'unavailable',
          gap: '取启动器服务时抛出了未预期的异常，实例库暂时打不开。',
          failure: describeFailure(error, 'service'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [kernel, reloadNonce]);

  /* 2. 读实例库 + 进程读数，并订两路变更（宿主推来的状态才是真相） */
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    const service = phase.service;
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const [list, processes] = await Promise.all([
          service.instances.list(),
          Promise.resolve(service.processes.list()),
        ]);
        if (cancelled) return;
        setInstances(list);
        setStatuses(new Map(processes.map((status) => [status.instanceId, status])));
        setListFailure(null);
        // 选中项保持（还在就继续选），否则落到排序后的第一条——首帧就有详情可看
        setSelectedId((prev) =>
          prev !== null && list.some((instance) => instance.id === prev)
            ? prev
            : (sortInstances(list)[0]?.id ?? null),
        );
      } catch (error) {
        if (cancelled) return;
        setListFailure(describeFailure(error, 'list'));
      }
    };

    void load();
    const offInstances = service.instances.subscribe(() => {
      void load();
    });
    const offProcesses = service.processes.subscribe((status) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.instanceId, status);
        return next;
      });
    });
    return () => {
      cancelled = true;
      offInstances();
      offProcesses();
    };
  }, [phase]);

  /* 3. 选中项的详情读数（失败不静默：详情里挂一条错误，仍显示实例快照） */
  useEffect(() => {
    if (phase.kind !== 'ready' || selectedId === null) {
      setInspection(null);
      return;
    }
    let cancelled = false;
    setInspectFailure(null);
    void phase.service.instances
      .inspect(selectedId)
      .then((value) => {
        if (!cancelled) setInspection(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInspection(null);
        setInspectFailure(describeFailure(error, 'inspect'));
      });
    return () => {
      cancelled = true;
    };
  }, [phase, selectedId]);

  const rows = useMemo(
    () =>
      sortInstances(filterInstances(instances, query)).map((instance) =>
        instanceRowView(instance, statuses.get(instance.id)),
      ),
    [instances, query, statuses],
  );

  const selected = useMemo(
    () => instances.find((instance) => instance.id === selectedId) ?? null,
    [instances, selectedId],
  );
  const selectedStatus = selected === null ? undefined : statuses.get(selected.id);
  const statusLine = instanceStatusLine(selected?.state ?? 'ready', selectedStatus?.state ?? 'idle');
  const controls = startStopControls(selectedStatus?.state ?? 'idle', pending);
  const facts = useMemo(
    () => (selected === null ? null : detailFacts(selected, inspection)),
    [selected, inspection],
  );

  const runProcessAction = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      if (phase.kind !== 'ready' || selectedId === null) return;
      setPending(action);
      setActionFailure(null);
      try {
        const status =
          action === 'start'
            ? await phase.service.processes.start(selectedId)
            : await phase.service.processes.stop(selectedId);
        setStatuses((prev) => {
          const next = new Map(prev);
          next.set(status.instanceId, status);
          return next;
        });
      } catch (error) {
        setActionFailure(describeFailure(error, action));
      } finally {
        setPending(null);
      }
    },
    [phase, selectedId],
  );

  const onMaskDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="launcher-mask" onMouseDown={onMaskDown}>
      <div className="launcher-panel glass" role="dialog" aria-modal="true" aria-label="启动器 · 实例库">
        <header className="launcher-head">
          <div className="launcher-head-titles">
            <h2 className="launcher-title">启动器 · 实例库</h2>
            <p className="launcher-subtitle">启动 / 停止游戏实例，并查看路径与信任读数。</p>
          </div>
          <div className="launcher-head-actions">
            <button
              type="button"
              className="ghost small"
              onClick={reload}
              disabled={phase.kind === 'loading'}
            >
              <Icon name="refresh" size="sm" />
              刷新
            </button>
            <button type="button" className="ghost small" onClick={onClose} aria-label="关闭启动器">
              <Icon name="close" size="sm" />
            </button>
          </div>
        </header>

        {phase.kind === 'loading' ? (
          <p className="launcher-note" role="status">
            正在装载启动器…
          </p>
        ) : null}

        {phase.kind === 'unavailable' ? (
          <div className="launcher-unavailable">
            <p className="launcher-unavailable-title">启动器服务不可用</p>
            <p className="launcher-note">{phase.gap}</p>
            {phase.failure === null ? null : <FailureNotice failure={phase.failure} />}
          </div>
        ) : null}

        {phase.kind === 'ready' ? (
          <div className="launcher-body">
            <aside className="launcher-side">
              <label className="launcher-search">
                <Icon name="search" size="sm" />
                <input
                  className="launcher-search-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索实例名 / 游戏 / 隔离模式"
                  aria-label="搜索实例"
                />
              </label>
              {listFailure === null ? null : <FailureNotice failure={listFailure} />}
              {rows.length === 0 ? (
                <p className="launcher-note">
                  {instances.length === 0 ? '还没有实例。' : '没有匹配的实例。'}
                </p>
              ) : (
                <ul className="launcher-list">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className={`launcher-row${row.id === selectedId ? ' on' : ''}`}
                        aria-pressed={row.id === selectedId}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <span className="launcher-row-name">{row.name}</span>
                        <span className="launcher-row-meta">
                          <span className="launcher-badge">{row.isolation}</span>
                          <span className="launcher-status" data-tone={row.status.tone}>
                            {row.status.label}
                          </span>
                        </span>
                        <span className="launcher-row-time">上次启动：{row.lastLaunched}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>

            <section className="launcher-main">
              {instances.length === 0 ? (
                <EmptyLibrary onRefresh={reload} />
              ) : selected === null ? (
                <p className="launcher-note">从左侧选一个实例查看详情。</p>
              ) : (
                <div className="launcher-detail">
                  <div className="launcher-detail-head">
                    <div className="launcher-detail-titles">
                      <h3 className="launcher-detail-name">{selected.name}</h3>
                      <p className="launcher-detail-meta">
                        {selected.gameId} · {isolationLabel(selected.isolation)} · {selected.id}
                      </p>
                    </div>
                    <span className="launcher-status" data-tone={statusLine.tone}>
                      {statusLine.label}
                    </span>
                  </div>
                  <p className="launcher-headline">{detailHeadline(selected, selectedStatus)}</p>
                  <div className="launcher-actions">
                    <button
                      type="button"
                      className="primary small"
                      disabled={!controls.canStart}
                      onClick={() => void runProcessAction('start')}
                    >
                      启动
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={!controls.canStop}
                      onClick={() => void runProcessAction('stop')}
                    >
                      停止
                    </button>
                    {controls.busyText === null ? null : (
                      <span className="launcher-busy" role="status">
                        {controls.busyText}
                      </span>
                    )}
                  </div>
                  {actionFailure === null ? null : (
                    <FailureNotice failure={actionFailure} onDismiss={() => setActionFailure(null)} />
                  )}
                  {inspectFailure === null ? null : <FailureNotice failure={inspectFailure} />}
                  {facts === null ? null : (
                    <div className="launcher-fact-grid">
                      <FactBlock title="路径" rows={facts.paths} />
                      <FactBlock title="运行时" rows={facts.runtime} />
                      <FactBlock title="信任" rows={facts.trust} />
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
