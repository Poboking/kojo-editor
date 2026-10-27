/**
 * 资源管理器剪贴板的**会话态**（WS-13 2a 车；零 React、零 IO）。
 *
 * ## 为什么是模块级
 *
 * 两件事凑在一起决定了形态：
 *
 * - 粘贴的宾语来自树的多选集，而勾选只惊动翻转快照的那几行（见 `file-tree-multi-selection`
 *   那条 PERF 教训）⇒ 树本体不会因为勾了东西而重渲 ⇒ 任何"注册那帧的快照"都会过期，
 *   必须**现读**；
 * - 命令面板那侧也要能触发同一动作（`explorer.copyEntry` 等），而它拿不到树的实例。
 *
 * 于是照 `file-tree-selection` / `file-tree-multi-selection` 的既有先例放模块级单例，
 * 树挂载时把它自己的执行入口登记进运行时桥，命令面板通过桥打过来。
 *
 * ## 只住会话，不落盘
 *
 * 刻意**不写 localStorage**：里面是绝对路径，跨重启既没有意义（项目可能已经关了、
 * 文件可能已经没了），又会把"上次剪了什么"变成一台机器上的隐私面。会话内有效、
 * 换项目即清（`clearFileClipboard` 由宿主在根变化时调），与"剪切还没落地"同一条生命周期。
 */

export type ClipMode = 'copy' | 'cut';

/** 剪贴板里的一条源（路径 + 是不是目录；种类必须在复制那一刻定下来，粘贴时树可能已经变了） */
export interface ClipEntry {
  readonly path: string;
  readonly isDir: boolean;
}

let entries: readonly ClipEntry[] = [];
let mode: ClipMode = 'copy';

/** 当前剪贴板内容（有序快照；空数组 = 空着） */
export function getFileClipboard(): readonly ClipEntry[] {
  return entries;
}

/** 当前模式（空剪贴板时读它没有意义，调用侧先判 `hasFileClipboard`） */
export function getFileClipMode(): ClipMode {
  return mode;
}

export function hasFileClipboard(): boolean {
  return entries.length > 0;
}

/**
 * 写入剪贴板（复制 / 剪切）。
 *
 * 按 `pkey` 式归一去重（分隔符 / 大小写两种写法不算两份）——与多选集同一口径；
 * 顺序就是作者选中的顺序。空集合等于清空（不给"剪贴板里什么都没有但仍标着剪切"的状态）。
 */
export function setFileClipboard(next: readonly ClipEntry[], nextMode: ClipMode): number {
  const seen = new Set<string>();
  const out: ClipEntry[] = [];
  for (const e of next) {
    const key = e.path.replace(/[\\/]+/g, '/').toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  entries = out;
  mode = out.length === 0 ? 'copy' : nextMode;
  return out.length;
}

export function clearFileClipboard(): void {
  entries = [];
  mode = 'copy';
}

/** 上屏用的一句人话（「已复制 3 项」/「已剪切 1 项」；空着说"剪贴板是空的"） */
export function fileClipSentence(): string {
  if (entries.length === 0) return '剪贴板是空的——先在树上选中要搬的东西，再按复制。';
  return `已${mode === 'cut' ? '剪切' : '复制'} ${entries.length} 项`;
}

/* ------------------------------ 运行时桥（命令面板的落点） ------------------------------ */

/** 资源管理器的四条文件动作（菜单、键位、命令面板共用同一份 id） */
export type ExplorerOp = 'copy' | 'cut' | 'paste' | 'duplicate';

/**
 * 树交出来的执行入口（每次渲染整体替换；卸载即 null）。
 *
 * 只给"做"这一件事：命令面板不持有现场，也不该自己算宾语 —— 宾语（多选集 / 焦点行）
 * 与落点（焦点行所在目录）只有树自己当场知道。
 */
export interface ExplorerOpsRuntime {
  readonly run: (op: ExplorerOp) => void;
}

let runtime: ExplorerOpsRuntime | null = null;

export function setExplorerOpsRuntime(next: ExplorerOpsRuntime | null): void {
  runtime = next;
}

/**
 * 打一条动作到当前挂载的树。
 *
 * 返回 `false` = 树没挂载（项目没开 / 侧栏被换掉）——**调用侧必须说人话**，
 * 不许静默返回（铁律 4）；这里不自己弹通知，因为上屏通道在宿主那侧。
 */
export function runExplorerOp(op: ExplorerOp): boolean {
  const rt = runtime;
  if (rt === null) return false;
  rt.run(op);
  return true;
}

/** 测试用：把两份单例一起复位（生产不留"清空运行时"的额外入口——卸载已经清了） */
export function resetFileClipboardForTest(): void {
  clearFileClipboard();
  runtime = null;
}
