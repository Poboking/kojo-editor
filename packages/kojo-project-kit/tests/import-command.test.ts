import { describe, expect, it } from 'vitest';
import type { EditorCommandContribution, FileIO, PluginContext } from '@kojo/plugin-api';
import {
  IMPORT_KOJO_PROJECT_COMMAND_ID,
  pickAndRequestImport,
  registerImportCommand,
} from '../src/import-command';

/**
 * 通用导入命令收敛（P0）的共享层钉子。
 *
 * 两个 adapter 并装时向同一 `editor.command` 槽注册同一条命令——`registerImportCommand`
 * 必须：第一条落子、第二条见"同槽同 id 重复"即让位（不抛，不塌成两条），但对**其它**任何
 * 异常（非重复冲突）必须原样上抛（不让"收敛"变成吞错的口子，铁律 4）。
 */

interface Harness {
  readonly commands: EditorCommandContribution[];
  readonly ctx: PluginContext;
  readonly io: FileIO;
  /** 下一次 register 固定抛出的错误（模拟重复 id 之外的失败）；null 表示按重复判等逻辑走 */
  forceThrow(err: Error | null): void;
}

function makeHarness(choose: (opts?: { title?: string }) => Promise<string | null> = async () => null): Harness {
  const commands: EditorCommandContribution[] = [];
  const state = { forced: null as Error | null };
  // 2026-10-27 导入来源批：走 `pickDirectory`（只选不授权），不再借 chooseWorkspaceRoot
  const io = { pickDirectory: choose } as unknown as FileIO;
  const ctx = {
    pluginId: 'kit-test',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: { emit: () => {}, on: () => () => {} },
    onDispose: () => {},
    inject: () => io,
    slots: {
      register: (_slot: string, item: EditorCommandContribution) => {
        if (state.forced) throw state.forced;
        if (commands.some((c) => c.id === item.id)) {
          // 复刻内核 SlotRegistryImpl 的重复 id 措辞
          throw new Error(`Slot 'editor.command' already has a contribution with id '${item.id}'`);
        }
        commands.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  return {
    commands,
    ctx,
    io,
    forceThrow: (err) => {
      state.forced = err;
    },
  };
}

describe('kojo-project-kit · registerImportCommand 收敛（双 adapter 并装）', () => {
  it('第一条注册落子：editor.command 恰有一条通用导入命令（id / 标题 / 分类齐备，不写 when）', () => {
    const h = makeHarness();
    registerImportCommand(h.ctx, h.io);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]!.id).toBe(IMPORT_KOJO_PROJECT_COMMAND_ID);
    expect(h.commands[0]!.title).toBe('从文件夹导入口上项目…');
    expect(h.commands[0]!.category).toBe('文件');
    // 命令不依赖活动文件 / 打开项目 ⇒ 不写 when（宿主按恒可用求值）
    expect(h.commands[0]!.when).toBeUndefined();
  });

  it('同表第二条同 id 命中重复 ⇒ 让位、不抛、不塌成两条', () => {
    const h = makeHarness();
    registerImportCommand(h.ctx, h.io);
    // 第二次调用模拟"另一 adapter 落到同一宿主注册表"：harness 抛重复错误
    expect(() => registerImportCommand(h.ctx, h.io)).not.toThrow();
    expect(h.commands).toHaveLength(1);
  });

  it('非重复冲突的其它异常必须原样上抛（收敛不得吞错）', () => {
    const h = makeHarness();
    h.forceThrow(new Error('some unrelated slot validation failure'));
    expect(() => registerImportCommand(h.ctx, h.io)).toThrow(/unrelated slot validation failure/);
  });

  it('命令 run 走 pickAndRequestImport：选定目录 → 发 workspace.importRequested（source=command-palette）', async () => {
    const emits: Array<{ event: string; payload: unknown }> = [];
    const io = { pickDirectory: async () => 'D:/packs/东方口上包' } as unknown as FileIO;
    let captured: EditorCommandContribution | undefined;
    const ctx = {
      pluginId: 'kit-test',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      bus: { emit: (event: string, payload?: unknown) => emits.push({ event, payload }), on: () => () => {} },
      onDispose: () => {},
      slots: {
        register: (_slot: string, item: EditorCommandContribution) => {
          captured = item;
          return () => {};
        },
      },
    } as unknown as PluginContext;

    registerImportCommand(ctx, io);
    await captured!.run({ project: null });
    expect(emits).toEqual([
      {
        event: 'workspace.importRequested',
        payload: { sourceDir: 'D:/packs/东方口上包', suggestedName: '东方口上包', source: 'command-palette' },
      },
    ]);
  });

  it('pickAndRequestImport：取消（null）安静返回、零发射', async () => {
    const emits: unknown[] = [];
    const io = { pickDirectory: async () => null } as unknown as FileIO;
    const ctx = {
      pluginId: 'kit-test',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      bus: { emit: (_e: string, p?: unknown) => emits.push(p), on: () => () => {} },
      onDispose: () => {},
      slots: { register: () => () => {} },
    } as unknown as PluginContext;
    await pickAndRequestImport(ctx, io, 'projects-panel');
    expect(emits).toEqual([]);
  });
});

/**
 * 「来源目录只选不授权」（2026-10-27 导入来源批）。
 *
 * 旧形态借 `chooseWorkspaceRoot` 选来源——那条通道是「对话框即授权」，选到游戏目录当
 * 来源就把游戏目录登记成了常驻可写根。现在必须走 `pickDirectory`；平台没有这个能力时
 * **出声拒绝**，绝不许偷偷退回那条会扩大写允许域的通道。
 */
describe('kojo-project-kit · pickAndRequestImport 不碰写授权', () => {
  const makeCtx = (emits: unknown[], logs: string[]): PluginContext =>
    ({
      pluginId: 'kit-test',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: (m: string) => logs.push(m) },
      bus: { emit: (_e: string, p?: unknown) => emits.push(p), on: () => () => {} },
      onDispose: () => {},
      slots: { register: () => () => {} },
    }) as unknown as PluginContext;

  it('平台只有 chooseWorkspaceRoot（没有 pickDirectory）⇒ 不发射、出声，绝不回退到授权通道', async () => {
    const emits: unknown[] = [];
    const logs: string[] = [];
    let asked = 0;
    const io = {
      chooseWorkspaceRoot: async () => {
        asked += 1;
        return 'C:/Game/eratw';
      },
    } as unknown as FileIO;
    await pickAndRequestImport(makeCtx(emits, logs), io, 'projects-panel');
    expect(asked).toBe(0);
    expect(emits).toEqual([]);
    expect(logs.some((l) => l.includes('没有目录选择能力'))).toBe(true);
  });

  it('对话框能力抛错：原样进日志，安静返回（不吞、也不发空载荷）', async () => {
    const emits: unknown[] = [];
    const logs: string[] = [];
    const io = {
      pickDirectory: async () => {
        throw new Error('需要桌面壳');
      },
    } as unknown as FileIO;
    await pickAndRequestImport(makeCtx(emits, logs), io, 'projects-panel');
    expect(emits).toEqual([]);
    expect(logs.some((l) => l.includes('需要桌面壳'))).toBe(true);
  });
});
