// @vitest-environment happy-dom
/**
 * 工包 E（2026-10-19）：诊断的「三处三个口径」收成一个**真相**。
 *
 * 三处 = 状态栏那颗（旧标签写「本文件」、数的却是全部已打开文件的合并值）、问题面板
 * （表头 + 组头）、文件树（此前对诊断**完全无感**：`FileTree.tsx` 里 grep
 * `problem|diagnostic|marker` 是 0 ⇒ 某个文件整体报错，树上一点痕迹没有）。
 * 收口之后只有一条派生腿：`problem-store.summarizeProblems`。
 *
 * 本文件钉三件事：
 *  1. **同源同口径**（判据①）——同一份 store 状态下，状态栏那颗 / 面板表头 / 面板组头合计 /
 *     文件树徽标读到的数字必须彼此相等；状态栏的可见范围标签只能是 store 里那一个真源。
 *     这是"以后有人改标签或改计数、又把它俩拆开"的唯一自动化拦点。
 *  2. **不造假**（判据②）——树上只标**账上真有**的那些（info-only 不开口、没上账的文件不开口）；
 *     路径写法差异必须认得。
 *  3. **补齐缺腿后两头都不冒充**（工包「未打开文件永不上账」，2026-10-20）——诊断按 `origin`
 *     分两簇（编辑器实时 / 整项目扫描）：清账入口只认自己那一簇（关标签抹不掉项目级结论）、
 *     同一文件两簇并存只数一遍（不翻倍）、范围标签跟着"屏幕上真有几簇"走；扫描没跑完 /
 *     只覆盖部分目录 / 有文件被跳过时，那句话里必须当场看得出来（铁律 4）。
 *
 * 观测口径沿用仓里两族做法：markup 数类名与数字（`ps6-rows` / `ps6-panel-bridge`）、
 * 结构约定扫源码（`shell-info-design` / `readonly-pill`）；展开作者包那一层需要点一下，
 * 故整文件跑 happy-dom（同 `file-tree-memo`）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import type { ErbIndex, GameProject } from '@kojo/plugin-api';
import { FileTree, treeProblemMarks } from '../src/ui/FileTree';
import { ProblemPanel, ProblemsStatusItem } from '../src/ui/ProblemPanel';
import { buildFileGroups, kojoOwners } from '../src/ui/file-tree-model';
import {
  clearAllProblems,
  clearProjectScan,
  clearProblems,
  setProjectScanCoverage,
  setProjectScanProblems,
  setProblems,
  snapshot,
  subscribe,
  summarizeProblems,
  takeRescanPaths,
  projectScanCoverage,
  projectScanFileCount,
  IDLE_SCAN_COVERAGE,
  EMPTY_PROBLEM_SUMMARY,
  PROBLEM_SCOPE,
  type EditorProblem,
  type ProjectScanCoverage,
} from '../src/ui/problem-store';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// 活订阅那条腿要真跑 act（同 `file-tree-memo` / `tabs-bar-memo` 的写法）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PKG_DIR = 'C:/game/ERB/001/少女之梦';
const F1 = `${PKG_DIR}/M_KOJO_K1_1.ERB`;
const F2 = `${PKG_DIR}/M_KOJO_K1_2.ERB`;
const F3 = `${PKG_DIR}/M_KOJO_K1_3.ERB`;
/** 同包另外九份（只给"点名上限"那条用：树上在、默认折叠 ⇒ 不进 markup，除徽标 tooltip 外） */
const EXTRA = Array.from({ length: 9 }, (_, i) => `${PKG_DIR}/X${i}.ERB`);

const project = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: ['C:/game/ERB'],
  charaIndex: new Map([['1', { id: 1, no: 1, name: '灵梦', kojoDir: 'C:/game/ERB/001' }]]),
} as unknown as GameProject;

const index = {
  files: new Map([...EXTRA, F1, F2, F3].map((p) => [p, { path: p, functions: [] }])),
} as unknown as ErbIndex;

const mk = (
  path: string,
  line: number,
  severity: EditorProblem['severity'],
  message = 'm',
): EditorProblem => ({ path, line, severity, message });

const groups = buildFileGroups([...EXTRA, F1, F2, F3], kojoOwners(project));
const GROUP_LABEL = groups[0]!.label; // '#1 灵梦'

const treeMarkup = (): string =>
  renderToStaticMarkup(h(FileTree, { project, index, activeFile: null, onOpenFile: () => {} }));

/** 「符号 + 空格 + 数字」的读数（状态栏 / 组头共用这一种上屏形态；树徽标 L10 起是 SVG，另走 `treeBadgeNums`） */
const nums = (markup: string, sym: string): number[] =>
  [...markup.matchAll(new RegExp(`>${sym} (\\d+)<`, 'g'))].map((m) => Number(m[1]));

/** 树徽标读数（批次十一 L10：`✕ n` 字符换成状态族 SVG + 数字，读数按 `data-prob` 那格取） */
const treeBadgeNums = (markup: string, sev: 'error' | 'warning'): number[] =>
  [...markup.matchAll(new RegExp(`data-prob="${sev}".*?</svg> (\\d+)</span>`, 'g'))].map((m) =>
    Number(m[1]),
  );

const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);

interface Counts3 {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

/** 状态栏那颗：三档各一枚 `.sb-problems-item` */
function statusCounts(markup: string): Counts3 {
  const spans = [...markup.matchAll(/class="sb-problems-item"[^>]*>([^<]*)</g)].map((m) => m[1] ?? '');
  const pick = (sym: string): number =>
    Number(spans.find((s) => s.includes(sym))?.trim().slice(1) ?? 0);
  return { error: pick('✕'), warning: pick('⚠'), info: pick('ℹ') };
}

/** 面板表头：`错误 n` / `警告 n` / `提示 n`（勾选框那三枚只有词没有数，不会误命中） */
function headerCounts(markup: string): Counts3 {
  const g = (word: string): number => Number(markup.match(new RegExp(`>${word} (\\d+)<`))?.[1] ?? 0);
  return { error: g('错误'), warning: g('警告'), info: g('提示') };
}

/** 面板组头合计（只扫 `prob-list` 那一段，行内消息里不含 `✕ 数字` 形态） */
function groupHeadCounts(panel: string): Counts3 {
  const seg = panel.slice(panel.indexOf('class="prob-list"'));
  return { error: sum(nums(seg, '✕')), warning: sum(nums(seg, '⚠')), info: sum(nums(seg, 'ℹ')) };
}

/** 树侧合计（按角色组那一层求和：每个文件恰属一个组 ⇒ 不重不漏） */
function treeTotals(): Counts3 & { readonly badges: number } {
  const marks = treeProblemMarks(groups, summarizeProblems(snapshot()));
  let error = 0;
  let warning = 0;
  let badges = 0;
  for (const m of marks.groups.values()) {
    error += m.error;
    warning += m.warning;
    badges++;
  }
  return { error, warning, info: 0, badges };
}

afterEach(() => {
  clearAllProblems();
  clearProjectScan();
  setProjectScanCoverage(IDLE_SCAN_COVERAGE);
  takeRescanPaths(10_000); // 复核队列排空：上一案的队列不许串进下一案的读数
});

describe('summarizeProblems · 唯一一次遍历的产物', () => {
  it('全局计数 + 按文件计数 + 按归一路径计数一次算全', () => {
    setProblems(F1, [mk(F1, 3, 'error'), mk(F1, 9, 'warning')]);
    setProblems(F2, [mk(F2, 1, 'error'), mk(F2, 2, 'info'), mk(F2, 4, 'info')]);
    const s = summarizeProblems(snapshot());
    expect(s.counts).toEqual({ error: 2, warning: 1, info: 2 });
    expect(s.byPath.get(F1)).toEqual({ path: F1, error: 1, warning: 1, info: 0 });
    expect(s.byPath.get(F2)).toEqual({ path: F2, error: 1, warning: 0, info: 2 });
    expect(s.files.map((f) => f.path)).toEqual([F1, F2]);
  });

  it('Windows 两种写法 = 同一个文件：byKey 合并计数，绝不当两份数（文件树按磁盘写法查表要认得）', () => {
    const alt = `${PKG_DIR}\\M_KOJO_K1_2.erb`;
    setProblems(alt, [mk(alt, 1, 'error')]);
    setProblems(F2, [mk(F2, 7, 'warning')]);
    const s = summarizeProblems(snapshot());
    const hit = s.byKey.get(F2.toLowerCase())!;
    expect({ error: hit.error, warning: hit.warning, info: hit.info }).toEqual({
      error: 1,
      warning: 1,
      info: 0,
    });
    // 原始写法那两格照旧留着（跳源要按注册表里那条路径本身）；归一腿只用于查表
    expect(s.byPath.size).toBe(2);
    // 全局计数按条目数，不因合并而丢数
    expect(s.counts).toEqual({ error: 1, warning: 1, info: 0 });
    // 折到树上也只算一枚徽标、一份量（不因为两种写法翻成两倍）
    expect(treeTotals().error).toBe(1);
  });

  it('空表 ⇒ 同一个常量引用（订阅方不每帧新造空对象）；同引用入参 ⇒ 派生命中缓存', () => {
    expect(summarizeProblems(snapshot())).toBe(EMPTY_PROBLEM_SUMMARY);
    setProblems(F1, [mk(F1, 1, 'error')]);
    const s1 = snapshot();
    expect(summarizeProblems(s1)).toBe(summarizeProblems(s1));
  });
});

describe('treeProblemMarks · 把同一份派生折到两层节点', () => {
  it('包与角色组各拿到合计（同一文件同时进两层，是"两层各说一遍"不是"数两遍"）', () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'warning')]);
    setProblems(F3, [mk(F3, 4, 'error')]);
    const marks = treeProblemMarks(groups, summarizeProblems(snapshot()));
    const g = marks.groups.get(GROUP_LABEL)!;
    expect({ error: g.error, warning: g.warning }).toEqual({ error: 2, warning: 1 });
    expect(g.files.map((f) => `${f.name}:${f.error}/${f.warning}`)).toEqual([
      'M_KOJO_K1_1.ERB:1/1',
      'M_KOJO_K1_3.ERB:1/0',
    ]);
    expect(marks.packages.size).toBe(1);
    const p = [...marks.packages.values()][0]!;
    expect({ error: p.error, warning: p.warning }).toEqual({ error: 2, warning: 1 });
  });

  it('只有 info 的文件不在树上说话（两档即可；那一档面板表头本来就在说）', () => {
    setProblems(F2, [mk(F2, 1, 'info')]);
    const marks = treeProblemMarks(groups, summarizeProblems(snapshot()));
    expect(marks.groups.size).toBe(0);
    expect(marks.packages.size).toBe(0);
  });

  it('点名上限之外的折进 more（几十份文件的包不许把 tooltip 写成小说）', () => {
    for (const p of EXTRA) setProblems(p, [mk(p, 1, 'error')]);
    const g = treeProblemMarks(groups, summarizeProblems(snapshot())).groups.get(GROUP_LABEL)!;
    expect(g.error).toBe(9);
    expect(g.files.map((f) => f.name)).toEqual(['X0.ERB', 'X1.ERB', 'X2.ERB', 'X3.ERB', 'X4.ERB', 'X5.ERB']);
    expect(g.more).toBe(3);
  });
});

describe('文件树徽标 · SSR 实际画出来', () => {
  it('store 为空 ⇒ 一个徽标都不画（零视觉扰动）', () => {
    expect(treeMarkup()).not.toContain('tree-prob-mark');
  });

  it('默认折叠态：角色组那一层就说话（旧形态是整棵树对诊断完全无感）', () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'error'), mk(F1, 5, 'warning')]);
    const markup = treeMarkup();
    expect((markup.match(/class="tree-prob-mark"/g) ?? []).length).toBe(1);
    expect(nums(markup, '✕')).toEqual([]); // 徽标字形已 SVG 化：markup 里不再有 `>✕ n<` 形态
    expect(treeBadgeNums(markup, 'error')).toEqual([2]);
    expect(treeBadgeNums(markup, 'warning')).toEqual([1]);
    expect(markup).toContain('M_KOJO_K1_1.ERB ✕2 ⚠1');
    expect(markup).toContain(`内${PROBLEM_SCOPE.label}文件的诊断`);
  });

  it('未打开也没扫到的文件（树上在、store 里没有）⇒ 树上不给它标——账上没有就不许画（采集腿接上后仍未覆盖的文件同一条判据）', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    const markup = treeMarkup();
    // 折叠态里 markup 出现的文件名只可能来自徽标 tooltip：只许点名真正有诊断的那一份
    expect(markup.match(/M_KOJO_K1_\d\.ERB/g)).toEqual(['M_KOJO_K1_1.ERB']);
  });

  it('展开作者包 ⇒ 包标题行同一份数字（两层各说一遍，值来自同一次派生）', async () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 4, 'warning')]);
    const container = document.createElement('div');
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(h(FileTree, { project, index, activeFile: null, onOpenFile: () => {} }));
    });
    expect(container.querySelectorAll('.tree-prob-mark')).toHaveLength(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.tree-group-btn')?.click();
    });
    const badges = [...container.querySelectorAll('.tree-prob-mark')];
    // 展开作者包后上屏的是**三枚**：角色组标题行、作者包标题行、单条文件行
    // （文件行那一枚由 `file-tree-row` 那一路接上，2026-10-20 那条线加的）。
    // 判据不变：三枚全读同一次派生的同一个值 —— 谁也不许自己再数一遍。
    expect(badges).toHaveLength(3);
    // 目录两层挂数字（读数按 data-prob 格取）；文件行只画灯（视觉批十六），精确数进 aria
    for (const b of badges.filter((x) => x.closest('.tree-file') === null)) {
      expect(b.querySelector('svg.icon')).not.toBeNull();
      expect(b.querySelector('[data-prob="error"]')?.textContent).toBe(' 1');
      expect(b.querySelector('[data-prob="warning"]')?.textContent).toBe(' 1');
    }
    const rowBadge = container.querySelector('.tree-file .tree-prob-mark');
    expect(rowBadge?.querySelector('[data-prob="error"]')?.textContent).toBe('');
    expect(rowBadge?.getAttribute('aria-label')).toContain('错误 1');
    expect(rowBadge?.getAttribute('aria-label')).toContain('警告 1');
    // 活订阅：诊断换了（这里是清掉），徽标当场退场——不重挂树也得跟着真相走
    await act(async () => {
      clearAllProblems();
    });
    expect(container.querySelectorAll('.tree-prob-mark')).toHaveLength(0);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('四张面孔一个真相（判据①的自动化拦点）', () => {
  const surfaces = (): {
    status: Counts3;
    header: Counts3;
    groups: Counts3;
    tree: Counts3;
  } => {
    const status = statusCounts(renderToStaticMarkup(h(ProblemsStatusItem, { onClick: () => {} })));
    const panel = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    return { status, header: headerCounts(panel), groups: groupHeadCounts(panel), tree: treeTotals() };
  };

  it('混合三档：状态栏 = 面板表头 = 组头合计 = 树（树上只报错误/警告两档）', () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'warning'), mk(F1, 3, 'info')]);
    setProblems(F2, [mk(F2, 4, 'error'), mk(F2, 5, 'info')]);
    const s = surfaces();
    expect(s.status).toEqual({ error: 2, warning: 1, info: 2 });
    expect(s.header).toEqual(s.status);
    expect(s.groups).toEqual(s.status);
    expect(s.tree).toEqual({ error: s.status.error, warning: s.status.warning, info: 0, badges: 1 });
  });

  it('关掉一份标签（store 少一个文件）⇒ 四处同步缩水到同一份', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProblems(F2, [mk(F2, 1, 'error'), mk(F2, 2, 'error')]);
    expect(surfaces().status).toEqual({ error: 3, warning: 0, info: 0 });
    clearAllProblems();
    setProblems(F1, [mk(F1, 1, 'error')]);
    const s = surfaces();
    expect(s.status).toEqual({ error: 1, warning: 0, info: 0 });
    expect(s.header).toEqual(s.status);
    expect(s.groups).toEqual(s.status);
    expect(s.tree).toEqual({ error: 1, warning: 0, info: 0, badges: 1 });
  });

  it('面板过滤一开：组头跟着过滤结果走，表头/状态栏仍数全量（同一把尺的两种切片，不是两套算法）', () => {
    setProblems(F1, [mk(F1, 1, 'error', '结构不闭合')]);
    setProblems(F2, [mk(F2, 1, 'warning', '表达式缺 else')]);
    const all = surfaces();
    expect(all.groups).toEqual(all.status);
    // 过滤态只能由交互产生，这里只钉"未过滤时四处必等"这条底线；
    // 组头数字取自 `summarizeProblems(filtered)` 由下面的源码闸钉住。
    expect(all.header.error).toBe(1);
    expect(all.header.warning).toBe(1);
  });

  it('状态栏那颗：可见标签与 tooltip 都取自 PROBLEM_SCOPE（改标签字必须同时改真源）', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    const withCounts = renderToStaticMarkup(h(ProblemsStatusItem, { onClick: () => {} }));
    clearAllProblems();
    const empty = renderToStaticMarkup(h(ProblemsStatusItem, { onClick: () => {} }));
    for (const markup of [withCounts, empty]) {
      expect(markup).toContain(`class="sb-scope-tag">${PROBLEM_SCOPE.label}</span>`);
      expect(markup).toContain(PROBLEM_SCOPE.title);
    }
    expect(PROBLEM_SCOPE.label).toBe('已打开'); // 旧「本文件」是假口径（计数是合并值）
  });
});

/* ---------------- 工包「缺腿」（2026-10-20）：origin 两簇 ---------------- */

/** 覆盖读数造一条（默认 = 一整轮跑完：12/12、允许根就是那个口上目录） */
const scanCoverage = (over: Partial<ProjectScanCoverage> = {}): ProjectScanCoverage => ({
  ...IDLE_SCAN_COVERAGE,
  status: 'complete',
  roots: [PKG_DIR],
  scanned: 12,
  total: 12,
  ...over,
});

describe('origin 两簇 · 未打开的文件也能上账，且关标签抹不掉项目级结论', () => {
  it('同一文件两簇并存 ⇒ 只出示编辑器那份（同一个问题数两遍就是造假账）', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProjectScanProblems(F1, [mk(F1, 1, 'error'), mk(F1, 5, 'warning')]);
    expect(snapshot().map((p) => `${p.line}/${p.severity}/${p.origin}`)).toEqual(['1/error/open-file']);
    expect(summarizeProblems(snapshot()).counts).toEqual({ error: 1, warning: 0, info: 0 });
  });

  it('clearProblems（关标签）只清编辑器那一簇 ⇒ 项目级那条回到台前，并排进复核队列', () => {
    setProjectScanProblems(F3, [mk(F3, 2, 'warning')]);
    setProblems(F3, [mk(F3, 2, 'warning')]);
    setProjectScanCoverage(scanCoverage());
    clearProblems(F3);
    expect(snapshot().map((p) => p.origin)).toEqual(['project-scan']);
    expect(summarizeProblems(snapshot()).counts.warning).toBe(1);
    expect(takeRescanPaths()).toEqual([F3]); // 内存结论作废 ⇒ 盘上那份要复核，不许当新真相
    expect(takeRescanPaths()).toEqual([]);
  });

  it('clearAllProblems（编辑器卸载）也只清自己那一簇；只有 clearProjectScan 才动项目级', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProjectScanProblems(F2, [mk(F2, 1, 'error')]);
    setProjectScanCoverage(scanCoverage());
    clearAllProblems();
    expect(summarizeProblems(snapshot()).counts).toEqual({ error: 1, warning: 0, info: 0 });
    clearProjectScan();
    expect(snapshot()).toHaveLength(0);
    expect(projectScanFileCount()).toBe(0);
  });

  it('打开且干净 ⇒ 压住旧扫描（刚发布"这份没问题"的文件不能凭空长出红线）', () => {
    setProjectScanProblems(F2, [mk(F2, 4, 'error')]);
    setProblems(F2, []);
    expect(snapshot()).toHaveLength(0);
    expect(summarizeProblems(snapshot())).toBe(EMPTY_PROBLEM_SUMMARY);
    clearProblems(F2);
    expect(snapshot().map((p) => `${p.line}/${p.origin}`)).toEqual(['4/project-scan']);
  });

  it('旧形状一格没动（另一条线按原样消费），分簇计数是新增那一格', () => {
    setProblems(F1, [mk(F1, 3, 'error'), mk(F1, 9, 'warning')]);
    setProjectScanProblems(F2, [mk(F2, 1, 'error')]);
    const s = summarizeProblems(snapshot());
    expect(Object.keys(s).sort()).toEqual(['byKey', 'byPath', 'counts', 'countsByOrigin', 'files']);
    expect(Object.keys(s.byPath.get(F1)!).sort()).toEqual(['error', 'info', 'path', 'warning']);
    expect(s.counts).toEqual({ error: 2, warning: 1, info: 0 });
    expect(s.countsByOrigin['open-file']).toEqual({ error: 1, warning: 1, info: 0 });
    expect(s.countsByOrigin['project-scan']).toEqual({ error: 1, warning: 0, info: 0 });
  });

  it('不带 origin 的入参按编辑器那一簇记账（旧调用零改动、旧数字零变化）', () => {
    const s = summarizeProblems([mk(F1, 1, 'error'), mk(F2, 1, 'warning')]);
    expect(s.countsByOrigin['open-file']).toEqual({ error: 1, warning: 1, info: 0 });
    expect(s.countsByOrigin['project-scan']).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

describe('PROBLEM_SCOPE · 合并之后的说法必须两头都不冒充', () => {
  it('只有编辑器那一簇 ⇒ 原文一字不改（"不含未打开文件"这句此刻仍然是真的）', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    expect(PROBLEM_SCOPE.label).toBe('已打开');
    expect(PROBLEM_SCOPE.title).toContain('不含未打开文件与整项目结论 ≠ 项目级约定计数');
  });

  it('项目级进了账 ⇒ 不许再说"只有已打开文件"，并说得出覆盖了几个、哪些目录', () => {
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProjectScanProblems(F2, [mk(F2, 1, 'error')]);
    setProjectScanCoverage(scanCoverage({ roots: [PKG_DIR], scanned: 12, total: 12 }));
    expect(PROBLEM_SCOPE.label).toBe('已打开+已扫描');
    expect(PROBLEM_SCOPE.title).toContain('覆盖 12/12');
    expect(PROBLEM_SCOPE.title).toContain(PKG_DIR);
    expect(PROBLEM_SCOPE.title).not.toContain('不含未打开文件');
  });

  it('扫过的文件全都开着 ⇒ 屏幕上根本没有项目级那一簇，标签仍说「已打开」', () => {
    setProjectScanProblems(F1, [mk(F1, 7, 'warning')]);
    setProblems(F1, [mk(F1, 1, 'error')]);
    setProjectScanCoverage(scanCoverage());
    expect(PROBLEM_SCOPE.label).toBe('已打开');
  });

  it('扫描没跑完（上限 / 取消 / 部分目录）⇒ 措辞里必须留得出来', () => {
    setProjectScanProblems(F2, [mk(F2, 1, 'error')]);
    setProjectScanCoverage(scanCoverage({ scanned: 40, total: 320, capped: true }));
    expect(PROBLEM_SCOPE.label).toBe('部分扫描');
    expect(PROBLEM_SCOPE.title).toContain('覆盖 40/320');
    expect(PROBLEM_SCOPE.title).toContain('到批量上限即停');
    setProjectScanCoverage(scanCoverage({ status: 'cancelled', scanned: 3, total: 320, capped: false }));
    expect(PROBLEM_SCOPE.label).toBe('部分扫描');
    expect(PROBLEM_SCOPE.title).toContain('已取消');
    setProjectScanCoverage(scanCoverage({ status: 'running', scanned: 1, total: 12, capped: false }));
    expect(PROBLEM_SCOPE.label).toBe('扫描中');
  });

  it('降级也在这句话里：读不动的、越界拒读的、待复核的，都点名到数字', () => {
    setProjectScanProblems(F2, [mk(F2, 1, 'error')]);
    setProjectScanCoverage(scanCoverage({ skipped: 3, outOfRoots: 2, degraded: 1 }));
    clearProblems(F3); // 排进一个待复核
    const t = PROBLEM_SCOPE.title;
    for (const phrase of [
      '3 个文件读不动已跳过',
      '2 个越界路径已拒读',
      '1 个文件的某路诊断方抛错已跳过',
      '1 个文件关标签后待复核',
    ]) {
      expect(t).toContain(phrase);
    }
    expect(projectScanCoverage().skipped).toBe(3);
  });

  it('合并态仍是"一个真相"：状态栏 = 面板表头 = 组头 = 树', () => {
    setProblems(F1, [mk(F1, 1, 'error'), mk(F1, 2, 'warning')]);
    setProjectScanProblems(F2, [mk(F2, 3, 'error')]);
    setProjectScanProblems(F3, [mk(F3, 1, 'warning'), mk(F3, 2, 'warning')]);
    setProjectScanCoverage(scanCoverage());
    const status = statusCounts(renderToStaticMarkup(h(ProblemsStatusItem, { onClick: () => {} })));
    const panel = renderToStaticMarkup(h(ProblemPanel, { onReveal: () => {} }));
    expect(status).toEqual({ error: 2, warning: 3, info: 0 });
    expect(headerCounts(panel)).toEqual(status);
    expect(groupHeadCounts(panel)).toEqual(status);
    expect(treeTotals()).toEqual({ error: 2, warning: 3, info: 0, badges: 1 });
  });

  it('覆盖读数逐字段比对后才通知（每批一次的写入不该炸渲染）', () => {
    let fired = 0;
    const un = subscribe(() => {
      fired++;
    });
    setProjectScanCoverage(scanCoverage());
    setProjectScanCoverage(scanCoverage());
    expect(fired).toBe(1);
    setProjectScanCoverage(scanCoverage({ scanned: 5 }));
    expect(fired).toBe(2);
    un();
  });
});

describe('静态闸：计数与配色都不许有第二条腿', () => {
  const panel = read('../src/ui/ProblemPanel.tsx');
  const tree = read('../src/ui/FileTree.tsx');
  /** PERF 批：树侧的计数与折表搬到「按节点订阅」的视图层（宿主不再碰诊断） */
  const view = read('../src/ui/file-tree-problem-view.ts');
  const store = read('../src/ui/problem-store.ts');

  it('消费面不再自己数严重度（逐条 `severity === ...` 的折算只许住在 store 里）', () => {
    for (const [name, src] of [
      ['ProblemPanel.tsx', panel],
      ['FileTree.tsx', tree],
      ['file-tree-problem-view.ts', view],
    ] as const) {
      expect(src.match(/severity === 'error'/g) ?? [], `${name}: 又抄了一份计数循环`).toHaveLength(0);
    }
    expect(panel, 'ProblemPanel: 计数只许来自 summarizeProblems').toContain('summarizeProblems');
    expect(view, 'file-tree-problem-view: 计数只许来自 summarizeProblems').toContain('summarizeProblems');
    expect(store).toContain('export function summarizeProblems');
    expect(store).toContain('counts[it.severity]++');
  });

  it('严重度配色单源：三处都读 SEVERITY_TINT，谁都不许自带十六进制', () => {
    const hexes = (src: string): string[] => src.match(/#[0-9a-f]{6}/gi) ?? [];
    expect(hexes(panel), 'ProblemPanel 里写死了色值').toEqual([]);
    expect(hexes(tree), 'FileTree 里写死了色值').toEqual([]);
    expect(hexes(store).length).toBeGreaterThanOrEqual(3);
    expect(panel).toContain('SEVERITY_TINT');
    expect(tree).toContain('SEVERITY_TINT');
    // 面板组头的数字来自派生，不再吃 `groupProblems` 自带的 counts（那是第二把尺子）
    expect(panel).toContain('filteredSummary.byPath.get(g.path)');
    expect(panel).not.toContain('g.counts.');
  });

  it('范围标签单源：只有 store 写着那三个字，JSX 里只留引用', () => {
    expect(store).toMatch(/label:\s*'已打开'/);
    expect(panel.match(/>本文件</g) ?? []).toHaveLength(0);
    expect(
      panel.match(/<span className="sb-scope-tag">\{PROBLEM_SCOPE\.label\}<\/span>/g) ?? [],
    ).toHaveLength(2);
    expect((panel.match(/title=\{PROBLEM_SCOPE\.title\}/g) ?? []).length).toBe(2);
  });

  it('上账只有一条腿：项目级那一簇的写入原语住在 store，采集器只交类型、不碰写盘', () => {
    const scanner = read('../src/ui/project-diagnostics.ts');
    expect(store).toContain('export function setProjectScanProblems');
    expect(store).toContain("export type ProblemOrigin = 'open-file' | 'project-scan'");
    expect(scanner).toContain("from './problem-store'");
    // 采集器不自己记账：上哪一簇由宿主注入的 publish 决定（账本仍只有 store 那一个）
    expect(scanner).not.toMatch(/setProjectScanProblems\(|setProblems\(/);
    // 只读诊断：一个写文件的口子都不许有
    expect(scanner).not.toMatch(/writeFile|saveFile|exportFile|invoke\(/);
  });

  it('采集器的迟到防护有判据本体（每个 await 之后先认世代，才许有外部效果）', () => {
    const scanner = read('../src/ui/project-diagnostics.ts');
    expect(scanner).toContain('const stale = ()');
    expect((scanner.match(/if \(stale\(\)\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(scanner).toContain('outcome.discarded++');
  });
});
