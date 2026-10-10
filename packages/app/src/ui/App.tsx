import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, GameProject, RecentProject } from '@kojo/plugin-api';
import { invoke, isTauri } from '../bridge/invoke';
import { bootstrapKernel } from '../bootstrap';
import { ProjectView } from './ProjectView';
import { WelcomeView } from './WelcomeView';
import { WritableApprovalDialog } from './WritableApprovalDialog';

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
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pendingApproval, setPendingApproval] = useState<GameProject | null>(null);

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

  // 通用导航意图：任意插件提出"打开文件并定位"，宿主在此落地
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('editor.revealLocation', (ev) => {
      setActiveFile(ev.filePath);
      setReveal({ line: ev.line ?? 1, nonce: Date.now() });
    });
    return () => {
      un();
    };
  }, [kernel]);

  const openProject = useCallback(
    async (dir: string) => {
      if (!kernel) return;
      setPhase('opening');
      setError(null);
      try {
        const p = await kernel.project.open(dir);
        setProject(p);
        setActiveFile(null);
        setReveal(null);
        setIndex(null);
        setPhase('project');
        setRecent(await kernel.project.recent());

        // 可写路径批准（首次打开必须由用户显式确认；未批准 = 只读浏览）
        const approved = await kernel.project.approvedWritableFor(dir);
        if (!approved) setPendingApproval(p);

        // 口上域全量索引：解析器在 project.opened 已自动开建，这里等待其完成
        setIndexing(true);
        const parser = kernel.services.get<ErbParserService>('erb.parser');
        const idx = await parser.ensureIndex();
        setIndex(idx);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('welcome');
      } finally {
        setIndexing(false);
      }
    },
    [kernel],
  );

  const chooseAndOpen = useCallback(async () => {
    try {
      const dir = await invoke<string | null>('choose_directory', { title: '选择 eraTW 游戏目录' });
      if (dir) await openProject(dir);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [openProject]);

  const openFile = useCallback((path: string) => {
    setActiveFile(path);
    setReveal(null);
  }, []);

  const closeProject = useCallback(async () => {
    if (!kernel) return;
    await kernel.project.close();
    setProject(null);
    setIndex(null);
    setActiveFile(null);
    setReveal(null);
    setPendingApproval(null);
    setPhase('welcome');
    setRecent(await kernel.project.recent());
  }, [kernel]);

  const decideApproval = useCallback(
    async (allow: boolean) => {
      const p = pendingApproval;
      setPendingApproval(null);
      if (!p || !kernel || !allow) return;
      try {
        await kernel.project.approveWritablePaths(p, p.writablePaths);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [kernel, pendingApproval],
  );

  const body =
    phase === 'project' && kernel && project ? (
      <ProjectView
        kernel={kernel}
        project={project}
        index={index}
        indexing={indexing}
        activeFile={activeFile}
        reveal={reveal}
        onOpenFile={openFile}
        onClose={closeProject}
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
    </>
  );
}
