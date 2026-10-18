/**
 * PS-14：快速打开候选的会话级缓存（`createSourceFileCache`）+ 列举语义（`listSourceFiles`）。
 *
 * 钉的判据：同项目连开六次 Ctrl+P 的 walk 趟数 **6 → 1**——
 * 同 roots + 同 nonce 的重复 `list` 只复用同一个 Promise（in-flight 也算）；
 * nonce（树重列合批信号）或 roots 变了才重走；整体失败不缓存（下次重试）。
 * 顺带钉 `listSourceFiles` 的列举语义：只收源文件后缀、失败根跳过不炸整条。
 */

import { describe, expect, it } from 'vitest';
import { createSourceFileCache, listSourceFiles, type WalkDirLike } from '../src/ui/commands';

interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FakeWalk {
  calls: string[];
  walkDir: WalkDirLike;
  /** 下一次列举是否整体抛错（测"失败不缓存"） */
  failNext: boolean;
}

function fakeWalk(byRoot: Record<string, Entry[] | Error>): FakeWalk {
  const fw: FakeWalk = {
    calls: [],
    failNext: false,
    walkDir: null as unknown as WalkDirLike,
  };
  fw.walkDir = async (root: string) => {
    fw.calls.push(root);
    if (fw.failNext) throw new Error(`列举失败：${root}`);
    const v = byRoot[root];
    if (v instanceof Error) throw v;
    return v ?? [];
  };
  return fw;
}

const ROOT_A = 'C:/game/ERB';
const ROOT_B = 'C:/game/CSV';
const FILES_A: Entry[] = [
  { name: 'a.ERB', path: 'C:/game/ERB/a.ERB', isDirectory: false },
  { name: 'sugar.kojo', path: 'C:/game/ERB/sugar.kojo', isDirectory: false },
  { name: 'readme.txt', path: 'C:/game/ERB/readme.txt', isDirectory: false },
];
const FILES_B: Entry[] = [{ name: 'b.ERB', path: 'C:/game/CSV/b.ERB', isDirectory: false }];

describe('listSourceFiles（列举语义）', () => {
  it('只收源文件后缀；失败根跳过，不影响别的根', async () => {
    const fw = fakeWalk({ [ROOT_A]: FILES_A, [ROOT_B]: new Error('盘不在') });
    const out = await listSourceFiles(fw.walkDir, [ROOT_A, ROOT_B]);
    expect(out).toEqual(['C:/game/ERB/a.ERB', 'C:/game/ERB/sugar.kojo']);
    expect(fw.calls).toEqual([ROOT_A, ROOT_B]); // 失败根也走过了（不是被静默跳过没尝试）
  });

  it('空串 / 非字符串根不列举', async () => {
    const fw = fakeWalk({});
    const out = await listSourceFiles(fw.walkDir, ['', ROOT_A]);
    expect(out).toEqual([]);
    expect(fw.calls).toEqual([ROOT_A]);
  });
});

describe('createSourceFileCache（PS-14 候选缓存）', () => {
  it('六连击：同 roots + 同 nonce 调 6 次 ⇒ walk 只走一趟（6 → 1）', async () => {
    const fw = fakeWalk({ [ROOT_A]: FILES_A, [ROOT_B]: FILES_B });
    const cache = createSourceFileCache(fw.walkDir);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => cache.list([ROOT_A, ROOT_B], 0)),
    );
    // 一趟 = 每根各一次（in-flight 的 6 次调用共享同一个 Promise）
    expect(fw.calls).toEqual([ROOT_A, ROOT_B]);
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(results[0]).toEqual(['C:/game/ERB/a.ERB', 'C:/game/ERB/sugar.kojo', 'C:/game/CSV/b.ERB']);
  });

  it('nonce 翻篇（树重列信号）⇒ 重走一趟', async () => {
    const fw = fakeWalk({ [ROOT_A]: FILES_A });
    const cache = createSourceFileCache(fw.walkDir);
    await cache.list([ROOT_A], 0);
    await cache.list([ROOT_A], 0); // 同 nonce：复用
    await cache.list([ROOT_A], 1); // nonce 变：重走
    expect(fw.calls).toEqual([ROOT_A, ROOT_A]);
  });

  it('roots 变（新附加根 / 顺序换）⇒ 重走（键顺序敏感）', async () => {
    const fw = fakeWalk({ [ROOT_A]: FILES_A, [ROOT_B]: FILES_B });
    const cache = createSourceFileCache(fw.walkDir);
    await cache.list([ROOT_A], 0);
    await cache.list([ROOT_A, ROOT_B], 0); // 加根
    await cache.list([ROOT_A, ROOT_B], 0); // 复用
    await cache.list([ROOT_B, ROOT_A], 0); // 顺序换 = 不同键
    expect(fw.calls).toEqual([ROOT_A, ROOT_A, ROOT_B, ROOT_B, ROOT_A]);
  });

  it('失败根的空缺随 nonce 翻篇自愈（失败结果缓存到下一次失效信号）', async () => {
    const fw = fakeWalk({ [ROOT_A]: FILES_A });
    const cache = createSourceFileCache(fw.walkDir);
    fw.failNext = true;
    await expect(cache.list([ROOT_A], 0)).resolves.toEqual([]); // 单根失败被 listSourceFiles 兜住
    fw.failNext = false;
    await expect(cache.list([ROOT_A], 0)).resolves.toEqual([]); // 同 nonce：缓存命中，不重走
    expect(fw.calls).toEqual([ROOT_A]);
    // nonce 翻篇（树重列信号）⇒ 重走拿到真清单——空缺不会钉死到项目切换
    const out = await cache.list([ROOT_A], 1);
    expect(out).toEqual(['C:/game/ERB/a.ERB', 'C:/game/ERB/sugar.kojo']);
    expect(fw.calls).toEqual([ROOT_A, ROOT_A]);
  });

  it('walkDir 桥换（kernel 换）⇒ 新缓存器，互不串味', async () => {
    const fw1 = fakeWalk({ [ROOT_A]: FILES_A });
    const fw2 = fakeWalk({ [ROOT_A]: [{ name: 'z.ERB', path: 'C:/game/ERB/z.ERB', isDirectory: false }] });
    const c1 = createSourceFileCache(fw1.walkDir);
    const c2 = createSourceFileCache(fw2.walkDir);
    const [a, b] = await Promise.all([c1.list([ROOT_A], 0), c2.list([ROOT_A], 0)]);
    expect(a).toEqual(['C:/game/ERB/a.ERB', 'C:/game/ERB/sugar.kojo']);
    expect(b).toEqual(['C:/game/ERB/z.ERB']);
  });
});