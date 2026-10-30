/**
 * `@kojo/kojo-lang/indent` 的闸：Kojo 2.0 的**回车缩进判据**与 **`@原生` 围栏自动闭合守卫**
 * （B3i 从宿主 `monaco/kojo2-indent.ts` 整块搬进包；宿主只留装配与翻译）。
 *
 * ## 这一半钉什么
 *
 * - **判据表逐格正例**：五锚点块头 / `# 对照表` 两列 / `# 池` 分支 / `@随机` 候选（含 `@组`）/
 *   `@原生` 围栏 / `?` 链 / `选项：`；
 * - **不动手的那几格**：旁白 / 台词 / `!` 触发（插槽要模板定义才知道）/ 单行声明 /
 *   单行调度（`@颜绘` `@标` `@跳` `@返` `@断` `@续`）/ 空行 / 注释 / 非 4 空格栅格 / Tab；
 * - **单源**：结果恒为 `KOJO2_INDENT_WIDTH`（= core `KOJO_INDENT_WIDTH`）的整数倍，
 *   一级缩进串就是 `KOJO2_INDENT_UNIT`；
 * - **幂等**：同一输入问两次答案逐字相同；
 * - **真 2.0 夹具**：`tests/v2-fixtures/full.kojo2` 逐行取判据，覆盖每一种结构（词序一变就红）；
 * - **纯入口**：`kojo2IndentReplacementAt`（on-type 要落的行首空白区间）与
 *   `kojo2AutoCloseTargetAt`（围栏内该删的闭括号）——判据本身不带任何 Monaco 形状，
 *   宿主只把这两个 1 基区间翻成 `TextEdit`；
 * - **边界**：空文 / CRLF / 未闭合围栏 / 行号列号越界 / 非字符串。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOJO_INDENT_WIDTH } from '@kojo/kojo-core';
import { KOJO2_INDENT_UNIT } from '../src/language-config';
import { KOJO2_INDENT_WIDTH } from '../src/lexicon';
import {
  KOJO2_BASE_INDENT_RULES,
  kojo2AutoCloseTargetAt,
  kojo2IndentAfterLine,
  kojo2IndentReplacementAt,
} from '../src/indent';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/kojo-lang/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');

/** 真 2.0 夹具（每一行都是正典写法；缩进的"真实语料"侧证据） */
const FIXTURE_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/** 独立口径的一级缩进（**手写 4 空格**，不是从被测常量取的：2.0 的"一级 = 4 空格"这条事实要自己钉） */
const FOUR = '    ';

/* ============================== 判据表（正例） ============================== */

describe('kojo2IndentAfterLine · 开体块头一律 +1 级（4 空格）', () => {
  it.each([
    ['# 对照表 心情 依据 恋慕', '表体（两列行）'],
    ['# 池 早安问候', '池体（`?` 链）'],
    ['# 模 娇羞退场(原因)', '模板体（可含 `[插槽]`）'],
    ['@算', '状态更新块'],
    ['@着色 0xFF8080', '颜色块（体内是叙事）'],
    ['@随机', '随机候选层'],
    ['@组', '多行候选组'],
    ['@循 体力恢复 < 100', '循环体'],
    ['@复 3', '定次循环体'],
    ['@巡 队伍状态', '集合遍历体'],
    ['@函 增加羁绊(目标, 数值=10, 理由="日常")', '函数体'],
    ['@织 回合末 之后', '监听体'],
    ['@原生', '围栏体（比栏头深一级）'],
    ['? 恋慕 >= 500', '条件分支体'],
    ['? 否', '默认分支体'],
    ['选项：', 'UI 块头（2.0 待定，仍是块头）'],
  ])('%s → %s', (line) => {
    expect(kojo2IndentAfterLine(`${line}\n`, 1)).toBe(FOUR);
  });

  it('嵌套层级按行的实际档位算：`# 池` 里的 `?` 在 4 空格上 ⇒ 分支体给 8 空格', () => {
    const text = ['# 池 早安问候', '    ? 恋慕 < 100', '        「……早。」', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(`${FOUR}${FOUR}`);
  });
});

describe('kojo2IndentAfterLine · 同级容器（下一行仍是兄弟，不再加深）', () => {
  it('`# 对照表` 的两列行：行与行同层（表头 → 4；行 → 4）', () => {
    const text = ['# 对照表 心情 依据 恋慕', '    0..99 -> 疏远', '    100..499 -> 平常', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 3)).toBe(FOUR);
  });

  it('`@随机` 的候选行：下一条候选留在候选层（4 空格）', () => {
    const text = ['@随机', '    灵梦：「……呼。」', '    灵梦：「……」', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(FOUR);
  });

  it('`@组` 开体（+1）而组体行留在组层（8 空格）', () => {
    const text = [
      '@随机',
      '    灵梦：「……呼。」',
      '    @组',
      '        灵梦：「再、再摸摸嘛。」',
      '        > 她把脸别了过去。',
      '',
    ].join('\n');
    expect(kojo2IndentAfterLine(text, 3)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 4)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 5)).toBe(`${FOUR}${FOUR}`);
  });

  it('表的行 / 候选行之后**没有**同级容器（空行结束）⇒ 不动手', () => {
    const text = ['# 对照表 心情 依据 恋慕', '    0..99 -> 疏远', '', '    100..499 平常', ''].join('\n');
    // 第 4 行虽然在栅格上，但它头上隔着一枚物理空行：表已结束（§6.1），本层不替它猜
    expect(kojo2IndentAfterLine(text, 4)).toBeNull();
  });
});

describe('kojo2IndentAfterLine · `@原生` 围栏：栏头 +1，体内一个字都不动', () => {
  it('栏头 +1；体内（含行尾冒号、更深的行、围栏内注释）一律 null', () => {
    const text = [
      '@原生',
      '    ; 逃生舱：底层 ERB 代码',
      '    CALL HPH_PRINT "w"',
      '    IF TFLAG:10',
      '        PRINTFORML {　}',
      '    // 这里不是 2.0 注释',
      '> 围栏结束后的旁白',
      '',
    ].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    for (const line of [2, 3, 4, 5, 6]) {
      expect(kojo2IndentAfterLine(text, line), `围栏内第 ${line} 行`).toBeNull();
    }
    // 去缩进到 0 的那一行结束围栏 ⇒ 它自己按普通行判（旁白 = 不动手）
    expect(kojo2IndentAfterLine(text, 7)).toBeNull();
  });

  it('围栏内空行不参与基准、也不开体（§8.5）', () => {
    const text = ['@原生', '    CALL X', '', '    CALL Y', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 3)).toBeNull();
    expect(kojo2IndentAfterLine(text, 4)).toBeNull();
  });

  it('围栏内即使长得像块头（行尾冒号）也不 +1：原文保真优先', () => {
    const text = ['@原生', '    LABEL:', '    CALL X', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 2)).toBeNull();
  });

  it('围栏到文末都没收 ⇒ 体内的每一行仍然不动（不猜"围栏外"）', () => {
    const text = ['@原生', '    CALL A', '        CALL B', '    ; tail'].join('\n');
    for (const line of [2, 3, 4]) {
      expect(kojo2IndentAfterLine(text, line), `未闭合围栏第 ${line} 行`).toBeNull();
    }
    // 栏头本身仍按开体判
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
  });
});

describe('kojo2IndentAfterLine · 行尾全角冒号（迁移期块头 / 按钮标签）', () => {
  it('`选项：` 的按钮标签 `「标签」：` → +1（与按钮体同一条判据）', () => {
    const text = ['选项：', '    「用亲吻代替回答」：', '        灵梦：「……唔。」', '    「摸摸头」：', ''].join('\n');
    expect(kojo2IndentAfterLine(text, 1)).toBe(FOUR);
    expect(kojo2IndentAfterLine(text, 2)).toBe(`${FOUR}${FOUR}`);
    expect(kojo2IndentAfterLine(text, 4)).toBe(`${FOUR}${FOUR}`);
  });

  it('旁白的行尾冒号是正文（`> 请选择你的行动：`）⇒ 不动手', () => {
    expect(kojo2IndentAfterLine('> 请选择你的行动：\n', 1)).toBeNull();
  });

  it('行首转义行的行尾冒号是字面文本 ⇒ 不动手', () => {
    expect(kojo2IndentAfterLine('\\选项：\n', 1)).toBeNull();
  });

  it('CJK 台词的行尾冒号仍开体（`灵梦：「早」：`）', () => {
    expect(kojo2IndentAfterLine('灵梦：「早」：\n', 1)).toBe(FOUR);
  });
});

describe('kojo2IndentAfterLine · 不动手的那几格', () => {
  it.each([
    ['# 幕 神社清晨', '单行声明（体是顶层叙事）'],
    ['# 视角 灵梦', '单行声明'],
    ['# 机 指令 310', '单行声明'],
    ['# 设 今天已触发 整数 = 0 存档', '单行声明'],
    ['# 设 亲近线 整数 = 500', '单行声明'],
    ['> 晨光透过鸟居。', '旁白没有体'],
    ['灵梦：「早上好。」', '台词没有体'],
    ['! 早安问候', '池调用没有体'],
    ['! 娇羞退场("被夸奖")', '模板插槽块要定义处才知道 ⇒ 不猜'],
    ['@颜绘 笑顔', '单行演出'],
    ['@标 主菜单', '单行语句'],
    ['@跳 主菜单', '单行语句'],
    ['@返', '单行语句'],
    ['@断', '单行语句'],
    ['@续', '单行语句'],
    ['// 整行注释', '注释不打断块、自己也不开体'],
    ['', '空行'],
    ['    ', '纯空白行'],
  ])('%s → null（%s）', (line) => {
    expect(kojo2IndentAfterLine(`${line}\n`, 1)).toBeNull();
  });

  it('`空行` 语句（`空行` / `空行 等待` / `空行 续`）不开体', () => {
    for (const line of ['空行', '空行 等待', '空行 续']) {
      expect(kojo2IndentAfterLine(`${line}\n`, 1), line).toBeNull();
    }
  });
});

describe('kojo2IndentAfterLine · 判不准就 null（绝不给一个猜的缩进）', () => {
  it('不在 4 空格栅格上的行（2 / 6 空格）⇒ null', () => {
    expect(kojo2IndentAfterLine('  # 对照表 心情 依据 恋慕\n', 1)).toBeNull();
    expect(kojo2IndentAfterLine('      @算\n', 1)).toBeNull();
  });

  it('含 Tab 的结构行 ⇒ null（2.0 结构缩进只用空格，§8.5）', () => {
    expect(kojo2IndentAfterLine('\t@算\n', 1)).toBeNull();
    expect(kojo2IndentAfterLine('\t# 池 早安问候\n', 1)).toBeNull();
  });

  it('行号越界 / 非整数 / 非正数 ⇒ null', () => {
    const text = '# 对照表 心情 依据 恋慕\n';
    expect(kojo2IndentAfterLine(text, 0)).toBeNull();
    expect(kojo2IndentAfterLine(text, -3)).toBeNull();
    expect(kojo2IndentAfterLine(text, 1.5)).toBeNull();
    expect(kojo2IndentAfterLine(text, 99)).toBeNull();
  });

  it('空文本 / 非字符串 ⇒ null（不抛）', () => {
    expect(kojo2IndentAfterLine('', 1)).toBeNull();
    expect(kojo2IndentAfterLine(undefined as unknown as string, 1)).toBeNull();
    expect(kojo2IndentAfterLine(42 as unknown as string, 1)).toBeNull();
  });
});

/* ============================== 单源 / 幂等 / 真夹具 ============================== */

describe('缩进的单源与幂等', () => {
  it('一级缩进串 = core 的 4 空格；判据里的宽度与它同源', () => {
    expect(KOJO2_INDENT_WIDTH).toBe(KOJO_INDENT_WIDTH);
    expect(KOJO2_INDENT_UNIT).toBe(' '.repeat(KOJO_INDENT_WIDTH));
    expect(KOJO2_INDENT_UNIT).toHaveLength(4);
    expect(FOUR).toBe(KOJO2_INDENT_UNIT);
  });

  it('结果恒为 4 空格整数倍个空格：整篇夹具逐行扫一遍（含 null 行）', () => {
    const lineCount = FIXTURE_TEXT.split('\n').length;
    let positive = 0;
    for (let line = 1; line <= lineCount; line += 1) {
      const indent = kojo2IndentAfterLine(FIXTURE_TEXT, line);
      if (indent === null) continue;
      positive += 1;
      expect(indent, `第 ${line} 行`).toMatch(/^(?: {4})+$/);
      expect(indent.length % KOJO_INDENT_WIDTH).toBe(0);
    }
    // 反空匹配自证：夹具里确实有成片的开体行（不是整篇 null 蒙混过关）
    expect(positive).toBeGreaterThan(15);
  });

  it('幂等：同一输入问两次答案逐字相同（纯函数、无内部状态）', () => {
    const lineCount = FIXTURE_TEXT.split('\n').length;
    for (let line = 1; line <= lineCount; line += 1) {
      expect(kojo2IndentAfterLine(FIXTURE_TEXT, line)).toBe(kojo2IndentAfterLine(FIXTURE_TEXT, line));
    }
  });

  it('CRLF：行尾换成 `\\r\\n` 后逐行答案不变（判据按物理行算，不按字节偏移）', () => {
    const crlf = FIXTURE_TEXT.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const lineCount = crlf.split(/\r\n|\r|\n/).length;
    let positive = 0;
    for (let line = 1; line <= lineCount; line += 1) {
      const next = kojo2IndentAfterLine(crlf, line);
      expect(next, `CRLF 第 ${line} 行`).toBe(kojo2IndentAfterLine(FIXTURE_TEXT, line));
      if (next !== null) positive += 1;
    }
    expect(positive).toBeGreaterThan(15); // 反空匹配自证
  });
});

describe('真 2.0 夹具（full.kojo2）逐结构读数', () => {
  const cases: ReadonlyArray<readonly [number, string | null, string]> = [
    [11, FOUR, '# 对照表 心情 依据 恋慕'],
    [12, FOUR, '    0..99 -> 疏远（表行与行同层）'],
    [15, FOUR, '    否 -> 未知（默认分支也是行）'],
    [17, FOUR, '# 池 早安问候'],
    [18, `${FOUR}${FOUR}`, '    ? 恋慕 < 100（池里的分支体）'],
    [19, null, '        「……早。」（分支体里再回车不加深）'],
    [26, FOUR, '# 模 娇羞退场(原因)'],
    [39, FOUR, '@算'],
    [48, FOUR, '? 恋慕 >= 500'],
    [56, FOUR, '@着色 0xFF8080'],
    [61, FOUR, '@随机'],
    [62, FOUR, '    灵梦：「……呼。」（候选层）'],
    [63, `${FOUR}${FOUR}`, '    @组'],
    [64, `${FOUR}${FOUR}`, '        灵梦：「再、再摸摸嘛。」（组体层）'],
    [66, FOUR, '    灵梦：「……」（组之后的候选）'],
    [72, FOUR, '@循 体力恢复 < 100'],
    [74, `${FOUR}${FOUR}`, '    ? 体力恢复 == 50'],
    [82, FOUR, '@巡 队伍状态'],
    [86, FOUR, '@复 3'],
    [90, null, '> 请选择你的行动：（旁白行尾冒号是正文）'],
    [100, FOUR, '@函 斐波那契(n)'],
    [111, FOUR, '@织 回合末 之后'],
    [117, null, '! 早安问候'],
    [119, null, '    灵梦：「才、才没有很开心呢！」（插槽块不猜）'],
    [122, FOUR, '@原生'],
    [123, null, '    ; 逃生舱：底层 ERB 代码（围栏内）'],
    [129, null, '    // 这里不是 2.0 注释（围栏内）'],
  ];
  it.each(cases)('第 %i 行 %s → %s', (line: number, expected: string | null) => {
    expect(kojo2IndentAfterLine(FIXTURE_TEXT, line)).toBe(expected);
  });
});

/* ============================== on-type 行首空白替换（纯判据） ============================== */

describe('kojo2IndentReplacementAt · 只改新行的行首空白', () => {
  it('`# 对照表` 表头后回车：新行是空行 ⇒ 一条替换把 0 个字符换成 4 空格', () => {
    expect(kojo2IndentReplacementAt('# 对照表 心情 依据 恋慕\n', 2)).toEqual({
      line: 2,
      startColumn: 1,
      endColumn: 1,
      text: FOUR,
    });
  });

  it('已有缩进不对（静态 onEnterRules 给多了）⇒ 校正到精确值', () => {
    expect(kojo2IndentReplacementAt('@算\n        \n', 2)).toEqual({
      line: 2,
      startColumn: 1,
      endColumn: 9,
      text: FOUR,
    });
  });

  it('已经对齐 ⇒ null（落过一次之后再问不来回抖，幂等）', () => {
    expect(kojo2IndentReplacementAt('@算\n    \n', 2)).toBeNull();
  });

  it('当前行有内容（行中回车切出来的半截）⇒ null', () => {
    expect(kojo2IndentReplacementAt('@算\n    心情快照 = 心\n', 2)).toBeNull();
  });

  it('第一行 / 判据为 null / 行号越界 / 空文 ⇒ null', () => {
    expect(kojo2IndentReplacementAt('# 对照表 心情 依据 恋慕\n', 1)).toBeNull();
    expect(kojo2IndentReplacementAt('> 旁白\n', 2)).toBeNull();
    expect(kojo2IndentReplacementAt('# 对照表 心情 依据 恋慕\n', 99)).toBeNull();
    expect(kojo2IndentReplacementAt('', 2)).toBeNull();
  });

  it('行尾 `\\r\\n`：列区间按行内字符算（不含行尾换行）', () => {
    // 第二行 `  \r\n`：行首两空格 ⇒ 替换区间 1..3
    expect(kojo2IndentReplacementAt('@算\r\n  \r\n', 2)).toEqual({
      line: 2,
      startColumn: 1,
      endColumn: 3,
      text: FOUR,
    });
  });

  it('把替换落进去再问一次 ⇒ null（同一位置两次请求答案一致）', () => {
    const text = '# 对照表 心情 依据 恋慕\n';
    const first = kojo2IndentReplacementAt(text, 2);
    expect(first).not.toBeNull();
    if (first === null) return;
    expect(kojo2IndentReplacementAt(`${text}${first.text}\n`, 2)).toBeNull();
  });
});

/* ============================== `@原生` 围栏自动闭合守卫（纯判据） ============================== */

describe('kojo2AutoCloseTargetAt · 只删自动补出来的闭括号', () => {
  it('`@原生` 体内：刚打进 `「` ⇒ 给出删除区间（列 = 光标列）', () => {
    // 行 2 是 `    CALL X「」`：`「` 在 0 基 10，光标在它之后 ⇒ column 12
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X「」\n', 2, 12, '「')).toEqual({
      line: 2,
      startColumn: 12,
      endColumn: 13,
    });
  });

  it('围栏内空行也守；去缩进到 0 就不在围栏内了', () => {
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X\n\n（\n', 4, 2, '（')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X\n\n    （）\n', 4, 6, '（')).toEqual({
      line: 4,
      startColumn: 6,
      endColumn: 7,
    });
  });

  it('围栏外（旁白 / 台词 / 块体）⇒ null；围栏结束后那行同理', () => {
    expect(kojo2AutoCloseTargetAt('> 旁白「」\n', 1, 6, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt('灵梦：「」\n', 1, 5, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X\n「」\n', 3, 2, '「')).toBeNull();
  });

  it('指纹不完整（没自动补 / 触发的不是开括号 / 光标位置不对）⇒ null', () => {
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X「\n', 2, 12, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X「」\n', 2, 12, '（')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X「」\n', 2, 13, '」')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    CALL X「」\n', 2, 1, '「')).toBeNull();
  });

  it('整篇没有围栏词 / 非字符串 / 坐标越界 ⇒ null（不词法）', () => {
    expect(kojo2AutoCloseTargetAt('灵梦：「」\n', 1, 4, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt(undefined as unknown as string, 1, 1, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    「」\n', 0, 6, '「')).toBeNull();
    expect(kojo2AutoCloseTargetAt('@原生\n    「」\n', 99, 6, '「')).toBeNull();
  });

  it('CRLF：列号按行内字符算（行尾 `\\r` 不参与）', () => {
    expect(kojo2AutoCloseTargetAt('@原生\r\n    CALL X「」\r\n', 2, 12, '「')).toEqual({
      line: 2,
      startColumn: 12,
      endColumn: 13,
    });
  });
});

/* ============================== 基底规则数据 ============================== */

describe('KOJO2_BASE_INDENT_RULES · 静态规则数据（宿主只拿去合并）', () => {
  it('两格回车规则：`@原生` 栏头 + 行尾全角冒号', () => {
    expect(KOJO2_BASE_INDENT_RULES.indentOnEnter).toHaveLength(2);
    expect(KOJO2_BASE_INDENT_RULES.indentOnEnter[0]!.test('@原生')).toBe(true);
    expect(KOJO2_BASE_INDENT_RULES.indentOnEnter[0]!.test('@原生{')).toBe(true);
    expect(KOJO2_BASE_INDENT_RULES.indentOnEnter[1]!.test('选项：')).toBe(true);
    expect(KOJO2_BASE_INDENT_RULES.indentOnEnter[1]!.test('甲：乙')).toBe(false);
  });

  it('increase 是两格的并集；decrease 永不匹配（Enter 上不许 Outdent）', () => {
    const increase = KOJO2_BASE_INDENT_RULES.increaseIndentPattern;
    expect(increase.test('@原生')).toBe(true);
    expect(increase.test('选项：')).toBe(true);
    expect(increase.test('> 旁白')).toBe(false);
    const decrease = KOJO2_BASE_INDENT_RULES.decreaseIndentPattern;
    for (const line of ['@原生', '选项：', '> 旁白', '    ? 条件', '', '灵梦：「早」']) {
      expect(decrease.test(line), line).toBe(false);
    }
  });
});
