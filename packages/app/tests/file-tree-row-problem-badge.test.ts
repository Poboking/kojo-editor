// @vitest-environment happy-dom
/**
 * 单条文件行的诊断徽标（工包：把树的**第三层**也接上同一个真相）。
 *
 * 工包 E（`ec5a9ba`）把诊断收成 `summarizeProblems` 单源，并折到了角色组 / 作者包两层标题行，
 * 点名剩下的洞就是「单条文件行没有徽标」。本文件钉的正是那一层，且判据与上一批同源：
 *  ① **一个真相**：行上的数字 = 组/包聚合 = store 计数（三层同一个数，谁也不许另算一遍）；
 *  ② **不造假**：只有 `info` 的文件不在行上开口；未打开的文件根本没有那一格；
 *  ③ **归一**：同一个文件的两种 Windows 写法只标一枚、只算一份（尺 = `file-tree-ops.pkey`）；
 *  ④ **过滤态不少报**：组/包按完整分组折，行按自己那一条如实报；
 *  ⑤ **PS-16 前提不破**：新加的那一位是**值**（宿主传 `byKey` 里那一格本身），无关帧
 *     仍然一行都不重画——这条用 mock 计数层钉，不用"看着没变"糊过去。
 *
 * 观测口径沿用仓里两族做法：DOM 数徽标与数字（同 `problem-truth-single-source` / `file-tree-memo`）、
 * 源码扫单源（同 `shell-info-design`）。行渲染要展开到第三层，故整文件跑 happy-dom。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, memo, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DirEntry, ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree } from '../src/ui/FileTree';
import type { DirRowsProps } from '../src/ui/file-tree-dir-rows';
import type { FileRowProps } from '../src/ui/file-tree-row';
import {
  PROBLEM_SCOPE,
  SEVERITY_TINT,
  clearAllProblems,
  setProblems,
  snapshot,
  summarizeProblems,
  type EditorProblem,
} from '../src/ui/problem-store';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// mock 只包导出 ⇒ 外层计数 memo 挡下时内层真组件一次都不跑（`file-tree-memo` 同款口径）
const counts = vi.hoisted(() => ({ fileRow: 0, dirRows: 0 }));

vi.mock('../src/ui/file-tree-row', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/file-tree-row')>();
  return {
    ...actual,
    FileRow: memo((props: FileRowProps): ReactElement => {
      counts.fileRow++;
      return h(actual.FileRow, props);
    }),
  };
});
vi.mock('../src/ui/file-tree-dir-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/file-tree-dir-rows')>();
  return {
    ...actual,
    DirRows: memo((props: DirRowsProps): ReactElement => {
      counts.dirRows++;
      return h(actual.DirRows, props);
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PKG_DIR = 'C:/game/ERB/001/少女之梦';
const SUB_DIR = `${PKG_DIR}/没写的`;
const F1 = `${PKG_DIR}/M_KOJO_K1_1.ERB`;
const F2 = `${PKG_DIR}/M_KOJO_K1_2.ERB`;
const F3 = `${PKG_DIR}/M_KOJO_K1_3.ERB`;
/** 子目录里的 ERB：没进索引 ⇒ 只从 DirRows（磁盘列举）那条腿出现 */
const SUB = `${SUB_DIR}/M_KOJO_K1_s.ERB`;
/** 作者包里的附加文件：同样只从 DirRows 那条腿出现 */
const NOTE = `${PKG_DIR}/notes.txt`;

const project = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: ['C:/game/ERB'],
  charaIndex: new Map([['1', { id: 1, no: 1, name: '灵梦', kojoDir: 'C:/game/ERB/001' }]]),
} as unknown as GameProject;

/** 索引里只有平铺的那三份（`groups` 的分组来源） */
const index = {
  files: new Map([F1, F2, F3].map((p) => [p, { path: p, functions: [] }])),
} as unknown as ErbIndex;

const entry = (path: string, isDirectory: boolean): DirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  isDirectory,
});

/** 包根列出一份"与平铺同级"的 ERB（必须被 skip 掉 ⇒ 只标一枚）+ 附加文件 + 子目录 */
const listDir = async (dir: string): Promise<DirEntry[]> => {
  if (dir === PKG_DIR) return [entry(SUB_DIR, true), entry(NOTE, false), entry(F1, false)];
  if (dir === SUB_DIR) return [entry(SUB, false)];
  return [];
};

const mk = (
  path: string,
  line: number,
  severity: EditorProblem['severity'],
  message = 'm',
): EditorProblem => ({ path, line, severity, message });

const treeProps = {
  project,
  index,
  activeFile: null as string | null,
  onOpenFile: () => {},
  listDir,
};

let container: HTMLElement;
let root: Root;

/** 展开到第三层：开角色组 → 开作者包真实文件夹 → 开子目录（两条行装配线全部挂载） */
async function mountTree(activeFile: string | null = null): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(FileTree, { ...treeProps, activeFile }));
  });
  for (const sel of ['.tree-group-btn', '.tree-package', '.tree-dir']) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(sel)?.click();
    });
  }
  await act(async () => {});
}

async function rerender(activeFile: string | null): Promise<void> {
  await act(async () => {
    root.render(h(FileTree, { ...treeProps, activeFile }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
}

const rowsSel = 'button.tree-file';
/** 某一条文件行末尾的那枚徽标（行路径按 `data-locate` 点名） */
const badgeOf = (path: string): Element | null =>
  container.querySelector(`button[data-locate="${path}"] .tree-prob-mark`);

/**
 * 徽标两档的内层读数格（L10 图标批：`✕ n`/`⚠ n` 字符换成 `data-prob` + 状态族 SVG + 数字；
 * 与 `problem-truth-single-source` 同一把尺——按 `data-prob` 点名，读数取那格的数）。
 */
const badgeParts = (scope: ParentNode, sel: string): number[] =>
  [...scope.querySelectorAll(`${sel} .tree-prob-mark > span[data-prob]`)].map((s) =>
    Number((s.textContent ?? '').trim()),
  );

/** 某档读数格本身（error/warning 各一枚；SVG 上屏后按 data-prob 取，不再数汉字字形） */
const probPart = (scope: ParentNode | null | undefined, sev: 'error' | 'warning'): Element | null =>
  scope?.querySelector(`[data-prob="${sev}"]`) ?? null;

const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);

/** store 里那位落到行上应该长成的样子——hex 会被 DOM 归一成 rgb，`var(…)` 则原样留在内联样式里 */
function paintedForms(value: string): string[] {
  const v = value.toLowerCase();
  if (v.startsWith('var(')) return [v];
  const n = BigInt(`0x${v.slice(1)}`);
  return [v, `rgb(${(n >> 16n) & 255n}, ${(n >> 8n) & 255n}, ${n & 255n})`];
}

/** 树侧三层各自合计（组标题行 / 包标题行 / 文件行）：三处必等 */
function threeFaces(): { group: number; pkg: number; row: number; store: number } {
  const pick = (sel: string): number => sum(badgeParts(container, sel));
  return {
    group: pick('button.tree-group-btn'),
    pkg: pick('button.tree-package'),
    row: pick(rowsSel),
    store: (() => {
      const c = summarizeProblems(snapshot()).counts;
      return c.error + c.warning;
    })(),
  };
}

beforeEach(() => {
  counts.fileRow = 0;
  counts.dirRows = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  clearAllProblems();
  counts.fileRow = 0;
  counts.dirRows = 0;
});

describe('单条文件行徽标 · 平铺那条腿（FileRows → FileRow）', () => {
  it('store 为空 ⇒ 行上一枚都不画（零视觉扰动）', async () => {
    await mountTree();
    expect(container.querySelectorAll(`${rowsSel} .tree-prob-mark`)).toHaveLength(0);
  });

  it('文件行只画状态灯、不挂数字；精确读数在 aria-label / title 里（视觉批十六）', async () => {
    setProblems(F1, [mk(F1, 3, 'error'), mk(F1, 7, 'error'), mk(F1, 9, 'warning')]);
    await mountTree();
    const badge = badgeOf(F1);
    expect(badge).not.toBeNull();
    // 屏上只有灯（数字聚合到角色组 / 作者包那一层，见 `TreeProbMark.compact`）
    expect(probPart(badge, 'error')?.textContent?.trim()).toBe('');
    expect(probPart(badge, 'warning')?.textContent?.trim()).toBe('');
    expect(probPart(badge, 'error')?.querySelector('svg.icon')).not.toBeNull();
    // 读数一条不丢：读屏与悬停仍拿到 store 那一格
    const label = badge?.getAttribute('aria-label') ?? '';
    expect(label).toContain('错误 2');
    expect(label).toContain('警告 1');
    // 配色仍取自 store 的 SEVERITY_TINT（行这一腿不许自带色值；token 档原样是 var(…)，hex 档可能被归一成 rgb）
    const painted = ((badge?.firstElementChild as HTMLElement).style.color ?? '').toLowerCase();
    expect(paintedForms(SEVERITY_TINT.error)).toContain(painted);
  });

  it('只有 info 的文件不在行上开口（那一档面板表头本来就在说）', async () => {
    setProblems(F2, [mk(F2, 1, 'info'), mk(F2, 2, 'info')]);
    await mountTree();
    expect(badgeOf(F2)).toBeNull();
    // store 里确实有它（面板要说），树上就是不开口
    expect(summarizeProblems(snapshot()).byKey.get(F2.toLowerCase())?.info).toBe(2);
  });

  it('tooltip 用 PROBLEM_SCOPE 的口径词（句式只有一句中文）', async () => {
    setProblems(F1, [mk(F1, 3, 'error')]);
    await mountTree();
    const title = badgeOf(F1)?.getAttribute('title') ?? '';
    expect(title).toContain(`本文件内${PROBLEM_SCOPE.label}文件的诊断：错误 1 / 警告 0`);
    expect(title).toContain('详见问题面板');
    // 行徽标不点名文件（行本身就是那个文件），组/包那两层的点名不在这里重复
    expect(title).not.toContain('M_KOJO_K1_1.ERB');
  });

  it('同一个文件两种 Windows 写法 ⇒ 一枚徽标、一份合并数（尺 = pkey）', async () => {
    const alt = `${PKG_DIR}\\M_KOJO_K1_2.erb`;
    setProblems(alt, [mk(alt, 1, 'error')]);
    setProblems(F2, [mk(F2, 7, 'warning')]);
    await mountTree();
    const badge = badgeOf(F2);
    expect(badge).not.toBeNull();
    const label = badge?.getAttribute('aria-label') ?? '';
    expect(label).toContain('错误 1');
    expect(label).toContain('警告 1');
    expect(container.querySelectorAll(`button[data-locate="${F2}"]`)).toHaveLength(1);
    // 文件行不挂数字（批十六）：两档灯都在，数字合计为 0
    expect(threeFaces().row).toBe(0);
  });

  it('活订阅：清掉诊断 ⇒ 行徽标当场退场（不重挂树）', async () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    await mountTree();
    expect(badgeOf(F1)).not.toBeNull();
    await act(async () => {
      clearAllProblems();
    });
    expect(badgeOf(F1)).toBeNull();
  });

  it('聚合层同一个数：组标题行 = 包标题行 = store；文件行只报"有没有"（视觉批十六）', async () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'error'), mk(F1, 3, 'warning')]);
    setProblems(F3, [mk(F3, 4, 'warning')]);
    await mountTree();
    const faces = threeFaces();
    expect(faces.store).toBe(4);
    // 目录那两层仍逐档报数（读树的人在那里决定打开哪一瓶）
    expect(faces.group).toBe(faces.store);
    expect(faces.pkg).toBe(faces.store);
    // 文件行：灯在、数字不上屏（aria 里仍是精确读数）
    expect(faces.row).toBe(0);
    expect(container.querySelectorAll(`${rowsSel} .tree-prob-mark`)).toHaveLength(2);
    expect(badgeOf(F3)?.getAttribute('aria-label')).toContain('警告 1');
  });
});

describe('单条文件行徽标 · DirRows 那条腿（包真实文件夹 / 嵌套目录 / 附加文件）', () => {
  it('包内附加文件行与嵌套子目录里的 ERB 行同样开口', async () => {
    setProblems(NOTE, [mk(NOTE, 1, 'warning')]);
    setProblems(SUB, [mk(SUB, 2, 'error'), mk(SUB, 3, 'error')]);
    await mountTree();
    expect(badgeOf(NOTE)?.getAttribute('aria-label')).toContain('警告 1');
    expect(badgeOf(SUB)?.getAttribute('aria-label')).toContain('错误 2');
  });

  it('与平铺同级的 ERB 只标一枚（skip 去重那条腿照旧生效，不因徽标翻倍）', async () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    await mountTree();
    expect(container.querySelectorAll(`button[data-locate="${F1}"]`)).toHaveLength(1);
    expect(container.querySelectorAll(`button[data-locate="${F1}"] .tree-prob-mark`)).toHaveLength(1);
  });
});

describe('过滤态：徽标不少报', () => {
  it('过滤词只筛显示：可见行如实报自己的数，组标题行仍按完整分组折', async () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'error')]);
    setProblems(F3, [mk(F3, 1, 'error')]);
    await mountTree();
    const input = container.querySelector<HTMLInputElement>('.tree-filter');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'K1_1');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await flush();
    // 命中那一行：自己那两条错误的灯在，精确数进 aria（行不挂数字）
    expect(badgeOf(F1)?.getAttribute('aria-label')).toContain('错误 2');
    // 组标题行：被过滤掉的那份（F3）照样算进来——少报 = 撒谎
    const groupBadge = container.querySelector('button.tree-group-btn .tree-prob-mark');
    expect(groupBadge?.getAttribute('title') ?? '').toContain('错误 3 / 警告 0');
    expect(probPart(groupBadge, 'error')?.textContent).toContain('3');
  });
});

describe('PS-16 前提不破（渲染计数）', () => {
  it('有诊断时右键菜单翻动 ⇒ 行组件一次都不执行（probs 是稳定引用）', async () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProblems(SUB, [mk(SUB, 1, 'warning')]);
    await mountTree();
    const base = { ...counts };
    expect(base.fileRow).toBeGreaterThan(0);
    expect(base.dirRows).toBeGreaterThan(0);
    await act(async () => {
      container.querySelector('.file-tree')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(counts.fileRow).toBe(base.fileRow);
    expect(counts.dirRows).toBe(base.dirRows);
  });

  it('activeFile 切换 ⇒ 仍只有新旧两行重画（prob 传的是值，不是每帧新引用）', async () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProblems(F3, [mk(F3, 1, 'warning')]);
    await mountTree(F1);
    const base = { ...counts };
    await rerender(F3);
    expect(counts.fileRow - base.fileRow).toBe(2);
  });
});

describe('静态闸：画法与句式都只有一条腿', () => {
  const row = read('../src/ui/file-tree-row.tsx');
  const rows = read('../src/ui/file-tree-rows.tsx');
  const dir = read('../src/ui/file-tree-dir-rows.tsx');
  const tree = read('../src/ui/FileTree.tsx');

  it('`.tree-prob-mark` 那枚 DOM 只在行模块造一次（宿主与两条装配线只复用）', () => {
    expect((row.match(/className="tree-prob-mark"/g) ?? []).length).toBe(1);
    for (const [name, src] of [
      ['FileTree.tsx', tree],
      ['file-tree-rows.tsx', rows],
      ['file-tree-dir-rows.tsx', dir],
    ] as const) {
      expect(src, `${name}: 又抄了一份徽标画法`).not.toContain('tree-prob-mark');
    }
    expect(tree).toContain('TreeProbMark');
    expect(dir).toContain('TreeProbMark');
    expect(rows).toContain('FileRow');
  });

  it('tooltip 那句中文只有一句（口径词仍取自 PROBLEM_SCOPE）', () => {
    const sentence = /文件的诊断：错误/g;
    expect((row.match(sentence) ?? []).length).toBe(1);
    for (const src of [tree, rows, dir]) {
      expect(src, '第二句 tooltip = 第二个真相').not.toMatch(sentence);
    }
    expect(row).toContain('PROBLEM_SCOPE.label');
    expect(row).toContain('SEVERITY_TINT');
  });

  it('行模块零字面色值、零第二条计数腿（`byPath` 那把原始写法的尺不许进树）', () => {
    for (const [name, src] of [
      ['file-tree-row.tsx', row],
      ['file-tree-rows.tsx', rows],
      ['file-tree-dir-rows.tsx', dir],
      ['FileTree.tsx', tree],
    ] as const) {
      expect((src.match(/#[0-9a-f]{6}/gi) ?? []).length, `${name}: 写死了色值`).toBe(0);
      expect(src, `${name}: 树上只许按 pkey 查表`).not.toContain('byPath');
      expect(src.match(/severity === 'error'/g) ?? [], `${name}: 又抄了一份计数循环`).toHaveLength(0);
    }
    // 归一那把尺只有一把：行组件的查表必须走 pkey
    expect(rows).toContain('pkey(f)');
    expect(dir).toContain('pkey(d.path)');
  });
});
