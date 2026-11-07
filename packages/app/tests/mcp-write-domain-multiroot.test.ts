/**
 * 「写域多根」判据（2026-11-06，用户已拍板 additive 方案）。
 *
 * 先钉会红的对拍，再动实现。全程假注入（fake kernel / fake invoke / fake bus），
 * 不启 GUI / Tauri / HTTP / 真运行时，也不碰真盘。
 *
 * 六条硬判据：
 *   ① rootId 是稳定枚举标识（同一根恒等、不同根不同、形状闸同尺）；
 *   ② **默认拒绝不变**：不传 rootId 时行为一字不变（仍写项目根）；
 *   ③ 传了 rootId 但第四张表 approvedRootIds 没批 ⇒ 显式拒绝、零写入；
 *   ④ 批准后 ⇒ 落点解析到该常驻根（不是项目根），且仍过 approvedRoots 相对前缀闸；
 *   ⑤ 形状非法的 rootId（绝对路径 / 脏值）⇒ 显式拒绝，绝不把 rootId 当路径用；
 *   ⑥ 双闸不变：approvedRoots 不覆盖 relPath ⇒ 拒；内核 WriteNotAllowedError ⇒ WRITE_DISABLED。
 *
 * 安全边界：rootId 只是枚举标识，绝不收任意目标路径；落盘仍走既有内核写原语，
 * 不新建写通道、不绕过 Rust ensure_write_allowed。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ROOT_ID_SCHEMA,
  SUPPLEMENTAL_TOOL_SPECS,
  validateAgainstSchema,
} from '@kojo/mcp-host';
import type { McpSessionScope } from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';
import {
  ROOT_ID_SHAPE,
  findRootById,
  isRootIdShape,
  rootIdOf,
} from '../src/mcp/workspace-root-id';

/** additive 字段：契约尚未加时用交叉类型，避免「类型先红」遮住「行为红」。 */
type MultiRootScope = McpSessionScope & { approvedRootIds?: readonly string[] };

const PROJECT_ROOT = 'D:\\proj';
const WS_ROOT = 'D:\\author-workspace';
const OTHER_ROOT = 'D:\\another-workspace';
const WS_ID = rootIdOf(WS_ROOT);

const NO_SEARCH: McpSearchResultLike = {
  files: [],
  totalMatches: 0,
  truncated: false,
  filesScanned: 0,
  elapsedMs: 0,
  skipped: {},
};

function scope(over: Partial<MultiRootScope> = {}): MultiRootScope {
  return {
    sessionId: 's1',
    clientId: 'c1',
    tier: 'edit',
    approvedRoots: ['docs'],
    approvedTools: [],
    ...over,
  };
}

interface Harness {
  readonly sup: ReturnType<typeof createRunSupplemental>;
  readonly writes: string[];
  readonly invokes: Array<{ cmd: string; args?: Record<string, unknown> }>;
}

function makeSup(options: {
  readonly workspaceRoots?: unknown[];
  readonly writeFails?: boolean;
  readonly exists?: boolean;
} = {}): Harness {
  const writes: string[] = [];
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const maybeFail = async (path: string): Promise<void> => {
    if (options.writeFails) {
      const err = new Error(`这个位置在只读范围内，不能写入：${path}`);
      err.name = 'WriteNotAllowedError';
      throw err;
    }
    writes.push(path);
  };
  const kernel: McpKernelLike = {
    project: { current: () => ({ rootDir: PROJECT_ROOT, adapterId: 'a', kojoPaths: [] }) },
    io: {
      walkDir: async () => [],
      createFileExclusive: vi.fn(async (p: string) => {
        await maybeFail(p);
        return true;
      }),
      createDirExclusive: vi.fn(async (p: string) => {
        await maybeFail(p);
        return true;
      }),
      writeText: vi.fn(async (p: string) => {
        await maybeFail(p);
      }),
      exists: vi.fn(async () => options.exists ?? false),
      removeFile: vi.fn(async (p: string) => {
        await maybeFail(p);
      }),
      removeDir: vi.fn(async (p: string) => {
        await maybeFail(p);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        await maybeFail(from);
        await maybeFail(to);
      }),
    },
    plugins: { list: () => [] },
    services: { tryGet: <T = unknown>(_key: string) => undefined as T | undefined },
    bus: { on: () => () => {}, emit: () => undefined },
    slots: { query: () => [] },
  };
  const deps: McpIoDeps = {
    getKernel: () => kernel,
    getCommands: () => [],
    invoke: async (cmd, args) => {
      invokes.push({ cmd, args });
      if (cmd === 'workspace_roots') return options.workspaceRoots ?? [WS_ROOT];
      if (cmd === 'stat_file') return { size: 1, mtimeMs: 1, isDirectory: false };
      return null;
    },
    searchInFiles: async () => NO_SEARCH,
  };
  return { sup: createRunSupplemental(deps), writes, invokes };
}

const createArgs = (rootId?: string): Record<string, unknown> => ({
  kind: 'file',
  relPath: 'docs/a.erb',
  content: '#口上\n',
  ...(rootId === undefined ? {} : { rootId }),
});

/* ------------------------------------------------------------------ */

describe('① rootId 是稳定枚举标识', () => {
  it('同一根恒等、不同根不同、形状闸同尺；反查只认只读真源枚举', () => {
    expect(ROOT_ID_SHAPE.test(WS_ID)).toBe(true);
    expect(isRootIdShape(WS_ID)).toBe(true);
    expect(rootIdOf(WS_ROOT)).toBe(WS_ID);
    expect(rootIdOf('D:/author-workspace')).toBe(WS_ID); // 分隔符归一
    expect(rootIdOf(OTHER_ROOT)).not.toBe(WS_ID);
    expect(isRootIdShape('D:\\author-workspace')).toBe(false);
    expect(isRootIdShape('ws:ZZZZZZZZ')).toBe(false);
    expect(findRootById([WS_ROOT, OTHER_ROOT], WS_ID)).toBe(WS_ROOT);
    expect(findRootById([WS_ROOT], rootIdOf(OTHER_ROOT))).toBeNull();
  });
});

describe('② 默认拒绝不变：不传 rootId 时行为一字不变', () => {
  it('仍写项目根，且一次都不去枚举常驻根（零额外 IPC）', async () => {
    const { sup, writes, invokes } = makeSup();
    await sup('fileTree.create', createArgs(), scope());
    expect(writes).toContain('D:/proj/docs/a.erb');
    expect(invokes.some((c) => c.cmd === 'workspace_roots')).toBe(false);
  });
});

describe('③ 未批准的 rootId ⇒ 显式拒绝、零写入', () => {
  it('approvedRootIds 缺省 / 为空 / 不含该 ID，三种都要拒', async () => {
    for (const approvedRootIds of [undefined, [], [rootIdOf(OTHER_ROOT)]]) {
      const { sup, writes } = makeSup();
      await expect(
        sup('fileTree.create', createArgs(WS_ID), scope({ approvedRootIds })),
      ).rejects.toMatchObject({ code: expect.stringMatching(/WRITE_DISABLED|PERMISSION_DENIED|INVALID_ARGS/) });
      expect(writes, '未批准的 rootId 绝不落盘').toEqual([]);
    }
  });
});

describe('④ 批准后 ⇒ 落点解析到常驻根', () => {
  it('create 写 D:/author-workspace/docs/a.erb（不是项目根），且只读真源被枚举', async () => {
    const { sup, writes, invokes } = makeSup();
    const out = (await sup(
      'fileTree.create',
      createArgs(WS_ID),
      scope({ approvedRootIds: [WS_ID] }),
    )) as Record<string, unknown>;
    expect(writes[0]).toBe('D:/author-workspace/docs/a.erb');
    expect(writes.every((p) => p.startsWith('D:/proj/'))).toBe(false);
    expect(invokes.some((c) => c.cmd === 'workspace_roots')).toBe(true);
    expect(out['created']).toBe(true);
  });

  it('rootId 在 workspace_roots 读数里找不到 ⇒ 显式拒绝（绝不退回项目根）', async () => {
    const { sup, writes } = makeSup({ workspaceRoots: [OTHER_ROOT] });
    await expect(
      sup('fileTree.create', createArgs(WS_ID), scope({ approvedRootIds: [WS_ID] })),
    ).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });
});

describe('⑤ rootId 形状非法 ⇒ 拒绝，绝不当路径用', () => {
  it.each([
    ['D:\\author-workspace', '绝对路径'],
    ['../../etc', '相对逃逸'],
    ['ws:ZZZZZZZZ', '脏十六进制'],
    ['', '空串'],
  ])('%s（%s）', async (badId) => {
    const { sup, writes } = makeSup();
    await expect(
      sup('fileTree.create', createArgs(badId), scope({ approvedRootIds: [WS_ID, badId] })),
    ).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });
});

describe('⑥ 双闸不变', () => {
  it('approvedRoots 不覆盖 relPath ⇒ 仍拒（第一闸）', async () => {
    const { sup, writes } = makeSup();
    await expect(
      sup(
        'fileTree.create',
        { ...createArgs(WS_ID), relPath: 'ERB/Lines/x.erb' },
        scope({ approvedRootIds: [WS_ID] }),
      ),
    ).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });

  it('内核 WriteNotAllowedError ⇒ WRITE_DISABLED（第二闸，根在批准面也照拒）', async () => {
    const { sup, writes } = makeSup({ writeFails: true });
    await expect(
      sup('fileTree.create', createArgs(WS_ID), scope({ approvedRootIds: [WS_ID] })),
    ).rejects.toMatchObject({ code: 'WRITE_DISABLED' });
    expect(writes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

const WRITE_LEGS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['fileTree.create', createArgs()],
  ['fileTree.update', { relPath: 'docs/a.erb', content: '#x\n' }],
  ['fileTree.remove', { relPath: 'docs/a.erb' }],
  ['fileTree.rename', { from: 'docs/a.erb', to: 'docs/b.erb' }],
];

describe('⑦ 四枚写腿一致（create / update / remove / rename）', () => {
  it.each(WRITE_LEGS)('%s 不传 rootId ⇒ 仍写项目根、零枚举 IPC', async (name, args) => {
    const { sup, writes, invokes } = makeSup({ exists: true });
    await sup(name, args, scope());
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((p) => p.startsWith('D:/proj/'))).toBe(true);
    expect(invokes.some((c) => c.cmd === 'workspace_roots')).toBe(false);
  });

  it.each(WRITE_LEGS)('%s 经批准 rootId ⇒ 全部落点都在常驻根内', async (name, args) => {
    const { sup, writes, invokes } = makeSup({ exists: true });
    await sup(name, { ...args, rootId: WS_ID }, scope({ approvedRootIds: [WS_ID] }));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((p) => p.startsWith('D:/author-workspace/'))).toBe(true);
    expect(writes.some((p) => p.startsWith('D:/proj/'))).toBe(false);
    expect(invokes.some((c) => c.cmd === 'workspace_roots')).toBe(true);
  });
});

describe('⑧ 只读发现面：io.workspaceRoots 逐项给出 rootIds', () => {
  it('rootIds 与 roots 逐项对齐且等于同一真源算出的稳定标识', async () => {
    const { sup } = makeSup({ workspaceRoots: [WS_ROOT, OTHER_ROOT] });
    const out = (await sup('io.workspaceRoots', { limit: 50 }, scope())) as {
      roots: string[];
      rootIds: string[];
    };
    expect(out.roots).toEqual([WS_ROOT, OTHER_ROOT]);
    expect(out.rootIds).toEqual([rootIdOf(WS_ROOT), rootIdOf(OTHER_ROOT)]);
    expect(out.rootIds[0]).toBe(WS_ID);
    expect(isRootIdShape(out.rootIds[1]!)).toBe(true);
  });
});

describe('⑨ 冻结契约：四枚写腿声明严格形状 rootId', () => {
  it.each(['fileTree.create', 'fileTree.update', 'fileTree.remove', 'fileTree.rename'])(
    '%s 的 inputSchema 带 rootId 且 pattern 拒绝对路径 / 逃逸 / 脏值',
    (name) => {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === name)!;
      const props = spec.inputSchema['properties'] as Record<string, unknown>;
      const schema = props['rootId'] as Record<string, unknown>;
      // B27（S15 式指针化）：完整口径只留 `fileTree.update` 一份，其余三腿是点名落点的指针；
      // 形状闸（type / pattern / description 之外的一切）必须仍与冻结契约同源。
      expect({ type: schema['type'], pattern: schema['pattern'] }).toEqual({
        type: ROOT_ID_SCHEMA['type'],
        pattern: ROOT_ID_SCHEMA['pattern'],
      });
      if (name === 'fileTree.update') {
        expect(schema).toEqual(ROOT_ID_SCHEMA);
      } else {
        expect(String(schema['description']), `${name} 的 rootId 指针必须点名落点`).toContain('`fileTree.update`');
      }
      expect(validateAgainstSchema(schema, WS_ID).valid).toBe(true);
      expect(validateAgainstSchema(schema, 'D:\\author-workspace').valid).toBe(false);
      expect(validateAgainstSchema(schema, '../../etc').valid).toBe(false);
      expect(validateAgainstSchema(schema, 'ws:ZZZZZZZZ').valid).toBe(false);
    },
  );
});
