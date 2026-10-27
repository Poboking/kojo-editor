import { describe, expect, it } from 'vitest';

import { registerErbLanguage } from '../src/monaco/erb-language';
import { scanTextTernaries } from '@kojo/plugin-condition-extractor';
import { ROLE } from '@kojo/kojo-sdk/semantic-roles';
import { compileMonarch, driveLine, driveLines, stubMonaco, type CompiledLexer, type Emit } from './monarch-harness';

/**
 * ERB-PAINT-21（2026-10-26）：`str` 态内联三元从"整形状一次发射"改成**相位机**之后的专属钉子。
 *
 * `tests/erb-highlight.test.ts` ⑩ 已经钉住"涂什么 / 不涂什么"，本文件钉的是**机器本身**的四条：
 * ① 换态不压栈（`switchTo`），闭合 `\@` 精确回到 `str`，不会把串当成新开的；
 * ② 插值层零回退——同一枚 `%…%` / `{…}` 在三元段内与段外**逐字符同档**；
 * ③ 词表不漂移——`str` 的 guard 与 root 的整形状对同一批"不含插值"的形状必给同一枚边界序列
 *    （两套口径只差 `%`/`{`/嵌套，任何一边单独被改动的漂移当场红）；
 * ④ 相位状态绝不越行界（意外字符一律本行内出栈）。
 */
const { monaco, captured } = stubMonaco();
registerErbLanguage(monaco);

async function erbLexer(): Promise<CompiledLexer> {
  const def = captured.monarchs.get('kojo-erb');
  if (!def) throw new Error('monaco 桩没捕获到 kojo-erb 的 Monarch def');
  return compileMonarch('kojo-erb', def);
}

/** 去掉 tokenPostfix，读起来短一截 */
function bare(lexer: CompiledLexer, emitted: readonly Emit[]): string {
  return emitted.map((e) => `${e.text}::${e.token.replace(lexer.tokenPostfix, '')}`).join(' ');
}

describe('内联三元相位机（switchTo 三相位）', () => {
  it('① 闭合 `\\@` 精确回到 str：同一条串后面的正文仍出角色层、收尾引号同串档并回到 root', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "x\\@A?b#c\\@y"');
    // 期望串按角色拼（LAU-2 起引号与串内容同角色 `role.string`，转义记号独立成 `role.escape`）
    expect(bare(lexer, line.emitted)).toBe(
      [
        `PRINTL::${ROLE.keyword}`,
        `"::${ROLE.string}`,
        `x::${ROLE.string}`,
        `\\@::${ROLE.escape}`,
        `A::${ROLE.variable}`,
        `?::${ROLE.escape}`,
        `b::${ROLE.string}`,
        `#::${ROLE.escape}`,
        `c::${ROLE.string}`,
        `\\@::${ROLE.escape}`,
        `y::${ROLE.string}`,
        `"::${ROLE.string}`,
      ].join(' '),
    );
    expect(line.stack).toEqual(['root']);
  });

  it('①b 三元之后紧跟的第二枚三元照样成相（栈不被第一枚带走）', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "\\@A?a#b\\@中\\@C?c#d\\@尾"');
    const bounds = line.emitted
      .filter((e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(ROLE.escape))
      .map((e) => e.text)
      .join('');
    expect(bounds).toBe('\\@?#\\@\\@?#\\@');
    expect(line.stack).toEqual(['root']);
  });

  /**
   * ② 插值零回退：同一枚 `%…%` / `{…}`，放在三元段内与放在串里裸位置，**边界档与层内档必须逐字符相同**。
   * 这一条就是看板那句「`%…%`/`{…}` 既有插值着色零回退」的直接判据。
   */
  const interpolations: readonly string[] = ['%CALLNAME:TARGET%', '%MASTERNAME:1%', '{ITEM:45}', '{LOCAL:1}'];

  /** 把发射序列摊平回列坐标：取 [start, start+len) 这一段字符的 token 名（按覆盖起点的那枚为准） */
  /**
   * 取"发射序列里恰好拼成 `frag` 的那一段连续 token"。
   * 不能按列切：驱动器和真实 lexer 一样，**没有规则的字符不发射任何 token**（`PRINTL` 与 `"` 之间
   * 那枚空格就没有），按累计长度推列坐标会整体偏一位——这正是本条第一版红出来的原因。
   */
  function fragTokens(emitted: readonly Emit[], frag: string): string[] {
    const texts = emitted.map((e) => e.text);
    for (let i = 0; i < texts.length; i++) {
      let acc = '';
      for (let j = i; j < texts.length; j++) {
        acc += texts[j]!;
        if (acc === frag) return emitted.slice(i, j + 1).map((e) => e.token);
        if (!frag.startsWith(acc)) break;
      }
    }
    throw new Error(`发射序列里没有一整段 ${frag}：${texts.join('|')}`);
  }

  it.each(interpolations)('② 插值 `%s` 在三元段内与段外逐字符同档', async (frag) => {
    const lexer = await erbLexer();
    const out = driveLine(lexer, `PRINTL "前${frag}尾"`).emitted;
    const inn = driveLine(lexer, `PRINTL "x\\@A?${frag}#c\\@y"`).emitted;
    const outTok = fragTokens(out, frag);
    const inTok = fragTokens(inn, frag);
    // 逐字符同档 ⇒ 三元内的插值与裸位置的插值给出**同一串 token**（少一枚或多一枚都当场红）
    expect(inTok.join('|'), `段内 ${frag} 实发 ${inTok.join('|')}，段外 ${outTok.join('|')}`).toBe(outTok.join('|'));
    expect(outTok.join('|')).toContain('variable');
  });

  it('③ 词表不漂移：同一批无插值形状，str 的 guard 与 root 的整形状给同一枚边界序列', async () => {
    const lexer = await erbLexer();
    const shapes: readonly string[] = [
      '\\@CFLAG:0>0?是#否\\@',
      '\\@(A||B)&&C?是#否\\@',
      '\\@CFLAG[1]==2?y#n\\@',
      '\\@A?b(c#d)#e\\@',
    ];
    for (const shape of shapes) {
      const inRoot = driveLine(lexer, `PRINTDATA ${shape}`).emitted;
      const inStr = driveLine(lexer, `PRINTL "x${shape}y"`).emitted;
      const bounds = (emitted: readonly Emit[]): string =>
        emitted
          .filter((e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(ROLE.escape))
          .map((e) => e.text)
          .join('');
      expect(bounds(inRoot), `root 态没涂 ${shape}`).toBe('\\@?#\\@');
      expect(bounds(inStr), `str 态与 root 态边界序列分叉：${shape}`).toBe(bounds(inRoot));
      // 两态都只涂这一枚，不许顺手多产
      expect(inStr.filter((e) => e.token.startsWith(ROLE.escape)).length, `str 多产 escape：${shape}`).toBe(4);
    }
  });

  it('③b 两态同色：`%`/`{`/两层括号形状 root 与 str 都涂（上一批给 root 留的窄口径本批撤了）', async () => {
    const lexer = await erbLexer();
    const bounds = (emitted: readonly Emit[]): string =>
      emitted
        .filter((e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(ROLE.escape))
        .map((e) => e.text)
        .join('');
    const pairs: readonly [string, string][] = [
      ['PRINTL "x\\@A?%B%#c\\@y"', 'PRINTDATA \\@A?%B%#c\\@'],
      ['PRINTL "x\\@A?{N}#c\\@y"', 'PRINTDATA \\@A?{N}#c\\@'],
      ['PRINTL "x\\@((A))?b#c\\@y"', 'PRINTDATA \\@((A))?b#c\\@'],
    ];
    for (const [strLine, rootLine] of pairs) {
      expect(bounds(driveLine(lexer, strLine).emitted), `str 没涂：${strLine}`).toBe('\\@?#\\@');
      expect(bounds(driveLine(lexer, rootLine).emitted), `root 没涂：${rootLine}`).toBe('\\@?#\\@');
    }
  });

  it('③c 唯一剩下的口径差是 `;`：root 段禁注释界，str 段里 `;` 是正文', async () => {
    const lexer = await erbLexer();
    const escapes = (emitted: readonly Emit[]): number =>
      emitted.filter((e) => e.token.startsWith(ROLE.escape)).length;
    // 串里 `;` 属正文 ⇒ 涂
    expect(escapes(driveLine(lexer, 'PRINTL "x\\@A;b?c#d\\@y"').emitted)).toBeGreaterThan(0);
    // 引号外 `;` 起注释 ⇒ 形状不许跨注释界 ⇒ 不涂（与语义层 codeViewOf 同向）
    expect(escapes(driveLine(lexer, 'PRINTDATA \\@A;b?c#d\\@').emitted)).toBe(0);
  });

  it('④ 相位绝不越行界：任意含 `\\@` 的行（含被截断的残形）跑完，下一行都从 root 起', async () => {
    const lexer = await erbLexer();
    const lines = [
      'PRINTL "a\\@A?b#c\\@d"',
      'PRINTL "a\\@A?b#c',
      'PRINTL "a\\@A{B?c#d\\@e',
      'PRINTL "a\\@A%B?c#d\\@e',
      'PRINTL "x\\@((A))?b#c\\@y"',
      'PRINTL "台词\\@A?"',
    ];
    let stack: readonly string[] = ['root'];
    for (const line of lines) {
      const drive = driveLine(lexer, line, stack);
      // 行内任何相位残留都必须被 `@popall` 收掉：出栈态长度 ≤ 2（root 或 root+str），绝不含 tern 相位
      expect(drive.stack.filter((s) => s.startsWith('erbTern')), `「${line}」相位带过行界`).toHaveLength(0);
      expect(drive.stack.length, `「${line}」栈深异常：${JSON.stringify(drive.stack)}`).toBeLessThanOrEqual(2);
      stack = drive.stack;
    }
    const tail = driveLines(lexer, [...lines, 'PRINTL 正常']);
    const last = tail[tail.length - 1]!;
    expect(last.some((e) => e.token.startsWith(`${ROLE.string}.`) && e.text === '正常'), '尾行不许被上一行的串态染色').toBe(false);
    expect(last.some((e) => e.token.startsWith(ROLE.escape))).toBe(false);
  });

  /** 反向自证：把 guard 的"段内含非空白"写成"界前一字符非空白" ⇒ 主流排版整片掉色 */
  it('⑤ 真源不认的形状（段内全空白）着色层也不涂——涂 ⊆ 认在这一格的双向证据', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "a\\@ ?b#c\\@d"');
    expect(line.emitted.filter((e) => e.token.startsWith(ROLE.escape))).toHaveLength(0);
    expect(scanTextTernaries('a\\@ ?b#c\\@d')).toHaveLength(0);
  });

  it('⑥ 主流排版 ` ? `（界两侧留空格）必须照涂——首跑用 `(?<!\\s)` 偷懒判据把这片色全取消过', async () => {
    const lexer = await erbLexer();
    const line = driveLine(lexer, 'PRINTL "x\\@ STRLENS(nDesc) ? %nDesc% #设定\\@y"');
    const bounds = line.emitted
      .filter((e) => ['\\@', '?', '#'].includes(e.text) && e.token.startsWith(ROLE.escape))
      .map((e) => e.text)
      .join('');
    expect(bounds, `实发 ${bare(lexer, line.emitted)}`).toBe('\\@?#\\@');
    // 段内插值照旧 escape+variable（覆盖率与零回退同时成立才算这条过）
    expect(bare(lexer, line.emitted)).toContain(
      `%::${ROLE.escape} nDesc::${ROLE.variable} %::${ROLE.escape}`,
    );
    expect(line.stack).toEqual(['root']);
    // 反面：段里**全是**空白 ⇒ 真源不认 ⇒ 本层也不涂（同一条判据的两个方向）
    expect(driveLine(lexer, 'PRINTL "a\\@ ?b#c\\@d"').emitted.filter((e) => e.token.startsWith(ROLE.escape))).toHaveLength(0);
  });
});
