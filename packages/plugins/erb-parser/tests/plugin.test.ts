import { describe, expect, it } from 'vitest';
import type {
  ErbParserService,
  EventBus,
  FileIO,
  GameProject,
  LineDecoration,
  PluginContext,
  Unsubscribe,
} from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { erbParserTasks } from '../src/offload';
import { makeComputeStub } from './support';

/** 伪 FileIO：只用得到 readText / readTexts / walkDir / stat */
function fakeIO(files: Record<string, string>, isWritable?: (path: string) => boolean): FileIO {
  return {
    // 缺省 = 一律可写（本包绝大多数用例不关心写权限；💡 修复那条用例显式传 false）
    ...(isWritable ? { isWritable } : {}),
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async readTexts(paths: readonly string[]) {
      // 与内核 io 同语义：与入参一一对应，失败位 null（不整批抛）
      return paths.map((path) => {
        const text = files[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(path: string) {
      const text = files[path];
      if (text === undefined) return null;
      // mtimeMs 恒 null = 平台未提供 → 快照逻辑按"保守过期"处理（与 readText 口径一致）
      return { size: text.length, mtimeMs: null, isDirectory: false };
    },
    // WS-05：`file.changed` 去抖落地前会先 `exists` 判删（改名常以 change 报告旧路径已不在）
    async exists(path: string) {
      return files[path] !== undefined;
    },
    async walkDir(root: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(root))
        .map((p) => ({
          name: p.split('/').pop() ?? p,
          path: p,
          isDirectory: false,
        }));
    },
  } as unknown as FileIO;
}

/** 最小事件总线（测试用；只覆盖 on/once/emit） */
function makeBus(): { bus: EventBus; emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const on = (type: string, handler: (p: unknown) => void): Unsubscribe => {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
  const once = (type: string, handler: (p: unknown) => void): Unsubscribe => {
    const un = on(type, (p) => {
      un();
      handler(p);
    });
    return un;
  };
  const emit = (type: string, payload: unknown): void => {
    for (const h of [...(handlers.get(type) ?? [])]) h(payload);
  };
  return { bus: { on, once, emit } as unknown as EventBus, emit };
}

/** 测试侧记录的槽位贡献形状（只声明本包会用到的那几个字段） */
interface RegisteredSlot {
  kind: string;
  contribution: {
    id: string;
    title?: string;
    order?: number;
    /** 契约 additive 字段（2026-10-16 装饰热路径批） */
    offloadKind?: string;
    decorate?: (f: { path: string; text: string; project: GameProject | null }) => unknown[];
    provideActions?: (f: {
      path: string;
      text: string;
      project: GameProject | null;
      lineCount?: number;
      line?: number;
      /** B9：宿主点明的"本次请求对应的当前波浪线"（测试里手动给，缺省 = 旧宿主） */
      diagnostics?: LineDecoration[];
    }) => Array<{
      title: string;
      kind?: string;
      diagnostics?: LineDecoration[];
      edits?: Array<{ fromLine: number; toLine: number; newText: string }>;
    }>;
  };
}

/** 最小上下文体：只验证插件行为，不拉整个 kernel */
function activatePlugin(io: FileIO): {
  services: Map<string, unknown>;
  logs: string[];
  bus: EventBus;
  /** 捕获到的槽位贡献（本包有两个：ui.editor.decorator 与 ui.editor.codeAction） */
  slots: RegisteredSlot[];
  emit: (type: string, payload: unknown) => void;
  dispose: () => void;
} {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const slots: RegisteredSlot[] = [];
  const { bus, emit } = makeBus();
  const disposers: Array<() => void> = [];
  const compute = makeComputeStub();
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
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.compute') return compute as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    // 内存存储域（内核优化批：索引快照的落点；每次 activate 独立实例，测试互不影响）
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
      register: (kind: string, contribution: RegisteredSlot['contribution']) => {
        slots.push({ kind, contribution });
        return () => undefined;
      },
      query: () => [],
    },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return {
    services,
    logs,
    bus,
    slots,
    emit,
    dispose: () => {
      for (const d of disposers.reverse()) d();
    },
  };
}

function fakeProject(rootDir: string, kojoPaths: string[]): GameProject {
  return {
    rootDir,
    adapterId: 'test',
    kojoPaths,
    writablePaths: [],
    charaIndex: new Map(),
  };
}

describe('erb-parser 插件', () => {
  it('provides erb.parser 服务；requires kernel.io', () => {
    const plugin = createErbParserPlugin();
    expect(plugin.provides).toContain('erb.parser');
    expect(plugin.requires).toContain('kernel.io');
  });

  it('parseFile 走 io.readText（编码探测由内核负责）', async () => {
    const { services } = activatePlugin(fakeIO({ '/t/a.ERB': '@FOO\nPRINTL x\n' }));
    const parser = services.get('erb.parser') as ErbParserService;
    const f = await parser.parseFile('/t/a.ERB');
    expect(f.functions[0]!.name).toBe('FOO');
    expect(f.path).toBe('/t/a.ERB');
  });

  it('buildIndex 汇总多文件、按归一化名索引、重名保留多定义', async () => {
    const { services } = activatePlugin(
      fakeIO({
        '/root/a.ERB': '@ALPHA\nPRINTL 1\n@COMMON\nPRINTL 2\n',
        '/root/sub/b.ERB': '@BETA\nPRINTL 3\n@common\nPRINTL 4\n',
        '/root/not-erb.txt': '@IGNORED\n',
      }),
    );
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/root']);
    expect(index.files.size).toBe(2);
    expect([...index.byName.keys()].sort()).toEqual(['ALPHA', 'BETA', 'COMMON']);
    expect(index.byName.get('COMMON')).toHaveLength(2); // 大小写不同视为同名（Emuera 语义）
  });

  it('buildIndex 对单文件解析失败不中断（记警告）', async () => {
    const io = fakeIO({ '/root/a.ERB': '@A\n' });
    // 让某个文件批量读的失败位落 null（与 readText 抛错同语义）
    const failing: FileIO = {
      ...io,
      async readText(path: string) {
        if (path.endsWith('broken.ERB')) throw new Error('io fail');
        return io.readText(path);
      },
      async readTexts(paths: readonly string[]) {
        return (await io.readTexts(paths)).map((tf, i) =>
          paths[i]!.endsWith('broken.ERB') ? null : tf,
        );
      },
      async walkDir(root: string) {
        const r = await io.walkDir(root);
        return [...r, { name: 'broken.ERB', path: '/root/broken.ERB', isDirectory: false }];
      },
    } as FileIO;
    const { services, logs } = activatePlugin(failing);
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/root']);
    expect(index.files.size).toBe(1);
    expect(logs.some((l) => l.includes('read failed'))).toBe(true);
  });

  describe('v0.2 响应式索引所有权', () => {
    it('无项目时 currentIndex 为 null，ensureIndex 显式报错', async () => {
      const { services } = activatePlugin(fakeIO({}));
      const parser = services.get('erb.parser') as ErbParserService;
      expect(parser.currentIndex()).toBeNull();
      await expect(parser.ensureIndex()).rejects.toThrow(/No project is open/);
    });

    it('project.opened 自动构建索引并发 kojo.functionChanged；ensureIndex 与其共享结果', async () => {
      const { services, bus, emit } = activatePlugin(
        fakeIO({
          '/proj/kojo/a.ERB': '@M_KOJO_K1\nRETURN 1\n@M_KOJO_MESSAGE_COM_K1_1\nPRINTL x\n',
        }),
      );
      const parser = services.get('erb.parser') as ErbParserService;

      const changed = new Promise<{ projectRoot: string; files: string[] }>((resolve) => {
        bus.once('kojo.functionChanged', (p) => resolve(p as { projectRoot: string; files: string[] }));
      });

      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      const ev = await changed;

      expect(ev.projectRoot).toBe('/proj');
      expect(ev.files).toEqual(['/proj/kojo/a.ERB']);
      const idx = parser.currentIndex();
      expect(idx).not.toBeNull();
      expect([...idx!.byName.keys()].sort()).toEqual(['M_KOJO_K1', 'M_KOJO_MESSAGE_COM_K1_1']);
      await expect(parser.ensureIndex()).resolves.toBe(idx);
    });

    it('project.closed 清空索引', async () => {
      const { services, bus, emit } = activatePlugin(fakeIO({ '/proj/kojo/a.ERB': '@A\n' }));
      const parser = services.get('erb.parser') as ErbParserService;
      const changed = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await changed;
      expect(parser.currentIndex()).not.toBeNull();

      emit('project.closed', { rootDir: '/proj' });
      expect(parser.currentIndex()).toBeNull();
    });

    /* ---- WS-02 重命名迁移：rebuildIndex（契约 additive） ---- */

    it('rebuildIndex 无项目时明确 reject（与 ensureIndex 同口径）', async () => {
      const { services } = activatePlugin(fakeIO({}));
      const parser = services.get('erb.parser') as ErbParserService;
      expect(typeof parser.rebuildIndex).toBe('function');
      await expect(parser.rebuildIndex!()).rejects.toThrow(/No project is open/);
    });

    it('rebuildIndex 已有索引也重扫：旧路径消失、新路径进来，收尾广播并替换当前索引', async () => {
      // fakeIO 闭包持有同一份 files 对象 ⇒ 原地增删即可模拟盘上改名
      const files: Record<string, string> = { '/proj/kojo/old/a.ERB': '@OLD_FN\nRETURN 1\n' };
      const { services, bus, emit } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;

      const first = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await first;
      expect(parser.currentIndex()!.files.has('/proj/kojo/old/a.ERB')).toBe(true);

      delete files['/proj/kojo/old/a.ERB'];
      files['/proj/kojo/new/a.ERB'] = '@NEW_FN\nRETURN 2\n';
      const second = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      const rebuilt = await parser.rebuildIndex!();
      await second;

      expect([...rebuilt.files.keys()]).toEqual(['/proj/kojo/new/a.ERB']);
      expect([...rebuilt.byName.keys()]).toEqual(['NEW_FN']);
      expect(rebuilt.byName.has('OLD_FN')).toBe(false); // 旧路径不留幽灵行
      expect(parser.currentIndex()).toBe(rebuilt); // 当前索引已换成新一轮
    });

    /* ---- WS-05 增量：`applyFileChanges`（契约 additive）+ `file.changed` 去抖 ---- */

    /**
     * 等整扫收尾：`kojo.functionChanged` 在 `startBuild` 内发出，而 `inFlight` 要等它
     * 返回后才清——这一瞬调 `applyFileChanges` 会被"整扫在跑"挡回去（那是对的，整扫
     * 读的就是盘上现状），但测试要钉增量本身，得先等那一轮落地。
     */
    const settleBuild = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

    it('applyFileChanges：改一格只重读那一格，旧函数退场、新函数进来并广播', async () => {
      const files: Record<string, string> = {
        '/proj/kojo/a.ERB': '@OLD_FN\nRETURN 1\n',
        '/proj/kojo/b.ERB': '@KEEP_FN\nRETURN 2\n',
      };
      const { services, bus, emit } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      files['/proj/kojo/a.ERB'] = '@FRESH_FN\nRETURN 3\n';
      const broadcast = new Promise<string[]>((resolve) => {
        bus.once('kojo.functionChanged', (p) => resolve((p as { files: string[] }).files));
      });
      const next = await parser.applyFileChanges!({ changed: ['/proj/kojo/a.ERB'], removed: [] });
      expect(await broadcast).toEqual(['/proj/kojo/a.ERB', '/proj/kojo/b.ERB']);

      expect(next!.byName.has('OLD_FN')).toBe(false);
      expect([...next!.byName.keys()].sort()).toEqual(['FRESH_FN', 'KEEP_FN']);
      expect(parser.currentIndex()).toBe(next);
      // 反向引用增量后保守失效：不带旧边（下一次访问才排整扫）
      expect(next!.references).toBeUndefined();
    });

    it('applyFileChanges：删除目录按前缀移除其下全部条目', async () => {
      const files: Record<string, string> = {
        '/proj/kojo/old/a.ERB': '@A\n',
        '/proj/kojo/old/sub/b.ERB': '@B\n',
        '/proj/kojo/keep.ERB': '@KEEP\n',
      };
      const { services, bus, emit } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      delete files['/proj/kojo/old/a.ERB'];
      delete files['/proj/kojo/old/sub/b.ERB'];
      const next = await parser.applyFileChanges!({ changed: [], removed: ['/proj/kojo/old'] });
      expect([...next!.files.keys()]).toEqual(['/proj/kojo/keep.ERB']);
      expect(next!.byName.has('A')).toBe(false);
      expect(next!.byName.has('B')).toBe(false);
    });

    it('applyFileChanges：根外 / 非方言路径只数不报错（返回原索引，不广播）', async () => {
      const files: Record<string, string> = { '/proj/kojo/a.ERB': '@A\n' };
      const { services, bus, emit, logs } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      const before = parser.currentIndex();
      const next = await parser.applyFileChanges!({
        changed: ['/proj/sav/存档.sav', '/proj/kojo/note.txt'],
        removed: ['/elsewhere/gone.ERB'],
      });
      expect(next).toBe(before);
      expect(logs.some((l) => l.includes('ignored'))).toBe(true);
    });

    it('applyFileChanges：读失败回退整扫（不留半新半旧），结果与盘上现状一致', async () => {
      const files: Record<string, string> = { '/proj/kojo/a.ERB': '@A\n' };
      const { services, bus, emit, logs } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      // 报一格"方言、根内、但读不出来"的路径：增量必须回退整扫，而不是把它当空文件
      files['/proj/kojo/c.ERB'] = '@C\n';
      const rebroadcast = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      const next = await parser.applyFileChanges!({ changed: ['/proj/kojo/ghost.ERB'], removed: [] });
      await rebroadcast;
      expect(logs.some((l) => l.includes('falling back to a full rebuild'))).toBe(true);
      expect([...next!.files.keys()].sort()).toEqual(['/proj/kojo/a.ERB', '/proj/kojo/c.ERB']);
    });

    it('增量后读反向引用：先答"不可用"，同时排一次整扫把 references 恢复', async () => {
      const files: Record<string, string> = { '/proj/kojo/a.ERB': '@A\nCALL B\n' };
      const { services, bus, emit } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      files['/proj/kojo/b.ERB'] = '@B\nRETURN 1\n';
      await parser.applyFileChanges!({ changed: ['/proj/kojo/b.ERB'], removed: [] });
      expect(parser.currentIndex()!.references).toBeUndefined();

      const repaired = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      expect(parser.referencesTo!('B')).toEqual([]); // 保守：不知道就是空，不编一份旧名单
      await repaired;
      expect(parser.currentIndex()!.references).toBeDefined();
    });

    it('file.changed 去抖后走增量（保存一份文件，索引与 Ctrl+T 立刻跟上）', async () => {
      const files: Record<string, string> = { '/proj/kojo/a.ERB': '@A\n' };
      const { services, bus, emit } = activatePlugin(fakeIO(files));
      const parser = services.get('erb.parser') as ErbParserService;
      const opened = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('project.opened', { project: fakeProject('/proj', ['/proj/kojo']) });
      await opened;
      await settleBuild();

      files['/proj/kojo/saved.ERB'] = '@SAVED_FN\nRETURN 1\n';
      const incremental = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('file.changed 没有在去抖窗口内落地')), 2_000);
        bus.on('kojo.functionChanged', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      emit('file.changed', { kind: 'change', path: '/proj/kojo/saved.ERB' });
      await incremental;
      expect(parser.currentIndex()!.byName.has('SAVED_FN')).toBe(true);

      // unlink：文件没了 ⇒ 条目退场（不留幽灵行）
      delete files['/proj/kojo/saved.ERB'];
      const dropped = new Promise<void>((resolve) => {
        bus.once('kojo.functionChanged', () => resolve());
      });
      emit('file.changed', { kind: 'unlink', path: '/proj/kojo/saved.ERB' });
      await dropped;
      expect(parser.currentIndex()!.files.has('/proj/kojo/saved.ERB')).toBe(false);
    });
  });
});

/* ============ 可搬运任务（并行运输层的本地实现/回退路径） ============ */

describe('可搬运任务', () => {
  it('scanControlFlowOffloaded 与同步版结果一致（无通道时走本地实现）', async () => {
    const src = '@F\n\tIF TFLAG:1\n\t\tPRINTFORMDW 甲。\n\tENDIF\n\tRETURN 1\n';
    const { services } = activatePlugin(fakeIO({ '/proj/kojo/f.ERB': src }));
    const parser = services.get('erb.parser') as ErbParserService;
    const offloaded = await parser.scanControlFlowOffloaded(src);
    expect(offloaded).toEqual(parser.scanControlFlow(src));
    expect(offloaded.length).toBeGreaterThan(0);
  });
});

/* ============ ERB 结构波浪线（2026-10-13 UI 反馈 7） ============ */

/**
 * 这里钉的是**接线**：注册进哪个槽、什么文件才出提示、报告怎么落到行号与 code 上。
 * 判据本身的对错在 `structure.test.ts`（形态）与 `structure.corpus.test.ts`（语料零误报）——
 * 三份各管一段，别拿这份当"判据正确"的证据。
 */
describe('erb-parser 插件 · ui.editor.decorator（ERB 结构波浪线）', () => {
  const broken = ['@AEGI', 'IF LOCAL', '\tPRINTL 甲'].join('\n');

  function decorator(): RegisteredSlot['contribution'] | undefined {
    const { slots } = activatePlugin(fakeIO({}));
    return slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution;
  }

  it('注册进 ui.editor.decorator，标题说得出人话', () => {
    const found = decorator();
    expect(found?.id).toBe('erb-structure');
    expect(found?.title ?? '').toContain('ERB');
  });

  it('声明 offloadKind，且任务实现与 decorate 同结果（两条走法不许漂移）', () => {
    const found = decorator()!;
    expect(found.offloadKind).toBe('erb.structureDecorations');
    const task = erbParserTasks['erb.structureDecorations'] as unknown as (p: {
      path: string;
      text: string;
    }) => unknown[];
    const payload = { path: 'C:/game/ERB/SAMPLE.ERB', text: broken };
    expect(task(payload)).toEqual(found.decorate!({ ...payload, project: null }));
    // 不适用该文件 = 空数组；判据只住在 `erbStructureDecorations` 一处
    expect(task({ path: 'C:/notes/readme.md', text: broken })).toEqual([]);
    expect(task({ path: 'C:/game/ERB/a.erb', text: '' })).toEqual([]);
    expect(found.decorate!({ path: 'C:/notes/readme.md', text: broken, project: null })).toEqual([]);
  });

  it('.ERB 少一个 ENDIF ⇒ 一条 error 装饰，行号指着开块那一行，code 带得上类型', () => {
    const decorations = decorator()!.decorate!({
      path: 'C:/game/ERB/M_KOJO_SAMPLE.ERB',
      text: broken,
      project: null,
    }) as Array<{ line: number; severity: string; message: string; code?: string }>;
    expect(decorations).toHaveLength(1);
    expect(decorations[0]).toMatchObject({ line: 2, severity: 'error', code: 'erb.unclosed-open' });
    expect(decorations[0]!.message).toContain('ENDIF');
  });

  it('.ERM 同口径（引擎的另一种扩展名，不该漏）', () => {
    expect(decorator()!.decorate!({ path: 'C:/game/X.ERM', text: broken, project: null })).toHaveLength(1);
  });

  it('.kojo 一律不出提示（糖语法诊断另有其人，两处各报一遍会重复）', () => {
    expect(decorator()!.decorate!({ path: 'C:/ws/事件.kojo', text: broken, project: null })).toEqual([]);
  });

  it('空文本与配平文本都零装饰（新开的文件不该先看到红线）', () => {
    const decorate = decorator()!.decorate!;
    expect(decorate({ path: 'C:/game/A.ERB', text: '', project: null })).toEqual([]);
    expect(
      decorate({ path: 'C:/game/A.ERB', text: ['IF A', '\tPRINTL 甲', 'ENDIF'].join('\n'), project: null }),
    ).toEqual([]);
  });

  it('服务面上 checkStructure 可用（契约那条 additive 方法的落地端）', () => {
    const { services } = activatePlugin(fakeIO({}));
    const svc = services.get('erb.parser') as ErbParserService;
    expect(typeof svc.checkStructure).toBe('function');
    expect(svc.checkStructure!(broken).map((i) => i.kind)).toEqual(['unclosed-open']);
  });

  it('checkStructure 收可选 path：`.ERH` 才判头文件形态（单参调用语义不变）', () => {
    const { services } = activatePlugin(fakeIO({}));
    const svc = services.get('erb.parser') as ErbParserService;
    const header = ['#DIM X, 10', 'PRINTL 甲'].join('\n');
    expect(svc.checkStructure!(header, 'C:/game/ERB/DIM.ERH').map((i) => i.kind)).toEqual(['erh-invalid']);
    expect(svc.checkStructure!(header, 'C:/game/ERB/MAIN.ERB')).toEqual([]);
    expect(svc.checkStructure!(header)).toEqual([]);
  });

  it('.ERH 里写普通语句 ⇒ 一条 erh-invalid 装饰（A4：声明面判据真正上屏）', () => {
    const decorations = decorator()!.decorate!({
      path: 'C:/game/ERB/DIM.ERH',
      text: ['#DIM X, 10', 'PRINTL 甲'].join('\n'),
      project: null,
    }) as Array<{ line: number; severity: string; code?: string }>;
    expect(decorations).toHaveLength(1);
    expect(decorations[0]).toMatchObject({ line: 2, severity: 'error', code: 'erb.erh-invalid' });
  });
});

/* ============ 💡 一键补齐缺失的闭合语句（2026-10-13 反馈 7 第二步） ============ */

/**
 * 这里钉的是**接线与门槛**：注册进哪个槽、可写性怎么挡、光标行怎么筛。
 * "补上去对不对"由 `structure-fix.test.ts` 的闭环用例负责（补完复检为零）。
 */
describe('erb-parser 插件 · ui.editor.codeAction（结构修复动作）', () => {
  const broken = ['@AEGI', 'IF LOCAL', '\tPRINTL 甲'].join('\n');
  const erb = 'C:/ws/包/事件.ERB';

  function actions(
    writable: boolean,
    path = erb,
    text = broken,
    line?: number,
    diagnostics?: LineDecoration[],
    scope?: 'range' | 'document',
  ): unknown[] {
    const { slots } = activatePlugin(fakeIO({}, () => writable));
    const found = slots.find((s) => s.kind === 'ui.editor.codeAction')?.contribution;
    if (!found?.provideActions) return [];
    return found.provideActions({
      path,
      text,
      project: null,
      lineCount: 3,
      ...(line === undefined ? {} : { line }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(scope === undefined ? {} : { scope }),
    });
  }

  it('注册进 ui.editor.codeAction，id 与波浪线那条同族', () => {
    const { slots } = activatePlugin(fakeIO({}));
    const found = slots.find((s) => s.kind === 'ui.editor.codeAction')?.contribution;
    expect(found?.id).toBe('erb-structure-fix');
    expect(found!.provideActions).toBeTypeOf('function');
  });

  it('可写路径 + 光标在开块行 ⇒ 给一个 quickfix，edits 落在末行', () => {
    const out = actions(true, erb, broken, 2) as Array<{ title: string; kind?: string; edits?: unknown[] }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('quickfix');
    expect(out[0]!.title).toContain('ENDIF');
    expect(out[0]!.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '\tPRINTL 甲\nENDIF' }]);
  });

  it('不可写（游戏目录里未授权的 ERB）一律不给动作：只读文件不该被 💡 改脏', () => {
    expect(actions(false, erb, broken, 2)).toEqual([]);
  });

  it('`.kojo` 与空文本不参与（糖线的 💡 另有其人，两处各报一边会打架）', () => {
    expect(actions(true, 'C:/ws/包/事件.kojo', broken, 2)).toEqual([]);
    expect(actions(true, erb, '', 1)).toEqual([]);
  });

  it('光标不在波浪线那一行 ⇒ 不给（💡 要出现在作者正看着的地方）', () => {
    expect(actions(true, erb, broken, 3)).toEqual([]);
  });

  it('没有 `line`（位置未知的旧宿主）⇒ 不猜，一律不给动作', () => {
    expect(actions(true, erb, broken)).toEqual([]);
  });

  it('配平文本零动作（好的文件不该看见💡 里冒出"补 ENDIF"）', () => {
    expect(actions(true, erb, ['@A', 'IF X', 'PRINT Y', 'ENDIF'].join('\n'), 2)).toEqual([]);
  });

  /* --------------------- B9：波浪线 ↔ 快速修复的关联 --------------------- */

  /** 同一次激活取两槽：装饰器交出的那条诊断，必须就是修复动作交回宿主的那一条 */
  function squiggle(): LineDecoration[] {
    const { slots } = activatePlugin(fakeIO({}));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate;
    return (deco?.({ path: erb, text: broken, project: null }) as LineDecoration[] | undefined) ?? [];
  }

  it('动作把**那条波浪线原样**交回宿主（与装饰器逐字段相等 ⇒ 关联不可能各说一套）', () => {
    const out = actions(true, erb, broken, 2) as Array<{ diagnostics?: LineDecoration[] }>;
    expect(out[0]!.diagnostics).toEqual(squiggle());
    expect(out[0]!.diagnostics![0]!.code).toBe('erb.unclosed-open');
  });

  it('宿主点明这条诊断 ⇒ 给它的修复；点明的是**另一族**（同码不同行 / 同行不同码）⇒ 不给', () => {
    const asked = squiggle();
    expect(actions(true, erb, broken, 2, asked)).toHaveLength(1);
    expect(actions(true, erb, broken, 2, [{ ...asked[0]!, line: 99 }])).toEqual([]);
    expect(actions(true, erb, broken, 2, [{ ...asked[0]!, code: 'erb.orphan-close' }])).toEqual([]);
  });

  it('区间里没有波浪线（空诊断）⇒ 零动作：没有"要修的东西"就不假装能修', () => {
    expect(actions(true, erb, broken, 2, [])).toEqual([]);
  });

  it('旧宿主没给 `diagnostics` ⇒ 行判据照旧（additive 零改动）', () => {
    expect(actions(true, erb, broken, 2)).toHaveLength(1);
    expect(actions(true, erb, broken, 3)).toEqual([]);
  });

  it('孤儿闭合（`orphan-close`）有诊断、没动作：不确定就不删用户的行', () => {
    const orphan = ['@A', 'PRINTL 甲', 'ENDIF'].join('\n');
    const { slots } = activatePlugin(fakeIO({}, () => true));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate!;
    const decorations = deco({ path: erb, text: orphan, project: null }) as LineDecoration[];
    expect(decorations.map((d) => d.code)).toEqual(['erb.orphan-close']);
    expect(actions(true, erb, orphan, 3, decorations)).toEqual([]);
  });

  /* --------------------- E3：`scope:'document'` = 整篇批量 --------------------- */

  /** 两处未闭合（两层各自一行），批量要一次给出两条 */
  const twiceBroken = ['@AEGI', 'IF LOCAL', 'IF TRUE', '\tPRINTL 甲'].join('\n');

  it('整篇批量（无 `line` + `scope:document`）⇒ 全篇每条唯一解都交出，不再"位置未知就不猜"', () => {
    const { slots } = activatePlugin(fakeIO({}, () => true));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate!;
    const decorations = deco({ path: erb, text: twiceBroken, project: null }) as LineDecoration[];
    expect(decorations).toHaveLength(2);
    const out = actions(true, erb, twiceBroken, undefined, decorations, 'document') as Array<{
      title: string;
    }>;
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringContaining('ENDIF')]));
  });

  it('批量请求仍按宿主点明的诊断精确应答：没点到的那条不给（不借"整篇"之名多改）', () => {
    const { slots } = activatePlugin(fakeIO({}, () => true));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate!;
    const decorations = deco({ path: erb, text: twiceBroken, project: null }) as LineDecoration[];
    const out = actions(true, erb, twiceBroken, undefined, [decorations[0]!], 'document');
    expect(out).toHaveLength(1);
  });

  it('`scope` 缺省 = 区间请求，逐字沿用旧判据（旧宿主零改动）：无 `line` 一律不给', () => {
    const { slots } = activatePlugin(fakeIO({}, () => true));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate!;
    const decorations = deco({ path: erb, text: twiceBroken, project: null }) as LineDecoration[];
    expect(actions(true, erb, twiceBroken, undefined, decorations)).toEqual([]);
  });

  it('批量也要过可写闸门：只读目录里的文件不因"整篇请求"被改脏', () => {
    const { slots } = activatePlugin(fakeIO({}, () => true));
    const deco = slots.find((s) => s.kind === 'ui.editor.decorator')?.contribution?.decorate!;
    const decorations = deco({ path: erb, text: twiceBroken, project: null }) as LineDecoration[];
    expect(actions(false, erb, twiceBroken, undefined, decorations, 'document')).toEqual([]);
  });
});
