/**
 * 启动器视图 · 实例库 + 详情 + **新建实例向导**（L5 骨架 + L10 创建/信任/启动流）。
 *
 * 这一批把 L5 里禁用的按钮接活，三件事：
 * 1. **新建实例向导**（同一浮层内三步、可后退）：选来源目录（`host.pickSourceRoot`，
 *    原生对话框即授权）→ 选候选（adapter 的 `probe`，经 `launcher-service` 取启动面）
 *    → 起名 + 隔离模式 + 可选包含存档 → `instances.create`。
 *    `InstanceCreation.task` 非空 ⇒ 界面显示**复制任务进度**（`tasks` 服务），
 *    **不**把实例装作已就绪。
 * 2. **信任流**：实例就绪但 `inspection.executable.trusted === false` ⇒ 按钮变
 *    「信任并启动」：先走确认框（`processes.trust` → 宿主 `trustExecutable`，原生框在
 *    同一个命令内），成功后才 `processes.start`。取消 / 失败 ⇒ 保持未信任、一句话说明、不重试。
 * 3. **启动后的读数**：订阅优先（`processes.subscribe`），服务没有推送能力时退化为
 *    3 s 轮询（见 `model.watchProcessStatus` 的注释）。
 *
 * 失败面：错误码**原样**显示、原文不改写；四类常见启动错误另给「为什么 + 下一步」
 * （`launchErrorAdvice`）。拿不到 `launcher.service` 时仍说清缺哪一块，不吞异常。
 *
 * 详情分区（组长接线，UI-CONTENT / UI-SAVES / UI-PLUGINS 三块面板的挂载点）：`概览` = 只读事实
 * 三块（路径 / 运行时 / 信任，默认分区）；`内容包` = `ContentPanel`；`存档` = `SavesPanel`；
 * `游戏插件` = `PluginsPanel`。三块面板**只在自己那一屏才挂载**（组件自取数，挂着就多几轮
 * IPC），且只拿到 `host.pickArchive` / `service.saves.exportArchive` 两条回调——视图不开第二条
 * 授权路径（插件面板同样只吃父层给的 `onPickArchive`）。
 *
 * 装载纪律（PS-10）：本组件只经 `App.tsx` 的 `lazy(() => import('./launcher/LauncherView'))`
 * 进入，插件本体由 `bootstrap.ts::ensureLauncherPlugin` 的字面量动态 import 装载
 * ⇒ 开机图**零新增文件**。样式全部走 `launcher.css`（token 消费，零颜色字面量）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type {
  InstanceInspection,
  LauncherHostBridge,
  LauncherInstance,
  LauncherService,
  LauncherTask,
  ProcessStatus,
  SaveExportRequest,
} from '@kojo/plugin-api';
import { Icon } from '../ui/icons';
import { ContentPanel } from './content-panel';
import { PluginsPanel } from './plugins-panel';
import { SavesPanel } from './saves-panel';
import {
  ISOLATION_CHOICES,
  NO_LAUNCH_SURFACE_TEXT,
  WIZARD_STEPS,
  WIZARD_STEP_TITLES,
  describeFailure,
  describeTrustInterruption,
  detailFacts,
  detailHeadline,
  emptyProbeNotice,
  filterInstances,
  includeSavesHint,
  instanceRowView,
  instanceStatusLine,
  isolationChoiceLabel,
  launchErrorAdvice,
  launchPlan,
  sortInstances,
  startStopControls,
  taskProgressView,
  watchProcessStatus,
  wizardAdvance,
  wizardApplyPickedRoot,
  wizardBlockedReason,
  wizardCreateRequest,
  wizardRetreat,
  wizardSelectCandidate,
  wizardStart,
  wizardStepIndex,
  wizardSummaryRows,
  type CandidateCard,
  type DetailFacts,
  type FactRow,
  type FailureView,
  type LauncherPending,
  type WizardState,
} from './model';
import {
  probeCandidates,
  resolveLaunchSurfaces,
  resolveLauncherHost,
  resolveLauncherService,
} from './launcher-service';
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

type WizardBusy = 'pick' | 'probe' | 'create' | null;

/** 创建回执：`task` 非空 = 后台还在复制（此刻**不是** ready） */
interface CreationState {
  readonly instance: LauncherInstance;
  readonly task: LauncherTask | null;
}

/** 失败读数（标题 / 码 / 原文 / 建议）——码与原文都不改写，只补人话建议 */
function FailureNotice({
  failure,
  onDismiss,
}: {
  readonly failure: FailureView;
  readonly onDismiss?: () => void;
}): ReactElement {
  // 四类启动错误的「为什么 + 下一步」；其余码走 `failure.hint`（一张表覆盖全部码）
  const advice = launchErrorAdvice(failure.code);
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
      {advice === null ? null : (
        <p className="launcher-failure-heading" data-tone="warn">
          {advice.heading}
        </p>
      )}
      <p className="launcher-failure-message">{failure.message}</p>
      {failure.detail === null ? null : <p className="launcher-failure-detail">{failure.detail}</p>}
      {advice === null ? null : (
        <p className="launcher-failure-why">{advice.explanation}</p>
      )}
      <p className="launcher-failure-hint">{advice === null ? failure.hint : advice.nextStep}</p>
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

/** 详情分区：概览（只读事实）/ 内容包 / 存档 / 游戏插件——面板按需挂载，不抢首帧 */
type DetailTab = 'overview' | 'content' | 'saves' | 'plugins';

const DETAIL_TABS: readonly { readonly id: DetailTab; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'content', label: '内容包' },
  { id: 'saves', label: '存档' },
  { id: 'plugins', label: '游戏插件' },
];

/**
 * 详情页的分区容器。
 *
 * 三块面板（`ContentPanel` / `SavesPanel` / `PluginsPanel`）只在对应分区被点开时才挂载：
 * 它们的取数由组件自己发起（`service.content.*` / `service.saves.*` / `service.plugins.*`），
 * 挂在 `概览` 那一屏上就会白白多打几轮 IPC。
 *
 * `host` 只在这里被读一次，转成面板要的两条回调形状：
 * - `onPickArchive`：`host.pickArchive` 缺席（Web 壳 / 极早相位）⇒ 传 `undefined`，
 *   面板据此禁用导入按钮并写明「宿主未提供选择器」——不假装能选；
 * - `onExport`：走 `service.saves.exportArchive`（原生保存对话框即授权，与契约 §9 一致）。
 */
function DetailTabs({
  service,
  instance,
  facts,
  host,
}: {
  readonly service: LauncherService;
  readonly instance: LauncherInstance;
  readonly facts: DetailFacts;
  readonly host: LauncherHostBridge | null;
}): ReactElement {
  const [tab, setTab] = useState<DetailTab>('overview');

  const onPickArchive = useMemo(
    () =>
      host === null || typeof host.pickArchive !== 'function'
        ? undefined
        : (): Promise<string | null> => host.pickArchive!(),
    [host],
  );

  return (
    <>
      <div className="launcher-tabs" role="tablist" aria-label="实例详情分区">
        {DETAIL_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`launcher-tab${tab === entry.id ? ' on' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="launcher-fact-grid">
          <FactBlock title="路径" rows={facts.paths} />
          <FactBlock title="运行时" rows={facts.runtime} />
          <FactBlock title="信任" rows={facts.trust} />
        </div>
      ) : null}

      {tab === 'content' ? (
        <ContentPanel service={service} instanceId={instance.id} onPickArchive={onPickArchive} />
      ) : null}

      {tab === 'saves' ? (
        <SavesPanel
          service={service}
          instanceId={instance.id}
          isolation={instance.isolation === 'copy' ? 'copy' : 'shared'}
          onPickArchive={onPickArchive}
          onExport={(req: SaveExportRequest): Promise<string | null> =>
            service.saves.exportArchive(instance.id, req)
          }
        />
      ) : null}

      {tab === 'plugins' ? (
        <PluginsPanel service={service} instanceId={instance.id} onPickArchive={onPickArchive} />
      ) : null}
    </>
  );
}

/** 空状态：解释下一步做什么（按钮已接活——点它开向导） */
function EmptyLibrary({
  onCreate,
  onRefresh,
  surfaceCount,
}: {
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly surfaceCount: number;
}): ReactElement {
  return (
    <div className="empty-state">
      <p>还没有实例</p>
      <p className="dim">
        实例 = 一个游戏目录 + 一份隔离配置。点「从目录创建」→ 选目录 → 选启动程序 → 起名。
      </p>
      <div className="empty-actions">
        <button type="button" className="primary" onClick={onCreate}>
          从目录创建
        </button>
        <button type="button" className="ghost" onClick={onRefresh}>
          刷新列表
        </button>
      </div>
      {surfaceCount === 0 ? <p className="dim">{NO_LAUNCH_SURFACE_TEXT}</p> : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 新建实例向导（三步，同一浮层内）
 * ══════════════════════════════════════════════════════════════════════════════ */

interface WizardPanelProps {
  readonly state: WizardState;
  readonly cards: readonly CandidateCard[];
  readonly failures: readonly { readonly adapterId: string; readonly message: string }[];
  readonly surfaceCount: number;
  readonly busy: WizardBusy;
  readonly failure: FailureView | null;
  readonly notice: string | null;
  readonly onPick: () => void;
  readonly onSelect: (card: CandidateCard) => void;
  readonly onName: (name: string) => void;
  readonly onIsolation: (mode: 'shared' | 'copy') => void;
  readonly onIncludeSaves: (value: boolean) => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

const WIZARD_BUSY_TEXT: Readonly<Record<Exclude<WizardBusy, null>, string>> = {
  pick: '正在等待系统目录对话框…',
  probe: '正在探测候选程序…',
  create: '正在创建实例（复制档可能要等一会儿）…',
};

function WizardPanel(props: WizardPanelProps): ReactElement {
  const { state, cards, failures, surfaceCount, busy, failure, notice } = props;
  const selectedCard = cards.find((card) => card.key === state.candidateKey) ?? null;
  const blocked = wizardBlockedReason(state, { candidateCount: cards.length });
  const submission = wizardCreateRequest(state, selectedCard);
  const atFirst = wizardStepIndex(state.step) === 0;
  const atLast = state.step === 'details';
  const emptyNotice = emptyProbeNotice(failures);

  return (
    <div className="launcher-wizard" role="group" aria-label="新建实例向导">
      <ol className="launcher-steps">
        {WIZARD_STEPS.map((step, index) => (
          <li
            key={step}
            className="launcher-step"
            data-state={
              step === state.step ? 'on' : wizardStepIndex(state.step) > index ? 'done' : 'todo'
            }
          >
            <span className="launcher-step-index">{index + 1}</span>
            {WIZARD_STEP_TITLES[step]}
          </li>
        ))}
      </ol>

      <div className="launcher-wizard-body">
        {failure === null ? null : <FailureNotice failure={failure} />}
        {notice === null ? null : (
          <p className="launcher-note" role="status">
            {notice}
          </p>
        )}

        {state.step === 'source' ? (
          <section className="launcher-wizard-step" aria-label="第一步：选来源目录">
            <p className="launcher-note">
              选一个游戏目录。系统目录对话框就是授权：确认后这个目录才会进「来源根」表，
              启动器不会去读你没选过的目录。
            </p>
            {state.sourceRoot === null ? null : (
              <p className="launcher-note">已选来源目录：{state.sourceRoot}</p>
            )}
            <div className="launcher-wizard-actions">
              <button
                type="button"
                className="primary"
                onClick={props.onPick}
                disabled={busy !== null}
              >
                <Icon name="files" size="sm" />
                选择游戏目录…
              </button>
            </div>
          </section>
        ) : null}

        {state.step === 'candidate' ? (
          <section className="launcher-wizard-step" aria-label="第二步：选启动程序">
            <p className="launcher-note">来源目录：{state.sourceRoot ?? '（未选）'}</p>
            {surfaceCount === 0 ? <p className="launcher-warn-note">{NO_LAUNCH_SURFACE_TEXT}</p> : null}
            {busy === 'probe' ? (
              <p className="launcher-note" role="status">
                {WIZARD_BUSY_TEXT.probe}
              </p>
            ) : cards.length === 0 ? (
              <div className="launcher-empty-probe" role="status">
                <p className="launcher-empty-probe-title">{emptyNotice.title}</p>
                <ul className="launcher-empty-probe-reasons">
                  {emptyNotice.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <div className="launcher-wizard-actions">
                  <button type="button" className="ghost" onClick={props.onBack} disabled={busy !== null}>
                    重新选择目录
                  </button>
                </div>
              </div>
            ) : (
              <ul className="launcher-candidates">
                {cards.map((card) => (
                  <li key={card.key}>
                    <button
                      type="button"
                      className="launcher-candidate"
                      aria-pressed={card.key === state.candidateKey}
                      data-recommended={card.recommended ? 'true' : 'false'}
                      onClick={() => props.onSelect(card)}
                      disabled={busy !== null}
                    >
                      <span className="launcher-candidate-head">
                        <span className="launcher-candidate-name">{card.label}</span>
                        {card.recommended ? (
                          <span className="launcher-badge launcher-candidate-rec">推荐位</span>
                        ) : null}
                        {card.arch === null ? null : (
                          <span className="launcher-badge">{card.arch}</span>
                        )}
                      </span>
                      {/* 证据：目标程序相对游戏目录的路径（不是绝对路径，不泄露用户目录） */}
                      <span className="launcher-candidate-path">{card.relativePath}</span>
                      {card.notes === null ? null : (
                        <span className="launcher-candidate-notes">{card.notes}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {state.step === 'details' ? (
          <section className="launcher-wizard-step" aria-label="第三步：起名与隔离">
            <label className="launcher-field">
              <span className="launcher-field-label">实例名</span>
              <input
                className="launcher-input"
                type="text"
                value={state.name}
                onChange={(event) => props.onName(event.target.value)}
                placeholder="列表里靠它认，例如「主存档 · 共享」"
                aria-label="实例名"
                disabled={busy !== null}
              />
            </label>

            <fieldset className="launcher-field launcher-fieldset">
              <legend className="launcher-field-label">隔离模式</legend>
              {ISOLATION_CHOICES.map((choice) => (
                <label className="launcher-choice" key={choice.mode}>
                  <input
                    type="radio"
                    name="launcher-isolation"
                    checked={state.isolation === choice.mode}
                    onChange={() => props.onIsolation(choice.mode)}
                    disabled={busy !== null}
                  />
                  <span className="launcher-choice-body">
                    <span className="launcher-choice-label">{choice.label}</span>
                    <span className="launcher-choice-hint">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="launcher-choice" data-disabled={state.isolation === 'copy' ? 'false' : 'true'}>
              <input
                type="checkbox"
                checked={state.includeSaves}
                onChange={(event) => props.onIncludeSaves(event.target.checked)}
                disabled={busy !== null || state.isolation !== 'copy'}
              />
              <span className="launcher-choice-body">
                <span className="launcher-choice-label">包含存档</span>
                <span className="launcher-choice-hint">{includeSavesHint(state.isolation)}</span>
              </span>
            </label>

            <dl className="launcher-facts launcher-wizard-summary" aria-label="将要创建的实例">
              {wizardSummaryRows(state, selectedCard).map((row) => (
                <div className="launcher-fact" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>

            {submission.problem === null ? null : (
              <p className="launcher-warn-note">{submission.problem}</p>
            )}
          </section>
        ) : null}
      </div>

      <footer className="launcher-wizard-foot">
        <button
          type="button"
          className="ghost small"
          onClick={props.onBack}
          disabled={atFirst || busy !== null}
        >
          上一步
        </button>
        {atLast ? (
          <button
            type="button"
            className="primary small"
            onClick={props.onSubmit}
            disabled={busy !== null || submission.request === null}
          >
            创建实例
          </button>
        ) : (
          <button
            type="button"
            className="primary small"
            onClick={props.onNext}
            disabled={busy !== null || blocked !== null}
          >
            下一步
          </button>
        )}
        <button type="button" className="ghost small" onClick={props.onCancel} disabled={busy === 'create'}>
          取消
        </button>
        {busy === null ? null : (
          <span className="launcher-busy" role="status">
            {WIZARD_BUSY_TEXT[busy]}
          </span>
        )}
        {atLast || busy !== null || blocked === null ? null : (
          <span className="launcher-wizard-blocked">{blocked}</span>
        )}
      </footer>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 创建回执面板：复制任务在跑时显示进度，而不是「就绪」
 * ══════════════════════════════════════════════════════════════════════════════ */

function CreationPanel({
  creation,
  onDismiss,
}: {
  readonly creation: CreationState;
  readonly onDismiss: () => void;
}): ReactElement {
  const task = creation.task;
  const progress = task === null ? null : taskProgressView(task);
  return (
    <section className="launcher-creation" role="status" aria-label="创建进度">
      <div className="launcher-creation-head">
        <strong>{progress === null ? '实例已创建' : progress.headline}</strong>
        <span className="launcher-status" data-tone={progress === null ? 'ok' : progress.tone}>
          {progress === null ? '就绪' : progress.terminal ? '已结束' : '进行中'}
        </span>
        <button type="button" className="ghost small" onClick={onDismiss}>
          收起
        </button>
      </div>
      <p className="launcher-note">
        {progress === null ? '这个档位不需要复制文件，可以直接启动。' : progress.detail}
      </p>
      {progress !== null && progress.percent !== null ? (
        <progress className="launcher-progress" max={100} value={progress.percent}>
          {progress.percent}%
        </progress>
      ) : null}
      {progress !== null && progress.errorText !== null ? (
        <p className="launcher-warn-note">任务失败：{progress.errorText}</p>
      ) : null}
      {progress === null || progress.terminal ? null : (
        <p className="launcher-note">
          实例「{creation.instance.name}」在复制完成前处于「准备中」，不能启动；进度由任务中心推送，
          关掉这个面板不会取消任务。
        </p>
      )}
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 视图本体
 * ══════════════════════════════════════════════════════════════════════════════ */

export function LauncherView({ kernel, onClose }: LauncherViewProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  /** 手动刷新：递增即重新解析服务并重读实例库（错误态也走这条路出来） */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [instances, setInstances] = useState<readonly LauncherInstance[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProcessStatus>>(new Map());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InstanceInspection | null>(null);
  const [inspectNonce, setInspectNonce] = useState(0);
  const [listFailure, setListFailure] = useState<FailureView | null>(null);
  const [inspectFailure, setInspectFailure] = useState<FailureView | null>(null);
  const [actionFailure, setActionFailure] = useState<FailureView | null>(null);
  const [pending, setPending] = useState<LauncherPending>(null);
  /** 原生确认框被取消 / 失败时的**一行说明**（不是错误条：它没有错误码，也不需要重试） */
  const [trustNote, setTrustNote] = useState<string | null>(null);

  /* 向导 */
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [wizardCandidates, setWizardCandidates] = useState<readonly CandidateCard[]>([]);
  const [probeFailures, setProbeFailures] = useState<
    readonly { readonly adapterId: string; readonly message: string }[]
  >([]);
  const [wizardBusy, setWizardBusy] = useState<WizardBusy>(null);
  const [wizardFailure, setWizardFailure] = useState<FailureView | null>(null);
  const [wizardNotice, setWizardNotice] = useState<string | null>(null);

  /** 创建回执（task 非空 = 还在复制） */
  const [creation, setCreation] = useState<CreationState | null>(null);

  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);
  const refreshInspection = useCallback(() => setInspectNonce((nonce) => nonce + 1), []);

  /* 宿主桥 + 启动面：两条都是内核对象上的现成读数（L10；不新开装载边） */
  const host = useMemo(() => resolveLauncherHost(kernel), [kernel]);
  const surfaces = useMemo(() => resolveLaunchSurfaces(kernel), [kernel]);

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
  }, [phase, selectedId, inspectNonce]);

  /**
   * 3b. 选中实例的进程读数：**订阅优先，3 s 轮询兜底**（见 `watchProcessStatus`）。
   *
   * 与第 2 步的全局订阅并存：那份管列表，这份保证详情页的「跑没跑」不会停在 `starting`
   * （服务没实现推送时全局订阅永远不来事件，而启动的返回值只是一个瞬间快照）。
   */
  useEffect(() => {
    if (phase.kind !== 'ready' || selectedId === null) return;
    return watchProcessStatus(phase.service.processes, selectedId, (status) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.instanceId, status);
        return next;
      });
    });
  }, [phase, selectedId]);

  /* 4. 创建回执里的复制任务：订任务中心，进度走完再刷新实例库（不假装立刻 ready） */
  const service = phase.kind === 'ready' ? phase.service : null;
  const creationTaskId = creation?.task?.id ?? null;
  /**
   * 「这个任务已经触发过一次刷新」的记号。
   *
   * 少了它就会死循环：刷新 → `phase` 换新对象 → 本 effect 重订 → 再读到 succeeded → 再刷新。
   * 记号按任务 id 记，同一个任务只刷新一次（重复 list 只是浪费一轮 IPC）。
   */
  const reloadedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (service === null || creationTaskId === null) return;
    if (typeof service.tasks?.subscribe !== 'function') return;
    const applyTask = (task: LauncherTask): void => {
      if (task.id !== creationTaskId) return;
      setCreation((prev) =>
        prev === null || prev.task === null || prev.task.id !== creationTaskId
          ? prev
          : { ...prev, task },
      );
      if (task.state === 'succeeded' && reloadedTaskRef.current !== task.id) {
        reloadedTaskRef.current = task.id;
        reload();
      }
    };
    const off = service.tasks.subscribe(applyTask);
    // 先读一次快照：任务可能在本组件订阅之前就已经在跑（或已经结束）
    const snapshot = service.tasks.get(creationTaskId);
    if (snapshot !== null) applyTask(snapshot);
    return off;
  }, [service, creationTaskId, reload]);

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
  /** 启动按钮的形态（信任态决定文案；实例没就绪 / 程序不在位时给出不可点原因） */
  const plan = useMemo(
    () => (selected === null ? null : launchPlan(selected, inspection)),
    [selected, inspection],
  );

  const runStop = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'ready' || selectedId === null) return;
    setPending('stop');
    setActionFailure(null);
    try {
      const status = await phase.service.processes.stop(selectedId);
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.instanceId, status);
        return next;
      });
    } catch (error) {
      setActionFailure(describeFailure(error, 'stop'));
    } finally {
      setPending(null);
    }
  }, [phase, selectedId]);

  /**
   * 「启动」或「信任并启动」。
   *
   * 未信任时**先** `processes.trust`（= 宿主 `trustExecutable`：算哈希 + 弹原生确认框，
   * 同一个命令内），成功后才 `processes.start`。
   * 确认框被取消 / 信任失败 ⇒ 保持未信任态、写一行说明、**不启动也不重试**
   * （重试只会再弹一次框，用户会以为点了没反应）。
   */
  const runLaunch = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'ready' || selectedId === null || plan === null) return;
    const service = phase.service;
    setActionFailure(null);
    setTrustNote(null);

    if (plan.needsTrust) {
      setPending('trust');
      try {
        await service.processes.trust(selectedId);
      } catch (error) {
        setPending(null);
        setTrustNote(describeTrustInterruption(error).note);
        refreshInspection(); // 信任态可能已经变了：以宿主现算的读数为准
        return;
      }
      setPending(null);
      refreshInspection();
    }

    setPending('start');
    try {
      const status = await service.processes.start(selectedId);
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.instanceId, status);
        return next;
      });
    } catch (error) {
      setActionFailure(describeFailure(error, 'start'));
      // 启动被拒往往就是信任态变了（TRUST_CHANGED / TRUST_REQUIRED）：重读详情，按钮跟着改文案
      refreshInspection();
    } finally {
      setPending(null);
    }
  }, [phase, selectedId, plan, refreshInspection]);

  /* ------------------------------ 向导动作 ------------------------------ */

  const openWizard = useCallback((): void => {
    setWizard(wizardStart());
    setWizardCandidates([]);
    setProbeFailures([]);
    setWizardFailure(null);
    setWizardNotice(null);
  }, []);

  /**
   * 取消 / 关闭：整份草稿丢弃（等价于 `wizardCancel()` 回初始态——宿主侧此时没有任何写入）。
   * 组件这边只把这一格置空：向导关闭，下次打开是一份新草稿。
   */
  const closeWizard = useCallback((): void => {
    setWizard(null);
    setWizardCandidates([]);
    setProbeFailures([]);
    setWizardFailure(null);
    setWizardNotice(null);
    setWizardBusy(null);
  }, []);

  const runProbe = useCallback(
    async (root: string): Promise<void> => {
      setWizardBusy('probe');
      try {
        const outcome = await probeCandidates(surfaces, root);
        setWizardCandidates(outcome.cards);
        setProbeFailures(outcome.failures);
      } catch (error) {
        setWizardCandidates([]);
        setProbeFailures([]);
        setWizardFailure(describeFailure(error, 'wizard'));
      } finally {
        setWizardBusy(null);
      }
    },
    [surfaces],
  );

  /** 第一步：原生目录对话框（回执即授权；取消 ⇒ 停在原步、只说一句「已取消」） */
  const pickSourceRoot = useCallback(async (): Promise<void> => {
    if (wizard === null) return;
    if (host === null) {
      setWizardFailure(
        describeFailure(
          new Error('宿主桥不在：这一版拿不到系统目录对话框（启动器服务与 kernel.launcher 都缺）。'),
          'wizard',
        ),
      );
      return;
    }
    setWizardBusy('pick');
    setWizardFailure(null);
    setWizardNotice(null);
    try {
      const root = await host.pickSourceRoot('选择游戏目录（确认后这个目录才会被启动器读取）');
      const outcome = wizardApplyPickedRoot(wizard, root);
      if (outcome.kind === 'cancelled') {
        setWizardNotice('已取消选择目录：没有做任何改动。');
        setWizardBusy(null);
        return;
      }
      setWizard(outcome.state);
      setWizardCandidates([]);
      setProbeFailures([]);
      await runProbe(outcome.state.sourceRoot ?? '');
    } catch (error) {
      setWizardFailure(describeFailure(error, 'wizard'));
    } finally {
      setWizardBusy(null);
    }
  }, [host, runProbe, wizard]);

  const wizardNext = useCallback((): void => {
    if (wizard === null) return;
    const move = wizardAdvance(wizard, { candidateCount: wizardCandidates.length });
    if (move.kind === 'blocked') {
      setWizardNotice(move.reason);
      return;
    }
    setWizardNotice(null);
    setWizard(move.state);
  }, [wizard, wizardCandidates.length]);

  const wizardBack = useCallback((): void => {
    setWizardNotice(null);
    setWizardFailure(null);
    setWizard((prev) => (prev === null ? null : wizardRetreat(prev)));
  }, []);

  const submitWizard = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'ready' || wizard === null) return;
    const card = wizardCandidates.find((candidate) => candidate.key === wizard.candidateKey) ?? null;
    const submission = wizardCreateRequest(wizard, card);
    if (submission.request === null) {
      setWizardNotice(submission.problem ?? '还差一项才能创建。');
      return;
    }
    setWizardBusy('create');
    setWizardFailure(null);
    try {
      const created = await phase.service.instances.create(submission.request);
      // 先记回执（task 非空 = 还在复制），再关向导、选中新实例、刷新列表
      setCreation({ instance: created.instance, task: created.task });
      setSelectedId(created.instance.id);
      setWizard(null);
      setWizardCandidates([]);
      setProbeFailures([]);
      reload();
    } catch (error) {
      setWizardFailure(describeFailure(error, 'create'));
    } finally {
      setWizardBusy(null);
    }
  }, [phase, reload, wizard, wizardCandidates]);

  const onMaskDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="launcher-mask" onMouseDown={onMaskDown}>
      <div className="launcher-panel glass" role="dialog" aria-modal="true" aria-label="启动器 · 实例库">
        <header className="launcher-head">
          <div className="launcher-head-titles">
            <h2 className="launcher-title">启动器 · 实例库</h2>
            <p className="launcher-subtitle">创建 / 启动 / 停止游戏实例，并查看路径与信任读数。</p>
          </div>
          <div className="launcher-head-actions">
            {phase.kind === 'ready' && wizard === null ? (
              <button type="button" className="primary small" onClick={openWizard}>
                <Icon name="add" size="sm" />
                新建实例
              </button>
            ) : null}
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

        {phase.kind === 'ready' && wizard !== null ? (
          <WizardPanel
            state={wizard}
            cards={wizardCandidates}
            failures={probeFailures}
            surfaceCount={surfaces.length}
            busy={wizardBusy}
            failure={wizardFailure}
            notice={wizardNotice}
            onPick={() => void pickSourceRoot()}
            onSelect={(card) => setWizard((prev) => (prev === null ? null : wizardSelectCandidate(prev, card)))}
            onName={(name) => setWizard((prev) => (prev === null ? null : { ...prev, name }))}
            onIsolation={(mode) => setWizard((prev) => (prev === null ? null : { ...prev, isolation: mode }))}
            onIncludeSaves={(value) => setWizard((prev) => (prev === null ? null : { ...prev, includeSaves: value }))}
            onNext={wizardNext}
            onBack={wizardBack}
            onCancel={closeWizard}
            onSubmit={() => void submitWizard()}
          />
        ) : null}

        {phase.kind === 'ready' && wizard === null ? (
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
              {creation === null ? null : (
                <CreationPanel creation={creation} onDismiss={() => setCreation(null)} />
              )}
              {instances.length === 0 ? (
                <EmptyLibrary
                  onCreate={openWizard}
                  onRefresh={reload}
                  surfaceCount={surfaces.length}
                />
              ) : selected === null || plan === null ? (
                <p className="launcher-note">从左侧选一个实例查看详情。</p>
              ) : (
                <div className="launcher-detail">
                  <div className="launcher-detail-head">
                    <div className="launcher-detail-titles">
                      <h3 className="launcher-detail-name">{selected.name}</h3>
                      <p className="launcher-detail-meta">
                        {selected.gameId} · {isolationChoiceLabel(selected.isolation)} · {selected.id}
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
                      disabled={!controls.canStart || plan.blockedReason !== null}
                      onClick={() => void runLaunch()}
                    >
                      {plan.label}
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={!controls.canStop}
                      onClick={() => void runStop()}
                    >
                      停止
                    </button>
                    {controls.busyText === null ? null : (
                      <span className="launcher-busy" role="status">
                        {controls.busyText}
                      </span>
                    )}
                    {plan.blockedReason === null ? null : (
                      <span className="launcher-warn-note">{plan.blockedReason}</span>
                    )}
                  </div>
                  {trustNote === null ? null : (
                    <p className="launcher-trust-note" role="status">
                      {trustNote}
                    </p>
                  )}
                  {actionFailure === null ? null : (
                    <FailureNotice failure={actionFailure} onDismiss={() => setActionFailure(null)} />
                  )}
                  {inspectFailure === null ? null : <FailureNotice failure={inspectFailure} />}
                  {facts === null ? null : (
                    <DetailTabs
                      service={phase.service}
                      instance={selected}
                      facts={facts}
                      host={host}
                    />
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
