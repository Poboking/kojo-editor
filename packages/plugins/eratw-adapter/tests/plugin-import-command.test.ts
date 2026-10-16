import { describe, expect, it } from 'vitest';
import type { EditorCommandContribution, FileIO, PluginContext } from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';

/**
 * 「从文件夹导入口上项目…」命令（命令面板入口）的钉子。
 *
 * 这条命令只干两件事：弹系统目录对话框（`io.chooseWorkspaceRoot`）→ 发**既有**
 * 的 `workspace.importRequested` 意图。测试钉的是这两步的逐字行为：
 * payload 形状、取消的安静、对话框抛错的人话——不是"不炸"就算过。
 */

interface Emit {
  readonly event: string;
  readonly payload: unknown;
}

interface Harness {
  /** editor.command 槽里那条注册（找不到 = undefined） */
  command: EditorCommandContribution | undefined;
  /** 总线发射记录（按序） */
  emits: Emit[];
  /** log.error 收到的消息（人话断言用） */
  errors: string[];
}

function activate(io: FileIO): Harness {
  const emits: Emit[] = [];
  const errors: string[] = [];
  const commands: EditorCommandContribution[] = [];
  const ctx = {
    pluginId: 'eratw-adapter',
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m: string) => errors.push(m),
    },
    bus: {
      emit: (event: string, payload?: unknown) => emits.push({ event, payload }),
      on: () => () => {},
    },
    onDispose: () => {},
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') {
        return {
          list: async () => [],
          projectDir: (id: string) => `/ws/${id}`,
        } as unknown as T;
      }
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: unknown) => {
        if (slot === 'editor.command') commands.push(item as EditorCommandContribution);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return {
    command: commands.find((c) => c.id === 'kojo.importKojoProject'),
    emits,
    errors,
  };
}

/** 可编排 chooseWorkspaceRoot 行为的伪 IO（其余成员本命令不碰，给最小桩） */
function fakeIO(
  choose: (opts?: { title?: string }) => Promise<string | null>,
): FileIO {
  return { chooseWorkspaceRoot: choose } as unknown as FileIO;
}

describe('eratw-adapter · 「从文件夹导入口上项目…」命令', () => {
  it('注册在 editor.command 槽：id / 标题齐备，且任何上下文都可用（不依赖活动文件）', () => {
    const { command } = activate(fakeIO(async () => null));
    expect(command).toBeDefined();
    expect(command!.title).toBe('从文件夹导入口上项目…');
    // when 缺省 = 宿主按恒可用求值；写死 () => true 反而是第二份真相。
    // 这里钉住"没有 when"这件事，防止将来有人顺手加 when 把命令灰掉。
    expect(command!.when).toBeUndefined();
  });

  it('选定目录 → 逐字发出 workspace.importRequested：sourceDir / suggestedName=末段名 / source=command-palette', async () => {
    const { command, emits } = activate(fakeIO(async () => 'D:/packs/东方口上包'));
    await command!.run({ project: null });
    expect(emits).toEqual([
      {
        event: 'workspace.importRequested',
        payload: {
          sourceDir: 'D:/packs/东方口上包',
          suggestedName: '东方口上包',
          source: 'command-palette',
        },
      },
    ]);
  });

  it('取消（null）= 用户自己的动作：安静返回，零发射零报错', async () => {
    const { command, emits, errors } = activate(fakeIO(async () => null));
    await command!.run({ project: null });
    expect(emits).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('根目录没有末段名 → 不带 suggestedName 键（空串不混进载荷，回退交给向导）', async () => {
    const { command, emits } = activate(fakeIO(async () => '/'));
    await command!.run({ project: null });
    expect(emits).toEqual([
      {
        event: 'workspace.importRequested',
        payload: { sourceDir: '/', source: 'command-palette' },
      },
    ]);
  });

  it('对话框抛错 → 人话进 log（含原因），不吞、不发射', async () => {
    const { command, emits, errors } = activate(fakeIO(async () => {
      throw new Error('chooseWorkspaceRoot is not supported by NodeBridge');
    }));
    await command!.run({ project: null });
    expect(emits).toEqual([]);
    expect(errors).toHaveLength(1);
    // 人话：说清哪条路走不通 + 原因原样带上
    expect(errors[0]).toContain('从文件夹导入口上项目');
    expect(errors[0]).toContain('目录选择对话框');
    expect(errors[0]).toContain('chooseWorkspaceRoot is not supported by NodeBridge');
  });

  it('对话框标题走中文人话（系统对话框里作者看得见的字）', async () => {
    let seenTitle: string | undefined;
    const { command } = activate(
      fakeIO(async (opts) => {
        seenTitle = opts?.title;
        return null;
      }),
    );
    await command!.run({ project: null });
    expect(seenTitle).toBe('选择要导入的作者包文件夹');
  });
});
