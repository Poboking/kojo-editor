import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { EditorCommandContext, EditorWorkspaceSymbol } from '@kojo/plugin-api';
import {
  commandEnabled,
  filterCommands,
  filterFileCandidates,
  formatKeybinding,
  type CommandEntry,
} from './commands';
import { dirLabelParts, splitPath } from './path-label';
import { isComposingEvent } from './shell-keys';
import {
  pickWorkspaceSymbols,
  symbolPickerItems,
  symbolPickerKey,
  workspaceSymbolOverflowText,
  type WorkspaceSymbolCollection,
} from './workspace-symbols';

/**
 * 命令面板 / 快速打开 / 工作区符号（2026-10-11 UI 重设计批 P2；D2 2026-10-15 加符号）。
 *
 * 三者共用同一模态列表选择器形态（输入 + 过滤列表 + 键盘导航），
 * 壳层零业务知识：命令面板读统一命令注册表，快速打开读泛型文件路径候选，
 * 符号面板读 `ui.editor.languageService` 的 `workspaceSymbol` 应答（宿主只做合并）。
 *
 * 键盘：↑↓ 移动、Enter 执行、Esc 关闭（stopPropagation 防止穿透到壳层
 * 禅模式 Esc——Esc 优先级：picker > overlay > zen）。
 *
 * **输入法合成期一律让位**（`isComposingEvent`，同 `shell-keys` 的单源判据）：
 * 拼音候选窗用的也是 ↑↓/Enter/Esc，选择器在这里吞一次键 = 把用户正在打的字替他选了
 * 一项。写作模式的主场景就是中文输入，故这条判据对三个面板同时生效。
 */

interface PickerProps {
  placeholder: string;
  /** 空候选时的提示 */
  emptyText: string;
  query: string;
  onQuery(q: string): void;
  items: {
    key: string;
    primary: string;
    /**
     * 副行 = 这个文件住在哪个目录，**分两段渲染**（前缀可缩、最深一层恒显）。
     * 整条目录交给 CSS 尾部省略时，被裁掉的恰好是包名 / 角色目录——实测 337–389px，
     * 而那是一堆同名 ERB 之间唯一的区分点（同编辑器工具条的规矩，见 `path-label.ts`）。
     */
    secondaryDir?: string;
    hint?: string;
    disabled?: boolean;
    /** 悬停全文（符号面板给 `文件:行`——副行是目录段，装不下完整路径） */
    title?: string;
  }[];
  onPick(key: string): void;
  onClose(): void;
  /**
   * 列表下方的**溢出提示**（D2）：预算截断了多少条要说出来，不能让作者以为"就只有这些"。
   * 与 `emptyText` 互不冲突——那是"没有结果"，这是"结果没列全"。
   */
  footnote?: string | null;
}

function Picker({ placeholder, emptyText, query, onQuery, items, onPick, onClose, footnote }: PickerProps): ReactElement {
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * 合成会话标志（判据与壳层全局键盘同源，见 `shell-keys.ts`）。
   * 只在本组件内维护：候选窗开着时事件都落在选择器里，不需要跨组件共享。
   */
  const composingRef = useRef(false);

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
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          // 合成期：一个键都不消费（拼音候选窗自己要用这些键）
          // 判据用**原生事件**——`isComposing` 在 React 合成事件上没有转发，而它正是主判据。
          if (isComposingEvent(e.nativeEvent, composingRef.current)) return;
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
            items.map((it, i) => {
              // 目录标签**一行算一次**（PS-6 第 6 项）：旧写法在同一行里调 `dirLabelParts`
              // 三遍（判空 + head + tail），一次 Ctrl+P 铺满预算就是几百行 × 三次拆分。
              const dirLabel = it.secondaryDir !== undefined ? dirLabelParts(it.secondaryDir) : null;
              return (
                <button
                  key={it.key}
                  data-idx={i}
                  className={`picker-item ${i === cursor ? 'active' : ''}`}
                  disabled={it.disabled === true}
                  {...(it.title !== undefined ? { title: it.title } : {})}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <span className="picker-primary">{it.primary}</span>
                  {dirLabel !== null && it.secondaryDir !== undefined ? (
                    <span className="picker-secondary dim" title={it.secondaryDir}>
                      {dirLabel.head !== '' ? <span className="ps-head">{dirLabel.head}</span> : null}
                      <span className="ps-tail">{dirLabel.tail}</span>
                    </span>
                  ) : null}
                  {it.hint ? <span className="picker-hint dim">{it.hint}</span> : null}
                </button>
              );
            })
          )}
        </div>
        {footnote ? <div className="picker-note dim">{footnote}</div> : null}
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
        const { dir, base } = splitPath(p);
        return { key: p, primary: base, ...(dir !== '' ? { secondaryDir: dir } : {}) };
      })}
      onPick={(path) => {
        onClose();
        onOpenFile(path);
      }}
      onClose={onClose}
    />
  );
}

export interface WorkspaceSymbolsProps {
  /**
   * 问一次候选（宿主在此查 `ui.editor.languageService` 槽；**同步**、零业务知识）。
   * 身份每帧都可变，故只经 ref 读、不作 `useMemo` 依赖——否则父组件一渲染就把
   * 十万条名字重新扫一遍（查询代价按击键计，不按渲染计）。
   */
  fetchSymbols(query: string): WorkspaceSymbolCollection;
  /** 空结果的**可见原因**（无项目 / 索引构建中 / 索引失败 / 还没打字） */
  notice(query: string): string;
  onPickSymbol(symbol: EditorWorkspaceSymbol): void;
  onClose(): void;
}

/**
 * 工作区符号（D2 · Ctrl+T）：按名字找定义并跳过去。
 *
 * 与 `QuickOpen` 的分工：那条按**文件**找，这条按**符号**找；形态（Picker）与
 * 跳转通道（`editor.revealLocation`，由发起方 `onPickSymbol` 落地）都不新造。
 */
export function WorkspaceSymbols({
  fetchSymbols,
  notice,
  onPickSymbol,
  onClose,
}: WorkspaceSymbolsProps): ReactElement {
  const [query, setQuery] = useState('');
  const fetchRef = useRef(fetchSymbols);
  fetchRef.current = fetchSymbols;

  const collected = useMemo(() => fetchRef.current(query), [query]);
  const picked = useMemo(() => pickWorkspaceSymbols(collected, query), [collected, query]);
  const overflow = workspaceSymbolOverflowText(picked.hidden);
  // 条目形状（主行/副行/行号）的判据在 `workspace-symbols.ts`（纯映射，可单测）
  const items = useMemo(() => symbolPickerItems(picked.items), [picked.items]);

  return (
    <Picker
      placeholder="按名称搜索工作区符号…"
      emptyText={notice(query)}
      query={query}
      onQuery={setQuery}
      items={items}
      onPick={(key) => {
        const symbol = picked.items.find((s) => symbolPickerKey(s) === key);
        onClose();
        if (symbol) onPickSymbol(symbol);
      }}
      onClose={onClose}
      {...(overflow !== null ? { footnote: overflow } : {})}
    />
  );
}
