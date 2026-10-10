import { createKernel, type Kernel } from '@kojo/kernel';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createUiStatusPlugin } from '@kojo/plugin-ui-status';
import { createConventionLinterPlugin } from '@kojo/plugin-convention-linter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createSavParserPlugin } from '@kojo/plugin-sav-parser';
import { createStateReplayPlugin } from '@kojo/plugin-state-replay';
import { createUiConventionReportPlugin } from '@kojo/plugin-ui-convention-report';
import { createUiKojoNavigatorPlugin } from '@kojo/plugin-ui-kojo-navigator';
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
      // UI：面板（内核状态 + 校验结果 + 函数树导航）
      createUiStatusPlugin(),
      createUiConventionReportPlugin(),
      createUiKojoNavigatorPlugin(),
    ],
  });
  await kernel.start();
  return kernel;
}
