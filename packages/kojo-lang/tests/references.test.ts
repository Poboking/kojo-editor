/**
 * K2-LSP-REFS · `kojo2` 查找全部引用（Shift+F12）的**判据闸**（B3e 起住包）。
 *
 * 本文件原是 `packages/app/tests/kojo2-references.test.ts` 的纯逻辑段（①–⑥）——B3e 把判据
 * 整块搬进 `@kojo/kojo-lang/references` 之后跟着搬来，**断言一条没减**；只测 Monaco 的那组
 * 留在宿主 `packages/app/tests/kojo2-references.test.ts`（那里钉请求构造 / 快照 / Location 翻译）。
 *
 * 覆盖面：
 * 1. **符号面**：七类声明（`# 幕 / 变量 / 常量 / 表 / 池 / 模`、`@函`）+ 事件名
 *    （`# 机` 声明 / `@织` 监听）；声明位 → 同一符号 + 精确 `declSpan`；
 * 2. **可证引用位**：`{…}` 插值（台词 / 旁白 / 模体）、`! 名` / `! 名(实参)` 调用、
 *    `@巡` 集合、`# 对照表 依据 <表达式>`、`? 条件`、`@算` 赋值两侧 / 裸调用、`@返` 返回值、
 *    `@着色` 颜色表达式、`# 设` 类型里的 `[<数组长度>]`；
 * 3. **不误报**：正文纯文本、注释行、`@原生` 体、双引号字符串、`对象.成员` 的成员名、
 *    表体字面量、`# 视角` 名字、`? 否`、空白位 → 一律 `null` 或不进 `refs`；
 * 4. **结果形状**：源码序、去重、`decl` / `ref` / `call` 三档角色、`declSpan` 覆盖整段
 *    `# 幕` 标题（标题里可以有空格）；
 * 5. **上限**：`KOJO2_REFERENCE_LIMIT` 截断 + `truncated` 显式标记；恰好到上限不标截断；
 * 6. **边界**：CRLF 与 LF 同结果、`getIndex` 注入（正常 / 抛错 / 回 null）、确定性、
 *    空源 / 非法位 / 越界位 → `null`；
 * 7. **B3e 快照口**：`projectFiles` 缺席 = 同文件；给出 = 跨文件合并 / 排序 / 去重 / 上限、
 *    只在别的文件声明的名字（本文件是一处可证引用位）。
 */
import { describe, expect, it, vi } from 'vitest';
import { kojo2DocumentOf, type Kojo2Declaration } from '../src/declarations';
import {
  KOJO2_PROJECT_REF_LIMIT,
  KOJO2_REFERENCE_LIMIT,
  kojo2ProjectReferencesAt,
  kojo2ReferencesAt,
  kojo2ReferencesInProjectFiles,
  kojo2ReferenceSymbolsOf,
  type Kojo2ReferencePosition,
  type Kojo2ReferenceSpan,
  type Kojo2ReferenceSymbolKind,
} from '../src/references';

/**
 * 引用查找夹具。刻意把"同一个名字的可证位 / 不可证位"写在相邻行：
 * - `心情` 在表声明、插值、条件里各命中一次，在台词正文与注释里不命中；
 * - `指令` 在 `# 机` / `@织` 各命中一次，在台词正文与注释里不命中；
 * - `今天已触发` 在插值、赋值两侧、成员名（`我.今天已触发`）上区分 `ref` 与不命中；
 * - `亲近线` 在 `# 对照表 依据` 与 `@返` 里各命中一次。
 */
const SOURCE = [
  '// 引用查找夹具：声明位 / 引用位 / 不误报位',
  '# 幕 神社 清晨',
  '# 视角 旅人',
  '# 机 指令 310',
  '',
  '# 设 亲近线 整数 = 500',
  '# 设 今天已触发 整数 = 0 存档',
  '# 设 队伍 整数[4]',
  '',
  '# 对照表 心情 依据 亲近线',
  '    0..99 -> 疏远',
  '    100..499 -> 平常',
  '    否 -> 未知',
  '',
  '# 池 早安问候',
  '    ? 好感 < 100',
  '        「……早。」',
  '    ? 否',
  '        「早上好。」',
  '',
  '# 模 娇羞退场(原因)',
  '    > （她红着脸，因为{原因}而不知所措）',
  '    [插槽]',
  '    > （随后匆匆跑开了）',
  '',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 目标 + 亲近线',
  '',
  '@织 指令 之后',
  '    > （事件之后的旁白）',
  '',
  '> 晨光透过鸟居，{今天已触发} 次。',
  '旅人：「{心情}今天来得挺早嘛。」',
  '旅人：「心情不错，指令也清楚。」',
  '@算',
  '    今天已触发 = 1',
  '    ? 心情 == "今天已触发"',
  '        > 她看了你一眼。',
  '    ! 早安问候',
  '    @巡 队伍',
  '        > 一个接一个。',
  '    ! 增加羁绊(目标, 12)',
  '    增加羁绊(目标, 1)',
  '    今天已触发 = 我.今天已触发',
  '',
  '! 早安问候',
  '! 娇羞退场("心情")',
  '',
  '@原生',
  '    CALL 心情',
  '// 注释里提到 心情 / 今天已触发 / 指令',
].join('\n');

const DOCUMENT = kojo2DocumentOf(SOURCE);
const ROWS = SOURCE.split('\n');

/* ============================== 位置小工具 ============================== */

/** 0 基源偏移 → 1 基行列（夹具只含 LF，切行即物理行）。 */
function positionAtOffset(source: string, offset: number): Kojo2ReferencePosition {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

/** `needle` 第 `from` 位之后的首个出现 → 1 基行列；`offsetInNeedle` 指定词内第几位。 */
function positionAt(needle: string, from = 0, offsetInNeedle = 0): Kojo2ReferencePosition {
  return positionIn(SOURCE, needle, from, offsetInNeedle);
}

function positionIn(
  source: string,
  needle: string,
  from = 0,
  offsetInNeedle = 0,
): Kojo2ReferencePosition {
  const at = source.indexOf(needle, from);
  if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
  return positionAtOffset(source, at + offsetInNeedle);
}

/** 夹具里某条声明（同名只有一条；缺了当场红）。 */
function declarationOf(name: string): Kojo2Declaration {
  const found = DOCUMENT.declarations.find((declaration) => declaration.name === name);
  if (found === undefined) throw new Error(`夹具缺少声明 ${name}`);
  return found;
}

/** 声明名字段首列 → 查询位。 */
function atDeclaration(name: string): Kojo2ReferencePosition {
  const declaration = declarationOf(name);
  return { line: declaration.line, column: declaration.nameStart };
}

/** 一次查询；`null` 由调用方断言。 */
function refsAt(position: Kojo2ReferencePosition) {
  return kojo2ReferencesAt(SOURCE, position);
}

/** 一定有结果的查询（失败即测试失败）。 */
function found(position: Kojo2ReferencePosition) {
  const result = refsAt(position);
  if (result === null) throw new Error(`位置 ${position.line}:${position.column} 没有符号`);
  return result;
}

/** span 覆盖的原文（用于断言"落点是哪个词"）。 */
function textOf(span: Kojo2ReferenceSpan): string {
  const line = ROWS[span.startLine - 1] ?? '';
  return line.slice(span.startColumn - 1, span.endColumn - 1);
}

/** 结果里的出现点角色序列。 */
function rolesOf(position: Kojo2ReferencePosition): string[] {
  return found(position).refs.map((site) => site.kind);
}

/** 结果里的出现点行号序列。 */
function linesOf(position: Kojo2ReferencePosition): number[] {
  return found(position).refs.map((site) => site.span.startLine);
}

/* ============================== ① 符号面：七类声明 + 事件 + 幕 ============================== */

const DECLARATION_CASES: readonly { readonly name: string; readonly kind: Kojo2ReferenceSymbolKind }[] = [
  { name: '神社 清晨', kind: 'scene' },
  { name: '亲近线', kind: 'constant' },
  { name: '今天已触发', kind: 'variable' },
  { name: '队伍', kind: 'variable' },
  { name: '心情', kind: 'table' },
  { name: '早安问候', kind: 'pool' },
  { name: '娇羞退场', kind: 'template' },
  { name: '增加羁绊', kind: 'function' },
];

describe('符号面：声明位 → 同一符号 + 精确名字段', () => {
  it.each(DECLARATION_CASES)(
    '$name（$kind）声明处查得到自己，declSpan = 名字段',
    ({ name, kind }) => {
      const declaration = declarationOf(name);
      const result = found(atDeclaration(name));
      expect(result.symbol.name).toBe(name);
      expect(result.symbol.kind).toBe(kind);
      expect(result.symbol.declSpan).toEqual({
        startLine: declaration.line,
        startColumn: declaration.nameStart,
        endLine: declaration.line,
        endColumn: declaration.nameEnd,
      });
      expect(result.refs[0]?.kind).toBe('decl');
    },
  );

  it('`# 幕` 标题含空格时，光标落在标题第二个词上也认得（区间覆盖整段标题）', () => {
    const result = found(positionAt('清晨'));
    expect(result.symbol.name).toBe('神社 清晨');
    expect(result.symbol.kind).toBe('scene');
    expect(textOf(result.symbol.declSpan)).toBe('神社 清晨');
  });

  it('`# 机` 事件名 → 事件符号，`@织` 是它的 ref', () => {
    // `# 机` 不在声明索引里：事件符号由事件挂点单独成组。
    const atMachine = positionAt('# 机 指令 310', 0, 4);
    const result = found(atMachine);
    expect(result.symbol.name).toBe('指令');
    expect(result.symbol.kind).toBe('event');
    expect(result.symbol.declSpan.startLine).toBe(4);
    expect(textOf(result.symbol.declSpan)).toBe('指令');
    expect(rolesOf(atMachine)).toEqual(['decl', 'ref']);
    expect(linesOf(atMachine)).toEqual([4, 29]);
  });

  it('`@织` 事件名与 `# 机` 解析到同一条事件符号（declSpan 仍指 `# 机`）', () => {
    const atWeave = positionAt('@织 指令', 0, 3);
    const atMachine = positionAt('# 机 指令 310', 0, 4);
    const result = found(atWeave);
    expect(result.symbol).toEqual(found(atMachine).symbol);
    expect(textOf(result.symbol.declSpan)).toBe('指令');
  });

  it('没有 `# 机` 时以最早一条 `@织` 作锚点，两条监听都进 refs', () => {
    const source = [
      '# 幕 某个清晨',
      '@织 指令 之后',
      '    > 一。',
      '@织 指令 之前',
      '    > 二。',
    ].join('\n');
    const position = positionIn(source, '@织 指令', 0, 3);
    const result = kojo2ReferencesAt(source, position);
    expect(result).not.toBeNull();
    expect(result?.symbol.kind).toBe('event');
    expect(result?.symbol.declSpan.startLine).toBe(2);
    expect(result?.refs).toHaveLength(2);
    expect(result?.refs.map((site) => site.kind)).toEqual(['ref', 'ref']);
  });

  it('同名事件与变量是两枚符号（`# 机 指令` 与 `# 设 指令` 不互相串）', () => {
    const source = [
      '# 机 指令 310',
      '# 设 指令 整数 = 0 场景',
      '@算',
      '    指令 = 1',
    ].join('\n');
    const atEvent = positionIn(source, '# 机 指令', 0, 4);
    const atVariable = positionIn(source, '指令', source.indexOf('# 设'));
    const event = kojo2ReferencesAt(source, atEvent);
    const variable = kojo2ReferencesAt(source, atVariable);
    expect(event?.symbol.kind).toBe('event');
    expect(event?.refs.map((site) => site.span.startLine)).toEqual([1]);
    expect(variable?.symbol.kind).toBe('variable');
    expect(variable?.refs.map((site) => site.span.startLine)).toEqual([2, 4]);
    expect(kojo2ReferencesAt(source, positionIn(source, '指令 = 1'))).toEqual(variable);
  });

  it('幕标题与变量同名是合法文件：幕与变量不互相串（幕标题不进表达式名单）', () => {
    const source = [
      '# 幕 日常',
      '# 设 日常 整数 = 0 场景',
      '@算',
      '    日常 = 1',
    ].join('\n');
    const scene = kojo2ReferencesAt(source, positionIn(source, '# 幕 日常', 0, 4));
    const variable = kojo2ReferencesAt(source, positionIn(source, '日常', source.indexOf('# 设')));
    expect(scene?.symbol.kind).toBe('scene');
    expect(scene?.refs).toHaveLength(1);
    expect(variable?.symbol.kind).toBe('variable');
    expect(variable?.refs.map((site) => site.span.startLine)).toEqual([2, 4]);
  });

  it('两幕同标题：各自只查到自己那一条（幕按具体符号归属）', () => {
    const source = ['# 幕 日常', '> 一。', '# 幕 日常', '> 二。'].join('\n');
    const first = kojo2ReferencesAt(source, positionIn(source, '# 幕 日常', 0, 4));
    const secondAt = source.lastIndexOf('# 幕 日常') + 4;
    const second = kojo2ReferencesAt(source, positionAtOffset(source, secondAt));
    expect(first?.refs.map((site) => site.span.startLine)).toEqual([1]);
    expect(second?.refs.map((site) => site.span.startLine)).toEqual([3]);
  });
});

/* ============================== ② 可证引用位 ============================== */

describe('可证引用位：插值 / 调用 / 表达式', () => {
  it('台词插值 `{心情}` → 表声明（区间是插值里的名字，不是花括号）', () => {
    const result = found(positionAt('{心情}', 0, 1));
    expect(result.symbol.name).toBe('心情');
    expect(result.refs.map((site) => site.kind)).toEqual(['decl', 'ref', 'ref']);
    expect(textOf(result.refs[1]!.span)).toBe('心情');
    expect(linesOf(positionAt('心情'))).toEqual([10, 33, 37]);
  });

  it('旁白插值 `{今天已触发}` → 变量声明', () => {
    const result = found(positionAt('{今天已触发}', 0, 1));
    expect(result.symbol.name).toBe('今天已触发');
    expect(result.symbol.kind).toBe('variable');
    expect(result.refs.some((site) => site.span.startLine === 32)).toBe(true);
  });

  it('`! 名` 调用 → `call` 角色', () => {
    const result = found(positionAt('! 早安问候', 0, 2));
    expect(rolesOf(positionAt('! 早安问候', 0, 2))).toEqual(['decl', 'call', 'call']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([15, 39, 46]);
  });

  it('`! 名(实参)` 调用 → `call` 角色（实参里的字符串不进 refs）', () => {
    const result = found(positionAt('! 娇羞退场', 0, 2));
    expect(result.symbol.name).toBe('娇羞退场');
    expect(rolesOf(positionAt('! 娇羞退场', 0, 2))).toEqual(['decl', 'call']);
    expect(result.refs.some((site) => site.span.startLine === 47)).toBe(true);
  });

  it('`@巡 名` 的集合表达式 → `ref`', () => {
    const result = found(positionAt('@巡 队伍', 0, 3));
    expect(result.symbol.name).toBe('队伍');
    expect(rolesOf(positionAt('@巡 队伍', 0, 3))).toEqual(['decl', 'ref']);
    expect(result.refs[1]?.span.startLine).toBe(40);
  });

  it('`# 对照表 依据 <表达式>` 的表达式 → `ref`', () => {
    const result = found(positionAt('# 对照表 心情 依据 亲近线', 0, 13));
    expect(result.symbol.name).toBe('亲近线');
    expect(result.symbol.kind).toBe('constant');
    expect(rolesOf(positionAt('# 对照表 心情 依据 亲近线', 0, 13))).toEqual(['decl', 'ref', 'ref']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([6, 10, 27]);
  });

  it('`? <条件>` 的条件表达式 → `ref`', () => {
    const result = found(positionAt('? 心情 ==', 0, 2));
    expect(result.symbol.name).toBe('心情');
    expect(result.refs.some((site) => site.span.startLine === 37)).toBe(true);
  });

  it('`@算` 体里的赋值左侧 → `ref`', () => {
    const result = found(positionAt('今天已触发 = 1'));
    expect(result.symbol.name).toBe('今天已触发');
    expect(result.refs.some((site) => site.span.startLine === 36)).toBe(true);
  });

  it('`@算` 体里的裸调用 → `call` 角色', () => {
    const result = found(positionAt('增加羁绊(目标, 1)', 0, 0));
    expect(result.symbol.name).toBe('增加羁绊');
    expect(rolesOf(positionAt('增加羁绊(目标, 1)', 0, 0))).toEqual(['decl', 'call', 'call']);
    expect(result.refs.map((site) => site.span.startLine)).toEqual([26, 42, 43]);
  });

  it('`@返 <表达式>` 的返回值表达式 → `ref`', () => {
    const result = found(positionAt('@返 目标 + 亲近线', 0, 8));
    expect(result.symbol.name).toBe('亲近线');
    expect(result.refs.some((site) => site.span.startLine === 27)).toBe(true);
  });

  it('`@着色 <颜色表达式>` → `ref`（颜色不是字面量时也认）', () => {
    const source = [
      '# 设 主色 整数 = 0',
      '@着色 主色',
      '    > （红光照在脸上）',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '主色'));
    expect(result?.symbol.name).toBe('主色');
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref']);
    expect(result?.refs[1]?.span.startLine).toBe(2);
  });

  it('`# 设` 类型里的 `[<数组长度>]` 可引用整数常量', () => {
    const source = [
      '# 设 上限 整数 = 4',
      '# 设 队伍 整数[上限]',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '上限'));
    expect(result?.symbol.name).toBe('上限');
    expect(result?.symbol.kind).toBe('constant');
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref']);
    expect(result?.refs[1]?.span.startLine).toBe(2);
  });

  it('`@函` 体内嵌套 `@算`：语句仍按表达式位收集（缩进栈逐层归位）', () => {
    const source = [
      '# 设 计数 整数 = 0',
      '@函 加一()',
      '    @算',
      '        计数 = 计数 + 1',
      '    @返 计数',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '计数'));
    expect(result?.symbol.name).toBe('计数');
    expect(result?.refs.map((site) => site.span.startLine)).toEqual([1, 4, 4, 5]);
  });

  it('`# 模` 体插值里的参数名不是文件符号（不归给任何声明）', () => {
    // `{原因}` 是模的参数，不是文件级符号：没有可归属的声明 ⇒ null。
    expect(refsAt(positionAt('{原因}', 0, 1))).toBeNull();
  });

  it('`@织` 修饰词 / `# 机` 事件参数不是引用位', () => {
    // `之后`（修饰词）与 `310`（事件参数）都没有对应符号。
    expect(refsAt(positionAt('@织 指令 之后', 0, 7))).toBeNull();
    expect(refsAt(positionAt('# 机 指令 310', 0, 7))).toBeNull();
  });
});

/* ============================== ③ 不误报 ============================== */

describe('不误报：正文 / 字符串 / 成员 / 字面量 / 非本批符号', () => {
  it('台词正文里的名字（与声明同名）不产生引用', () => {
    expect(refsAt(positionAt('心情不错'))).toBeNull();
    expect(refsAt(positionAt('指令也清楚', 0, 0))).toBeNull();
  });

  it('注释里的名字不产生引用', () => {
    const from = SOURCE.indexOf('// 注释里提到');
    const position = positionAtOffset(SOURCE, SOURCE.indexOf('心情', from));
    expect(refsAt(position)).toBeNull();
  });

  it('`@原生` 体里的名字不产生引用', () => {
    const from = SOURCE.indexOf('@原生');
    const position = positionAtOffset(SOURCE, SOURCE.indexOf('心情', from));
    expect(refsAt(position)).toBeNull();
  });

  it('双引号字符串里的名字不计数（条件行只认字符串外的 `心情`）', () => {
    const result = found(positionAt('? 心情 ==', 0, 2));
    expect(result.refs).toHaveLength(3); // decl10 + interp33 + 条件37
    const quoted = SOURCE.indexOf('"今天已触发"');
    const position = positionAtOffset(SOURCE, quoted + 1);
    expect(refsAt(position)).toBeNull();
  });

  it('调用实参里的双引号字符串不计数', () => {
    const result = found(positionAt('! 娇羞退场', 0, 2));
    expect(result.refs).toHaveLength(2); // 声明 + 调用，没有实参里的 `心情`
    expect(result.refs.every((site) => textOf(site.span) !== '心情')).toBe(true);
  });

  it('`对象.成员` 的成员名不是文件内符号', () => {
    const result = found(positionAt('今天已触发 = 我.今天已触发'));
    // 该行只有左侧一枚 ref；右侧成员名被跳过。
    expect(result.refs.filter((site) => site.span.startLine === 44)).toHaveLength(1);
    const member = SOURCE.indexOf('我.今天已触发') + '我.'.length;
    expect(refsAt(positionAtOffset(SOURCE, member))).toBeNull();
  });

  it('表体行：值列不是引用位；范围端点里的常量是（与 rename 的改写集合一致）', () => {
    // 改前读数：端点也不收集（`refsAt('100..499')` / 端点常量 → null），
    // 而 `rename.ts` 按 core AST 会改写 `from` / `to` 里的常量 ⇒ 两把尺子不一致。
    expect(refsAt(positionAt('疏远'))).toBeNull();
    expect(refsAt(positionAt('100..499'))).toBeNull();
    const source = [
      '# 设 上限 整数 = 499',
      '# 对照表 心情 依据 上限',
      '    0..上限 疏远',
      '    否 未知',
    ].join('\n');
    const result = kojo2ReferencesAt(source, positionIn(source, '上限'));
    expect(result?.symbol.name).toBe('上限');
    expect(result?.symbol.kind).toBe('constant');
    // 声明位 + `依据` 表达式 + 表体端点
    expect(result?.refs.map((site) => site.span.startLine)).toEqual([1, 2, 3]);
    expect(result?.refs.map((site) => site.kind)).toEqual(['decl', 'ref', 'ref']);
  });

  it('`# 视角` 的名字不属本批符号面', () => {
    expect(refsAt(positionAt('旅人'))).toBeNull();
  });

  it('`? 否` 默认分支不是引用位', () => {
    expect(refsAt(positionAt('? 否', 0, 2))).toBeNull();
  });

  it('空白 / 声明名之后的空格 / 越界行 → null', () => {
    expect(refsAt(positionAt('今天已触发', 0, 0))).not.toBeNull();
    // 名字段之后（`整数` 开头）不再是这个名字位。
    const afterName = SOURCE.indexOf('整数', SOURCE.indexOf('# 设 今天已触发'));
    expect(refsAt(positionAtOffset(SOURCE, afterName))).toBeNull();
    expect(refsAt({ line: 999, column: 1 })).toBeNull();
  });
});

/* ============================== ④ 结果形状 ============================== */

describe('结果形状：源码序 / 去重 / 角色', () => {
  it('refs 按源码序（行、列升序）且同一位置只出现一次', () => {
    const result = found(atDeclaration('今天已触发'));
    const keys = result.refs.map((site) => `${site.span.startLine}:${site.span.startColumn}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...result.refs].sort(
      (a, b) => a.span.startLine - b.span.startLine || a.span.startColumn - b.span.startColumn,
    );
    expect(keys).toEqual(sorted.map((site) => `${site.span.startLine}:${site.span.startColumn}`));
  });

  it('声明位在第一位且角色是 `decl`（声明通常写在引用之前）', () => {
    for (const { name } of DECLARATION_CASES) {
      const result = found(atDeclaration(name));
      expect(result.refs[0]?.kind).toBe('decl');
      expect(textOf(result.refs[0]!.span)).toBe(declarationOf(name).name);
    }
  });

  it('角色三档：decl（声明）/ ref（普通引用）/ call（`!` 调用与裸调用）', () => {
    expect(rolesOf(atDeclaration('早安问候'))).toEqual(['decl', 'call', 'call']);
    expect(rolesOf(atDeclaration('心情'))).toEqual(['decl', 'ref', 'ref']);
    expect(rolesOf(atDeclaration('增加羁绊'))).toEqual(['decl', 'call', 'call']);
  });

  it('`declSpan` 对 `@函` / `# 模` 取 `(` 之前的名字（不带参数表）', () => {
    const fn = found(atDeclaration('增加羁绊'));
    expect(textOf(fn.symbol.declSpan)).toBe('增加羁绊');
    const template = found(atDeclaration('娇羞退场'));
    expect(textOf(template.symbol.declSpan)).toBe('娇羞退场');
  });
});

/* ============================== ⑤ 上限 / 截断 ============================== */

describe('上限：500 条 + truncated 显式标记', () => {
  function poolWithCalls(count: number): string {
    const rows = ['# 池 甲', '    ? 否', '        「好。」'];
    for (let i = 0; i < count; i++) rows.push('! 甲');
    return rows.join('\n');
  }

  it('超过上限 → refs 恰好 500 条且 truncated = true（声明位保留）', () => {
    const source = poolWithCalls(KOJO2_REFERENCE_LIMIT + 5);
    const result = kojo2ReferencesAt(source, positionIn(source, '# 池 甲', 0, 4));
    expect(result).not.toBeNull();
    expect(result?.refs).toHaveLength(KOJO2_REFERENCE_LIMIT);
    expect(result?.truncated).toBe(true);
    expect(result?.refs[0]?.kind).toBe('decl');
  });

  it('恰好到上限 → truncated = false（不静默标截断）', () => {
    const source = poolWithCalls(KOJO2_REFERENCE_LIMIT - 1);
    const result = kojo2ReferencesAt(source, positionIn(source, '# 池 甲', 0, 4));
    expect(result?.refs).toHaveLength(KOJO2_REFERENCE_LIMIT);
    expect(result?.truncated).toBe(false);
  });

  it('未到上限 → truncated = false', () => {
    const result = found(atDeclaration('心情'));
    expect(result.truncated).toBe(false);
  });
});

/* ============================== ⑥ 边界 / 注入 / 确定性 ============================== */

describe('边界：CRLF / getIndex / 确定性 / 坏输入', () => {
  it('CRLF 与 LF 给出逐字相同的结果', () => {
    const crlf = SOURCE.replace(/\n/g, '\r\n');
    const lfResult = found(atDeclaration('今天已触发'));
    const crlfResult = kojo2ReferencesAt(crlf, positionIn(crlf, '今天已触发'));
    expect(crlfResult).toEqual(lfResult);
  });

  it('`getIndex` 注入：用注入的索引且结果与现建一致', () => {
    const injected = kojo2DocumentOf(SOURCE);
    const getIndex = vi.fn(() => injected);
    const position = atDeclaration('心情');
    const result = kojo2ReferencesAt(SOURCE, position, { getIndex });
    expect(getIndex).toHaveBeenCalledTimes(1);
    expect(result).toEqual(found(position));
  });

  it('`getIndex` 抛错 → 退回现建（结果不变，不抛）', () => {
    const position = atDeclaration('心情');
    const getIndex = () => {
      throw new Error('桩：索引端抛错');
    };
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex })).toEqual(found(position));
  });

  it('`getIndex` 回 null / 坏值 → 退回现建', () => {
    const position = atDeclaration('心情');
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex: () => null })).toEqual(found(position));
    const bad = () => ({}) as never;
    expect(kojo2ReferencesAt(SOURCE, position, { getIndex: bad })).toEqual(found(position));
  });

  it('确定性：同一输入两次调用逐字相等', () => {
    const position = atDeclaration('心情');
    expect(kojo2ReferencesAt(SOURCE, position)).toEqual(kojo2ReferencesAt(SOURCE, position));
  });

  it('空源 / 非法位（0 行 / 0 列 / NaN）→ null', () => {
    expect(kojo2ReferencesAt('', { line: 1, column: 1 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: 0, column: 1 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: 1, column: 0 })).toBeNull();
    expect(kojo2ReferencesAt(SOURCE, { line: Number.NaN, column: 1 })).toBeNull();
  });

  it('没有声明也没有事件的空文件 → null', () => {
    expect(kojo2ReferencesAt('> 只有旁白。', { line: 1, column: 1 })).toBeNull();
  });
});

/* ============================== ⑦ B3e 项目文件快照口 ============================== */

const DECL_FILE = ['# 对照表 心情 依据 亲近线', '# 设 亲近线 整数 = 500'].join('\n');

describe('项目文件快照：缺席 = 同文件；给出 = 跨文件合并', () => {
  it('projectFiles 缺席 ⇒ 与同文件查询逐字相同（旧行为零改动）', () => {
    const position = { line: 1, column: 7 };
    const sameFile = kojo2ReferencesAt(DECL_FILE, position);
    for (const result of [
      kojo2ReferencesInProjectFiles(DECL_FILE, position, undefined),
      kojo2ReferencesInProjectFiles(DECL_FILE, position, []),
    ]) {
      expect(result?.symbol).toEqual(sameFile?.symbol);
      expect(result?.local).toEqual(sameFile?.refs);
      expect(result?.external).toEqual([]);
      expect(result?.truncated).toBe(false);
      // 合并视图在当地就是 local 那份（path = null）
      expect(result?.refs.every((site) => site.path === null)).toBe(true);
    }
  });

  it('跨文件：声明在 A、引用在 B（本文件无声明）⇒ B 的引用落点带 filePath', () => {
    const bFile = ['# 幕 访客', '> 今天心情{心情}不错。', '! 问候'].join('\n');
    const position = { line: 2, column: 8 };
    const result = kojo2ReferencesInProjectFiles(
      bFile,
      position,
      [
        { path: 'D:/p/b.kojo2', text: bFile },
        { path: 'D:/p/a.kojo2', text: DECL_FILE },
      ],
      { path: 'D:/p/b.kojo2' },
    );
    expect(result).not.toBeNull();
    expect(result?.symbol.name).toBe('心情');
    expect(result?.symbol.kind).toBe('table');
    expect(result?.local.map((site) => site.span.startLine)).toEqual([2]);
    expect(result?.external.map((site) => site.path)).toEqual(['D:/p/a.kojo2']);
    // 合并视图：声明位在前（跨文件那份），本文件引用在后
    expect(result?.refs.map((site) => `${site.path ?? 'local'}:${site.kind}`)).toEqual([
      'D:/p/a.kojo2:decl',
      'local:ref',
    ]);
  });

  it('本文件有同名声明 ⇒ 同文件判据 + 跨文件 refs 合流；排除请求文件自己', () => {
    const cFile = ['# 对照表 心情 依据 1', '> {心情}'].join('\n');
    const result = kojo2ReferencesInProjectFiles(
      DECL_FILE,
      { line: 1, column: 7 },
      [
        { path: 'D:/p/c.kojo2', text: cFile },
        { path: 'D:/p/a.kojo2', text: DECL_FILE },
      ],
      { path: 'D:/p/a.kojo2' },
    );
    expect(result).not.toBeNull();
    // 候选文件给两处：声明位 + 插值引用位（c 自己有同名表声明）
    expect(result?.external.map((site) => site.path)).toEqual([
      'D:/p/c.kojo2',
      'D:/p/c.kojo2',
    ]);
    // 请求文件自己只出现一次（local），快照里那份同路径被归一键排除
    expect(result?.refs.filter((site) => site.path === 'D:/p/a.kojo2')).toHaveLength(0);
  });

  it('跨文件结果按路径 → 源码序排、同位置去重', () => {
    const x = ['# 对照表 心情 依据 1', '> {心情}', '> {心情}', '> {心情}'].join('\n');
    const y = ['# 幕 甲', '> {心情}'].join('\n');
    const result = kojo2ReferencesInProjectFiles(
      DECL_FILE,
      { line: 1, column: 7 },
      [
        { path: 'D:/p/z.kojo2', text: y },
        { path: 'D:/p/a.kojo2', text: x },
      ],
      { path: 'D:/q/self.kojo2' },
    );
    expect(result?.external.map((site) => site.path)).toEqual([
      'D:/p/a.kojo2',
      'D:/p/a.kojo2',
      'D:/p/a.kojo2',
      'D:/p/a.kojo2',
      'D:/p/z.kojo2',
    ]);
    const keys = result!.external.map(
      (site) => `${site.path}:${site.span.startLine}:${site.span.startColumn}:${site.kind}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('同名多家族（项目里同名变量 + 表）⇒ 不猜，跨文件侧不给（null）', () => {
    const other = ['# 设 心情 整数 = 0'].join('\n');
    const bFile = '> {心情}';
    const result = kojo2ReferencesInProjectFiles(
      bFile,
      { line: 1, column: 4 },
      [
        { path: 'D:/p/a.kojo2', text: DECL_FILE },
        { path: 'D:/p/v.kojo2', text: other },
      ],
      { path: 'D:/p/b.kojo2' },
    );
    expect(result).toBeNull();
  });

  it('跨文件侧触到 2000 条上限 ⇒ truncated = true（不静默少给）', () => {
    const refs = ['# 对照表 心情 依据 1'];
    for (let i = 0; i < KOJO2_PROJECT_REF_LIMIT + 5; i++) refs.push('> {心情}');
    const result = kojo2ReferencesInProjectFiles(
      '# 幕 本地\n> {心情}',
      { line: 2, column: 4 },
      [{ path: 'D:/p/big.kojo2', text: refs.join('\n') }],
      { path: 'D:/p/self.kojo2' },
    );
    expect(result).not.toBeNull();
    expect(result?.external).toHaveLength(KOJO2_PROJECT_REF_LIMIT);
    expect(result?.truncated).toBe(true);
  });

  it('`kojo2ReferenceSymbolsOf` 摊开整篇符号（快照索引的事实来源）', () => {
    const facts = kojo2ReferenceSymbolsOf(DECL_FILE);
    expect(facts.map((fact) => `${fact.symbol.name}/${fact.symbol.kind}`)).toEqual([
      '心情/table',
      '亲近线/constant',
    ]);
    expect(facts[0]?.refs.map((site) => site.kind)).toEqual(['decl']);
  });

  it('`kojo2ProjectReferencesAt` 仍接受宿主索引形状（结构接口不破旧接线）', () => {
    const index = {
      refsOf: () => ({ refs: [], truncated: false }),
      declsOf: () => [],
      symbolAt: () => null,
    };
    const result = kojo2ProjectReferencesAt(DECL_FILE, { line: 1, column: 7 }, index, {
      path: 'D:/p/a.kojo2',
    });
    expect(result?.symbol.name).toBe('心情');
    expect(result?.external).toEqual([]);
  });
});
