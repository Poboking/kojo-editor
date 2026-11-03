import { describe, expect, it, vi } from 'vitest';
import type { CharaInfo, FileIO, GameProject, ProjectService, WorkspaceService } from '@kojo/plugin-api';
import {
  KOJO_LANG_DOC_CHOICES,
  kojoLangDocExtension,
  withKojoLangDocs,
  type KojoLangDocChoice,
  type KojoScaffoldDraft,
} from '../src/index';
import { createNewKojoProjectWizard, type NewKojoProjectWizardDeps } from '../src/new-project-wizard';

/**
 * 新建向导的**档位拦路警示**（KW-1 发布诚实闸，2026-11-02）。
 *
 * 改前那句"导出 / 部署链还没接到 2.0"只是 `wizard-hint dim` 的一行灰字，而选下去之后
 * **导出与部署都会成功**、游戏里却什么都不会多出来——一行灰字拦不住这种"成功"。
 * 本批把它长成拦路档：选 2.0 ⇒ 一条 `.wizard-warn`（与部署 / 导入 / 无口上目录那几家同一
 * 既有类，不新加 CSS 体系）+ 一键切换到另两档；选原生或封存 ⇒ 那一格整个不渲染。
 *
 * 组件是 hooks + `createElement`，本包**刻意不引 react-dom**（房规见
 * `projects-panel-lifecycle.test.ts`）：hook 换平凡 shim 后直接调组件函数拿元素树。
 * 「选了哪一档」由 shim 的 `useState` 初值决定，而初值 = **声明清单的第一项**
 * （向导的缺省档规则），于是三档各自的渲染都能在不点任何按钮的前提下渲出来。
 */

let cells: unknown[] = [];
let cursor = 0;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown): [unknown, (v: unknown) => void] => {
      const i = cursor++;
      if (i >= cells.length) {
        cells[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      }
      return [
        cells[i],
        (v: unknown): void => {
          cells[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(cells[i]) : v;
        },
      ];
    },
    useRef: (init: unknown): { current: unknown } => ({ current: init }),
    useEffect: (): void => {},
    useMemo: (factory: () => unknown): unknown => factory(),
  };
});

interface FakeNode {
  type: unknown;
  className: string;
  text: string;
  props: Record<string, unknown>;
}

function walk(node: unknown, out: FakeNode[] = []): FakeNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  out.push({
    type: el.type,
    className: String(el.props?.className ?? ''),
    text: textOf(el.props?.children),
    props: el.props ?? {},
  });
  walk(el.props?.children, out);
  return out;
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const has = (n: FakeNode, cls: string): boolean => n.className.split(/\s+/).includes(cls);

/* --------------------------- 供数替身（角色表只要有一个人） --------------------------- */

const chara: CharaInfo = { no: 1, name: '灵梦', kojoDir: 'C:/game/kojo/001 灵梦' };
const gameProject = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: ['C:/game/kojo'],
  writablePaths: [],
  charaIndex: new Map<number, CharaInfo>([[1, chara]]),
} as unknown as GameProject;

const noopScaffold = (draft: KojoScaffoldDraft) => ({ dirName: draft.workName, files: {} });

function wizardDeps(langDocs: readonly KojoLangDocChoice[]): NewKojoProjectWizardDeps {
  return {
    workspaces: {
      rootDir: () => '/appdata/workspaces',
      // 默认落点（2026-11-03 批）：这副替身没设定过，就是内置根
      defaultRoot: () => '/appdata/workspaces',
      customDefaultRoot: () => null,
      roots: () => [],
      projects: async () => [],
      current: () => null,
    } as unknown as WorkspaceService,
    io: { walkDir: async () => [] } as unknown as FileIO,
    project: { current: () => gameProject } as unknown as ProjectService,
    close: () => {},
    onCreated: () => {},
    created: () => {},
    scaffold: withKojoLangDocs(noopScaffold, langDocs),
    coreFaceCount: 8,
  };
}

/** 挂上向导（`cells` 清零 = 一张全新的表单），`draw` 只把游标归零、状态位留着 */
function mount(langDocs: readonly KojoLangDocChoice[]): { draw: () => FakeNode[] } {
  cells = [];
  cursor = 0;
  const component = createNewKojoProjectWizard(wizardDeps(langDocs));
  return {
    draw: (): FakeNode[] => {
      cursor = 0;
      return walk(component());
    },
  };
}

const warnNodes = (nodes: FakeNode[]): FakeNode[] => nodes.filter((n) => has(n, 'wizard-warn'));
const switchButtons = (nodes: FakeNode[]): FakeNode[] =>
  nodes.filter((n) => n.type === 'button' && n.text.startsWith('改用'));

describe('选 2.0 档 ⇒ 拦路警示上屏', () => {
  it('缺省档（清单第一项 = Kojo 2.0）渲染出一条 `.wizard-warn`，说的就是"发出去也不生效"', () => {
    const nodes = mount(KOJO_LANG_DOC_CHOICES).draw();
    const warns = warnNodes(nodes);
    expect(warns).toHaveLength(1);
    const text = warns[0]!.text;
    expect(text).toContain('Kojo 2.0');
    expect(text).toContain('不会被转译');
    expect(text).toContain('读不到');
    expect(text).toContain('导出与部署');
    expect(text).toContain('不报错'); // 说白"它不会拦你"，这才是这条闸真正的症状
    // 扩展名现算自契约单源：屏上看到的就是盘上会落的那一枚
    expect(text).toContain(kojoLangDocExtension('kojo2'));
  });

  it('警示里给出两条出路的名字（原生 / kojo1 封存），不是只说"不行"', () => {
    const text = warnNodes(mount(KOJO_LANG_DOC_CHOICES).draw())[0]!.text;
    expect(text).toContain('原生写法');
    expect(text).toContain('kojo1 封存写法');
  });

  it('一键切换：两枚按钮各指向一档，点下去警示当场消失、下拉也跟着换档', () => {
    const { draw } = mount(KOJO_LANG_DOC_CHOICES);
    const buttons = switchButtons(draw());
    expect(buttons.map((b) => b.text).sort()).toEqual(
      [`改用kojo1 封存写法（${kojoLangDocExtension('sugar')}，仅维护老工程）`, `改用原生写法（${kojoLangDocExtension('native')}，老路径）`].sort(),
    );
    // 点「改用原生写法」（灰字警示就此让位，不再叠第二份）
    const native = buttons.find((b) => b.text.startsWith('改用原生写法'))!;
    (native.props.onClick as () => void)();
    const after = warnNodes(draw());
    expect(after).toHaveLength(0);
    expect(switchButtons(draw())).toHaveLength(0);
  });
});

describe('选 kojo1 / 原生档 ⇒ 不渲染警示（旧屏零噪音）', () => {
  it('清单第一项 = 原生写法：整个窗口没有 `.wizard-warn`，起手说明照旧', () => {
    const nativeFirst = [KOJO_LANG_DOC_CHOICES[1]!, KOJO_LANG_DOC_CHOICES[0]!, KOJO_LANG_DOC_CHOICES[2]!];
    const nodes = mount(nativeFirst).draw();
    expect(warnNodes(nodes)).toHaveLength(0);
    expect(switchButtons(nodes)).toHaveLength(0);
    // 「起手写法」这一格本身还在（声明了 ≥2 档），只是这一档今天没有可拦的事
    expect(nodes.some((n) => n.text === '起手写法')).toBe(true);
  });

  it('清单第一项 = 封存写法（kojo1）：同样一条警示都没有', () => {
    const sugarFirst = [KOJO_LANG_DOC_CHOICES[2]!, KOJO_LANG_DOC_CHOICES[0]!, KOJO_LANG_DOC_CHOICES[1]!];
    const nodes = mount(sugarFirst).draw();
    expect(warnNodes(nodes)).toHaveLength(0);
  });

  it('本游戏没声明语言档（<2 档）⇒ 连「起手写法」这一格都没有，也就没有警示（历史屏逐字一致）', () => {
    const nodes = mount([]).draw();
    expect(nodes.some((n) => n.text === '起手写法')).toBe(false);
    expect(warnNodes(nodes)).toHaveLength(0);
  });
});
