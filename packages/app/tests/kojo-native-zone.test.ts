/**
 * SUGGEST-2A · `.kojo` **原生区**判定（`kojo-native-zone.ts`）单测。
 *
 * 判据单一真源 = `kojo-sugar` 的 `classifyLine(splitLogicalLines(text)[0])`（规范 §3.10）：
 * 行首全大写 ERB 指令 / `$标签` = 原生直通行；`@` = 原生函数块起点，块延续到下一个 `@`
 * 或 EOF（块内可含 `#DIM` 等预处理行与任意文本）。
 *
 * 本文件只测纯函数（桩 model：`getValue` / `getLineContent`），不打 provider。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  classifyKojoLine,
  KOJO_NATIVE_BLOCK_SCAN_LIMIT,
  kojoNativeSlotAt,
  kojoNativeZoneAt,
} from '../src/monaco/kojo-native-zone';

/** 桩 model：多行文本 + Monaco 默认词法的薄复刻（`#` / `[` / `]` 是词分隔符） */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
    getLanguageId: () => 'kojo',
  } as unknown as Monaco.editor.ITextModel;
}

const at = (lineNumber: number, column = 1): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

const zone = (text: string, lineNumber: number): boolean => kojoNativeZoneAt(modelOf(text), lineNumber);
const slot = (text: string, lineNumber: number, column: number): boolean =>
  kojoNativeSlotAt(modelOf(text), at(lineNumber, column));

describe('classifyKojoLine · 行类判据与转译器同一份', () => {
  it('原生直通行：全大写指令 / `$标签`（行首，忽略缩进）', () => {
    expect(classifyKojoLine('CALL FOO').kind).toBe('rawLine');
    expect(classifyKojoLine('TFLAG:193 = 0').kind).toBe('rawLine');
    expect(classifyKojoLine('\t$LOOP_TOP').kind).toBe('rawLine');
  });

  it('`@` 行 = 原生块起点（含缩进形态，`contentOf` 剥缩进后判）', () => {
    expect(classifyKojoLine('@M_KOJO_TEST').kind).toBe('rawBlockStart');
    expect(classifyKojoLine('    @FUNC').kind).toBe('rawBlockStart');
  });

  it('`#DIM` 不在行级原生判据内（预处理行只由 `@` 块携带）；糖行 / 注释 / 空白各归其类', () => {
    expect(classifyKojoLine('#DIM X').kind).not.toBe('rawLine');
    expect(classifyKojoLine('#DIM X').kind).not.toBe('rawBlockStart');
    expect(classifyKojoLine('调用 某函数').kind).not.toBe('rawLine');
    expect(classifyKojoLine('; 注释').kind).toBe('comment');
    expect(classifyKojoLine('').kind).toBe('blank');
  });
});

describe('kojoNativeZoneAt · 行级原生直通', () => {
  it('全大写指令 / `$标签` / `@` 行 ⇒ true', () => {
    expect(zone('CALL FOO', 1)).toBe(true);
    expect(zone('$LOOP_TOP', 1)).toBe(true);
    expect(zone('@M_KOJO_TEST', 1)).toBe(true);
  });

  it('缩进不改变行首判据（`   CALL X` 仍是原生行）', () => {
    expect(zone('    CALL FOO', 1)).toBe(true);
    expect(zone('\u3000\u3000GOTO $L', 1)).toBe(true);
  });
});

describe('kojoNativeZoneAt · `@` 块成员（向上找最近的 rawBlockStart）', () => {
  const TEXT = [
    '时机 初见：', // 1
    '    调用 某函数', // 2
    '    如果 好感度 大于 5：', // 3
    '@M_KOJO_TEST', // 4
    '#DIM CNT', // 5
    '    ; 注释行（块内原样透传）', // 6
    '    IF CNT > 0', // 7
    '    CALL FOO', // 8
    '@OTHER', // 9
    '$LABEL', // 10
  ].join('\n');

  it('块外的糖行 ⇒ false（`调用` / `时机` / 缩进块体绝不路由）', () => {
    expect(zone(TEXT, 1)).toBe(false);
    expect(zone(TEXT, 2)).toBe(false);
    expect(zone(TEXT, 3)).toBe(false);
  });

  it('`@` 行本身与块内任意行 ⇒ true（`#DIM` / 注释 / 表达式 / 原生行）', () => {
    expect(zone(TEXT, 4)).toBe(true);
    expect(zone(TEXT, 5)).toBe(true);
    expect(zone(TEXT, 6)).toBe(true);
    expect(zone(TEXT, 7)).toBe(true);
    expect(zone(TEXT, 8)).toBe(true); // 自身也是 rawLine（行级判据先行）
  });

  it('块界 = 下一个 `@` 或 EOF（§3.10）：第二个 `@` 起是新块，其下 `$标签` 同属原生', () => {
    expect(zone(TEXT, 9)).toBe(true);
    expect(zone(TEXT, 10)).toBe(true);
  });

  it('首个 `@` 之前是糖区：`@` 再远也扫不到（不能跨文件把糖行送进 ERB 源）', () => {
    const sugarOnly = ['时机 初见：', '    调用 某函数', '    如果 好感度 大于 5：'].join('\n');
    for (let n = 1; n <= 3; n++) expect(zone(sugarOnly, n)).toBe(false);
  });
});

describe('kojoNativeZoneAt · 注释 / 字符串 / 行中形态', () => {
  it('块外注释行 ⇒ false；块内注释行 ⇒ true（块成员优先于单行语义）', () => {
    expect(zone('; CALL FOO', 1)).toBe(false);
    expect(zone(['@F', '    ; CALL FOO'].join('\n'), 2)).toBe(true);
  });

  it('字符串开头的行 ⇒ false（`"CALL FOO"` 是被打印的文本，不是原生指令）', () => {
    expect(zone('"CALL FOO"', 1)).toBe(false);
    expect(zone('她："CALL FOO"', 1)).toBe(false);
  });

  it('行中出现的指令 / `$` / `@` 不算行首：`她 CALL FOO` / `x CALL` / `调用 $L` / `说 @F` ⇒ false', () => {
    expect(zone('她 CALL FOO', 1)).toBe(false);
    expect(zone('x CALL FOO', 1)).toBe(false);
    expect(zone('调用 $LABEL', 1)).toBe(false);
    expect(zone('说 @FUNC', 1)).toBe(false);
  });

  it('非法行号 / 桩 model 越界 ⇒ false（判据落空而不抛）', () => {
    expect(zone('CALL FOO', 0)).toBe(false);
    expect(zone('CALL FOO', Number.NaN)).toBe(false);
    expect(zone('CALL FOO', 99)).toBe(false);
  });
});

describe('kojoNativeZoneAt · 向上扫描上界（病态长文件的固定预算）', () => {
  const text = ['@F', ...Array.from({ length: KOJO_NATIVE_BLOCK_SCAN_LIMIT }, () => ''), 'if CNT'].join('\n');

  it('恰在上界内 ⇒ true（行距 = LIMIT，仍能看见块首 `@`）', () => {
    expect(zone(text, KOJO_NATIVE_BLOCK_SCAN_LIMIT + 1)).toBe(true);
  });

  it('越过上界 ⇒ false（保守判非原生区，退回糖册；不拿界外猜测污染糖位）', () => {
    expect(zone(text, KOJO_NATIVE_BLOCK_SCAN_LIMIT + 2)).toBe(false);
  });
});

describe('kojoNativeSlotAt · 主动触发只看"原生区 + 非空槽"', () => {
  it('原生名字位 ⇒ true：`CALL ` / `#D` / `CFLAG:` / `GOTO ` / `SETBIT CFLAG:1,`', () => {
    expect(slot(['@F', '    CALL '].join('\n'), 2, 10)).toBe(true); // call-target
    expect(slot(['@F', '    #D'].join('\n'), 2, 7)).toBe(true); // directive-token
    expect(slot(['@F', '    CFLAG:'].join('\n'), 2, 11)).toBe(true); // variable-slot
    expect(slot(['@F', '    GOTO '].join('\n'), 2, 10)).toBe(true); // label-target
    expect(slot(['@F', '    SETBIT CFLAG:1,'].join('\n'), 2, 20)).toBe(true); // bit-slot
  });

  it('名字槽源自己的判据优先于宽门：`CALL` / `GOTO` 未跟空白 ⇒ false（防提前弹空候选吞掉下一拍）', () => {
    // call-target / label-target 的门在"关键字后无空白"时也命中，但候选源的槽要求空白
    expect(slot(['@F', '    CALL'].join('\n'), 2, 9)).toBe(false);
    expect(slot(['@F', '    GOTO'].join('\n'), 2, 9)).toBe(false);
    // 对照：同一行补上空白即 true
    expect(slot(['@F', '    CALL '].join('\n'), 2, 10)).toBe(true);
    expect(slot(['@F', '    GOTO '].join('\n'), 2, 10)).toBe(true);
  });

  it('串内 / `;` 注释内 ⇒ false（in-string 门）', () => {
    expect(slot(['@F', '    PRINTFORM "CALL'].join('\n'), 2, 20)).toBe(false);
    expect(slot(['@F', '    CALL FOO ; 注释'].join('\n'), 2, 18)).toBe(false);
  });

  it('普通表达式位 ⇒ false（default 门：等作者自己敲触发字符，不主动弹）', () => {
    expect(slot(['@F', '    IF A'].join('\n'), 2, 9)).toBe(false);
    expect(slot('CALL FOO, ', 1, 11)).toBe(false); // 顶层原生行，但光标已在实参位（default）
  });

  it('糖位 ⇒ false（区判先行：没有 `@` 块 / 不是原生行，形态再像也不路由）', () => {
    expect(slot('    #D', 1, 7)).toBe(false); // 首个 @ 之前：`#DIM` 只能活在原生块里
    expect(slot('    调用 ', 1, 8)).toBe(false);
  });
});
