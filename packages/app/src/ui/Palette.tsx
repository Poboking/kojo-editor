import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { EditorCommandContext, EditorWorkspaceSymbol } from '@kojo/plugin-api';
import type { CommandEntry } from './commands';
import { dirLabelParts } from './path-label';
import { isComposingEvent } from './shell-keys';
import {
  activeSymbolKey,
  commandItems,
  lineFromKey,
  MODE_TEXT,
  parsePaletteMode,
  quickOpenView,
  revealHome,
  type ActiveFileSymbolSource,
  type HitRanges,
} from './palette-search';
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

/** `Picker` 的一行（三个面板与快速打开四种模式共用；判据全在 `palette-search`，这里只是形状） */
interface PickerItem {
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
  /**
   * 主行上的**命中区间**（1020 编辑器体感批：一眼看到"这行为什么在列表里"）。
   * 下标相对 `primary` 的原样文本，由 `palette-search.fuzzyMatch` 就地算——
   * 只有这一屏看得见的行才付这份钱。
   */
  ranges?: HitRanges;
  /** 副行（目录段）上的命中区间：文件名不命中、只有目录命中时高亮落在目录里。
   * 下标相对**最深一层目录**（`dirLabelParts(dir).tail`）——可缩的前缀 `head` 会被中段省略改写，
   * 拿整条目录的下标去切它就是切错字符串。 */
  secondaryRanges?: HitRanges;
  /** 小节标题（与上一行不同时，在这一行上方插一条分组标签）；目前只有「最近打开」 */
  group?: string;
}

interface PickerProps {
  placeholder: string;
  /** 空候选时的提示 */
  emptyText: string;
  query: string;
  onQuery(q: string): void;
  /** 只读：列表内容由纯函数算出来就直接交进来，不再 `.slice()` 复制一次 */
  items: readonly PickerItem[];
  onPick(key: string): void;
  onClose(): void;
  /**
   * 列表下方的**溢出提示**（D2）：预算截断了多少条要说出来，不能让作者以为"就只有这些"。
   * 与 `emptyText` 互不冲突——那是"没有结果"，这是"结果没列全"。
   */
  footnote?: string | null;
}

/**
 * 命中区间 → 高亮片段（`<mark>` 包住命中的那几枚字符）。
 *
 * 区间不合法（越界 / 倒置 / 重叠）时**整行原样返回**，不画半个高亮：
 * 宁可不高亮，也不能把文件名切错——文件名是作者认文件的唯一线索。
 */
function marked(text: string, ranges: HitRanges | undefined): ReactNode {
  if (ranges === undefined || ranges.length === 0) return text;
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at || end <= start || end > text.length) return text;
    at = end;
  }
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(<mark key={`${start}-${end}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
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
              const row = (
                <button
                  key={it.key}
                  data-idx={i}
                  className={`picker-item ${i === cursor ? 'active' : ''}`}
                  disabled={it.disabled === true}
                  {...(it.title !== undefined ? { title: it.title } : {})}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                >
                  <span className="picker-primary">{marked(it.primary, it.ranges)}</span>
                  {dirLabel !== null && it.secondaryDir !== undefined ? (
                    <span className="picker-secondary dim" title={it.secondaryDir}>
                      {dirLabel.head !== '' ? <span className="ps-head">{dirLabel.head}</span> : null}
                      <span className="ps-tail">{marked(dirLabel.tail, it.secondaryRanges)}</span>
                    </span>
                  ) : null}
                  {it.hint ? <span className="picker-hint dim">{it.hint}</span> : null}
                </button>
              );
              const prev = i > 0 ? items[i - 1] : undefined;
              // 分组标题只在**换组那一行**前插一条（不是每行都带标签）；
              // 它不参与键盘导航：光标下标始终数的是行，标题只是给眼睛的隔断。
              if (it.group === undefined || it.group === prev?.group) return row;
              return (
                <Fragment key={`group-${it.group}-${it.key}`}>
                  <div className="picker-group-label dim">{it.group}</div>
                  {row}
                </Fragment>
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
  // 条目构造与 Ctrl+P 的 `>` 模式共用一份（`commandItems`）：两个入口给两种高亮/顺序 = 迟早分叉
  const items = useMemo(() => commandItems(commands, query, commandCtx), [commands, query, commandCtx]);

  return (
    <Picker
      placeholder="输入命令名称…"
      emptyText="无匹配命令"
      query={query}
      onQuery={setQuery}
      items={items}
      onPick={(id) => {
        const cmd = commands.find((c) => c.id === id);
        onClose();
        if (cmd) void cmd.run(commandCtx);
      }}
      onClose={onClose}
    />
  );
}

/** 一次定位请求（壳层折成既有 `editor.revealLocation`，面板自己不发事件、不碰编辑器） */
export interface PaletteReveal {
  readonly filePath: string;
  readonly line: number;
  readonly source: string;
}

export interface QuickOpenProps {
  /** 候选文件路径（壳层泛型，零业务知识） */
  files: readonly string[];
  /** 最近打开（倒序）：空查询时在列表顶上先给一节「最近打开」 */
  recent?: readonly string[];
  /** `>` 模式：与 F1 命令面板**同一张注册表、同一条过滤判据**（两处不同尺子迟早分叉） */
  commands: readonly CommandEntry[];
  commandCtx: EditorCommandContext;
  /** `@` 模式：当前文件的符号来源（编辑器位点探针；按下前缀才取） */
  activeFileSymbols(): ActiveFileSymbolSource | null;
  /** 当前文件（探针不在场时的回落落点，如 `:` 那一趟没问探针） */
  activeFile: string | null;
  onOpenFile(path: string): void;
  /** 跳到某行（`:` 行号 / `@` 程序段）——由壳层落地，面板零 IO */
  onReveal(target: PaletteReveal): void;
  onClose(): void;
}

/**
 * 快速打开（Ctrl+P，1020 编辑器体感批：一栏四用）。
 *
 * 前缀开关照 VS Code 的 Quick Open：**`>` 命令 · `@` 当前文件里的程序 · `:` 跳到行号 ·
 * 其余按名字或路径找文件**。判据只认首字符（路径中间的 `:` 是盘符，不能当开关）。
 *
 * 本组件只做两件事：把输入交给 `parsePaletteMode`、把列表交给 `Picker`。
 * **模式内容、空态文案、高亮区间全在 `palette-search.quickOpenView`**（纯函数、可单测），
 * 渲染层不留第二份判据。
 *
 * 三条腿各归其位：文件模式**永久打开**（专门搜出来的不是"瞄一眼"）；`@` 与 `:` 走
 * `onReveal` ⇒ 壳层折成既有 `editor.revealLocation`；`>` 直接跑注册表里那条命令。
 */
export function QuickOpen({
  files,
  recent,
  commands,
  commandCtx,
  activeFileSymbols,
  activeFile,
  onOpenFile,
  onReveal,
  onClose,
}: QuickOpenProps): ReactElement {
  const [query, setQuery] = useState('');
  const mode = useMemo(() => parsePaletteMode(query), [query]);
  const symbolsRef = useRef(activeFileSymbols);
  symbolsRef.current = activeFileSymbols;

  /**
   * 符号树只在**进入 `@` 那一拍**取一次：探针可能触发一次全文解析（有缓存，但冷的那下不便宜），
   * 每击键重取等于把编辑器最贵的一步挂到搜索框上。`:` 那一趟干脆不问（只要一个落点文件）。
   */
  const isSymbolMode = mode.kind === 'symbols';
  const source = useMemo(() => (isSymbolMode ? symbolsRef.current() : null), [isSymbolMode]);

  const view = useMemo(
    () =>
      quickOpenView({
        mode,
        files,
        ...(recent === undefined ? {} : { recent }),
        commands,
        commandCtx,
        symbolSource: source,
        activeFile,
      }),
    [mode, files, recent, commands, commandCtx, source, activeFile],
  );

  return (
    <Picker
      placeholder={MODE_TEXT[mode.kind].placeholder}
      emptyText={view.emptyText}
      query={query}
      onQuery={setQuery}
      items={view.items}
      onPick={(key) => {
        if (mode.kind === 'files') {
          onClose();
          onOpenFile(key);
          return;
        }
        if (mode.kind === 'commands') {
          const cmd = commands.find((c) => c.id === key);
          onClose();
          if (cmd) void cmd.run(commandCtx);
          return;
        }
        if (mode.kind === 'line') {
          const line = lineFromKey(key);
          const home = revealHome(source, activeFile);
          onClose();
          if (line !== null && home !== '') onReveal({ filePath: home, line, source: '转到行' });
          return;
        }
        const picked = (source?.symbols ?? []).find((s) => activeSymbolKey(s) === key);
        onClose();
        if (picked !== undefined && source !== null && source.path !== '') {
          onReveal({ filePath: source.path, line: picked.startLine, source: '当前文件符号' });
        }
      }}
      onClose={onClose}
      {...(view.footnote !== null ? { footnote: view.footnote } : {})}
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
