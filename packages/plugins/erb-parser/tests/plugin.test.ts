import { describe, expect, it } from 'vitest';
import type { ErbParserService, FileIO, PluginContext } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';

/** 伪 FileIO：只用得到 readText 与 walkDir */
function fakeIO(files: Record<string, string>): FileIO {
  return {
    async readText(path: string) {
      const text = files[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
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

/** 最小上下文体：只验证插件行为，不拉整个 kernel */
function activatePlugin(io: FileIO): { services: Map<string, unknown>; logs: string[] } {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    pluginId: 'erb-parser',
    log: {
      debug: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, logs };
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
});
