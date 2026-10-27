/**
 * v1.9 P2 · 面接线（高亮 / 补全位 / 悬停分类）。
 *
 * 三面各自的"改前"缺口：
 * - 高亮：`#FUNCTION` 一族与 `[IF …]` 一族在 `.kojo1` 里没有任何规则 ⇒ 白字；
 * - 补全：糖区敲单枚 `#` / `[` 时行类还是 `text`，各 source 位置判据全落空 ⇒ 零候选；
 * - 悬停：`[IF …]` / `#DIM` / `{` `}` / 行首大写语句没有分类 ⇒ 无提示。
 *
 * 判据走**真 Monarch 编译**（与 `.erb` 高亮同一基座），词形从语言定义读，不在测试里点名规则。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { registerKojoLanguage } from '../src/monaco/kojo-language';
import { ROLE } from '@kojo/kojo-lang/semantic-roles';
import {
  kojoNativeMarkCandidates,
  kojoNativeMarkRange,
  kojoNativeMarkSlotAt,
} from '../src/monaco/kojo-native-marks';
import { resolveErbMarkHover } from '../src/monaco/kojo-hover-marks';
import { compileMonarch, driveLexer, stubMonaco, type Emit } from './monarch-harness';

const KOJO_ID = 'kojo-legacy';

const { monaco, captured } = stubMonaco();
registerKojoLanguage(monaco);

const kojoDef = captured.monarchs.get(KOJO_ID)!;
const lexerP = compileMonarch(KOJO_ID, kojoDef);

async function emit(line: string): Promise<{ emitted: Emit[]; postfix: string }> {
  const lexer = await lexerP;
  return { emitted: driveLexer(lexer, line), postfix: lexer.tokenPostfix };
}

function wholeLineToken(emitted: readonly Emit[], text: string): string {
  return emitted.find((e) => e.text === text)?.token ?? '<none>';
}

/* ============================== 高亮 / 语义着色（同一层 Monarch） ============================== */

describe('P2 · 原生标记高亮（.kojo1）', () => {
  it('# 声明族整行一档（8 枚文件级声明 + #DIM 族）', async () => {
    const suffix = (await emit('x')).postfix;
    const cases: [string, string][] = [
      ['#FUNCTION', '#FUNCTION'],
      ['#FUNCTIONS', '#FUNCTIONS'],
      ['#GLOBAL 100', '#GLOBAL'],
      ['#LOCALSIZE 20', '#LOCALSIZE'],
      ['#LOCALSSIZE 30', '#LOCALSSIZE'],
      ['#SFUNCTION', '#SFUNCTION'],
      ['#XFUNCTION', '#XFUNCTION'],
      ['#TESTMEMORY', '#TESTMEMORY'],
      ['#DIM 好感度, 10', '#DIM'],
      ['#DIMS 名字, 10', '#DIMS'],
    ];
    for (const [line, piece] of cases) {
      const { emitted } = await emit(line);
      expect(wholeLineToken(emitted, piece), `「${line}」的 ${piece} 应为 ${ROLE.directive}`).toBe(
        `${ROLE.directive}${suffix}`,
      );
    }
  });

  it('预处理标记整行一档（含宏名；大小写不敏感）', async () => {
    const suffix = (await emit('x')).postfix;
    for (const line of ['[IF 恋慕开关]', '[ELSEIF 嫉妒开关]', '[ELSE]', '[ENDIF]', '[IF_DEBUG]', '[IF_NDEBUG]', '[if 恋慕开关]']) {
      const { emitted } = await emit(line);
      expect(wholeLineToken(emitted, line), `「${line}」应整行 ${ROLE.directive}`).toBe(
        `${ROLE.directive}${suffix}`,
      );
    }
  });

  it('行连接标记 `{` / `}` 独占一行才是原生档', async () => {
    const suffix = (await emit('x')).postfix;
    for (const line of ['{', '}', '\t{', '  }']) {
      const { emitted } = await emit(line);
      const raw = emitted.filter((e) => e.token === `${ROLE.raw}${suffix}`);
      expect(raw, `「${line.trim()}」应为 ${ROLE.raw}`).toHaveLength(1);
      expect(raw[0]!.text.trim()).toBe(line.trim());
    }
  });

  it('行内 `{x}` 仍是插值，不被行连接规则截胡', async () => {
    const { emitted } = await emit('台词 「{你}」');
    expect(emitted.some((e) => e.token.startsWith(ROLE.raw))).toBe(false);
  });

  it('`# 注释` 不进声明档（闭集，不做 /^#\\w/ 泛化）', async () => {
    const { emitted } = await emit('# 这不是声明');
    expect(emitted.some((e) => e.token.startsWith(ROLE.directive))).toBe(false);
  });
});

/* ============================== 补全位 / 替换区间 / 候选表 ============================== */

describe('P2 · 原生标记位（补全）', () => {
  it('位置判据：`#` / `[` / 行首大写指令', () => {
    expect(kojoNativeMarkSlotAt('#DI', 3)).toBe('declaration');
    expect(kojoNativeMarkSlotAt('  #', 3)).toBe('declaration');
    expect(kojoNativeMarkSlotAt('[IF', 3)).toBe('preproc');
    expect(kojoNativeMarkSlotAt('PRIN', 4)).toBe('statement');
    expect(kojoNativeMarkSlotAt('台词', 2)).toBeNull();
    expect(kojoNativeMarkSlotAt('[[属性]]', 2)).toBeNull();
  });

  it('替换区间**含**起手字符（否则插出 ##DIM / [[IF]）', () => {
    expect(kojoNativeMarkRange('#DI', 3)).toEqual({ startColumn: 1, endColumn: 4 });
    expect(kojoNativeMarkRange('[IF', 3)).toEqual({ startColumn: 1, endColumn: 4 });
    expect(kojoNativeMarkRange('PRI', 3)).toEqual({ startColumn: 1, endColumn: 4 });
  });

  it('候选表来自 erb-directives 单源', () => {
    const decls = kojoNativeMarkCandidates('declaration').map((c) => c.label);
    expect(decls).toHaveLength(14);
    for (const w of ['#DIM', '#DIMSTR', '#FUNCTION', '#TESTMEMORY']) expect(decls).toContain(w);
    const pre = kojoNativeMarkCandidates('preproc').map((c) => c.label);
    for (const w of ['[IF]', '[ELSEIF]', '[ELSE]', '[ENDIF]', '[IF_DEBUG]', '[IF_NDEBUG]', '[SKIPSTART]', '[SKIPEND]']) {
      expect(pre).toContain(w);
    }
    expect(kojoNativeMarkCandidates('statement').map((c) => c.label)).toContain('PRINTFORM');
  });
});

/* ============================== 悬停分类 ============================== */

describe('P2 · 原生标记悬停分类', () => {
  it('预处理 / 声明 / 行连接 / ERB 语句', () => {
    expect(resolveErbMarkHover('[IF 恋慕开关]', 3)?.kind).toBe('预处理标记');
    expect(resolveErbMarkHover('#DIM 好感度', 3)?.name).toBe('#DIM');
    expect(resolveErbMarkHover('#DIM 好感度', 3)?.kind).toBe('ERB 声明');
    expect(resolveErbMarkHover('{', 1)?.kind).toBe('引擎记号 · 行连接');
    expect(resolveErbMarkHover('PRINTFORMW x', 3)?.kind).toBe('ERB 语句');
  });

  it('台词行不分类（不猜）', () => {
    expect(resolveErbMarkHover('台词 「好」', 2)).toBeUndefined();
  });

  it('悬停区间是 1 基、左含右不含', () => {
    const hit = resolveErbMarkHover('#DIM 好感度', 2)!;
    expect(hit.startColumn).toBe(1);
    expect(hit.endColumn).toBe(5);
  });
});
