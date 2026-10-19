/**
 * 索引根扩到作者工作区的**接线**单测（IDX-ROOT，2026-10-19）。
 *
 * 与 `index-roots.test.ts` 的分工：那里钉判据（哪些根该走），这里钉装配——
 * 构建真的用了并集、`roots()` 抛时**退化成只有口上根并出声**、签名变了真的
 * `generation++` 作废在途并重扫、以及**本刀的存在理由**：作者工作区里那份
 * `.ERB` 定义第一次被 `erb-definition` 命中（扩根之前那条腿只会交空数组）。
 *
 * 夹具刻意**只**实现 `roots()`（本包只消费它；多一个成员都不给，插件侧可消费的面就这一寸）。
 * 自带的上下文体（不动 `plugin.test.ts` 的共享夹具，避免并行改同一文件）。
 */

import { describe, expect, it } from 'vitest';
import {
  KernelServices,
  isPathUnder,
  type EditorWorkspaceSymbol,
  type ErbParserService,
  type EventBus,
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
const WS_DEFAULT = '/ws/default/b.ERB';
const WS_AUTHORIZED = '/ws/extra/c.ERM';
const SESSION_EXTRA = '/session/extra/x.ERB';

/** 每枚用例各拿一份**独立**的盘（用例会在中途"新建文件"，共享常量对象会互相污染） */
function baseFiles(): Record<string, string> {
  return {
    [GAME_FILE]: '@GAME_FOO\n\tRETURN 1\n',
    [WS_DEFAULT]: '@WS_FOO(ARG)\n\tRETURN 1\n',
    [WS_AUTHORIZED]: '@EXTRA_FOO\n\tPRINTL x\n',
    [SESSION_EXTRA]: '@SESSION_ONLY\n\tRETURN 1\n',
  };
}

/** 伪 IO 的闸门：`hold()` 后每次 walkDir 停在"已记账、未返回"那一步，`release()` 放行 */
interface Gate {
  hold(): void;
  release(): void;
  wait(): Promise<void>;
}

function makeGate(): Gate {
  let held = false;
  const parked: Array<() => void> = [];
  const gate: Gate = {
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const r of parked.splice(0)) r();
    },
    async wait(): Promise<void> {
      while (held) await new Promise<void>((resolve) => parked.push(resolve));
    },
  };
  return gate;
}

function makeIO(files: Record<string, string>, walks: string[], gate: Gate): FileIO {
  return {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 1 };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = files[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1 };
      });
    },
    async stat(path: string) {
      const text = files[path];
      return text === undefined ? null : { size: text.length, mtimeMs: 1, isDirectory: false };
    },
    async isWritable() {
      return false;
    },
    async walkDir(root: string) {
      // **记账在闸之前**：这样"这一轮到底去走了哪个根"在无 await 的断言里就看得见
      walks.push(root);
      await gate.wait();
      // 真目录里什么都有：方言判定归插件（`.kojo` 那条反向钉正是靠这里**不**过滤）
      return Object.keys(files)
        .filter((p) => isPathUnder(root, p))
        .map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

/* ---------------- 上下文体 ---------------- */

interface WorkspaceFake {
  /** `roots()` 的返回值（可中途追加 = 模拟作者刚经目录对话框授权了一个落点） */
  roots: string[];
  /** `'service-roots'` = `roots()` 抛；`'inject'` = 服务键缺席；`null` = 正常 */
  fail: 'service-roots' | 'inject' | null;
  calls: number;
}

interface Harness {
  logs: string[];
  walks: string[];
  changed: Array<{ projectRoot: string; files: string[] }>;
  slots: Array<{ kind: string; contribution: Record<string, unknown> }>;
  ws: WorkspaceFake;
  gate: Gate;
  emit(type: string, payload: unknown): void;
  parser(): ErbParserService;
  dispose(): void;
}

function activateWith(files: Record<string, string>, workspaceRoots: string[]): Harness {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const walks: string[] = [];
  const changed: Harness['changed'] = [];
  const slots: Harness['slots'] = [];
  const disposers: Array<() => void> = [];
  const gate = makeGate();
  const ws: WorkspaceFake = { roots: [...workspaceRoots], fail: null, calls: 0 };

  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const on = (type: string, handler: (p: unknown) => void): Unsubscribe => {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  };
  const emit = (type: string, payload: unknown): void => {
    if (type === 'kojo.functionChanged') changed.push(payload as Harness['changed'][number]);
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
      if (key === 'kernel.io') return makeIO(files, walks, gate) as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      if (key === KernelServices.Workspaces) {
        if (ws.fail === 'inject') throw new Error(`Service '${key}' is not available (required by 'erb-parser')`);
        const service = {
          roots: () => {
            ws.calls++;
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
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        slots.push({ kind, contribution });
        return () => undefined;
      },
      query: () => [],
    },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;

  createErbParserPlugin().activate(ctx);
  return {
    logs,
    walks,
    changed,
    slots,
    ws,
    gate,
    emit,
    parser: () => services.get('erb.parser') as ErbParserService,
    dispose: () => {
      for (const d of disposers.reverse()) d();
    },
  };
}

/** 异步收尾（重扫那条路）没有可直接 await 的把手：轮询到判据成立，超时即失败说明 */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error(`等待超时：${what}`);
}

function openProject(h: Harness, rootDir: string, kojoPaths: string[]): void {
  const project: GameProject = { rootDir, adapterId: 'test', kojoPaths, writablePaths: [], charaIndex: new Map() };
  h.emit('project.opened', { project });
}

type LanguageServiceContribution = {
  provide(request: unknown): unknown;
};
function languageServiceOf(h: Harness, id: string): LanguageServiceContribution {
  const hit = h.slots.find((s) => s.kind === 'ui.editor.languageService' && s.contribution.id === id);
  if (!hit) throw new Error(`ui.editor.languageService '${id}' 未注册`);
  return hit.contribution as unknown as LanguageServiceContribution;
}

const degradeLog = (h: Harness) => h.logs.filter((l) => l.includes('Workspace roots unavailable'));

/* ============================ 并集 ============================ */

describe('erb-parser · 索引根 = kojoPaths ∪ 工作区全部根', () => {
  it('构建走的是并集：两侧的定义都进名录，重复写法不再多走一遍', async () => {
    const h = activateWith(baseFiles(), ['/ws/default', '/ws/default/', '/ws/extra']);
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    expect(h.walks).toEqual(['/game/kojo', '/ws/default', '/ws/extra']);
    expect([...idx.byName.keys()].sort()).toEqual(['EXTRA_FOO', 'GAME_FOO', 'WS_FOO']);
    expect([...idx.files.keys()].sort()).toEqual([GAME_FILE, WS_AUTHORIZED, WS_DEFAULT].sort());
    h.dispose();
  });

  it('端到端一条腿：作者工作区里的定义第一次被 `erb-definition` 命中（扩根前这里是空数组）', async () => {
    const caller = '/ws/default/caller.ERB';
    const files = baseFiles();
    files[caller] = '@CALLER\n\tCALL WS_FOO(1)\n';
    const h = activateWith(files, ['/ws/default', '/ws/extra']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    const res = languageServiceOf(h, 'erb-definition').provide({
      kind: 'definition',
      path: caller,
      text: files[caller]!,
      line: 2, // `CALL WS_FOO(1)`
      column: 8,
      project: null,
    });
    expect(res).toEqual({ kind: 'definition', locations: [{ filePath: WS_DEFAULT, line: 1 }] });
    h.dispose();
  });

  it('工作区符号腿同样吃得到作品侧定义（五条腿共用这一份名录）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    const res = languageServiceOf(h, 'erb-workspace-symbols').provide({
      kind: 'workspaceSymbol',
      query: 'ws_',
      limit: 50,
      project: null,
    }) as { symbols: readonly EditorWorkspaceSymbol[] };
    expect(res.symbols.map((s) => s.filePath)).toEqual([WS_DEFAULT]);
    h.dispose();
  });

  it('`.kojo` 不进索引（糖线自管；方言清单只有 `.erb/.erm/.erh`）', async () => {
    const files = baseFiles();
    files['/ws/default/note.kojo'] = '@KOJO_ONLY\n\tRETURN 1\n';
    const h = activateWith(files, ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    expect(idx.byName.has('KOJO_ONLY')).toBe(false);
    expect([...idx.files.keys()]).not.toContain('/ws/default/note.kojo');
    h.dispose();
  });

  it('会话级附加根（D1）不进索引：它既不在 kojoPaths 也不在 `roots()` 里 ⇒ 一条都不扫', async () => {
    const h = activateWith(baseFiles(), ['/ws/default', '/ws/extra']);
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    expect(idx.byName.has('SESSION_ONLY')).toBe(false);
    expect(h.walks).not.toContain('/session/extra');
    h.dispose();
  });

  it('工作区根与口上目录互为邻居（`<根>-备份`）时各走各的：边界语义单源于 `isPathUnder`', async () => {
    const files = baseFiles();
    files['/game/kojo-备份/z.ERB'] = '@NEIGHBOUR_ONLY\n\tRETURN 1\n';
    const h = activateWith(files, ['/game/kojo-备份']);
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    expect(h.walks).toEqual(['/game/kojo', '/game/kojo-备份']);
    expect([...idx.files.keys()].sort()).toEqual([GAME_FILE, '/game/kojo-备份/z.ERB'].sort());
    h.dispose();
  });
});

/* ============================ 降级（不静默） ============================ */

describe('erb-parser · 工作区不可用时退化', () => {
  it('`roots()` 抛（无平台数据目录的浏览器开发壳）⇒ 只扫口上根，并留下一条可见记录', async () => {
    const h = activateWith(baseFiles(), ['/ws/default', '/ws/extra']);
    h.ws.fail = 'service-roots';
    openProject(h, '/game', ['/game/kojo']);
    const idx = await h.parser().ensureIndex();

    expect(h.walks).toEqual(['/game/kojo']);
    expect([...idx.byName.keys()]).toEqual(['GAME_FOO']);
    expect(degradeLog(h)).toHaveLength(1);
    expect(degradeLog(h)[0]).toContain('no platform data dir');
    h.dispose();
  });

  it('服务键缺席（`inject` 抛）⇒ 同一待遇：退化 + 出声，且翻转时才再出声（不刷屏）', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    h.ws.fail = 'inject';
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    expect(h.walks).toEqual(['/game/kojo']);
    // 之后的既有时刻再比若干次：同一条降级只说一遍（`file.changed` 是高频时刻）
    h.emit('file.changed', { kind: 'change', path: GAME_FILE });
    h.emit('editor.activeFileChanged', { filePath: GAME_FILE });
    expect(degradeLog(h)).toHaveLength(1);

    // 恢复可用 ⇒ 降级标志复位（下一次失败会再出声），而这一轮就重新扫了
    h.ws.fail = null;
    h.emit('file.changed', { kind: 'change', path: GAME_FILE });
    await waitUntil(() => h.changed.length === 2, '工作区恢复后重扫收尾');
    expect(h.walks).toContain('/ws/default');
    h.dispose();
  });

  it('无项目态不在本刀范围：没有口上根就照旧明确报"未打开项目"，不拿工作区根凑一副索引', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    await expect(h.parser().ensureIndex()).rejects.toThrow(/No project is open/);
    expect(h.walks).toEqual([]);
    h.dispose();
  });
});

/* ============================ 换根 ⇒ 重扫（generation 语义） ============================ */

describe('erb-parser · 扫描根变更 ⇒ 作废在途构建并重扫', () => {
  it('在途期间授权新落点：旧构建的产物被代际号丢弃，全程只广播一次且含新根的文件', async () => {
    const files = baseFiles();
    const h = activateWith(files, ['/ws/default', '/ws/extra']);
    h.gate.hold();
    openProject(h, '/game', ['/game/kojo']);
    expect(h.walks).toEqual(['/game/kojo']); // 第一轮卡在第一个根上

    // 作者经目录对话框授权了新的项目位置，并在里面落了文件（今天没有任何事件说"根变了"）
    h.ws.roots.push('/ws/new');
    files['/ws/new/fresh.ERB'] = '@FRESH_FOO\n\tRETURN 1\n';
    h.emit('file.changed', { kind: 'add', path: '/ws/new/fresh.ERB' });

    expect(h.logs.some((l) => l.includes('Index scan roots changed'))).toBe(true);
    expect(h.walks).toEqual(['/game/kojo', '/game/kojo']); // 第二轮已起跑（第一轮被作废）

    h.gate.release();
    const idx = await h.parser().ensureIndex();

    expect([...idx.byName.keys()].sort()).toEqual(['EXTRA_FOO', 'FRESH_FOO', 'GAME_FOO', 'WS_FOO']);
    // **generation 语义**：过期构建既不落 `index` 也不广播 ⇒ 全程只有一条 functionChanged，
    // 而且它带着新根里那份文件（旧构建若抢着收尾就会是四条名、且绝无 FRESH_FOO）
    expect(h.changed).toHaveLength(1);
    expect(h.changed[0]!.files).toContain('/ws/new/fresh.ERB');
    h.dispose();
  });

  it('签名一致时既有时刻什么都不做：不为"没变更"付一次全树遍历', async () => {
    const h = activateWith(baseFiles(), ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    const before = h.walks.length;

    h.emit('file.changed', { kind: 'change', path: WS_DEFAULT });
    h.emit('editor.activeFileChanged', { filePath: WS_DEFAULT });
    await h.parser().ensureIndex();

    expect(h.walks).toHaveLength(before);
    expect(h.changed).toHaveLength(1);
    h.dispose();
  });

  it('切文件也是活读时刻：语言服务腿不经 `ensureIndex`，光靠那条兜不住这一步', async () => {
    const files = baseFiles();
    const h = activateWith(files, ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();

    h.ws.roots.push('/ws/late');
    files['/ws/late/late.ERB'] = '@LATE_FOO\n\tRETURN 1\n';
    h.emit('editor.activeFileChanged', { filePath: '/ws/late/late.ERB' });
    await waitUntil(() => h.changed.length === 2, '换根后切文件触发重扫并广播');

    expect(h.walks).toContain('/ws/late');
    expect(h.parser().currentIndex()!.byName.has('LATE_FOO')).toBe(true);
    h.dispose();
  });

  it('项目关闭清空一切：新授权的工作区根不会再在关项目状态被扫', async () => {
    const files = baseFiles();
    const h = activateWith(files, ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    h.emit('project.closed', { rootDir: '/game' });
    const before = h.walks.length;

    h.ws.roots.push('/ws/late');
    files['/ws/late/late.ERB'] = '@LATE_FOO\n\tRETURN 1\n';
    h.emit('file.changed', { kind: 'add', path: '/ws/late/late.ERB' });
    expect(h.walks).toHaveLength(before);
    await expect(h.parser().ensureIndex()).rejects.toThrow(/No project is open/);
    h.dispose();
  });
});

/* ============================ 不缓存根 ============================ */

describe('erb-parser · 索引侧不缓存工作区根', () => {
  it('每一轮都现读 `roots()`：缓存一次定死 = 本会话刚授权的落点被永久排除', async () => {
    const files = baseFiles();
    const h = activateWith(files, ['/ws/default']);
    openProject(h, '/game', ['/game/kojo']);
    await h.parser().ensureIndex();
    expect(h.ws.calls).toBeGreaterThan(0);
    const afterFirstBuild = h.ws.calls;

    h.ws.roots.push('/ws/late');
    files['/ws/late/late.ERB'] = '@LATE_FOO\n\tRETURN 1\n';
    h.emit('file.changed', { kind: 'add', path: '/ws/late/late.ERB' });
    await waitUntil(() => h.changed.length === 2, '新授权根的重扫收尾广播');

    expect(h.ws.calls).toBeGreaterThan(afterFirstBuild);
    expect(h.parser().currentIndex()!.byName.has('LATE_FOO')).toBe(true);
    h.dispose();
  });
});
