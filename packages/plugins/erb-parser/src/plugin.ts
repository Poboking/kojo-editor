import type {
  ComputePool,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  ErbParserService,
  FileIO,
  FileStat,
  GameProject,
  LineDecoration,
  Plugin,
} from '@kojo/plugin-api';
import { KernelServices, isErbDialectPath, projectFingerprintOf } from '@kojo/plugin-api';
import { PARSE_FILE_TASK, SCAN_FLOW_TASK, erbParserTasks, type ParseFilePayload, type ScanFlowPayload } from './offload';
import { parseErbText, scanControlFlow } from './scanner';
import { checkControlFlowStructure } from './structure';
import { buildStructureFixes } from './structure-fix';
import { definitionTargetsAt, functionAt } from './symbols';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  diffSnapshot,
  encodeEntries,
  mergeEntries,
  pruneSnapshotKeys,
  snapshotKeyFor,
  type IndexSnapshot,
  type SnapshotEntry,
} from './snapshot';

/**
 * erb-parser 插件。
 *
 * - 服务键：`erb.parser`（provides）
 * - 依赖：`kernel.io`（读文件 + 目录遍历；自动处理编码探测）
 * - 零游戏知识：不识别任何 `M_KOJO` 之类的命名约定（那是 game.adapter 的领域）
 *
 * v0.2 —— **索引所有权收敛到解析器**（架构文档 §5.7「响应式，不是中心式流水线」）：
 * 订阅 `project.opened` 自动构建索引并缓存，构建完成发 `kojo.functionChanged`；
 * 消费方（函数树 / 校验器 / 面板）订阅事件或调用 `currentIndex()` / `ensureIndex()`
 * 取用，无需各自重复构建。
 *
 * 2026-10-12「内核优化」批 —— **索引快照 + 增量复扫**（例 1：第二次开项目不用再等）：
 * 文件没变（mtime 一致）时直接复用上次的解析结果，只重扫变过的文件。
 * 设计与纪律见 `./snapshot.ts` 头注（fail-closed / 保守失效 / 顺序确定）。
 */

const IO = 'kernel.io';
/**
 * 「哪些文件算 ERB 方言」一律问契约层的单一真源（`plugin-api/erb-ext`，FT-2 收口）。
 *
 * 2026-10-14 起口径**含 `.ERH`**（引擎预载白名单认它是脚本文件，实测口上根内 31 份、
 * 内容只有 `#DIM` / `#DIMS`）：索引文件数随之增加，而函数树不变——声明文件 0 个 `@` 定义，
 * 这条不变量由 `tests/erh-index.corpus.test.ts` 在真语料上钉死。
 */
const isDialect = isErbDialectPath;

/** 索引三段（walk 之外）的窗口并发度：stat 轻、parse 重 */
const STAT_CONCURRENCY = 32;
const PARSE_CONCURRENCY = 12;
/** 片预算：半个 60fps 帧（与计算池默认一致） */
const SLICE_MS = 8;

export function createErbParserPlugin(): Plugin {
  return {
    id: 'erb-parser',
    version: '0.2.0',
    provides: ['erb.parser'],
    requires: [IO, KernelServices.Compute],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);
      /**
       * 计算池（内核优化批）：索引是"开项目级联"的第一段，2,317 个文件 / 362 万行
       * 的 walk+stat+parse 必须**分片让路**，否则用户开项目后几秒内打字必卡。
       * 用 `concurrency` 保住 IPC 并行度，窗口之间让出主线程。
       */
      const compute = ctx.inject<ComputePool>(KernelServices.Compute);
      // 注册可搬运任务：本地实现 = 无并行通道（或通道失败）时的回退路径；
      // worker 侧由装配层用**同一份表**（`erbParserTasks`）注册，避免映射漂移。
      for (const [kind, impl] of Object.entries(erbParserTasks)) compute.registerTask(kind, impl as never);
      /** 本插件命名空间的存储域：索引快照的落点（`{appData}/store/erb-parser/`） */
      const storage = ctx.storage;

      /** 当前索引（未打开项目 / 未构建时为 null） */
      let index: ErbIndex | null = null;
      /** 在途构建（并发调用 ensureIndex 时共享同一 Promise） */
      let inFlight: Promise<ErbIndex> | null = null;
      /** 当前口上根（由 project.opened 提供） */
      let roots: string[] = [];
      /** 当前项目根（事件载荷用） */
      let currentRoot = '';
      /** 代际号：项目切换时作废过期构建的结果 */
      let generation = 0;

      /**
       * 磁盘卫生：索引快照统一成**单文件语义**，只留当前项目这一份。
       * 与抽取 / 校验两段的覆盖式行为对齐，顺带清掉格式升级留下的 `index-v1-*` / `v2-*` 孤儿。
       * 纯清理动作，失败只记一行——缓存回收不该影响索引正确性。
       */
      function pruneStaleSnapshots(keepKey: string): void {
        void (async () => {
          try {
            const doomed = pruneSnapshotKeys(await storage.keys(), keepKey);
            for (const k of doomed) await storage.delete(k);
            if (doomed.length > 0) ctx.log.info(`Index snapshot store pruned (${doomed.length} stale key(s))`);
          } catch (err) {
            ctx.log.warn(`Index snapshot prune failed (cache hygiene only): ${String(err)}`);
          }
        })();
      }

      async function build(rootsToScan: string[], gen: number, useSnapshot: boolean): Promise<ErbIndex> {
        // 耗时拆分（内核优化 L0）：索引是"开项目级联"的第一段，必须在日志里可见。
        // 每段单独计时——上一轮"热启动 stat 872ms"的疑点就是因为快照读盘被并进了 stat 区间。
        const buildStartedAt = Date.now();
        const allFiles: string[] = [];
        /**
         * `walkDir({withMetadata})` 顺带带回的元数据（IMPLEMENTATION-LOG §5.117）：
         * 热开段实测 `stat` 独占 2,038ms / index 2,657ms，全部是 2,285 次逐文件 IPC 往返；
         * 遍历目录时元数据本就在手边，一次带回就把那一整段折进 walk。
         */
        const metaByPath = new Map<string, { mtimeMs: number; size: number }>();
        for (const root of rootsToScan) {
          const entries = await io.walkDir(root, {
            includeFiles: true,
            includeDirs: false,
            withMetadata: true,
            filter: (e) => e.isDirectory || isDialect(e.name),
          });
          for (const e of entries) {
            if (e.isDirectory || !isDialect(e.name)) continue;
            allFiles.push(e.path);
            if (typeof e.mtimeMs === 'number' && typeof e.size === 'number') {
              metaByPath.set(e.path, { mtimeMs: e.mtimeMs, size: e.size });
            }
          }
        }
        const walkMs = Date.now() - buildStartedAt;

        // 体量指纹：mtime 是增量复扫的判据——mtime 没变的文件，解析结果必然不变（纯函数）。
        // 首选 walk 带回的值；**缺项才逐文件 stat 兜底**（桥没实现 withMetadata / 个别取不到），
        // 兜底也不许伪造：拿不到 stat ⇒ null ⇒ 该文件一律判过期（保守）。
        const statStartedAt = Date.now();
        const stats = new Map<string, FileStat | null>();
        const needStat: string[] = [];
        for (const path of allFiles) {
          const meta = metaByPath.get(path);
          if (meta) stats.set(path, { size: meta.size, mtimeMs: meta.mtimeMs, isDirectory: false });
          else needStat.push(path);
        }
        await compute.runSliced(
          needStat,
          { concurrency: STAT_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.stat' },
          async (path) => {
            try {
              stats.set(path, await io.stat(path));
            } catch {
              stats.set(path, null); // stat 失败 = 判过期（保守）
            }
          },
        );
        const statMs = Date.now() - statStartedAt;
        // 项目体量指纹：stat 已经逐文件做过，这里只是把它汇成一个判据给下游派生缓存
        // （条件抽取 / 约定校验）。任一文件取不到 stat ⇒ null ⇒ 下游一律不命中。
        const fingerprint = projectFingerprintOf(
          allFiles.map((path) => {
            const st = stats.get(path);
            return { path, mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? null };
          }),
        );

        // 快照：只在项目响应式路径启用（service.buildIndex 的显式调用 = 强制重建）
        let snapshot: IndexSnapshot | null = null;
        const snapStartedAt = Date.now();
        let snapGetMs = 0;
        let snapCoerceMs = 0;
        if (useSnapshot && currentRoot) {
          const key = snapshotKeyFor(currentRoot);
          try {
            // get 内含「读盘 + decode + JSON.parse」——体积过大时这一项就是热启动的主要成本
            const getStartedAt = Date.now();
            const raw = await storage.get<unknown>(key);
            snapGetMs = Date.now() - getStartedAt;
            if (raw === undefined) {
              snapshot = null; // 首次打开 / 无快照 → 全量（正常路径）
            } else {
              const coerceStartedAt = Date.now();
              snapshot = coerceSnapshot(raw, currentRoot);
              snapCoerceMs = Date.now() - coerceStartedAt;
              if (snapshot === null) {
                // fail-closed：版本/结构/项目根任一不符 → 删除 + 全量重建，绝不"修"快照
                ctx.log.warn('Index snapshot unusable (version/structure/root mismatch); rebuilding from scratch');
                void storage.delete(key).catch(() => undefined);
              }
            }
          } catch (err) {
            ctx.log.warn(`Index snapshot read failed; rebuilding from scratch: ${String(err)}`);
            snapshot = null;
          }
        }
        const snapMs = Date.now() - snapStartedAt;

        const diff = snapshot ? diffSnapshot(snapshot, allFiles, stats) : { reusable: [], stale: allFiles };

        const parseStartedAt = Date.now();
        const fresh = new Map<string, SnapshotEntry>();
        await compute.runSliced(
          diff.stale,
          { concurrency: PARSE_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.parse' },
          async (path) => {
            try {
              // IO 留主线程（worker 内 IPC 未验证），**只把纯解析**搬上并行通道：
              // 有 worker 时是真并行（多槽轮转），无 worker / 通道失败时自动内联回退。
              const tf = await io.readText(path);
              const payload: ParseFilePayload = { text: tf.text, path };
              const file = await compute.offload<ErbFile>(PARSE_FILE_TASK, payload);
              fresh.set(path, { mtimeMs: tf.mtimeMs, textLength: tf.text.length, file });
            } catch (err) {
              ctx.log.warn(`Parse failed: ${path}: ${String(err)}`);
            }
          },
        );
        const parseMs = Date.now() - parseStartedAt;

        // 合并：按本次 walk 顺序取数（快照只换"来源"，byName 聚合顺序与全量重建逐位一致）
        const aggStartedAt = Date.now();
        const ordered: ErbFile[] = [];
        // 逐文件 mtime 顺手记下来（同源：重扫文件用 readText 的、复用文件用快照的）——
        // 下游条件抽取按文件粒度复用结果时，只有整项目指纹会出现"改一个文件重算全库"
        const fileMtimes = new Map<string, number | null>();
        for (const path of allFiles) {
          const parsed = fresh.get(path);
          if (parsed?.file) {
            ordered.push(parsed.file);
            fileMtimes.set(path, parsed.mtimeMs);
            continue;
          }
          const old = snapshot?.entries[path];
          if (old?.file) {
            ordered.push(old.file);
            fileMtimes.set(path, old.mtimeMs);
          }
        }
        const { files, byName } = aggregateIndex(ordered);
        const aggMs = Date.now() - aggStartedAt;

        ctx.log.info(
          `Indexed ${files.size} ERB files, ${byName.size} distinct functions from ${rootsToScan.length} root(s) ` +
            `in ${Date.now() - buildStartedAt}ms`,
        );
        ctx.log.info(
          `  index breakdown: walk ${walkMs}ms · stat ${statMs}ms · snapshot ${snapMs}ms ` +
            `(get ${snapGetMs}ms, coerce ${snapCoerceMs}ms) · read+parse ${parseMs}ms · aggregate ${aggMs}ms · ` +
            `mtime 来源 walk顺带 ${metaByPath.size} / 兜底逐文件 ${needStat.length} · ` +
            `reused ${diff.reusable.length}/${allFiles.length}`,
        );

        // 落盘快照（异步，不阻塞广播；失败只告警——它只是缓存，不是数据）
        const snapshotDirty =
          fresh.size > 0 || (snapshot !== null && Object.keys(snapshot.entries).length !== allFiles.length);
        if (useSnapshot && currentRoot && gen === generation) {
          const key = snapshotKeyFor(currentRoot);
          if (snapshotDirty) {
            const entries = mergeEntries(snapshot, allFiles, fresh);
            const saveStartedAt = Date.now();
            void storage
              .set(key, {
                version: SNAPSHOT_VERSION,
                rootDir: currentRoot,
                savedAt: Date.now(),
                // 盘上用 v3 紧凑元组（剥可派生字段 + 位置化），加载时由 decodeEntries 还原
                entries: encodeEntries(entries),
              })
              .then(() => {
                ctx.log.info(
                  `Index snapshot saved (${Object.keys(entries).length} entries, key ${key}, ` +
                    `${Date.now() - saveStartedAt}ms)`,
                );
                pruneStaleSnapshots(key);
              })
              .catch((err: unknown) => {
                ctx.log.warn(`Index snapshot save failed: ${String(err)}`);
              });
          } else {
            // 没变更也要收口：磁盘上可能躺着别的项目的快照或旧版本孤儿
            pruneStaleSnapshots(key);
          }
        }

        // 仅在仍是当前代际时提交（避免项目快速切换导致旧结果覆盖新结果）
        if (gen !== generation) return { files, byName, fingerprint, fileMtimes };

        const built: ErbIndex = { files, byName, fingerprint, fileMtimes };
        index = built;
        ctx.bus.emit('kojo.functionChanged', {
          projectRoot: currentRoot,
          files: [...files.keys()],
        });
        return built;
      }

      function startBuild(gen: number): Promise<ErbIndex> {
        const p = build(roots, gen, true).finally(() => {
          if (inFlight === p) inFlight = null;
        });
        inFlight = p;
        return p;
      }

      const service: ErbParserService = {
        async parseFile(path: string): Promise<ErbFile> {
          const tf = await io.readText(path);
          return parseErbText(tf.text, path);
        },

        parseText: (text: string, path?: string) => parseErbText(text, path),

        scanControlFlow: (text: string) => scanControlFlow(text),

        // 结构体检（2026-10-13 UI 反馈 7）：与骨架扫描共用 scanner 的配对表与行过滤规则，
        // 纯文本入、纯数据出——编辑器去抖后经 ui.editor.decorator 调它，不读盘也不碰索引。
        checkStructure: (text: string) => checkControlFlowStructure(text),

        // 走计算池的并行通道（无通道/失败自动内联）；消费方不需要知道 kind 与 worker
        scanControlFlowOffloaded: (text: string) =>
          compute.offload<ControlFlowStatement[]>(SCAN_FLOW_TASK, { text } satisfies ScanFlowPayload),

        buildIndex: (rootsToScan: string[]) => build(rootsToScan, generation, false),

        currentIndex: () => index,

        async ensureIndex(): Promise<ErbIndex> {
          if (index) return index;
          // 项目切换会立刻作废旧在途构建并替换 inFlight，因此共享 inFlight 是安全的
          if (inFlight) return inFlight;
          if (roots.length === 0) throw new Error('No project is open; cannot build the ERB index');
          return startBuild(generation);
        },

        // 位置 → 符号（B0）：只读已构建的索引，不读盘；未构建 → undefined（不猜）
        functionAt: (path: string, line: number) => (index ? functionAt(index, path, line) : undefined),
      };

      // 响应式：项目打开 → 自动构建；项目关闭 → 清空
      ctx.onDispose(
        ctx.bus.on('project.opened', (ev) => {
          const project: GameProject = ev.project;
          currentRoot = project.rootDir;
          roots = [...project.kojoPaths];
          index = null;
          generation++;
          ctx.log.info(`Project opened; indexing ${roots.length} root(s)…`);
          // 不阻塞事件（构建可能数秒）；结果通过 kojo.functionChanged 广播
          void startBuild(generation).catch((err: unknown) => {
            ctx.log.error(`Index build failed: ${String(err)}`);
          });
        }),
      );
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          index = null;
          roots = [];
          currentRoot = '';
          generation++;
        }),
      );

      ctx.provide('erb.parser', service);

      /* ---------------- 编辑器波浪线（2026-10-13 UI 反馈 7） ----------------

       为什么装饰器由**解析器插件自己**注册，而不是放进某个 UI 插件：
       判据与配对表同源才能不漂移（表在 `scanner.ts`），而 `ui.editor.decorator` 的契约是
       **纯函数**（文本进、行级装饰出，无 React、无 IO）——放这里既不引入新的跨插件依赖，
       也不把"哪些行算控制流语句"这件事外化成第二份知识。

       只管 ERB 方言全集（`isErbDialectPath` 同一条口径：正文 `.erb`/`.erm` + 声明 `.erh`）；
       `.kojo` 的语法诊断另有其人（糖线）。
       超大文件不降级、不跳过：判据是单遍线性扫描，实测读数见 IMPLEMENTATION-LOG 本批记录，
       真要限流也应该由宿主那侧的去抖/上限来做，不在这里悄悄少报。
       */
      ctx.slots.register('ui.editor.decorator', {
        id: 'erb-structure',
        title: 'ERB 结构错误波浪线',
        order: 20,
        decorate(file): LineDecoration[] {
          if (!isDialect(file.path) || file.text.length === 0) return [];
          return checkControlFlowStructure(file.text).map((issue) => ({
            line: issue.line,
            severity: 'error' as const,
            message: issue.message,
            code: `erb.${issue.kind}`,
          }));
        },
      });

      /* ---------------- 💡 一键补齐缺失的闭合语句（2026-10-13 反馈 7 的第二步） ----------------

       波浪线说"少一个 ENDIF"，但**补在哪一行**对新手是更难的一半：补在 `IF` 紧后面与补在
       函数末尾都编译得过，语义却完全不同。本动作给出体检器判定的那个保守位置（这一层确定
       没关的地方），落地走宿主既有的 `EditorTextEdit` 通道 = 一次可撤销的 model 编辑，
       **不碰磁盘**（保存仍由用户 Ctrl+S 决定）。

       门槛两条，都是"不确定就不给动作"：
       - 只对**能写**的路径供（`io.isWritable`）：游戏目录里的 ERB 默认只读，Monaco 的
         `executeEdits` 却照样能改缓冲区 ⇒ 不挡就会造出一个"只读文件被改脏"的怪状态。
         轴二解锁那一份也拿不到动作（插件看不见宿主的会话解锁态），这是刻意的保守。
       - 只对 `unclosed-open` 供：孤儿闭合 / 无主分支也可能是"我们把函数边界漏判了"，
         据一条不确定的推断去删用户写好的行不做（见 `structure-fix.ts` 头注）。
       */
      ctx.slots.register('ui.editor.codeAction', {
        id: 'erb-structure-fix',
        order: 30,
        provideActions: ({ path, text, line }) => {
          if (!isDialect(path) || text.length === 0) return [];
          // 位置未知就不猜：本包的动作**天生按行**（波浪线在哪行，💡 就在哪行给），
          // 少了这个约束会把几十条动作灌进同一个菜单。
          if (line === undefined) return [];
          if (!io.isWritable(path)) return [];
          return buildStructureFixes(text, line).map((fix) => ({
            title: fix.title,
            kind: 'quickfix' as const,
            edits: fix.edits,
            // 有 `edits` 时宿主不调 `run`；仍给以满足契约（并在无改写通道的宿主下无害退化）
            run: () => undefined,
          }));
        },
      });

      /* ---------------- 转到定义（2026-10-15 语言服务批） ----------------

       为什么由解析器插件自己应答：判据（"光标处那个名字是不是本项目的一个函数"）
       只有 `ErbIndex.byName` 说了算。放进任何别的插件都得先拿到索引，等于把同一份
       判据抄第二遍、并在项目开闭时机上与解析器赛跑。

       数据面只有两件事：光标处记号（`symbolTokenAt`）＋ `byName` 反查；跨文件怎么
       跳由**宿主**决定（插件只给"文件:行"，不碰导航——宿主那条 `editor.revealLocation`
       通道已经能开文件定位，不新造机制）。

       三态返回（见契约 `EditorLanguageServiceContribution`）：非 ERB 方言或未打开
       项目 → `undefined`（不是本包的活）；认这个文件但记号不在索引里 → 空数组
       （**不猜**，作者会看到"没有定义"，而不是被跳到错地方）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-definition',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'definition') return undefined;
          if (!isDialect(request.path)) return undefined;
          const idx = index;
          if (!idx) return undefined;
          const refs = definitionTargetsAt(idx, request.path, request.text, request.line, request.column);
          return {
            kind: 'definition',
            locations: refs.map((ref) => ({ filePath: ref.filePath, line: ref.startLine })),
          };
        },
      });
    },
  };
}
