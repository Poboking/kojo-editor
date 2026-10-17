import { createKernel, type Kernel } from '@kojo/kernel';
import type { Plugin } from '@kojo/plugin-api';
import { createWorkerTransport, WellKnownServices } from '@kojo/plugin-api';
import type { ConditionExtractorService, ConventionLinterService } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { version as APP_VERSION } from '../package.json';
import { tauriBridge } from './bridge/tauri-bridge';
import { computeTasks } from './compute-tasks';
import { createCascadeWatermarks } from './cascade-watermarks';
import { perf } from './perf';
// vite ?worker：并行计算线程入口（纯 CPU 任务搬出主线程）
import ComputeWorker from './compute-worker?worker';

/**
 * 应用引导：装配内核 + 插件清单。
 *
 * v0.1 的插件是编译期注册表（builtin）。接口按"运行时可加载"设计——
 * 未来加目录扫描 loader 时，本函数改为读取插件目录即可（装载接口预留来源字段）。
 *
 * PS-10 首屏批的切分口径（**不是** loader：装哪几个、按什么顺序仍是本文件的编译期名单；
 * `docs/BOARD.md §U` 废止的是"运行时扫描插件目录"，不是内置名单里的懒 `import()`）：
 * - **常驻（静态 import）**＝欢迎页 / 无项目态真吃得到的两个：
 *   `erb-parser`（App 开机就取 `erb.parser` 服务并订 `kojo.functionChanged`）、
 *   `eratw-adapter`（开任何项目都要它认目录；欢迎页的教程卡片与向导浮层全挂在它的
 *   `ui.overlay` / `ui.tutorial.open` 上）。
 * - **项目级（动态 import + `kernel.registerPlugin`）**＝其余 17 个。它们的可见面
 *   （面板 / 命令 / 状态栏 / 编辑器装饰器）只在项目态存在；拆分前的静态图里插件占
 *   2,817 KB 源码，两个常驻项只留 ~650 KB，剩下的没理由在 `boot.welcomeInteractive`
 *   之前被解析、求值。
 * - **装载时机**＝`App.openProject` 里 `kernel.project.open()` **之前**（见
 *   `ensureProjectPlugins`）：级联一开始 17 个插件就全部在场，所以面板顺序、命令面板
 *   内容、事件扇出、`compute` 任务表与拆分前一字不差——变的是"什么时候装"，不是"装了什么"。
 */
export async function bootstrapKernel(): Promise<Kernel> {
  const kernel = await createKernel({
    platform: tauriBridge,
    plugins: [
      // 通用解析能力（索引所有权在解析器，v0.2 起响应式）
      createErbParserPlugin(),
      // eraTW 领域知识（唯一知道游戏名的地方：家族识别 + 约定规则）
      createEratwAdapterPlugin(),
    ],
  });
  // 装配层任务表并入**宿主侧本地实现**（在 start 之前）：跨插件合成的 kind
  //（如 `erb.exprSyntaxDecorations`）没有任何插件会自己注册它，而 worker 挂了 /
  // 无并行通道时 `offload` 要能回落到本地实现——缺一条就是抛 "No local
  // implementation registered"。同 kind 重复注册是幂等的（各插件仍按自己的表注册）。
  for (const [kind, impl] of Object.entries(computeTasks)) kernel.compute.registerTask(kind, impl as never);
  // 并行运输层：**在 start 之前**接上，让首次索引构建就吃到多线程
  installComputeTransport(kernel);
  await kernel.start();
  installPerfProbe(kernel);
  return kernel;
}

/**
 * 项目级插件工厂清单（PS-10）。
 *
 * **顺序 = 拆分前静态装配清单去掉两个常驻项后的相对次序，一条不重排**：`requires` 图决定
 * 谁先激活，而同一趟扫描里的注册次序就是总线订阅与槽位贡献的先后（PITFALLS 105 的教训
 * 正是"次序与展开时机同轴"）。动态 `import()` 只推迟解析与求值，不改这份名单的含义。
 */
async function loadProjectPlugins(): Promise<Plugin[]> {
  const [
    linter,
    extractor,
    savParser,
    stateReplay,
    sugar,
    uiStatus,
    uiConventionReport,
    uiKojoNavigator,
    uiConditionMatrix,
    uiStateReplay,
    uiArchiveBrowser,
    uiSnapshotInjector,
    uiSugarLift,
    uiSugarPreview,
    uiSugarEditor,
    market,
    uiMarket,
  ] = await Promise.all([
    import('@kojo/plugin-convention-linter'),
    import('@kojo/plugin-condition-extractor'),
    import('@kojo/plugin-sav-parser'),
    import('@kojo/plugin-state-replay'),
    import('@kojo/plugin-kojo-sugar'),
    import('@kojo/plugin-ui-status'),
    import('@kojo/plugin-ui-convention-report'),
    import('@kojo/plugin-ui-kojo-navigator'),
    import('@kojo/plugin-ui-condition-matrix'),
    import('@kojo/plugin-ui-state-replay'),
    import('@kojo/plugin-ui-archive-browser'),
    import('@kojo/plugin-ui-snapshot-injector'),
    import('@kojo/plugin-ui-sugar-lift'),
    import('@kojo/plugin-ui-sugar-preview'),
    import('@kojo/plugin-ui-sugar-editor'),
    import('@kojo/plugin-kojo-market'),
    import('@kojo/plugin-ui-market'),
  ]);
  return [
    // 约定校验引擎（游戏无关）+ 结果为面板呈现
    linter.createConventionLinterPlugin(),
    // 条件谓词抽取（游戏无关；变量语义来自当前 adapter 的 variableSchema）
    extractor.createConditionExtractorPlugin(),
    // 存档解析（游戏无关；存档目录来自当前 adapter 的 GameProject.savDir）
    savParser.createSavParserPlugin(),
    // 状态回放（游戏无关；消费 snapshot.source + condition.extractor；
    // 具名索引字典来自当前 adapter 的 variableSchema）
    stateReplay.createStateReplayPlugin(),
    // 语法糖转译（游戏无关；中文表层关键字是跨游戏语言层，住在契约；
    // 时机分野命名模板与变量字典来自当前 adapter —— 纯函数，不触达工程状态）
    sugar.createKojoSugarPlugin(),
    // UI：面板（内核状态 + 校验结果 + 函数树导航 + 状态回放 + 归档浏览 + 状态注入）
    uiStatus.createUiStatusPlugin(),
    uiConventionReport.createUiConventionReportPlugin(),
    uiKojoNavigator.createUiKojoNavigatorPlugin(),
    uiConditionMatrix.createUiConditionMatrixPlugin(),
    uiStateReplay.createUiStateReplayPlugin(),
    uiArchiveBrowser.createUiArchiveBrowserPlugin(),
    // 状态注入器（写链路在 sav-parser 的 snapshot.writer；面板只做呈现 + 意图）
    uiSnapshotInjector.createUiSnapshotInjectorPlugin(),
    // 升糖预览器（识别在 kojo-sugar 的 sugar.lift；预览经 editor.liftPreview.show
    // 交宿主就地折叠显示，**纯前端不写盘**。排在 kojo-sugar 之后：它 require sugar.lift）
    uiSugarLift.createUiSugarLiftPlugin(),
    // 糖预览（只读观察面：转译 + 源映射 + 状态回放三向映射全在 kojo-sugar 的
    // sugar.preview；面板只做呈现。排在 kojo-sugar 之后）
    uiSugarPreview.createUiSugarPreviewPlugin(),
    // 糖编辑体验（v0.3 S6）：编辑器波浪线（ui.editor.decorator 贡献，宿主消费为
    // Monaco markers）+ 糖判定面板。语义全在 kojo-sugar 的 sugar.transpile（纯函数）
    // ——排在 kojo-sugar 之后（它 require sugar.transpile）
    uiSugarEditor.createUiSugarEditorPlugin(),
    // 口上市场 v1：服务 `market`（本地目录源装卸 + 逐文件 sha256 锚）。
    // appVersion 单一真源 = app 包清单（`packages/app/package.json`），插件源码不写版本号
    market.createKojoMarketPlugin({ appVersion: APP_VERSION }),
    // 市场面板（ui.panel）：消费 `market` 服务 ⇒ **必须排在 kojo-market 之后**
    // （装配语义照 ui-sugar-lift 的 requires: ['sugar.lift']，不 import 市场插件）
    uiMarket.createUiMarketPlugin({ appVersion: APP_VERSION }),
  ];
}

/** 进行中的项目级装载：多条开项目路径共用一个 promise ⇒ 幂等，且只求值一次 */
let projectPluginsTask: Promise<void> | null = null;
/** 项目级插件工厂的装载 promise（预热与注册共用：一次取字节、一次求值） */
let projectPluginsOnce: Promise<Plugin[]> | null = null;

function loadProjectPluginsOnce(): Promise<Plugin[]> {
  projectPluginsOnce ??= loadProjectPlugins().catch((err: unknown) => {
    projectPluginsOnce = null;
    throw err;
  });
  return projectPluginsOnce;
}

/**
 * 预热项目级插件块（PS-10 ③ 的配套）：**只取字节与求值，不注册**。
 *
 * 注册一步都不许提前——项目级插件的贡献（面板 / 命令 / 状态栏 / 编辑器装饰器）一落地
 * 就是欢迎页的可见面，那才是产品行为变化。这里做的只是把开项目时必然要付的解析成本
 * 挪到"用户已经表明要开项目"的那一刻，与 ProjectView / Monaco 块并行飞。
 */
export function prefetchProjectPlugins(): Promise<void> {
  return loadProjectPluginsOnce().then(() => undefined);
}

/**
 * 进项目之前把 17 个项目级插件装好并注册（PS-10）。
 *
 * 时机是**硬约束**：必须赶在 `kernel.project.open()` 之前完成——插件们挂在
 * `project.opened` 那一拍上（级联、快照还原、各自的 `compute` 任务表），事件之后再注册
 * 就是漏拍，那才是产品行为变化。`App.openProject` 是本仓唯一的开项目入口
 * （recent 点击 / 继续上次会话 / 崩溃恢复 / 拖入 / 换根确认全部汇到它）。
 *
 * 失败不静默：清掉缓存 promise 让下一次开项目重试，错误原样抛给开项目链路
 * （App 的错误条会把这句说出来）。重试前先问一遍已注册的 id——`runtime.register` 对
 * 同 id 是抛错，半途失败不能再变成必然失败。
 */
export function ensureProjectPlugins(kernel: Kernel): Promise<void> {
  projectPluginsTask ??= loadProjectPluginsOnce()
    .then(async (plugins) => {
      const registered = new Set(kernel.plugins.list().map((p) => p.id));
      for (const plugin of plugins) {
        if (registered.has(plugin.id)) continue;
        await kernel.registerPlugin(plugin);
      }
      // 条件 / 校验两个水位只有这两个插件在场才接得上（口径见 installPerfProbe 的分段说明）
      attachProjectPluginWatermarks(kernel);
    })
    .catch((err: unknown) => {
      projectPluginsTask = null;
      throw err;
    });
  return projectPluginsTask;
}

/**
 * 并行运输层接线（2026-10-12「内核优化」批）。
 *
 * 槽数 = `hardwareConcurrency - 1`（封顶 4、至少 1）：给主线程留一个核；
 * 单槽只是"换个线程跑"**不减少总 CPU**，多槽才有真提速（见
 * `plugin-api/src/compute-worker.ts` 头注）。worker 崩溃由池回退本地实现，
 * 不会让索引构建失败。
 */
function installComputeTransport(kernel: Kernel): void {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  const size = Math.max(1, Math.min(4, cores - 1));
  kernel.compute.attachTransport(createWorkerTransport(() => new ComputeWorker(), { size }));
}

/**
 * 性能探针接线（2026-10-12「内核优化 L0 批」+「体感丝滑批」扩展）。
 *
 * - 把探针挂到 `globalThis.__kojoPerf`（DevTools 里按需汇总，见 `perf.ts`）；
 * - 记录**开项目级联的三个用户水位**，全部相对 `project.opened` 起点：
 *   `cascade.projectOpened→index可用`（函数树的数据就绪）
 *   `→条件可用`（抽取摘要就绪，函数树徽章/条件矩阵依赖）
 *   `→校验有结果`（约定报告就绪，校验面板依赖）
 *   此前只量第一段，而真实语料里大头在抽取与校验——用户体感的"等十秒"是**三个水位
 *   里最晚那一个**，只报索引等于没报。
 * - 每个水位每次开项目只记首次达成（后续 functionChanged / subscribe 回调不重复计入），
 *   `project.opened` 重置资格 ⇒ 交替开项目也能逐次对比冷热。
 *   是否走了快照，看插件自己的日志（`restored from snapshot` / `reused N/N`）。
 * - **PS-10 分段**：`index` 一段的服务来自常驻的 erb-parser，开机即接；`条件 / 校验` 两段
 *   的服务由项目级插件提供，注册之前 `tryGet` 是 undefined ⇒ 订不上就不是"没值"而是
 *   "没订到"，读数会永远缺这两行。故拆到 `attachProjectPluginWatermarks`，由
 *   `ensureProjectPlugins` 在注册完成后补接（标记名与判据逐字不变）。
 */
let cascadeWatermarks: ReturnType<typeof createCascadeWatermarks> | null = null;

function installPerfProbe(kernel: Kernel): void {
  perf.install();
  const water = createCascadeWatermarks(
    (name, ms) => perf.record(name, ms),
    () => performance.now(),
  );
  cascadeWatermarks = water;

  kernel.bus.on('project.opened', () => water.projectOpened());
  kernel.bus.on('kojo.functionChanged', () => water.mark('index', 'cascade.projectOpened→index可用'));
}

/**
 * 项目级插件注册完成后补接的两个水位（PS-10）。
 *
 * 抽取与校验不广播专用事件，但两者都提供 subscribe（注册即以当前值回调一次）：
 * 首个非空值 = 该段对用户可用。接在 `project.opened` 之前（`ensureProjectPlugins` 的
 * 时机契约）⇒ 级联跑起来时订阅已经在场，读数与拆分前同口径。
 */
function attachProjectPluginWatermarks(kernel: Kernel): void {
  const water = cascadeWatermarks;
  if (!water) return;
  kernel.services
    .tryGet<ConditionExtractorService>(WellKnownServices.ConditionExtractor)
    ?.subscribe((index) => {
      if (index) water.mark('conditions', 'cascade.projectOpened→条件可用');
    });
  kernel.services
    .tryGet<ConventionLinterService>(WellKnownServices.ConventionLinter)
    ?.subscribe((report) => {
      if (report) water.mark('lint', 'cascade.projectOpened→校验有结果');
    });
}
