/**
 * 整项目诊断扫描的**接线与调度**单测（接线批，2026-10-20）。
 *
 * 这里跑的是**真采集器 + 假宿主**：`createProjectScanner` 一字未改地使进来，kernel / io /
 * slots / 时钟全是假的。这样既钉得住宿主这半条腿的判据（什么时候叫、叫几次、换项目清哪一簇），
 * 又不必靠真定时器跑满 60s——时间由假时钟点表，"首帧之后"由手动的帧队列点。
 *
 * 钉的判据：
 * ① 索引未就绪时的退化路径（`io.walkDir` 的清单，且这批文件真上账）与就绪时走索引；
 * ② 同一项目重复请求 ⇒ 只有一轮在写账，旧轮被取代且**不落账**；
 * ③ 换项目 / 关项目 ⇒ 先 `clearProjectScan()` 再重新装配（**`clearAllProblems` 没被当项目级
 *    清账用**：编辑器那一簇在换项目前后逐字不变，范围标签也不冒充项目级）；
 * ④ 复核队列非空 ⇒ `run({rescanOnly:true})` 且只办队列那一份；整轮在跑时复核只等不抢；
 * ⑤ 编辑器活跃（用户在打字）⇒ `cancel()`，覆盖读数自证不完整；
 * ⑥ 60s 合批节流：窗口内三次外部改动只起一轮；根外改动不起轮；
 * ⑦ 单文件读炸不终止整轮；根全炸则本轮如实 `failed`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorDecoratorContribution,
  ErbIndex,
  GameProject,
  LineDecoration,
  WalkOptions,
} from '@kojo/plugin-api';
import {
  SCAN_EVENT_COALESCE_MS,
  SCAN_FULL_ROUND_MIN_MS,
  SCAN_INDEX_WAIT_MS,
  SCAN_RESCAN_COALESCE_MS,
  SCAN_TYPING_QUIET_MS,
  mountProjectScan,
  type ProjectScanHandle,
  type ProjectScanRunner,
  type ScanKernel,
  type ScanScheduler,
} from '../src/ui/project-scan-schedule';
import { createProjectScanner, type ProjectScannerDeps } from '../src/ui/project-diagnostics';
import {
  IDLE_SCAN_COVERAGE,
  PROBLEM_SCOPE,
  clearAllProblems,
  clearProblems,
  clearProjectScan,
  projectScanCoverage,
  projectScanFileCount,
  rescanPendingCount,
  setProjectScanCoverage,
  setProblems,
  snapshot,
  summarizeProblems,
  type EditorProblem,
} from '../src/ui/problem-store';

const ROOT = 'C:/game/ERB';
const A = `${ROOT}/001/M_KOJO_K1_1.ERB`;
const B = `${ROOT}/001/M_KOJO_K1_2.ERB`;
const C = `${ROOT}/002/M_KOJO_K2_1.ERB`;
/** 会话附加根（D1）下的一份 */
const W = 'C:/Users/me/work/M_KOJO_K9.ERB';
/** 索引里躺着、但落在允许根之外的一条（越界必须拒读并数得出） */
const OUTSIDE = 'C:/Windows/notepad.ERB';

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

const openProblem: EditorProblem = { path: B, line: 1, severity: 'error', message: '编辑器那一簇' };

/** 假时钟：定时器登记在表上由测试点着跑（不挂真 60s）；`onStep` = 每一拍之前放行"首帧之后"那批 */
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
      const next = due.filter((e) => !e.cancelled && e.at <= target).sort((x, y) => x.at - y.at)[0];
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

/** 采集器包装：用真采集器（判据一字未动），同时交出 run / cancel / publish 的记账面 */
interface RunnerSpy {
  deps: ProjectScannerDeps;
  runs: Array<{ rescanOnly: boolean }>;
  cancels: number;
  published: string[];
}

function harness() {
  const frames: Array<() => void> = [];
  const clock = fakeClock(() => {
    const queued = frames.splice(0, frames.length);
    for (const f of queued) f();
  });
  const handlers = new Map<string, Set<(payload: never) => void>>();
  const texts = new Map<string, string>([
    [A, 'A 的内容'],
    [B, 'B 的内容'],
    [C, 'C 的内容'],
    [W, 'W 的内容'],
  ]);
  const gates = new Map<string, Promise<void>>();
  const readCalls: string[] = [];
  const walkCalls: string[] = [];
  const notices: string[] = [];
  const spies: RunnerSpy[] = [];
  /** 哪几份文件要有诊断（测试可换，模拟"盘上事实变了"） */
  const loud = new Set<string>([B]);
  let walkFiles: string[] = [];
  let walkFails = false;
  const walkFailRoots = new Set<string>();
  let index: ErbIndex | null = null;
  let current: GameProject | null = null;
  let extraRoots: readonly string[] = [];

  const decorator: EditorDecoratorContribution = {
    id: 'fake-lint',
    title: '假诊断',
    decorate: (file): LineDecoration[] =>
      loud.has(file.path) ? [{ line: 2, severity: 'error', message: '假问题', code: 'fake.x' }] : [],
  };

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
  const fire = (type: string, payload: unknown): void => bus.emit(type, payload as never);

  const io = {
    async walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]> {
      walkCalls.push(path);
      if (walkFails || walkFailRoots.has(path)) throw new Error(`读不到目录：${path}`);
      const entries: DirEntry[] = walkFiles
        .filter((p) => p.startsWith(path))
        .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false }));
      return opts?.filter ? entries.filter((e) => opts.filter!(e)) : entries;
    },
    async readText(path: string) {
      readCalls.push(path);
      const text = texts.get(path);
      if (text === undefined) throw new Error(`读不到：${path}`);
      const gate = gates.get(path);
      if (gate !== undefined) {
        gates.delete(path); // 一次性闸门：一份闸门只卡住一趟读
        await gate;
      }
      return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 0 };
    },
  };

  const parser = { currentIndex: () => index };
  const kernel = {
    bus,
    io,
    slots: { query: (slot: string) => (slot === 'ui.editor.decorator' ? [decorator] : []) },
    services: {
      tryGet: (key: string) => (key === 'erb.parser' ? parser : undefined),
      get: (key: string) => (key === 'erb.parser' ? parser : null),
      keys: () => ['erb.parser'],
    },
    project: { current: () => current },
    compute: { yieldToMain: async () => {} },
    workspaces: { roots: () => [] as string[] },
  } as unknown as ScanKernel;

  const createScanner = (deps: ProjectScannerDeps): ProjectScanRunner => {
    const spy: RunnerSpy = { deps, runs: [], cancels: 0, published: [] };
    const publish = deps.publish;
    deps.publish = (path, items) => {
      spy.published.push(path);
      publish(path, items);
    };
    const real = createProjectScanner(deps);
    spies.push(spy);
    return {
      ...real,
      run: (opts) => {
        spy.runs.push({ rescanOnly: opts?.rescanOnly === true });
        return real.run(opts);
      },
      cancel: () => {
        spy.cancels += 1;
        real.cancel();
      },
    };
  };

  let handle: ProjectScanHandle | null = null;
  const mount = (): ProjectScanHandle => {
    handle = mountProjectScan({
      kernel,
      createScanner,
      now: clock.now,
      schedule: clock.schedule,
      afterFrame: (fn) => {
        frames.push(fn);
      },
      extraRoots: () => extraRoots,
      onNotice: (m) => {
        notices.push(m);
      },
    });
    return handle;
  };

  return {
    clock,
    mount,
    dispose: () => handle?.dispose(),
    handle: () => handle,
    fire,
    frames,
    /** 放行"首帧之后"那一批并跑一拍（① 的延后判据靠"没放行时不起轮"自证） */
    runFrames: () => clock.advance(0),
    setProject: (p: GameProject | null) => {
      current = p;
    },
    setIndex: (paths: readonly string[] | null) => {
      index = paths === null ? null : ({ files: new Map(paths.map((p) => [p, { path: p }])) } as unknown as ErbIndex);
    },
    setWalkFiles: (paths: string[]) => {
      walkFiles = paths;
    },
    setWalkFails: (fails: boolean) => {
      walkFails = fails;
    },
    failWalkRoot: (root: string) => {
      walkFailRoots.add(root);
    },
    setExtraRoots: (roots: readonly string[]) => {
      extraRoots = roots;
    },
    gateRead: (path: string): (() => void) => {
      let release = (): void => {};
      gates.set(
        path,
        new Promise<void>((res) => {
          release = res;
        }),
      );
      return () => {
        release();
      };
    },
    removeText: (path: string) => {
      texts.delete(path);
    },
    spies,
    /** 当前装配那一份采集器的记账（换项目后就是新的那份） */
    latest: (): RunnerSpy => spies[spies.length - 1]!,
    readCalls,
    walkCalls,
    notices,
    loud,
    settle: () => clock.advance(0),
  };
}

afterEach(() => {
  // 覆盖读数先归 idle 再清账：非 idle 时 `clearAllProblems` 会把路径记进复核队列
  setProjectScanCoverage(IDLE_SCAN_COVERAGE);
  clearProjectScan();
  clearAllProblems();
});

const scanFiles = (): number => projectScanFileCount();
const scanErrors = (): number => summarizeProblems(snapshot()).countsByOrigin['project-scan'].error;
const has = (path: string): boolean => snapshot().some((p) => p.path === path);
/** 索引不广播时那一发兜底轮的落点（等待 + 合批窗口，再留一点余量） */
const DEGRADED_ROUND_AT = SCAN_INDEX_WAIT_MS + SCAN_EVENT_COALESCE_MS + 500;

describe('① 项目加载 + 索引就绪（第一轮）', () => {
  it('装配当场不起轮；第一轮等索引广播，并延后到首帧之后', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    const handle = h.mount();
    expect(handle.armedRoot()).toBe(project.rootDir);
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    expect(h.latest().runs).toHaveLength(0);
    expect(h.frames).toHaveLength(1); // 排进"首帧之后"，不当场和索引抢 CPU
    await h.runFrames();
    expect(h.latest().runs).toHaveLength(1);
    expect(h.latest().runs[0]!.rescanOnly).toBe(false);
    expect(h.walkCalls).toEqual([]); // 索引就绪 ⇒ 用索引的键，不另走一趟递归列举
    expect(scanErrors()).toBe(1);
    expect(scanFiles()).toBe(1);
    expect(projectScanCoverage().status).toBe('complete');
    h.dispose();
  });

  it('索引未就绪 ⇒ 退化到 io.walkDir 的清单，那批文件照样上账', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex(null);
    h.setWalkFiles([A, B]);
    h.mount();
    await h.clock.advance(DEGRADED_ROUND_AT);
    expect(h.walkCalls).toContain(ROOT);
    expect(h.latest().runs).toHaveLength(1);
    expect(scanErrors()).toBe(1);
    expect(projectScanCoverage().status).toBe('complete');
    expect(projectScanCoverage().roots).toEqual([ROOT]);
    h.dispose();
  });

  it('别的项目迟到的索引广播不起轮；等自己那一份广播来了才起', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: otherProject.rootDir, files: [] });
    expect(h.frames).toHaveLength(0);
    expect(h.latest().runs).toHaveLength(0);
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A] });
    await h.runFrames();
    expect(h.latest().runs).toHaveLength(1);
    expect(h.readCalls).toEqual([A]);
    h.dispose();
  });
});

describe('② 重复请求 ⇒ 取代而非排队', () => {
  it('旧轮迟到那份不写账，屏幕上只有新轮的结论', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    const release = h.gateRead(A); // 第一轮卡在 A 这一趟读盘
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    h.setIndex([C]); // 换了文件集 ⇒ 第二轮列举的是另一份
    h.fire('file.changed', { kind: 'change', path: C }); // 间隔满后那一发请求把旧轮取代掉
    await h.clock.advance(SCAN_FULL_ROUND_MIN_MS + 10_000);
    expect(spy.runs).toHaveLength(2);
    expect(spy.runs[1]!.rescanOnly).toBe(false);
    release();
    await h.settle();
    expect(spy.published).toEqual([C]); // 旧轮那份 A 一个字节都不许落账
    expect(has(A)).toBe(false);
    expect(projectScanCoverage().total).toBe(1);
    expect(projectScanCoverage().scanned).toBe(1);
    h.dispose();
  });

  it('整轮在跑时复核只等不抢（不许把整轮的缺口冒充成复核的"已完成"）', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    const release = h.gateRead(A);
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    setProblems(B, [openProblem]);
    clearProblems(B); // 关标签：编辑器那一簇清掉，复核队列记上 B
    expect(rescanPendingCount()).toBe(1);
    await h.clock.advance(SCAN_RESCAN_COALESCE_MS * 4);
    expect(spy.runs).toHaveLength(1); // 没有抢先的第二轮
    release();
    await h.settle();
    await h.clock.advance(SCAN_RESCAN_COALESCE_MS);
    expect(spy.runs).toHaveLength(2);
    expect(spy.runs[1]!.rescanOnly).toBe(true);
    expect(rescanPendingCount()).toBe(0);
    h.dispose();
  });
});

describe('③ 换项目 / 关项目的项目级清账', () => {
  it('换项目先 clearProjectScan 再重新装配；编辑器那一簇逐字不变', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    await h.runFrames();
    setProblems(B, [openProblem]);
    expect(scanFiles()).toBe(1);
    expect(snapshot()).toHaveLength(1); // 同一文件两簇并存只数一遍
    h.fire('project.closed', { rootDir: project.rootDir });
    h.setProject(otherProject);
    h.fire('project.opened', { project: otherProject });
    expect(h.handle()?.armedRoot()).toBe(otherProject.rootDir);
    expect(h.spies).toHaveLength(2); // 重新装配 = 新的一份采集器（新世代线）
    // 项目级那一簇整段退场、编辑器那一簇原样留着 ⇒ 清账走的是 clearProjectScan
    expect(scanFiles()).toBe(0);
    expect(snapshot()).toHaveLength(1);
    expect(snapshot()[0]!.origin).toBe('open-file');
    expect(PROBLEM_SCOPE.label).toBe('已打开'); // 账上没有扫描那一簇时不许冒充项目级
    h.dispose();
  });

  it('关项目 ⇒ 取消在跑那一轮、扫描簇清零、之后不再冒轮次', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B] });
    const release = h.gateRead(B); // 轮次卡在读盘上 ⇒ 关项目时确有"在跑的那一轮"
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    h.setProject(null);
    h.fire('project.closed', { rootDir: project.rootDir });
    expect(spy.cancels).toBe(1);
    expect(h.handle()?.armedRoot()).toBeNull();
    release();
    await h.settle();
    expect(scanFiles()).toBe(0); // 迟到的那一份也没把账捡回来
    expect(spy.runs).toHaveLength(1);
    await h.clock.advance(SCAN_FULL_ROUND_MIN_MS * 2);
    expect(spy.runs).toHaveLength(1); // 关掉之后不会有轮次自己冒出来
    h.dispose();
  });

  it('盘上被删的文件就地销账（旧扫描结论不许留成幽灵诊断）', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    await h.runFrames();
    expect(scanErrors()).toBe(1);
    h.fire('file.changed', { kind: 'unlink', path: B });
    expect(scanErrors()).toBe(0);
    h.dispose();
  });
});

describe('④ 复核队列与根集合', () => {
  it('队列非空只办队列那一份，不重新列举文件', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    h.loud.clear();
    h.loud.add(A); // 盘上事实变了：现在出问题的是 A
    setProblems(A, [{ ...openProblem, path: A }]);
    clearProblems(A);
    expect(rescanPendingCount()).toBe(1);
    await h.clock.advance(SCAN_RESCAN_COALESCE_MS);
    expect(spy.runs).toHaveLength(2);
    expect(spy.runs[1]!.rescanOnly).toBe(true);
    expect(h.readCalls.filter((p) => p === A)).toHaveLength(2); // 整轮 + 复核各一趟
    expect(h.readCalls.filter((p) => p === B)).toHaveLength(1); // 复核没有把整轮的文件重读
    expect(rescanPendingCount()).toBe(0);
    expect(scanFiles()).toBe(2); // B 那份旧结论仍在，A 是新上账的
    expect(scanErrors()).toBe(2);
    h.dispose();
  });

  it('越界路径拒读并数得出（索引里躺着根外的一条也不读）', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([B, OUTSIDE]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B, OUTSIDE] });
    await h.runFrames();
    expect(h.readCalls).toEqual([B]);
    expect(projectScanCoverage().outOfRoots).toBe(1);
    h.dispose();
  });

  it('会话附加根（D1）也在允许根之内', async () => {
    const h = harness();
    h.setProject(project);
    h.setExtraRoots(['C:/Users/me/work']);
    h.setIndex([B, W]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B, W] });
    await h.runFrames();
    expect(h.readCalls.sort()).toEqual([B, W].sort());
    expect(projectScanCoverage().roots).toEqual([ROOT, 'C:/Users/me/work']);
    h.dispose();
  });
});

describe('⑤ 用户在打字 ⇒ 停轮', () => {
  it('编辑器活跃即 cancel，覆盖读数自证不完整', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    const release = h.gateRead(A);
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    h.fire('editor.cursorMoved', { filePath: A, line: 1, column: 1, derivedView: false });
    expect(spy.cancels).toBe(1);
    expect(projectScanCoverage().status).toBe('cancelled');
    release();
    await h.settle();
    expect(spy.published).toEqual([]); // 取消那一份不落账
    expect(scanFiles()).toBe(0);
    h.dispose();
  });

  it('打字期间的整轮请求不叠加；静默期与间隔都过了才补一轮', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B] });
    const release = h.gateRead(B);
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    h.fire('editor.cursorMoved', { filePath: B, line: 1, column: 1, derivedView: false });
    expect(spy.cancels).toBe(1);
    h.fire('editor.documentChanged', { filePath: B, text: '改了', dirty: true });
    h.fire('editor.cursorMoved', { filePath: B, line: 2, column: 1, derivedView: false });
    release();
    await h.settle();
    await h.clock.advance(SCAN_TYPING_QUIET_MS);
    expect(spy.runs).toHaveLength(1); // 三次活跃只留一发待跑，且还在 60s 间隔里
    await h.clock.advance(SCAN_FULL_ROUND_MIN_MS);
    expect(spy.runs).toHaveLength(2);
    h.dispose();
  });
});

describe('⑥ 节流', () => {
  it('同一窗口内三次外部改动只起一轮', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B] });
    await h.runFrames();
    const spy = h.latest();
    expect(spy.runs).toHaveLength(1);
    for (const p of [A, B, C]) h.fire('file.changed', { kind: 'change', path: p });
    await h.clock.advance(10_000); // 合批窗口过了，但离上一轮满 60s 还差得远
    expect(spy.runs).toHaveLength(1);
    await h.clock.advance(60_000);
    expect(spy.runs).toHaveLength(2);
    await h.clock.advance(60_000);
    expect(spy.runs).toHaveLength(2); // 没有新请求 ⇒ 不会有轮次自己冒出来
    h.dispose();
  });

  it('根外的改动不起整轮（与扫描根同口径）', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([B]);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [B] });
    await h.runFrames();
    const spy = h.latest();
    h.fire('file.changed', { kind: 'change', path: 'C:/Users/me/Desktop/notes.txt' });
    await h.clock.advance(70_000);
    expect(spy.runs).toHaveLength(1);
    h.dispose();
  });
});

describe('⑦ IO 边界', () => {
  it('单文件读炸不终止整轮：该格 skipped 上账，其余照上', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex([A, B]);
    h.removeText(A);
    h.mount();
    h.fire('kojo.functionChanged', { projectRoot: project.rootDir, files: [A, B] });
    await h.runFrames();
    expect(projectScanCoverage().status).toBe('complete');
    expect(projectScanCoverage().skipped).toBe(1);
    expect(scanErrors()).toBe(1);
    h.dispose();
  });

  it('索引未就绪且口上根全部读不到 ⇒ 本轮如实 failed（不伪装成"扫完了什么都没扫出来"）', async () => {
    const h = harness();
    h.setProject(project);
    h.setIndex(null);
    h.setWalkFails(true);
    h.mount();
    await h.clock.advance(DEGRADED_ROUND_AT);
    expect(h.walkCalls).toContain(ROOT);
    expect(projectScanCoverage().status).toBe('failed');
    h.dispose();
  });

  it('退化路径少读了某一个根要说得出（整轮照跑，缺的那份上一句人话）', async () => {
    const h = harness();
    h.setProject(project);
    h.setExtraRoots(['C:/Users/me/work']);
    h.setIndex(null);
    h.setWalkFiles([B]);
    h.failWalkRoot('C:/Users/me/work'); // 附加根读不到、口上根读得到 ⇒ 清单不全
    h.mount();
    await h.clock.advance(DEGRADED_ROUND_AT);
    expect(h.walkCalls).toEqual([ROOT, 'C:/Users/me/work']);
    expect(h.notices.join(' ')).toContain('少读');
    expect(scanErrors()).toBe(1); // 读得到的那一份照常上账
    expect(projectScanCoverage().status).toBe('complete');
    h.dispose();
  });
});
