# 性能评审：更激进的卡顿根治路线（2026-10-11）

> 评审对象：`docs/PERF-ANALYSIS-2026-10-11.md`（下称「原文」）。
> 评审方式：源码复审（未做实机 profile，与原文同款纪律——所有结论仍需 §六的测量门槛放行）。
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
