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
  middleEllipsis,
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
  it('显示发现文件真实路径（中段省略 + 全文进 title）、三步人话引导与四个可操作按钮', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    const card = hz.find('.settings-ai-onboard');
    expect(card).not.toBeNull();
    // UI-26：长路径屏上只留「头 … 尾」，全文必须仍可经 title / 复制动作取回。
    const pathEl = card!.querySelector('.settings-ai-discovery-path');
    expect(pathEl, '发现文件路径胶囊应存在').not.toBeNull();
    expect(pathEl!.getAttribute('title')).toBe(DISCOVERY);
    const shown = pathEl!.textContent ?? '';
    expect(shown).toContain('…');
    expect(shown.length).toBeLessThanOrEqual(48); // 省略结果不许比上限还长
    expect(shown.startsWith(DISCOVERY.slice(0, 20))).toBe(true); // 头部与尾部都留得住
    expect(shown.endsWith(DISCOVERY.slice(-18))).toBe(true);
    expect(card!.textContent).not.toContain(DISCOVERY); // 屏面不许把长路径整条摊开
    // UI-20：屏面说人话「转发器」，stdio shim 这个术语只留在 title 里。
    const step2 = card!.querySelector('.settings-ai-onboard-steps li:nth-child(2)');
    expect(step2?.textContent).toContain('转发器');
    expect(step2?.textContent).toContain('node tools/kojo-mcp.mjs');
    expect(step2?.getAttribute('title')).toContain('stdio shim');
    expect(card!.textContent).not.toContain('stdio shim');
    expect(card!.textContent).toContain('首次握手');
    for (const label of ['复制路径', '打开所在目录', '复制客户端配置']) {
      expect(hz.findAll('button').some((b) => (b.textContent ?? '').trim() === label), `缺按钮「${label}」`).toBe(true);
    }
    // UI-06：端点与 token 解耦后的第四个复制动作也必须在页上（不在卡内）。
    expect(hz.findAll('button').some((b) => (b.textContent ?? '').includes('复制端点')), '缺「复制端点」').toBe(true);
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

  it('已握手时在屏上正面确认「已接入」+ 客户端名，且接入确认卡不抢 live region', async () => {
    const rt = makeRuntime({ connections: [HANDSHAKE] });
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0, connections: [HANDSHAKE] }));
    // UI-35：全页唯一播报通道是状态条；接入确认回执只是普通文本，不与状态条重复播报。
    const status = hz.find('.settings-ai-status[role="status"]');
    expect(status, '状态条应是唯一 live region').not.toBeNull();
    expect(hz.find('.settings-ai-onboard [role="status"]')).toBeNull();
    const ok = hz.find('.settings-ai-onboard-ok');
    expect(ok, '已接入应有正面回执').not.toBeNull();
    expect(ok!.textContent).toContain('已接入');
    expect(ok!.textContent).toContain(splitClientId(HANDSHAKE.clientId).name);
    // clientId 全文不丢：拆名后 hash / 完整串仍可经 title 追溯。
    expect(ok!.querySelector('[title]')?.getAttribute('title')).toBe(HANDSHAKE.clientId);
    // 两态互斥：已接入时三步教程必须消失。
    expect(hz.find('.settings-ai-onboard-steps')).toBeNull();
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

  it('路径中段省略是输出上限：短串原样、长串有界且保留头尾（UI-26）', () => {
    expect(middleEllipsis('short/path.json')).toBe('short/path.json');
    expect(middleEllipsis(DISCOVERY)).toContain('…');
    expect(middleEllipsis(DISCOVERY).length).toBeLessThanOrEqual(48);
    expect(middleEllipsis(DISCOVERY).startsWith(DISCOVERY.slice(0, 20))).toBe(true);
    expect(middleEllipsis(DISCOVERY).endsWith(DISCOVERY.slice(-18))).toBe(true);
    // max 是输出上限，不是只管触发的阈值：小上限的省略结果不许比原串还长。
    expect(middleEllipsis('abcdefgh', 6).length).toBeLessThanOrEqual(6);
    expect(middleEllipsis('abcdefgh', 6)).toContain('…');
  });

  it('页内分段导航：概览 / 授权 / 审计三段可点，无 scrollIntoView 也不炸（UI-19）', async () => {
    const hz = await mount(h(SettingsAi, { runner: makeRuntime().runner, pollMs: 0 }));
    const nav = hz.find('.mcp-subnav');
    expect(nav, '应有页内分段导航').not.toBeNull();
    const items = [...nav!.querySelectorAll('button')];
    expect(items.map((b) => (b.textContent ?? '').trim())).toEqual(['概览', '授权', '审计']);
    expect(items[0]!.className).toContain('on');
    // 内层组件只带「概览」段；授权 / 审计两段的锚挂在编排层 AiAccessSection，
    // 所以整页三段是否都落了地要挂真实入口验（点了不能滚向空气）。
    expect(hz.find('#mcp-sec-overview')).not.toBeNull();
    const outer = await mount(h(AiAccessSection, {
      runner: makeRuntime().runner, pollMs: 0, onCopy: vi.fn(), onReveal: vi.fn(),
    }));
    for (const id of ['mcp-sec-overview', 'mcp-sec-approval', 'mcp-sec-audit']) {
      expect(outer.find(`#${id}`), `整页分段 ${id} 应有真实锚点`).not.toBeNull();
    }
    // happy-dom 没有 scrollIntoView：点击只应切高亮，不许抛异常。
    await hz.click(items[1]!);
    expect(items[1]!.className).toContain('on');
    expect(items[0]!.className).not.toContain('on');
  });

  it('屏面说人话：读数卡不带黑话，技术口径只留在 title（UI-20）', async () => {
    const hz = await mount(h(SettingsAi, { runner: makeRuntime().runner, pollMs: 0 }));
    const metrics = hz.find('.settings-ai-metrics');
    expect(metrics).not.toBeNull();
    expect(metrics!.textContent).not.toContain('第四张表');
    expect(metrics!.textContent).not.toContain('clientId');
    expect(metrics!.textContent).toContain('人类批准过且未撤销的会话');
    expect(metrics!.textContent).toContain('本次运行真实连过端点的客户端');
    expect(metrics!.querySelector('.settings-ai-metric-label[title]')?.getAttribute('title'))
      .toContain('mcp_status.clients');
    expect(hz.find('.settings-ai-onboard-tag')!.textContent).toBe('接入状态');
  });
});

/* -------------------- ⑥ 收口批：状态去重 / 一主两辅 / 凭据重签 / 按钮档位 -------------------- */

describe('收口批（UI-10 / UI-11 / UI-22 / UI-23）', () => {
  it('状态条不再复读三张读数卡的数字，只补环境与下一步（UI-10）', async () => {
    const rt = makeRuntime({ connections: [HANDSHAKE] });
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    const detail = hz.find('.settings-ai-status-detail')?.textContent ?? '';
    expect(detail).toContain('7011'); // 端口是卡片里没有的事实
    expect(detail).toContain('客户端已连入'); // 已连入时给下一步，不再报数
    expect(detail).not.toContain('瞬时并发连接');
    expect(detail).not.toContain('已握手');
    expect(hz.find('.settings-ai-status-label')?.textContent).toContain('运行中');
  });

  it('读数一主两辅：已握手客户端是唯一大数，另两枚退成 chip（UI-11）', async () => {
    const hz = await mount(h(SettingsAi, { runner: makeRuntime().runner, pollMs: 0 }));
    const hero = hz.findAll('.settings-ai-metric--hero');
    expect(hero).toHaveLength(1);
    expect(hero[0]!.textContent).toContain('已握手客户端');
    expect(hz.findAll('.settings-ai-metric--chip')).toHaveLength(2);
    expect(hz.findAll('.settings-ai-metric')).toHaveLength(3); // 三读数一个不少
  });

  it('未启动时整块读数隐藏，首屏不再铺 0 / 0 / 0（UI-11）', async () => {
    const hz = await mount(h(SettingsAi, { runner: makeRuntime({ enabled: false }).runner, pollMs: 0 }));
    expect(hz.find('.settings-ai-badge')?.textContent).toContain('未启动');
    expect(hz.find('.settings-ai-metrics')).toBeNull();
    expect(hz.text()).not.toContain('瞬时并发连接');
  });

  it('刷新后 token 为空但服务仍在跑 ⇒「重新签发」不消失，且真能两步轮换（UI-22）', async () => {
    const rt = makeRuntime();
    // 状态命令不回明文；mcp_start 的返回值才是唯一明文来源。
    const runner: McpCommandRunner = async (cmd, args) => {
      if (cmd === 'mcp_start') {
        rt.calls.push({ cmd, args }); // 与 rt.runner 同一本流水账，轮换顺序才判得准
        return { port: 7011, token: 'tok-rotated', endpoint: 'http://127.0.0.1:7011/mcp' };
      }
      return rt.runner(cmd, args);
    };
    const hz = await mount(h(SettingsAi, { runner, pollMs: 0 }));
    expect(hz.find('.settings-ai-token-empty'), '状态命令不回明文').not.toBeNull();
    expect(hz.find('.settings-ai-endpoint'), '服务在跑就有端点').not.toBeNull();

    const btn = buttonByText(hz, '重新签发');
    expect(btn.getAttribute('title')).toContain('旧凭据立即失效');
    await hz.click(btn);
    expect(hz.text()).toContain('确认重新签发');
    expect(hz.text()).not.toContain('确认轮换');
    await hz.click(buttonByText(hz, '确认重新签发'));

    // 轮换 = 先 stop 收回 listener / 发现文件，再 start 首次签发新凭据（幂等 start 不会换 token）。
    const calls = rt.calls.map((c) => c.cmd);
    expect(calls.indexOf('mcp_stop')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('mcp_stop')).toBeLessThan(calls.indexOf('mcp_start'));
    await hz.click(buttonByText(hz, '显示'));
    expect(hz.find('.settings-ai-token code')?.textContent).toBe('tok-rotated');
    expect(hz.find('.settings-ai-status-detail')?.textContent).toContain('token 已轮换');
  });

  it('按钮三档统一：主档 / 次档 / 危险档各归其位，图标随文案（UI-23）', async () => {
    const hz = await mount(h(SettingsAi, { runner: makeRuntime().runner, pollMs: 0 }));
    const primary = buttonByText(hz, '复制客户端配置');
    expect(primary.className).toContain('mcp-btn-primary');
    expect(primary.querySelector('svg.icon')).not.toBeNull();
    for (const label of ['复制路径', '打开所在目录']) {
      expect(buttonByText(hz, label).className).toContain('mcp-btn-secondary');
    }
    expect(hz.find('.settings-ai-status-age svg.icon'), '刷新胶囊也带图标').not.toBeNull();

    const outer = await mount(h(AiAccessSection, {
      runner: makeRuntime().runner, pollMs: 0, onCopy: vi.fn(), onReveal: vi.fn(),
    }));
    expect(outer.find('.mcp-btn-danger'), '撤销会话走危险档').not.toBeNull();
  });
});
