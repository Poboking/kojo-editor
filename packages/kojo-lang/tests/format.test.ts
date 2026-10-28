/**
 * K2-FORMAT-2 · Kojo 2.0 文档格式化的**纯规则**闸（设计稿 §16.7 U6.6）。
 *
 * B3d（2026-10-28）：本闸由两份宿主测试的纯函数那半合进来——
 * - `packages/app/tests/kojo2-format.test.ts` 的 ①–⑦（规则 / 空行 / 行尾 / 注释 / EOL / 幂等 /
 *   edits 形状）；
 * - `packages/app/tests/kojo2-indent-brackets.test.ts` 的 ⑤（区间格式化：只动选中行）。
 *
 * 判据搬进本包之后供方是插件，宿主只剩"model → 请求 / 契约 → Monaco"两段翻译；断言**一条未减**，
 * 只换了 import 出处。app 侧那两份文件留下的是 provider 面（注册收口、语言过滤、空结果语义）。
 *
 * 覆盖七件事：
 * 1. **缩进归一**：`# 池` 分支 / `# 表` 两列 / `@随机` 候选 + `@组` / `@算`~`@织` 块 /
 *    `!` 调用体 / `选项` 标签体 / 制表符缩进 / 多缩进漂移，一律归一到 `KOJO2_INDENT_WIDTH`；
 * 2. **空行呼吸**：单行声明组内部 0 空行、组与正文/块之间 1 空行、块前后 1 空行、连续空行折叠、
 *    文件首尾空行去掉（结尾换行保持）、`@原生` 体内的空行一个字节都不动、注释与下一行之间不插；
 * 3. **行尾空白 / `//` 注释 / 正文保真**：行尾空白清除而正文不动；整行注释保留原缩进；
 *    `> http://…` 这类行内 `//` 不被当注释；
 * 4. **EOL**：CRLF 进 CRLF 出（无裸 LF）、混合行尾逐行保留；
 * 5. **幂等 / 可解析**：仓内 canonical fixture 上 `changed=false` 且逐字节等；
 *    `format(format(x))` 不变；格式化后 `parseSource` 的 error 数不变大（含无效输入）；
 * 6. **edits 形状**：行数不变 ⇒ 逐行最小 edit；行数变了（空行增删）⇒ 整篇一条；BOM 保留；
 * 7. **区间**：整篇算、只落选中行；选区外逐字节不动；越界 / 倒置 / 围栏体一律少改。
 *
 * 格式化规则一律走 core 真词法 / 真 parser，不在测试里手写一份"期望的层级算法"。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource } from '@kojo/kojo-core';
import {
  formatKojo2Range,
  formatKojo2Source,
  type Kojo2FormatEdit,
  type Kojo2FormatOptions,
} from '../src/format';

const HERE = import.meta.dirname;

/* ============================== 夹具与工具 ============================== */

function errorCount(source: string): number {
  try {
    return parseSource(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  } catch {
    return -1;
  }
}

function expectFormat(source: string, expected: string, options?: Kojo2FormatOptions): void {
  const result = formatKojo2Source(source, options);
  expect(result.changed).toBe(true);
  expect(result.code).toBe(expected);
  // 每个正例都顺手钉幂等：二次格式化必须零改动且逐字节等
  const again = formatKojo2Source(result.code, options);
  expect(again.changed).toBe(false);
  expect(again.code).toBe(result.code);
}

function expectUnchanged(source: string, options?: Kojo2FormatOptions): void {
  const result = formatKojo2Source(source, options);
  expect(result.changed).toBe(false);
  expect(result.code).toBe(source);
  expect(result.edits).toBeUndefined();
}

/** 把 edits 按"整行替换"语义代回文本（只用于 LF 夹具） */
function applyEdits(source: string, edits: readonly Kojo2FormatEdit[]): string {
  const lines = source.split('\n');
  const sorted = [...edits].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber);
  for (const edit of sorted) {
    const from = edit.range.startLineNumber - 1;
    const count = edit.range.endLineNumber - edit.range.startLineNumber + 1;
    lines.splice(from, count, ...edit.newText.split('\n'));
  }
  return lines.join('\n');
}

/* ============================== ① 缩进归一 ============================== */

describe('①缩进归一到 4 空格（`# 池` / `# 表` / `@随机` / `@` 块 / 调用体 / 选项）', () => {
  it('`# 池` 的 `?` 分支与分支体：2 / 6 空格 → 4 / 8', () => {
    const source = '# 机 开场\n# 视 我\n\n# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「早上好。」\n';
    expectFormat(
      source,
      '# 机 开场\n# 视 我\n\n# 池 问候\n    ? 恋慕 < 100\n        「早。」\n    ? 否\n        我：「早上好。」\n',
    );
  });

  it('`# 表` 的两列行是并列项：多缩进漂移也归到同一层', () => {
    const source = '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n  0..99 疏远\n      100..499 平常\n  否 未知\n';
    expectFormat(
      source,
      '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n    0..99 疏远\n    100..499 平常\n    否 未知\n',
    );
  });

  it('`@随机` 候选并列、`@组` 体深一级', () => {
    const source =
      '# 机 开场\n# 视 我\n\n@随机\n  我：「a」\n      我：「b」\n  @组\n      我：「c」\n      > 别过脸。\n';
    expectFormat(
      source,
      '# 机 开场\n# 视 我\n\n@随机\n    我：「a」\n    我：「b」\n    @组\n        我：「c」\n        > 别过脸。\n',
    );
  });

  it('`@算` / `@着色` / `@循` / `@巡` / `@复` / `@函` / `@织` 的体各归一', () => {
    const source = [
      '# 机 开场',
      '# 视 我',
      '',
      '@算',
      '  甲 = 1',
      '',
      '@着色 0xFF8080',
      '  我：「红。」',
      '',
      '@循 甲 < 3',
      '  甲 += 1',
      '',
      '@巡 队伍',
      '  ? {值} == "伤"',
      '      > 需要治疗。',
      '',
      '@复 2',
      '  我：「嗯。」',
      '',
      '@函 加(值)',
      '  ? 值 > 0',
      '      @返 值',
      '  ? 否',
      '      @返 0',
      '',
      '@织 回合末',
      '  > 监听体。',
      '',
    ].join('\n');
    expectFormat(
      source,
      [
        '# 机 开场',
        '# 视 我',
        '',
        '@算',
        '    甲 = 1',
        '',
        '@着色 0xFF8080',
        '    我：「红。」',
        '',
        '@循 甲 < 3',
        '    甲 += 1',
        '',
        '@巡 队伍',
        '    ? {值} == "伤"',
        '        > 需要治疗。',
        '',
        '@复 2',
        '    我：「嗯。」',
        '',
        '@函 加(值)',
        '    ? 值 > 0',
        '        @返 值',
        '    ? 否',
        '        @返 0',
        '',
        '@织 回合末',
        '    > 监听体。',
        '',
      ].join('\n'),
    );
  });

  it('`!` 调用体的插槽正文：只有"紧跟更深一行"才开体，缩进归一到 4', () => {
    const source = '# 机 开场\n# 视 我\n\n! 娇羞退场("被夸奖")\n      我：「才没有！」\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n! 娇羞退场("被夸奖")\n    我：「才没有！」\n');
  });

  it('`选项：` 的按钮标签体（裸引号行尾全角冒号）深一级', () => {
    const source = '# 机 开场\n# 视 我\n\n选项：\n  「用亲吻代替回答」：\n      灵梦：「……唔。」\n';
    expectFormat(
      source,
      '# 机 开场\n# 视 我\n\n选项：\n    「用亲吻代替回答」：\n        灵梦：「……唔。」\n',
    );
  });

  it('结构行的 Tab 缩进折成 4 空格（Tab 只在 `@原生` 体内合法）', () => {
    const source = '# 机 开场\n# 视 我\n\n# 池 问候\n\t? 恋慕 < 100\n\t\t「早。」\n\t? 否\n\t\t我：「嗯。」\n';
    expectFormat(
      source,
      '# 机 开场\n# 视 我\n\n# 池 问候\n    ? 恋慕 < 100\n        「早。」\n    ? 否\n        我：「嗯。」\n',
    );
  });

  it('没有开体行的纯漂移（`@算` 体内 8 空格）归回一级', () => {
    const source = '# 机 开场\n# 视 我\n\n@算\n    甲 = 1\n        乙 = 2\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n@算\n    甲 = 1\n    乙 = 2\n');
  });

  it('`@原生` 围栏头与体内逐字节不变（含 Tab / 行尾空白 / 伪注释 / 深缩进）', () => {
    const native =
      '@原生\n   ; 逃生舱\n    \tCALL HPH_PRINT "w"   \n   // 不是注释\n     缩进\n';
    const source = `# 机 开场\n# 视 我\n\n@算\n  甲 = 1\n\n${native}\n> 正文\n`;
    const result = formatKojo2Source(source);
    expect(result.changed).toBe(true);
    expect(result.code).toContain(native);
    expect(result.code).toBe(`# 机 开场\n# 视 我\n\n@算\n    甲 = 1\n\n${native}\n> 正文\n`);
  });
});

/* ============================== ② 空行呼吸 ============================== */

describe('②空行呼吸（声明区 / 块边界 / 折叠 / 首尾）', () => {
  it('单行声明之间不空行：组内空行全删', () => {
    const source = '# 幕 清晨\n\n# 视 我\n\n# 机 开场\n\n\n# 变量 甲 整数\n\n> 正文\n';
    expectFormat(source, '# 幕 清晨\n# 视 我\n# 机 开场\n# 变量 甲 整数\n\n> 正文\n');
  });

  it('声明组与正文之间插一个空行（原来没有）', () => {
    const source = '# 机 开场\n# 视 我\n> 正文\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n> 正文\n');
  });

  it('声明组与块声明之间插一个空行（`# 表` 也是声明块）', () => {
    const source = '# 机 开场\n# 视 我\n# 表 心情 由 恋慕\n    否 未知\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n    否 未知\n');
  });

  it('连续空行折叠为一个（块与块之间）', () => {
    const source = '# 机 开场\n# 视 我\n\n\n# 表 心情 由 恋慕\n    否 未知\n\n\n\n> 正文\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n    否 未知\n\n> 正文\n');
  });

  it('块前后各一个空行（前文 / `@算` / 后文贴在一起时插空行）', () => {
    const source = '# 机 开场\n# 视 我\n\n> 前文\n@算\n  甲 = 1\n> 后文\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n> 前文\n\n@算\n    甲 = 1\n\n> 后文\n');
  });

  it('文件首尾空行去掉；"结尾有换行"保持（不多出一条空行）', () => {
    const source = '\n\n# 机 开场\n# 视 我\n\n> 正文\n\n\n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n> 正文\n');
  });

  it('文件结尾没有换行时，删尾部空白行也不凭空加换行', () => {
    const source = '# 机 开场\n# 视 我\n\n> 正文\n   ';
    expectFormat(source, '# 机 开场\n# 视 我\n\n> 正文');
  });

  it('紧跟注释的下一行不插空行（注释属于下一块）', () => {
    const source = '# 机 开场\n# 视 我\n\n// 下一块的注释\n@算\n    甲 = 1\n';
    expectUnchanged(source);
  });

  it('`@原生` 体内的空行（含纯空白行）一个字节都不动', () => {
    const source = '# 机 开场\n# 视 我\n\n@原生\n    LINE1\n       \n    LINE2\n\n> 正文\n';
    expectUnchanged(source);
  });

  it('blankLines:false ⇒ 空行原样（不折叠 / 不插入 / 不删首尾）', () => {
    const source = '# 幕 清晨\n\n\n# 视 我\n\n> 正文\n\n\n';
    expectUnchanged(source, { blankLines: false });
  });
});

/* ============================== ③ 行尾空白 / 正文保真 ============================== */

describe('③行尾空白清除，正文与注释文本不动', () => {
  it('结构行 / 叙事行 / 注释行的行尾空白清掉；纯空白行归一为真空行', () => {
    const source = '# 机 开场   \n# 视 我\t\n\n> 正文\u3000\u00a0 \n// 注释  \n';
    expectFormat(source, '# 机 开场\n# 视 我\n\n> 正文\n// 注释\n');
  });

  it('行内文本一个字符都不改（引号内空格 / 表行内部对齐 / `//` 是正文）', () => {
    const source =
      '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n  0..99     疏远\n\n> 看这里 // 不是注释\n灵梦：「你 好。」   \n';
    const result = formatKojo2Source(source);
    expect(result.code).toContain('    0..99     疏远');
    expect(result.code).toContain('> 看这里 // 不是注释');
    expect(result.code).toContain('灵梦：「你 好。」');
    expect(result.code).not.toContain('   \n');
  });

  it('trailingWhitespace:false ⇒ 行尾空白原样保留', () => {
    const source = '# 机 开场   \n# 视 我\n\n> 正文\t\n';
    expectUnchanged(source, { trailingWhitespace: false });
  });
});

/* ============================== ④ 注释 ============================== */

describe('④`//` 整行注释保留原缩进层级', () => {
  it('注释行首空白逐字保留（可写任意缩进），邻居该归一仍归一', () => {
    const source = '# 机 开场\n  // 注释缩进 2\n# 视 我\n\n@算\n  甲 = 1\n  // 块内注释缩进 2\n  乙 = 2\n';
    expectFormat(
      source,
      '# 机 开场\n  // 注释缩进 2\n# 视 我\n\n@算\n    甲 = 1\n  // 块内注释缩进 2\n    乙 = 2\n',
    );
  });
});

/* ============================== ⑤ EOL ============================== */

describe('⑤EOL 保留', () => {
  it('CRLF 进 ⇒ CRLF 出（输出里没有裸 LF）', () => {
    const lf = '# 机 开场\n# 视 我\n\n# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「嗯。」\n';
    const source = lf.replace(/\n/g, '\r\n');
    const result = formatKojo2Source(source);
    expect(result.changed).toBe(true);
    expect(result.code).toBe(
      '# 机 开场\r\n# 视 我\r\n\r\n# 池 问候\r\n    ? 恋慕 < 100\r\n        「早。」\r\n    ? 否\r\n        我：「嗯。」\r\n',
    );
    expect(/(?<!\r)\n/.test(result.code)).toBe(false);
    expect(result.code.endsWith('\r\n')).toBe(true);
  });

  it('混合行尾逐行保留（只改缩进，不动任何一行的行尾种类）', () => {
    const source =
      '# 机 开场\r\n# 视 我\n\r\n# 池 问候\r\n  ? 恋慕 < 100\n      「早。」\r\n  ? 否\n      我：「嗯。」\r\n';
    const result = formatKojo2Source(source);
    const eols = [...result.code.matchAll(/\r\n|\r|\n/g)].map((match) => match[0]);
    expect(eols).toEqual(['\r\n', '\n', '\r\n', '\r\n', '\n', '\r\n', '\n', '\r\n']);
  });
});

/* ============================== ⑥ 幂等 / 可解析 ============================== */

describe('⑥幂等与可解析（安全闸）', () => {
  it('仓内 canonical fixture：changed=false 且逐字节等于输入', () => {
    const canonical = readFileSync(
      path.resolve(HERE, '..', '..', 'kojo-core', 'tests', 'fixtures', 'kojo2-canonical.kojo2'),
      'utf8',
    );
    expect(errorCount(canonical)).toBe(0);
    expectUnchanged(canonical);
  });

  it('conformance basic fixture：changed=false 且逐字节等于输入', () => {
    const basic = readFileSync(
      path.resolve(HERE, '..', '..', 'kojo-conformance', 'tests', 'fixtures', 'basic.kojo2'),
      'utf8',
    );
    expect(errorCount(basic)).toBe(0);
    expectUnchanged(basic);
  });

  it('乱输入格式化一次后二次零改动（format ∘ format = format）', () => {
    const source =
      '# 幕 清晨\n\n# 视 我\n# 机 开场\n\n\n# 表 心情 由 恋慕\n  0..99 疏远\n      100..499 平常\n  否 未知\n\n@算\n  甲 = 1\n    乙 = 2\n> 正文   \n';
    const once = formatKojo2Source(source);
    const twice = formatKojo2Source(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it('合法但没排版（缺声明空行 / 行尾空白）⇒ 格式化后 parse error 仍为 0', () => {
    const source = '# 机 开场\n# 视 我\n> 正文   \n';
    expect(errorCount(source)).toBe(0);
    const result = formatKojo2Source(source);
    expect(errorCount(result.code)).toBe(0);
    expect(result.code).toBe('# 机 开场\n# 视 我\n\n> 正文\n');
  });

  it('空文件 / 全空白文件原样返回（没有结构可归一，不动源事实）', () => {
    expectUnchanged('');
    expectUnchanged('\n\n   \n');
  });

  it('无效输入不放大错误（2 空格 / Tab / 表行漂移 / 多缩进旁白）', () => {
    const cases = [
      '# 机 开场\n# 视 我\n\n# 池 问候\n  ? x < 1\n      「早。」\n  ? 否\n      我：「嗯。」\n',
      '# 机 开场\n# 视 我\n\n# 池 问候\n\t? x < 1\n\t\t「早。」\n\t? 否\n\t\t我：「嗯。」\n',
      '# 机 开场\n# 视 我\n\n# 表 心情 由 恋慕\n  0..99 疏远\n      100..499 平常\n  否 未知\n',
      '> 甲\n    > 乙\n',
    ];
    for (const source of cases) {
      const before = errorCount(source);
      expect(before).toBeGreaterThanOrEqual(0);
      const result = formatKojo2Source(source);
      expect(errorCount(result.code)).toBeLessThanOrEqual(before);
    }
  });
});

/* ============================== ⑦ edits 形状 ============================== */

describe('⑦edits：行数不变逐行最小 / 行数变了整篇一条', () => {
  const POOL_MESSY =
    '# 机 开场\n# 视 我\n\n# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「早上好。」\n';

  it('只改缩进（行数不变）⇒ 每个改动行一条单行 edit，代回去等于 code', () => {
    const result = formatKojo2Source(POOL_MESSY);
    expect(result.edits).toBeDefined();
    const edits = result.edits!;
    expect(edits).toHaveLength(4);
    for (const edit of edits) {
      expect(edit.range.startLineNumber).toBe(edit.range.endLineNumber);
      expect(edit.range.startColumn).toBe(1);
    }
    expect(edits.map((edit) => edit.range.startLineNumber)).toEqual([5, 6, 7, 8]);
    expect(applyEdits(POOL_MESSY, edits)).toBe(result.code);
  });

  it('插空行（行数变了）⇒ 整篇一条 edit，newText 就是成品行', () => {
    const source = '# 机 开场\n# 视 我\n> 正文\n';
    const result = formatKojo2Source(source);
    expect(result.edits).toHaveLength(1);
    const edit = result.edits![0]!;
    expect(edit.range.startLineNumber).toBe(1);
    expect(edit.range.startColumn).toBe(1);
    // 行数 = 物理行数（结尾换行后那一格也算一行）
    expect(edit.range.endLineNumber).toBe(source.split('\n').length);
    expect(edit.range.endColumn).toBe(1);
    expect(edit.newText).toBe(result.code);
    expect(applyEdits(source, result.edits!)).toBe(result.code);
  });

  it('BOM 保留；改首行时 edit 的 newText 也带上 BOM', () => {
    const source = '\ufeff# 机 开场   \n# 视 我\n\n> 正文\n';
    const result = formatKojo2Source(source);
    expect(result.code.startsWith('\ufeff# 机 开场\n')).toBe(true);
    const first = result.edits!.find((edit) => edit.range.startLineNumber === 1);
    expect(first).toBeDefined();
    expect(first!.newText.startsWith('\ufeff')).toBe(true);
    expect(applyEdits(source, result.edits!)).toBe(result.code);
  });
});

/* ============================== ⑧ 区间格式化（纯规则：只动选中行） ============================== */

function parseErrors(source: string): number {
  return parseSource(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
}

function linesOf(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

const MESSY_POOL = ['# 池 早安问候', '    ? 恋慕 < 100', '      「……早。」', '    ? 否', '        「……」', ''].join('\n');

describe('⑧ formatRange：规则复用整篇、落点只在选中行', () => {
  it('整篇没有增删行时：区内逐行相等，区外逐字节不动', () => {
    const full = formatKojo2Source(MESSY_POOL);
    expect(full.changed).toBe(true);
    const ranged = formatKojo2Range(MESSY_POOL, 3, 3);
    expect(ranged.changed).toBe(true);
    const fullLines = linesOf(full.code);
    const rangeLines = linesOf(ranged.code);
    expect(rangeLines).toHaveLength(linesOf(MESSY_POOL).length);
    // 区外（1 / 2 / 4 / 5 行）与原文逐字节相同
    for (const index of [0, 1, 3, 4]) {
      expect(rangeLines[index], `第 ${index + 1} 行被越界改了`).toBe(linesOf(MESSY_POOL)[index]);
    }
    // 区内 == 整篇结果切片
    expect(rangeLines[2]).toBe(fullLines[2]);
    expect(rangeLines[2]).toBe('        「……早。」');
  });

  it('选区覆盖全文 ⇒ 与整篇格式化逐字节一致', () => {
    const full = formatKojo2Source(MESSY_POOL);
    const ranged = formatKojo2Range(MESSY_POOL, 1, linesOf(MESSY_POOL).length);
    expect(ranged.code).toBe(full.code);
    expect(ranged.changed).toBe(full.changed);
    // 全文选区也允许一条整段 edit（整篇的逐行最小 edit 是另一档形状，字节结果相同即可）
  });

  it('整篇要插空行时，选区覆盖那一缝 ⇒ 与整篇结果一致（插入行随 kept 行一起进段）', () => {
    const source = ['# 机 开场', '# 视 我', '> 正文', ''].join('\n');
    const full = formatKojo2Source(source);
    expect(full.changed).toBe(true);
    expect(full.code).toContain('\n\n> 正文');
    expect(formatKojo2Range(source, 1, 3).code).toBe(full.code);
  });

  it('只选正文那一行时不在选区外插空行（缝隙呼吸不越界）', () => {
    const source = ['# 机 开场', '# 视 我', '> 正文   ', ''].join('\n');
    const ranged = formatKojo2Range(source, 3, 3);
    expect(ranged.changed).toBe(true);
    const out = linesOf(ranged.code);
    expect(out[0]).toBe('# 机 开场');
    expect(out[1]).toBe('# 视 我');
    expect(out[2]).toBe('> 正文');
    expect(out[3]).toBe('');
    expect(out).toHaveLength(4);
  });

  it('结果可解析：error 数不增加；edits 只有一条且落在选区内', () => {
    const ranged = formatKojo2Range(MESSY_POOL, 3, 3);
    expect(parseErrors(ranged.code)).toBeLessThanOrEqual(parseErrors(MESSY_POOL));
    expect(ranged.edits).toHaveLength(1);
    const edit = ranged.edits![0]!;
    expect(edit.range.startLineNumber).toBe(3);
    expect(edit.range.endLineNumber).toBe(3);
    expect(edit.newText).toBe('        「……早。」');
  });

  it('`@原生` 围栏体：选中围栏行不改一个字节（返回 unchanged）', () => {
    const source = ['# 机 开场', '', '@原生', '    ; raw', '      CALL X   ', '> 旁白', ''].join('\n');
    const ranged = formatKojo2Range(source, 3, 5);
    expect(ranged.changed).toBe(false);
    expect(ranged.code).toBe(source);
    expect(ranged.edits).toBeUndefined();
  });

  it('CRLF 保留：选区外行尾逐字节保留，选区内也用原行尾', () => {
    const source = '# 池 甲\r\n    ? 条件\r\n      「早。」\r\n';
    const ranged = formatKojo2Range(source, 3, 3);
    expect(ranged.changed).toBe(true);
    expect(ranged.code).toBe('# 池 甲\r\n    ? 条件\r\n        「早。」\r\n');
  });

  it('行号非法 / 倒置 / 越界 ⇒ 原样返回（不猜方向、不夹取）', () => {
    for (const [start, end] of [
      [0, 3],
      [3, 2],
      [1.5, 3],
      [Number.NaN, 3],
      [99, 120],
    ] as const) {
      const result = formatKojo2Range(MESSY_POOL, start, end);
      expect(result).toEqual({ code: MESSY_POOL, changed: false });
    }
    expect(formatKojo2Range('', 1, 1)).toEqual({ code: '', changed: false });
    expect(formatKojo2Range('> 已合规。\n', 1, 1)).toEqual({ code: '> 已合规。\n', changed: false });
  });

  it('选项透传（关 indent 就不动缩进）', () => {
    const noIndent = formatKojo2Range(MESSY_POOL, 3, 3, { indent: false, blankLines: false });
    expect(noIndent.changed).toBe(false);
  });
});
