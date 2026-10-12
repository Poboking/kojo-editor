import { describe, expect, it } from 'vitest';
import type { ErbParserService, EventBus, FileIO, GameProject, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

/** 伪 FileIO：只用得到 readText / walkDir / stat */
function fakeIO(files: Record<string, string>): FileIO {
  return {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async stat(path: string) {
      const text = files[path];
      if (text === undefined) return null;
      // mtimeMs 恒 null = 平台未提供 → 快照逻辑按"保守过期"处理（与 readText 口径一致）
      return { size: text.length, mtimeMs: null, isDirectory: false };
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

/** 最小上下文体：只验证插件行为，不拉整个 kernel */
function activatePlugin(io: FileIO): {
  services: Map<string, unknown>;
  logs: string[];
  bus: EventBus;
  emit: (type: string, payload: unknown) => void;
  dispose: () => void;
} {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
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
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return {
    services,
    logs,
    bus,
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
    // 让某个文件读取抛错
    const failing: FileIO = {
      ...io,
      async readText(path: string) {
        if (path.endsWith('broken.ERB')) throw new Error('io fail');
        return io.readText(path);
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
    expect(logs.some((l) => l.includes('Parse failed'))).toBe(true);
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
  });
});
