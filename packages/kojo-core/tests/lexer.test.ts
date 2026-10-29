/**
 * 词法层回归：源事实（BOM/EOL）、五锚点、注释、等待三态、`@原生` 围栏、
 * 转义、插值扫描、旧写法判别、缩进诊断、50k 行单遍。
 */
import { describe, expect, it } from 'vitest';
import { decodeIntegerLiteral, isIntegerLiteralText, lex } from '../src/lexer.js';
import type { KojoInterpSegment, KojoLexLine } from '../src/tokens.js';

function kinds(source: string): string[] {
  return lex(source).lines.map((line) => line.kind);
}

function codesOf(source: string): string[] {
  return lex(source).diagnostics.map((diagnostic) => diagnostic.code);
}

function firstLine(source: string): KojoLexLine {
  const result = lex(source);
  return result.lines[0]!;
}

describe('lex：源事实（BOM / EOL）', () => {
  it('BOM 只记录事实，不并进首行内容', () => {
    const result = lex('\uFEFF# 机 指令 310\r\n> 好\r\n');
    expect(result.facts.bom).toBe('feff');
    expect(result.facts.contentStart).toBe(1);
    expect(result.facts.eol).toBe('crlf');
    expect(result.facts.crlf).toBe(2);
    expect(result.facts.lf).toBe(0);
    expect(result.facts.physicalLines).toBe(2);
    const first = result.lines[0]!;
    expect(first.kind).toBe('decl');
    expect(first.lineOffset).toBe(1);
    expect(first.text).toBe('# 机 指令 310');
  });

  it('CRLF / LF / 混合 EOL 是文件属性，不归一化', () => {
    const mixed = lex('a\r\nb\nc\r\n');
    expect(mixed.facts.eol).toBe('mixed');
    expect(mixed.facts.crlf).toBe(2);
    expect(mixed.facts.lf).toBe(1);
    expect(mixed.physical.map((line) => line.eol)).toEqual(['crlf', 'lf', 'crlf']);
    const lfOnly = lex('a\nb\n');
    expect(lfOnly.facts.eol).toBe('lf');
    const none = lex('a');
    expect(none.facts.eol).toBe('none');
    expect(none.physical[0]!.eol).toBe('none');
  });

  it('空文件 / 只有 BOM 的文件：0 行、无诊断', () => {
    for (const source of ['', '\uFEFF']) {
      const result = lex(source);
      expect(result.lines).toEqual([]);
      expect(result.physical).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    }
  });
});

describe('lex：五个锚点 + 台词 + 裸引号', () => {
  it('逐行分类', () => {
    const source = [
      '# 幕 神社清晨',
      '@算',
      '> 晨光透过鸟居。',
      '? 恋慕 >= 500',
      '! 早安问候',
      '灵梦：「{你}今天来得挺早嘛。」',
      '「裸台词」',
      '空行 续',
      '// 注释',
    ].join('\n');
    expect(kinds(source)).toEqual([
      'decl',
      'dispatch',
      'narration',
      'condition',
      'trigger',
      'dialogue',
      'bareQuote',
      'blankLine',
      'comment',
    ]);
  });

  it('锚点后必须跟空白：`>旁白` / `?条件` / `!调用` 报 core/lex/anchor', () => {
    for (const source of ['>旁白', '?条件', '!调用']) {
      expect(codesOf(source)).toContain('core/lex/anchor');
    }
  });

  it('`#` 与声明词之间必须有空格，#DIM 判为原生预处理器', () => {
    const dim = firstLine('#DIM X, 0');
    expect(dim.kind).toBe('legacy');
    if (dim.kind === 'legacy') expect(dim.legacy).toBe('preprocessor');
    expect(codesOf('#幕 x')).toContain('core/lex/anchor');
  });

  it('`@` 与调度词之间不许空白', () => {
    expect(codesOf('@ 算')).toContain('core/lex/anchor');
  });

  it('台词 = 说话人 + 全角冒号；半角冒号报锚点错但仍切出说话人', () => {
    const full = firstLine('灵梦：「早。」');
    expect(full.kind).toBe('dialogue');
    if (full.kind === 'dialogue') {
      expect(full.speaker).toBe('灵梦');
      expect(full.body).toBe('早。');
    }
    expect(codesOf('灵梦:「早。」')).toContain('core/lex/anchor');
  });

  it('`灵梦：「」` 缺右引号报错且标 invalid', () => {
    const result = lex('灵梦：「早。');
    expect(result.lines[0]!.kind).toBe('dialogue');
    expect(result.lines[0]!.invalid).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/lex/anchor');
  });
});

describe('lex：整行注释与 `;` 旧注释', () => {
  it('`//` 只认整行；正文里的 `//` 是正文', () => {
    const result = lex('// 注释\n> 看这个 // 不是注释');
    expect(result.lines[0]!.kind).toBe('comment');
    const narration = result.lines[1]!;
    expect(narration.kind).toBe('narration');
    if (narration.kind === 'narration') expect(narration.body).toBe('看这个 // 不是注释');
    expect(result.diagnostics).toEqual([]);
  });

  it('注释可写任意缩进，不报缩进错', () => {
    const result = lex('@算\n      // 任意缩进注释');
    expect(result.diagnostics).toEqual([]);
  });

  it('行首 `;` 判为旧注释（迁移由 parser 报）', () => {
    const line = firstLine('; 旧注释');
    expect(line.kind).toBe('legacy');
    if (line.kind === 'legacy') expect(line.legacy).toBe('semicolon');
  });
});

describe('lex：等待三态（`续` / `空行`）', () => {
  it('行尾 `续` → continue，且从正文剥离', () => {
    const line = firstLine('灵梦：「……好。」 续');
    expect(line.kind).toBe('dialogue');
    if (line.kind === 'dialogue') {
      expect(line.wait).toBe('continue');
      expect(line.body).toBe('……好。');
    }
  });

  it('`续` 紧贴正文不算等待标记', () => {
    const line = firstLine('> 继续前进');
    if (line.kind === 'narration') expect(line.wait).toBe('default');
    const glued = firstLine('> 继续');
    if (glued.kind === 'narration') expect(glued.wait).toBe('default');
  });

  it('空行三态', () => {
    const result = lex('空行\n空行 等待\n空行 续');
    expect(result.lines.map((line) => (line.kind === 'blankLine' ? line.wait : line.kind))).toEqual([
      'default',
      'wait',
      'continue',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('`空行 不等待` 是自造写法：报锚点错', () => {
    expect(codesOf('空行 不等待')).toContain('core/lex/anchor');
  });

  it('旧等待别名 `~` / `cont` 报迁移诊断且标 invalid', () => {
    for (const source of ['> 行尾波浪号~', '> 行尾 cont']) {
      const result = lex(source);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/migration/wait');
      expect(result.lines[0]!.invalid).toBe(true);
    }
  });
});

describe('lex：行尾表演提示', () => {
  it('`(心形)` 剥离为 hint，正文不含提示', () => {
    const line = firstLine('灵梦：「其实……{我}一直在等你。」(心形)');
    expect(line.kind).toBe('dialogue');
    if (line.kind === 'dialogue') {
      expect(line.hint?.text).toBe('心形');
      expect(line.hintCount).toBe(1);
      expect(line.body).toBe('其实……{我}一直在等你。');
    }
  });

  it('旁白里的全角（……）是正文，不是提示', () => {
    const line = firstLine('> 她别过头。（叹气）');
    if (line.kind === 'narration') {
      expect(line.hint).toBeNull();
      expect(line.body).toBe('她别过头。（叹气）');
    }
  });

  it('两组行尾提示：hintCount = 2（parser 报 bad-hint）', () => {
    const line = firstLine('灵梦：「嗯。」(心形)(微笑)');
    if (line.kind === 'dialogue') {
      expect(line.hintCount).toBe(2);
    }
  });

  it('配对顺序：`续` 在提示之后也能剥', () => {
    const line = firstLine('灵梦：「嗯。」(心形) 续');
    if (line.kind === 'dialogue') {
      expect(line.wait).toBe('continue');
      expect(line.hint?.text).toBe('心形');
    }
  });
});

describe('lex：@原生 缩进围栏', () => {
  it('围栏内是原文行，不再解释 2.0；围栏外恢复分类', () => {
    const source = ['@原生', '    ; ERB 注释', '    CALL X', '', '    // 不是 2.0 注释', '> 恢复旁白'].join('\n');
    const result = lex(source);
    expect(result.lines.map((line) => line.kind)).toEqual([
      'dispatch',
      'native',
      'native',
      'native',
      'native',
      'narration',
    ]);
    const first = result.lines[1]!;
    if (first.kind === 'native') {
      expect(first.raw).toBe('    ; ERB 注释');
      expect(first.blank).toBe(false);
    }
    const blank = result.lines[3]!;
    if (blank.kind === 'native') expect(blank.blank).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('围栏内 Tab 缩进不报结构缩进错', () => {
    const result = lex('@原生\n\tCALL X');
    expect(result.lines[1]!.kind).toBe('native');
    expect(result.diagnostics).toEqual([]);
  });

  it('围栏结束于缩进 ≤ 块头的非空行', () => {
    const result = lex('@原生\n    CALL X\n@算\n    x = 1');
    expect(result.lines.map((line) => line.kind)).toEqual(['dispatch', 'native', 'dispatch', 'text']);
  });
});

describe('lex：转义（§2.6）', () => {
  it('行首 `\\>` 还原为字面文本', () => {
    const line = firstLine('\\> 这不是旁白。');
    expect(line.kind).toBe('escaped');
    if (line.kind === 'escaped') {
      expect(line.escaped).toBe('>');
      expect(line.body).toBe('> 这不是旁白。');
    }
  });

  it('行首 `\\?` / `\\=` / `\\!` / `\\#` 同样还原，不再触发锚点或迁移', () => {
    for (const [source, escapedChar] of [
      ['\\? 这不是条件。', '?'],
      ['\\= 这不是迁移诊断。', '='],
      ['\\! 这不是调用。', '!'],
      ['\\# 这不是声明。', '#'],
    ] as const) {
      const result = lex(source);
      const line = result.lines[0]!;
      expect(line.kind, source).toBe('escaped');
      if (line.kind === 'escaped') expect(line.escaped).toBe(escapedChar);
      expect(result.diagnostics, source).toEqual([]);
    }
  });

  it('正文里 `\\{` / `\\}` / `\\\\` 输出字面字符', () => {
    const line = firstLine('> 字面\\{花括号\\}和\\\\反斜杠');
    if (line.kind === 'narration') {
      expect(line.parts).toHaveLength(1);
      const part = line.parts[0]!;
      if (part.kind === 'text') expect(part.text).toBe('字面{花括号}和\\反斜杠');
    }
  });
});

describe('lex：插值扫描（只扫不解析）', () => {
  it('普通插值：文本 / 表达式分段', () => {
    const line = firstLine('> 她今天看起来{心情}。');
    if (line.kind !== 'narration') throw new Error('not narration');
    expect(line.parts.map((part) => part.kind)).toEqual(['text', 'interp', 'text']);
    const interp = line.parts[1] as KojoInterpSegment;
    expect(interp.value).toBe('心情');
    expect(interp.condition).toBeNull();
  });

  it('`{条件 ? A : B}` 三段扫描（尊重字符串里的 `?` / `:`）', () => {
    const line = firstLine('灵梦：「{恋慕 >= 亲近线 ? "你最近……有点不一样。" : "今天也一起加油吧。"}」');
    if (line.kind !== 'dialogue') throw new Error('not dialogue');
    const interp = line.parts.find((part) => part.kind === 'interp') as KojoInterpSegment;
    expect(interp.condition).not.toBeNull();
    expect(interp.condition!.cond.text).toBe('恋慕 >= 亲近线');
    expect(interp.condition!.then.text).toBe('"你最近……有点不一样。"');
    expect(interp.condition!.else.text).toBe('"今天也一起加油吧。"');
  });

  it('未闭合 / 嵌套 / 空插值 报 core/lex/interpolation', () => {
    expect(codesOf('> 未闭合{心情')).toContain('core/lex/interpolation');
    expect(codesOf('> 嵌套{外{内}}')).toContain('core/lex/interpolation');
    expect(codesOf('> 空{}')).toContain('core/lex/interpolation');
    expect(codesOf('> 缺冒号{条件 ? A}')).toContain('core/lex/interpolation');
  });

  it('字符串里的花括号不当作插值边界', () => {
    const line = firstLine('> {条件 ? "a{b}" : "c"}');
    if (line.kind === 'narration') {
      const interp = line.parts[0] as KojoInterpSegment;
      expect(interp.condition?.then.text).toBe('"a{b}"');
    }
  });
});

describe('lex：声明行与 # 对照表 两列行', () => {
  it('声明词切分：word / rest / restOffset', () => {
    const line = firstLine('# 设 今天已触发 整数 = 0 存档');
    expect(line.kind).toBe('decl');
    if (line.kind === 'decl') {
      expect(line.word).toBe('设');
      expect(line.known).toBe(true);
      expect(line.rest).toBe('今天已触发 整数 = 0 存档');
      expect(line.restOffset).toBe(4);
    }
  });

  it('未知声明词走 known=false（parser 报 core/decl/unknown）', () => {
    const line = firstLine('# 未知词 x');
    if (line.kind === 'decl') expect(line.known).toBe(false);
  });

  it('# 对照表 的两列行是普通 text 行，原样留给 parser', () => {
    const result = lex('# 对照表 心情 依据 恋慕\n    0..99 -> 疏远\n');
    expect(result.lines[1]!.kind).toBe('text');
    expect(result.lines[1]!.text).toBe('0..99 -> 疏远');
  });
});

describe('lex：缩进（§4.13）', () => {
  it('结构行用 Tab 缩进报 core/lex/indent', () => {
    expect(codesOf('@算\n\tx = 1')).toContain('core/lex/indent');
  });

  it('缩进不是 4 的倍数报 core/lex/indent', () => {
    expect(codesOf('@算\n   x = 1')).toContain('core/lex/indent');
  });

  it('4 空格倍数不报', () => {
    expect(codesOf('@算\n    x = 1')).toEqual([]);
  });
});

describe('lex：旧写法判别（§12.1 全表）', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['如果 恋慕 >= 500：', 'if'],
    ['否则如果 恋慕 >= 100：', 'elif'],
    ['否则：', 'else'],
    ['当 心情：', 'when'],
    ['是 0：', 'is'],
    ['分支：', 'branch'],
    ['循环 3 次：', 'loop'],
    ['循环结束', 'loop-end'],
    ['调用 某函数', 'call'],
    ['返回 1', 'return'],
    ['标签 主菜单', 'goto-label'],
    ['跳到 战斗', 'goto-jump'],
    ['初回 "once"：', 'ask'],
    ['询问 "选哪个"：', 'ask'],
    ['确认 "确定吗"：', 'ask'],
    ['隐藏情景：', 'hidden-timing'],
    ['别名 好感 = CFLAG:1', 'alias'],
    ['旁白色 0xFF0000', 'color-option'],
    ['口上色 0x00FF00', 'color-option'],
    ['心形：', 'heart'],
    ['着色 0xFF8080：', 'color-block'],
    ['随机：', 'random-block'],
    ['组：', 'group-block'],
    ['数据表：', 'data-table'],
    ['数据表结束', 'data-table'],
    ['角色：灵梦', 'head-decl'],
    ['@LABEL 旧标签', 'native-label'],
    ['@旧函数块', 'raw-function'],
    ['= 返 1', 'equal-prefix'],
    ['# 版本 1.0', 'version'],
    ['# 时机 事件 100', 'timing'],
    ['#DIM X, 0', 'preprocessor'],
  ];
  it.each(cases)('%s → %s', (source, expected) => {
    const line = firstLine(source);
    expect(line.kind).toBe('legacy');
    if (line.kind === 'legacy') expect(line.legacy).toBe(expected);
  });

  it('`选项：` 不是旧语法：单独 kinds=options', () => {
    expect(firstLine('选项：').kind).toBe('options');
  });

  it('普通正文里出现这些词不算旧写法（词边界）', () => {
    for (const source of ['如果的事', '当たり前', '循环往复', '心形状的云']) {
      expect(firstLine(source).kind).toBe('text');
    }
  });
});

describe('lex：单遍性能（50k 行）', () => {
  it('50k 行一次扫完：行数正确、零诊断', () => {
    const chunk = '灵梦：「{恋慕 >= 亲近线 ? "A" : "B"}」 续\n> 晨光透过鸟居，斑驳地洒在石阶上。\n';
    const builder: string[] = [];
    for (let i = 0; i < 25000; i++) builder.push(chunk);
    const result = lex(builder.join(''));
    expect(result.lines.length).toBe(50000);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts.lf).toBe(50000);
  });
});

describe('decodeIntegerLiteral · 安全整数闸（2026-10-26 批）', () => {
  /** 边界值 2^53-1 本身仍可精确表示 ⇒ 解码；再大一律 null（不再静默舍入） */
  const MAX = Number.MAX_SAFE_INTEGER;

  it('边界内照常解码（十进制 / 带符号 / 十六进制）', () => {
    expect(decodeIntegerLiteral('9007199254740991')).toBe(MAX);
    expect(decodeIntegerLiteral('-9007199254740991')).toBe(-MAX);
    expect(decodeIntegerLiteral('  +42  ')).toBe(42);
    expect(decodeIntegerLiteral('0x1F')).toBe(31);
  });

  it('超过 MAX_SAFE_INTEGER ⇒ null（旧行为是 `parseInt` 后的舍入值）', () => {
    // 改前读数：decodeIntegerLiteral('12345678901234567890') === 12345678901234567000
    expect(decodeIntegerLiteral('12345678901234567890')).toBeNull();
    expect(decodeIntegerLiteral('9007199254740992')).toBeNull(); // 2^53
    expect(decodeIntegerLiteral('-9007199254740992')).toBeNull();
    expect(decodeIntegerLiteral('0xFFFFFFFFFFFFFFFF')).toBeNull(); // 2^64-1
  });

  it('isIntegerLiteralText 只判形状：区分"不是字面量"与"是字面量但超界"', () => {
    expect(isIntegerLiteralText('12345678901234567890')).toBe(true);
    expect(isIntegerLiteralText('-0x10')).toBe(true);
    expect(isIntegerLiteralText('1.5')).toBe(false);
    expect(isIntegerLiteralText('abc')).toBe(false);
    expect(isIntegerLiteralText('')).toBe(false);
  });
});
