/**
 * `.kojo` 折叠区间（D3）单测。
 *
 * 走**真解析器**（同 `document-symbols.test.ts` 的口径：折叠的价值建立在"节点 `loc`
 * 与源行对得上"上，手搓 AST 证明不了行号）。装配面（贡献确实注册、`.kojo` 之外不认）
 * 在 `language-service.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { kojoFoldingRanges } from '../src/folding';
import { stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ faceTable: stubFaceTable() as KojoFaceTable });

const ranges = (src: string) => kojoFoldingRanges(svc().parse(src, { filePath: 'C:\\p\\a.kojo' }));

const has = (list: readonly { startLine: number; endLine: number }[], start: number, end: number): boolean =>
  list.some((r) => r.startLine === start && r.endLine === end);

describe('kojo-sugar · 折叠区间（foldingRange）', () => {
  it('纯头声明文件 → 空区间（认这个文件，但无可折块）', () => {
    expect(ranges('角色: 12\n')).toEqual([]);
  });

  it('时机块整块可折（区间与大纲同源同值）', () => {
    const list = ranges('角色: 12\n时机 指令 310：\n    「嗯。」\n    「哦？」\n');
    expect(has(list, 2, 5)).toBe(true); // 止行含末行换行后的那一线空行（与 B3 大纲同口径）
  });

  it('糖的层级就是折叠层级：块与分支各成区间（如果/否则/当/是/否则）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    如果 教養 > 30：', // 3
      '        「乙」', // 4
      '    否则：', // 5
      '        「丙」', // 6
      '    当 TFLAG:193：', // 7
      '        是 1：', // 8
      '            「丁」', // 9
      '        否则：', // 10
      '            「戊」', // 11
      '    「结束」', // 12
    ].join('\n');
    const list = ranges(src);
    expect(has(list, 2, 12)).toBe(true); // 时机块到最后一行（无尾换行 → 不产幽灵线）
    expect(has(list, 3, 6)).toBe(true); // 如果整块
    expect(has(list, 5, 6)).toBe(true); // 否则分支
    expect(has(list, 7, 11)).toBe(true); // 当整块
    expect(has(list, 8, 9)).toBe(true); // 是 分支
    expect(has(list, 10, 11)).toBe(true); // 当的 否则 分支
    for (const r of list) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('分支：规则池的池与每条分支各成区间（登记进大纲即登记进折叠——同一棵树）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    分支：', // 3
      '        [她的恋慕 >= 30]', // 4
      '            「甲」', // 5
      '            她侧过身。', // 6
      '        [她的反発刻印 超过 1]', // 7
      '            「乙」', // 8
      '        [其他]', // 9
      '            「丙」', // 10
      '    「丁」', // 11
      '',
    ].join('\n');
    const list = ranges(src);
    expect(has(list, 3, 10)).toBe(true); // 池：块头行 → 末条分支正文末行
    expect(has(list, 4, 6)).toBe(true); // 首条分支
    expect(has(list, 7, 8)).toBe(true); // 第二条分支
    expect(has(list, 9, 10)).toBe(true); // 兜底分支
    for (const r of list) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('心形：与 循环：各成区间（登记进大纲即登记进折叠——同一棵树）', () => {
    const src = [
      '角色: 12', // 1
      '时机 指令 310：', // 2
      '    心形：', // 3
      '        「甲」', // 4
      '        她侧过身。', // 5
      '    循环 计数 I 从 0 到 2：', // 6
      '        「乙」', // 7
      '        如果 教養 > 30：', // 8
      '            「丙」', // 9
      '    循环结束', // 10
      '    循环 3 次：', // 11
      '        「丁」', // 12
      '',
    ].join('\n');
    const list = ranges(src);
    expect(has(list, 3, 5)).toBe(true); // 心形：块头行 → 文本行末行（这一族没有收束词）
    expect(has(list, 6, 10)).toBe(true); // 循环：**含收束行** 6..10（折起来要把 `循环结束` 一起藏掉）
    expect(has(list, 8, 9)).toBe(true); // 循环体里的 如果 也成区间（此前整族不可见）
    expect(has(list, 11, 12)).toBe(true); // 没写收束行的那一块只到正文末行
    for (const r of list) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('区间摊平自大纲树（折叠与大纲同一棵树：顶层节点区间 ⊇ 其子孙区间）', () => {
    const src = ['时机 指令 310：', '    随机：', '        「甲」', '        「乙」', '    「丙」'].join('\n');
    const list = ranges(src);
    const outer = list.find((r) => r.startLine === 1);
    const inner = list.find((r) => r.startLine === 2);
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(outer!.endLine).toBeGreaterThanOrEqual(inner!.endLine);
  });

  it('空文件 → 空区间（不崩）', () => {
    expect(ranges('')).toEqual([]);
  });
});
