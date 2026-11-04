/**
 * MCP 装配层（`src/mcp/wiring.ts`）单测 —— 冻结契约 v1 · 路 A 端到端集成。
 *
 * 全程注入 seam：命令注册表 / 上下文 / 语义服务都给假实现，不起 GUI、不起 Tauri、
 * 不起 HTTP。覆盖四件事：
 *  ① 真源登记 seam（register / get）；
 *  ② `projectCommands` 投影：字段透传、缺 context 抛 NOT_WIRED、有 context 调到 `cmd.run(ctx,args)`；
 *  ③ `createMcpHostDeps` 对缺席字段保持缺席（不造空实现、不伪造读数）；
 *  ④ `semanticReadersFromService` 8 条腿 + scope 适配；
 *  ⑤ 把装配结果接进**真** `@kojo/mcp-host` registry，钉住「缺席 ⇒ NOT_WIRED /
 *     RESOURCE_UNAVAILABLE 显式可见」（铁律 4：不静默）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpFailure,
  createMcpCapabilityRegistry,
  type McpHostDeps,
  type McpSessionScope,
} from '@kojo/mcp-host';
import type { EditorCommandContext } from '@kojo/plugin-api';
import type { CommandEntry } from '../src/ui/commands';
import {
  createMcpHostDeps,
  getMcpWiringSources,
  projectCommands,
  registerMcpWiringSources,
  semanticReadersFromService,
} from '../src/mcp/wiring';
import {
  SEMANTIC_READING_SPECS,
  createSemanticService,
  type SemanticService,
} from '../src/mcp/semantic-service';

const ctx: EditorCommandContext = { project: null };
const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'privileged',
  approvedRoots: ['/proj'],
  approvedTools: [],
};

const ALL_DEP_KEYS: readonly (keyof McpHostDeps)[] = [
  'commands', 'semantic', 'kernelIo', 'readResourceData',
  'resources', 'prompts', 'runSupplemental', 'promptSlots',
];

function cmd(over: Partial<CommandEntry> = {}): CommandEntry {
  return { id: 'x', title: 'X', run: () => undefined, ...over };
}

describe('真源登记 seam', () => {
  afterEach(() => registerMcpWiringSources(null));

  it('登记后可读，传 null 恢复「全部缺席」', () => {
    registerMcpWiringSources(null);
    expect(getMcpWiringSources()).toBeNull();
    const sources = { commands: [] as const };
    registerMcpWiringSources(sources);
    expect(getMcpWiringSources()).toBe(sources);
    registerMcpWiringSources(null);
    expect(getMcpWiringSources()).toBeNull();
  });
});

describe('projectCommands：注册表 → McpCommandSource[]', () => {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties: { q: { type: 'string' } },
  };

  it('字段逐项透传；可选字段缺席时保持缺席（不擅自代填）', () => {
    const out = projectCommands(
      [
        cmd({ id: 'a.one', title: '一', description: '描述', argsSchema: schema, tier: 'read' }),
        cmd({ id: 'a.two', title: '二' }),
      ],
      ctx,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'a.one', title: '一', description: '描述', argsSchema: schema, tier: 'read',
    });
    expect(typeof out[0]!.run).toBe('function');
    expect(out[1]!.description).toBeUndefined();
    expect(out[1]!.argsSchema).toBeUndefined();
    expect(out[1]!.tier).toBeUndefined();
  });

  it('有 context：run(args, scope) 调到 cmd.run(ctx, args)，ctx 是同一枚', async () => {
    const runSpy = vi.fn((_c: EditorCommandContext, _a?: Record<string, unknown>): void => undefined);
    const [src] = projectCommands([cmd({ id: 'run.me', title: '跑', run: runSpy })], ctx);
    await src!.run({ q: 'x' }, scope);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0]).toBe(ctx);
    expect(runSpy.mock.calls[0]![1]).toEqual({ q: 'x' });
  });

  it('缺 context：工具仍列出（能力可见），但 run 抛 NOT_WIRED 结构化失败（不伪造上下文）', () => {
    const [src] = projectCommands([cmd({ id: 'n.ctx', title: '缺上下文' })]);
    expect(src!.id).toBe('n.ctx');
    let caught: unknown;
    try {
      src!.run({}, scope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpFailure);
    expect((caught as McpFailure).code).toBe('NOT_WIRED');
    expect((caught as McpFailure).message).toContain('n.ctx');
  });
});

describe('createMcpHostDeps：给到才接，缺席保持缺席', () => {
  afterEach(() => registerMcpWiringSources(null));

  it('空 sources ⇒ 空 deps（八个字段全缺席，Object.keys 为空）', () => {
    const deps = createMcpHostDeps({});
    expect(Object.keys(deps)).toEqual([]);
    for (const k of ALL_DEP_KEYS) {
      expect((deps as Record<string, unknown>)[k]).toBeUndefined();
    }
  });

  it('未登记（getMcpWiringSources() === null）⇒ 空 deps', () => {
    registerMcpWiringSources(null);
    expect(createMcpHostDeps()).toEqual({});
  });

  it('只登记 commands + commandContext ⇒ 只有 commands 一腿，其余保持缺席', () => {
    const deps = createMcpHostDeps({
      commands: [cmd({ id: 'only.cmd', title: '唯一' })],
      commandContext: ctx,
    });
    expect(Object.keys(deps)).toEqual(['commands']);
    expect(deps.commands).toHaveLength(1);
    for (const k of ALL_DEP_KEYS.filter((k) => k !== 'commands')) {
      expect((deps as Record<string, unknown>)[k]).toBeUndefined();
    }
  });

  it('commands 为空数组不登记（length 守卫，不投影出空清单冒充成功）', () => {
    expect(Object.keys(createMcpHostDeps({ commands: [] }))).toEqual([]);
  });

  it('promptSlots 哪怕空数组也算显式提供 ⇒ 登记（骨架并入的开关按契约保留）', () => {
    const deps = createMcpHostDeps({ promptSlots: [] });
    expect(Object.keys(deps)).toEqual(['promptSlots']);
    expect(deps.promptSlots).toEqual([]);
  });

  it('显式 semantic 优先于 semanticService；给全则八字段全登记', () => {
    const explicit = { definitionAt: () => 'EXPLICIT' };
    const service = createSemanticService({ readers: { definitionAt: () => 'SERVICE' } });
    const deps = createMcpHostDeps({
      commands: [cmd({ id: 'all.cmd', title: '全' })],
      commandContext: ctx,
      semantic: explicit,
      semanticService: service,
      kernelIo: { projectInfo: () => ({ ok: true }) },
      readResourceData: () => ({}),
      resources: [],
      prompts: [],
      runSupplemental: () => 'ok',
      promptSlots: [],
    });
    for (const k of ALL_DEP_KEYS) {
      expect((deps as Record<string, unknown>)[k], `${k} 应已登记`).toBeDefined();
    }
    expect(deps.semantic).toBe(explicit);
  });

  it('只给 semanticService 时由它投影出 semantic 8 腿（不再额外登记 service）', () => {
    const service = createSemanticService({ readers: {} });
    const deps = createMcpHostDeps({ semanticService: service });
    expect(Object.keys(deps)).toEqual(['semantic']);
    expect(Object.keys(deps.semantic ?? {})).toHaveLength(8);
  });
});

describe('semanticReadersFromService：8 条腿 + (args, scope) 适配', () => {
  const names = SEMANTIC_READING_SPECS.map((s) => s.name);

  it('恰 8 条、名字与契约对齐；每条腿把 (args, scope) 适配成 service.read(name, args)', async () => {
    const reads: string[] = [];
    const service: SemanticService = createSemanticService({
      readers: Object.fromEntries(
        names.map((n) => [
          n,
          (a: Record<string, unknown>) => {
            reads.push(n);
            return `v:${n}:${String(a['line'] ?? '-')}`;
          },
        ]),
      ),
    });
    const readers = semanticReadersFromService(service);
    expect(Object.keys(readers).sort()).toEqual([...names].sort());
    for (const n of names) {
      expect(typeof (readers as Record<string, unknown>)[n]).toBe('function');
    }
    const table = readers as unknown as Record<
      string,
      (args: Record<string, unknown>, s: McpSessionScope) => unknown
    >;
    // scope 不参与读语义；位置读数给合法正整数以过 service 自身的入参校验。
    for (const n of names) {
      const out = await table[n]!({ line: 1, column: 2 }, scope);
      expect(out).toBe(`v:${n}:1`);
    }
    expect(reads).toEqual([...names]);
  });
});

describe('装配结果接进真 @kojo/mcp-host registry', () => {
  afterEach(() => registerMcpWiringSources(null));

  it('登记 commands + context ⇒ registry 列出该工具且 callTool 调到 cmd.run(ctx, args)', async () => {
    const runSpy = vi.fn((_c: EditorCommandContext, _a?: Record<string, unknown>): void => undefined);
    registerMcpWiringSources({
      commands: [cmd({ id: 'demo.echo', title: '回声', tier: 'read', run: runSpy })],
      commandContext: ctx,
    });
    const reg = createMcpCapabilityRegistry(createMcpHostDeps());
    const tool = reg.listTools(scope).find((t) => t.name === 'demo.echo');
    expect(tool).toBeDefined();
    expect(tool!.tier).toBe('read');
    await reg.callTool('demo.echo', { q: 1 }, scope);
    expect(runSpy).toHaveBeenCalledWith(ctx, { q: 1 });
  });

  it('空 deps（无登记）⇒ 语义 / resource 腿显式 NOT_WIRED / RESOURCE_UNAVAILABLE（不静默）', async () => {
    registerMcpWiringSources(null);
    const reg = createMcpCapabilityRegistry(createMcpHostDeps());
    // 能力仍列出（可见），调用才显式报缺线
    expect(reg.listTools(scope).some((t) => t.name === 'semantic.definitionAt')).toBe(true);
    await expect(
      reg.callTool('semantic.definitionAt', { line: 1, column: 1 }, scope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED' });
    await expect(
      reg.readResource('kojo://project/commands', scope),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });
});
