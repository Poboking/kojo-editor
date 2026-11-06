// @vitest-environment happy-dom
/**
 * MCP 端到端集成单测（路 A）—— 注入 seam，不起 GUI / HTTP / Tauri 真身。
 *
 * 覆盖四块：
 *  ① `defaultRegistryFactory` 不经任何注入，解出**真** `@kojo/mcp-host` 注册表
 *     （`tools/list` 回真工具清单、未接线腿调用显式报错）；
 *  ⑤ `host-bridge` 六种 method 分派、显式 error 帧、取消 / 超时 / 体积上限不回退；
 *  ⑥ `SettingsPanel` 在 `isTauri()` 真 / 假两态下节数正确（8 / 9），'ai' 节可渲染；
 *  ⑦ `AiAccessSection` 的 scope / audit / approve / revoke 命中 4 个命令名、失败不静默。
 *
 * 关于 `isTauri()`：直接切 `window.__TAURI_INTERNALS__`（`bridge/invoke.ts` 的判据），
 * 不用 `vi.mock` / `vi.resetModules()`，以免把 React 实例打散成两份（invalid hook call）。
 * 因此 ① 必须是本文件**第一个**用例：它依赖 `registryFactory === null` 的初始模块状态；
 * 其后每个 host-bridge 用例都显式传全套 options，杜绝 sticky 状态串味。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { createMcpCapabilityRegistry, McpFailure, type McpCapabilityRegistry, type McpSessionScope } from '@kojo/mcp-host';
import {
  cancelAllMcpRequests,
  cancelMcpRequest,
  registerMcpHostBridge,
  type McpBridgeTransport,
  type McpMethod,
  type McpRequestEvent,
  type McpRespondArgs,
} from '../src/mcp/host-bridge';
import { SETTINGS_SECTIONS, type SettingsPanelProps } from '../src/ui/SettingsPanel';
import { createMcpHostDeps } from '../src/mcp/wiring';
import { createSemanticService } from '../src/mcp/semantic-service';
import type { ApprovalBatch } from '../src/mcp/approval-ui';
import {
  AiAccessSection,
  MCP_SETTINGS_COMMANDS,
  approveMcpSession,
  queryMcpAudit,
  queryMcpScope,
  revokeMcpSession,
  scopeStateToApproval,
  scopeStateToClients,
  toAuditEntryView,
  type McpCommandRunner,
  type McpScopeState,
} from '../src/mcp/settings-ai';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope: McpSessionScope = {
  sessionId: 's1',
  clientId: 'c1',
  tier: 'privileged',
  approvedRoots: ['/proj'],
  approvedTools: [],
};

function setTauri(on: boolean): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

afterEach(() => {
  document.body.innerHTML = '';
  setTauri(false);
});

/* --------------------------- host-bridge 测试脚手架 --------------------------- */

interface Call {
  method: string;
  args: unknown[];
}

function makeRegistry(over: Record<string, unknown> = {}): {
  registry: McpCapabilityRegistry;
  calls: Call[];
} {
  const calls: Call[] = [];
  const rec = (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return `${method}:ok`;
    };
  const registry = {
    listTools: rec('listTools'),
    listResources: rec('listResources'),
    listPrompts: rec('listPrompts'),
    callTool: rec('callTool'),
    readResource: rec('readResource'),
    getPrompt: rec('getPrompt'),
    ...over,
  } as unknown as McpCapabilityRegistry;
  return { registry, calls };
}

interface Harness {
  transport: McpBridgeTransport;
  frames: McpRespondArgs[];
  ready: Promise<void>;
  emit(event: McpRequestEvent): void;
  waitFor(n: number): Promise<void>;
}

function createHarness(): Harness {
  const frames: McpRespondArgs[] = [];
  const listeners = new Set<() => void>();
  let handler: ((e: McpRequestEvent) => void) | null = null;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const transport: McpBridgeTransport = {
    listen: async (fn) => {
      handler = fn;
      markReady();
      return () => {
        handler = null;
      };
    },
    respond: async (args) => {
      frames.push(args);
      for (const l of [...listeners]) l();
    },
  };
  const waitFor = (n: number): Promise<void> => {
    if (frames.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const l = (): void => {
        if (frames.length >= n) {
          listeners.delete(l);
          resolve();
        }
      };
      listeners.add(l);
    });
  };
  return {
    transport,
    frames,
    ready,
    emit: (event) => handler?.(event),
    waitFor,
  };
}

function evt(
  id: string,
  method: McpMethod,
  params: Record<string, unknown> = {},
): McpRequestEvent {
  return { id, method, params, scope };
}

/** 每个 host-bridge 用例都显式给全套 options，避免模块级 sticky 状态串味。 */
const BASE_OPTIONS = {
  deps: {},
  timeoutMs: 100_000,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;

describe('host-bridge：默认工厂 / 六种分派 / 取消超时体积', () => {
  // ① 必须第一：只有此处不注入 registryFactory，才会走 defaultRegistryFactory。
  it('① defaultRegistryFactory 解出真 @kojo/mcp-host 注册表，未接线腿显式报错', async () => {
    const hz = createHarness();
    const off = registerMcpHostBridge({ transport: hz.transport, ...BASE_OPTIONS });
    await hz.ready;

    hz.emit(evt('real-1', 'tools/list'));
    await hz.waitFor(1);
    const listFrame = hz.frames.find((f) => f.id === 'real-1')!;
    expect(listFrame.ok).toBe(true);
    const tools = listFrame.result as readonly { name: string }[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === 'semantic.definitionAt')).toBe(true);
    expect(tools.some((t) => t.name === 'project.info')).toBe(true);
    // 写腿工具照常列出（能力可见）：edit 档，执行体在宿主真源装配后走内核 io 写通道。
    expect(tools.some((t) => t.name === 'fileTree.create')).toBe(true);
    expect(tools.some((t) => t.name === 'fileTree.update')).toBe(true);

    // 空 deps（未登记真源）⇒ 该语义工具的取数腿调用时显式报错，不静默
    hz.emit(evt('real-2', 'tools/call', {
      name: 'semantic.definitionAt',
      arguments: { line: 1, column: 1 },
    }));
    await hz.waitFor(2);
    const callFrame = hz.frames.find((f) => f.id === 'real-2')!;
    expect(callFrame.ok).toBe(false);
    expect(callFrame.error?.code).toBeTruthy();
    expect(callFrame.error?.message).toContain('未接线');

    // 写腿同口径：宿主未登记 runSupplemental ⇒ fileTree.update 显式 NOT_WIRED（不静默）。
    // （host-bridge 对非 BridgeError 统一包 mcp/internal，McpFailure 原文随 message 透出——
    // 与上面 semantic.definitionAt 同一约定。）
    hz.emit(evt('real-3', 'tools/call', {
      name: 'fileTree.update',
      arguments: { relPath: 'docs/a.txt', content: 'x' },
    }));
    await hz.waitFor(3);
    const writeFrame = hz.frames.find((f) => f.id === 'real-3')!;
    expect(writeFrame.ok).toBe(false);
    expect(writeFrame.error?.code).toBeTruthy();
    expect(writeFrame.error?.message).toContain('fileTree.update');
    expect(writeFrame.error?.message).toContain('未接线');

    // resources / prompts 同样来自真 registry
    hz.emit(evt('real-5', 'resources/list'));
    hz.emit(evt('real-6', 'prompts/list'));
    await hz.waitFor(5);
    const rFrame = hz.frames.find((f) => f.id === 'real-5')!;
    const pFrame = hz.frames.find((f) => f.id === 'real-6')!;
    expect(rFrame.ok).toBe(true);
    expect((rFrame.result as unknown[]).length).toBeGreaterThan(0);
    expect(pFrame.ok).toBe(true);
    expect(Array.isArray(pFrame.result)).toBe(true);
    off();
  });

  it('⑤ 六种 method 分派到 registry 对应方法，ok 帧带回结果（含参数别名）', async () => {
    const { registry, calls } = makeRegistry();
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;

    const events = [
      evt('m1', 'tools/list'),
      evt('m2', 'tools/call', { name: 't', arguments: { a: 1 } }),
      evt('m3', 'resources/list'),
      evt('m4', 'resources/read', { uri: 'kojo://project/commands' }),
      evt('m5', 'prompts/list'),
      evt('m6', 'prompts/get', { name: 'p', arguments: { x: 2 } }),
      evt('m7', 'tools/call', { tool: 't2', args: { b: 2 } }),
    ];
    for (const e of events) hz.emit(e);
    await hz.waitFor(events.length);

    expect(hz.frames.filter((f) => f.ok)).toHaveLength(events.length);
    expect(calls.map((c) => c.method)).toEqual([
      'listTools', 'callTool', 'listResources', 'readResource',
      'listPrompts', 'getPrompt', 'callTool',
    ]);
    expect(calls[0]!.args).toEqual([scope]);
    expect(calls[1]!.args).toEqual(['t', { a: 1 }, scope]);
    expect(calls[3]!.args).toEqual(['kojo://project/commands', scope]);
    expect(calls[5]!.args).toEqual(['p', { x: 2 }, scope]);
    expect(calls[6]!.args).toEqual(['t2', { b: 2 }, scope]);
    expect(hz.frames.find((f) => f.id === 'm1')!.result).toBe('listTools:ok');
    off();
  });

  it('⑤ 未知 method / 缺参 / registry 抛错 ⇒ 显式 {code,message} error 帧', async () => {
    const { registry } = makeRegistry({
      callTool: () => {
        throw new Error('boom');
      },
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;

    hz.emit(evt('e1', 'bogus' as McpMethod));
    hz.emit(evt('e2', 'tools/call'));
    hz.emit(evt('e3', 'resources/read'));
    hz.emit(evt('e4', 'prompts/get'));
    hz.emit(evt('e5', 'tools/call', { name: 'x' }));
    await hz.waitFor(5);

    const byId = new Map(hz.frames.map((f) => [f.id, f]));
    expect(byId.size).toBe(5);
    for (const f of hz.frames) {
      expect(f.ok).toBe(false);
      expect(f.error?.code).toBeTruthy();
      expect(f.error?.message).toBeTruthy();
    }
    expect(byId.get('e1')!.error?.code).toBe('mcp/method-not-found');
    expect(byId.get('e2')!.error?.code).toBe('mcp/invalid-params');
    expect(byId.get('e3')!.error?.code).toBe('mcp/invalid-params');
    expect(byId.get('e4')!.error?.code).toBe('mcp/invalid-params');
    expect(byId.get('e5')!.error?.message).toContain('boom');
    off();
  });

  it.each([
    ['NOT_WIRED', '能力未接线'],
    ['PERMISSION_DENIED', '特权工具未批准'],
    ['INVALID_ARGS', '入参不合法'],
    ['RESOURCE_UNAVAILABLE', '资源不可用'],
  ] as const)(
    '⑤b registry 结构化失败 %s ⇒ error.code 原样透传（不降级成 mcp/internal）',
    async (code, message) => {
      const { registry } = makeRegistry({
        callTool: () => {
          throw Object.assign(new Error(message), { code });
        },
      });
      const hz = createHarness();
      const off = registerMcpHostBridge({
        transport: hz.transport,
        registryFactory: () => registry,
        ...BASE_OPTIONS,
      });
      await hz.ready;
      hz.emit(evt('structured', 'tools/call', { name: 'x' }));
      await hz.waitFor(1);
      expect(hz.frames[0]!.ok).toBe(false);
      expect(hz.frames[0]!.error?.code).toBe(code);
      expect(hz.frames[0]!.error?.message).toBe(message);
      off();
    },
  );

  it('⑤b resources/read 的结构化失败同样原样透传（六种分派共用一条 catch）', async () => {
    const { registry } = makeRegistry({
      readResource: () => {
        throw Object.assign(new Error('数据源缺席'), { code: 'RESOURCE_UNAVAILABLE' });
      },
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;
    hz.emit(evt('structured-r', 'resources/read', { uri: 'kojo://project/snapshot' }));
    await hz.waitFor(1);
    expect(hz.frames[0]!.error?.code).toBe('RESOURCE_UNAVAILABLE');
    off();
  });

  it('⑤b 普通 Error / 不可信 code 形状 ⇒ 回落 mcp/internal（脏码不进审计）', async () => {
    const { registry } = makeRegistry({
      callTool: (name: string) => {
        throw Object.assign(new Error(name === 'dirty' ? 'dirty' : 'plain'), {
          ...(name === 'dirty' ? { code: 'BAD CODE\n注入' } : {}),
        });
      },
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;
    hz.emit(evt('plain', 'tools/call', { name: 'plain' }));
    hz.emit(evt('dirty', 'tools/call', { name: 'dirty' }));
    await hz.waitFor(2);
    const byId = new Map(hz.frames.map((f) => [f.id, f]));
    expect(byId.get('plain')!.error?.code).toBe('mcp/internal');
    expect(byId.get('dirty')!.error?.code).toBe('mcp/internal');
    expect(byId.get('dirty')!.error?.message).not.toContain('BAD CODE');
    off();
  });

  it('⑤ 超时 ⇒ 显式 mcp/timeout error 帧（不静默、不挂死）', async () => {
    const { registry } = makeRegistry({
      listTools: () => new Promise<never>(() => {}),
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
      timeoutMs: 15,
    });
    await hz.ready;
    hz.emit(evt('t1', 'tools/list'));
    await hz.waitFor(1);
    expect(hz.frames[0]!.ok).toBe(false);
    expect(hz.frames[0]!.error?.code).toBe('mcp/timeout');
    off();
  });

  it('⑤ 返回体积超上限 ⇒ 显式 mcp/response-too-large error 帧', async () => {
    const { registry } = makeRegistry({
      listTools: () => 'X'.repeat(100),
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
      maxResponseBytes: 10,
    });
    await hz.ready;
    hz.emit(evt('z1', 'tools/list'));
    await hz.waitFor(1);
    expect(hz.frames[0]!.ok).toBe(false);
    expect(hz.frames[0]!.error?.code).toBe('mcp/response-too-large');
    off();
  });

  it('⑤ cancelMcpRequest 命中后该请求不回帧（主动取消＝客户端已断流）', async () => {
    const { registry } = makeRegistry({
      listTools: () => new Promise<never>(() => {}),
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;
    hz.emit(evt('c1', 'tools/list'));
    expect(cancelMcpRequest('c1')).toBe(true);
    expect(cancelMcpRequest('does-not-exist')).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(hz.frames).toHaveLength(0);
    off();
  });

  it('⑤ cancelAllMcpRequests 取消全部在途请求并返回条数，均不回帧', async () => {
    const { registry } = makeRegistry({
      listTools: () => new Promise<never>(() => {}),
    });
    const hz = createHarness();
    const off = registerMcpHostBridge({
      transport: hz.transport,
      registryFactory: () => registry,
      ...BASE_OPTIONS,
    });
    await hz.ready;
    hz.emit(evt('a1', 'tools/list'));
    hz.emit(evt('a2', 'tools/list'));
    expect(cancelAllMcpRequests()).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(hz.frames).toHaveLength(0);
    off();
  });
});

/* --------------------------- 设置面板 --------------------------- */

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

/** 壳层传进设置页的缺省态（与 settings-panel-lazy-sections.test.ts 同口径）。 */
function panelProps(): SettingsPanelProps {
  return {
    onClose: noop,
    initialSection: 'general',
    commands: [],
    zen: false,
    zenLimitWidth: false,
    dispatch: noop,
    onResetLayout: noop,
    themePref: 'dark',
    motionPref: 'full',
    commitMotionPref: noop,
    panelVirtualize: true,
    glassTransparency: 15,
    sealed: true,
    nameColorOn: false,
    fontSize: 16,
    fontZoom: 0,
    quickSuggestionsOn: true,
    commitQuickSuggestions: noop,
    wordSuggestionsOn: true,
    commitWordSuggestions: noop,
    suggestDelay: 0,
    commitSuggestDelay: noop,
    inlineCompletionOn: true,
    commitInlineCompletion: noop,
    inlineMinShowDelay: 0,
    commitInlineMinShowDelay: noop,
    inlineMaxCandidates: 5,
    commitInlineMaxCandidates: noop,
    sugarViewOn: false,
    applySugarViewPref: noop,
    formatOnSave: false,
    commitFormatOnSave: noop,
    codeLensOn: false,
    commitCodeLens: noop,
    autosaveMode: 'off',
    directMode: false,
    marketSource: null,
    marketEndpointDraft: '',
    setMarketEndpointDraft: noop,
    saveMarketEndpoint: asyncNoop,
    resetMarketEndpoint: asyncNoop,
    appVersion: '0.0.0-test',
    updatePhase: { kind: 'idle' },
    updateStatusLine: null,
    runUpdateCheck: asyncNoop,
    installUpdate: asyncNoop,
    openUpdateDialog: noop,
  };
}

describe('⑥ SettingsPanel：isTauri 真 / 假两态下的节数', () => {
  it('isTauri() 假（浏览器调试壳 / 测试）⇒ 8 节，无 ai 节', () => {
    setTauri(false);
    const sections = SETTINGS_SECTIONS(panelProps());
    expect(sections).toHaveLength(8);
    expect(sections.find((s) => s.id === 'ai')).toBeUndefined();
  });

  it('isTauri() 真 ⇒ 追加第 9 节 ai（icon=wand、React.lazy + Suspense 可渲染）', () => {
    setTauri(true);
    const sections = SETTINGS_SECTIONS(panelProps());
    expect(sections).toHaveLength(9);
    const ai = sections.find((s) => s.id === 'ai')!;
    expect(ai).toBeDefined();
    expect(ai.label).toBe('AI 接入');
    expect(ai.icon).toBe('wand');
    const el = ai.render();
    expect(el).not.toBeNull();
    expect(isValidElement(el)).toBe(true);
    // Suspense 边界可渲染（React.lazy 未 resolve 时输出 fallback，不抛）
    const html = renderToString(el!);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('正在装载 AI 接入面板');
  });
});

/* --------------------------- AiAccessSection --------------------------- */

const batch: ApprovalBatch = {
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: ['/proj'],
  approvedTools: ['write_file'],
};

describe('⑦ AiAccessSection：4 个命令名 / 投影 / 失败不静默', () => {
  it('scope / audit / approve / revoke 命中且仅命中约定的 4 个命令名', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const runner: McpCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === MCP_SETTINGS_COMMANDS.auditQuery) return [];
      return { version: 1, sessions: [] };
    };
    await queryMcpScope(runner);
    await queryMcpAudit(runner, { clientId: 'c1', limit: 5 });
    await approveMcpSession(runner, batch);
    await revokeMcpSession(runner, 'c1');

    expect(calls.map((c) => c.cmd)).toEqual([
      'mcp_scope_query', 'mcp_audit_query', 'mcp_approve', 'mcp_revoke',
    ]);
    expect(calls[0]!.args).toBeUndefined();
    expect(calls[1]!.args).toEqual({ args: { limit: 5, clientId: 'c1' } });
    expect(calls[2]!.args).toEqual({
      args: {
        clientId: 'c1', tier: 'edit',
        approvedRoots: ['/proj'], approvedTools: ['write_file'],
      },
    });
    expect(calls[3]!.args).toEqual({ args: { clientId: 'c1' } });
    expect(MCP_SETTINGS_COMMANDS).toMatchObject({
      scopeQuery: 'mcp_scope_query',
      auditQuery: 'mcp_audit_query',
      approve: 'mcp_approve',
      revoke: 'mcp_revoke',
    });
  });

  it('投影纯函数如实映射，不发明字段、不吞撤销过的会话', () => {
    const state: McpScopeState = {
      version: 1,
      sessions: [
        { clientId: 'c1', tier: 'edit', approvedRoots: ['/p'], approvedTools: ['t'], createdAt: 'ts1' },
        { clientId: 'c2', tier: 'read', approvedRoots: [], approvedTools: [], createdAt: 'ts2', revokedAt: 'ts3' },
      ],
    };
    // 接入可见性批：授权台账不再硬编码 `connected: true`；连接态只认端点接入台账。
    expect(scopeStateToClients(state)).toEqual([
      { clientId: 'c1', tier: 'edit', connected: false },
    ]);
    expect(
      scopeStateToClients(state, [{ clientId: 'c1', ts: 'ts4', method: 'initialize' }]),
    ).toEqual([{ clientId: 'c1', tier: 'edit', connected: true }]);
    const ap = scopeStateToApproval(state);
    expect(ap.clientId).toBe('c1');
    expect(ap.roots).toEqual(['/p']);
    expect(ap.pending.length).toBeGreaterThan(0);
    expect(ap.pending.every((p) => p.tier === 'privileged')).toBe(true);
    expect(toAuditEntryView({
      ts: 't', clientId: 'c', tool: 'x', argsDigest: '{}', outcome: 'denied', note: 'n',
    })).toEqual({
      ts: 't', clientId: 'c', tool: 'x', argsDigest: '{}', outcome: 'denied', note: 'n',
    });
  });

  it('动作函数失败不吞错（重新抛出，交给 UI 显式显示）', async () => {
    const runner: McpCommandRunner = async () => {
      throw new Error('IPC down');
    };
    await expect(queryMcpScope(runner)).rejects.toThrow('IPC down');
    await expect(queryMcpAudit(runner)).rejects.toThrow('IPC down');
    await expect(approveMcpSession(runner, batch)).rejects.toThrow('IPC down');
    await expect(revokeMcpSession(runner, 'c1')).rejects.toThrow('IPC down');
  });

  it('组件挂载即查 scope/audit；读数失败把原因显示在页面上（不静默、不假装成功）', async () => {
    setTauri(false);
    const runner: McpCommandRunner = async () => {
      throw new Error('IPC down');
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(h(AiAccessSection, { runner, pollMs: 0 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('AI 接入（MCP Server）');
    expect(text).toContain('读取 mcp_scope_query / mcp_audit_query 失败');
    expect(text).toContain('IPC down');
    await act(async () => root.unmount());
    container.remove();
  });

  it('组件 approve / revoke 按钮走 mcp_approve / mcp_revoke（注入 runner 命中正确命令名）', async () => {
    setTauri(false);
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const state: McpScopeState = {
      version: 1,
      sessions: [
        { clientId: 'c1', tier: 'edit', approvedRoots: ['/proj'], approvedTools: [], createdAt: 'ts' },
      ],
    };
    const runner: McpCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === MCP_SETTINGS_COMMANDS.scopeQuery) return state;
      if (cmd === MCP_SETTINGS_COMMANDS.auditQuery) return [];
      return state;
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(h(AiAccessSection, { runner, pollMs: 0 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.some((c) => c.cmd === 'mcp_scope_query')).toBe(true);
    expect(calls.some((c) => c.cmd === 'mcp_audit_query')).toBe(true);

    // 撤销按钮：点击 ⇒ mcp_revoke（clientId 来自第四张表投影）。
    // UI-14（2026-11-07）把撤销做进已授权会话列表行、文案改人话「撤销」
    // （mcp_revoke 命令名收进 title）。本判据认 title 里的命令名而非按钮字面量：
    // 全页唯一含 mcp_revoke 的 title，不会误命中未来其它「撤销」类按钮（Lane A/C 共识）。
    const buttons = [...container.querySelectorAll('button')];
    const revokeBtn = buttons.find((b) => (b.getAttribute('title') ?? '').includes('mcp_revoke'));
    expect(revokeBtn, '应有撤销会话按钮').toBeDefined();
    await act(async () => {
      revokeBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toContainEqual({ cmd: 'mcp_revoke', args: { args: { clientId: 'c1' } } });

    // 批准按钮：先勾一项特权工具，再点「批准所选」⇒ mcp_approve
    // 注意：整节里 SettingsAi 还有一个「启用 MCP 服务」复选框（settings-ai.tsx），
    // 用 container 全局 querySelector('input[type="checkbox"]') 会先命中它，导致勾选的
    // 不是 ApprovalUi 的待批准项、chosen.length 仍为 0、按钮 disabled、mcp_approve 不触发。
    // 必须把查询收窄到 ApprovalUi 的 section[aria-label="MCP 会话授权"] 内。
    const approvalSection = container.querySelector('section[aria-label="MCP 会话授权"]');
    expect(approvalSection, '应有写前 diff / 批量审批面板').not.toBeNull();
    const checkbox = approvalSection!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox, '应有待批准工具复选框').not.toBeNull();
    await act(async () => {
      checkbox!.click();
    });
    const approveBtn = [...approvalSection!.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('批准所选'),
    );
    expect(approveBtn, '应有批准按钮').toBeDefined();
    await act(async () => {
      approveBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.some((c) => c.cmd === 'mcp_approve')).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });
});

/* --------------------- 语义 8 腿经真 registry（semanticService 装配路径） --------------------- */

describe('语义腿经真 registry：结构化失败端到端不洗码 / 只读透出', () => {
  // 纯注入（createMcpHostDeps + 真 @kojo/mcp-host registry），不经 registerMcpHostBridge
  // 模块状态，对首用例 ① 的初始态零影响。
  it('reader 抛 McpFailure(NOT_WIRED) ⇒ callTool 原样 NOT_WIRED（不被洗成 READ_FAILED / TOOL_EXECUTION_FAILED）；codeActions 只读列表原样透出', async () => {
    const service = createSemanticService({
      readers: {
        definitionAt: () => {
          throw new McpFailure('NOT_WIRED', '语义读数未接线：当前没有活动编辑器（不静默、不伪造读数）');
        },
        codeActionsAt: () => [
          { title: '快速修复', kind: 'quickfix', isPreferred: true, edit: { edits: [] } },
        ],
      },
    });
    const registry = createMcpCapabilityRegistry(createMcpHostDeps({ semanticService: service }));
    // 工具仍列出（能力可见），调用才显式报缺线——code 一路透传到客户端
    expect(registry.listTools(scope).some((t) => t.name === 'semantic.definitionAt')).toBe(true);
    await expect(
      registry.callTool('semantic.definitionAt', { line: 1, column: 1 }, scope),
    ).rejects.toMatchObject({ code: 'NOT_WIRED', message: expect.stringContaining('没有活动编辑器') });
    // codeActionsAt 只读透出：列表原样返回（服务面无 apply 通道，见 semantic-service 单测）
    const actions = await registry.callTool('semantic.codeActionsAt', { line: 2, column: 3 }, scope);
    expect(actions).toEqual([{ title: '快速修复', kind: 'quickfix', isPreferred: true, edit: { edits: [] } }]);
  });
});
