import { createKernel, type Kernel } from '@kojo/kernel';
import type { Plugin } from '@kojo/plugin-api';
import { createWorkerTransport, WellKnownServices } from '@kojo/plugin-api';
import type { ConditionExtractorService, ConventionLinterService } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin, createEratwEmitBackend, ERATW, ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter'; // audit-allow: 组合根的 eraTW 常驻静态装载点（PS-10 口径，欢迎页就要它）
import { projectEventArgs, type MigrateEventArgs } from '@kojo/kojo-core';
import type {
  EmitFailure,
  GameAdapter as Kojo2GameAdapter,
  KojoEmitBackend,
  KojoExprText,
} from '@kojo/kojo-core';
import type { AdapterManifestEntry } from './adapter-manifest';
import { version as APP_VERSION } from '../package.json';
import { tauriBridge } from './bridge/tauri-bridge';
import { computeTasks } from './compute-tasks';
import { createCascadeWatermarks } from './cascade-watermarks';
import { perf } from './perf';
// vite ?worker：并行计算线程入口（纯 CPU 任务搬出主线程）
import ComputeWorker from './compute-worker?worker';

/* ============================== 2.0 adapter 登记簿 ============================== */

/**
 * v1 `gameId` → 2.0 `GameAdapter`（宿主组合根私有）。
 *
 * **为什么需要这张表**：2.0 语言面（补全 / 悬停 / 签名 / 行内提示 / 转定义 / 文档符号）
 * 要的游戏事实住在 2.0 adapter 里，而它是**纯数据对象、不进任何槽**——`game.adapter`
 * 槽里那枚是 v1 契约对象（`gameId` / `displayName`，没有 `eventCatalog`）。修好以前，
 * 宿主把 2.0 adapter **写死成 eraTW**：打开任何工程，2.0 面拿到的都是 eraTW 的事实。
 * 错误的事实不报错，只是"看起来对、其实属于另一个游戏"——比没做更危险。
 *
 * 三条口径（与 `@kojo/kojo-lang/adapter-source` 登记表同族）：
 * - **键用 v1 的 `gameId`**：`project.adapterId` 存的就是它，不是 2.0 的 `id`；
 * - **查不到 ⇒ `null`**：合法语义（各腿零候选、不抛），**绝不回退到"某一枚"**；
 * - **eraTW 是常驻项**（静态 import，模块加载即登记）；其余 adapter 走项目级动态
 *   import，在 {@link loadProjectPlugins} 里当场登记——静态拉进引导图会撑破 PS-10。
 */
const kojo2Adapters = new Map<string, Kojo2GameAdapter>();

/** 登记一枚 2.0 adapter（重复登记以最后一次为准；adapter 包装载后由组合根调用） */
export function registerKojo2Adapter(gameId: string, adapter: Kojo2GameAdapter): void {
  kojo2Adapters.set(gameId, adapter);
}

/**
 * 按当前项目取 2.0 adapter：没开项目 / 没有 `adapterId` / 该游戏没有 2.0 面 ⇒ `null`。
 * **不猜**：宁可零候选，不借别游戏的事实。
 *
 * 参数收结构最小投影（`{ adapterId?: string } | null`）：`GameProject | null`
 * 天然可传，测试不必造整枚项目。
 */
export function kojo2AdapterForProject(
  project: { readonly adapterId?: string } | null,
): Kojo2GameAdapter | null {
  const id = project?.adapterId;
  if (id === undefined || id === null) return null;
  return kojo2Adapters.get(id) ?? null;
}

/**
 * 按当前项目取 2.0 事实的**最小投影**（LAU-1a，2026-10-25）：迁移向导与槽位账本原先
 * 各自动态 `import()` 那一枚**常驻适配器**并无条件拿它的事实——打开别的工程时
 * 事件面词/参数形状/存储期与指纹全是它的（§5.1 漏点表的同族 bug）。这三个
 * helper 与 {@link kojo2AdapterForProject} 同一条口径：
 *
 * - **键 = 当前项目的 `adapterId`**（无项目态 / 该项目没有 2.0 面 ⇒ 各自的空形态）；
 * - **绝不回落"某一枚"**（D12：未绑定 = 明确降级，不猜）；
 * - 失败形态沿用各消费点的既有 fail-soft：迁移腿给 `undefined`（只判面词、不猜参数形状）、
 *   存储腿给 `null`（本轮不写账本，宿主报一句人话）、扫描腿由宿主交 `undefined`（可见降级）。
 */

/** 迁移向导的事件面词名单（adapter `eventCatalog` 的名字投影）；无 2.0 面 ⇒ `undefined` */
export function kojo2MigrateEventNames(
  project: { readonly adapterId?: string } | null,
): readonly string[] | undefined {
  const adapter = kojo2AdapterForProject(project);
  if (adapter === null) return undefined;
  // 派生式与常驻包里的名单常量逐字同构（`events.map(spec => spec.event)`）：
  // 换成从登记簿现取后，原常驻适配器工程的名录一字不变，别的工程拿到的是自己的事件目录。
  return Object.freeze(adapter.eventCatalog.events.map((spec) => spec.event));
}

/** 迁移向导的事件参数形状投影（core 纯函数 `projectEventArgs`）；无 2.0 面 ⇒ `undefined` */
export function kojo2MigrateEventArgs(
  project: { readonly adapterId?: string } | null,
): MigrateEventArgs | undefined {
  const adapter = kojo2AdapterForProject(project);
  if (adapter === null) return undefined;
  return projectEventArgs(adapter.eventCatalog);
}

/** 槽位账本要的两格事实（存储期声明 + 游戏指纹）；无 2.0 面 ⇒ `null`（本轮不建账本） */
export interface Kojo2StorageFacts {
  readonly gameFingerprint: string;
  /** adapter 真声明过的存储期集合——没声明的绝不替它补（`core/storage/unknown-class` 的源头） */
  readonly declaredPeriods: ReadonlySet<string>;
}

export function kojo2StorageFacts(
  project: { readonly adapterId?: string } | null,
): Kojo2StorageFacts | null {
  const adapter = kojo2AdapterForProject(project);
  if (adapter === null) return null;
  return Object.freeze({
    gameFingerprint: adapter.gameFingerprint.digest,
    declaredPeriods: Object.freeze(
      new Set<string>(adapter.storageClasses.classes.map((spec) => spec.period)),
    ),
  });
}

// eraTW：常驻 adapter（欢迎页 / 无项目态就要它），模块加载即进表。
registerKojo2Adapter(ERATW.gameId, ERATW_GAME_ADAPTER);

/* ============================== 2.0 backend 登记簿（入口 D） ============================== */

/**
 * `KojoEmitBackend` 工厂的注入面 = **宿主端口 + 文件级上下文**。
 *
 * 为什么是工厂而不是成品 backend：backend 里有一腿是宿主注入的
 * （`compileExpression`：core 给的 2.0 表达式源切片 → 引擎表达式），而这条管线住在
 * 语言层（v1 `lowerExpression` 一族）。若把成品 backend 存进表，组合根就得自己
 * 实现表达式编译——那是把语言策略塞进游戏登记簿。工厂把两侧切干净：
 * **组合根说"哪个游戏用哪个 backend"，宿主说"表达式怎么编译"**。
 */
export interface Kojo2BackendDeps {
  /** **必填**：2.0 表达式源切片 → ERB 表达式；表达不了返回 `EmitFailure`（fail-closed） */
  readonly compileExpression: (expr: KojoExprText) => string | EmitFailure;
  /**
   * 文件级角色号（按 `kojoDir` 前缀推；推不到 ⇒ 不传）。
   * eraTW 一族把它闭进事件头模板；eraFL 的口上在 XML 侧、不用它——**不用的一方忽略**。
   */
  readonly charNo?: string;
}

/** 游戏 → 落点实现（键与 adapter 表同一把：v1 `gameId`） */
export type Kojo2BackendFactory = (deps: Kojo2BackendDeps) => KojoEmitBackend;

/**
 * v1 `gameId` → backend 工厂（宿主组合根私有）。
 *
 * 与 {@link kojo2Adapters} **同一把键**、同一条口径：查不到 ⇒ `null`，
 * **绝不回退到"某一枚"**。理由与 adapter 表逐字同源——用错游戏的事实不报错，
 * 只是"看起来对、其实属于另一个游戏"。此前诊断链写死 eraTW 后端，打开 eraFL 工程
 * 时波浪线是拿 eraTW 的落点规则算出来的；本表就是那个洞的堵法。
 */
const kojo2Backends = new Map<string, Kojo2BackendFactory>();

/** 登记一枚 backend 工厂（重复登记以最后一次为准；插件装载后由组合根调用） */
export function registerKojo2Backend(gameId: string, factory: Kojo2BackendFactory): void {
  kojo2Backends.set(gameId, factory);
}

/** 按当前项目取 backend 工厂：没开项目 / 没有 `adapterId` / 该游戏没有落点面 ⇒ `null` */
export function kojo2BackendFactoryForProject(
  project: { readonly adapterId?: string } | null,
): Kojo2BackendFactory | null {
  const id = project?.adapterId;
  if (id === undefined || id === null) return null;
  return kojo2Backends.get(id) ?? null;
}

/**
 * 按**适配器清单**登记项目级 adapter 的 2.0 两面（LAU-1a，2026-10-25）。
 *
 * 这是原先写死 `'erafl'` 那段特例的泛化：游戏名与导出名不再住在组合根的分支里，
 * 而是清单条目自带的 `kojo2AdapterExport` / `kojo2BackendFactoryExport`（`adapter-manifest.ts`
 * 是审计钦定的游戏名法定落点）——**加一个 era 只加数据**（§5.6 判据 10：新增第三个
 * 方言包时宿主源码零改动）。
 *
 * 口径与逐字保留的原实现一致：
 * - **存在性卫语句**：条目没声明导出名、或包没导出那个名字 ⇒ 跳过（该项目走 `null`
 *   语义：零候选、不抛、不借别游戏的事实）；
 * - **adapter 与 backend 分开卫住**：只有一半时 `kojo2SurfaceForProject` 仍给 `null`
 *   （宁缺勿错），不会出现"A 游戏的事件目录 + B 游戏的落点"这种混搭；
 * - **键 = `entry.id`（= v1 `gameId`）**：与 `project.adapterId` 同一把；原实现取的
 *   `ERAFL.gameId` 与之逐字相等（清单头注即钉这一点）。
 *
 * eraTW 是 `scope:'boot'` 常驻项，走模块加载即进表的静态路径（上方两行
 * `registerKojo2*`），不经本函数——这条静态路径是 PS-10 开机图既有口径，保持不变。
 */
export function registerKojo2SurfacesFromModules(
  entries: readonly AdapterManifestEntry[],
  modules: readonly (Record<string, unknown> | undefined)[],
): void {
  for (const [index, entry] of entries.entries()) {
    const mod = modules[index];
    if (mod === undefined) continue;
    const adapterExport = entry.kojo2AdapterExport;
    if (adapterExport !== undefined) {
      const facts = mod[adapterExport];
      if (facts !== undefined) registerKojo2Adapter(entry.id, facts as Kojo2GameAdapter);
    }
    const backendExport = entry.kojo2BackendFactoryExport;
    if (backendExport !== undefined) {
      const factory = mod[backendExport];
      if (typeof factory === 'function') registerKojo2Backend(entry.id, factory as Kojo2BackendFactory);
    }
  }
}

/** 一份 2.0 诊断/降糖需要的**两面**：游戏事实（adapter）+ 落点（backend） */
export interface Kojo2GameSurface {
  readonly adapter: Kojo2GameAdapter;
  readonly backend: KojoEmitBackend;
}

/**
 * 按当前项目取 2.0 的**两面**；任一面缺席 ⇒ `null`。
 *
 * **两面必须同源**：adapter 说"这个游戏有哪些事件/符号"，backend 说"它们落成什么字节"。
 * 一半对一半错比两半都缺更危险——core 会拿 A 游戏的事件目录去问 B 游戏的落点，
 * 产出一个"语法全对、语义属于另一个游戏"的 ERB。所以本函数只在两表**同一把键**
 * 都命中时才给结果，不做任何跨表拼装。
 */
export function kojo2SurfaceForProject(
  project: { readonly adapterId?: string } | null,
  deps: Kojo2BackendDeps,
): Kojo2GameSurface | null {
  const adapter = kojo2AdapterForProject(project);
  if (adapter === null) return null;
  const factory = kojo2BackendFactoryForProject(project);
  if (factory === null) return null;
  return { adapter, backend: factory(deps) };
}

// eraTW：常驻落点面。`charNo` 只在非空时注入（空串会让事件头模板拼出 `_K` 空尾，
// 那是"看起来有个函数名"的假产物；eraTW backend 对缺 charNo 是 fail-closed）。
registerKojo2Backend(ERATW.gameId, (deps) =>
  createEratwEmitBackend({
    compileExpression: deps.compileExpression,
    ...(deps.charNo !== undefined && deps.charNo.length > 0 ? { charNo: deps.charNo } : {}),
  }),
);

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
 * - **项目级（动态 import + `kernel.registerPlugin`）**＝其余 20 个。它们的可见面
 *   （面板 / 命令 / 状态栏 / 编辑器装饰器）只在项目态存在；拆分前的静态图里插件占
 *   2,817 KB 源码，两个常驻项只留 ~650 KB，剩下的没理由在 `boot.welcomeInteractive`
 *   之前被解析、求值。第二个 adapter（eraAkumaMaid）走项目级而非常驻：它在欢迎页
 *   没有任何贡献面（不像 eraTW 那样挂 `ui.overlay` / `ui.tutorial.open`），而
 *   `ensureProjectPlugins` 已保证它在 `project.open()` 之前入场。
 * - **装载时机**＝`App.openProject` 里 `kernel.project.open()` **之前**（见
 *   `ensureProjectPlugins`）：级联一开始 20 个插件就全部在场，所以面板顺序、命令面板
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
  // 调试面登记（2026-10-24 调试模式批）：`?kojo-debug=1` 时 `window.__kojoDebug.kernel()`
  // 经登记簿拿到这枚实例；未选入调试模式时登记簿无人读，零开销。
  // **动态 import 是刻意的**：开机图闸（ps10-eager-graph）文件余量只剩 1，登记簿不许吃它。
  void import('./debug/debug-registry').then((m) => m.registerDebugKernel(kernel));
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
  // 适配器走**单一清单**（`./adapter-manifest`，动态取，不占开机静态图）。
  const { projectAdapters, createAdapterPlugin } = await import('./adapter-manifest');
  const adapterEntries = projectAdapters();
  const adapterModules = await Promise.all(adapterEntries.map((entry) => entry.load!()));
  const [
    linter,
    extractor,
    savParser,
    stateReplay,
    sugar,
    kojoLang,
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
    uiKojoXml,
  ] = await Promise.all([
    import('@kojo/plugin-convention-linter'),
    import('@kojo/plugin-condition-extractor'),
    import('@kojo/plugin-sav-parser'),
    import('@kojo/plugin-state-replay'),
    import('@kojo/plugin-kojo-sugar'),
    import('@kojo/plugin-kojo-lang'),
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
    import('@kojo/plugin-ui-kojo-xml'),
  ]);
  // 项目级 adapter 的 2.0 两面：**清单驱动**登记（LAU-1a，泛化原 erafl 特例）——
  // 导出名住在 `adapter-manifest.ts`，组合根只见清单不见游戏名（口径见
  // {@link registerKojo2SurfacesFromModules}）。没有 2.0 面的适配器（四家）自然不进表，
  // 其工程走 `null` 语义：零候选、不抛、不借 eraTW 的事实。
  registerKojo2SurfacesFromModules(adapterEntries, adapterModules);
  return [
    // 适配器（清单顺序 = 注册顺序）：内核 detect / loadProject 时 adapter 必须已在场。
    // 次序不再承担「谁赢」的责任——多枚适配器同时认领会报冲突（见 `AdapterConflictError`）。
    ...adapterEntries.map((entry, idx) => createAdapterPlugin(entry, adapterModules[idx]!)),
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
    // Kojo 语言面插件（B2）：definition / documentSymbol 的**唯一供方**，经
    // `ui.editor.languageService` 槽应答 `languageId: 'kojo2'` 的请求。
    // 排在这里的理由：它不 require 任何服务（判据全在 `@kojo/kojo-lang`，零 IO、
    // 零项目状态），所以位置不影响正确性；放在 sugar 之后是保持"语言面在前、
    // 呈现面在后"的阅读顺序。宿主侧对应的原生 provider 已在 B2 批删除 ⇒
    // 本插件缺席时这几项能力**无人应答**（可见退化，不是静默兜底）。
    // 本批只接了 definition / documentSymbol 两项；其余三项（references /
    // foldingRange / inlayHint）在 B3 批接上（它们各自的判据还没搬进包）。
    kojoLang.createKojoLangPlugin(),
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
    // 口上 XML 面板（2026-10-24）：消费 `kojo.xml` 服务（由 XML 形态的 adapter 提供）。
    // 服务缺席（ERB 口上形态的工程）⇒ 面板显式降级，不静默空白。
    uiKojoXml.createUiKojoXmlPlugin(),
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
 * 进项目之前把 18 个项目级插件装好并注册（PS-10）。
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
