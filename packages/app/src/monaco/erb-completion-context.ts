/**
 * `.erb` 补全的**位置门**：宿主侧只剩一条 re-export。
 *
 * 判据（九态门 / 调用语句表 / 名字槽解析 / 标签位 / 代码视野 / 插值区 / 门→source 白名单）
 * 已整块搬进 `@kojo/erb-lang/completion-context`（LAU-4 续，2026-10-30）——"这一格能不能弹补全、
 * 能弹的是哪一族"是**语言事实**，插件的供方要用同一份，而插件读不到 `packages/app/src/**`。
 *
 * 这里**不留第二份实现**，也不重新导出包里的私有件：本文件只把包对外的那一组原样摆出来，
 * 既有 import 点（11 处宿主文件 + 6 个测试文件）一字不改。口径与 `kojo-completion-position.ts`
 * 当年把空白/插值判据搬进 `@kojo/kojo-lang` 时同一条纪律：**一个判据只有一个落点**。
 *
 * 搬走的判据逐条对应包里的同名导出；宿主侧新增的唯一东西是这条注释。
 */
export {
  DEF_RE,
  ERB_CALL_SLOT_BY_KEYWORD,
  ERB_CALL_STATEMENTS,
  ERB_GATE_SOURCE_WHITELIST,
  ERB_JUMP_KEYWORDS,
  NAME_CHAR_RE,
  erbCallKeywords,
  erbCallStatementRe,
  erbCodeViewOf,
  erbCompletionGate,
  erbInterpRegionAt,
  erbLabelSlot,
  parseErbNameSlot,
} from '@kojo/erb-lang/completion-context';
export type {
  ErbCallSlotKind,
  ErbCallStatement,
  ErbCodeView,
  ErbCompletionGate,
  ErbLabelSlot,
  ErbNameSlot,
} from '@kojo/erb-lang/completion-context';