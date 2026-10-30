# 新增一个方言（DIALECT-AUTHORING）

> 判据：**新增一个方言 = 新增一个包 + 清单一行**。宿主（`scheduler` / `bootstrap` / Monaco 接线）、
> kernel、`kojo-core` 都不改；conformance 也不改（`--adapter <id>` 从适配器清单派生列）。
> 本文只讲操作与边界，契约细节见 `docs/ARCH-language-unification.md` §5 与 `packages/kojo-sdk/src/`。

## 五步

### 1. 生成骨架

```bash
node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run   # 先看计划
node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
```

- `--id`：1–24 位小写字母/数字、字母开头（拼进包名 / TS 标识符 / 清单键；也是 `GameAdapter.gameId`）；
- `--title`：展示名；`--ext`：源文件扩展名（不带点）；
- 同 id / 同目录 / 清单已有同项 ⇒ **拒绝**（非零退出，一个字节不写）；`--dry-run` 只打印。
- 生成后跑一次 `pnpm install`：把 workspace 链接建起来（应用运行期按包名解析；typecheck 与
  vitest 走 `paths` 别名，不装也能过）。

### 2. 认出「清单一行」与它带出来的散点

生成器在 `packages/app/src/adapter-manifest.ts` 里**只插入一个条目块**，带 `// new-dialect` 标记：

```ts
{
  // new-dialect: My Game（tools/new-dialect.mjs 生成；删本块 + packages/plugins/mygame-adapter 即回退）
  id: 'mygame', dir: 'mygame-adapter', packageName: '@kojo/plugin-mygame-adapter',
  factory: 'createMygameAdapterPlugin', scope: 'project', auditWord: 'mygame',
  load: () => import('@kojo/plugin-mygame-adapter'),
  kojo2AdapterExport: 'MYGAME_GAME_ADAPTER', kojo2BackendFactoryExport: 'createMygameEmitBackend',
},
```

另外三处是 **`adapter-manifest.test.ts` 的双向自证要求的**（清单说有的，依赖/别名/磁盘必须真有），
生成器代劳并各带 `// new-dialect` 标记：`packages/app/package.json` 一行依赖、root / app `tsconfig.json`
与 `vitest.config.ts` 各一行别名。**别手工漏任何一处**——漏了只会在另一台机器上以别的形态炸。

### 3. 把「最小」换成你的方言

| 文件 | 你要改什么 |
|---|---|
| `src/adapter.ts` | 事件目录（`engine` 记号是真方言的落点）、`profile` 三轴、`presentation` 四格、`programFeatures`、`storageClasses` / `domainSymbols`（起点沿用 core fixture 形状，**别借别的 adapter**） |
| `src/backend.ts` | `wrapMachine` 机壳（起点 `@<ID>_FIRST` + `#LATER`）、真支持的能力从 fail-closed 改成实现；表达式端口仍由宿主注入 |
| `src/plugin.ts` | `detect`（起点只认工程根的 `kojo-dialect.json`，零误命）、`loadProject`（`kojoPaths` / `charaIndex` / `writablePaths`） |
| `tests/*` | purity / 形态闸跟着改；导出面增删要显式改名单 |

起点 backend 是 **Emuera 系最小可跑**实现（`PRINTFORM` / `IF` / `SETCOLOR` / `PRINTDATA`…），
所以共享列 golden 能直接对上；引擎不是 Emuera 的方言替换它，不改 core。

### 4. 契约面（写方言只需要认识这三类）

- **游戏侧**：`GameAdapter`（`@kojo/kojo-core`，SDK 以 `@kojo/kojo-sdk` 的 type 导出面再出口）——
  十五格事实面，见 `packages/kojo-core/src/adapter.ts`；
- **编辑器侧**：`ui.monaco.language` 槽（`packages/plugin-api/src/monaco-language.ts`）——
  语言 id / 扩展名 / 词法 / 主题 / 能力声明；要语义高亮再加 `ui.editor.languageService`；
- **共享常量**：`SEMANTIC_ROLES` / `ROLE`（角色表）、`STRUCTURE_PROTOCOL_VERSION`（结构 worker 协议 v4）、
  结构协议类型（`@kojo/kojo-sdk/structure-protocol`）。
- 纪律：方言**只提供数据**；语法 / 折叠 / 缩进 / 残缺归 tree-sitter，方言不进 wasm、不进 worker
  （`docs/ARCH-language-unification.md` D10）。插件只许依赖 `@kojo/plugin-api` 与 `@kojo/kojo-core`，
  **不许 import 别的插件**（解耦审计 B/C）。

### 5. 验收

```bash
# 语言面一致性：共享列（同一份 fixture、同一份 body golden；机壳各自给）
node tools/kojo-conformance.mjs language --adapter mygame
# 抽象列（默认 fixture；与具体方言事件表无关，47 例）
node tools/kojo-conformance.mjs language

# 生成包自带的闸 + 清单双向自证
node node_modules/vitest/vitest.mjs run packages/plugins/mygame-adapter/tests packages/app/tests/adapter-manifest.test.ts
# 定向 + 双 typecheck + 解耦审计
pnpm typecheck && pnpm --filter @kojo/app typecheck && pnpm audit:decoupling
```

conformance 的列**从清单派生**（`id` + 包自己的 `exports` + 两个 `kojo2*Export` 名），
只有两枚列写死在 `tools/kojo-conformance.mjs`：eraTW（boot 常驻、2.0 面走静态 import）与
conformance 自己的 `demo` 夹具。新方言不需要改它。

## 边界与陷阱

- **写边界**：生成的 `loadProject` 给 `writablePaths: []`（只读）。写授权是用户批准的
  项目级 `writablePaths`（内核 `io` 强制），方言不自己开写；绕写只有 `exportFile` 一条法定通道。
- **没有 per-plugin `tsconfig.json`**：root `tsconfig.json` 的 `include` 覆盖
  `packages/plugins/*/{src,tests}/**`，所以生成器**不生成** tsconfig（实树口径；多一份 `extends`
  只会多一处漂移点）。
- **`auditWord` 取 id**：它进审计词表（内核/宿主层出现即红）。挑一个不会撞日常词汇的 id。
- **回退**：删 `packages/plugins/<id>-adapter/`，再删所有带 `// new-dialect` 的行（清单块 +
  依赖行 + 三条别名）即可回到生成前；`git clean` 前先看 `git status`。
- **共享列不是「相似」**：`language --adapter <id>` 的 body 逐字节比 golden；`blocked` 不算通过。
