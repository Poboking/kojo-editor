/**
 * K2-INDEX-HOST-FEED · 项目扫描 → 2.0 项目索引的**宿主喂养**闸。
 *
 * 这里跑的是「真扫描器 + 假内核 + 虚拟文件系统」：项目扫描读到的 `.kojo2` 原文经
 * `kojo2-project-scan-adapter` 的喂养通道分拍进入 `kojo2ProjectIndex`，索引再经
 * `createKojo2ProjectRenameResolvers` / `createKojo2ProjectCallHierarchyResolvers`
 * 交出跨文件 resolver。钉的判据：
 *
 * ① 扫描读到的**未打开文件**进索引（v1 源文不进；路径大小写 / 分隔符归一到同一格）；
 * ② 只声明在 A、引用在 B（A 从未打开）⇒ `refsOf` / `declsOf` / `symbolAt` 都看得见；
 * ③ 改名请求在 B、候选 A 只在扫描里 ⇒ `kojo2RenamePlanXFile` 同时给 A / B 出编辑；
 * ④ `file.changed` 增量重读（保存后立刻生效）与 `unlink` 就地撤条；
 * ⑤ 换 / 关项目 ⇒ 索引整份清空；
 * ⑥ 多文件分拍喂养不丢（大项目一次不吞完，但最终一份不少）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DirEntry, ErbIndex, GameProject, WalkOptions } from '@kojo/plugin-api';
import { kojo2DocumentOf } from '@kojo/kojo-lang';
import {
  createKojo2ProjectCallHierarchyResolvers,
  createKojo2ProjectIndex,
  createKojo2ProjectRenameResolvers,
  type Kojo2ProjectIndex,
} from '../src/monaco/kojo2-project-index';
import { kojo2RenamePlanXFile } from '../src/monaco/kojo2-rename';
import {
  KOJO2_INDEX_FEED_CHUNK,
  mountProjectScan,
  onKojo2ProjectFileFeed,
  onKojo2ProjectFileFeedReset,
  type ProjectScanHandle,
  type ScanKernel,
  type ScanScheduler,
} from '../src/ui/project-scan-schedule';
import {
  IDLE_SCAN_COVERAGE,
  clearAllProblems,
  clearProjectScan,
  setProjectScanCoverage,
} from '../src/ui/problem-store';

const ROOT = 'C:/game/ERB';
const A = `${ROOT}/a.kojo2`;
const B = `${ROOT}/b.kojo2`;
/** v1 源文：扫描也会读它，但索引只收 `.kojo2` */
const V1 = `${ROOT}/M_KOJO_K1.ERB`;

/** A（未打开 = 只经扫描喂）：声明 `心情`，也声明 `好感度` */
const MAIN = [
  '# 变量 心情 整数 = 0',
  '# 变量 好感度 整数 = 0',
  '# 幕 神社 清晨',
  '# 机 指令 310',
  '@织 指令 之后',
  '> 心情是 {心情}，好感是 {好感度}。',
].join('\n');

/** B（请求文件）：不声明 `心情`，只引用；也声明 `好感度`（跨文件改名的候选面） */
const LIB = [
  '# 变量 好感度 整数 = 0',
  '# 幕 书院 午后',
  '# 机 指令 310',
  '@织 指令 之后',
  '> 这边的 {心情} 与 {好感度}。',
].join('\n');

const project = {
  rootDir: 'C:/game',
  adapterId: 'eratw',
  kojoPaths: [ROOT],
  charaIndex: new Map(),
} as unknown as GameProject;

const otherProject = {
  rootDir: 'D:/other',
  adapterId: 'eratw',
  kojoPaths: ['D:/other/ERB'],
  charaIndex: new Map(),
} as unknown as GameProject;

/** 假时钟（与 `project-scan-schedule.test.ts` 同一形态；时间由测试点着跑） */
function fakeClock(onStep?: () => void) {
  interface Due {
    at: number;
    fn: () => void;
    cancelled: boolean;
  }
  let t = 0;
  const due: Due[] = [];
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 64; i++) await Promise.resolve();
  };
  const step = async (): Promise<void> => {
    onStep?.();
    await settle();
  };
  const schedule: ScanScheduler = (fn, ms) => {
    const entry: Due = { at: t + Math.max(0, ms), fn, cancelled: false };
    due.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const advance = async (ms: number): Promise<void> => {
    const target = t + ms;
    await step();
    for (;;) {
      const next = due
        .filter((e) => !e.cancelled && e.at <= target)
        .sort((x, y) => x.at - y.at)[0];
      if (next === undefined) break;
      due.splice(due.indexOf(next), 1);
      t = next.at;
      next.fn();
      await step();
    }
    t = target;
    await step();
  };
  return { now: () => t, schedule, advance };
}

interface Harness {
  readonly index: Kojo2ProjectIndex;
  readonly texts: Map<string, string>;
  fire(type: string, payload: unknown): void;
  mount(): ProjectScanHandle;
  /** 放行帧 + 跑轮次 + 跑完喂养队列（链式 0ms 定时器要几拍） */
  settle(): Promise<void>;
  /** 换项目用例改当前项目 */
  setProject(project: GameProject | null): void;
  /** 摘掉喂养订阅并卸载扫描 */
  disposeFeed(): void;
}

function harness(files: ReadonlyMap<string, string>): Harness {
  const frames: Array<() => void> = [];
  const clock = fakeClock(() => {
    const queued = frames.splice(0, frames.length);
    for (const f of queued) f();
  });
  const handlers = new Map<string, Set<(payload: never) => void>>();
  const texts = new Map(files);
  let current: GameProject | null = project;

  const bus = {
    on: (type: string, handler: (payload: never) => void): (() => void) => {
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    once: (type: string, handler: (payload: never) => void) => bus.on(type, handler),
    emit: (type: string, payload: never): void => {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload);
    },
  };

  const indexObject = {
    files: new Map([...texts.keys()].map((p) => [p, { path: p }])),
  } as unknown as ErbIndex;
  const parser = { currentIndex: () => indexObject };

  const kernel = {
    bus,
    io: {
      async readText(path: string) {
        const text = texts.get(path);
        if (text === undefined) throw new Error(`读不到：${path}`);
        return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 0 };
      },
      async walkDir(_path: string, _opts?: WalkOptions): Promise<DirEntry[]> {
        return [];
      },
    },
    slots: { query: () => [] },
    services: { tryGet: (key: string) => (key === 'erb.parser' ? parser : undefined) },
    project: { current: () => current },
    compute: { yieldToMain: async () => {} },
    workspaces: { roots: () => [] as string[] },
  } as unknown as ScanKernel;

  // 真索引 + 生产喂养通道：订阅关系与 `editor-global-providers` 的 2.0 装配段逐字同形。
  const index = createKojo2ProjectIndex();
  const offFeed = onKojo2ProjectFileFeed((path, text) => {
    if (text === null) index.removeFile(path);
    else index.updateFile({ path, text });
  });
  const offReset = onKojo2ProjectFileFeedReset(() => {
    for (const path of index.files()) index.removeFile(path);
  });

  let handle: ProjectScanHandle | null = null;

  return {
    index,
    texts,
    fire: (type, payload) => bus.emit(type, payload as never),
    mount: () => {
      handle = mountProjectScan({
        kernel,
        now: clock.now,
        schedule: clock.schedule,
        afterFrame: (fn) => frames.push(fn),
      });
      return handle;
    },
    settle: async () => {
      // 帧 → 整轮 → 每轮读盘后的喂养拍（链式 0ms），多推几拍把队列清空
      await clock.advance(0);
      await clock.advance(0);
      await clock.advance(0);
    },
    setProject: (next) => {
      current = next;
    },
    disposeFeed: () => {
      offFeed();
      offReset();
      handle?.dispose();
      handle = null;
    },
  };
}

function declarationPosition(source: string, name: string): { line: number; column: number } {
  const declaration = kojo2DocumentOf(source).declarations.find((entry) => entry.name === name);
  if (declaration === undefined) throw new Error(`夹具缺少声明 ${name}`);
  return { line: declaration.line, column: declaration.nameStart };
}

/** `needle` 首次出现 → 1 基行列（夹具只含 LF） */
function positionOf(source: string, needle: string): { line: number; column: number } {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
  const before = source.slice(0, at);
  return { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') };
}

const mounted: Array<{ disposeFeed(): void }> = [];

afterEach(() => {
  for (const h of mounted.splice(0)) h.disposeFeed();
  setProjectScanCoverage(IDLE_SCAN_COVERAGE);
  clearProjectScan();
  clearAllProblems();
});

/** 装配 + 索引广播 + 跑完整轮 + 清喂养队列 */
async function scanProject(files: ReadonlyMap<string, string>): Promise<Harness> {
  const h = harness(files);
  mounted.push(h);
  h.mount();
  h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [...files.keys()] });
  await h.settle();
  return h;
}

const BASE_FILES = new Map<string, string>([
  [A, MAIN],
  [B, LIB],
  [V1, '> v1 源文不该进 2.0 索引'],
]);

describe('① 扫描把未打开文件喂进索引（路径归一口径统一）', () => {
  it('`.kojo2` 进索引，v1 源文不进；大小写 / 反斜杠写法落到同一格', async () => {
    const h = await scanProject(BASE_FILES);
    expect([...h.index.files()].sort()).toEqual([A, B].sort());
    expect(h.index.getFile(A)?.text).toBe(MAIN);
    expect(h.index.getFile(B)?.text).toBe(LIB);
    expect(h.index.getFile(V1)).toBeUndefined();
    // 扫描路径与 model 路径两种写法（大小写 / 分隔符）必须同一格
    expect(h.index.getFile('c:\\GAME\\erb\\A.KOJO2')?.text).toBe(MAIN);
    expect(h.index.snapshot().fileCount).toBe(2);
  });
});

describe('② 只声明在未打开文件里的引用', () => {
  it('`refsOf` / `declsOf` / `symbolAt` 都从扫描喂进来的 A 取事实', async () => {
    const h = await scanProject(BASE_FILES);
    const declarations = h.index.declsOf('心情');
    expect(declarations.map((entry) => entry.path)).toEqual([A]);

    const refs = h.index.refsOf({ name: '心情', kind: 'variable' }).refs;
    // A 里的声明 / 引用照样在；关键是 B（从未打开）那枚跨文件引用位也看得见
    expect(refs.some((ref) => ref.path === A && ref.kind === 'decl')).toBe(true);
    expect(refs.some((ref) => ref.path === B && ref.kind !== 'decl')).toBe(true);

    const at = positionOf(LIB, '{心情}');
    expect(h.index.symbolAt({ path: B, line: at.line, column: at.column + 1 })).toEqual({
      name: '心情',
      kind: 'variable',
    });
  });
});

describe('③ 跨文件改名：候选只活在扫描索引里', () => {
  it('请求在 B、A 从未打开 ⇒ plan 同时给 B 与 A 出编辑', async () => {
    const h = await scanProject(BASE_FILES);
    const resolvers = createKojo2ProjectRenameResolvers(h.index);
    // resolver 的两个映射就是模块头写明的 `declsOf` / `getFile().text`
    expect(resolvers.listFilesWithSymbol!('好感度')).toEqual([A, B]);
    expect(resolvers.readSource(A)).toBe(MAIN);

    const plan = kojo2RenamePlanXFile(
      LIB,
      B,
      declarationPosition(LIB, '好感度'),
      '心念',
      resolvers,
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([B, A]);
    const editsInA = plan.editsByPath.find((entry) => entry.path === A)?.edits ?? [];
    // A 的声明位 + 正文里的 `{好感度}` 引用位，两段都要改（跨文件引用跟着一起走）
    expect(editsInA).toHaveLength(2);
    expect(editsInA.every((edit) => edit.newText === '心念')).toBe(true);
  });
});

describe('④ 保存后增量更新 / 删除就地移除', () => {
  it('`file.changed` 增量重读把新文本喂进索引（不等整轮）', async () => {
    const h = await scanProject(BASE_FILES);
    const updated = MAIN.replace('{心情}', '{心情}{好感度}');
    h.texts.set(A, updated);
    h.fire('file.changed', { kind: 'change', path: A });
    await h.settle();
    expect(h.index.getFile(A)?.text).toBe(updated);
  });

  it('`unlink` 立刻撤条：跨文件引用不再落到已删文件', async () => {
    const h = await scanProject(BASE_FILES);
    h.texts.delete(B);
    h.fire('file.changed', { kind: 'unlink', path: B });
    expect(h.index.getFile(B)).toBeUndefined();
    expect(h.index.refsOf({ name: '心情', kind: 'variable' }).refs.some((ref) => ref.path === B)).toBe(
      false,
    );
  });
});

describe('⑤ 换 / 关项目：索引整份清空', () => {
  it('`project.closed` 后旧项目的文件一份不剩', async () => {
    const h = await scanProject(BASE_FILES);
    h.fire('project.closed', { rootDir: project.rootDir });
    expect(h.index.files()).toEqual([]);
  });

  it('换项目后新项目从零开始（旧条目不会串进新项目）', async () => {
    const h = await scanProject(BASE_FILES);
    h.setProject(otherProject);
    h.fire('project.closed', { rootDir: project.rootDir });
    h.fire('project.opened', { project: otherProject });
    expect(h.index.files()).toEqual([]);
  });
});

describe('⑥ 大项目分拍喂养不丢', () => {
  it(`${KOJO2_INDEX_FEED_CHUNK}+ 份文件最终全部进索引`, async () => {
    const many = new Map<string, string>();
    for (let i = 0; i < KOJO2_INDEX_FEED_CHUNK * 3; i++) {
      many.set(`${ROOT}/f${String(i).padStart(2, '0')}.kojo2`, `# 变量 数值${i} 整数 = 0\n> {数值${i}}`);
    }
    const h = await scanProject(many);
    expect(h.index.files()).toHaveLength(many.size);
    expect(h.index.declsOf('数值0').length).toBe(1);
  });
});

describe('⑦ 调用层级 resolver 也吃同一份索引', () => {
  it('声明只在扫描文件里：`resolveDeclaration` / `listCallers` 都能交回', async () => {
    const files = new Map<string, string>([
      [A, ['@函 测试()', '    @返 1', '# 幕 神社 清晨', '# 机 指令 310'].join('\n')],
      [B, ['# 幕 书院 午后', '# 机 指令 310', '! 测试()'].join('\n')],
      [V1, '> v1'],
    ]);
    const h = await scanProject(files);
    const resolvers = createKojo2ProjectCallHierarchyResolvers(h.index);
    expect(resolvers.resolveDeclaration('测试')).toEqual({
      path: A,
      line: 1,
      column: 4,
      kind: 'function',
    });
    expect(resolvers.readSource(B)).toBe(files.get(B));
    expect(resolvers.listCallers?.('测试')?.map((entry) => entry.path)).toEqual([A, B]);
  });
});
