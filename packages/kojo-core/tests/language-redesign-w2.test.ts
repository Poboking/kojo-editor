/**
 * W2 语言重构表面测试：`【定】` / `【设】` 二义消解、类型词 `数`/`文字`、
 * 循环控制正典 `下一轮` / `跳出循环`。语义与旧写法对拍用 fake backend 的确定性编码。
 */
import { describe, expect, it } from 'vitest';
import type { KojoFile } from '../src/ast.js';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter.js';
import { lowerFile } from '../src/lower/index.js';
import { parseSource } from '../src/parser.js';
import { checkKojoFile } from '../src/sema/index.js';
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

describe('W2：定/设 二义消解', () => {
  it('【定】是编译期常量、【设】是运行期变量（同字面量初值也不许静默变常量）', () => {
    const fixed = parseOk('【挂 指令 310】\n【定 亲近线 数 = 500】\n');
    expect(fixed.decls.find((decl) => 'name' in decl && decl.name === '亲近线')?.kind).toBe('const');

    const variable = parseOk('【挂 指令 310】\n【设 计数 数 = 0】\n');
    const decl = variable.decls.find((item) => 'name' in item && item.name === '计数');
    expect(decl?.kind).toBe('var');
    if (decl?.kind === 'var') expect(decl.storage).toBe('scene');

    // `【设】` 可赋值；`【定】` 不可赋值（语义层报 const 赋值）。
    expect(linesOf('【挂 指令 310】\n【设 计数 数 = 0】\n算：\n    计数 += 1\n')).toContain(
      'ASSIGN|计数|+=|1',
    );
  });

  it('【定】必须有初值、不能写存储期、不能是数组', () => {    const noInit = parseSource('【挂 指令 310】\n【定 x 数】\n');
    expect(noInit.diagnostics.map((d) => d.code)).toContain('core/decl/bad-initializer');

    const withStorage = parseSource('【挂 指令 310】\n【定 x 数 = 5 存档】\n');
    expect(withStorage.diagnostics.map((d) => d.code)).toContain('core/decl/bad-initializer');

    const array = parseSource('【挂 指令 310】\n【定 xs 数[3] = 1】\n');
    expect(array.diagnostics.map((d) => d.code)).toContain('core/decl/bad-initializer');
  });

  it('给常量赋值必须报 assign-to-constant（新/旧两种常量形态一致，不静默）', () => {
    const semaCodes = (src: string): string[] =>
      checkKojoFile(parseSource(src), { adapter: FIXTURE_ADAPTER, filePath: 'w2.kojo2' }).diagnostics.map(
        (diagnostic) => String(diagnostic.code),
      );
    expect(
      semaCodes('【挂 指令 310】\n【定 亲近线 数 = 500】\n算：\n    亲近线 = 2\n'),
    ).toContain('core/expr/assign-to-constant');
    expect(
      semaCodes('# 机 指令 310\n# 设 亲近线 整数 = 500\n@算\n    亲近线 = 2\n'),
    ).toContain('core/expr/assign-to-constant');
  });

  it('【定】与旧 # 设 常量形态同 lowering', () => {
    const newSrc =
      '【挂 指令 310】\n【定 亲近线 数 = 500】\n【设 恋慕 数 = 100】\n若 恋慕 >= 亲近线：\n    > 亲近。\n否则：\n    > 远。\n';
    const oldSrc =
      '# 机 指令 310\n# 设 亲近线 整数 = 500\n# 设 恋慕 整数 = 100 场景\n? 恋慕 >= 亲近线\n    > 亲近。\n? 否\n    > 远。\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });
});

describe('W2：类型词 数/文字', () => {
  it('标量 / 数组类型别名与旧词同 lowering', () => {
    const newSrc = '【挂 指令 310】\n【设 名 文字 = "灵梦"】\n【设 队伍 文字[3]】\n算：\n    队伍[0] = "健康"\n';
    const oldSrc = '# 机 指令 310\n# 设 名 字符串 = "灵梦" 场景\n# 设 队伍 字符串[3] 场景\n算：\n    队伍[0] = "健康"\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('未知类型仍报错，报错文案同时提到新词与旧词', () => {
    const file = parseSource('【挂 指令 310】\n【设 x 布尔】\n');
    const diagnostic = file.diagnostics.find((d) => d.code === 'core/decl/unknown-type');
    expect(diagnostic?.message).toContain('数');
    expect(diagnostic?.message).toContain('文字');
  });
});

describe('W3：函数返回正典', () => {
  it('返回 / 返回：表达式 = @返 / @返 表达式', () => {
    const newSrc = '【挂 指令 310】\n【函 加(a)】\n    返回：a + 1\n【函 空()】\n    返回\n';
    const oldSrc = '# 机 指令 310\n@函 加(a)\n    @返 a + 1\n@函 空()\n    @返\n';
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });
});

describe('W2：循环控制正典', () => {  it('下一轮 / 跳出循环 = @续 / @断', () => {
    const newSrc = `【挂 指令 310】
【设 i 数 = 0】
循环：i < 3
    i += 1
    下一轮
    跳出循环
`;
    const oldSrc = `# 机 指令 310
# 设 i 整数 = 0 场景
@循 i < 3
    i += 1
    @续
    @断
`;
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('循环外使用 下一轮 / 跳出循环 仍报对应错误', () => {
    expect(parseSource('【挂 指令 310】\n下一轮\n').diagnostics.map((d) => d.code)).toContain(
      'core/control/continue-outside',
    );
    expect(parseSource('【挂 指令 310】\n跳出循环\n').diagnostics.map((d) => d.code)).toContain(
      'core/control/break-outside',
    );
  });
});
