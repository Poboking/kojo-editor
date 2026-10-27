import { describe, expect, it } from 'vitest';
import {
  dirtyNamesIn,
  fileOpGuardMessage,
  mapRenamedPath,
  pathGoneByDelete,
  reconcilePathsAfterDiskChange,
} from '../src/ui/disk-reconcile';

/**
 * 盘上事实收尾的纯逻辑（WS-02 前缀感知迁移）。
 *
 * 事故面：目录改名后，其下打开的文件标签 / 脏态 / 固定态 / 最近记录 / 视图状态
 * 全停在旧路径——精确 `from → to` 只能换掉目录自身那一条。这里锁的是
 * 「相等或位于其下 ⇒ 映射到 to + 相对后缀」以及它的边界（同名前缀邻居不误伤）。
 */

const WIN = (p: string): string => p.replace(/\//g, '\\');

describe('mapRenamedPath · 自身相等', () => {
  it('精确路径换成新路径', () => {
    expect(mapRenamedPath('C:\\p\\kojo\\001\\a.ERB', [{ from: 'C:\\p\\kojo\\001\\a.ERB', to: 'C:\\p\\kojo\\001\\b.ERB' }])).toBe(
      'C:\\p\\kojo\\001\\b.ERB',
    );
  });

  it('大小写 / 分隔符写法不同也命中同一条（isPathUnder 口径）', () => {
    const renamed = [{ from: 'C:\\P\\Kojo\\Old', to: 'C:\\P\\Kojo\\New' }];
    expect(mapRenamedPath('c:/p/kojo/old', renamed)).toBe('C:\\P\\Kojo\\New');
    expect(mapRenamedPath('C:/P/KOJO/OLD/data/a.erb', renamed)).toBe('C:/P/Kojo/New/data/a.erb');
  });
});

describe('mapRenamedPath · 目录之下的子路径', () => {
  const renamed = [{ from: 'C:\\game\\kojo\\001', to: 'C:\\game\\kojo\\001-新' }];

  it('多层子路径带上相对后缀（逐级都跟随）', () => {
    expect(mapRenamedPath('C:\\game\\kojo\\001\\a.ERB', renamed)).toBe('C:\\game\\kojo\\001-新\\a.ERB');
    expect(mapRenamedPath('C:\\game\\kojo\\001\\pkg\\v2\\deep\\b.ERB', renamed)).toBe(
      'C:\\game\\kojo\\001-新\\pkg\\v2\\deep\\b.ERB',
    );
  });

  it('同目录同名前缀的邻居**不**误伤（a vs a-备份）', () => {
    const r = [{ from: 'C:\\game\\kojo\\a', to: 'C:\\game\\kojo\\b' }];
    expect(mapRenamedPath('C:\\game\\kojo\\a-备份\\x.ERB', r)).toBe('C:\\game\\kojo\\a-备份\\x.ERB');
    expect(mapRenamedPath('C:\\game\\kojo\\ab\\x.ERB', r)).toBe('C:\\game\\kojo\\ab\\x.ERB');
  });

  it('未命中返回原引用（字符串值不变，调用侧据此零动作）', () => {
    const path = 'C:\\game\\kojo\\999\\x.ERB';
    expect(mapRenamedPath(path, renamed)).toBe(path);
    expect(mapRenamedPath(path, [])).toBe(path);
  });

  it('多条目按给定顺序应用，命中即返回', () => {
    const list = [
      { from: 'C:\\p\\root', to: 'C:\\p\\mid' },
      { from: 'C:\\p\\mid\\sub', to: 'C:\\p\\end' },
    ];
    // 外层先行命中 ⇒ 不再拿结果跑第二条（口径是"命中即返回"）
    expect(mapRenamedPath('C:\\p\\root\\sub\\a.erb', list)).toBe('C:\\p\\mid\\sub\\a.erb');
  });
});

describe('reconcilePathsAfterDiskChange · 脏态 / 固定态跟随改名', () => {
  const RENAMED = [{ from: 'C:\\p\\kojo\\001', to: 'C:\\p\\kojo\\001-新' }];

  it('目录下多层子路径全部迁到新路径（不只剩目录自身那一条）', () => {
    const prev = new Set([
      'C:\\p\\kojo\\001\\a.ERB',
      'C:\\p\\kojo\\001\\pkg\\deep\\b.ERB',
      'C:\\p\\kojo\\002\\keep.ERB',
    ]);
    expect([...reconcilePathsAfterDiskChange(prev, [], RENAMED)].sort()).toEqual(
      [
        'C:\\p\\kojo\\001-新\\a.ERB',
        'C:\\p\\kojo\\001-新\\pkg\\deep\\b.ERB',
        'C:\\p\\kojo\\002\\keep.ERB',
      ].sort(),
    );
  });

  it('同名前缀邻居不被误迁；未命中返回**同一个引用**', () => {
    const prev = new Set(['C:\\p\\kojo\\001-备份\\x.ERB', 'C:\\p\\kojo\\0010\\y.ERB']);
    expect(reconcilePathsAfterDiskChange(prev, [], RENAMED)).toBe(prev);
    expect(reconcilePathsAfterDiskChange(prev, [], [])).toBe(prev);
  });

  it('被删的（含子路径）退出；删除优先于改名', () => {
    const prev = new Set(['C:\\p\\x\\gone.ERB', 'C:\\p\\x\\sub\\gone2.ERB', 'C:\\p\\keep.ERB']);
    const out = reconcilePathsAfterDiskChange(prev, ['C:\\p\\x'], []);
    expect([...out]).toEqual(['C:\\p\\keep.ERB']);
    // 同一条既被删又落在改名目录下 ⇒ 退出，不留新路径
    const both = reconcilePathsAfterDiskChange(new Set(['C:\\p\\kojo\\001\\a.erb']), ['C:\\p\\kojo\\001'], RENAMED);
    expect(both.size).toBe(0);
  });
});

describe('既有判据未回退', () => {
  it('pathGoneByDelete：目录之下的子路径也算没了', () => {
    expect(pathGoneByDelete(['C:\\p\\x'], 'C:\\p\\x\\a.erb')).toBe(true);
    expect(pathGoneByDelete(['C:\\p\\x'], 'C:\\p\\xy\\a.erb')).toBe(false);
  });

  it('fileOpGuardMessage：脏文件在被改名目录之下也拦（递归大刀）', () => {
    expect(fileOpGuardMessage(['C:\\p\\x'], new Set([WIN('C:/p/x/sub/a.erb')]))).toContain('未保存修改');
  });

  it('dirtyNamesIn：守门与脏闸同一份匹配判据——点名哪几份是脏的（含目录之下），去重且按入参序', () => {
    const dirty = new Set([WIN('C:/p/x/a.erb'), 'C:\\p\\y\\b.erb']);
    // 精确命中 + 目录之下（递归大刀问的就是这一格下面有没有脏的）
    expect(dirtyNamesIn(['C:\\p\\x\\a.erb'], dirty)).toEqual(['a.erb']);
    expect(dirtyNamesIn(['C:\\p\\x'], dirty)).toEqual(['a.erb']);
    // 两份都脏 ⇒ 两个名字；同一份被两种入参写法交了两次 ⇒ 只点一次名
    expect(dirtyNamesIn(['C:\\p\\y\\b.erb', 'C:/p/x', 'C:\\p\\x\\a.erb'], dirty)).toEqual(['b.erb', 'a.erb']);
    // 干净的一批 ⇒ 空数组（脏闸不该问）
    expect(dirtyNamesIn(['C:\\p\\z'], dirty)).toEqual([]);
  });
});
