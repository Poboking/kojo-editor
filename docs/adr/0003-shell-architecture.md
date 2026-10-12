# ADR-0003: 桌面壳架构 —— 内核运行在 WebView，Tauri 只做 IO 原语

- **日期**：2026-10-09
- **状态**：已接受（v0.1 实施验证）

## 背景

Tauri 应用天然分两层：Rust 宿主 + WebView 前端。kernel 与插件（TS）放在哪一层，有三条路线：

1. **Node sidecar**：Tauri 拉起 Node 子进程跑 kernel，前端只做 UI。→ 需打包 Node 运行时（体积 +80MB）、进程间协议复杂度、插件在 Node 侧无法直接渲染 UI。
2. **Rust 宿主为主**：kernel 用 Rust 重写。→ 插件系统要做 Rust 动态加载（ABI 不稳定），与"TS 插件生态"的愿景冲突。
3. **WebView 内跑 kernel**（选定）：kernel/plugins 全在 WebView 的 TS 环境；Tauri 仅暴露 PlatformBridge 原语。

## 决策

采用路线 3：

- **内核与插件是纯 TS 库**，不 import 任何平台的 fs/path/进程 API，只依赖 `PlatformBridge` 接口；
- **Tauri Rust 侧只实现 PlatformBridge 的原语命令**（读/写字节、目录遍历、编解码、对话框、应用数据目录、导出目录/导出单文件、写允许域注册）——「零游戏知识、零业务逻辑」在 Rust 侧同样是硬约束；
  条数随契约增长（初稿 14 条，2026-10-13 实测 **18 个方法**，见 `plugin-api/src/platform.ts`），
  **权威清单以该文件为准，不在本 ADR 里钉死数字**；
- 编解码（编码探测后的字节转换）在两端各有一实现：Node（测试/CLI，WHATWG TextDecoder + iconv-lite）与 Rust（生产，encoding_rs）——接口同一份契约，行为以测试对齐；
- 二进制数据跨 IPC 用 base64（确定性优先；口上文件体量下开销可忽略）；
- 原子写下沉到 bridge 层（临时文件 + rename），Node 与 Rust 各自实现。

## 后果

**收益**：
- 内核/插件在 Node 下可做 100% 单元测试 + 真实工程集成测试（无需启动 GUI）；
- 插件系统复用 TS 生态（动态 import、React 组件、Monaco 装饰器）；
- 未来做浏览器预览版/CLI 版时，只需换一个 PlatformBridge 实现。

**代价**：
- 重计算会占用 WebView 主线程——v0.1 实测 2,285 文件索引 2.9 秒可接受；若 v0.2 出现卡顿，将解析移入 Web Worker（kernel 无平台依赖，天然可搬）。
  **进度（2026-10-13）**：这条已经动过但不是"整体搬进 Worker"——`kernel.compute` 时间片计算池
  与并行运输层已落地（IMPLEMENTATION-LOG §5.52），索引本身也降到约 1.24 秒（§5.58 起的多批缓存）。
  运输层目前是内联实现，Worker 化仍是可选项而非欠账。
- 文件监视（watchDirs）在 WebView 无法原生实现，v0.1 以"显式刷新"替代，后续接 Rust notify
  （**2026-10-13 已落地**：`start_watch`/`stop_watch` 原语 + 内核去抖，实施记录 IMPLEMENTATION-LOG §5.84）。
- base64 有 33% 传输膨胀，对 sav 二进制（~MB 级）在 v1.0 评估切换到 `tauri::ipc::Response` 原始字节通道。
