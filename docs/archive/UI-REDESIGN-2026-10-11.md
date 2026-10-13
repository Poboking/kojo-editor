# UI/UX 重设计（定稿 v1.0）：活动栏 + 可停靠面板 + 全禅写作模式

> 状态：**定稿，可实施**（2026-10-11 用户拍板全部开放问题，见 §十四拍板记录）。
> 输入：首个可运行 exe 实机反馈 7 条（下称 F1–F7）+ 现状审读盘点。
> 约束：架构铁律不变——宿主零业务知识；插件只经槽位贡献 UI；契约变更**全部 additive**（旧插件注册不改也能跑）。
> 版本纪律：已插入 v0.4.0-beta.1 发版判据 ⑥（见 §十二）；实施批次用「日期 + 简称」命名。

## 〇、反馈 → 设计决策映射

| # | 用户反馈 | 设计决策（章节） |
|---|---------|-----------------|
| F1 | 应用升糖建议报 Write not allowed | 写权限闭环：状态栏徽章 + 重授权 overlay + 通知中心（§九） |
| F2 | 保存报同样错误 | 同上 + 错误消息中文化、可行动（§九） |
| F3 | 面板全堆左侧、不可移动拉伸、被挤出视口 | 五区布局 + 三容器 + 尺寸/显隐记忆（§二、§七） |
| F4 | 约定校验/归档/注入/升糖/预览/插件状态不是创作刚需 | 信息分级：导航→侧栏、诊断→底部、工具→副侧栏、升糖→编辑器内💡、插件状态→默认隐藏（§四） |
| F5 | 找不到新建按钮 | 命令体系 + 新建命令三入口（§五、§六） |
| F6 | 各小框滚动条难看 | 容器统一滚动 + 主题化细滚动条（§十） |
| F7 | 编辑器最上端要工具栏 | `ui.toolbar` 槽 + 顶部工具栏（§三、§五） |
| — | 升糖建议要 💡（IntelliJ/VSCode 式） | 新槽 `ui.editor.codeAction`（§六-3） |
| — | 体验对标 VSCode，否则作者直接用 VSCode+ERB 插件 | 全文；对标项：活动栏/命令面板/快速打开/底部 Problems/状态栏/多标签/禅模式 |

## 一、设计原则

1. **编辑器是主角**：默认布局里编辑区占 ≥60% 面积；一切面板可隐、尺寸可记。
2. **按使用频率分层，不按插件边界分层**：作者感知的是"导航/诊断/预览/工具"，不是"这是哪个插件"。
3. **VSCode 有的惯性不重新发明**：Ctrl+Shift+P、Ctrl+P、Ctrl+B/J、活动栏、底部 Problems、状态栏、多标签、禅模式——作者的学习成本应该为零。
4. **壳层只懂容器语义**：`location`、`group`、`align`、`command id`、`overlay id`——不出现任何口上/游戏概念；业务知识（向导、💡建议、面包屑段）全部住插件。
5. **additive 至上**：所有契约新增字段均可缺省，缺省行为 = 现状（sidebar 堆叠），迁移逐插件进行，不存在"同时改 10 个插件才能跑"的窗口期。

## 二、目标布局（五区模型）

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部工具栏（ui.toolbar 槽 + 壳层布局按钮）                         │
├──┬───────────┬──────────────────────────────┬──────────────────┤
│活│ 主侧栏      │ 标签页栏（多文件）              │ 副侧栏            │
│动│ Explorer   │ 面包屑（可选槽）               │ 糖预览            │
│栏│ ├口上文件   │ ┌──────────────────────────┐ │ 状态回放          │
│48│ └函数树     │ │ Monaco                    │ │ 归档浏览器        │
│px│ （折叠堆叠  │ │  · 💡 升糖 quickfix        │ │ 状态注入器        │
│  │  可拖宽）   │ │  · 波浪线（现状保留）        │ │ （默认收起）       │
│  │            │ └──────────────────────────┘ │                  │
├──┴───────────┴──────────────────────────────┴──────────────────┤
│ 底部区（可拖高/可关；tab：约定校验 · 糖判定 · …）                   │
├────────────────────────────────────────────────────────────────┤
│ 状态栏（左：写权限徽章 · 诊断计数｜右：编码·EOL·行列 · 保存态 · 禅） │
└────────────────────────────────────────────────────────────────┘
```

- **活动栏**（壳层）：主侧栏每个 view 容器一枚图标；底部放低频入口（插件状态齿轮、设置）。壳层自带，无需业务知识。
- **主/副侧栏、底部区**：三个面板容器；显隐、尺寸、激活项全部持久化（§七）。
- **编辑器区**：多标签 + 面包屑 + Monaco；空态页给"新建/快速打开/最近文件"三个动作。

## 三、槽位契约变更（全部 additive）

```ts
// ---- ui.panel 扩展（缺省 = 旧行为）----
type PanelLocation = 'sidebar' | 'aux' | 'bottom';
interface UIPanelContribution {
  location?: PanelLocation;   // 缺省 'sidebar'
  defaultActive?: boolean;    // 缺省 true；低频工具设 false
  group?: string;             // 同 group 的 sidebar 面板共享一枚活动栏图标，
                              // 容器内折叠堆叠（VSCode Explorer 多 view 式）；
                              // 缺省 = 独占一枚图标
}

// ---- 新槽：顶部工具栏（F7）----
interface ToolbarContribution extends ContributionBase {
  title: string; icon?: string;
  command: string;            // 引用 editor.command 的 id——单一动作真源在命令
  when?: (ctx: EditorCommandContext) => boolean;
}

// ---- 新槽：状态栏 ----
interface StatusbarContribution extends ContributionBase {
  align?: 'left' | 'right';   // 缺省 right
  component: UIPanelComponent; // 复用面板组件形态（小型件）
}

// ---- 新槽：编辑器 CodeAction（💡 升糖）----
interface EditorCodeAction {
  title: string;
  kind?: 'quickfix' | 'refactor';
  diagnostics?: LineDecoration[];          // 关联诊断（quickfix 形态）
  run(ctx: EditorCommandContext): void | Promise<void>;
}
interface EditorCodeActionContribution extends ContributionBase {
  provideActions(file: { path: string; text: string; project: GameProject | null }): EditorCodeAction[];
}

// ---- 新槽：模态/向导 overlay（新建向导、重授权、设置）----
interface OverlayContribution extends ContributionBase {
  component: UIPanelComponent;  // 宿主提供遮罩、Esc/关闭语义
}

// ---- editor.command 救活 + 扩展 ----
interface EditorCommandContribution {
  keybinding?: string;        // 新增 additive，如 'ctrl+n'；宿主统一注册
}
```

- 宿主编排规则：toolbar/状态栏/命令面板的**动作真源都是 `editor.command`**；toolbar 项只引用命令 id，不自带 `run`（避免两套动作定义漂移）。
- overlay 的打开经**内核通用事件**（`KernelEventMap` additive 新增 `ui.overlay.open { id, payload? }`），与 `editor.revealLocation` 同款模式——插件发意图，宿主落地，插件间零依赖。
- Monaco 侧：`ui.editor.codeAction` 由宿主适配为 `registerCodeActionProvider`（灯泡由 Monaco 自带 lightbulb 渲染，宿主零绘制）。
- 活动栏同组条目：图标/标题取组内 order 最小者（Explorer 组 = 口上文件的图标）。

## 四、面板迁移表（10 块面板的归宿，Q1/Q5 定案）

| 面板 | 现状 | 新归属 | group | defaultActive | 理由 |
|------|------|--------|-------|---------------|------|
| 口上文件 | 硬编码堆叠 | **sidebar** | `explorer` | true | 导航刚需；壳层内建视图改为与槽同构 |
| 函数树 | order 40 | **sidebar** | `explorer` | true | 导航刚需；与口上文件合并为单 Explorer（内部双 view 折叠，Q5 定案） |
| 约定校验 | order 50 | **bottom**（Problems 形态，计数徽标上状态栏） | — | 有诊断时自动弹出 | 诊断列表天然属底部 |
| 糖判定 | order 76 | **bottom** tab | — | false | 诊断性质 |
| 糖预览 | order 74 | **aux**（跟随活动文件，VSCode Markdown 预览位） | — | true（aux 打开时） | 写糖时的对照视图 |
| 状态回放 | order 60 | **aux** | — | false | 按需验证工具 |
| 归档浏览器 | order 70 | **aux** | — | false | 低频 |
| 状态注入器 | order 71 | **aux** | — | false | 低频+危险（写档） |
| 升糖建议 | order 72 | **不再是面板** → `ui.editor.codeAction` 💡；aux 面板作过渡兜底（defaultActive:false，💡 稳定后移除注册） | — | — | 用户点名要灯泡 |
| 插件状态 | order 100 | **sidebar**，活动栏底部齿轮位 | — | false | 开发者面板，普通作者不该看到 |

迁移方式：逐插件改注册参数（+3 个可选字段），宿主对未迁移面板按缺省（sidebar 堆叠）渲染——任何中间态都可运行。

## 五、命令体系（editor.command 救活）

1. **宿主新增命令消费点**：命令面板（Ctrl+Shift+P / F1）、快捷键表、工具栏、（可选）文件树右键菜单——读同一个 `editor.command` 槽。
2. **快速打开**（Ctrl+P）：壳层功能，候选 = 索引文件列表（宿主已持有 ErbIndex，泛化无业务知识）。
3. **壳层自带布局命令**（合法，零业务）：切换主侧栏 Ctrl+B / 底部区 Ctrl+J / 副侧栏 Ctrl+Alt+B / 写作模式 Ctrl+K Z / 重置布局 / 全部保存。
4. **工具栏构成**：左侧 = 业务动作（`ui.toolbar` 贡献：新建文件、保存…）；右侧 = 壳层布局开关（底部区/副侧栏/写作模式）。

## 六、关键链路设计

### 6.1 新建文件（F5）——三入口
- 入口：① Explorer 面板头部「+」（面板自有 UI，无需新槽）；② 工具栏/命令面板「新建口上文件」（命令 + `keybinding:'ctrl+n'`）；③ 编辑器空态页按钮。
- 命令由**插件**贡献——默认归属 `ui-sugar-editor`（它已管 `.kojo` 的 decorator/saveHandler/panel 三处贡献）；命名模板/时机分野/fail-closed 查表经 adapter 契约（KojoFaceTable 等）查询，宿主零知识。命令触发 `ui.overlay.open` → 向导 overlay（选角色 → 选家族/时机 → 文件名实时预览 → 生成模板落盘到 writablePaths 内 → 打开并定位）。
- 写权限未批准时向导首屏即提示并给重授权按钮（不等到落盘才炸）。

### 6.2 升糖建议 💡
- `ui-sugar-lift` 从"面板扫文件"改为注册 `ui.editor.codeAction`：对当前 `.kojo`/ERB 逐行产候选（数据层 `sugar.lift`/`sugar.liftApply` 不变）；宿主经 Monaco codeActionProvider 呈现灯泡 + Ctrl+. 菜单；应用仍走 `sugar.liftApply` 写链路（writablePaths 约束不变，错误进通知中心）。
- 过渡期内 aux 兜底面板保留但默认收起；💡 冒烟稳定后移除面板注册（单独一批，记 IMPLEMENTATION-LOG）。

### 6.3 底部诊断区（F4）
- 约定校验面板迁入底部，行点击跳转已有（`editor.revealLocation`）；状态栏左侧聚合计数（错/警），点击开关底部区——计数由 `ui-convention-report` 经 `ui.statusbar` 贡献。
- 糖判定（当前文件的糖诊断汇总）作第二个 tab。

### 6.4 多标签页（Q6 定案：一次到位）
- **宿主模型**：`tabs: [{ path, dirty, viewState }]`——纯通用（路径 + Monaco viewState，零业务概念）；活动 tab 即现有 `activeFile` 的升级。
- **Monaco 生命周期**：单编辑器实例 + 每 tab 一个 model（`monaco.Uri.file(path)`）；切换 = 旧 tab `saveViewState()` → `setModel` → 新 tab `restoreViewState()`；model 仅在**关闭 tab** 时 dispose（脏则先弹确认——扩展现有 UnsavedConfirmDialog 支持"关闭 tab"语境）。
- **脏基线**：每 tab 独立版本号基线（沿用 BUG-4 的 O(1) 方案，按 model 存）。
- **markers**：按 model 维度重算（激活全量 + 编辑去抖 250ms，沿用现状逻辑）；`ui.editor.decorator` 消费点不变。
- **保存**：Ctrl+S = 当前 tab；新增命令「全部保存」（壳层命令）；`ui.editor.saveHandler` 就近征询逻辑不变（按 path）。
- **外部打开**（文件树/校验跳转/快速打开/`editor.revealLocation`）：一律"已有 tab 则激活，否则新开"；同文件重复定位仍走 nonce。
- **UI**：中键关闭、脏点（●）、溢出横向滚动；空态（无 tab）= 新建/快速打开/最近文件三动作。

## 七、可停靠面板系统与布局持久化（Q2/Q3 定案）

- **停靠粒度**：三容器（sidebar/aux/bottom）之间拖拽移动面板 tab/视图，落点高亮；不做窗口级浮动。
- **持久化**：壳层私有状态存 **WebView localStorage**（`kojo.ui.layout.v1`，**全局一份**，Q3 定案）：各容器 {visible, size, activeView} + 面板位置 override + 写作模式开关。**不进内核存储域**——布局是壳层私事，内核不沾 UI。提供「重置布局」命令。
- 面板显隐 = 记忆上次状态。

## 八、写作模式（Q4 定案：全禅）

- **形态**：隐藏活动栏 + 主侧栏 + 副侧栏 + 底部区 + 顶部工具栏；**保留迷你状态栏**（保存态 + 写权限徽章——安全相关信息不隐藏）；编辑器居中限宽（默认 ~1000px，「重置布局」外提供设置项可关）。
- **进出**：Ctrl+K Z / 工具栏按钮 / 命令；**Esc 退出**；状态持久化（下次启动恢复）。

## 九、写权限闭环与错误呈现（F1/F2，P0 插队）

1. **状态栏永久徽章**（壳层通用 chrome）：`可写`（绿）/ `只读`（琥珀，点击 → 重授权 overlay）；保存按钮只读时置灰带 tooltip，**不等到写盘才报错**。
2. **修静默只读 bug**：`applyApprovedWritable` 检测到「旧批准 ≠ 新提议」时，除 log.warn 外经内核事件通知宿主重新弹 `WritableApprovalDialog`（现状：App 只在 record==null 时弹，旧记录场景永远不重弹 → 静默永久只读）。
3. **通知中心**（壳层）：错误 toast + 可行动按钮（"去授权"/"查看详情"，Q9 定案：状态栏点击与通知 action **两者都留**）；`WriteNotAllowedError` 等异常映射为中文人话 + 下一步动作，裸英文堆栈只进日志。

## 十、视觉系统（F6；Q7 定案：仅深色，token 预留浅色）

- 滚动条：全局 `::-webkit-scrollbar` 主题化（10px/面板 8px、透明轨道、悬停显 thumb）；面板内容滚动收归**容器级**（每个容器一根滚动条/view 切换），消灭"十个小框十根条"。
- 设计 token 扩展：现有 10 个色变量 → 补 spacing(4/8/12/16)、radius(6/8)、z-index 刻度（toolbar 10 / overlay 1000 / modal 1100）、字号阶（12/13/14）；颜色全部走 token（浅色主题预留，不做实现）。
- 焦点可见性：`:focus-visible` 统一描边。

## 十一、键盘可达性清单

| 快捷键 | 动作 | 备注 |
|--------|------|------|
| Ctrl+S | 保存当前 tab | 现状保留 |
| Ctrl+Shift+P / F1 | 命令面板 | 新增 |
| Ctrl+P | 快速打开文件 | 新增 |
| Ctrl+N | 新建口上文件 | 命令 keybinding（插件贡献） |
| Ctrl+B / Ctrl+J / Ctrl+Alt+B | 主侧栏 / 底部区 / 副侧栏 | 壳层命令 |
| Ctrl+K Z | 写作模式（Esc 退出） | 壳层命令 |
| Ctrl+W | 关闭当前 tab（脏则确认） | 壳层命令 |
| Ctrl+. | 灯泡 quickfix（升糖） | Monaco 自带 |
| Esc | 关 overlay / 退出写作模式 | — |

## 十二、实施分期（Q10/Q11 定案：P0 插队；新壳整体插入 beta.1 判据⑥）

| 期 | 内容 | 解决 | 验收 |
|----|------|------|------|
| **P0 写权限闭环批** | §九全部：状态栏徽章、静默只读修复（重授权事件）、通知中心 + 错误中文化 | F1 F2 | 单测覆盖新事件路径；桌面壳手工：旧批准记录 → 重弹授权；只读态保存 → 友好提示 |
| **P1 壳层骨架批** | 五区布局 + 活动栏 + `location/group/defaultActive` + 三容器 + localStorage 持久化 + 滚动条/token + 面板迁移表全量 + Explorer 合并 | F3 F4 F6 | 958 基线全绿 + typecheck root+app 双跑 + audit:decoupling + 壳冒烟（面板各归其位、显隐记忆生效） |
| **P2 命令与工具栏批** | editor.command 消费（命令面板/快捷键）+ 快速打开 + `ui.toolbar` + `ui.overlay` + 新建口上文件命令与向导 | F5 F7 | 同上 + 新建→落盘→打开端到端勾验 |
| **P3 编辑器深化批** | 多标签页（§6.4 全量）+ `ui.editor.codeAction` 💡 升糖迁移 + 底部诊断计数状态栏 | 升糖样式、多文件 | 同上 + 💡 应用冒烟 + 多 tab 脏态/切换/关闭矩阵 |
| **P4 停靠与全禅批** | 三容器拖拽停靠 + 全禅写作模式 + 设置 overlay（含限宽开关）+（可选）面包屑槽 | 打磨 | 同上 + 禅模式进出/持久化勾验 |

- **v0.4.0-beta.1 判据 ⑥（新增）**：P0–P4 全部完成 + 真实终端勾验通过（与判据③同终端）。
- 每期 = 一个「日期 + 简称」批次：全量验证绿 → Conventional Commits → `node tools/git-push.mjs` → IMPLEMENTATION-LOG 记录。

## 十三、架构合规自检

- 宿主新增概念只有：location/group/aux/bottom/toolbar/statusbar/overlay/command/keybinding/tab——**全是容器与动作语义，零业务词**。
- 业务知识流向不变：新建向导/💡/判定全在插件；宿主只消费 `command id`、`overlay id`、泛型 `EditorCodeAction`、泛型 tab 路径。
- 契约 additive：旧插件注册零修改可运行；迁移逐插件进行。
- 插件间零 import：overlay 打开走内核事件（`editor.revealLocation` 同款模式）。
- 布局状态走壳层 localStorage，内核存储域零新增负担。

## 十四、拍板记录（2026-10-11，用户）

| # | 问题 | 定案 |
|---|------|------|
| Q1 | 面板迁移表 | 照单全收（糖预览 aux；升糖过渡期保留 aux 兜底面板） |
| Q2 | 可停靠粒度 | 三容器互拖 |
| Q3 | 布局记忆 | 全局一份 |
| Q4 | 写作模式 | **全禅**（§八） |
| Q5 | 文件树+函数树 | **合并为单 Explorer**（group 机制，§三/§四） |
| Q6 | 多标签页 | **一次到位**（§6.4） |
| Q7 | 主题 | 仅深色，token 预留浅色 |
| Q8 | 状态栏清单 | 按提案（左：写权限徽章+诊断计数；右：编码·EOL·行列+保存态+禅开关） |
| Q9 | 重授权入口 | 状态栏点击 + 通知 action 两者都留 |
| Q10 | P0 插队 | 确认（写权限闭环最先做） |
| Q11 | 与 beta.1 关系 | **插入判据⑥：beta.1 直接带新壳**（§十二） |
