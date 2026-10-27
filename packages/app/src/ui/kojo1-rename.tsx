/**
 * `.kojo` → `.kojo1` 改名对话框（LAU-3b，2026-10-27）。
 *
 * ## 它只做三步
 *
 * 1. **列清单**（只读）：读口上域里的 `.kojo`，按内容指纹分流——只把**确认是 v1 写法**的
 *    文件放进候选；已是 2.0 写法 / 拿不准 / 空文件 / 只读域 / 落点已存在，逐条写明原因；
 * 2. **作者过目**：候选项默认全选，可逐个取消；应用前先过脏标签守门（与文件树删除 / 改名
 *    同一条口径），有未保存修改就整批拒绝；
 * 3. **落地**：逐文件再验写权限 → 写前备份 → 只改名不改内容 → 逐条回执。
 *
 * 落成之后由宿主收尾（`onRenamed`）：把开着的标签换到新路径、刷新文件树。本组件不认识
 * 标签栏与文件树，也不自造第二条刷新链。
 *
 * ## 文案口径
 *
 * 作者面只说两件事：**这只是改名**（内容一个字节不动，且已备份）、**改完还是同一门封存
 * 语法**（`.kojo1` 恒按 kojo1 解析，不再参与 2.0 的正文判断）。不讲"扩展名交接"这种
 * 机器词，也不假装它能替作者迁移到 2.0。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Icon } from './icons';
import { KitCheck } from '../ui-kit/kit-check';
import { useModalEscape } from './modal-stack';
import {
  applyKojo1Renames,
  planKojo1Renames,
  type Kojo1RenameApplyReport,
  type Kojo1RenameCandidate,
  type Kojo1RenameIoPort,
  type Kojo1RenamePlan,
  type Kojo1RenameSkipReason,
} from './kojo1-rename-model';

export interface Kojo1RenameDialogProps {
  /** 真身 = `kernel.io`（结构子集） */
  readonly io: Kojo1RenameIoPort;
  /** 已按扩展名收过的候选路径（宿主用 `listSourceFiles` 列举口上域） */
  readonly filePaths: readonly string[];
  /**
   * 脏标签守门（应用前调用；返回人话 = 整批拒绝）。
   * 与文件树删除 / 改名同一条口径：不拿作者没保存的修改去换一次改名。
   */
  readonly guard?: (paths: readonly string[]) => string | null;
  readonly onClose: () => void;
  /** 落地后的宿主收尾（重挂标签路径 + 刷新文件树） */
  readonly onRenamed: (renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>) => void;
  /** 人话通知（可选；不传则只在对话框内显示） */
  readonly notify?: (message: string) => void;
}

type Phase = 'loading' | 'ready' | 'applying' | 'done' | 'error';

/** 跳过原因的人话（一处文案；对话框与测试共用） */
const SKIP_LABELS: Readonly<Record<Kojo1RenameSkipReason, string>> = {
  kojo2: '已是 2.0 写法，不用改名',
  ambiguous: '两套写法都说得通，先不动',
  empty: '空文件',
  'read-failed': '读不出来',
  'destination-exists': '同名 .kojo1 已存在',
  'not-writable': '不在可写范围（先批准写权限）',
};

/** 相对路径的展示（长了就截中间，完整路径留在 title） */
function shortPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const parts = slashed.split('/');
  if (parts.length <= 3) return slashed;
  return `…/${parts.slice(-3).join('/')}`;
}

export function Kojo1RenameDialog({
  io,
  filePaths,
  guard,
  onClose,
  onRenamed,
  notify,
}: Kojo1RenameDialogProps): ReactElement {
  const [plan, setPlan] = useState<Kojo1RenamePlan | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [report, setReport] = useState<Kojo1RenameApplyReport | null>(null);

  const pathsKey = filePaths.join('\u0000');

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);
    setReport(null);
    void (async () => {
      try {
        const next = await planKojo1Renames(filePaths, io);
        if (cancelled) return;
        setPlan(next);
        setSelected(new Set(next.candidates.map((c) => c.from)));
        setPhase('ready');
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // pathsKey 是内容键：宿主每次渲染重建数组不该触发重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey, io]);

  const candidates = plan?.candidates ?? [];
  const chosen = useMemo(
    () => candidates.filter((c) => selected.has(c.from)),
    [candidates, selected],
  );

  const toggle = useCallback((path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allOn = candidates.length > 0 && chosen.length === candidates.length;
  const toggleAll = useCallback((): void => {
    setSelected(allOn ? new Set() : new Set(candidates.map((c) => c.from)));
  }, [allOn, candidates]);

  const run = useCallback(async (): Promise<void> => {
    if (chosen.length === 0) return;
    const blocked = guard?.(chosen.map((c) => c.from)) ?? null;
    if (blocked !== null) {
      setError(blocked);
      return;
    }
    setError(null);
    setPhase('applying');
    try {
      const next = await applyKojo1Renames(chosen, io);
      setReport(next);
      setPhase('done');
      if (next.renamed.length > 0) {
        onRenamed(next.renamed);
        notify?.(`已把 ${next.renamed.length} 份旧 .kojo 改名为 .kojo1（只改名，内容未动，改前已备份）。`);
      } else {
        notify?.('这一批没有文件被改名，逐条原因见对话框。');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [chosen, guard, io, notify, onRenamed]);

  useModalEscape(phase === 'applying' ? () => undefined : onClose);

  const skippedGroups = useMemo(() => {
    const groups = new Map<Kojo1RenameSkipReason, string[]>();
    for (const s of plan?.skipped ?? []) {
      const list = groups.get(s.reason) ?? [];
      list.push(s.path);
      groups.set(s.reason, list);
    }
    return [...groups.entries()];
  }, [plan]);

  const busy = phase === 'loading' || phase === 'applying';

  return (
    <div className="modal-mask">
      <div className="modal legacy-rename" role="dialog" aria-modal="true" aria-label="把旧 .kojo 改名为 .kojo1">
        <h2>把旧 .kojo 文件标成 kojo1</h2>
        <p>
          这份工具<b>只改文件名</b>：把确认是命令式旧写法的 <code>.kojo</code> 改成 <code>.kojo1</code>。
          文件内容一个字节都不动，改名之前每一份都会先备份。
        </p>
        <p className="dim">
          <code>.kojo1</code> 是<b>封存标记</b>：以后打开它永远按 kojo1 解析，不再参与 2.0 的正文判断。
          已经是 2.0 写法、或两套都说得清的文件不会被动到。
        </p>

        {error !== null ? (
          <p className="legacy-rename__error" role="alert">
            <Icon name="warning" /> {error}
          </p>
        ) : null}

        {phase === 'loading' ? (
          <p className="legacy-rename__status">正在读取文件并判断写法…</p>
        ) : null}

        {phase === 'applying' ? (
          <p className="legacy-rename__status">正在改名（写前备份）…</p>
        ) : null}

        {phase !== 'loading' && phase !== 'applying' && plan !== null ? (
          <>
            <div className="legacy-rename__bar">
              <KitCheck
                checked={allOn}
                disabled={candidates.length === 0}
                onChange={toggleAll}
                label="全选"
              >
                全选
              </KitCheck>
              <span className="dim">
                候选 {candidates.length} 份 · 已选 {chosen.length} 份 · 扫描 {plan.scanned} 份
              </span>
            </div>

            {candidates.length > 0 ? (
              <ul className="legacy-rename__list" aria-label="待改名的文件">
                {candidates.map((c: Kojo1RenameCandidate) => (
                  <li key={c.from} className="legacy-rename__row">
                    <KitCheck
                      checked={selected.has(c.from)}
                      disabled={phase === 'done'}
                      onChange={() => toggle(c.from)}
                      label={c.from}
                    >
                      <span className="legacy-rename__path" title={c.from}>
                        {shortPath(c.from)}
                      </span>
                    </KitCheck>
                    <span className="dim">{c.lineCount} 行</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="legacy-rename__empty">
                没有可改名的文件。若你期待有候选，先确认这些文件确实是命令式旧写法（纯台词 / 纯注释
                的文件会被判成"两套都说得通"，不会自动选中）。
              </p>
            )}

            {skippedGroups.length > 0 ? (
              <details className="legacy-rename__skipped">
                <summary>没有列进候选的文件（{plan.skipped.length} 份）</summary>
                <ul>
                  {skippedGroups.map(([reason, paths]) => (
                    <li key={reason}>
                      <b>{SKIP_LABELS[reason]}</b>：{paths.map(shortPath).join('、')}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {report !== null ? (
              <details className="legacy-rename__skipped" open>
                <summary>改名结果（成功 {report.renamed.length} 份）</summary>
                <ul>
                  {report.results.map((r) => (
                    <li key={r.from} className={r.kind === 'renamed' ? undefined : 'legacy-rename__fail'}>
                      {shortPath(r.from)} → {r.kind === 'renamed' ? '已改名' : (r.message ?? r.kind)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={phase === 'applying'}>
            {phase === 'done' ? '完成' : '取消'}
          </button>
          {phase !== 'done' ? (
            <button className="primary" onClick={() => void run()} disabled={busy || chosen.length === 0}>
              {phase === 'applying' ? '正在改名…' : `改名 ${chosen.length} 份`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
