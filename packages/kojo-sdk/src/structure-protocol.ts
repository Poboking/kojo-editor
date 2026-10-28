/**
 * **结构 worker 协议 v4**（`structure-protocol`）——语言包作者要自己写结构 worker 时的形状。
 *
 * ## 协议讲什么（一页纸）
 *
 * 主线程与结构 worker 之间只有三类消息，靠一条请求一枚 `id`、回复带同一枚 `id` 配对：
 *
 * | 方向 | 消息 | 形状 | 语义 |
 * |---|---|---|---|
 * | 主 → worker | `open` | `StructureOpenRequest` | 这条线程服务哪一份文档（`docBase` = 文档绝对起点，v4 起一条线程可服务多台引擎） |
 * | 主 → worker | `parse` | `StructureParseRequest` | `{text}` 整篇 或 `{edit, base}` 差集；`includedRanges` 只给注入子语言用 |
 * | worker → 主 | `ready` | `StructureReadyReply` | `{protocol, loadMs, docBase}`（无 `engine`；`docBase` 自 v4 起） |
 * | worker → 主 | `reply` | `StructureParseReply` | `{treeId, incremental, facets.{semantic\|folds\|indent\|syntax}, metrics}`（`facets` 只带 `want` 点名的那几面） |
 * | worker → 主 | `failure` | `StructureFailureReply` | fail-visible：`reason` + 人话；不产半成品 |
 *
 * 版本不匹配时宿主**降级到旧协议**（v3 及以前没有 `docBase`），不是静默继续——见
 * `packages/app/src/monaco/tree-sitter/client.ts` 的 `adoptLegacy`。
 *
 * ## 为什么形状住 `@kojo/kojo-core`、常量也从那里转出来
 *
 * 协议是**语言层事实**（与编辑器无关：结构 worker 也可以在别的宿主里跑），所以真身在 core；
 * 本文件是 SDK 面上的稳定入口名（作者从这里 import，不认识 core 的目录布局）。
 *
 * ## 别再"抬版本号顺手加字段"
 *
 * 改协议 = 改线上形状：加字段就是改语义（旧 worker 收不到、新 worker 多发），必须**抬
 * `STRUCTURE_PROTOCOL_VERSION`** 并给宿主留降级路。`StructureReadyReply.protocol` 的比对
 * 是唯一判据，不做"宽松兼容"。
 */

export type {
  /** 请求 / 回复 */
  StructureRequest,
  StructureOpenRequest,
  StructureParseRequest,
  StructureReply,
  StructureReadyReply,
  StructureParseReply,
  StructureFailureReply,
  /** 内容与差集 */
  StructureContent,
  StructureEdit,
  StructurePoint,
  StructureRange,
  /** 四副面（捕获表 / 折叠 / 缩进 / 语法故障） */
  StructureFacet,
  StructureCaptureTable,
  StructureFoldTable,
  StructureIndentRules,
  StructureSyntaxFault,
  StructureSyntaxKind,
  StructureFailureReason,
} from '@kojo/kojo-core';

export {
  /** 版本号与随之钉死的常量（超时 / 上限 / 连续失败数） */
  STRUCTURE_PROTOCOL_VERSION,
  STRUCTURE_MAX_CAPTURES,
  STRUCTURE_TIMEOUT_MS,
  STRUCTURE_BOOTSTRAP_TIMEOUT_MS,
  STRUCTURE_DEAD_AFTER_FAILURES,
  STRUCTURE_FAILURE_REASONS,
  STRUCTURE_FACETS,
} from '@kojo/kojo-core';
