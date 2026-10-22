/**
 * Kojo 2.0 迁移向导（最小可用版）——U6.7 / M7.3–M7.5 的宿主 UI。
 *
 * 刻意做小：
 * - **不接 `EditorPane` 热点**，不 import Monaco / 编辑器模型；本组件只吃
 *   `kojo2-migrate-model` 的 dry-run 与 apply 结果，宿主随时可以把它放进任意覆盖层。
 * - **零全局样式**：只用内联样式，避免 `styles.css` 冲突热点；要换成设计系统类名时，
 *   只改样式常量，不动接线。
 * - 三步状态：预演（只读）→ 文件列表 + diff / 台账预览 → 应用（备份 + 回读 + 失败回滚）。
 *
 * K2-MIGRATE-MOUNT 起多两块**加法**（旧调用方零改动）：
 * - `Kojo2MigrateWizardHost`：宿主用的挂载壳（`position: fixed` 遮罩 + 居中），样式仍全内联；
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
  type CSSProperties,
  type ReactElement,
} from 'react';
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
      // 事件目录惰性装载（失败 = 缺席，不阻断预演）：白名单只在给了目录时生效。
      const eventNames =
        loadEventNames === undefined
          ? undefined
          : await loadEventNames().catch(() => undefined);
      if (cancelled) return;
      const options: { speaker?: string; eventNames?: readonly string[] } = {};
      if (speaker !== undefined) options.speaker = speaker;
      if (eventNames !== undefined) options.eventNames = eventNames;
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
  }, [io, pathsKey, speaker, loadEventNames, reloadNonce]);

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

  return (
    <div role="dialog" aria-modal="true" aria-label="Kojo 2.0 迁移向导" style={styles.root}>
      <header style={styles.header}>
        <div>
          <div style={styles.title}>Kojo 2.0 迁移向导</div>
          <div style={styles.subtitle}>
            {plan === null
              ? '正在读取文件…'
              : `${plan.files.length} 个文件 · 可迁移 ${plan.summary.migratableCount} · 阻断 ${blockedCount} · +${plan.summary.addedLines} / −${plan.summary.removedLines} 行${
                  plan.summary.rewriteCount > 0 ? ` · 语义升级 ${plan.summary.rewriteCount} 条` : ''
                }`}
          </div>
        </div>
        <span style={plan !== null && plan.ok ? styles.badgeOk : styles.badgeWarn}>
          {phase === 'loading'
            ? '预演中'
            : phase === 'applying'
              ? '应用中'
              : phase === 'undoing'
                ? '撤销中'
                : plan !== null && plan.ok
                  ? 'dry-run 就绪'
                  : '有阻断'}
        </span>
      </header>

      {phase === 'loading' ? (
        <div style={styles.centerNote}>正在预演（只读，不会写盘）…</div>
      ) : phase === 'error' ? (
        <div style={styles.errorBox}>
          <strong>预演失败：</strong>
          {error}
          <div style={styles.rowGap}>
            <button style={styles.ghostButton} onClick={close}>
              关闭
            </button>
            <button style={styles.primaryButton} onClick={() => setReloadNonce((n) => n + 1)}>
              重试
            </button>
          </div>
        </div>
      ) : plan === null || plan.files.length === 0 ? (
        <div style={styles.centerNote}>没有可迁移的 v1 `.kojo` 文件。</div>
      ) : (
        <div style={styles.body}>
          <nav style={styles.fileList} aria-label="待迁移文件">
            {plan.files.map((file) => {
              const tone = statusOf(file);
              return (
                <button
                  key={file.filePath}
                  type="button"
                  onClick={() => setSelectedPath(file.filePath)}
                  style={file.filePath === selected?.filePath ? styles.fileRowActive : styles.fileRow}
                  title={file.filePath}
                >
                  <span style={styles.fileName}>{fileNameOf(file.filePath)}</span>
                  <span style={{ ...styles.chip, color: tone.color, borderColor: tone.border }}>
                    {tone.label}
                  </span>
                </button>
              );
            })}
          </nav>

          <main style={styles.preview}>
            {selected === null ? null : (
              <>
                <div style={styles.previewHead}>
                  <span style={styles.previewPath} title={selected.filePath}>
                    {selected.filePath}
                  </span>
                  <span style={styles.dim}>
                    {selected.sourceEncoding} · {selected.sourceEol.toUpperCase()} · 写盘 preserve
                    {selected.rewrites.length > 0 ? ` · 语义升级 ${selected.rewrites.length} 条` : ''}
                  </span>
                </div>

                <div style={styles.diff} role="region" aria-label="逐行 diff">
                  {previewLines.map((line, index) => (
                    <div key={index} style={diffLineStyle(line)}>
                      {line.length === 0 ? ' ' : line}
                    </div>
                  ))}
                </div>

                {selected.rewrites.length > 0 ? (
                  <section style={styles.section} aria-label="语义升级">
                    <div style={styles.rewriteTitle}>
                      语义升级 · {selected.rewrites.length} 条
                      <span style={styles.dim}>
                        下列构造在机械层是 unsupported；语义层证得动，已改写为 2.0（逐条给出原块 → 落点）
                      </span>
                    </div>
                    {selected.rewrites.map((rewrite, index) => (
                      <div key={`${rewrite.kind}:${rewrite.line}:${index}`} style={styles.rewriteItem}>
                        <div style={styles.rewriteHead}>
                          <span style={styles.lineChip}>{rewriteRangeLabel(rewrite)}</span>
                          <span>{rewrite.title}</span>
                          {rewrite.declName === null ? null : (
                            <code style={styles.code}>{rewrite.declName}</code>
                          )}
                        </div>
                        <pre style={styles.rewriteDiff}>{rewrite.diffText}</pre>
                      </div>
                    ))}
                  </section>
                ) : null}

                {selected.error !== null ? (
                  <div style={styles.errorBox}>{selected.error}</div>
                ) : null}

                {selected.unsupported.length > 0 ? (
                  <section style={styles.section}>
                    <div style={styles.sectionTitle}>不可迁移 · {selected.unsupported.length} 项</div>
                    {selected.unsupported.map((item) => (
                      <div key={`${item.line}:${item.code}`} style={styles.unsupportedItem}>
                        <div style={styles.unsupportedHead}>
                          <span style={styles.lineChip}>第 {item.line} 行</span>
                          <span>{item.construct}</span>
                          <code style={styles.code}>{item.code}</code>
                        </div>
                        <div style={styles.hint}>{item.targetHint}</div>
                        {item.sourceLine.length > 0 ? (
                          <pre style={styles.sourceLine}>{item.sourceLine}</pre>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                {selected.diagnostics.some((diagnostic) => diagnostic.severity === 'warning') ? (
                  <section style={styles.section}>
                    <div style={styles.sectionTitle}>需人工复核 · warning</div>
                    {selected.diagnostics
                      .filter((diagnostic) => diagnostic.severity === 'warning')
                      .map((diagnostic, index) => (
                        <div key={`${diagnostic.code}:${index}`} style={styles.warningItem}>
                          <span style={styles.lineChip}>
                            {diagnostic.line === null ? '全文' : `第 ${diagnostic.line} 行`}
                          </span>
                          <span>{diagnostic.message}</span>
                        </div>
                      ))}
                  </section>
                ) : null}

                <div style={styles.planNote}>
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
        <div style={applyResult.ok ? styles.okBox : styles.errorBox}>
          <strong>{applyResult.message}</strong>
          {applyResult.files
            .filter((file) => file.status !== 'applied')
            .slice(0, 6)
            .map((file) => (
              <div key={file.filePath} style={styles.resultLine}>
                {fileNameOf(file.filePath)}：{file.message}
              </div>
            ))}
        </div>
      ) : null}

      {error !== null && phase !== 'error' ? <div style={styles.errorBox}>{error}</div> : null}

      <footer style={styles.footer}>
        <span style={styles.dim}>
          {plan !== null && !plan.ok
            ? '存在阻断文件，应用已禁用；请先修正旧写法后重新预演。'
            : '应用前逐文件自动备份；写入失败或回读不一致会自动回滚。'}
        </span>
        <div style={styles.rowGap}>
          <button style={styles.ghostButton} onClick={close} disabled={phase === 'applying' || phase === 'undoing'}>
            取消
          </button>
          {phase === 'done' ? (
            <>
              {applyResult !== null && applyResult.written > 0 ? (
                <button style={styles.ghostButton} onClick={() => void runUndo()}>
                  撤销迁移
                </button>
              ) : null}
              <button style={styles.primaryButton} onClick={close}>
                完成
              </button>
            </>
          ) : (
            <button
              style={canApply ? styles.primaryButton : styles.primaryButtonDisabled}
              onClick={() => void runApply()}
              disabled={!canApply}
            >
              {phase === 'applying' ? '正在应用…' : phase === 'undoing' ? '正在撤销…' : '应用迁移'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * 宿主的**挂载壳**：把向导放进一层盖住窗口的遮罩里（`position: fixed`）。
 *
 * 为什么单独一层：向导本体（`Kojo2MigrateWizard`）是"一块对话框"，不假设自己被谁包着；
 * 宿主只需要在开的时候渲染这一层。样式全部内联、复用同一份 `styles`，**不碰** `styles.css`
 * （那是冲突热点），也就不需要新的类名。
 *
 * 点遮罩**不关**：应用 / 回滚在途时误触空白处就关掉，作者会看不到最终结果（与向导内部
 * 对 Esc 的处理同一条纪律——`applying` / `undoing` 阶段关不掉）。
 */
export function Kojo2MigrateWizardHost(props: Kojo2MigrateWizardProps): ReactElement {
  return (
    <div style={styles.backdrop} data-kojo2-migrate-host="">
      <Kojo2MigrateWizard {...props} />
    </div>
  );
}

/* ============================== 呈现小工具 ============================== */

interface StatusTone {
  readonly label: string;
  readonly color: string;
  readonly border: string;
}

function statusOf(file: MigrateFilePlan): StatusTone {
  if (file.error !== null) return { label: '读取失败', color: '#ffb4ab', border: 'rgba(255,180,171,0.4)' };
  if (!file.ok) return { label: `阻断 ${file.unsupported.length}`, color: '#ffca8a', border: 'rgba(255,202,138,0.4)' };
  if (!file.changed) return { label: '已是 2.0', color: '#9aa7b8', border: 'rgba(154,167,184,0.35)' };
  return { label: `+${file.summary.addedLines} / −${file.summary.removedLines}`, color: '#7ee787', border: 'rgba(126,231,135,0.35)' };
}

/** 语义升级的行范围标签（单行块不写 `–` 空档） */
function rewriteRangeLabel(rewrite: MigrateRewriteView): string {
  return rewrite.endLine > rewrite.line
    ? `第 ${rewrite.line}–${rewrite.endLine} 行`
    : `第 ${rewrite.line} 行`;
}

function diffLineStyle(line: string): CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: '#8ab4f8', fontWeight: 600 };
  if (line.startsWith('@@')) return { color: '#c792ea' };
  if (line.startsWith('+')) return { color: '#7ee787', background: 'rgba(46,160,67,0.12)' };
  if (line.startsWith('-')) return { color: '#ff7b72', background: 'rgba(248,81,73,0.10)' };
  return { color: '#9aa7b8' };
}

function fileNameOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ============================== 内联样式（局部，不碰全局样式表） ============================== */

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--z-modal)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(1,4,9,0.62)',
    backdropFilter: 'blur(2px)',
  },
  root: {
    width: 'min(1080px, 94vw)',
    height: 'min(720px, 86vh)',
    display: 'flex',
    flexDirection: 'column',
    color: '#e6edf3',
    background: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)',
    border: '1px solid rgba(139,148,158,0.35)',
    borderRadius: 14,
    boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
    overflow: 'hidden',
    fontFamily: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '14px 18px',
    borderBottom: '1px solid rgba(139,148,158,0.2)',
    background: 'rgba(22,27,34,0.9)',
  },
  title: { fontSize: 16, fontWeight: 700, letterSpacing: 0.2 },
  subtitle: { marginTop: 4, color: '#9aa7b8', fontSize: 12 },
  badgeOk: {
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    color: '#7ee787',
    border: '1px solid rgba(126,231,135,0.4)',
    background: 'rgba(46,160,67,0.12)',
    whiteSpace: 'nowrap',
  },
  badgeWarn: {
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    color: '#ffca8a',
    border: '1px solid rgba(255,202,138,0.4)',
    background: 'rgba(187,128,9,0.14)',
    whiteSpace: 'nowrap',
  },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  fileList: {
    width: 280,
    flexShrink: 0,
    overflowY: 'auto',
    borderRight: '1px solid rgba(139,148,158,0.2)',
    padding: 8,
    background: 'rgba(13,17,23,0.6)',
  },
  fileRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    marginBottom: 4,
    color: '#c9d1d9',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  fileRowActive: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    marginBottom: 4,
    color: '#ffffff',
    background: 'rgba(56,139,253,0.16)',
    border: '1px solid rgba(56,139,253,0.45)',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chip: { flexShrink: 0, padding: '1px 7px', borderRadius: 999, border: '1px solid', fontSize: 10 },
  preview: { flex: 1, minWidth: 0, overflowY: 'auto', padding: 14 },
  previewHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  previewPath: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, color: '#c9d1d9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dim: { color: '#8b949e', fontSize: 11 },
  diff: {
    margin: 0,
    padding: '10px 12px',
    maxHeight: 300,
    overflow: 'auto',
    background: '#010409',
    border: '1px solid rgba(139,148,158,0.25)',
    borderRadius: 8,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre',
  },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#ffca8a', marginBottom: 6 },
  rewriteTitle: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 12, fontWeight: 700, color: '#8ab4f8', marginBottom: 6 },
  rewriteItem: {
    padding: '8px 10px',
    marginBottom: 6,
    border: '1px solid rgba(56,139,253,0.35)',
    borderRadius: 8,
    background: 'rgba(56,139,253,0.07)',
  },
  rewriteHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: '#c9d1d9' },
  rewriteDiff: {
    margin: '6px 0 0',
    padding: '6px 8px',
    maxHeight: 180,
    overflow: 'auto',
    background: '#010409',
    borderRadius: 6,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 11,
    lineHeight: 1.55,
    whiteSpace: 'pre',
  },
  unsupportedItem: {
    padding: '8px 10px',
    marginBottom: 6,
    border: '1px solid rgba(187,128,9,0.35)',
    borderRadius: 8,
    background: 'rgba(187,128,9,0.08)',
  },
  unsupportedHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  lineChip: {
    padding: '0 6px',
    borderRadius: 4,
    fontSize: 10,
    color: '#ffca8a',
    border: '1px solid rgba(255,202,138,0.4)',
  },
  code: { marginLeft: 'auto', fontSize: 10, color: '#8b949e' },
  hint: { marginTop: 4, color: '#c9d1d9' },
  sourceLine: {
    margin: '6px 0 0',
    padding: '4px 8px',
    background: '#010409',
    borderRadius: 5,
    color: '#ff7b72',
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 11,
    overflowX: 'auto',
  },
  warningItem: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, color: '#c9d1d9' },
  planNote: { marginTop: 14, color: '#8b949e', fontSize: 11, lineHeight: 1.6 },
  centerNote: { flex: 1, display: 'grid', placeItems: 'center', color: '#8b949e', padding: 24 },
  errorBox: {
    margin: 14,
    padding: '10px 12px',
    color: '#ffb4ab',
    background: 'rgba(248,81,73,0.08)',
    border: '1px solid rgba(248,81,73,0.4)',
    borderRadius: 8,
    lineHeight: 1.6,
  },
  okBox: {
    margin: 14,
    padding: '10px 12px',
    color: '#7ee787',
    background: 'rgba(46,160,67,0.10)',
    border: '1px solid rgba(126,231,135,0.35)',
    borderRadius: 8,
    lineHeight: 1.6,
  },
  resultLine: { marginTop: 4, color: '#c9d1d9', fontSize: 11 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '12px 18px',
    borderTop: '1px solid rgba(139,148,158,0.2)',
    background: 'rgba(22,27,34,0.9)',
  },
  rowGap: { display: 'flex', alignItems: 'center', gap: 8 },
  ghostButton: {
    padding: '6px 14px',
    color: '#c9d1d9',
    background: 'transparent',
    border: '1px solid rgba(139,148,158,0.45)',
    borderRadius: 7,
    cursor: 'pointer',
    font: 'inherit',
  },
  primaryButton: {
    padding: '6px 16px',
    color: '#ffffff',
    background: '#238636',
    border: '1px solid rgba(46,160,67,0.6)',
    borderRadius: 7,
    cursor: 'pointer',
    font: 'inherit',
  },
  primaryButtonDisabled: {
    padding: '6px 16px',
    color: '#6e7681',
    background: 'rgba(35,134,54,0.25)',
    border: '1px solid rgba(46,160,67,0.2)',
    borderRadius: 7,
    cursor: 'not-allowed',
    font: 'inherit',
  },
} satisfies Record<string, CSSProperties>;
