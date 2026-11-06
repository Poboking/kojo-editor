// @vitest-environment happy-dom
/**
 * MCP 审批 UI 回归钉（LaneE · 历史四案之一「轮换不换 token / 批准批不动特权工具」纵深）。
 *
 * 纯单测：happy-dom + 注入 `McpCommandRunner` 假实现，不启 GUI / Tauri / HTTP / 真运行时。
 * 「静默失效」靠**假 runner 的语义**抓，而不是只钉常量表：
 *   · 假运行时对 `mcp_start` 幂等（同一运行时重复 start 返旧 token），只有 `mcp_stop`
 *     之后首次 start 才铸新 token ⇒ 轮换若只调 start、或顺序反了、或没把新 token 写回
 *     state，UI 必显示旧 token，红；
 *   · 假 `mcp_approve` 返回**已更新**的 scope、`mcp_scope_query` 跟着返回它 ⇒ 批准若
 *     不刷 scope（只发命令不 setScope / 不 refresh），徽标 / 清单不翻转，红；
 *   · denied 条目混在 ok / filtered 里，选 denied 后若被过滤掉，屏上断言必红。
 *
 * 四组：① 轮换真换 token ② 批准真落 approvedTools ③ 三态可见 ④ 审计 denied 呈现。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AiAccessSection,
  SettingsAi,
  approveArgs,
  scopeStateToApproval,
  type McpCommandRunner,
  type McpScopeState,
} from '../src/mcp/settings-ai';
import {
  APPROVABLE_PRIVILEGED_TOOLS,
  ApprovalUi,
  type ApprovalBatch,
} from '../src/mcp/approval-ui';
import {
  AuditPanel,
  filterAuditEntries,
  formatAuditEntry,
  type AuditEntryView,
} from '../src/mcp/audit-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------- 渲染脚手架 ------------------------------- */

interface Harness {
  text: () => string;
  find: (sel: string) => Element | null;
  findAll: (sel: string) => Element[];
  click: (target: Element) => Promise<void>;
  changeSelect: (select: HTMLSelectElement, value: string) => Promise<void>;
}

const mountedRoots: Array<{
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
}> = [];

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
    changeSelect: async (select, value) => {
      await act(async () => {
        // 必须走原生 value setter：React 的 value tracker 挂在实例属性上，直接
        // `select.value =` 会被判成「没变」而把 onChange 去重吞掉。
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(select, value);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
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

/* ------------------- 假运行时：mcp_start 幂等，stop 后铸新 ------------------- */

interface StartResult {
  port: number;
  token: string;
  endpoint: string;
}

interface RuntimeHarness {
  calls: { cmd: string; args?: Record<string, unknown> }[];
  runner: McpCommandRunner;
  /** 每次「新运行时首次签发」铸出的 token，按序记录。 */
  tokens: string[];
}

/**
 * 关键：模拟 Rust 侧 `mcp_start` 对同一运行时的幂等性——运行时活着时重复 start 原样
 * 返回既有三元组（旧 token / 旧 port）；`mcp_stop` 收回运行时后首次 start 才铸新 token。
 * 于是「轮换只调 start」「start 在 stop 之前」「没把 start 返回值写回 state」都会让
 * UI 停在旧 token 上，下面的断言必然红（不是靠断言调用序列自证）。
 */
function makeRuntime(): RuntimeHarness {
  let alive = false;
  let port = 7000;
  let token = '';
  let serial = 0;
  const calls: RuntimeHarness['calls'] = [];
  const tokens: string[] = [];
  const runner: McpCommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'mcp_status') {
      return { enabled: alive, port: alive ? port : null, clients: alive ? 1 : 0 };
    }
    if (cmd === 'mcp_stop') {
      alive = false;
      return null;
    }
    if (cmd === 'mcp_start') {
      if (!alive) {
        serial += 1;
        token = `tok-${serial}-${'A'.repeat(8)}`;
        port = 7000 + serial;
        tokens.push(token);
        alive = true;
      }
      return { port, token, endpoint: `http://127.0.0.1:${port}/mcp` } satisfies StartResult;
    }
    return null;
  };
  return { calls, runner, tokens };
}

/* ================================================================== *
 * ① 轮换按钮真换 token
 * ================================================================== */

describe('① 轮换：先 stop 再 start、两步确认、新 token / 端点上屏', () => {
  it('轮换 → 确认 ⇒ stop 在 start 之前、UI 显示新 token 且端点刷新；取消不下发命令', async () => {
    const rt = makeRuntime();
    const hz = await mount(h(SettingsAi, { runner: rt.runner, pollMs: 0 }));
    expect(hz.text()).toContain('未启动');

    // 先经一次「启用」把 token 拿到手上（状态命令不回明文，只能由 mcp_start 返回）
    const toggle = hz.find('input[aria-label="启用 MCP 服务"]');
    expect(toggle, '应有启用 MCP 服务开关').not.toBeNull();
    await hz.click(toggle!);
    expect(hz.text()).toContain('运行中');
    const firstToken = rt.tokens[0]!;
    expect(hz.find('.settings-ai-endpoint')!.textContent).toContain('127.0.0.1:7001');

    await hz.click(buttonByText(hz, '显示'));
    expect(hz.find('.settings-ai-token code')!.textContent).toBe(firstToken);

    // 两步确认：点「轮换」只进入待确认，不下发任何 stop / start
    await hz.click(buttonByText(hz, '轮换'));
    expect(hz.text()).toContain('确认轮换');
    expect(rt.calls.filter((c) => c.cmd === 'mcp_stop')).toHaveLength(0);
    expect(rt.calls.filter((c) => c.cmd === 'mcp_start')).toHaveLength(1);

    // 「取消」撤销待确认，token 不变、命令数不变
    await hz.click(buttonByText(hz, '取消'));
    expect(hz.text()).not.toContain('确认轮换');
    expect(rt.calls.filter((c) => c.cmd === 'mcp_start')).toHaveLength(1);

    // 再点「轮换」→「确认轮换」⇒ 真正轮换
    await hz.click(buttonByText(hz, '轮换'));
    await hz.click(buttonByText(hz, '确认轮换'));

    const stops = rt.calls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.cmd === 'mcp_stop');
    const starts = rt.calls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.cmd === 'mcp_start');
    expect(stops).toHaveLength(1);
    expect(starts).toHaveLength(2);
    expect(stops[0]!.i).toBeLessThan(starts[1]!.i);

    // 铁律 4：新 token 真上屏（只调 start 的话假运行时返旧 token，这里必红）
    expect(rt.tokens).toHaveLength(2);
    await hz.click(buttonByText(hz, '显示'));
    const shown = hz.find('.settings-ai-token code')!.textContent ?? '';
    expect(shown).toBe(rt.tokens[1]!);
    expect(shown).not.toBe(firstToken);
    expect(hz.text()).toContain('token 已轮换');

    // 端点随之刷新（port 7001 → 7002）
    expect(hz.find('.settings-ai-endpoint')!.textContent).toContain('127.0.0.1:7002');
    expect(hz.text()).not.toContain('127.0.0.1:7001');
  });

  it('运行时契约：同一运行时二次 mcp_start 返旧 token（幂等），只有 stop 后才铸新', async () => {
    const rt = makeRuntime();
    const r1 = (await rt.runner('mcp_start', { enabled: true })) as StartResult;
    const r2 = (await rt.runner('mcp_start', { enabled: true })) as StartResult;
    expect(r2.token).toBe(r1.token);
    expect(r2.port).toBe(r1.port);
    expect(rt.tokens).toHaveLength(1);

    await rt.runner('mcp_stop');
    const r3 = (await rt.runner('mcp_start', { enabled: true })) as StartResult;
    expect(r3.token).not.toBe(r1.token);
    expect(rt.tokens).toHaveLength(2);
  });
});

/* ================================================================== *
 * ② 批准真落 approvedTools
 * ================================================================== */

describe('② 批准：scope 投影 / camelCase args / 真发给 runner / 徽标与清单翻转', () => {
  it('scopeStateToApproval 只回本会话 approvedTools（去重 / 不串 clientId / 排除撤销）；approveArgs 为 camelCase', () => {
    const state: McpScopeState = {
      version: 1,
      sessions: [
        {
          clientId: 'c1', tier: 'edit', approvedRoots: ['/proj'],
          approvedTools: ['fileTree.remove', 'fileTree.remove'], createdAt: 't1',
        },
        {
          clientId: 'c1', tier: 'edit', approvedRoots: [],
          approvedTools: ['fileTree.rename'], createdAt: 't2',
        },
        {
          clientId: 'c2', tier: 'read', approvedRoots: [],
          approvedTools: ['c2.only'], createdAt: 't3',
        },
        {
          clientId: 'c1', tier: 'edit', approvedRoots: [],
          approvedTools: ['revoked.tool'], createdAt: 't4', revokedAt: 't5',
        },
      ],
    };
    const ap = scopeStateToApproval(state);
    expect(ap.clientId).toBe('c1');
    expect(ap.approvedTools).toEqual(['fileTree.remove', 'fileTree.rename']);
    expect(ap.approvedTools).not.toContain('c2.only');
    expect(ap.approvedTools).not.toContain('revoked.tool');
    expect(ap.roots).toEqual(['/proj']);
    expect(ap.pending.map((p) => p.name)).toEqual([...APPROVABLE_PRIVILEGED_TOOLS]);

    const args = approveArgs({
      clientId: 'c1',
      tier: 'privileged',
      approvedRoots: ['/proj'],
      approvedTools: ['fileTree.remove'],
    });
    expect(args).toEqual({
      clientId: 'c1',
      tier: 'privileged',
      approvedRoots: ['/proj'],
      approvedTools: ['fileTree.remove'],
    });
    // 对齐 Rust ApproveArgs：键名逐字 camelCase，不出现 snake_case / 命令名口径
    expect(Object.keys(args).sort()).toEqual(
      ['approvedRoots', 'approvedTools', 'clientId', 'tier'].sort(),
    );
  });

  it('AiAccessSection.onApprove 真把批准发给 mcp_approve，且批准后徽标 / 清单翻转（不刷 scope 必红）', async () => {
    let state: McpScopeState = {
      version: 1,
      sessions: [
        {
          clientId: 'c1', tier: 'edit', approvedRoots: ['/proj'],
          approvedTools: [], createdAt: 't0',
        },
      ],
    };
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const runner: McpCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'mcp_scope_query') return state;
      if (cmd === 'mcp_audit_query') return [];
      if (cmd === 'mcp_approve') {
        const batch = (args as { args: ApprovalBatch }).args;
        state = {
          version: 1,
          sessions: [{ ...state.sessions[0]!, approvedTools: batch.approvedTools }],
        };
        return state;
      }
      // SettingsAi 的 mcp_status 等：给个 benign 读数，不参与本用例断言
      return state;
    };
    const hz = await mount(h(AiAccessSection, { runner, pollMs: 0 }));

    // 批准前：清单可见但为空，无「已批准」徽标
    expect(hz.find('[data-testid="mcp-approved-tools"]')!.textContent).toContain('（无）');
    expect(hz.findAll('[data-approved="true"]')).toHaveLength(0);

    const approvalSection = hz.find('section[aria-label="MCP 会话授权"]')!;
    const checkbox = approvalSection.querySelector('input[type="checkbox"]');
    expect(checkbox, '应有待批准工具复选框').not.toBeNull();
    await hz.click(checkbox!);
    const approveBtn = [...approvalSection.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('批准所选'),
    );
    expect(approveBtn, '应有批准所选按钮').toBeDefined();
    await hz.click(approveBtn!);

    // 真的把批准发给了 runner，且 args 含被批准的工具面名字（camelCase）
    const approveCall = calls.find((c) => c.cmd === 'mcp_approve');
    expect(approveCall, '应下发 mcp_approve').toBeDefined();
    const sent = (approveCall!.args as { args: ApprovalBatch }).args;
    // 这里勾的是第一个 checkbox ⇒ 对应名单第一项。B24 把 commands.run 置于表头，
    // 夹具改读真源而非硬编名字（口径不变：仍须真把被勾选的那一枚下发）。
    expect(sent.approvedTools).toContain(APPROVABLE_PRIVILEGED_TOOLS[0]!);
    expect(sent.clientId).toBe('c1');

    // 批准后：scope 刷新 ⇒ 清单与「已批准」徽标翻转（不刷 scope 则仍是「（无）」，红）
    expect(hz.find('[data-testid="mcp-approved-tools"]')!.textContent).toContain(APPROVABLE_PRIVILEGED_TOOLS[0]!);
    expect(hz.findAll('[data-approved="true"]').length).toBeGreaterThan(0);
    expect(hz.text()).toContain('已批准');
  });

  it('ApprovalUi 不注入 approvedTools 时零渲染（旧消费方形状不变）', async () => {
    const hz = await mount(
      h(ApprovalUi, {
        clientId: 'c1',
        pending: [{ name: 'fileTree.remove', tier: 'privileged' as const, reason: 'r' }],
        roots: [],
        before: '',
        after: '',
        onApprove: () => {},
      }),
    );
    expect(hz.find('[data-testid="mcp-approved-tools"]')).toBeNull();
    expect(hz.findAll('[data-approved="true"]')).toHaveLength(0);
    expect(hz.findAll('.mcp-approve-badge')).toHaveLength(0);
  });

  it('逐工具批准：可批准名单里每一枚特权工具各自可选中 → mcp_approve 真发全量 args → data-tool 徽标/清单逐项翻转', async () => {
    let state: McpScopeState = {
      version: 1,
      sessions: [
        {
          clientId: 'c1', tier: 'edit', approvedRoots: ['docs'],
          approvedTools: [], createdAt: 't0',
        },
      ],
    };
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const runner: McpCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'mcp_scope_query') return state;
      if (cmd === 'mcp_audit_query') return [];
      if (cmd === 'mcp_approve') {
        const batch = (args as { args: ApprovalBatch }).args;
        state = { version: 1, sessions: [{ ...state.sessions[0]!, approvedTools: batch.approvedTools }] };
        return state;
      }
      return state;
    };
    const hz = await mount(h(AiAccessSection, { runner, pollMs: 0 }));

    const approvalSection = hz.find('section[aria-label="MCP 会话授权"]')!;
    // 逐工具可见性：每个待批准项带 data-tool（= 工具面名字），与可批准名单**逐字同序**
    // （B4 批把启动器族列进同一张表 ⇒ 枚数会随名单涨，这里读真源不硬编；口径不变：一枚都不许漏）。
    const items = [...approvalSection.querySelectorAll('li[data-tool]')];
    expect(items.map((li) => li.getAttribute('data-tool'))).toEqual([
      ...APPROVABLE_PRIVILEGED_TOOLS,
    ]);
    // 逐项勾选：每个 li 内各有一个独立 checkbox，全部点。
    for (const li of items) {
      const box = li.querySelector('input[type="checkbox"]');
      expect(box, `应有 ${li.getAttribute('data-tool')} 的复选框`).not.toBeNull();
      await hz.click(box!);
    }
    const approveBtn = [...approvalSection.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('批准所选'),
    )!;
    await hz.click(approveBtn);

    // 真发 args：一次批准把名单里每一枚工具名都写进 approvedTools（camelCase、逐工具精确）。
    const approveCall = calls.find((c) => c.cmd === 'mcp_approve');
    expect(approveCall, '应下发 mcp_approve').toBeDefined();
    const sent = (approveCall!.args as { args: ApprovalBatch }).args;
    expect(sent.approvedTools).toEqual([...APPROVABLE_PRIVILEGED_TOOLS]);
    expect(sent.clientId).toBe('c1');
    expect(sent.approvedRoots).toContain('docs');
    expect(Object.keys(sent).sort()).toEqual(
      ['approvedRoots', 'approvedTools', 'clientId', 'tier'].sort(),
    );

    // 批准后翻转：清单含每一枚 + 每一枚各自「已批准」徽标按 data-tool 可见（不刷 scope 必红）。
    const list = hz.find('[data-testid="mcp-approved-tools"]')!.textContent ?? '';
    for (const name of APPROVABLE_PRIVILEGED_TOOLS) {
      expect(list).toContain(name);
      const li = approvalSection.querySelector(`li[data-tool="${name}"]`)!;
      expect(li.querySelector(`.mcp-approve-badge[data-tool="${name}"]`), `${name} 应有已批准徽标`).not.toBeNull();
    }
  });
});

/* ================================================================== *
 * ③ 三态可见
 * ================================================================== */

describe('③ 三态可见：stopped / unauthorized / error + 运行中 / 处理中', () => {
  it('stopped 未启动 / unauthorized 未授权 / running 运行中，屏上文案各自可辨', async () => {
    const cases: { status: Record<string, unknown>; label: string; absent: string[] }[] = [
      {
        status: { enabled: false, port: null, clients: 0 },
        label: '未启动', absent: ['未授权', '运行中'],
      },
      {
        status: { enabled: true, port: 7001, clients: 0 },
        label: '未授权', absent: ['运行中', '未启动'],
      },
      {
        status: { enabled: true, port: 7001, clients: 1 },
        label: '运行中', absent: ['未授权', '未启动'],
      },
    ];
    for (const c of cases) {
      const runner: McpCommandRunner = async (cmd) =>
        cmd === 'mcp_status' ? c.status : null;
      const hz = await mount(h(SettingsAi, { runner, pollMs: 0 }));
      expect(hz.find('.settings-ai-status-label')!.textContent).toContain(c.label);
      expect(hz.text()).toContain(c.label);
      for (const other of c.absent) {
        expect(hz.find('.settings-ai-status-label')!.textContent).not.toContain(other);
      }
    }
  });

  it('mcp_status 失败 ⇒ 「连接失败」+ 原错误文本上屏（不吞、不假装成功）', async () => {
    const runner: McpCommandRunner = async (cmd) => {
      if (cmd === 'mcp_status') throw new Error('IPC boom 42');
      return null;
    };
    const hz = await mount(h(SettingsAi, { runner, pollMs: 0 }));
    expect(hz.find('.settings-ai-status-label')!.textContent).toContain('连接失败');
    expect(hz.text()).toContain('读取 mcp_status 失败');
    expect(hz.text()).toContain('IPC boom 42');
    expect(hz.text()).not.toContain('运行中');
  });

  it('开启命令未决时屏上「处理中…」（不是静默卡住）', async () => {
    const runner: McpCommandRunner = async (cmd) => {
      if (cmd === 'mcp_status') return { enabled: false, port: null, clients: 0 };
      if (cmd === 'mcp_start') return new Promise<never>(() => {}); // 永不 resolve
      return null;
    };
    const hz = await mount(h(SettingsAi, { runner, pollMs: 0 }));
    expect(hz.text()).toContain('未启动');
    const toggle = hz.find('input[aria-label="启用 MCP 服务"]')!;
    await act(async () => {
      (toggle as HTMLElement).click();
    });
    expect(hz.find('.settings-ai-status-label')!.textContent).toContain('处理中');
  });
});

/* ================================================================== *
 * ④ 审计 denied 呈现
 * ================================================================== */

describe('④ 审计 denied 呈现 / cap / clientId', () => {
  const rows: AuditEntryView[] = [
    { ts: 't1', clientId: 'c1', tool: 'read_file', argsDigest: 'path:str(3)', outcome: 'ok' },
    { ts: 't2', clientId: 'c2', tool: 'export_file', argsDigest: 'name:str(4)', outcome: 'filtered' },
    {
      ts: 't3', clientId: 'c1', tool: 'fileTree.remove', argsDigest: 'path:str(9)',
      outcome: 'denied', note: '特权工具未批准',
    },
    { ts: 't4', clientId: 'c2', tool: 'launcher_start', argsDigest: '{}', outcome: 'denied' },
  ];

  it('formatAuditEntry 输出 [denied]，note / landedPath 不吞', () => {
    const text = formatAuditEntry(rows[2]!);
    expect(text).toContain('[denied]');
    expect(text).toContain('fileTree.remove');
    expect(text).toContain('特权工具未批准');
    expect(formatAuditEntry({ ...rows[2]!, landedPath: 'docs/a.txt' })).toContain('docs/a.txt');
  });

  it('filterAuditEntries：denied 可筛、cap 取尾部并夹到 [1,200]、clientId 精确匹配', () => {
    expect(filterAuditEntries(rows, 'denied', '', 200).map((r) => r.ts)).toEqual(['t3', 't4']);
    expect(filterAuditEntries(rows, 'denied', 'c2', 200).map((r) => r.ts)).toEqual(['t4']);
    expect(filterAuditEntries(rows, 'all', 'c1', 200).map((r) => r.ts)).toEqual(['t1', 't3']);
    expect(filterAuditEntries(rows, 'all', '', 0).map((r) => r.ts)).toEqual(['t4']); // 下限 1
    expect(filterAuditEntries(rows, 'all', '', 2).map((r) => r.ts)).toEqual(['t3', 't4']); // 尾部 2
    const many: AuditEntryView[] = Array.from({ length: 250 }, (_, i) => ({
      ...rows[0]!, ts: `n${i}`,
    }));
    const capped = filterAuditEntries(many, 'all', '', 99999); // 上限 200
    expect(capped).toHaveLength(200);
    expect(capped[0]!.ts).toBe('n50');
    expect(capped[199]!.ts).toBe('n249');
  });

  it('AuditPanel 选 outcome=denied ⇒ 屏上只剩被拒条目且含 [denied]（denied 被过滤掉必红）', async () => {
    const hz = await mount(h(AuditPanel, { entries: rows }));
    const select = hz.find('select[aria-label="按结果过滤审计条目"]') as HTMLSelectElement | null;
    expect(select, '应有结果过滤下拉').not.toBeNull();
    expect([...select!.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value)).toContain(
      'denied',
    );

    await hz.changeSelect(select!, 'denied');
    const lis = hz.findAll('[data-testid="mcp-audit-rows"] li');
    expect(lis).toHaveLength(2);
    for (const li of lis) expect(li.textContent).toContain('[denied]');
    expect(hz.text()).toContain('fileTree.remove');
    // UI-18：note 不再占第五列折行，全文留在行 title（悬浮可查），屏面不许再出现机制长句。
    expect(lis.some((li) => (li.getAttribute('title') ?? '').includes('特权工具未批准')),
      '拒绝原因应留在行 title').toBe(true);
    expect(hz.text()).not.toContain('特权工具未批准');
    // 选了 denied 就不该再有 ok / filtered 行（选项被删 / denied 被过滤都会让这里红）
    expect(hz.text()).not.toContain('[ok]');
    expect(hz.text()).not.toContain('[filtered]');
  });

  it('fileTree.rename 未批准调用 ⇒ 审计 [denied] 条目可见（note 不吞、不被过滤掉）', async () => {
    const renameDenied: AuditEntryView = {
      ts: 't5', clientId: 'c1', tool: 'fileTree.rename',
      argsDigest: 'from:str(9),to:str(9)', outcome: 'denied', note: '特权工具 fileTree.rename 未批准',
    };
    expect(formatAuditEntry(renameDenied)).toContain('[denied]');
    expect(formatAuditEntry(renameDenied)).toContain('fileTree.rename');
    expect(formatAuditEntry(renameDenied)).toContain('未批准');
    // 混进 ok 条目里选 denied，rename 的 denied 必须仍在屏上（被过滤掉必红）。
    const hz = await mount(h(AuditPanel, { entries: [rows[0]!, renameDenied] }));
    const select = hz.find('select[aria-label="按结果过滤审计条目"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    await hz.changeSelect(select!, 'denied');
    const lis = hz.findAll('[data-testid="mcp-audit-rows"] li');
    expect(lis).toHaveLength(1);
    expect(lis[0]!.textContent).toContain('[denied]');
    expect(hz.text()).toContain('fileTree.rename');
    // note 不吞但不上屏：完整拒绝原因在行 title，屏面五列保持干净（不折行、不挤列）。
    expect(lis[0]!.getAttribute('title')).toContain('未批准');
    expect(hz.text()).not.toContain('未批准');
    expect(hz.text()).not.toContain('[ok]');
  });
});
