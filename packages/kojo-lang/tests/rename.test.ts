/**
 * Kojo 2.0 符号重命名（`@kojo/kojo-lang/rename`，K2-LSP-RENAME）的**判据闸**（B3e 起住包）。
 *
 * 本文件原是 `packages/app/tests/kojo2-rename.test.ts` 的纯逻辑段（①–⑤、⑦）——B3e 把判据
 * 整块搬进包之后跟着搬来，**断言一条没减**；只测 Monaco provider 的那组留在宿主
 * `packages/app/tests/kojo2-rename.test.ts`（请求构造 / WorkspaceEdit 落点 / rejectReason）。
 *
 * 覆盖面（任务口径）：
 * 1. **各符号重命名**：`# 变量 / 常量 / 表 / 池 / 模` 与 `@函` 的声明 + 全部可证引用位同步；
 * 2. **引用面**：插值（台词 / 旁白 / 表达式）、`!` 调用、`@巡` 集合、表 `依据` 主语与端点
 *    （常量）、数组长度、赋值目标与右值、条件链 test；
 * 3. **不误改**：注释 / 字符串字面量 / `@原生` 原生行 / 表值列 / `@函` 形参 / `@巡` 绑定名；
 * 4. **闸**：非法名 / 重名 / 同名 / 引用扫描不可证 ⇒ 零编辑 + blockers；
 * 5. **收口**：应用编辑后用 core `parseSource` 复查零 error（文件本来有错 ⇒ 零编辑）；
 * 6. **prepare 语义**：星号不在符号上、注释 / 原生 / 台词 / 声明头 / 表值列各自给理由；
 * 7. **CRLF / 中文**：CRLF 源逐字保留换行，区域列坐标正确。
 */

import { describe, expect, it } from 'vitest';
import { parseSource } from '@kojo/kojo-core';
import {
  kojo2PrepareRename,
  kojo2RenameAt,
  kojo2RenamedSource,
  validateKojo2RenameName,
  validateName,
  type Kojo2RenameEdit,
  type Kojo2RenameResult,
} from '../src/rename';

/* ============================== 夹具（行号写在旁边，测试直接引用） ============================== */

/**
 * 一份**可解析干净的 2.0 文件**（parse 零 error 是改名落地的前提）。
 * 每一行都至少服务一条断言：声明、各类引用位、以及五类"不许动"的位置。
 */
const LINES: readonly string[] = [
  '// 注释里的名字不参与改名：心情 / 好感度 / 心情快照', // 1
  '# 幕 神社清晨', // 2
  '# 视 灵梦', // 3
  '# 机 指令 310', // 4
  '# 常量 亲近线 整数 = 500', // 5
  '# 变量 好感度 整数 = 0 存档', // 6
  '# 变量 心情快照 字符串', // 7
  '# 变量 值 整数 = 0', // 8
  '# 变量 数值 整数 = 0', // 9
  '# 变量 队伍状态 字符串[亲近线]', // 10
  '# 变量 疏远 字符串', // 11
  '', // 12
  '# 对照表 心情 依据 好感度', // 13
  '    0..99 -> 疏远', // 14
  '    亲近线.. -> 亲近', // 15
  '    否 -> 未知', // 16
  '', // 17
  '# 池 早安问候', // 18
  '    ? 好感度 < 100', // 19
  '        「……早。」', // 20
  '    ? 否', // 21
  '        「早上好。」', // 22
  '', // 23
  '# 模 娇羞退场(原因)', // 24
  '    > （她红着脸，因为{原因}而不知所措）', // 25
  '    > （她的好感度是{好感度}）', // 26
  '    [插槽]', // 27
  '', // 28
  '@函 增加羁绊(目标, 数值=10)', // 29
  '    ? 数值 > 0', // 30
  '        @返 数值', // 31
  '    @返 0', // 32
  '', // 33
  '> 外面是{值}。', // 34
  '> 她今天看起来{心情}。', // 35
  '灵梦：「{好感度} 点好感，{心情快照}。」', // 36
  '@算', // 37
  '    心情快照 = "亲近"', // 38
  '    好感度 = 好感度 + 1', // 39
  '    ! 增加羁绊(目标, 12)', // 40
  '@巡 队伍状态', // 41
  '    > 这一格是{值}。', // 42
  '! 早安问候', // 43
  '! 娇羞退场("心情快照")', // 44
  '! 增加羁绊(目标, 12)', // 45
  '@原生', // 46
  '    CALL HPH_PRINT 心情', // 47
  '    CALL HPH_PRINT "好感度"', // 48
];

const FIXTURE = `${LINES.join('\n')}\n`;
const FIXTURE_LINES = FIXTURE.split(/\r\n|\r|\n/);

/** 指定行上的 `needle` → 1 基行列（夹具行号写死在测试里，避免"第几枚"的歧义）。 */
function positionOnLine(
  lineNumber: number,
  needle: string,
): { readonly line: number; readonly column: number } {
  const text = FIXTURE_LINES[lineNumber - 1] ?? '';
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`夹具第 ${lineNumber} 行里找不到「${needle}」`);
  return { line: lineNumber, column: index + 1 };
}

/** 全文找一枚**整词**位置（CRLF 用例与"同一行两处"用；注释里也会命中，调用方自己挑）。 */
function wholeWordPositions(source: string, needle: string): Array<{ line: number; column: number }> {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(needle)}(?![\\p{L}\\p{N}_])`, 'gu');
  const out: Array<{ line: number; column: number }> = [];
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    const before = source.slice(0, match.index);
    const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    out.push({
      line: before.split(/\r\n|\r|\n/).length,
      column: match.index - lastBreak,
    });
  }
  return out;
}

/** 编辑集里每一段覆盖的源码文本（逐段验证"改的是名字、列没漂"）。 */
function editSlices(source: string, edits: readonly Kojo2RenameEdit[]): string[] {
  const lines = source.split(/\r\n|\r|\n/);
  return edits.map((edit) => {
    const text = lines[edit.range.startLine - 1] ?? '';
    return text.slice(edit.range.startColumn - 1, edit.range.endColumn - 1);
  });
}

/** 编辑集覆盖的行号（升序，重复保留——同行两处就是两条）。 */
function editLines(edits: readonly Kojo2RenameEdit[]): number[] {
  return edits.map((edit) => edit.range.startLine);
}

/** 一次改名的"应该成功"断言：无 blockers、名字对、每段切下来就是原名、应用后 parse 零 error。 */
function expectRename(
  name: string,
  newName: string,
  position: { readonly line: number; readonly column: number },
  expectedLines: readonly number[],
): { readonly result: Kojo2RenameResult; readonly renamed: string } {
  const result = kojo2RenameAt(FIXTURE, position, newName);
  expect(result.blockers).toEqual([]);
  expect(result.symbol?.name).toBe(name);
  expect(result.edits.length).toBe(expectedLines.length);
  expect(editLines(result.edits)).toEqual([...expectedLines]);
  expect(editSlices(FIXTURE, result.edits)).toEqual(expectedLines.map(() => name));
  for (const edit of result.edits) expect(edit.newText).toBe(newName);
  const renamed = kojo2RenamedSource(FIXTURE, result.edits);
  expect(renamed).not.toBe(FIXTURE);
  expect(
    parseSource(renamed).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
  ).toEqual([]);
  return { result, renamed };
}

/* ============================== 夹具本身 ============================== */

describe('夹具：2.0 源解析零 error（改名落地的收口前提）', () => {
  it('parseSource 没有任何 error（warning 可以有）', () => {
    const errors = parseSource(FIXTURE).diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    expect(errors.map((diagnostic) => `${diagnostic.code}@${diagnostic.span?.start.line}`)).toEqual(
      [],
    );
  });
});

/* ============================== ① 各符号重命名 ============================== */

describe('各符号重命名：声明 + 全部可证引用位同步', () => {
  it('# 变量 好感度：表主语 / 池条件 / 模板插值 / 台词插值 / 赋值目标与右值全同步（7 段）', () => {
    const { result, renamed } = expectRename('好感度', '羁绊值', positionOnLine(6, '好感度'), [
      6, 13, 19, 26, 36, 39, 39,
    ]);
    expect(result.symbol?.kind).toBe('variable');
    // 赋值行同一行两段：目标在左、右值在右，列序严格递增
    const sameLine = result.edits.filter((edit) => edit.range.startLine === 39);
    expect(sameLine).toHaveLength(2);
    expect(sameLine[0]!.range.startColumn).toBeLessThan(sameLine[1]!.range.startColumn);
    // 注释 / @原生 里的同名文字原样留着
    expect(renamed.split(/\r\n|\r|\n/)[0]).toContain('好感度');
    expect(renamed.split(/\r\n|\r|\n/)[47]).toContain('好感度');
    expect(renamed).toContain('# 变量 羁绊值 整数 = 0 存档');
  });

  it('# 常量 亲近线：数组长度 + 表行端点同步（3 段）', () => {
    const { result, renamed } = expectRename('亲近线', '亲密阈值', positionOnLine(5, '亲近线'), [
      5, 10, 15,
    ]);
    expect(result.symbol?.kind).toBe('constant');
    expect(renamed).toContain('# 变量 队伍状态 字符串[亲密阈值]');
    expect(renamed).toContain('亲密阈值.. -> 亲近');
  });

  it('# 对照表 心情：声明 + 台词插值（2 段）', () => {
    const { result, renamed } = expectRename('心情', '情绪', positionOnLine(13, '心情'), [13, 35]);
    expect(result.symbol?.kind).toBe('table');
    expect(renamed).toContain('# 对照表 情绪 依据 好感度');
    expect(renamed).toContain('她今天看起来{情绪}。');
  });

  it('# 池 早安问候：声明 + `!` 调用（2 段）', () => {
    const { result, renamed } = expectRename('早安问候', '晨间问候', positionOnLine(18, '早安问候'), [
      18, 43,
    ]);
    expect(result.symbol?.kind).toBe('pool');
    expect(renamed).toContain('# 池 晨间问候');
    expect(renamed).toContain('! 晨间问候');
  });

  it('# 模 娇羞退场：声明 + 带实参的 `!` 调用（2 段）', () => {
    const { result, renamed } = expectRename('娇羞退场', '害羞离场', positionOnLine(24, '娇羞退场'), [
      24, 44,
    ]);
    expect(result.symbol?.kind).toBe('template');
    expect(renamed).toContain('# 模 害羞离场(原因)');
    expect(renamed).toContain('! 害羞离场("心情快照")');
  });

  it('@函 增加羁绊：声明 + `@算` 体内调用 + 叙事区调用（3 段）', () => {
    const { result, renamed } = expectRename('增加羁绊', '提升好感', positionOnLine(29, '增加羁绊'), [
      29, 40, 45,
    ]);
    expect(result.symbol?.kind).toBe('function');
    expect(result.symbol?.kindLabel).toBe('函');
    expect(renamed).toContain('@函 提升好感(目标, 数值=10)');
    expect(renamed).toContain('! 提升好感(目标, 12)');
  });

  it('# 变量 队伍状态：`@巡` 集合位同步（2 段）', () => {
    const { renamed } = expectRename('队伍状态', '队列', positionOnLine(10, '队伍状态'), [
      10, 41,
    ]);
    expect(renamed).toContain('@巡 队列');
  });

  it('# 变量 心情快照：插值 + 赋值目标同步；字符串里的同名文字不动（3 段）', () => {
    const { result, renamed } = expectRename('心情快照', '心情存档', positionOnLine(7, '心情快照'), [
      7, 36, 38,
    ]);
    expect(result.edits.some((edit) => edit.range.startLine === 44)).toBe(false);
    expect(renamed).toContain('! 娇羞退场("心情快照")');
  });

  it('# 变量 值：循环外的插值同步，`@巡` 体内的 `{值}` 是绑定名不动（2 段）', () => {
    const { result, renamed } = expectRename('值', '备用值', positionOnLine(8, '值'), [8, 34]);
    expect(result.edits.some((edit) => edit.range.startLine === 42)).toBe(false);
    expect(renamed).toContain('> 这一格是{值}。');
  });

  it('# 变量 数值：`@函` 形参遮蔽同名文件变量 ⇒ 只改声明（1 段）', () => {
    const { result, renamed } = expectRename('数值', '步长', positionOnLine(9, '数值'), [9]);
    expect(result.edits.some((edit) => edit.range.startLine === 30)).toBe(false);
    expect(result.edits.some((edit) => edit.range.startLine === 31)).toBe(false);
    expect(renamed).toContain('@函 增加羁绊(目标, 数值=10)');
    expect(renamed).toContain('? 数值 > 0');
  });

  it('# 变量 疏远：表值列的同名词不是引用（只改声明，1 段）', () => {
    const { result, renamed } = expectRename('疏远', '疏远的人', positionOnLine(11, '疏远'), [11]);
    expect(result.edits.some((edit) => edit.range.startLine === 14)).toBe(false);
    expect(renamed).toContain('    0..99 -> 疏远');
  });
});

/* ============================== ② 区间精确 ============================== */

describe('区间精确：编辑只覆盖名字字段（1 基、尾列半开）', () => {
  it('声明 / 插值 / 赋值目标 / `!` 调用的列都逐位对得上', () => {
    const result = kojo2RenameAt(FIXTURE, positionOnLine(7, '心情快照'), '心情存档');
    expect(result.blockers).toEqual([]);
    const declarationLine = FIXTURE_LINES[6]!; // 第 7 行
    const declaration = result.edits.find((edit) => edit.range.startLine === 7)!;
    expect(declaration.range.startColumn).toBe(declarationLine.indexOf('心情快照') + 1);
    expect(declaration.range.endColumn).toBe(
      declarationLine.indexOf('心情快照') + 1 + '心情快照'.length,
    );
    expect(editSlices(FIXTURE, result.edits)).toEqual(['心情快照', '心情快照', '心情快照']);
  });

  it('声明名的区间与 `kojo2DocumentOf` 的名字字段一致（不抄第二份列口径）', () => {
    const prepared = kojo2PrepareRename(FIXTURE, positionOnLine(5, '亲近线'));
    expect(prepared.blockers).toEqual([]);
    expect(prepared.range).toEqual({
      startLine: 5,
      startColumn: 6,
      endLine: 5,
      endColumn: 9,
    });
    expect(prepared.symbol?.range).toEqual({
      startLine: 5,
      startColumn: 6,
      endLine: 5,
      endColumn: 9,
    });
    expect(prepared.symbol?.line).toBe(5);
  });

  it('同一行两处引用：两段编辑、列严格递增、应用后两处都换掉', () => {
    const result = kojo2RenameAt(FIXTURE, positionOnLine(6, '好感度'), '羁绊值');
    const line = result.edits.filter((edit) => edit.range.startLine === 39);
    expect(line).toHaveLength(2);
    expect(line[0]!.range.endColumn).toBeLessThanOrEqual(line[1]!.range.startColumn);
    const renamed = kojo2RenamedSource(FIXTURE, result.edits);
    expect(renamed.split(/\r\n|\r|\n/)[38]).toBe('    羁绊值 = 羁绊值 + 1');
  });
});

/* ============================== ③ 不误改 ============================== */

describe('不误改：字符串 / 注释 / @原生 / 表值列 / 形参 / 循环绑定', () => {
  it('字符串字面量里的同名文字不进引用集', () => {
    const result = kojo2RenameAt(FIXTURE, positionOnLine(7, '心情快照'), '心情存档');
    const rendered = editSlices(FIXTURE, result.edits);
    expect(rendered.every((slice) => slice === '心情快照')).toBe(true);
    expect(kojo2RenamedSource(FIXTURE, result.edits)).toContain('"心情快照"');
  });

  it('注释行里的三个名字一个都不改', () => {
    for (const [name, line] of [
      ['心情', 13],
      ['好感度', 6],
      ['心情快照', 7],
    ] as const) {
      const result = kojo2RenameAt(FIXTURE, positionOnLine(line, name), `${name}新名`);
      expect(result.edits.some((edit) => edit.range.startLine === 1)).toBe(false);
    }
  });

  it('`@原生` 体内（47 / 48 行）原样透传：裸名字与字符串都不改', () => {
    const targets: ReadonlyArray<readonly [string, number]> = [
      ['心情', 13],
      ['好感度', 6],
    ];
    for (const [name, line] of targets) {
      const result = kojo2RenameAt(FIXTURE, positionOnLine(line, name), `${name}新名`);
      expect(result.edits.some((edit) => edit.range.startLine === 47)).toBe(false);
      expect(result.edits.some((edit) => edit.range.startLine === 48)).toBe(false);
    }
  });

  it('表值列（`0..99 疏远` 的 `疏远`）不是引用', () => {
    const result = kojo2RenameAt(FIXTURE, positionOnLine(11, '疏远'), '疏远的人');
    expect(editLines(result.edits)).toEqual([11]);
  });
});

/* ============================== ④ 新名闸 / 收口 ============================== */

describe('新名闸：非法名 / 重名 / 同名一律零编辑 + 理由', () => {
  const position = positionOnLine(6, '好感度');

  it.each([
    ['1坏名', '合法'],
    ['有 空格', '合法'],
    ['坏-名', '合法'],
    ['', '不能为空'],
  ])('非法新名 %j ⇒ 零编辑、理由提到「%s」', (newName, keyword) => {
    const result = kojo2RenameAt(FIXTURE, position, newName);
    expect(result.edits).toEqual([]);
    expect(result.symbol?.name).toBe('好感度');
    expect(result.blockers.join('\n')).toContain(keyword);
  });

  it('与既有声明重名 ⇒ 零编辑（不让新旧名分叉）', () => {
    const result = kojo2RenameAt(FIXTURE, position, '心情快照');
    expect(result.edits).toEqual([]);
    expect(result.blockers[0]).toContain('已在本文件声明过');
  });

  it('新名与原名相同 ⇒ 零编辑（没有可改的东西）', () => {
    const result = kojo2RenameAt(FIXTURE, position, '好感度');
    expect(result.edits).toEqual([]);
    expect(result.blockers[0]).toContain('新名与原名相同');
  });

  it('validateKojo2RenameName：合法 / 非法 / 重名三档，别名 `validateName` 是同一枚', () => {
    expect(validateKojo2RenameName(FIXTURE, '新的名字')).toEqual({ ok: true });
    expect(validateKojo2RenameName(FIXTURE, '1abc').ok).toBe(false);
    const duplicate = validateKojo2RenameName(FIXTURE, '心情');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.ok ? '' : duplicate.reason).toContain('声明过');
    expect(validateName).toBe(validateKojo2RenameName);
  });

  it('文件本来就有解析错误 ⇒ 应用后仍是 error ⇒ 零编辑（parse 零 error 才落地）', () => {
    const broken = `${FIXTURE}@断\n`; // 顶层 `@断` = core/control/break-outside
    expect(
      parseSource(broken).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    ).not.toEqual([]);
    const result = kojo2RenameAt(broken, positionOnLine(6, '好感度'), '羁绊值');
    expect(result.edits).toEqual([]);
    expect(result.blockers.join('\n')).toContain('解析错误');
  });
});

/* ============================== ⑤ prepare 语义 ============================== */

describe('prepare：不在符号上就拒绝并给理由；在符号上给名字段区间', () => {
  it('在声明名上 ⇒ 符号 + 名字段区间；在插值 / `!` 调用上同样是符号', () => {
    const declaration = kojo2PrepareRename(FIXTURE, positionOnLine(6, '好感度'));
    expect(declaration.blockers).toEqual([]);
    expect(declaration.symbol?.name).toBe('好感度');
    expect(declaration.range).toEqual({
      startLine: 6,
      startColumn: 6,
      endLine: 6,
      endColumn: 9,
    });

    const interpolation = kojo2PrepareRename(FIXTURE, positionOnLine(36, '好感度'));
    expect(interpolation.blockers).toEqual([]);
    expect(interpolation.symbol?.kind).toBe('variable');
    expect(interpolation.range).toEqual({
      startLine: 36,
      startColumn: 6,
      endLine: 36,
      endColumn: 9,
    });

    const call = kojo2PrepareRename(FIXTURE, positionOnLine(43, '早安问候'));
    expect(call.blockers).toEqual([]);
    expect(call.symbol?.kind).toBe('pool');
    expect(call.range).toEqual({
      startLine: 43,
      startColumn: 3,
      endLine: 43,
      endColumn: 7,
    });
  });

  it('注释 / `@原生` / 台词旁白 / 普通文字：各自给作者能读懂的理由', () => {
    const cases: ReadonlyArray<readonly [string, { line: number; column: number }, string]> = [
      ['注释', { line: 1, column: 5 }, '注释'],
      ['原生', { line: 47, column: 20 }, '@原生'],
      ['旁白普通文字', { line: 35, column: 3 }, '台词 / 旁白'],
      ['裸行文字', { line: 34, column: 3 }, '台词 / 旁白'],
    ];
    for (const [label, position, keyword] of cases) {
      const prepared = kojo2PrepareRename(FIXTURE, position);
      expect(prepared.symbol, label).toBeNull();
      expect(prepared.range, label).toBeNull();
      expect(prepared.blockers.join('\n'), label).toContain(keyword);
    }
  });

  it('声明头（`# 变量` 词上）指路到名字；`# 幕` 标题明确说不可改名', () => {
    const header = kojo2PrepareRename(FIXTURE, { line: 6, column: 3 });
    expect(header.blockers[0]).toContain('声明头');
    expect(header.blockers[0]).toContain('好感度');

    const scene = kojo2PrepareRename(FIXTURE, { line: 2, column: 5 });
    expect(scene.blockers[0]).toContain('# 幕');
  });

  it('表值列 / 字符串里的同名词不是符号（不猜）', () => {
    const tableValue = kojo2PrepareRename(FIXTURE, positionOnLine(14, '疏远'));
    expect(tableValue.blockers[0]).toContain('不是可证引用位');

    const inString = kojo2PrepareRename(FIXTURE, { line: 44, column: 9 });
    expect(inString.symbol).toBeNull();
    expect(inString.blockers[0]).toContain('不是可证引用位');
  });

  it('空行 / 行外坐标都给理由、不抛', () => {
    expect(kojo2PrepareRename(FIXTURE, { line: 12, column: 1 }).blockers[0]).toContain('空行');
    expect(kojo2PrepareRename(FIXTURE, { line: 999, column: 1 }).blockers[0]).toContain('不在本文件');
    expect(kojo2PrepareRename(FIXTURE, { line: 0, column: 0 }).blockers[0]).toContain('不是有效坐标');
  });

  it('光标落在名字右边界（同一枚 token 的尾列）仍认这枚 token', () => {
    const prepared = kojo2PrepareRename(FIXTURE, { line: 6, column: 9 });
    expect(prepared.blockers).toEqual([]);
    expect(prepared.symbol?.name).toBe('好感度');
  });

  it('同名声明 ⇒ prepare 就拒绝（不弹输入框让作者白打一遍）', () => {
    const duplicated = `${FIXTURE}# 变量 好感度 字符串\n`;
    const prepared = kojo2PrepareRename(duplicated, positionOnLine(6, '好感度'));
    expect(prepared.symbol?.name).toBe('好感度');
    expect(prepared.blockers[0]).toContain('同名声明');
  });
});

/* ============================== ⑥ CRLF / 中文 ============================== */

describe('CRLF / 中文：列坐标按行内码元、换行逐字保留', () => {
  const CRLF = `${LINES.join('\r\n')}\r\n`;

  it('CRLF 源上的中文名改名：行号 / 列号与 LF 源一致，应用后不出现裸 LF', () => {
    const positions = wholeWordPositions(CRLF, '好感度');
    // 第 1 枚在注释行，第 2 枚在 `# 变量` 声明行（第 6 行）
    expect(positions[0]?.line).toBe(1);
    const declaration = positions[1]!;
    expect(declaration.line).toBe(6);
    expect(declaration.column).toBe(6);

    const result = kojo2RenameAt(CRLF, declaration, '羁绊值');
    expect(result.blockers).toEqual([]);
    expect(editLines(result.edits)).toEqual([6, 13, 19, 26, 36, 39, 39]);
    const renamed = kojo2RenamedSource(CRLF, result.edits);
    expect(renamed.split('\r\n')).toHaveLength(LINES.length + 1);
    expect(/[^\r]\n/.test(renamed)).toBe(false);
    expect(renamed).toContain('# 变量 羁绊值 整数 = 0 存档');
    expect(
      parseSource(renamed).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    ).toEqual([]);
  });

  it('中文新名逐段落地（列区间均落在原名上，无错位）', () => {
    const result = kojo2RenameAt(FIXTURE, positionOnLine(7, '心情快照'), '心境快照');
    expect(result.blockers).toEqual([]);
    expect(editSlices(FIXTURE, result.edits)).toEqual(['心情快照', '心情快照', '心情快照']);
    const renamed = kojo2RenamedSource(FIXTURE, result.edits);
    expect(renamed.split(/\r\n|\r|\n/)[37]).toBe('    心境快照 = "亲近"');
    expect(renamed).toContain('灵梦：「{好感度} 点好感，{心境快照}。」');
  });

  it('确定性：同输入两次调用逐字相同（纯函数）', () => {
    const position = positionOnLine(29, '增加羁绊');
    const first = kojo2RenameAt(FIXTURE, position, '提升好感');
    const second = kojo2RenameAt(FIXTURE, position, '提升好感');
    expect(second).toEqual(first);
  });
});
