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
 * 用户主动展开才列举文件——信息呈现以不杂乱为第一约束。同理，包行上的动作
 * （导出等）静息态隐去，悬停 / 键盘聚焦才显；结果经底部状态条交代
 * （控制器见 `package-actions.ts`，无消息时状态条不渲染）。
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirEntry, WorkspaceArtifact, WorkspaceProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { attributionSummary, type AttributionState, type PackageAttribution } from './attribution';
import type { PanelStatus } from './package-actions';

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
  /** 打开「新建口上项目」向导（P-C；缺省 → 不显示新建按钮） */
  openNewWizard?(): void;
  /** 包操作反馈条内容（P-D；null → 状态条不渲染） */
  status(): PanelStatus | null;
  /** 手动关闭反馈条 */
  dismissStatus(): void;
  /** 导出包到用户选定的目录（P-D：平台对话框 + 整目录复制） */
  exportArtifact(absDir: string, displayName: string): void;
  /** 发起「部署到游戏目录」（P-E：打开向导，落点与写权限在向导里确认） */
  deployArtifact(artifact: WorkspaceArtifact, absDir: string): void;
  /** 署名 / 授权读取态（T2；未触发加载 → undefined） */
  attribution(absDir: string): AttributionState | undefined;
  /** 请求加载某包的署名（已加载 / 在途 → no-op） */
  ensureAttribution(absDir: string): void;
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

/** 包事实行的输入（三项都可能缺） */
export interface FactsInput {
  /** 制品 meta 里的目标角色名（P-C 新建时写入；导入的包没有） */
  charaName: string | null;
  /** 目标剧本号（1-10；缺省 = 未记录） */
  scriptNo: number | null;
  /** 署名抽取结果（null = 未抽到任何字段，仍显示角色/剧本） */
  attribution: PackageAttribution | null;
}

/**
 * 组合「包事实行」片段（纯函数）。
 *
 * 缺项**如实不显示**，不补「未知」占位——满屏「未知」比空着更吵，也更像在指控数据缺失。
 * 这一行同时收掉纪要 §5 的两条：署名一等公民（T2）与「多剧本编号在 UI 中显式表达」。
 */
export function packageFacts(inp: FactsInput): string[] {
  const facts: string[] = [];
  if (inp.charaName) facts.push(`目标 ${inp.charaName}`);
  if (inp.scriptNo !== null) facts.push(`剧本${inp.scriptNo}`);
  if (inp.attribution) facts.push(attributionSummary(inp.attribution));
  return facts;
}

/** 从制品 meta 取事实行输入（meta 是 `Record<string, unknown>`，逐项收窄，不猜） */
export function factsFromMeta(meta: Record<string, unknown>): { charaName: string | null; scriptNo: number | null } {
  return {
    charaName: typeof meta.charaName === 'string' && meta.charaName.length > 0 ? meta.charaName : null,
    scriptNo: typeof meta.scriptNo === 'number' && Number.isInteger(meta.scriptNo) ? meta.scriptNo : null,
  };
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

    /* ------------------------------ 包事实行（T2 署名 + 纪要「多剧本编号上树」） ------------------------------ */

    /**
     * 包展开时的一行事实摘要：目标角色 · 剧本号 · 原作者 · 更新 · 授权形态。
     *
     * 只在**展开态**出现（口上树默认简洁的既定约束），且**给证据不给结论**：
     * 悬停可看到署名抽自哪个文件哪一行 —— 授权条款一律不替作者下判断（见 attribution.ts 头注）。
     * 角色与剧本取自制品 meta（P-C 新建时写入）；导入的包没有这两项，如实不显示。
     */
    const renderFacts = (artifact: WorkspaceArtifact, dir: string): ReactNode => {
      const st = deps.attribution(dir);
      const at = indent(1);
      const meta = factsFromMeta(artifact.meta);
      /** 角色/剧本来自本地 meta，署名要读盘——异步那段先摆已知的，不因等待而整行空着 */
      const line = (attr: PackageAttribution | null, suffix?: string): string =>
        [...packageFacts({ ...meta, attribution: attr }), ...(suffix ? [suffix] : [])].join(' · ');

      if (st === undefined) {
        const s = line(null);
        return s.length > 0 ? h('div', { className: 'kp-facts', style: at }, s) : null;
      }
      if (st === 'loading') {
        return h('div', { className: 'kp-facts dim', style: at }, line(null, '读取署名…'));
      }
      if (st === null) {
        return h(
          'div',
          { className: 'kp-facts dim', style: at },
          line(null, '署名读取失败（不影响编辑与部署）'),
        );
      }
      const tips: string[] = [];
      if (st.author) tips.push(`作者原文：${st.author.file} 第 ${st.author.line} 行`);
      if (st.updated) tips.push(`更新原文：${st.updated.file} 第 ${st.updated.line} 行`);
      if (st.readmeFiles.length > 0) tips.push(`可查文件：${st.readmeFiles.join('、')}`);
      return h('div', { className: 'kp-facts', style: at, title: tips.join('\n') }, line(st));
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
              'div',
              { className: 'kp-artifact-row' },
              h(
                'button',
                {
                  className: 'kp-artifact-btn',
                  style: indent(1),
                  title: `${dir}（点击展开真实文件夹）`,
                  onClick: () => {
                    deps.ensureAttribution(dir);
                    toggleDir(dir);
                  },
                },
                h('span', { className: 'caret' }, isOpen ? '▾' : '▸'),
                h('span', { className: 'kp-artifact-name' }, a.name),
                a.name !== a.dirName ? h('span', { className: 'kp-dirname dim' }, a.dirName) : null,
              ),
              // 行内动作：静息态隐去（悬停 / 键盘聚焦才显），保持口上树清爽
              h(
                'span',
                { className: 'kp-row-actions' },
                h(
                  'button',
                  {
                    className: 'kp-action',
                    title: `把「${a.name}」打包成 ZIP（.kojo 自动转译为 .ERB）到选定位置，工作区原件不动`,
                    onClick: () => deps.exportArtifact(dir, a.name),
                  },
                  '导出',
                ),
                h(
                  'button',
                  {
                    className: 'kp-action',
                    title: `把「${a.name}」转译后部署到游戏目录的角色口上目录下（.kojo → .ERB；目标已存在不覆盖）`,
                    onClick: () => deps.deployArtifact(a, dir),
                  },
                  '部署',
                ),
              ),
            ),
            isOpen ? renderFacts(a, dir) : null,
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
      h(
        'span',
        { className: 'kp-toolbar-actions' },
        deps.openNewWizard
          ? h(
              'button',
              { className: 'ghost small', title: '新建口上项目', onClick: () => deps.openNewWizard!() },
              '＋ 新建',
            )
          : null,
        h('button', { className: 'ghost small', title: '刷新项目列表', onClick: () => deps.refresh() }, '⟳'),
      ),
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

    // 包操作反馈条（底部状态栏位；无消息则不渲染，不占版面）
    const status = deps.status();
    const statusBar = status
      ? h(
          'div',
          { className: `kp-status ${status.kind}`, role: 'status' },
          h('span', { className: 'kp-status-text', title: status.text }, status.text),
          status.kind === 'busy'
            ? null
            : h(
                'button',
                { className: 'kp-status-close', title: '关闭', onClick: () => deps.dismissStatus() },
                '×',
              ),
        )
      : null;

    return h('div', { className: 'panel-kojo-projects' }, notice, toolbar, body, statusBar);
  };
}
