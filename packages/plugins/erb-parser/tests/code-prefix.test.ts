/**
 * 行首代码前缀 `;!;` / `;#;`（2026-10-25 ERB 语法缺口批 P2-1）。
 *
 * 语法事实（Era Wiki `Emuera/exetc`）：这两种前缀之后是**有效代码**，不是注释——
 * `;!;` 是"Emuera 专用语句"（eramaker 跳过、Emuera 执行），`;#;` 是"仅调试模式执行"。
 * 把它们当整行注释吞掉的后果不止"少着一点色"：`;!;[SKIPSTART]` 与后面对称的
 * `[SKIPEND]` 会失配，之后整篇文件的行可见性全错。
 *
 * 判据本体住在 `plugin-api`（`erb-code-prefix.ts`）：`condition-extractor` 与
 * `erb-parser` 是两个插件、禁止互相 import，两边都要这条判据 ⇒ 只能落在契约层。
 * 本文件钉的是**判据本身**，以及它在四个消费面上的落地：骨架扫描 / 控制流 /
 * 预处理块 / 可见行遍历。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERB_CODE_PREFIXES as API_PREFIXES,
  erbCodeBodyOf,
  erbCodePrefixLength,
  isErbCommentLine,
} from '@kojo/plugin-api';
import {
  ERB_CODE_PREFIXES as SCANNER_PREFIXES,
  forEachControlFlowLine,
  parseErbText,
} from '../src/scanner';
import { visibleCodeLines } from '../src/references';
import { checkPreprocStructure, checkStructure } from '../src/structure';

const lines = (...rows: string[]): string => rows.join('\n');

describe('判据本体（plugin-api · erb-code-prefix）', () => {
  it('两种前缀各 3 个字符，且之后不要求空白', () => {
    expect(API_PREFIXES).toEqual([';!;', ';#;']);
    expect(erbCodePrefixLength(';!;PRINTL あ')).toBe(3);
    expect(erbCodePrefixLength(';#;PRINTL あ')).toBe(3);
    expect(erbCodeBodyOf(';!;PRINTL あ')).toBe('PRINTL あ');
    expect(erbCodeBodyOf(';#;PRINTL あ')).toBe('PRINTL あ');
  });

  it('普通注释不算前缀；`; !;` 这种中间带空白的形态也不认（引擎按字面前缀匹配）', () => {
    expect(erbCodePrefixLength(';说明')).toBe(0);
    expect(erbCodePrefixLength(';')).toBe(0);
    // 前缀之后紧跟正文即可，**不要求**空白（语料里就是 `;!;PRINTL` 这样写的）
    expect(erbCodePrefixLength(';!; 后面跟空白也照样认')).toBe(3);
    // 但前缀自身不许被拆开：`; !;` 不是前缀，是注释
    expect(erbCodePrefixLength('; !;PRINTL')).toBe(0);
    expect(erbCodePrefixLength('PRINTL')).toBe(0);
    expect(erbCodePrefixLength(';!')).toBe(0);
  });

  it('`isErbCommentLine`：`;` 起头但不是代码前缀', () => {
    expect(isErbCommentLine(';说明')).toBe(true);
    expect(isErbCommentLine(';!;PRINTL')).toBe(false);
    expect(isErbCommentLine(';#;PRINTL')).toBe(false);
    expect(isErbCommentLine('PRINTL')).toBe(false);
  });

  it('无前缀时零分配原样返回（同一引用）', () => {
    const s = ';说明';
    expect(erbCodeBodyOf(s)).toBe(s);
  });
});

describe('骨架扫描：前缀之后是真代码', () => {
  it('`;!;@FUNC` 是真函数定义，`nameColumn` 把前缀宽度算进列坐标', () => {
    const file = parseErbText(lines(';!;@FUNC', ';!;PRINTL あ'));
    expect(file.functions.map((f) => f.name)).toEqual(['FUNC']);
    // 列 5 = `;!;` 三枚 + `@` 一枚 + 1 基——前缀不许让列坐标整体左移 3
    expect(file.functions[0]!.nameColumn).toBe(5);
  });

  it('`;!;#DIM X, 3` 是真声明（不是注释）', () => {
    const file = parseErbText(lines(';!;#DIM X, 3'));
    expect(file.dims.map((d) => d.name)).toEqual(['X']);
  });

  it('`;!;[SKIPSTART]` 真的开停用区：区内 `@` 不收、`[SKIPEND]` 之后恢复', () => {
    const file = parseErbText(
      lines(';!;[SKIPSTART]', '@DEAD', '[SKIPEND]', '@ALIVE'),
    );
    expect(file.functions.map((f) => f.name)).toEqual(['ALIVE']);
  });

  it('普通 `;` 行仍是注释：不产函数、不进声明', () => {
    const file = parseErbText(lines(';@FUNC', ';#DIM X, 3'));
    expect(file.functions).toEqual([]);
    expect(file.dims).toEqual([]);
  });
});

describe('控制流 / 结构体检：前缀不改变配对判据', () => {
  it('`;!;IF` … `;!;ENDIF` 配平（无缺陷）', () => {
    const text = lines('@F', ';!;IF TFLAG:0', ';!;PRINTL あ', ';!;ENDIF');
    expect(checkStructure(text)).toEqual([]);
  });

  it('前缀版未闭合照样报（报在开块那一行）', () => {
    const issues = checkStructure(lines('@F', ';!;IF TFLAG:0', 'PRINTL あ'));
    expect(issues.map((i) => [i.kind, i.line])).toEqual([['unclosed-open', 2]]);
  });

  it('控制流遍历看见前缀之后的语句原词', () => {
    const seen: string[] = [];
    forEachControlFlowLine(lines(';!;IF A', ';!;ENDIF'), (l) => {
      if (l.statement) seen.push(l.statement.kind);
    });
    expect(seen).toEqual(['IF', 'ENDIF']);
  });

  it('预处理块同理：`;!;[IF_DEBUG]` … `;!;[ENDIF]` 配平', () => {
    expect(checkPreprocStructure(lines(';!;[IF_DEBUG]', ';!;[ENDIF]'))).toEqual([]);
    expect(checkPreprocStructure(lines(';!;[IF_DEBUG]')).map((i) => i.kind)).toEqual(['unclosed-open']);
  });
});

describe('可见行遍历：前缀行是调用行，列坐标按原文算', () => {
  it('`;!;CALL FOO` 是调用行，`keywordEnd` = 前缀 3 + `CALL` 4', () => {
    const rows = [...visibleCodeLines(lines(';!;CALL FOO'))];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCallLine).toBe(true);
    expect(rows[0]!.keywordEnd).toBe(7);
  });

  it('缩进 + 前缀同时存在时两段宽度都要算', () => {
    const rows = [...visibleCodeLines(lines('\t;!;CALL FOO'))];
    expect(rows[0]!.keywordEnd).toBe(8);
  });

  it('普通注释行不产出可见行', () => {
    expect([...visibleCodeLines(lines(';CALL FOO'))]).toEqual([]);
  });
});

/* ============================== 两处落地同一份语言事实（对拍） ============================== */

/**
 * LAU-4 起字形判据（`CODE_PREFIXES` / `codePrefixLength`）随高亮判据整块搬进
 * `@kojo/erb-lang/highlight`（宿主 `monaco/erb-highlight.ts` 只剩翻译，不再自带字面量）。
 * 这里把三处对拍起来：改一处不改另一处 ⇒ 本用例红。与 `preproc-block.test.ts`
 * 对拍语言包的做法同一条纪律。
 */
describe('对拍：ERB 语言包的字形判据 ≡ `plugin-api` 真源', () => {
  const HIGHLIGHT_SRC = path.resolve(
    import.meta.dirname,
    '..', '..', '..', 'erb-lang', 'src', 'highlight.ts',
  );

  it('三处落地逐项相同：plugin-api 真源 ≡ scanner 镜像 ≡ ERB 语言包字形表', () => {
    const src = readFileSync(HIGHLIGHT_SRC, 'utf8');
    const m = /const CODE_PREFIXES: readonly string\[\] = \[([^\]]*)\]/.exec(src);
    expect(m, '没找到 @kojo/erb-lang/highlight 的 CODE_PREFIXES（改名了？同步改本对拍）').not.toBeNull();
    const highlight = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect(SCANNER_PREFIXES, 'scanner 镜像与契约层真源不一致').toEqual([...API_PREFIXES]);
    expect(highlight, 'ERB 语言包字形表与契约层真源不一致').toEqual([...API_PREFIXES]);
  });
});
