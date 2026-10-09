# 交接文档（v0.1 ✅ → v0.2 🚧）

> 更新：2026-10-10 01:10。**新会话从这里开始读，读完即可开工。**
> 上一会话完成了整个 v0.1（含桌面壳端到端验证）与 v0.2 的家族识别地基，全部已推送。

---

## 一、项目一句话

**kojo-editor** = eraTW 口上编辑器：结构感知（Monaco + ERB 语法）× 一切皆插件 × sav 快照回放（远期差异化核心）。
技术栈：pnpm monorepo · TS（TS7/vitest4/vite7）· Tauri2（Rust 只做 IO 原语）· React 19 · Monaco。

- 仓库：`D:\DSH\kojo-editor` = github.com/Poboking/kojo-editor（**当前 18 commits，工作区干净，本地=远程**）
- 测试游戏目录：`D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)`（汉化整合版，CSV/ERB 均 UTF-8-BOM）

## 二、当前状态（30 秒版）

- **v0.1 全部完成**：kernel（DI/总线/存储域/文件IO/槽位/运行时）+ plugin-api + 3 插件 + Tauri 桌面壳。
- **桌面壳端到端已验证**：cargo 编译通过（增量启动仅 ~2s）、vite→WebView→React→内核 bootstrap 3/3 插件（CDP 抓 DOM 实证欢迎页按钮渲染）。
- **真实工程基线**：168 角色映射 / 2,285 ERB / 99,104 函数，全量索引 2.9s；家族识别 98.9%；发现 **1,546 处 `_KX_` 占位符残留**（模板置换事故实证 → 校验器杀手项）。
- **v0.2 地基已就绪**：家族识别规则（family-index）已实现并验证；校验器契约（ConventionRule）已在 plugin-api 定义。

## 三、文档索引（按权威性排序）

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **架构权威**：一切皆插件铁律、内核边界、GameProject 通用形状（§5） |
| `docs/RESEARCH.md` | 技术调研（Monaco/编辑器方案对比） |
| `docs/adr/0001-0003` | 工具链选型 / game.adapter 服务键语义 / 壳架构（内核跑 WebView，Rust 仅 IO 原语） |
| `docs/HANDOFF.md`（本文件） | 交接状态 + v0.2 动手清单 |
| `D:\DSH\reverse-engineering\eratw4.980-口上机制深挖.md` | **口上领域知识权威**（27 CASE 路由表、MESSAGECHECK 位协议、家族命名） |
| `D:\DSH\reverse-engineering\eratw4.980-存档实战解析.md` | sav 协议（v1.0 前必读） |

## 四、代码地图

```
packages/
├── plugin-api/src/            # 唯一公共契约包（类型+纯函数）。改动需慎重（所有插件依赖它）
│   ├── plugin.ts              #   Plugin/PluginContext（provide/inject/slots/bus/storage）
│   ├── services.ts            #   内核服务键 kernel.* 与知名服务键 game.adapter/erb.parser
│   ├── game.ts                #   GameAdapter/GameProject/CharaInfo/FamilyMatch/ConventionRule
│   ├── erb.ts                 #   ErbFile/ErbFunction/ErbIndex/ErbParserService
│   └── paths.ts               #   跨平台路径纯工具（join/isPathUnder/pathKey…）
├── kernel/src/                # 内核（零游戏知识！）
│   ├── kernel.ts              #   createKernel 组装 + ServiceQuery（宿主/UI 取服务通道）
│   ├── runtime.ts             #   插件运行时：inactive 可见+自动激活、停用完全可逆、环检测
│   ├── container.ts / bus.ts / slots.ts / storage.ts
│   ├── io.ts                  #   FileIOServiceImpl：编码探测/保编码写回/原子写/备份20版/写白名单
│   └── project.ts             #   onboarding 骨架：轮询 adapter.detect → loadProject → 事件
├── plugins/
│   ├── erb-parser/src/        # scanner.ts（行状态机）+ plugin.ts（buildIndex 并发12）
│   ├── eratw-adapter/src/     # 全部 eraTW 知识：
│   │   ├── constants.ts       #   路径/特征常量
│   │   ├── chara-csv.ts       #   番号/名前/呼び名 解析
│   │   ├── family-index.ts    #   ★ 函数家族识别（98.9%，v0.2 导航与校验的地基）
│   │   └── plugin.ts          #   detect/loadProject/挂 functionFamilyIndex
│   └── ui-plugin-status/src/  # 插件状态面板（ui.panel 槽示例，createElement 无 JSX）
├── app/
│   ├── src/                   # React：App(ui/App.tsx 容器)/WelcomeView/ProjectView/FileTree/EditorPane
│   │   ├── bridge/            # tauri-bridge（PlatformBridge 实现，base64 跨 IPC）
│   │   ├── bootstrap.ts       # 组合根：createKernel + 3 插件 + start
│   │   └── monaco/erb-language.ts # ERB Monarch 高亮
│   └── src-tauri/src/lib.rs   # Rust：14 条 IO 原语命令（零游戏知识）
tools/
├── audit-decoupling.mjs       # pnpm audit:decoupling（解耦审计，必须保持全绿）
├── analyze-kojo-names.mjs     # 家族命名分析（数据驱动开发范本；游戏目录作 argv）
├── smoke-tauri-dom.mjs        # 桌面壳 DOM 级冒烟（CDP 连 WebView2 :9222）
└── git-push.mjs               # 带重试的直连推送（本机网络专用，见 §八）
```

## 五、验证矩阵（怎么跑）

```bash
cd D:\DSH\kojo-editor
pnpm install
pnpm test               # 128 项（无游戏目录时集成冒烟自动跳过）
pnpm typecheck          # root tsconfig（含所有包与测试）
pnpm audit:decoupling   # 解耦审计——任何改动后必须保持 ✅
# 真实工程集成冒烟（168 角色/2285 文件/99k 函数/家族覆盖率断言）：
set KOJO_SMOKE_PROJECT=D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)
pnpm test
# 桌面壳（会弹窗 ~30s 自动关闭）：
node tools/smoke-tauri-dom.mjs
```

**架构铁律（改动前默念）**：
1. 内核/契约/Rust 宿主**零游戏名词**（审计 A 项，只查代码行）；
2. 插件**只许依赖 `@kojo/plugin-api`**，禁 import kernel、禁插件间交叉 import（审计 B/C 项）；
3. 游戏知识只能进 eratw-adapter；跨游戏共享的领域术语（kojo/chara）放 plugin-api；
4. 内核不静默：inactive 必须可见（missing 列表）、冲突必须 error、detect 多命中必须告警；
5. 游戏目录整体只读，写入仅限用户批准的 `writablePaths`（白名单在内核 io 强制）。

## 六、v0.2 路线（下一步就干这个）

### 6.1 约定校验器（建议第一批：价值最高、纯逻辑、直接打痛点）

- **契约已就绪**：`plugin-api/src/game.ts` 的 `ConventionRule { id, severity, check(ctx): ConventionIssue[] }`；adapter 的 `conventions?: ConventionRule[]` 挂载点已预留。
- **建议规则清单**（按优先级，依据 = 真实数据实证）：
  1. **KX 占位符残留**：`/_KX(?:_|$)/`——实测 1,546 处。家族识别已把它们标为 `kind:'placeholder'`，直接消费 FamilyMatch。
  2. **四件套完整性**：每个有口上目录的角色（charaIndex.kojoDir）应存在 `M_KOJO_K{no}` 声明函数（family-index `kind:'declare'`）＋ FLAGSETTING ＋ COLOR ＋ VERSION（缺 → 警告）。
  3. **MESSAGECHECK 位协议**：`isMessageCheck` 的函数体第一可执行语句应是 `IF 0` 起始位掩码（细节见逆向文档《口上机制深挖》§MESSAGECHECK；先做结构存在性检查，语义校验放后）。
  4. **FORM 串三连符号**：`===`/`***`/`+++`/`///`/`$$$` 在 ERB 中会被引擎替换为角色名 → 口上文件里用作分隔线会翻车（引擎 bug 定案，见逆向文档）；扫描 PRINTFORM 字符串字面量。
  5. **重名定义提示**：`ErbIndex.byName` 中同名多定义（当前 3 处）→ info 级。
- **实现位置**：新插件 `packages/plugins/convention-linter/`（依赖 `kernel.io` + `erb.parser` + `game.adapter` 槽位查询）。
- **UI**：校验结果面板（新 `ui.panel` 贡献 + 点击跳转 Monaco 对应行）。

### 6.2 函数树导航（第二批：UI 为主）

- **数据已就绪**：`erb.parser` 的 `ErbIndex`（files/byName）＋ adapter 的 `parseKojoFamily`（FamilyMatch：kind/prefix/family/characterNo/face/sub/isMessageCheck/slot/isPlaceholder）。
- **导航三维**：角色（charaIndex）→ 家族（family，含初始家族）→ 面（face：MESSAGE_COM/COUNTER/EVENT…，顺序按调用语义排）→ 具体函数（按 slot 数值排序）。
- **实现**：app 的 FileTree 升级为三段式树（或新 ui.panel 插件 `ui-kojo-navigator`），点击 → Monaco 打开并跳行（`ErbFunctionRef.startLine`）。
- **注意**：家族名大小写归一（Emuera 语义全大写比较，`normalizedName` 已备）；「初始家族」函数名不含家族段，靠 declare 的 charaIndex 关联。

### 6.3 条件抽取（第三批：为 v1.0 差分矩阵服务）

- 从函数体抽取 `IF/SELECTCASE/CASE` 条件表达式 → 条件树（内存结构，不入档）。
- 依赖 erb-parser 扩展：行分类（PRINT 变体/条件块嵌套层级）——scanner.ts 已留扩展点（v0.1 注释标明）。

### 6.4 其它已排队项

- `watchDirs` 文件监视（现返回空实现+UI 手动刷新；后续 Rust notify）；
- sav-parser（v1.0）：**先读** `D:\DSH\reverse-engineering\eratw4.980-存档实战解析.md` + 复用 `sav-parse/parse_sav.cjs` 协议实现；
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
| **Edit 工具偶发"声称成功未落盘"** | 关键修改后读回验证（或用 node 脚本改） |
| cargo 输出带 ANSI 色码 | 正则匹配前先 stripAnsi（tools/smoke-*.mjs 有现成函数） |
| crates.io 直连慢 | cargo 首次 build 已完成，之后增量秒级 |

## 九、新会话动手清单

1. `cd D:\DSH\kojo-editor && pnpm install`
2. `pnpm test && pnpm typecheck && pnpm audit:decoupling` —— **确认三项全绿**（基线）
3. 读 `docs/ARCHITECTURE.md` §5 + 本文件 §六
4. **第一批实现约定校验器**（§6.1 规则 1-2 起步，先做 KX 残留——最简单且数据最大）：
   - 建插件包 → 注册 `conventions` → app 挂校验面板 → 集成冒烟加断言（KX 计数 = 603 去重名）
5. 每完成一批：`pnpm test` 全绿 → Conventional Commits 提交 → `node tools/git-push.mjs`
6. 深夜黄金时间提示：桌面壳已可 `pnpm --filter @kojo/app tauri dev` 直接玩（选目录 → 只读浏览 → 批准写权限 → 编辑保存）
