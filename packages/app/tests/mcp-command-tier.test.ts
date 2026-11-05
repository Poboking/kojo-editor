/**
 * P0 安全回归 · 命令面板动作在 MCP 面的分级（判据先钉成会红的对拍再动实现）。
 *
 * 缺陷真源：`buildRealMcpSources` 把命令面板注册的 61 条命令原样投影成
 * `McpCommandSource`；`commandToTool` 缺省 `tier='edit'`，`isDangerousTool` 只认
 * `launcher_` / `export_file` / `remove_` 这类**下划线**形状，认不出点号 id。于是
 * `workbench.saveAll` / `launcher.openInstances` / `editor.action.formatDocument`
 * 等写盘 / 原生对话框 / 编辑器写动作，在 `tier=edit` 会话里既可见也可执行——
 * 绕过 ADR-0013「危险工具默认缺席、逐工具逐会话批准」与盘点脚本里
 * 「写 / 授权 / 原生 UI 交互首期不默认暴露」的既定归因。
 *
 * 判据：面板动作一律 `privileged`（fail-closed），命令自报的宽松 tier 不能放宽；
 * read / edit 会话既不见也调不动；第四张表精确批准后才恢复合法通道；
 * `commands.list` 读数里的 tier 与真实工具分级同源（不出现两副面孔）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyCommandTier,
  createMcpCapabilityRegistry,
  type McpSessionScope,
} from '@kojo/mcp-host';
import type { CommandEntry } from '../src/ui/commands';
import {
  buildRealMcpSources,
  projectCommandsForMcp,
  type McpRealSourceHost,
} from '../src/mcp/real-sources';
import { createMcpHostDeps } from '../src/mcp/wiring';
import type { McpSearchResultLike } from '../src/mcp/real-sources-io';

const readScope: McpSessionScope = {
  sessionId: 's1', clientId: 'c1', tier: 'read', approvedRoots: [], approvedTools: [],
};
const editScope: McpSessionScope = { ...readScope, tier: 'edit' };

/** 代表性面板动作：写盘 / 原生对话框 / 启动器 / 编辑器写 / UI 状态 / 自报宽松 tier。 */
const saveSpy = vi.fn();
const PANEL_COMMANDS: readonly CommandEntry[] = [
  { id: 'workbench.saveAll', title: '全部保存', run: saveSpy },
  { id: 'workbench.saveAs', title: '另存为', run: () => undefined },
  { id: 'workbench.openProjectFolder', title: '打开项目目录', run: () => undefined },
  { id: 'workbench.checkUpdates', title: '检查更新', run: () => undefined },
  { id: 'launcher.openInstances', title: '打开实例', run: () => undefined },
  { id: 'editor.action.formatDocument', title: '格式化', run: () => undefined },
  { id: 'editor.action.replace', title: '替换', run: () => undefined },
  { id: 'layout.toggleSidebar', title: '切换侧栏', run: () => undefined },
  { id: 'bookmarks.toggle', title: '切换书签', run: () => undefined },
  // 命令作者自报 read：外部 AI 面的分级由宿主裁决，不许自报放宽。
  { id: 'workbench.problems', title: '问题面板', tier: 'read', run: () => undefined },
];

const NO_SEARCH = async (): Promise<McpSearchResultLike> => ({
  files: [], totalMatches: 0, truncated: false, filesScanned: 0, elapsedMs: 0, skipped: {},
});

async function productionRegistry() {
  const host: McpRealSourceHost = {
    getCommands: () => PANEL_COMMANDS,
    getCommandContext: () => ({ project: null }),
    getKernel: () => null,
  };
  const sources = await buildRealMcpSources(host, {
    invoke: async () => null,
    searchInFiles: NO_SEARCH,
  });
  return { sources, reg: createMcpCapabilityRegistry(createMcpHostDeps(sources)) };
}

beforeEach(() => saveSpy.mockClear());

describe('classifyCommandTier：面板动作 fail-closed', () => {
  it('点号命名空间的写 / 危险 / UI 动作一律 privileged', () => {
    for (const c of PANEL_COMMANDS) expect(classifyCommandTier(c.id)).toBe('privileged');
    expect(classifyCommandTier('launcher_start')).toBe('privileged');
    expect(classifyCommandTier('export_file')).toBe('privileged');
  });

  it('命令自报的宽松 tier 不能放宽（与 annotations 不可信同口径）', () => {
    expect(classifyCommandTier('workbench.problems', 'read')).toBe('privileged');
    expect(classifyCommandTier('workbench.saveAs', 'edit')).toBe('privileged');
    expect(classifyCommandTier('anything', 'privileged')).toBe('privileged');
  });
});

describe('projectCommandsForMcp：生产投影只落 tier、不碰其它字段、不改原数组', () => {
  it('逐条 id/title/run 原样，tier 全部 privileged，源数组零副作用', () => {
    const out = projectCommandsForMcp(PANEL_COMMANDS);
    expect(out).toHaveLength(PANEL_COMMANDS.length);
    expect(out.map((c) => c.id)).toEqual(PANEL_COMMANDS.map((c) => c.id));
    expect(out.map((c) => c.title)).toEqual(PANEL_COMMANDS.map((c) => c.title));
    expect(out.every((c) => c.tier === 'privileged')).toBe(true);
    expect(out[0]!.run).toBe(PANEL_COMMANDS[0]!.run);
    expect(PANEL_COMMANDS.every((c) => c.tier === undefined || c.tier === 'read')).toBe(true);
  });
});

describe('生产接线：read / edit 会话不见也调不动面板动作', () => {
  it('tools/list 不含任何面板动作（read 与 edit 两档都钉住）', async () => {
    const { reg } = await productionRegistry();
    for (const s of [readScope, editScope]) {
      const names = reg.listTools(s).map((t) => t.name);
      for (const c of PANEL_COMMANDS) expect(names).not.toContain(c.id);
    }
  });

  it('tools/call 越权 ⇒ PERMISSION_DENIED（拒绝可见，不是静默过滤）', async () => {
    const { reg } = await productionRegistry();
    await expect(reg.callTool('workbench.saveAll', {}, editScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(reg.callTool('launcher.openInstances', {}, editScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('第四张表精确批准 ⇒ 恢复合法通道（可见 + 可执行）', async () => {
    const { reg } = await productionRegistry();
    const approved: McpSessionScope = {
      ...editScope, tier: 'privileged', approvedTools: ['workbench.saveAll'],
    };
    expect(reg.listTools(approved).some((t) => t.name === 'workbench.saveAll')).toBe(true);
    await expect(reg.callTool('workbench.saveAll', {}, approved)).resolves.toBeUndefined();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('commands.list 读数 tier 与真实工具同源（不出现两副面孔）', async () => {
    const { sources, reg } = await productionRegistry();
    const listing = (await sources.runSupplemental!('commands.list', { maxResults: 100 }, readScope)) as {
      commands: { id: string; tier?: string }[];
    };
    const toolTier = new Map(reg.listTools({ ...readScope, tier: 'privileged', approvedTools: PANEL_COMMANDS.map((c) => c.id) }).map((t) => [t.name, t.tier]));
    for (const c of listing.commands) {
      expect(c.tier).toBe('privileged');
      expect(toolTier.get(c.id)).toBe('privileged');
    }
    expect(listing.commands).toHaveLength(PANEL_COMMANDS.length);
  });
});
