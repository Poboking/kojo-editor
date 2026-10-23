// @vitest-environment happy-dom
/**
 * K2-FORMAT-2 · Kojo 2.0 文档格式化（设计稿 §16.7 U6.6）的闸。
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
 * 6. **edits 形状**：行数不变 ⇒ 逐行最小 edit；行数变了（空行增删）⇒ 整篇一条；
 * 7. **注册与停点复用**：flag 关零注册；flag 开只给 `kojo2` 一枚 provider；
 *    `applyKojo2Format` 走**同一枚** `applyTextEdits`（真 model 上断言
 *    `pushUndoStop → executeEdits → pushUndoStop`，并验证两次撤销的语义），本层不出现
 *    `executeEdits` / `pushUndoStop` 第二套机制。
 *
 * 桩 monaco 只实现被真正用到的那几格；格式化规则一律走 core 真词法 / 真 parser，不在测试里
 * 手写一份"期望的层级算法"。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import type * as Monaco from '../src/monaco/entry';
import { parseSource } from '@kojo/kojo-core';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-constants';
import {
  applyKojo2Format,
  formatKojo2Source,
  installKojo2DocumentFormatter,
  installKojo2RangeFormatter,
  type Kojo2FormatEdit,
  type Kojo2FormatOptions,
} from '../src/monaco/kojo2-format';

const HERE = import.meta.dirname;
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';
const LAYER_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-format.ts'), 'utf8');

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

/** 把 edits 按 `applyTextEdits` 的整行替换语义代回文本（只用于 LF 夹具） */
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

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

interface Registered {
  readonly languageId: string;
  readonly provider: Monaco.languages.DocumentFormattingEditProvider;
}

function fakeMonaco() {
  const registered: Registered[] = [];
  const disposed: string[] = [];
  const monacoStub = {
    languages: {
      registerDocumentFormattingEditProvider(languageId: string, provider: unknown) {
        registered.push({
          languageId,
          provider: provider as Monaco.languages.DocumentFormattingEditProvider,
        });
        return {
          dispose: () => {
            disposed.push(languageId);
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco: monacoStub, registered, disposed };
}

function fakeModel(source: string, languageId = KOJO2_LANGUAGE_ID) {
  return {
    getValue: () => source,
    getLanguageId: () => languageId,
  };
}

/** 一次 provider 请求（返回类型可能是 Thenable，测试只收同步那一支） */
function requestFormatting(
  provider: Monaco.languages.DocumentFormattingEditProvider,
  model: unknown,
): Monaco.languages.TextEdit[] {
  return provider.provideDocumentFormattingEdits(
    model as Monaco.editor.ITextModel,
    {} as Monaco.languages.FormattingOptions,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.TextEdit[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    // Monaco 的 lineCount = 物理行数（结尾换行后那一格也算一行）
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

/* ============================== ⑧ 注册纪律 ============================== */

describe('⑧注册：flag 关零注册；flag 开只给 `kojo2` 一枚 provider', () => {
  it('flag 关 ⇒ 一次注册都不发生，dispose 空操作', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2DocumentFormatter(fake.monaco);
    expect(fake.registered).toEqual([]);
    handle.dispose();
    expect(fake.disposed).toEqual([]);
  });

  it('flag 开 ⇒ 恰好一枚 provider、语言 id 是 `kojo2`；dispose 幂等', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const handle = installKojo2DocumentFormatter(fake.monaco);
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]!.languageId).toBe(KOJO2_LANGUAGE_ID);
    handle.dispose();
    handle.dispose();
    expect(fake.disposed).toEqual([KOJO2_LANGUAGE_ID]);
  });

  it('语言 id 不是 `kojo2` ⇒ 零 edits（v1 面零动作）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    const provider = fake.registered[0]!.provider;
    const edits = requestFormatting(provider, fakeModel('  > 甲\n', 'kojo'));
    expect(edits).toEqual([]);
  });

  it('已合规文档 ⇒ 空 edits（不返回"等价但不同字节"的重写）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    const provider = fake.registered[0]!.provider;
    const edits = requestFormatting(provider, fakeModel('# 机 开场\n# 视 我\n'));
    expect(edits).toEqual([]);
  });

  it('乱文档 ⇒ provider 返回真 edits（`text` 字段，不带 `eol`）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    const provider = fake.registered[0]!.provider;
    const edits = requestFormatting(provider, fakeModel('# 机 开场\n# 视 我\n> 正文\n'));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0]!.eol).toBeUndefined();
    expect(edits[0]!.text).toContain('> 正文');
  });

  it('provider 体内取文抛错（模型已释放）⇒ 空 edits，不掀桌子', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    const provider = fake.registered[0]!.provider;
    const edits = requestFormatting(provider, {
      getValue: () => {
        throw new Error('model disposed');
      },
      getLanguageId: () => KOJO2_LANGUAGE_ID,
    });
    expect(edits).toEqual([]);
  });

  it('源码钉子：flag 守卫先于注册；本层不出现 executeEdits / pushUndoStop', () => {
    const code = codeOf(LAYER_SOURCE);
    const body = sliceBetween('export function installKojo2DocumentFormatter(', '\n}\n', code);
    const guard = body.indexOf('isKojo2CutoverEnabled()');
    const register = body.indexOf('registerDocumentFormattingEditProvider');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(guard);
    expect(code).not.toContain('executeEdits');
    expect(code).not.toContain('pushUndoStop');
    // 区间格式化（K2-INDENT-BRACKETS）另有一枚 installer：整篇这一枚不许抢它的注册
    expect(body).not.toContain('registerDocumentRangeFormattingEditProvider');
    // 只认 2.0 语言面：不 import v1 的 `kojo-language`
    expect(code).not.toContain("from './kojo-language'");
  });
});

/* ============================== ⑨ 停点复用（undo） ============================== */

describe('⑨`applyKojo2Format` 复用同一枚 `applyTextEdits`（前后各一颗停点）', () => {
  const models: monaco.editor.ITextModel[] = [];
  let seq = 0;

  function makeModel(text: string): monaco.editor.ITextModel {
    const model = monaco.editor.createModel(
      text,
      KOJO2_LANGUAGE_ID,
      monaco.Uri.parse(`inmemory://kojo2-format/${++seq}`),
    );
    models.push(model);
    return model;
  }

  afterEach(() => {
    for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
  });

  function editorOf(model: monaco.editor.ITextModel) {
    const calls: string[] = [];
    const editor = {
      getModel: () => model,
      executeEdits: (_source: string, operations: monaco.editor.IIdentifiedSingleEditOperation[]) => {
        calls.push('edit');
        return model.pushEditOperations(null, operations, () => null) !== null;
      },
      pushUndoStop: () => {
        calls.push('stop');
        model.pushStackElement();
      },
    } as unknown as Parameters<typeof applyKojo2Format>[0] & { calls: string[] };
    return { editor, calls };
  }

  it('无 model ⇒ false（一次停点都不推）', async () => {
    const applied = await applyKojo2Format({ getModel: () => null });
    expect(applied).toBe(false);
  });

  it('无变化 ⇒ false 且不占撤销栈位', async () => {
    const model = makeModel('# 机 开场\n# 视 我\n');
    const { editor, calls } = editorOf(model);
    expect(await applyKojo2Format(editor)).toBe(false);
    expect(calls).toEqual([]);
    expect(model.getValue()).toBe('# 机 开场\n# 视 我\n');
  });

  it('调用序 `停点 → executeEdits → 停点`，落地后文本等于格式化成品', async () => {
    const source = '# 机 开场\n# 视 我\n> 正文\n';
    const model = makeModel(source);
    const { editor, calls } = editorOf(model);
    expect(await applyKojo2Format(editor)).toBe(true);
    expect(calls).toEqual(['stop', 'edit', 'stop']);
    expect(model.getValue()).toBe(formatKojo2Source(source).code);
    expect(model.getValue()).toBe('# 机 开场\n# 视 我\n\n> 正文\n');
  });

  it('打字 → 格式化 ⇒ 第一次撤销只退格式化、作者那一笔仍在；第二次才退打字', async () => {
    const source = '# 机 开场\n# 视 我\n> 正文\n';
    const model = makeModel(source);
    const typed = '# 机 开场Z\n# 视 我\n> 正文\n';
    model.pushEditOperations(
      null,
      [
        {
          range: new monaco.Range(1, model.getLineMaxColumn(1), 1, model.getLineMaxColumn(1)),
          text: 'Z',
        },
      ],
      () => null,
    );
    expect(model.getValue()).toBe(typed);

    const { editor } = editorOf(model);
    expect(await applyKojo2Format(editor)).toBe(true);
    expect(model.getValue()).toBe('# 机 开场Z\n# 视 我\n\n> 正文\n');

    await model.undo();
    expect(model.getValue()).toBe(typed);
    expect(model.getValue()).toContain('Z');
    await model.undo();
    expect(model.getValue()).toBe(source);
    expect(model.getValue()).not.toContain('Z');
  });

  it('源码钉子：落地只经动态 import 的 `applyTextEdits`，本层没有第二套编辑机制', () => {
    const code = codeOf(LAYER_SOURCE);
    expect(code).toContain("await import('../ui/editor-global-providers')");
    expect(code).toContain('applyTextEdits(editor as unknown as Parameters<typeof applyTextEdits>[0]');
    expect(code).toContain('fromLine: edit.range.startLineNumber');
    expect(code).not.toContain('executeEdits');
    expect(code).not.toContain('pushUndoStop');
    // 静态图里只 import 类型：不把 Monaco 运行时拉进纯逻辑模块
    expect(code).toContain("import type * as Monaco from './entry'");
    expect(code).toContain("import type { applyTextEdits }");
    expect(code).not.toContain("from '@kojo/plugin-");
  });
});

/* ============================== ⑩ 区间格式化 provider ============================== */

describe('⑩区间格式化（Ctrl+K Ctrl+F）：provider 存在、只落选中行、选区外零编辑', () => {
  it('range provider 只挂 kojo2；一条 edit 落在选区内；代回后选区外逐字节不动', () => {
    stubFlag(true);
    const registered: { languageId: string; provider: Monaco.languages.DocumentRangeFormattingEditProvider }[] = [];
    const monacoStub = {
      languages: {
        registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
          registered.push({
            languageId,
            provider: provider as Monaco.languages.DocumentRangeFormattingEditProvider,
          });
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installKojo2RangeFormatter(monacoStub);
    // provider 存在且只认一门：kojo2（不与 ERB / v1 双注册）
    expect(registered.map((entry) => entry.languageId)).toEqual([KOJO2_LANGUAGE_ID]);

    const source = '# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「嗯。」\n';
    const requestedRange = { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 12 };
    const edits = registered[0]!.provider.provideDocumentRangeFormattingEdits(
      fakeModel(source) as unknown as Monaco.editor.ITextModel,
      requestedRange as Monaco.Range,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];

    // 只改选区：唯一一条 edit 的行范围落在请求的选区内
    expect(edits).toHaveLength(1);
    expect(edits[0]!.range.startLineNumber).toBe(requestedRange.startLineNumber);
    expect(edits[0]!.range.endLineNumber).toBe(requestedRange.endLineNumber);

    // 选区外零编辑：把 edit 代回原文，第 1 / 2 / 4 / 5 行逐字节不变
    const outLines = source.split('\n');
    outLines.splice(edits[0]!.range.startLineNumber - 1, 1, edits[0]!.text);
    const beforeLines = source.split('\n');
    expect(outLines[2]).toBe('        「早。」');
    for (const index of [0, 1, 3, 4]) {
      expect(outLines[index], `第 ${index + 1} 行被选区外改动了`).toBe(beforeLines[index]);
    }
  });
});

/* ============================== 小工具 ============================== */

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source: string): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**，注释里提到方法名不该把针弄红/弄绿 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
