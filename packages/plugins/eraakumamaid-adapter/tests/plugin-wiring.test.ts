import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  PluginContext,
  SearchScopeContribution,
} from '@kojo/plugin-api';
import { createErakumamaidAdapterPlugin } from '../src/plugin';
import {
  DEPLOY_KOJO_OVERLAY_ID,
  IMPORT_KOJO_OVERLAY_ID,
  NEW_KOJO_PROJECT_OVERLAY_ID,
  PUBLISH_KOJO_OVERLAY_ID,
} from '../src/overlay-ids';
import { AM_SCAFFOLD_DEPS } from '../src/new-project-wizard';
import { AM_SCAFFOLD_FILES } from '../src/scaffold';

/**
 * eraAkumaMaid 的「我的口上项目」面板与向导族接线。
 *
 * 这些窗口来自共享层（`@kojo/kojo-project-kit`），本包只做接线。本组用例只钉
 * **接线面**：注册了哪些贡献、id 落在本游戏命名空间下、游戏侧供数确实接上了。
 * 窗口行为本身由共享层与 eratw 的既有测试覆盖。
 */
interface Registered {
  slot: string;
  item: Record<string, unknown>;
}

type Listener = (payload: unknown) => void;

function activate(): {
  registered: Registered[];
  ctx: PluginContext;
  /** 触发某个内核事件的全部订阅者（本包只订阅，不发射） */
  fire: (event: string, payload: unknown) => void;
  /** `workspaces.list()` 被调了几次（钉「项目列表该重拉」这一条） */
  listCalls: () => number;
} {
  const registered: Registered[] = [];
  const listeners = new Map<string, Listener[]>();
  let listCalls = 0;
  const io = {
    listDir: async () => [],
    exists: async () => false,
    isWritable: () => true,
    chooseWorkspaceRoot: async () => null,
  } as unknown as FileIO;

  const ctx = {
    pluginId: 'eraakumamaid-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    bus: {
      emit: () => {},
      on: (event: string, cb: Listener) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return () => {};
      },
    },
    tryInject: () => null,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      if (key === 'kernel.workspaces') {
        return {
          rootDir: () => '/appdata/workspaces',
          roots: () => ['/appdata/workspaces'],
          list: async () => {
            listCalls += 1;
            return [];
          },
          projectDir: (id: string) => `/appdata/workspaces/${id}`,
          listDir: async () => [],
        } as unknown as T;
      }
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: unknown) => {
        registered.push({ slot, item: item as Record<string, unknown> });
        return () => {};
      },
    },
  } as unknown as PluginContext;

  createErakumamaidAdapterPlugin().activate(ctx);
  return {
    registered,
    ctx,
    fire: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    listCalls: () => listCalls,
  };
}

const ids = (rs: Registered[], slot: string): string[] =>
  rs.filter((r) => r.slot === slot).map((r) => String(r.item.id));

describe('eraAkumaMaid · 项目面板与向导族接线', () => {
  it('注册了面板、四个向导与导入命令（与 eratw 同一组能力）', () => {
    const { registered } = activate();

    expect(ids(registered, 'game.adapter')).toEqual(['eraakumamaid-adapter']);
    expect(ids(registered, 'ui.panel')).toEqual(['eraakumamaid-kojo-projects']);
    expect(ids(registered, 'ui.overlay')).toEqual([
      NEW_KOJO_PROJECT_OVERLAY_ID,
      IMPORT_KOJO_OVERLAY_ID,
      DEPLOY_KOJO_OVERLAY_ID,
      PUBLISH_KOJO_OVERLAY_ID,
    ]);
    expect(ids(registered, 'editor.command')).toEqual(['kojo.importKojoProject']);
  });

  it('overlay id 落在本游戏命名空间（不会与 eratw 互相顶掉）', () => {
    for (const id of [
      NEW_KOJO_PROJECT_OVERLAY_ID,
      IMPORT_KOJO_OVERLAY_ID,
      DEPLOY_KOJO_OVERLAY_ID,
      PUBLISH_KOJO_OVERLAY_ID,
    ]) {
      expect(id.startsWith('eraakumamaid.')).toBe(true);
      expect(id.startsWith('eratw.')).toBe(false);
    }
  });

  it('游戏侧供数接上了本游戏的脚手架（面数取自文件规格表，不是写死的数）', () => {
    expect(AM_SCAFFOLD_DEPS.coreFaceCount).toBe(AM_SCAFFOLD_FILES.length);
    expect(AM_SCAFFOLD_DEPS.coreFaceCount).toBeGreaterThan(1);
    // 本游戏没有「剧本号」⇒ 不提供 extraFields（共享向导连那一行都不渲染）
    expect('extraFields' in AM_SCAFFOLD_DEPS).toBe(false);

    const built = AM_SCAFFOLD_DEPS.scaffold({
      workName: '测试作品',
      authorName: '测试作者',
      version: '1.0',
      charaNo: 67,
      charaName: '测试角色',
      license: 'none',
      extra: {},
    });
    expect(Object.keys(built.files)).toContain('CSV/CHARA/CHARA67.csv');
    expect(built.dirName).toContain('测试作品');
  });
});

/* --------------------- AM-1 P5 批：两个"此前没接"的能力 --------------------- */

describe('eraAkumaMaid · 检索收窄与外部改动（P5 接线）', () => {
  const chara = (no: number, name: string, kojoDir?: string): CharaInfo =>
    kojoDir === undefined ? { no, name } : { no, name, kojoDir };

  const projectWith = (chars: readonly CharaInfo[], adapterId = 'eraakumamaid'): GameProject => {
    const charaIndex = new Map<number, CharaInfo>();
    for (const c of chars) charaIndex.set(c.no, c);
    return {
      rootDir: '/game',
      adapterId,
      kojoPaths: ['/game/ERB/EVENT_K'],
      writablePaths: [],
      charaIndex,
    } as unknown as GameProject;
  };

  it('注册了 search.scope，且 id 落在本游戏命名空间', () => {
    const { registered } = activate();
    const scopes = registered.filter((r) => r.slot === 'search.scope');
    expect(scopes).toHaveLength(1);
    expect(String(scopes[0]!.item.id)).toBe('eraakumamaid-chara-scope');
  });

  it('search.scope 只认本项目：别人的项目给空候选（不替他方编范围）', () => {
    const { registered } = activate();
    const contribution = registered.find((r) => r.slot === 'search.scope')!
      .item as unknown as SearchScopeContribution;

    const mine = projectWith([chara(1, 'フェリシエル', '/game/ERB/EVENT_K/01 フェリシエル')]);
    expect(contribution.provide(mine).map((o) => o.roots)).toEqual([
      ['/game/ERB/EVENT_K/01 フェリシエル'],
    ]);
    expect(contribution.provide(null)).toEqual([]);
    const foreign = projectWith(
      [chara(1, 'フェリシエル', '/game/ERB/EVENT_K/01 フェリシエル')],
      'eratw',
    );
    expect(contribution.provide(foreign)).toEqual([]);
  });

  it('订阅了 file.changed：工作区根的直接子层变了 ⇒ 项目列表重拉', () => {
    const { fire, listCalls } = activate();
    // activate 自己会拉一次项目列表（面板首屏）
    expect(listCalls()).toBe(1);

    fire('file.changed', { kind: 'add', path: '/appdata/workspaces/新得到的项目' });
    expect(listCalls()).toBe(2);
  });

  it('工作区之外的改动不触发重拉（游戏目录那半边不归面板管）', () => {
    const { fire, listCalls } = activate();
    fire('file.changed', { kind: 'change', path: '/game/ERB/EVENT_K/EVENT_K.ERB' });
    expect(listCalls()).toBe(1);
  });
});

/* ---------------- AM-1 P5 批：三张糖层表 / 剧情线预设接线 ---------------- */

describe('eraAkumaMaid · 糖层表与剧情线预设（P5 接线）', () => {
  /** `game.adapter` 槽位注册的是 `{ id, adapter }` 包装，不是裸 adapter */
  const adapterOf = (): GameAdapter => {
    const { registered } = activate();
    return (registered.find((r) => r.slot === 'game.adapter')!.item as { adapter: GameAdapter }).adapter;
  };

  it('函数中文化表接上了本游戏的表（非空表，查得到本游戏真实函数）', () => {
    const table = adapterOf().kojoLibraryTable!;
    expect(table.hasTable).toBe(true);
    expect(table.lookupByName('随机文本')).toBe('TEXTR');
    expect(table.lookupByName('穿着判定')).toBe('CHECK_CLO');
  });

  it('增减族表是**直写**形态（`form: assign`）——别退化成 eratw 那套 CALL', () => {
    const table = adapterOf().kojoMutatorTable!;
    expect(table.hasTable).toBe(true);
    expect(table.lookupByFamily('CFLAG')?.form).toBe('assign');
    expect(table.lookupByFamily('BASE')?.form).toBe('assign');
    // 一维族仍不登记（有加减写法但拼不出三段左值）
    expect(table.lookupByFamily('JUEL')).toBeUndefined();
  });

  it('剧情线预设四条，键取自本游戏 CSV 名表（具名 + 编号两形态都给）', () => {
    const presets = adapterOf().stateLinePresets!;
    expect(presets.map((p) => p.id)).toEqual(['affection', 'love', 'mutual', 'birth']);
    expect(presets[0]!.keys).toEqual(['CFLAG:好感度', 'CFLAG:2']);
    expect(presets[1]!.keys).toEqual(['TALENT:恋慕', 'TALENT:150']);
    expect(presets[3]!.keys).toEqual(['TALENT:出産経験', 'TALENT:22']);
  });

  it('表情线预设**不**收口上域没有条件行的键（否则是个永远筛不出行的按钮）', () => {
    const keys = adapterOf()
      .stateLinePresets!.flatMap((p) => p.keys)
      .join(',');
    // 语料实测：`片思い` 在 `EVENT_K/` 条件位 0 处、`同棲` 在 `EVENT_K/` 0 处
    expect(keys).not.toContain('片思い');
    expect(keys).not.toContain('同棲');
  });

  it('分野表扩到 22 面（首批 10 + 增量 12），且仍是纯数据可重复取用', () => {
    const a = adapterOf().kojoFaceTemplates!;
    const b = adapterOf().kojoFaceTemplates!;
    expect(Object.keys(a.faces)).toHaveLength(22);
    expect(a.faces).toEqual(b.faces);
  });
});
