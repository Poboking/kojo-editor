/**
 * ERB 插值/内联三元：**语义面 ↔ 补全面** 的跨面对拍（lead 名下，K2 报告 §待决 1 的落槌）。
 *
 * 为什么要有这个文件：`@kojo/plugin-condition-extractor` 的 `inline.ts` 认「哪一段文本是谓词」，
 * `packages/app/src/monaco/erb-completion-context.ts` 的 `erbInterpRegionAt` 认「光标落在串内哪个
 * 插值区」——两者是**同一份字形判据的第二实现**（契约 §一禁插件与宿主互相 import，
 * 第二实现是被迫的）。被迫的双实现必须有闸：谓词那一枚标记在补全面**不许被判成零候选**。
 *
 * 夹具一律取**真语料原样行**（`C:/game/eratw-画蛇添足版eratw4.980/ERB`，出处逐行注明），
 * 不自己造句子：造出来的句子只会验证我脑子里的语法，不会验证作者真在写的那一种。
 */
import { describe, expect, it } from 'vitest';
import { scanBraceTernaries, scanTextTernaries } from '@kojo/plugin-condition-extractor';
import { erbCompletionGate, erbInterpRegionAt } from '../src/monaco/erb-completion-context';

/** 真语料行（`\@…?…#…\@` 文本形；行首制表符原样保留） */
const TEXT_TERNARY_LINES: readonly (readonly [string, string])[] = [
  ['ANOTHER_TALK.ERB', '\t\t\t\t\tPRINTFORML %CALLNAME:30%的\\@ 充填率(30,3) >= 5 ? %SHOW_BOTTOM(TARGET,1)%里面已经完全湿透了、但审判仍然在 # 审判正在 \\@%TEXTR("庄严地/严肃地/庄重地")%继续着…'],
  ['BODY_INFO/PRINT_STATE_BODYGRAPH.ERB', '\t\tPRINTBUTTON @"[98]立绘包:\\@CFLAG:選択中キャラID:差し替え適用?可选立绘{CFLAG:選択中キャラID:差し替え適用}#初始立绘\\@",98'],
  ['COMMON.ERB', '\tLOCALS = \\@ ARGS:1 != "" ? （%ARGS:1%） # \\@'],
  ['DLC/DLCCHIOSEMENU.ERB', '\t\tPRINTBUTTON @"\\@!IFDr?[启动]#[关闭]\\@ ",0'],
  ['CASINO/駒草の賭場.ERB', '\tCALL COLORMESSAGE(@"%\\@ プール > 0 ? ＋ # － \\@%{ABS(プール)}枚", 表示色, 1, 1)'],
];

/** 花括号形 `{条件 ? 真 # 假}` 真语料行（**串外**代码位：11 次 / 2 文件的稀有形） */
const BRACE_TERNARY_LINE = ['BODY_INFO 系（真语料）', '\tLOCALS = {ARG, ARG:1 ? 0 # 6}'] as const;

describe('插值与内联三元：语义面认出的谓词，补全面必须给候选视野（对拍方向一）', () => {
  for (const [origin, line] of TEXT_TERNARY_LINES) {
    it(`${origin}：每一枚 \\@ 谓词的标记位都不是 in-string`, () => {
      const conditions = scanTextTernaries(line);
      expect(conditions.length, '语义面应至少认出一枚谓词').toBeGreaterThan(0);
      for (const cond of conditions) {
        // inline.ts 的 `column` = 0 基的 `\` 位；Monaco 列 1 基 ⇒ 标记后一位 = column + 3
        const caret = cond.column + 3;
        expect(
          erbCompletionGate(line, caret),
          `${origin} 的谓词位（${JSON.stringify(cond.text.slice(0, 24))}）落成了 ${erbCompletionGate(line, caret)}`,
        ).not.toBe('in-string');
      }
    });
  }

  it('花括号形（串外代码位）：语义面出谓词，补全面走 default 而非插值态', () => {
    const [, line] = BRACE_TERNARY_LINE;
    const parse = () => ({ kind: 'ternary' as const });
    const conditions = scanBraceTernaries(line, parse);
    expect(conditions).toHaveLength(1);
    const gate = erbCompletionGate(line, conditions[0]!.column + 2);
    expect(gate).toBe('default');
  });
});

describe('口径宽窄差（lead 明说，不是漂移）', () => {
  it('取值插值 `{CFLAG:0}` 不是谓词，但仍是插值区——补全要宽于依赖抽取', () => {
    const line = '\tPRINTFORM "{CFLAG:0}号"';
    const parse = () => ({ kind: 'other' as const });
    expect(scanBraceTernaries(line, parse), '纯取值插值不得凭空造谓词').toHaveLength(0);
    expect(erbCompletionGate(line, 14), '串内 `{…}` 里应给表达式候选').toBe('interp-expr');
  });

  it('串已断而 `%…%` 自身配对 ⇒ 仍给插值区（K2 口径，lead 追认：区判据优先于行破损）', () => {
    const line = '\tPRINTFORM "%A%B';
    expect(erbInterpRegionAt(line, 16)).toBe(true);
  });

  it('裸 `%` / 裸 `\\@` 在串外是运算符与文本，不算插值区', () => {
    expect(erbInterpRegionAt('\tLOCAL = A % B', 12)).toBe(false);
    expect(erbCompletionGate('\tPRINTFORM \\@X?a#b\\@', 14), '串外走代码视野').toBe('default');
  });
});

describe('残形两侧都不认（对拍方向二：宁少不错）', () => {
  it('未闭合的 `\\@`（缺收尾、缺 `?`）：语义面零谓词，补全面零候选', () => {
    const noClose = '\tPRINTFORM "前 \\@ 未闭合的文字';
    expect(scanTextTernaries(noClose)).toHaveLength(0);
    expect(erbCompletionGate(noClose, 20)).toBe('in-string');
  });

  it('成对但缺 `?` 的 `\\@…\\@`：语义面不出谓词，补全面**照给候选**（明说的宽窄差）', () => {
    // inline.ts 的「残句不产谓词」是**依赖抽取**面的保守（错造一条状态依赖比漏造更糟）；
    // 补全面正好相反——光标停在 `\@` 之后多半就是作者正要打条件的 Moment，
    // 给候选零危害，不给候选是缺陷。⇒ 这一格刻意与语义面不同判，别"顺手统一"。
    const noQuestion = '\tPRINTFORM "\\@只有开标记\\@"';
    expect(scanTextTernaries(noQuestion)).toHaveLength(0);
    expect(erbCompletionGate(noQuestion, 16)).toBe('interp-expr');
  });

  it('孤立半枚 `%`（串内没有配对）不算插值区', () => {
    const line = '\tPRINTFORM "只有 % 一枚"';
    expect(erbInterpRegionAt(line, 15)).toBe(false);
    expect(erbCompletionGate(line, 15)).toBe('in-string');
  });
});
