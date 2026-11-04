/**
 * 命令面板参数化（冻结契约 v1）回归钉子。
 *
 * 两条硬判据：
 * 1. **旧命令不传 args 行为逐字不变**——不声明新字段、`run(ctx)` 单参的旧贡献，经
 *    `buildCommandRegistry` 合并后行为、when、键位、过滤都与此前一致；
 * 2. **新字段透传**——`description` / `argsSchema` / `tier` 原样进 `CommandEntry`，
 *    且 `run(ctx, args)` 的第二参透传到贡献方的 `run(ctx, args?)`。
 */
import { describe, expect, it } from 'vitest';
import type { EditorCommandContribution } from '@kojo/plugin-api';
import {
  buildCommandRegistry,
  buildKeybindingIndex,
  commandEnabled,
  filterCommands,
  formatKeybinding,
  type CommandEntry,
} from '../src/ui/commands';

const ctx = { project: null } as const;

describe('命令参数化 · 旧命令零改动仍逐字等价', () => {
  it('旧贡献不声明新字段 ⇒ entry 上三字段都缺省，run(ctx) 只收到 ctx', async () => {
    const seen: unknown[] = [];
    const old: EditorCommandContribution = {
      id: 'legacy.ping',
      title: '旧命令',
      run: (c) => { seen.push(c); },
    };
    const reg = buildCommandRegistry([], [old]);
    expect(reg).toHaveLength(1);
    const entry = reg[0]!;
    expect(entry.description).toBeUndefined();
    expect(entry.argsSchema).toBeUndefined();
    expect(entry.tier).toBeUndefined();
    await entry.run(ctx);
    expect(seen).toEqual([ctx]);
  });

  it('壳层命令（无 ctx 形参）包装后调用不抛，键位/分类照旧', () => {
    const reg = buildCommandRegistry(
      [{ id: 'layout.toggle', title: '切换', keybinding: 'ctrl+b', run: () => undefined }],
      [],
    );
    expect(reg[0]!.category).toBe('布局');
    expect(() => reg[0]!.run(ctx)).not.toThrow();
    expect(buildKeybindingIndex(reg).get('c:b')?.id).toBe('layout.toggle');
  });

  it('when / 过滤 / 格式化三条旧路径不受新字段影响', () => {
    const withWhen: EditorCommandContribution = {
      id: 'a', title: 'A', when: (c) => c.project !== undefined, run: () => undefined,
    };
    const reg = buildCommandRegistry([], [withWhen]);
    expect(commandEnabled(reg[0]!, ctx)).toBe(true);
    expect(filterCommands(reg, 'a').map((c) => c.id)).toEqual(['a']);
    expect(formatKeybinding('ctrl+shift+p')).toBe('Ctrl+Shift+P');
  });

  it('同 id 槽贡献覆盖壳层默认（旧优先级不变）', () => {
    const reg = buildCommandRegistry(
      [{ id: 'x', title: '壳层', run: () => undefined }],
      [{ id: 'x', title: '插件', run: () => undefined }],
    );
    expect(reg).toHaveLength(1);
    expect(reg[0]!.title).toBe('插件');
  });
});

describe('命令参数化 · 新字段 additive 透传', () => {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  };

  it('description / argsSchema / tier 原样进 CommandEntry', () => {
    const contrib: EditorCommandContribution = {
      id: 'mcp.open',
      title: '打开',
      description: '按路径打开文档',
      argsSchema: schema,
      tier: 'read',
      run: () => undefined,
    };
    const entry = buildCommandRegistry([], [contrib])[0]!;
    expect(entry.description).toBe('按路径打开文档');
    expect(entry.argsSchema).toEqual(schema);
    expect(entry.tier).toBe('read');
  });

  it('run(ctx, args) 的第二参透传到贡献方（模型调用入口）', async () => {
    let got: Record<string, unknown> | undefined;
    const contrib: EditorCommandContribution = {
      id: 'mcp.search',
      title: '检索',
      argsSchema: schema,
      run: (_c, args) => { got = args; },
    };
    const entry: CommandEntry = buildCommandRegistry([], [contrib])[0]!;
    const args = { path: 'ERB/A.ERB' };
    await entry.run(ctx, args);
    expect(got).toEqual(args);
  });

  it('缺省 description 时宿主侧可回退 title（字段保持 undefined，不擅自代填）', () => {
    const entry = buildCommandRegistry([], [
      { id: 'mcp.noDesc', title: '无描述', argsSchema: schema, tier: 'edit', run: () => undefined },
    ])[0]!;
    expect(entry.description).toBeUndefined();
    expect(entry.title).toBe('无描述');
    expect(entry.tier).toBe('edit');
  });

  it('第三参（内核动作）同样吃新字段 additive', () => {
    const entry = buildCommandRegistry([], [], [
      { id: 'editor.foldAll', title: '全部折叠', description: '折叠全部', tier: 'read', run: () => undefined },
    ])[0]!;
    expect(entry.description).toBe('折叠全部');
    expect(entry.tier).toBe('read');
  });
});
