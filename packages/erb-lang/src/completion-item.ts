/**
 * 补全候选的**中性形状**（`@kojo/erb-lang/completion-item`）。
 *
 * ## 为什么在这里再写一遍
 *
 * 判据进包之后，"候选长什么样"也必须能脱离宿主表达——否则包只能交出标签数组，`kind` /
 * 排序档 / 替换区间这些**判断**还得回宿主补一遍，等于判据搬了一半。
 *
 * 契约里已有同一个形状（`EditorCompletionItem`，`@kojo/plugin-api/src/slots.ts`），但本包
 * **不引契约包**：`erb-lang` 是语言面库，它的纯度判据（`tests/purity.test.ts`）把外部依赖钉在
 * 几枚非插件叶子上；引契约会让"语言库 → 契约"这条边成为新常态，而这一批还不需要它。
 * 于是这里放一份**结构子集**：字段名 / 语义逐字与契约相同，宿主把它直接喂给补全的
 * Monaco 翻译层即可（结构类型，不需要转换函数）。
 *
 * ## 档位只列本包真用得上的
 *
 * `kind` 是**宿主挑哪枚图标**的中性说法，不是语义标签。契约的十二档里本包今天只用得上
 * `keyword` / `function` / `variable`；契约扩档时这里跟着补，**不许**在此另造一套命名
 * （宿主那张档→图标映射表是唯一落点）。
 */

/**
 * 落点区间（口径与契约 `EditorLanguageRange` 逐字相同：行号 1 基、列按 UTF-16 码元、
 * 区间 **[startColumn, endColumn)** 尾列不含、单行）。
 */
export interface ErbLanguageRange {
  /** 1 基行号 */
  readonly line: number;
  /** 1 基起始列（UTF-16 码元） */
  readonly startColumn: number;
  /** 1 基结束列（**不含**），须 ≥ `startColumn` */
  readonly endColumn: number;
}

/** 候选的中性类别（宿主按它挑图标与排序档；语义同契约 `EditorCompletionItemKind` 的同名档） */
export type ErbCompletionItemKind = 'keyword' | 'function' | 'variable';

/** 一条候选（字段语义与契约 `EditorCompletionItem` 逐字相同） */
export interface ErbCompletionItem {
  /** 列表里显示的字面（也是缺省的插入文本） */
  readonly label: string;
  readonly kind?: ErbCompletionItemKind;
  /** 行尾浅色补充（类型 / 形参摘要） */
  readonly detail?: string;
  /** 展开的说明文档（纯文本，多行用 `\n`） */
  readonly documentation?: string;
  /** 插入文本（缺省 = `label`） */
  readonly insertText?: string;
  /** 过滤文本（缺省 = `label`） */
  readonly filterText?: string;
  /** 排序权重（字典序，小在前） */
  readonly sortText?: string;
  /** 插入时替换的区间（缺省 = 宿主自己的现行口径） */
  readonly range?: ErbLanguageRange;
}