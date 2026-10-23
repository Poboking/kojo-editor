/**
 * Kojo 2.0 迁移向导（最小可用版）——U6.7 / M7.3–M7.5 的宿主 UI。
 *
 * 刻意做小：
 * - **不接 `EditorPane` 热点**，不 import Monaco / 编辑器模型；本组件只吃
 *   `kojo2-migrate-model` 的 dry-run 与 apply 结果，宿主随时可以把它放进任意覆盖层。
 * - **零内联样式（批次十一 L11 收编）**：观感全部住 `../kojo2.css` 的 `.kojo2-wizard*`
 *   一族（此前整块 GitHub 深色字面量内联，绕开 token 与主题翻色）；遮罩与本体说
 *   `.overlay-backdrop` / `.overlay-host` 的语言，磨砂 / 圆角 / 分层阴影 / 入场动画白拿。
 *   留在组件里的 `style` 只有**数据驱动的量**（进度条宽度），像素与颜色一律不进 TSX。
 * - **不改语义**：三步状态机与全部接线逐字保留——
 *   预演（只读）→ 文件列表 + diff / 台账预览 → 应用（备份 + 回读 + 失败回滚）。
 *   步骤条与进度轨是这一既有三段的**可见化**（阶段 + 图标 + 色三重区分），零新语义。
 *
 * K2-MIGRATE-MOUNT 起多两块**加法**（旧调用方零改动）：
 * - `Kojo2MigrateWizardHost`：宿主用的挂载壳，遮罩挂既有 `.overlay-backdrop`（fixed + 居中，
 *   样式来自 `styles.css` 的浮层族），本组件不再自带定位；
 * - `applyPlan` / `undoPlan` 两个可选端口：宿主入口（`kojo2-migrate-entry.ts`）把自己的
 *   `apply` / `undo` 交进来，写盘之后的"刷新文件树与已开编辑器"由它收尾——向导不认识
 *   宿主的刷新通道。不给端口 = 直接调模型层，与接线前逐字一致。
 * - 语义升级台账（`rewrites`）逐条上屏：每条给出「v1 第 N–M 行 → 落点」的独立 diff。
 *
 * 安全口径由模型层兜底（dry-run 端口类型只有 `readText`；整批默认 fail-closed），
 * 本组件只负责让作者**看见**阻断原因与回滚结果，不提供任何绕闸按钮。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import type { MigrateEventArgs } from '@kojo/kojo-core';
import { Icon } from './icons';
import {
  applyMigratePlan,
  dryRunMigrateFiles,
  undoMigratePlan,
  type MigrateApplyResult,
  type MigrateDryRun,
  type MigrateFilePlan,
  type MigrateIoPort,
  type MigrateRewriteView,
  type MigrateUndoResult,
} from './kojo2-migrate-model';
import '../kojo2.css';

/** 向导属性：`io` 直接传 `kernel.io`（结构子集即可） */
export interface Kojo2MigrateWizardProps {
  readonly io: MigrateIoPort;
  readonly filePaths: readonly string[];
  /** v1 文件头缺 `角色:` 时的说话人兜底（工程配置里拿到的角色名） */
  readonly speaker?: string;
  /**
   * adapter 事件目录的惰性装载（K2-EVENT-FACEWORD 的宿主接线）：给了就在 dry-run 前取一次
   * （失败/缺席 ⇒ `undefined`，迁移器退回 v1 形状判定，不猜目录）。宿主用动态 import 供它，
   * 插件包因此不进开机静态图。
   */
  readonly loadEventNames?: () => Promise<readonly string[] | undefined>;
  /**
   * adapter 事件**参数形状**投影的惰性装载（K2-MIGRATE-SHAPE）：与 `loadEventNames` 同处 await，
   * 失败/缺席 ⇒ `undefined`（迁移器不猜参数形状）。
   */
  readonly loadEventArgs?: () => Promise<MigrateEventArgs | undefined>;
  readonly onClose: () => void;
  /** 应用成功（含部分跳过）后的宿主回调，用于刷新文件树 / 通知 */
  readonly onApplied?: (result: MigrateApplyResult) => void;
  /** 撤销成功后的宿主回调（同样要刷新文件树 / 已开编辑器） */
  readonly onUndone?: (result: MigrateUndoResult) => void;
  /** 人话通知通道（可选；不传则只在本组件内显示） */
  readonly notify?: (message: string) => void;
  /**
   * 应用端口（可选；缺省 = 直接调模型层的 `applyMigratePlan`）。
   *
   * 宿主入口（`kojo2-migrate-entry.ts`）传自己的 `apply`：写盘之后"让文件树与已开编辑器
   * 重载"那一步由它收尾——向导只认识 `io`，不认识宿主的刷新通道，也不该认识。
   * 给了这个端口就不再额外触发 `onApplied`（刷新与通知已经在端口里做过一次）。
   */
  readonly applyPlan?: (plan: MigrateDryRun) => Promise<MigrateApplyResult>;
  /** 撤销端口（可选；语义同 `applyPlan`） */
  readonly undoPlan?: (
    plan: MigrateDryRun,
    applied: MigrateApplyResult,
  ) => Promise<MigrateUndoResult>;
}

type WizardPhase = 'loading' | 'ready' | 'applying' | 'undoing' | 'done' | 'error';

export function Kojo2MigrateWizard({
  io,
  filePaths,
  speaker,
  loadEventNames,
  loadEventArgs,
  onClose,
  onApplied,
  onUndone,
  notify,
  applyPlan,
  undoPlan,
}: Kojo2MigrateWizardProps): ReactElement {
  const [plan, setPlan] = useState<MigrateDryRun | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<WizardPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<MigrateApplyResult | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 数组身份由宿主每次渲染重建时不应触发重跑，故用内容键
  const pathsKey = filePaths.join('\u0000');

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    setApplyResult(null);
    setPlan(null);
    void (async () => {
      // 事件目录惰性装载（失败 = 缺席，不阻断预演）：白名单与参数形状只在给了目录时生效。
      const [eventNames, eventArgs] = await Promise.all([
        loadEventNames === undefined
          ? Promise.resolve(undefined)
          : loadEventNames().catch(() => undefined),
        loadEventArgs === undefined
          ? Promise.resolve(undefined)
          : loadEventArgs().catch(() => undefined),
      ]);
      if (cancelled) return;
      const options: {
        speaker?: string;
        eventNames?: readonly string[];
        eventArgs?: MigrateEventArgs;
      } = {};
      if (speaker !== undefined) options.speaker = speaker;
      if (eventNames !== undefined) options.eventNames = eventNames;
      if (eventArgs !== undefined) options.eventArgs = eventArgs;
      return dryRunMigrateFiles(io, filePaths, options);
    })().then(
      (next) => {
        if (cancelled || next === undefined) return;
        setPlan(next);
        setSelectedPath((previous) => {
          if (previous !== null && next.files.some((file) => file.filePath === previous)) return previous;
          return next.files[0]?.filePath ?? null;
        });
        setPhase('ready');
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(errorText(reason));
        setPhase('error');
      },
    );
    return () => {
      cancelled = true;
    };
    // filePaths 只经 pathsKey 参与依赖：宿主传新数组但内容相同 → 不重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io, pathsKey, speaker, loadEventNames, loadEventArgs, reloadNonce]);

  const selected = useMemo<MigrateFilePlan | null>(() => {
    if (plan === null || selectedPath === null) return null;
    return plan.files.find((file) => file.filePath === selectedPath) ?? plan.files[0] ?? null;
  }, [plan, selectedPath]);

  // 大文件只渲染前 1500 行 diff：向导不该为一份万行口上文件卡住（完整文本仍在计划里）
  const previewLines = useMemo<readonly string[]>(() => {
    if (selected === null) return [];
    const lines = selected.diffText.split('\n');
    if (lines.length <= 1500) return lines;
    return [...lines.slice(0, 1500), `… 已截断 ${lines.length - 1500} 行（完整 diff 见迁移日志）`];
  }, [selected]);

  const close = useCallback(() => {
    // 写盘 / 回滚 / 撤销在途时不允许关：作者应当看到最终结果
    if (phase === 'applying' || phase === 'undoing') return;
    onClose();
  }, [onClose, phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const runApply = useCallback(async (): Promise<void> => {
    if (plan === null || !plan.ok || phase === 'applying') return;
    setPhase('applying');
    setError(null);
    try {
      const result = applyPlan === undefined ? await applyMigratePlan(io, plan) : await applyPlan(plan);
      setApplyResult(result);
      if (result.ok) {
        setPhase('done');
        // 给了宿主端口 ⇒ 刷新与通知已在端口里做过一次，这里不再重复
        if (applyPlan === undefined) {
          notify?.(result.message);
          onApplied?.(result);
        }
      } else {
        setPhase('ready');
        if (applyPlan === undefined) notify?.(result.message);
      }
    } catch (reason) {
      setError(errorText(reason));
      setPhase('ready');
    }
  }, [applyPlan, io, notify, onApplied, phase, plan]);

  const runUndo = useCallback(async (): Promise<void> => {
    if (plan === null || applyResult === null || phase !== 'done') return;
    setPhase('undoing');
    setError(null);
    try {
      const result =
        undoPlan === undefined
          ? await undoMigratePlan(io, plan, applyResult)
          : await undoPlan(plan, applyResult);
      if (result.ok) {
        if (undoPlan === undefined) {
          notify?.(result.message);
          onUndone?.(result);
        }
        setApplyResult(null);
        setReloadNonce((n) => n + 1); // 重新预演：列表回到迁移前状态
      } else {
        setError(result.message);
        setPhase('done');
      }
    } catch (reason) {
      setError(errorText(reason));
      setPhase('done');
    }
  }, [applyResult, io, notify, onUndone, phase, plan, undoPlan]);

  const canApply = plan !== null && plan.ok && phase === 'ready';
  const blockedCount = plan === null ? 0 : plan.summary.blockedCount + plan.summary.readErrorCount;

  /* —— 步骤条与进度轨：三段既有状态（预演 → 复核 → 应用）的**可见化投影**。
     纯视图派生：不新增状态、不读写任何状态机变量之外的东西；每一步的
     done/current/blocked/error 用「序号→记号」的形状变化 + 语义色两路同时说。 —— */

  /** 单步视觉档（`data-state` 的取值；undefined = 尚未走到，用基档） */
  type StepVisualState = 'done' | 'current' | 'blocked' | 'error';

  const step1: StepVisualState | undefined =
    phase === 'loading' ? 'current' : phase === 'error' ? 'error' : plan !== null ? 'done' : undefined;
  const step2: StepVisualState | undefined =
    plan === null || phase === 'loading' || phase === 'error'
      ? undefined
      : phase === 'ready'
        ? plan.ok
          ? 'current'
          : 'blocked'
        : 'done';
  const step3: StepVisualState | undefined =
    phase === 'applying' || phase === 'undoing'
      ? 'current'
      : phase === 'done'
        ? 'done'
        : applyResult !== null && !applyResult.ok
          ? 'error'
          : plan !== null && !plan.ok
            ? 'blocked'
            : undefined;

  const steps: ReadonlyArray<{ label: string; detail: string; state: StepVisualState | undefined }> = [
    { label: '预演', detail: '只读扫描，不写盘', state: step1 },
    {
      label: '复核',
      detail: plan === null ? '等待预演结果' : `${plan.files.length} 个文件 · 阻断 ${blockedCount}`,
      state: step2,
    },
    {
      label: '应用',
      detail:
        phase === 'done'
          ? '已写回，备份保留可撤销'
          : '先备份再写回，失败自动回滚',
      state: step3,
    },
  ];

  /** 进度 = **阶段完成度**四档（15/50/80/100），不伪造文件级百分比；写盘在途走不定态扫光 */
  const progressPct =
    phase === 'error' || phase === 'done'
      ? 100
      : phase === 'applying' || phase === 'undoing'
        ? 80
        : plan !== null
          ? 50
          : 15;
  const progressState: 'error' | 'done' | 'blocked' | undefined =
    phase === 'error' || (applyResult !== null && !applyResult.ok && phase === 'ready')
      ? 'error'
      : phase === 'done'
        ? 'done'
        : plan !== null && !plan.ok
          ? 'blocked'
          : undefined;
  const progressIndeterminate = phase === 'applying' || phase === 'undoing';

  /** 阶段枚胶囊：文案与旧版逐字相同；tone 是同一文案的色形档（busy 档带呼吸点） */
  const statusLabel =
    phase === 'loading'
      ? '预演中'
      : phase === 'applying'
        ? '应用中'
        : phase === 'undoing'
          ? '撤销中'
          : plan !== null && plan.ok
            ? 'dry-run 就绪'
            : '有阻断';
  const statusTone =
    phase === 'loading' || phase === 'applying' || phase === 'undoing'
      ? 'busy'
      : plan !== null && plan.ok
        ? 'ok'
        : 'warn';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Kojo 2.0 迁移向导"
      className="overlay-host kojo2-wizard"
    >
      <header className="kojo2-wizard__head">
        <div>
          <div className="kojo2-wizard__title">Kojo 2.0 迁移向导</div>
          <div className="kojo2-wizard__subtitle">
            {plan === null
              ? '正在读取文件…'
              : `${plan.files.length} 个文件 · 可迁移 ${plan.summary.migratableCount} · 阻断 ${blockedCount} · +${plan.summary.addedLines} / −${plan.summary.removedLines} 行${
                  plan.summary.rewriteCount > 0 ? ` · 语义升级 ${plan.summary.rewriteCount} 条` : ''
                }`}
          </div>
        </div>
        <span className="kojo2-wizard__status" data-tone={statusTone}>
          {statusLabel}
        </span>
      </header>

      <div className="kojo2-wizard__rail">
        <ol className="kojo2-wizard__steps">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className="kojo2-wizard-step"
              data-state={step.state}
              aria-current={step.state === 'current' ? 'step' : undefined}
            >
              <span className="kojo2-wizard-step__index" aria-hidden="true">
                {step.state === 'done' ? (
                  <Icon name="check" size="sm" />
                ) : step.state === 'blocked' ? (
                  <Icon name="warning" size="sm" />
                ) : step.state === 'error' ? (
                  <Icon name="close" size="sm" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="kojo2-wizard-step__body">
                <span className="kojo2-wizard-step__label">{step.label}</span>
                <span className="kojo2-wizard-step__detail">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <div
          className="kojo2-wizard__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressIndeterminate ? undefined : progressPct}
          aria-label="迁移阶段进度"
          data-state={progressState}
          data-indeterminate={progressIndeterminate ? '1' : undefined}
        >
          <span className="kojo2-wizard__progress-track">
            <span className="kojo2-wizard__progress-fill" style={{ width: `${progressPct}%` }} />
          </span>
          <span className="kojo2-wizard__progress-pct">{progressPct}%</span>
        </div>
      </div>

      {phase === 'loading' ? (
        <div className="kojo2-wizard__loading" role="status" aria-busy="true">
          <div className="kojo2-wizard__loading-caption">正在预演（只读，不会写盘）…</div>
          <span className="kojo2-wizard__skeleton-row kojo2-wizard__skeleton-row--mid skeleton" />
          <span className="kojo2-wizard__skeleton-row skeleton" />
          <span className="kojo2-wizard__skeleton-row kojo2-wizard__skeleton-row--short skeleton" />
          <span className="kojo2-wizard__skeleton-row kojo2-wizard__skeleton-row--mid skeleton" />
        </div>
      ) : phase === 'error' ? (
        <div className="kojo2-wizard__result" data-state="error" role="alert">
          <span className="kojo2-wizard__result-icon">
            <Icon name="close" size="md" />
          </span>
          <div className="kojo2-wizard__result-body">
            <div>
              <strong>预演失败：</strong>
              {error}
            </div>
            <div className="kojo2-wizard__actions">
              <button type="button" onClick={close}>
                关闭
              </button>
              <button type="button" className="primary" onClick={() => setReloadNonce((n) => n + 1)}>
                重试
              </button>
            </div>
          </div>
        </div>
      ) : plan === null || plan.files.length === 0 ? (
        <div className="kojo2-wizard__note">没有可迁移的 v1 `.kojo` 文件。</div>
      ) : (
        <div className="kojo2-wizard__body">
          <nav className="kojo2-wizard__files" aria-label="待迁移文件">
            {plan.files.map((file) => {
              const tone = statusOf(file);
              return (
                <button
                  key={file.filePath}
                  type="button"
                  className="kojo2-wizard__file-row"
                  onClick={() => setSelectedPath(file.filePath)}
                  aria-current={file.filePath === selected?.filePath ? 'true' : undefined}
                  title={file.filePath}
                >
                  <span className="kojo2-wizard__file-name">{fileNameOf(file.filePath)}</span>
                  <span className="kojo2-wizard__chip" data-tone={tone.tone}>
                    {tone.label}
                  </span>
                </button>
              );
            })}
          </nav>

          <main className="kojo2-wizard__preview">
            {selected === null ? null : (
              <>
                <div className="kojo2-wizard__preview-head">
                  <span className="kojo2-wizard__preview-path" title={selected.filePath}>
                    {selected.filePath}
                  </span>
                  <span className="kojo2-wizard__dim">
                    {selected.sourceEncoding} · {selected.sourceEol.toUpperCase()} · 写盘 preserve
                    {selected.rewrites.length > 0 ? ` · 语义升级 ${selected.rewrites.length} 条` : ''}
                  </span>
                </div>

                <div className="kojo2-wizard__well kojo2-wizard__diff" role="region" aria-label="逐行 diff">
                  {previewLines.map((line, index) => (
                    <div key={index} className="kojo2-wizard__diff-line" data-diff={diffTone(line)}>
                      {line.length === 0 ? ' ' : line}
                    </div>
                  ))}
                </div>

                {selected.rewrites.length > 0 ? (
                  <section className="kojo2-wizard__section" aria-label="语义升级">
                    <div className="kojo2-wizard__section-title" data-tone="info">
                      语义升级 · {selected.rewrites.length} 条
                      <span>
                        下列构造在机械层是 unsupported；语义层证得动，已改写为 2.0（逐条给出原块 → 落点）
                      </span>
                    </div>
                    {selected.rewrites.map((rewrite, index) => (
                      <div
                        key={`${rewrite.kind}:${rewrite.line}:${index}`}
                        className="kojo2-wizard__item"
                        data-tone="info"
                      >
                        <div className="kojo2-wizard__item-head">
                          <span className="kojo2-wizard__line-chip">{rewriteRangeLabel(rewrite)}</span>
                          <span>{rewrite.title}</span>
                          {rewrite.declName === null ? null : (
                            <code className="kojo2-wizard__code">{rewrite.declName}</code>
                          )}
                        </div>
                        <pre className="kojo2-wizard__well kojo2-wizard__rewrite-diff">{rewrite.diffText}</pre>
                      </div>
                    ))}
                  </section>
                ) : null}

                {selected.error !== null ? (
                  <div className="kojo2-wizard__result" data-state="error" role="alert">
                    <span className="kojo2-wizard__result-icon">
                      <Icon name="close" size="md" />
                    </span>
                    <div className="kojo2-wizard__result-body">{selected.error}</div>
                  </div>
                ) : null}

                {selected.unsupported.length > 0 ? (
                  <section className="kojo2-wizard__section">
                    <div className="kojo2-wizard__section-title" data-tone="warn">
                      不可迁移 · {selected.unsupported.length} 项
                    </div>
                    {selected.unsupported.map((item) => (
                      <div
                        key={`${item.line}:${item.code}`}
                        className="kojo2-wizard__item"
                        data-tone="warn"
                      >
                        <div className="kojo2-wizard__item-head">
                          <span className="kojo2-wizard__line-chip">第 {item.line} 行</span>
                          <span>{item.construct}</span>
                          <code className="kojo2-wizard__code">{item.code}</code>
                        </div>
                        <div className="kojo2-wizard__hint">{item.targetHint}</div>
                        {item.sourceLine.length > 0 ? (
                          <pre className="kojo2-wizard__well kojo2-wizard__source-line">{item.sourceLine}</pre>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                {selected.diagnostics.some((diagnostic) => diagnostic.severity === 'warning') ? (
                  <section className="kojo2-wizard__section">
                    <div className="kojo2-wizard__section-title" data-tone="warn">
                      需人工复核 · warning
                    </div>
                    {selected.diagnostics
                      .filter((diagnostic) => diagnostic.severity === 'warning')
                      .map((diagnostic, index) => (
                        <div key={`${diagnostic.code}:${index}`} className="kojo2-wizard__item-head">
                          <span className="kojo2-wizard__line-chip">
                            {diagnostic.line === null ? '全文' : `第 ${diagnostic.line} 行`}
                          </span>
                          <span className="kojo2-wizard__hint">{diagnostic.message}</span>
                        </div>
                      ))}
                  </section>
                ) : null}

                <div className="kojo2-wizard__plan-note">
                  {selected.ok
                    ? `应用计划：原地改写（不改扩展名、不删源）——先备份，再以 ${selected.sourceEncoding} / ${selected.sourceEol.toUpperCase()} 原样写回。${selected.backup.rollbackHint}`
                    : '该文件含不可迁移写法：整批默认拒绝写盘，源文件不会被改动。'}
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {applyResult !== null ? (
        <div className="kojo2-wizard__result" data-state={applyResult.ok ? 'ok' : 'error'} role="status">
          <span className="kojo2-wizard__result-icon">
            <Icon name={applyResult.ok ? 'check' : 'close'} size="md" />
          </span>
          <div className="kojo2-wizard__result-body">
            <div className="kojo2-wizard__result-title">{applyResult.message}</div>
            {applyResult.files
              .filter((file) => file.status !== 'applied')
              .slice(0, 6)
              .map((file) => (
                <div key={file.filePath} className="kojo2-wizard__result-line">
                  {fileNameOf(file.filePath)}：{file.message}
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {error !== null && phase !== 'error' ? (
        <div className="kojo2-wizard__result" data-state="error" role="alert">
          <span className="kojo2-wizard__result-icon">
            <Icon name="close" size="md" />
          </span>
          <div className="kojo2-wizard__result-body">{error}</div>
        </div>
      ) : null}

      <footer className="kojo2-wizard__footer">
        <span className="kojo2-wizard__dim">
          {plan !== null && !plan.ok
            ? '存在阻断文件，应用已禁用；请先修正旧写法后重新预演。'
            : '应用前逐文件自动备份；写入失败或回读不一致会自动回滚。'}
        </span>
        <div className="kojo2-wizard__actions">
          <button type="button" onClick={close} disabled={phase === 'applying' || phase === 'undoing'}>
            取消
          </button>
          {phase === 'done' ? (
            <>
              {applyResult !== null && applyResult.written > 0 ? (
                <button type="button" onClick={() => void runUndo()}>
                  撤销迁移
                </button>
              ) : null}
              <button type="button" className="primary" onClick={close}>
                完成
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={() => void runApply()} disabled={!canApply}>
              {phase === 'applying' ? '正在应用…' : phase === 'undoing' ? '正在撤销…' : '应用迁移'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * 宿主的**挂载壳**：把向导放进一层盖住窗口的遮罩里。
 *
 * 为什么单独一层：向导本体（`Kojo2MigrateWizard`）是"一块对话框"，不假设自己被谁包着；
 * 宿主只需要在开的时候渲染这一层。遮罩挂既有 `.overlay-backdrop`（磨砂 + 压暗 + 居中 +
 * `--z-modal`，与教程 / 部署 diff 同一族），**不碰** `styles.css`（那是冲突热点）。
 *
 * 点遮罩**不关**：应用 / 回滚在途时误触空白处就关掉，作者会看不到最终结果（与向导内部
 * 对 Esc 的处理同一条纪律——`applying` / `undoing` 阶段关不掉）。
 */
export function Kojo2MigrateWizardHost(props: Kojo2MigrateWizardProps): ReactElement {
  return (
    <div className="overlay-backdrop" data-kojo2-migrate-host="">
      <Kojo2MigrateWizard {...props} />
    </div>
  );
}

/* ============================== 呈现小工具 ============================== */

/** 文件状态档：文案 + `data-tone`（色与描边住 kojo2.css，不再由 TS 算字面量色） */
interface StatusTone {
  readonly label: string;
  readonly tone: 'danger' | 'warn' | 'muted' | 'ok';
}

function statusOf(file: MigrateFilePlan): StatusTone {
  if (file.error !== null) return { label: '读取失败', tone: 'danger' };
  if (!file.ok) return { label: `阻断 ${file.unsupported.length}`, tone: 'warn' };
  if (!file.changed) return { label: '已是 2.0', tone: 'muted' };
  return { label: `+${file.summary.addedLines} / −${file.summary.removedLines}`, tone: 'ok' };
}

/** 语义升级的行范围标签（单行块不写 `–` 空档） */
function rewriteRangeLabel(rewrite: MigrateRewriteView): string {
  return rewrite.endLine > rewrite.line
    ? `第 ${rewrite.line}–${rewrite.endLine} 行`
    : `第 ${rewrite.line} 行`;
}

/** diff 行档位（旧 `diffLineStyle` 的字面量表 → kojo2.css 的 `data-diff` 语义档） */
function diffTone(line: string): 'meta' | 'hunk' | 'add' | 'del' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

function fileNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
