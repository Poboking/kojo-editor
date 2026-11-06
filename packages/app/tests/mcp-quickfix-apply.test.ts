// @vitest-environment happy-dom
/**
 * Wave4 余项①（`problems.quickFix` 真执行）回归：稳定 actionId 台账 + 宿主受控 apply 通道。
 *
 * 判据（BOARD：不许假实现——稳定 `actionId` 与宿主受控 apply 通道必须同批落地）：
 * ① 端到端（真 monaco model + 真 `livePanes` 登记 + 真 `applyTextEdits` + 生产动态 import 解析）：
 *   清单 ⇒ 拿到宿主签发 id ⇒ apply ⇒ 文档确实变（模型内）⇒ 一次 Ctrl+Z 退得掉 ⇒
 *   **文档一变（编辑/撤销）旧 id 必被显式拒绝**；
 * ② 逐闸拒绝（注入假件，全红可追）：未列过 / 编造 id / 跨会话 / 位置不符 / pane 退册 /
 *   换文档 / 反查表已清 / run 式意图 / 糖投影 / edits 形状非法 / apply 回报 false；
 * ③ 台账有界 + 过期清理（超出上限淘汰最旧，被清 id 再 apply 显式失败，不静默）；
 * ④ 档位：read 会话在 WebView registry 即 PERMISSION_DENIED（腿零触达）；
 * ⑤ 不落盘安全钉：成功路径只动 model——kernel io 写原语 / invoke / bus.emit 零触达
 *   （铁律 5/6/7：本批没有新建任何写通道）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { createMcpCapabilityRegistry, type McpSessionScope } from '@kojo/mcp-host';
import { registerPane, unregisterPane, type PaneRefs } from '../src/ui/editor-pane-registry';
import { createRunSupplemental, type McpIoDeps } from '../src/mcp/real-sources-io';
import {
  buildSemanticReaders,
  type McpLanguageFeaturesLike,
  type McpSemanticMonaco,
  type McpSemanticModel,
  type McpSemanticWorkspace,
} from '../src/mcp/real-sources';
import {
  productionResolveQuickFixPane,
  quickFixTicketCount,
  recordQuickFixTickets,
  resetQuickFixTickets,
  type QuickFixPaneHandle,
} from '../src/mcp/quick-fix';

const URI_A = 'file:///D:/proj/a.kojo';

const editScope: McpSessionScope = {
  sessionId: 'sess-a',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: [],
  approvedTools: [],
};
const readScope: McpSessionScope = { ...editScope, tier: 'read' };

/* ================================================================== *
 * ① 端到端：真 model + 真 livePanes + 真 applyTextEdits + 生产解析
 * ================================================================== */

interface PaneRig {
  readonly paneId: string;
  readonly ctx: PaneRefs;
  readonly model: monaco.editor.ITextModel;
}

const rigs: PaneRig[] = [];
const models: monaco.editor.ITextModel[] = [];

/** 归属实例档案的最小假件（quickFix 只读 editorRef / pendingActionsRef / sugarModelRef / actionSeqRef）。 */
function openPane(text: string, uri: string): PaneRig {
  const model = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(uri));
  models.push(model);
  // editor 转发桩（同 code-action-undo-stack 口径）：撤销栈住 model，机器改写走真路。
  const editor = {
    getModel: () => model,
    executeEdits: (_source: string, operations: monaco.editor.IIdentifiedSingleEditOperation[]) =>
      model.pushEditOperations(null, operations, () => null) !== null,
    pushUndoStop: () => model.pushStackElement(),
  };
  const ctx: PaneRefs = {
    editorRef: { current: editor as unknown as PaneRefs['editorRef']['current'] },
    entriesRef: { current: new Map() },
    filePathRef: { current: 'D:\\proj\\a.kojo' },
    sugarModelRef: { current: null },
    sugarLineMapRef: { current: [] },
    pendingActionsRef: { current: new Map() },
    actionSeqRef: { current: 0 },
    crumbTreeCacheRef: { current: null },
    unlockedPathsRef: { current: new Set<string>() },
  } as unknown as PaneRefs;
  const paneId = registerPane(ctx);
  const rig: PaneRig = { paneId, ctx, model };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) unregisterPane(rig.paneId);
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  resetQuickFixTickets();
});

/** 模仿宿主 `provideCodeActionsFor` 的 sink：动作实例挂进 pane 反查表，id 用同款签发形态。 */
function hostLikeProvider(rig: PaneRig, action: Record<string, unknown>) {
  return {
    provideCodeActions: () => {
      const actionId = `${rig.paneId}:test-fix#${++rig.ctx.actionSeqRef.current}`;
      (rig.ctx.pendingActionsRef.current as unknown as Map<string, unknown>).set(actionId, action);
      return {
        actions: [
          {
            title: (action['title'] as string) ?? 'fix it',
            kind: 'quickfix',
            command: { id: 'kojo.codeAction.run', title: (action['title'] as string) ?? 'fix it', arguments: [actionId] },
          },
        ],
      };
    },
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
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
    CancellationTokenSource: class {
      readonly token = { cancelled: false };
      dispose(): void {}
    },
    editor: { tokenize: () => [], getModelMarkers: () => [] },
  } as unknown as McpSemanticMonaco;
}

function e2eSetup(action: Record<string, unknown>, text = 'alpha\nbeta\ngamma') {
  const rig = openPane(text, URI_A);
  const provider = hostLikeProvider(rig, action);
  const ws: McpSemanticWorkspace = {
    model: rig.model as unknown as McpSemanticModel,
    monaco: fakeMonaco(),
    cursor: { line: 2, column: 1 },
    rootDir: 'D:/proj',
  };
  const features = { codeActionProvider: { ordered: () => [{ provideCodeActions: provider.provideCodeActions }] } };
  const semantic = buildSemanticReaders({
    getMonaco: () => fakeMonaco(),
    getWorkspace: () => ws,
    getLegs: () => null,
    getFeaturesService: () => features as unknown as McpLanguageFeaturesLike,
    getRootDir: () => 'D:/proj',
  });
  // runSupplemental 不给 getQuickFixPane ⇒ 走生产动态 import（livePanes + applyTextEdits）。
  const ioDeps: McpIoDeps = {
    getKernel: () => null,
    getCommands: () => [],
    invoke: vi.fn(async () => null),
    searchInFiles: async () => {
      throw new Error('searchInFiles 不该被 quickFix 触达');
    },
  };
  const reg = createMcpCapabilityRegistry({
    semantic,
    runSupplemental: createRunSupplemental(ioDeps),
  });
  return { rig, reg };
}

describe('① quickFix 端到端（真 model / 真 livePanes / 真 applyTextEdits / 真 registry）', () => {
  it('列动作 ⇒ 拿宿主 id ⇒ apply ⇒ 文档变 ⇒ 一次 undo 退回 ⇒ 旧 id 再 apply 显式失败', async () => {
    const { rig, reg } = e2eSetup({
      title: 'B 大写',
      edits: [{ fromLine: 2, toLine: 2, newText: 'BETA' }],
      run: () => undefined,
    });
    const listed = (await reg.callTool('semantic.codeActionsAt', { line: 2, column: 1 }, editScope)) as Record<string, unknown>;
    const items = listed['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const actionId = items[0]?.['actionId'] as string;
    expect(actionId).toMatch(new RegExp(`^${rig.paneId}:test-fix#1$`)); // 宿主签发形态，非 MCP 编造

    const applied = (await reg.callTool('problems.quickFix', { actionId, line: 2, column: 1 }, editScope)) as Record<string, unknown>;
    expect(applied).toMatchObject({ actionId, title: 'B 大写', editsApplied: 1 });
    expect(typeof applied['versionBefore']).toBe('number');
    expect(applied['versionAfter']).not.toBe(applied['versionBefore']); // 版本闸的失效凭据
    expect(rig.model.getLineContent(2)).toBe('BETA'); // 文档确实变了（模型内）
    expect(rig.model.canUndo()).toBe(true);
    await rig.model.undo(); // 一次 Ctrl+Z：整段机器改写退回
    expect(rig.model.getLineContent(2)).toBe('beta');

    // 已消耗 + 已过期（undo 也推版本）：旧 id 再 apply 必须显式失败，不假成功。
    await expect(reg.callTool('problems.quickFix', { actionId, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
  });

  it('清单后文档被编辑 ⇒ 同一旧 id ⇒ [E_QUICKFIX_DOC_CHANGED] 显式拒绝（行号不过期执行）', async () => {
    const { rig, reg } = e2eSetup({
      title: 'B 大写',
      edits: [{ fromLine: 2, toLine: 2, newText: 'BETA' }],
    });
    const listed = (await reg.callTool('semantic.codeActionsAt', { line: 2, column: 1 }, editScope)) as Record<string, unknown>;
    const actionId = (listed['items'] as Record<string, unknown>[])[0]!['actionId'] as string;

    // 用户改了第 1 行（版本前进；即使第 2 行没动，旧清单语义已过期）
    rig.model.applyEdits([{ range: new monaco.Range(1, 6, 1, 6), text: '!' }]);

    await expect(reg.callTool('problems.quickFix', { actionId, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      message: expect.stringContaining('[E_QUICKFIX_DOC_CHANGED]'),
    });
    expect(rig.model.getLineContent(2)).toBe('beta'); // 被拒的 apply 一个字节都没动
  });

  it('不落盘安全钉：成功 apply 只动 model，io / invoke / bus 零触达（铁律 5/6/7）', async () => {
    const invoke = vi.fn(async () => null);
    const emit = vi.fn();
    const writeText = vi.fn(async () => undefined);
    const rig = openPane('alpha\nbeta\ngamma', URI_A);
    const provider = hostLikeProvider(rig, { title: 't', edits: [{ fromLine: 2, toLine: 2, newText: 'B' }] });
    const ws: McpSemanticWorkspace = {
      model: rig.model as unknown as McpSemanticModel,
      monaco: fakeMonaco(),
      cursor: { line: 2, column: 1 },
      rootDir: 'D:/proj',
    };
    const kernel = {
      project: { current: () => ({ rootDir: 'D:\\proj' }) },
      io: { walkDir: async () => [], writeText },
      plugins: { list: () => [] },
      services: { tryGet: () => undefined },
      bus: { on: () => () => {}, emit },
      slots: { query: () => [] },
    };
    const semantic = buildSemanticReaders({
      getMonaco: () => fakeMonaco(),
      getWorkspace: () => ws,
      getLegs: () => null,
      getFeaturesService: () => ({ codeActionProvider: { ordered: () => [provider] } }) as unknown as McpLanguageFeaturesLike,
      getRootDir: () => 'D:/proj',
    });
    const sup = createRunSupplemental({
      getKernel: () => kernel,
      getCommands: () => [],
      invoke,
      searchInFiles: async () => {
        throw new Error('不该触达');
      },
    } as unknown as McpIoDeps);
    const listed = (await semantic.codeActionsAt!({ line: 2, column: 1 }, editScope)) as Record<string, unknown>;
    const actionId = (listed['items'] as Record<string, unknown>[])[0]!['actionId'] as string;
    await sup('problems.quickFix', { actionId, line: 2, column: 1 }, editScope);
    expect(writeText).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(rig.model.getLineContent(2)).toBe('B'); // 唯一落点 = 模型
  });
});

/* ================================================================== *
 * ② 逐闸拒绝（注入假件；台账用 recordQuickFixTickets 直种）
 * ================================================================== */

const AID = 'pane-9:test-fix#1';

interface Rig2 {
  readonly sup: ReturnType<typeof createRunSupplemental>;
  readonly handle: QuickFixPaneHandle & { applyEdits: ReturnType<typeof vi.fn> };
  state: { version: number; uri: string; paneAlive: boolean; sugar: string | null };
}

function fakeLeg(over: Partial<{ action: Record<string, unknown> | null; applyResult: boolean }> = {}): Rig2 {
  const state = { version: 5, uri: URI_A, paneAlive: true, sugar: null as string | null };
  const model = {
    uri: { toString: () => state.uri },
    getVersionId: () => state.version,
  };
  const editor = { getModel: () => model };
  const action = 'action' in over ? over.action : { title: 'fix it', edits: [{ fromLine: 2, toLine: 2, newText: 'B' }] };
  const pending = new Map<string, unknown>();
  if (action !== null) pending.set(AID, action);
  const applyEdits = vi.fn(() => over.applyResult ?? true);
  const handle: Rig2['handle'] = {
    editor,
    pendingActions: pending,
    get sugarModelUri() {
      return state.sugar;
    },
    applyEdits,
  };
  const sup = createRunSupplemental({
    getKernel: () => null,
    getCommands: () => [],
    invoke: async () => null,
    searchInFiles: async () => {
      throw new Error('不该触达');
    },
    getQuickFixPane: async (paneId) => (paneId === 'pane-9' && state.paneAlive ? handle : null),
  });
  return { sup, handle, state };
}

function seed(over: Partial<{ line: number; column: number; version: number | null; sessionId: string }> = {}) {
  recordQuickFixTickets({
    sessionId: over.sessionId ?? 'sess-a',
    uri: URI_A,
    versionId: 'version' in over ? over.version ?? null : 5,
    line: over.line ?? 2,
    column: over.column ?? 1,
    items: [{ title: 'fix it', actionId: AID }],
  });
}

describe('② 逐闸显式拒绝（不静默、不假成功）', () => {
  it('缺 actionId / 位置非法 ⇒ INVALID_ARGS（台账零触达前就拒）', async () => {
    const { sup } = fakeLeg();
    await expect(sup('problems.quickFix', { line: 2, column: 1 }, editScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('problems.quickFix', { actionId: AID, line: 0, column: 1 }, editScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(sup('problems.quickFix', { actionId: AID, line: 1.5, column: 1 }, editScope)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('未列过 / 编造 id ⇒ [E_QUICKFIX_UNLISTED]；非宿主签发形态的 id 连台账都不进', async () => {
    seed();
    const { sup, handle } = fakeLeg();
    await expect(sup('problems.quickFix', { actionId: 'pane-1:evil#999', line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
    // 野路子 id（假 provider 给的）不记假账：record 返回 0，apply 显式失败。
    expect(recordQuickFixTickets({ sessionId: 'sess-a', uri: URI_A, versionId: 1, line: 1, column: 1, items: [{ title: 'x', actionId: 'not-a-host-id' }] })).toBe(0);
    await expect(sup('problems.quickFix', { actionId: 'not-a-host-id', line: 1, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
    expect(handle.applyEdits).not.toHaveBeenCalled();
  });

  it('跨会话挪用 ⇒ PERMISSION_DENIED [E_QUICKFIX_CROSS_SESSION]', async () => {
    seed();
    const { sup, handle } = fakeLeg();
    const other: McpSessionScope = { ...editScope, sessionId: 'sess-b' };
    await expect(sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, other)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('[E_QUICKFIX_CROSS_SESSION]'),
    });
    expect(handle.applyEdits).not.toHaveBeenCalled();
  });

  it('位置与清单不符 ⇒ [E_QUICKFIX_POSITION_MISMATCH]（换位置执行是假实现）', async () => {
    seed();
    const { sup } = fakeLeg();
    await expect(sup('problems.quickFix', { actionId: AID, line: 3, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_POSITION_MISMATCH]'),
    });
  });

  it('pane 退册 ⇒ NOT_WIRED [E_QUICKFIX_PANE_GONE]，不迁移不伪造', async () => {
    seed();
    const rig = fakeLeg();
    rig.state.paneAlive = false;
    await expect(rig.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_QUICKFIX_PANE_GONE]'),
    });
  });

  it('归属实例换了文档 ⇒ [E_QUICKFIX_DOC_CHANGED]（uri 面）；版本前进 ⇒ 同码（版本面）', async () => {
    seed();
    const rig = fakeLeg();
    rig.state.uri = 'file:///D:/proj/other.kojo';
    await expect(rig.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_DOC_CHANGED]'),
    });
    rig.state.uri = URI_A;
    seed({ version: 7 }); // 同 id 重记 ⇒ 版本 7
    rig.state.version = 8; // 清单后又变了
    await expect(rig.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_DOC_CHANGED]'),
    });
  });

  it('宿主反查表已被整体清理 ⇒ [E_QUICKFIX_ACTION_EXPIRED]', async () => {
    seed();
    const rig = fakeLeg({ action: null });
    await expect(rig.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_ACTION_EXPIRED]'),
    });
  });

  it('run 式意图（无 edits）⇒ NOT_WIRED [E_QUICKFIX_RUN_INTENT]：能力没接上的部分保持显式', async () => {
    seed();
    const { sup, handle } = fakeLeg({ action: { title: 'open dialog', run: () => undefined } });
    await expect(sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_QUICKFIX_RUN_INTENT]'),
    });
    expect(handle.applyEdits).not.toHaveBeenCalled();
  });

  it('糖投影（派生视图）⇒ NOT_WIRED [E_QUICKFIX_DERIVED_VIEW]', async () => {
    seed();
    const rig = fakeLeg();
    rig.state.sugar = URI_A; // 清单位子就是投影 model
    await expect(rig.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_QUICKFIX_DERIVED_VIEW]'),
    });
  });

  it('edits 形状非法 ⇒ [E_QUICKFIX_EDIT_SHAPE] 整条拒绝；apply 回报 false ⇒ [E_QUICKFIX_APPLY_FAILED] 不冒充成功', async () => {
    seed();
    const bad = fakeLeg({ action: { title: 't', edits: [{ fromLine: 0, toLine: 2, newText: 'x' }] } });
    await expect(bad.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_EDIT_SHAPE]'),
    });
    expect(bad.handle.applyEdits).not.toHaveBeenCalled();

    seed({ version: 6 });
    const failing = fakeLeg({ applyResult: false });
    failing.state.version = 6;
    await expect(failing.sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_APPLY_FAILED]'),
    });
  });

  it('WebView registry 档位闸：read 会话直调 ⇒ PERMISSION_DENIED，执行腿零触达', async () => {
    seed();
    const rig = fakeLeg();
    const reg = createMcpCapabilityRegistry({ runSupplemental: rig.sup });
    await expect(reg.callTool('problems.quickFix', { actionId: AID, line: 2, column: 1 }, readScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(rig.handle.applyEdits).not.toHaveBeenCalled();
    // edit 会话同参数：腿真跑通（台账与假件都备好的那条）。
    const out = (await reg.callTool('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)) as Record<string, unknown>;
    expect(out['editsApplied']).toBe(1);
    expect(rig.handle.applyEdits).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== *
 * ③ 台账有界 + 过期清理
 * ================================================================== */

describe('③ 台账有界（超出上限淘汰最旧，被清 id 再 apply 显式失败）', () => {
  it('灌 305 个不同位置的条目 ⇒ 条数 ≤ 300，最旧条目出局', async () => {
    for (let i = 0; i < 305; i += 1) {
      recordQuickFixTickets({
        sessionId: 'sess-a',
        uri: URI_A,
        versionId: 1,
        line: 1 + (i % 50),
        column: 1 + (i % 7),
        items: [{ title: `t${i}`, actionId: `pane-1:c#${i}` }],
      });
    }
    expect(quickFixTicketCount()).toBeLessThanOrEqual(300);
    const { sup } = fakeLeg();
    // 最旧那些（id0）已被淘汰：apply ⇒ UNLISTED（去向账：有界清理 = 显式失败，不静默放行）。
    await expect(sup('problems.quickFix', { actionId: 'pane-1:c#0', line: 1, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
    // 最新一条仍在台账（能走到位置/版本闸，说明没被误清）：给一个不一致的位置 ⇒ POSITION_MISMATCH。
    await expect(sup('problems.quickFix', { actionId: 'pane-1:c#304', line: 5, column: 6 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_POSITION_MISMATCH]'),
    });
  });

  it('resetQuickFixTickets 后所有旧 id 一律显式失败（不静默）', async () => {
    seed();
    resetQuickFixTickets();
    const { sup } = fakeLeg();
    await expect(sup('problems.quickFix', { actionId: AID, line: 2, column: 1 }, editScope)).rejects.toMatchObject({
      message: expect.stringContaining('[E_QUICKFIX_UNLISTED]'),
    });
  });
});

/* ---------------- 生产解析腿本身可指认（动态 import 链没接错） ---------------- */

describe('生产 pane 解析', () => {
  it('livePanes 里查无此 pane ⇒ null；在册 pane ⇒ 真 pendingActionsRef + 真 applyTextEdits', async () => {
    expect(await productionResolveQuickFixPane('pane-does-not-exist')).toBeNull();
    const rig = openPane('x\ny', URI_A);
    const handle = await productionResolveQuickFixPane(rig.paneId);
    expect(handle).not.toBeNull();
    expect(handle!.pendingActions).toBe(rig.ctx.pendingActionsRef.current);
    const applied = handle!.applyEdits(handle!.editor, [{ fromLine: 2, toLine: 2, newText: 'Y' }]);
    expect(applied).toBe(true);
    expect(rig.model.getLineContent(2)).toBe('Y'); // 真 applyTextEdits 落在真 model（一次撤销步）
    await rig.model.undo();
    expect(rig.model.getLineContent(2)).toBe('y');
  });
});
