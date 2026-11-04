/**
 * 项目级 `#DIM` 声明落点（2026-11-04 ERH 批地基）。
 *
 * 这一份钉三件事：
 * 1. **跨文件**：同名声明分散在 `.ERH` 与 `.ERB` 里时，一张表能同时给出两处落点
 *    （`.ERH` 不是"被 include 的头文件"，而是同一编译单元的另一片——全语料 0 处 `#INCLUDE`）；
 * 2. **归一**：大小写不敏感、CJK 原样、空名字不进名录（否则空串会成为"什么都能匹配"的键）；
 * 3. **缓存只跟索引对象**：同一 `ErbIndex` 两次取到同一个 Map（F12 热路径零重建），
 *    索引重建即新对象 ⇒ 天然失效，不需要版本号。
 */

import { describe, expect, it } from 'vitest';
import { functionLookupOf } from '@kojo/plugin-api';
import type { ErbDim, ErbFile, ErbIndex } from '@kojo/plugin-api';
import { dimDeclarationSitesOf, projectDeclaredNames, projectDimDeclarations, projectDimEntries } from '../src/dim-index';

const ERH = 'C:/game/ERB/DIM.ERH';
const ERB = 'C:/game/ERB/口上・メッセージ関連/KOJO.ERB';

function dim(name: string, directive: string, line: number): ErbDim {
  return { name, directive, line };
}

function file(path: string, dims: ErbDim[]): ErbFile {
  return { path, functions: [], dims, hasFunctionDirective: false, lineCount: dims.length + 1 };
}

function makeIndex(files: ErbFile[]): ErbIndex {
  return {
    files: new Map(files.map((f) => [f.path, f])),
    byName: functionLookupOf([]),
  } as ErbIndex;
}

describe('projectDimDeclarations · 跨文件汇总', () => {
  it('同名声明的两处落点都在，文件路径逐字保留', () => {
    const index = makeIndex([
      file(ERH, [dim('KOJO_ACTIVE_NAME', 'DIMS', 3)]),
      file(ERB, [dim('KOJO_ACTIVE_NAME', 'DIM', 88)]),
    ]);
    const sites = projectDimDeclarations(index).get('KOJO_ACTIVE_NAME');
    expect(sites?.map((s) => [s.filePath, s.line])).toEqual([
      [ERH, 3],
      [ERB, 88],
    ]);
  });

  it('声明指令原样带出（DIM / DIMS / DEFINE 各自可辨）', () => {
    const index = makeIndex([file(ERH, [dim('A', 'DIM', 1), dim('B', 'DIMS', 2), dim('C', 'DEFINE', 3)])]);
    const table = projectDimDeclarations(index);
    expect(['A', 'B', 'C'].map((n) => table.get(n)?.[0]?.directive)).toEqual(['DIM', 'DIMS', 'DEFINE']);
  });

  it('列恒为 1——索引里没有列事实，不伪造列号', () => {
    const index = makeIndex([file(ERH, [dim('X', 'DIM', 7)])]);
    expect(projectDimDeclarations(index).get('X')?.[0]?.column).toBe(1);
  });

  it('多份 .ERH 各自声明同名 ⇒ 全部收齐（不是"后者覆盖前者"）', () => {
    const index = makeIndex([
      file('C:/game/ERB/A.ERH', [dim('FLAG_X', 'DIM', 1)]),
      file('C:/game/ERB/B.ERH', [dim('FLAG_X', 'DIM', 2)]),
      file('C:/game/ERB/C.ERH', [dim('FLAG_X', 'DIM', 3)]),
    ]);
    expect(projectDimDeclarations(index).get('FLAG_X')?.map((s) => s.filePath)).toEqual([
      'C:/game/ERB/A.ERH',
      'C:/game/ERB/B.ERH',
      'C:/game/ERB/C.ERH',
    ]);
  });
});

describe('projectDimDeclarations · 归一与过滤', () => {
  it('查名大小写不敏感（与 dimDeclarationsOf 同一把尺子）', () => {
    const index = makeIndex([file(ERH, [dim('kojo_active_name', 'DIMS', 3)])]);
    // 表键是大写归一的，消费方不该自己拼大小写——统一走查询函数
    expect(dimDeclarationSitesOf(index, 'KOJO_ACTIVE_NAME')).toHaveLength(1);
    expect(dimDeclarationSitesOf(index, 'KoJo_Active_Name')).toHaveLength(1);
    expect(projectDimDeclarations(index).get('KOJO_ACTIVE_NAME')).toHaveLength(1);
  });

  it('CJK 名原样参与（不做任何音译/折叠）', () => {
    const index = makeIndex([file(ERH, [dim('好感度上限', 'DIM', 5)])]);
    expect(projectDimDeclarations(index).get('好感度上限')).toHaveLength(1);
  });

  it('空名字是解析残渣，不进名录', () => {
    const index = makeIndex([file(ERH, [dim('', 'DIM', 1), dim('真名', 'DIM', 2)])]);
    const table = projectDimDeclarations(index);
    expect(table.has('')).toBe(false);
    expect(table.size).toBe(1);
  });

  it('没有 dims 的文件不制造空桶', () => {
    const index = makeIndex([file('C:/game/ERB/EMPTY.ERB', [])]);
    expect(projectDimDeclarations(index).size).toBe(0);
  });
});

describe('dimDeclarationSitesOf · 三态', () => {
  const index = makeIndex([file(ERH, [dim('V', 'DIM', 9)])]);

  it('命中 ⇒ 落点', () => {
    expect(dimDeclarationSitesOf(index, 'v').map((s) => s.line)).toEqual([9]);
  });

  it('未命中 ⇒ 空数组（不抛）', () => {
    expect(dimDeclarationSitesOf(index, '不存在')).toEqual([]);
  });

  it('索引缺席 ⇒ 空数组，而不是让调用方判空', () => {
    expect(dimDeclarationSitesOf(null, 'V')).toEqual([]);
  });

  it('空名 ⇒ 空数组（空串不是"匹配一切"的通配符）', () => {
    expect(dimDeclarationSitesOf(index, '')).toEqual([]);
  });
});

describe('缓存 · 只跟索引对象', () => {
  it('同一索引两次调用取到同一个 Map（热路径零重建）', () => {
    const index = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    expect(projectDimDeclarations(index)).toBe(projectDimDeclarations(index));
  });

  it('索引换对象 ⇒ 重新建表（重建即失效，不需要版本号）', () => {
    const a = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    const b = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    expect(projectDimDeclarations(a)).not.toBe(projectDimDeclarations(b));
  });

  it('缓存命中后改 files 不追溯——那是调用方复用索引的违约，不是本函数漏判', () => {
    const index = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    const first = projectDimDeclarations(index);
    index.files.set('C:/game/ERB/LATE.ERH', file('C:/game/ERB/LATE.ERH', [dim('Y', 'DIM', 2)]));
    expect(projectDimDeclarations(index)).toBe(first);
    expect(dimDeclarationSitesOf(index, 'Y')).toEqual([]);
  });
});

describe('projectDeclaredNames · 与旧实现逐字等价', () => {
  it('dims 保留重复与原顺序（同名散在两份文件里各出一条，不折叠）', () => {
    const index = makeIndex([
      file(ERH, [dim('A', 'DIM', 1), dim('B', 'DIMS', 2)]),
      file(ERB, [dim('A', 'DIM', 5)]),
    ]);
    expect(projectDeclaredNames(index).dims).toEqual(['A', 'B', 'A']);
  });

  it('strings 只收 DIMS / DIMSTR / DIMCHAR（DIM / DIMF / DEFINE 不进）', () => {
    const index = makeIndex([
      file(ERH, [
        dim('S1', 'DIMS', 1),
        dim('S2', 'DIMSTR', 2),
        dim('S3', 'DIMCHAR', 3),
        dim('N1', 'DIM', 4),
        dim('N2', 'DIMF', 5),
        dim('N3', 'DEFINE', 6),
      ]),
    ]);
    expect(projectDeclaredNames(index).strings).toEqual(['S1', 'S2', 'S3']);
  });

  it('名字按原名回给作者（不归一），消费方自己去重时才能显示原样', () => {
    const index = makeIndex([file(ERH, [dim('kojo_active_name', 'DIMS', 1)])]);
    expect(projectDeclaredNames(index).dims).toEqual(['kojo_active_name']);
  });

  it('同一索引两次调用取到同一个对象（诊断热路径零重建）', () => {
    const index = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    expect(projectDeclaredNames(index)).toBe(projectDeclaredNames(index));
  });

  it('两个视图共用同一次遍历：entries 缓存也是同一份', () => {
    const index = makeIndex([file(ERH, [dim('X', 'DIM', 1)])]);
    const sites = projectDimDeclarations(index);
    const names = projectDeclaredNames(index);
    expect(sites.size).toBe(1);
    expect(names.dims).toEqual(['X']);
    // 同一个索引对象上三次取用不该各自重建（WeakMap 命中即同一引用）
    expect(projectDimEntries(index)).toBe(projectDimEntries(index));
  });
});
