import { createKernel, type Kernel } from '@kojo/kernel';
import { createWorkerTransport, WellKnownServices } from '@kojo/plugin-api';
import type { ConditionExtractorService, ConventionLinterService } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createUiStatusPlugin } from '@kojo/plugin-ui-status';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createSavParserPlugin } from '@kojo/plugin-sav-parser';
import { createStateReplayPlugin } from '@kojo/plugin-state-replay';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createUiConditionMatrixPlugin } from '@kojo/plugin-ui-condition-matrix';
import { createUiConventionReportPlugin } from '@kojo/plugin-ui-convention-report';
import { createUiKojoNavigatorPlugin } from '@kojo/plugin-ui-kojo-navigator';
import { createUiStateReplayPlugin } from '@kojo/plugin-ui-state-replay';
import { createUiArchiveBrowserPlugin } from '@kojo/plugin-ui-archive-browser';
import { createUiSnapshotInjectorPlugin } from '@kojo/plugin-ui-snapshot-injector';
import { createUiSugarLiftPlugin } from '@kojo/plugin-ui-sugar-lift';
import { createUiSugarPreviewPlugin } from '@kojo/plugin-ui-sugar-preview';
import { createUiSugarEditorPlugin } from '@kojo/plugin-ui-sugar-editor';
import { createKojoMarketPlugin } from '@kojo/plugin-kojo-market';
import { createUiMarketPlugin } from '@kojo/plugin-ui-market';
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
 */
export async function bootstrapKernel(): Promise<Kernel> {
  const kernel = await createKernel({
    platform: tauriBridge,
    plugins: [
      // 通用解析能力（索引所有权在解析器，v0.2 起响应式）
      createErbParserPlugin(),      // eraTW 领域知识（唯一知道游戏名的地方：家族识别 + 约定规则）
      createEratwAdapterPlugin(),
      // 约定校验引擎（游戏无关）+ 结果为面板呈现
      createConventionLinterPlugin(),
      // 条件谓词抽取（游戏无关；变量语义来自当前 adapter 的 variableSchema）
      createConditionExtractorPlugin(),
      // 存档解析（游戏无关；存档目录来自当前 adapter 的 GameProject.savDir）
      createSavParserPlugin(),
      // 状态回放（游戏无关；消费 snapshot.source + condition.extractor；
      // 具名索引字典来自当前 adapter 的 variableSchema）
      createStateReplayPlugin(),
      // 语法糖转译（游戏无关；中文表层关键字是跨游戏语言层，住在契约；
      // 时机分野命名模板与变量字典来自当前 adapter —— 纯函数，不触达工程状态）
      createKojoSugarPlugin(),
      // UI：面板（内核状态 + 校验结果 + 函数树导航 + 状态回放 + 归档浏览 + 状态注入）
      createUiStatusPlugin(),
      createUiConventionReportPlugin(),
      createUiKojoNavigatorPlugin(),
      createUiConditionMatrixPlugin(),
      createUiStateReplayPlugin(),
      createUiArchiveBrowserPlugin(),
      // 状态注入器（写链路在 sav-parser 的 snapshot.writer；面板只做呈现 + 意图）
      createUiSnapshotInjectorPlugin(),
      // 升糖预览器（识别在 kojo-sugar 的 sugar.lift；预览经 editor.liftPreview.show
      // 交宿主就地折叠显示，**纯前端不写盘**。排在 kojo-sugar 之后：它 require sugar.lift）
      createUiSugarLiftPlugin(),
      // 糖预览（只读观察面：转译 + 源映射 + 状态回放三向映射全在 kojo-sugar 的
      // sugar.preview；面板只做呈现。排在 kojo-sugar 之后）
      createUiSugarPreviewPlugin(),
      // 糖编辑体验（v0.3 S6）：编辑器波浪线（ui.editor.decorator 贡献，宿主消费为
      // Monaco markers）+ 糖判定面板。语义全在 kojo-sugar 的 sugar.transpile（纯函数）
      // ——排在 kojo-sugar 之后（它 require sugar.transpile）
      createUiSugarEditorPlugin(),
      // 口上市场 v1：服务 `market`（本地目录源装卸 + 逐文件 sha256 锚）。
      // appVersion 单一真源 = app 包清单（`packages/app/package.json`），插件源码不写版本号
      createKojoMarketPlugin({ appVersion: APP_VERSION }),
      // 市场面板（ui.panel）：消费 `market` 服务 ⇒ **必须排在 kojo-market 之后**
      // （装配语义照 ui-sugar-lift 的 requires: ['sugar.lift']，不 import 市场插件）
      createUiMarketPlugin({ appVersion: APP_VERSION }),
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
 */
function installPerfProbe(kernel: Kernel): void {
  perf.install();
  const water = createCascadeWatermarks(
    (name, ms) => perf.record(name, ms),
    () => performance.now(),
  );

  kernel.bus.on('project.opened', () => water.projectOpened());
  kernel.bus.on('kojo.functionChanged', () => water.mark('index', 'cascade.projectOpened→index可用'));

  // 抽取与校验不广播专用事件，但两者都提供 subscribe（注册即以当前值回调一次）：
  // 首个非空值 = 该段对用户可用
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
