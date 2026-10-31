/**
 * @kojo/plugin-ui-kojo-xml
 *
 * 口上 XML 面板（`ui.panel` 槽贡献）：角色 → 文件 → `<command>` 条目，点击经
 * `editor.revealLocation` 跳转。
 *
 * 数据面（判据都住在提供方，面板本身零裁决）：
 *   - `kojo.xml` 服务 → `KojoXmlIndex`（**可选**依赖：适配器没提供时面板显式降级）；
 *   - `project.charaIndex` → 角色显示名（取不到显示编号）。
 *
 * 模块布局：`plugin.ts` 装配与槽位注册 · `panel.ts` 面板组件 · `panel-tree.ts`
 * 索引 → 树节点的纯函数投影（唯一被单测覆盖的判据面）。
 *
 * 另有两枚**方言判据叶子**，只经子路径对外（`@kojo/plugin-ui-kojo-xml/kojo-xml-dialect`
 * 与 `/kojo-xml-event-sites`，B5b C 类第三车从宿主 `monaco/kojo-xml-*.ts` 逐字搬来）：
 * 消费者是宿主的 `kojo-xml` marker 装配与单测，都在懒边上；本桶刻意不转出它们，
 * 免得引一次桶就把面板的 React 面拖进语言腿。零内核依赖、零 IO、不 `provide` 任何服务。
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
