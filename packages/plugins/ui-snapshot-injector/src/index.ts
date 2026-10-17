/**
 * @kojo/plugin-ui-snapshot-injector
 *
 * 状态注入面板（`ui.panel` 槽贡献；v0.2 第十五批，实施记录 §5.22）。
 *
 * 把「改槽注入」做成端到端可用的写链路（呈现 + 意图层）：
 *   选档 → 深解析（keepRaw，从 snapshot.source 列档出发，不重复扫描）→
 *   定位作用域（角色块 / 主变量区 / EM 扩展区）与变量 → 编辑标量 / 单元 →
 *   预览 diff（改前 / 改后）→ 确认注入。
 *
 * 写盘链路在 sav-parser（`snapshot.writer`）：serializePayload（未修变量
 * passthrough + Int64 守卫，大数拒绝显式报错）→ 容器组装 → 写前备份 →
 * kernel io 写入（writablePaths 第一道闸 + Rust 写允许域第二道闸）→
 * 回读验证。面板只消费结果 / 错误（含备份位置提示），不自建写逻辑。
 *
 * 分层（"一切皆插件"）：
 *   - 纯逻辑（目录 / diff / overrides 构建）在 `panel-logic.ts`（零 React 可单测）；
 *   - 组件层（状态与编排）在 `injector-panel.ts`；呈现块在 `panel-frame`（工具条 +
 *     非就绪阶段）/ `var-list` / `cell-rows` / `editor-box` / `pending-box`，触底哨兵
 *     在 `more-row`；本文件只剩插件描述符、服务注入与 `ui.panel` 槽位注册；
 *   - 变量语义标签（可选）来自当前 game adapter 的 variableSchema（槽位查询透传）。
 */

import type {
  Plugin,
  ProjectService,
  SnapshotSourceService,
  SnapshotWriteService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createInjectorPanel } from './injector-panel';

export function createUiSnapshotInjectorPlugin(): Plugin {
  return {
    id: 'ui-snapshot-injector',
    version: '0.2.0',
    requires: [
      WellKnownServices.SnapshotSource,
      WellKnownServices.SnapshotWriter,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const writer = ctx.inject<SnapshotWriteService>(WellKnownServices.SnapshotWriter);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /* ------------------------------ 面板组件 ------------------------------ */

      const InjectorPanel = createInjectorPanel({ ctx, snapshots, writer, project, slots });

      ctx.slots.register('ui.panel', {
        id: 'snapshot-injector',
        title: '状态注入器',
        icon: 'snapshot',
        order: 71,
        // UI 重设计批 P1：低频+危险（写档）→ 副侧栏，默认不激活（定稿 §四）
        location: 'aux',
        defaultActive: false,
        component: InjectorPanel,
      });
    },
  };
}
