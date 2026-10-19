/**
 * 索引扫描根的**纯判据**单测（IDX-ROOT，2026-10-19）。
 *
 * 分工：这里钉的是"哪些根该走、怎么走一遍"（`./index-roots` 的三条口径），
 * 接线（活读时机、降级出声、换根重扫）在 `workspace-index-roots.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import { planScanRoots, rootsSignature } from '../src/index-roots';

describe('planScanRoots · 并集与顺序', () => {
  it('索引根 = kojoPaths ∪ 工作区根：口上根在前、工作区新增根在后（既有索引的文件序逐字不变）', () => {
    const plan = planScanRoots(['/game/ERB/chara'], ['/ws/default', '/ws/authorized']);
    expect(plan.roots).toEqual(['/game/ERB/chara', '/ws/default', '/ws/authorized']);
    expect(plan.duplicated).toBe(0);
    expect(plan.nested).toBe(0);
  });

  it('工作区一条根都没有 ⇒ 与扩根前逐字相同（旧盘零回归）', () => {
    expect(planScanRoots(['/game/ERB', '/game/MESSAGE'], []).roots).toEqual(['/game/ERB', '/game/MESSAGE']);
  });

  it('两条口上根自己互相嵌套时也只走父根（同前缀两种写法各走一遍 = 同一份定义在 `byName` 里出现两次）', () => {
    const plan = planScanRoots(['/game/ERB', '/game/ERB/chara'], []);
    expect(plan.roots).toEqual(['/game/ERB']);
    expect(plan.nested).toBe(1);
  });

  it('默认根恒在首位不影响结果：工作区两根互换 ⇒ 同一集合、同一条不被折掉', () => {
    const a = planScanRoots(['/game/kojo'], ['/ws/one', '/ws/two']);
    const b = planScanRoots(['/game/kojo'], ['/ws/two', '/ws/one']);
    expect([...a.roots].sort()).toEqual([...b.roots].sort());
    expect(a.nested + a.duplicated).toBe(0);
    expect(b.nested + b.duplicated).toBe(0);
  });
});

describe('planScanRoots · 判等一律走 pathKey', () => {
  it('同一目录的 Windows 写法变体（盘符大小写 / 斜杠方向 / 尾分隔符）算**一个根**', () => {
    const plan = planScanRoots(['D:\\work\\proj'], ['d:/work/proj/', 'D:\\work\\proj\\']);
    expect(plan.roots).toEqual(['D:\\work\\proj']);
    expect(plan.duplicated).toBe(2);
  });

  it('POSIX 大小写敏感：`/A` 与 `/a` 是两个目录，不折（折了就少扫一整棵树）', () => {
    const plan = planScanRoots(['/ws/A'], ['/ws/a']);
    expect(plan.roots).toEqual(['/ws/A', '/ws/a']);
    expect(plan.duplicated).toBe(0);
  });

  it('同前缀的**邻居**目录不算命中（`<根>-备份` 该各走各的；边界语义单源于 isPathUnder）', () => {
    const plan = planScanRoots(['D:\\ws\\proj'], ['D:\\ws\\proj-备份']);
    expect(plan.roots).toEqual(['D:\\ws\\proj', 'D:\\ws\\proj-备份']);
    expect(plan.nested).toBe(0);
  });

  it('空串根直接丢弃（不该让"根为空"把整盘遍历带成怪形态）', () => {
    expect(planScanRoots(['', '/game/kojo'], ['']).roots).toEqual(['/game/kojo']);
  });
});

describe('planScanRoots · 祖先折叠（父遍历已覆盖子根，不该再走一遍）', () => {
  it('工作区根是口上根的**父** ⇒ 只留父根，子根折掉（文件集不变，白付的那趟遍历才是差别）', () => {
    const plan = planScanRoots(['D:\\game\\ERB\\chara'], ['D:\\game']);
    expect(plan.roots).toEqual(['D:\\game']);
    expect(plan.nested).toBe(1);
  });

  it('口上根是工作区根的父 ⇒ 同一条判据，折掉子侧（折叠只看集合，不看谁先出现）', () => {
    const plan = planScanRoots(['D:\\game'], ['D:\\game\\ERB\\chara']);
    expect(plan.roots).toEqual(['D:\\game']);
    expect(plan.nested).toBe(1);
  });

  it('三层嵌套只留极大根，且结果与输入顺序无关', () => {
    const deep = ['D:\\ws', 'D:\\ws\\proj', 'D:\\ws\\proj\\sub'];
    for (const perm of [deep, [...deep].reverse(), [deep[1]!, deep[2]!, deep[0]!]]) {
      const plan = planScanRoots(perm.slice(0, 1), perm.slice(1));
      expect(plan.roots).toEqual(['D:\\ws']);
      expect(plan.nested).toBe(2);
    }
  });
});

describe('rootsSignature · 活读比对的判据', () => {
  it('写法变体（折叠大小写与分隔符）不算换根：不因此重扫全库', () => {
    expect(rootsSignature(['D:\\A\\B', 'C:/x'])).toBe(rootsSignature(['d:/a/b/', 'c:\\x\\']));
  });

  it('多一条根 = 变；顺序变了也 = 变（文件按根序进 allFiles，重排会改索引里的定义次序）', () => {
    const base = rootsSignature(['/g', '/w1']);
    expect(rootsSignature(['/g', '/w1', '/w2'])).not.toBe(base);
    expect(rootsSignature(['/w1', '/g'])).not.toBe(base);
    expect(rootsSignature(['/g', '/w1'])).toBe(base);
  });
});
