/**
 * 结果类面板的**行导航**（1020 编辑器体感批，用户反馈项 9）——薄转发壳。
 *
 * 协议本体（↑↓ 移焦点 / F4·F8 移过去并当场打开、边界回绕、空集合 `null`、
 * `<select>` / `<textarea>` 让位、合成期放行，以及把决策落到行按钮上的 DOM 腿）
 * 已于 kw8a 1102 行键盘批**整体上提到契约层** `@kojo/plugin-api` 的 `sugar-panels.ts`
 * 末段——插件不许 import 宿主模块（铁律 2），而这条协议要给宿主两只面板与插件面板
 * 共用同一把尺子，共享件的唯一合法落点就是契约层（协议口径与落点理由逐字写在那一处）。
 *
 * 本壳只保留宿主既有导入面（`SearchPanel` / `ProblemPanel` / `panel-row-nav.test.ts`
 * 的取数路径），**零实现**——不许出现"宿主一份、契约一份"的两处实现。
 */
export {
  applyPanelRowNav,
  PANEL_ROW_ATTR,
  PANEL_ROW_SELECTOR,
  rowNavDecision,
  type PanelRowElement,
  type PanelRowNavHost,
  type RowNavDecision,
  type RowNavDomEvent,
  type RowNavInput,
} from '@kojo/plugin-api';
