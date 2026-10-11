import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { EditorCommandContext } from '@kojo/plugin-api';
import {
  commandEnabled,
  filterCommands,
  filterFileCandidates,
  formatKeybinding,
  type CommandEntry,
} from './commands';

/**
 * 命令面板 / 快速打开（2026-10-11 UI 重设计批 P2；定稿 §五/§十一）。
 *
 * 两者共用同一模态列表选择器形态（输入 + 过滤列表 + 键盘导航），
 * 壳层零业务知识：命令面板读统一命令注册表，快速打开读泛型文件路径候选。
 *
 * 键盘：↑↓ 移动、Enter 执行、Esc 关闭（stopPropagation 防止穿透到壳层
 * 禅模式 Esc——Esc 优先级：picker > overlay > zen）。
 */

interface PickerProps {
  placeholder: string;
  /** 空候选时的提示 */
  emptyText: string;
  query: string;
  onQuery(q: string): void;
  items: { key: string; primary: string; secondary?: string; hint?: string; disabled?: boolean }[];
  onPick(key: string): void;
  onClose(): void;
}

function Picker({ placeholder, emptyText, query, onQuery, items, onPick, onClose }: PickerProps): ReactElement {
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  // 过滤后候选数变化：光标回落防越界
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items.length]);
  // 光标项滚入视口
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (idx: number): void => {
    const it = items[idx];
    if (!it || it.disabled) return;
    onPick(it.key);
  };

  return (
    <div className="picker-backdrop" onMouseDown={onClose}>
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(cursor);
          }
        }}
      >
        <input
          ref={inputRef}
          className="picker-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setCursor(0);
          }}
        />
        <div ref={listRef} className="picker-list">
          {items.length === 0 ? (
            <div className="picker-empty dim">{emptyText}</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                data-idx={i}
                className={`picker-item ${i === cursor ? 'active' : ''}`}
                disabled={it.disabled === true}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(i)}
              >
                <span className="picker-primary">{it.primary}</span>
                {it.secondary ? <span className="picker-secondary dim">{it.secondary}</span> : null}
                {it.hint ? <span className="picker-hint dim">{it.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export interface CommandPaletteProps {
  commands: readonly CommandEntry[];
  commandCtx: EditorCommandContext;
  onClose(): void;
}

/** 命令面板（Ctrl+Shift+P / F1）：读统一注册表，when 求值决定禁态 */
export function CommandPalette({ commands, commandCtx, onClose }: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  return (
    <Picker
      placeholder="输入命令名称…"
      emptyText="无匹配命令"
      query={query}
      onQuery={setQuery}
      items={filtered.map((c) => ({
        key: c.id,
        primary: c.category ? `${c.category}: ${c.title}` : c.title,
        ...(c.keybinding ? { hint: formatKeybinding(c.keybinding) } : {}),
        disabled: !commandEnabled(c, commandCtx),
      }))}
      onPick={(id) => {
        const cmd = commands.find((c) => c.id === id);
        onClose();
        if (cmd) void cmd.run(commandCtx);
      }}
      onClose={onClose}
    />
  );
}

export interface QuickOpenProps {
  /** 候选文件路径（壳层泛型，零业务知识） */
  files: readonly string[];
  onOpenFile(path: string): void;
  onClose(): void;
}

/** 快速打开（Ctrl+P）：路径子串过滤（文件名命中优先），Enter 打开 */
export function QuickOpen({ files, onOpenFile, onClose }: QuickOpenProps): ReactElement {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterFileCandidates(files, query), [files, query]);

  return (
    <Picker
      placeholder="按名称或路径快速打开文件…"
      emptyText="无匹配文件"
      query={query}
      onQuery={setQuery}
      items={filtered.map((p) => {
        const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return {
          key: p,
          primary: slash >= 0 ? p.slice(slash + 1) : p,
          secondary: slash >= 0 ? p.slice(0, slash) : '',
        };
      })}
      onPick={(path) => {
        onClose();
        onOpenFile(path);
      }}
      onClose={onClose}
    />
  );
}
