import { createKernel, type Kernel } from '@kojo/kernel';
import { createWorkerTransport } from '@kojo/plugin-api';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createUiStatusPlugin } from '@kojo/plugin-ui-status';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createSavParserPlugin } from '@kojo/plugin-sav-parser';
import { createStateReplayPlugin } from '@kojo/plugin-state-replay';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createUiConventionReportPlugin } from '@kojo/plugin-ui-convention-report';
import { createUiKojoNavigatorPlugin } from '@kojo/plugin-ui-kojo-navigator';
import { createUiStateReplayPlugin } from '@kojo/plugin-ui-state-replay';
import { createUiArchiveBrowserPlugin } from '@kojo/plugin-ui-archive-browser';
import { createUiSnapshotInjectorPlugin } from '@kojo/plugin-ui-snapshot-injector';
import { createUiSugarLiftPlugin } from '@kojo/plugin-ui-sugar-lift';
import { createUiSugarPreviewPlugin } from '@kojo/plugin-ui-sugar-preview';
import { createUiSugarEditorPlugin } from '@kojo/plugin-ui-sugar-editor';
import { tauriBridge } from './bridge/tauri-bridge';
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
    ],
  });
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
 * 性能探针接线（2026-10-12「内核优化 L0 批」）：
 * - 把探针挂到 `globalThis.__kojoPerf`（DevTools 里按需汇总，见 `perf.ts`）；
 * - 记录**开项目级联**的时间线：`project.opened` → `kojo.functionChanged`
 *   （后者由 erb-parser 索引构建完成后广播，故该差值 = 索引构建耗时）。
 *   条件抽取 / 约定校验的耗时由各自插件日志给出（均含 `in Nms`）。
 */
function installPerfProbe(kernel: Kernel): void {
  perf.install();
  let openedAt: number | null = null;
  kernel.bus.on('project.opened', () => {
    openedAt = performance.now();
  });
  kernel.bus.on('kojo.functionChanged', () => {
    if (openedAt === null) return;
    perf.record('cascade.projectOpened→index', performance.now() - openedAt);
    openedAt = null;
  });
}
