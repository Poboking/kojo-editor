/**
 * 「新建口上文件」的落盘编排（2026-10-13 用户反馈 3）。
 *
 * 反馈原文要的是**没有口上项目时的那条路**：弹窗问是否新建 → 是则跳新建项目向导、
 * 建好后把口上文件写到项目位置；否则自选文件夹建单个 `.kojo`。顺着这条反馈，
 * 常态落点也从**游戏目录的角色口上目录**改成了**口上项目里的作者包**：
 * 「工作区为权威 · 游戏目录仅部署目标」是面板顶部常驻的口径，而 Ctrl+N 却把新文件
 * 直接写进游戏目录（还要先批准游戏目录写权限）——同一屏上两条相反的规矩。
 * 现在向导只有工作区这一个落点，`写权限未批准` 那类死路随之消失；
 * 要进游戏目录，走「部署」（`.kojo → .ERB` 自动转译）。
 *
 * 三条写路径，全部不覆盖既有文件：
 * 1. 工作区落点（常态）：`io.writeText`——工作区根是常驻可写根，无需授权动作；
 * 2. 另存到自选文件夹（反馈 3 a2）：`io.exportFile`——**对话框即授权**，
 *    落点由用户在系统对话框里选定，JS 拿不到决定权（白名单外唯一合法通道）；
 * 3. 交给新建项目向导后自动落盘（反馈 3 a1）：见下。
 *
 * ## 关联号（requestToken）为什么必须存在
 *
 * 分支 3 是跨插件的两拍：本插件把作者正在填的那份内容存进闭包（`pending`），
 * 请 `eratw-adapter` 的新建项目向导开门；向导建完项目广播 `workspace.projectCreated`，
 * 本模块收到才落盘。若只看「有没有建项目」就落盘，作者**取消**向导后改天从面板
 * 正常新建一个项目时，会在那个新项目里凭空冒出一个他从来没要过的文件——
 * 工具替作者做决定，还是在他没按任何按钮的时候做。
 * 故请求带一个关联号，兑现只认同号的那次创建（配对关系由 adapter 侧的
 * 「向导一关就清号」保证，见 `eratw-adapter/src/plugin.ts`）。
 * 关联号是**配对用的**，不是凭据：它换不来任何写权限（写盘仍过内核双闸）。
 *
 * 逻辑住在这里而不是向导组件里：与 `package-actions.ts` 同款理由——
 * 「挂起 → 等另一个插件 → 落盘 → 失败要把作者请回来」这一串时序，
 * 不渲染面板也该能单测。
 */

import type {
  FileIO,
  Logger,
  WorkspaceArtifact,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';

/** 一份待落盘的口上文件（文件名由 declare 模板 + 角色号 + 家族段推导，见向导） */
export interface KojoFileDraft {
  /** 落盘文件名（含扩展名） */
  fileName: string;
  /** 文件正文（糖骨架，`;` 注释 + `角色:` 头） */
  text: string;
}

/** 落盘结果；`cancelled` = 作者在对话框里反悔，不是失败，不该按错误呈现 */
export type WriteOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: string; cancelled?: boolean };

/** 工作区项目列表的读取态（向导据此在「有项目 / 没项目 / 读失败」间分岔） */
export interface WorkspaceState {
  loading: boolean;
  error: string | null;
  projects: readonly WorkspaceProject[];
}

export interface NewFileFlowDeps {
  io: FileIO;
  workspaces: WorkspaceService;
  log: Logger;
  /** 打开并定位到新文件（宿主消费） */
  reveal(path: string): void;
  /** 请 `eratw-adapter` 打开「新建口上项目」向导，并把关联号交给它 */
  openProjectWizard(token: string): void;
  /** 重新打开「新建口上文件」向导（自动落盘失败时把作者请回现场） */
  reopenWizard(): void;
}

export interface NewFileFlow {
  /** 订阅工作区状态变化；返回取消订阅 */
  subscribe(cb: () => void): () => void;
  state(): WorkspaceState;
  /** 重新列举工作区项目（向导每次打开都重拉——列表就在应用数据目录，很便宜） */
  reload(): void;
  /** 落点目录 = 项目目录 + 包目录名；无包 / 目录名不合法 → null（不猜） */
  landingDir(projectId: string, artifact: WorkspaceArtifact | null): string | null;
  /** 一次性提示（自动落盘失败的原因；读过即清） */
  takeNotice(): string | null;
  /** 把手上这份内容交给新建项目向导（反馈 3 a1 的第一拍） */
  handoffToNewProject(draft: KojoFileDraft): void;
  /** `workspace.projectCreated` 消费者（反馈 3 a1 的第二拍） */
  onProjectCreated(projectId: string, requestToken?: string): Promise<void>;
  /** 写进工作区落点（常态路径） */
  createIn(absDir: string, draft: KojoFileDraft): Promise<WriteOutcome>;
  /** 另存到用户选定的位置（反馈 3 a2；对话框即授权） */
  saveToPickedFolder(draft: KojoFileDraft): Promise<WriteOutcome>;
  dispose(): void;
}

/** 单层目录段（落点/文件名共用）：空串、点段、含分隔符一律不成 */
function isSingleSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/**
 * 默认落点包：项目里**最近创建**的那个（无包 → null）。
 *
 * 选最新而不是第一个，是因为作者的下一步几乎总在刚建好的那个包里继续写；
 * 老包排在前面的话，每次都要多点一下才能回到手头的活。
 */
export function latestArtifact(project: WorkspaceProject | null | undefined): WorkspaceArtifact | null {
  if (!project || project.artifacts.length === 0) return null;
  return [...project.artifacts].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** 落盘编排工厂（闭包状态：项目列表读取态 + 挂起意图 + 一次性提示） */
export function createNewFileFlow(deps: NewFileFlowDeps): NewFileFlow {
  let projects: readonly WorkspaceProject[] = [];
  let loading = false;
  let error: string | null = null;
  const listeners = new Set<() => void>();
  /** 交给新建项目向导、等它建完再落的那份（null = 没人在等） */
  let pending: { requestToken: string; draft: KojoFileDraft } | null = null;
  let notice: string | null = null;
  let seq = 0;

  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        deps.log.warn(`新建口上文件监听器抛错：${String(err)}`);
      }
    }
  };

  const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** 写进指定目录（覆盖保护 + 闸门前取自证）；两条路径共用一个口径 */
  const writeInto = async (absDir: string, draft: KojoFileDraft): Promise<WriteOutcome> => {
    if (!isSingleSegment(draft.fileName)) {
      return { ok: false, reason: `文件名不是单层文件名：${draft.fileName}` };
    }
    const target = join(absDir, draft.fileName);
    if (await deps.io.exists(target)) {
      return { ok: false, reason: `已有同名文件，未覆盖：${draft.fileName}` };
    }
    try {
      await deps.io.writeText(target, draft.text);
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
    return { ok: true, path: target };
  };

  /** 落点目录 = 项目目录 + 包目录名（组件与自动落盘共用；不猜、不合不成） */
  const landingDirOf = (projectId: string, artifact: WorkspaceArtifact | null): string | null => {
    if (!artifact || !isSingleSegment(artifact.dirName)) return null;
    return join(deps.workspaces.projectDir(projectId), artifact.dirName);
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    state: () => ({ loading, error, projects }),

    reload() {
      loading = true;
      error = null;
      notify();
      deps.workspaces
        .list()
        .then((list) => {
          projects = list;
          loading = false;
          notify();
        })
        .catch((err: unknown) => {
          error = reasonOf(err);
          loading = false;
          deps.log.warn(`工作区项目列表加载失败：${error}`);
          notify();
        });
    },

    landingDir: landingDirOf,

    takeNotice() {
      const out = notice;
      notice = null;
      return out;
    },

    handoffToNewProject(draft) {
      seq += 1;
      const requestToken = `kojo-${Date.now().toString(36)}-${seq}`;
      pending = { requestToken, draft };
      deps.openProjectWizard(requestToken);
    },

    async onProjectCreated(projectId, requestToken) {
      const held = pending;
      if (held === null) return;
      // 号不对 = 这次创建不是我们引出来的（多半是作者取消了那次请求，之后从面板
      // 正常新建）。挂起的那份就此作废——宁可丢掉，也不在别的项目里造文件。
      if (requestToken !== held.requestToken) {
        pending = null;
        return;
      }
      pending = null;
      try {
        const project = await deps.workspaces.get(projectId);
        const dir = landingDirOf(projectId, latestArtifact(project));
        if (dir === null) throw new Error('新项目里还没有作者包');
        const outcome = await writeInto(dir, held.draft);
        if (!outcome.ok) throw new Error(outcome.reason);
        deps.reveal(outcome.path);
      } catch (err) {
        const reason = reasonOf(err);
        deps.log.warn(`新建项目后自动创建口上文件失败：${reason}`);
        notice = `口上项目已建好，但「${held.draft.fileName}」没能自动创建：${reason}`;
        deps.reopenWizard();
      }
    },

    async createIn(absDir, draft) {
      // 工作区根恒可写；走到"不可写"只有两种可能：项目被挪进了游戏目录，
      // 或程序算错了落点。两种都不能默默写下去（写保护铁律不靠调用方自觉）。
      if (!deps.io.isWritable(absDir)) {
        return { ok: false, reason: `落点不在可写范围内：${absDir}` };
      }
      return writeInto(absDir, draft);
    },

    async saveToPickedFolder(draft) {
      if (!isSingleSegment(draft.fileName)) {
        return { ok: false, reason: `文件名不是单层文件名：${draft.fileName}` };
      }
      try {
        // 与工作区里的 `.kojo` 同口径：UTF-8 BOM + LF（io 新建文件的默认形态）。
        // 另存只是换地方放同一份源，不该在编码上另立一套。
        const bytes = new TextEncoder().encode(`\uFEFF${draft.text}`);
        const target = await deps.io.exportFile(draft.fileName, bytes, {
          title: `新建口上文件「${draft.fileName}」到…`,
        });
        if (target === null) return { ok: false, reason: '未选择保存位置。', cancelled: true };
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },

    dispose() {
      listeners.clear();
      pending = null;
      notice = null;
    },
  };
}
