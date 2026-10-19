/**
 * **TRY 系九枚 round-trip 对拍（工包 F · 非语料）**：中文写形 → 编译 → 产物行逐字节相同。
 *
 * 本体判据只有一条：`试探 原形 <记号> <原文>` 这一串（= 只读面 `native-display/control.ts`
 * 早已给出的中性显示形）写进 `.kojo`，产物那一行必须与引擎原文**一字不差**。
 * 形态照 `dim-family.roundtrip.test.ts`：不取样语料、不过装配层，直接手写写形喂转译，
 * 比对产物与源记号（比较口径同为「去行首缩进与行尾空白，语句本体逐字节」——
 * 缩进由块层级决定，产物一律 TAB，比缩进只会把"本体对不对"糊掉）。
 *
 * 为什么这九枚走**逐字节透传**而不是九个中文动词：九枚分两个配对档（六枚配 `CATCH`、
 * 三枚配 `ENDFUNC`，见 `sugar-ident.ts`），本包没有引擎侧取证去说某一枚中文该叫什么——
 * 猜一个就是把没有的东西写成有。判据与 `#DIM` 族（`DIM_DIRECTIVE_RE` 原生透传）、
 * `数据表 原形 PRINTDATADL`（`parseDataHead` 记号回显）同一轴：**翻类不翻义**，写法与产物同一 token。
 *
 * 与 `dim-family.roundtrip.test.ts` 的一处口径差别（本批的红线所在）：那一批的写形就是原生
 * 记号本身，走 `rawLine` 整行透传；本批的写形是**中文词头 + 记号回显**，所以词形必须登记进
 * `KEYWORDS`（登记 = 承诺写得回去）。随之而来的两条都由本文件钉住：
 * ①词形与只读面同源（`primaryWord('inline.tryStatement')` 就是显示层那一串的词头）；
 * ②发版样例里**真用过**（`sugar-releasecheck.transpile.test.ts` 的词闸挂语料才跑，
 *   故本文件另有一条不依赖语料的预演——见最后那组）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { classifyLine, splitLogicalLines, type LineClass } from '../src/lexer';
import { computeFormatEdits, formatText } from '../src/formatter';
import { lookupKeyword, primaryWord } from '../src/keywords';
import { renderControlLine } from '../src/native-display/control';
import { TRY_CATCH_OPEN, TRY_LIST_OPEN } from '../src/sugar-ident';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 去行首缩进与行尾空白（语句本体才是逐字节判据；口径同对拍语料文件） */
const body = (line: string): string => line.replace(/^[ \t\u3000]+/, '').replace(/\s+$/, '');

/** 产物正文行（去缩进、丢空行） */
function productLines(erb: string): string[] {
  return erb
    .split('\n')
    .map(body)
    .filter((l) => l.length > 0);
}

/** 把一行语句塞进最小时机块体（顶层写语句是**非法位**，另有用例钉它不静默） */
const inTiming = (statement: string): string => `角色: 12\n时机 绝顶：\n\t${statement}\n`;

const line = (text: string): LineClass => {
  const [logical] = splitLogicalLines(text);
  return classifyLine(logical!);
};

const TRY_W = primaryWord('inline.tryStatement');
const ECHO_W = primaryWord('inline.engineEcho');
/** 写形 = 只读面显示形 ⇒ 两者共用这一个前缀 */
const PREFIX = `${TRY_W} ${ECHO_W} `;

/**
 * 九枚各自的引擎语法（名单真源 = `sugar-ident` 的 `TRY_CATCH_OPEN` ∪ `TRY_LIST_OPEN`）。
 *
 * 载荷一律**数据**：`*` / `$` 前缀、逗号尺寸、引号、算式里的 `=` 与 `<` 都不许被中文化或剥掉
 * ——改一个字符就改档（判据同 `JUMP` / `DATAFORM` / `#DIM`）。
 */
const NATIVES: readonly string[] = [
  // 六枚：配 `出错处理`（CATCH … ENDCATCH）
  'TRYCGOTO *先, LABEL:目标',
  'TRYCJUMP *退路, LABEL:2',
  'TRYCCALL FOO(A, 1)',
  'TRYCGOTOFORM $GO_BACK, TARGET',
  'TRYCJUMPFORM F_NAME(ARG)',
  'TRYCCALLFORM GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)',
  // 三枚：配 `ENDFUNC`
  'TRYCALLLIST F1, F2',
  'TRYGOTOLIST *A, *B',
  'TRYJUMPLIST FUNC(A)',
];

/** 同一批写形的四个变形（每一枚都针对一条"透传必须逐字"的越界面） */
const VARIANTS: readonly [string, string][] = [
  // 裸记号（无载荷）：引擎里合法（清单位写空），写形也须原样发回
  ['TRYCGOTO', '裸记号无载荷'],
  // 记号之后与载荷内部的**连续空白**照字面带走（透传不折叠空白）
  ['TRYCALLLIST   F1 ,  F2', '多重空格逐字'],
  // 载荷里的 `=` / `<` 是数据不是条件 ⇒ 不折成 `等于` / `不足`
  ['TRYCCALL FOO(A = 1, B < 2)', '载荷运算符不降糖'],
  // 引号内的 `;` 不是行尾注释（整串属载荷）
  ['TRYCCALLFORM FOO("甲;乙")', '引号内分号不当注释'],
  // 行尾注释随整行带走（本族写形吃的是注释剥离**之前**的整行内容）
  ['TRYCALLLIST F1, F2 ; 缺函数就整批跳过', '行尾注释随行'],
];

const ALL_NATIVES: readonly string[] = [...NATIVES, ...VARIANTS.map(([erb]) => erb)];

/* --------------------------- 一、词表登记与名单同源 --------------------------- */

describe('工包 F · TRY 系写形的词表与名单（登记 = 承诺写得回去）', () => {
  it('`试探` 已登记进词表且中文主形就是它（只读面那句"无写形"的欠账已还）', () => {
    expect(lookupKeyword(TRY_W), '词形即写形词头').toBe('inline.tryStatement');
    expect(primaryWord('inline.tryStatement')).toBe('试探');
  });

  it('词形与只读面的中性显示形**同一串**（显示出来的那串直接写得回去）', () => {
    for (const erb of NATIVES) {
      const shown = renderControlLine({ content: erb, indent: 0 });
      expect(shown, erb).toBe(`${PREFIX}${erb}`);
      // 显示层用词 == 写侧词头：`control.ts` 那枚私词与本包词表指同一枚（不许各叫一个）
      expect(shown!.startsWith(`${TRY_W} `), erb).toBe(true);
    }
  });

  it('写形认领的记号恰为 sugar-ident 那九枚（一张名单，不多一枚不漏一枚）', () => {
    const nine = [...new Set([...TRY_CATCH_OPEN, ...TRY_LIST_OPEN])].sort();
    expect(nine).toHaveLength(9);
    for (const kind of nine) {
      const cls = line(`${PREFIX}${kind} FOO(A, 1)`);
      expect(cls.kind, kind).toBe('tryStatement');
      expect(cls.kind === 'tryStatement' ? cls.engine : undefined, kind).toBe(kind);
    }
    // 引擎**单行语句**那几枚不在九枚内（归原生直通通道，本形不抢、也不许靠前缀扩张）
    for (const kind of ['TRYCALL', 'TRYCALLFORM', 'TRYJUMP', 'TRYGOTO', 'TRYGOTOFORM']) {
      expect(nine).not.toContain(kind);
      expect(line(`${PREFIX}${kind} FOO`).kind, kind).toBe('controlMalformed');
    }
  });
});

/* --------------------------- 二、round-trip 本体（逐字节） --------------------------- */

describe('工包 F · TRY 系九枚 round-trip：写形编译后逐字节回到引擎原文', () => {
  const errorsOf = (source: string): string[] =>
    svc()
      .transpile(source)
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`);

  for (const erb of ALL_NATIVES) {
    it(erb, () => {
      const source = inTiming(`${PREFIX}${erb}`);
      expect(errorsOf(source), `源：\n${source}`).toEqual([]);
      // 逐字节判据：产物里必须存在与引擎原文**一字不差**的那一行
      expect(productLines(svc().transpile(source).erb), source).toContain(erb);
    });
  }

  it('写形逐字节 = 产物，连载荷里的连续空白也不折叠（`原形` 回显的本分）', () => {
    const erb = 'TRYCALLLIST   F1 ,  F2';
    const lines = productLines(svc().transpile(inTiming(`${PREFIX}${erb}`)).erb);
    expect(lines.filter((l) => l.startsWith('TRYCALLLIST'))).toEqual([erb]);
  });

  it('行尾注释随整行进产物（原生直通同一条口径：注释一个字节不丢）', () => {
    const erb = 'TRYCALLLIST F1, F2 ; 缺函数就整批跳过';
    expect(productLines(svc().transpile(inTiming(`${PREFIX}${erb}`)).erb)).toContain(erb);
  });

  it('引擎原生记号那一行仍走原生直通（本批不扩面、不误伤既有通路）', () => {
    for (const erb of ['TRYCGOTO *先, LABEL:目标', 'TRYCALLLIST F1, F2']) {
      expect(line(erb).kind, erb).toBe('rawLine');
      expect(productLines(svc().transpile(inTiming(erb)).erb), erb).toContain(erb);
    }
  });
});

/* --------------------------- 三、块形与单行形（九枚各自语法） --------------------------- */

describe('工包 F · 块形（TRYC 六枚配 `出错处理`）与单行形（TRY*LIST 三枚）', () => {
  it('块形：写形头行 + `出错处理：` 块 ⇒ 产物四行逐字节、且顺序是配对顺序', () => {
    const head = 'TRYCCALLFORM M_KOJO_K12_回声';
    const source = `角色: 12\n时机 绝顶：\n\t${PREFIX}${head}\n\t出错处理：\n\t\t「这一段兜住。」\n\t出错处理结束\n`;
    const result = svc().transpile(source);
    expect(
      result.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`),
      `源：\n${source}`,
    ).toEqual([]);
    const lines = productLines(result.erb);
    const at = (needle: string): number => lines.indexOf(needle);
    expect(lines).toContain(head);
    expect(at(head)).toBeGreaterThanOrEqual(0);
    expect(at('CATCH')).toBeGreaterThan(at(head));
    expect(at('PRINTFORMW 「这一段兜住。」')).toBeGreaterThan(at('CATCH'));
    expect(at('ENDCATCH')).toBeGreaterThan(at('PRINTFORMW 「这一段兜住。」'));
  });

  it('单行形：TRYCALLLIST 一枚整行语句，产物就只有那一行（不配对、不吞后随行）', () => {
    const head = 'TRYCALLLIST F_A, F_B';
    const source = `角色: 12\n时机 绝顶：\n\t${PREFIX}${head}\n\t「台词照常走。」\n`;
    const lines = productLines(svc().transpile(source).erb);
    expect(lines).toContain(head);
    expect(lines).toContain('PRINTFORMW 「台词照常走。」');
    expect(lines.filter((l) => l === head)).toHaveLength(1);
  });

  it('随机候选位写 TRY 形：候选本身是一条语句，原样产、绝不静默丢行', () => {
    const head = 'TRYCGOTO 1, *先';
    const source = `角色: 12\n时机 绝顶：\n\t随机：\n\t\t${PREFIX}${head}\n\t\t「另一候选。」\n`;
    const result = svc().transpile(source);
    expect(
      result.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`),
      `源：\n${source}`,
    ).toEqual([]);
    expect(productLines(result.erb)).toContain(head);
  });
});

/* --------------------------- 四、fail-closed（认得词形 ≠ 猜得动写法） --------------------------- */

describe('工包 F · 残缺与越界写法不落台词、不产半成品', () => {
  const BAD: readonly string[] = [
    `${PREFIX}TRYCALL FOO`, // 名单外记号（引擎单行语句，归原生直通）
    `${PREFIX}trycgoto 1, *先`, // 小写记号（名单是引擎记号原文，逐字大写才算回显）
    `${PREFIX}NOPE FOO`, // 根本不是 TRY 记号
    `${TRY_W} ${ECHO_W}`, // 光杆回显标记（缺记号）
  ];

  for (const bad of BAD) {
    it(`${bad} ⇒ controlMalformed`, () => {
      expect(line(bad).kind, bad).toBe('controlMalformed');
    });
    it(`${bad} ⇒ 转译报 error 且产物里没有半枚 TRY 行`, () => {
      const source = inTiming(bad);
      const result = svc().transpile(source);
      const codes = result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
      expect(codes, `源：\n${source}`).toContain('statement-shape');
      expect(productLines(result.erb).some((l) => /^TRY[A-Z0-9_]*\b/.test(l)), result.erb).toBe(false);
    });
  }

  it('残缺回执把合法形与九枚名单逐条列给作者（诊断文本零硬编码词形）', () => {
    const cls = line(`${PREFIX}NOPE FOO`);
    const message = cls.kind === 'controlMalformed' ? cls.message : '';
    expect(message).toContain(TRY_W);
    expect(message).toContain(ECHO_W);
    for (const kind of [...TRY_CATCH_OPEN, ...TRY_LIST_OPEN]) expect(message, kind).toContain(kind);
  });

  it('`试探` 是日常中文动词：词后不接 `原形` 的散文照旧是台词（绝不当指令）', () => {
    for (const prose of [
      '试探 她的底线',
      '试探 原形之外的东西',
      `${TRY_W}`,
      '试探原形 TRYCGOTO 1, *先', // 词后无空白分隔（连写不算词形 + 余文）
    ]) {
      expect(line(prose).kind, prose).toBe('text');
    }
  });

  it('写在时机块外（顶层）不静默：报 error，且产物不含那行', () => {
    const source = `角色: 12\n${PREFIX}TRYCALLLIST F1\n时机 绝顶：\n\t「台词」\n`;
    const result = svc().transpile(source);
    expect(
      result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
      `源：\n${source}`,
    ).toContain('indent-mismatch');
    expect(productLines(result.erb).some((l) => l.startsWith('TRYCALLLIST'))).toBe(false);
  });
});

/* --------------------------- 五、读 ↔ 写回路闭合（显示形即写形） --------------------------- */

describe('工包 F · 读↔写回路：屏上那一串照抄回去就发得出去', () => {
  it('十四枚形（九枚 + 五变形）逐枚：显示形去掉词头 == 产物那一行，逐字节', () => {
    for (const erb of ALL_NATIVES) {
      const shown = renderControlLine({ content: erb, indent: 0 });
      expect(shown, erb).not.toBeNull();
      const written = shown!.slice(PREFIX.length);
      const source = inTiming(shown!);
      expect(
        svc()
          .transpile(source)
          .diagnostics.filter((d) => d.severity === 'error')
          .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`),
        `源：\n${source}`,
      ).toEqual([]);
      // 判据是「屏上写的 = 产物发的」：显示层自己做的空白归一（记号后那一段）不归本批红线，
      // 本批只对**写形 → 产物**逐字节负责（那条另有用例钉）。
      expect(productLines(svc().transpile(source).erb), shown!).toContain(written);
    }
  });
});

/* --------------------------- 六、格式化不改写形本体 --------------------------- */

describe('工包 F · 格式化只排版面，TRY 写形本体一个字符不动', () => {
  const STATEMENT = '试探 原形 TRYCALLLIST F1, F2 ; 缺函数就整批跳过';
  const source = `角色: 12\n时机 绝顶：\n\u3000\u3000${STATEMENT}\n`;

  it('全角缩进的写形行过格式化：语句本体（含载荷与行尾注释）逐字留在文中', () => {
    const formatted = formatText(source, 'kojo').text;
    expect(formatted).toContain(STATEMENT);
    // 幂等：第二遍不再产生任何 edit（本体没有可再"排"的东西）
    expect(computeFormatEdits(formatted, 'kojo'), formatted).toEqual([]);
  });

  it('格式化之后的文档照样逐字节发回引擎原文（排版不是改档）', () => {
    const formatted = formatText(source, 'kojo').text;
    expect(productLines(svc().transpile(formatted).erb)).toContain(
      'TRYCALLLIST F1, F2 ; 缺函数就整批跳过',
    );
  });
});

/* ------------------ 七、发版样例覆盖率预演（不依赖语料的那半） ------------------ */
/**
 * `sugar-releasecheck.transpile.test.ts` 的词闸（「词表里每个中文主形都得在发版样例里真写过」）
 * 挂语料才跑（`KOJO_SMOKE_PROJECT` 未设 ⇒ 整组 skip）。上一批的教训正是**词入表而样例没跟上**，
 * 红要等组长挂盘才看得见。⇒ 本组在**无语料**环境下预演同一件事，两半各钉一条：
 * ①样例里确有非注释行的 `试探 原形 …` 写法（词真的被用了，不是补注释）；
 * ②样例里那几行逐字节 round-trip（用了，而且用得回去）。
 */
describe('工包 F · 发版样例真用过写形（覆盖率闸的无语料预演）', () => {
  const fixture = readFileSync(
    new URL('../../../../fixtures/sugar/release-check.kojo', import.meta.url),
    'utf8',
  ).replace(/^\uFEFF/, '');

  /** 样例里的 TRY 写形行（剥注释行：`;` 开头不算"用过"，口径同覆盖率闸） */
  const usedLines = fixture
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => !l.trim().startsWith(';'))
    .filter((l) => new RegExp(`^[ \\t\\u3000]*${TRY_W}[ \\t\\u3000]+${ECHO_W}[ \\t\\u3000]+\\S`).test(l));

  it('发版样例里真写过 `试探 原形 …`（至少一枚九枚记号）', () => {
    expect(usedLines.length, '发版样例没用到 TRY 写形 ⇒ 覆盖率闸会报缺词').toBeGreaterThan(0);
  });

  it.each(usedLines.map((l) => [l.replace(/^[ \t\u3000]+/, '')] as const))(
    '样例那一行 %s 逐字节写得回去',
    (statement) => {
      const erb = statement.slice(PREFIX.length);
      const source = inTiming(statement);
      expect(
        svc()
          .transpile(source)
          .diagnostics.filter((d) => d.severity === 'error')
          .map((d) => `${d.code}@${d.loc?.line}: ${d.message}`),
        `源：\n${source}`,
      ).toEqual([]);
      expect(productLines(svc().transpile(source).erb), statement).toContain(erb);
    },
  );
});
