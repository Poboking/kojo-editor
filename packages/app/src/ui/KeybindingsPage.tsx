import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { chordFromEvent, type CommandEntry } from './commands';
import {
  buildKeybindingRows,
  chordToBinding,
  filterKeybindingRows,
  isKeybindingRowModified,
  keybindingChips,
  overrideCount,
  resetAllKeybindings,
  setKeybindingOverride,
  useKeybindingsVersion,
  type KeybindingRow,
} from './keybindings';
import { isComposingEvent, nextRovingIndex } from './shell-keys';
import { monacoBuiltinRows } from './monaco-builtin-keybindings';
import { Icon } from './icons';
import { KitKbd } from '../ui-kit';
import { isFailureNote, useMenuNote } from './context-menu-pages';
// 快捷键面（`keybindings`）的数据面与设置面同住 `settings-menu.ts`（本页由 SettingsPanel
// 静态引入，同属那枚懒 chunk）——键位表与撞键判据只在设置浮层里才有用。
import { keybindingMenuStateOf, registerKeybindingsMenuBridge } from './settings-menu';
import './context-menu-pages.css';
// L17 视觉切片：只覆盖 `.kb-page` 子树内的既有 `.kb-*` 规则（双类选择器压过 styles-project 基线，
// 基线里的 `.kb-*` 行一条不搬——styles-split 等价性闸钉着）。
import '../keybindings.css';

/**
 * 快捷键设置页（b/kbset/1017 批次）——设置浮层「快捷键」一节的本体。
 *
 * 版式借参考图（搜索框 / 全部恢复默认 / 命令·按键绑定·操作 三列 / kbd 芯片 / 行尾图标钮），
 * 文案一律走本仓作者面口径（去黑话，见下）。**本页不含任何键位判据**：行数据、搜索、
 * 芯片分段、撞键互指、改键/解绑/复原的落库全部住在 `keybindings.ts`，这里只排版与接线。
 *
 * 房规落点：
 * - **不给一个点了没反应的控件** —— 计数为 0 的范围档、无覆盖时的「全部恢复默认」、
 *   不可改键行的操作格，一律**不渲染**（不是灰着）。
 * - **改键即刻生效** —— 覆盖表一变（`useKeybindingsVersion`）整页重算，命令表由壳层同步重建。
 * - **撞键不静默** —— 撞键行就地长一行语义色（`--warning`）提示，图标 + 「撞键」字样
 *   与颜色同时在场，指名对方命令（铁律 4）。
 * - **键盘可达** —— 行 roving tabindex、↑↓ 漫游、Enter 改键、Delete 解绑，漫游判据复用
 *   `nextRovingIndex`（与导航栏同一套，不写第二份）。
 * - **键位只有一副面孔**（视觉批十一 L17）—— 组合键一律经 `ui-kit` 的 `KitKbd` 呈现；
 *   行内动作钮静息隐去、hover/focus（及撞键行）才亮；分组标题吸顶并带每节计数，
 *   搜索命中给「N / M 条」读数。样式覆盖全部住 `keybindings.css` 切片，基线 `.kb-*` 不搬。
 */

/** 范围三档：全部 / 已被作者改过（含解绑）/ 撞键 */
type Scope = 'all' | 'changed' | 'conflict';

/** 键盘序列的中文读法（芯片之间的 dim 间隔符，非 emoji） */
const CHIP_SEP = '·';

/**
 * 「已改」判据不住在这里：它是 `keybindings.ts` 的 `isKeybindingRowModified`
 * （行数据 `state` 的真源是那张覆盖表，`bindingStateOf` 与设置索引
 * `settingsEntryModified` 同吃它）。页面与右键菜单两个消费面同吃那一枚谓词——
 * 判据若在本页再写一遍，就是「同一页两个真相」的起点，静态闸当场红。
 */

/**
 * 一行命令的按键芯片：一步一片，键帽视觉整体交给 `KitKbd`（字号/边框/间距全站一副面孔）。
 * 外层的 `kb-chip` span 只做**判据锚位**（逐行芯片计数的既有口径挂在它上面），
 * 在 `keybindings.css` 里被收成 `display: contents` —— 它自己不画任何东西。
 */
function KeyChips({ row }: { row: KeybindingRow }): ReactElement {
  const steps = row.keys === undefined ? [] : keybindingChips(row.keys);
  if (steps.length === 0) {
    // 无键位（或非法串）：画一个 dim 的破折号，绝不留空白（空白读成"漏了"）
    return (
      <span className="kb-dash" aria-hidden="true">
        —
      </span>
    );
  }
  return (
    <>
      {steps.map((keys, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span className="kb-chip-sep" aria-hidden="true">
              {CHIP_SEP}
            </span>
          ) : null}
          <span className="kb-chip">
            <KitKbd combo={keys.join('+')} />
          </span>
        </Fragment>
      ))}
    </>
  );
}

export function KeybindingsPage({ commands }: { commands: readonly CommandEntry[] }): ReactElement {
  // 覆盖表一变即重渲染（改键 / 解绑 / 复原 / 全部恢复默认都经此回环）
  const kbVersion = useKeybindingsVersion();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /** 刚落定的那一行：芯片做一次 scale-in 微入场（动效可关） */
  const [flashId, setFlashId] = useState<string | null>(null);
  /** 「全部恢复默认」的就地回执（role=status，不抢焦点） */
  const [resetNote, setResetNote] = useState<string | null>(null);
  /** 右键菜单动作的回执（复制命令 ID / 重置 / 移除键位；到时自动收起） */
  const [menuNote, setMenuNote] = useMenuNote();

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const rows = useMemo(
    // 1020 编辑器体感批：补一组「Monaco 内建（只读）」行——那些能力随 contrib 早已装好，
    // 只是不在宿主注册表里，此前作者在键位页上看不见它们。内建行恒为 `state:'default'`
    // 且 `conflictWith:null` ⇒ 「已改」「撞键」两个范围档天然不含它们，不改既有口径。
    () => [...buildKeybindingRows(commands), ...monacoBuiltinRows()],
    [commands, kbVersion],
  );

  const changedCount = useMemo(() => rows.filter(isKeybindingRowModified).length, [rows]);
  const conflictCount = useMemo(() => rows.filter((r) => r.conflictWith !== null).length, [rows]);
  const overrides = overrideCount();

  // 范围档先切、搜索后滤：`scoped` 是"这一档一共多少条"，`visible` 是"搜索命中多少条"，
  // 读数「N / M 条」正是拿这两个数拼出来的（M 不含搜索、N 含搜索）。
  const scoped = useMemo(() => {
    if (scope === 'changed') return rows.filter(isKeybindingRowModified);
    if (scope === 'conflict') return rows.filter((r) => r.conflictWith !== null);
    return rows;
  }, [rows, scope]);
  const visible = useMemo(() => filterKeybindingRows(scoped, query), [scoped, query]);

  // 当前焦点行夹取到可见范围（过滤后行数变少时不悬空）
  const focusIndex = visible.length === 0 ? -1 : Math.min(activeIndex, visible.length - 1);

  /* ------------------- 右键菜单接线（1023 覆盖面批 · 快捷键页） ------------------- */
  // 面（`keybindings`）在 `settings-menu.ts` 模块顶层登记；这里只交接线桥：
  // 行读数已由 `buildKeybindingRows` 算好，菜单不重算撞键；改键仍走覆盖表既有 API。
  useEffect(() => {
    registerKeybindingsMenuBridge({
      rowOf: (id) => {
        const row = rows.find((r) => r.id === id);
        return row === undefined ? undefined : keybindingMenuStateOf(row);
      },
      conflictCount: () => conflictCount,
      // 「查看同键位冲突」复用页面上那枚「撞键」范围档，不另造一条过滤
      onlyConflicts: () => {
        setQuery('');
        setScope('conflict');
      },
      note: (line) => setMenuNote(line),
    });
    return () => registerKeybindingsMenuBridge(null);
  }, [rows, conflictCount, setMenuNote]);

  /* --------------------------- 捕获改键（window 捕获阶段） --------------------------- */
  // 焦点可能还在导航栏或搜索框上，挂容器会漏键 ⇒ 挂 window 的**捕获阶段**，
  // 吃掉的键一律 preventDefault + stopPropagation，否则会穿到壳层的全局命令分发。
  useEffect(() => {
    if (capturingId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isComposingEvent(e, false)) return; // 输入法合成期一律让位
      if (e.key === 'Escape') {
        // 只归还捕获，不许顺手关掉设置浮层
        e.preventDefault();
        e.stopPropagation();
        setCapturingId(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (chord === null) return; // 纯修饰键按下：继续等主键，不取消、不报错
      e.preventDefault();
      e.stopPropagation();
      const id = capturingId;
      if (setKeybindingOverride(id, chordToBinding(chord))) {
        // 撞键提示由重算后的 row.conflictWith 驱动（见渲染），这里只补一次芯片入场
        setFlashId(id);
      }
      setCapturingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [capturingId]);

  // 入场动画放完后清 flash（减弱动效下动画被压平，这里只是把 class 摘掉）
  useEffect(() => {
    if (flashId === null) return;
    const t = setTimeout(() => setFlashId(null), 360);
    return () => clearTimeout(t);
  }, [flashId]);

  const startCapture = useCallback((id: string) => {
    setResetNote(null);
    setCapturingId(id);
  }, []);

  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
    const row = visible[index];
    if (!row) return;
    const next = nextRovingIndex(index, visible.length, e.key);
    if (next !== null) {
      e.preventDefault();
      setActiveIndex(next);
      rowRefs.current[next]?.focus();
      return;
    }
    if (e.key === 'Enter') {
      if (row.rebindable) {
        e.preventDefault();
        startCapture(row.id);
      }
      return;
    }
    if (e.key === 'Delete') {
      if (row.rebindable && row.keys !== undefined) {
        e.preventDefault();
        setResetNote(null);
        setKeybindingOverride(row.id, '');
      }
    }
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && query !== '') {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      searchRef.current?.blur();
    }
  };

  const doResetAll = (): void => {
    const cleared = resetAllKeybindings();
    setCapturingId(null);
    setResetNote(`已恢复 ${cleared} 项为默认`);
  };

  /* ------------------------------- 分组渲染 ------------------------------- */
  // 按分类插分组行（搜索时分组仍成立：只对可见行分组）
  const groups: { category: string; rows: { row: KeybindingRow; index: number }[] }[] = [];
  visible.forEach((row, index) => {
    const label = row.category === '' ? '未分类' : row.category;
    const last = groups[groups.length - 1];
    if (last && last.category === label) last.rows.push({ row, index });
    else groups.push({ category: label, rows: [{ row, index }] });
  });

  return (
    <div className="kb-page" role="region" aria-label="键盘快捷键" data-context-surface="keybindings">
      <p className="kb-intro">
        这里列出编辑器认得的每一条命令和它当前的按键。点按键那一格、再按下新的组合即可改键（Esc 取消）。
        两键序列会分成两片，先按前一片再按后一片。也可用 ↑ ↓ 走位、Enter 改键、Delete 移除键位。
        末尾那组「Monaco 内建」是编辑器本身自带的按键（速览定义、转到行、一次选中相同词等），
        它们已经能用、在这一页只给看不给改；列选择是鼠标手势，在设置的「编辑器」里开。
      </p>

      <div className="kb-toolbar">
        <div className="kb-search">
          <Icon name="search" size="sm" className="kb-search-icon" />
          <input
            ref={searchRef}
            type="search"
            className="kb-search-input"
            placeholder="搜索命令或按键"
            aria-label="搜索命令或按键"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query !== '' ? (
            <button
              type="button"
              className="kb-search-clear"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size="sm" />
            </button>
          ) : null}
        </div>

        <span className="kb-scope theme-segment" role="radiogroup" aria-label="显示范围">
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'all'}
            className={`theme-seg-btn${scope === 'all' ? ' on' : ''}`}
            onClick={() => setScope('all')}
          >
            全部
          </button>
          {changedCount > 0 ? (
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'changed'}
              className={`theme-seg-btn${scope === 'changed' ? ' on' : ''}`}
              onClick={() => setScope('changed')}
            >
              已改 ({changedCount})
            </button>
          ) : null}
          {conflictCount > 0 ? (
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'conflict'}
              className={`theme-seg-btn${scope === 'conflict' ? ' on' : ''}`}
              onClick={() => setScope('conflict')}
            >
              撞键 ({conflictCount})
            </button>
          ) : null}
        </span>

        {overrides > 0 ? (
          <button type="button" className="ghost small kb-resetall" onClick={doResetAll}>
            恢复默认 ({overrides})
          </button>
        ) : null}
      </div>

      <div className="kb-count" role="status">
        {query !== '' ? `${visible.length} / ${scoped.length} 条` : `${visible.length} 条`}
      </div>
      {resetNote !== null ? (
        <div className="kb-resetnote" role="status">
          {resetNote}
        </div>
      ) : null}
      {menuNote !== null ? (
        <div className={`page-menu-note${isFailureNote(menuNote) ? ' is-error' : ''}`} role="status">
          {menuNote}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="kb-empty">
          <div className="kb-empty-title">没有匹配的快捷键</div>
          <div className="kb-empty-hint">
            {scoped.length === 0
              ? '这一节本来就没有条目：切回「全部」看看所有命令。'
              : `这一节有 ${scoped.length} 条，但没有和「${query}」匹配的——换个词，或清空搜索。`}
          </div>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setQuery('');
              setScope('all');
            }}
          >
            清空搜索
          </button>
        </div>
      ) : (
        <div className="kb-table" role="table" aria-label="快捷键列表">
          <div className="kb-head" role="row">
            <span className="kb-th kb-th-cmd" role="columnheader">
              命令
            </span>
            <span className="kb-th kb-th-keys" role="columnheader">
              按键绑定
            </span>
            <span className="kb-th kb-th-act" role="columnheader">
              操作
            </span>
          </div>

          {groups.map((group) => (
            <Fragment key={group.category}>
              <div className="kb-group" role="row">
                <span className="kb-group-label" role="cell">
                  {group.category}
                  {/* 每节计数：搜索时这是"本节命中数"，静息时是"本节条数"（口径同一格读数） */}
                  <span className="kb-group-count">{`${group.rows.length} 条`}</span>
                </span>
              </div>
              {group.rows.map(({ row, index }) => {
                const capturing = capturingId === row.id;
                const conflicted = row.conflictWith !== null;
                const rowClass =
                  'kb-row' +
                  (row.state === 'overridden'
                    ? ' kb-overridden'
                    : row.state === 'unbound'
                      ? ' kb-unbound'
                      : '') +
                  (capturing ? ' kb-capturing' : '') +
                  (conflicted ? ' kb-conflicted' : '') +
                  (flashId === row.id ? ' kb-flashed' : '');
                const showReset = isKeybindingRowModified(row);
                const showRemove = row.keys !== undefined && row.rebindable;
                return (
                  <div
                    key={row.id}
                    data-kb-id={row.id}
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                    className={rowClass}
                    role="row"
                    tabIndex={index === focusIndex ? 0 : -1}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                  >
                    <span className="kb-cell kb-cell-cmd" role="cell">
                      <span className="kb-title">{row.title}</span>
                      {row.note !== null ? <span className="kb-note">{row.note}</span> : null}
                    </span>

                    <span className={`kb-cell kb-cell-keys${row.rebindable ? '' : ' kb-locked'}`} role="cell">
                      {capturing ? (
                        <span className="kb-capture" role="status">
                          按下新键位 · Esc 取消
                        </span>
                      ) : row.rebindable ? (
                        <button
                          type="button"
                          className="kb-keys-btn"
                          aria-label={`修改「${row.title}」的按键`}
                          onClick={() => startCapture(row.id)}
                        >
                          <KeyChips row={row} />
                        </button>
                      ) : (
                        <span className="kb-keys-static">
                          <KeyChips row={row} />
                        </span>
                      )}
                    </span>

                    <span className="kb-cell kb-cell-act" role="cell">
                      {showReset ? (
                        <button
                          type="button"
                          className="kb-icon-btn"
                          aria-label="恢复缺省"
                          title="恢复缺省"
                          onClick={() => {
                            setResetNote(null);
                            setKeybindingOverride(row.id, null);
                          }}
                        >
                          <Icon name="reset" size="sm" />
                        </button>
                      ) : null}
                      {showRemove ? (
                        <button
                          type="button"
                          className="kb-icon-btn kb-icon-btn-danger"
                          aria-label="移除键位"
                          title="移除键位"
                          onClick={() => {
                            setResetNote(null);
                            setKeybindingOverride(row.id, '');
                          }}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      ) : null}
                    </span>

                    {conflicted ? (
                      <span className="kb-conflict" role="cell">
                        {/* 撞键不只靠颜色说话：图标 + 「撞键」字样与琥珀色同时在场
                            （forced-colors / 色觉异常下信息与语义不丢） */}
                        <Icon name="warning" size="xs" className="kb-conflict-icon" />
                        <span>{`撞键：与「${row.conflictWith}」用了同一个按键，两者只会触发排在前面的那一个`}</span>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
