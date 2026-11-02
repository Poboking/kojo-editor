import { describe, expect, it, vi } from 'vitest';
import type { CharaInfo, FileIO, GameProject } from '@kojo/plugin-api';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import {
  createPackageActions,
  KOJO2_NOTICE_MAX_PATHS,
  KOJO2_PROBE_FAILED_NOTICE,
  KOJO2_TITLE_MAX_PATHS,
  deployOkText,
  exportDialogTitle,
  exportOkText,
  kojo2UntranspiledNotice,
  planArtifacts,
  type ArtifactPlan,
  type Kojo2UntranspiledSource,
  type KojoCompiler,
} from '../src/index';
import { createDeployKojoWizard, type DeployKojoWizardDeps } from '../src/deploy-wizard';

/**
 * 发布诚实闸的**屏上文案**（KW-1，2026-11-02）。
 *
 * 闸要拦的是"导出成功 / 部署成功却什么都没进游戏"，所以判据必须钉在**作者看得见的那几句**上，
 * 而不是只钉计划里那个数组。三件事分开守：
 * 1. **有 2.0 源 ⇒ 点名**：确认框（导出腿 = 系统保存对话框标题，这一腿唯一的确认面；
 *    部署腿 = 向导里的 `.wizard-warn`）说清"几份 / 不会被转译 / 游戏读不到"并列出相对路径；
 * 2. **零 2.0 源 ⇒ 逐字不变**：两腿屏上每一句都与改前历史文案一字不差（旧消费方零改动的自证）；
 * 3. **出路不剥夺**：按钮照旧可点、部署照旧能成——拦的是"以为装好了"，不是"不许发"。
 *
 * 部署向导是 hooks + `createElement`，本包**刻意不引 react-dom**（房规见
 * `projects-panel-lifecycle.test.ts`）：三个 hook 换平凡 shim 后直接调组件函数拿元素树。
 */

let cells: unknown[] = [];
let cursor = 0;
let effectCells: unknown[][] = [];
let effectCursor = 0;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown): [unknown, (v: unknown) => void] => {
      const i = cursor++;
      if (i >= cells.length) {
        cells[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      }
      // **不**自动重渲染：本闸门的点名来自 effect 里的异步核对，
      // 由用例自己"渲一次 → 冲一拍 → 再渲一次"，避免 setter 触发重入死循环。
      return [
        cells[i],
        (v: unknown): void => {
          cells[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(cells[i]) : v;
        },
      ];
    },
    useRef: (init: unknown): { current: unknown } => ({ current: init }),
    useEffect: (fn: () => unknown, deps?: unknown[]): void => {
      const i = effectCursor++;
      const prev = effectCells[i] as unknown[] | undefined;
      const depList = deps ?? [];
      const same = prev !== undefined && prev.length === depList.length && prev.every((v, k) => v === depList[k]);
      if (same) return; // 与真 React 同口径：依赖没变就不重跑（否则每次渲都把已核完的清单抹回空）
      effectCells[i] = [...depList];
      fn();
    },
    useMemo: (factory: () => unknown): unknown => factory(),
  };
});

/* --------------------------- 元素树小工具（同目录房规） --------------------------- */

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
const warnTexts = (nodes: FakeNode[]): string[] =>
  nodes.filter((n) => has(n, 'wizard-warn')).map((n) => n.text);
/** 元素树的**逐字快照**（"这一格没接 ⇒ 窗口与历史一字不差"就靠它比对） */
const shape = (nodes: FakeNode[]): string[] => nodes.map((n) => `${String(n.type)}|${n.className}|${n.text}`);

/* --------------------------- 制品计划替身（真函数，不编数据） --------------------------- */

const enc = new TextEncoder();
const NAME = '东方口上-灵梦 v1.0';
const PKG_DIR = `/appdata/workspaces/p1/${NAME}`;
const TARGET = 'D:/发布/东方口上-灵梦 v1.0.zip';
const DEPLOY_DIR = 'C:/game/kojo/001 灵梦/东方口上-灵梦 v1.0';
const fakeCompile: KojoCompiler = (source, label) => ({
  bytes: enc.encode(`; from ${label}\n${source}`),
  transpile: { erb: `; from ${label}\n${source}`, sourceMap: [], diagnostics: [] },
});
/** 用**真的** `planArtifacts` 造计划：闸读的就是这一枚字段，不在用例里手搓形状 */
const planOf = (rels: readonly string[]): ArtifactPlan =>
  planArtifacts(rels.map((relPath) => ({ relPath, bytes: enc.encode('x') })), fakeCompile);
const itemsOf = (plan: ArtifactPlan): readonly Kojo2UntranspiledSource[] => plan.untranspiledKojo2;

const KOJO2_PLAN = planOf(['事件.kojo', '子/日常.kojo']);
const MANY_KOJO2_PLAN = planOf(['a.kojo', 'b.kojo', 'c.kojo', 'd.kojo']);
const CLEAN_PLAN = planOf(['事件.kojo1', '说明.txt']);

/* ============================ ① 导出腿（对话框标题 + 结果通知） ============================ */

describe('① 导出腿：确认面与结果通知', () => {
  it('控制器把点名递进系统保存对话框的标题（这一腿唯一的确认面；取消照旧是不发）', async () => {
    const titles: string[] = [];
    const io = {
      walkDir: async () =>
        ['正文.kojo', '子/日常.kojo', '事件.kojo1'].map((rel) => ({
          name: rel,
          path: `${PKG_DIR}/${rel}`,
          isDirectory: false,
        })),
      readBytes: async () => enc.encode('x'),
      exportFile: async (_fileName: string, _bytes: Uint8Array, opts?: { title?: string }) => {
        titles.push(opts?.title ?? '');
        return null; // 作者取消：标题已经说过话了，这里不验证落盘
      },
    } as unknown as FileIO;
    const actions = createPackageActions({
      io,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      notify: () => {},
      compileKojo: fakeCompile,
    });
    actions.exportArtifact(PKG_DIR, NAME);
    await vi.waitFor(
      () => {
        if (actions.status()?.kind === 'busy') throw new Error('仍在忙碌');
      },
      { timeout: 3000, interval: 5 },
    );
    expect(titles).toHaveLength(1);
    expect(titles[0]).toBe(exportDialogTitle(NAME, planOf(['事件.kojo1', '正文.kojo', '子/日常.kojo'])));
    expect(titles[0]).toContain(`导出「${NAME}」为…`);
    expect(titles[0]).toContain('本包含 2 份');
  });

  it('零 2.0 源 ⇒ 对话框标题与历史逐字相同', () => {
    expect(exportDialogTitle(NAME, CLEAN_PLAN)).toBe(`导出「${NAME}」为…`);
  });

  it('有 2.0 源 ⇒ 标题点名数量、扩展名与"不会被转译 / 游戏读不到"，并列出相对路径', () => {
    const title = exportDialogTitle(NAME, KOJO2_PLAN);
    expect(title).toContain(`导出「${NAME}」为…`); // 原句一字不动，只在后面追加
    expect(title).toContain('本包含 2 份');
    expect(title).toContain(KOJO_SOURCE_EXTENSION);
    expect(title).toContain('不会被转译');
    expect(title).toContain('游戏读不到');
    expect(title).toContain('事件.kojo');
    expect(title).toContain('子/日常.kojo');
  });

  it('窄面只点前几枚、宽面列全（标题淹不起，通知也不必"另有未列出"）', () => {
    const title = exportDialogTitle(NAME, MANY_KOJO2_PLAN);
    expect(title).toContain('本包含 4 份');
    expect(title).toContain('a.kojo');
    expect(title).toContain('b.kojo');
    expect(title).not.toContain('c.kojo');
    expect(title).toContain(`另有 ${MANY_KOJO2_PLAN.untranspiledKojo2.length - KOJO2_TITLE_MAX_PATHS} 份未列出`);
    const text = exportOkText(NAME, TARGET, MANY_KOJO2_PLAN);
    expect(text).toContain('c.kojo');
    expect(text).toContain('d.kojo');
    expect(text).not.toContain('未列出');
    expect(KOJO2_TITLE_MAX_PATHS).toBeLessThan(KOJO2_NOTICE_MAX_PATHS);
  });

  it('零 2.0 源 ⇒ 成功通知与历史逐字相同（旧消费方零改动的自证）', () => {
    expect(exportOkText(NAME, TARGET, CLEAN_PLAN)).toBe(
      `已导出「${NAME}」1 个 .kojo1 转译为 .ERB、1 个文件原样打包 → ${TARGET}`,
    );
  });

  it('有 2.0 源 ⇒ 成功通知不再是光秃秃的一句，数量与清单都在', () => {
    const text = exportOkText(NAME, TARGET, KOJO2_PLAN);
    expect(text).toContain(`已导出「${NAME}」`); // 原句保留（转译数 / 原样数 / 落点一个不少）
    expect(text).toContain(TARGET);
    expect(text).toContain(`本包含 ${KOJO2_PLAN.untranspiledKojo2.length} 份 Kojo 2.0 源`);
    expect(text).toContain('子/日常.kojo');
    // 两腿同一枚 builder：通知里点名的那一段必须与向导里的完全同一句
    expect(text).toContain(kojo2UntranspiledNotice(itemsOf(KOJO2_PLAN))!);
  });
});

/* ============================ ② 部署腿（结果通知与导出腿同形） ============================ */

describe('② 部署腿：结果通知与确认框同一份清单', () => {
  it('零 2.0 源 ⇒ 与历史逐字相同', () => {
    expect(deployOkText(NAME, DEPLOY_DIR, 2, [])).toBe(`已部署「${NAME}」2 个文件 → ${DEPLOY_DIR}`);
  });

  it('有 2.0 源 ⇒ 带上与导出腿**同一枚 builder 产出**的那一句（不各抄一套判据）', () => {
    const items = itemsOf(KOJO2_PLAN);
    const text = deployOkText(NAME, DEPLOY_DIR, 2, items);
    expect(text).toContain(`已部署「${NAME}」2 个文件 → ${DEPLOY_DIR}`);
    expect(text).toContain(`本包含 ${items.length} 份 Kojo 2.0 源`);
    expect(text).toContain('不会被转译');
    expect(text).toContain('游戏读不到');
    expect(text.slice(text.indexOf('注意：') + '注意：'.length)).toBe(kojo2UntranspiledNotice(items)!);
  });

  it('核对失败 ⇒ 明说"没能核对"，不冒认这个包干净', () => {
    expect(deployOkText(NAME, DEPLOY_DIR, 2, null)).toContain(KOJO2_PROBE_FAILED_NOTICE);
    expect(deployOkText(NAME, DEPLOY_DIR, 2, null)).not.toContain('没有问题');
  });
});

/* ============================ ③ 部署确认框（向导窗口本体） ============================ */

const chara: CharaInfo = { no: 1, name: '灵梦', kojoDir: 'C:/game/kojo/001 灵梦' };
const gameProject = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: ['C:/game/kojo'],
  writablePaths: [],
  charaIndex: new Map<number, CharaInfo>([[1, chara]]),
} as unknown as GameProject;
const PENDING = { absDir: '/appdata/workspaces/p1/包', dirName: NAME, displayName: NAME, charaNo: 1 };

function wizardDeps(over: Partial<DeployKojoWizardDeps> = {}): DeployKojoWizardDeps {
  return {
    gameProject: () => gameProject,
    writable: () => true,
    checkTargetExists: async () => false,
    pending: () => PENDING,
    clearPending: () => {},
    close: () => {},
    deploy: async () => true,
    ...over,
  };
}

/**
 * 挂载部署向导：`mount` 清一次 hook 位，`draw` 只把游标归零（**状态位留着**）——
 * 点名是 effect 里异步核对回来的，靠"渲一次 → 冲一拍 → 再渲一次"才能看见它上屏。
 */
function mountWizard(deps: DeployKojoWizardDeps): { draw: () => FakeNode[] } {
  cells = [];
  cursor = 0;
  effectCells = [];
  effectCursor = 0;
  const component = createDeployKojoWizard(deps);
  return {
    draw: (): FakeNode[] => {
      cursor = 0;
      effectCursor = 0;
      return walk(component());
    },
  };
}

/** 渲一次（让 effect 起飞）→ 冲掉核对的 promise → 再渲一次 */
async function drawAfterProbe(deps: DeployKojoWizardDeps): Promise<FakeNode[]> {
  const { draw } = mountWizard(deps);
  draw();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return draw();
}
const primaryButton = (nodes: FakeNode[]): FakeNode | undefined =>
  nodes.find((n) => n.type === 'button' && n.text === '部署到游戏目录');

describe('③ 部署确认框：2.0 源点名上屏，出路不剥夺', () => {
  it('包里有 2.0 源 ⇒ 窗口里出现一条 `.wizard-warn`，正文与导出腿完全同一句', async () => {
    const items = itemsOf(KOJO2_PLAN);
    const nodes = await drawAfterProbe(wizardDeps({ kojo2Sources: async () => items }));
    const warns = warnTexts(nodes);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(kojo2UntranspiledNotice(items));
    expect(warns[0]).toContain('本包含 2 份');
    expect(warns[0]).toContain('不会被转译');
    expect(warns[0]).toContain('游戏读不到');
    expect(warns[0]).toContain('事件.kojo');
  });

  it('包里干净 ⇒ 一条警示都不渲染，整个窗口与"本 adapter 没接这一格"逐字相同', async () => {
    const withProbe = await drawAfterProbe(wizardDeps({ kojo2Sources: async () => [] }));
    const withoutProbe = await drawAfterProbe(wizardDeps());
    expect(warnTexts(withProbe)).toEqual([]);
    expect(shape(withProbe)).toEqual(shape(withoutProbe));
  });

  it('核对失败 ⇒ 上屏的是"没能核对"，不是"这个包没问题"', async () => {
    const nodes = await drawAfterProbe(
      wizardDeps({
        kojo2Sources: async () => {
          throw new Error('读目录失败');
        },
      }),
    );
    expect(warnTexts(nodes)).toEqual([KOJO2_PROBE_FAILED_NOTICE]);
  });

  it('点名之后**按钮照样可点**：闸拦的是"以为装好了"，不是"不许发"', async () => {
    const nodes = await drawAfterProbe(wizardDeps({ kojo2Sources: async () => itemsOf(KOJO2_PLAN) }));
    expect(warnTexts(nodes)).toHaveLength(1);
    const button = primaryButton(nodes);
    expect(button, '部署按钮仍在窗口里').toBeDefined();
    expect(button!.props.disabled).toBeFalsy();
  });
});
