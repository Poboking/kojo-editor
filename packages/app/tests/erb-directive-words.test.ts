/**
 * T5 · Monarch directive 词表同源化（`mergeDirectiveWords` / `setErbDirectiveWords`）单测。
 *
 * 纯函数（两表进、合并词表出）+ 假 Monaco（只记录 `setMonarchTokensProvider` 与句柄
 * dispose，无运行时依赖）。覆盖：并集、大小写不敏感去重、排序确定、`extra` 缺席回基底；
 * 重设句柄纪律：重设时 dispose 旧 provider、`null` 回基底（项目切换不残留上一项目词表）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_DIRECTIVES, mergeDirectiveWords, setErbDirectiveWords } from '../src/monaco/erb-language';

describe('mergeDirectiveWords（纯函数：两表进、合并词表出）', () => {
  it('并集：基底 + adapter 词表全量在列', () => {
    const merged = mergeDirectiveWords(['PRINTL', 'CALL'], ['亲吻', '摸屁股']);
    expect(merged).toContain('PRINTL');
    expect(merged).toContain('CALL');
    expect(merged).toContain('亲吻');
    expect(merged).toContain('摸屁股');
    expect(merged).toHaveLength(4);
  });

  it('大小写不敏感去重（先出现者保留原样——基底在前，英文指令保持基底写法）', () => {
    expect(mergeDirectiveWords(['CALL', 'PRINT'], ['call', 'PRINTL', 'CallForm'])).toEqual([
      'CALL',
      'CallForm',
      'PRINT',
      'PRINTL',
    ]);
    // 大小写兄弟词（同归一化键）不产生重复项
    expect(mergeDirectiveWords(['CALL'], ['CALL', 'call'])).toEqual(['CALL']);
  });

  it('排序确定：同一输入恒得同一顺序（按码元比较，不依赖 locale）', () => {
    const a = mergeDirectiveWords(['IF', 'PRINT', 'CALL'], ['亲吻', '摸屁股']);
    const b = mergeDirectiveWords(['IF', 'PRINT', 'CALL'], ['亲吻', '摸屁股']);
    expect(a).toEqual(b);
    const sorted = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(a).toEqual(sorted);
  });

  it('extra 缺席（adapter 表缺席 / 未提供枚举能力）⇒ 基底的确定性排序拷贝（不动原数组）', () => {
    const base = ['B', 'A'];
    const out = mergeDirectiveWords(base, undefined);
    expect(out).toEqual(['A', 'B']);
    expect(base).toEqual(['B', 'A']);
    expect(mergeDirectiveWords(base, null)).toEqual(['A', 'B']);
    expect(mergeDirectiveWords(base, [])).toEqual(['A', 'B']);
  });

  it('空串丢弃；基底与 adapter 侧各自的重复项一并去重', () => {
    expect(mergeDirectiveWords(['CALL', '', 'CALL'], ['', '亲吻', '亲吻'])).toEqual(['CALL', '亲吻']);
  });
});

/** 假 Monaco：记录 `setMonarchTokensProvider` 的调用序与句柄 dispose */
function fakeMonaco() {
  const sets: { languageId: string; def: { directives?: readonly string[] }; disposed: boolean }[] = [];
  const monaco = {
    languages: {
      setMonarchTokensProvider: (languageId: string, def: { directives?: readonly string[] }) => {
        const rec = { languageId, def, disposed: false };
        sets.push(rec);
        return {
          dispose: () => {
            rec.disposed = true;
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, sets };
}

describe('setErbDirectiveWords（Monarch 重设纪律）', () => {
  it('重设词表：新 provider 带合并词表、落在 ERB 语言上', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, mergeDirectiveWords(ERB_DIRECTIVES, ['亲吻']));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.languageId).toBe('kojo-erb');
    expect(sets[0]!.def.directives).toContain('亲吻');
    expect(sets[0]!.def.directives).toContain('PRINTL');
  });

  it('重设时 dispose 旧的：第二次 set 之前，第一次的句柄已被 dispose', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, ['A']);
    setErbDirectiveWords(monaco, ['B']);
    expect(sets).toHaveLength(2);
    expect(sets[0]!.disposed).toBe(true);
    expect(sets[1]!.disposed).toBe(false);
    expect(sets[1]!.def.directives).toEqual(['B']);
  });

  it('null = 回基底：词表逐项等于 ERB_DIRECTIVES（项目切换不残留上一项目的词表）', () => {
    const { monaco, sets } = fakeMonaco();
    setErbDirectiveWords(monaco, ['亲吻']);
    setErbDirectiveWords(monaco, null);
    expect(sets).toHaveLength(2);
    expect(sets[1]!.def.directives).toEqual(ERB_DIRECTIVES);
    expect(sets[0]!.disposed).toBe(true);
  });
});
