/**
 * 文件树「新建」的盘上守门（WS-01：同名条目不得覆盖）。
 *
 * 事故形态：`commitEdit` 在 create 模式直接 `writeBytes(target, 空)` / `ensureDir(target)`，
 * 盘上已有同名文件时**静默清空**了它。守门放在这里而不在组件里：判据只有一份、可单测
 * （与 `file-tree-ops` / `file-tree-reveal` 同一形态），组件只管接线与上屏。
 *
 * **竞态已在 OS 层闭合**（2026-10-27 独占创建原语批）：本模块不再 `exists` 预检、也不再
 * `writeBytes` 空字节，而是直接调内核的独占创建原语（Rust `CREATE_NEW` / `mkdir`）——
 * "判存在"与"建条目"是同一个原子系统调用。`false` 就是"同名条目已在那儿，一个字节都没动"，
 * 不存在"两次系统调用之间被人插进同名文件、然后被空写覆盖"的窗口。
 *
 * IO 面故意收窄到 `createFileExclusive` / `createDirExclusive` 两条：
 * - 端口里**根本没有** exists / writeBytes ⇒ "还偷偷先查后写"在类型上就无处落脚；
 * - 测试拿最小的替身（第二次回 false）就能钉住文案与"不覆盖"；
 * - 组件传 `FileIO` 进来天然兼容（结构类型），不需要为本模块另立适配层。
 */

/** 新建落点需要的**最小** IO 面（结构类型：`FileIO` 直接可传） */
export interface CreateEntryIo {
  createFileExclusive(path: string): Promise<boolean>;
  createDirExclusive(path: string): Promise<boolean>;
}

export type CreateEntryKind = 'file' | 'dir';

export interface CreateEntrySpec {
  /** 新建目标的绝对路径（父目录 + 名称，由调用侧拼好） */
  readonly target: string;
  /** 文件还是文件夹（决定走哪条独占原语，以及提示措辞） */
  readonly kind: CreateEntryKind;
  /** 用户输入的条目名（只用于人话提示，不参与路径拼接） */
  readonly name: string;
}

/**
 * 新建结果：`created:false` 只表示"目标已存在、本次没写"，**不是错误**——
 * 调用侧应保留编辑行让作者改名，并把这句人话上屏。
 */
export type CreateEntryOutcome =
  | { readonly created: true }
  | { readonly created: false; readonly reason: 'exists'; readonly message: string };

/** 同名条目的中文提示（文件 / 文件夹分别措辞；措辞只此一处，别在组件里再抄） */
export function entryExistsMessage(kind: CreateEntryKind, name: string): string {
  return kind === 'file'
    ? `已存在同名文件，未覆盖：${name}`
    : `已存在同名文件夹，未覆盖：${name}`;
}

/**
 * 创建（一步到位，纯 IO 无 React）。
 *
 * - 原语返回 `false`（目标已存在）⇒ 不覆盖，返回 `{ created:false, message }`；
 * - 原语返回 `true` ⇒ 真建了空文件 / 空文件夹，返回 `{ created:true }`；
 * - IO 失败（越权 / 权限 / 父目录没了…）⇒ **原样向上抛**，调用侧照既有 `noteErr`
 *   （`errorText` 口径）说人话并带上原始原因——绝不把"建不成"折叠成"已存在"。
 */
export async function createEntryIfAbsent(
  io: CreateEntryIo,
  spec: CreateEntrySpec,
): Promise<CreateEntryOutcome> {
  const created =
    spec.kind === 'file'
      ? await io.createFileExclusive(spec.target)
      : await io.createDirExclusive(spec.target);
  if (!created) {
    return { created: false, reason: 'exists', message: entryExistsMessage(spec.kind, spec.name) };
  }
  return { created: true };
}
