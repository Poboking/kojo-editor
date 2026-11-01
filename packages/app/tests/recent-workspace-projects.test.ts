import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionKv } from '../src/ui/session-store';
import {
  RECENT_WORKSPACE_PROJECTS_KEY,
  RECENT_WORKSPACE_PROJECTS_LIMIT,
  loadRecentWorkspaceProjects,
  pickFirstBodyName,
  pickFirstEditableName,
  removeRecentWorkspaceProject,
  sameRecentWorkspaceProjects,
  sanitizeRecentWorkspaceProjects,
  saveRecentWorkspaceProjects,
  upsertRecentWorkspaceProject,
  workspaceMissingReason,
  workspaceProjectIdForPath,
  workspaceProjectStatKey,
  workspaceRowState,
  type RecentWorkspaceProject,
} from '../src/ui/recent-workspace-projects';

/**
 * 最近打开的口上作品（P0-6）纯函数判据：
 * 损坏容忍 / 排序 / 去重 / 上限 / upsert / 摘除 / 失效态 / 首文件挑选 / KV 往返。
 */

function memoryKv(): SessionKv & { raw(): string | undefined } {
  const m = new Map<string, string>();
  return {
    async get(key) {
      const s = m.get(key);
      return s === undefined ? undefined : JSON.parse(s);
    },
    async set(key, value) {
      m.set(key, JSON.stringify(value));
    },
    raw: () => m.get(RECENT_WORKSPACE_PROJECTS_KEY),
  };
}

let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
});

const rec = (projectId: string, openedAt: number, dir = `C:/ws/${projectId}`): RecentWorkspaceProject => ({
  projectId,
  name: projectId,
  dir,
  openedAt,
});

/** 探测结果替身（FileStat 只取「存在」语义） */
const stat = (isDirectory = false) => ({ size: 1, mtimeMs: 1, isDirectory });

describe('sanitizeRecentWorkspaceProjects（损坏容忍）', () => {
  it('任何不合法形态回空列表，绝不抛', () => {
    for (const raw of [undefined, null, 'x', 42, true, {}]) {
      expect(sanitizeRecentWorkspaceProjects(raw)).toEqual([]);
    }
  });

  it('缺字段 / 类型不对的条目整条滤掉，好条目照收', () => {
    const list = sanitizeRecentWorkspaceProjects([
      null,
      'nope',
      {},
      { projectId: '', name: 'a', dir: 'C:/a', openedAt: 1 },
      { projectId: 'p', name: '', dir: 'C:/a', openedAt: 1 },
      { projectId: 'p', name: 'a', dir: '', openedAt: 1 },
      { projectId: 'p', name: 'a', dir: 'C:/a', openedAt: 'x' },
      { projectId: 'ok', name: '作品', dir: 'C:/b', openedAt: 5 },
    ]);
    expect(list).toEqual([{ projectId: 'ok', name: '作品', dir: 'C:/b', openedAt: 5 }]);
  });

  it('按 openedAt 降序排；同一 projectId 去重只留最新一条', () => {
    const list = sanitizeRecentWorkspaceProjects([
      rec('old', 1),
      rec('new', 9),
      rec('old', 7),
      rec('mid', 5),
    ]);
    expect(list.map((r) => r.projectId)).toEqual(['new', 'old', 'mid']);
    expect(list.find((r) => r.projectId === 'old')?.openedAt).toBe(7);
  });

  it('截断到上限 8 条（最旧的先出队）', () => {
    const many = Array.from({ length: 12 }, (_, i) => rec(`p${i}`, i));
    const list = sanitizeRecentWorkspaceProjects(many);
    expect(list).toHaveLength(RECENT_WORKSPACE_PROJECTS_LIMIT);
    expect(list.map((r) => r.projectId)).toEqual(['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4']);
  });
});

describe('upsertRecentWorkspaceProject（合并 / 上限）', () => {
  it('新纪录插队首；同 projectId 提前并刷新时间戳，绝不重复', () => {
    const before = [rec('a', 3), rec('b', 2)];
    const after = upsertRecentWorkspaceProject(before, {
      projectId: 'b',
      name: 'b2',
      dir: 'C:/workspace/b',
      now: 9,
    });
    expect(after).toEqual([
      { projectId: 'b', name: 'b2', dir: 'C:/workspace/b', openedAt: 9 },
      rec('a', 3),
    ]);
  });

  it('超过上限时淘汰队尾；gameRoot 原样保留，空串不写', () => {
    const before = Array.from({ length: RECENT_WORKSPACE_PROJECTS_LIMIT }, (_, i) => rec(`p${i}`, i));
    const withRoot = upsertRecentWorkspaceProject(before, {
      projectId: 'new',
      name: 'new',
      dir: 'C:/ws/new',
      gameRoot: 'C:/game',
      now: 100,
    });
    expect(withRoot).toHaveLength(RECENT_WORKSPACE_PROJECTS_LIMIT);
    expect(withRoot[0]).toEqual({
      projectId: 'new',
      name: 'new',
      dir: 'C:/ws/new',
      openedAt: 100,
      gameRoot: 'C:/game',
    });
    expect(withRoot.at(-1)?.projectId).not.toBe('new');

    const noRoot = upsertRecentWorkspaceProject([], {
      projectId: 'new',
      name: 'new',
      dir: 'C:/ws/new',
      gameRoot: '',
      now: 100,
    });
    expect(noRoot[0]).not.toHaveProperty('gameRoot');
  });
});

describe('removeRecentWorkspaceProject / workspaceProjectStatKey', () => {
  it('按 projectId 摘除；未命中原样保留其余条目', () => {
    const list = [rec('a', 3), rec('b', 2), rec('c', 1)];
    expect(removeRecentWorkspaceProject(list, 'b').map((r) => r.projectId)).toEqual(['a', 'c']);
    expect(removeRecentWorkspaceProject(list, 'nope')).toEqual(list);
  });

  it('探测键按 pathKey 折大小写 / 分隔符，并随 openedAt 变化', () => {
    const a: RecentWorkspaceProject = { projectId: 'p', name: 'p', dir: 'C:\\WS\\p', openedAt: 1 };
    const b: RecentWorkspaceProject = { projectId: 'p', name: 'p', dir: 'c:/ws/p', openedAt: 1 };
    expect(workspaceProjectStatKey(a)).toBe(workspaceProjectStatKey(b));
    expect(workspaceProjectStatKey(a)).not.toBe(workspaceProjectStatKey({ ...a, openedAt: 2 }));
  });
});

describe('workspaceProjectIdForPath（面板打开作品 → 归属项目）', () => {
  it('落在作品目录下的文件折回该 projectId；不在任何作品里 ⇒ null', () => {
    const list = [
      { projectId: 'a', dir: 'C:/ws/a' },
      { projectId: 'b', dir: 'C:/ws/b' },
    ];
    expect(workspaceProjectIdForPath(list, 'C:/ws/a/剧情.kojo')).toBe('a');
    expect(workspaceProjectIdForPath(list, 'C:/ws/b/sub/x.ERB')).toBe('b');
    expect(workspaceProjectIdForPath(list, 'C:/other/y.kojo')).toBeNull();
  });

  it('Windows 大小写 / 分隔符同一口径；嵌套时取最深的那条', () => {
    expect(workspaceProjectIdForPath([{ projectId: 'a', dir: 'C:\\WS\\A' }], 'c:/ws/a/z.kojo')).toBe('a');
    expect(
      workspaceProjectIdForPath(
        [
          { projectId: 'outer', dir: 'C:/ws/p' },
          { projectId: 'inner', dir: 'C:/ws/p/sub' },
        ],
        'C:/ws/p/sub/z.kojo',
      ),
    ).toBe('inner');
  });
});

describe('workspaceRowState / workspaceMissingReason（失效态判定）', () => {
  it('探测不可用（undefined）⇒ unknown，不标记；目录或清单缺失 ⇒ missing', () => {
    expect(workspaceRowState(undefined, undefined)).toBe('unknown');
    expect(workspaceRowState(stat(true), undefined)).toBe('unknown');
    expect(workspaceRowState(null, stat())).toBe('missing');
    expect(workspaceRowState(stat(true), null)).toBe('missing');
    expect(workspaceRowState(stat(true), stat())).toBe('ok');
  });

  it('失效原因区分「文件夹不在」与「workspace.json 不在」', () => {
    expect(workspaceMissingReason(undefined, undefined)).toBeNull();
    expect(workspaceMissingReason(null, stat())).toBe('dir');
    expect(workspaceMissingReason(stat(true), null)).toBe('manifest');
    expect(workspaceMissingReason(stat(true), stat())).toBeNull();
  });
});

describe('pickFirstEditableName（正文优先）', () => {
  it('.kojo 优先于 .kojo1 / .ERB / .erm；同档取字典序最小', () => {
    expect(pickFirstEditableName(['说明.txt', '角色表.csv', 'b.ERB', 'a.kojo'])).toBe('a.kojo');
    expect(pickFirstEditableName(['b.ERB', 'a.erm'])).toBe('b.ERB');
    expect(pickFirstEditableName(['z.kojo', 'a.kojo'])).toBe('a.kojo');
  });

  it('大小写不敏感；没有正文时退回非 README / 非 workspace.json 的第一枚', () => {
    expect(pickFirstEditableName(['X.KOJO'])).toBe('X.KOJO');
    expect(pickFirstEditableName(['README.md', 'workspace.json', 'notes.txt'])).toBe('notes.txt');
    expect(pickFirstEditableName([])).toBeNull();
  });

  it('只剩 README 时退回 README；非 README 优先于 README', () => {
    expect(pickFirstEditableName(['README.md'])).toBe('README.md');
    expect(pickFirstEditableName(['README.md', 'z.txt'])).toBe('z.txt');
  });

  it('pickFirstBodyName 只认正文：根上只剩 README 时交 null（让调用方继续找制品目录）', () => {
    expect(pickFirstBodyName(['README.md', 'workspace.json', 'notes.txt'])).toBeNull();
    expect(pickFirstBodyName(['b.ERB', 'a.kojo'])).toBe('a.kojo');
    expect(pickFirstBodyName([])).toBeNull();
  });
});

describe('KV 往返（真实后端就是 JSON 文件）', () => {
  it('save → load 逐条等值；损坏的盘上数据 load 回空列表', async () => {
    const list = [rec('a', 2), { ...rec('b', 1), gameRoot: 'C:/game' }];
    await saveRecentWorkspaceProjects(kv, list);
    expect(await loadRecentWorkspaceProjects(kv)).toEqual(list);

    await kv.set(RECENT_WORKSPACE_PROJECTS_KEY, { bad: true });
    expect(await loadRecentWorkspaceProjects(kv)).toEqual([]);
  });

  it('sameRecentWorkspaceProjects：字段全等才 true（gameRoot 也参与比较）', () => {
    expect(sameRecentWorkspaceProjects([rec('a', 1)], [rec('a', 1)])).toBe(true);
    expect(sameRecentWorkspaceProjects([rec('a', 1)], [{ ...rec('a', 1), gameRoot: 'C:/g' }])).toBe(false);
    expect(sameRecentWorkspaceProjects([rec('a', 1)], [rec('b', 1)])).toBe(false);
  });
});
