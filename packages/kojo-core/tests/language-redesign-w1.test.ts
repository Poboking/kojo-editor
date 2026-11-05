/**
 * W1 语言重构表面测试：新正典（方寸声明 / 冒号动作 / 若-否则 / 演调用 / 裸行旁白 / ※）
 * 必须与旧写法产出**同一棵 AST 语义**（用 fake backend 的确定性编码比对 lowering 结果）。
 *
 * 规范：`docs/KOJO-2.0-LANGUAGE-REDESIGN.md` §2 / §6 W1。
 */
import { describe, expect, it } from 'vitest';
import type { KojoFile, KojoTextLine } from '../src/ast.js';
import { lowerFile } from '../src/lower/index.js';
import { parseSource } from '../src/parser.js';
import { createFakeBackend } from './lower-fake-backend.js';

function parseOk(source: string): KojoFile {
  const file = parseSource(source);
  const errors = file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors, JSON.stringify(errors.map((e) => [e.code, e.message]))).toEqual([]);
  return file;
}

function linesOf(source: string): readonly string[] {
  const result = lowerFile(parseOk(source), { backend: createFakeBackend() });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors, JSON.stringify(errors.map((e) => [e.code, e.message]))).toEqual([]);
  return result.lines;
}

const OLD_FULL = `# 幕 清晨
# 视角 灵梦
# 机 指令 310
# 设 亲近线 整数 = 500
# 设 心情快照 字符串 场景

# 对照表 心情 依据 恋慕
    0..99 -> 疏远
    100..499 -> 平常
    亲近线.. -> 亲近
    否 -> 未知

> 晨光透过鸟居。
灵梦：「今天来得挺早。」

? 恋慕 >= 亲近线
    灵梦：「……嗯。」
? 否
    灵梦：「……早。」

@算
    心情快照 = 心情

# 池 问候
    ? 恋慕 < 100
        「……早。」
    ? 否
        「早上好。」

! 问候
`;

const NEW_FULL = `【幕 清晨】
【视角 灵梦】
【挂 指令 310】
【定 亲近线 数 = 500】
【设 心情快照 文字 场景】

【对照表 心情 依据 恋慕】
    0..99 → 疏远
    100..499 → 平常
    亲近线.. → 亲近
    否 → 未知

晨光透过鸟居。
灵梦：「今天来得挺早。」

若 恋慕 >= 亲近线：
    灵梦：「……嗯。」
否则：
    灵梦：「……早。」

算：
    心情快照 = 心情

【池 问候】
    若 恋慕 < 100：
        「……早。」
    否则：
        「早上好。」

演：问候
`;

describe('W1：新正典完整示例与旧写法同 lowering', () => {
  it('新写法零 error', () => {
    parseOk(NEW_FULL);
  });

  it('新旧完整示例产出逐行相同的 lowering 结果', () => {
    expect(linesOf(NEW_FULL)).toEqual(linesOf(OLD_FULL));
  });

  it('方寸声明覆盖 幕/视角/挂/设/对照表/池；挂 归一化为 # 机 语义', () => {
    const file = parseOk(NEW_FULL);
    const words = file.decls.map((decl) => decl.kind);
    expect(words).toContain('machine');
    expect(words).toContain('view');
    expect(file.scenes.length).toBe(1);
    expect(file.scenes[0]?.title).toBe('清晨');
    const table = file.decls.find((decl) => decl.kind === 'table');
    expect(table?.name).toBe('心情');
    // 方寸收口 `】` 不能切进表判别式表达式（真实编译 bug：`{外部计数】}`）。
    if (table?.kind === 'table') expect(table.subject.text).toBe('恋慕');
    expect(file.decls.find((decl) => decl.kind === 'pool')?.name).toBe('问候');
  });
});

describe('W1：冒号动作族', () => {
  it('算：= @算', () => {
    expect(linesOf('【挂 指令 310】\n【设 x 整数】\n算：\n    x = 1\n')).toEqual(
      linesOf('# 机 指令 310\n# 设 x 整数\n@算\n    x = 1\n'),
    );
  });

  it('色：= @着色；颜绘：= @颜绘', () => {
    const newSrc = '【挂 指令 310】\n色：0xFF8080\n    灵梦：「红」\n颜绘：笑顔\n';
    const oldSrc = '# 机 指令 310\n@着色 0xFF8080\n    灵梦：「红」\n@颜绘 笑顔\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('择一：/组： = @随机/@组', () => {
    const newSrc = '【挂 指令 310】\n择一：\n    灵梦：「甲」\n    组：\n        灵梦：「乙」\n        > 乙的旁白。\n';
    const oldSrc =
      '# 机 指令 310\n@随机\n    灵梦：「甲」\n    @组\n        灵梦：「乙」\n        > 乙的旁白。\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('循环/重复/遍历/断/续 = @循/@复/@巡/@断/@续', () => {
    const newSrc = `【挂 指令 310】
【设 i 整数 = 0】
循环：i < 3
    i += 1
    续
    断
重复：2
    > 重复。
遍历：队伍
    > {名}
`;
    const oldSrc = `# 机 指令 310
# 设 i 整数 = 0
@循 i < 3
    i += 1
    @续
    @断
@复 2
    > 重复。
@巡 队伍
    > {名}
`;
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('标：/跳： = @标/@跳', () => {
    const newSrc = '【挂 指令 310】\n标：回\n> 再来。\n跳：回\n';
    const oldSrc = '# 机 指令 310\n@标 回\n> 再来。\n@跳 回\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('演：名字(args) = ! 名字(args)', () => {
    const newSrc = '【挂 指令 310】\n【函 加(a, b = 2)】\n    @返 a + b\n演：加(1)\n';
    const oldSrc = '# 机 指令 310\n@函 加(a, b = 2)\n    @返 a + b\n! 加(1)\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });
});

describe('W1：若/再若/否则', () => {
  it('与 ? 链同 lowering（含中段与默认分支）', () => {
    const newSrc = `【挂 指令 310】
【设 n 整数 = 100】
若 n > 500：
    > 大。
再若 n > 50：
    > 中。
否则：
    > 小。
`;
    const oldSrc = `# 机 指令 310
# 设 n 整数 = 100
? n > 500
    > 大。
? n > 50
    > 中。
? 否
    > 小。
`;
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('若 后没有收口冒号时当正文（旁白），不误判条件', () => {
    const file = parseOk('【挂 指令 310】\n若你愿意，就留下来吧。\n');
    expect(file.scenes[0]?.items[0]?.kind).toBe('textLine');
  });
});

describe('W1：裸行旁白与 ※ 注释', () => {
  it('裸行旁白 = > 旁白', () => {
    expect(linesOf('【挂 指令 310】\n晨光透过鸟居。\n')).toEqual(
      linesOf('# 机 指令 310\n> 晨光透过鸟居。\n'),
    );
  });

  it('裸行里的赋值/调用仍报「叙事区不写裸表达式」，不静默变正文', () => {
    const assign = parseSource('【挂 指令 310】\nx = 1\n');
    expect(assign.diagnostics.map((d) => d.code)).toContain('core/narrative/bare-expression');
    const call = parseSource('【挂 指令 310】\n记录("hi")\n');
    expect(call.diagnostics.map((d) => d.code)).toContain('core/narrative/bare-expression');
  });

  it('※ 整行注释被忽略（产物不打印）', () => {
    const withComment = linesOf('【挂 指令 310】\n※ 这是注释\n晨光。\n');
    const without = linesOf('【挂 指令 310】\n晨光。\n');
    expect(withComment).toEqual(without);
  });
});

describe('W1：行首保留词不静默吃正文', () => {
  it('循环：/否则： 后接中文句读不会静默变控制流；演： 后接句读按旁白', () => {
    const loop = parseSource('【挂 指令 310】\n循环：日子一天天过去。\n');
    expect(loop.diagnostics.map((d) => d.code)).toContain('core/migration/loop');
    expect(loop.scenes.flatMap((scene) => scene.items)).toEqual([]);

    const otherwise = parseSource('【挂 指令 310】\n否则：我们走吧。\n');
    expect(
      otherwise.diagnostics.some(
        (d) => d.code === 'core/migration/if' || d.code === 'core/migration/else',
      ),
    ).toBe(true);

    const perform = parseOk('【挂 指令 310】\n演：她笑了。\n');
    expect(perform.scenes[0]?.items[0]?.kind).toBe('textLine');
  });

  it('算：/组：/择一： 是块头，行内接内容给显式诊断而不是静默', () => {
    for (const text of ['算：今天心情不错。', '组：随便写点什么。', '择一：就这样吧。']) {
      const file = parseSource(`【挂 指令 310】\n${text}\n`);
      expect(file.diagnostics.map((d) => d.code), text).toContain('core/lex/anchor');
    }
  });

  it('`\\续` 输出字面「续」，不当等待标记', () => {
    const file = parseOk('【挂 指令 310】\n\\续\n');
    const line = file.scenes[0]?.items[0] as KojoTextLine;
    expect(line.kind).toBe('textLine');
    expect(line.wait).toBe('default');
    expect(line.parts[0]).toEqual({ kind: 'text', text: '续' });
  });
});

describe('W1：旧写法继续兼容', () => {  it('# / @ / ? / ! / > 五锚点旧例零 error', () => {
    parseOk(OLD_FULL);
  });

  it('旧 # 机 与新 【挂 …】 都保留 machine 声明；旧写法不多报新表面诊断', () => {
    const oldFile = parseSource('# 机 指令 310\n# 幕 清晨\n> 正文。\n');
    expect(oldFile.diagnostics).toEqual([]);
  });
});
