// @vitest-environment happy-dom
/**
 * 「让 Agent 自由使用编辑器全部能力」的可达性判据（2026-11-06）。
 *
 * 三条硬阻塞，先钉红再动实现：
 *   ① 第四张表批准面只有两枚硬编码 privileged 具名工具，命令面板 61 条动作
 *      虽已注册成工具却根本列不进设置页 ⇒ 人无法批准 ⇒ 等于永久不可达；
 *   ② 没有「全选」形态，逐项勾选几十条不具备可操作性；
 *   ③ 命令面板动作 `run` 返回 void，`callTool` 原样回 undefined ⇒ fire-and-forget
 *      被当成成功，违反铁律 4「内核不静默 / inactive 必须可见」。
 *
 * 本文件只钉**可达性与诚实性**，不放宽任何默认权限：privileged 仍默认缺席、
 * 仍要求 approvedTools 精确列名、Rust 端点二次分级不采信 WebView 回帧。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createMcpCapabilityRegistry, type McpSessionScope } from '@kojo/mcp-host';
import { scopeStateToApproval, type McpScopeState } from '../src/mcp/settings-ai';
import {
  ApprovalUi,
  APPROVABLE_PRIVILEGED_TOOLS,
  type ApprovalBatch,
  type ApprovalItem,
} from '../src/mcp/approval-ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mount(el: ReactElement): Promise<{
  text: () => string;
  findAll: (sel: string) => Element[];
  click: (target: Element) => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    text: () => container.textContent ?? '',
    findAll: (sel) => [...container.querySelectorAll(sel)],
    click: async (target) => {
      await act(async () => {
        (target as HTMLElement).click();
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

/** 命令面板动作候选（真实注册表里的命名空间形状，非编造的工具名）。 */
const PANEL_CANDIDATES: readonly string[] = [
  'workbench.saveAll',
  'workbench.openProjectFolder',
  'launcher.openInstances',
  'editor.action.formatDocument',
  'layout.toggleSidebar',
  'fileTree.remove',
  'fileTree.rename',
];

function scopeState(): McpScopeState {
  return {
    version: 1,
    sessions: [
      {
        clientId: 'agent-local',
        tier: 'privileged',
        approvedRoots: [],
        approvedTools: [],
        createdAt: '2026-11-06T00:00:00.000Z',
      },
    ],
  } as McpScopeState;
}

describe('① 批准面真源驱动：命令面板动作必须列得出来', () => {
  it('传入候选工具全集 ⇒ pending ＝静态具名名单 ∪ 运行时候选（一枚不漏）', () => {
    const out = scopeStateToApproval(scopeState(), { candidateTools: PANEL_CANDIDATES });
    // 静态名单是漂移闸对拍的真源（B4 后含启动器族 27 枚，不是写死的两枚）；
    // 顺序无语义，按集合对拍，且不许漏项 / 多项。
    const want = [...new Set([...APPROVABLE_PRIVILEGED_TOOLS, ...PANEL_CANDIDATES])].sort();
    expect([...out.pending.map((p) => p.name)].sort()).toEqual(want);
    for (const p of out.pending) expect(p.tier).toBe('privileged');
    for (const name of PANEL_CANDIDATES) {
      expect(out.pending.some((p) => p.name === name), `${name} 必须列得出来`).toBe(true);
    }
  });

  it('不传候选时保持旧形状（additive，旧消费方零改动）', () => {
    const out = scopeStateToApproval(scopeState());
    // 读真源而非写死枚举：名单随 B4 / 后续批次扩容，判据口径仍是「一枚都不许漏」。
    expect([...out.pending.map((p) => p.name)].sort()).toEqual(
      [...APPROVABLE_PRIVILEGED_TOOLS].sort(),
    );
    expect(out.pending.some((p) => p.name === 'workbench.saveAll')).toBe(false);
  });
});

describe('② 一键批准全集：勾选动作可一次性覆盖全部候选', () => {
  it('「全选」后批准 ⇒ approvedTools 逐项精确列名，会话档位不放宽', async () => {
    const pending: ApprovalItem[] = PANEL_CANDIDATES.map((name) => ({
      name,
      tier: 'privileged',
      reason: 'fixture',
    }));
    let batch: ApprovalBatch | null = null;
    const hz = await mount(
      h(ApprovalUi, {
        clientId: 'agent-local',
        pending,
        roots: [],
        before: '',
        after: '',
        onApprove: (b: ApprovalBatch) => {
          batch = b;
        },
      }),
    );
    const all = hz.findAll('button').find((b) => (b.textContent ?? '').includes('全选'));
    expect(all, '应有「全选」按钮').toBeDefined();
    await hz.click(all!);
    const approve = hz.findAll('button').find((b) => (b.textContent ?? '').includes('批准所选'));
    expect(approve, '应有「批准所选」按钮').toBeDefined();
    await hz.click(approve!);
    expect(batch, '全选后应能下发一次批量审批').not.toBeNull();
    expect(batch!.approvedTools).toEqual([...PANEL_CANDIDATES]);
    // 会话档位不因「批准了特权工具」被抬高：privileged 一律按工具名精确授权，
    // 绝不变成「整个会话升档 ⇒ 其它特权工具顺带可见」的后门。
    expect(batch!.tier).toBe('edit');
  });
});

describe('③ 命令执行诚实回执：fire-and-forget 不许冒充成功', () => {
  const scope: McpSessionScope = {
    sessionId: 's1',
    clientId: 'agent-local',
    tier: 'privileged',
    approvedRoots: [],
    approvedTools: ['workbench.saveAll'],
  };

  it('run 返回 void ⇒ 回执显式 dispatched / confirmed:false / 有原因', async () => {
    const reg = createMcpCapabilityRegistry({
      commands: [
        {
          id: 'workbench.saveAll',
          title: '全部保存',
          tier: 'privileged',
          run: () => undefined,
        },
      ],
    });
    const out = await reg.callTool('workbench.saveAll', {}, scope);
    expect(out).toMatchObject({ dispatched: true, confirmed: false });
    expect((out as { notice?: string }).notice).toMatch(/无落地确认|fire-and-forget|不可据此判定/);
  });

  it('run 有真实返回值 ⇒ 原样透出，不套回执壳（旧契约零改动）', async () => {
    const reg = createMcpCapabilityRegistry({
      commands: [
        {
          id: 'workbench.saveAll',
          title: '全部保存',
          tier: 'privileged',
          run: () => ({ saved: 3 }),
        },
      ],
    });
    expect(await reg.callTool('workbench.saveAll', {}, scope)).toEqual({ saved: 3 });
  });
});
