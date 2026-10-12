# 性能评审：更激进的卡顿根治路线（2026-10-11）

> 评审对象：`docs/PERF-ANALYSIS-2026-10-11.md`（下称「原文」）。
> 评审方式：源码复审（未做实机 profile，与原文同款纪律——所有结论仍需 §六的测量门槛放行）。
>
> **状态（2026-10-12）**：本文件已按 HANDOFF §三 指示**从 `docs/archive/` 取回**
> 为活文档，作为「内核/性能优化」批次的路线权威。§七 为 L0 实测记录。
>
> **结论先行**：
> 1. 原文对击键路径的判定**成立**：主因 = 停顿 250ms 后全文同步转译跑在主线程；
> 2. 原文**漏了两个更重的黑洞**：① 开项目后的**级联风暴**（索引 2.9s → 条件抽取 6.2s + 约定校验 ~9s，全部主线程）；② 切换到 `.kojo` 时同一文本**同步全文转译 1–3 次**（原文只盯了去抖路径）；
> 3. 「更激进」的正解不是"把 transpile 搬进 worker"这一件事，而是**把主线程 CPU 预算清零**：宿主通用计算池 + 全部 CPU 密集纯函数过池 + 转译结果共享缓存 + 索引持久化快照。分级 L0–L4（§三），各有量化门槛，不是一口气全上。

## 一、对原文的评审

### 1.1 站得住的部分

- **击键路径链路梳理正确**：`computeDirty` O(1)、`setDirty` bail out、250ms 去抖后才跑转译——击键瞬间本身确实轻（EditorPane.tsx:470-477）。
- **嫌疑 #1 判定合理**：`refreshMarkers` → `model.getValue()` 全文复制 → `sugar.transpile(全文)` 同步主线程（EditorPane.tsx:185-200；lexer 697 + parser 1165 + codegen 1047 行纯 TS）。250ms 停顿后的那一下顿挫，就是它。
- **A1（转译 worker 化）方向正确**，且契约 additive、铁律安全的论证（原文 §五）无误——本评审把这条路**升级并扩大**（§三 L1）。
- **先测后动**（原文 §四）纪律正确，本评审保留并扩展（§六）。

### 1.2 需要修正 / 原文遗漏的部分

| # | 发现 | 证据 | 原文状态 |
|---|------|------|----------|
| G1 | **开项目级联风暴远不止索引**：`kojo.functionChanged` 一响，condition-extractor（mapLimit 8，全量 49.3 万谓词，~6.2s 冷启 ~13s）**和** convention-linter（~9s / 757 项）同时上主线程。开项目后 **~10–20s 主线程持续高负载**，期间打字必卡。 | condition-extractor/index.ts:91（订阅即全量跑）；engine.ts:191（mapLimit 8）；convention-linter/index.ts:105（同款订阅）；HANDOFF §基线（2.9s / 6.2s / 9s 实测数） | 原文嫌疑 #3 只算了索引 2.9s，**低估一个量级** |
| G2 | **切文件重复转译**：切到一个 `.kojo`，EditorPane 打开即同步转译一次（EditorPane.tsx:502）；「糖判定」面板 effect 再来一次（ui-sugar-editor/index.ts:125-132，读盘后同步转译）；糖预览面板开着的话第三次（ui-sugar-preview/index.ts:110,203）。**同一文本最多 3 次全文转译，全在主线程。** | 上述行号 | 完全未提 |
| G3 | **每次转译调用都重建整套服务**：`kojo-sugar` 插件的 `transpile` 每次调用都 `makeTranspiler()` → 两次槽位查询 + 闭包构造（kojo-sugar/index.ts:152-154, 143-150）；且 `resolveFamily` 对每个未知标识符做 22 族线性扫（index.ts:269-289）。单次不贵，但它在每个 250ms 停顿、每次切文件、每次预览刷新上都发生。 | 同左 | 未提（属小项，L1 顺手解决） |
| G4 | **补全 provider 不只缺别名缓存**：三组静态建议（中文主形关键字 / 保留代词 / 运算符，kojo-language.ts:228-259）**每次弹建议都整体重建对象数组**——纯分配浪费 + GC 压力。 | kojo-language.ts:217-261 | 只提了别名正则扫描（A2 的一半） |
| G5 | **backpressure 未提**：worker 化后若用户连续输入、转译一轮 >250ms，多轮任务会在队列里堆积，结果逐个过期还逐个回放——必须单飞（in-flight 作废旧请求）+ 尾缘合并。 | worker 方案设计缺口 | 未提 |
| G6 | **区分三种卡法**：输入卡（#1/#4/G4）、切文件卡（G2）、开项目后卡（G1）——对症药不同，原文混在一份清单里。 | — | 隐含但未分型 |
| G7 | `styles.css` 复查：`* { box-sizing }` 无害，无 `backdrop-filter`、无大范围通配——原文 §四的 CSS 疑点可以降权（不是清零：2322 行里 hover/transition 的量级仍值得实机看一眼渲染开销）。 | styles.css:29 | 原文列为备查，维持备查 |

## 二、原文结论矩阵（修正后）

| 卡法 | 主因 | 原文对应 | 本评审对应 |
|------|------|----------|-----------|
| 输入中顿挫 | 停顿后全文同步转译（#1）+ 补全重建（#4/G4） | A1+A2 | L1+L2 |
| 切文件顿一下 | 同一文本 1–3 次全文转译（G2） | 未覆盖 | L2 |
| 开项目后 10–20s 掉帧 | 索引+抽取+校验级联（G1） | B4（只治索引） | L1+L3 |
| 滚动/渲染卡 | dev 构建 / WebView2（#2） | A3 | L0 放行确认 |

## 三、激进路线（L0–L4）

> 总纲一句话：**主线程只留 IO（Tauri IPC）+ UI 渲染 + Monaco 增量分词，其余 CPU 全部下池。**
> 每个 L 有明确验收门槛；不满足门槛就停在上一级，不做无用功（先测量再动手，第四次应验之后不再违例）。

### L0 · 放行与分型（半小时，必做）

1. 确认用户实机跑的是 `tauri dev`（React dev runtime）还是 `tauri build`（vite production）。dev 构建卡 2–5 倍是常态——**若卡顿只出现在 dev，先只做 L1 再复测**。
2. 原文 §四的两个计时点照做，另加三个（§六清单）：切文件一次性成本、开项目后 30s 内输入延迟分布、（若可）任务管理器看 WebView2 GPU/软渲染状态。

### L1 · 宿主通用计算池（激进版 A1，本路线的芯）

**不是"给 sugar 开个 worker"，而是 kernel 级通用执行器**：

- 新内核设施 `kernel.compute`（名字零游戏词汇，铁律安全）：优先级两档 `interactive`（markers / 补全）> `background`（索引 / 抽取 / 校验），单 worker 起步（转译与索引互斥不抢核，桌面 WebView2 里 1 个专用 worker 已足够吃掉全部场景）。
- **全部 CPU 密集纯函数过池**，一个设施吃四家：
  - `sugar.transpile`（原文 A1）；
  - `parseErbText`（索引构建，原文 B4 的升级版——不是"让路"是"离场"）；
  - 条件抽取的 `scanControlFlow` + 表达式解析（G1 主凶）；
  - 约定校验的规则扫描（G1 另一凶）。
  主线程职责收缩为：发起任务 → IPC 读文本 → 传文本（structured clone）→ 收结构化结果 → 装配索引/事件。
- **单飞 + 版本门 + 尾缘合并**（G5）：每类任务同 key 只允许一个 in-flight；worker 忙时新请求只记"最新待办"，worker 空闲取最新执行（中间版本直接跳过）；回主线程时校验 `model.getVersionId()`（原文已有此条，并入）。
- **降级通道**：执行器在无 Worker 环境（vitest node 侧）自动退化为内联同步执行——测试与真实宿主同一套调度代码，只是运输层不同。
- **闭包跨不过结构化克隆是本层唯一的真工程量**：`dictionary`（闭包）/ `VariableSchema.lookup`（方法）不能直接 postMessage。解法是**传数据不传函数**——`VariableSchema` 导出原始表（additive 契约），`KojoFaceTable` 本就是数据；worker 端用同一份 `makeLookup` 代码重建闭包（同 bundle，`?worker` 天然共享源码；Monaco 的 editor worker 已验证此模式在本仓库可用）。G3（每次重建转译器）在此顺手解决：池内按 `adapterId + 代际` memo 转译器实例。

### L2 · 转译结果共享缓存 + 输入侧零分配

- **(path, versionId) → TranspileResult 缓存，三个消费者共享**（G2）：EditorPane 波浪线、糖判定面板、糖预览面板不再各转各的；切 tab 回来直接命中（原文 C7 免费获得）。缓存失效 = 版本变化，天然正确。
- **补全重构**（G4）：三组静态建议模块级一次构建（内容恒定，永不重建）；别名按 `(model, versionId)` memo，且只扫文件头 N 行（别名声明在 front-matter，原文 A2 原样并入）。
- `model.getValue()` 全文复制从输入路径退场：L1 的 worker 每轮收全文即可接受（.kojo 是作者手写文件，量级几百行）；**万行文件才启用输入镜像**（onDidChangeContent 的 delta 在 worker 维护镜像，见 L4 触发条件）。

### L3 · 索引持久化（激进：重开项目零等待）

- 索引 + 谓词抽取结果落 appData 快照（内核 io 既有 appDataDir 通道，十七批冒烟已验证落点；走既有写闸，不新增权限面）。
- 重开项目：先载快照（UI 立即可用，~百 ms 量级），后台按 `mtime + size` 增量复扫变更文件再广播。**2.9s + 6.2s + 9s 的开项目风暴对二次打开直接消失**——这是激进路线里用户体验收益最大的一项。
- 前置缺口（additive）：io 契约的 walkDir/readText 元数据需补 `mtime`/`size`；失效判定宁可保守（mtime 变了就重扫该文件），快照格式带版本号，解析失败整体弃用重建（fail-closed，不修快照）。

### L4 · 增量转译（** gated：仅当 L1+L2 落地后实测大文件仍卡才做**）

- 三段式转译天然适合阶段边界 memo：逻辑行词法按行内容 hash 缓存（未动的行零重lex）；AST 按块边界局部重建；codegen 只重生成受影响块。诊断对未触碰行直接复用。
- **诚实标注复杂度**：别名表 / 时机块 / 原生块是跨行全局状态，源映射行号偏移要整段平移——全量 AST 增量是高投入项，**只有万行级 `.kojo` 才回本**。当前语料（作者手写）到不了这个量级，预期结论是"不做"，但把门槛写死在这里，防止将来文件变大时重新发明。
- 配套（若触发）：delta 输入镜像进 worker（主线程永不 post 全文）。

### Monaco 层（半天量级，随 L2 一起上）

- `occurrencesHighlight: 'off'`（大文件真凶之一：光标停留即全文找同词）；`wordBasedSuggestions: 'off'`；`matchBrackets` 大文件降 `'near'`（原文 B6 并入）；确认 `stickyScroll` 未开；`wordWrap` 保留（口上行长，必须 wrap）。
- 这些是开关级改动，收益中等但零风险，适合夹在 L1 开发间隙落地。

## 四、铁律与风险核对

- **审计 A/C**：`kernel.compute` 是通用设施，零游戏名词零糖字样——安全。插件不 import 内核的规则不破：插件仍只依赖服务键，"在哪执行"是宿主内部细节（原文 §五结论，扩大到 parseErbText/scanControlFlow 同理——它们本来就是纯函数）。
- **审计 D**：dictionary/faceTable 数据从 adapter 槽位取、传给 worker——游戏知识仍只住 adapter，路径未变。
- **契约 additive**：`ui.editor.decorator` 签名不变；`VariableSchema` 导出原始表是新增可选方法；io 元数据 mtime/size 是新增字段。全部向后兼容。
- **风险清单**：
  1. worker bundle 与主 bundle 的共享 chunk（`?worker` 打包 kojo-sugar 源码 ×2）——体积代价，可接受；
  2. `kernel.compute` 单 worker 是**串行瓶颈**：转译与索引互斥。若实测互斥造成可感知延迟（索引途中打字等波浪线 >1s），升双 worker 分池；
  3. 快照失效漏判（外部工具改文件但 mtime 粒度不足）→ 保守策略：项目关闭时全量校验一次 mtime；
  4. **别把 IO 搬进 worker**：Tauri IPC 留主线程（worker 内 invoke 的可用性未经本仓库验证，不值得赌）。

## 五、建议执行序（与原文 A/B/C 合并）

| 序 | 事项 | 原文对应 | 验收门槛 |
|----|------|----------|----------|
| 0 | L0 放行确认 + 五计时点 | A3 + §四 | 卡法分型明确；dev/release 归因明确 |
| 1 | L1 计算池（先只挂 `sugar.transpile`）+ Monaco 开关 | A1 + B6 | 停顿后 markers 不再产生 >16ms 主线程任务（Performance 面板可验） |
| 2 | L2 共享缓存 + 补全重构 | A2 + C7 | 切文件转译次数 3→1；补全 provider 零静态分配 |
| 3 | L1 扩容：索引/抽取/校验全量过池（background 档） | B4 升级 | 开项目后 30s 内输入 p99 < 50ms |
| 4 | L3 索引持久化 | —（新增） | 二次开项目到函数树可用 < 500ms |
| 5 | L4 增量转译 | B5 的远亲 | **默认不做**；触发条件 = 存在 >3000 行 `.kojo` 且 L1 后停顿仍 >100ms |
| — | C8 React.memo 化 | C8 | **建议砍掉**：击键路径不触发重渲染（原文 #6 自己已证非主因），换 tab 渲染实测无感再议 |
| — | C9 性能自检面板 | C9 | 保留并扩展：显示池队列深度 + 各任务近次耗时（L1 顺手埋点） |

## 六、动手前先测（原文 §四 扩展版）

1. `refreshMarkers` 前后 `console.time('markers')`（原文照做）；
2. 切文件计时：EditorPane 打开 effect 里包住 `refreshMarkers` + 糖判定面板 effect 的转译段；
3. 开项目后 30s：`kojo.functionChanged` 到 extractor/linter 各自完成的时间戳（两者 log 已有，加耗时即可）；
4. 输入延迟分布：`onDidChangeContent` 到 handler 返回的耗时（应恒 <1ms，若不是则 React 层有未知问题）；
5. WebView2：任务管理器 GPU 列确认非软渲染（软渲染则"滚动卡"单独立案，与本文路线正交）。

判读规则（承接原文）：markers 稳定 >100ms → L1 全速开工；<30ms 仍卡 → 转 L0-5 WebView2/分词线；开项目后卡 → 无论上面结果如何 L1 扩容 + L3 都立项。

---

## 七、L0 实测记录（2026-10-12，内核优化批）

> 纪律：先测量再动手。本节 = **无桌面壳条件下的纯函数侧微基准**（可复现、不依赖 GUI）；
> 实机五计时点与 WebView2 归因仍待真实终端（T0 剩余部分）。
> 方法：临时 vitest 探针（按项目惯例建 → 跑 → 删），样本取自真实语料 + 合成 `.kojo`。

### 7.1 语料规模（实测扫描，口上域 `ERB/口上・メッセージ関連/`）

| 指标 | 实测 |
|---|---|
| ERB 文件数 | **2,317** |
| 总行数 | **3,618,834** |
| 总字节 | **144,373,632（≈144 MB）** |
| 最大单文件 | `個人口上/058 Meiling [美鈴]/新制美鈴口上Ver0.5C/M_KOJO_K58_1_日常系コマンド.ERB` = **52,601 行 / 2.35 MB** |
| 第 2–5 名 | 30,498 / 24,187 / 24,178 / 23,150 行 |

**这修正了原文与评审的一个隐含假设**：原文 §三 B 批把"大文件"当作 `.kojo` 的特殊情形（"作者手写，几百行"），
而真实语料里**上万分行的文件是 ERB**，不是 `.kojo`。

### 7.2 纯函数耗时（Node v22.22.2，本机；单次均值，预热 1 次后取 3–5 次平均）

真实 ERB（UTF-8-BOM，实测读入）：

| 任务 | 284 行 / 8 KB | 21,967 行 / 623 KB | 52,602 行 / 1.4 MB |
|---|---|---|---|
| `parseErbText`（索引） | 0.2 ms | **8.7 ms** | **12.5 ms** |
| `scanControlFlow`（条件抽取前置） | 0.3 ms | **18.1 ms** | **38.2 ms** |

合成 `.kojo`（`时机` 块按 §6.1 形态复制放大；**未注入字典**，故诊断数偏多）：

| 行数 | 213 | 507 | 1,011 | 3,013 | 6,009 |
|---|---|---|---|---|---|
| `transpile` ms/次 | 3.8 | 5.3 | 8.3 | **19.1** | **35.0** |

### 7.3 三条修正性发现

**F1 · 击键路径的全文转译只发生在 `.kojo`。**
`ui.editor.decorator` 目前唯一贡献者 `ui-sugar-editor` 的 `sugar-diagnostics`，
`decorate()` 首行即 `if (!isKojoFile(file.path)) return []`。
→ **2,317 个 ERB（含 52k 行那个）在击键/切文件路径上根本不跑转译**；
原文嫌疑 #1 / G2 只对 `.kojo`（作者手写，常态几百行 → 实测 **4–6 ms**）成立。

**F2 · 最坏文件是 ERB，其卡顿源不可能在 `sugar.transpile`。**
52k 行的 ERB 打开/滚动/输入若卡，只可能来自 Monaco 自身：
Monarch 分词（`erb-language.ts`）、`wordWrap:'on'`、缩略图、平滑滚动等。

**F3 · Monaco 相关开关确实一个都没设。**
`EditorPane.tsx` 的 `monaco.editor.create` 选项里**没有** `occurrencesHighlight`、
`wordBasedSuggestions`、`matchBrackets`、`stickyScroll` —— 全部走 Monaco 默认值。
其中 `occurrencesHighlight` 默认会在光标停留时**全文找同词**，对上万分行文件是典型重灾区。
→ §三 Monaco 层那一组开关（T6）的收益面比原先预估的更大，且**零风险**。

### 7.4 判读与执行序建议（待用户确认）

- 纯函数侧（`.kojo` 常态 4–6 ms）**不足以单独解释"明显卡顿"** → 原文嫌疑 #1 不是全局主因；
- 主线程真凶嫌疑按受害面重排为：**(a) 开项目级联**（索引 2.9s + 抽取 6.2s + 校验 ~9s，**全员受影响**，T3/L3）
  → **(b) Monaco 大文件特性**（52k 行 ERB，T6）→ **(c) `.kojo` 转译**（作者手写文件，量级 4–6 ms，T1/T2）。
- 故建议把 **T6（Monaco 开关，半天、零风险）提到 T1 之前**先落地止血，
  T1 计算池仍按原序作为 T3 的**基础设施**推进（其直接受益者 `.kojo` 目前语料稀少，
  但 T3 把索引/抽取/校验搬下主线程必须依赖它）。
- **未尽事项**：实机五计时点（markers / 切文件 / 开项目后 30s 输入延迟分布 / handler 返回 / WebView2 渲染态）
  仍需真实终端跑一次，用于钉死 (a)(b) 的占比——本节的纯函数数字只给出**下界**。

### 7.5 实机测量操作单（待跑，约 10 分钟）

**探针已常驻**（2026-10-12 落地，随本批代码入库）：`packages/app/src/perf.ts`，
启动后 DevTools Console 会打印 `[perf] 性能探针就绪…`。计时点：

| 计时点 | 含义 | 预期 |
|---|---|---|
| `switch.readText` | 切文件读盘 | 取决于文件大小（大 ERB 数十 ms 属正常 IO） |
| `switch.createModel` | Monaco 建 model | 与行数强相关 |
| `switch.apply` | setModel + 选项 + 视图恢复 + 装饰刷新（**同步段**） | 大 ERB 上是重点观察项 |
| `markers.total` / `markers.decorate:<id>` | 一次装饰刷新总耗时 / 单个装饰器耗时 | `.kojo` 上看 `sugar-diagnostics` |
| `input.handler` | `onDidChangeContent` 到 handler 返回 | **应恒 <1ms**；否则 React 层有未知同步开销 |
| `cascade.projectOpened→index` | `project.opened` → `kojo.functionChanged` | = 索引构建耗时 |

操作：

1. 真实终端（非沙箱）跑 `pnpm --filter @kojo/app tauri dev`（首轮 cargo 冷编译 20–30 分钟，之后增量秒级）。
2. 打开真实项目 `D:\Game\eratw\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)`，
   **抄下控制台三行耗时**（三者相加 = 开项目级联总时长）：
   - `[erb-parser] … Indexed <N> ERB files … in <X>ms (walk+read+parse <Y>ms)`
   - `[condition-extractor] Condition index: … in <X>ms`
   - `[convention-linter] Convention lint: … in <X>ms`
   > 判据：**>10s ⇒ T3 + L3 无条件下立项**。
3. 打开最大文件 `個人口上/058 Meiling [美鈴]/…/M_KOJO_K58_1_日常系コマンド.ERB`（52,601 行），
   手动敲 20 个字符后停顿，执行 `__kojoPerf.summary()`：
   - 看 `input.handler`（应 <1ms）、`markers.total`（ERB 上应很小）；
   - 同时用 DevTools **Performance 面板录一段**，看有没有 >100ms 长任务（Monaco 分词 /
     `occurrencesHighlight` 会出现在这里，而**不会**出现在我们的探针里——这正是要区分两层的意义）。
4. 造一个 ~1,000 行 `.kojo`（`fixtures/sugar/sample-310.kojo` 复制放大）放进项目并打开，重复步骤 3
   → 此时 `markers.decorate:sugar-diagnostics` 应进入 10ms 量级。
5. 大 ERB ↔ `.kojo` 来回切 5 次 → 看 `switch.*` 三项。
6. WebView2 渲染态：任务管理器 → 详细信息 → 找到 WebView2 进程，看 GPU 列
   （若为软渲染，则"滚动卡"单独立案，与本路线正交）。
7. 判读规则见本文 §六；本轮需重点钉死 **(a) 开项目级联** 与 **(b) Monaco 大文件** 的占比，
   再最终确定 T1 / T3 / T4 / T6 的先后。

### 7.6 实测之二：折叠链全量扫描 —— 「打开超长 ERB 卡顿」的真凶（2026-10-12）

#### 7.6.1 文件体量分布（口上域 2,317 个 ERB 实测）

| 指标 | 值 |
|---|---|
| 平均 / 中位数 | 1,562 行 / **893 行** |
| p90 / p99 | 3,619 行 / **12,441 行** |
| ≥1,000 行 | 1,005 个（43.4%） |
| ≥3,000 行 | 308 个（13.3%） |
| **≥5,000 行** | **138 个（6.0%）** |
| ≥10,000 行 | 39 个（1.7%） |

#### 7.6.2 整篇升糖扫描的代价（`sugar.lift.liftSuggest`）

| 文件 | 行数 | `liftSuggest` | 其中 `parseErbText` | 其中 `scanControlFlow` |
|---|---|---|---|---|
| `AUTO_AEGI.ERB` | 284 | 4 ms | 0.2 ms | 0.3 ms |
| `M_KOJO_K40_コマンド.ERB` | 21,967 | **70 ms** | 7.9 ms | 13.4 ms |
| `M_KOJO_K58_1_日常系コマンド.ERB` | 52,602 | **231 ms** | 11.5 ms | 39.1 ms |

#### 7.6.3 三条**自动**入口共用这同一次全量扫描

```
Monaco 打开文件 → 要一遍整篇 folding ranges
  └→ 宿主 provideFoldingRanges（model.getValue() 全文复制）
       └→ 槽 ui.editor.liftPreview → ui-sugar-lift.provideLiftPreview
            └→ sugar.lift.liftSuggest(全文)          ← 231 ms @ 52k 行

Monaco 💡 可用性探测（光标/选区变化即调 provider）
  └→ 槽 ui.editor.codeAction → 同一条 liftSuggest 链（memo 只缓存 1 个文件）

打开「升糖候选」面板
  └→ 面板 effect 随 editor.activeFileChanged 自动 runScan → 同一条链
```

**用户在超长文件上"什么都没做"，就会被卡一次 231 ms（Node 口径；WebView2 只会更慢）。**
这比 Monaco 默认选项（§7.3 F3）的量级更重，且完全在**我们自己的代码**里 ——
故它不是"要不要优化"，而是"必须让路"。

#### 7.6.4 本批修复（2026-10-12「超长文件丝滑」批）

1. **契约 additive**（`plugin-api/slots.ts`）：`ui.editor.liftPreview` 与
   `ui.editor.codeAction` 的请求新增可选 `lineCount` —— 宿主提供**中性事实**，
   贡献方自行决定降级；缺省 = 体量未知 → **不降级**（与旧版行为一致）。
   分层刻意如此：**"多少行算大"是贡献方的策略，不是宿主的业务知识**。
2. **插件降级**（`ui-sugar-lift/src/large-file.ts`，纯函数可测）：`LIFT_MAX_LINES = 5000`；
   超限时**自动路径**（折叠供给 / 💡 探测 / 面板自动扫描）跳过整篇扫描，
   并**每文件告警一次**（高频 provider 不刷屏）；面板「重新扫描」保留**显式出口**
   ——牺牲自动，不牺牲能力。
3. **Monaco 选项按体量分级**（`app/src/ui/editor-options.ts`，纯函数可测）：
   ≥5,000 行时 `occurrencesHighlight: 'off'`、`bracketPairColorization.enabled: false`、
   `minimap.enabled: false`、`matchBrackets: 'near'`、`renderLineHighlight: 'line'`；
   两档都关 `wordBasedSuggestions` 与 `stickyScroll`（对 ERB / 中文口上无语义价值）。
   —— **即 T6 的一半**（原先排在本路线后段，实测后提前落地）。
4. **可量测**：`markers.decorate:<id>` 计时点可量到折叠/装饰链的耗时（§7.5）。

#### 7.6.5 仍然欠账

- `liftSuggest` / `parseErbText` / `scanControlFlow` 仍在主线程 —— 大文件的
  **显式**扫描（面板「重新扫描」）与**索引构建**依旧会卡；正解是 T1 计算池（L1）。
- 二次开项目零等待（T4/L3）与开项目级联让路（T3）未动 —— 对应「例 1」，是下一批主体。
