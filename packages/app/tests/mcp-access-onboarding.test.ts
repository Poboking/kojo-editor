// @vitest-environment happy-dom
/**
 * MCP「接入可见性」批次判据先红（2026-11-06）。
 *
 * 审阅结论：设置页只有「管理台」，没有「客户端接入成功」这一刻的可靠 UI 信号；
 * 且三个读数语义被混成一个 `clients`：
 *   · `mcp_status().clients` 是**瞬时并发 TCP 连接数**（Connection: close 后即减）；
 *   · 「已连接客户端」列表来自第四张授权表，`scopeStateToClients` 硬编码 `connected:true`；
 *   · 生产 `AiAccessSection` 默认 `pollMs=0`，不订阅任何接入事件 ⇒ 界面不会自己变。
 *
 * 本文件钉四件新事（先红，实现见 src/mcp/settings-ai.tsx / audit-panel.tsx）：
 *   ① 三读数拆分 + 授权台账不再冒充连接态 + 新增「已授权待握手」态；
 *   ② 接入确认卡：发现文件真实路径 / 复制 / 打开所在目录 / 一键客户端配置（不含 token）；
 *   ③ 首次握手事件到达 ⇒ 自动刷新台账、屏上出现「已接入」、通知出声；
 *   ④ 审计视图不再丢 `sessionId` / `elapsedMs`。
 *
 * 所有 UI 判据走 happy-dom + 注入 `McpCommandRunner` / 动作 seam，不启 Tauri / HTTP / 真端点。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AiAccessSection,
  SettingsAi,
  classifyMcpPhase,
  clientConfigSnippet,
  formatAgeSeconds,
  formatRelativeTime,
  scopeStateToClients,
  splitClientId,
  queryMcpConnections,
  toAuditEntryView,
  type McpClientConnection,
  type McpCommandRunner,
  type McpScopeState,
} from '../src/mcp/settings-ai';
import { formatAuditEntry } from '../src/mcp/audit-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------- 渲染脚手架 ------------------------------- */

interface Harness {
  text: () => string;
  find: (sel: string) => Element | null;
  findAll: (sel: string) => Element[];
  click: (target: Element) => Promise<void>;
}

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  for (const { root, container } of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(el: ReactElement): Promise<Harness> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(el);
  });
  await flush();
  return {
    text: () => container.textContent ?? '',
    find: (sel) => container.querySelector(sel),
    findAll: (sel) => [...container.querySelectorAll(sel)],
    click: async (target) => {
      await act(async () => {
        (target as HTMLElement).click();
      });
      await flush();
    },
  };
}

function buttonByText(hz: Harness, label: string): Element {
  const btn = hz.findAll('button').find((b) => (b.textContent ?? '').trim() === label);
  expect(btn, `应有按钮「${label}」`).toBeDefined();
  return btn!;
}

/* ------------------------------ 假运行时 ------------------------------ */

const DISCOVERY = 'C:\\Users\\me\\AppData\\Roaming\\dev.kojo.editor\\mcp-endpoint.json';
const HANDSHAKE: McpClientConnection = {
  clientId: 'harness-a',
  ts: '2026-11-06T10:00:00.000Z',
  method: 'initialize',
};

interface Runtime {
  calls: { cmd: string; args?: Record<string, unknown> }[];
  runner: McpCommandRunner;
  connections: McpClientConnection[];
}

function makeRuntime(opts: { connections?: McpClientConnection[]; enabled?: boolean } = {}): Runtime {
  const enabled = opts.enabled ?? true;
  const connections = opts.connections ?? [];
  const calls: Runtime['calls'] = [];
  const scope: McpScopeState = {
    version: 1,
    sessions: [
      {
        clientId: 'harness-a',
        tier: 'edit',
        approvedRoots: [],
        approvedTools: [],
        createdAt: '2026-11-06T09:00:00.000Z',
      },
    ],
  };
  const runner: McpCommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'mcp_status':
        return {
          enabled,
          port: enabled ? 7011 : null,
          clients: 0,
          connections: connections.length,
          authorizedSessions: scope.sessions.length,
          discoveryPath: enabled ? DISCOVERY : '',
          endpoint: enabled ? 'http://127.0.0.1:7011/mcp' : '',
        };
      case 'mcp_scope_query':
        return scope;
      case 'mcp_audit_query':
        return [];
      case 'mcp_connections_query':
        return connections;
      case 'workspace_roots':
        return [];
      default:
        return null;
    }
  };
  return { calls, runner, connections };
}

/* -------------------- ① 状态语义：三读数与连接态 -------------------- */

describe('状态语义纠偏', () => {
  const scope: McpScopeState = {
    version: 1,
    sessions: [
      {
        clientId: 'harness-a',
        tier: 'edit',
        approvedRoots: [],
        approvedTools: [],
        createdAt: '2026-11-06T09:00:00.000Z',
      },
      {
        clientId: 'revoked-b',
        tier: 'read',
        approvedRoots: [],
        approvedTools: [],
        createdAt: '2026-11-06T09:00:00.000Z',
        revokedAt: '2026-11-06T09:30:00.000Z',
      },
    ],
  };

  it('授权台账不得硬编码 connected:true；只有命中握手台账才是已连接', () => {
    expect(scopeStateToClients(scope).map((c) => c.connected)).toEqual([false]);
    expect(scopeStateToClients(scope, [HANDSHAKE]).map((c) => c.connected)).toEqual([true]);
    // 撤销过的会话不该被「接入」重新点亮
    expect(scopeStateToClients(scope, [HANDSHAKE, { ...HANDSHAKE, clientId: 'revoked-b' }])).toHaveLength(1);
  });

  it('classifyMcpPhase 区分「已授权待握手」与「已握手」，旧形状仍兼容', () => {
    expect(classifyMcpPhase({ enabled: false, port: null, clients: 0 })).toBe('stopped');
    expect(
      classifyMcpPhase({ enabled: true, port: 7011, clients: 0, connections: 0, authorizedSessions: 1 }),
    ).toBe('awaiting');
    expect(
      classifyMcpPhase({ enabled: true, port: 7011, clients: 0, connections: 1, authorizedSessions: 1 }),
    ).toBe('running');
    expect(
      classifyMcpPhase({ enabled: true, port: 7011, clients: 0, connections: 0, authorizedSessions: 0 }),
    ).toBe('unauthorized');
    // 旧响应（无 additive 字段）保持旧口径，不让旧消费方一夜变红
    expect(classifyMcpPhase({ enabled: true, port: 7011, clients: 1 })).toBe('running');
    expect(classifyMcpPhase({ enabled: true, port: 7011, clients: 0 })).toBe('unauthorized');
  });

  it('屏上把三个读数分开命名，不再把并发连接数叫「已连接客户端」', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    const metrics = hz.findAll('.settings-ai-metric');
    expect(metrics).toHaveLength(3);
    const labels = metrics.map((m) => m.textContent ?? '').join('|');
    expect(labels).toContain('瞬时并发连接');
    expect(labels).toContain('已授权会话');
    expect(labels).toContain('已握手客户端');
    expect(hz.text()).not.toContain('已连接客户端（0）');
  });

  it('已授权但还没握手时显示「等待首次握手」，不是「运行中」', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    expect(hz.find('.settings-ai-status--awaiting')).not.toBeNull();
    expect(hz.text()).toContain('等待首次握手');
  });
});

/* -------------------- ② 接入确认卡与接入引导 -------------------- */

describe('接入确认卡', () => {
  it('显示发现文件真实路径、三步引导与三个可操作按钮', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    const card = hz.find('.settings-ai-onboard');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(DISCOVERY);
    expect(card!.textContent).toContain('stdio shim');
    expect(card!.textContent).toContain('首次握手');
    for (const label of ['复制路径', '打开所在目录', '复制客户端配置']) {
      expect(hz.findAll('button').some((b) => (b.textContent ?? '').trim() === label), `缺按钮「${label}」`).toBe(true);
    }
  });

  it('复制路径 / 打开所在目录都带真实路径，且不把 token 带进动作', async () => {
    const rt = makeRuntime();
    const onCopy = vi.fn();
    const onReveal = vi.fn();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0, onCopy, onReveal }));
    await hz.click(buttonByText(hz, '复制路径'));
    expect(onCopy).toHaveBeenCalledWith(DISCOVERY);
    await hz.click(buttonByText(hz, '打开所在目录'));
    expect(onReveal).toHaveBeenCalledWith(DISCOVERY);
    expect(JSON.stringify(onCopy.mock.calls) + JSON.stringify(onReveal.mock.calls)).not.toContain('tok-');
  });

  it('一键生成的客户端配置不含 token / 端口，只指向 stdio shim', async () => {
    const snippet = clientConfigSnippet();
    expect(snippet).toContain('"mcpServers"');
    expect(snippet).toContain('"node"');
    expect(snippet).toContain('tools/kojo-mcp.mjs');
    expect(snippet.toLowerCase()).not.toContain('token');
    expect(snippet).not.toContain('7011');
    expect(snippet).not.toContain('127.0.0.1');

    const rt = makeRuntime();
    const onCopy = vi.fn();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0, onCopy }));
    await hz.click(buttonByText(hz, '复制客户端配置'));
    expect(onCopy).toHaveBeenCalledWith(snippet);
  });

  it('已握手时在屏上正面确认「已接入」+ clientId', async () => {
    const rt = makeRuntime({ connections: [HANDSHAKE] });
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0, connections: [HANDSHAKE] }));
    const ok = hz.find('.settings-ai-onboard [role="status"]');
    expect(ok).not.toBeNull();
    expect(ok!.textContent).toContain('已接入');
    expect(ok!.textContent).toContain('harness-a');
  });
});

/* -------------------- ③ 接入事件：自动刷新 + 通知 -------------------- */

describe('首次握手事件', () => {
  it('queryMcpConnections 走的是 mcp_connections_query', async () => {
    const rt = makeRuntime({ connections: [HANDSHAKE] });
    const rows = await queryMcpConnections(rt.runner);
    expect(rows).toEqual([HANDSHAKE]);
    expect(rt.calls.map((c) => c.cmd)).toEqual(['mcp_connections_query']);
  });

  it('事件到达 ⇒ 重查台账、屏上出现「已接入」并出声通知', async () => {
    const rt = makeRuntime();
    let fire: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((handler: () => void) => {
      fire = handler;
      return unsubscribe;
    });
    const onNotify = vi.fn();
    const hz = await mount(
      h(AiAccessSection, {
        runner: rt.runner,
        pollMs: 0,
        subscribeClientConnected: subscribe,
        onNotify,
        onCopy: vi.fn(),
        onReveal: vi.fn(),
      }),
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(hz.text()).not.toContain('已接入');

    rt.connections.push(HANDSHAKE);
    const before = rt.calls.filter((c) => c.cmd === 'mcp_connections_query').length;
    await act(async () => {
      fire?.();
    });
    await flush();
    expect(rt.calls.filter((c) => c.cmd === 'mcp_connections_query').length).toBeGreaterThan(before);
    expect(hz.text()).toContain('已接入');
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(String(JSON.stringify(onNotify.mock.calls[0]?.[0] ?? {}))).toContain('已接入');
  });

  it('卸载时退订，不留悬挂订阅', async () => {
    const rt = makeRuntime();
    const unsubscribe = vi.fn();
    const hz = await mount(
      h(AiAccessSection, {
        runner: rt.runner,
        pollMs: 0,
        subscribeClientConnected: () => unsubscribe,
      }),
    );
    await act(async () => {
      mountedRoots.at(-1)?.root.unmount();
    });
    expect(unsubscribe).toHaveBeenCalled();
    expect(hz.findAll('button').length).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------- ④ 审计粒度不丢字段 -------------------- */

describe('审计视图粒度', () => {
  it('sessionId / elapsedMs 透传到视图与可读文本', () => {
    const view = toAuditEntryView({
      ts: '2026-11-06T10:00:00.000Z',
      clientId: 'harness-a',
      sessionId: 'sess-42',
      tool: 'fileTree.update',
      argsDigest: 'relPath:string',
      outcome: 'ok',
      elapsedMs: 12,
    });
    expect(view.sessionId).toBe('sess-42');
    expect(view.elapsedMs).toBe(12);
    expect(formatAuditEntry(view)).toContain('sess-42');
    expect(formatAuditEntry(view)).toContain('12ms');
  });

  it('旧条目没有 additive 字段时格式逐字不变', () => {
    const view = toAuditEntryView({
      ts: 'T',
      clientId: 'c',
      tool: 'x',
      argsDigest: 'd',
      outcome: 'ok',
    });
    expect(formatAuditEntry(view)).toBe('T c x [ok] d');
  });
});

/* ------------- ⑤ UI 修复批（2026-11-06 审查 UI-01/02/03/05/06/21/24） ------------- */

describe('UI 修复批', () => {
  it('① 停止态：不查台账、不出现「接入台账读取失败」警告（UI-01）', async () => {
    const rt = makeRuntime({ enabled: false });
    const hz = await mount(h(AiAccessSection, { runner: rt.runner, pollMs: 0 }));
    await flush();
    expect(hz.text()).not.toContain('接入台账读取失败');
    expect(rt.calls.some((c) => c.cmd === 'mcp_connections_query')).toBe(false);
  });

  it('② error 态：三张读数卡如实显示「—」，不把未知画成 0（UI-02）', async () => {
    const rt = makeRuntime();
    const failing: McpCommandRunner = async (cmd, args) => {
      if (cmd === 'mcp_status') throw new Error('boom: ipc down');
      return rt.runner(cmd, args);
    };
    const hz = await mount(h(SettingsAi, { runner: failing, pollMs: 0 }));
    const values = hz
      .findAll('.settings-ai-metric-value')
      .map((v) => (v.textContent ?? '').trim());
    expect(values).toEqual(['—', '—', '—']);
    expect(hz.findAll('.settings-ai-metric--unknown')).toHaveLength(3);
  });

  it('③ 跨多个轮询周期后操作回执仍在状态条上，不被 refresh 冲掉（UI-03）', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 30 }));
    const box = hz.find('input[type="checkbox"]') as HTMLInputElement;
    await hz.click(box);
    expect(hz.find('.settings-ai-status-detail')!.textContent).toContain('已关闭');
    // 至少跨两个 30ms 轮询周期：receipt 必须活着，detail 只在后台被轮询更新
    await act(async () => {
      await new Promise((r) => setTimeout(r, 90));
    });
    expect(hz.find('.settings-ai-status-detail')!.textContent).toContain('已关闭');
    expect(rt.calls.filter((c) => c.cmd === 'mcp_status').length).toBeGreaterThanOrEqual(2);
  });

  it('④ token 未显示但服务已启用：端点可见且可复制（UI-06）', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    expect(hz.text()).toContain('http://127.0.0.1:7011/mcp');
    expect(buttonByText(hz, '复制端点')).toBeDefined();
  });

  it('⑤ 复制按钮给出「已复制 ✓」反馈（UI-05）', async () => {
    const rt = makeRuntime();
    const onCopy = vi.fn();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0, onCopy }));
    await hz.click(buttonByText(hz, '复制路径'));
    expect(onCopy).toHaveBeenCalledWith(DISCOVERY);
    expect(hz.findAll('button').some((b) => (b.textContent ?? '').trim() === '已复制 ✓')).toBe(true);
  });

  it('纯函数：formatAgeSeconds / formatRelativeTime / splitClientId（UI-21 / UI-24）', () => {
    expect(formatAgeSeconds(0)).toBe('0 秒前');
    expect(formatAgeSeconds(59)).toBe('59 秒前');
    expect(formatAgeSeconds(60)).toBe('1 分钟前');
    expect(formatAgeSeconds(3600)).toBe('1 小时前');
    expect(formatRelativeTime(new Date(Date.now() - 30_000).toISOString())).toBe('刚刚');
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 分钟前');
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3 小时前');
    expect(formatRelativeTime('not-a-date')).toBe('not-a-date');
    expect(splitClientId('codex-cli@3f2a19c8')).toEqual({ name: 'codex-cli', hash: '3f2a19c8' });
    expect(splitClientId('harness-a')).toEqual({ name: 'harness-a', hash: '' });
  });

  it('徽标短态：徽标只留两三个字，完整状态句保留在状态条（UI-27）', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    const badge = hz.find('.settings-ai-badge');
    expect((badge!.textContent ?? '').trim()).toBe('待握手');
    expect(hz.find('.settings-ai-status-label')!.textContent).toContain('等待首次握手');
  });
});
