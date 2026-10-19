/**
 * 命令体系（2026-10-11 UI 重设计批 P2；定稿 §五）。
 *
 * 纯逻辑零 React：keybinding 解析/匹配 + 命令注册表合并。
 * 壳层布局命令（切换侧栏/底部区/禅模式等）与 `editor.command` 槽贡献合并为
 * 统一注册表——命令面板、快捷键表、工具栏读同一真源（定稿：动作真源在命令）。
 */

import type { EditorCommandContext, EditorCommandContribution } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';

/** 归一化后的按键描述 */
export interface KeyChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string; // 小写，如 'n' / 'p' / 'f1'
}

/**
 * 解析 keybinding 字符串（如 'ctrl+n' / 'ctrl+shift+p' / 'f1'）。
 * 修饰键顺序无关；主键取最后一个段。非法输入返回 null。
 */
export function parseKeybinding(binding: string): KeyChord | null {
  const parts = binding
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const chord: KeyChord = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') chord.ctrl = true;
    else if (p === 'shift') chord.shift = true;
    else if (p === 'alt') chord.alt = true;
    else if (p === 'meta' || p === 'cmd' || p === 'super') chord.meta = true;
    else chord.key = p; // 后写覆盖——主键为最后一个非修饰段
  }
  return chord.key ? chord : null;
}

/** 键盘事件 → 归一化 chord（不匹配仅修饰键本身的按下） */
export function chordFromEvent(e: KeyboardEvent): KeyChord | null {
  const key = e.key.toLowerCase();
  if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return null;
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, key };
}

export function chordEquals(a: KeyChord, b: KeyChord): boolean {
  return (
    a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta && a.key === b.key
  );
}

/**
 * 方向键的人读符号（MM-6 导航键位专用特例）：`alt+arrowleft` 原样显示成
 * 「Alt+arrowleft」——快捷键页与命令面板 hint 里一溜小写英文，作者读不了。
 * 只收左右两支（宿主缺省键位里用得上方向键的只有导航历史）；其余方向键不在
 * 宿主缺省键位中，原样回显即可，不预支映射表。
 */
const ARROW_KEY_LABELS: Readonly<Record<string, string>> = { arrowleft: '←', arrowright: '→' };

/** keybinding 的人读展示（命令面板右侧 hint） */
export function formatKeybinding(binding: string): string {
  const c = parseKeybinding(binding);
  if (!c) return binding;
  const mods: string[] = [];
  if (c.ctrl) mods.push('Ctrl');
  if (c.shift) mods.push('Shift');
  if (c.alt) mods.push('Alt');
  if (c.meta) mods.push('Meta');
  // 单字符与功能键（f1…f12）大写展示；左右方向键折成箭头符号；其余原样
  const key =
    c.key.length === 1 || /^f\d+$/.test(c.key) ? c.key.toUpperCase() : (ARROW_KEY_LABELS[c.key] ?? c.key);
  return [...mods, key].join('+');
}

/** 注册表中的统一命令项（壳层命令 + 槽贡献同构） */
export interface CommandEntry {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly when?: (ctx: EditorCommandContext) => boolean;
  run(ctx: EditorCommandContext): void | Promise<void>;
}

/** 壳层内建命令（合法容器语义：显隐/禅/重置——零业务词，定稿 §五-3） */
export interface ShellCommandSpec {
  readonly id: string;
  readonly title: string;
  /** 命令面板分类（缺省 = 「布局」；编辑器动作等自陈分类，R8 起） */
  readonly category?: string;
  readonly keybinding?: string;
  run(): void;
}

/** 合并壳层命令与槽贡献为统一注册表（同 id 时槽贡献优先——插件可覆盖壳层默认） */
export function buildCommandRegistry(
  shellCommands: readonly ShellCommandSpec[],
  slotCommands: readonly EditorCommandContribution[],
): CommandEntry[] {
  const map = new Map<string, CommandEntry>();
  for (const s of shellCommands) {
    const entry: CommandEntry = { id: s.id, title: s.title, category: s.category ?? '布局', run: () => s.run() };
    if (s.keybinding !== undefined) (entry as { keybinding?: string }).keybinding = s.keybinding;
    map.set(s.id, entry);
  }
  for (const c of slotCommands) {
    const entry: CommandEntry = { id: c.id, title: c.title, run: (ctx) => c.run(ctx) };
    if (c.category !== undefined) (entry as { category?: string }).category = c.category;
    if (c.keybinding !== undefined) (entry as { keybinding?: string }).keybinding = c.keybinding;
    if (c.when !== undefined) (entry as { when?: typeof c.when }).when = c.when;
    map.set(c.id, entry);
  }
  return [...map.values()];
}

/** 命令是否在当前上下文可用（when 求值异常 → 视为不可用，不炸交互） */
export function commandEnabled(cmd: CommandEntry, ctx: EditorCommandContext): boolean {
  if (!cmd.when) return true;
  try {
    return cmd.when(ctx);
  } catch {
    return false;
  }
}

/** 命令面板的过滤（大小写不敏感子串；空串返回全部，按 category+title 稳定排序） */
export function filterCommands(commands: readonly CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? commands.filter((c) => `${c.category ?? ''} ${c.title} ${c.id}`.toLowerCase().includes(q))
    : [...commands];
  return matched.sort((a, b) => {
    const ca = a.category ?? '';
    const cb = b.category ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    return a.title.localeCompare(b.title);
  });
}

/**
 * 候选清单合并（**并集、去重、排序**；W7 NAV-SCOPE）。
 *
 * `Ctrl+P` 的候选此前只有 ERB 索引那一层（`.kojo` 与别的方言文件根本进不来——
 * 作者写了半天的糖源文件按 Ctrl+P 搜不到）。合并这一件事留在宿主层：宿主只认
 * "这是一份路径清单"，**谁生产的路径它不认识**（方言文件由口上域的递归列举与
 * 语言服务槽的应答方提供，判据住在提供方与 io 层）。
 */
export function mergeCandidatePaths(groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const p of group) {
      if (typeof p !== 'string' || p === '') continue;
      seen.add(p);
    }
  }
  return [...seen].sort();
}

/**
 * 表层 DSL（`.kojo`）源文件后缀。宿主级**编辑器事实**：同一字面量在
 * `monaco/kojo-language.ts` 注册语言时写了一次（那份是 Monaco 的注册形状，
 * 不是一份可读清单），这里要的是"哪些后缀算源文件"，故显式声明并挂进下面的清单。
 */
export const KOJO_SOURCE_EXTENSION = '.kojo';

/**
 * 快速打开认得的**源文件**后缀：ERB 方言全集（契约 `ERB_DIALECT_EXTENSIONS`）
 * 再加表层 DSL 那一份。
 *
 * 为什么需要这张表：`Ctrl+P` 的候选以前只来自 ERB 索引，于是 `.kojo`（以及索引
 * 不认的那些方言文件）**根本进不来**——"索引里有什么"与"工作区里有什么"是两件事，
 * 把它当一件事用，作者的糖源文件就搜不到。后缀清单住在契约与宿主注册表，
 * 不在这里发明第三种。
 */
export const QUICK_OPEN_SOURCE_EXTENSIONS: readonly string[] = [
  ...ERB_DIALECT_EXTENSIONS,
  KOJO_SOURCE_EXTENSION,
];

/** 路径是否是快速打开认得的源文件（大小写不敏感；无后缀 / 目录段结尾 ⇒ 否） */
export function isQuickOpenSourcePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  const dot = path.lastIndexOf('.');
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= sep) return false;
  return QUICK_OPEN_SOURCE_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

/** `listSourceFiles` 需要的最小列举面（注入 seam：真实是 `kernel.io.walkDir`，单测给假的） */
export type WalkDirLike = (
  path: string,
  opts?: {
    includeFiles?: boolean;
    includeDirs?: boolean;
    filter?: (entry: { name: string; isDirectory: boolean }) => boolean;
  },
) => Promise<readonly { name: string; path: string; isDirectory: boolean }[]>;

/**
 * 口上域内的**源文件**清单（`.erb` / `.erm` / `.erh` / `.kojo`）。
 *
 * 为什么必须有这一条而不是"用索引的键"：ERB 索引只收解析器认得的那几类文件，
 * 而快速打开要回答的是"这个工作区里我能打开什么"。两者划等号 ⇒ `.kojo` 与
 * 索引没吃进去的文件在 `Ctrl+P` 里凭空消失（少扫不是省事的理由，看不见才是事故）。
 *
 * 逐根各一次递归列举（与左侧文件树的冷开快照同一形态）；某根读失败**跳过**，
 * 其余照给——快速打开退化成一份不全的清单是可接受的，整条快捷键失灵不是。
 */
export async function listSourceFiles(walkDir: WalkDirLike, roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue;
    try {
      const entries = await walkDir(root, {
        includeFiles: true,
        includeDirs: false,
        filter: (e) => e.isDirectory || isQuickOpenSourcePath(e.name),
      });
      for (const e of entries) {
        if (!e.isDirectory && isQuickOpenSourcePath(e.name)) out.push(e.path);
      }
    } catch {
      // 读不到这一个根 ⇒ 少一批候选，不影响别的根（铁律 4 的"可见"由面板的空态承担，
      // 这里不抛：一次列举失败不该把整条 Ctrl+P 变成异常）
    }
  }
  return out;
}
/**
 * PS-14：快速打开候选的**会话级缓存器**（注入 seam 同 `listSourceFiles`——`walkDir`
 * 真实是 `kernel.io.walkDir`，单测给假的并数调用次数）。
 *
 * 为什么要有它：同项目连开 N 次 Ctrl+P 不该走 N 趟递归列举——候选源（roots）与
 * 失效戳（nonce）都没变，第 2..N 次全是同一份答案的白走。键 = roots 顺序拼接 +
 * nonce：nonce 是树重列已有的合批信号（`file.changed` → `affectsKojoTree` 过滤 →
 * 400ms 合批，见 ProjectView 的 `treeNonce`），文件真变了它变、缓存自动翻篇，
 * **不在这里另造一套失效判据**。in-flight 的 Promise 同样复用：面板连点六次也只
 * 触发一趟 walk。整体失败不缓存（失败是瞬态的，下次同键重走，不把空清单钉死到
 * 下一次 nonce 翻篇）。
 */
export interface SourceFileCache {
  /** 顺序敏感（应答顺序即 roots 顺序）；同键并发调用共享同一个 Promise */
  list(roots: readonly string[], nonce: number): Promise<readonly string[]>;
}

export function createSourceFileCache(walkDir: WalkDirLike): SourceFileCache {
  let key: string | null = null;
  let entry: Promise<readonly string[]> | null = null;
  return {
    list(roots, nonce) {
      const nextKey = `${nonce} ${roots.join('\n')}`;
      if (key === nextKey && entry !== null) return entry;
      const request = listSourceFiles(walkDir, roots);
      key = nextKey;
      entry = request;
      void request.catch(() => {
        // 失败不缓存：只清"这一格"（部分根失败已在 listSourceFiles 里兜住，
        // 这里只兜整个 promise reject 的极端形态）
        if (entry === request) {
          key = null;
          entry = null;
        }
      });
      return request;
    },
  };
}
