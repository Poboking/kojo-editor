import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { Icon, type IconName } from './icons';
import { readJumpProbe } from './jump-to-state';
import {
  buildOutlineRows,
  locateOutlineRow,
  outlineRowsKey,
  visibleOutlineRows,
  type OutlineRow,
} from './outline-model';
import {
  OUTLINE_ROW_ATTR,
  OUTLINE_ROW_ID_ATTR,
  foldableOutlineIds,
  setOutlineMenuContext,
  type OutlineMenuRow,
} from './outline-menu';
import '../outline-panel.css';

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
 *
 * ## 折叠（1023 缺口批）
 *
 * 折叠是**纯视图状态**（铁律 3）：它只决定"这一支画不画"，行对象、`depth`、行 id、
 * 跳源行为一律不变。三条边界写在这里，因为它们是这份状态的**生命周期**：
 * - **不落盘**：折叠不是作者的偏好设置，而是"此刻想少看几行"的临时视线；一旦持久化，
 *   下次打开同一份文件就会被一份谁都没要求过的视角挡住（`autosave-pref` 那种
 *   偏好存储的语义完全不同，不借）。进程内也只活在这一个面板实例上。
 * - **换文档就复位**：行 id 是**先序序号**（`r0`/`r1`…，见 `outline-model`），它只保证
 *   "同一棵树内稳定"。换文件 / 树变了之后同一串 id 指向的是别的行，沿用旧折叠集
 *   就会折掉新文件里毫不相干的一支。所以折叠集绑定在 `state.shape`（路径 + 行序键）
 *   上，形一变**当帧即视为空集**，不用等 effect 才纠偏。
 * - **只折有子节点的行**：叶子行折了什么都不变，这种 id 进集合等于一份看不见的脏状态；
 *   渲染侧与菜单侧都先问 `outlineHasChildren`。
 *
 * ## 样式（批次十一 L11 收编）
 *
 * 住 `../outline-panel.css`（此前整片内联硬编码 `fontSize: 12` / px padding / 12px 每级
 * 缩进，绕开类系统与 token）。行密度取文件树同一档（22px 行高 / 缩进步进同值口径），
 * 颜色一律 token；组件里只剩"第几级"这一个**无单位数字**（`--outline-depth`），
 * 像素步进算式在 CSS。悬停高亮改由 CSS `:hover` 承担——不再为"鼠标在哪一行"起一份
 * React state（旧 `hoverId` 每移一行就重渲一次，且与 `:hover` 是同一件事的两份真源）；
 * 当前行以 `is-active` 类挂进行容器，折叠指示 / 占位 / 回执条同理全部走类。
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
  /** 文档形态（路径 + 行序键）：折叠状态的归属标记，形一变折叠集即作废 */
  readonly shape: string;
}

const EMPTY_STATE: OutlineViewState = {
  path: null,
  symbols: null,
  rows: [],
  activeIndex: -1,
  notice: null,
  key: '',
  shape: '',
};

/** 空折叠集（模块级常量：复位时引用恒定，比较与"没折过"是同一种东西） */
const NO_COLLAPSED: ReadonlySet<string> = new Set<string>();

interface OutlineFoldState {
  /** 这份折叠集属于哪一"形"的文档；与当帧 `shape` 不符 ⇒ 视为空集（换文档即复位） */
  readonly shape: string;
  /** 已折叠的行 id（**只含有子节点的行**） */
  readonly collapsed: ReadonlySet<string>;
}

/** 初始折叠集：形状键先占一个不可能出现的空串，第一份文档就算"形不对"⇒ 空集 */
const EMPTY_FOLD: OutlineFoldState = { shape: '', collapsed: NO_COLLAPSED };

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
  /**
   * 折叠集 + 它属于哪一"形"的文档（见文件头「折叠」三条边界）。
   *
   * 存成一条 state 而不是 `useEffect` 复位：复位要在**当帧**生效——等 effect 补一刀，
   * 换文件后的第一帧就会用旧 id 折掉新文件的行，那一瞬间是真错，不是过渡。
   */
  const [fold, setFold] = useState<OutlineFoldState>(EMPTY_FOLD);

  const refresh = useCallback((): void => {
    const probe = readJumpProbe();
    let next: Omit<OutlineViewState, 'key' | 'shape'>;
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
    const rowsKey = outlineRowsKey(next.rows);
    const key = `${next.path ?? ''}\u0000${next.notice ?? ''}\u0000${next.activeIndex}\u0000${rowsKey}`;
    if (key === lastRef.current.key) return;
    // 形状只认"路径 + 行序"：光标在同一份文档里走动不该把作者的折叠掀开
    const committed: OutlineViewState = { ...next, key, shape: `${next.path ?? ''}\u0000${rowsKey}` };
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

  /**
   * 换文档 ⇒ 折叠集真的清掉（渲染期复位，React 会在提交前重渲这一帧）。
   *
   * 下面那行"当帧视为空集"已经保证换文件后不会用旧 id 折新行；这里再做一次显式复位，
   * 是为了让状态本身也是空的——否则 `A → B → A` 回到同一份文档时，旧折叠会"有时候
   * 又回来了"（取决于中间有没有在新文件里折过）。宁可不恢复，也不要一个说不准的行为。
   */
  if (fold.shape !== '' && fold.shape !== state.shape) setFold({ shape: state.shape, collapsed: NO_COLLAPSED });

  /** 当帧生效的折叠集：形状对不上（换文件 / 树变了）⇒ 空集，不等 effect 纠偏 */
  const collapsed: ReadonlySet<string> = fold.shape === state.shape ? fold.collapsed : NO_COLLAPSED;

  /** 有子节点的行 id 集（叶子行不进折叠集；也决定行上画不画折叠指示） */
  const foldableIds = useMemo(() => new Set(foldableOutlineIds(rows)), [rows]);

  /** 折叠投影：只裁剪"看得见哪些行"，行对象本身原样（缩进 / 行身份 / 跳源都不变） */
  const visibleRows = useMemo(() => visibleOutlineRows(rows, collapsed), [rows, collapsed]);

  /**
   * 折叠 / 展开（菜单与行上的折叠指示共用这一个入口）。
   *
   * 收一串 id：单行折叠传一个，「全部折叠 / 全部展开」传全量——面板这边只有一份
   * Set 写入逻辑，两个入口不会给出两套语义。
   */
  const foldRows = useCallback(
    (ids: readonly string[], folded: boolean): void => {
      setFold((prev) => {
        const base = prev.shape === state.shape ? prev.collapsed : NO_COLLAPSED;
        const next = new Set(base);
        for (const id of ids) {
          if (folded) next.add(id);
          else next.delete(id);
        }
        return { shape: state.shape, collapsed: next };
      });
    },
    [state.shape],
  );

  /** 当前高亮行的 id（`activeIndex` 是全行序里的下标，折叠后可见行序会短一截，按 id 对） */
  const activeId = state.activeIndex >= 0 ? rows[state.activeIndex]?.id ?? null : null;

  /**
   * 菜单侧的行投影（与 DOM 同一序、同一份 `state.rows`）。
   *
   * 复制项的回执走 `notice` 一条**独立**的短命提示行（不抢空态那句：空态是常驻事实，
   * 回执是刚发生的事）。没有剪贴板能力时三个复制项整项不显示（能力不存在就不摆入口）。
   * 行投影给的是**全量行**（折叠只影响画什么，不影响"复制这一支 / 复制整份"搬什么）。
   */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const menuRows = useMemo<readonly OutlineMenuRow[]>(
    () =>
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        detail: row.detail,
        depth: row.depth,
        startLine: row.startLine,
      })),
    [rows],
  );

  useEffect(() => {
    const path = state.path;
    const canCopy =
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
    setOutlineMenuContext({
      canCopy,
      rows: menuRows,
      collapsed,
      handlers: {
        reveal: (row) => {
          if (path !== null) onReveal(path, row.startLine);
        },
        fold: foldRows,
        copy: (text, okText) => {
          const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (!clipboard?.writeText) {
            setFlash('复制失败：当前环境没有剪贴板能力');
          } else {
            void clipboard.writeText(text).then(
              () => setFlash(okText),
              () => setFlash('复制失败：剪贴板拒绝了这次写入'),
            );
          }
          if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
          flashTimerRef.current = window.setTimeout(() => setFlash(null), 1_800);
        },
      },
    });
  });

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      setOutlineMenuContext(null);
    },
    [],
  );

  const body =
    state.notice !== null ? (
      <div data-outline-empty="" className="outline-empty">
        {state.notice}
      </div>
    ) : (
      <div role="tree" aria-label="大纲" className="outline-tree">
        {visibleRows.map((row) => {
          const active = row.id === activeId;
          const name = row.name.length > 0 ? row.name : '（未命名）';
          const title = row.detail !== null ? `${row.name} — ${row.detail}` : row.name;
          const foldable = foldableIds.has(row.id);
          const folded = foldable && collapsed.has(row.id);
          return (
            // 行 = 折叠指示 + 行主体两个**并列**按钮（不嵌套可交互元素：嵌套按钮
            // 在 HTML 里非法，键盘/读屏都会被浏览器重排成另一个东西）。
            // 行身份锚点放在这层容器上：右键戳折叠箭头也仍归这一行（`closest` 找得到）。
            <div
              key={row.id}
              role="none"
              className={active ? 'outline-row is-active' : 'outline-row'}
              {...{ [OUTLINE_ROW_ATTR]: '', [OUTLINE_ROW_ID_ATTR]: row.id }}
              // 缩进只递"第几级"这一个无单位数字，像素步进与档位都在 outline-panel.css 里
              style={{ '--outline-depth': row.depth } as CSSProperties}
            >
              {foldable ? (
                <button
                  type="button"
                  data-outline-fold=""
                  className="outline-row__fold"
                  aria-expanded={!folded}
                  aria-label={`${folded ? '展开' : '折叠'} ${name}`}
                  title={folded ? '展开这一支' : '折叠这一支'}
                  // 折叠指示是**独立 hit target**：点击只折/展，不跳源
                  onClick={(event) => {
                    event.stopPropagation();
                    foldRows([row.id], !folded);
                  }}
                >
                  {folded ? '▸' : '▾'}
                </button>
              ) : (
                // 叶子行留同宽占位：名字不会因为"有没有子节点"而左右跳
                <span aria-hidden="true" className="outline-row__fold outline-row__fold--leaf" />
              )}
              <button
                ref={active ? activeRowRef : null}
                type="button"
                role="treeitem"
                className="outline-row__body"
                aria-level={row.depth + 1}
                aria-selected={active}
                aria-expanded={foldable ? !folded : undefined}
                title={title}
                onClick={() => {
                  if (state.path !== null) onReveal(state.path, row.startLine);
                }}
              >
                <span className="outline-row__icon">
                  <Icon name={iconForKind(row.kind)} size={14} />
                </span>
                <span className="outline-row__name">{name}</span>
                {row.detail !== null ? <span className="outline-row__detail">{row.detail}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
    );

  return (
    <div data-context-surface="outline" className="outline-panel">
      {body}
      {/* 复制回执（菜单动作的唯一可见反馈）：与空态那句分开——一个是常驻事实，一个是刚发生的事 */}
      {flash !== null ? (
        <div role="status" data-outline-flash="" className="outline-flash">
          {flash}
        </div>
      ) : null}
    </div>
  );
}
