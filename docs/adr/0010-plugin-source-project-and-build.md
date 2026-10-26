# ADR-0010: 插件项目 = 工作区项目 —— 源不带哈希、构建可复现、三条写边界

- **日期**：2026-10-26
- **状态**：**已接受（设计口径定稿；实现未开工）**
- **相关**：[`LAUNCHER-ARCHITECTURE.md`](../LAUNCHER-ARCHITECTURE.md) v0.4 §9.2、§10.5、§16 风险 18/19/21、§17；
  ADR-0009（部署门禁）；`plugin-api/src/workspace.ts`（工作区模型）、`plugin-api/src/zip.ts::buildZip`、
  `plugin-api/src/game.ts` 顶部「两个曾经存在、现已删除的成员（别再往回加）」

## 背景

没有作者侧闭环，插件能力只能消费别人做好的 ZIP：作者想改一行逻辑，就得离开编辑器手工拼目录、
手算哈希、自己压 ZIP。这条路上的每个手工步骤都会出错，而且错法很隐蔽——包能装，装完不生效。

三条既有资产决定了这件事**不该从零造**：

- 工作区已有「项目 → 制品 → 文件」模型、常驻可写根与 `workspace.json` 持久化；
- `zip.ts::buildZip` 已在生产里被消费（`kojo-project-kit/src/package-actions.ts` 的导出链路），
  并由 `zip-roundtrip.test.ts` 对 golden 容器做逐字节对拍；
- 启动器已有安装管线（plan/apply/备份/回滚，ADR-0009）。

于是只剩一个设计问题：**插件项目住在哪、源和产物怎么分、谁能写哪里**。

## 决策

### 1. 模型：`WorkspaceProject` + `meta.kind='game-plugin'` + 一个制品

- 插件项目就是**工作区项目**；插件本体是项目内的**一个制品**（`WorkspaceArtifact`，首版 `dirName='plugin'`）。
- **不造第二套项目存储**：项目 → 制品 → 文件的模型、常驻写授权、`workspace.json` 持久化全部复用
  `kernel.workspaces`。新建/改名/删除/列举与口上项目走同一套服务。
- 项目住工作区（`{workspaceRoot}/{projectId}/`），**不在 `{appData}/launcher/` 下**；
  `launcher/` 只存实例侧已装产物与备份。删实例 / 清缓存 / 卸载插件**永远不会碰到作者源码**。
- `workspace.json` 的 `meta` 只存**指针**（`lastBuild` 摘要、`installedTarget`、`extractedFrom`、
  `adapterId` / `gameId`）；构建报告的权威副本在 `build/{buildId}.json`，两者不一致时以报告为准并提示重建。

### 2. 源 / 产物分离

| 形态 | 文件 | 有没有哈希 | 谁写 |
|---|---|---|---|
| 源 | `plugin/plugin.json`（`PluginSourceManifest`） | **没有** `files[]`、没有 `sha256` | 作者（编辑器，走内核 io） |
| 产物 | `build/{pluginId}-{version}.zip` + `build/{buildId}.json`（内含 `pack.json`） | 有：逐文件 `sha256` + `size` + ZIP 自身哈希 | 构建服务（core） |
| 已装 | `{appData}/launcher/instances/{id}/content/{packId}/` | 有：`ownership.json` + 清单快照 | 安装管线（宿主 + core） |

- **手写 `files[]` / 哈希即非法**：源清单里出现哈希 → `LAUNCHER_PLUGIN_PROJECT_INVALID`。
  这不是洁癖，是防伪造验收——安装门禁只信构建产物里的 `pack.json`。
- 三份副本的版本由 `inspectDrift` 一眼说清（决策 6），UI 同时显示「源 / 上次构建 / 已装」。
- `build/` 放**项目根**、不放制品里：放制品里会被下一次构建自己打包进去（自吞），并污染 `roots` 枚举；
  `.gitignore` 恒排除 `build/`。

### 3. 确定性构建复用 `zip.ts::buildZip`，不新增宿主打包命令

```text
[1] 读 plugin.json → 校验 schema / pluginId / version / gameId / roots / entrypoints
[2] 路径守卫（.. / 绝对路径 / 盘符 / UNC / ADS / 保留名 / 尾点尾空格）
[3] walkDir(from) → include/exclude 过滤 → 目标路径 = to + 相对路径
[4] 同一 rootId 下同一目标路径被两条映射命中 ⇒ 失败（不做隐式覆盖）
[5] 逐文件算 sha256 / size（宿主流式哈希）
[6] 生成 pack.json（ContentPackManifest）
[7] 写 build/staging/pack.json（报告最后写）
[8] buildZip(entries, { contract: 'extractable', date: <固定值> })
[9] 写 build/{buildId}.json
```

- **确定性由「调用方给定顺序 + 统一 `date`」保证，不是 `buildZip` 自动做的**：
  `buildZip` 按**收到的条目顺序**落盘，时间戳取 `opts.date`（缺省 `Date.now()`）或条目自带的
  `mtimeMs`，并夹到 DOS 时间可表示的 1980 起算区间（`DOS_EPOCH_YEAR`；更早的 mtime 一律夹到 1980-01-01）。
  因此构建必须**不读文件真实 mtime**、先把条目按 posix 路径排序、再传入固定 `date`——
  三者齐了才有「同源两次构建逐字节相同」；
  `buildId = sha256(pack.json 规范化文本 + 逐文件摘要)` 与时间无关，时间只进报告的 `builtAt`。
  这一条是消费侧责任——把它写成「buildZip 自己会排序」会让下一份实现漏掉排序而仍以为可复现。
  `zip-roundtrip.test.ts` 正是以显式 `date` + 固定条目表钉住逐字节相等。
- **不新增宿主打包命令**：宿主只留 `launcher_project_hash`（按给定相对路径**流式摘要**，
  大二进制不整包读进 JS）。`plugin.json` / `pack.json` 校验、`roots` 映射、`buildId`、报告全在 TS。
  理由：同一份打包逻辑用两种语言各写一遍 = 迟早漂；市场侧审计注释讲的正是这件事。
  若将来实测证明确需宿主打包（大包内存峰值），必须吃 `fixtures/zip-roundtrip/contract.json`
  同一张表，并**单独立 ADR** 记理由。
- 构建**不执行项目内任何代码**：没有 `npm install`、没有构建脚本、没有模板渲染器。
  `plugin.json` 是数据，不是可执行配置。
- 构建**不做安装门禁**（不读游戏目录）：风险升级、版本兼容、函数冲突、存档影响全部留到 `planInstall`
  ——构建是「产出确定的东西」，安装是「判断能不能进这个实例」。

### 4. 三条写边界（本项目最容易破的一条）

| # | 边界 | 执法 |
|---|---|---|
| 1 | 项目只写**工作区根**与项目自己的 `build/` | 内核 io 写闸（工作区根是常驻可写根）；输出路径由 core 拼死，**没有** `outRelPath` 之类参数 |
| 2 | 装配到实例**只走** `planInstall → applyInstall` | 启动器安装管线（ADR-0009）；没有「从 `build/` 直写实例」的旁路 |
| 3 | **编辑器不直写游戏目录**，即便当前打开的项目根就是目标实例的游戏根 | 改逻辑一律走安装计划；否则备份、`ownership`、回滚全部失效 |

### 5. 创建失败按路径清单逐条回滚，**不调 `workspaces.remove`**

`workspaces.remove` 的契约是「删除项目（**连同目录全部内容**）」。在创建失败时调用它有两个风险：
项目目录可能已经包含**不是本批写出的内容**（用户先前放进去的草稿、或路径解析落到了非预期目录），
一旦删就是不可逆误删。因此回滚口径是：

- 创建过程**累积本批写出的相对路径清单**（`plugin.json`、模板文件、`.gitignore`、`build/` 目录）；
- 失败时**按清单倒序逐条删除**，再按需删除本批创建的空目录；
- manifest 里的制品登记按 `removeArtifact` 语义撤销（只撤登记，不整目录清空）；
- 回滚本身失败要报出来（列出残留路径），不静默。

### 6. `inspectDrift` 三态与优先级

| 状态 | 条件 | UI |
|---|---|---|
| `not-installed` | 实例没装该 id | 「构建并安装」为主按钮 |
| `source-changed` | `plugin.json` 版本或源指纹与 `lastBuild` 不一致 | 黄条「源已改动，请重新构建」 |
| `installed-differs` | 已装版本 ≠ 上次构建版本（或哈希不同；不区分谁更新） | 黄条「实例里不是这个构建」 |
| `in-sync` | 源版本 = 上次构建 = 已装，且源指纹与 `buildSha256` 都对上 | 正常，仍允许重装 |

- 判定按优先级取**第一条命中**：`not-installed` → `source-changed` → `installed-differs` → `in-sync`；
  同时满足多条只显示最靠前的一条，不并列刷屏。
- 源指纹用 `plugin.json` 规范化文本 + 映射文件 `(路径, size, mtimeMs)` 的摘要，**不重算内容哈希**
  （打开项目不该全量读盘）。已知上限：mtime 回拨会漏报；构建时全量重算，产物哈希与上次不同即暴露。
- **`projectDir` 解析前必须先 `list()`**：默认根下的项目恒可解析（`<默认根>/<id>`），
  但落在**自选授权根**里的项目靠 `id → 目录` 缓存，而缓存只由 `list()` 填充，
  未命中时 `projectDir` 会**回落默认根**。拿回退值去写盘 = 在错误的目录里建项目。
  因此创建 / 构建 / 提取 / 打开源码的第一句都是 `await workspaces.list()`。

### 7. `GamePluginRules.scaffold` ≠ 已删除的 `GameAdapter.scaffold`

| 维度 | `GameAdapter.scaffold`（**已删除**） | `GamePluginRules.scaffold`（本设计新增） |
|---|---|---|
| 是否写盘 | 生成并**写进游戏目录** | **只返回内容**，不写盘 |
| 消费方 | 全仓**零调用方** | 插件项目创建向导 |
| 落点 | 游戏目录（绕过「工作区为权威」） | 工作区项目制品（core 经 `kernel.workspaces` 写入） |
| 与 `deps.scaffold` 的关系 | 无 | 形状重合时做**薄包装复用**，不复制第二份生成逻辑 |

`plugin-api/src/game.ts` 顶部已有「别再往回加」的判据记录：契约成员「要么有消费方，要么别加」。
各 adapter 现有的 `scaffold.ts` **纯生成器仍在**，那是「供数」真源（经 `deps.scaffold` 通道服务
新建口上向导）；本回调只是把同一批供数接到插件项目向导上。回滚与路径守卫都在 core 一侧，
写授权不随回调外泄。

## 备选方案（为何不选）

| 方案 | 为何不选 |
|---|---|
| 为插件另造项目存储 / 另立清单格式 | 两套项目生命周期、两套一致性检查、两套删除语义；否 |
| 源清单里带 `files[]` 与哈希（作者手填） | 手算必错，且 `pack.json` 可被伪造验收；哈希只在构建时算；否 |
| 宿主新增 `launcher_project_pack` 打包命令 | 双打包器必漂（市场 `contract.json` 的教训）；打包留在 TS，宿主只做流式摘要；否 |
| 构建产物直接写进实例（跳过 plan/apply） | 绕开备份、`ownership`、回滚与全部插件门禁；否 |
| 创建失败用 `workspaces.remove` 一把删 | 契约是「连同目录全部内容」，会删掉非本批内容；否 |
| 自动递增版本 / 构建时回写版本到源 | 工具替作者编版本会让「升级」变噪音；构建改源会让「源」不再是真源；否 |
| 提取为项目时整目录复制游戏 | 版权素材外流 + 体积失控 + 变成隐式导出；只复制 `ownership.json` 属于该插件的文件；否 |

## 后果与前置

**后果**：

- 一个项目首版只有一个插件制品，但 `artifacts` 按数组建模：日后「一个项目多个 addon」不需要改存储模型。
- 构建产物**不是免检理由**：仍过 ZIP 四重守卫、`pack.json` 哈希核对、全部插件门禁（ADR-0009）。
- 从已装插件提取的项目**不是逐字节等价**：按根重组目录、哈希注释丢失、原作者额外字段可能缺；
  `source='extracted'` 常驻徽标，且不写入 `trust.verified`——它不是原作者项目，不能冒充。
- `kojo-project-kit` 的项目面板对 `meta.kind === 'game-plugin'` 必须显示「插件项目」徽标、
  且不提供「部署到游戏目录」这类口上包动作（插件只能经安装管线进实例）。

**前置**（未满足前不得宣称已落地）：

1. `WorkspaceArtifactInput.files` 只有**文本**；二进制资源必须走 `io.writeBytes` 逐文件补写
   ——构建与创建两侧都要按字节，不做隐式转码。
2. `projectDir` 前先 `list()`（决策 6），三个入口（create / build / extract）同一条纪律。
3. 构建的条目**排序 + 固定 `date`** 由 core 保证；确定性验收＝同源两次构建逐字节相同。
4. ZIP 限额复用 `ZIP_EXTRACT_LIMITS` 与 `fixtures/zip-roundtrip/contract.json` 共享表，
   **不在 `launcher.ts` 另立第二份**；真实 P95 未定（ADR-0009 前置 3 同一条）。
5. 启动器视图与 `launcher-core` 全程**动态 import**：开机图余量仅 10 KB、dist 件数余量 5，
   任何静态入口都会当场红；阈值要动就单独一批。

**未解缺口**：构建期增量（文件监听，P2）、一个项目多制品的向导（P2）、
提取时保留原 `pack.json` 快照（P2）、`source-changed` 的 mtime 漏报（已知上限，靠构建暴露）。
