# 性能分析：编辑口上卡顿（2026-10-11）

> 现象：实机（初步编译后的编辑器）编辑/修改口上有明显卡顿。
> 本文 = 源码审读结论 + 优化建议清单（按性价比排序）。未做实机 profile，
> 落地前建议先按 §四加两个计时点确认量级。
>
> **状态（2026-10-12）**：本文件已按 HANDOFF §三 指示**从 `docs/archive/` 取回**
> 为活文档。后续修订与实测见 `docs/PERF-REVIEW-2026-10-11.md`（路线权威）。

## 一、一次击键到底发生了什么（现状链路）

```
击键
 ├─ Monaco Monarch 分词（主线程，增量）+ wordWrap 排版
 ├─ model.onDidChangeContent（EditorPane.tsx:470）
 │   ├─ computeDirty（O(1)，✅ 便宜）
 │   └─ setDirty(d) —— 值不变时 React bail out，✅ 不会整树重渲染
 └─ 250ms 停顿后 scheduleMarkers（EditorPane.tsx:223）
     └─ refreshMarkers（EditorPane.tsx:185）
         ├─ model.getValue() —— 全文复制一份
         ├─ 遍历 ui.editor.decorator 槽：
         │   └─ sugar-diagnostics → sugar.transpile(全文)
         │       （lexer 697 行 + parser 1165 行，同步、主线程、整文件）
         └─ setModelMarkers
```

另有并发消耗：Monaco 补全 provider 每次弹建议都对**全文**跑
`aliasNamesOf` 正则扫描（kojo-language.ts:217），没有按版本缓存。

## 二、卡顿根因判定（按嫌疑度排序）

| # | 嫌疑 | 证据 | 影响面 |
|---|------|------|--------|
| 1 | **sugar.transpile 全文同步跑在主线程** | EditorPane.tsx:185-200；kojo-sugar lexer+parser 共 ~1900 行纯 TS | 每次停顿 250ms 后一次阻塞，大文件估计几十到几百 ms——**编辑中的顿挫感主因** |
| 2 | **构建设置**：`tauri dev` / debug 构建 = React dev + 不压缩 | vite.config.ts 无 mode 区分；用户说的是"初步编译后" | dev 与 release 可差 2-5 倍，先排除 |
| 3 | **打开项目后的索引构建挤占主线程** | erb-parser/plugin.ts:72 `mapLimit(12)`，每文件 `parseErbText` 同步解析，eraTW 口上域数千文件 | 开项目后头几秒到几十秒内打字掉帧 |
| 4 | **补全 provider 全文正则无缓存** | kojo-language.ts:191-202 | 输入时弹建议的瞬间额外全文扫描 |
| 5 | ERB 语法 Monarch 分词（主线程） | erb-language.ts | 大文件首开/大改时卡，平时增量分词尚可 |
| 6 | React 重渲染 | 无 React.memo，面板组件全裸奔 | **击键路径上其实不触发**（dirty bail out），只在换 tab/脏状态翻转时整树渲染一次，非主因 |

## 三、优化建议（按性价比排序）

### A 批（P0，编辑手感直接相关）

1. **转译挪进 Web Worker**：`sugar.transpile` 是纯函数（无 IO），天生的 worker
   材料。做法：`sugar-worker.ts` + `new Worker`，`refreshMarkers` 改为
   postMessage(text) → 收诊断回 setModelMarkers；返回时校验
   `model.getVersionId()` 仍是发起时的版本（过期结果直接丢弃）。主线程击键路径
   从此零转译。契约不变（槽返回的还是 `LineDecoration[]`），只是执行位置变。
2. **补全别名缓存**：`aliasNamesOf` 按 `model.getVersionId()` memo；别名声明
   通常在文件头部，进一步可只扫头部 N 行。
3. **确认 release 构建**：用 `pnpm tauri build`（vite production + Rust
   release）实测对比；若是 dev 构建测出的卡顿，先修 2 再谈其余。

### B 批（P1，大文件/大项目场景）

4. **索引让路**：编辑器 focus 时把 `mapLimit` 降到 2-3，失焦恢复；或把
   `parseErbText` 批次放进 worker（与 1 共用 worker 池）。最简单版：分片间
   `await new Promise(r => setTimeout(r))` 已有（IPC 天然 yield），加"输入中
   暂停解析"标志即可。
5. **转译诊断分层**：大文件（>3000 行）降级为只转译光标前后窗口 ±300 行 +
   文件头（别名区），窗口外诊断标注"未校验"；等 worker 方案稳了再撤。
6. **Monaco 选项微调**：`matchBrackets: 'near'`、关闭空文件 alsoRender
   decorations 无关项；`wordWrap` 保留（口上行长，必须 wrap），但可给
   `.kojo` 大文件提示条。

### C 批（P2，锦上添花）

7. **装饰结果缓存**：decorator 纯函数 → 按 (path, versionId) 记忆化，切 tab
   回来不重算。
8. **面板 React.memo 化**：PanelBody 包 memo，配合槽贡献引用稳定（组件在
   activate 时注册，本来就稳定）；对"换 tab 整树渲染"场景有用。
9. **性能自检面板**（ui-plugin-status 加一块）：显示最近一次
   transpile/indexing 的耗时，以后卡不卡一眼可见，不靠体感猜。

## 四、动手前先测（10 分钟）

在 `refreshMarkers` 里临时加 `console.time('markers')`，在 erb-parser
`parseErbText` 前后累加耗时到全局，release 构建跑一次真实口上文件：

- 若 markers 稳定 >100ms → 建议全部成立，从 A1 开工；
- 若 markers <30ms 仍卡 → 主因在分词/排版/WebView2 渲染，转查
  `styles.css`（1719 行全局样式有无 `*` 通配选择器/大范围 backdrop）与
  wordWrap 大文件行为。

## 五、约束提醒

- worker 方案不破铁律：转译语义仍在 kojo-sugar 插件，宿主只做"把函数搬到
  worker 跑"的通用设施（可做成宿主通用 worker 池服务，不出现糖字样）。
- 契约 additive：`ui.editor.decorator` 的纯函数签名不变，worker 化是宿主
  内部实现细节；插件想自建 worker 也允许（自带 blob worker 不经宿主）。
