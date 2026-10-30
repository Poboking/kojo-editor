/**
 * A5 · 被裁支压暗的**宿主取数腿**：`#DEFINE` 名集从索引里怎么取。
 *
 * 判据本身（哪一支被裁）由 `@kojo/plugin-erb-parser` 的 `collectPreprocDeadRanges`
 * 单测 + 语料闸钉住；这里只钉"宿主喂给它的宏集对不对"——喂错比判错更隐蔽：
 * 少一个名字就是一支真代码被压灰。
 */
import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { definedMacrosOf } from '../src/monaco/erb-preproc-defines';

function file(path: string, dims: Array<[string, string]>): [string, ErbFile] {
  return [
    path,
    {
      path,
      functions: [],
      dims: dims.map(([name, directive], i) => ({ name, directive, line: i + 1 })),
      hasFunctionDirective: false,
      lineCount: 10,
    },
  ];
}

function indexOf(files: Array<[string, ErbFile]>): ErbIndex {
  return { files: new Map(files), byName: functionLookupOf(new Map()) };
}

describe('definedMacrosOf · 索引 → 宏名集', () => {
  it('没有索引 / 一份文件都没扫到 ⇒ null（无法证明，装饰层一律不判）', () => {
    expect(definedMacrosOf(null)).toBeNull();
    expect(definedMacrosOf(indexOf([]))).toBeNull();
  });

  it('只收 `#DEFINE`，不收 `#DIM` 族；名字大写归一', () => {
    const index = indexOf([
      file('A.ERB', [['foo', 'DEFINE'], ['bar', 'DIM']]),
      file('DIM.ERH', [['Baz', 'DEFINE'], ['qux', 'DIMS']]),
    ]);
    expect([...definedMacrosOf(index)!].sort()).toEqual(['BAZ', 'FOO']);
  });

  it('空集不是 null：项目确实没有宏时，"`[IF X]` 必被裁"仍是可证明的', () => {
    const index = indexOf([file('A.ERB', [['x', 'DIM']])]);
    expect(definedMacrosOf(index)).toEqual(new Set());
  });

  it('同一份索引只算一次（重建 = 新对象，缓存天然失效）', () => {
    const first = indexOf([file('A.ERB', [['x', 'DEFINE']])]);
    expect(definedMacrosOf(first)).toBe(definedMacrosOf(first));
    expect(definedMacrosOf(indexOf([file('A.ERB', [['x', 'DEFINE']])]))).not.toBe(definedMacrosOf(first));
  });
});
