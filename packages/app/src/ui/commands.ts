/**
 * 命令体系（2026-10-11 UI 重设计批 P2；定稿 §五）。
 *
 * 纯逻辑零 React：keybinding 解析/匹配 + 命令注册表合并。
 * 壳层布局命令（切换侧栏/底部区/禅模式等）与 `editor.command` 槽贡献合并为
 * 统一注册表——命令面板、快捷键表、工具栏读同一真源（定稿：动作真源在命令）。
 */

import type { EditorCommandContext, EditorCommandContribution } from '@kojo/plugin-api';

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

/** keybinding 的人读展示（命令面板右侧 hint） */
export function formatKeybinding(binding: string): string {
  const c = parseKeybinding(binding);
  if (!c) return binding;
  const mods: string[] = [];
  if (c.ctrl) mods.push('Ctrl');
  if (c.shift) mods.push('Shift');
  if (c.alt) mods.push('Alt');
  if (c.meta) mods.push('Meta');
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
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
    const entry: CommandEntry = { id: s.id, title: s.title, category: '布局', run: () => s.run() };
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

/** 快速打开的候选过滤（路径子串匹配；文件名命中优先于目录命中） */
export function filterFileCandidates(paths: readonly string[], query: string, cap = 50): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, cap);
  const nameHit: string[] = [];
  const pathHit: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    if (name.includes(q)) nameHit.push(p);
    else if (lower.includes(q)) pathHit.push(p);
  }
  return [...nameHit, ...pathHit].slice(0, cap);
}
