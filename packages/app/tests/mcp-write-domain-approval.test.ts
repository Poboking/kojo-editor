// @vitest-environment happy-dom
/**
 * 「写域多根」批准面判据（2026-11-06，用户已拍板 additive 方案）。
 *
 * 覆盖第四张表的**写域信任模型**变更，不碰盘、不启 GUI / Tauri / HTTP：
 *   ① buildApprovalBatch 只放行形状合法的 rootId；畸形 / 绝对路径一律剔除；
 *   ② 没勾候选根时批次形状一字不变（旧四键），默认拒绝面零变化；
 *   ③ approveArgs 只在真的勾了根时才 additive 带 approvedRootIds（camelCase、去重、再过形状闸）；
 *   ④ scopeStateToApproval 把第四张表 approvedRootIds 投影出来（批准落没落地看得见）；
 *   ⑤ workspaceRootIdCandidates 由只读真源算出稳定枚举标识（label 只展示，绝不作为落点）；
 *   ⑥ ApprovalUi 列出候选根、勾选后批次带精确列名、已批准徽标可见翻转。
 *
 * 安全边界：rootId 只是枚举标识；批准根 ≠ 放宽 approvedRoots 相对前缀 ≠ 绕过内核写允许域。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildApprovalBatch,
  isSafeRelativePath,
  ApprovalUi,
  type ApprovalBatch,
  type ApprovalItem,
} from '../src/mcp/approval-ui';
import {
  approveArgs,
  scopeStateToApproval,
  workspaceRootIdCandidates,
  type McpScopeState,
} from '../src/mcp/settings-ai';
import { isRootIdShape, rootIdOf } from '../src/mcp/workspace-root-id';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS_ROOT = 'D:\\author-workspace';
const OTHER_ROOT = 'D:\\another-workspace';
const WS_ID = rootIdOf(WS_ROOT);
const OTHER_ID = rootIdOf(OTHER_ROOT);

const tool: ApprovalItem = {
  name: 'fileTree.remove',
  tier: 'privileged',
  reason: '特权工具',
};

const mounted: Array<{ root: ReturnType<typeof createRoot>; box: HTMLDivElement }> = [];
afterEach(async () => {
  for (const { root, box } of mounted.splice(0)) {
    await act(async () => root.unmount());
    box.remove();
  }
  document.body.innerHTML = '';
});

async function mount(el: ReactElement): Promise<{
  box: HTMLDivElement;
  text: () => string;
  find: (sel: string) => Element | null;
  findAll: (sel: string) => Element[];
  click: (e: Element) => Promise<void>;
}> {
  const box = document.createElement('div');
  document.body.append(box);
  const root = createRoot(box);
  mounted.push({ root, box });
  await act(async () => root.render(el));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    box,
    text: () => box.textContent ?? '',
    find: (sel) => box.querySelector(sel),
    findAll: (sel) => [...box.querySelectorAll(sel)],
    click: async (e) => {
      await act(async () => (e as HTMLElement).click());
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    },
  };
}

describe('① 形状闸：rootId 只认枚举标识', () => {
  it('合法标识放行并去重；绝对路径 / 逃逸 / 脏值 / 空串一律剔除', () => {
    const batch = buildApprovalBatch('c1', 'edit', [tool], ['docs'], [
      WS_ID,
      WS_ID,
      'D:\\author-workspace',
      '../../etc',
      'ws:ZZZZZZZZ',
      '',
      OTHER_ID,
    ]);
    expect(batch.approvedRootIds).toEqual([WS_ID, OTHER_ID]);
    expect(batch.approvedRootIds!.every(isRootIdShape)).toBe(true);
    expect(batch.approvedTools).toEqual(['fileTree.remove']);
    expect(batch.tier).toBe('edit'); // 绝不靠抬会话档位放行
    expect(batch.approvedRoots).toEqual(['docs']);
  });

  it('approvedRoots 的既有形状闸不受影响（越界根仍剔除）', () => {
    expect(isSafeRelativePath('docs')).toBe(true);
    expect(isSafeRelativePath('/etc')).toBe(false);
    expect(buildApprovalBatch('c1', 'edit', [], ['docs', '/etc'], []).approvedRoots).toEqual(['docs']);
  });
});

describe('② 默认拒绝不变：没勾候选根时旧四键形状一字不变', () => {
  it.each([undefined, [], ['D:\\author-workspace', 'ws:ZZZZZZZZ']])('%s', (rootIds) => {
    const batch = buildApprovalBatch('c1', 'edit', [tool], ['docs'], rootIds);
    expect(Object.keys(batch).sort()).toEqual(
      ['approvedRoots', 'approvedTools', 'clientId', 'tier'].sort(),
    );
    expect(Object.keys(approveArgs(batch)).sort()).toEqual(
      ['approvedRoots', 'approvedTools', 'clientId', 'tier'].sort(),
    );
  });
});

describe('③ approveArgs：只在真的勾了根时 additive 带精确列名', () => {
  it('camelCase + 去重 + 二次形状闸（不被 UI 外的注入绕过）', () => {
    const args = approveArgs({
      clientId: 'c1',
      tier: 'edit',
      approvedRoots: ['docs'],
      approvedTools: ['fileTree.remove'],
      approvedRootIds: [WS_ID, WS_ID, 'C:/evil', 'ws:ABCDEFGH'],
    });
    expect(args['approvedRootIds']).toEqual([WS_ID]);
    expect(Object.keys(args).sort()).toEqual(
      ['approvedRootIds', 'approvedRoots', 'approvedTools', 'clientId', 'tier'].sort(),
    );
  });
});

describe('④ 第四张表投影：批准落没落地看得见', () => {
  const state: McpScopeState = {
    version: 1,
    sessions: [
      {
        clientId: 'c1', tier: 'edit', approvedRoots: ['docs'], approvedTools: ['fileTree.remove'],
        approvedRootIds: [WS_ID, WS_ID], createdAt: 't1',
      },
      {
        clientId: 'c2', tier: 'read', approvedRoots: [], approvedTools: [],
        approvedRootIds: [OTHER_ID], createdAt: 't2',
      },
      {
        clientId: 'c1', tier: 'edit', approvedRoots: [], approvedTools: [],
        approvedRootIds: ['ws:deadbeef'], createdAt: 't3', revokedAt: 't4',
      },
    ],
  };

  it('只回本会话、去重、排除撤销与其它 clientId；旧表缺席 ⇒ 空数组', () => {
    expect(scopeStateToApproval(state).approvedRootIds).toEqual([WS_ID]);
    const legacy: McpScopeState = {
      version: 1,
      sessions: [{ clientId: 'c1', tier: 'edit', approvedRoots: [], approvedTools: [], createdAt: 't' }],
    };
    expect(scopeStateToApproval(legacy).approvedRootIds).toEqual([]);
  });
});

describe('⑤ 只读真源 → 候选根（label 只展示）', () => {
  it('逐项算出稳定标识，同一根不随顺序漂移；脏读数如实得空表', () => {
    expect(workspaceRootIdCandidates([WS_ROOT, OTHER_ROOT])).toEqual([
      { id: WS_ID, label: WS_ROOT },
      { id: OTHER_ID, label: OTHER_ROOT },
    ]);
    expect(workspaceRootIdCandidates([OTHER_ROOT, WS_ROOT])[1]).toEqual({ id: WS_ID, label: WS_ROOT });
    expect(rootIdOf('D:/author-workspace')).toBe(WS_ID); // 分隔符归一
    expect(workspaceRootIdCandidates(null)).toEqual([]);
    expect(workspaceRootIdCandidates({ nope: 1 })).toEqual([]);
    expect(workspaceRootIdCandidates([WS_ROOT, 42, ''])).toEqual([{ id: WS_ID, label: WS_ROOT }]);
  });
});

describe('⑥ ApprovalUi：候选根可见、可勾、批次带精确列名', () => {
  const candidates = [
    { id: WS_ID, label: WS_ROOT },
    { id: OTHER_ID, label: OTHER_ROOT },
  ];

  it('不注入候选根 ⇒ 整块零渲染（旧消费方形状不变）', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: [tool],
      roots: ['docs'],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    expect(hz.find('section[aria-label="MCP 常驻可写根批准"]')).toBeNull();
    expect(hz.findAll('[data-root-id]')).toHaveLength(0);
    // 第一个 checkbox 仍是工具项（旧回归判据靠这个形状取工具勾选框）
    expect(hz.findAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it('勾选一个根 ⇒ 只把该精确标识写进 approvedRootIds，档位仍固定 edit', async () => {
    const batches: ApprovalBatch[] = [];
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: [tool],
      roots: ['docs'],
      before: '',
      after: '',
      candidateRootIds: candidates,
      approvedRootIds: [OTHER_ID],
      onApprove: (b) => batches.push(b),
    }));
    expect(hz.findAll('li[data-root-id]')).toHaveLength(2);
    expect(hz.find(`li[data-root-id="${OTHER_ID}"] [data-root-approved="true"]`)).not.toBeNull();
    expect(hz.find(`li[data-root-id="${WS_ID}"] [data-root-approved="true"]`)).toBeNull();
    // 工具清单在前 ⇒ 第一个 checkbox 还是工具项
    expect(hz.findAll('input[type="checkbox"]')[0]!.closest('li')!.getAttribute('data-tool'))
      .toBe('fileTree.remove');

    await hz.click(hz.find(`li[data-root-id="${WS_ID}"] input[type="checkbox"]`)!);
    const approveBtn = hz.findAll('button').find((b) => (b.textContent ?? '').includes('批准所选'))!;
    await hz.click(approveBtn);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.approvedRootIds).toEqual([WS_ID]);
    expect(batches[0]!.tier).toBe('edit');
    expect(batches[0]!.approvedTools).toEqual([]); // 只批根，不隐式批任何工具
  });

  it('枚举失败 ⇒ 显式上屏，不静默装作「没有候选根」', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: [tool],
      roots: [],
      before: '',
      after: '',
      rootEnumerationNote: '常驻可写根枚举失败：IPC boom',
      onApprove: () => {},
    }));
    expect(hz.find('[data-testid="mcp-root-enumeration-note"]')!.textContent).toContain('IPC boom');
  });
});
