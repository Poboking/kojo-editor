/**
 * 文法层回归：2.0 全语法正例（fixtures/kojo2-canonical.kojo2）+ 旧写法反例
 * （fixtures/legacy-v1.kojo.txt）+ 各类结构/诊断单测（§3–§9）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  KojoBlankLine,
  KojoCallStmt,
  KojoConditionChain,
  KojoFile,
  KojoForEachLoop,
  KojoFunctionDecl,
  KojoNativeBlock,
  KojoOptionsBlock,
  KojoRepeatLoop,
  KojoTableDecl,
  KojoTextLine,
  KojoWhileLoop,
} from '../src/ast.js';
import { lex } from '../src/lexer.js';
import { parse, parseSource } from '../src/parser.js';

const MACHINE = '# 机 指令 310\n';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function codesOf(source: string): string[] {
  return parseSource(source).diagnostics.map((diagnostic) => diagnostic.code);
}

function errorCodesOf(source: string): string[] {
  return parseSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.code);
}

function warningCodesOf(source: string): string[] {
  return parseSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
    .map((diagnostic) => diagnostic.code);
}

function parseOk(source: string): KojoFile {
  const file = parseSource(source);
  const errors = file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors, `unexpected errors: ${JSON.stringify(errors.map((e) => `${e.code}@${e.span?.start.line}`))}`).toEqual([]);
  return file;
}

function firstSceneItems(source: string) {
  return parseSource(source).scenes[0]?.items ?? [];
}

describe('parse：2.0 正典 fixture 全绿', () => {
  it('fixture 无 error 诊断', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const errors = file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.map((error) => `${error.code}: ${error.message}`)).toEqual([]);
  });

  it('声明提升：decls 顺序 = 书写顺序，幕不进 decls', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    expect(file.decls.map((decl) => decl.kind)).toEqual([
      'view',
      'machine',
      'const',
      'var',
      'var',
      'var',
      'var',
      'var',
      'table',
      'pool',
      'template',
      'function',
      'weave',
    ]);
  });

  it('幕按书写序切成 scenes；首个幕之前无正文 ⇒ 无隐式前奏', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    expect(file.scenes.map((scene) => scene.title)).toEqual(['神社清晨', '神社夜晚']);
  });

  it('第一幕覆盖 §4–§9 的叙事/演出/调度形状', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const kinds = new Set(file.scenes[0]!.items.map((node) => node.kind));
    for (const kind of [
      'textLine',
      'sandboxBlock',
      'colorBlock',
      'faceLine',
      'randomBlock',
      'conditionChain',
      'call',
      'blankLine',
      'nativeBlock',
      'label',
      'jump',
    ]) {
      expect(kinds, `missing ${kind}`).toContain(kind);
    }
  });

  it('第二幕：program 层三个循环是叙事区节点', () => {
    const nodes = parseSource(fixture('kojo2-canonical.kojo2')).scenes[1]!.items;
    const whileLoop = nodes.find((node) => node.kind === 'whileLoop') as KojoWhileLoop | undefined;
    const repeatLoop = nodes.find((node) => node.kind === 'repeatLoop') as KojoRepeatLoop | undefined;
    const forEachLoop = nodes.find((node) => node.kind === 'forEachLoop') as KojoForEachLoop | undefined;
    expect(whileLoop?.test.text).toBe('体力恢复 < 100');
    expect(repeatLoop?.count.text).toBe('3');
    expect(forEachLoop?.collection.text).toBe('队伍');
  });

  it('# 表：静态分档 + 否 兜底 + 开放区间', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const table = file.decls.find((decl) => decl.kind === 'table') as KojoTableDecl;
    expect(table.name).toBe('心情');
    expect(table.subject.text).toBe('恋慕');
    expect(table.rows).toHaveLength(4);
    expect([table.rows[0]!.from?.text, table.rows[0]!.to?.text, table.rows[0]!.value]).toEqual(['0', '99', '疏远']);
    expect([table.rows[2]!.from?.text, table.rows[2]!.to, table.rows[2]!.value]).toEqual(['亲近线', null, '亲近']);
    expect([table.rows[3]!.from, table.rows[3]!.to, table.rows[3]!.value]).toEqual([null, null, '未知']);
  });

  it('# 池：一条 ? 链 + 裸引号默认说话人 + 行尾提示', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const pool = file.decls.find((decl) => decl.kind === 'pool');
    if (pool?.kind !== 'pool') throw new Error('no pool');
    expect(pool.name).toBe('早安问候');
    expect(pool.branches).toHaveLength(3);
    expect(pool.branches[2]!.test).toBeNull();
    const first = pool.branches[2]!.body[0] as KojoTextLine;
    expect(first.kind).toBe('textLine');
    expect(first.speech.kind).toBe('bareQuote');
    expect(first.hint).toBe('拥抱');
  });

  it('# 模：参数 + 唯一 [插槽] 位置', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const template = file.decls.find((decl) => decl.kind === 'template');
    if (template?.kind !== 'template') throw new Error('no template');
    expect(template.name).toBe('娇羞退场');
    expect(template.params.map((param) => param.name)).toEqual(['原因']);
    expect(template.slotIndex).toBe(1);
    expect(template.body).toHaveLength(2); // `[插槽]` 不进 body，slotIndex 指出位置
  });

  it('@函：参数默认值 + 返回 + 调度区裸写赋值', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const fn = file.decls.find((decl) => decl.kind === 'function') as KojoFunctionDecl;
    expect(fn.name).toBe('增加羁绊');
    expect(fn.params.map((param) => [param.name, param.defaultValue])).toEqual([
      ['目标', undefined],
      ['数值', 10],
      ['理由', '日常'],
    ]);
    expect(fn.body.map((node) => node.kind)).toEqual(['assign', 'call', 'dispatchCondition']);
  });

  it('@织：修饰词 → later，块体是叙事节点', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const weave = file.decls.find((decl) => decl.kind === 'weave');
    if (weave?.kind !== 'weave') throw new Error('no weave');
    expect(weave.event).toBe('回合末');
    expect(weave.modifiers).toEqual(['later']);
    expect(weave.body[0]!.kind).toBe('conditionChain');
  });

  it('@原生：去基准缩进、相对缩进与 Tab/原文保留', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const native = file.scenes[0]!.items.find((node) => node.kind === 'nativeBlock') as KojoNativeBlock;
    expect(native.lines).toEqual([
      '; 逃生舱：底层 ERB 代码',
      'CALL HPH_PRINT "w"',
      'IF FLAG:1',
      '    PRINTFORML 原样保留',
      'ENDIF',
    ]);
  });

  it('插值：三段条件插值进 AST（cond / then / else 都是源切片）', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const line = file.scenes[0]!.items[2] as KojoTextLine;
    if (line.kind !== 'textLine') throw new Error('not text line');
    const interp = line.parts.find((part) => part.kind === 'interp');
    if (interp?.kind !== 'interp') throw new Error('no interp');
    expect(interp.cond?.cond.text).toBe('恋慕 >= 亲近线');
    expect(interp.cond?.then.text).toBe('"你最近……有点不一样。"');
  });

  it('模板调用带缩进块 = 插槽内容', () => {
    const file = parseSource(fixture('kojo2-canonical.kojo2'));
    const calls = file.scenes[0]!.items.filter((node): node is KojoCallStmt => node.kind === 'call');
    const withBody = calls.find((call) => call.name === '娇羞退场');
    expect(withBody?.body).toHaveLength(1);
    expect(withBody?.body?.[0]?.kind).toBe('textLine');
    const withoutBody = calls.find((call) => call.name === '早安问候');
    expect(withoutBody?.body).toBeUndefined();
  });
});

describe('parse：旧写法反例全部报迁移诊断，且不进 AST', () => {
  it('legacy fixture 覆盖 §12.1 迁移码', () => {
    const codes = new Set(codesOf(fixture('legacy-v1.kojo.txt')));
    for (const code of [
      'core/migration/version',
      'core/migration/timing',
      'core/migration/raw',
      'core/migration/comment',
      'core/migration/if',
      'core/migration/switch',
      'core/migration/loop',
      'core/migration/call-return',
      'core/migration/heart',
      'core/migration/color',
      'core/migration/random',
      'core/migration/data',
      'core/migration/branch',
      'core/migration/alias',
      'core/migration/color-option',
      'core/migration/ask',
      'core/migration/hidden-timing',
      'core/migration/label',
      'core/migration/wait',
      'core/narrative/bare-quote',
      'core/narrative/bare-narration',
    ]) {
      expect(codes, `missing ${code}`).toContain(code);
    }
  });

  it('`选项：` 不是旧语法：warning + 真节点（body 不丢）', () => {
    const file = parseSource(fixture('legacy-v1.kojo.txt'));
    expect(file.diagnostics.some((diagnostic) => diagnostic.code === 'core/options/pending' && diagnostic.severity === 'warning')).toBe(true);
    const options = file.scenes
      .flatMap((scene) => scene.items)
      .find((node): node is KojoOptionsBlock => node.kind === 'optionsBlock');
    expect(options?.items).toHaveLength(1);
    expect(options?.items[0]!.label).toBe('标签');
    expect(options?.items[0]!.body[0]?.kind).toBe('textLine');
  });

  it('旧写法不产出 AST：legacy fixture 的 decls 只有合法 # 机', () => {
    const file = parseSource(fixture('legacy-v1.kojo.txt'));
    expect(file.decls.map((decl) => decl.kind)).toEqual(['machine']);
  });

  it('`若/当/循环` 之类词边界：正文里的词不误报', () => {
    expect(codesOf(`${MACHINE}> 如果的事\n> 当たり前\n> 循环往复\n> 心形状的云\n`)).toEqual([]);
  });

  it('`如果` 混进 `?` 链单独报迁移，链本身不断', () => {
    const file = parseSource(`${MACHINE}? 恋慕 >= 500\n    如果 恋慕 >= 100\n        > 旧分支\n? 否\n    > 兜底\n`);
    expect(file.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/migration/if');
    const chain = file.scenes[0]!.items.find((node): node is KojoConditionChain => node.kind === 'conditionChain');
    expect(chain?.branches).toHaveLength(2);
  });
});

describe('parse：文件结构与声明（§3）', () => {
  it('隐式前奏场景：首个 # 幕 之前的正文落 title=null', () => {
    const file = parseOk(`${MACHINE}> 前奏\n# 幕 第一幕\n> 正片\n`);
    expect(file.scenes.map((scene) => scene.title)).toEqual([null, '第一幕']);
    expect(file.scenes[0]!.items).toHaveLength(1);
  });

  it('没有 # 幕：整文件一个隐式场景', () => {
    const file = parseOk(`${MACHINE}> 只有正文\n`);
    expect(file.scenes).toHaveLength(1);
    expect(file.scenes[0]!.title).toBeNull();
  });

  it('有正文没有 # 机 → core/decl/missing-machine', () => {
    expect(errorCodesOf('> 裸正文\n')).toContain('core/decl/missing-machine');
    expect(errorCodesOf('# 幕 标题\n> 正文\n')).toContain('core/decl/missing-machine');
  });

  it('多 # 机 / 多 # 视 报错', () => {
    expect(codesOf('# 机 a\n# 机 b\n')).toContain('core/decl/multiple-machine');
    expect(codesOf('# 视 a\n# 视 b\n')).toContain('core/decl/multiple-view');
  });

  it('未知声明词 → core/decl/unknown', () => {
    expect(codesOf('# 未知词 x\n')).toContain('core/decl/unknown');
  });

  it('# 变量：类型 / 数组 / 初值 / 存储期', () => {
    const file = parseOk(
      `${MACHINE}# 变量 临时 整数\n# 变量 今天已触发 整数 = 0 存档\n# 变量 队列 整数[10]\n# 变量 队员 字符串[4] 存档\n# 变量 名字 字符串 = "灵梦"\n`,
    );
    expect(
      file.decls
        .filter((decl) => decl.kind === 'var')
        .map((decl) => (decl.kind === 'var' ? [decl.name, decl.valueType, decl.storage, decl.arraySize?.text, decl.init] : null)),
    ).toEqual([
      ['临时', 'int', 'scene', undefined, undefined],
      ['今天已触发', 'int', 'save', undefined, 0],
      ['队列', 'int', 'scene', '10', undefined],
      ['队员', 'string', 'save', '4', undefined],
      ['名字', 'string', 'scene', undefined, '灵梦'],
    ]);
  });

  it('# 常量：必须字面量；类型不符 / 非字面量报错', () => {
    expect(
      parseOk(`${MACHINE}# 常量 最大好感 整数 = 1000\n# 常量 标题 字符串 = "神社的清晨"\n`).decls.filter(
        (decl) => decl.kind === 'const',
      ),
    ).toHaveLength(2);
    expect(codesOf(`${MACHINE}# 常量 X 整数 = "文本"\n`)).toContain('core/decl/bad-initializer');
    expect(codesOf(`${MACHINE}# 常量 X 整数 = 某函数(1)\n`)).toContain('core/decl/const-not-constant');
    expect(codesOf(`${MACHINE}# 常量 X 整数\n`)).toContain('core/decl/bad-initializer');
    expect(codesOf(`${MACHINE}# 常量 X\n`)).toContain('core/lex/anchor');
  });

  it('# 变量：坏类型 / 坏数组长度 / 坏初值 / 坏存储期', () => {
    expect(codesOf(`${MACHINE}# 变量 x 逻辑\n`)).toContain('core/decl/unknown-type');
    expect(codesOf(`${MACHINE}# 变量 x 整数[0]\n`)).toContain('core/decl/bad-array-size');
    expect(codesOf(`${MACHINE}# 变量 x 整数[abc+1]\n`)).toContain('core/decl/bad-array-size');
    expect(codesOf(`${MACHINE}# 变量 x 整数 = 1 + 2\n`)).toContain('core/decl/bad-initializer');
    expect(codesOf(`${MACHINE}# 变量 x 整数 永久\n`)).toContain('core/decl/unknown-storage');
    expect(codesOf(`${MACHINE}# 变量 x 整数[2] = 0\n`)).toContain('core/decl/bad-initializer');
  });

  it('命名空间：重名 / 保留前缀 / 域符号', () => {
    expect(codesOf(`${MACHINE}# 变量 x 整数\n# 变量 x 整数\n`)).toContain('core/decl/duplicate-name');
    expect(codesOf(`${MACHINE}# 变量 __kojo_x 整数\n`)).toContain('core/decl/reserved-name');
    expect(codesOf(`${MACHINE}# 变量 我 整数\n`)).toContain('core/decl/reserved-name');
  });

  it('声明写进块 → core/decl/not-top-level', () => {
    expect(codesOf(`${MACHINE}@算\n    # 变量 x 整数\n`)).toContain('core/decl/not-top-level');
    expect(codesOf(`${MACHINE}# 池 p\n    ? 1\n        # 表 t 由 x\n`)).toContain('core/decl/not-top-level');
  });

  it('# 表：缺列 / 否 空值 / 空表由 parser 只出 shape 错', () => {
    expect(codesOf(`${MACHINE}# 表 T 由 x\n    0..99\n`)).toContain('core/table/value-empty');
    expect(codesOf(`${MACHINE}# 表 T 由 x\n    否\n`)).toContain('core/table/empty-default');
    expect(codesOf(`${MACHINE}# 表 T 由 x\n    .. 值\n`)).toContain('core/table/dynamic-endpoint');
    expect(codesOf(`${MACHINE}# 表 T x\n`)).toContain('core/lex/anchor');
  });

  it('# 表：精确值编码为两端同值；空行结束表', () => {
    const file = parseOk(`${MACHINE}# 表 T 由 x\n    5 五\n    否 无\n\n> 表外\n`);
    const table = file.decls.find((decl) => decl.kind === 'table') as KojoTableDecl;
    expect([table.rows[0]!.from?.text, table.rows[0]!.to?.text]).toEqual(['5', '5']);
    expect(file.scenes[0]!.items).toHaveLength(1);
  });

  it('# 表 值列：首尾 trim、内部保留、引号解码', () => {
    const file = parseOk(`${MACHINE}# 表 T 由 x\n    0   "  中间 保留  "\n    1   裸文本 内部\n    否  未知\n`);
    const table = file.decls.find((decl) => decl.kind === 'table') as KojoTableDecl;
    expect(table.rows[0]!.value).toBe('  中间 保留  ');
    expect(table.rows[1]!.value).toBe('裸文本 内部');
  });

  it('# 池：没有 # 视 时裸引号报 core/pool/no-view', () => {
    expect(codesOf('# 机 x\n# 池 p\n    ? 1\n        灵梦：「a」\n    ? 否\n        「b」\n')).toContain('core/pool/no-view');
  });

  it('# 池 体不是 ? 链 → core/pool/no-default', () => {
    expect(codesOf(`${MACHINE}# 池 p\n    > 正文\n`)).toContain('core/pool/no-default');
  });

  it('# 池 内禁止副作用', () => {
    const codes = new Set(codesOf(`${MACHINE}# 视 灵梦\n# 池 p\n    ? 1\n        @算\n            x = 1\n    ? 否\n        「a」\n`));
    expect(codes).toContain('core/pool/side-effect');
  });
});

describe('parse：条件链（§5）', () => {
  const chainSource = `${MACHINE}? 恋慕 >= 500\n    > 高\n? 恋慕 >= 100\n    > 中\n? 否\n    > 低\n`;
  it('连续同缩进 ? 行构成一条链，首分支优先', () => {
    const file = parseOk(chainSource);
    const chain = file.scenes[0]!.items[0] as KojoConditionChain;
    expect(chain.kind).toBe('conditionChain');
    expect(chain.branches).toHaveLength(3);
    expect(chain.branches[0]!.test?.text).toBe('恋慕 >= 500');
    expect(chain.branches[2]!.test).toBeNull();
  });

  it('物理空行断链：空行后的 ? 否 是另一条链', () => {
    const file = parseOk(`${MACHINE}? 1\n    > a\n\n? 否\n    > b\n`);
    const chains = file.scenes[0]!.items.filter((node): node is KojoConditionChain => node.kind === 'conditionChain');
    expect(chains).toHaveLength(2);
  });

  it('注释不打断链', () => {
    const file = parseOk(`${MACHINE}? 1\n    > a\n// 注释\n? 否\n    > b\n`);
    expect(file.scenes[0]!.items.filter((node) => node.kind === 'conditionChain')).toHaveLength(1);
  });

  it('调度区 ? 链 = dispatchCondition', () => {
    const file = parseOk(`${MACHINE}@算\n    ? x == 1\n        y = 2\n    ? 否\n        y = 3\n`);
    const sandbox = file.scenes[0]!.items[0];
    if (sandbox?.kind !== 'sandboxBlock') throw new Error('no sandbox');
    expect(sandbox.body[0]!.kind).toBe('dispatchCondition');
  });
});

describe('parse：调度区与演出块（§8）', () => {
  it('@算：块头不接行内内容；赋值 / 增量 / 数组元素 / .长度', () => {
    expect(codesOf(`${MACHINE}@算 多余\n`)).toContain('core/lex/anchor');
    const file = parseOk(`${MACHINE}@算\n    x = 1\n    x += 2\n    队伍[0] = "健康"\n    人数 = 队伍.长度\n`);
    const sandbox = file.scenes[0]!.items[0];
    if (sandbox?.kind !== 'sandboxBlock') throw new Error('no sandbox');
    expect(sandbox.body.map((node) => (node.kind === 'assign' ? node.op : node.kind))).toEqual(['=', '+=', '=', '=']);
  });

  it('调度区纯表达式行 → core/expr/not-expression；裸调用允许为 exprCall', () => {
    expect(codesOf(`${MACHINE}@算\n    1 + 2\n`)).toContain('core/expr/not-expression');
    const file = parseOk(`${MACHINE}@算\n    记录("hi")\n`);
    const sandbox = file.scenes[0]!.items[0];
    if (sandbox?.kind !== 'sandboxBlock') throw new Error('no sandbox');
    expect(sandbox.body[0]!.kind).toBe('exprCall');
  });

  it('@着色：平级块 OK；嵌套报 core/color/nested', () => {
    parseOk(`${MACHINE}? 1\n    @着色 0xFF8080\n        > 红\n? 否\n    @着色 0x8080FF\n        > 蓝\n`);
    expect(codesOf(`${MACHINE}@着色 0xFF8080\n    @着色 0x8080FF\n        > 红\n`)).toContain('core/color/nested');
  });

  it('@着色 里只有计算 → warning core/color/no-output', () => {
    expect(warningCodesOf(`${MACHINE}@着色 0xFF8080\n    @算\n        x = 1\n`)).toContain('core/color/no-output');
  });

  it('@颜绘：对象只认 我/你；超过 4 个参数报错', () => {
    const file = parseOk(`${MACHINE}# 视 灵梦\n@颜绘 笑顔 服1\n@颜绘 你 自慰 裸\n`);
    const faces = file.scenes[0]!.items;
    expect(faces[0]!.kind).toBe('faceLine');
    if (faces[0]!.kind === 'faceLine') expect(faces[0]!.object).toBeNull();
    if (faces[1]!.kind === 'faceLine') {
      expect(faces[1]!.object).toBe('you');
      expect(faces[1]!.args.map((arg) => arg.text)).toEqual(['自慰', '裸']);
    }
    expect(codesOf(`${MACHINE}@颜绘 我 表 情 服 差 效\n`)).toContain('core/face/args');
  });

  it('@随机：单行候选 + @组；只有一个候选 / 嵌套 / 空行 / 裸控制 报错', () => {
    const file = parseOk(`${MACHINE}@随机\n    > a\n    @组\n        > b\n        > c\n`);
    const random = file.scenes[0]!.items[0];
    if (random?.kind !== 'randomBlock') throw new Error('no random');
    expect(random.candidates.map((candidate) => candidate.kind)).toEqual(['randomLine', 'randomGroup']);
    expect(codesOf(`${MACHINE}@随机\n    > a\n`)).toContain('core/random/one-candidate');
    expect(codesOf(`${MACHINE}@随机\n    @随机\n        > a\n`)).toContain('core/random/nested');
    expect(codesOf(`${MACHINE}@随机\n    > a\n\n    > b\n`)).toContain('core/random/empty-line');
    expect(codesOf(`${MACHINE}@随机\n    ? 1\n        > a\n`)).toContain('core/random/bare-control');
    expect(codesOf(`${MACHINE}@组\n    > a\n`)).toContain('core/random/group-nested');
    expect(codesOf(`${MACHINE}@算\n    @随机\n        > a\n`)).toContain('core/random/unsupported');
  });

  it('@原生：空块 / 缩进不足 / 禁止位置', () => {
    expect(codesOf(`${MACHINE}@原生\n`)).toContain('core/native/empty');
    expect(codesOf(`${MACHINE}@原生\n  CALL X\n`)).toContain('core/native/indent');
    expect(codesOf(`${MACHINE}@随机\n    > a\n    @原生\n        CALL X\n    > b\n`)).toContain('core/native/disallowed-location');
  });

  it('@织：修饰词冲突；块内 # 幕 报 core/weave/scene-inside', () => {
    expect(codesOf(`${MACHINE}@织 回合末 之前 之后\n    > a\n`)).toContain('core/weave/modifier-conflict');
    expect(codesOf(`${MACHINE}@织 回合末 接管 之后\n    > a\n`)).toContain('core/weave/modifier-conflict');
    expect(codesOf(`${MACHINE}@织 回合末\n    # 幕 幕内\n`)).toContain('core/weave/scene-inside');
  });

  it('@织 接管 → only', () => {
    const file = parseOk(`${MACHINE}@织 读档 接管\n    > a\n`);
    const weave = file.decls.find((decl) => decl.kind === 'weave');
    if (weave?.kind !== 'weave') throw new Error('no weave');
    expect(weave.modifiers).toEqual(['only']);
  });
});

describe('parse：程序层（§9）', () => {
  it('@断 / @续 在循环外报错，在循环内合法', () => {
    expect(codesOf(`${MACHINE}@断\n`)).toContain('core/control/break-outside');
    expect(codesOf(`${MACHINE}@续\n`)).toContain('core/control/continue-outside');
    parseOk(`${MACHINE}@循 1\n    @断\n    @续\n`);
  });

  it('@复 当 已删除 → 迁移诊断', () => {
    expect(codesOf(`${MACHINE}@复 当 x > 0\n    > a\n`)).toContain('core/migration/loop');
  });

  it('@标 只能单元顶层：进条件分支 / 循环体报 core/goto/label-in-block', () => {
    parseOk(`${MACHINE}@标 主菜单\n> 请选择\n@跳 主菜单\n`);
    expect(codesOf(`${MACHINE}? 1\n    @标 块内\n`)).toContain('core/goto/label-in-block');
    expect(codesOf(`${MACHINE}@循 1\n    @标 循环内\n`)).toContain('core/goto/label-in-block');
  });

  it('@返 只能在 @函 内；@返 有值/无值都保形', () => {
    expect(codesOf(`${MACHINE}> 旁白\n@返\n`)).toContain('core/func/return-outside');
    const file = parseOk(`${MACHINE}@函 f()\n    @返 1\n`);
    const fn = file.decls.find((decl) => decl.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('no function');
    expect(fn.body[0]).toMatchObject({ kind: 'return', value: { text: '1' } });
    const voidFn = parseOk(`${MACHINE}@函 g()\n    @返\n`).decls.find((decl) => decl.kind === 'function');
    if (voidFn?.kind === 'function') expect((voidFn.body[0] as { value?: unknown }).value).toBeUndefined();
  });

  it('@巡 / @复 体内允许叙事与 @断/@续', () => {
    parseOk(`${MACHINE}@巡 队伍\n    ? {值} == "受伤"\n        > 第{下标 + 1}位需要治疗。\n        @续\n`);
    parseOk(`${MACHINE}@复 3\n    > 唔\n    @断\n`);
  });
});

describe('parse：叙事区硬规则（§4）', () => {
  it('裸旁白 / 裸台词 / `你：` 前缀都报错', () => {
    expect(codesOf(`${MACHINE}她点了点头。\n`)).toContain('core/narrative/bare-narration');
    expect(codesOf(`${MACHINE}「早。」\n`)).toContain('core/narrative/bare-quote');
    expect(codesOf(`${MACHINE}你：早。\n`)).toContain('core/narrative/bare-narration');
  });

  it('行首转义 → 字面旁白文本，不报裸旁白', () => {
    const file = parseOk(`${MACHINE}\\> 这不是旁白。\n`);
    const line = file.scenes[0]!.items[0] as KojoTextLine;
    expect(line.kind).toBe('textLine');
    expect(line.speech).toEqual({ kind: 'narration' });
    expect(line.parts[0]).toEqual({ kind: 'text', text: '> 这不是旁白。' });
  });

  it('等待三态进 AST：续 → continue、空行 等待 → wait', () => {
    const file = parseOk(`${MACHINE}灵梦：「好。」 续\n空行 等待\n`);
    const [textLine, blank] = file.scenes[0]!.items as [KojoTextLine, KojoBlankLine];
    expect(textLine.wait).toBe('continue');
    expect(blank.kind).toBe('blankLine');
    expect(blank.wait).toBe('wait');
  });

  it('行尾提示：一个提示进 AST；两个提示 / 单独提示 报 bad-hint', () => {
    const file = parseOk(`${MACHINE}灵梦：「嗯。」(心形)\n`);
    const line = file.scenes[0]!.items[0] as KojoTextLine;
    expect(line.hint).toBe('心形');
    expect(codesOf(`${MACHINE}灵梦：「嗯。」(心形)(微笑)\n`)).toContain('core/narrative/bad-hint');
    expect(codesOf(`${MACHINE}(心跳声)\n`)).toContain('core/narrative/bad-hint');
  });

  it('长台词里的 `//` 不误当注释', () => {
    const file = parseOk(`${MACHINE}> 网址是 https://example.test/a\n`);
    expect(file.scenes[0]!.items).toHaveLength(1);
  });
});

describe('parse：选项（待定 UI，§7.5）', () => {
  it('建 optionsBlock + warning；按钮标签不进文本行', () => {
    const file = parseSource(`${MACHINE}选项：\n    「用亲吻代替回答」：\n        灵梦：「……唔。」\n    「摸摸头」：\n        灵梦：「……好。」\n`);
    expect(file.diagnostics.filter((diagnostic) => diagnostic.code === 'core/options/pending')).toHaveLength(1);
    const options = file.scenes[0]!.items[0] as KojoOptionsBlock;
    expect(options.kind).toBe('optionsBlock');
    expect(options.items.map((item) => item.label)).toEqual(['用亲吻代替回答', '摸摸头']);
    expect(options.items[0]!.body[0]!.kind).toBe('textLine');
  });

  it('嵌套 / 放进块里 → core/decl/not-top-level', () => {
    expect(codesOf(`${MACHINE}@算\n    选项：\n`)).toContain('core/decl/not-top-level');
    expect(codesOf(`${MACHINE}选项：\n    选项：\n`)).toContain('core/decl/not-top-level');
  });
});

describe('parse：调用体（§7.2）与全角标点', () => {
  it('池 / 函数调用带缩进块 → core/template/unexpected-slot', () => {
    expect(codesOf(`${MACHINE}# 池 p\n    ? 1\n        > a\n    ? 否\n        > b\n! p\n    > 多余\n`)).toContain(
      'core/template/unexpected-slot',
    );
    expect(codesOf(`${MACHINE}@函 f()\n    @返\n! f()\n    > 多余\n`)).toContain('core/template/unexpected-slot');
  });

  it('全角标点在条件/表达式位置 → core/migration/fullwidth-punct（唯一入口）', () => {
    expect(codesOf(`${MACHINE}? 恋慕 ＝ 500\n    > a\n`)).toContain('core/migration/fullwidth-punct');
    expect(codesOf(`${MACHINE}@算\n    x ＝ 1\n`)).toContain('core/migration/fullwidth-punct');
    // 台词正文里的全角标点是正文，不报
    expect(codesOf(`${MACHINE}灵梦：「今天，天气不错。」\n`)).toEqual([]);
    // # 表 值列允许全角标点
    expect(codesOf(`${MACHINE}# 表 T 由 x\n    0 这里，有逗号\n    否 未知\n`)).toEqual([]);
  });
});

describe('parse：诊断质量', () => {
  it('一次报多条：错误行后的合法行继续建树', () => {
    const file = parseSource(`${MACHINE}「裸」\n这是裸旁白\n> 合法旁白\n`);
    expect(file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(2);
    expect(file.scenes[0]!.items).toHaveLength(1);
    expect(file.scenes[0]!.items[0]!.kind).toBe('textLine');
  });

  it('诊断 span 是 1 基、UTF-16、精确到行', () => {
    const file = parseSource(`${MACHINE}「裸」\n`);
    const diagnostic = file.diagnostics.find((item) => item.code === 'core/narrative/bare-quote');
    expect(diagnostic?.span?.start.line).toBe(2);
    expect(diagnostic?.span?.start.column).toBe(1);
  });

  it('错误行的缩进体整块跳过：不产生级联噪声', () => {
    const codes = codesOf(`${MACHINE}@算\n    如果 x\n        > a\n        > b\n        > c\n`);
    expect(codes.filter((code) => code === 'core/narrative/bare-narration')).toHaveLength(0);
    expect(codes).toContain('core/migration/if');
  });
});

describe('parse：入口契约', () => {
  it('parse(lex(source)) 与 parseSource(source) 等价', () => {
    const source = `${MACHINE}> 旁白\n`;
    expect(parseSource(source)).toEqual(parse(lex(source)));
  });

  it('lexer 诊断原样并入 KojoFile.diagnostics', () => {
    const file = parseSource(`${MACHINE}@算\n   x = 1\n`);
    expect(file.diagnostics.map((diagnostic) => diagnostic.code)).toContain('core/lex/indent');
  });
});

describe('parse：空文件', () => {
  it('空源码 = 空文件，无诊断', () => {
    expect(parseSource('')).toEqual({ decls: [], scenes: [], diagnostics: [] });
  });
});

describe('parse：单遍性能（50k 行）', () => {
  it('5 万行叙事（每 500 行夹一个 @算）：单遍建树、零 error', () => {
    const parts: string[] = ['# 机 指令 310\n'];
    for (let i = 0; i < 50000; i++) {
      if (i % 500 === 0) parts.push('@算\n    人数 = 人数 + 1\n');
      else parts.push('灵梦：「{恋慕 >= 亲近线 ? "A" : "B"}」 续\n');
    }
    const file = parseSource(parts.join(''));
    expect(file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(file.scenes).toHaveLength(1);
    expect(file.scenes[0]!.items).toHaveLength(50000);
  });
});

describe('parse：整数超安全范围不静默舍入（2026-10-26 批）', () => {
  const BIG = '12345678901234567890';
  const MAX = '9007199254740991';

  it('`# 常量 x 整数 = 超界` → core/expr/bad-literal，且不建出变形常量', () => {
    const file = parseSource(`${MACHINE}# 常量 x 整数 = ${BIG}\n> 正文\n`);
    const codes = file.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('core/expr/bad-literal');
    expect(codes).not.toContain('core/decl/const-not-constant'); // 它确实是字面量，不能借用"不是字面量"的码
    const diagnostic = file.diagnostics.find((item) => item.code === 'core/expr/bad-literal')!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.message).toContain('安全整数');
    // 诊断落在数字上（不是整行空白）
    expect(diagnostic.span?.start.line).toBe(2);
    // 超界值不进 AST（不会以 12345678901234567000 的形状落进声明表）
    expect(file.decls.find((decl) => decl.kind === 'const')).toBeUndefined();
  });

  it('边界值 MAX_SAFE_INTEGER 照常通过', () => {
    const file = parseSource(`${MACHINE}# 常量 x 整数 = ${MAX}\n> 正文\n`);
    expect(file.diagnostics).toEqual([]);
    const decl = file.decls.find((item) => item.kind === 'const');
    expect(decl?.kind === 'const' ? decl.value : null).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('变量初值超界同样报 bad-literal（不是"初值只允许字面量"）', () => {
    const file = parseSource(`${MACHINE}# 变量 x 整数 = ${BIG}\n> 正文\n`);
    const diagnostic = file.diagnostics.find((item) => item.code === 'core/expr/bad-literal');
    expect(diagnostic?.message).toContain('安全整数');
    expect(file.diagnostics.map((item) => item.message).join('\n')).not.toContain('初值只允许字面量');
  });

  it('表值列超界 → bad-literal（不静默退化成字符串列）', () => {
    const file = parseSource(
      `${MACHINE}# 表 心情 由 好感\n    0..9 ${BIG}\n    否 未知\n> 正文\n`,
    );
    expect(file.diagnostics.map((item) => item.code)).toContain('core/expr/bad-literal');
    const table = file.decls.find((decl) => decl.kind === 'table');
    const value = table?.kind === 'table' ? table.rows[0]!.value : null;
    expect(typeof value).toBe('string'); // 退化前的防线：诊断已报，值不冒充整数
  });

  it('`# 变量 x 整数[超界]` → bad-array-size（既有码，文案点明超界）', () => {
    const diagnostic = parseSource(`${MACHINE}# 变量 x 整数[9007199254740993]\n> 正文\n`).diagnostics.find(
      (item) => item.code === 'core/decl/bad-array-size',
    );
    expect(diagnostic?.message).toContain('安全整数');
  });
});
