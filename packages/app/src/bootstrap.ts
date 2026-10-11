import { createKernel, type Kernel } from '@kojo/kernel';
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
      createErbParserPlugin(),
      // eraTW 领域知识（唯一知道游戏名的地方：家族识别 + 约定规则）
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
      // 升糖建议器（写链路在 kojo-sugar 的 sugar.liftApply；面板只做呈现 + 意图。
      // 排在 kojo-sugar 之后：它 require sugar.lift / sugar.liftApply 两个服务槽）
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
  await kernel.start();
  return kernel;
}
