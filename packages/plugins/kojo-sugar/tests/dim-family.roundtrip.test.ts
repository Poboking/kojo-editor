/**
 * **`#DIM` 族 round-trip 对拍（工包 F · 非语料）**：写形 → 编译 → 产物逐字节相同。
 *
 * 形态照 `control-roundtrip.corpus.test.ts`，但**不取样语料、不过显示层**（显示层的
 * `#DIM` 词形是另一条私产、`#DEFINE`/`#DIMF` 它根本不渲染）：本批验收本体是「`#DIM` 有
 * `.kojo` 写形且回转逐字节相同」，所以我**直接手写 `.kojo` 写形**喂转译，比对产物那一行与
 * 源里那枚原生记号是否**一字不差**。
 *
 * 写形口径 = 上游 `erb-parser/scanner.ts` 的那张判据表（`DIM_DIRECTIVE_RE` / `DIM_MODIFIER_WORDS`
 * 与 `scanner.ts` 的 `DIM_RE` / `DIM_MODIFIERS` 逐字对齐，见 `keywords.ts` 注释）——不另发明第三种。
 * 写侧通路是**原生直通行逐字节透传**：修饰词 / 大小写 / 逗号尺寸 / 行尾注释一并原样带走，转译器
 * 不解释、不降糖，于是产物行 ≡ 源行。
 *
 * `[SKIPSTART]`/`[SKIPEND]` 停用块**不在本文件**：块内字节不动需要配对 + 逐行透传（要动 `parser.ts`，
 * 不在本工包可改清单内），故只交 `#DIM` 那一半——未通的那半见交付回报。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { classifyLine, splitLogicalLines, type LineClass } from '../src/lexer';
import { DIM_DIRECTIVE_RE, DIM_MODIFIER_WORDS } from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 去行首缩进与行尾空白（缩进由块层级决定，语句本体才是逐字节判据；口径同对拍语料文件） */
const body = (line: string): string => line.replace(/^[ \t\u3000]+/, '').replace(/\s+$/, '');

/** 产物正文行（去缩进、丢空行） */
function productLines(erb: string): string[] {
  return erb
    .split('\n')
    .map(body)
    .filter((l) => l.length > 0);
}

/** 把一枚 `#DIM` 族写形放进一份最小 `.kojo`（顶层声明位；另配一个时机保证结构合法） */
function wrapTopLevel(directive: string): string {
  return `角色: 12\n${directive}\n时机 绝顶：\n\t「台词」\n`;
}

const line = (text: string): LineClass => {
  const [logical] = splitLogicalLines(text);
  return classifyLine(logical!);
};

/* 上游那张表逐字对齐：成员全集 + 前置修饰词（本批只做识别 / 透传，不参与产物构造） */
describe('工包 F · `#DIM` 族判据与上游同源（识别谓词 / 修饰词表零自造）', () => {
  it('识别谓词命中 `#DIM` / `#DIMS` / `#DIMF` / `#DIMSTR` / `#DIMCHAR` / `#DEFINE`（大小写不敏感）', () => {
    for (const d of [
      '#DIM 喘ぎ強度',
      '#DIMS 名前 10',
      '#DIMF 倍率, 4',
      '#DIMSTR リスト, 10',
      '#DIMCHAR 假名, 3',
      '#DEFINE 時間帯 TIME:2',
      '#dim 小写也认',
      '#Define 最大 100',
    ]) {
      expect(DIM_DIRECTIVE_RE.test(d), d).toBe(true);
    }
  });

  it('负例：不是族成员 / 指令词不完整 / 裸形无正文 —— 一概不认（与上游取不到名字即 null 同判据）', () => {
    for (const d of [
      '#GLOBAL X', // 不在 `#DIM` 族（上游 DIM_RE 无 GLOBAL）
      '#DIMX 假名', // 族词必须完整 token：`DIM` 后跟 `X` 不是空白
      '#DIMFOO x',
      '#DEFINED 假名',
      '#DIM', // 裸形（无正文）
      '#DIM   ', // 只有空白正文（contentOf 会先去尾空白 ⇒ 退化成裸 `#DIM`）
      'DIM 无井号',
      '# 井号后无记号',
    ]) {
      expect(DIM_DIRECTIVE_RE.test(body(d)), d).toBe(false);
    }
  });

  it('前置修饰词表逐字对齐上游 erb-parser 的 `DIM_MODIFIERS`（含新补的 LOCAL/STATIC/DYNAMIC/OUT/CHARADATA；`TEMP` 不在表内）', () => {
    expect([...DIM_MODIFIER_WORDS].sort().join(',')).toBe(
      [
        'CONST', 'SAVEDATA', 'GLOBAL', 'REF', 'NOINIT', 'CHARA',
        'LOCAL', 'STATIC', 'DYNAMIC', 'OUT', 'CHARADATA',
      ].sort().join(','),
    );
    expect(DIM_MODIFIER_WORDS).not.toContain('TEMP');
  });
});

/* 词法层：族声明落原生直通行，绝不落 text（落 text 就是把声明当台词打印出去，违铁律 4） */
describe('工包 F · `#DIM` 族在词法层走原生直通（不落台词兜底）', () => {
  it('写形命中 ⇒ `rawLine`，`text` 即整行原文', () => {
    for (const d of ['#DIM DYNAMIC CNT_CHARA, 10', '#DIMS SORT_TARGET , LIST_MAX_SORT', '#DEFINE DEF_CULC_RELATION_NULL VARSIZE("TALENT") + 1']) {
      const cls = line(d);
      expect(cls.kind, d).toBe('rawLine');
      expect(cls.kind === 'rawLine' ? cls.text : undefined, d).toBe(d);
    }
  });

  it('非族成员的 `#` 行仍走原路径（今天落 text）——本批不扩面、不误伤', () => {
    expect(line('#GLOBAL 计数 10').kind).toBe('text');
  });

  it('行尾注释随整行一起透传（原生直通支先于注释剥离，口径同全大写指令行）', () => {
    const cls = line('#DIM LOCAL i ; 局部计数');
    expect(cls.kind).toBe('rawLine');
    expect(cls.kind === 'rawLine' ? cls.text : undefined).toBe('#DIM LOCAL i ; 局部计数');
  });
});

/* round-trip 本体：写形 → 编译 → 产物逐字节 = 源写形 */
describe('工包 F · `#DIM` 族 round-trip：写形编译后逐字节回到源记号', () => {
  const CASES: readonly string[] = [
    '#DIM DYNAMIC CNT_CHARA, 10',
    '#DIMS 名前 10',
    '#DIMF 倍率, 4',
    '#DIM CHARADATA SAVEDATA STcvar, 10',
    '#DEFINE 時間帯 TIME:2',
    '#DIM CONST 省略前括号 = 1',
    '#DIMS 賭け = "丁", "半"',
    '#DIM REF     TALKER', // 多个连续空格也逐字带走（透传不折叠空白）
  ];

  for (const directive of CASES) {
    it(`${directive}`, () => {
      const result = svc().transpile(wrapTopLevel(directive));
      const errors = result.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`);
      expect(errors, `源：\n${wrapTopLevel(directive)}`).toEqual([]);
      // 逐字节判据：产物里必须存在与源写形**一字不差**的那一行（顶层发射无缩进 ⇒ body() 后原样）
      expect(productLines(result.erb)).toContain(directive);
    });
  }

  it('时机正文里的 `#DIM LOCAL` 同样逐字节透传（走块内原生直通行通路）', () => {
    const directive = '#DIM LOCAL 计数';
    const result = svc().transpile(`角色: 12\n时机 绝顶：\n\t${directive}\n`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(productLines(result.erb)).toContain(directive);
  });
});
