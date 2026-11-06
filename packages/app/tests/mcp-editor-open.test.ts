/**
 * Wave4 #4（LaneH）：editor.openDocument / editor.revealPosition 判性后不登记 + editor.cursor 只读加法。
 *
 * 纯单测 / 假注入：不启 GUI、不起 Tauri、不起 HTTP，workspace / host / injection 全给假实现。
 *
 * 判性结论：宿主没有可从 MCP 注入面安全复用、且能诚实回报结果的「打开文档 / 定位光标」真源。
 * 按铁律 4「真源不存在=不登记（绝不挂空串假实现）」，本测试钉住三件事，每件都能红：
 *  ① 不登记：两枚名字在 SUPPLEMENTAL_TOOL_SPECS / registry.listTools（三档会话）里都不存在、
 *     registry.callTool 直调一律 UNKNOWN_TOOL；buildUiSupplemental 腿表也不含两枚、
 *     MCP_TOOL_GAP_MAP 无硬造映射、MCP_DEFERRED_GAP_NOTES 有 Wave4 #4 显式缺口条目；
 *  ② 无假成功：runSupplemental 前置兜底对两枚名字仍抛带判性理由的可见 NOT_WIRED，
 *     绝不静默成功 / 不返回空串 / 不返回假 {opened:true} / {moved:true}；
 *  ③ 只读加法：editor.cursor 仍 read 档 + readOnlyHint:true、read 会话可见，
 *     真读返回焦点编辑器光标、无活动编辑器显式 NOT_WIRED。
 */
import { describe, expect, it } from 'vitest';
import {
  McpFailure,
  MCP_DEFERRED_GAP_NOTES,
  MCP_TOOL_GAP_MAP,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import {
  buildRealMcpSources,
  buildUiSupplemental,
  type McpRealSourceHost,
  type McpRealSourceInjection,
  type McpSemanticDeps,
  type McpSemanticMonaco,
  type McpSemanticWorkspace,
} from '../src/mcp/real-sources';

const OPEN_TOOLS = ['editor.openDocument', 'editor.revealPosition'] as const;

const readScope: McpSessionScope = {
  sessionId: 's1', clientId: 'c1', tier: 'read', approvedRoots: ['/proj'], approvedTools: [],
};
const editScope: McpSessionScope = { ...readScope, tier: 'edit' };
const privScope: McpSessionScope = { ...readScope, tier: 'privileged' };

/** 焦点编辑器的最窄假件：caret 在 7:3，文档 12 行，语言 typescript。 */
function fakeWorkspace(): McpSemanticWorkspace {
  return {
    model: {
      uri: { toString: () => '/proj/src/a.txt' },
      getLineCount: () => 12,
      getLineMaxColumn: () => 80,
      getLineContent: () => 'hello',
      getLanguageId: () => 'typescript',
      getEOL: () => '\n',
      getValue: () => 'hello\n',
    },
    monaco: {} as McpSemanticMonaco,
    cursor: { line: 7, column: 3 },
    rootDir: '/proj',
  };
}

function fakeDeps(workspace: McpSemanticWorkspace | null): McpSemanticDeps {
  return {
    getMonaco: () => null,
    getWorkspace: () => workspace,
    getLegs: () => null,
    getFeaturesService: () => null,
    getRootDir: () => '/proj',
  };
}

/** 假 host / 假 injection：让 buildRealMcpSources 零动态 import、零 GUI / Tauri / HTTP。 */
const host: McpRealSourceHost = {
  getCommands: () => [],
  getCommandContext: () => ({ project: null }),
  getKernel: () => null,
};
const injection: McpRealSourceInjection = {
  invoke: async () => '',
  searchInFiles: async () => ({
    files: [], totalMatches: 0, truncated: false, filesScanned: 0, elapsedMs: 0, skipped: [],
  }),
  getMonaco: () => null,
  getWorkspace: () => null,
  getLegs: () => null,
  getFeaturesService: () => null,
};

/** 「调用必抛可见 NOT_WIRED」判据：任何静默成功（含空串 / 假成功对象）都让测试失败。 */
async function mustFailNotWired(fn: () => Promise<unknown>): Promise<McpFailure> {
  let out: unknown;
  try {
    out = await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpFailure);
    expect((err as McpFailure).code).toBe('NOT_WIRED');
    expect((err as McpFailure).message.length).toBeGreaterThan(0); // 可见，不是静默
    return err as McpFailure;
  }
  throw new Error(`调用静默成功（应抛 NOT_WIRED），返回=${JSON.stringify(out)}`);
}

function argsFor(name: string): Record<string, unknown> {
  return name === 'editor.openDocument' ? { relPath: 'src/a.txt' } : { line: 3, column: 5 };
}

describe('Wave4 #4 · 不登记判据（真源不存在 ⇒ 不登记，绝不挂空串假实现）', () => {
  it('SUPPLEMENTAL_TOOL_SPECS 不含两枚 edit 档工具；editor.cursor 仍是 read 档 + readOnlyHint:true', () => {
    for (const name of OPEN_TOOLS) {
      expect(SUPPLEMENTAL_TOOL_SPECS.some((s) => s.name === name)).toBe(false);
    }
    const cursor = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'editor.cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.tier).toBe('read');
    expect(cursor!.annotations).toMatchObject({ readOnlyHint: true });
    // 只读加法与缺口分开记账：description 面向模型写明纯读、绝不冒充写能力
    expect(cursor!.description).toContain('read-only');
    expect(cursor!.description).toContain('never moves the caret');
  });

  it('三档会话的 registry.listTools 都不见两枚；editor.cursor 在 read 会话可见', () => {
    const reg = createMcpCapabilityRegistry({});
    for (const scope of [readScope, editScope, privScope]) {
      const names = reg.listTools(scope).map((t) => t.name);
      for (const name of OPEN_TOOLS) expect(names).not.toContain(name);
    }
    const readNames = reg.listTools(readScope).map((t) => t.name);
    expect(readNames).toContain('editor.cursor');
    expect(reg.listTools(readScope).every((t) => t.tier === 'read')).toBe(true);
    expect(reg.listTools(privScope).map((t) => t.name)).not.toContain('fileTree.remove'); // privileged 需逐工具批准
  });

  it('registry.callTool 直调两枚一律 UNKNOWN_TOOL（不登记 ⇒ 连 schema 闸 / 执行腿都到不了，不假成功）', async () => {
    const reg = createMcpCapabilityRegistry({});
    for (const name of OPEN_TOOLS) {
      await expect(reg.callTool(name, argsFor(name), editScope)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    }
  });
});

describe('Wave4 #4 · 无假成功与缺口台账', () => {
  it('MCP_DEFERRED_GAP_NOTES 有 Wave4 #4 不登记 + 显式缺口条目；MCP_TOOL_GAP_MAP 无硬造映射', () => {
    const note = MCP_DEFERRED_GAP_NOTES.find((n) => n.scope.includes('Wave4 #4'));
    expect(note).toBeDefined();
    expect(note!.reason).toContain('editor.revealLocation');
    expect(note!.reason).toContain('NOT_WIRED');
    expect(note!.reason).toContain('fire-and-forget');
    expect(note!.reason).toContain('不登记'); // 铁律：真源不存在 ⇒ 不登记，不许退回「登记但 NOT_WIRED」
    // 没有对应的真实缺口 ⇒ 不硬造 tool→gap 映射（硬造会被盘点判 orphanedWires / 假绿）
    for (const name of [...OPEN_TOOLS, 'editor.cursor']) {
      expect(MCP_TOOL_GAP_MAP.some((w) => w.tool === name)).toBe(false);
    }
  });

  it('runSupplemental 直调两枚仍抛带判性理由的可见 NOT_WIRED（防御性显式失败，不假成功）', async () => {
    const sources = await buildRealMcpSources(host, injection);
    expect(sources.runSupplemental).toBeDefined();
    for (const name of OPEN_TOOLS) {
      const err = await mustFailNotWired(async () =>
        sources.runSupplemental!(name, argsFor(name), editScope),
      );
      expect(err.message).toContain('Wave4 #4');
      expect(err.message).toContain('fire-and-forget');
    }
  });

  it('无真执行腿：buildUiSupplemental 腿表不含两个写工具名（只读 editor.cursor 在表内）', () => {
    const legs = buildUiSupplemental(fakeDeps(fakeWorkspace()), null);
    for (const name of OPEN_TOOLS) expect(legs.has(name)).toBe(false);
    expect(legs.has('editor.cursor')).toBe(true);
  });
});

describe('Wave4 #4 · editor.cursor 只读读数加法（与缺口判性分开记账）', () => {
  it('真读腿返回焦点编辑器光标与文档读数（纯读，不改光标 / 不开文件）', async () => {
    const legs = buildUiSupplemental(fakeDeps(fakeWorkspace()), null);
    const read = legs.get('editor.cursor')!;
    const out = (await read({}, readScope)) as Record<string, unknown>;
    expect(out).toMatchObject({
      path: expect.stringContaining('a.txt'),
      language: 'typescript',
      line: 7,
      column: 3,
      lineCount: 12,
    });
    // 与写缺口分开记账：它是 read 档 + readOnlyHint，且真能返回结果（不是拿读数冒充写工具）
    const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'editor.cursor')!;
    expect(spec.tier).toBe('read');
    expect(spec.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('无活动编辑器 ⇒ editor.cursor 显式 NOT_WIRED，绝不编造 {line:1,column:1}', async () => {
    const legs = buildUiSupplemental(fakeDeps(null), null);
    const read = legs.get('editor.cursor')!;
    await mustFailNotWired(async () => read({}, readScope));
  });
});
