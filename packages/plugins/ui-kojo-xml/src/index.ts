/**
 * @kojo/plugin-ui-kojo-xml
 *
 * 口上 XML 面板（`ui.panel` 槽贡献）：角色 → 文件 → `<command>` 条目，点击经
 * `editor.revealLocation` 跳转。
 *
 * 数据面（判据都住在提供方，本插件零裁决）：
 *   - `kojo.xml` 服务 → `KojoXmlIndex`（**可选**依赖：适配器没提供时面板显式降级）；
 *   - `project.charaIndex` → 角色显示名（取不到显示编号）。
 *
 * 模块布局：`plugin.ts` 装配与槽位注册 · `panel.ts` 面板组件 · `panel-tree.ts`
 * 索引 → 树节点的纯函数投影（唯一被单测覆盖的判据面）。
 */

export { createUiKojoXmlPlugin, PANEL_ID, PANEL_ORDER } from './plugin';
export {
  buildPanelTree,
  commandLabel,
  commandSubtitle,
  compareCom,
  diagnosticRows,
  diagnosticSummary,
  filterPanelTree,
  panelStatsLine,
  DIAGNOSTIC_ROW_LIMIT,
  UNASSIGNED_LABEL,
  type PanelCharaNode,
  type PanelCommandNode,
  type PanelDiagnosticCounts,
  type PanelDiagnosticRow,
  type PanelFileNode,
  type PanelNodeKind,
  type PanelTree,
} from './panel-tree';
