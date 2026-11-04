/**
 * 数值看板**呈现层**（纯组件：props 进、元素树出；零状态、零副作用）。
 *
 * 分层纪律与 `ui-state-replay` 的 `DebugPreviewPanel` 同款——状态与数据获取全在
 * 壳层（`index.ts` 的面板组件），这里只画。因此元素树可以被直接断言（单测不引
 * react-dom，本包只把 react 当 peerDep）。
 *
 * 视觉：全部颜色 / 间距 / 字号走 token（`--surface-*` / `--fg*` / `--space-*` /
 * `--fs-*` / `--radius-*`），五套主题同名覆写即生效；不引游戏名词。
 */

import { createElement, Fragment, type ReactElement } from 'react';
import type {
  SnippetItem,
  FamilyRow,
  FnUsageItem,
  IndexStats,
  InstrRow,
  PackSummary,
  SymbolRow,
  VarEntryRow,
  VarUsageAnswer,
  VarUsageItem,
} from './panel-logic';
import { refKindLabel, sourceLabel } from './panel-logic';

/** 看板三张页签 */
export type LookerTab = 'vars' | 'symbols' | 'instr';

const TABS: readonly { id: LookerTab; label: string }[] = [
  { id: 'vars', label: '变量字典' },
  { id: 'symbols', label: '项目符号' },
  { id: 'instr', label: '指令速查' },
];

export interface ValueLookerViewProps {
  readonly activeTab: LookerTab;
  readonly onTab: (tab: LookerTab) => void;

  /* ---- 头部状态 ---- */
  /** 游戏版本徽章（如 '4.980'；null = 不显示） */
  readonly gameVersion: string | null;
  /** 头部副句（族数 / 名录数等；null = 不显示） */
  readonly headNote: string | null;
  /** 操作回执（复制成功 / 失败原因；null = 无） */
  readonly notice: string | null;
  /** 词典装载警示（`dictionary.loaded === false` 时的一句话；null = 无事） */
  readonly dictWarn: string | null;
  /** 索引读数（项目符号页空态用；null = 索引未就绪） */
  readonly stats: IndexStats | null;
  /** 整板级空态理由（没有项目 / 没有适配器时，正文区整块显示这句） */
  readonly emptyReason: string | null;

  /* ---- 变量字典页 ---- */
  readonly familyRows: readonly FamilyRow[];
  readonly familyQuery: string;
  readonly onFamilyQuery: (q: string) => void;
  readonly selectedFamily: string | null;
  readonly onSelectFamily: (id: string) => void;
  readonly entryRows: readonly VarEntryRow[];
  readonly entryQuery: string;
  readonly onEntryQuery: (q: string) => void;
  readonly entryLimit: number;
  readonly onGrowEntries: () => void;
  readonly selectedEntry: VarEntryRow | null;
  readonly onSelectEntry: (e: VarEntryRow) => void;

  /* ---- 详情卡（选中条目时渲染） ---- */
  readonly snippets: readonly SnippetItem[];
  readonly onCopy: (text: string) => void;
  readonly usage: VarUsageAnswer | null;
  /** 反查索引慢路径在建（首次点选后的全库条件索引遍历）：详情卡给一句进度话 */
  readonly usageBuilding: boolean;
  readonly usageLimit: number;
  readonly onGrowUsage: () => void;
  readonly onJumpUsage: (u: VarUsageItem) => void;

  /* ---- 项目符号页 ---- */
  readonly packs: readonly PackSummary[];
  readonly selectedPack: string | null;
  readonly onSelectPack: (key: string | null) => void;
  readonly symbolKind: 'fn' | 'dim';
  readonly onSymbolKind: (k: 'fn' | 'dim') => void;
  readonly symbolQuery: string;
  readonly onSymbolQuery: (q: string) => void;
  readonly symbolRows: readonly SymbolRow[];
  readonly symbolLimit: number;
  readonly onGrowSymbols: () => void;
  readonly onJumpSymbol: (s: SymbolRow) => void;

  /* ---- 指令速查页 ---- */
  readonly instrRows: readonly InstrRow[];
  readonly instrQuery: string;
  readonly onInstrQuery: (q: string) => void;
  readonly instrLimit: number;
  readonly onGrowInstr: () => void;
  readonly onCopyInstr: (row: InstrRow) => void;
}

/** 「显示更多」哨兵行（触底自动加载 + 显式按钮双通道，与回放面板同款） */
function MoreRow(props: { label: string; onMore: () => void }): ReactElement {
  const { label, onMore } = props;
  return createElement(
    'button',
    { className: 'vl-more', type: 'button', onClick: onMore },
    `${label}（点此或继续滚动加载）`,
  );
}

/** 头部：标题 + 版本徽章 + 副句 + 词典警示 + 操作回执 */
function Head(props: {
  gameVersion: string | null;
  headNote: string | null;
  dictWarn: string | null;
  notice: string | null;
}): ReactElement {
  const { gameVersion, headNote, dictWarn, notice } = props;
  return createElement(
    'div',
    { className: 'vl-head' },
    createElement(
      'div',
      { className: 'vl-head-row' },
      createElement('span', { className: 'vl-head-title' }, '数值看板'),
      gameVersion
        ? createElement('span', { className: 'vl-badge vl-badge-version', title: '当前游戏版本' }, gameVersion)
        : null,
    ),
    headNote ? createElement('div', { className: 'vl-head-note' }, headNote) : null,
    dictWarn ? createElement('div', { className: 'vl-dict-warn' }, dictWarn) : null,
    notice ? createElement('div', { className: 'vl-notice', role: 'status' }, notice) : null,
  );
}

/** 页签条（segmented） */
function TabBar(props: { active: LookerTab; onTab: (t: LookerTab) => void; instrCount: number }): ReactElement {
  const { active, onTab, instrCount } = props;
  return createElement(
    'div',
    { className: 'vl-tabs', role: 'tablist', 'aria-label': '数值看板页签' },
    TABS.map((t) =>
      createElement(
        'button',
        {
          key: t.id,
          type: 'button',
          role: 'tab',
          'aria-selected': active === t.id ? 'true' : 'false',
          className: `vl-tab${active === t.id ? ' is-active' : ''}`,
          onClick: () => onTab(t.id),
        },
        t.label,
        t.id === 'instr' && instrCount > 0
          ? createElement('span', { className: 'vl-tab-count' }, String(instrCount))
          : null,
      ),
    ),
  );
}

/** 族列表行 */
function FamilyItem(props: { row: FamilyRow; selected: boolean; onSelect: (id: string) => void }): ReactElement {
  const { row, selected, onSelect } = props;
  return createElement(
    'button',
    {
      type: 'button',
      className: `vl-fam${selected ? ' is-active' : ''}`,
      'aria-pressed': selected ? 'true' : 'false',
      onClick: () => onSelect(row.id),
      title: `${row.label}（${row.count} 条）`,
    },
    createElement('span', { className: 'vl-fam-id' }, row.id),
    createElement('span', { className: 'vl-fam-label' }, row.label),
    createElement('span', { className: 'vl-fam-count' }, String(row.count)),
  );
}

/** 条目行 */
function EntryItem(props: {
  row: VarEntryRow;
  selected: boolean;
  onSelect: (e: VarEntryRow) => void;
}): ReactElement {
  const { row, selected, onSelect } = props;
  return createElement(
    'button',
    {
      type: 'button',
      className: `vl-entry${selected ? ' is-active' : ''}`,
      'aria-pressed': selected ? 'true' : 'false',
      onClick: () => onSelect(row),
    },
    createElement('span', { className: 'vl-entry-idx' }, String(row.index)),
    createElement(
      'span',
      { className: 'vl-entry-main' },
      createElement('span', { className: 'vl-entry-name' }, row.name),
      row.desc && row.desc !== row.name
        ? createElement('span', { className: 'vl-entry-desc' }, row.desc)
        : null,
    ),
    row.source && row.source !== 'primary'
      ? createElement('span', { className: `vl-badge vl-src-${row.source}` }, sourceLabel(row.source))
      : null,
  );
}

/** 详情卡：选中条目的引用片段 + 反查 */
function DetailCard(props: {
  entry: VarEntryRow;
  snippets: readonly SnippetItem[];
  onCopy: (text: string) => void;
  usage: VarUsageAnswer | null;
  usageBuilding: boolean;
  usageLimit: number;
  onGrowUsage: () => void;
  onJumpUsage: (u: VarUsageItem) => void;
}): ReactElement {
  const { entry, snippets, onCopy, usage, usageBuilding, usageLimit, onGrowUsage, onJumpUsage } = props;
  const shownUsage = usage ? usage.exact.slice(0, usageLimit) : [];
  return createElement(
    'div',
    { className: 'vl-detail' },
    createElement(
      'div',
      { className: 'vl-detail-title' },
      createElement('span', { className: 'vl-detail-key' }, `${entry.family}:${entry.index}`),
      entry.desc ? createElement('span', { className: 'vl-detail-desc' }, entry.desc) : null,
    ),
    snippets.length > 0
      ? createElement(
          'div',
          { className: 'vl-snips', role: 'group', 'aria-label': '复制引用片段' },
          snippets.map((s) =>
            createElement(
              'button',
              {
                key: s.text,
                type: 'button',
                className: 'vl-snip',
                title: `点击复制：${s.text}`,
                onClick: () => onCopy(s.text),
              },
              createElement('span', { className: 'vl-snip-label' }, s.label),
              createElement('code', { className: 'vl-snip-text' }, s.text),
            ),
          ),
        )
      : null,
    usage
      ? createElement(
          'div',
          { className: 'vl-usage' },
          createElement(
            'div',
            { className: 'vl-usage-head' },
            usage.exact.length > 0
              ? `${usage.exact.length} 处使用（${new Set(usage.exact.map((u) => u.fn)).size} 个函数）`
              : usage.familyTotal > 0
                ? `这个键暂时没有精确命中；整个 ${entry.family} 族共有 ${usage.familyTotal} 处使用`
                : '条件索引里还没见到它的使用',
          ),
          usageBuilding
            ? createElement('div', { className: 'vl-usage-building' }, '正在统计全项目使用点…（首次点选建一次索引，之后走缓存）')
            : null,
          shownUsage.map((u, i) =>
            createElement(
              'button',
              {
                key: `${u.fn}:${u.key}:${i}`,
                type: 'button',
                className: 'vl-usage-row',
                title: u.line !== undefined ? `跳到 ${u.fn} 第 ${u.line} 行` : `打开 ${u.fn}`,
                onClick: () => onJumpUsage(u),
              },
              createElement('span', { className: 'vl-usage-fn' }, u.fn),
              u.line !== undefined ? createElement('span', { className: 'vl-usage-line' }, `:${u.line}`) : null,
              createElement('span', { className: 'vl-usage-key' }, u.key),
              u.count > 1 ? createElement('span', { className: 'vl-usage-count' }, `×${u.count}`) : null,
            ),
          ),
          usage.exact.length > usageLimit
            ? createElement(MoreRow, {
                key: 'more-usage',
                label: `显示更多使用点（还有 ${usage.exact.length - usageLimit} 处）`,
                onMore: onGrowUsage,
              })
            : null,
        )
      : null,
  );
}

/** 符号行（函数 / #DIM） */
function SymbolItem(props: { row: SymbolRow; onJump: (s: SymbolRow) => void }): ReactElement {
  const { row, onJump } = props;
  return createElement(
    'button',
    {
      type: 'button',
      className: `vl-sym${row.inLibrary ? ' is-library' : ''}`,
      title: `${row.filePath}:${row.line}`,
      onClick: () => onJump(row),
    },
    createElement(
      'span',
      { className: 'vl-sym-main' },
      createElement('span', { className: 'vl-sym-name' }, row.name),
      row.kind === 'fn' && row.params !== undefined && row.params > 0
        ? createElement('span', { className: 'vl-sym-params' }, `(${row.params})`)
        : null,
      row.kind === 'dim' && row.directive
        ? createElement('span', { className: 'vl-badge vl-dim-directive' }, row.directive)
        : null,
      row.doc ? createElement('span', { className: 'vl-sym-doc' }, row.doc) : null,
    ),
    createElement('span', { className: 'vl-sym-loc' }, `${row.line}`),
  );
}

/** 指令行 */
function InstrItem(props: { row: InstrRow; onCopy: (r: InstrRow) => void }): ReactElement {
  const { row, onCopy } = props;
  return createElement(
    'button',
    {
      type: 'button',
      className: 'vl-instr',
      title: `点击复制：${row.name}（编号 ${row.no}）`,
      onClick: () => onCopy(row),
    },
    createElement('span', { className: 'vl-instr-no' }, String(row.no)),
    createElement('span', { className: 'vl-instr-name' }, row.name),
  );
}

/** 空态（一句白话 + 可选副句） */
function Empty(props: { text: string; sub?: string }): ReactElement {
  const { text, sub } = props;
  return createElement(
    'div',
    { className: 'vl-empty' },
    createElement('div', { className: 'vl-empty-text' }, text),
    sub ? createElement('div', { className: 'vl-empty-sub' }, sub) : null,
  );
}

/** 主组件：按 props 画整板 */
export function ValueLookerView(props: ValueLookerViewProps): ReactElement {
  const {
    activeTab,
    onTab,
    gameVersion,
    headNote,
    notice,
    dictWarn,
    stats,
    emptyReason,
    familyRows,
    familyQuery,
    onFamilyQuery,
    selectedFamily,
    onSelectFamily,
    entryRows,
    entryQuery,
    onEntryQuery,
    entryLimit,
    onGrowEntries,
    selectedEntry,
    onSelectEntry,
    snippets,
    onCopy,
    usage,
    usageBuilding,
    usageLimit,
    onGrowUsage,
    onJumpUsage,
    packs,
    selectedPack,
    onSelectPack,
    symbolKind,
    onSymbolKind,
    symbolQuery,
    onSymbolQuery,
    symbolRows,
    symbolLimit,
    onGrowSymbols,
    onJumpSymbol,
    instrRows,
    instrQuery,
    onInstrQuery,
    instrLimit,
    onGrowInstr,
    onCopyInstr,
  } = props;

  if (emptyReason) {
    return createElement(
      'div',
      { className: 'panel-value-looker' },
      Head({ gameVersion, headNote, dictWarn, notice }),
      TabBar({ active: activeTab, onTab, instrCount: instrRows.length }),
      Empty({ text: emptyReason }),
    );
  }

  /* ---- 变量字典页 ---- */
  const varsBody = createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'vl-vars' },
      createElement(
        'div',
        { className: 'vl-fams', role: 'list', 'aria-label': '变量族' },
        createElement(
          'div',
          { className: 'vl-search vl-search-slim' },
          createElement('input', {
            className: 'vl-input',
            type: 'search',
            placeholder: '搜族（如 标志 / FLAG）',
            value: familyQuery,
            'aria-label': '搜索变量族',
            onInput: (e: { currentTarget: { value: string } }) => onFamilyQuery(e.currentTarget.value),
          }),
        ),
        familyRows.length === 0
          ? createElement(
              'div',
              { className: 'vl-list' },
              Empty({ text: '当前游戏没有可枚举的变量名称表', sub: '变量字典由游戏数据驱动；没有名称表就没有可列的名字' }),
            )
          : createElement(
              'div',
              { className: 'vl-list' },
              familyRows.map((f) =>
                createElement(FamilyItem, {
                  key: f.id,
                  row: f,
                  selected: selectedFamily === f.id,
                  onSelect: onSelectFamily,
                }),
              ),
            ),
      ),
      createElement(
        'div',
        { className: 'vl-entries' },
        createElement(
          'div',
          { className: 'vl-search' },
          createElement('input', {
            className: 'vl-input',
            type: 'search',
            placeholder: selectedFamily
              ? `在 ${selectedFamily} 里搜（名字 / 编号 / 说明）`
              : '先选一个变量族，再搜条目',
            value: entryQuery,
            'aria-label': '搜索变量条目',
            onInput: (e: { currentTarget: { value: string } }) => onEntryQuery(e.currentTarget.value),
          }),
        ),
        entryRows.length === 0
          ? createElement(
              'div',
              { className: 'vl-list' },
              Empty({
                text: selectedFamily ? '这个族没有匹配的条目' : '左侧选一个变量族开始浏览',
              }),
            )
          : createElement(
              'div',
              { className: 'vl-list' },
              entryRows.slice(0, entryLimit).map((e) =>
                createElement(EntryItem, {
                  key: `${e.family}:${String(e.index)}`,
                  row: e,
                  selected:
                    selectedEntry !== null &&
                    selectedEntry.family === e.family &&
                    String(selectedEntry.index) === String(e.index),
                  onSelect: onSelectEntry,
                }),
              ),
              entryRows.length > entryLimit
                ? createElement(MoreRow, {
                    key: 'more-entries',
                    label: `显示更多（还有 ${entryRows.length - entryLimit} 条）`,
                    onMore: onGrowEntries,
                  })
                : null,
            ),
      ),
    ),
    selectedEntry
      ? DetailCard({ entry: selectedEntry, snippets, onCopy, usage, usageBuilding, usageLimit, onGrowUsage, onJumpUsage })
      : null,
  );

  /* ---- 项目符号页 ---- */
  const symbolsBody = createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'vl-toolbar' },
      createElement('input', {
        className: 'vl-input vl-input-grow',
        type: 'search',
        placeholder: '搜函数名 / 注释 / 文件',
        value: symbolQuery,
        'aria-label': '搜索项目符号',
        onInput: (e: { currentTarget: { value: string } }) => onSymbolQuery(e.currentTarget.value),
      }),
      createElement(
        'select',
        {
          className: 'vl-select',
          value: selectedPack ?? '',
          'aria-label': '选择口上包作用域',
          onChange: (e: { currentTarget: { value: string } }) =>
            onSelectPack(e.currentTarget.value === '' ? null : e.currentTarget.value),
        },
        createElement('option', { value: '' }, '全部口上包'),
        packs.map((p) => createElement('option', { key: p.key, value: p.key }, `${p.label}（${p.fileCount} 文件）`)),
      ),
      createElement(
        'div',
        { className: 'vl-seg', role: 'group', 'aria-label': '符号类型' },
        createElement(
          'button',
          {
            type: 'button',
            className: `vl-seg-btn${symbolKind === 'fn' ? ' is-active' : ''}`,
            'aria-pressed': symbolKind === 'fn' ? 'true' : 'false',
            onClick: () => onSymbolKind('fn'),
          },
          '函数',
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: `vl-seg-btn${symbolKind === 'dim' ? ' is-active' : ''}`,
            'aria-pressed': symbolKind === 'dim' ? 'true' : 'false',
            onClick: () => onSymbolKind('dim'),
          },
          '声明',
        ),
      ),
    ),
    symbolRows.length === 0
      ? createElement(
          'div',
          { className: 'vl-list' },
          Empty({
            text:
              symbolQuery.trim().length > 0
                ? '没有匹配的符号'
                : symbolKind === 'fn'
                  ? selectedPack
                    ? '这个口上包暂无函数'
                    : stats
                      ? `输入关键字搜索全部 ${stats.functions} 个函数，或选一个口上包浏览`
                      : '函数索引还没就绪，稍等片刻会自动出现'
                  : selectedPack
                    ? '这个口上包暂无声明'
                    : stats
                      ? `输入关键字搜索全部 ${stats.dims} 条 #DIM 声明（含 .ERH 全局声明）`
                      : '索引还没就绪',
          }),
        )
      : createElement(
          'div',
          { className: 'vl-list' },
          symbolRows.slice(0, symbolLimit).map((s, i) =>
            createElement(SymbolItem, {
              key: `${s.filePath}:${s.line}:${s.name}:${i}`,
              row: s,
              onJump: onJumpSymbol,
            }),
          ),
          symbolRows.length > symbolLimit
            ? createElement(MoreRow, {
                key: 'more-symbols',
                label: `显示更多（还有 ${symbolRows.length - symbolLimit} 条）`,
                onMore: onGrowSymbols,
              })
            : null,
        ),
  );

  /* ---- 指令速查页 ---- */
  const instrBody = createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'vl-toolbar' },
      createElement('input', {
        className: 'vl-input vl-input-grow',
        type: 'search',
        placeholder: '搜指令（中文名 / 编号）',
        value: instrQuery,
        'aria-label': '搜索指令',
        onInput: (e: { currentTarget: { value: string } }) => onInstrQuery(e.currentTarget.value),
      }),
    ),
    instrRows.length === 0
      ? createElement(
          'div',
          { className: 'vl-list' },
          Empty({
            text: instrQuery.trim().length > 0 ? '没有匹配的指令' : '当前游戏没有提供指令名称表',
            sub: instrQuery.trim().length > 0 ? undefined : '指令表由适配器按游戏数据提供；没有表就不显示这一页的内容',
          }),
        )
      : createElement(
          'div',
          { className: 'vl-list' },
          instrRows.slice(0, instrLimit).map((r) =>
            createElement(InstrItem, { key: `${r.no}:${r.name}`, row: r, onCopy: onCopyInstr }),
          ),
          instrRows.length > instrLimit
            ? createElement(MoreRow, {
                key: 'more-instr',
                label: `显示更多（还有 ${instrRows.length - instrLimit} 条）`,
                onMore: onGrowInstr,
              })
            : null,
        ),
  );

  return createElement(
    'div',
    { className: 'panel-value-looker' },
    Head({ gameVersion, headNote, dictWarn, notice }),
    TabBar({ active: activeTab, onTab, instrCount: instrRows.length }),
    createElement(
      'div',
      { className: 'vl-body' },
      activeTab === 'vars' ? varsBody : null,
      activeTab === 'symbols' ? symbolsBody : null,
      activeTab === 'instr' ? instrBody : null,
    ),
  );
}

/** 引用种类显示（供壳层复用，避免 view 内部再解释） */
export function usageKindLabel(kind: string): string {
  return refKindLabel(kind);
}

/** 函数反查行（壳层把 ErbReference 映射成 FnUsageItem 后由本视图画） */
export function FnUsageList(props: {
  rows: readonly FnUsageItem[];
  onJump: (u: FnUsageItem) => void;
}): ReactElement {
  const { rows, onJump } = props;
  return createElement(
    'div',
    { className: 'vl-usage' },
    rows.map((u, i) =>
      createElement(
        'button',
        {
          key: `${u.filePath}:${u.line}:${u.column}:${i}`,
          type: 'button',
          className: 'vl-usage-row',
          title: `跳到第 ${u.line} 行`,
          onClick: () => onJump(u),
        },
        createElement('span', { className: 'vl-usage-fn' }, u.filePath),
        createElement('span', { className: 'vl-usage-line' }, `:${u.line}`),
        createElement('span', { className: 'vl-usage-key' }, usageKindLabel(u.kind)),
      ),
    ),
  );
}
