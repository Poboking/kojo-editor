# kojo-editor

> 口上编辑器 —— 面向 eraTW（及后续 era 系游戏）口上作者的结构感知编辑器。
> 架构采用「一切皆插件」的解耦设计：**内核零游戏知识**，扩展新游戏 = 新增一个适配器插件，内核零改动。

## 为什么

eraTW 口上生态的现状：2,285 个文件、99,104 个函数的剧本库，工具链却停留在记事本 + 全文 Grep。
作者的真实痛点（详见 [RESEARCH.md](docs/RESEARCH.md)）：

- 函数归属与触发时机全靠 Grep（官方教程的答案就是"去 Grep `KOJO_MESSAGE_SEND`"）；
- 函数名写错 = 静默失效，家族完整性靠人肉核对；
- 改一行台词要"开游戏 → 玩到对应状态 → 肉眼验收"，深条件状态要 grind 十几分钟；
- 编码混杂（Shift-JIS / UTF-8-BOM），改坏文件是常态。

本项目的答案是三个递进的工具层：**导航与校验** → **脚手架与置换** → **状态快照回放**。

## 架构

```
┌─────────────────────────────────────────────────┐
│ 插件层（一切皆插件）                              │
│  erb-parser │ eratw-adapter │ sav-parser │ ...  │
├─────────────────────────────────────────────────┤
│ 槽位注册表（同槽多注册 + order 显式排序）           │
├─────────────────────────────────────────────────┤
│ 内核（只做四件事）                                │
│ DI 容器 │ 事件总线 │ 存储域 │ 文件 IO              │
└─────────────────────────────────────────────────┘
```

铁律与关键机制：

1. **内核源码中不允许出现任何具体游戏名**（eraTW / eraK / …）。一切游戏知识只在 `game.adapter` 插件。
2. **插件间禁止直接 import**，只能通过 `@kojo/plugin-api` 的类型 + 内核服务（DI）交互。
3. **依赖缺位不静默**：状态面板强制显示 `active / inactive(缺 X) / error(原因)`，依赖满足后自动激活。
4. **生命周期完全可逆**：deactivate 时自动逆序执行 disposer、撤销槽位、释放服务（开发工具必须能热重载插件）。
5. **写保护是内核级不变量**：游戏目录整体只读，只有显式批准的白名单路径可写；写前自动备份 + 原子写；**编码读时探测、写时保持**。

完整设计见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，调研依据见 [RESEARCH.md](docs/RESEARCH.md)。

## 目录

```
packages/
├── plugin-api/               # 唯一公共契约包（类型 + 纯函数工具，零平台依赖）
├── kernel/                   # 内核：DI / 事件 / 存储域 / 文件 IO / 槽位 / 插件运行时
├── plugins/
│   ├── erb-parser/           # ERB 结构感知解析 + 全量函数索引 + 控制流骨架
│   ├── eratw-adapter/        # eraTW 全部领域知识（唯一允许出现游戏名之处）
│   ├── convention-linter/    # 约定校验引擎（零游戏知识；内置通用规则 + 糖侧静态规则）
│   ├── condition-extractor/  # 条件谓词抽取（表达式 AST + 状态依赖聚合）
│   ├── sav-parser/           # 存档快照源（纯读；写侧 v1.1）
│   ├── state-replay/         # 状态回放（快照 → 三值求值 + 分支走向）
│   ├── kojo-sugar/           # 语法糖转译（.kojo → ERB，v0.3）
│   ├── ui-convention-report/ # 校验结果面板
│   ├── ui-kojo-navigator/    # 函数树导航面板（角色→家族→面→函数）
│   ├── ui-state-replay/      # 状态回放面板
│   ├── ui-archive-browser/   # 存档浏览器
│   ├── ui-snapshot-injector/ # 状态注入器面板
│   └── ui-plugin-status/     # 插件状态面板
└── app/                      # 桌面壳：Tauri（Rust：IO 原语）+ React + Monaco
docs/                         # 架构 / 调研 / ADR / 基线 / 交接
fixtures/                     # 合成样本（真实游戏数据不入库）
```

内核运行在 WebView 前端（TS 同构、可在 Node 下全量测试），Tauri 侧只提供 PlatformBridge 原语——详见 [0003-shell-architecture.md](docs/adr/0003-shell-architecture.md)。

## 面向口上作者

1. **获取**：目前从源码构建桌面壳（见下方「运行桌面壳」）；预编译安装包随 v0.3 写链路交付后提供。
2. **选择游戏目录**：首次启动在欢迎页选择 eraTW 游戏目录，工具自动识别并索引。
3. **确认写权限**：可拒绝——**只读浏览始终可用**；批准后才会写入，且写前自动备份。
4. **日常使用**：
   - **浏览**：侧栏按角色列出全部口上文件；
   - **校验**：「约定校验」面板列出全部问题，点击即跳转到对应文件行；
   - **导航**：「函数树」面板按 角色 → 家族 → 面 → 函数 浏览 99k 函数，点击定位；
   - **回放**：「状态回放」面板选中某个存档与角色，看每条触发条件的真假与分支走向；
   - **注入**：「状态注入器」把变量改动写入**测试档**（两步确认 + 自动备份 + 回读验证）；
   - **编辑**：Monaco 中编辑，保存时保持原编码与换行。

## 开发

```bash
pnpm install
pnpm test              # vitest：单元 + 集成测试（未设游戏目录时集成冒烟自动跳过；实测 689 通过 / 6 跳过）
pnpm typecheck         # root 包类型检查
pnpm audit:decoupling  # 「一切皆插件」解耦审计（内核零游戏名 / 插件依赖纪律）
```

无真实游戏目录的贡献者可用合成样本跑「迷你模式」冒烟：

```bash
node tools/gen-fixtures.mjs   # 生成 fixtures/mini-game（合成目录骨架）
node node_modules/vitest/vitest.mjs run packages/kernel/tests/fixtures-mini.test.ts
```

真实工程集成冒烟（需要本地 eraTW 目录，不设置则自动跳过）：

```bash
KOJO_SMOKE_PROJECT="D:/path/to/eratw" pnpm test
```

## 运行桌面壳

```bash
pnpm --filter @kojo/app tauri dev     # 首次需 cargo 编译 Tauri 依赖树（约 20-30 分钟）
```

## 路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0.1 | monorepo + kernel + plugin-api + 插件运行时 + Tauri 壳 + Monaco | ✅ 完成 |
| v0.2 | 十八批：约定校验 / 家族导航 / 条件抽取 / 快照源 / 状态回放 / 回放面板 / 分支走向 / 注入器地基 | ✅ 完成 |
| v1.0 | 快照回放收口（有界内联求值 + 分支走向 + 信任闭环 + 协议覆盖校验） | ✅ 完成 |
| v1.1 | 状态注入器（读档 → 改值 → 备份 → 回读验证 + 两步确认 UI） | ✅ 完成 |
| v0.3 | 语法糖 `.kojo` → ERB：S1 契约+golden / S2 转译内核 / S3 写盘 | 🔄 S1–S2 ✅，S3 进行中 |
| v0.2.5 | 收尾：CI + README + 编码往返 golden + 合成 fixtures | 🔄 本批 |

批次明细见 [HANDOFF.md](docs/HANDOFF.md) §二/§六；语法糖表层语法见 [SYNTAX-SUGAR-SURFACE-SPEC.md](docs/SYNTAX-SUGAR-SURFACE-SPEC.md)。

## 基线

除下方最强数字外，全部实测数据与口径见 [BASELINES.md](docs/BASELINES.md)。
一句话：**99,104 函数全量索引 2.9 秒，家族识别 98.91%**；状态回放未知率 **32.0%**。

## 许可

[MIT](LICENSE)（内核与工具代码；不内置任何游戏内容）。