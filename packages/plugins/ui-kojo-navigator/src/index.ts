/**
 * @kojo/plugin-ui-kojo-navigator
 *
 * 函数树面板（`ui.panel` 槽贡献）：角色 → 家族 → 面 → 函数 四级导航。
 *
 * 数据面（判据都住在提供方/服务，本插件零裁决）：
 *   - `erb.parser` 服务的 `currentIndex()` → `ErbIndex`（建树与搜索的唯一来源）；
 *   - `game.adapter` 槽位查询 + `project.adapterId` 过滤 → `functionFamilyIndex`
 *     （**不 import 适配器包**——解耦铁律，多游戏共存天然正确）；
 *   - `project.charaIndex`：角色显示名。
 *
 * 呈现层只做「浏览 + 跳转意图」：点击函数 → `editor.revealLocation`（宿主消费）。
 * 文件维度的浏览由 app 壳的 FileTree 承担，本面板负责函数/家族维度。
 *
 * 模块布局（本文件只做装配，不含渲染与判据）：`navigator-store.ts` 外部状态源（建树/刷新/
 * 总线订阅）· `navigator-panel.ts` 面板组件 · `tree-rows.ts` 树态渲染 · `face-list.ts` 面行
 * 窗口 · `labels.ts` 显示名 · `panel-copy.ts` 失败态与状态行文案 · `tree.ts` 建树与搜索判据。
 */

import type {
  ConditionExtractorService,
  ErbParserService,
  FamilyIndexRule,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createNavigatorPanel } from './navigator-panel';
import { createNavigatorStore } from './navigator-store';

export function createUiKojoNavigatorPlugin(): Plugin {
  return {
    id: 'ui-kojo-navigator',
    version: '0.2.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const conditionExtractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
      const currentFamilyIndex = (): FamilyIndexRule | null => {
        const current: GameProject | null = project.current();
        if (!current) return null;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
            return contribution.adapter.functionFamilyIndex;
          }
        }
        return null;
      };

      /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 原样显示 token） */
      const currentFaceLabels = (): Readonly<Record<string, string>> | undefined =>
        currentFamilyIndex()?.faceLabels;

      // 建树 / 刷新 / 总线订阅都已迁出到 `navigator-store.ts`（React 外部源，面板只读与订阅）。
      const store = createNavigatorStore(ctx, { parser, project, currentFamilyIndex });

      // 渲染层已迁出到 `navigator-panel.ts`；这里只做装配（组件读的还是同一批闭包依赖）。
      const NavigatorPanel = createNavigatorPanel({
        ctx,
        parser,
        conditionExtractor,
        store,
        currentFamilyIndex,
        currentFaceLabels,
      });

      ctx.slots.register('ui.panel', {
        id: 'kojo-navigator',
        title: '函数树',
        icon: 'structure',
        order: 40,
        // UI 重设计批 P1：与壳层内建口上文件树合并为单 Explorer（定稿 Q5）
        group: 'explorer',
        component: NavigatorPanel,
      });
    },
  };
}

/* ---- W7 NAV-SCOPE 独占追加区块（文件末尾；勿在他处重排）：宿主侧四通道对拍测试需要建树/搜索入口 ---- */
export {
  buildNavigatorTree,
  searchFunctions,
  charaOwnersOf,
  ownerNoOfPath,
  type CharaOwner,
  type NavigatorBuildOptions,
  type NavigatorTree,
  type SearchHit,
} from './tree';
