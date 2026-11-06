/**
 * MCP-PERF-S10 批（LaneT，2026-11-07）：`semantic.batchAt` 批量腿的判据。
 *
 * TRAE P1：「语言服务……补批量接口；50 个符号批量 <200ms」。单枚面（definitionAt /
 * referencesAt）一次只答一个位点，agent 批量审阅 / 批量跳转预算要 50 趟往返；本批把
 * **同一数据源**（`buildSemanticReaders` 的判据腿 `semanticLegsNow()`——ERB 侧最终落在
 * erb-parser 索引上，S2 批起 references 是增量活视图，**零新扫描**）扇成 ≤50 项的一次往返。
 *
 * 判据（与卡面逐字对齐）：
 * ① `items` ≤50 项，每项 `{line,column,kind:"definition"|"references"}`（1 基行列，与单枚面
 *    同口径）；可选 `includeDeclaration`（references 用，语义沿 referencesAt）；
 * ② 逐项结果可见：`{ok:true,result}` / `{ok:false,code}` ——服务缺席逐项 `NOT_WIRED`、
 *    坐标越界逐项 `INVALID_ARGS`，单项失败不抛整批；
 * ③ 总账 `requested/succeeded/failed` 必带；分页不适用（一次往返 ≤50 项）；
 * ④ read tier（host 侧默认放行，回归在 src-tauri/src/mcp/tests.rs）。
 * 50 项 <200ms 用临时探针量（量完删，读数入提交），不进常驻测试。
 */
import { describe, expect, it, vi } from 'vitest';
import { createMcpCapabilityRegistry, type McpSessionScope } from '@kojo/mcp-host';
import {
  buildSemanticReaders,
  type McpSemanticDeps,
  type McpSemanticLegsLike,
  type McpSemanticModel,
  type McpSemanticMonaco,
  type McpSemanticWorkspace,
} from '../src/mcp/real-sources';

const scope: McpSessionScope = {
  sessionId: 's10',
  clientId: 'c10',
  tier: 'read',
  approvedRoots: [],
  approvedTools: [],
};

/* ------------------------------- 假件（与 mcp-real-sources.test.ts 同族） ------------------------------- */

function fakeModel(text = 'alpha\nbeta\ngamma\n'): McpSemanticModel {
  const lines = text.split('\n');
  return {
    uri: { toString: () => 'file:///D:/proj/a.kojo' },
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
    getLineContent: (line: number) => lines[line - 1] ?? '',
    getLanguageId: () => 'kojo',
    getEOL: () => '\n',
    getValue: () => text,
  };
}

function fakeMonaco(): McpSemanticMonaco {
  return {
    Position: class {
      constructor(
        readonly line: number,
        readonly column: number,
      ) {}
    },
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startColumn: number,
        readonly endLine: number,
        readonly endColumn: number,
      ) {}
    },
    CancellationTokenSource: class {
      readonly token = { cancelled: false };
      dispose(): void {}
    },
    editor: {
      tokenize: () => [],
      getModelMarkers: () => [],
    },
  } as unknown as McpSemanticMonaco;
}

function fakeLegs(over: Partial<McpSemanticLegsLike> = {}): McpSemanticLegsLike {
  return {
    definition: () => [{ filePath: 'D:/proj/b.kojo', line: 3, column: 2 }],
    references: () => ({
      path: 'b.kojo',
      locations: [
        { filePath: 'D:/proj/b.kojo', line: 3, kind: 'definition' },
        { filePath: 'D:/proj/c.kojo', line: 9, kind: 'call' },
      ],
    }),
    ...over,
  };
}

function fakeDeps(over: Partial<McpSemanticDeps> = {}): McpSemanticDeps {
  const ws: McpSemanticWorkspace = {
    model: fakeModel(),
    monaco: fakeMonaco(),
    cursor: { line: 1, column: 1 },
    rootDir: 'D:/proj',
  };
  return {
    getMonaco: () => ws.monaco,
    getWorkspace: () => ws,
    getLegs: () => fakeLegs(),
    getFeaturesService: () => null,
    getRootDir: () => 'D:/proj',
    ...over,
  };
}

/* ------------------------------- 判据 ------------------------------- */

describe('MCP-PERF-S10 · semantic.batchAt 批量腿', () => {
  it('① buildSemanticReaders 恰 9 键、batchAt 在册且全函数（与既有 8 腿同一装配点）', () => {
    const readers = buildSemanticReaders(fakeDeps());
    expect(Object.keys(readers).sort()).toEqual([
      'batchAt', 'codeActionsAt', 'definitionAt', 'diagnostics', 'documentSymbols',
      'hoverAt', 'referencesAt', 'suggestAt', 'tokens',
    ]);
    expect(readers.batchAt).toBeTypeOf('function');
  });

  it('② 注册表在册：read tier + readOnlyHint，read 会话可见（81→82 的第 82 枚）', () => {
    const registry = createMcpCapabilityRegistry({});
    const tool = registry.listTools(scope).find((t) => t.name === 'semantic.batchAt');
    expect(tool).toBeDefined();
    expect(tool?.tier).toBe('read');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('③ 逐项扇出同源同形：definition/references 各一项，{ok,result} 与单枚面逐字同尺', async () => {
    const providerTouched = vi.fn();
    const deps = fakeDeps({
      // provider 通道有导航副作用——批量腿与单枚面同纪律：绝不触达
      getFeaturesService: () => ({
        definitionProvider: { ordered: () => [{ provideDefinition: providerTouched }] },
      }),
    });
    const out = (await buildSemanticReaders(deps).batchAt!(
      {
        items: [
          { line: 1, column: 1, kind: 'definition' },
          { line: 2, column: 2, kind: 'references' },
        ],
      },
      scope,
    )) as Record<string, unknown>;

    expect(out['requested']).toBe(2);
    expect(out['succeeded']).toBe(2);
    expect(out['failed']).toBe(0);
    const items = out['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2); // 1:1 对应，绝不跳条
    expect(items[0]).toMatchObject({ ok: true, result: { items: [{ path: 'b.kojo', line: 3, column: 2 }], total: 1, truncated: false } });
    expect(items[1]).toMatchObject({
      ok: true,
      result: { items: [{ path: 'b.kojo', line: 3 }, { path: 'c.kojo', line: 9 }], total: 2, truncated: false },
    });
    expect(providerTouched).not.toHaveBeenCalled();
  });

  it('④ includeDeclaration=false 沿 referencesAt 语义逐项过滤 definition 种类', async () => {
    const readers = buildSemanticReaders(fakeDeps());
    const out = (await readers.batchAt!(
      { items: [{ line: 1, column: 1, kind: 'references', includeDeclaration: false }] },
      scope,
    )) as Record<string, unknown>;
    const item = (out['items'] as Record<string, unknown>[])[0];
    expect(item).toMatchObject({ ok: true, result: { items: [{ path: 'c.kojo', line: 9 }], total: 1 } });
  });

  it('⑤ 服务缺席（无活动编辑器）逐项 NOT_WIRED：不抛整批、总账如实', async () => {
    const readers = buildSemanticReaders(fakeDeps({ getWorkspace: () => null }));
    const out = (await readers.batchAt!(
      {
        items: [
          { line: 1, column: 1, kind: 'definition' },
          { line: 2, column: 1, kind: 'references' },
        ],
      },
      scope,
    )) as Record<string, unknown>;
    expect(out['requested']).toBe(2);
    expect(out['succeeded']).toBe(0);
    expect(out['failed']).toBe(2);
    for (const item of out['items'] as Record<string, unknown>[]) {
      expect(item).toEqual({ ok: false, code: 'NOT_WIRED' });
    }
  });

  it('⑤b 判据腿缺席同尺：逐项 NOT_WIRED（不退到有导航副作用的 provider 通道）', async () => {
    const readers = buildSemanticReaders(fakeDeps({ getLegs: () => null }));
    const out = (await readers.batchAt!(
      { items: [{ line: 1, column: 1, kind: 'definition' }] },
      scope,
    )) as Record<string, unknown>;
    expect((out['items'] as Record<string, unknown>[])[0]).toEqual({ ok: false, code: 'NOT_WIRED' });
    expect(out['failed']).toBe(1);
  });

  it('⑥ 坐标越界逐项 INVALID_ARGS（行超行数 / 列超行尾），其余项照常成功——单项失败不抛整批', async () => {
    const readers = buildSemanticReaders(fakeDeps()); // 夹具 3 行：alpha/beta/gamma
    const out = (await readers.batchAt!(
      {
        items: [
          { line: 99, column: 1, kind: 'definition' }, // 行越界
          { line: 1, column: 1, kind: 'definition' }, // 好
          { line: 2, column: 99, kind: 'references' }, // 列越界（beta 长 4 ⇒ max 5）
          { line: 0, column: 1, kind: 'definition' }, // 非 1 基
          { line: 1, column: 1, kind: 'implementation' }, // kind 不在白名单
        ],
      },
      scope,
    )) as Record<string, unknown>;
    expect(out['requested']).toBe(5);
    expect(out['succeeded']).toBe(1);
    expect(out['failed']).toBe(4);
    const items = out['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(items[1]).toMatchObject({ ok: true });
    expect(items[2]).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(items[3]).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(items[4]).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
  });

  it('⑦ 判据腿单项抛结构化失败 ⇒ 原样 {ok:false,code}，不洗码、不抛整批', async () => {
    const readers = buildSemanticReaders(
      fakeDeps({
        getLegs: () =>
          ({
            definition: () => {
              throw Object.assign(new Error('leg boom'), { code: 'READ_FAILED' });
            },
            references: () => null,
          }) as unknown as McpSemanticLegsLike,
      }),
    );
    const out = (await readers.batchAt!(
      {
        items: [
          { line: 1, column: 1, kind: 'definition' },
          { line: 2, column: 1, kind: 'references' },
        ],
      },
      scope,
    )) as Record<string, unknown>;
    const items = out['items'] as Record<string, unknown>[];
    expect(items[0]).toEqual({ ok: false, code: 'READ_FAILED' });
    expect(items[1]).toMatchObject({ ok: true, result: { items: [], total: 0 } }); // references null＝空应答（与单枚面同口径）
    expect(out['failed']).toBe(1);
  });

  it('⑧ 批级形状缺陷整批 INVALID_ARGS：非数组 / 空数组 / 超 50 项（分页不适用，请拆批）', async () => {
    const readers = buildSemanticReaders(fakeDeps());
    const batchAt = readers.batchAt!;
    await expect(batchAt({} as Record<string, unknown>, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(batchAt({ items: 'nope' } as unknown as Record<string, unknown>, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(batchAt({ items: [] }, scope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      batchAt({ items: Array.from({ length: 51 }, () => ({ line: 1, column: 1, kind: 'definition' })) }, scope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('⑨ 注册表 schema 闸：items 逐键点名 + additionalProperties:false，未知键 / 坏 kind / 坏类型整批拒', async () => {
    const registry = createMcpCapabilityRegistry({});
    await expect(
      registry.callTool('semantic.batchAt', { items: [{ line: 1, column: 1, kind: 'definition', extra: 1 }] }, scope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      registry.callTool('semantic.batchAt', { items: [{ line: '1', column: 1, kind: 'definition' }] }, scope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      registry.callTool('semantic.batchAt', { items: [{ line: 1, column: 1, kind: 'jump' }] }, scope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      registry.callTool('semantic.batchAt', { items: [{ line: 1, column: 1, kind: 'definition' }], cursor: 'x' }, scope),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' }); // 分页不适用 ⇒ 无 cursor 位
    // 空依赖注册表：合法入参穿过 schema，到腿上显式 NOT_WIRED（不静默）。
    await expect(
      registry.callTool('semantic.batchAt', { items: [{ line: 1, column: 1, kind: 'definition' }] }, scope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });
});
