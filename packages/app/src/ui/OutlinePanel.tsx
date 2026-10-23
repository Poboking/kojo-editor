import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { Icon, type IconName } from './icons';
import { readJumpProbe } from './jump-to-state';
import { buildOutlineRows, locateOutlineRow, outlineRowsKey, type OutlineRow } from './outline-model';

/**
 * 侧栏「大纲」（批次十 S9）——对标 VS Code Outline 的宿主内建面板体。
 *
 * 读的是编辑器位点探针（`jump-to-state` 那一条注册通道）：探针背后是
 * `documentSymbol` 树缓存（面包屑 / 吸顶 / 大纲同一棵，ERB 与 `.kojo2` 各有 provider），
 * 因此面板**不解析任何格式**，也不新造第二套符号来源。
 *
 * 刷新时机只有三处，且都不挂 Monaco 监听：
 * - `editor.cursorMoved`（光标 / 切文件 / 糖视图翻转都汇到这一条广播）⇒ 立即读探针；
 * - `editor.documentChanged` ⇒ **推迟一拍**再读（面包屑同一条防抖链在 250ms 后补树，
 *   推后读取能直接吃上它的缓存，避免同一篇文档在一个停笔窗口里被解析两次）；
 * - `editor.activeFileChanged`（sticky）⇒ 立即读（关闭最后一个标签时也要回到空态）。
 *
 * 空态一律**可见**（铁律 4）：没有文件 / 语言服务没答 / 糖视图行号不可用 / 文件里
 * 确实没有符号，各给一句人话，绝不静默留白。
 */

/** 文档改动后的补读延迟：排在面包屑 250ms 重算之后，直接复用它的树缓存 */
const OUTLINE_DOC_REFRESH_MS = 300;

const NO_FILE_HINT = '还没有打开文件——在左侧打开一份口上文件，大纲会列在这里。';
const DERIVED_HINT = '现在是转出来的写法视图，行号对不上原文件——按 Ctrl+Alt+T 切回原代码再看大纲。';
const NO_SYMBOLS_HINT = '语言服务还没给出这份文件的符号——稍等片刻，或切回原代码再试。';
const EMPTY_TREE_HINT = '这份文件里还没有可列出的符号。';

export interface OutlinePanelProps {
  readonly kernel: Kernel;
  /** 跳源走宿主既有通道（`editor.revealLocation` 的载荷在宿主侧同一处折） */
  readonly onReveal: (path: string, line: number) => void;
}

interface OutlineViewState {
  readonly path: string | null;
  readonly symbols: readonly EditorDocumentSymbol[] | null;
  readonly rows: readonly OutlineRow[];
  readonly activeIndex: number;
  readonly notice: string | null;
  /** 等值键：位点动了但大纲视觉没变 ⇒ 不 setState */
  readonly key: string;
}

const EMPTY_STATE: OutlineViewState = {
  path: null,
  symbols: null,
  rows: [],
  activeIndex: -1,
  notice: null,
  key: '',
};

/** 符号类别 → 内置图标（不认识的一律回退文件图标，不会画成空白） */
function iconForKind(kind: EditorDocumentSymbol['kind']): IconName {
  if (kind === 'function') return 'code';
  if (kind === 'section') return 'structure';
  if (kind === 'declaration') return 'module';
  return 'files';
}

export function OutlinePanel({ kernel, onReveal }: OutlinePanelProps): ReactElement {
  const [state, setState] = useState<OutlineViewState>(EMPTY_STATE);
  /** 上一次投影（不触发渲染的那份，用于挡掉等值刷新） */
  const lastRef = useRef<OutlineViewState>(EMPTY_STATE);
  /** 文档改动的补读定时器（卸载 / 换 kernel 时丢弃在途那一次） */
  const docTimerRef = useRef<number | null>(null);
  /** 当前符号行（光标走时滚到可见处，与 VS Code 的"跟随"同感） */
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    const probe = readJumpProbe();
    let next: Omit<OutlineViewState, 'key'>;
    if (!probe) {
      next = { path: null, symbols: null, rows: [], activeIndex: -1, notice: NO_FILE_HINT };
    } else if (probe.derivedView) {
      next = { path: probe.path, symbols: null, rows: [], activeIndex: -1, notice: DERIVED_HINT };
    } else if (probe.symbols === null) {
      next = { path: probe.path, symbols: null, rows: [], activeIndex: -1, notice: NO_SYMBOLS_HINT };
    } else {
      const rows = buildOutlineRows(probe.symbols);
      if (rows.length === 0) {
        next = { path: probe.path, symbols: probe.symbols, rows, activeIndex: -1, notice: EMPTY_TREE_HINT };
      } else {
        next = {
          path: probe.path,
          symbols: probe.symbols,
          rows,
          activeIndex: locateOutlineRow(rows, probe.symbols, probe.line),
          notice: null,
        };
      }
    }
    const key = `${next.path ?? ''}\u0000${next.notice ?? ''}\u0000${next.activeIndex}\u0000${outlineRowsKey(next.rows)}`;
    if (key === lastRef.current.key) return;
    const committed: OutlineViewState = { ...next, key };
    lastRef.current = committed;
    setState(committed);
  }, []);

  /** 文档改动：推后一拍读（让面包屑的防抖重算先把树缓存换上） */
  const scheduleRefresh = useCallback((): void => {
    if (docTimerRef.current !== null) return;
    docTimerRef.current = window.setTimeout(() => {
      docTimerRef.current = null;
      refresh();
    }, OUTLINE_DOC_REFRESH_MS);
  }, [refresh]);

  useEffect(() => {
    refresh();
    const offCursor = kernel.bus.on('editor.cursorMoved', refresh);
    const offDoc = kernel.bus.on('editor.documentChanged', scheduleRefresh);
    const offActive = kernel.bus.on('editor.activeFileChanged', refresh);
    return () => {
      offCursor();
      offDoc();
      offActive();
      if (docTimerRef.current !== null) {
        window.clearTimeout(docTimerRef.current);
        docTimerRef.current = null;
      }
    };
  }, [kernel, refresh, scheduleRefresh]);

  // 光标换到另一段时把那一行滚进视口（`block: 'nearest'`：已经在眼前就不动）
  useEffect(() => {
    const node = activeRowRef.current;
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [state.rows, state.activeIndex]);

  const rows = state.rows;
  const body =
    state.notice !== null ? (
      <div
        data-outline-empty=""
        style={{ padding: '12px 10px', color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.6 }}
      >
        {state.notice}
      </div>
    ) : (
      <div role="tree" aria-label="大纲" style={{ padding: '4px 0' }}>
        {rows.map((row, index) => {
          const active = index === state.activeIndex;
          const hovered = row.id === hoverId;
          const title = row.detail !== null ? `${row.name} — ${row.detail}` : row.name;
          return (
            <button
              key={row.id}
              ref={active ? activeRowRef : null}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={active}
              title={title}
              onClick={() => {
                if (state.path !== null) onReveal(state.path, row.startLine);
              }}
              onMouseEnter={() => setHoverId(row.id)}
              onMouseLeave={() => setHoverId((prev) => (prev === row.id ? null : prev))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                minHeight: 22,
                padding: `2px 8px 2px ${8 + row.depth * 12}px`,
                border: 0,
                borderRadius: 0,
                background: active ? 'var(--active)' : hovered ? 'var(--hover)' : 'transparent',
                color: active ? 'var(--fg)' : 'var(--fg-dim)',
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                textAlign: 'left',
                cursor: 'pointer',
                boxShadow: active ? 'inset 2px 0 0 rgb(var(--accent-rgb))' : 'none',
              }}
            >
              <span style={{ flex: '0 0 auto', display: 'inline-flex', width: 14, height: 14 }}>
                <Icon name={iconForKind(row.kind)} size={14} />
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.name.length > 0 ? row.name : '（未命名）'}
              </span>
              {row.detail !== null ? (
                <span
                  style={{
                    flex: '0 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    opacity: 0.7,
                  }}
                >
                  {row.detail}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto' }}>
      {body}
    </div>
  );
}
