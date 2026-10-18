import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  MarketService,
  OpJournal,
  Plugin,
  ProjectService,
  SugarTranspileService,
  VariableSchema,
  WorkspaceArtifact,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, MARKET_SERVICE_KEY, WellKnownServices, basename, combineDigests, foldDigest, join, pathKey } from '@kojo/plugin-api';
import { ERATW } from './constants';
import { createEratwCounterTable, ERATW_COUNTER_ENTRIES } from './counter-table';
import { EMPTY_INSTRUCTION_TABLE, loadEratwInstructionTable } from './instruction-table';
import { createEratwLibraryTable, ERATW_LIBRARY_FUNCTIONS } from './library-table';
import { createEratwMutatorTable, ERATW_MUTATOR_FAMILIES } from './mutator-table';
import { deriveCharaNoFromFileNames, parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from './chara-csv';
import { clearKojoFamilyMemo, createEratwFamilyIndex } from './family-index';
import { createEratwConventions } from './conventions';
import { loadEratwVariableSchema } from './variable-schema';
import { loadEratwCallProtocol, type EratwCallProtocol } from './call-protocol';
import { createEratwFaceTable } from './face-templates';
import { ERATW_NAME_GLOSSARY } from './name-glossary';
import { createKojoProjectsPanel, type DirListState } from './kojo-projects-panel';
import { readPackageAttribution, readSourceAttribution, type AttributionState as AttrState } from './attribution';
import { createPackageActions } from './package-actions';
import { resolveNewItemPath, type NewItemKind } from './new-item';
import { workspaceChangeOf } from './watch-scope';
import type { KojoCompiler } from './artifact';
import {
  NEW_KOJO_PROJECT_OVERLAY_ID,
  createNewKojoProjectWizard,
  listMarketTemplates,
  readRequestToken,
  type KojoTemplateEntry,
} from './new-project-wizard';
import { IMPORT_KOJO_OVERLAY_ID, createImportKojoWizard, type PendingImport } from './import-wizard';
import { DEPLOY_KOJO_OVERLAY_ID, createDeployKojoWizard } from './deploy-wizard';
import { PUBLISH_KOJO_OVERLAY_ID, createPublishKojoWizard } from './publish-wizard';
import {
  KOJO_TUTORIAL_OVERLAY_ID,
  REFERENCE_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
  createLazyTutorialOverlay,
} from './tutorial-lazy';
import type { TutorialId } from './tutorial-content';
import type { PendingDeploy } from './deploy';
import { charaSearchScopeOptions } from './search-scope';

/**
 * 教程语义 id → 本插件注册的 overlay 贡献 id（用户反馈 8 批）。
 *
 * 只读映射，两个入口共用同一份：欢迎页的教程卡片走内核事件 `ui.tutorial.open`
 * （由下方监听器查表），「我的口上项目」面板底部的三个按钮走本包的
 * `openTutorial` 回调。发起方只认识语义 id，模态叫什么始终是本包的私事。
 */
export const TUTORIAL_OVERLAY_BY_ID: Readonly<Record<TutorialId, string>> = {
  kojo: KOJO_TUTORIAL_OVERLAY_ID,
  sugar: SUGAR_TUTORIAL_OVERLAY_ID,
  reference: REFERENCE_TUTORIAL_OVERLAY_ID,
};

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

      /* ---- 外部改动 → 面板重列（2026-10-13 看板 HK-6；监视根含工作区根，见 §5.91） ---- */

      /**
       * 每个目录"最新一次重列请求"的序号：旧请求后到时**不覆盖**新结果。
       * 与宿主文件树那条失效通道（`FileTree.dirReq`）同一个理由——只是两包之间
       * 不许交叉 import（审计 C 项），所以各留一份，不硬凑一个公共件。
       */
      const relistSeq = new Map<string, number>();

      /**
       * 重列一个已缓存目录，但**旧内容原地留着**等新结果。
       *
       * 不复用 `refreshDir`：它先 delete 再 ensure，中间那一帧 `dirState` 是 undefined，
       * 面板就渲染成「读取目录…」——作者只是用别的程序往包里存了个文件，
       * 不该看见整块内容闪一下空白（宿主文件树那边同一批踩过，见 §5.91）。
       * 读失败时同样保留旧内容、只记日志：把一份正确的目录换成错误态是更坏的失败，
       * 而面板顶部本就有 ⟳ 可手动重拉。
       */
      const relistDir = (absDir: string): void => {
        const seq = (relistSeq.get(absDir) ?? 0) + 1;
        relistSeq.set(absDir, seq);
        void io
          .listDir(absDir)
          .then((entries) => {
            if (relistSeq.get(absDir) !== seq) return;
            wsDirCache.set(absDir, entries);
            notifyWs();
          })
          .catch((err: unknown) => {
            if (relistSeq.get(absDir) !== seq) return;
            ctx.log.warn(`工作区目录重列失败（${absDir}），面板显示的是上一次的内容：${String(err)}`);
          });
      };

      /**
       * 工作区**全部**根（默认根 + 作者自选并常驻授权的项目位置；拿不到 = 无平台数据目录的
       * 环境，如浏览器开发壳 → 空列表 ⇒ 不响应外部改动）。
       * 每次现取不缓存：`roots()` 是同步读内存数组、零 IO，而缓存会把"本会话刚自选的新根"
       * 永远排除在外——那正是作品真正住着的地方。
       */
      const workspaceRoots = (): string[] => {
        try {
          return workspaces.roots();
        } catch {
          return [];
        }
      };

      ctx.onDispose(
        ctx.bus.on('file.changed', (ev) => {
          const target = workspaceChangeOf(ev.path, workspaceRoots());
          if (target.projectListChanged) {
            refreshWsProjects();
            return;
          }
          if (target.dirToRefresh === null) return;
          // **按统一形态找缓存键**，不直接 `has(dirToRefresh)`：事件里的路径是平台原样
          // （Rust notify 给什么就是什么），而缓存键是 `join()` 出来的形态——两者在
          // Windows 上分隔符与大小写都不保证一致，直接 has 会"看着对、永远不命中"。
          const want = pathKey(target.dirToRefresh);
          for (const cached of wsDirCache.keys()) {
            // 只重列**已经在缓存里**的目录 = 作者看过的那些；没缓存的等展开时惰性取到新数据
            if (pathKey(cached) === want) {
              relistDir(cached);
              break;
            }
          }
        }),
      );

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
          throw new Error(`「${label}」需要 .kojo 转译服务（kojo-sugar 插件未启用），无法转成 .ERB`);
        }
        return sugar.compileToBytes(source, undefined, label);
      };

      /**
       * 市场服务（**惰性取**；KM-14 模板包 / KM-15 字典包共用）。
       *
       * `kojo-market` 可能比本插件晚激活 ⇒ 一律在"用到的那一刻"`tryInject`，
       * 与 `compileKojo` 同款理由。缺席 / 取出失败 ⇒ `null`（调用方按"没有市场"降级，
       * 绝不让项目加载或向导挂掉）。
       */
      const tryMarket = (): MarketService | null => {
        try {
          return ctx.tryInject<MarketService>(MARKET_SERVICE_KEY) ?? null;
        } catch (err) {
          // 测试壳等未实现 tryInject 的上下文：与"市场缺席"同义，照常出声
          ctx.log.warn(`市场服务获取失败（按未安装处理）：${String(err)}`);
          return null;
        }
      };

      /**
       * 批操作 journal（2026-10-18 undo 覆盖批，additive 可选注入）：部署整包进账。
       * 缺席 / 取出失败 ⇒ undefined（部署照旧、不进账——旧内核兼容）。
       */
      const tryJournal = (): Pick<OpJournal, 'begin' | 'record' | 'commit' | 'abort'> | undefined => {
        try {
          return ctx.tryInject<OpJournal>(KernelServices.Ops) ?? undefined;
        } catch (err) {
          ctx.log.warn(`批操作账本获取失败（部署将不进账）：${String(err)}`);
          return undefined;
        }
      };

      const actions = createPackageActions({
        io,
        log: ctx.log,
        notify: notifyWs,
        compileKojo,
        journal: tryJournal(),
      });
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
            // KM-13：来源标记原样记住——市场来源的导入据此读上一级 pack.json 兜底署名
            ...(ev.source !== undefined ? { source: ev.source } : {}),
          };
          ctx.bus.emit('ui.overlay.open', { id: IMPORT_KOJO_OVERLAY_ID, source: 'eratw-adapter' });
        }),
      );

      /* ---- 发布口上请求（用户反馈 4 批）：市场面板发语义意图，本插件解释为发布向导 ---- */

      /**
       * 市场面板只递「作者要发布」这一个意图——载荷里没有项目 / 包 / 许可，那些是
       * 本插件从工作区**现读**的事实（overlay 组件无 props，打开时不带 payload）。
       * 与 `workspace.importRequested` 同款分工：发起方不需要知道本插件把模态叫什么、
       * 要问哪些字段。
       */
      ctx.onDispose(
        ctx.bus.on('market.publishRequested', () => {
          ctx.bus.emit('ui.overlay.open', { id: PUBLISH_KOJO_OVERLAY_ID, source: 'eratw-adapter' });
        }),
      );

      /* ---- 「从文件夹导入口上项目…」命令（命令面板入口） ---- */

      /**
       * 文件树右键只覆盖"目录已经在当前树里"的情形；作者手上更多是磁盘上任意
       * 位置的作者包文件夹。这里用系统目录对话框补上这一口：选定 → 发**既有**
       * 的 `workspace.importRequested` 意图，导入流程（P-F 向导）零改动复用——
       * 本函数只负责把目录递进门里，不解释怎么导。
       *
       * 对话框通道即 `io.chooseWorkspaceRoot`（对话框即授权，铁律 6 的法定形态；
       * 与新建向导的「项目位置」同族）——这里只借它的"选目录"形态，授权登记
       * 由平台命令内部完成，本插件不碰授权本身。
       *
       * 抽成共享函数（用户反馈批）：命令面板与「我的口上项目」面板工具条的
       * 「导入项目」按钮走同一条通道，不复制两份——两处行为必须逐字一致，
       * 只有 `source` 标记不同（KM-13：市场来源据此读上一级 pack.json 兜底署名）。
       */
      const pickAndRequestImport = async (source: string): Promise<void> => {
        let picked: string | null;
        try {
          picked = await io.chooseWorkspaceRoot({ title: '选择要导入的作者包文件夹' });
        } catch (err) {
          // 对话框本身起不来（如无对话框能力的环境）：人话出声，不吞——
          // 宁可让作者知道"这条路今天走不通"，也不让他对着毫无反应的按钮发呆。
          const reason = err instanceof Error ? err.message : String(err);
          ctx.log.error(`「从文件夹导入口上项目」打不开目录选择对话框：${reason}`);
          return;
        }
        if (picked === null) {
          // 取消 = 用户自己的动作，安静返回是尊重，不是静默失败：
          // 他刚刚亲手关掉了对话框，再补一句"已取消"就是噪音。
          return;
        }
        // 末段名做预填建议；根目录（`/`、`C:\`）没有末段 → 不带这个键，
        // 让导入向导按自己的回退链取名，绝不让空串混进事件载荷。
        const suggestedName = basename(picked);
        ctx.bus.emit('workspace.importRequested', {
          sourceDir: picked,
          ...(suggestedName.length > 0 ? { suggestedName } : {}),
          source,
        });
      };

      ctx.slots.register('editor.command', {
        id: 'kojo.importKojoProject',
        title: '从文件夹导入口上项目…',
        category: '文件',
        // 不写 when：命令不依赖活动文件也不依赖打开的项目，任何上下文都可用
        // （宿主对缺省 when 按"恒可用"求值）——按下去必须听到响，绝不灰着不说话。
        run: () => pickAndRequestImport('command-palette'),
      });

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
      /** 指令名表（HK-11；loadProject 时读 `CSV/Train.csv`，缺表 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable | undefined;

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
        // 指令名表（HK-11）——读当前项目表；未加载 = 空表实例（糖层查表恒有其一枚）。
        get kojoInstructionTable(): KojoInstructionTable {
          return currentInstructionTable ?? EMPTY_INSTRUCTION_TABLE;
        },
        // 时机分野模板表（v0.3 批 S2 补齐）——纯数据、无 IO：转译器转译时
        // 经槽位取用，故恒可用（不依赖 loadProject）。
        kojoFaceTemplates: createEratwFaceTable(),
        // 基础库/常用函数名表（ZH-F1）——同样纯数据、无 IO（手工维护的静态表），
        // 糖层在表达式里把中文函数名降为原生 ERB 函数名。
        kojoLibraryTable: createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS),
        // 数值增减族表（1016 批）——同样纯数据、无 IO（手工维护的静态表）：
        // 糖层把 `增减 族:对象:槽 ± n` 降为 `CALL <engine>(…)`，参数序由本表声明。
        kojoMutatorTable: createEratwMutatorTable(ERATW_MUTATOR_FAMILIES),
        // 计数器值域表（1016 批）——同样纯数据、无 IO（手工维护的静态表）：
        // 糖层把 `时机 计数器 <中文名>：` 的名换算成编号（纯数字令牌直通、不查表）。
        kojoCounterTable: createEratwCounterTable(ERATW_COUNTER_ENTRIES),
        // 日文名 → 中文名对照词典（只加显示备注，不改任何实际目录/文件名）
        nameGlossary: ERATW_NAME_GLOSSARY,
        // 条件矩阵剧情线预设（2026-10-18 填格批）：状态键的口径取自 CHARA 相关名表。
        // 同一条线给「具名 / 编号」两形态——真实口上两种写法都常见，面板只做精确匹配。
        stateLinePresets: [
          {
            id: 'affection',
            label: '好感线',
            description: '以好感度（CFLAG:2）为轴的状态线。',
            keys: ['CFLAG:好感度', 'CFLAG:2'],
          },
          {
            id: 'love',
            label: '爱慕线',
            description: '以恋慕（TALENT:3）为轴的状态线；爱慕是本地化里对恋慕的常用称呼。',
            keys: ['TALENT:恋慕', 'TALENT:3'],
          },
          {
            id: 'lover',
            label: '恋人线',
            description: '以恋人（TALENT:7）为轴的状态线。',
            keys: ['TALENT:恋人', 'TALENT:7'],
          },
          {
            id: 'desire',
            label: '爱欲线',
            description: '以爱欲（TALENT:184）为轴的状态线。',
            keys: ['TALENT:愛欲', 'TALENT:爱欲', 'TALENT:184'],
          },
        ],

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
            let no: number | null = parsed?.no ?? null;
            // 命名回退：目录名不带编号（纯角色名目录，如 4.842 的 `阿燐`）时，
            // 按目录内 `M_KOJO_K{no}_*.ERB` / `M_KOJO_K{no}.ERH` 文件名反推编号
            // （与引擎 `KOJO_MESSAGE.ERB` 的 `_K{no}` 调用同口径），取到即按编号路径绑定。
            const label = parsed?.label ?? e.name;
            if (parsed === null) {
              let names: string[] = [];
              try {
                const inner = await io.listDir(e.path);
                names = inner.filter((d) => !d.isDirectory).map((d) => d.name);
              } catch (err) {
                ctx.log.debug(`個人口上目录列举失败（按无编号处理）：${e.path} — ${String(err)}`);
              }
              no = deriveCharaNoFromFileNames(names);
            }
            if (no === null) {
              ctx.log.warn(`個人口上目录名不符合「{三位编号} {名称}」约定（跳过）：${e.name}`);
              continue;
            }
            const info = charaIndex.get(no);
            if (info) {
              info.kojoDir = e.path;
            } else {
              // 口上目录存在但 CSV 中无该编号：补最小条目（不猜测显示名，用目录 label）
              charaIndex.set(no, { no, name: label, kojoDir: e.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CFLAG/Talent/… 名称表；条件抽取的语义标注来源） ----
          // 市场字典包（KM-15）：第三轮追加名表。市场缺席 / 读取失败 / 无字典包 ⇒ 空列表，
          // 与今天行为逐字一致（字典零新增轮、日志零新增）；项目加载不因市场出声而挂。
          const marketAppendDirs: string[] = [];
          try {
            const market = tryMarket();
            if (market !== null) {
              for (const rec of await market.installed()) {
                if (rec.kind !== 'dict-pack') continue;
                marketAppendDirs.push(await market.contentDir(rec.kind, rec.id, rec.version));
              }
            }
          } catch (err) {
            marketAppendDirs.length = 0;
            ctx.log.warn(`市场字典包目录收集失败（本次不并入市场名表，字典照常加载）：${String(err)}`);
          }
          currentSchema = await loadEratwVariableSchema({
            io,
            csvDir: join(rootDir, ...ERATW.csvDir),
            chsMapPath: join(rootDir, ...ERATW.chsNameMap),
            // 作者自定名表（FT-1）：引擎从整个 ERB 根递归装 `.ERH`（`Process.cs:221`）
            erbDir: join(rootDir, ...ERATW.erbDir),
            // 市场字典包追加名表（KM-15；空 = 连这个键都不带，与历史逐字一致）
            ...(marketAppendDirs.length > 0 ? { marketAppendDirs } : {}),
            log: ctx.log,
          });

          // ---- 4. 口上调用协议（路由表 → 槽位语义表；失败降级 undefined） ----
          currentProtocol = await loadEratwCallProtocol({
            io,
            routeFile: join(rootDir, ...ERATW.paths.kojoMessageRoute),
            log: ctx.log,
          });

          // ---- 5. 指令名表（CSV/Train.csv → 中文名 ↔ 编号；缺表/读失败 = 空表，不抛） ----
          currentInstructionTable = await loadEratwInstructionTable({
            io,
            csvDir: join(rootDir, ...ERATW.csvDir),
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
        icon: 'home',
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
          // 「导入项目」= 命令面板那条 `kojo.importKojoProject` 的同一具身体，只换来源标记
          openImportWizard: () => pickAndRequestImport('projects-panel'),
          // 教程入口（E6；TUT-2 加全表）：三个 overlay 常驻注册（见下方），这里只发打开意图。
          // 用户反馈 8 批起映射抽成 `TUTORIAL_OVERLAY_BY_ID`，与内核事件监听共用一份。
          openTutorial: (which) =>
            ctx.bus.emit('ui.overlay.open', {
              id: TUTORIAL_OVERLAY_BY_ID[which],
              source: 'eratw-adapter',
            }),
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
          // 「项目位置」的自选通道（2026-10-14）：插件只经 kernel.io 的对话框通道，
          // 不碰路径授权本身（授权在平台命令内完成，铁律 6）
          io,
          project,
          close: () => {
            ctx.bus.emit('ui.overlay.close', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eratw-adapter' });
            // 意图随窗口关闭作废（创建路径在 close 之前已把关联号带进广播）
            projectRequestToken = null;
          },
          // 模板来源（KM-14）：已装 `template-pack` 投影成下拉条目（懒取市场，市场缺席 ⇒ []）。
          // 取目录 / 列包失败一律按"没有模板包"处理——模板是锦上添花，不挡向导的默认内置骨架。
          listTemplates: async (): Promise<readonly KojoTemplateEntry[]> => {
            try {
              return await listMarketTemplates(tryMarket());
            } catch (err) {
              ctx.log.warn(`市场模板包列表获取失败（新建向导按无模板包处理）：${String(err)}`);
              return [];
            }
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
          // KM-13：来源标记透传给读取器——市场来源先补读上一级 pack.json 兜底署名
          // （读不到就退回 README 扫描，绝不阻断导入）
          loadAttribution: (absDir, source) =>
            readSourceAttribution({ io, absDir, ...(source !== undefined ? { source } : {}) }),
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

      /* ---- 发布口上向导（用户反馈 4 批）：工作区项目/包 → 许可 → 打包上传 ---- */

      ctx.slots.register('ui.overlay', {
        id: PUBLISH_KOJO_OVERLAY_ID,
        // 向导族 20-40：新建 20 / 导入 21 / 部署 22 / 发布 23
        order: 23,
        // 五段引导 + 字段说明比单页向导长，按宽版承载（同教程浮层的度量档）
        size: 'wide',
        component: createPublishKojoWizard({
          workspaces,
          io,
          compileKojo,
          // 市场服务惰性取：`kojo-market` 可能晚激活 / 被停用（同 compileKojo 的理由）
          market: tryMarket,
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: PUBLISH_KOJO_OVERLAY_ID, source: 'eratw-adapter' }),
          // 外链只发意图：宿主落地（闸的唯一执法点在 Rust，插件不开窗）
          openExternal: (url) => ctx.bus.emit('ui.openExternal', { url }),
        }),
      });

      /* ---- 内置教程（E6）：语法糖 + 口上 + 语法全表附录；入口在「我的口上项目」面板底部 ---- */

      /**
       * 教程打开意图（用户反馈 8 批）：欢迎页等发起方只发语义 id（kojo/sugar/reference），
       * 本插件映射到自己的 overlay 贡献后打开——发起方不知道模态叫什么（与
       * `market.publishRequested` 同款分工）。退订挂 `ctx.onDispose`：插件停用后，
       * 总线上的意图不再打开本插件的浮层。
       */
      ctx.onDispose(
        ctx.bus.on('ui.tutorial.open', (ev) => {
          const overlayId = TUTORIAL_OVERLAY_BY_ID[ev.tutorial];
          if (!overlayId) {
            // 载荷由契约强类型化，但总线运行时不校验——未知 id 出声，不静默打开错浮层
            ctx.log.warn(`未知教程 id：${String(ev.tutorial)}`);
            return;
          }
          ctx.bus.emit('ui.overlay.open', { id: overlayId, source: 'eratw-adapter' });
        }),
      );

      /** 脚部「查语法全表」：overlay 是单槽位，直接发打开意图即替换当前这本 */
      const openReferenceOverlay = (): void => {
        ctx.bus.emit('ui.overlay.open', { id: REFERENCE_TUTORIAL_OVERLAY_ID, source: 'eratw-adapter' });
      };

      /**
       * 三个教程浮层（PS-10 首屏批）：贡献照旧在此刻注册——id / order / size 一字不动，
       * 面板顺序与 `ui.tutorial.open` 映射的语义完全不变；只有**正文**换成懒装载壳，
       * 浮层真被打开那一刻才 `import()` 那 223 KB 文案（开机默认不开教程 ⇒ 欢迎页不该
       * 为它付解析与求值的钱）。
       */
      ctx.slots.register('ui.overlay', {
        id: SUGAR_TUTORIAL_OVERLAY_ID,
        order: 30,
        size: 'wide',
        component: createLazyTutorialOverlay({
          tutorial: 'sugar',
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: SUGAR_TUTORIAL_OVERLAY_ID, source: 'eratw-adapter' }),
          openReference: openReferenceOverlay,
        }),
      });

      ctx.slots.register('ui.overlay', {
        id: KOJO_TUTORIAL_OVERLAY_ID,
        order: 31,
        size: 'wide',
        component: createLazyTutorialOverlay({
          tutorial: 'kojo',
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: KOJO_TUTORIAL_OVERLAY_ID, source: 'eratw-adapter' }),
          openReference: openReferenceOverlay,
        }),
      });

      ctx.slots.register('ui.overlay', {
        id: REFERENCE_TUTORIAL_OVERLAY_ID,
        order: 32,
        size: 'wide',
        component: createLazyTutorialOverlay({
          tutorial: 'reference',
          close: () =>
            ctx.bus.emit('ui.overlay.close', {
              id: REFERENCE_TUTORIAL_OVERLAY_ID,
              source: 'eratw-adapter',
            }),
        }),
      });

      /* ---- 检索范围提供方（C3 领域限定检索批）----
       *
       * 「这个角色只有哪些文件」= 一个目录前缀，判据来自本包在 `loadProject` 里绑好的
       * `charaIndex[].kojoDir`（唯一真源，这里不重算名单）。宿主全文检索只拿到
       * "标签 + 目录"两样它不需要理解的泛型事实，并据此**收窄检索根**（少扫就是少扫）。
       * 反过来写在宿主里（哪怕只是读 `charaIndex`）就是把游戏判据抄第二份、
       * 还抄进了审计 A 射程内最不该有它的一层。
       *
       * 只认本项目：`adapterId` 不是自己的 ⇒ 空候选 ⇒ 宿主不画选择器（默认关）。
       * 一次投影 155 条 ≈ 微秒级，不值得记忆化；宿主也只在换项目时重算一次。 */
      ctx.slots.register('search.scope', {
        id: `${ERATW.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERATW.gameId
            ? charaSearchScopeOptions(project.charaIndex.values())
            : [],
      });
    },
  };
}
