/**
 * 「我的口上项目」面板（2026-10-12 口上项目批 P-B）。
 *
 * 三级树：**项目 → 包（artifact）→ 文件**。知识分层：
 * - 项目/包模型是内核 `kernel.workspaces` 的通用 project/artifact（内核零游戏知识）；
 *   「包 = 作者口上包」的游戏解释只住在 adapter（本面板）；
 * - 包内文件**惰性列举**并按目录缓存（缓存在插件闭包，批量展开不刮目录请求风暴）；
 * - 文件点击 → `editor.revealLocation`（宿主消费；面板不持有宿主引用）；
 * - 顶部**常驻**双真相源提示条：工作区为权威 · 游戏目录仅部署目标
 *   （讨论纪要 §2 定调——不明示用户就会困惑「改了哪个才算数」）。
 *
 * 默认形态克制（口上树简洁约束）：项目行展开即见包标题行；**包默认折叠**，
 * 用户主动展开才列举文件——信息呈现以不杂乱为第一约束。
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirEntry, WorkspaceArtifact, WorkspaceProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';

/** 目录列举态（闭包缓存值）：在途 / 失败（带原因）/ 已加载 */
export type DirListState = DirEntry[] | 'loading' | { error: string };

export interface KojoProjectsPanelDeps {
  /** 订阅工作区状态变化（项目列表 / 目录缓存）；返回取消订阅 */
  subscribe(cb: () => void): () => void;
  /** 项目列表快照（内核已按 updatedAt 倒序） */
  projects(): readonly WorkspaceProject[];
  /** 项目列表是否在途 */
  loading(): boolean;
  /** 项目列表加载失败原因（null = 无） */
  error(): string | null;
  /** 手动刷新项目列表 */
  refresh(): void;
  /** 项目目录绝对路径 */
  projectDir(projectId: string): string;
  /** 目录列举态（未触发加载 → undefined） */
  dirState(absDir: string): DirListState | undefined;
  /** 请求加载目录（已加载/在途 → no-op） */
  ensureDir(absDir: string): void;
  /** 打开文件并定位（经内核事件，宿主消费） */
  reveal(absPath: string): void;
}

/** 目录条目排序：目录在前，其后按名称（中文本地化比较口径） */
export function sortDirEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/** 包目录绝对路径（项目目录 + 包目录名；制品文件全部住在这里） */
export function artifactDir(projectDir: string, artifact: Pick<WorkspaceArtifact, 'dirName'>): string {
  return join(projectDir, artifact.dirName);
}

/** 行缩进（层级 → padding-left；树深度不定，内联最直观） */
function indent(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${4 + depth * 14}px` };
}

/**
 * 面板组件工厂（createElement 风格，与本插件既有面板一致；不引 JSX）。
 * 数据与缓存全在 deps（插件闭包），组件只持有**呈现态**（展开/折叠集合）。
 */
export function createKojoProjectsPanel(deps: KojoProjectsPanelDeps): () => unknown {
  return function KojoProjectsPanel(): unknown {
    const [, force] = useState(0);
    /** 折叠的项目（缺省全展开——项目行下包标题行可见即「简洁平铺」形态） */
    const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
    /** 展开的包/子目录（绝对路径；缺省空 = 包折叠，不列举文件） */
    const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
    const openDirsRef = useRef(openDirs);
    openDirsRef.current = openDirs;

    useEffect(
      () =>
        deps.subscribe(() => {
          // 缓存失效（导入/部署等变更后）→ 重列展开中的目录（已缓存则 no-op，收敛）
          for (const d of openDirsRef.current) deps.ensureDir(d);
          force((n) => n + 1);
        }),
      [deps],
    );

    const toggleIn = <T,>(set: Set<T>, key: T): Set<T> => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    };

    const toggleProject = (id: string): void => setClosedProjects((prev) => toggleIn(prev, id));

    /** 包/子目录展开切换；首次展开触发惰性列举（缓存命中则零请求） */
    const toggleDir = (dir: string): void => {
      if (!openDirs.has(dir)) deps.ensureDir(dir);
      setOpenDirs((prev) => toggleIn(prev, dir));
    };

    /* ------------------------------ 目录内容（递归） ------------------------------ */

    const renderDir = (dir: string, depth: number): ReactNode => {
      const state = deps.dirState(dir);
      if (state === undefined || state === 'loading') {
        return h('div', { key: `${dir}::note`, className: 'kp-note dim', style: indent(depth) }, '读取目录…');
      }
      if (!Array.isArray(state)) {
        return h(
          'div',
          { key: `${dir}::note`, className: 'kp-note err', style: indent(depth), title: state.error },
          '目录读取失败（悬停查看原因）',
        );
      }
      const entries = sortDirEntries(state);
      if (entries.length === 0) {
        return h('div', { key: `${dir}::note`, className: 'kp-note dim', style: indent(depth) }, '（空目录）');
      }
      return h(
        'div',
        { key: dir, className: 'kp-dir' },
        ...entries.map((e) => {
          if (e.isDirectory) {
            const dOpen = openDirs.has(e.path);
            return h(
              'div',
              { key: e.path },
              h(
                'button',
                {
                  className: 'kp-dir-btn',
                  style: indent(depth),
                  title: e.path,
                  onClick: () => toggleDir(e.path),
                },
                h('span', { className: 'caret' }, dOpen ? '▾' : '▸'),
                h('span', { className: 'kp-dir-name' }, e.name),
              ),
              dOpen ? renderDir(e.path, depth + 1) : null,
            );
          }
          return h(
            'button',
            {
              key: e.path,
              className: 'kp-file-btn',
              style: indent(depth),
              title: e.path,
              onClick: () => deps.reveal(e.path),
            },
            h('span', { className: 'kp-file-name' }, e.name),
          );
        }),
      );
    };

    /* ------------------------------ 项目 → 包 ------------------------------ */

    const renderArtifacts = (p: WorkspaceProject): ReactNode => {
      if (p.artifacts.length === 0) {
        return h('div', { className: 'kp-note dim', style: indent(1) }, '（暂无作者包）');
      }
      return h(
        'div',
        { className: 'kp-artifacts' },
        ...p.artifacts.map((a) => {
          const dir = artifactDir(deps.projectDir(p.id), a);
          const isOpen = openDirs.has(dir);
          return h(
            'div',
            { key: a.id, className: 'kp-artifact' },
            h(
              'button',
              {
                className: 'kp-artifact-btn',
                style: indent(1),
                title: `${dir}（点击展开真实文件夹）`,
                onClick: () => toggleDir(dir),
              },
              h('span', { className: 'caret' }, isOpen ? '▾' : '▸'),
              h('span', { className: 'kp-artifact-name' }, a.name),
              a.name !== a.dirName ? h('span', { className: 'kp-dirname dim' }, a.dirName) : null,
            ),
            isOpen ? renderDir(dir, 2) : null,
          );
        }),
      );
    };

    /* ------------------------------ 骨架 ------------------------------ */

    // 双真相源提示条（常驻；讨论纪要 §2——写保护铁律的 UI 明示面）
    const notice = h(
      'div',
      {
        className: 'kp-notice',
        title: '编辑以工作区为准：工作区是可写的权威副本；游戏目录只读，仅作为部署目标。直接改游戏目录里的文件不会被工作区感知。',
      },
      '工作区为权威 · 游戏目录仅部署目标',
    );

    const projects = deps.projects();
    const loading = deps.loading();
    const error = deps.error();

    const toolbar = h(
      'div',
      { className: 'kp-toolbar' },
      h('span', { className: 'dim kp-toolbar-label' }, loading ? '读取中…' : `${projects.length} 个项目`),
      h('button', { className: 'ghost small', title: '刷新项目列表', onClick: () => deps.refresh() }, '⟳'),
    );

    let body: ReactNode;
    if (error) {
      body = h(
        'div',
        { className: 'kp-body' },
        h('div', { className: 'kp-empty err', title: error }, `工作区加载失败：${error}`),
        h('div', { className: 'kp-actions' }, h('button', { className: 'small', onClick: () => deps.refresh() }, '重试')),
      );
    } else if (projects.length === 0) {
      body = h(
        'div',
        { className: 'kp-body' },
        h('div', { className: 'kp-empty dim' }, loading ? '正在读取工作区…' : '还没有口上项目'),
        loading
          ? null
          : h('div', { className: 'kp-empty dim' }, '可在此新建作品，或从文件树导入既有作者包'),
      );
    } else {
      body = h(
        'div',
        { className: 'kp-body' },
        ...projects.map((p) => {
          const pOpen = !closedProjects.has(p.id);
          return h(
            'div',
            { key: p.id, className: 'kp-project' },
            h(
              'button',
              { className: 'kp-project-btn', title: `项目：${p.name}`, onClick: () => toggleProject(p.id) },
              h('span', { className: 'caret' }, pOpen ? '▾' : '▸'),
              h('span', { className: 'kp-project-name' }, p.name),
              h('span', { className: 'kp-count dim' }, `${p.artifacts.length} 包`),
            ),
            pOpen ? renderArtifacts(p) : null,
          );
        }),
      );
    }

    return h('div', { className: 'panel-kojo-projects' }, notice, toolbar, body);
  };
}
