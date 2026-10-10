# 交接文档（v0.1 ✅ / v0.2 第一批 ✅ / 第二批 ✅ / 第三批 🚧）

> 更新：2026-10-10。**新会话从这里开始读，读完即可开工。**
> 上一会话完成 v0.1 全量（含桌面壳端到端）+ v0.2 第一批（约定校验器 + 索引响应式化）；
> 本会话完成 **v0.2 第二批：函数树导航（`ui-kojo-navigator`）**。

---

## 一、项目一句话

**kojo-editor** = eraTW 口上编辑器：结构感知（Monaco + ERB 语法）× 一切皆插件 × sav 快照回放（远期差异化核心）。
技术栈：pnpm monorepo · TS（TS7/vitest4/vite7）· Tauri2（Rust 只做 IO 原语）· React 19 · Monaco。

- 仓库：`D:\DSH\kojo-editor` = github.com/Poboking/kojo-editor
- 测试游戏目录：`D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)`（汉化整合版，CSV/ERB 均 UTF-8-BOM）

## 二、当前状态（30 秒版）

- **v0.1 全部完成**：kernel（DI/总线/存储域/文件IO/槽位/运行时）+ plugin-api + 3 插件 + Tauri 桌面壳，端到端已验证。
- **v0.2 第一批完成**（本会话）：
  1. **索引所有权收敛到 `erb-parser`**：订阅 `project.opened` 自动建索引并缓存，`currentIndex()/ensureIndex()` + `kojo.functionChanged` 广播；app 不再自建索引。
  2. **约定校验器**：`plugin-api/conventions.ts` 契约 + 新插件 `convention-linter`（引擎 + 内置通用规则）+ `eratw-adapter/conventions.ts`（4 条 eraTW 规则）+ 新插件 `ui-convention-report`（面板，点击问题跳转）。
  3. **通用导航事件 `editor.revealLocation`**（内核事件表新增）+ app 落地（打开文件并定位行）。
- **v0.2 第二批完成**（本会话）：
  1. **新插件 `ui-kojo-navigator`**（`ui.panel`）：角色 → 家族 → 面 → 函数 三维树；角色下拉 + 全量函数名搜索（含未归属）；点击 → `editor.revealLocation`。
  2. **`tree.ts` 纯逻辑**（零 React）：面语义排序（FACE_ORDER）、slot 数值排序、`declare` 单独成面、orphan 只计数不展开（99k 函数里非口上域占大头）。
  3. **家族规则经槽位查询获取**（按 `project.adapterId` 精确匹配），**不 import adapter 包**——多游戏共存天然正确。
  4. 集成冒烟新增「导航地基」断言：可归属角色 / 多家族角色 / 多面角色 / 最重角色。
- **真实工程基线（2026-10-10 实测）**：168 角色 / 2,285 ERB / 99,104 函数 / 去重名 99,101；家族识别 98.91%（109 家族）；索引 ~2.9s。
- **导航地基基线**：可归属角色 **141** | 多家族角色 **77** | 多面（>3）角色 **135** | 最重角色 **K49（3,099 函数 / 18 家族）**。
- **约定校验基线**：**757 项**（error 0 / warning 611 / info 146），耗时 ~5.7s。分规则：KX 占位符 603（去重函数名）/ 口上完整性 141 / FORM 三连符号 8 / MESSAGECHECK 结构 2 / 函数重名 3。
- 测试：**157 项全绿**；typecheck（root + app）通过；解耦审计 ✅（6 插件）。

## 三、文档索引（按权威性排序）

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **架构权威**：铁律、内核边界、GameProject 形状（§5）、**§5.8 v0.2 实施记录（校验器分层 + 规则误报治理）** |
| `docs/RESEARCH.md` | 技术调研 |
| `docs/adr/0001-0003` | 工具链 / game.adapter 服务键语义 / 壳架构 |
| `docs/HANDOFF.md`（本文件） | 交接状态 + 下一批动手清单 |
| `D:\DSH\reverse-engineering\eratw4.980-口上机制深挖.md` | **口上领域知识权威**（27 CASE 路由、MESSAGECHECK 位协议、家族命名、四件套） |
| `D:\DSH\reverse-engineering\eratw4.980-存档实战解析.md` | sav 协议（v1.0 前必读） |

## 四、代码地图（v0.2 第二批增补）

```
packages/
├── plugin-api/src/
│   ├── conventions.ts         # 约定校验器契约（规则/问题/上下文/报告/服务）
│   ├── services.ts            # +WellKnownServices.ConventionLinter='convention.linter'
│   ├── events.ts              # +KernelEventMap['editor.revealLocation']
│   ├── erb.ts                 # ErbParserService +currentIndex()/ensureIndex()
│   └── game.ts                # ConventionRule 迁往 conventions.ts（re-export 保持兼容）
├── kernel/src/bus.ts          # +KERNEL_EVENT_NAMES: 'editor.revealLocation'
├── plugins/
│   ├── erb-parser/src/plugin.ts        # 响应式索引所有权（订阅 project.opened/closed）
│   ├── eratw-adapter/src/conventions.ts# eraTW 4 条规则（KX/四件套/FORM/MESSAGECHECK）
│   ├── convention-linter/src/          # 引擎（engine.ts + rules/duplicate-function.ts）
│   ├── ui-convention-report/src/index.ts # ui.panel 面板（订阅 linter；点击 → revealLocation）
│   └── ui-kojo-navigator/src/          # ★ 新增：函数树导航
│       ├── tree.ts                     # ★ 纯逻辑：buildNavigatorTree / searchFunctions（零 React，可单测）
│       └── index.ts                    # ★ ui.panel：角色下拉 + 搜索 + 可折叠树 → revealLocation
└── app/src/
    ├── bootstrap.ts           # 注册 6 个插件
    ├── ui/App.tsx             # 订阅 kojo.functionChanged / editor.revealLocation
    ├── ui/ProjectView.tsx     # 透传 reveal
    ├── ui/EditorPane.tsx      # revealLine/revealNonce → Monaco revealLineInCenter
    └── styles.css             # +约定面板样式 +导航面板样式（nav-*）
```

## 五、验证矩阵（怎么跑）

```bash
cd D:\DSH\kojo-editor
pnpm install
pnpm test               # 157 项（无游戏目录时集成冒烟自动跳过）
pnpm typecheck          # root + app（app: pnpm --filter @kojo/app typecheck）
pnpm audit:decoupling   # 必须 ✅（plugins 数 6）
# 真实工程集成冒烟（168 角色/2285 文件/99k 函数/家族覆盖率/导航地基/校验报告断言）：
KOJO_SMOKE_PROJECT="D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)" pnpm vitest run packages/kernel/tests/integration-plugins.test.ts
# 桌面壳（会弹窗 ~30s 自动关闭）：
node tools/smoke-tauri-dom.mjs
```

**架构铁律（改动前默念）**：
1. 内核/契约/Rust 宿主**零游戏名词**（审计 A 项，只查代码行；行尾 `// audit-allow: <理由>` 可豁免）；
2. 插件**只许依赖 `@kojo/plugin-api`**，禁 import kernel、禁插件间交叉 import（审计 B/C 项；**测试文件豁免 C 项**）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享术语（kojo/chara）放 plugin-api；
4. 内核不静默：inactive 必须可见、冲突必须 error、**校验规则抛错必须进 `report.failedRules`**；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（白名单在内核 io 强制）。

## 六、v0.2 第二批（✅ 已完成）：函数树导航 `ui-kojo-navigator`

**实施结果**：插件已落地（`packages/plugins/ui-kojo-navigator/`）。`tree.ts` 纯逻辑 10 项单测（三维聚合 / declare 成面 / slot 数值排序 / 面语义排序 / orphan 计数 / 搜索边界）；集成冒烟新增导航地基断言（可归属角色 **141** / 多家族角色 **77** / 多面角色 **135** / 最重角色 **K49 = 3,099 函数 / 18 家族**）。

### 6.1 数据已就绪
- `erb.parser` 的 `ErbIndex`（files/byName）+ `currentIndex()/ensureIndex()`；索引自动更新并发 `kojo.functionChanged`。
- adapter 的 `parseKojoFamily`（`FamilyMatch`：kind/prefix/family/characterNo/face/sub/isMessageCheck/slot/isPlaceholder）。

### 6.2 导航三维
角色（`project.charaIndex`）→ 家族（`FamilyMatch.family`，含 `''`=初始家族）→ 面（`face`，按调用语义排序）→ 具体函数（按 `slot` 排序）。
- 「初始家族」函数名不含家族段（`M_KOJO_MESSAGE_COM_K{n}_xx`），靠 `characterNo` 关联角色。
- 家族名大小写归一：`normalizedName` 已备（Emuera 语义全大写比较）。

### 6.3 实现形态（建议）
- 新建 **`ui-kojo-navigator` 插件**（`ui.panel` 贡献），`requires: ['erb.parser', 'kernel.project', 'kernel.slots']`；通过 `game.adapter` 槽位查询取 `functionFamilyIndex`，**不 import adapter 包**（解耦铁律）。
- 点击函数 → `ctx.bus.emit('editor.revealLocation', { filePath, line: startLine })` —— 复用本批已落地的跳转通道（app 已消费）。
- 保留 app 现有 FileTree（文件维度浏览）作为互补；面板负责"函数/家族维度"。

### 6.4 第三批（下一批）：条件抽取 + 其它排队项
- **条件抽取**（为 v1.0 差分矩阵服务）：扩展 `erb-parser/src/scanner.ts`（PRINT 变体 / IF-SELECTCASE 嵌套层级，已留扩展点）→ 新插件 `condition-extractor` 提取每个函数的条件谓词（好感 `CFLAG:2` / 信赖 `CFLAG:4` / `MAXABL` 恋慕闸门 / MESSAGECHECK 位 / 时间窗），供导航面板徽章或独立矩阵面板消费。
- **导航面板增强**（可选）：面上条件徽章、MESSAGECHECK 位可视化、收藏/最近访问。
- `watchDirs` 文件监视（现为手动刷新；后续走 Rust notify）→ 增量重建索引。
- sav-parser（v1.0）：先读 `reverse-engineering/eratw4.980-存档实战解析.md` + 复用 `sav-parse/parse_sav.cjs` 协议。
- Monaco bundle 4.3MB 拆分（manualChunks，低优先级）。

## 七、安全模型（写文件功能相关必读）

- 写入仅允许 `writablePaths`（用户批准 + 持久化于 kernel 存储域 `_global`），越权抛 `WriteNotAllowedError`；
- 写回**保编码保换行**（首读探测缓存：utf-8-bom / utf-8 / shift_jis / utf-16；eol 多数派）；
- 原子写（临时文件+rename）+ 自动备份 `{appData}/backup/{hash}/`（保留 20 版）；
- UI 侧「只读浏览」永远可用（未批准 = 不可写，不阻塞浏览）。

## 八、环境坑速查（本机，2026-10 实测）

| 坑 | 对策 |
|---|---|
| 沙箱注入的 `HTTP(S)_PROXY=127.0.0.1:8587` 是**坏的**，git/curl 默认走它必失败 | **推送一律用 `node tools/git-push.mjs`**（内部清空全部代理环境变量直连+重试） |
| github 直连时通时断 | git-push.mjs 已内置 6 轮×5s 重试，失败就隔几分钟再试 |
| npm/pnpm registry=npmmirror **直连可用** | 别给镜像配代理（ECONNREFUSED）；项目 `.npmrc` 已固定 |
| pnpm 11 供应链策略拦构建脚本 | pnpm-workspace.yaml `allowBuilds` 显式批准（esbuild 已批） |
| bash coreutils 时常 127；`node -e` 多层引号/Markdown 反引号必翻车 | 一切用 node 临时 `.mjs` 文件或 Read/Write/Edit 工具；PowerShell 工具 stdout 不回显 |
| **Edit 工具偶发"声称成功未落盘"，且同文件并行 Edit 会 EBUSY** | 关键修改后读回验证；**同一文件的多次 Edit 必须串行** |
| 模板字符串里写 Markdown 反引号（如 \`====\`）会截断 TS 模板串 | 用「」代替反引号 |
| cargo 输出带 ANSI 色码 | 正则匹配前先 stripAnsi（tools/smoke-*.mjs 有现成函数） |
| crates.io 直连慢 | cargo 首次 build 已完成，之后增量秒级 |

## 九、本会话踩坑记录（给未来的自己）

1. **规则必须先核验引擎源码再定语义**：FORM 三连符号初版按"字面出现即报"实现 → 239 条里大量是 `+++`（MASTER 名）的有意用法（43 个文件）。收窄为排除 `+++` + 每文件每符号聚合 → 8 条真实事故。见 ARCHITECTURE §5.8"规则误报治理原则"。
2. **`ctx.onDispose` 是插件订阅/清理的必经之路**：事件订阅不 `onDispose` 会导致插件停用后残留 handler（内核 deactivate 逆序执行 disposer）。erb-parser / convention-linter 均照此。
3. 新增插件包需四处登记：`packages/plugins/*/package.json`、root `tsconfig.json` paths、`vitest.config.ts` aliases、`app/vite.config.ts` aliases + `app/package.json` deps（kernel devDeps 亦然）。漏一处就 resolve 失败。

## 十、新会话动手清单

1. `cd D:\DSH\kojo-editor && pnpm install`
2. `pnpm test && pnpm typecheck && pnpm audit:decoupling` —— **确认三项全绿**（基线）
3. 读 `docs/ARCHITECTURE.md` §5.8 + 本文件 §六
4. **开始 v0.2 第三批：条件抽取**（见 §6.4：先扩展 `scanner.ts`，再建 `condition-extractor` 插件）
5. 每完成一批：`pnpm test` 全绿 → Conventional Commits 提交 → `node tools/git-push.mjs`
