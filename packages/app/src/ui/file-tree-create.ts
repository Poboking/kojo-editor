/**
 * 文件树「新建」的盘上守门（WS-01：同名条目不得覆盖）。
 *
 * 现状事故：`commitEdit` 在 create 模式直接 `writeBytes(target, 空)` / `ensureDir(target)`，
 * 盘上已有同名文件时**静默清空**了它。守门放在这里而不在组件里：判据只有一份、可单测
 * （与 `file-tree-ops` / `file-tree-reveal` 同一形态），组件只管接线与上屏。
 *
 * IO 面故意收窄到 exists / writeBytes / ensureDir 三条：
 * - 测试拿最小的替身就能证明"存在时一次写/建都不调、原内容不变"；
 * - 组件传 `FileIO` 进来天然兼容（结构类型），不需要为本模块扩契约。
 *
 * 已知边界（本批不修）：exists 与 write 之间仍有极小竞态窗口（另一个进程在这一瞬
 * 建了同名文件仍会被这次空写覆盖）。彻底解需要内核/平台侧「独占创建」原语
 * （O_EXCL / CREATE_NEW），那是 Rust 与契约层的改动，不在本车道范围内。
 */

/** 新建落点需要的**最小** IO 面（结构类型：`FileIO` 直接可传） */
export interface CreateEntryIo {
  exists(path: string): Promise<boolean>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

export type CreateEntryKind = 'file' | 'dir';

export interface CreateEntrySpec {
  /** 新建目标的绝对路径（父目录 + 名称，由调用侧拼好） */
  readonly target: string;
  /** 文件还是文件夹（决定走 writeBytes 还是 ensureDir，以及提示措辞） */
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
 * 检查 + 创建（一步到位，纯 IO 无 React）。
 *
 * - 目标已存在 ⇒ **不写、不建**，返回 `{ created:false, message }`；
 * - 目标不存在 ⇒ 照旧建空文件（空 Uint8Array，与既有链路一致）/ 建目录，返回 `{ created:true }`；
 * - IO 失败（exists 判不出来 / 写或建抛错）⇒ **原样向上抛**，调用侧照既有 `noteErr`
 *   （`errorText` 口径）说人话并带上原始原因。
 *
 * 注意：`exists` 自己失败时也一律抛、**绝不**"判不出来就建"——那正好会撞回覆盖事故。
 */
export async function createEntryIfAbsent(
  io: CreateEntryIo,
  spec: CreateEntrySpec,
): Promise<CreateEntryOutcome> {
  const exists = await io.exists(spec.target);
  if (exists) {
    return { created: false, reason: 'exists', message: entryExistsMessage(spec.kind, spec.name) };
  }
  if (spec.kind === 'file') await io.writeBytes(spec.target, new Uint8Array());
  else await io.ensureDir(spec.target);
  return { created: true };
}
