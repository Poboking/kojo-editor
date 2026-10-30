/**
 * 循环 / 跳转 / 数据表的**写侧语法**（`.kojo` → ERB）。
 *
 * 这一族的成立条件只有一个：**写形与显示形同源**——词形从 `keywords.ts` 取，显示层
 * （`native-display/control.ts`）取的是同一批串。本文件因此只钉两件事：
 *
 *   ① 每种合法写法产出的 ERB **逐字节**是什么（含缩进——断言直接对产物串做子串比对，
 *      不拆行、不去缩进，这样"配平但缩进错"这类事故不会被断言口径放过）；
 *   ② 结构残缺 / 语义含糊的写法 **fail-closed**：报 error、**不产半成品**，
 *      且绝不回落成文本行（回落 = 把控制语句当台词打印出去，违铁律 4「内核不静默」）。
 *
 * 闭合词配对（`NEXT` / `WEND` / `REND` / `LOOP`）由**开块模态**决定、作者写法上只有一条
 * `循环结束`——那张配对表就是本文件的主断言对象。唯一的例外是 `DO` 那一族的**尾随条件**
 * （`循环结束 当 <条件>` → `LOOP <条件>`）：盘上 `DO` 的闭合 210/210 都带条件、裸形零例，
 * 所以尾随条件不是装饰而是那一族的正身（判据见 `写侧-A2`）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const errsOf = (src: string): SugarDiagnostic[] => svc().transpile(src).diagnostics.filter((d) => d.severity === 'error');
const codesOf = (src: string): string[] => errsOf(src).map((d) => d.code);
const productOf = (src: string): string => svc().transpile(src).erb;

/** 正文落在 `时机 绝顶：` 的函数体内（stub 表 → 正文缩进 1 枚 TAB） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/**
 * 产物里必须**逐字节**出现这一段（含 TAB 缩进与换行）。
 *
 * `L(n, text)` = n 枚 TAB 的一行。用它而不是 `toContain(text)`：本批的验收口径是
 * 「产物与原生 ERB 行等价」，缩进也是产物行的一部分。
 */
const L = (indent: number, text: string): string => '\t'.repeat(indent) + text;
const seq = (...rows: string[]): string => rows.join('\n');
const has = (src: string, ...rows: string[]): void => {
  const block = seq(...rows);
  expect(productOf(src), block).toContain(block);
};

/* ============================ A. 循环四族 ============================ */

describe('写侧-A · 循环块：一条 `循环结束`，闭合词由开块模态决定', () => {
  it('计数形 → `FOR <变量>, <起>, <止>` + `NEXT`（逗号形＝语料主流形 3,809:1）', () => {
    const src = doc(seq(L(1, '循环 计数 LOCAL 从 0 到 5：'), L(2, '「一轮」'), L(1, '循环结束')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'FOR LOCAL, 0, 5'), L(2, 'PRINTFORMW 「一轮」'), L(1, 'NEXT'));
  });

  it('带步长 → 第四参数（语料形 `FOR COUNT, 6, 1, -1`）', () => {
    const src = doc(seq(L(1, '循环 计数 COUNT 从 6 到 1 步长 -1：'), L(2, '「倒数」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'FOR COUNT, 6, 1, -1'), L(2, 'PRINTFORMW 「倒数」'), L(1, 'NEXT'));
  });

  it('当形 → `WHILE <条件>` + `WEND`（条件走既有降糖：中文运算符还原成引擎记号）', () => {
    const src = doc(
      seq(
        L(1, '循环 当 LINECOUNT 不足 ARG：'),
        L(2, '步进 LINECOUNT 加 1'),
        L(2, '跳出循环'),
        L(1, '循环结束'),
      ) + '\n',
    );
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'WHILE LINECOUNT < ARG'), L(2, 'LINECOUNT + 1'), L(2, 'BREAK'), L(1, 'WEND'));
  });

  it('次数形 → `REPEAT <表达式>` + `REND`（官方义项：按参数指定的**次数**循环）', () => {
    const src = doc(seq(L(1, '循环 3 次：'), L(2, '「三遍」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'REPEAT 3'), L(2, 'PRINTFORMW 「三遍」'), L(1, 'REND'));
  });

  it('次数形带算式 ⇒ 与 `如果` 同一条降糖管线（`等于` 折回 `==`）', () => {
    const src = doc(seq(L(1, '循环 RESULT 等于 0 次：'), L(2, '「一轮」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'REPEAT RESULT == 0'), L(2, 'PRINTFORMW 「一轮」'), L(1, 'REND'));
  });

  it('无限形 ⇒ **裸** `REPEAT` + `REND`（不带参数才是无限循环；盘上 0 处但引擎合法）', () => {
    const src = doc(seq(L(1, '循环 无限：'), L(2, '「直到跳出」'), L(2, '跳出循环')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'REPEAT'), L(2, 'PRINTFORMW 「直到跳出」'), L(2, 'BREAK'), L(1, 'REND'));
  });

  it('裸形 → `DO` + `LOOP`', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '「死循环」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'DO'), L(2, 'PRINTFORMW 「死循环」'), L(1, 'LOOP'));
  });

  it('收束行**可选**：不写 `循环结束` 也产配对的 `NEXT`（缩进收口是糖的既有纪律）', () => {
    const src = doc(seq(L(1, '循环 计数 I 从 0 到 3：'), L(2, '「三遍」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'FOR I, 0, 3'), L(2, 'PRINTFORMW 「三遍」'), L(1, 'NEXT'));
  });

  it('收束行必须与块头**同缩进**：写在更深层 = 缩进错误，不静默当成第二条收束', () => {
    const src = doc(seq(L(1, '循环 计数 I 从 0 到 3：'), L(2, '「三遍」'), L(2, '循环结束')) + '\n');
    expect(codesOf(src)).toContain('indent-mismatch');
  });

  it('循环变量**逐字**保留（引擎写的槽，不查字典）：带位引用的 `LOCAL:11` 原样进产物', () => {
    const src = doc(seq(L(1, '循环 计数 LOCAL:11 从 0 到 2：'), L(2, '「两遍」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'FOR LOCAL:11, 0, 2'));
  });

  it('循环套块、块套循环都成：闭合词各归各层', () => {
    const src = doc(
      seq(
        L(1, '循环 计数 I 从 0 到 2：'),
        L(2, '如果 TARGET 等于 1：'),
        L(3, '「一」'),
        L(2, '否则：'),
        L(3, '「多」'),
        L(1, '循环结束'),
      ) + '\n',
    );
    expect(errsOf(src)).toEqual([]);
    has(
      src,
      L(1, 'FOR I, 0, 2'),
      L(2, 'IF TARGET == 1'),
      L(3, 'PRINTFORMW 「一」'),
      L(2, 'ELSE'),
      L(3, 'PRINTFORMW 「多」'),
      L(2, 'ENDIF'),
      L(1, 'NEXT'),
    );
  });
});

/* ============================ A2. `DO` 的尾随条件闭合 ============================ */

/**
 * 真语料读数（`C:\game\eratw-画蛇添足版eratw4.980`，只读实测）：`DO` 开块 **210** 处，
 * 闭合形 `LOOP <表达式>` **210** 处，裸 `LOOP` **0** 处。
 *
 * 所以这一族的判据不是"锦上添花的可选项"：写不出 `LOOP <条件>`，`循环：` 产的那个裸形
 * 在盘上根本没有对应物；读得到的 210 行也只能落兜底段。中文写形 = `循环结束 当 <条件>`
 * （`当` 复用既有词形 `block.when`，零新词）。
 */
describe('写侧-A2 · 循环闭合行的尾随条件（`循环结束 当 <条件>` ⇄ `LOOP <条件>`）', () => {
  it('①`循环：` … `循环结束 当 1` → `DO` … `LOOP 1` 逐字节（盘上真形，不是裸 `LOOP`）', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '「一轮」'), L(1, '循环结束 当 1')) + '\n');
    expect(errsOf(src)).toEqual([]);
    // 整块三行按顺序逐字节出现 ⇒ 既验闭合词带条件，也验缩进与裸形 `LOOP` 没有混进来
    has(src, seq(L(1, 'DO'), L(2, 'PRINTFORMW 「一轮」'), L(1, 'LOOP 1')));
  });

  it('②条件是中文运算符形 ⇒ 与 `如果` 同一条降糖管线（`不足` → `<`）', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '步进 LINECOUNT 加 1'), L(1, '循环结束 当 LINECOUNT 不足 80')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'DO'), L(2, 'LINECOUNT + 1'), L(1, 'LOOP LINECOUNT < 80'));
  });

  it('②b长尾条件形（`且` / `超过` / 带索引实参）也还原成引擎记号', () => {
    const src = doc(
      seq(
        L(1, '循环：'),
        L(2, '跳出循环'),
        L(1, '循环结束 当 ARG:1 超过 0 且 TARGET 等于 1'),
      ) + '\n',
    );
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'LOOP ARG:1 > 0 && TARGET == 1'));
  });

  it.each([
    ['计数形', [L(1, '循环 计数 I 从 0 到 3：'), L(2, '「一轮」')], '循环 计数 <变量> …：'],
    ['当形', [L(1, '循环 当 LINECOUNT 不足 3：'), L(2, '「一轮」')], '循环 当 <条件>：'],
    ['次数形', [L(1, '循环 3 次：'), L(2, '「一轮」')], '循环 <表达式> 次：'],
    ['无限形', [L(1, '循环 无限：'), L(2, '「一轮」')], '循环 无限：'],
  ])('③%s 的收束行带尾随条件 ⇒ error，且该块一条字节都不产（`NEXT`/`WEND`/`REND` 不吃条件）', (name, body, headForm) => {
    const src = doc(seq(...body, L(1, '循环结束 当 1')) + '\n');
    const errs = errsOf(src);
    expect(errs.length, name).toBeGreaterThan(0);
    // 配对不配 = **形态**不认识（不是「块内无内容」）⇒ 码必须跟着这件事走
    expect(errs[0]!.code, name).toBe('statement-shape');
    // 回执要点名三件事：合法形是哪一形、本块块头是哪一形、该怎么改（指回块头写法）
    expect(errs[0]!.message, name).toContain('循环结束 当 <条件>');
    expect(errs[0]!.message, name).toContain(headForm);
    expect(errs[0]!.message, name).toContain('循环：');
    const erb = productOf(src);
    // 开块词 / 闭合词 / 块体行**全部**不许出现（不拼半块循环，同数据表 `_invalid` 的口径）
    for (const token of ['FOR', 'WHILE', 'REPEAT', 'DO', 'NEXT', 'WEND', 'REND', 'LOOP', 'PRINTFORMW']) {
      expect(erb, `${name}：产物不该含 ${token}`).not.toContain(token);
    }
  });

  it('④只写 `循环结束 当`（空条件）⇒ 残缺回执，不静默当收束行吃掉', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '「一轮」'), L(1, '循环结束 当')) + '\n');
    const errs = errsOf(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.message.includes('循环结束'))).toBe(true);
  });

  it('④b尾随别的词 / 行尾带冒号同样是残缺回执（合法形逐条列在回执里）', () => {
    for (const bad of ['循环结束 乱写', '循环结束 当 1：']) {
      const src = doc(L(1, bad) + '\n');
      const errs = errsOf(src);
      expect(errs.length, bad).toBeGreaterThan(0);
      expect(errs[0]!.message, bad).toContain('循环结束');
      expect(errs[0]!.message, bad).toContain('当');
    }
  });

  it('⑤整块不写收束行 ⇒ 仍产裸 `LOOP`（收束行**可选**这条既有口径不许回归）', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '「死循环」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'DO'), L(2, 'PRINTFORMW 「死循环」'), L(1, 'LOOP'));
  });

  it('带尾随条件的收束行写在更深缩进 ⇒ 仍旧只有 `indent-mismatch` 一条口径', () => {
    const src = doc(seq(L(1, '循环：'), L(2, '「一轮」'), L(2, '循环结束 当 1')) + '\n');
    expect(codesOf(src)).toContain('indent-mismatch');
  });

  it('尾随条件的收束行没有对应开块 ⇒ 报错并说明缩进纪律（与裸形同一条路径）', () => {
    const src = doc(L(1, '循环结束 当 1') + '\n');
    expect(codesOf(src)).toContain('indent-mismatch');
    expect(errsOf(src)[0]!.message).toContain('收束行');
  });
});

/* ============================ B. 跳转与出口 ============================ */

describe('写侧-B · 跳转 / 标签 / 循环出口：目标与位号是**记号**，不是表达式', () => {
  it('`函数跳转 <原文>` → `JUMP <原文>`（**逐字**透传：括号 / 引号 / 逗号 / 空格一个字符都不动）', () => {
    const body = 'GMF_MAP_METHOD(CFLAG:ARG:現在位置, 1, "GETOUT", ARG)';
    has(doc(L(1, `函数跳转 ${body}`) + '\n'), L(1, `JUMP ${body}`));
  });

  it('函数跳转的余文**不按标签名校验**（含空白与括号也照写；校验会把盘上 132 处全误杀）', () => {
    const src = doc(L(1, '函数跳转 FOO(A, 1) + B') + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'JUMP FOO(A, 1) + B'));
  });

  it('函数跳转不降糖：余文里的 `等于` 一类字样原样留着（它是数据不是条件）', () => {
    has(doc(L(1, '函数跳转 FOO(A 等于 1)') + '\n'), L(1, 'JUMP FOO(A 等于 1)'));
  });

  it('光杆 `函数跳转` ⇒ 残缺回执，不产 `JUMP`', () => {
    const src = doc(L(1, '函数跳转') + '\n');
    expect(codesOf(src)).toContain('statement-shape');
    expect(productOf(src)).not.toContain('JUMP');
  });

  it('`跳到 X` → `GOTO X`（语料实测跳转目标**不带** `$`：`GOTO CANCEL`）', () => {
    has(doc(L(1, '跳到 CANCEL') + '\n'), L(1, 'GOTO CANCEL'));
  });

  it('`标签 X` → `$X`', () => {
    has(doc(L(1, '标签 CANCEL') + '\n'), L(1, '$CANCEL'));
  });

  it('标签名可含汉字（语料实测 `$小役抽選開始`）', () => {
    const src = doc(seq(L(1, '标签 抽選終わり'), L(1, '跳到 抽選終わり')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, '$抽選終わり'), L(1, 'GOTO 抽選終わり'));
  });

  it('三枚出口逐字', () => {
    has(doc(seq(L(1, '跳出循环'), L(1, '跳过本轮'), L(1, '重跑本轮')) + '\n'), L(1, 'BREAK'), L(1, 'CONTINUE'), L(1, 'RESTART'));
  });

  it('`步进 X 加|减 n` → **裸表达式行**（`X + n`），不是赋值', () => {
    has(doc(seq(L(1, '步进 BEST 加 1'), L(1, '步进 BEST 减 2')) + '\n'), L(1, 'BEST + 1'), L(1, 'BEST - 2'));
  });

  it('目标带 `$` / `*` 前缀 ⇒ 剥掉（与显示层同一归一，两边对齐同一个名字）', () => {
    has(doc(L(1, '跳到 $招待') + '\n'), L(1, 'GOTO 招待'));
  });

  it('跳转目标含空白 ⇒ 不是标签名：报错且不产 `GOTO`', () => {
    const src = doc(L(1, '跳到 你 心里') + '\n');
    expect(codesOf(src)).toContain('statement-shape');
    expect(productOf(src)).not.toContain('GOTO');
  });

  it('步进增量写成算式 ⇒ 不猜，报错', () => {
    const src = doc(L(1, '步进 BEST 加 1 乘 2') + '\n');
    expect(codesOf(src)).toContain('statement-shape');
    expect(productOf(src)).not.toContain('BEST +');
  });
});

/* ============================ C. 数据表 ============================ */

describe('写侧-C · 数据表：块头配对 + 条目正文**逐字**透传', () => {
  it('`数据表：` + 条目 → `PRINTDATA` … `ENDDATA`', () => {
    const src = doc(
      seq(
        L(1, '数据表：'),
        L(2, '条目 露出了不愉快的表情…'),
        L(2, '条目 随意应付了几句…'),
        L(1, '数据表结束'),
      ) + '\n',
    );
    expect(errsOf(src)).toEqual([]);
    has(
      src,
      L(1, 'PRINTDATA'),
      L(2, 'DATAFORM 露出了不愉快的表情…'),
      L(2, 'DATAFORM 随意应付了几句…'),
      L(1, 'ENDDATA'),
    );
  });

  it('变体不猜义项：`数据表 原形 PRINTDATADL：` → 那枚记号原样带走', () => {
    const src = doc(seq(L(1, '数据表 原形 PRINTDATADL：'), L(2, '条目 「嗯。」')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'PRINTDATADL'), L(2, 'DATAFORM 「嗯。」'), L(1, 'ENDDATA'));
  });

  it('条目正文里的 `=` 不被吞成赋值（正文是数据，不降糖）', () => {
    has(doc(seq(L(1, '数据表：'), L(2, '条目 心情 = 1')) + '\n'), L(2, 'DATAFORM 心情 = 1'));
  });

  it('`条目 原形 DATA <原文>` → `DATA <原文>`（与 `DATAFORM` 义项不同 ⇒ 不折成同一形）', () => {
    has(doc(seq(L(1, '数据表：'), L(2, '条目 原形 DATA 「啊、你回来了～」')) + '\n'), L(2, 'DATA 「啊、你回来了～」'));
  });

  it('块体混入语句 ⇒ 整块不产字节（不拼半张数据表）+ error', () => {
    const src = doc(
      seq(L(1, '数据表：'), L(2, '条目 一条'), L(2, '如果 TARGET 等于 1：'), L(3, '「串进来了」'), L(1, '数据表结束')) + '\n',
    );
    expect(codesOf(src)).toContain('indent-mismatch');
    expect(productOf(src)).not.toContain('PRINTDATA');
    expect(productOf(src)).not.toContain('DATAFORM');
  });

  it('条目写在块外 ⇒ 报错，不静默产 `DATAFORM`', () => {
    const src = doc(L(1, '条目 孤零零') + '\n');
    expect(codesOf(src)).toContain('indent-mismatch');
    expect(productOf(src)).not.toContain('DATAFORM');
  });

  it('空数据表 ⇒ `block-empty`', () => {
    expect(codesOf(doc(L(1, '数据表：') + '\n'))).toContain('block-empty');
  });

  it('`原形` 后面不是 PRINTDATA 系记号 ⇒ 报错（形态不认识，不是「块内无内容」）', () => {
    expect(codesOf(doc(seq(L(1, '数据表 原形 PRINTFORMW：'), L(2, '条目 x')) + '\n'))).toContain('statement-shape');
  });
});

/* ============================ D. 出错处理块 ============================ */

describe('写侧-D · `出错处理：` → `CATCH` … `ENDCATCH`', () => {
  it('块形逐字', () => {
    const src = doc(seq(L(1, '出错处理：'), L(2, '「出岔了」'), L(1, '出错处理结束')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'CATCH'), L(2, 'PRINTFORMW 「出岔了」'), L(1, 'ENDCATCH'));
  });

  it('空体 ⇒ `block-empty`', () => {
    expect(codesOf(doc(L(1, '出错处理：') + '\n'))).toContain('block-empty');
  });

  it('块头带条件 ⇒ 不认（`CATCH` 是裸块头），报错不猜', () => {
    expect(codesOf(doc(seq(L(1, '出错处理 TARGET 等于 1：'), L(2, '「x」')) + '\n'))).toContain('statement-shape');
  });
});

/* ============================ E. 残缺写法一律 fail-closed ============================ */

describe('写侧-E · 认得词形但结构残缺 ⇒ 报错，绝不回落成台词行', () => {
  const MALFORMED: readonly string[] = [
    L(1, '循环 计数 从 0 到 5：'), // 缺变量
    L(1, '循环 计数 LOCAL 0 到 5：'), // 缺 `从`
    L(1, '循环 当：'), // 缺条件
    L(1, '循环 次：'), // 只有量词、没有次数
    L(1, '循环 无限 次：'), // 无限形与次数形混写
    L(1, '循环 乱写：'), // 模态词不认识
    L(1, '循环结束'), // 没有开块
    L(1, '循环结束 当'), // 尾随条件只剩词、没有条件
    L(1, '循环结束 当 1 2：'), // 收束行不带块头冒号
    L(1, '循环结束 乱写'),
    L(1, '数据表结束'),
    L(1, '出错处理结束'),
    L(1, '跳到'), // 只有词、没有目标
    L(1, '函数跳转'),
    L(1, '条目'),
    L(1, '标签'),
    L(1, '步进'),
  ];

  /**
   * 形态残缺那一族挂 `statement-shape`（缺陷④：从前借 `block-empty`，面板上会同时写着
   * 对的消息与错的短名「块内无内容」）。裸收束行（`循环结束` / `数据表结束` / `出错处理结束`）
   * 走的是缩进纪律 ⇒ 它们只报 `indent-mismatch`，不在本清单。
   */
  const SHAPE_CODES: readonly string[] = MALFORMED.filter(
    (b) => !/^(循环结束|数据表结束|出错处理结束)$/.test(b.trim()),
  );

  it.each(MALFORMED)('残缺形 %j 报 error', (body) => {
    expect(codesOf(doc(body + '\n')).length, body).toBeGreaterThan(0);
  });

  it.each(SHAPE_CODES)('残缺形 %j 的诊断码 = `statement-shape`（零 `block-empty`）', (body) => {
    const codes = codesOf(doc(body + '\n'));
    expect(codes, body).toContain('statement-shape');
    expect(codes, body).not.toContain('block-empty');
  });

  it('裸收束行没有开块 ⇒ 仍旧只报缩进纪律那一码（没被顺手改挂）', () => {
    for (const bare of ['循环结束', '数据表结束', '出错处理结束']) {
      expect(codesOf(doc(L(1, bare) + '\n')), bare).toEqual(['indent-mismatch']);
    }
  });

  it('残缺的循环块头**不会**把后一行吞进块体（不产半成品 ERB）', () => {
    const src = doc(seq(L(1, '循环 乱写：'), L(2, '「本来想说台词」')) + '\n');
    expect(codesOf(src)).toContain('statement-shape');
    const erb = productOf(src);
    for (const token of ['FOR ', 'WHILE ', 'REPEAT', 'DO', 'NEXT', 'WEND']) expect(erb, token).not.toContain(token);
  });

  it('收束行没有对应开块 ⇒ 报错并说明缩进纪律（回执里能读出该怎么改）', () => {
    const src = doc(L(1, '循环结束') + '\n');
    expect(codesOf(src)).toContain('indent-mismatch');
    expect(errsOf(src)[0]!.message).toContain('收束行');
  });

  it(`词后面没有空白分隔的台词照旧是台词（不被当指令）`, () => {
    const src = doc(seq(L(1, '标签栏里写着名字'), L(1, '循环这三个字我要打印')) + '\n');
    expect(errsOf(src)).toEqual([]);
    has(src, L(1, 'PRINTFORMDW 标签栏里写着名字'), L(1, 'PRINTFORMDW 循环这三个字我要打印'));
  });
});

/* ============================ F. 产物配平（发版闸同款尺子） ============================ */

describe('写侧-F · 结构配平', () => {
  const MIXED = doc(
    seq(
      L(1, '循环 计数 I 从 0 到 2：'),
      L(2, '出错处理：'),
      L(3, '数据表：'),
      L(4, '条目 一条'),
      L(4, '条目 原形 DATA 两条'),
      L(3, '数据表结束'),
      L(2, '出错处理结束'),
      L(1, '循环结束'),
      L(1, '标签 DONE'),
      L(1, '跳到 DONE'),
    ) + '\n',
  );

  it('零 error', () => {
    expect(errsOf(MIXED)).toEqual([]);
  });

  it('四族开闭词各自配平（含 `IF`/`ENDIF` 信封之外再数一次）', () => {
    const erb = productOf(MIXED);
    for (const [open, close] of [
      [/\bFOR\b/g, /\bNEXT\b/g],
      [/\bCATCH\b/g, /\bENDCATCH\b/g],
      [/^[\t ]*PRINTDATA$/gm, /\bENDDATA\b/g],
    ] as const) {
      expect((erb.match(close) ?? []).length, open.source).toBe((erb.match(open) ?? []).length);
    }
  });

  it('块体逐层加一枚 TAB（四层嵌套 = 四枚）', () => {
    has(
      MIXED,
      L(1, 'FOR I, 0, 2'),
      L(2, 'CATCH'),
      L(3, 'PRINTDATA'),
      L(4, 'DATAFORM 一条'),
      L(4, 'DATA 两条'),
      L(3, 'ENDDATA'),
      L(2, 'ENDCATCH'),
      L(1, 'NEXT'),
      L(1, '$DONE'),
      L(1, 'GOTO DONE'),
    );
  });
});
