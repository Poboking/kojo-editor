# CONTEXT-MENU-MATRIX.md — 右键菜单可用性矩阵（1023 覆盖面批 · WP6.3）

> 本表回答一个问题：**"某个动作在界面上到底有没有右键入口，点下去落到哪个既有能力"**。
> 反向也成立：想知道"菜单里为什么没有某一项"，按面查这张表。
>
> 判据口径（与代码同源，不另立一套）：
> - 面清单＝`packages/app/src/ui/context-surfaces.ts` 的 `CONTEXT_SURFACE_MANIFEST`（32 面）；
> - 每一面必须有人 `declareContextSurface`，且宿主元素真带 `data-context-surface`——
>   这条由 `packages/app/tests/context-coverage.test.ts` 机器对账，不靠本表人工维持；
> - **能力不存在 ⇒ 整项不显示**；**上下文暂不可用 ⇒ `disabled: true` + `disabledReason` 人话**
>   （铁律 4「内核不静默」在菜单层的落点）。本表"未做"一栏写清是哪一种。

## 表 1 · 32 面总览

分区：`editor` 编辑区 / `explorer` 文件树与标签 / `panel` 面板与浮层 / `chrome` 壳层与页面 / `plugin` 插件面板 / `host` 地基。

| 面 | 分区 | 声明处（宿主） | 菜单覆盖 | 主要测试 |
|---|---|---|---|---|
| `editor` | editor | `editor-pane/preview-menu.ts`（`.editor-toolbar`） | 行级＝应用动作（格式化/查找/转到定义…）＋编辑命令；只读面按能力裁项 | `editor-context-actions.test.ts` |
| `sugar-preview` | editor | 同上（`.kojo 预览` 横幅） | 预览专属动作（对比原文 / 关闭预览） | `preview-menu.test.ts` |
| `file-tree` | explorer | `file-tree-menu.tsx` | 文件/目录/组/包四种作用域，各一套项 | `file-tree-menu.test.ts` |
| `file-tree-root` | explorer | 同上 | 根空白区：新建 / 刷新 / 在资源管理器中显示 | 同上 |
| `tabs` | explorer | `tabs-bar.tsx` | 关闭族 / 固定 / 复制路径 / 分组 | `tabs-menu.test.ts` |
| `tab-bar-blank` | explorer | 同上 | 标签栏空白区：新建标签 / 关闭全部 | 同上 |
| `editor-group-header` | explorer | 同上 | 编辑器组头：拆分 / 关闭组 | 同上 |
| `breadcrumb` | explorer | `breadcrumb-bar.tsx` | 面包屑段：复制路径 / 在树中定位 | `breadcrumb-menu.test.ts` |
| `quick-open` | explorer | `Palette.tsx` | 快速打开结果行：打开 / 复制路径 | `palette-menu.test.ts` |
| `search-results` | panel | `search-menu.ts` | 命中行 / 文件组 / 空白区；替换入口按上下文开 | `search-problems-menu.test.ts` |
| `problems` | panel | `problem-menu.ts` | 单条（修复 / 显示 / 复制 / 按码过滤）＋面板（复制全部 / 清除过滤） | 同上 |
| `outline` | panel | `outline-menu.ts` | 符号行（转到 / 复制名 / 复制位置 / 复制这一支 / 折叠·展开这一支）＋面板（复制整份 / 全部折叠 / 全部展开）；折叠是纯视图状态，换文档即复位 | `outline-menu.test.ts` · `outline-panel-fold.test.ts` |
| `call-hierarchy` | panel | `CallHierarchyOverlay.tsx`（两门语言同根） | 行级跳转 / 复制调用链 / 展开更多行 | `overlay-menus.test.ts` |
| `file-history` | panel | `FileHistoryOverlay.tsx` | 版本行：恢复 / 对比 / 复制摘要 | 同上 |
| `ops-history` | panel | `OpsHistoryOverlay.tsx` | 操作行：撤销到此处 / 复制详情 | 同上 |
| `diff-view` | panel | `DiffViewOverlay.tsx` | 差异行：复制 / 跳源 | 同上 |
| `panel-tabs` | panel | `context-menu-shell.ts` | 选项卡：关闭族 / 拆分 / 固定 | `shell-menus.test.ts` |
| `panel-section-header` | panel | 同上 | 分区头：折叠 / 移动 / 关闭 | 同上 |
| `floating-window` | panel | 同上 | 浮动窗：重置位置与尺寸（与拖拽共用 `defaultFloatRect`）/ 关闭 | 同上 |
| `notification` | panel | `notification-menu.ts`（通知中心） | 单条（执行动作 / 忽略）＋容器（清除全部） | `shell-menus.test.ts` |
| `activity-bar` | chrome | 同上 | 视图项：显示/隐藏 / 移动面板 | 同上 |
| `toolbar` | chrome | 同上 | 带命令的按钮：复制标题 / 复制 id / 设置 | 同上 |
| `status-bar` | chrome | 同上 | 每一格（`data-status-cell`）：复制这一格；换行符项按读数分档 | 同上 |
| `welcome` | chrome | `WelcomeView.tsx`（无 `build`） | **免右键面**：清单里标 `suppressMenu: true`，整片不出菜单（`welcome-recent` 行级面随菜单一起退役）。页面上的动作都有实心按钮 | `welcome-no-context-menu.test.ts` |
| `settings` | chrome | `settings-menu.ts`（设置面板，懒 chunk） | 设置项：复制 id / 恢复默认外观 / 定位 | `settings-menu.test.ts` |
| `keybindings` | chrome | 同上 | 快捷键行：改键 / 恢复 / 查冲突 | 同上 |
| `market` | chrome | `context-surfaces.ts`（插件 `ui-market` 交 build，宿主声明） | 市场卡片：安装 / 详情 / 复制 id | `plugin-context-menu.test.ts` |
| `tutorial` | chrome | `tutorial-context-menu.ts` | 教程代码块：复制 / 在编辑器中打开 | `tutorial-dialog-menus.test.ts` |
| `palette` | chrome | `Palette.tsx` | 命令面板行：执行 / 复制命令 id | `palette-menu.test.ts` |
| `plugin-panel` | plugin | `plugin-panel-menu.ts` | 面板级：复制面板名 / 面板 id / 插件 id | `plugin-panel-menu.test.ts` |
| `input` | host | `context-surfaces.ts` | 输入框优先面：剪切/复制/粘贴/全选（**优先于一切容器面**） | `context-menu.test.ts` |
| `app-fallback` | host | 同上 | 兜底通用菜单：命令面板 / 设置 / 检查更新 | `context-surfaces.test.ts` |

## 表 2 · 路由（点下去先问谁）

0. **免右键面（白名单）**：命中的面在清单里标了 `suppressMenu` ⇒ 一个菜单都不出（也不落兜底）。
   白名单是**清单的一列**（不另立第二张表）；目前只有 `welcome`——弹窗态跑轻档样式，
   且那页没有菜单独占的能力；
1. **输入框面优先**：命中 `input` 就直接用（粘贴/全选必须在输入框那一面，不许被容器面截走）；
2. **显式面逐级上溯**：从最近的 `[data-context-surface]` 往外走，内层不表态（返回 `null`）才问外层，
   同一个 id 只问一次；
3. **兜底**：都没接管才出 `app-fallback`（与 `buildFallbackMenu` 同源）。

## 表 3 · 已知缺口（本批不做，理由写在这里而不是留空）

| 缺口 | 性质 | 事实判据 |
|---|---|---|
| Monaco 里被禁用的动作 | 刻意保留可见 | 照常显示 + 点下去说原因（不用 `precondition` 藏项），原因是"写权限/只读"等上下文事实 |
| 插件的行级菜单 | 契约已开，用法在插件 | `plugin-api` 的 `context-menu` 契约是 additive 的，宿主只保证中文闸与面路由 |

> 已销的两条（2026-10-23 收口）：**大纲折叠**已落地（纯视图状态，不落盘、换文档复位，
> 折叠项按"有子节点 / 是否已折"增减）；**快捷键提示取数**已从 `keybindings` 运行期下沉到
> `keybinding-specs` 纯数据叶子，生效键位由 `ShellLayout` 挂载时注入（作者改键后提示仍跟着变）。

## 表 4 · 键盘与层叠（WAI-ARIA menu 口径）

| 键 | 行为 | 落点 |
|---|---|---|
| ↑ / ↓ | 上一项 / 下一项，跳过 `disabled`；到边界即停（不循环） | `context-menu.tsx` |
| Home / End | 首个 / 最后一个**可用**项 | 同上 |
| → / ← | 进子菜单 / 退子菜单（逐层；子菜单内 Esc 也逐层退） | 同上 |
| 可打印字符 | 首字母跳转：500ms 内累积成前缀，命中就跳到**下一个**以它开头的项（绕回即循环）；输入法组合期间不拦 | 同上（`typeAhead*` 纯函数与组件同文件） |
| Tab | **关整棵菜单**（含子菜单）且不拦截默认行为，焦点按浏览器顺序继续走；此路径**不**把焦点抢回触发处 | 同上 |
| Esc / 外点 / 选中 | 关闭并归还焦点到触发元素（不是菜单） | 同上 |
| 空菜单 | 中文化守卫把项全滤掉 ⇒ 宿主 `useEffect` 里 `closeContextMenu()` 收口：`onDismiss` 恰好一次、state 归零、不上屏空壳 | `context-menu-host.tsx` |

层叠真值（`context-menu-layering.test.ts` 逐条钉住）：`.context-menu-host` **1300**（fixed）＞
裸浮层档 **1200**（`.notification-center`）＞ `.context-menu` **1101**（`calc(var(--z-modal) + 1)`，
`--z-modal = 1100`）＞ 遮罩 `var(--z-modal)`；菜单本体 `max-height` 带 `vh` 兜底 +
`overflow-y: auto` + `overscroll-behavior: contain`（长菜单可滚、滚到底不漏给页面）。

## 附 · 文件树三面的逐项落点

文件树/面包屑的**逐条**对账（每项 → 真正落到哪个函数 / 命令 id → 未做的原因）见
`packages/app/tests/file-tree-menu.test.ts` 的 describe 标题，以及本批提交正文；
那三面项数最多（文件/目录/组/包 + 空白区 + 面包屑段），一张表放不进本文件还保持可读。
