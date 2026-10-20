/**
 * 索引状态事实的**装配**单测（IDX-STATE，2026-10-19）。
 *
 * 与 `index-state.test.ts` 的分工：那里钉判据（形状怎么裁），这里钉时机——
 * `indexState()` 在每一个真实时刻读出来的是不是**那一步的事实**：
 * 起跑前 `idle` · 在途 `scanning` 且带已扫文件数读数 · 收尾 `ready`/`empty`/`nothing-to-scan`
 * 三态分形 · 抛出 `failed` 且原始原因可读 · **过期代际一笔都不许写**（旧构建的进度
 * 不是当前状态）· 项目关闭复位。
 *
 * 降级那一组是本刀的存在理由：`roots()` 抛时**事实面**读得出"少了哪一类位置"，
 * 断言的从来不是 console（旧形态只有一声 warn，作者侧零落点）。
 *
 * 上下文体自带（不动 `plugin.test.ts` / `workspace-index-roots.test.ts` 的共享夹具，
 * 避免并行改同一文件）。
 */

import { describe, expect, it } from 'vitest';
import {
  KernelServices,
  isPathUnder,
  type EventBus,
  type ErbIndexState,
  type ErbParserService,
  type FileIO,
  type GameProject,
  type PluginContext,
  type Unsubscribe,
  type WorkspaceService,
} from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

/* ---------------- 盘面 ---------------- */

const GAME_FILE = '/game/kojo/a.ERB';
const WS_FILE = '/ws/default/b.ERB';
/** 走得到、也确实扫到了文件，但里面一个 `@` 定义都没有 */
const NO_DEF_FILE = '/ws/quiet/notes.ERH';

function baseFiles(): Record<string, string> {
  return {
    [GAME_FILE]: '@GAME_FOO\n\tRETURN 1\n',
    [WS_FILE]: '@WS_FOO(ARG)\n\tRETURN 1\n',
    [NO_DEF_FILE]: '#DIM ALPHA, 10\n',
  };
}

/** 闸：从第 `holdFrom(n)` 趟 walk 起停在"已记账、未返回"那一步 */
interface Gate {
  holdFrom(n: number): void;
  release(): void;
  waitBefore(count: number): Promise<void>;
}

function makeGate(): Gate {
  let holdFrom = Infinity;
  const parked: Array<() => void> = [];
  return {
    holdFrom: (n) => {
      holdFrom = n;
    },
    release: () => {
      holdFrom = Infinity;
      for (const r of parked.splice(0)) r();
    },
    async waitBefore(count: number): Promise<void> {
      while (count >= holdFrom) await new Promise<void>((resolve) => parked.push(resolve));
    },
  };
}

function makeIO(
  files: Record<string, string>,
  walks: string[],
  gate: Gate,
  failWalk: () => string | null,
  broken: ReadonlySet<string>,
): FileIO {
  /** 读不到 ≠ 走不到：`broken` 里的路径**照旧被 walk 交出来**，只是读/stat 这一轮失败 */
  const readable = (path: string): boolean => broken.has(path) === false;
  return {
    async readText(path: string) {
      const text = readable(path) ? files[path] : undefined;
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = readable(path) ? files[path] : undefined;
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1 };
      });
    },
    async stat(path: string) {
      const text = readable(path) ? files[path] : undefined;
      return text === undefined ? null : { size: text.length, mtimeMs: 1, isDirectory: false };
    },
    async isWritable() {
      return false;
    },
    async walkDir(root: string) {
      walks.push(root);
      // 读不到盘 ⇒ **抛出**（不是交回空清单）：这一路的失败必须被记成 failed 一笔
      const boom = failWalk();
      if (boom !== null) throw new Error(boom);
      await gate.waitBefore(walks.length);
      // 目录清单包含 `broken` 里的路径（它们仍在盘上，只是这一轮打不开）
      return [...new Set([...Object.keys(files), ...broken])]
        .filter((p) => isPathUnder(root, p))
        .map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

/* ---------------- 上下文体 ---------------- */

interface Harness {
  logs: string[];
  walks: string[];
  changed: number;
  ws: { roots: string[]; fail: 'service-roots' | 'inject' | null };
  gate: Gate;
  /** 置为非 null ⇒ 下一趟 walkDir 抛这个原因（用 `armWalkFail` 设/清） */
  failWalk: () => string | null;
  armWalkFail(msg: string | null): void;
  /** 让这条路径**这一轮读不到**（walk 照旧走到它；与"盘上没有这个文件"是两回事） */
  breakPath(path: string): void;
  /** 撤销 `breakPath`（下一轮读得回来） */
  healPath(path: string): void;
  emit(type: string, payload: unknown): void;
  parser(): ErbParserService;
  state(): ErbIndexState;
  dispose(): void;
}

function activateWith(files: Record<string, string>, workspaceRoots: string[]): Harness {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const walks: string[] = [];
  const disposers: Array<() => void> = [];
  let changed = 0;
  const gate = makeGate();
  const ws = { roots: [...workspaceRoots], fail: null as 'service-roots' | 'inject' | null };
  let walkFailMsg: string | null = null;
  const failWalk = () => walkFailMsg;
  /** 本轮读不到的路径（IDX-SILENT 用例用：walk 交得出、读盘读不到） */
  const broken = new Set<string>();

  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const on = (type: string, handler: (p: unknown) => void): Unsubscribe => {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  };
  const emit = (type: string, payload: unknown): void => {
    if (type === 'kojo.functionChanged') changed++;
    for (const h of [...(handlers.get(type) ?? [])]) h(payload);
  };
  const bus = { on, once: on, emit } as unknown as EventBus;

  const ctx = {
    pluginId: 'erb-parser',
    log: {
      debug: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    bus,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return makeIO(files, walks, gate, failWalk, broken) as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      if (key === KernelServices.Workspaces) {
        if (ws.fail === 'inject') throw new Error(`Service '${key}' is not available (required by 'erb-parser')`);
        const service = {
          roots: () => {
            if (ws.fail === 'service-roots') throw new Error('Workspace service unavailable: no platform data dir');
            return [...ws.roots];
          },
        } as unknown as WorkspaceService;
        return service as unknown as T;
      }
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: (() => {
      const map = new Map<string, string>();
      return {
        get: async (key: string) => {
          const raw = map.get(key);
          return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
        },
        set: async (key: string, value: unknown) => {
          map.set(key, JSON.stringify(value));
        },
        delete: async (key: string) => {
          map.delete(key);
        },
        keys: async () => [...map.keys()],
      };
    })(),
    slots: { register: () => () => undefined, query: () => [] },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;

  createErbParserPlugin().activate(ctx);
  return {
    logs,
    walks,
    get changed() {
      return changed;
    },
    ws,
    gate,
    failWalk,
    armWalkFail: (msg) => {
      walkFailMsg = msg;
    },
    breakPath: (path) => {
      broken.add(path);
    },
    healPath: (path) => {
      broken.delete(path);
    },
    emit,
    parser: () => services.get('erb.parser') as ErbParserService,
    state: () => {
      const fn = (services.get('erb.parser') as ErbParserService).indexState;
      if (!fn) throw new Error('erb.parser 未提供 indexState()（IDX-STATE 事实面缺席）');
      return fn();
    },
    dispose: () => {
      for (const d of disposers.reverse()) d();
    },
  };
}

function openProject(h: Harness, rootDir: string, kojoPaths: string[]): void {
  const project: GameProject = { rootDir, adapterId: 'test', kojoPaths, writablePaths: [], charaIndex: new Map() };
  h.emit('project.opened', { project });
}

/** 异步收尾（重扫那条路）没有可直接 await 的把手：轮询到判据成立，超时即失败说明 */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error(`等待超时：${what}`);
}

const wsFact = (s: ErbIndexState) => s.sources.find((f) => f.source === 'workspace')!;
const projectFact = (s: ErbIndexState) => s.sources.find((f) => f.source === 'project')!;

/* ============================ 时机面 ============================ */

describe('erb-parser · indexState() 的时机面', () => {
  it('起跑前 idle；收尾 ready，且根数/文件数/名录条数一并可读', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    expect(h.state()).toMatchObject({ phase: 'idle', rootsWalked: 0, coverage: 'none' });

    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    const s = h.state();
    expect(s.phase).toBe('ready');
    expect(s.rootsWalked).toBe(2);
    expect(s.filesScanned).toBe(idx.files.size);
    expect(s.functions).toBe(idx.byName.size);
    expect(s.functions).toBe(2);
    expect(s.coverage).toBe('full');
    h.dispose();
  });

  it('在途那一格读得出"正在扫"+ 已扫文件数读数（不是一句永远不变的占位）', async () => {
    const files = baseFiles();
    const h = activateWith(files, ['/ws/default']);
    // 第一趟 walk 放行、第二趟卡住 ⇒ 手里有"扫完 1 个根"的进度读数
    h.gate.holdFrom(2);
    openProject(h, '/game', ['/game/kojo']);
    await waitUntil(() => h.walks.length === 2, '第二趟 walk 已起跑并被闸停住');

    const mid = h.state();
    expect(mid.phase).toBe('scanning');
    expect(mid.filesScanned).toBe(1); // 口上根那一份已经扫到
    expect(mid.rootsWalked).toBe(2); // 起跑时就定下来的本轮根数
    expect(mid.functions).toBe(0); // 名录还没聚合 ⇒ 不假装知道

    h.gate.release();
    await h.parser().ensureIndex();
    expect(h.state().phase).toBe('ready');
    h.dispose();
  });

  it('项目关闭复位 idle：上一棵树的读数不许留着回答"这一轮怎么样了"', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    expect(h.state().phase).toBe('ready');

    h.emit('project.closed', { rootDir: '/game' });
    expect(h.state()).toMatchObject({ phase: 'idle', rootsWalked: 0, filesScanned: 0, functions: 0, sources: [] });
    h.dispose();
  });

  it('过期代际一笔都不写：被项目关闭作废的那轮构建收尾时不许盖掉当前事实', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.gate.holdFrom(1); // 第一趟就停住
    openProject(h, '/game', ['/game/kojo']);
    expect(h.state().phase).toBe('scanning');

    h.emit('project.closed', { rootDir: '/game' }); // generation++ ⇒ 在途那轮过期
    expect(h.state().phase).toBe('idle');

    h.gate.release();
    // 给过期构建走完剩余管线的时间（两趟 walk 都在手 + 30ms 的余量）：它**跑完了**才算
    // "过期那一笔确实没写进来"，而不是"还没来得及写"
    await waitUntil(() => h.walks.length >= 2, '过期构建的两趟 walk 都走完');
    await new Promise((r) => setTimeout(r, 30));
    // 过期构建照常产出并交回（既有语义不动），但它**不写事实面**
    expect(h.state().phase).toBe('idle');
    expect(h.state().rootsWalked).toBe(0);
    h.dispose();
  });


  it('walkDir 抛 ⇒ phase=failed 且原始原因可读（不是"正在构建"那句假话）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.armWalkFail('EACCES: permission denied, scandir /game/kojo');
    openProject(h, '/game', ['/game/kojo']);
    await expect(h.parser().ensureIndex()).rejects.toThrow(/EACCES/);

    const s = h.state();
    expect(s.phase).toBe('failed');
    expect(s.error).toContain('EACCES');
    expect(h.parser().currentIndex()).toBeNull(); // 失败不产假索引（既有语义一字未动）
    h.dispose();
  });
});

/* ============================ 三态分形 ============================ */

describe('erb-parser · 三态是分得开的三枚事实', () => {
  it('没有任何可扫描的位置 ⇒ nothing-to-scan（不是"扫完了"）', async () => {
    const h = activateWith(baseFiles(), []);
    openProject(h, '/game', []); // 项目开了，但既没有口上目录、工作区也没授权
    const idx = await h.parser().ensureIndex();

    const s = h.state();
    expect(s.phase).toBe('nothing-to-scan');
    expect(s.coverage).toBe('none');
    expect(s.rootsWalked).toBe(0);
    expect(s.filesScanned).toBe(0);
    expect(idx.byName.size).toBe(0);
    h.dispose();
  });

  it('走得到位置、也扫到了文件，但一个函数都没有 ⇒ empty（与"没地方可扫"不同态）', async () => {
    const h = activateWith(baseFiles(), ['/ws/quiet']);
    openProject(h, '/game', []); // 只有工作区那一条根
    await h.parser().ensureIndex();

    const s = h.state();
    expect(s.phase).toBe('empty');
    expect(s.rootsWalked).toBe(1);
    expect(s.filesScanned).toBe(1); // 确实扫到了一份 .ERH
    expect(s.functions).toBe(0);
    h.dispose();
  });

  it('两态在 filesScanned 同为 0 时也分得开（判据取形状，不取读数）', async () => {
    const nowhere = activateWith(baseFiles(), []);
    openProject(nowhere, '/game', []);
    await nowhere.parser().ensureIndex();
    const emptyRoot = activateWith({ '/ws/quiet/empty.txt': 'no dialect file here' }, ['/ws/quiet']);
    openProject(emptyRoot, '/game', []);
    await emptyRoot.parser().ensureIndex();

    expect(nowhere.state().filesScanned).toBe(0);
    expect(emptyRoot.state().filesScanned).toBe(0);
    expect(nowhere.state().phase).toBe('nothing-to-scan');
    expect(emptyRoot.state().phase).toBe('empty');
    nowhere.dispose();
    emptyRoot.dispose();
  });
});

/* ============================ 降级可见（本刀存在理由） ============================ */

describe('erb-parser · 工作区降级读得出"少了哪一类位置"（不断言 console）', () => {
  it('`roots()` 抛 ⇒ workspace 那枚事实 available=false / offered=0 / 原始原因逐字在，coverage=partial', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.ws.fail = 'service-roots';
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    const s = h.state();
    expect(s.sources.map((f) => f.source)).toEqual(['project', 'workspace']);
    expect(projectFact(s)).toEqual({ source: 'project', offered: 1, available: true });
    expect(wsFact(s).available).toBe(false);
    expect(wsFact(s).offered).toBe(0);
    expect(wsFact(s).reason).toContain('no platform data dir');
    expect(s.coverage).toBe('partial'); // 与成功那一轮**不同形**
    h.dispose();
  });

  it('服务键缺席（inject 抛）⇒ 同一枚降级事实（两条退路同形）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.ws.fail = 'inject';
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    expect(wsFact(h.state()).available).toBe(false);
    expect(h.state().coverage).toBe('partial');
    h.dispose();
  });

  it('降级的那棵树与扫全了的那棵树不同形（其余读数可以完全一样）', async () => {
    const ok = activateWith(baseFiles(), ['/ws/default']);
    openProject(ok, '/game', ['/game/kojo']);
    await ok.parser().ensureIndex();

    const degraded = activateWith(baseFiles(), ['/ws/default']);
    degraded.ws.fail = 'service-roots';
    openProject(degraded, '/game', ['/game/kojo']);
    await degraded.parser().ensureIndex();

    expect(ok.state().rootsWalked).toBe(2);
    expect(degraded.state().rootsWalked).toBe(1);
    expect(ok.state().coverage).toBe('full');
    expect(degraded.state().coverage).toBe('partial');
    // 少的不只是数字：**哪一类位置没读到**本身就是事实（消费方据此标出"少扫了一类位置"）
    expect(wsFact(ok.state()).available).toBe(true);
    expect(wsFact(degraded.state()).available).toBe(false);
    expect(wsFact(degraded.state()).offered).toBe(0);
    expect(projectFact(ok.state())).toEqual(projectFact(degraded.state())); // 口上那一侧两棵树完全同形
    ok.dispose();
    degraded.dispose();
  });

  it('工作区恢复可用 ⇒ 降级事实当轮撤销（coverage 不许粘住）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.ws.fail = 'service-roots';
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    expect(h.state().coverage).toBe('partial');

    h.ws.fail = null;
    h.emit('file.changed', { kind: 'add', path: WS_FILE });
    await waitUntil(() => h.changed === 2, '工作区恢复后的重扫收尾');

    const s = h.state();
    expect(wsFact(s).available).toBe(true);
    expect(s.coverage).toBe('full');
    h.dispose();
  });

  it('作者没授权工作区（读到空清单）不算降级：available=true / offered=0 / coverage=full', async () => {
    const h = activateWith(baseFiles(), []);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    const s = h.state();
    expect(wsFact(s)).toEqual({ source: 'workspace', offered: 0, available: true });
    expect(s.coverage).toBe('full');
    h.dispose();
  });
});

/* ============================ 逐文件失败面（IDX-SILENT，2026-10-20） ============================ */

/**
 * 本刀要补的洞：走到、但没读成/没解析成的文件此前只有一声 console `warn`，
 * 事实面上**与"盘上没有这个文件"同形**；唯一可推的信号 `filesScanned − index.files.size`
 * 在"上一轮快照顶替"那一类降级上仍然是 0（旧内容补进了索引）⇒ 与全成功完全同形。
 *
 * 夹具用 `breakPath()`：路径**照旧被 walk 交出来**（盘上有它），只是这一轮读/stat 失败。
 */
describe('erb-parser · 逐文件失败面：失败 ≠ 没有这个文件（IDX-SILENT）', () => {
  it('被快照顶替的那一类也计成失败，而 filesScanned === index.files.size 照旧成立（改前与全成功同形）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    const first = await h.parser().ensureIndex();
    expect(h.state().filesFailed).toBe(0); // 全成功那一轮：零失败、差值也是 0

    // 第二轮：WS_FILE 读不到，但快照里那份旧解析结果还在 ⇒ 它会补进 index.files。
    // 不重新走"起跑"的话根签名没变、不会重扫（既有判据），故用 project.opened 起新一轮。
    h.breakPath(WS_FILE);
    openProject(h, '/game', ['/game/kojo']);
    const second = await h.parser().ensureIndex();

    const s = h.state();
    expect(s.filesFailed).toBe(1);
    expect(s.failures).toEqual([{ path: WS_FILE, reason: 'read' }]);
    // ↓ 这就是"今天看不出降级"的那组读数：走到的文件数与索引里的文件数**完全相等**
    expect(s.filesScanned).toBe(2);
    expect(second.files.size).toBe(2);
    expect(s.filesScanned).toBe(second.files.size);
    expect(second.files.has(WS_FILE)).toBe(true); // 旧内容顶替：文件仍在名录里
    expect(second.files.get(WS_FILE)!.functions[0]!.name).toBe(first.files.get(WS_FILE)!.functions[0]!.name);
    expect(s.phase).toBe('ready'); // 失败不改三态判据（不拿"有失败"冒充"索引坏了"）
    h.dispose();
  });

  it('没被快照顶替的那一类同样读得出失败（走到的比索引里的多时，是谁走岔了）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.breakPath(WS_FILE); // 首轮就没有可用快照 ⇒ 这一份缺失没有旧内容可顶替
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    const s = h.state();
    expect(s.filesScanned).toBe(2);
    expect(idx.files.size).toBe(1);
    expect(s.filesFailed).toBe(1);
    expect(s.failures?.[0]).toEqual({ path: WS_FILE, reason: 'read' });
    expect(idx.byName.has('WS_FOO')).toBe(false); // 与"盘上没有这个函数"仍然不同：失败面说出了原因
    h.dispose();
  });

  it('失败面不跨轮粘连：下一轮读得回来 ⇒ 计数归零、样本键不出现', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.breakPath(WS_FILE);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    expect(h.state().filesFailed).toBe(1);

    h.healPath(WS_FILE);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    const s = h.state();
    expect(s.filesFailed).toBe(0);
    expect('failures' in s).toBe(false);
    h.dispose();
  });
});
