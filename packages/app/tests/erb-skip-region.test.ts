import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { registerKojoLanguage } from '../src/monaco/kojo-language';
import { classifyKojoLine } from '../src/monaco/kojo-native-zone';
import { ROLE } from '@kojo/kojo-lang/semantic-roles';
import { compileMonarch, driveLines, stubMonaco, type Emit } from './monarch-harness';

/**
 * `[SKIPSTART] … [SKIPEND]` 原样块的高亮验收（2026-10-20 语法高亮批）。
 *
 * 真源口径（`erb-parser/src/scanner.ts`）：标记只在**整行等值**时成立
 * （`line.trim() === '[SKIPSTART]'` / `'[SKIPEND]'`），块内是引擎原样输出的死代码，
 * 不是 ERB 代码。Monarch 此前把两个标记当行内任意位置的 `keyword.preprocessor`，
 * 且**没有块状态**——块内 `IF` / `PRINTFORMW "…"` / `; 注释` 照常被涂成
 * keyword / string / comment，作者一眼看去像活代码。
 *
 * 本文件钉三层：
 * 1. 块内逐行**单一不透明 raw 档**（`keyword.raw`，与 `.kojo` 原生围栏同档）；
 * 2. 两个标记是**专用标记档**（`keyword.preprocessor.skip.start` / `.end`），与块内不同档；
 * 3. `[SKIPEND]` 之后状态退回 root，后文照常着色（不吃掉后文）。
 *
 * `.kojo` 侧**不设**停用块：真源 lexer（`classifyLine`）把 `[SKIPSTART]` 归为普通文本行
 * （规范 §3.11 明说原生记号不当 `[条件]` 标签，"既有直通/文本行为逐字节不变"）。
 * 故这里反向钉住：`.kojo` 的 Monarch 不得长出块状态（否则与真源 lexer 分叉）。
 */

const ERB_ID = 'kojo-erb';
const KOJO_ID = 'kojo-legacy';

const { monaco, captured } = stubMonaco();
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

function defOf(id: string): Monaco.languages.IMonarchLanguage {
  const def = captured.monarchs.get(id);
  if (!def) throw new Error(`monaco 桩没捕获到 ${id} 的 Monarch def（装配面漂 = 本文件整个红）`);
  return def;
}

const erbLexerP = compileMonarch(ERB_ID, defOf(ERB_ID));
const kojoLexerP = compileMonarch(KOJO_ID, defOf(KOJO_ID));

/** 一行的发射文本拼接（用于断言"整行恰为一个不透明 token"） */
function joined(emits: readonly Emit[]): string {
  return emits.map((e) => e.text).join('');
}

/** 逐行发射的展示形（断言失败时一眼看出实际 token） */
function dump(perLine: readonly (readonly Emit[])[]): string {
  return perLine
    .map((emits, i) => `L${i + 1}: ${emits.map((e) => `${JSON.stringify(e.text)}=${e.token}`).join(' / ') || '<空>'}`)
    .join('\n');
}

/** 该行每个非空发射是否都落在给定 token 上（同档判定） */
function allTokens(emits: readonly Emit[], token: string): boolean {
  return emits.length > 0 && emits.every((e) => e.token === token);
}

describe('.ERB [SKIPSTART]…[SKIPEND] 原样块', () => {
  const body = ['[SKIPSTART]', 'IF 1', '「台词」', '; 注释', 'PRINTFORMW "字符串"', '[SKIPEND]', 'IF 2'];

  it('块内逐行单一 raw 档：IF / 「台词」 / ; 注释 / 字符串 都不再被识别为语言构造', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, body);
    const raw = `${ROLE.raw}${lexer.tokenPostfix}`;
    for (let i = 1; i <= 4; i++) {
      expect(
        allTokens(perLine[i]!, raw),
        `块内第 ${i + 1} 行不是单一 raw 档（实发：${dump(perLine)}）`,
      ).toBe(true);
    }
    // 逐个点名：这三类此前分别吃 keyword / identifier / comment / string
    expect(joined(perLine[1]!)).toBe('IF 1');
    expect(joined(perLine[2]!)).toBe('「台词」');
    expect(joined(perLine[3]!)).toBe('; 注释');
    expect(joined(perLine[4]!)).toBe('PRINTFORMW "字符串"');
  });

  it('两个标记落预处理档且与块内 raw 档不同档（LAU-2 起 start / end 同角色）', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, body);
    const start = perLine[0]!;
    const end = perLine[5]!;
    expect(start, `起始标记行（实发：${dump(perLine)}）`).toHaveLength(1);
    expect(end, `结束标记行（实发：${dump(perLine)}）`).toHaveLength(1);
    expect(joined(start)).toBe('[SKIPSTART]');
    expect(joined(end)).toBe('[SKIPEND]');
    // LAU-2 收口：`keyword.preprocessor.skip.start` / `.end` 在别名表里都归 `role.directive`
    // （收口前它们也只靠 `keyword.preprocessor` 前缀吃同一条规则、同一枚色）⇒ 可区分性只剩
    // 「标记 vs 块内」两层，start / end 不再各分一色（要分色＝改配色，属定稿色卡那一批）
    expect(start[0]!.token.startsWith(ROLE.directive)).toBe(true);
    expect(end[0]!.token.startsWith(ROLE.directive)).toBe(true);
    const raw = `${ROLE.raw}${lexer.tokenPostfix}`;
    expect(start[0]!.token, '标记不许落在块内 raw 档').not.toBe(raw);
    expect(end[0]!.token, '标记不许落在块内 raw 档').not.toBe(raw);
  });

  it('三套主题里标记档与块内 raw 档前景不同（屏上真能分开，不是只差 token 名）', () => {
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark']) {
      const theme = captured.themes.get(id);
      expect(theme, `主题 ${id} 没被装配`).toBeDefined();
      const foreground = (token: string) => theme!.rules.find((r) => r.token === token)?.foreground;
      const marker = foreground(ROLE.directive);
      const raw = foreground(ROLE.raw);
      expect(marker, `${id} 缺 keyword.preprocessor 前景`).toMatch(/^[0-9a-f]{6}$/i);
      expect(raw, `${id} 缺 keyword.raw 前景`).toMatch(/^[0-9a-f]{6}$/i);
      expect(marker!.toLowerCase(), `${id}：标记档与 raw 档同色`).not.toBe(raw!.toLowerCase());
    }
  });

  it('[SKIPEND] 之后状态退回 root：IF / 字符串照常着色，后文不被吃掉', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, body);
    const ifToken = perLine[6]!.find((e) => e.text === 'IF')?.token ?? '<none>';
    expect(ifToken, `[SKIPEND] 后的 IF 实发 ${ifToken}（${dump(perLine)}）`).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
    expect(perLine[6]!.some((e) => e.token.startsWith(ROLE.raw))).toBe(false);

    const afterString = await driveLines(lexer, ['[SKIPSTART]', 'IF 1', '[SKIPEND]', 'PRINTFORMW "后文"']);
    expect(afterString[3]!.find((e) => e.text === 'PRINTFORMW')?.token).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
    expect(afterString[3]!.some((e) => e.token.startsWith(ROLE.string))).toBe(true);
  });
});

describe('.ERB 标记判据 = 真源 lexer 的整行等值（不是"行内出现即生效"）', () => {
  it('字符串 / 行首注释 / 行尾带内容里的同形文本都不开块，后文照常着色', async () => {
    const lexer = await erbLexerP;
    const cases: readonly { label: string; line: string }[] = [
      { label: '字符串内', line: 'PRINTFORMW "[SKIPSTART]"' },
      { label: '行首注释', line: '; [SKIPSTART]' },
      { label: '行尾残留', line: '[SKIPSTART] 残余' },
    ];
    for (const { label, line } of cases) {
      const perLine = driveLines(lexer, [line, 'IF 3']);
      expect(
        perLine[1]!.find((e) => e.text === 'IF')?.token,
        `${label} 的同形文本开了块，吃掉了后文（${dump(perLine)}）`,
      ).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
      expect(perLine[0]!.some((e) => e.token.startsWith(ROLE.directive))).toBe(false);
      // 字符串 / 注释场景里，块外原有档位不许被这条规则扰动
      if (label === '字符串内') expect(joined(perLine[0]!)).toContain('[SKIPSTART]');
    }
  });

  it('缩进与行尾空白不改变判据（trim 后整行等值）', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, ['   [SKIPSTART]', '\tIF 1', '[SKIPEND]   ', 'IF 4']);
    expect(perLine[0]![0]!.token.startsWith(ROLE.directive)).toBe(true);
    expect(allTokens(perLine[1]!, `${ROLE.raw}${lexer.tokenPostfix}`)).toBe(true);
    expect(perLine[2]![0]!.token.startsWith(ROLE.directive)).toBe(true);
    expect(perLine[3]!.find((e) => e.text === 'IF')?.token).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
  });

  it('块内带残留的 [SKIPEND] 不结束块；只有整行等值的才结束', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, ['[SKIPSTART]', '[SKIPEND] 残余', 'IF 1', '[SKIPEND]', 'IF 2']);
    const raw = `${ROLE.raw}${lexer.tokenPostfix}`;
    expect(allTokens(perLine[1]!, raw), `带残留的 [SKIPEND] 提前结束了块（${dump(perLine)}）`).toBe(true);
    expect(allTokens(perLine[2]!, raw)).toBe(true);
    expect(perLine[3]![0]!.token.startsWith(ROLE.directive)).toBe(true);
    expect(perLine[4]!.find((e) => e.text === 'IF')?.token).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
  });

  it('孤立的 [SKIPEND] 只是标记，不改变状态（后文仍按 root 着色）', async () => {
    const lexer = await erbLexerP;
    const perLine = driveLines(lexer, ['[SKIPEND]', 'IF 7']);
    expect(perLine[0]![0]!.token.startsWith(ROLE.directive)).toBe(true);
    expect(perLine[1]!.find((e) => e.text === 'IF')?.token).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
  });
});

describe('.kojo 侧停用块同样是原样档（真源 lexer 已登记 skipStart / skipEnd）', () => {
  it('classifyLine 判型取自真源 lexer：整行等值 ⇒ skipStart / skipEnd，不在宿主抄第二份', () => {
    expect(classifyKojoLine('[SKIPSTART]').kind).toBe('skipStart');
    expect(classifyKojoLine('[SKIPEND]').kind).toBe('skipEnd');
  });

  it('Monarch 与源判据同向：块内逐行 raw、标记行同档、[SKIPEND] 后恢复糖着色', async () => {
    const lexer = await kojoLexerP;
    const perLine = driveLines(lexer, ['[SKIPSTART]', '如果 条件：', 'IF 1', '[SKIPEND]', '如果 条件2：']);
    const raw = `${ROLE.raw}${lexer.tokenPostfix}`;
    // 标记与块内一律 raw（与 ```erb 围栏同档：不透明区不冒充活代码）
    for (const i of [0, 1, 2, 3]) expect(allTokens(perLine[i]!, raw), `第 ${i + 1} 行不是 raw`).toBe(true);
    // 整行等值的 [SKIPEND] 退块，后文恢复
    expect(perLine[4]!.find((e) => e.text === '如果')?.token).toBe(`${ROLE.keyword}${lexer.tokenPostfix}`);
  });
});
