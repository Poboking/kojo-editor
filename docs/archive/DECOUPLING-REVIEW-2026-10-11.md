# 解耦审阅：「一切皆插件」合规检查（2026-10-11 晚）

> **修复状态（同日晚）**：M1–M4 已全量修复并入库，落地细节见 `IMPLEMENTATION-LOG.md` §5.48
> （M1 的方案在实施中修正：`KERNEL_EVENT_NAMES` 语义 = 插件可 emit 子集而非全部 Map 键，
> 故单一真源采用「emit 权限全量分类两表 + 编译期穷尽断言」，而非本审阅初拟的「白名单=Map 键集」）。

> 审阅范围：`ed68f23..HEAD`（UI 重设计批 P0–P3b + 审阅修复，app 层 +3,314 行 /
> 契约 +71 / kernel +8）＋ 全仓结构性复查。
> 方法：`pnpm audit:decoupling`（A–D 四项全绿，16 插件）＋ 人工源码复审——自动探针
> 只扫字面量且**不覆盖 app 宿主层**，本轮新代码大头恰在宿主层，故人工过。

## 一、结论（30 秒版）

**架构纪律整体优秀，新批次延续了高水准**：五槽一事件全部 additive 通用词汇、
命令/工具栏/状态栏/overlay/CodeAction 全部槽驱动、新建向导教科书级 fail-closed。
但人工复审发现 **1 个有前科实锤的结构性风险（M1）+ 2 个审计盲区泄漏（M2/M3）**：

| # | 级别 | 发现 | 状态 |
|---|------|------|------|
| M1 | 中 | 事件名双源漂移——**已造成过一次运行时断裂**（0bf2eb9），且修复未加防再犯测试 | 需修 |
| M2 | 中低 | 宿主层功能性文案绑死 eraTW（审计 A 不扫 app 的盲区） | 建议修 |
| M3 | 低 | 宿主硬编码插件命令 id（有优雅降级兜底） | 可缓 |
| M4 | 低 | 工作区卫生：`preview/*.exe` 未 ignore、三份 docs 未入库 | 顺手 |

## 二、发现明细

### M1（最值得修）· 事件名双源漂移，已出过一次事故

- **事实**：内核事件名存在**两份手工同步的清单**——`plugin-api/src/events.ts` 的
  `KernelEventMap`（类型层）与 `kernel/src/bus.ts` 的 `KERNEL_EVENT_NAMES`
  （运行时白名单，`scopedBus` emit 纪律的执法依据）。
- **前科**：P1/P2 批给 events.ts 加了 `editor.activeFileChanged` / `ui.overlay.open`
  / `ui.overlay.close` 三个事件的类型，**漏改 kernel 白名单**——插件 emit
  `ui.overlay.open` 被 scopedBus 命名空间纪律拦截抛错，P2 新建向导命令链直接断裂
  （commit 0bf2eb9 就是修这个）。类型层编译全绿、探针全绿，**只有运行时才炸**。
- **缺口**：0bf2eb9 只补了名单，**没加防再犯的测试/断言**——同类事故会再发生。
- **建议修法**（契约 additive，半小时量级）：
  1. `KERNEL_EVENT_NAMES` 搬到 `plugin-api/src/events.ts`，与 `KernelEventMap`
     同文件相邻（kernel 反向 import——依赖方向本就 kernel→plugin-api）；
  2. 加**类型级穷尽断言**：`type _Sync = [Exclude<keyof KernelEventMap, (typeof NAMES)[number]>] extends [never] ? true : never`，两清单不同步即编译红；
  3. 单测补一条：白名单逐键 === Map 键集合（运行时兜底，防绕过类型的拼错）。

### M2 · 宿主层游戏词泄漏（audit A 的覆盖盲区）

audit A 只扫 kernel / plugin-api / Rust 宿主，**不扫 `packages/app`**。本轮
app 层新增文案里有三处功能性游戏绑定：

| 位置 | 内容 | 问题 |
|------|------|------|
| App.tsx:180 | 对话框标题「选择 eraTW 游戏目录」 | 第二个 adapter 出现即失真 |
| WelcomeView.tsx:35 | 按钮文案同上 | 同上 |
| WelcomeView.tsx:61 | 「请求对「個人口上」目录的写权限确认」 | 個人口上 = eraTW 专属目录概念（本来自 adapter 的 writablePaths） |

- WelcomeView:22 tagline「eraTW 口上编辑器」属**产品品牌位**，可留（产品定位本身
  就是 eraTW 工具；品牌 ≠ 游戏知识）。
- **建议**：功能文案改通用（「选择游戏目录」/「游戏写目录」）；若想保留指名，
  契约 additive 给 adapter 加 `gameLabel?`（单一真源在 adapter，宿主动态取）。
  顺带给 audit-decoupling.mjs 加 **E 项：扫 `packages/app/src` 游戏词**
  （豁免清单：bootstrap.ts 组合根、WelcomeView 品牌位）——把盲区变成探针。

### M3 · 宿主硬编码插件命令 id

- ProjectView.tsx:219-220 空态按钮直接引用 `'kojo.newKojoFile'`（ui-sugar-editor
  注册的命令 id）。有 `workbench.hasCommand()` 守卫，插件缺席时按钮整体隐藏——
  **降级姿势正确**，属「容知的耦合」而非破坏。
- 同类先例：app 宿主 import `@kojo/plugin-kojo-sugar` 词表（S6 定案，单一真源取向）。
- **建议**（可缓）：按 `WellKnownServices` 模式在契约加 `WellKnownCommands`
  常量表（additive），宿主与插件共用的 id 字符串单一真源。趋势监控点：这类
  硬引用若从 1 处涨到 5 处，就该做。

### M4 · 工作区卫生

- `preview/kojo-editor-v0.4.0-beta.1-preview.exe` 未跟踪——建议 `.gitignore` 加
  `preview/`（构建产物不进库）。
- `docs/CODE-REVIEW-2026-10-11.md` / `PERF-ANALYSIS-2026-10-11.md` /
  `PERF-REVIEW-2026-10-11.md` 三份未入库，随下批 docs commit 一并收。

## 三、通过项点名（本轮新代码的可取之处）

1. **契约层（plugin-api/slots.ts +71）**：五个新槽（`ui.toolbar` / `ui.statusbar`
   / `ui.overlay` / `ui.editor.codeAction` / `editor.command`+keybinding）全部
   通用词汇、全部 additive、缺省行为向后兼容（location 缺省 = 旧 sidebar 堆叠）。
   「动作真源在命令、工具栏只引用 id」的设计直接杜绝了双动作定义漂移。
2. **命令体系（app/ui/commands.ts + Palette）**：纯逻辑零 React 零业务词，
   壳层命令与槽贡献合并为统一注册表（同 id 槽贡献可覆盖壳层默认——插件优先，
   方向正确）；快速打开候选是泛型路径过滤，零游戏知识。
3. **CodeAction 宿主适配（EditorPane:513-527）**：宿主只做 Monaco 协议转换
   （registerCodeActionProvider + registerCommand + id 反查），动作产出全在
   插件纯函数 `provideActions`——宿主零糖知识，与 decorator/saveHandler 同款范式。
4. **新建向导（ui-sugar-editor/new-file-wizard.ts）**：全槽驱动（face 表查
   `game.adapter`、落盘走内核 io 闸 + writablePaths），模板缺席显式不可用
   （fail-closed 不猜命名）——本轮解耦质量最高的一块。
5. **外部变更重载（external-change.ts）**：noop/reload/conflict 三态决策纯函数，
   「谁改盘谁发 file.changed」的事件纪律让宿主零插件知识完成 B1 修复。
6. **结构性复查全过**：16 插件零 `@kojo/kernel` import、零交叉 import、零
   monaco import；plugin-api 零 react/monaco import（契约纯净）；游戏知识
   仍然唯一住在 eratw-adapter（bootstrap.ts 组合根注释明示「唯一知道游戏名的地方」）。
7. **事件命名空间纪律（scopedBus）**运行有效——讽刺的是 M1 的事故正是它抓的：
   纪律本身是好设计，坏的是喂给它的名单是手工抄的。

## 四、既定取舍重申（非违规，记录在案）

- **10 个 UI 插件直接 import react**：既定约定（`UIPanelComponent` 宽签名
  `(props) => unknown` 留了换渲染框架的口子，但实际全员 react）。换宿主渲染
  框架 = 全部 UI 插件重写，这是已知情且接受的代价。
- **宿主内建视图**（口上文件树/快速打开/命令面板）以「与槽同构的贡献形态」注入
  壳层（P1 定稿 §五-3 的显式取舍）：宿主功能密度在涨，若将来要纯化，这三块可
  平移为 builtin 插件且零契约变化——退路是通的，暂不动。
- **内核事件词汇表膨胀**（12 个，跨 kojo/editor/ui/state/plugin 五个前缀）：
  全是通用词汇、无游戏知识，合规；但「每加一个 UI 意图都要动 kernel/bus.ts」
  的维护成本在 M1 修掉同步双源后即大幅消解。

## 五、建议执行序

1. **M1 修复批**（优先）：白名单归一 plugin-api + 类型级断言 + 单测——这是
   已发生过事故的结构隐患，修复成本最低、防再犯收益最高；
2. **M2 + audit E 项**：三处文案通用化（或 adapter gameLabel）+ 探针扫 app 层；
3. **M4 顺手**：.gitignore + 三份 docs 随下批入库；
4. M3 观察：`WellKnownCommands` 等硬引用涨到 ≥3 处再立批。

—— 审阅人：Haruki（WorkBuddy），2026-10-11 20:00
