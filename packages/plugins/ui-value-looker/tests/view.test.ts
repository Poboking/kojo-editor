/**
 * 呈现层元素树单测（**刻意不引 react-dom**——本包只把 react 当 peerDep）。
 *
 * 直接对 `createElement` 产物做结构断言：类名定位 + 文本聚合 + 关键 props 在位。
 * 覆盖：整板空态、头部（版本徽章 / 词典警示 / 回执）、页签条、变量字典两栏、
 * 详情卡（引用片段 / 反查使用点 / 显示更多）、项目符号工具条、指令页、
 * 「显示更多」哨兵与触底语义。
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { ValueLookerView, type ValueLookerViewProps } from '../src/looker-view';
import type { FamilyRow, InstrRow, PackSummary, SymbolRow, VarEntryRow } from '../src/panel-logic';

/* ------------------------------ 走树工具 ------------------------------ */

interface Node {
  readonly el: ReactElement;
  readonly className: string;
  readonly text: string;
  readonly children: readonly Node[];
}

function toNodes(input: unknown): Node[] {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input)) return input.flatMap((x) => toNodes(x));
  const el = input as ReactElement;
  const kind = typeof el.type;
  if (kind !== 'string' && kind !== 'symbol' && kind !== 'function') return [];
  const props = (el.props ?? {}) as { className?: unknown; children?: unknown };
  // 函数组件：就地调用展开（本包把 react 当 peerDep，没有 react-dom 替我们渲染）
  const rendered =
    kind === 'function' ? (el.type as (p: unknown) => unknown)(props) : props.children;
  const children = toNodes(rendered);
  const text =
    kind === 'function'
      ? children.map((c) => c.text).join('')
      : typeof props.children === 'string'
        ? props.children
        : children.map((c) => c.text).join('');
  return [
    {
      el,
      className: typeof props.className === 'string' ? props.className : '',
      text,
      children,
    },
  ];
}

function all(node: Node, pred: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (pred(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function findByClass(root: Node, cls: string): Node[] {
  return all(root, (n) => n.className.split(' ').includes(cls));
}

/** 全树文本（拼所有节点文本，含空格归一） */
function fullText(root: Node): string {
  return all(root, () => true)
    .map((n) => n.text)
    .join('');
}

/* ------------------------------ 夹具 ------------------------------ */

const FAMILY_ROWS: FamilyRow[] = [
  { id: 'CFLAG', label: '角色标志', count: 2, charaScoped: true },
  { id: 'FLAG', label: '全局标志', count: 1, charaScoped: false },
];
const ENTRY_ROWS: VarEntryRow[] = [
  { family: 'CFLAG', index: 2, name: '好感甲', desc: '好感甲', resolvedIndex: 2, source: 'primary' },
  { family: 'CFLAG', index: 3, name: '亲密乙', desc: '亲密乙', resolvedIndex: 3, source: 'append' },
];
const PACKS: PackSummary[] = [
  { key: 'K1', label: 'K1', fileCount: 3, functionCount: 0 },
  { key: '', label: '（口上根散文件）', fileCount: 1, functionCount: 0 },
];
const SYMBOL_ROWS: SymbolRow[] = [
  { name: 'CHECK_FEEL', kind: 'fn', filePath: 'D:/g/K1/A.ERB', line: 3, params: 1, doc: '判定好感', inLibrary: false },
];
const INSTR_ROWS: InstrRow[] = [{ no: 7, name: '指令七' }];

function baseProps(over: Partial<ValueLookerViewProps> = {}): ValueLookerViewProps {
  return {
    activeTab: 'vars',
    onTab: () => {},
    gameVersion: '9.99',
    headNote: '2 个变量族 · 3 条名称',
    notice: null,
    dictWarn: null,
    stats: { files: 4, functions: 10, dims: 2 },
    emptyReason: null,
    familyRows: FAMILY_ROWS,
    familyQuery: '',
    onFamilyQuery: () => {},
    selectedFamily: 'CFLAG',
    onSelectFamily: () => {},
    entryRows: ENTRY_ROWS,
    entryQuery: '',
    onEntryQuery: () => {},
    entryLimit: 120,
    onGrowEntries: () => {},
    selectedEntry: null,
    onSelectEntry: () => {},
    snippets: [],
    onCopy: () => {},
    usage: null,
    usageBuilding: false,
    usageLimit: 40,
    onGrowUsage: () => {},
    onJumpUsage: () => {},
    packs: PACKS,
    selectedPack: null,
    onSelectPack: () => {},
    symbolKind: 'fn',
    onSymbolKind: () => {},
    symbolQuery: '',
    onSymbolQuery: () => {},
    symbolRows: [],
    symbolLimit: 120,
    onGrowSymbols: () => {},
    onJumpSymbol: () => {},
    instrRows: [],
    instrQuery: '',
    onInstrQuery: () => {},
    instrLimit: 120,
    onGrowInstr: () => {},
    onCopyInstr: () => {},
    ...over,
  };
}

function render(props: ValueLookerViewProps): Node {
  const out = ValueLookerView(props) as ReactElement;
  const [root] = toNodes([out]);
  return root!;
}

/* ------------------------------ 用例 ------------------------------ */

describe('ValueLookerView', () => {
  it('整板空态：理由 + 页签仍在，正文区没有', () => {
    const root = render(baseProps({ emptyReason: '打开一个项目后，这里就是你的数值速查台。' }));
    expect(fullText(root)).toContain('打开一个项目后');
    expect(findByClass(root, 'vl-body')).toHaveLength(0);
    expect(findByClass(root, 'vl-tab')).toHaveLength(3);
  });

  it('头部：标题 + 版本徽章 + 副句；词典警示按 props 出现', () => {
    const root = render(baseProps());
    expect(findByClass(root, 'vl-head-title')).toHaveLength(1);
    const badge = findByClass(root, 'vl-badge-version');
    expect(badge).toHaveLength(1);
    expect(badge[0]!.text).toBe('9.99');
    expect(fullText(root)).toContain('2 个变量族 · 3 条名称');
    expect(findByClass(root, 'vl-dict-warn')).toHaveLength(0);

    const warned = render(baseProps({ dictWarn: '名词词典不在位——名称按游戏原文显示。' }));
    expect(findByClass(warned, 'vl-dict-warn')).toHaveLength(1);
  });

  it('回执 notice 有 role=status（无障碍通报位）', () => {
    const root = render(baseProps({ notice: '已复制：CFLAG:2' }));
    const n = findByClass(root, 'vl-notice');
    expect(n).toHaveLength(1);
    expect((n[0]!.el.props as { role?: string }).role).toBe('status');
  });

  it('变量字典页：族行与条目行渲染；来源徽章只给非主表', () => {
    const root = render(baseProps());
    const fams = findByClass(root, 'vl-fam');
    expect(fams).toHaveLength(2);
    expect(fams[0]!.text).toContain('CFLAG');
    expect(fams[0]!.text).toContain('角色标志');
    const famOn = findByClass(root, 'vl-fam');
    expect(famOn[0]!.className).toContain('is-active');
    const entries = findByClass(root, 'vl-entry');
    expect(entries).toHaveLength(2);
    // 首条选中态（selectedFamily=CFLAG + selectedEntry=null → 无 is-active）
    expect(entries[0]!.className).not.toContain('is-active');
    const badges = findByClass(root, 'vl-src-append');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.text).toBe('追加表');
  });

  it('详情卡：键名 / 引用片段 / 反查使用点 / 显示更多', () => {
    const entry = ENTRY_ROWS[0]!;
    const root = render(
      baseProps({
        selectedEntry: entry,
        snippets: [
          { label: '编号引用', text: 'CFLAG:2' },
          { label: 'TARGET', text: 'CFLAG:TARGET:2' },
        ],
        usage: {
          exact: [
            { fn: 'FN_A', key: 'CFLAG:2', line: 10, count: 3 },
            { fn: 'FN_B', key: 'CFLAG:2', line: 20, count: 1 },
            { fn: 'FN_C', key: 'CFLAG:2', line: 30, count: 1 },
          ],
          familyTotal: 3,
        },
        usageLimit: 2,
      }),
    );
    expect(findByClass(root, 'vl-detail-key')[0]!.text).toBe('CFLAG:2');
    const snips = findByClass(root, 'vl-snip');
    expect(snips.map((s) => s.text)).toEqual(['编号引用CFLAG:2', 'TARGETCFLAG:TARGET:2']);
    const usageRows = findByClass(root, 'vl-usage-row');
    expect(usageRows).toHaveLength(2);
    const more = findByClass(root, 'vl-more');
    expect(more).toHaveLength(1);
    expect(more[0]!.text).toContain('还有 1 处');
    // 使用行可点击（onJumpUsage 在位）
    const props = usageRows[0]!.el.props as { onClick?: unknown };
    expect(typeof props.onClick).toBe('function');
  });

  it('反查空态：精确无命中但族级有 → 说族级总数，不冒充精确', () => {
    const root = render(
      baseProps({
        selectedEntry: ENTRY_ROWS[0]!,
        snippets: [{ label: '编号引用', text: 'CFLAG:2' }],
        usage: { exact: [], familyTotal: 12 },
      }),
    );
    expect(fullText(root)).toContain('整个 CFLAG 族共有 12 处使用');
  });

  it('项目符号页：包下拉、类型分段、符号行与行号', () => {
    const root = render(
      baseProps({
        activeTab: 'symbols',
        headNote: '10 函数 · 2 声明 · 4 文件',
        symbolRows: SYMBOL_ROWS,
      }),
    );
    const select = findByClass(root, 'vl-select');
    expect(select).toHaveLength(1);
    const options = findByClass(root, 'vl-select')[0]!.children.filter(
      (c) => (c.el.type as string) === 'option',
    );
    expect(options.map((o) => o.text)).toEqual(['全部口上包', 'K1（3 文件）', '（口上根散文件）（1 文件）']);
    const segs = findByClass(root, 'vl-seg-btn');
    expect(segs.map((s) => s.text)).toEqual(['函数', '声明']);
    expect(segs[0]!.className).toContain('is-active');
    const sym = findByClass(root, 'vl-sym');
    expect(sym).toHaveLength(1);
    expect(sym[0]!.text).toContain('CHECK_FEEL');
    expect(sym[0]!.text).toContain('(1)');
    expect(fullText(root)).toContain('10 函数 · 2 声明 · 4 文件');
  });

  it('指令页：行渲染 + 页签计数徽章；空表时空态说明', () => {
    const root = render(baseProps({ activeTab: 'instr', instrRows: INSTR_ROWS }));
    expect(findByClass(root, 'vl-instr')).toHaveLength(1);
    expect(fullText(root)).toContain('指令七');
    const count = findByClass(root, 'vl-tab-count');
    expect(count).toHaveLength(1);
    expect(count[0]!.text).toBe('1');

    const empty = render(baseProps({ activeTab: 'instr', instrRows: [] }));
    expect(findByClass(empty, 'vl-empty')).toHaveLength(1);
    expect(findByClass(empty, 'vl-tab-count')).toHaveLength(0);
  });

  it('条目超窗 → 显示更多哨兵；窗口内只画 limit 行', () => {
    const many: VarEntryRow[] = Array.from({ length: 10 }, (_, i) => ({
      family: 'CFLAG',
      index: i + 1,
      name: `名${i + 1}`,
    }));
    const root = render(baseProps({ entryRows: many, entryLimit: 4 }));
    expect(findByClass(root, 'vl-entry')).toHaveLength(4);
    const more = findByClass(root, 'vl-more');
    expect(more).toHaveLength(1);
    expect(more[0]!.text).toContain('还有 6 条');
  });

  it('条目空态随 selectedFamily 变话术', () => {
    const none = render(baseProps({ selectedFamily: null, entryRows: [] }));
    expect(fullText(none)).toContain('左侧选一个变量族开始浏览');
    const noMatch = render(baseProps({ entryRows: [] }));
    expect(fullText(noMatch)).toContain('这个族没有匹配的条目');
  });
});
