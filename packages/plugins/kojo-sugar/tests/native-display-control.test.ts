/**
 * ZH-C · 控制流与预处理行的中文显示形（表驱动 + 红线自证）。
 *
 * 这个文件是**系列红线**（`types.ts` 头注：预览屏上不许出现一整行原样 ERB）在单测层的自证。
 * 每一条正例都同时钉三件事，缺一不可：
 *
 * 1. `rendered !== null` —— 认得出（命中本层的封闭表）；
 * 2. `rendered !== 输入行` 且 `isVerbatimNativeLine(rendered, 输入行) === false` —— **不是原样交回**；
 * 3. `rendered === 钉值` —— 词形逐字钉住（改一个假名都算改口径，必须显形）。
 *
 * 另加两类自证：
 * - **`lookup` 缺席仍出中文**（关键字照翻；不许因为没名表就返 `null`，也不许因为没名表就留 ERB）；
 * - **未知指令返 `null`**（宁缺勿猜；表外的东西交给装配层的显式兜底）。
 *
 * 语料自证在 `KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 缺席时整组 skip（不为绿改钉值）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderControlLine } from '../src/native-display/control';
import { localizeNativeLine } from '../src/native-display/passes';
import { isVerbatimNativeLine } from '../src/native-display/types';
import { lookupKeyword } from '../src/keywords';
import { TRY_CATCH_OPEN, TRY_LIST_OPEN } from '../src/sugar-ident';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';
import type { NativeDisplayLookup } from '../src/native-display/types';

/** 族头别名桩（**语言层测试不依赖 adapter**；真表的自证在 eratw-adapter 的 family-alias.test.ts） */
const FAMILIES: Readonly<Record<string, string>> = { TFLAG: '时标', CFLAG: '角色标记', NOWEX: '现在' };
const LOOKUP: NativeDisplayLookup = {
  familyAlias: (family) => FAMILIES[family],
  slotCn: () => undefined,
};

/** 一行 → 显示形（缺省喂别名表） */
const show = (content: string, lookup: NativeDisplayLookup = LOOKUP): string | null =>
  renderControlLine({ content, indent: 0, lookup });

/** 无工程 / 无 adapter 形态（`lookup` 整个缺席，不是传 `undefined` 触发缺省值） */
const showBare = (content: string): string | null => renderControlLine({ content, indent: 0 });

/** [输入行原文, 钉住的中文显示形] */
type Case = readonly [string, string];

const BLOCKS: readonly Case[] = [
  ['IF TFLAG:193 = 1', '如果 时标：193 等于 1：'],
  ['IF TFLAG:193 == 1', '如果 时标：193 等于 1：'],
  ['IF CFLAG:TARGET:1088 >= 500', '如果 角色标记：TARGET:1088 至少 500：'],
  ['IF !(TFLAG:193 >= 5 && TFLAG:193 <= 10)', '如果 时标：193 不在 5 到 10：'],
  ['IF A > 0 && B < 2', '如果 A 超过 0 且 B 不足 2：'],
  ['IF A <= 1 || B >= 2', '如果 A 至多 1 或 B 至少 2：'],
  ['IF !TARGET', '如果 非 TARGET：'],
  ['IF A != 1', '如果 A 不等于 1：'],
  ['IF "TFLAG:1" == A', '如果 "TFLAG:1" 等于 A：'],
  ['ELSEIF TFLAG:193 == 2', '否则如果 时标：193 等于 2：'],
  ['ELSE', '否则：'],
  ['ENDIF', '如果结束'],
  ['SIF TARGET != 12', '如果 TARGET 不等于 12：'],
  ['SIF A : PRINTFORMW "x"', '如果 A 则 PRINTFORMW "x"'],
  ['SIF TFLAG:193 : CALL FOO', '如果 时标：193 则 CALL FOO'], // 变形：冒号形 + 语句侧原样（行内英文允许）
  ['SELECTCASE TFLAG:193', '当 时标：193：'],
  ['CASE 1 TO 5', '是 1 到 5：'],
  ['CASE 0, 1, 2', '是 0, 1, 2：'],
  ['CASE RESULT', '是 RESULT：'],
  ['CASEELSE', '否则：'],
  ['ENDSELECT', '当结束'],
];

const LOOPS: readonly Case[] = [
  ['FOR i = 0 TO 9', '循环 计数 i 从 0 到 9：'],
  ['FOR i = 1 TO 10 STEP 2', '循环 计数 i 从 1 到 10 步长 2：'],
  ['FOR LOCAL:0 = 0 TO LOCAL:5', '循环 计数 LOCAL:0 从 0 到 LOCAL:5：'],
  ['FOR i = 0 TO CHARANUM - 1', '循环 计数 i 从 0 到 CHARANUM - 1：'],
  ['NEXT', '循环结束'],
  ['WHILE TFLAG:193 != 0', '循环 当 时标：193 不等于 0：'],
  ['WHILE LOCAL < 10', '循环 当 LOCAL 不足 10：'],
  ['WEND', '循环结束'],
  ['REPEAT', '循环 无限：'], // 裸 `REPEAT`（不带参数）才是无限循环（盘上 0 处，但引擎合法）
  ['REPEAT LOCAL < 5', '循环 LOCAL 不足 5 次：'], // 义项：按参数指定的**次数**循环（`REPEAT (LOCAL<5)` = 0 或 1 次）
  ['repeat RESULT = 0', '循环 RESULT 等于 0 次：'], // 变形：小写 + 次数位裸 `=` 折 `等于`
  ['REPEAT VARSIZE("TSTR")', '循环 VARSIZE("TSTR") 次：'], // 盘上真形：次数段是函数调用串，逐字带走
  ['REND', '循环结束'],
  ['DO', '循环：'],
  ['do', '循环：'], // 变形：小写
  ['LOOP', '循环结束'],
  ['LOOP 1', '循环结束 当 1'], // 盘上真形：`DO` 的闭合 210/210 都带条件（裸形零例）
  ['LOOP LOCAL < 80', '循环结束 当 LOCAL 不足 80'],
  ['loop ARG:1 > 0', '循环结束 当 ARG:1 超过 0'], // 变形：小写记号 + `>` → `超过`（本文件既有运算符形）
  ['LOOP ROOMMATE > 0 && ROOMMATE < CHARANUM - 1', '循环结束 当 ROOMMATE 超过 0 且 ROOMMATE 不足 CHARANUM - 1'],
  ['i + 1', '步进 i 加 1'],
  ['i - 1', '步进 i 减 1'],
  ['i += 1', '步进 i 加 1'],
  ['i -= 1', '步进 i 减 1'],
  ['LOCAL:2 += 3', '步进 LOCAL:2 加 3'],
  ['BEST + 1', '步进 BEST 加 1'],
];

const JUMPS: readonly Case[] = [
  ['GOTO $招待', '跳到 招待'],
  ['GOTO *RETRY', '跳到 RETRY'],
  ['JUMP GET_TARGET(A, 1)', '函数跳转 GET_TARGET(A, 1)'], // 函数跳转与标签跳转**两形**：余文逐字透传
  ['jump GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)', '函数跳转 GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)'], // 盘上真形（小写记号）
  ['BREAK', '跳出循环'],
  ['break ; 中断循环', '跳出循环 ; 中断循环'], // 变形：小写 + 行尾注释
  ['CONTINUE', '跳过本轮'],
  ['continue', '跳过本轮'], // 变形：小写
  ['RESTART', '重跑本轮'],
  ['restart', '重跑本轮'], // 变形：小写
  ['CATCH', '出错处理：'],
  ['ENDCATCH', '出错处理结束'],
  ['$招待', '标签 招待'],
  ['$RETRY', '标签 RETRY'],
];

const PREPROCESSOR: readonly Case[] = [
  ['#DIM BEST 10', '声明数组 BEST 大小 10'],
  ['#DIM BEST', '声明数组 BEST'],
  ['#DIMS LOCALS 10', '声明字符串数组 LOCALS 大小 10'],
  ['#DIMS LOCALS', '声明字符串数组 LOCALS'], // 变形：无规模 ⇒ 只翻类不给假大小
  ['#GLOBAL G 5', '声明全局数组 G 大小 5'],
  ['#global G 5', '声明全局数组 G 大小 5'], // 变形：小写指令（记号归一大写、义项同一）
  ['#LOCALSIZE LOCAL 10', '声明局部数组规模 LOCAL 大小 10'],
  ['#LOCALSIZE LOCAL', '声明局部数组规模 LOCAL'], // 变形：无规模
  ['#LOCALSSIZE LOCALS 10', '声明局部字符串规模 LOCALS 大小 10'],
  ['#localssize LOCALS 10', '声明局部字符串规模 LOCALS 大小 10'], // 变形：小写
  ['#FUNCTION', '声明值函数'],
  ['#FUNCTION GET_TARGET(LOCAL)', '声明值函数 GET_TARGET(LOCAL)'],
  ['#FUNCTIONS', '声明字符串值函数'],
  ['#FUNCTIONS GET_STR$(LOCAL)', '声明字符串值函数 GET_STR$(LOCAL)'], // 变形：带签名
  ['#SFUNCTION STATIC_A()', '预处理 SFUNCTION STATIC_A()'],
  ['#TESTMEMORY 1', '预处理 TESTMEMORY 1'],
  ['#TESTMEMORY', '预处理 TESTMEMORY'], // 变形：裸记号
  ['#XFUNCTION', '预处理 XFUNCTION'],
];

const WITH_TRAILING_COMMENT: readonly Case[] = [
  ['IF A = 1 ; 计数判定', '如果 A 等于 1： ; 计数判定'],
  ['ENDIF ; 到这里为止', '如果结束 ; 到这里为止'],
  ['#DIM BEST 10 ; 上限', '声明数组 BEST 大小 10 ; 上限'],
  ['JUMP GET_TARGET(A) ; 跳函数', '函数跳转 GET_TARGET(A) ; 跳函数'], // 逐字透传：括号实参原样留着，注释另挂行尾
];

/**
 * TRY 系九枚（工包 D 的中性显示形）。
 *
 * 名单 = `sugar-ident.ts` 的 `TRY_CATCH_OPEN`（六枚，配 `CATCH`）∪ `TRY_LIST_OPEN`
 * （三枚，配 `ENDFUNC`）；`keywords.ts:213` 那句"无写形、仍走兜底"说的就是这九枚。
 * 钉值刻意写成 `试探 原形 <记号> <原文>`：**记号逐字回显**（义项档位不替读者下结论）、
 * 载荷逐字带走（不剥 `$`/`*`、不中文化运算符），与 `JUMP` / `DATAFORM` 同一判据。
 */
const TRY_FAMILY: readonly Case[] = [
  // 六枚：配 `出错处理`（CATCH）
  ['TRYCGOTO *先, LABEL:目标', '试探 原形 TRYCGOTO *先, LABEL:目标'],
  ['TRYCJUMP *退路, LABEL:2', '试探 原形 TRYCJUMP *退路, LABEL:2'],
  ['TRYCCALL FOO(A, 1)', '试探 原形 TRYCCALL FOO(A, 1)'],
  ['TRYCGOTOFORM $GO_BACK, TARGET', '试探 原形 TRYCGOTOFORM $GO_BACK, TARGET'],
  ['TRYCJUMPFORM F_NAME(ARG)', '试探 原形 TRYCJUMPFORM F_NAME(ARG)'],
  ['TRYCCALLFORM GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)', '试探 原形 TRYCCALLFORM GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)'],
  // 三枚：配 `函数结束`（ENDFUNC）
  ['TRYCALLLIST F1, F2', '试探 原形 TRYCALLLIST F1, F2'],
  ['TRYGOTOLIST *A, *B', '试探 原形 TRYGOTOLIST *A, *B'],
  ['TRYJUMPLIST FUNC(A)', '试探 原形 TRYJUMPLIST FUNC(A)'],
  // 裸记号（无载荷）也给中性形：这九枚是**已知结构**，落兜底就是谎报"没读懂"
  ['TRYCGOTO', '试探 原形 TRYCGOTO'],
  ['TRYCALLLIST', '试探 原形 TRYCALLLIST'],
  // 变形：小写记号（名单按归一大写命中，回显用规范大写）
  ['trycgotoform FOO(A)', '试探 原形 TRYCGOTOFORM FOO(A)'],
  ['trygotolist *A, *B', '试探 原形 TRYGOTOLIST *A, *B'],
  // 变形：载荷里的 `=` / `<` 不折成中文运算符（那是数据不是条件）
  ['TRYCCALL FOO(A = 1, B < 2)', '试探 原形 TRYCCALL FOO(A = 1, B < 2)'],
  // 变形：行尾注释照旧挂回行尾
  ['TRYCALLLIST F1, F2 ; 缺函数就整批跳过', '试探 原形 TRYCALLLIST F1, F2 ; 缺函数就整批跳过'],
];

/** 全表（红线自证与条数下限都对着这一份，别只测其中一族） */
const ALL: readonly Case[] = [...BLOCKS, ...LOOPS, ...JUMPS, ...PREPROCESSOR, ...WITH_TRAILING_COMMENT, ...TRY_FAMILY];

/** 本层的成套词形（块头 = keywords.ts 主形；闭合 = `<块头词> + 结束`；循环/跳转/声明是本层新增族） */
const KEYWORD_SHAPES: readonly Case[] = [
  ['IF 1 = 1', '如果 1 等于 1：'],
  ['ELSEIF 1 = 2', '否则如果 1 等于 2：'],
  ['ELSE', '否则：'],
  ['ENDIF', '如果结束'],
  ['SELECTCASE 1', '当 1：'],
  ['CASE 2', '是 2：'],
  ['ENDSELECT', '当结束'],
  ['WHILE 1 = 1', '循环 当 1 等于 1：'],
  ['WEND', '循环结束'],
  ['CATCH', '出错处理：'],
  ['ENDCATCH', '出错处理结束'],
];

describe('ZH-C · 块（IF / ELSEIF / ELSE / ENDIF / SIF / SELECTCASE / CASE / CASEELSE / ENDSELECT）', () => {
  it.each(BLOCKS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 循环（糖层不做循环语法，显示层不许留 ERB）', () => {
  it.each(LOOPS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });

  it('`LOOP` 一枚两形各自判据：整行只有记号 = 收束行；带体 = 条件尾随形', () => {
    // 裸形走 `STANDALONE`（`循环结束`），带体形走 `OPENERS`（`循环结束 当 …`）——两表都在时
    // 由「整行是否只有那枚记号」分诊，不看尾部标点
    expect(show('LOOP')).toBe('循环结束');
    expect(show('LOOP 1')).toBe('循环结束 当 1');
  });

  it('条件位为空（记号后只剩分隔符）⇒ 形态不认识，返 null 落兜底段（空表达式不猜）', () => {
    for (const src of ['LOOP:', 'LOOP :']) {
      expect(show(src), src).toBeNull();
      const assembled = localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP });
      if (assembled !== null) expect(isVerbatimNativeLine(assembled, src), src).toBe(false);
    }
  });
});

/* ------------------------------- 显示形写回自证 ------------------------------- */

/**
 * **显示形 ⇒ 源 ⇒ 产物**必须逐字节回到原始那一行（闭合"读了但写不回去"这条缺口）。
 *
 * 链路就是产品链路：预览上屏用的显示层（`renderControlLine`）产出的串，当作 `.kojo` 源
 * 经 `classifyLine` → parser 配对 → codegen 发射，产物那一行与**原始 ERB 行**逐字相等。
 * 体刻意只放一枚 `跳出循环`（`BREAK`）：循环族自证的是闭合词那一行，正文归其它能力线。
 */
describe('ZH-C · 显示形当源写回 ⇒ 产物逐字节等于原始行（`DO … LOOP <条件>` 一族）', () => {
  const transpile = (body: string): string =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(body).erb;

  /**
   * 写回样本只用**引擎全局白名单**里的名字（`LINECOUNT` / `ARG`）与数字：
   * `LOCAL` 按 `engine-globals.ts` 的入库判据③不收（须由段块糖自己分配），
   * 在条件位读它会报 `unknown-identifier`——那是读名的口径，不是本族的缺口，
   * **不为此放宽白名单**。
   */
  const WRITE_BACK: readonly string[] = ['LOOP', 'LOOP 1', 'LOOP LINECOUNT < 80', 'LOOP ARG:1 > 0'];

  it.each(WRITE_BACK)('%s', (original) => {
    const shown = show(original);
    expect(shown, original).not.toBeNull();
    const src = `角色: 12\n时机 绝顶：\n\t循环：\n\t\t跳出循环\n\t${shown}\n`;
    const result = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error'), src).toEqual([]);
    const lines = result.erb
      .split('\n')
      .map((l) => l.replace(/^\t+/, ''))
      .filter((l) => l.length > 0);
    // 整块三行按序出现：`DO` / `BREAK` / 那一枚**原始**闭合行
    expect(lines.join('\n'), `${original}（显示形=${shown}）`).toContain(['DO', 'BREAK', original].join('\n'));
  });

  it('写回不是空话：把显示形里的条件改一个字符，产物就不再等于原始行', () => {
    const shown = show('LOOP 1')!;
    const broken = shown.replace(' 当 ', ' 且 ');
    expect(transpile(`角色: 12\n时机 绝顶：\n\t循环：\n\t\t跳出循环\n\t${broken}\n`)).not.toContain('LOOP 1');
  });
});

describe('ZH-C · 跳转与出口', () => {
  it.each(JUMPS)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });

  /**
   * **反证**（缺陷②b）：`GOTO` 与 `JUMP` 在引擎里是两个记号（`GOTO 名` = 标签跳转，
   * `JUMP` = 函数跳转），从前两枚都渲染成 `跳到 <目标>` ⇒ 作者照预览写回去就换了记号、
   * 改了行为。两侧必须**不同形**，且 `JUMP` 那一形不许对余文做任何加工。
   */
  it('`GOTO` 与 `JUMP` 两形不撞：目标不同形、余文逐字（不剥前缀、不中文化运算符）', () => {
    expect(show('GOTO LABEL1')).toBe('跳到 LABEL1');
    expect(show('JUMP LABEL1')).toBe('函数跳转 LABEL1');
    expect(show('JUMP LABEL1'), '两枚撞成同一形就是本条要抓的事故').not.toBe(show('GOTO LABEL1'));
    // 逐字：`$` / `*` 前缀不剥（`showTarget` 那套归一属标签跳转，函数调用串套它就改档了）
    expect(show('JUMP $GO_BACK')).toBe('函数跳转 $GO_BACK');
    // 逐字：余文里的 `=` 不折成 `等于`（那不是条件位，是函数实参）
    expect(show('JUMP FOO(A = 1)')).toBe('函数跳转 FOO(A = 1)');
    // 逐字：逗号 / 引号 / 空格一个字符都不动（盘上真形）
    expect(show('JUMP GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)')).toBe(
      '函数跳转 GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)',
    );
  });
});

describe('ZH-C · 预处理行（#DIM / #DIMS / #GLOBAL / #LOCALSIZE / #LOCALSSIZE / #FUNCTION…）', () => {
  it.each(PREPROCESSOR)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
  });

  it('认得记号但不担保义项的指令 ⇒ 只翻「预处理」这一层，记号原样保留（翻类不翻义）', () => {
    expect(show('#SFUNCTION A()')).toBe('预处理 SFUNCTION A()');
    expect(show('#XFUNCTION')).toBe('预处理 XFUNCTION');
  });
});

/**
 * 工包 D · TRY 系九枚的**中性显示形**（`试探 原形 <记号> <原文>`）。
 *
 * 三条独立判据各挡一类越界：
 * - **只读面**：显示形**不是**写形——`试探` 不进 `KEYWORDS`，把它当 `.kojo` 源喂写侧也发不出 TRY 语句；
 * - **分界**：`statement.ts` 已认领的 `TRYCALL` / `TRYCALLFORM` / `TRYJUMP`（单行语句、不在九枚内）
 *   零改动——本层的名单是 `sugar-ident` 的两张集合，不做 `startsWith('TRY')` 那种粗匹配；
 * - **红线**：命中即与源行逐字不等（`停用 · 原文` 那一档的结构性自证，兜底形不再出现在这九枚上）。
 */
describe('工包 D · TRY 系九枚的中性显示形（只读面，无写形）', () => {
  it.each(TRY_FAMILY)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).not.toBeNull();
    expect(got, src).not.toBe(src);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
    expect(got, src).toBe(want);
    // 兜底形不再出现在这九枚上（装配层拿得到中文显示形就不会走 `未识别语句`）
    expect(localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP }), src).not.toContain('未识别语句');
  });

  it('显示形**不靠往 KEYWORDS 加词**实现（`试探` 未登记 = 承诺不了写形）', () => {
    expect(lookupKeyword('试探'), '写形归工包 F；本批不许往词表塞只读面的词').toBeUndefined();
  });

  it('把显示形当 `.kojo` 源写回 ⇒ 发不出 TRY 语句（写侧通路确实不存在）', () => {
    const shown = show('TRYCGOTO *先, LABEL:目标')!;
    const result = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(
      `角色: 12\n时机 绝顶：\n\t${shown}\n`,
    );
    const emitted = result.erb.split('\n').map((l) => l.trim());
    expect(emitted.some((l) => /^TRY[A-Z0-9_]*\b/.test(l)), result.erb).toBe(false);
  });

  /**
   * `statement.ts` 的 `CALL_VERBS` 认领了这三枚（单行语句、不开块）⇒ 本层**不抢**，
   * 装配层读到的仍是 `'尝试调用 …'` 那一形（pass 顺序 = 优先级，工包 D 零改动）。
   */
  it('TRYCALL / TRYCALLFORM / TRYJUMP 归 statement 层，本层弃权', () => {
    for (const src of ['TRYCALL FOO', 'TRYCALLFORM FOO(A)', 'TRYJUMP FOO']) {
      expect(show(src), src).toBeNull();
      expect(localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP }), src).not.toContain('原形');
      expect(localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP }), src).not.toContain('未识别语句');
    }
  });

  /**
   * `TRYGOTO` / `TRYGOTOFORM`（引擎里是单行语句、**不在这九枚内**，statement 层也没有它们的动词）
   * 仍走兜底形——本批刻意不扩大认领面：钉住"它们还在兜底里"这个事实，归因由
   * `packages/kernel/tests/sugar-projection.corpus.test.ts` 的 `tryOther` 桶负责读数。
   */
  it('九枚之外的 TRY 记号本层不认领（口径不许靠前缀扩张）', () => {
    for (const src of ['TRYGOTO *先', 'TRYGOTOFORM $GO_BACK, TARGET']) {
      expect(show(src), src).toBeNull();
    }
  });

  /**
   * **名单同源**：显示面认领的记号 = `sugar-ident` 的 `TRY_CATCH_OPEN ∪ TRY_LIST_OPEN`（九枚），
   * 一张不多一张不少——真源加了第十枚而本层没跟上，这条立刻显形（而不是让兜底悄悄变厚）。
   */
  it('认领的记号恰为 sugar-ident 那九枚（名单同源，不多抄一枚也不漏一枚）', () => {
    const nine = [...new Set([...TRY_CATCH_OPEN, ...TRY_LIST_OPEN])].sort();
    expect(nine).toHaveLength(9);
    for (const kind of nine) {
      const src = `${kind} FOO(A, 1)`;
      expect(show(src), src).toBe(`试探 原形 ${kind} FOO(A, 1)`);
    }
    // 九枚之外、statement 层也没认领的那两枚必须**不在**名单里（防止有人图省事改成 startsWith('TRY')）
    for (const kind of ['TRYGOTO', 'TRYGOTOFORM', 'TRYCALL', 'TRYCALLFORM', 'TRYJUMP']) {
      expect(nine).not.toContain(kind);
    }
  });
});

describe('ZH-C · 行尾注释随行保留（不属于语句体，也不许被吞进条件）', () => {
  it.each(WITH_TRAILING_COMMENT)('%s', (src, want) => {
    const got = show(src);
    expect(got, src).toBe(want);
  });
});

describe('ZH-C · 成套词形一眼成套（收束 = `<块头词> + 结束`）', () => {
  it.each(KEYWORD_SHAPES)('%s', (src, want) => {
    expect(show(src)).toBe(want);
  });

  it('闭合行与开块行共用同一块头词', () => {
    expect(show('IF A = 1')?.startsWith('如果')).toBe(true);
    expect(show('ENDIF')).toBe('如果结束');
    expect(show('SELECTCASE A')?.startsWith('当')).toBe(true);
    expect(show('ENDSELECT')).toBe('当结束');
    expect(show('WHILE A = 1')?.startsWith('循环 当')).toBe(true);
    expect(show('WEND')).toBe('循环结束');
  });
});

describe('ZH-C · 红线全表自证（整行逐字相等 = 失败）', () => {
  it('每一条命中都非空、都与输入行逐字不等、都含中文词形', () => {
    for (const [src] of ALL) {
      const got = show(src);
      expect(got, src).not.toBeNull();
      expect(got, src).not.toBe(src);
      expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
      expect(got ?? '', src).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    }
  });

  it('正例条数下限（本文件的自证面不许缩水）', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(40);
  });

  it('装配层接受本层的每一行（原样返回会被 `localizeNativeLine` 拒掉）', () => {
    for (const [src, want] of ALL) {
      expect(localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP }), src).toBe(want);
    }
  });
});

describe('ZH-C · lookup 缺席 ⇒ 只做语言层（关键字照翻，整行仍是中文形）', () => {
  const NO_TABLE: readonly Case[] = [
    ['IF TFLAG:193 == 1', '如果 TFLAG:193 等于 1：'],
    ['WHILE A < B', '循环 当 A 不足 B：'],
    ['SELECTCASE NOWEX:1', '当 NOWEX:1：'],
    ['ENDIF', '如果结束'],
    ['GOTO $X', '跳到 X'],
    ['#DIM A 10', '声明数组 A 大小 10'],
    ['CASE 1 TO 5', '是 1 到 5：'],
  ];

  it.each(NO_TABLE)('%s', (src, want) => {
    const got = showBare(src);
    expect(got, src).toBe(want);
    expect(isVerbatimNativeLine(got ?? '', src), src).toBe(false);
  });

  it('别名表只换族头字面，查不到的族名原样保留（不猜）', () => {
    expect(show('IF NOTAFAMILY:3 = 1')).toBe('如果 NOTAFAMILY:3 等于 1：');
    expect(show('IF TFLAG:193 = 1 && NOTAFAMILY:3 = 2')).toBe('如果 时标：193 等于 1 且 NOTAFAMILY:3 等于 2：');
  });
});

describe('ZH-C · 表里没有的指令 ⇒ null（宁缺勿猜）', () => {
  const UNKNOWN: readonly string[] = [
    'PRINTFORMW 你好',
    'TFLAG:193 = 1',
    'LOCAL = 5',
    'SHIRO = 1',
    '!SHIRO', // 假前缀：`!` 不是标识符起点，HEAD_RE 结构上进不来
    '!SHIRO TARGET = 1',
    'CALL K13_A',
    'DIM A 10',
    '#DEFINE MAX 5',
    '#DIMF A 10',
    '#INCLUDE "A.ERB"',
    'ONERROR',
    'IF',
    'ELSEIF',
    'SELECTCASE',
    'CASE',
    'WHILE',
    'SIF',
    'FOR i = 0',
    'FOR i TO 5',
    'GOTO',
    'JUMP',
    '$',
    'NEXT NEXT',
    'ENDIF 1',
    'REND REND',
    'i + 1 + 2',
    '@BEGIN_MAIN',
    '; 整行注释本来就是给人读的',
    ';--- 段落分隔线 ---',
    '',
  ];

  it.each(UNKNOWN)('%s', (src) => {
    expect(show(src)).toBeNull();
    // 本层**弃权**（返 `null`）；装配层若命中也只可能是别的 pass 给的中文形，绝不许是原样
    const assembled = localizeNativeLine({ content: src, indent: 0, lookup: LOOKUP });
    if (assembled !== null) expect(isVerbatimNativeLine(assembled, src), src).toBe(false);
  });
});

/* ------------------------------- 语料自证 ------------------------------- */

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 盘上最多取这么多份 `.ERB`（自证判据，不是覆盖率尺子；取满即止） */
function collectErb(root: string, out: string[], limit: number): void {
  if (out.length >= limit || !existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = join(root, entry.name);
    if (entry.isDirectory()) collectErb(full, out, limit);
    else if (/\.erb$/i.test(entry.name)) out.push(full);
  }
}

const corpusCase = SMOKE === undefined ? describe.skip : describe;

corpusCase('ZH-C · 真盘自证（凡本层命中的行，显示形必与原文逐字不同）', () => {
  it('扫语料 `.ERB`：命中数 > 0 且红线 0 命中', () => {
    const files: string[] = [];
    collectErb(join(SMOKE as string, 'ERB'), files, 40);
    let hits = 0;
    let checked = 0;
    for (const file of files) {
      // 语料是 CP932；这里只验 ASCII 控制行的**逐字不等**，故按单字节读入即可（不参与任何写回）
      const text = readFileSync(file, 'latin1');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0) continue;
        const got = renderControlLine({ content: line, indent: 0 });
        if (got === null) continue;
        hits += 1;
        checked += isVerbatimNativeLine(got, line) ? 1 : 0;
      }
    }
    expect(hits).toBeGreaterThan(0);
    expect(checked).toBe(0);
  });
});
