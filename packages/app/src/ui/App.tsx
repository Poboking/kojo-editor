import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, GameProject, RecentProject } from '@kojo/plugin-api';
import { invoke, isTauri } from '../bridge/invoke';
import { bootstrapKernel } from '../bootstrap';
import { ProjectView } from './ProjectView';
import { useNotify } from './NotificationCenter';
import { UnsavedConfirmDialog } from './UnsavedConfirmDialog';
import { WelcomeView } from './WelcomeView';
import { WritableApprovalDialog } from './WritableApprovalDialog';
import type { EditorPaneActions } from './EditorPane';

export type AppPhase = 'boot' | 'welcome' | 'opening' | 'project';

/** 编辑器定位请求（来自校验面板 / 函数树等：内核事件 editor.revealLocation） */
export interface RevealTarget {
  line: number;
  /** 同一文件重复定位时用于触发重新滚动（nonce 变化即重新定位） */
  nonce: number;
}

export function App(): ReactElement {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [phase, setPhase] = useState<AppPhase>('boot');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<GameProject | null>(null);
  const [index, setIndex] = useState<ErbIndex | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  /** 打开的标签页（P3 多标签；顺序即标签栏顺序） */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  /** 各标签脏态集合（EditorPane 按路径逐个上报；标签栏脏点 + 关闭确认用） */
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /** 待确认的脏标签关闭（非 null = 弹确认框） */
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pendingApproval, setPendingApproval] = useState<GameProject | null>(null);
  /** 写权限状态（P0）：null = 无项目；驱动状态栏徽章 + 保存置灰 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 口上域索引构建失败原因（null = 成功/未构建）；驱动状态栏诊断与通知 */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** 通知中心（入口层 Provider 装配，App 自身也可发通知） */
  const notify = useNotify();
  /** 编辑器动作句柄（保存/保存指定/全部保存；EditorPane 注册） */
  const actionsRef = useRef<EditorPaneActions | null>(null);
  const registerActions = useCallback((a: EditorPaneActions | null) => {
    actionsRef.current = a;
  }, []);
  const onDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      const has = prev.has(path);
      if (has === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    bootstrapKernel()
      .then(async (k) => {
        if (disposed) return;
        setKernel(k);
        setRecent(await k.project.recent());
        setPhase('welcome');
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('welcome');
      });
    return () => {
      disposed = true;
    };
  }, []);

  // 索引所有权在 erb-parser：索引重建完成后由事件通知，宿主只同步展示
  useEffect(() => {
    if (!kernel) return;
    const parser = kernel.services.tryGet<ErbParserService>('erb.parser');
    if (!parser) return;
    const refresh = (): void => setIndex(parser.currentIndex());
    const un = kernel.bus.on('kojo.functionChanged', refresh);
    return () => {
      un();
    };
  }, [kernel]);

  // 通用导航意图：任意插件提出"打开文件并定位"，宿主在此落地。
  // P3 多标签后切换零丢失（model 留内存），无需未保存确认——确认只发生在关闭脏标签。
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('editor.revealLocation', (ev) => {
      requestOpenFile(ev.filePath, ev.line ?? 1);
    });
    return () => {
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  // 当前文件广播（v0.3 批 S5-UI）：宿主是"当前打开哪个文件"的唯一权威，
  // 面板（如升糖建议器）需要它才知道该扫哪个文件。做成事件而非查询接口，
  // 免得面板为"知道变了"而持有宿主引用。
  useEffect(() => {
    if (!kernel) return;
    kernel.bus.emit('editor.activeFileChanged', { filePath: activeFile });
  }, [kernel, activeFile]);

  const openProject = useCallback(
    async (dir: string, opts?: { keepView?: boolean }) => {
      if (!kernel) return;
      // 重载项目（同目录重开）不切回欢迎页：避免「项目被关掉」的错觉
      if (!opts?.keepView) setPhase('opening');
      setError(null);
      // 静默只读修复（P0）：不一致事件只在 open() 期间同步发出——局部订阅，
      // 避免常驻监听与 openProject 状态写入之间的竞态
      let approvalMismatch = false;
      const unMismatch = kernel.bus.on('project.writableApprovalMismatch', () => {
        approvalMismatch = true;
      });
      try {
        const p = await kernel.project.open(dir);
        setProject(p);
        setActiveFile(null);
        setReveal(null);
        setIndex(null);
        setPhase('project');
        setRecent(await kernel.project.recent());

        // Rust 侧写允许域注册（M3 纵深防御第二道闸）：
        // 允许域 = 项目根目录 + appDataDir；失败 fail-closed（仅 appDataDir 可写）并显式报错
        if (isTauri()) {
          try {
            await invoke('register_write_domain', { root: dir });
          } catch (e: unknown) {
            setError(`写允许域注册失败（将只允许 appDataDir 写入）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 可写路径批准（首次打开必须由用户显式确认；未批准 = 只读浏览）；
        // 批准记录与新提议不一致（approvalMismatch）同样重弹确认（F1/F2 修复）
        const approved = await kernel.project.approvedWritableFor(dir);
        if (!approved || approvalMismatch) setPendingApproval(p);
        setWritable(approved !== null && !approvalMismatch);

        // 口上域全量索引：解析器在 project.opened 已自动开建，这里等待其完成。
        // 索引失败**不**回退欢迎页：项目仍可浏览，失败原因走状态栏 + 通知显式呈现
        // （原先会走外层 catch → 用户只见「项目打不开」，无从判断是索引的问题）
        setIndexing(true);
        setIndexError(null);
        const parser = kernel.services.get<ErbParserService>('erb.parser');
        try {
          const idx = await parser.ensureIndex();
          setIndex(idx);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setIndexError(msg);
          notify({ kind: 'error', message: `口上域索引构建失败：${msg}` });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        // 打开失败必须显式可见：只落在 welcome 错误区容易被误读成「项目读不了」而无从下手
        notify({ kind: 'error', message: `打开项目失败：${msg}` });
        setPhase('welcome');
      } finally {
        unMismatch();
        setIndexing(false);
      }
    },
    [kernel, notify],
  );

  const chooseAndOpen = useCallback(async () => {
    try {
      const dir = await invoke<string | null>('choose_directory', { title: '选择游戏目录' });
      if (dir) await openProject(dir);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [openProject]);

  const commitOpenFile = useCallback((path: string, line?: number) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
    setReveal(line ? { line, nonce: Date.now() } : null);
  }, []);

  const requestOpenFile = useCallback(
    (path: string, line?: number) => {
      // P3 多标签：切换标签不丢内容（model 留内存），无需未保存确认
      commitOpenFile(path, line);
    },
    [commitOpenFile],
  );

  const openFile = useCallback(
    (path: string) => {
      requestOpenFile(path);
    },
    [requestOpenFile],
  );

  /** 关闭标签（无确认路径；model 回收由 EditorPane 的 openPaths effect 落地） */
  const doCloseTab = useCallback(
    (path: string) => {
      const i = openTabs.indexOf(path);
      const next = openTabs.filter((p) => p !== path);
      setOpenTabs(next);
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const n = new Set(prev);
        n.delete(path);
        return n;
      });
      if (path === activeFile) {
        // 激活邻居标签（优先右侧，末尾则左侧）；空 → 编辑器区回空态
        setActiveFile(next.length > 0 ? (next[Math.min(i, next.length - 1)] ?? null) : null);
        setReveal(null);
      }
    },
    [openTabs, activeFile],
  );

  /** 关闭标签入口：脏标签先弹确认（绝不静默丢弃，审阅 M4 精神在多标签下的延续） */
  const requestCloseTab = useCallback(
    (path: string) => {
      if (dirtyPaths.has(path)) {
        setPendingClose(path);
        return;
      }
      doCloseTab(path);
    },
    [dirtyPaths, doCloseTab],
  );

  const decideClose = useCallback(
    async (action: 'save-then-go' | 'discard' | 'cancel') => {
      const path = pendingClose;
      setPendingClose(null);
      if (!path || action === 'cancel') return;
      if (action === 'save-then-go') {
        const ok = actionsRef.current ? await actionsRef.current.savePath(path) : false;
        if (!ok) return; // 保存失败：标签保留（错误已显示在编辑器状态栏/通知）
      }
      doCloseTab(path);
    },
    [pendingClose, doCloseTab],
  );

  /** 全部保存（Ctrl+Shift+S；壳层命令经 ProjectView 注入） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    return actionsRef.current ? actionsRef.current.saveAll() : false;
  }, []);

  const closeProject = useCallback(async () => {
    if (!kernel) return;
    await kernel.project.close();
    // Rust 侧允许域回到「仅 appDataDir」（与 kernel 的 writablePaths 清理同相位）
    if (isTauri()) {
      try {
        await invoke('clear_write_domain');
      } catch (e: unknown) {
        setError(`写允许域清除失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setProject(null);
    setIndex(null);
    setActiveFile(null);
    setOpenTabs([]);
    setDirtyPaths(new Set());
    setPendingClose(null);
    setReveal(null);
    setPendingApproval(null);
    setWritable(null);
    setIndexError(null);
    setPhase('welcome');
    setRecent(await kernel.project.recent());
  }, [kernel]);

  const decideApproval = useCallback(
    async (allow: boolean) => {
      const p = pendingApproval;
      setPendingApproval(null);
      if (!p || !kernel) return;
      if (!allow) {
        setWritable(false);
        return;
      }
      try {
        await kernel.project.approveWritablePaths(p, p.writablePaths);
        setWritable(true);
      } catch (e: unknown) {
        // 授权失败必须显式可见（P0 实机反馈）：否则对话框一关、徽章仍是「只读」，
        // 用户以为点了没反应（=「无法重新选择权限」）
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setWritable(false);
        notify({ kind: 'error', message: `写权限授权失败：${msg}` });
      }
    },
    [kernel, pendingApproval, notify],
  );

  /** 重授权入口（定稿 Q9：状态栏徽章点击 + 通知 action 两者都留） */
  const requestReauth = useCallback(() => {
    if (project) setPendingApproval(project);
  }, [project]);

  const body =
    phase === 'project' && kernel && project ? (
      <ProjectView
        kernel={kernel}
        project={project}
        index={index}
        indexing={indexing}
        indexError={indexError}
        activeFile={activeFile}
        openTabs={openTabs}
        dirtyPaths={dirtyPaths}
        reveal={reveal}
        onOpenFile={openFile}
        onActivateTab={requestOpenFile}
        onRequestCloseTab={requestCloseTab}
        onSaveAll={saveAll}
        onDirtyChange={onDirtyChange}
        registerActions={registerActions}
        onClose={closeProject}
        onReload={() => void openProject(project.rootDir, { keepView: true })}
        writable={writable ?? false}
        onReauth={requestReauth}
      />
    ) : (
      <WelcomeView
        phase={phase}
        error={error}
        recent={recent}
        tauri={isTauri()}
        kernelReady={kernel !== null}
        onOpenDirectory={chooseAndOpen}
        onOpenRecent={openProject}
      />
    );

  return (
    <>
      {body}
      {pendingApproval ? <WritableApprovalDialog project={pendingApproval} onDecide={decideApproval} /> : null}
      {pendingClose ? (
        <UnsavedConfirmDialog filePath={pendingClose} context="close" onDecide={decideClose} />
      ) : null}
    </>
  );
}
