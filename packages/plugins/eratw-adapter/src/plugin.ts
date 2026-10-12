import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  Plugin,
  ProjectService,
  SugarTranspileService,
  VariableSchema,
  WorkspaceArtifact,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, combineDigests, foldDigest, join } from '@kojo/plugin-api';
import { ERATW } from './constants';
import { parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from './chara-csv';
import { clearKojoFamilyMemo, createEratwFamilyIndex } from './family-index';
import { createEratwConventions } from './conventions';
import { loadEratwVariableSchema } from './variable-schema';
import { loadEratwCallProtocol, type EratwCallProtocol } from './call-protocol';
import { createEratwFaceTable } from './face-templates';
import { createKojoProjectsPanel, type DirListState } from './kojo-projects-panel';
import { readPackageAttribution, type AttributionState as AttrState } from './attribution';
import { createPackageActions } from './package-actions';
import { resolveNewItemPath, type NewItemKind } from './new-item';
import type { KojoCompiler } from './artifact';
import { NEW_KOJO_PROJECT_OVERLAY_ID, createNewKojoProjectWizard, readRequestToken } from './new-project-wizard';
import { IMPORT_KOJO_OVERLAY_ID, createImportKojoWizard, type PendingImport } from './import-wizard';
import { DEPLOY_KOJO_OVERLAY_ID, createDeployKojoWizard } from './deploy-wizard';
import type { PendingDeploy } from './deploy';

/**
 * eraTW 适配器插件 —— 本项目**唯一**允许知道"eraTW / 口上 / CHARA CSV / sav"这些字眼的地方。
 *
 * 职责（架构文档 §5.1 / §5.7）：
 * - detect：识别 eraTW 工程目录（黑盒，内核只调用不感知）；
 * - loadProject：解析 CHARA CSV 映射、定位口上域与 sav 目录、提议可写路径；
 * - （v0.2+）functionFamilyIndex / variableSchema / conventions / scaffold。
 *
 * 槽位与服务：注册 `game.adapter` 槽位（onboarding 轮询）；
 * 按 ADR-0002 **不** provide 全局 `game.adapter` 服务键（多适配器共存需要）。
 * 口上项目批 P-B 起另贡献 `ui.panel`「我的口上项目」：消费内核通用
 * `kernel.workspaces`（project/artifact 模型），游戏解释只住本包。
 * 该面板是「口上项目」这条工作流的家：新建（P-C 向导）→ 编辑（工作区恒可写）→
 * 导入（P-F，文件树右键经内核意图事件进来）→ 导出（P-D，平台对话框即授权）→
 * 部署（P-E，写进角色口上目录，仍过内核写白名单）。
 */
export function createEratwAdapterPlugin(): Plugin {
  return {
    id: 'eratw-adapter',
    version: '0.2.0',
    requires: ['kernel.io', KernelServices.Workspaces, KernelServices.Project],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');
      const workspaces = ctx.inject<WorkspaceService>(KernelServices.Workspaces);
      const project = ctx.inject<ProjectService>(KernelServices.Project);

      /* ---- 「我的口上项目」面板闭包状态（P-B；后续新建/导入/部署共用同一通知源） ---- */

      let wsProjects: readonly WorkspaceProject[] = [];
      let wsLoading = false;
      let wsError: string | null = null;
      const wsListeners = new Set<() => void>();
      /** 目录列举缓存（按绝对路径惰性加载；变更动作后整体失效，避免陈旧视图） */
      const wsDirCache = new Map<string, DirListState>();
      /** 署名 / 授权缓存（T2；同按绝对路径，null = 读失败已降级为「未标注」） */
      const wsAttrCache = new Map<string, AttrState>();

      const notifyWs = (): void => {
        for (const cb of [...wsListeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`口上项目面板监听器抛错：${String(err)}`);
          }
        }
      };

      const refreshWsProjects = (): void => {
        wsLoading = true;
        wsError = null;
        notifyWs();
        workspaces
          .list()
          .then((list) => {
            wsProjects = list;
            wsLoading = false;
            notifyWs();
          })
          .catch((err: unknown) => {
            wsError = err instanceof Error ? err.message : String(err);
            wsLoading = false;
            ctx.log.warn(`工作区项目列表加载失败：${wsError}`);
            notifyWs();
          });
      };

      const ensureWsDir = (absDir: string): void => {
        if (wsDirCache.has(absDir)) return;
        wsDirCache.set(absDir, 'loading');
        notifyWs();
        void io
          .listDir(absDir)
          .then((entries) => {
            wsDirCache.set(absDir, entries);
            notifyWs();
          })
          .catch((err: unknown) => {
            wsDirCache.set(absDir, { error: err instanceof Error ? err.message : String(err) });
            notifyWs();
          });
      };

      /** 目录缓存整体失效 + 项目列表重拉（新建/导入/部署等变更动作后调用） */
      const invalidateWs = (): void => {
        wsDirCache.clear();
        wsAttrCache.clear();
        refreshWsProjects();
      };

      /** 只重拉一个目录（新建文件后不必把整棵树清掉——那会让面板闪一下） */
      const refreshDir = (absDir: string): void => {
        wsDirCache.delete(absDir);
        ensureWsDir(absDir);
      };

      /* ---- 新建文件 / 文件夹（反馈 1b）：目标恒在工作区内（常驻可写根） ---- */

      /**
       * 建一个条目并返回它的绝对路径（面板据此刷新 + 打开）。
       * 失败返回中文原因，**不抛**——原因要原样出现在面板上，不是进控制台。
       */
      const createItem = async (
        absDir: string,
        rawName: string,
        kind: NewItemKind,
      ): Promise<{ ok: true; path: string; displayName: string } | { ok: false; reason: string }> => {
        const resolved = resolveNewItemPath(absDir, rawName, kind);
        if (!resolved.ok) return resolved;
        if (!io.isWritable(resolved.absPath)) {
          // 工作区根是常驻可写的，走到这里说明路径根本不在工作区里——那是程序 bug，
          // 但也可能是用户把项目目录挪到了游戏目录下面。两种都不能默默写下去。
          return { ok: false, reason: `目标不在可写范围内：${resolved.absPath}` };
        }
        if (await io.exists(resolved.absPath)) {
          return { ok: false, reason: `已存在同名条目，未覆盖：${resolved.displayName}` };
        }
        try {
          if (kind === 'folder') {
            await io.ensureDir(resolved.absPath);
          } else {
            // 建**空文件**：内容留给作者写。工具不替他塞模板正文（与脚手架"不生成活函数"同一口径）。
            await io.writeText(resolved.absPath, '');
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ctx.log.warn(`新建失败（${resolved.absPath}）：${reason}`);
          return { ok: false, reason };
        }
        refreshDir(absDir);
        return { ok: true, path: resolved.absPath, displayName: resolved.displayName };
      };

      /* ---- 署名 / 授权（T2）：按包目录惰性读取并缓存（README 可能 Shift-JIS，走 io 探测） ---- */

      const ensureWsAttribution = (absDir: string): void => {
        if (wsAttrCache.has(absDir)) return;
        wsAttrCache.set(absDir, 'loading');
        void readPackageAttribution({ io, absDir })
          .then((a) => {
            wsAttrCache.set(absDir, a);
            notifyWs();
          })
          .catch((err: unknown) => {
            // 署名读不到不打扰用户（不是操作失败）：静默降级为「未标注」，但日志留痕
            const reason = err instanceof Error ? err.message : String(err);
            ctx.log.debug(`署名抽取失败（${absDir}）：${reason}`);
            wsAttrCache.set(absDir, null);
            notifyWs();
          });
      };

      /* ---- 包操作（P-D 导出；P-E 部署复用同一控制器与底部状态条） ---- */

      /**
       * `.kojo` → 产物字节。**故意延迟到点击时才 `tryInject`**：
       * ① 语法糖插件被停用时，游戏识别/浏览/导出无 `.kojo` 的包都应照常工作——
       *    写成 `requires` 硬依赖会把整个 adapter 一起拖下线；
       * ② adapter 通常早于糖插件激活，activate 当场取会取到 undefined，
       *    放到调用时取，激活顺序就与功能无关了。
       * 取不到时抛中文错误，由 `planArtifacts` 包装成「某个 .kojo 转译失败，未生成制品」——
       * 宁可拒绝，也不把 `.kojo` 原样塞进游戏目录（那是"装了不生效"）。
       */
      const compileKojo: KojoCompiler = (source, label) => {
        const sugar = ctx.tryInject<SugarTranspileService>(WellKnownServices.SugarTranspile);
        if (!sugar) {
          throw new Error(`「${label}」需要语法糖服务（kojo-sugar 插件未启用），无法转成 .ERB`);
        }
        return sugar.compileToBytes(source, undefined, label);
      };

      const actions = createPackageActions({ io, log: ctx.log, notify: notifyWs, compileKojo });
      ctx.onDispose(() => actions.dispose());

      /* ---- 部署请求（P-E）：面板包行「部署」→ 向导确认落点与写权限 ---- */

      /** 待部署请求（overlay 组件无 props，payload 不经组件——读插件闭包） */
      let pendingDeploy: PendingDeploy | null = null;

      const requestDeploy = (artifact: WorkspaceArtifact, absDir: string): void => {
        const metaCharaNo = artifact.meta.charaNo;
        pendingDeploy = {
          absDir,
          dirName: artifact.dirName,
          displayName: artifact.name,
          // 新建向导（P-C）写在制品 meta 里的角色号 → 自动预选；导入的包没有，留给用户挑
          ...(typeof metaCharaNo === 'number' ? { charaNo: metaCharaNo } : {}),
        };
        ctx.bus.emit('ui.overlay.open', { id: DEPLOY_KOJO_OVERLAY_ID, source: 'eratw-adapter' });
      };

      /* ---- 导入请求（P-F）：壳层文件树右键发意图，本插件解释为「导入口上项目」 ---- */

      /** 待导入请求（overlay 组件无 props，payload 不经组件——读插件闭包） */
      let pendingImport: PendingImport | null = null;

      /* ---- 新建项目向导的「谁叫我开的」关联号（反馈 3，2026-10-13） ---- */

      /**
       * 发起方（`ui-sugar-editor` 的落盘引导）经语义事件 `workspace.newProjectRequested`
       * 送来关联号；创建成功时原样带进 `workspace.projectCreated`，由发起方兑现挂起意图。
       *
       * 为什么不是"对方直接 open 我的 overlay id"：那样游戏词会进契约层
       * （`eratw.newKojoProject` 出现在 plugin-api 就是审计 A 项的一枚红），
       * 而且发起方从此绑死了本插件某个模态叫什么。
       *
       * 两条纪律让它不会变成"凭空造文件"的引信：
       * - 面板按钮开门不发意图 → 号保持 null（这次创建与任何请求无关）；
       * - **向导一关就清空** → 被取消的请求不会在下一次无关的创建里兑现。
       */
      let projectRequestToken: string | null = null;

      ctx.onDispose(
        ctx.bus.on('workspace.newProjectRequested', (ev) => {
          projectRequestToken = readRequestToken(ev);
          ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eratw-adapter' });
        }),
      );

      /** 项目已创建 → 广播（载荷只有项目 id 与可能存在的关联号；不解释意图） */
      const emitProjectCreated = (projectId: string, requestToken?: string): void => {
        ctx.bus.emit('workspace.projectCreated', {
          projectId,
          ...(requestToken !== undefined ? { requestToken } : {}),
          source: 'eratw-adapter',
        });
      };
      ctx.onDispose(
        ctx.bus.on('workspace.importRequested', (ev) => {
          pendingImport = {
            sourceDir: ev.sourceDir,
            ...(ev.suggestedName !== undefined ? { suggestedName: ev.suggestedName } : {}),
          };
          ctx.bus.emit('ui.overlay.open', { id: IMPORT_KOJO_OVERLAY_ID, source: 'eratw-adapter' });
        }),
      );

      /**
       * 名称解析 memo 随项目关闭清空（§5.73）。
       * 只在 `closed` 挂就够覆盖切项目：内核 `open()` 会先 `close()` 旧项目并广播该事件，
       * 而首次开项目时表本来就是空的。纯函数缓存，清空不改变任何判定。
       */
      ctx.onDispose(ctx.bus.on('project.closed', () => clearKojoFamilyMemo()));

      refreshWsProjects();

      /** 变量字典（每次 loadProject 时按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 口上调用协议（v0.2 第十批；loadProject 时解析路由表，失败 → undefined 优雅降级） */
      let currentProtocol: EratwCallProtocol | undefined;

      const adapter: GameAdapter = {
        gameId: ERATW.gameId,
        displayName: ERATW.displayName,
        functionFamilyIndex: createEratwFamilyIndex(),
        // 覆盖规则消费已解析的路由协议（loadProject 时填充；缺省 → 规则降级）。
        conventions: createEratwConventions(() => currentProtocol),
        get variableSchema() {
          return currentSchema;
        },
        get kojoCallProtocol() {
          return currentProtocol;
        },
        // 时机分野模板表（v0.3 批 S2 补齐）——纯数据、无 IO：转译器转译时
        // 经槽位取用，故恒可用（不依赖 loadProject）。
        kojoFaceTemplates: createEratwFaceTable(),

        async detect(rootDir: string): Promise<boolean> {
          // 特征组合：口上・消息域目录 + Chara CSV 目录（同时存在才成局）
          const kojoRoot = join(rootDir, ...ERATW.detect.kojoRoot);
          if (!(await io.exists(kojoRoot))) return false;
          const charaDir = join(rootDir, ...ERATW.detect.charaCsvDir);
          return io.exists(charaDir);
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERATW.detect.charaCsvDir);
          const personalKojo = join(rootDir, ...ERATW.paths.personalKojo);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（CHARA 表正文 + 角色目录名 + 变量名称表摘要）。
           * 下游派生缓存（条件抽取 / 约定校验）的产出依赖它们，而 ERB 体量指纹
           * 覆盖不到 ⇒ 必须折进判据（见 `GameProject.inputDigest`）。
           */
          const inputParts: string[] = [];

          // ---- 1. CHARA CSV → 编号 / 名前 / 呼び名 ----
          const csvEntries = await io.listDir(charaDir);
          const csvFiles = csvEntries.filter(
            (e) => !e.isDirectory && /\.csv$/i.test(e.name) && ERATW.charaCsvPattern.test(e.name),
          );

          for (const entry of csvFiles) {
            const noFromName = parseCharaNoFromFileName(entry.name, ERATW.charaCsvPattern);
            let parsed: ReturnType<typeof parseCharaCsv> = { no: null, name: null, callName: null };
            try {
              const tf = await io.readText(entry.path);
              parsed = parseCharaCsv(tf.text);
              inputParts.push(`chara\u0000${entry.path}\u0000${tf.text}`);
            } catch (err) {
              inputParts.push(`chara\u0000${entry.path}\u0000!unreadable`);
              ctx.log.warn(`CHARA CSV 读取失败（跳过该文件）：${entry.path} — ${String(err)}`);
            }
            const no = parsed.no ?? noFromName;
            if (no === null) {
              ctx.log.warn(`无法确定角色编号（跳过）：${entry.name}`);
              continue;
            }
            // 名称回退链：名前 行 → 文件名剩余部分 → `Chara{n}`（显式回退，绝不静默丢弃）
            const nameFromFile = entry.name.replace(/\.csv$/i, '').replace(/^Chara\d+\s*/i, '').trim();
            const info: CharaInfo = {
              no,
              name: parsed.name ?? (nameFromFile.length > 0 ? nameFromFile : `Chara${no}`),
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. 個人口上目录 → 绑定 kojoDir ----
          const kojoEntries = await io.listDir(personalKojo);
          let bound = 0;
          for (const e of kojoEntries) {
            if (!e.isDirectory) continue;
            inputParts.push(`kojoDir\u0000${e.name}`);
            const parsed = parseKojoDirName(e.name);
            if (!parsed) {
              ctx.log.warn(`個人口上目录名不符合「{三位编号} {名称}」约定（跳过）：${e.name}`);
              continue;
            }
            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = e.path;
            } else {
              // 口上目录存在但 CSV 中无该编号：补最小条目（不猜测显示名，用目录 label）
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: e.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CFLAG/Talent/… 名称表；条件抽取的语义标注来源） ----
          currentSchema = await loadEratwVariableSchema({
            io,
            csvDir: join(rootDir, ...ERATW.csvDir),
            log: ctx.log,
          });

          // ---- 4. 口上调用协议（路由表 → 槽位语义表；失败降级 undefined） ----
          currentProtocol = await loadEratwCallProtocol({
            io,
            routeFile: join(rootDir, ...ERATW.paths.kojoMessageRoute),
            log: ctx.log,
          });

          ctx.log.info(
            `eraTW 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${personalKojo}`,
          );

          return {
            rootDir,
            adapterId: ERATW.gameId,
            kojoPaths: [personalKojo],
            savDir: join(rootDir, ...ERATW.savDir),
            // 提议可写路径（用户批准后由内核 io 放行；见 ProjectService.approveWritablePaths）
            // sav 目录随 v0.2 第十五批加入提议：注入器写档需要（kernel 第一道闸
            // 判定域 = 批准的 writablePaths；Rust 第二道闸本就允许项目根整体）。
            writablePaths: [personalKojo, join(rootDir, ...ERATW.savDir)],
            charaIndex,
            // 派生缓存判据的一部分：本次加载实际吃进的非 ERB 输入（CHARA 表正文、
            // 角色目录名、变量名称表）。ERB 体量指纹覆盖不到这些。
            inputDigest: combineDigests([foldDigest(inputParts), currentSchema.inputDigest]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERATW.gameId}-adapter`, adapter });

      /* ---- 「我的口上项目」面板（P-B）：独立活动栏图标（不声明 group） ---- */

      ctx.slots.register('ui.panel', {
        id: 'kojo-projects',
        title: '我的口上项目',
        icon: '⌂',
        // explorer 组（口上文件 30 / 函数树 40）之后，独占一枚活动栏图标
        order: 35,
        location: 'sidebar',
        component: createKojoProjectsPanel({
          subscribe: (cb) => {
            wsListeners.add(cb);
            return () => wsListeners.delete(cb);
          },
          projects: () => wsProjects,
          loading: () => wsLoading,
          error: () => wsError,
          refresh: refreshWsProjects,
          projectDir: (projectId) => workspaces.projectDir(projectId),
          dirState: (absDir) => wsDirCache.get(absDir),
          ensureDir: ensureWsDir,
          reveal: (absPath) =>
            ctx.bus.emit('editor.revealLocation', { filePath: absPath, source: 'eratw-adapter' }),
          openNewWizard: () =>
            ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eratw-adapter' }),
          status: () => actions.status(),
          dismissStatus: () => actions.dismiss(),
          exportArtifact: (absDir, displayName) => actions.exportArtifact(absDir, displayName),
          deployArtifact: (artifact, absDir) => requestDeploy(artifact, absDir),
          attribution: (absDir) => wsAttrCache.get(absDir),
          ensureAttribution: ensureWsAttribution,
          createItem,
        }),
      });

      /* ---- 新建口上项目向导（P-C）：脚手架中文命名 + 8 核心面空壳 ---- */

      ctx.slots.register('ui.overlay', {
        id: NEW_KOJO_PROJECT_OVERLAY_ID,
        order: 20,
        component: createNewKojoProjectWizard({
          workspaces,
          project,
          close: () => {
            ctx.bus.emit('ui.overlay.close', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eratw-adapter' });
            // 意图随窗口关闭作废（创建路径在 close 之前已把关联号带进广播）
            projectRequestToken = null;
          },
          onCreated: invalidateWs,
          created: ({ projectId }) => emitProjectCreated(projectId, projectRequestToken ?? undefined),
        }),
      });

      /* ---- 导入口上项目向导（P-F）：强制新包名，不覆盖他人署名 ---- */

      ctx.slots.register('ui.overlay', {
        id: IMPORT_KOJO_OVERLAY_ID,
        order: 21,
        component: createImportKojoWizard({
          workspaces,
          pending: () => pendingImport,
          clearPending: () => {
            pendingImport = null;
          },
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: IMPORT_KOJO_OVERLAY_ID, source: 'eratw-adapter' }),
          onImported: invalidateWs,
          // 导入向导的「新建项目」分支同样是在建项目——事件要说事实，与入口无关；
          // 这条路径没有人在等，故不带关联号。
          projectCreated: (projectId) => emitProjectCreated(projectId),
          loadAttribution: (absDir) => readPackageAttribution({ io, absDir }),
        }),
      });

      /* ---- 部署向导（P-E）：工作区包 → 角色口上目录（目标已存在不覆盖） ---- */

      ctx.slots.register('ui.overlay', {
        id: DEPLOY_KOJO_OVERLAY_ID,
        order: 22,
        component: createDeployKojoWizard({
          gameProject: () => project.current(),
          writable: (targetDir) => io.isWritable(targetDir),
          checkTargetExists: (targetDir) => io.exists(targetDir),
          pending: () => pendingDeploy,
          clearPending: () => {
            pendingDeploy = null;
          },
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: DEPLOY_KOJO_OVERLAY_ID, source: 'eratw-adapter' }),
          deploy: (pkg, target) => actions.deployArtifact(pkg, target),
        }),
      });
    },
  };
}
