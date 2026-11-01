/**
 * K2-EDITOR-OPEN-PATHS 的判据闸：**flag 开时各打开入口认得 `.kojo2`，flag 关时逐字不变**。
 *
 * 六组断言（对应交付面）：
 * ① 拖放清单：`openableExtensions()` 关 = `OPENABLE_EXT` 逐项相同、悬停文案逐字相同；
 *    开 = 追加 `.kojo2`，`classifyDrop` 收得下（大小写不敏感）。
 * ② 快速打开 / 项目扫描：同一枚 `isQuickOpenSourcePath` 判据（扫描侧刻意复用它，不另写）；
 * ③ 打开入口闸：开关关 = `off` 且一个 port 都不碰；开 + `v1-only` 阶段 = `blocked` 且
 *    人话上屏、**不开空编辑器**（提示取 `kojo2-cutover` 的那一句，不另抄）；
 * ④ 最近文件往返：`.kojo2` 记录能存能读、pathKey 去重同口径、换项目走 `pendingOpenFile`；
 * ⑤ 新建向导：扩展名与模板语言一致（2.0 档 = `# 机` + 带说话人台词，无 v1 文件头）；
 * ⑥ 单源守门：`.kojo2` 字面量在 app 侧只此一处、插件侧零处（扩展名由宿主下传）。
 * `B5B-SINK`：BOARD `SDK-B5b` 两枚"可择机下沉"候选（`isKojo2Path` 与 diagnostics-gate 的
 * 扩展名常量）的判性——今天沉不动，障碍逐条量在账上。
 *
 * 开关用假 `window.localStorage`（`kojo2-wire.test.ts` 同款）：`ui/kojo2-flag.ts` 每次现读，
 * 所以本文件不需要 `resetModules`（`OPENABLE_EXT` 这类静态清单本来也不随开关变）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KOJO_LEGACY_SOURCE_EXTENSION, KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import {
  classifyDrop,
  dropHintText,
  openableExtensions,
  OPENABLE_EXT,
  UNKNOWN_FILE_REASON,
} from '../src/ui/drag-drop';
import {
  isQuickOpenSourcePath,
  listSourceFiles,
  quickOpenSourceExtensions,
  QUICK_OPEN_SOURCE_EXTENSIONS,
} from '../src/ui/commands';
import { routeKojo2OpenPath, kojo2StageBlockedReason } from '../src/ui/kojo2-open-paths';
import { isKojo2Path } from '../src/ui/kojo2-open';
import { decideKojo2Route, KOJO2_FILE_EXTENSION } from '../src/ui/kojo2-cutover';
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang';
import { removeRecentFiles, sanitizeRecentFiles, upsertRecentFile } from '../src/ui/recent-files';
import {
  buildKojo2Template,
  buildTemplate,
  createNewKojoWizard,
  previewFileName,
} from '../../plugins/ui-sugar-editor/src/new-file-wizard';

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
const CURRENT_ROOT = 'D:/proj';
const OTHER_ROOT = 'D:/other';
const KOJO2_FILE = 'D:/proj/chara/M_KOJO_K12_指令.kojo2';

/**
 * 装假 `window.localStorage`（`on` = 缺省档，什么都不存；`off` = 盘上显式一份 `v1-only`
 * 计划）；`ui/kojo2-flag.ts` 每次现读。LAU-3 起缺省档 = `2.0-default`（开关**开着**），
 * 所以"关"必须显式落到阶段上，不能再拿"没存过"当关。
 */
function stubFlag(on: boolean): void {
  const bag = new Map<string, string>();
  if (!on)
    bag.set(
      'kojo.ui.kojo2Cutover.plan.v1',
      JSON.stringify({ version: 2, stage: 'v1-only', overrides: {} }),
    );
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => bag.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        bag.set(key, value);
      },
      removeItem: (key: string): void => {
        bag.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

interface PortCalls {
  readonly files: string[];
  readonly projects: { rootDir: string; pendingOpenFile: string }[];
  readonly notes: string[];
}

function makePorts(): { calls: PortCalls; ports: Parameters<typeof routeKojo2OpenPath>[2] } {
  const calls: PortCalls = { files: [], projects: [], notes: [] };
  return {
    calls,
    ports: {
      openFile: (p) => calls.files.push(p),
      openProject: (rootDir, opts) =>
        calls.projects.push({ rootDir, pendingOpenFile: opts.pendingOpenFile }),
      notify: (message) => calls.notes.push(message),
    },
  };
}

const CTX = { currentRoot: CURRENT_ROOT, projectOpen: true } as const;

/* ───────────────────────── ① 拖放：清单与分类 ───────────────────────── */

describe('① 拖放清单：恒含 2.0 扩展名（看得见文件是语言面），v1 那几类一字不动', () => {
  it('恒含：openableExtensions() = 基线清单 + 2.0 扩展名（`.kojo` + 旧名 `.kojo2`）', () => {
    stubFlag(false);
    expect(openableExtensions()).toEqual([
      ...OPENABLE_EXT,
      KOJO_SOURCE_EXTENSION,
      KOJO2_SOURCE_EXTENSION,
    ]);
    // 基线清单只剩封存层 `.kojo1`；2.0 的两枚由上面那句追加（没有被就地改大）。
    expect(OPENABLE_EXT).toEqual([
      KOJO_LEGACY_SOURCE_EXTENSION,
      '.erb',
      '.erm',
      '.erh',
      '.md',
      '.txt',
    ]);
  });

  it('悬停文案由同一份清单派生（含 2.0 扩展名，不另抄一句）', () => {
    stubFlag(false);
    expect(dropHintText()).toContain(KOJO2_SOURCE_EXTENSION);
    expect(dropHintText()).toBe(
      `松手就能打开：${[...OPENABLE_EXT, KOJO_SOURCE_EXTENSION, KOJO2_SOURCE_EXTENSION].join(' / ')}`,
    );
  });

  it('拖入 .kojo2 / .KOJO2 收得下（开关关也一样：文件在磁盘上，看得见才打得开）', () => {
    stubFlag(false);
    const dropped = classifyDrop(['D:/proj/a.kojo2', 'D:/proj/b.KOJO2', 'D:/proj/c.kojo', 'D:/proj/d.md']);
    expect(dropped.files).toEqual(['D:/proj/a.kojo2', 'D:/proj/b.KOJO2', 'D:/proj/c.kojo', 'D:/proj/d.md']);
    expect(dropped.rejected).toEqual([]);
  });

  it('开关开 / 关两份清单与文案逐字相同（可见性不随切流变）', () => {
    stubFlag(false);
    const off = { ext: openableExtensions(), hint: dropHintText() };
    stubFlag(true);
    expect(openableExtensions()).toEqual(off.ext);
    expect(dropHintText()).toBe(off.hint);
  });
});

/* ─────────────────── ② 快速打开 / 项目扫描（同一枚判据） ─────────────────── */

describe('② 快速打开与项目扫描：后缀判据同一份、项目扫描只是复用', () => {
  /** 假的 `walkDir`（形状同 `commands.listSourceFiles` 的注入 seam） */
  const fakeWalk = async (
    root: string,
    opts?: { filter?: (entry: { name: string; isDirectory: boolean }) => boolean },
  ): Promise<{ name: string; path: string; isDirectory: boolean }[]> => {
    const entries = [
      { name: 'a.kojo', path: `${root}/a.kojo`, isDirectory: false },
      { name: 'b.kojo2', path: `${root}/b.kojo2`, isDirectory: false },
      { name: 'c.md', path: `${root}/c.md`, isDirectory: false },
    ];
    return opts?.filter === undefined ? entries : entries.filter((e) => opts.filter!(e));
  };

  it('quickOpenSourceExtensions() = 基线清单 + 2.0 扩展名', () => {
    stubFlag(false);
    expect(quickOpenSourceExtensions()).toEqual([
      ...QUICK_OPEN_SOURCE_EXTENSIONS,
      KOJO_SOURCE_EXTENSION,
      KOJO2_SOURCE_EXTENSION,
    ]);
  });

  it('2.0 文件是源文件（Ctrl+P 与项目扫描都看得见它；开关关也一样）', () => {
    stubFlag(false);
    expect(isQuickOpenSourcePath('D:/proj/b.kojo2')).toBe(true);
    expect(isQuickOpenSourcePath('D:/proj/B.KOJO2')).toBe(true);
    expect(isQuickOpenSourcePath('D:/proj/a.kojo')).toBe(true);
    expect(isQuickOpenSourcePath('D:/proj/a.kojo1')).toBe(true);
    expect(isQuickOpenSourcePath('D:/proj/A.KOJO1')).toBe(true);
  });

  it('listSourceFiles（项目扫描那条列举）含 2.0 文件，md 仍不收', async () => {
    stubFlag(false);
    await expect(listSourceFiles(fakeWalk, [CURRENT_ROOT])).resolves.toEqual([
      `${CURRENT_ROOT}/a.kojo`,
      `${CURRENT_ROOT}/b.kojo2`,
    ]);
  });

  it('开关开 / 关两份清单逐字相同（扫描面不随切流变）', () => {
    stubFlag(false);
    const off = quickOpenSourceExtensions();
    stubFlag(true);
    expect(quickOpenSourceExtensions()).toEqual(off);
  });
});

/* ─────────────────── ③ 打开入口闸：off / open / open-project / blocked ─────────────────── */

describe('③ 打开入口闸：开关关零副作用，v1-only 阶段显式 blocked 并说人话', () => {
  it('isKojo2Path 只认最后一段扩展名（x.kojo2.bak 不算、大小写不敏感）', () => {
    expect(isKojo2Path('D:/proj/a.kojo2')).toBe(true);
    expect(isKojo2Path('D:/proj/A.KOJO2')).toBe(true);
    // LAU-3b-FLIP：`.kojo` 是 2.0 的主扩展名，当然算。
    expect(isKojo2Path('D:/proj/a.kojo')).toBe(true);
    expect(isKojo2Path('D:/proj/A.KOJO')).toBe(true);
    expect(isKojo2Path('D:/proj/a.kojo2.bak')).toBe(false);
    expect(isKojo2Path('D:/proj/a.kojo1')).toBe(false);
  });

  it('开关关：routeKojo2OpenPath 返回 off，且 openFile / openProject / notify 一次都不调', () => {
    stubFlag(false);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath({ path: KOJO2_FILE, rootDir: CURRENT_ROOT }, CTX, ports);
    expect(plan).toEqual({ kind: 'off' });
    expect(calls).toEqual({ files: [], projects: [], notes: [] });
  });

  it('开关关：阶段闸恒 null（连判据都不进）', () => {
    stubFlag(false);
    expect(kojo2StageBlockedReason(KOJO2_FILE)).toBeNull();
  });

  it('开关开 + 非 2.0 文件：返回 not-kojo2，端口零调用（封存层一点没被接管）', () => {
    stubFlag(true);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath({ path: 'D:/proj/a.kojo1', rootDir: CURRENT_ROOT }, CTX, ports);
    expect(plan).toEqual({ kind: 'not-kojo2' });
    expect(calls).toEqual({ files: [], projects: [], notes: [] });
    expect(kojo2StageBlockedReason('D:/proj/a.kojo1', { enabled: true, stage: 'v1-only' })).toBeNull();
  });

  it('开关开 + dual + 当前项目内：直接走 openFile（不开项目）', () => {
    stubFlag(true);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath({ path: KOJO2_FILE, rootDir: CURRENT_ROOT }, CTX, ports, {
      enabled: true,
      stage: 'dual',
    });
    expect(plan).toEqual({ kind: 'open', path: KOJO2_FILE });
    expect(calls.files).toEqual([KOJO2_FILE]);
    expect(calls.projects).toEqual([]);
  });

  it('开关开 + 2.0-default + 别的项目：先开项目并排 pendingOpenFile（最近文件那条腿）', () => {
    stubFlag(true);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath(
      { path: KOJO2_FILE, rootDir: OTHER_ROOT },
      { currentRoot: CURRENT_ROOT, projectOpen: true },
      ports,
      { enabled: true, stage: '2.0-default' },
    );
    expect(plan).toEqual({ kind: 'open-project', rootDir: OTHER_ROOT, pendingOpenFile: KOJO2_FILE });
    expect(calls.projects).toEqual([{ rootDir: OTHER_ROOT, pendingOpenFile: KOJO2_FILE }]);
    expect(calls.files).toEqual([]);
  });

  it('开关开 + 没项目可投递：blocked + 人话（batch-3 的 NO_PROJECT 文案原样上屏）', () => {
    stubFlag(true);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath(
      { path: KOJO2_FILE },
      { currentRoot: null, projectOpen: false },
      ports,
      { enabled: true, stage: 'dual' },
    );
    expect(plan.kind).toBe('blocked');
    expect(calls.notes).toHaveLength(1);
    expect(calls.files).toEqual([]);
    expect(calls.projects).toEqual([]);
  });

  it('v1-only 阶段：`.kojo2` 不再 blocked（语言面无条件），照常打开', () => {
    stubFlag(true);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath({ path: KOJO2_FILE, rootDir: CURRENT_ROOT }, CTX, ports, {
      enabled: true,
      stage: 'v1-only',
    });
    const decision = decideKojo2Route({ stage: 'v1-only', filePath: KOJO2_FILE });
    expect(decision.kind).toBe('resolved');
    expect(plan.kind).not.toBe('blocked');
    expect(calls.notes).toEqual([]);
  });

  it('阶段闸只拦「把 .kojo 显式钉成 2.0」：`.kojo2` 在任何阶段都不给 blocked 提示', () => {
    stubFlag(true);
    expect(kojo2StageBlockedReason(KOJO2_FILE, { enabled: true })).toBeNull();
    expect(kojo2StageBlockedReason(KOJO2_FILE, { enabled: true, stage: 'v1-only' })).toBeNull();
    expect(kojo2StageBlockedReason(KOJO2_FILE, { enabled: true, stage: 'dual' })).toBeNull();
  });

  it('开关开：最近文件点开的 .kojo2 落到 2.0 语言面（不在"空编辑器/plaintext"上）', async () => {
    stubFlag(true);
    // `languages.ts` 在模块求值那一刻读开关 ⇒ 重装模块才等于"重载窗口"（同 kojo2-wire）
    vi.resetModules();
    const languages = await import('../src/monaco/languages');
    expect(languages.languageForPath(KOJO2_FILE)).toBe(KOJO2_LANGUAGE_ID);
  });

  it('开关关：同一路径仍落到 2.0 只读语言面（语言面常开，开关只门控写回/迁移）', async () => {
    stubFlag(false);
    vi.resetModules();
    const languages = await import('../src/monaco/languages');
    expect(languages.languageForPath(KOJO2_FILE)).toBe(KOJO2_LANGUAGE_ID);
    vi.resetModules();
  });
});

/* ───────────────────────── ④ 最近文件往返 ───────────────────────── */

describe('④ 最近文件：.kojo2 记录能往返、能按记录里的根开', () => {
  it('往返：upsert → 读回仍是同一条（路径按 pathKey 归一，大小写不同不产生第二行）', () => {
    const saved = upsertRecentFile([], { path: KOJO2_FILE, rootDir: CURRENT_ROOT, now: 1 });
    const again = upsertRecentFile(saved, {
      path: 'd:/PROJ/chara/M_KOJO_K12_指令.kojo2',
      rootDir: CURRENT_ROOT,
      now: 2,
    });
    expect(again).toHaveLength(1);
    expect(again[0]!.openedAt).toBe(2);
    const reread = sanitizeRecentFiles(JSON.parse(JSON.stringify(again)));
    expect(reread).toEqual(again);
    expect(reread[0]!.path).toBe('d:/PROJ/chara/M_KOJO_K12_指令.kojo2');
  });

  it('删一个 .kojo2 记录：只摘它自己（同目录的 .kojo 记录留着）', () => {
    const list = [
      { path: KOJO2_FILE, rootDir: CURRENT_ROOT, openedAt: 2 },
      { path: 'D:/proj/chara/同目录.kojo', rootDir: CURRENT_ROOT, openedAt: 1 },
    ];
    expect(removeRecentFiles(list, [KOJO2_FILE])).toEqual([list[1]]);
  });

  it('从记录点开（根 = 记录里那个）：走 openProject 并带上这份 .kojo2 作 pendingOpenFile', () => {
    stubFlag(true);
    const records = sanitizeRecentFiles([
      { path: KOJO2_FILE, rootDir: OTHER_ROOT, openedAt: 1 },
    ]);
    const { calls, ports } = makePorts();
    const plan = routeKojo2OpenPath(
      { path: records[0]!.path, rootDir: records[0]!.rootDir },
      { currentRoot: null, projectOpen: false },
      ports,
      { enabled: true, stage: 'dual' },
    );
    expect(plan).toEqual({
      kind: 'open-project',
      rootDir: OTHER_ROOT,
      pendingOpenFile: KOJO2_FILE,
    });
    expect(calls.projects).toEqual([{ rootDir: OTHER_ROOT, pendingOpenFile: KOJO2_FILE }]);
  });
});

/* ───────────────────────── ⑤ 新建向导：扩展名与模板同语言 ───────────────────────── */

describe('⑤ 新建向导：2.0 档的扩展名与模板语言一致（扩展名由宿主下传）', () => {
  it('previewFileName 缺省 = kojo1 档的 .kojo1；传入 2.0 扩展名就产出 .kojo / .kojo2', () => {
    // LAU-3b-FLIP：1.x 档产出封存档（`.kojo1`），`.kojo` 归 2.0 由宿主下传。
    expect(previewFileName('M_KOJO_K{n}', 12, '破空')).toBe('M_KOJO_K12_破空.kojo1');
    expect(previewFileName('M_KOJO_K{n}', 12, '破空', KOJO_SOURCE_EXTENSION)).toBe(
      'M_KOJO_K12_破空.kojo',
    );
    expect(previewFileName('M_KOJO_K{n}', 12, '破空', KOJO2_SOURCE_EXTENSION)).toBe(
      'M_KOJO_K12_破空.kojo2',
    );
    expect(previewFileName('M_KOJO_K{n}', 12, '', KOJO2_SOURCE_EXTENSION)).toBe('M_KOJO_K12.kojo2');
  });

  it('2.0 模板：整行 // 注释 + # 机 挂点 + 带说话人的台词（没有 v1 的 角色:/口上: 头）', () => {
    const text = buildKojo2Template({
      charNo: 12,
      charName: '露米娅',
      family: '破空',
      face: '指令',
      faceIndex: '310',
    });
    expect(text.split('\n')).toContain('// 露米娅（12） · 破空');
    expect(text.split('\n')).toContain('# 机 指令 310');
    expect(text).toContain('露米娅：「……」');
    expect(text).not.toContain('角色:');
    expect(text).not.toContain('口上:');
    expect(text).not.toContain('时机 ');
  });

  it('2.0 模板：没选分野就只留文件头注释（不产出一个挂不上事件的正文）', () => {
    const text = buildKojo2Template({
      charNo: 12,
      charName: '露米娅',
      family: '',
      face: null,
      faceIndex: '',
    });
    expect(text).toBe('// 露米娅（12）\n');
    expect(text).not.toContain('# 机');
  });

  it('2.0 模板：编号只在作者填了才进 # 机（空白不落字）', () => {
    const base = { charNo: 49, charName: '古明地觉', family: '', face: '初见' };
    expect(buildKojo2Template({ ...base, faceIndex: '' })).toContain('# 机 初见\n');
    expect(buildKojo2Template({ ...base, faceIndex: '  ' })).toContain('# 机 初见\n');
    expect(buildKojo2Template({ ...base, faceIndex: ' 310 ' })).toContain('# 机 初见 310\n');
  });

  it('1.x 模板一字未动（同一输入产出改动前那条逐字文本）', () => {
    expect(
      buildTemplate({ charNo: 12, charName: '露米娅', family: '', face: '初见', faceIndex: '310' }),
    ).toBe('; 露米娅（12）\n角色: 12\n\n时机 初见 310：\n    「……」\n');
  });
});

/* ───────────────────────── ⑥ 向导界面（宿主下传面决定有没有那一行） ───────────────────────── */

describe('⑥ 新建向导界面：2.0 选项只在宿主下传 2.0 面时出现', () => {
  /** 最小 deps：一张分野表 + 一个角色 + 一个落点（向导是纯渲染，不落盘） */
  function wizardDeps(): Parameters<typeof createNewKojoWizard>[0] {
    const gameProject = {
      rootDir: 'D:/proj',
      adapterId: 'test-adapter',
      kojoPaths: [] as string[],
      writablePaths: [] as string[],
      charaIndex: new Map([[12, { no: 12, name: '露米娅' }]]),
    };
    const faceTable = {
      faces: {
        初见: { template: 'M_KOJO_ENCOUNTER_K{n}' },
        指令: { template: 'M_KOJO_MESSAGE_K{n}_{i}' },
      },
      registration: { declare: 'M_KOJO_K{n}' },
    };
    const artifact = { id: 'a1', name: '包', dirName: '包', meta: {}, createdAt: 1 };
    return {
      project: { current: () => gameProject },
      slots: { query: () => [{ id: 'ad', adapter: { gameId: 'test-adapter', kojoFaceTemplates: faceTable } }] },
      flow: {
        subscribe: () => () => {},
        state: () => ({
          projects: [{ id: 'p1', name: '口上', createdAt: 1, updatedAt: 1, artifacts: [artifact], meta: {} }],
          loading: false,
          error: null,
        }),
        reload: () => {},
        landingDir: () => 'D:/ws/p1/包',
        takeNotice: () => null,
        handoffToNewProject: () => {},
      },
      close: () => {},
      reveal: () => {},
    } as unknown as Parameters<typeof createNewKojoWizard>[0];
  }

  /** 把 `UIPanelComponent`（返回 `unknown`）收成本次渲染要的 React 形状——只为 `h()` 的类型检查 */
  function renderWizard(props: { uiPrefs?: { kojo2?: { extension: string } } }): string {
    const Wizard = createNewKojoWizard(wizardDeps()) as unknown as (
      p: typeof props,
    ) => ReactElement;
    return renderToStaticMarkup(h(Wizard, props));
  }

  it('宿主没下传 uiPrefs：界面里没有"2.0 口上文件"这一项（改动前逐字）', () => {
    const html = renderWizard({});
    // 整行「文件格式」都不该出现（不是"出现但只有 1.x"）：开关关着 ⇒ 表单与改动前逐字相同
    expect(html).not.toContain('文件格式');
    expect(html).not.toContain('1.x 口上文件');
    expect(html).not.toContain('2.0 口上文件');
    expect(html).toContain('M_KOJO_K12.kojo');
  });

  it('宿主下传 2.0 面：多出"2.0 口上文件"一项，且标的就是宿主给的那个扩展名', () => {
    const html = renderWizard({ uiPrefs: { kojo2: { extension: '.kojo2' } } });
    expect(html).toContain('1.x 口上文件');
    expect(html).toContain(`2.0 口上文件（${KOJO2_SOURCE_EXTENSION}）`);
    // 缺省档仍是 1.x：多出来的只是"可选项"，不是把缺省改掉
    expect(html).toContain('M_KOJO_K12.kojo');
  });
});

/* ───────────────────────── ⑦ 单源守门 ───────────────────────── */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 递归列某目录下的 .ts/.tsx（守卫自己不在 src 里，不会被扫到） */
function sourceFiles(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(e.name)) out.push(child);
    }
  };
  walk(rel);
  return out;
}

/** 手抄的 `.kojo2` 字面量（引号包住的裸扩展；散文里的反引号不算抄判据） */
const KOJO2_EXT_LITERAL = /["']\.kojo2["']/i;

describe('⑥ 单源守门：.kojo2 字面量只住在语言面库那一处，宿主与插件侧零处', () => {
  it('app/src 里手写 .kojo2 字面量 = 零处（B1 后整枚下沉到 @kojo/kojo-lang）', () => {
    const hits = sourceFiles('packages/app/src')
      .filter((rel) => KOJO2_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')))
      .sort();
    expect(hits).toEqual([]);
  });

  it('语言面库里恰好一处（地址换了，独一性没换）', () => {
    const hits = sourceFiles('packages/kojo-lang/src').filter((rel) =>
      KOJO2_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')),
    );
    expect(hits).toEqual(['packages/kojo-lang/src/constants.ts']);
  });

  it('插件侧（ui-sugar-editor）零 .kojo2 字面量：向导只消费宿主下传的扩展名', () => {
    const hits = sourceFiles('packages/plugins/ui-sugar-editor/src').filter((rel) =>
      KOJO2_EXT_LITERAL.test(readFileSync(path.join(ROOT, rel), 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  it('三个消费点对拍同一枚值：常量叶 / 路由层 / 宿主下传面（改扩展名只改一处）', () => {
    expect(KOJO2_SOURCE_EXTENSION).toBe('.kojo2');
    expect(KOJO2_FILE_EXTENSION).toBe(KOJO2_SOURCE_EXTENSION);
    expect(isKojo2Path(`D:/x/a${KOJO2_SOURCE_EXTENSION}`)).toBe(true);
  });
});

/* ───────────────── B5B-SINK：BOARD SDK-B5b 两枚"可择机下沉"候选的判性 ───────────────── */

/**
 * BOARD `SDK-B5b` 卡原文：宿主语言面残留只剩 5 枚宿主事实，「仅 diagnostics-gate 的扩展名
 * 常量与 `isKojo2Path` 可择机下沉」。本组把这两枚逐条判性、钉成红得了的判据——**判据不搬家、
 * 不改写、不放宽**，只把"今天为什么沉不动"量出来（形状照 `erb-preproc-single-source.test.ts`
 * 的 `B5B-C-DEBT`）。
 *
 * 下沉的三条**合取**闸：① 零 Monaco、② 零宿主事实（项目 / 路径 / 设置这类宿主知识）、
 * ③ 单消费者。逐枚结论：
 *
 * - `isKojo2Path`（`ui/kojo2-open.ts`）：① ✓、② ✓（本体只做扩展名比对）、③ ✗（6 个宿主模块
 *   消费）。更硬的障碍：两枚扩展名字面源分住两个包——`.kojo` 的定义在 `@kojo/plugin-api`
 *   （`sugar.ts`），`.kojo2` 的唯一字面源 `kojo-lang/src/constants.ts` 必须保持零 import，
 *   而 `@kojo/kojo-lang` 连 `@kojo/plugin-api` 的依赖都没有 ⇒ **没有既有叶子能同时拿到两枚
 *   字面源**。任何"下沉"要么让语言包依赖契约桶（分层破），要么把清单抄第二份（单源破）。
 * - diagnostics-gate 的扩展名常量：它们由 `ui/kojo2-cutover.ts` 从契约 / 零依赖叶子**现算**，
 *   不是宿主自抄；语言 id 那一侧已由 DIAG-GATE-1033 改成 `descriptor.id` 身份比对。若改由
 *   descriptor 交扩展名，就得把 Monaco 语言注册表拖进这个**刻意零 Monaco、且在每次击键热路径
 *   上**的判据模块，并新增第二个组合点 ⇒ 常量保持在 cutover 单点组合，gate 只准消费。
 *
 * 红条件（任一变化 ⇒ "可下沉"的前提变了，必须回来重判本组）：`isKojo2Path` 改了定义处 /
 * 消费者清单变了 / 语言包开始依赖契约 / gate 里长出本地字面量、二次组合或语言 id 分支 /
 * cutover 的组合点改形 / 叠层装饰重新抄扩展名。
 */
const APP_SRC = 'packages/app/src';
const OPEN_MODULE = `${APP_SRC}/ui/kojo2-open.ts`;
const GATE_MODULE = `${APP_SRC}/ui/kojo2-diagnostics-gate.ts`;
const CUTOVER_MODULE = `${APP_SRC}/ui/kojo2-cutover.ts`;
const OVERLAY_MODULE = `${APP_SRC}/monaco/tree-sitter/syntax-decorations.ts`;

const readSrc = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** `from '<spec>'` 的静态导入清单，按文件判定（`spec` 是后缀匹配） */
function importsFrom(rel: string, specSuffix: string): boolean {
  const escaped = specSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`from\\s*'[^']*${escaped}'`).test(readSrc(rel));
}

describe('B5B-SINK：`isKojo2Path` 沉不动——单消费者不成立，且没有既有叶子可组合两枚字面源', () => {
  it('恰一处定义，本体只读 `KOJO2_FILE_EXTENSIONS`（零字面量、零 Monaco）', () => {
    const defs = sourceFiles(APP_SRC).filter((rel) =>
      /export function\s+isKojo2Path\b/.test(readSrc(rel)),
    );
    expect(defs, 'isKojo2Path 的定义处不止一枚（两份判据迟早漂）').toEqual([OPEN_MODULE]);
    const open = readSrc(OPEN_MODULE);
    expect(open).toMatch(
      /export function isKojo2Path\(filePath: string\): boolean \{\s*return KOJO2_FILE_EXTENSIONS\.includes\(extname\(filePath\)\.toLowerCase\(\)\);\s*\}/,
    );
    // ① 零 Monaco：这一枚能站的唯一理由（判据本身不碰 Monaco）
    expect(open, '打开路由层被拖进 Monaco 图').not.toMatch(/from\s*'[^']*monaco/i);
    // 本体不抄字面量（`⑥` 组查整份文件，这里查判据函数附近，防止"挪到别处再引回"）
    expect(open, 'isKojo2Path 附近又多抄了一份扩展名字面量').not.toMatch(/["']\.kojo[12]?["']/);
  });

  it('③ 单消费者不成立：app/src 恰 6 个宿主模块消费它（少一枚/多一枚都要回来重判）', () => {
    const importStatement = /import\s*(?:type\s*)?\{[\s\S]{0,600}?\}\s*from\s*'[^']*kojo2-open'/g;
    const consumers = sourceFiles(APP_SRC)
      .filter((rel) => rel !== OPEN_MODULE)
      .filter((rel) => {
        const text = readSrc(rel);
        for (const m of text.matchAll(importStatement)) {
          if (/\bisKojo2Path\b/.test(m[0]!)) return true;
        }
        return false;
      })
      .sort();
    expect(
      consumers,
      'isKojo2Path 的消费者清单变了：下沉前提是"单消费者"，清单变动必须重判本组',
    ).toEqual([
      `${APP_SRC}/ui/App.tsx`,
      `${APP_SRC}/ui/kojo2-diagnostics-gate.ts`,
      `${APP_SRC}/ui/kojo2-project-analysis.ts`,
      `${APP_SRC}/ui/kojo2-storage-refresh.ts`,
      `${APP_SRC}/ui/project-diagnostics.ts`,
      `${APP_SRC}/ui/project-scan-schedule.ts`,
    ]);
  });

  it('更硬的障碍：`@kojo/kojo-lang` 不许依赖契约包 ⇒ 没有既有叶子能同时拿 `.kojo` 与 `.kojo2`', () => {
    // `.kojo` 的唯一定义在契约包（另有 conformance 夹具的一份自持清单，不参与宿主判据）
    expect(readSrc('packages/plugin-api/src/sugar.ts')).toMatch(
      /export const KOJO_SOURCE_EXTENSION = '\.kojo';/,
    );
    // `.kojo2` 的唯一字面源是零 import 叶子
    const constants = readSrc('packages/kojo-lang/src/constants.ts');
    expect(constants).toMatch(/export const KOJO2_SOURCE_EXTENSION = '\.kojo2';/);
    expect(constants, '零依赖叶子长出了 import：字面源不再是"零 import"').not.toMatch(/^\s*import\s/m);
    // 语言包连契约包的依赖都没有 ⇒ 包内不可能组合两枚字面源
    const manifest = JSON.parse(readSrc('packages/kojo-lang/package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}), '语言包开始依赖契约桶（分层破）').not.toContain(
      '@kojo/plugin-api',
    );
    const foreign = sourceFiles('packages/kojo-lang/src').filter((rel) =>
      /from\s*'@kojo\/plugin-api'/.test(readSrc(rel)),
    );
    expect(foreign, '语言包内出现了对契约包的 import').toEqual([]);
  });
});

describe('B5B-SINK：diagnostics-gate 的扩展名常量——cutover 单点组合，gate 只准消费', () => {
  it('gate 只从 `./kojo2-cutover` 取那两枚常量：零本地字面量、零二次组合、零语言 id 分支', () => {
    const gate = readSrc(GATE_MODULE);
    expect(importsFrom(GATE_MODULE, './kojo2-cutover')).toBe(true);
    expect(gate).toMatch(/KOJO_V1_FILE_EXTENSION/);
    expect(gate).toMatch(/KOJO2_FILE_EXTENSIONS/);
    expect(gate, 'gate 里长出了扩展名字面量（第二份单源）').not.toMatch(/["']\.kojo[12]?["']/);
    expect(gate, 'gate 里二次组合扩展名清单（第二个组合点）').not.toMatch(
      /\bKOJO2_FILE_EXTENSIONS\s*=|\[[^\]]*KOJO_SOURCE_EXTENSION/,
    );
    // DIAG-GATE-1033：语言白名单已改成 `descriptor.id` 身份比对 ⇒ gate 里不该再有 *_LANGUAGE_ID
    expect(gate, 'gate 里又长出语言 id 分支（M2 账会涨）').not.toMatch(
      /\b[A-Z][A-Z0-9_]*_LANGUAGE_ID\b/,
    );
    // 这枚模块刻意零 Monaco（每次击键热路径）——把注册表拖进来就是为扩展名付 Monaco 的钱
    expect(gate, '刻意零 Monaco 的判据模块被拖进了 Monaco 语言注册表').not.toMatch(
      /from\s*'[^']*(?:monaco|entry)[^']*'/i,
    );
  });

  it('扩展名常量在 cutover 单点组合（契约 + 零依赖叶子现算，不抄字面量）', () => {
    const cutover = readSrc(CUTOVER_MODULE);
    expect(cutover).toMatch(
      /export const KOJO2_FILE_EXTENSIONS: readonly string\[\] = \[KOJO_SOURCE_EXTENSION, KOJO2_FILE_EXTENSION\];/,
    );
    expect(cutover).toMatch(
      /export const KOJO2_FILE_EXTENSION: string = KOJO2_SOURCE_EXTENSION;/,
    );
    expect(cutover).toMatch(
      /export const KOJO_V1_FILE_EXTENSION: string = KOJO_LEGACY_SOURCE_EXTENSION;/,
    );
    expect(cutover, 'cutover 又抄了一份字面量').not.toMatch(/["']\.kojo[12]?["']/);
  });

  it('语言 id 那条腿已是 `descriptor.id` 身份比对：叠层装饰里零扩展名常量', () => {
    const overlay = readSrc(OVERLAY_MODULE);
    expect(overlay).toMatch(/model\.getLanguageId\(\) !== overlayLanguageId/);
    expect(overlay, '叠层装饰层又抄了一份扩展名判据').not.toMatch(/["']\.kojo[12]?["']/);
  });
});
