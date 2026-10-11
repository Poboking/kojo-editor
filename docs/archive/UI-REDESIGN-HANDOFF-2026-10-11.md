# UI 重设计实施交接（P0–P4）

> 面向：接手实施的新会话。**唯一权威需求 = `docs/UI-REDESIGN-2026-10-11.md`（定稿 v1.0）**；
> 本文件只给工程上下文、实施纪律和每期任务卡。定稿与本文冲突时以定稿为准。

## 一、任务一句话

把 kojo-editor 壳层从「单一左侧栏堆 10 块面板」重造为 VSCode 式五区布局（工具栏/活动栏+主侧栏/编辑器区/副侧栏/底部区/状态栏），含命令体系、多标签、💡升糖、写权限闭环、拖拽停靠与全禅模式；全部契约变更 additive，宿主零业务知识的铁律不破。

## 二、开工前必读（按序）

1. `docs/UI-REDESIGN-2026-10-11.md` —— 需求定稿（布局/契约/迁移表/分期/拍板记录）。
2. `docs/HANDOFF.md` —— §二当前状态、§四代码地图、§七安全模型、§八环境坑、§九踩坑、§十一版本纪律。
3. `docs/ARCHITECTURE.md` —— §4 槽位系统、§5.7 Onboarding。
4. `packages/plugin-api/src/slots.ts` —— 现有 6 槽契约原文。
5. `packages/app/src/ui/`（App.tsx / ProjectView.tsx / EditorPane.tsx / PanelHost.tsx / FileTree.tsx / WelcomeView.tsx / WritableApprovalDialog.tsx / UnsavedConfirmDialog.tsx / SaveWarningDialog.tsx）+ `packages/app/src/styles.css`（~1719 行）+ `packages/app/src/bootstrap.ts`。
6. 任一 UI 插件的注册现状（如 `packages/plugins/ui-kojo-navigator/src/index.ts` 末尾 `ctx.slots.register('ui.panel', {...})`）——迁移就是给这些注册加字段。

## 三、基线与验证矩阵（每批必跑）

- 基线：**958 测试 / 16 插件 / 审计 A–D 四项**（2026-10-12 保存接线批后）。
- `pnpm test`；`pnpm typecheck`（**root + packages/app 双跑**，DOM vs node lib 严格度不同）；`pnpm audit:decoupling`。
- 桌面壳深度冒烟**沙箱不可跑**（os error 231），需本机正常终端 `pnpm tauri dev` 手工勾验。
- bash 残缺时直调 node（HANDOFF §八有命令原文）；推送用 `node tools/git-push.mjs`。
- **新批次命名「日期 + 简称」**（如「2026-10-13 壳层骨架批」）；每批：全绿 → Conventional Commits → 推送 → 记 IMPLEMENTATION-LOG。

## 四、铁律提醒（本线特有风险点）

- 壳层（app/src）只允许出现**容器/动作语义**：location、group、align、tab、command id、overlay id。**禁止**出现角色/时机/口上/存档等业务词（审计 D 项会抓）。
- 契约只加不改：所有新字段 optional，缺省行为 = 现状。任何中间态（部分插件已迁移）都必须可运行。
- 新建向导/💡建议等业务逻辑住插件；宿主只消费泛型贡献。新建命令默认归属 `ui-sugar-editor`（若实施时发现更合适归属，改并记 IMPLEMENTATION-LOG）。
- 布局状态走壳层 **localStorage**（`kojo.ui.layout.v1`），不动内核存储域。
- 新增内核事件（`ui.overlay.open`、写授权失效通知）是 additive 进 `KernelEventMap`，照 `editor.revealLocation` 同款模式（plugin-api events.ts + kernel bus 事件名表）。
- 无新插件计划；若确需新建，登记**四处**（HANDOFF §九-3）。

## 五、分期任务卡（顺序即依赖序，P0 先行是用户拍板）

### P0 写权限闭环批（F1/F2）
1. kernel `applyApprovedWritable` 不一致 → 新增内核事件通知（additive），App 收到后重弹 `WritableApprovalDialog`。
2. 壳层状态栏（可先以简化形态落地，P1 再换槽位化）：写权限徽章（可写/只读），点击重授权。
3. 通知中心（toast + action 按钮）；`WriteNotAllowedError` → 中文人话 +「去授权」action。
4. 只读时保存按钮置灰 + tooltip。
- 验收：旧批准记录场景重弹授权；只读保存友好提示；单测覆盖事件路径。

### P1 壳层骨架批（F3/F4/F6）
1. plugin-api：`ui.panel` +`location/group/defaultActive`（optional）。
2. 壳层五区布局 + 活动栏 + 三容器渲染器（未迁移面板按缺省 sidebar 渲染）。
3. localStorage 布局持久化（显隐/尺寸/激活项）+「重置布局」。
4. 滚动条主题化 + token 扩展（spacing/radius/z-index/字号）。
5. 10 面板按迁移表改注册参数；FileTree 改为与槽同构的壳层内建视图，与函数树同 `group:'explorer'`。
- 验收：面板各归其位；显隐/尺寸重启后保持；基线三项全绿。

### P2 命令与工具栏批（F5/F7）
1. editor.command 消费：命令注册表 + 命令面板（Ctrl+Shift+P/F1）+ keybinding 注册；快速打开（Ctrl+P，壳层）。
2. `ui.toolbar` 槽 + 顶部工具栏（左业务右布局）。
3. `ui.overlay` 槽 + `ui.overlay.open` 事件；新建口上文件命令（`ctrl+n`）+ 向导 overlay（ui-sugar-editor 贡献；命名知识经 adapter 契约）。
- 验收：新建 → 落盘 writablePaths 内 → 打开定位，端到端勾验。

### P3 编辑器深化批（多标签 + 💡）
1. 多标签（定稿 §6.4）：tabs 模型、per-tab model/viewState/脏基线、关闭确认扩展、Ctrl+W、全部保存。
2. `ui.editor.codeAction` 槽 + Monaco codeActionProvider 适配；ui-sugar-lift 迁移为 💡（aux 兜底面板 defaultActive:false 保留）。
3. `ui.statusbar` 槽；诊断计数贡献（ui-convention-report）；P0 的临时徽章槽位化。
- 验收：多 tab 脏态/切换/关闭矩阵；💡 应用冒烟。

### P4 停靠与全禅批
1. 三容器间拖拽移动面板 + override 持久化。
2. 全禅模式（定稿 §八）：隐藏五区只留编辑器+迷你状态栏；Ctrl+K Z / Esc；居中限宽（设置项）。
3. 设置 overlay（限宽开关等）；可选：面包屑槽。
- 验收：禅模式进出/持久化；拖拽后布局重启保持。

## 六、发版关联

- 本线 = **v0.4.0-beta.1 判据 ⑥**（P0–P4 全部 + 真实终端勾验）。判据未齐 root version 保持 `0.1.0`。
- 判据①–⑤ 不在本线范围，但 P0 的通知中心/重授权会被判据①的手工勾验直接用到。
