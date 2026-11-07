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
 *   ⑥ ApprovalUi 列出候选根、勾选后批次带精确列名、已批准徽标可见翻转；
 *   ⑦ toolFamily / TOOL_DESCRIPTIONS：29 枚可批准工具族归属正确、描述表与名单一一对应
 *      （漂移闸：工具面增删而描述表没跟上 ⇒ 红）；
 *   ⑧ 分组形状：li[data-tool] DOM 顺序与 APPROVABLE_PRIVILEGED_TOOLS 逐字同序、
 *      首个 checkbox 仍是工具项、组级勾选只动本族（mcp-free-access 的「全选」锚不破）；
 *   ⑨ 无会话锁定（UI-15）：clientId 为空 ⇒ 无清单 / 无全选 / 无 CTA，只留引导；
 *      空 diff（UI-07）不再渲染空 pre；
 *   ⑩ 审计面板（UI-04/18/29 + 实拍收尾）：客户端过滤走 kit 检索框、行结构化（时间短格式
 *      MM-DD HH:mm:ss、note/完整 ISO 收 title 不上屏、缺项格显 — 不塌列）、两种空态可区分、
 *      清空筛选恢复全量；
 *   ⑪ 屏面去黑话与按钮档位（UI-20/23）：条目屏面无 privileged 档位字样（title 里有）、
 *      只读/可写盘小字标、「已批准工具」不带黑话括注、root hint 人话化、批准所选挂主档。
 *
 * 安全边界：rootId 只是枚举标识；批准根 ≠ 放宽 approvedRoots 相对前缀 ≠ 绕过内核写允许域。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APPROVABLE_PRIVILEGED_TOOLS,
  ApprovalUi,
  buildApprovalBatch,
  isSafeRelativePath,
  TOOL_DESCRIPTIONS,
  toolFamily,
  type ApprovalBatch,
  type ApprovalItem,
} from '../src/mcp/approval-ui';
import { AuditPanel, formatAuditTime, type AuditEntryView } from '../src/mcp/audit-panel';
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
  type: (input: Element, value: string) => Promise<void>;
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
    type: async (input, value) => {
      await act(async () => {
        // 走原生 value setter：React 的 value tracker 会把直接赋值判成「没变」而吞掉 onChange。
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
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
    const note = hz.find('[data-testid="mcp-root-enumeration-note"]')!;
    expect(note.textContent).toContain('IPC boom');
    // UI-35：全页唯一 role="status" 是状态条；这里的静态警告只走 aria-live，不抢播报。
    expect(note.getAttribute('role')).toBeNull();
    expect(note.getAttribute('aria-live')).toBe('polite');
  });
});

describe('⑦ toolFamily / TOOL_DESCRIPTIONS：族归属与描述表漂移闸', () => {
  it('29 枚可批准工具族归属正确；点号形态与命令面板动作落 other', () => {
    for (const name of APPROVABLE_PRIVILEGED_TOOLS) {
      const expected = name.startsWith('fileTree.')
        ? 'fileTree'
        : name.startsWith('launcher_')
          ? (LAUNCHER_READ_SET.has(name) ? 'launcherRead' : 'launcherWrite')
          : 'other';
      expect(toolFamily(name), `${name} 应归 ${expected}`).toBe(expected);
    }
    // 非启动器族 / 点号形态不算 launcher_（与 Rust is_launcher_tool 前缀口径同尺）
    expect(toolFamily('launcher.openInstances')).toBe('other');
    expect(toolFamily('workbench.saveAll')).toBe('other');
    expect(toolFamily('read_file')).toBe('other');
  });

  it('TOOL_DESCRIPTIONS 与可批准名单一一对应，每条 ≤20 字非空（真实功能，不编造）', () => {
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual([...APPROVABLE_PRIVILEGED_TOOLS].sort());
    for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(desc.length, `${name} 描述超长`).toBeLessThanOrEqual(20);
      expect(desc.trim().length).toBeGreaterThan(0);
    }
    // 抽查三条关键语义：删除是删除、启动是启动、实例清点是清点（防复制粘贴式描述）
    expect(TOOL_DESCRIPTIONS['fileTree.remove']).toContain('删除');
    expect(TOOL_DESCRIPTIONS['launcher_start']).toContain('启动');
    expect(TOOL_DESCRIPTIONS['launcher_instance_list']).toContain('列出');
  });
});

describe('⑧ 分组形状：锚点不破、组级勾选只动本族', () => {
  const pendingOf = (names: readonly string[]): ApprovalItem[] =>
    names.map((name) => ({ name, tier: 'privileged' as const, reason: '特权工具' }));

  it('静态全量名单 ⇒ li[data-tool] DOM 顺序与 APPROVABLE_PRIVILEGED_TOOLS 逐字同序，首个 checkbox 仍是工具项', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(APPROVABLE_PRIVILEGED_TOOLS),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    const items = hz.findAll('li[data-tool]');
    expect(items.map((li) => li.getAttribute('data-tool'))).toEqual([...APPROVABLE_PRIVILEGED_TOOLS]);
    expect(
      hz.findAll('input[type="checkbox"]')[0]!.closest('li')!.getAttribute('data-tool'),
    ).toBe('fileTree.remove');
    // 三族组头齐备，族序与名单同序
    expect(hz.findAll('section[data-family]').map((s) => s.getAttribute('data-family'))).toEqual([
      'fileTree',
      'launcherRead',
      'launcherWrite',
    ]);
    // 全局「全选（N）」保留（mcp-free-access 的锚：首个含「全选」的按钮必须全量勾选）
    expect(hz.text()).toContain('全选（29）');
    // 组级按钮措辞避开「全选」字样
    expect(hz.findAll('button').filter((b) => (b.textContent ?? '').includes('全选'))).toHaveLength(1);
  });

  it('混入运行时候选 ⇒ 按首次出现顺序归族（pending 序不重排）；组内条目保持出现顺序', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['workbench.saveAll', 'fileTree.remove', 'launcher_start']),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    expect(hz.findAll('section[data-family]').map((s) => s.getAttribute('data-family'))).toEqual([
      'other',
      'fileTree',
      'launcherWrite',
    ]);
    expect(hz.findAll('li[data-tool]').map((li) => li.getAttribute('data-tool'))).toEqual([
      'workbench.saveAll',
      'fileTree.remove',
      'launcher_start',
    ]);
  });

  it('勾选本组只选中本族（批量勾选 ≠ 放宽：仍逐项精确列名）；清空本组只清本族', async () => {
    const batches: ApprovalBatch[] = [];
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['fileTree.remove', 'fileTree.rename', 'launcher_start']),
      roots: [],
      before: '',
      after: '',
      onApprove: (b) => batches.push(b),
    }));
    // 启动器写组（1 枚）：勾选本组 ⇒ CTA 计数 1，且只含 launcher_start
    const writeGroup = hz.find('section[data-family="launcherWrite"]')!;
    await hz.click(
      [...writeGroup.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('勾选本组'))!,
    );
    expect(hz.text()).toContain('批准所选（1）');
    const approveBtn = hz.findAll('button').find((b) => (b.textContent ?? '').includes('批准所选'))!;
    await hz.click(approveBtn);
    expect(batches.at(-1)!.approvedTools).toEqual(['launcher_start']);
    // 文件树组（2 枚）：勾选本组 ⇒ 计数 3；清空本组 ⇒ 只清掉这 2 枚，launcher_start 仍选中
    const fileGroup = hz.find('section[data-family="fileTree"]')!;
    await hz.click(
      [...fileGroup.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('勾选本组'))!,
    );
    expect(hz.text()).toContain('批准所选（3）');
    await hz.click(
      [...fileGroup.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('清空本组'))!,
    );
    expect(hz.text()).toContain('批准所选（1）');
    expect(hz.findAll('input[type="checkbox"]')
      .filter((b) => (b as HTMLInputElement).checked)
      .map((b) => b.closest('li')!.getAttribute('data-tool'))).toEqual(['launcher_start']);
  });
});

describe('⑨ 无会话锁定与空 diff（UI-15 / UI-07）', () => {
  it('clientId 为空 ⇒ 无清单 / 无全选 / 无 CTA / 无 checkbox，只留引导与 h3', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: '',
      pending: pendingTools(),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    expect(hz.text()).toContain('一次批量审批'); // h3 保留
    expect(hz.text()).toContain('完成接入并出现会话后，这里会出现逐项批准清单');
    expect(hz.findAll('input[type="checkbox"]')).toHaveLength(0);
    expect(hz.findAll('button').some((b) => (b.textContent ?? '').includes('全选'))).toBe(false);
    expect(hz.findAll('button').some((b) => (b.textContent ?? '').includes('批准所选'))).toBe(false);
  });

  it('before / after 都为空 ⇒ 不渲染空 pre，渲染一行空态；有内容 ⇒ pre 照常', async () => {
    const empty = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingTools(),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    expect(empty.find('[data-testid="mcp-diff"]')).toBeNull();
    expect(empty.text()).toContain('当前没有挂起的写请求');

    const hasDiff = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingTools(),
      roots: [],
      before: 'a',
      after: 'b',
      onApprove: () => {},
    }));
    expect(hasDiff.find('pre[data-testid="mcp-diff"]')).not.toBeNull();
    expect(hasDiff.text()).not.toContain('当前没有挂起的写请求');
  });
});

/* ------------------------------- ⑩ 审计面板 ------------------------------- */

describe('⑩ AuditPanel：kit 过滤框 / 结构化行 / 空态分场景', () => {
  const row: AuditEntryView = {
    ts: '2026-11-06T10:00:00.000Z',
    clientId: 'c1',
    tool: 'fileTree.remove',
    argsDigest: 'relPath:str(9)',
    outcome: 'denied',
    landedPath: 'docs/a.txt',
    note: '特权工具未批准',
    sessionId: 'sess-7',
    elapsedMs: 12,
  };

  it('客户端过滤框走 kit 检索井：带 placeholder 与 aria-label，暗色下不再裸白', async () => {
    const hz = await mount(h(AuditPanel, { entries: [row] }));
    const input = hz.find('input[aria-label="按 clientId 过滤审计条目"]') as HTMLInputElement | null;
    expect(input, '应有按 clientId 过滤的检索框').not.toBeNull();
    expect(input!.placeholder).toBe('按 clientId 过滤');
    expect(input!.closest('.kit-search-field')).not.toBeNull();
  });

  it('行结构化：五列 span + data-outcome 锚不动；note/argsDigest/clientId/sessionId/完整 ISO 收进 title，note 不再上屏', async () => {
    const hz = await mount(h(AuditPanel, { entries: [row] }));
    const li = hz.find('[data-testid="mcp-audit-rows"] li')!;
    expect(li.getAttribute('data-outcome')).toBe('denied');
    expect(li.classList.contains('mcp-audit-row')).toBe(true);
    for (const part of ['time', 'tool', 'outcome', 'elapsed', 'path']) {
      expect(li.querySelector(`.mcp-audit-row-${part}`), `缺 mcp-audit-row-${part}`).not.toBeNull();
    }
    expect(li.querySelector('.mcp-audit-row-time')!.textContent).toBe('11-06 10:00:00');
    expect(li.querySelector('.mcp-audit-row-outcome')!.textContent).toBe('[denied]');
    expect(li.querySelector('.mcp-audit-row-elapsed')!.textContent).toBe('12ms');
    expect(li.querySelector('.mcp-audit-row-path')!.textContent).toContain('docs/a.txt');
    // note 不再占列宽（实拍红点：折行挤压第五列），全文进 title——不静默：悬浮可达
    expect(li.textContent).not.toContain('特权工具未批准');
    expect(li.getAttribute('title')).toContain('特权工具未批准');
    // 悬浮承载完整 ISO 时间 + 参数摘要 + 客户端 + 会话
    expect(li.getAttribute('title')).toContain('2026-11-06T10:00:00.000Z');
    expect(li.getAttribute('title')).toContain('relPath:str(9)');
    expect(li.getAttribute('title')).toContain('c1');
    expect(li.getAttribute('title')).toContain('sess-7');
  });

  it('缺项行不塌列：无 elapsed / 无落点 ⇒ 对应格显 —，五列照常落位', async () => {
    const bare: AuditEntryView = {
      ts: 't1', clientId: 'c1', tool: 'read_file', argsDigest: '{}', outcome: 'ok',
    };
    const hz = await mount(h(AuditPanel, { entries: [bare] }));
    const li = hz.find('[data-testid="mcp-audit-rows"] li')!;
    expect(li.querySelector('.mcp-audit-row-elapsed')!.textContent).toBe('—');
    expect(li.querySelector('.mcp-audit-row-path')!.textContent).toBe('—');
    // 五列 span 齐备（grid 按子元素序落列，条件渲染会把落点挤进耗时列）
    expect(li.querySelectorAll('span')).toHaveLength(5);
  });

  it('formatAuditTime：ISO 裁成 MM-DD HH:mm:ss；非 ISO 原样返回（不编造）', () => {
    expect(formatAuditTime('2026-11-06T23:41:09.123Z')).toBe('11-06 23:41:09');
    expect(formatAuditTime('2026-11-06 23:41:09')).toBe('11-06 23:41:09');
    expect(formatAuditTime('2026-01-02T03:04:05Z')).toBe('01-02 03:04:05');
    expect(formatAuditTime('t1')).toBe('t1');
    expect(formatAuditTime('')).toBe('');
    expect(formatAuditTime('2026-11-06T23:41')).toBe('2026-11-06T23:41'); // 秒缺席不裁
  });

  it('两种空态可区分：零条目 vs 筛空；清空筛选恢复全量', async () => {
    const none = await mount(h(AuditPanel, { entries: [] }));
    expect(none.text()).toContain('还没有审计条目');
    expect(none.text()).not.toContain('没有匹配当前筛选的条目');

    const hz = await mount(h(AuditPanel, { entries: [row] }));
    await hz.type(hz.find('input[aria-label="按 clientId 过滤审计条目"]')!, 'c2');
    expect(hz.text()).toContain('没有匹配当前筛选的条目');
    expect(hz.text()).not.toContain('还没有审计条目');
    expect(hz.find('[data-testid="mcp-audit-rows"]')).toBeNull();

    await hz.click(hz.findAll('button').find((b) => (b.textContent ?? '').trim() === '清空筛选')!);
    expect(hz.findAll('[data-testid="mcp-audit-rows"] li')).toHaveLength(1);
    const input = hz.find('input[aria-label="按 clientId 过滤审计条目"]') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(hz.text()).not.toContain('没有匹配当前筛选的条目');
  });
});

/* --------------------- ⑪ 屏面去黑话与按钮档位（UI-20 / UI-23） --------------------- */

describe('⑪ UI-20/23：条目屏面只留「名字 — 功能 + 写入标记」，黑话进 title，CTA 挂主档', () => {
  const pendingOf = (names: readonly string[]): ApprovalItem[] =>
    names.map((name) => ({
      name,
      tier: 'privileged' as const,
      reason: '特权工具，默认不进 tools/list，需逐会话显式批准（按工具名精确授权）',
    }));

  it('条目屏面无「privileged」档位字样与 reason 长句；title 里有（形状不变，只是不上屏）', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['fileTree.remove', 'launcher_instance_list']),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    const text = hz.text();
    expect(text).not.toContain('privileged');
    expect(text).not.toContain('tools/list');
    expect(text).not.toContain('默认不进');
    // 屏面仍是「工具名 — 真实功能一句话」（UI-17 口径延续）
    expect(text).toContain('fileTree.remove — 删除文件树中的文件或目录');
    expect(text).toContain('launcher_instance_list — 列出已注册的启动器实例');
    // 黑话与机制长句收进条目 title
    const li = hz.find('li[data-tool="fileTree.remove"]')!;
    expect(li.getAttribute('title')).toContain('privileged');
    expect(li.getAttribute('title')).toContain('按工具名精确授权');
  });

  it('写入标记：launcher 只读族标「只读」，其余（文件树 / 写面 / other）标「可写盘」', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['fileTree.remove', 'launcher_instance_list', 'launcher_start', 'workbench.saveAll']),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    const tagOf = (name: string) =>
      hz.find(`li[data-tool="${name}"] .mcp-tool-tag`)!.textContent;
    expect(tagOf('launcher_instance_list')).toBe('只读');
    expect(tagOf('fileTree.remove')).toBe('可写盘');
    expect(tagOf('launcher_start')).toBe('可写盘');
    expect(tagOf('workbench.saveAll')).toBe('可写盘');
    // 可写盘标记带 data-write 钩子（样式侧用）
    expect(hz.find('li[data-tool="fileTree.remove"] .mcp-tool-tag')!.getAttribute('data-write')).toBe('true');
    expect(hz.find('li[data-tool="launcher_instance_list"] .mcp-tool-tag')!.getAttribute('data-write')).toBeNull();
  });

  it('「已批准工具」去黑话括注；可写根 hint 人话化，技术细节进 title', async () => {
    const candidates = [{ id: WS_ID, label: WS_ROOT }];
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['fileTree.remove']),
      roots: [],
      before: '',
      after: '',
      approvedTools: ['fileTree.remove'],
      candidateRootIds: candidates,
      onApprove: () => {},
    }));
    const approved = hz.find('[data-testid="mcp-approved-tools"]')!;
    expect(approved.textContent).toContain('已批准工具：');
    expect(approved.textContent).not.toContain('第四张表');
    expect(approved.getAttribute('title')).toContain('授权记录');
    // hint 屏面人话 + title 机制
    const hint = hz.find('.mcp-approve-roots-hint')!;
    expect(hint.textContent).toContain('勾选后 Agent 才能写入该根');
    expect(hint.textContent).not.toContain('relPath');
    expect(hint.getAttribute('title')).toContain('approvedRootIds');
    expect(hint.getAttribute('title')).toContain('内核写允许域');
  });

  it('粘性条主操作挂 mcp-btn-primary；全选 / 清空 / 组头按钮不挂', async () => {
    const hz = await mount(h(ApprovalUi, {
      clientId: 'c1',
      pending: pendingOf(['fileTree.remove']),
      roots: [],
      before: '',
      after: '',
      onApprove: () => {},
    }));
    const approveBtn = hz.findAll('button').find((b) => (b.textContent ?? '').includes('批准所选'))!;
    expect(approveBtn.classList.contains('mcp-btn-primary')).toBe(true);
    for (const label of ['全选', '清空', '勾选本组', '清空本组']) {
      const btn = hz.findAll('button').find((b) => (b.textContent ?? '').includes(label))!;
      expect(btn.classList.contains('mcp-btn-primary'), `${label} 不应是主档`).toBe(false);
    }
  });
});

/* ------------------------------- 共享夹具 ------------------------------- */
const LAUNCHER_READ_SET: ReadonlySet<string> = new Set([
  'launcher_instance_list',
  'launcher_instance_get',
  'launcher_content_list',
  'launcher_content_diagnose',
  'launcher_process_list',
  'launcher_process_status',
  'launcher_task_list',
  'launcher_save_list',
  'launcher_save_backups',
  'launcher_log_sessions',
  'launcher_log_tail',
  'launcher_log_read',
  'launcher_project_hash',
]);

function pendingTools(): ApprovalItem[] {
  return APPROVABLE_PRIVILEGED_TOOLS.map((name) => ({
    name,
    tier: 'privileged' as const,
    reason: '特权工具',
  }));
}
