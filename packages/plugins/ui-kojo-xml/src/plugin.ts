/**
 * 口上 XML 面板的装配（`ui.panel` 槽贡献）。
 *
 * 依赖口径：
 *   - **硬依赖**只有内核设施（IO / Project / Slots）——它们由内核保证存在；
 *   - 口上 XML 服务 `kojo.xml` 是**可选**的：只有把口上搬进 XML 的那类适配器才会
 *     `provide` 它。因此走 `tryInject`、**不写进 `requires`**：写进去会让本插件在没有
 *     该适配器的工程里直接 inactive（连"本工程没有口上 XML"这句话都显示不出来）。
 *
 * 本插件零游戏知识：属性名（`com` / `name` / `kojoPlace` / `priority`）只作为**字典键**
 * 出现，取值域与语义一律由适配器解释。
 */

import {
  KernelServices,
  WellKnownServices,
  type GameProject,
  type KojoXmlService,
  type Plugin,
  type PluginContext,
  type ProjectService,
} from '@kojo/plugin-api';
import { createKojoXmlPanel } from './panel';

/** 面板贡献 id（宿主按它定位 / 浮动 / 记住展开态） */
export const PANEL_ID = 'kojo-xml';
/**
 * 面板排序位：35 = 项目面板、40 = 函数树、45 = 条件矩阵。
 * 36 挤在项目面板之后、函数树之前——同属"口上浏览"一族，但不与任何现有面板撞号。
 */
export const PANEL_ORDER = 36;

export function createUiKojoXmlPlugin(): Plugin {
  return {
    id: 'ui-kojo-xml',
    version: '0.1.0',
    requires: [KernelServices.IO, KernelServices.Project, KernelServices.Slots],
    activate(ctx: PluginContext) {
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      // 缺席是常态（另一类游戏的口上不是 XML）：拿到 undefined 就交给面板显式降级
      const service = ctx.tryInject<KojoXmlService>(WellKnownServices.KojoXml);

      /**
       * 角色号 → 显示名。
       *
       * 每次渲染现取：换工程后 `charaIndex` 整个换新，缓存 Map 会让面板显示上一个
       * 工程的角色名（比显示编号错得更离谱）。
       */
      const charaNames = (): ReadonlyMap<number, string> => {
        const names = new Map<number, string>();
        const current: GameProject | null = project.current();
        if (!current) return names;
        for (const [no, info] of current.charaIndex) {
          if (info.name !== '') names.set(no, info.name);
        }
        return names;
      };

      const Panel = createKojoXmlPanel({ ctx, service, charaNames });

      ctx.slots.register('ui.panel', {
        id: PANEL_ID,
        title: '口上 XML',
        icon: 'book',
        order: PANEL_ORDER,
        location: 'sidebar',
        component: Panel,
      });
    },
  };
}
