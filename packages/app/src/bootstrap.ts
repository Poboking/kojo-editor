import { createKernel, type Kernel } from '@kojo/kernel';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createUiStatusPlugin } from '@kojo/plugin-ui-status';
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
      // 通用解析能力
      createErbParserPlugin(),
      // eraTW 领域知识（唯一知道游戏名的地方）
      createEratwAdapterPlugin(),
      // UI：插件状态面板（内核状态数据 + 本插件渲染）
      createUiStatusPlugin(),
    ],
  });
  await kernel.start();
  return kernel;
}
