/**
 * eraAkumaMaid 适配器插件 —— 本包是**唯一**允许知道「eraAkumaMaid / EVENT_K /
 * CHARA CSV」这些字眼的地方（架构文档 §5.1 / §5.7「游戏知识归 adapter」）。
 *
 * 落地形态照 eratw-adapter（packages/plugins/eratw-adapter）裁剪：
 * - detect / loadProject / 语义层提供方（family-index / variableSchema /
 *   conventions / kojoCallProtocol / kojoInstructionTable / kojoFaceTemplates /
 *   nameGlossary）；
 * - 「我的口上项目」面板与向导族**不在本版**（P4：先抽取共享骨架、两适配器共用，
 *   见 docs/PLAN-eraAkumaMaid-adapter.md 决策②——不复制一份 eratw 向导代码）。
 *
 * 与 eraTW 的核心差异（命名体系）：eraTW 是中缀 `M_KOJO_K{n}_{家族}`，本游戏是
 * **后缀式 `{家族}_K{n}`**；主路由 = `ERB/EVENT_K/EVENT_K.ERB`（= eraTW 的
 * `KOJO_MESSAGE.ERB` 等价物）；无静态 sav/ 目录（故不提议 savDir）。
 */

import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  MarketService,
  Plugin,
  ProjectService,
  ScaffoldOptions,
  ScaffoldResult,
  SugarTranspileService,
  VariableSchema,
  WorkspaceArtifact,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import {
  KernelServices,
  MARKET_SERVICE_KEY,
  WellKnownServices,
  basename,
  combineDigests,
  foldDigest,
  join,
  pathKey,
} from '@kojo/plugin-api';
import {
  createDeployKojoWizard,
  createImportKojoWizard,
  createKojoProjectsPanel,
  createNewKojoProjectWizard,
  createPackageActions,
  createPublishKojoWizard,
  listMarketTemplates,
  readPackageAttribution,
  readRequestToken,
  readSourceAttribution,
  resolveNewItemPath,
  writeScaffoldFiles,
  type AttributionState,
  type DirListState,
  type KojoCompiler,
  type KojoTemplateEntry,
  type NewItemKind,
  type PendingDeploy,
  type PendingImport,
} from '@kojo/kojo-project-kit';
import { charaSearchScopeOptions, workspaceChangeOf } from '@kojo/kojo-project-kit';
import { ERAAKUMA_MAID } from './constants';
import {
  deriveCharaNoFromFileNames,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { clearKojoFamilyMemo, createErakumamaidFamilyIndex } from './family-index';
import { createErakumamaidConventions } from './conventions';
import { loadErakumamaidVariableSchema } from './variable-schema';
import { loadErakumamaidCallProtocol, type ErakumamaidCallProtocol } from './call-protocol';
import { EMPTY_INSTRUCTION_TABLE, loadErakumamaidInstructionTable } from './instruction-table';
import { createErakumamaidFaceTable } from './face-templates';
import { AM_LIBRARY_FUNCTIONS, createErakumamaidLibraryTable } from './library-table';
import { AM_MUTATOR_FAMILIES, createErakumamaidMutatorTable } from './mutator-table';
import { ERAAKUMA_MAID_NAME_GLOSSARY } from './name-glossary';
import { scaffoldErakumamaidProject } from './scaffold';
import { withAmScaffold } from './new-project-wizard';
import {
  DEPLOY_KOJO_OVERLAY_ID,
  IMPORT_KOJO_OVERLAY_ID,
  NEW_KOJO_PROJECT_OVERLAY_ID,
  PUBLISH_KOJO_OVERLAY_ID,
} from './overlay-ids';

/** 创建 eraAkumaMaid 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createErakumamaidAdapterPlugin(): Plugin {
  return {
    id: 'eraakumamaid-adapter',
    version: '0.1.0',
    requires: ['kernel.io', KernelServices.Project, KernelServices.Workspaces],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');
      /** 当前游戏项目（`scaffold` 的落点解析要用 charaIndex / rootDir） */
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      /** 作者工作区（「我的口上项目」面板与四个向导的落点） */
      const workspaces = ctx.inject<WorkspaceService>(KernelServices.Workspaces);

      /**
       * 市场服务（**惰性取**；字典包追加名表 KM-15 用）。
       * `kojo-market` 可能比本插件晚激活 ⇒ 用到的那一刻才 tryInject；
       * 取出失败 ⇒ null（调用方按"没有市场"降级，绝不让项目加载挂掉）。
       */
      const tryMarket = (): MarketService | null => {
        try {
          return ctx.tryInject<MarketService>(MARKET_SERVICE_KEY) ?? null;
        } catch (err) {
          // 测试壳等未实现 tryInject 的上下文：与"市场缺席"同义
          ctx.log.warn(`市场服务获取失败（按未安装处理）：${String(err)}`);
          return null;
        }
      };

      /** 变量字典（每次 loadProject 时按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 口上调用协议（loadProject 时解析路由表，失败 → undefined 优雅降级） */
      let currentProtocol: ErakumamaidCallProtocol | undefined;
      /** 指令名表（loadProject 时读 `CSV/Train.csv`，缺表 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable | undefined;

      const adapter: GameAdapter = {
        gameId: ERAAKUMA_MAID.gameId,
        displayName: ERAAKUMA_MAID.displayName,
        functionFamilyIndex: createErakumamaidFamilyIndex(),
        // 覆盖规则消费已解析的路由协议（loadProject 时填充；缺省 → 规则降级）
        conventions: createErakumamaidConventions(() => currentProtocol),
        get variableSchema() {
          return currentSchema;
        },
        get kojoCallProtocol() {
          return currentProtocol;
        },
        // 指令名表——读当前项目表；未加载 = 空表实例（糖层查表恒有其一枚）
        get kojoInstructionTable(): KojoInstructionTable {
          return currentInstructionTable ?? EMPTY_INSTRUCTION_TABLE;
        },
        // 时机分野模板表——纯数据、无 IO：转译器转译时经槽位取用，恒可用
        kojoFaceTemplates: createErakumamaidFaceTable(),
        // 日文名 → 中文名对照词典（只加显示备注，不改任何实际目录/文件名）
        nameGlossary: ERAAKUMA_MAID_NAME_GLOSSARY,
        // 函数中文化表（2026-10-19 P5）——纯数据、无 IO（手工维护的静态表）：
        // 糖层把「中文函数名」降成本游戏的原生 ERB 函数名；查不到 fail-visible。
        kojoLibraryTable: createErakumamaidLibraryTable(AM_LIBRARY_FUNCTIONS),
        // 数值增减族表（2026-10-19 P5）——**直写形态**（`form: 'assign'`）：
        // 本游戏没有增减封装函数，产物是 `族:对象:槽 += n` 而不是 `CALL …(…)`。
        kojoMutatorTable: createErakumamaidMutatorTable(AM_MUTATOR_FAMILIES),
        // 条件矩阵剧情线预设（2026-10-19 P5）：状态键口径取自本游戏 `CSV/CFLAG.csv`
        // 与 `CSV/Talent.csv` 的名称列——同一条线给「具名 / 编号」两形态，面板只做精确匹配。
        //
        // 选键判据 = **在口上域真有条件行**（`ERB/EVENT_K/` 内条件位出现次数）：
        // 好感度 333 · 恋慕 16,934 · 相思相愛 805 · 出産経験 269。
        // ⚠ 特意**不**收两条看起来更像"剧情线"的键，因为它们在口上域几乎没有行：
        //   `TALENT:片思い`（表白前状态）全语料条件位 **0** 处（仅 `DAILY_CMD_LIST.ERB:904`
        //   一处是代码引用）；`CFLAG:同棲`（按位管理）在 `EVENT_K/` **0** 处。
        //   收进来只会得到一个点不动、永远筛不出行的按钮——宁可少一条线。
        stateLinePresets: [
          {
            id: 'affection',
            label: '好感线',
            description: '以好感度（`CSV/CFLAG.csv:2`）为轴的状态线。',
            keys: ['CFLAG:好感度', 'CFLAG:2'],
          },
          {
            id: 'love',
            label: '恋慕线',
            description: '以恋慕（`CSV/Talent.csv:150`）为轴的状态线；本游戏的"关系"只把恋慕列为本格。',
            keys: ['TALENT:恋慕', 'TALENT:150'],
          },
          {
            id: 'mutual',
            label: '相愛线',
            description: '以相思相愛（`CSV/Talent.csv:152`，"両思い"）为轴的状态线：恋慕走完之后的阶段。',
            keys: ['TALENT:相思相愛', 'TALENT:152'],
          },
          {
            id: 'birth',
            label: '生育线',
            description: '以出産経験（`CSV/Talent.csv:22`）为轴的状态线。',
            keys: ['TALENT:出産経験', 'TALENT:22'],
          },
        ],

        /**
         * 生成新角色口上骨架并**直接落盘**（契约 v0.3 的 `scaffold` 位）。
         *
         * 与 eraTW 的区别是**落点口径**：本游戏的脚手架产物是「游戏根相对路径」
         * （`ERB/EVENT_K/<n>/*.kojo` + `CSV/CHARA/CHARA<n>.csv`），所以缺省落点是
         * 项目根，而不是某个角色的口上目录——照搬 eraTW 那套会把文件铺错层。
         *
         * `options.targetDir` 可覆盖（例如先落到别处过目）；已存在的文件一律不覆盖。
         */
        async scaffold(characterNo: number, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
          const proj = project.current();
          if (!proj) throw new Error('当前没有打开的游戏项目，无处生成骨架。');
          const info = proj.charaIndex.get(characterNo);
          if (!info) throw new Error(`游戏项目里没有编号 ${characterNo} 的角色。`);
          const targetDir = options.targetDir ?? proj.rootDir;
          const built = scaffoldErakumamaidProject({
            workName: options.displayName ?? `${info.name}口上`,
            // 契约的 options 没有作者字段；占位而非编造，报告里会点明
            authorName: '未指定',
            charaName: info.name,
            version: '1.0',
            charaNo: characterNo,
          });
          // `options.faces` 收的是文件名干（本游戏形如 `EVENT_K{n}`）；只影响写哪些空壳
          const only = options.faces === undefined
            ? undefined
            : Object.keys(built.files).filter((rel) => {
                const stem = rel.replace(/\.kojo$/, '').split('/').pop() ?? '';
                return options.faces!.some((f) => f.replaceAll('{n}', String(characterNo)) === stem);
              });
          return writeScaffoldFiles({ io, files: built.files, targetDir, only });
        },

        async detect(rootDir: string): Promise<boolean> {
          // 特征组合：口上域主路由文件 + CHARA CSV 目录（同时存在才成局）
          const routeFile = join(rootDir, ...ERAAKUMA_MAID.detect.kojoRouteFile);
          if (!(await io.exists(routeFile))) return false;
          const charaDir = join(rootDir, ...ERAAKUMA_MAID.detect.charaCsvDir);
          return io.exists(charaDir);
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERAAKUMA_MAID.detect.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERAAKUMA_MAID.paths.kojoRoot);

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
            (e) => !e.isDirectory && /\.csv$/i.test(e.name) && ERAAKUMA_MAID.charaCsvPattern.test(e.name),
          );

          for (const entry of csvFiles) {
            const noFromName = parseCharaNoFromFileName(entry.name, ERAAKUMA_MAID.charaCsvPattern);
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
            // 名称回退链：名前 行 → 文件名剩余部分 → `CHARA{n}`（显式回退，绝不静默丢弃）。
            // AM 文件名是 `CHARA{n}.csv`——编号后直接结尾、**无「空格+名称」段**
            // （eraTW 的 `Chara{n} {名前}.csv` 形态不适用）⇒ 实测 nameFromFile 恒为
            // ''，回退按游戏自有命名给 `CHARA{n}`；`\s*` 保留给将来带名称段的文件名兜底。
            const nameFromFile = entry.name.replace(/\.csv$/i, '').replace(/^CHARA\d+\s*/i, '').trim();
            const info: CharaInfo = {
              no,
              name: parsed.name ?? (nameFromFile.length > 0 ? nameFromFile : `CHARA${no}`),
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. 口上域角色目录 → 绑定 kojoDir ----
          const kojoEntries = await io.listDir(kojoRoot);
          let bound = 0;
          for (const e of kojoEntries) {
            if (!e.isDirectory) continue;
            inputParts.push(`kojoDir\u0000${e.name}`);
            const parsed = parseKojoDirName(e.name);
            let no: number | null = parsed?.no ?? null;
            // 命名回退：目录名不带编号（纯角色名目录）时，按目录内
            // `EVENT_K{n}*.ERB` 文件名反推编号（与路由 `_K{NO:TARGET}` 同口径）
            const label = parsed?.label ?? e.name;
            if (parsed === null) {
              let names: string[] = [];
              try {
                const inner = await io.listDir(e.path);
                names = inner.filter((d) => !d.isDirectory).map((d) => d.name);
              } catch (err) {
                ctx.log.debug(`口上角色目录列举失败（按无编号处理）：${e.path} — ${String(err)}`);
              }
              no = deriveCharaNoFromFileNames(names);
            }
            if (no === null) {
              ctx.log.warn(`口上角色目录名不符合「{编号} {名称}」约定（跳过）：${e.name}`);
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

          // ---- 3. 变量字典（CSV 主表 + .als 追加 + .ERH 作者自定，三层） ----
          // 市场字典包（KM-15）：第三轮追加名表。市场缺席 / 读取失败 / 无字典包
          // ⇒ 空列表，与"无市场"逐字一致；项目加载不因市场出声而挂。
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
          currentSchema = await loadErakumamaidVariableSchema({
            io,
            csvDir: join(rootDir, ...ERAAKUMA_MAID.csvDir),
            // 作者自定名表（FT-1）：从整个 ERB 根递归扫 `.ERH`
            erbDir: join(rootDir, ...ERAAKUMA_MAID.erbDir),
            // 市场字典包追加名表（空 = 连这个键都不带）
            ...(marketAppendDirs.length > 0 ? { marketAppendDirs } : {}),
            log: ctx.log,
          });

          // ---- 4. 口上调用协议（路由表 → 槽位语义表；失败降级 undefined） ----
          currentProtocol = await loadErakumamaidCallProtocol({
            io,
            routeFile: join(rootDir, ...ERAAKUMA_MAID.paths.kojoMessageRoute),
            log: ctx.log,
          });

          // ---- 5. 指令名表（CSV/TRAIN.csv → 名 ↔ 编号；缺表/读失败 = 空表，不抛） ----
          currentInstructionTable = await loadErakumamaidInstructionTable({
            io,
            csvDir: join(rootDir, ...ERAAKUMA_MAID.csvDir),
            log: ctx.log,
          });

          ctx.log.info(
            `eraAkumaMaid 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERAAKUMA_MAID.gameId,
            kojoPaths: [kojoRoot],
            // eraAkumaMaid 无静态 sav/ 目录（运行期才生成）⇒ 不提议 savDir 及其可写
            writablePaths: [kojoRoot],
            charaIndex,
            // 派生缓存判据的一部分：本次加载实际吃进的非 ERB 输入
            inputDigest: combineDigests([foldDigest(inputParts), currentSchema.inputDigest]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERAAKUMA_MAID.gameId}-adapter`, adapter });

      /* ================= 「我的口上项目」面板与向导族 =================
       *
       * 窗口、面板、包操作全部来自共享层 `@kojo/kojo-project-kit`；本段只做
       * **宿主接线**：把内核服务接进来、把本游戏的脚手架供数递进去、把 overlay
       * 注册到本 adapter 的命名空间下。
       *
       * 这一段与 eratw-adapter 的同名段落结构一致但**不共享代码**——它是宿主
       * 组合根（谁注入什么、监听哪些事件是各游戏自己的事），共享的是它下面
       * 那层窗口与判据。审计 B/C 项也不允许插件互相 import。
       */

      /* ---- 面板状态（项目列表 / 目录缓存 / 署名缓存共用一条通知源） ---- */

      let wsProjects: readonly WorkspaceProject[] = [];
      let wsLoading = false;
      let wsError: string | null = null;
      const wsListeners = new Set<() => void>();
      /** 目录列举缓存（按绝对路径惰性加载；变更动作后整体失效） */
      const wsDirCache = new Map<string, DirListState>();
      /** 署名 / 授权缓存（null = 读失败，已降级为「未标注」） */
      const wsAttrCache = new Map<string, AttributionState>();

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

      /** 目录缓存整体失效 + 项目列表重拉（新建 / 导入 / 部署后调用） */
      const invalidateWs = (): void => {
        wsDirCache.clear();
        wsAttrCache.clear();
        refreshWsProjects();
      };

      /** 只重拉一个目录（新建文件后不必把整棵树清掉） */
      const refreshDir = (absDir: string): void => {
        wsDirCache.delete(absDir);
        ensureWsDir(absDir);
      };

      /**
       * 外部改动落在工作区的哪一层（AM-1 P5 批接线；判据本身在共享包）。
       *
       * 之前 `wsDirCache` 只被**本插件自己的动作**失效（`createItem → refreshDir` /
       * `invalidateWs`），于是作者用资源管理器往包里丢文件、或直接在磁盘上改包名时，
       * 面板一直显示旧内容——用户感知是"面板卡住"，但重开就好，这类问题最难被报上来。
       * 期望是那一批制造的，收口也该是它：订阅 `file.changed`，按共享层算出的目标重列。
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
              refreshDir(cached);
              break;
            }
          }
        }),
      );

      const ensureWsAttribution = (absDir: string): void => {
        if (wsAttrCache.has(absDir)) return;
        wsAttrCache.set(absDir, 'loading');
        void readPackageAttribution({ io, absDir })
          .then((a) => {
            wsAttrCache.set(absDir, a);
            notifyWs();
          })
          .catch((err: unknown) => {
            // 署名读不到不是操作失败：静默降级为「未标注」，日志留痕
            ctx.log.debug(`署名抽取失败（${absDir}）：${String(err)}`);
            wsAttrCache.set(absDir, null);
            notifyWs();
          });
      };

      /* ---- 包操作（导出 / 部署共用一条状态条） ---- */

      /**
       * `.kojo` → 产物字节。**点击时才 tryInject**：语法糖插件被停用时，
       * 浏览/导出无 `.kojo` 的包应照常工作，不把它写成 `requires` 硬依赖。
       */
      const compileKojo: KojoCompiler = (source, label) => {
        const sugar = ctx.tryInject<SugarTranspileService>(WellKnownServices.SugarTranspile);
        if (!sugar) {
          throw new Error(`「${label}」需要 .kojo 转译服务（kojo-sugar 插件未启用），无法转成成品`);
        }
        return sugar.compileToBytes(source, undefined, label);
      };

      const actions = createPackageActions({ io, log: ctx.log, notify: notifyWs, compileKojo });
      ctx.onDispose(() => actions.dispose());

      /* ---- 三条请求：新建（带关联号）/ 导入 / 发布 ---- */

      /** 待部署请求（overlay 组件无 props，payload 不经组件——读插件闭包） */
      let pendingDeploy: PendingDeploy | null = null;

      const requestDeploy = (artifact: WorkspaceArtifact, absDir: string): void => {
        const metaCharaNo = artifact.meta.charaNo;
        pendingDeploy = {
          absDir,
          dirName: artifact.dirName,
          displayName: artifact.name,
          // 新建向导写在制品 meta 里的角色号 → 自动预选；导入的包没有，留给用户挑
          ...(typeof metaCharaNo === 'number' ? { charaNo: metaCharaNo } : {}),
        };
        ctx.bus.emit('ui.overlay.open', { id: DEPLOY_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' });
      };

      /** 待导入请求 */
      let pendingImport: PendingImport | null = null;

      /**
       * 新建向导的「谁叫我开的」关联号：发起方经 `workspace.newProjectRequested`
       * 送来，创建成功时原样带进 `workspace.projectCreated`。
       * **向导一关就清空** ⇒ 被取消的请求不会在下一次无关的创建里兑现。
       */
      let projectRequestToken: string | null = null;

      ctx.onDispose(
        ctx.bus.on('workspace.newProjectRequested', (ev) => {
          projectRequestToken = readRequestToken(ev);
          ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eraakumamaid-adapter' });
        }),
      );

      const emitProjectCreated = (projectId: string, requestToken?: string): void => {
        ctx.bus.emit('workspace.projectCreated', {
          projectId,
          ...(requestToken !== undefined ? { requestToken } : {}),
          source: 'eraakumamaid-adapter',
        });
      };

      ctx.onDispose(
        ctx.bus.on('workspace.importRequested', (ev) => {
          pendingImport = {
            sourceDir: ev.sourceDir,
            ...(ev.suggestedName !== undefined ? { suggestedName: ev.suggestedName } : {}),
            ...(ev.source !== undefined ? { source: ev.source } : {}),
          };
          ctx.bus.emit('ui.overlay.open', { id: IMPORT_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' });
        }),
      );

      ctx.onDispose(
        ctx.bus.on('market.publishRequested', () => {
          ctx.bus.emit('ui.overlay.open', { id: PUBLISH_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' });
        }),
      );

      /** 系统目录对话框选定 → 发既有的导入意图（命令面板与面板按钮同一个身体） */
      const pickAndRequestImport = async (source: string): Promise<void> => {
        let picked: string | null;
        try {
          picked = await io.chooseWorkspaceRoot({ title: '选择要导入的作者包文件夹' });
        } catch (err) {
          ctx.log.error(`「从文件夹导入口上项目」打不开目录选择对话框：${String(err)}`);
          return;
        }
        // 取消是用户自己的动作，安静返回（不补一句"已取消"当噪音）
        if (picked === null) return;
        const suggestedName = basename(picked);
        ctx.bus.emit('workspace.importRequested', {
          sourceDir: picked,
          ...(suggestedName.length > 0 ? { suggestedName } : {}),
          source,
        });
      };

      ctx.slots.register('editor.command', {
        // id 归本游戏命名空间（与 overlay-ids 同一口径）：eratw-adapter 恒在场且已注册
        // 同款导入命令，裸 `kojo.importKojoProject` 会在激活时撞上同槽同 id 被内核抛错，
        // 连带回滚本插件全部贡献——eraAkumaMaid 项目从此无法识别。
        id: 'eraakumamaid.importKojoProject',
        title: '从文件夹导入口上项目…',
        category: '文件',
        run: () => pickAndRequestImport('command-palette'),
      });

      /* ---- 新建条目（面板右键菜单） ---- */

      const createItem = async (
        absDir: string,
        rawName: string,
        kind: NewItemKind,
      ): Promise<{ ok: true; path: string; displayName: string } | { ok: false; reason: string }> => {
        const resolved = resolveNewItemPath(absDir, rawName, kind);
        if (!resolved.ok) return resolved;
        if (!io.isWritable(resolved.absPath)) {
          return { ok: false, reason: `目标不在可写范围内：${resolved.absPath}` };
        }
        if (await io.exists(resolved.absPath)) {
          return { ok: false, reason: `已存在同名条目，未覆盖：${resolved.displayName}` };
        }
        try {
          if (kind === 'folder') {
            await io.ensureDir(resolved.absPath);
          } else {
            // 建**空文件**：内容留给作者写（与脚手架"不生成活函数"同一口径）
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

      /* ---- 面板（本游戏没有内置教程 ⇒ 不传 openTutorial，教程区整块不渲染） ---- */

      ctx.slots.register('ui.panel', {
        // 同上：面板贡献 id 也归本游戏命名空间——eratw 的「我的口上项目」面板已占
        // `kojo-projects`，这里再叫同一个名字就是激活即撞。两块面板并存是本意
        // （各游戏各一块，与 overlay 的 gameId 前缀口径一致）。
        id: 'eraakumamaid.kojo-projects',
        title: '我的口上项目',
        icon: 'home',
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
            ctx.bus.emit('editor.revealLocation', { filePath: absPath, source: 'eraakumamaid-adapter' }),
          openNewWizard: () =>
            ctx.bus.emit('ui.overlay.open', { id: NEW_KOJO_PROJECT_OVERLAY_ID, source: 'eraakumamaid-adapter' }),
          openImportWizard: () => pickAndRequestImport('projects-panel'),
          status: () => actions.status(),
          dismissStatus: () => actions.dismiss(),
          exportArtifact: (absDir, displayName) => actions.exportArtifact(absDir, displayName),
          deployArtifact: (artifact, absDir) => requestDeploy(artifact, absDir),
          attribution: (absDir) => wsAttrCache.get(absDir),
          ensureAttribution: ensureWsAttribution,
          createItem,
        }),
      });

      /* ---- 四个向导（创建顺序 20-23 与面板按钮顺序一致） ---- */

      ctx.slots.register('ui.overlay', {
        id: NEW_KOJO_PROJECT_OVERLAY_ID,
        order: 20,
        component: createNewKojoProjectWizard(
          withAmScaffold({
            workspaces,
            io,
            project,
            close: () => {
              ctx.bus.emit('ui.overlay.close', {
                id: NEW_KOJO_PROJECT_OVERLAY_ID,
                source: 'eraakumamaid-adapter',
              });
              projectRequestToken = null;
            },
            // 模板来源：已装 `template-pack` 投影成下拉条目；取不到按"没有模板包"处理
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
        ),
      });

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
            ctx.bus.emit('ui.overlay.close', { id: IMPORT_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' }),
          onImported: invalidateWs,
          projectCreated: (projectId) => emitProjectCreated(projectId),
          loadAttribution: (absDir, source) =>
            readSourceAttribution({ io, absDir, ...(source !== undefined ? { source } : {}) }),
        }),
      });

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
            ctx.bus.emit('ui.overlay.close', { id: DEPLOY_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' }),
          deploy: (pkg, target) => actions.deployArtifact(pkg, target),
        }),
      });

      ctx.slots.register('ui.overlay', {
        id: PUBLISH_KOJO_OVERLAY_ID,
        order: 23,
        size: 'wide',
        component: createPublishKojoWizard({
          workspaces,
          io,
          compileKojo,
          market: tryMarket,
          close: () =>
            ctx.bus.emit('ui.overlay.close', { id: PUBLISH_KOJO_OVERLAY_ID, source: 'eraakumamaid-adapter' }),
          // 外链只发意图：宿主落地（闸的唯一执法点在 Rust，插件不开窗）
          openExternal: (url) => ctx.bus.emit('ui.openExternal', { url }),
        }),
      });

      /**
       * 检索范围：角色级收窄（AM-1 P5 批）。
       *
       * 判据（`CharaInfo.kojoDir` → 该角色的检索根）住在共享包 `charaSearchScopeOptions`：
       * 它只吃契约字段，两个 adapter 共用同一份投影。宿主全文检索只认 `label` + `roots`
       * 两样泛型事实——对它而言"只看某个角色"与"用户少选了几个目录"没有区别。
       *
       * 只认本项目：`adapterId` 不是自己的 ⇒ 空候选 ⇒ 宿主不画选择器（默认关）。
       * `order: 10` 与 eratw 同值：两个 adapter 同时在场时按项目归属过滤，不靠 order 分胜负。
       */
      ctx.slots.register('search.scope', {
        id: `${ERAAKUMA_MAID.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERAAKUMA_MAID.gameId
            ? charaSearchScopeOptions(project.charaIndex.values())
            : [],
      });

      refreshWsProjects();

      /**
       * 名称解析 memo 随项目关闭清空（§5.73）。
       * 纯函数缓存，清空不改变任何判定，只是下一遍重新解析。
       */
      ctx.onDispose(ctx.bus.on('project.closed', () => clearKojoFamilyMemo()));
    },
  };
}
