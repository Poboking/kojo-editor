/**
 * Wave4 #4（LaneH）+ B10 收口（LaneV，2026-11-06）：`editor.openDocument` **已登记**为具名 edit 工具，
 * `editor.revealPosition` **仍不登记**；`editor.cursor` 是只读读数加法。
 *
 * 纯单测 / 假注入：不启 GUI、不起 Tauri、不起 HTTP，workspace / host / injection 全给假实现。
 *
 * 判性怎么变的（逐条）：LaneH 当年那四条证据一条都没被推翻（`editor.revealLocation` 至今是
 * fire-and-forget 事件），B10 改判的是**观察件**——`livePanes` 登记簿已可在执行时动态反查，
 * 「这条 path 有没有真上屏」变成读得回来的事实 ⇒ openDocument 登记（行为与反假绿用例在
 * `mcp-editor-open-document.test.ts`，那边钉回执读数、超时账与路径闸）。本文件只钉**登记面本身**：
 *  ① 登记 / 不登记的名单：SUPPLEMENTAL_TOOL_SPECS 与三档 registry.listTools 的形状；
 *  ② 仍不登记的那一枚：registry.callTool 到不了腿（UNKNOWN_TOOL），误调 runSupplemental 必得
 *     带判性理由的可见 NOT_WIRED；已登记那一枚**不再走兜底**（改由腿自己显式拒缺位真源）；
 *  ③ 台账同步：Wave4 #4 条目只剩 revealPosition，openDocument 的转登记判性另立一条；
 *     MCP_TOOL_GAP_MAP 不硬造映射（四处真源里没有「打开 GUI 文档」这一条缺口名）；
 *  ④ 只读加法：editor.cursor 仍 read 档 + readOnlyHint:true，read 会话可见，无活动编辑器显式 NOT_WIRED。
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

/** B10 批收口后**仍不登记**的那一枚（定位组合面）。 */
const UNREGISTERED = ['editor.revealPosition'] as const;
/** B10 批已登记为具名 edit 工具的那一枚（行为面见 mcp-editor-open-document.test.ts）。 */
const REGISTERED_IN_B10 = ['editor.openDocument'] as const;

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

describe('B10 收口 · 登记面（openDocument 已登记，revealPosition 仍不登记）', () => {
  it('SUPPLEMENTAL_TOOL_SPECS 不含 revealPosition；openDocument 已在册且是 edit 档（不抬 privileged）', () => {
    for (const name of UNREGISTERED) {
      expect(SUPPLEMENTAL_TOOL_SPECS.some((s) => s.name === name)).toBe(false);
    }
    for (const name of REGISTERED_IN_B10) {
      const spec = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === name);
      expect(spec, `${name} 应已登记为具名工具`).toBeDefined();
      expect(spec!.tier).toBe('edit');
      // 不收绝对路径：入参形状里只有项目根内相对路径那一条闸 + 有界窗，没有别的落点参数
      const props = spec!.inputSchema['properties'] as Record<string, Record<string, unknown>>;
      expect(Object.keys(props).sort()).toEqual(['deadlineMs', 'relPath']);
      expect(spec!.inputSchema['required']).toEqual(['relPath']);
      expect(spec!.inputSchema['additionalProperties']).toBe(false);
      expect(props['relPath']!.pattern, 'relPath 必须带拒绝对路径 / .. 的 pattern').toContain('?!');
      // description 必须自己把「读回来才算成功」讲给模型听（不是「发射了意图」那种半截话）
      expect(spec!.description).toContain('opened:true is answered ONLY after reading the pane registry back');
      expect(spec!.description).toContain('FAILS loudly');
    }
    const cursor = SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'editor.cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.tier).toBe('read');
    expect(cursor!.annotations).toMatchObject({ readOnlyHint: true });
    // 只读加法与写面分开记账：description 面向模型写明纯读、绝不冒充写能力
    expect(cursor!.description).toContain('read-only');
    expect(cursor!.description).toContain('never moves the caret');
  });

  it('read 会话两枚都看不见；edit 会话只见 openDocument（edit 档）、始终看不见 revealPosition', () => {
    const reg = createMcpCapabilityRegistry({});
    for (const scope of [readScope, editScope, privScope]) {
      const names = reg.listTools(scope).map((t) => t.name);
      for (const name of UNREGISTERED) expect(names).not.toContain(name);
    }
    const readNames = reg.listTools(readScope).map((t) => t.name);
    for (const name of REGISTERED_IN_B10) expect(readNames, 'edit 档不进 read 会话').not.toContain(name);
    expect(readNames).toContain('editor.cursor');
    expect(reg.listTools(readScope).every((t) => t.tier === 'read')).toBe(true);
    const editNames = reg.listTools(editScope).map((t) => t.name);
    for (const name of REGISTERED_IN_B10) expect(editNames).toContain(name);
    expect(reg.listTools(privScope).map((t) => t.name)).not.toContain('fileTree.remove'); // privileged 需逐工具批准
  });

  it('revealPosition 直调仍 UNKNOWN_TOOL（不登记 ⇒ 连 schema 闸 / 执行腿都到不了）；openDocument 已到得了腿', async () => {
    const reg = createMcpCapabilityRegistry({});
    for (const name of UNREGISTERED) {
      await expect(reg.callTool(name, argsFor(name), editScope)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    }
    // 已登记 ⇒ 不再是 UNKNOWN_TOOL；这里 registry 没注入 runSupplemental，故按缺席显式 NOT_WIRED（不假成功）
    for (const name of REGISTERED_IN_B10) {
      await expect(reg.callTool(name, argsFor(name), editScope)).rejects.toMatchObject({ code: 'NOT_WIRED' });
    }
  });
});

describe('B10 收口 · 无假成功与缺口台账', () => {
  it('台账两条各归各位：revealPosition 仍「不登记」，openDocument 有 B10 转登记判性条目', () => {
    const gapNote = MCP_DEFERRED_GAP_NOTES.find((n) => n.scope.includes('Wave4 #4'));
    expect(gapNote).toBeDefined();
    expect(gapNote!.scope).toContain('editor.revealPosition');
    expect(gapNote!.reason).toContain('editor.revealLocation');
    expect(gapNote!.reason).toContain('NOT_WIRED');
    expect(gapNote!.reason).toContain('fire-and-forget');
    expect(gapNote!.reason).toContain('不登记'); // 铁律：没有诚实数据面 ⇒ 不登记，不许退回「登记但 NOT_WIRED」
    expect(gapNote!.reason).toContain('editor.revealLine'); // 覆盖它的两枚要点名
    expect(gapNote!.reason).toContain('editor.setCursor');
    const b10 = MCP_DEFERRED_GAP_NOTES.find((n) => n.scope.includes('B10 批判性变更'));
    expect(b10, 'openDocument 的转登记判性必须写在台账里（不留陈旧断言）').toBeDefined();
    expect(b10!.scope).toContain('editor.openDocument');
    expect(b10!.reason).toContain('livePanes');
    expect(b10!.reason).toContain('resolveWithinRoot');
    // 四处真源里没有「打开 GUI 文档」这条缺口名 ⇒ 不硬造 tool→gap 映射（硬造会被盘点判 orphanedWires 假绿）
    for (const name of [...UNREGISTERED, ...REGISTERED_IN_B10, 'editor.cursor']) {
      expect(MCP_TOOL_GAP_MAP.some((w) => w.tool === name)).toBe(false);
    }
  });

  it('runSupplemental 兜底只管 revealPosition（带判性理由的可见 NOT_WIRED）；openDocument 改由腿自己显式拒', async () => {
    const sources = await buildRealMcpSources(host, injection);
    expect(sources.runSupplemental).toBeDefined();
    for (const name of UNREGISTERED) {
      const err = await mustFailNotWired(async () =>
        sources.runSupplemental!(name, argsFor(name), editScope),
      );
      expect(err.message).toContain('Wave4 #4');
      expect(err.message).toContain('fire-and-forget');
      expect(err.message).toContain('editor.revealLine');
    }
    // 兜底语句已撤：这一枚现在落到真源腿，缺位的是内核 / 项目（不是「没有通道」这句旧判性）
    for (const name of REGISTERED_IN_B10) {
      let code = '';
      let message = '';
      try {
        await sources.runSupplemental!(name, argsFor(name), editScope);
      } catch (err) {
        expect(err).toBeInstanceOf(McpFailure);
        code = (err as McpFailure).code;
        message = (err as McpFailure).message;
      }
      expect(code, '假 host 没有内核 ⇒ 必须由腿显式拒，绝不静默成功').toBe('RESOURCE_UNAVAILABLE');
      expect(message).not.toContain('Wave4 #4');
      expect(message).not.toContain('fire-and-forget');
    }
  });

  it('buildUiSupplemental 腿表不含这两枚写工具名（openDocument 在 ioTools，只读 editor.cursor 在 UI 腿表）', () => {
    const legs = buildUiSupplemental(fakeDeps(fakeWorkspace()), null);
    for (const name of [...UNREGISTERED, ...REGISTERED_IN_B10]) expect(legs.has(name)).toBe(false);
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
