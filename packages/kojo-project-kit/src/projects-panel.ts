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
 *
 * E9 起：教程区与树体之间是可拖拽分割线（`.kp-splitter`），拖拽调整教程区高度。
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirEntry, UIPanelProps, WorkspaceArtifact, WorkspaceProject } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { attributionSummary, type AttributionState, type PackageAttribution } from '@kojo/kojo-project-kit';
import type { PanelStatus } from './package-actions';
import { NEW_ITEM_MENU, newItemPreviewName, type NewItemKind } from '@kojo/kojo-project-kit';
import type { TutorialId } from './tutorial';

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
  /**
   * 打开「导入口上项目」向导（用户反馈批）：系统目录对话框选定文件夹 → 走**既有**
   * 的 `workspace.importRequested` 通道，导入向导自动开门。与命令面板
   * `kojo.importKojoProject` 同一具身体（`plugin.ts` 的 `pickAndRequestImport`），
   * 只有来源标记不同。缺省 → 按钮不显示（与 `openNewWizard` 同款克制口径：
   * 没有能力的入口不灰着占位）。
   */
  openImportWizard?(): void;
  /**
   * 打开内置教程（E6）。**可选**：没有教程内容的游戏不传，面板底部的教程区
   * 整块不渲染（不灰着占位——没有的能力不装样子）。
   */
  openTutorial?(which: TutorialId): void;
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
  /**
   * 在工作区某目录下新建文件 / 文件夹（反馈 1b）。
   * 成功返回绝对路径（面板据此打开它）；失败返回中文原因，**原样呈现**给作者。
   */
  createItem(
    absDir: string,
    rawName: string,
    kind: NewItemKind,
  ): Promise<{ ok: true; path: string; displayName: string } | { ok: false; reason: string }>;
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

/**
 * 项目根下「不属于任何包」的子目录（2026-10-13 UI 反馈 6）。
 *
 * 项目行原本只列 `workspace.json` 里登记的包，于是作者用右键「新建文件夹」建的平级目录
 * **从来不上树**——盘上真有、界面上没有，读起来仍然像"点了没生效"。这里把这类目录挑出来，
 * 由项目行下面单独列一行区。
 *
 * 三条口径：① 未触发列举 / 在途 / 读失败 ⇒ 空（不猜，也不留半张列表）；
 * ② **只挑目录**——根上的散装文件（`workspace.json`、作者手放的备忘）不进这棵树，
 *    新建文件本身会走 `reveal` 在编辑器里打开，那里才是看得见它的地方；
 * ③ 与任一包目录同名的目录**不列**：那是包本体，重复列会出现两行指向同一个目录。
 */
export function looseProjectDirs(
  state: DirListState | undefined,
  artifactDirNames: readonly string[],
): DirEntry[] {
  if (!Array.isArray(state)) return [];
  const owned = new Set(artifactDirNames);
  return sortDirEntries(state.filter((e) => e.isDirectory && !owned.has(e.name)));
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

/** 教程区高度下限：兜住内容（「教程」题头 + 两个入口按钮），拖到再近也看得全 */
export const TUTORIALS_MIN_H = 80;
/** 分割线上限给树体留的可视高度（提示条 / 工具条 / 状态条等固定件都算在里面） */
const TREE_VIEW_RESERVE = 200;

/**
 * 教程区高度钳制（纯函数，单测钉住）：下限兜住内容，上限 = 面板可视高度 - 树体保留。
 * panelHeight 未知（≤0，如无 DOM 环境）时钳到下限——宁可不拖，也不把两区都挤没。
 */
export function clampTutorialHeight(height: number, panelHeight: number): number {
  const max = Math.max(TUTORIALS_MIN_H, panelHeight - TREE_VIEW_RESERVE);
  return Math.min(max, Math.max(TUTORIALS_MIN_H, height));
}

/** 行缩进（层级 → padding-left；树深度不定，内联最直观） */
function indent(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${4 + depth * 14}px` };
}

/**
 * 面板组件工厂（createElement 风格，与本插件既有面板一致；不引 JSX）。
 * 数据与缓存全在 deps（插件闭包），组件只持有**呈现态**（展开/折叠集合）。
 * 组件收到宿主注入的 `UIPanelProps`（图标桥经此进来，见 `ic`）。
 */
export function createKojoProjectsPanel(
  deps: KojoProjectsPanelDeps,
): (props: UIPanelProps) => unknown {
  return function KojoProjectsPanel(props: UIPanelProps): unknown {
    const [, force] = useState(0);
    /** 折叠的项目（缺省全展开——项目行下包标题行可见即「简洁平铺」形态） */
    const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
    /** 展开的包/子目录（绝对路径；缺省空 = 包折叠，不列举文件） */
    const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
    const openDirsRef = useRef(openDirs);
    openDirsRef.current = openDirs;

    /**
     * 图标桥（E6 图标统一）：宿主经 props.renderIcon 注入图标注册表；缺省（旧宿主 /
     * 单测里的直接调用）一律回退纯文本字形——图标是锦上添花，缺省时绝不能画成空白。
     */
    const ic = (name: string, size: number, fallback: string): ReactNode =>
      (props.renderIcon?.(name, size) as ReactNode | undefined) ?? fallback;

    useEffect(
      () =>
        deps.subscribe(() => {
          // 缓存失效（导入/部署等变更后）→ 重列展开中的目录（已缓存则 no-op，收敛）
          for (const d of openDirsRef.current) deps.ensureDir(d);
          force((n) => n + 1);
        }),
      [deps],
    );

    /**
     * 展开的项目要把**项目根本身**也列一次（2026-10-13 UI 反馈 6）。
     * 不列就拿不到"包之外的目录"这张清单，作者新建的平级文件夹因此没有落脚点。
     * `ensureDir` 命中缓存即 no-op，所以这里重复调用不会刮出目录请求风暴。
     */
    useEffect(() => {
      for (const p of deps.projects()) {
        if (!closedProjects.has(p.id)) deps.ensureDir(deps.projectDir(p.id));
      }
    }, [deps, closedProjects]);

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

    /* ---------------------- 右键新建（反馈 1b） ---------------------- */

    /** 右键菜单（固定定位；dir = 要往哪儿建） */
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; dir: string } | null>(null);
    /** 行内命名输入（VSCode 式：不用 window.prompt——WebView2 里它可能直接返回 null） */
    const [draft, setDraft] = useState<{ dir: string; kind: NewItemKind } | null>(null);
    const [draftValue, setDraftValue] = useState('');
    const [draftError, setDraftError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    // 出现行内输入框就抢焦点（作者点完菜单的手已经在那儿了，不该再点一次）。
    // `focus` 走结构化声明而不是 HTMLInputElement：本仓插件的 tsconfig **刻意不含 DOM lib**
    // （全仓插件正文零 `document`/`window`，见 tsconfig `lib: ["ES2022"]`），
    // 事件与元素一律按"用到的那几个字段"声明，与 new-project-wizard 的 onChange 同源。
    const draftInputRef = useRef<{ focus(): void } | null>(null);
    useEffect(() => {
      draftInputRef.current?.focus();
    }, [draft]);

    /** 右键事件的最小形状（React 合成事件满足它） */
    type PointerEvent = {
      clientX: number;
      clientY: number;
      preventDefault(): void;
      stopPropagation(): void;
      /** React 合成事件的 view 就是 Window——用它拿视口宽，不必引 `window` */
      view?: { innerWidth: number };
    };

    /** 菜单宽与壳层 `.context-menu` 的 min-width 对齐；靠右边时往左挪，别溢出视口 */
    const MENU_WIDTH = 250;

    const openCtxMenu = (e: PointerEvent, dir: string): void => {
      e.preventDefault();
      e.stopPropagation();
      const vw = e.view?.innerWidth ?? Number.MAX_SAFE_INTEGER;
      setCtxMenu({ x: Math.min(e.clientX, vw - MENU_WIDTH), y: e.clientY, dir });
    };

    /** 从菜单选中某类型 → 收起菜单、展开目标目录、落下一个待命名的行内输入 */
    const startDraft = (dir: string, kind: NewItemKind): void => {
      setCtxMenu(null);
      if (!openDirs.has(dir)) deps.ensureDir(dir);
      setOpenDirs((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      setDraft({ dir, kind });
      setDraftValue('');
      setDraftError(null);
    };

    const commitDraft = async (): Promise<void> => {
      if (!draft || creating) return;
      setCreating(true);
      setDraftError(null);
      const r = await deps.createItem(draft.dir, draftValue, draft.kind);
      setCreating(false);
      if (!r.ok) {
        // 名字留着让他改，不清空——清掉等于让他重打一遍
        setDraftError(r.reason);
        return;
      }
      const wasFile = draft.kind !== 'folder';
      setDraft(null);
      setDraftValue('');
      // 新建的是文件就直接打开：作者的下一步十有八九是写内容
      if (wasFile) deps.reveal(r.path);
    };

    /** 目标目录下的行内输入框（渲染在该目录内容的最前面） */
    const draftRow = (dir: string, depth: number): ReactNode => {
      if (!draft || draft.dir !== dir) return null;
      const preview = newItemPreviewName(draftValue, draft.kind);
      return h(
        'div',
        { key: `${dir}::draft`, className: 'kp-draft', style: indent(depth) },
        h('input', {
          ref: draftInputRef,
          className: 'kp-draft-input',
          value: draftValue,
          placeholder: draft.kind === 'folder' ? '文件夹名' : '文件名',
          disabled: creating,
          onChange: (e: { target: { value: string } }) => {
            setDraftValue(e.target.value);
            setDraftError(null);
          },
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Enter') void commitDraft();
            else if (e.key === 'Escape') {
              setDraft(null);
              setDraftValue('');
              setDraftError(null);
            }
          },
        }),
        preview ? h('span', { className: 'kp-draft-preview dim' }, `→ ${preview}`) : null,
        draftError
          ? h('span', { className: 'kp-draft-err', title: draftError }, draftError)
          : h('span', { className: 'kp-draft-hint dim' }, 'Enter 创建 · Esc 取消'),
      );
    };

    /* ------------------------------ 目录内容（递归） ------------------------------ */

    /**
     * 目录内容（递归）。
     *
     * 行内新建框**永远排在最前，且不受目录状态影响**：空目录 / 正在读 / 读失败的目录
     * 同样要能建东西——"在空包里建第一个文件"恰恰是最常见的起手式，
     * 若把它绑在"有内容才渲染"上，这条路就断了。
     */
    const renderDir = (dir: string, depth: number): ReactNode => {
      const state = deps.dirState(dir);
      // 有待命名的目录若还没开始列举（例如右键了折叠的包行），顺手发起列举
      if (draft && draft.dir === dir && state === undefined) deps.ensureDir(dir);

      const note = (cls: string, text: string, title?: string): ReactNode =>
        h('div', { key: `${dir}::note`, className: `kp-note ${cls}`, style: indent(depth), title }, text);

      let body: ReactNode;
      if (state === undefined || state === 'loading') {
        body = note('dim', '读取目录…');
      } else if (!Array.isArray(state)) {
        body = note('err', '目录读取失败（悬停查看原因）', state.error);
      } else if (state.length === 0) {
        body = note('dim', '（空目录）');
      } else {
        body = h(
          'div',
          { key: `${dir}::files`, className: 'kp-dir' },
          ...sortDirEntries(state).map((e) => renderEntry(e, depth)),
        );
      }
      return h('div', { key: `${dir}::wrap` }, draftRow(dir, depth), body);
    };

    /**
     * 一条真实目录 / 文件行。包的展开态与项目根「包之外的目录」共用这一个渲染源，
     * 免得两处各自演化出不同的可点性（目录可展开 + 可右键继续往里建；文件点开=进编辑器）。
     */
    function renderEntry(e: DirEntry, depth: number): ReactNode {
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
              onContextMenu: (ev: PointerEvent) => openCtxMenu(ev, e.path),
            },
            h('span', { className: 'caret' }, dOpen ? ic('chevron-down', 12, '▾') : ic('chevron-right', 12, '▸')),
            // 名称行被 CSS 省略号截断时，title 让悬停能读回全名（行上的 title 是路径，不含这层语义）
            h('span', { className: 'kp-dir-name', title: e.name }, e.name),
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
        h('span', { className: 'kp-file-name', title: e.name }, e.name),
      );
    }

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
          // 多剧本编号上树（纪要 §5「多剧本（≤10）编号在 UI 中显式表达」）：
          // 编号住在制品 meta，**行上**就给一枚徽章——口上树默认折叠，
          // 只写在展开事实行里等于默认看不见，多剧本作品（同名不同剧本）分不开。
          const scriptNo = factsFromMeta(a.meta).scriptNo;
          return h(
            'div',
            { key: a.id, className: 'kp-artifact' },
            h(
              'div',
              {
                className: 'kp-artifact-row',
                // 右键整行 = 往这个包的目录里建（作者说"右键根节点"，对他而言"根"就是
                // 他这个包；项目行同样给菜单，用于在包与包之间加平级文件夹）
                onContextMenu: (ev: PointerEvent) => openCtxMenu(ev, dir),
              },
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
                h('span', { className: 'caret' }, isOpen ? ic('chevron-down', 12, '▾') : ic('chevron-right', 12, '▸')),
                // 名称可能被 CSS 省略号截断：title 给完整显示名（行按钮的 title 是目录路径，两者互补）
                h('span', { className: 'kp-artifact-name', title: a.name }, a.name),
                scriptNo !== null
                  ? h(
                      'span',
                      { className: 'kp-script-badge', title: `目标剧本 ${scriptNo}（多剧本作品按剧本号分开；来自制品 meta）` },
                      `剧本${scriptNo}`,
                    )
                  : null,
                a.name !== a.dirName ? h('span', { className: 'kp-dirname dim', title: a.dirName }, a.dirName) : null,
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

    /**
     * 项目行下面列「包之外的目录」（2026-10-13 UI 反馈 6 的后半条）。
     *
     * 前半条是行内命名框没有槽位（点了菜单界面无变化）；后半条是**即使建成功了也看不见**：
     * 包行只渲染 `workspace.json` 里登记的包，作者建在包与包之间的平级目录因此从来不上树，
     * 盘上有、面上无，读起来仍然像"点了没生效"。
     *
     * 只在没有东西可列时整块不渲染（口上树的简洁约束）；有一行就给它一句说明，
     * 免得作者把 `素材` 这类目录误读成"冒出了第二个包"。
     */
    const renderLooseDirs = (p: WorkspaceProject, pDir: string): ReactNode => {
      const loose = looseProjectDirs(deps.dirState(pDir), p.artifacts.map((a) => a.dirName));
      if (loose.length === 0) return null;
      return h(
        'div',
        { key: `${pDir}::loose`, className: 'kp-loose' },
        h(
          'div',
          {
            className: 'kp-note dim',
            style: indent(1),
            title: '这些目录不属于任何作者包（右键项目行新建的平级文件夹住在这里）',
          },
          `包之外的目录 ${loose.length} 个`,
        ),
        ...loose.map((e) => renderEntry(e, 1)),
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
              ic('add', 12, '＋'),
              ' 新建',
            )
          : null,
        // 导入 = 复用命令面板那条 `kojo.importKojoProject`（选目录 → 既有导入向导），
        // 不是第二套机制；缺省 dep 就整颗不画（没有能力的入口不灰着占位）。
        deps.openImportWizard
          ? h(
              'button',
              {
                className: 'ghost small',
                title: '从文件夹导入既有的口上项目（选定作者包目录后打开导入向导）',
                onClick: () => deps.openImportWizard!(),
              },
              ic('module', 12, '▣'),
              ' 导入项目',
            )
          : null,
        h('button', { className: 'ghost small', title: '刷新项目列表', onClick: () => deps.refresh() }, ic('refresh', 13, '⟳')),
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
          : h('div', { className: 'kp-empty dim' }, '可在此新建作品，或用工具条的「导入项目」把既有作者包接进来'),
      );
    } else {
      body = h(
        'div',
        { className: 'kp-body' },
        ...projects.map((p) => {
          const pOpen = !closedProjects.has(p.id);
          const pDir = deps.projectDir(p.id);
          return h(
            'div',
            { key: p.id, className: 'kp-project' },
            h(
              'button',
              {
                className: 'kp-project-btn',
                title: `项目：${p.name}`,
                onClick: () => toggleProject(p.id),
                onContextMenu: (ev: PointerEvent) => openCtxMenu(ev, pDir),
              },
              h('span', { className: 'caret' }, pOpen ? ic('chevron-down', 12, '▾') : ic('chevron-right', 12, '▸')),
              h('span', { className: 'kp-project-name', title: p.name }, p.name),
              h('span', { className: 'kp-count dim' }, `${p.artifacts.length} 包`),
            ),
            /* 项目根自己的行内新建框（UI 反馈 6 的缺陷点）：菜单把草稿指向 projectDir，
               但 draftRow 原先只在 renderDir 里产出，而 renderDir 只跑「包目录」与「包内子目录」
               ——项目根从来没有槽位，于是"新建文件夹"点下去只是把 draft 写进 state，界面上什么都没有。
               放在项目行正下方、且**不受 pOpen 影响**：收起的项目同样要能建东西（与 renderDir 同口径）。 */
            draftRow(pDir, 1),
            pOpen ? renderArtifacts(p) : null,
            /* 包与包之间的平级目录（反馈 6 的后半条）：建成功了必须在界面上看得见，
               否则"点了没生效"只解决了一半——盘上有了，面上没有。没有这类目录时整块不渲染。 */
            pOpen ? renderLooseDirs(p, pDir) : null,
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
                ic('close', 12, '×'),
              ),
        )
      : null;

    // 右键菜单：复用壳层同款 `.context-menu`（fixed + token + pop-in），
    // 不在插件里另立一套菜单样式——同一个应用里两套上下文菜单是最典型的"看着像两个系统"。
    const menu = ctxMenu
      ? h(
          'div',
          {},
          h('div', {
            className: 'context-menu-backdrop',
            onMouseDown: () => setCtxMenu(null),
            onContextMenu: (ev: PointerEvent) => ev.preventDefault(),
          }),
          h(
            'div',
            { className: 'context-menu', style: { left: ctxMenu.x, top: ctxMenu.y }, role: 'menu' },
            ...NEW_ITEM_MENU.map((m) =>
              h(
                'button',
                {
                  key: m.kind,
                  role: 'menuitem',
                  title: m.hint,
                  onClick: () => startDraft(ctxMenu!.dir, m.kind),
                },
                h(
                  'span',
                  { className: 'check' },
                  draft && draft.dir === ctxMenu.dir && draft.kind === m.kind ? ic('check', 12, '●') : '',
                ),
                m.label,
              ),
            ),
          ),
        )
      : null;

    /* ------------------------------ 教程区高度（E9 分割线拖拽） ------------------------------ */

    /** 教程区高度（px；null = 内容自然高度）。会话级，与壳层分栏权重同口径不持久化 */
    const [tutH, setTutH] = useState<number | null>(null);
    /** 分割线拖拽中（仅用于高亮） */
    const [splitDragging, setSplitDragging] = useState(false);
    const rootRef = useRef<{ clientHeight: number } | null>(null);
    const tutRef = useRef<{ clientHeight: number } | null>(null);
    const dragSeed = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);

    /** 分割线指针事件的最小形状（React 合成事件满足它；插件 tsconfig 无 DOM lib） */
    type SplitterPointer = {
      pointerId: number;
      clientY: number;
      preventDefault(): void;
      currentTarget: { setPointerCapture(pointerId: number): void };
    };

    const onSplitDown = (e: SplitterPointer): void => {
      e.preventDefault();
      dragSeed.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        // 首次拖拽从"当前真实高度"起步（未拖过时 = 内容自然高度），不跳变
        startH: tutH ?? tutRef.current?.clientHeight ?? TUTORIALS_MIN_H,
      };
      setSplitDragging(true);
      // 指针捕获：拖快了指头滑出 10px 命中区也不丢事件
      e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onSplitMove = (e: SplitterPointer): void => {
      const seed = dragSeed.current;
      if (!seed || seed.pointerId !== e.pointerId) return;
      const dy = seed.startY - e.clientY; // 向上拖 = 教程区变高
      setTutH(clampTutorialHeight(seed.startH + dy, rootRef.current?.clientHeight ?? 0));
    };

    const onSplitEnd = (e: { pointerId: number }): void => {
      if (dragSeed.current?.pointerId !== e.pointerId) return;
      dragSeed.current = null;
      setSplitDragging(false);
    };

    /**
     * 树体 ←→ 教程区的分割线（E9）：拖拽调整教程区高度。静息一条细线，悬停 / 拖拽中亮起
     * （视觉语言与壳层 .resizer 同族）；键盘不接——与壳层分栏把手同口径。
     */
    const splitter = h('div', {
      className: `kp-splitter${splitDragging ? ' dragging' : ''}`,
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': '拖动调整教程区高度',
      title: '拖动调整教程区高度',
      onPointerDown: onSplitDown,
      onPointerMove: onSplitMove,
      onPointerUp: onSplitEnd,
      onPointerCancel: onSplitEnd,
    });

    /**
     * 教程入口（E6）：常驻面板底部（body 之后、状态条之前），不随树滚动——
     * 写不下去时抬头就能找到，不藏在菜单里。行按钮与树行同族（度量 / hover /
     * focus-visible 复用 styles.css 的行按钮组）。
     */
    // 取到局部常量：`deps.openTutorial` 在箭头函数里的收窄不可靠
    const openTutorial = deps.openTutorial;
    const tutorials = openTutorial === undefined ? null : h(
      'div',
      {
        className: 'kp-tutorials',
        ref: tutRef,
        style: tutH === null ? undefined : { height: tutH },
      },
      h('div', { className: 'kp-tutorials-title dim' }, '教程'),
      h(
        'button',
        {
          className: 'kp-tutorial-btn',
          title: '.kojo 语言的每一种写法，以及它编译成的 ERB（每种写法都有一条对照样例）',
          onClick: () => openTutorial('sugar'),
        },
        ic('wand', 14, '✦'),
        h('span', { className: 'kp-tutorial-name' }, '.kojo 语言教程'),
      ),
      h(
        'button',
        {
          className: 'kp-tutorial-btn',
          title: '口上从选游戏目录到部署进游戏的全流程（含导出、许可与常见故障查法）',
          onClick: () => openTutorial('kojo'),
        },
        ic('book', 14, '▤'),
        h('span', { className: 'kp-tutorial-name' }, '口上教程'),
      ),
      h(
        'button',
        {
          className: 'kp-tutorial-btn',
          title: '现行全部写法的对照表：每种写法编译成什么、哪些值不填、写错时的提示原文（两份教程的附录）',
          onClick: () => openTutorial('reference'),
        },
        ic('structure', 14, '▦'),
        h('span', { className: 'kp-tutorial-name' }, 'kojo 语法全表'),
      ),
    );

    return h('div', { className: 'panel-kojo-projects', ref: rootRef }, notice, toolbar, body, splitter, tutorials, statusBar, menu);
  };
}
