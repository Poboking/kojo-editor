/**
 * K2-INDEX-REFS · kojo2 **项目级符号索引 + 跨文件引用**的行为闸。
 *
 * 覆盖面（索引纯逻辑 + 跨文件合并 + Monaco provider 三层一起钉）：
 * 1. **索引增删改**：`updateFile` / `removeFile` / `getFile` / `files` / `snapshot`；
 *    路径归一键（大小写 / 分隔符）、`generation` 只在真正变过时 +1；
 * 2. **缓存**：文本未变不重解析（注入 `documentOf` 数调用次数）、只改路径写法也只换显示路径；
 * 3. **跨文件 refs**：`refsOf({ name, kind })` 的路径 → 源码序、去重、`excludePath`、
 *    声明位 / 引用位 / 调用位、只在别的文件声明的名字（候选位）、上限 + `truncated`；
 * 4. **声明家族隔离**：表 / 变量同名、幕标题与变量同名、事件与变量同名——互不串；
 * 5. **坏文件不污染**：解析抛错保留旧条目、其它文件的查询结果逐条不变、垃圾文本不造符号；
 * 6. **CRLF / 确定性**：CRLF 与 LF 同结果、喂入顺序不影响输出；
 * 7. **性能护栏**：5k 行单文件更新 < 8ms（三次取样中位数）；
 * 8. **B3e**：索引实例仍满足跨文件合并的结构面（provider 的请求 / Location 翻译在
 *    `kojo2-references.test.ts`，判据本体在包）。
 *
 * 期望值全部从夹具原文位置与 `kojo2DocumentOf` 推，不在测试里复写行号。
 */
import { describe, expect, it, vi } from 'vitest';
import { kojo2DocumentOf } from '@kojo/kojo-lang';
import {
  KOJO2_PROJECT_REF_LIMIT,
  createKojo2ProjectIndex,
  type Kojo2ProjectIndex,
} from '../src/monaco/kojo2-project-index';
import {
  kojo2ProjectReferencesAt,
  type Kojo2ReferencePosition,
  type Kojo2ReferenceSpan,
} from '../src/monaco/kojo2-references';

const PATH_A = 'D:/proj/a.kojo2';
const PATH_B = 'D:/proj/b.kojo2';

/* ============================== 夹具 ============================== */

/** A 文件：声明面齐全 + 本文件引用；B 文件只引用（跨文件的关键形态）。 */
const MAIN = [
  '# 幕 神社 清晨',
  '# 设 亲近线 整数 = 500',
  '# 设 今天已触发 整数 = 0 存档',
  '# 对照表 心情 依据 亲近线',
  '    0..99 -> 疏远',
  '    100..499 -> 平常',
  '    否 -> 未知',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 目标 + 亲近线',
  '# 机 指令 310',
  '@织 指令 之后',
  '    > （事件之后的旁白）',
  '> 晨光透过鸟居，{今天已触发} 次。',
  '旅人：「{心情}今天来得挺早嘛。」',
  '@算',
  '    今天已触发 = 1',
  '    ! 增加羁绊(目标, 12)',
].join('\n');

/** B 文件：没有声明这些名字，只有可证引用位（候选位）。 */
const LIB = [
  '# 幕 书院 午后',
  '> 书院里，{心情} 摆在案上。',
  '旅人：「{亲近线} 很高。」',
  '! 增加羁绊(目标, 2)',
  '@织 指令 之后',
  '    > （另一份文件也在听）',
].join('\n');

/** 同名不同家族：`心情` 在这里是变量（不是 A 的那张表）。 */
const VARIABLE_HEART = [
  '# 幕 街角',
  '# 设 心情 整数 = 0 场景',
  '@算',
  '    心情 = 3',
  '    ! 增加羁绊(目标, 1)',
].join('\n');

/** 幕标题与变量同名（合法文件），另有一枚同名事件。 */
const SAME_NAME_FAMILIES = [
  '# 幕 日常',
  '# 设 日常 整数 = 0 场景',
  '# 机 日常 310',
  '@算',
  '    日常 = 1',
  '@织 日常 之后',
  '    > 一。',
].join('\n');

const ROWS_OF_MAIN = MAIN.split('\n');
const ROWS_OF_LIB = LIB.split('\n');

/* ============================== 位置小工具 ============================== */

/** `needle` 第 `from` 位之后的首个出现 → 1 基行列（夹具只含 LF）。 */
function positionIn(source: string, needle: string, from = 0, offsetInNeedle = 0): Kojo2ReferencePosition {
  const at = source.indexOf(needle, from);
  if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
  const before = source.slice(0, at + offsetInNeedle);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: before.length - lastBreak };
}

/** 声明名字段首列 → 查询位（行号从同一份文档索引取，测试不复写）。 */
function declarationPosition(source: string, name: string): Kojo2ReferencePosition {
  const declaration = kojo2DocumentOf(source).declarations.find((entry) => entry.name === name);
  if (declaration === undefined) throw new Error(`夹具缺少声明 ${name}`);
  return { line: declaration.line, column: declaration.nameStart };
}

/** 1 基半开区间 → 原文（断言行号 / 落点词用）。 */
function textAt(source: string, span: Kojo2ReferenceSpan): string {
  const line = source.split('\n')[span.startLine - 1] ?? '';
  return line.slice(span.startColumn - 1, span.endColumn - 1);
}

/* ============================== 索引小工具 ============================== */

function indexWith(
  files: readonly { readonly path: string; readonly text: string }[],
  options: Parameters<typeof createKojo2ProjectIndex>[0] = {},
): Kojo2ProjectIndex {
  const index = createKojo2ProjectIndex(options);
  for (const file of files) index.updateFile(file);
  return index;
}

function baseIndex(): Kojo2ProjectIndex {
  return indexWith([
    { path: PATH_A, text: MAIN },
    { path: PATH_B, text: LIB },
  ]);
}

/** 结果里的 `路径:行:列` 序列（断言跨文件顺序用）。 */
function refKeys(refs: readonly { readonly path: string; readonly span: Kojo2ReferenceSpan }[]): string[] {
  return refs.map((ref) => `${ref.path}:${ref.span.startLine}:${ref.span.startColumn}`);
}

/* ============================== ① 索引增删改 ============================== */

describe('索引增删改：updateFile / removeFile / getFile / files / snapshot', () => {
  it('updateFile 建表：getFile 拿回同一份文本与文档索引', () => {
    const index = createKojo2ProjectIndex();
    const entry = index.updateFile({ path: PATH_A, text: MAIN });
    expect(entry).toBeDefined();
    expect(entry?.path).toBe(PATH_A);
    expect(entry?.text).toBe(MAIN);
    expect(entry?.document.declarations.length).toBeGreaterThan(0);
    expect(index.getFile(PATH_A)).toBe(entry);
  });

  it('路径归一键：大小写 / 分隔符不同的写法命中同一份文件', () => {
    const index = createKojo2ProjectIndex();
    index.updateFile({ path: PATH_A, text: MAIN });
    expect(index.getFile('d:/PROJ/A.KOJO2')).toBeDefined();
    expect(index.getFile('D:\\proj\\a.kojo2')).toBeDefined();
    expect(index.files()).toEqual([PATH_A]);
  });

  it('removeFile：真删掉才 true 且 generation +1；不存在 false 且不变', () => {
    const index = createKojo2ProjectIndex();
    index.updateFile({ path: PATH_A, text: MAIN });
    const before = index.snapshot().generation;
    expect(index.removeFile(PATH_A)).toBe(true);
    expect(index.getFile(PATH_A)).toBeUndefined();
    expect(index.snapshot().generation).toBe(before + 1);
    expect(index.removeFile(PATH_A)).toBe(false);
    expect(index.snapshot().generation).toBe(before + 1);
  });

  it('files() 按路径归一键排序，返回原样路径（大小写不影响次序）', () => {
    const index = indexWith([
      { path: 'D:/proj/B.kojo2', text: LIB },
      { path: PATH_A, text: MAIN },
    ]);
    expect(index.files()).toEqual([PATH_A, 'D:/proj/B.kojo2']);
  });

  it('非法输入（空路径 / 非字符串路径 / 非字符串文本 / null）→ undefined 且索引不变', () => {
    const index = createKojo2ProjectIndex();
    expect(index.updateFile({ path: '', text: MAIN })).toBeUndefined();
    expect(index.updateFile({ path: 42 as unknown as string, text: MAIN })).toBeUndefined();
    expect(index.updateFile({ path: PATH_A, text: 42 as unknown as string })).toBeUndefined();
    expect(index.updateFile(null as unknown as { path: string; text: string })).toBeUndefined();
    expect(index.files()).toEqual([]);
  });

  it('snapshot 读数：文件数 / 符号数 / 出现点数 / 行数 / generation', () => {
    const index = baseIndex();
    const snapshot = index.snapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.files.map((file) => file.path)).toEqual([PATH_A, PATH_B]);
    expect(snapshot.symbolCount).toBeGreaterThan(0);
    expect(snapshot.siteCount).toBeGreaterThan(0);
    const main = snapshot.files[0];
    expect(main?.lines).toBe(kojo2DocumentOf(MAIN).lines.length);
    expect(main?.symbols).toBe(index.getFile(PATH_A)?.symbols.length);
    expect(main?.sites).toBe(index.getFile(PATH_A)?.siteCount);
  });
});

/* ============================== ② 缓存 ============================== */

describe('缓存：文本未变不重解析', () => {
  it('同一文本重复 updateFile → documentOf 只调一次，返回同一个条目', () => {
    const documentOf = vi.fn((text: string) => kojo2DocumentOf(text));
    const index = createKojo2ProjectIndex({ documentOf });
    const first = index.updateFile({ path: PATH_A, text: MAIN });
    const second = index.updateFile({ path: PATH_A, text: MAIN });
    expect(documentOf).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(index.snapshot().generation).toBe(1);
  });

  it('文本变了才重解析（第二次不同文本 → 调用计数 +1）', () => {
    const documentOf = vi.fn((text: string) => kojo2DocumentOf(text));
    const index = createKojo2ProjectIndex({ documentOf });
    index.updateFile({ path: PATH_A, text: MAIN });
    index.updateFile({ path: PATH_A, text: `${MAIN}\n// 改一行` });
    expect(documentOf).toHaveBeenCalledTimes(2);
    expect(index.snapshot().generation).toBe(2);
  });

  it('只改路径写法（文本相同）→ 不重解析、只换显示路径', () => {
    const documentOf = vi.fn((text: string) => kojo2DocumentOf(text));
    const index = createKojo2ProjectIndex({ documentOf });
    const first = index.updateFile({ path: PATH_A, text: MAIN });
    const renamed = index.updateFile({ path: 'd:\\proj\\A.kojo2', text: MAIN });
    expect(documentOf).toHaveBeenCalledTimes(1);
    expect(renamed?.path).toBe('d:\\proj\\A.kojo2');
    expect(renamed?.document).toBe(first?.document);
    expect(index.files()).toEqual(['d:\\proj\\A.kojo2']);
    expect(index.snapshot().generation).toBe(1);
  });
});

/* ============================== ③ 跨文件 refsOf ============================== */

describe('refsOf：跨文件、源码序、去重、上限', () => {
  it('表 `心情` 的跨文件引用：A 声明 + A 插值 + B 插值（按路径 → 源码序）', () => {
    const index = baseIndex();
    const found = index.refsOf({ name: '心情', kind: 'table' });
    expect(found.truncated).toBe(false);
    expect(refKeys(found.refs)).toEqual([
      `${PATH_A}:4:7`,
      `${PATH_A}:14:6`,
      `${PATH_B}:2:8`,
    ]);
    expect(found.refs.map((ref) => ref.kind)).toEqual(['decl', 'ref', 'ref']);
    expect(textAt(MAIN, found.refs[0]!.span)).toBe('心情');
    expect(textAt(MAIN, found.refs[1]!.span)).toBe('心情');
    expect(textAt(LIB, found.refs[2]!.span)).toBe('心情');
  });

  it('只在别的文件声明的名字：B 里的 `{心情}` / `{亲近线}` / `! 增加羁绊` 都能被索引看见', () => {
    const index = baseIndex();
    const heart = index.refsOf({ name: '心情', kind: 'table' });
    const constant = index.refsOf({ name: '亲近线', kind: 'constant' });
    const fn = index.refsOf({ name: '增加羁绊', kind: 'function' });
    expect(heart.refs.some((ref) => ref.path === PATH_B)).toBe(true);
    expect(constant.refs.some((ref) => ref.path === PATH_B)).toBe(true);
    expect(fn.refs.some((ref) => ref.path === PATH_B && ref.kind === 'call')).toBe(true);
    expect(fn.refs.filter((ref) => ref.kind === 'call').length).toBeGreaterThanOrEqual(2);
  });

  it('excludePath 排除当前文件（大小写 / 分隔符不敏感）', () => {
    const index = baseIndex();
    const found = index.refsOf({ name: '心情', kind: 'table', excludePath: 'd:\\PROJ\\a.kojo2' });
    expect(refKeys(found.refs)).toEqual([`${PATH_B}:2:8`]);
  });

  it('onlyPath 只查一份文件（跨文件引用位要把本文件出现点也列出时用）', () => {
    const index = baseIndex();
    const found = index.refsOf({ name: '心情', kind: 'table', onlyPath: 'd:\\PROJ\\b.kojo2' });
    expect(refKeys(found.refs)).toEqual([`${PATH_B}:2:8`]);
    expect(index.refsOf({ name: '心情', kind: 'table', onlyPath: PATH_B, excludePath: PATH_B }).refs).toHaveLength(1);
  });

  it('没有对应声明 → 空结果（候选位不会凭空造出符号）', () => {
    const index = baseIndex();
    expect(index.refsOf({ name: '不存在', kind: 'variable' })).toEqual({ refs: [], truncated: false });
    expect(index.refsOf({ name: '', kind: 'variable' })).toEqual({ refs: [], truncated: false });
    expect(index.refsOf({ name: '心情', kind: 'nope' as never })).toEqual({ refs: [], truncated: false });
  });

  it('结果按（路径 → 行 → 列）升序且同一位置只出现一次', () => {
    const index = baseIndex();
    const found = index.refsOf({ name: '增加羁绊', kind: 'function' });
    const keys = found.refs.map(
      (ref) => `${ref.path}\u0000${ref.span.startLine}\u0000${ref.span.startColumn}\u0000${ref.span.endColumn}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...found.refs].sort(
      (a, b) =>
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.span.startLine - b.span.startLine ||
        a.span.startColumn - b.span.startColumn,
    );
    expect(found.refs).toEqual(sorted);
    expect(found.refs[0]?.kind).toBe('decl');
  });

  it('喂入顺序不影响输出（确定性）', () => {
    const forward = baseIndex();
    const backward = indexWith([
      { path: PATH_B, text: LIB },
      { path: PATH_A, text: MAIN },
    ]);
    expect(backward.refsOf({ name: '心情', kind: 'table' })).toEqual(
      forward.refsOf({ name: '心情', kind: 'table' }),
    );
    expect(backward.snapshot()).toEqual(forward.snapshot());
  });

  it('上限常量是 2000；超过上限 → 恰好 2000 条 + truncated', () => {
    expect(KOJO2_PROJECT_REF_LIMIT).toBe(2000);
    const rows = ['# 池 甲', '    ? 否', '        「好。」'];
    for (let i = 0; i < KOJO2_PROJECT_REF_LIMIT + 5; i++) rows.push('! 甲');
    const index = indexWith([{ path: PATH_A, text: rows.join('\n') }]);
    const found = index.refsOf({ name: '甲', kind: 'pool' });
    expect(found.refs).toHaveLength(KOJO2_PROJECT_REF_LIMIT);
    expect(found.truncated).toBe(true);
    expect(found.refs[0]?.kind).toBe('decl');
  });

  it('恰好到上限 → truncated = false', () => {
    const rows = ['# 池 甲', '    ? 否', '        「好。」'];
    for (let i = 0; i < KOJO2_PROJECT_REF_LIMIT - 1; i++) rows.push('! 甲');
    const index = indexWith([{ path: PATH_A, text: rows.join('\n') }]);
    const found = index.refsOf({ name: '甲', kind: 'pool' });
    expect(found.refs).toHaveLength(KOJO2_PROJECT_REF_LIMIT);
    expect(found.truncated).toBe(false);
  });
});

/* ============================== ④ 声明查询 / 家族隔离 ============================== */

describe('declsOf：跨文件声明 + 家族隔离', () => {
  it('declsOf 返回名字段落点（路径 → 行 → 列）', () => {
    const index = baseIndex();
    const declarations = index.declsOf('心情');
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.path).toBe(PATH_A);
    expect(declarations[0]?.kind).toBe('table');
    expect(declarations[0]?.span.startLine).toBe(4);
    expect(textAt(MAIN, declarations[0]!.span)).toBe('心情');
  });

  it('事件在 A 有 `# 机`、在 B 只有 `@织`：两条声明锚点都在', () => {
    const index = baseIndex();
    const declarations = index.declsOf('指令');
    expect(declarations.map((entry) => entry.path)).toEqual([PATH_A, PATH_B]);
    expect(declarations.every((entry) => entry.kind === 'event')).toBe(true);
    expect(declarations[0]?.span.startLine).toBe(10); // A 的 `# 机`
    expect(declarations[1]?.span.startLine).toBe(5); // B 的最早 `@织`
  });

  it('表 `心情` 与变量 `心情` 互不串：变量文件的赋值 / 声明不进表的引用表', () => {
    const index = indexWith([
      { path: PATH_A, text: MAIN },
      { path: PATH_B, text: VARIABLE_HEART },
    ]);
    const table = index.refsOf({ name: '心情', kind: 'table' });
    const variable = index.refsOf({ name: '心情', kind: 'variable' });
    expect(table.refs.every((ref) => ref.path === PATH_A)).toBe(true);
    expect(variable.refs.every((ref) => ref.path === PATH_B)).toBe(true);
    expect(variable.refs.map((ref) => ref.kind)).toEqual(['decl', 'ref']);
  });

  it('幕标题与变量同名：幕只有声明位，变量有引用位', () => {
    const index = indexWith([{ path: PATH_A, text: SAME_NAME_FAMILIES }]);
    const scene = index.refsOf({ name: '日常', kind: 'scene' });
    const variable = index.refsOf({ name: '日常', kind: 'variable' });
    expect(scene.refs).toHaveLength(1);
    expect(scene.refs[0]?.kind).toBe('decl');
    expect(variable.refs.map((ref) => ref.kind)).toEqual(['decl', 'ref']);
  });

  it('事件与变量同名：事件只收 `# 机` / `@织` 挂点，变量只收表达式位', () => {
    const index = indexWith([{ path: PATH_A, text: SAME_NAME_FAMILIES }]);
    const event = index.refsOf({ name: '日常', kind: 'event' });
    const variable = index.refsOf({ name: '日常', kind: 'variable' });
    expect(event.refs.map((ref) => `${ref.span.startLine}:${ref.kind}`)).toEqual(['3:decl', '6:ref']);
    expect(variable.refs.map((ref) => `${ref.span.startLine}:${ref.kind}`)).toEqual(['2:decl', '5:ref']);
  });

  it('declsOf 对未知名字 / 坏输入 → 空数组', () => {
    const index = baseIndex();
    expect(index.declsOf('不存在')).toEqual([]);
    expect(index.declsOf('')).toEqual([]);
    expect(index.declsOf(null as unknown as string)).toEqual([]);
  });

  it('symbolAt：B 文件引用位（本文件无声明）→ 名字 + 项目里的声明种类', () => {
    const index = baseIndex();
    const atHeart = positionIn(LIB, '{心情}', 0, 1);
    expect(index.symbolAt({ path: PATH_B, line: atHeart.line, column: atHeart.column })).toEqual({
      name: '心情',
      kind: 'table',
    });
    const atFn = positionIn(LIB, '! 增加羁绊', 0, 2);
    expect(index.symbolAt({ path: PATH_B, line: atFn.line, column: atFn.column })).toEqual({
      name: '增加羁绊',
      kind: 'function',
    });
  });

  it('symbolAt：非引用位 / 未知路径 / 坏坐标 → null', () => {
    const index = baseIndex();
    expect(index.symbolAt({ path: PATH_B, line: 1, column: 1 })).toBeNull();
    expect(index.symbolAt({ path: 'D:/proj/nope.kojo2', line: 2, column: 8 })).toBeNull();
    expect(index.symbolAt({ path: PATH_B, line: 0, column: 1 })).toBeNull();
    expect(index.symbolAt({ path: PATH_B, line: 2, column: Number.NaN })).toBeNull();
  });

  it('symbolAt：同名多家族（core 错误态）→ null（不猜种类）', () => {
    const index = indexWith([
      { path: PATH_A, text: MAIN },
      { path: PATH_B, text: VARIABLE_HEART },
      { path: 'D:/proj/c.kojo2', text: '> 这一行里 {心情} 只引用。' },
    ]);
    const position = positionIn('> 这一行里 {心情} 只引用。', '{心情}', 0, 1);
    expect(index.symbolAt({ path: 'D:/proj/c.kojo2', line: position.line, column: position.column })).toBeNull();
  });

  it('symbolAt：候选位存在但项目里没有声明 → null', () => {
    const index = indexWith([{ path: PATH_A, text: '> 只有旁白，{无名} 不算符号。' }]);
    const position = positionIn('> 只有旁白，{无名} 不算符号。', '{无名}', 0, 1);
    expect(index.symbolAt({ path: PATH_A, line: position.line, column: position.column })).toBeNull();
  });
});

/* ============================== ⑤ 坏文件 / CRLF ============================== */

describe('坏文件不污染 / CRLF', () => {
  it('解析抛错：新路径不入索引、旧条目原样保留', () => {
    const documentOf = (text: string) => {
      if (text.includes('BOOM')) throw new Error('桩：解析炸了');
      return kojo2DocumentOf(text);
    };
    const index = createKojo2ProjectIndex({ documentOf });
    const good = index.updateFile({ path: PATH_A, text: MAIN });
    const before = index.refsOf({ name: '心情', kind: 'table' });
    expect(index.updateFile({ path: 'D:/proj/bad.kojo2', text: 'BOOM' })).toBeUndefined();
    expect(index.updateFile({ path: PATH_A, text: `${MAIN} // BOOM` })).toBeUndefined();
    expect(index.getFile(PATH_A)).toBe(good);
    expect(index.refsOf({ name: '心情', kind: 'table' })).toEqual(before);
    expect(index.files()).toEqual([PATH_A]);
  });

  it('垃圾文本（语法坏）不造假符号，也不影响其它文件', () => {
    const index = baseIndex();
    const before = index.refsOf({ name: '心情', kind: 'table' });
    index.updateFile({ path: 'D:/proj/garbage.kojo2', text: '@函 (((\n# 幕\n???\n> {{{' });
    expect(index.refsOf({ name: '心情', kind: 'table' })).toEqual(before);
    expect(index.refsOf({ name: '((', kind: 'function' }).refs).toEqual([]);
  });

  it('CRLF 与 LF 给出逐字相同的跨文件引用结果', () => {
    const lf = baseIndex();
    const crlf = indexWith([
      { path: PATH_A, text: MAIN.replace(/\n/g, '\r\n') },
      { path: PATH_B, text: LIB.replace(/\n/g, '\r\n') },
    ]);
    expect(crlf.refsOf({ name: '心情', kind: 'table' })).toEqual(
      lf.refsOf({ name: '心情', kind: 'table' }),
    );
    expect(crlf.refsOf({ name: '指令', kind: 'event' })).toEqual(
      lf.refsOf({ name: '指令', kind: 'event' }),
    );
  });
});

/* ============================== ⑥ 性能护栏 ============================== */

describe('性能：5k 行单文件更新 < 8ms', () => {
  /**
   * 生成恰好 `lines` 行的夹具：声明 / 引用位集中在头尾，中间用注释行撑到量级。
   * 这样 5k 行确实过一遍 lexer + 扫描（不是空文件），又不让每行都是叙事正文——
   * 后者的词法开销本身就超过预算，测的就不是索引了。
   */
  function bigSource(lines: number): string {
    const rows: string[] = [
      '# 设 亲近线 整数 = 500',
      '# 设 今天已触发 整数 = 0 存档',
      '# 对照表 心情 依据 亲近线',
      '    0..99 -> 疏远',
      '    否 -> 未知',
      '@函 增加羁绊(目标, 数值=10)',
      '    @返 目标 + 亲近线',
    ];
    while (rows.length < lines - 3) rows.push('// 注释：把 5k 行文件撑到量级，不产生引用位');
    rows.push('> 晨光透过鸟居，{今天已触发} 次。');
    rows.push('旅人：「{心情}今天来得挺早嘛。」');
    rows.push('! 增加羁绊(目标, 12)');
    return rows.join('\n');
  }



  it('文本未变的 5k 行更新命中缓存（返回同一份条目，不重解析）', () => {
    const source = bigSource(5000);
    const index = createKojo2ProjectIndex();
    const first = index.updateFile({ path: 'D:/proj/big.kojo2', text: source });
    const second = index.updateFile({ path: 'D:/proj/big.kojo2', text: source });
    // 墙钟预算在 `kojo2-project-index.perf.test.ts`（串行静默池）：并行主池里只钉"同一份条目"。
    expect(second).toBe(first);
  });
});

/* ============================== ⑦ 跨文件合并（纯函数） ============================== */

describe('kojo2ProjectReferencesAt：本文件 + 跨文件合并', () => {
  it('声明处查询：本地声明 / 本地引用 + B 文件引用，声明位在最前', () => {
    const index = baseIndex();
    const result = kojo2ProjectReferencesAt(MAIN, declarationPosition(MAIN, '心情'), index, {
      path: PATH_A,
    });
    expect(result).not.toBeNull();
    expect(result?.symbol.name).toBe('心情');
    expect(result?.symbol.kind).toBe('table');
    expect(result?.local).toHaveLength(2);
    expect(result?.external.map((ref) => ref.path)).toEqual([PATH_B]);
    expect(result?.refs.map((ref) => ref.kind)).toEqual(['decl', 'ref', 'ref']);
    expect(result?.refs.map((ref) => (ref.path === null ? 'local' : ref.path))).toEqual([
      'local',
      'local',
      PATH_B,
    ]);
    expect(result?.refs[0]?.span.startLine).toBe(4);
    expect(result?.truncated).toBe(false);
  });

  it('本文件 `@织` 查事件：跨文件 `# 机` 声明被提到最前（声明位在前）', () => {
    const index = baseIndex();
    const result = kojo2ProjectReferencesAt(
      LIB,
      positionIn(LIB, '@织 指令', 0, 3),
      index,
      { path: PATH_B },
    );
    expect(result).not.toBeNull();
    expect(result?.symbol.kind).toBe('event');
    expect(result?.refs[0]).toEqual({
      path: PATH_A,
      span: { startLine: 10, startColumn: 5, endLine: 10, endColumn: 7 },
      kind: 'decl',
    });
    expect(result?.refs.filter((ref) => ref.kind === 'decl')).toHaveLength(1);
    expect(result?.refs).toHaveLength(3);
  });

  it('索引缺席 → 退化成同文件结果（external 为空）', () => {
    const result = kojo2ProjectReferencesAt(MAIN, declarationPosition(MAIN, '心情'), null, {
      path: PATH_A,
    });
    expect(result?.external).toEqual([]);
    expect(result?.refs.every((ref) => ref.path === null)).toBe(true);
    expect(result?.refs).toHaveLength(2);
  });

  it('无法归属的位置 → null（正文 / 越界）', () => {
    const index = baseIndex();
    expect(
      kojo2ProjectReferencesAt(MAIN, positionIn(MAIN, '晨光透过鸟居'), index, { path: PATH_A }),
    ).toBeNull();
    expect(
      kojo2ProjectReferencesAt(MAIN, { line: 999, column: 1 }, index, { path: PATH_A }),
    ).toBeNull();
  });

  it('路径缺省时索引不排除本文件（记录缺口：本文件落点会在 external 里再出现）', () => {
    const index = baseIndex();
    const result = kojo2ProjectReferencesAt(MAIN, declarationPosition(MAIN, '心情'), index);
    expect(result?.external.length).toBeGreaterThanOrEqual(2);
    expect(result?.refs.length).toBeGreaterThanOrEqual(4);
  });

  it('B 文件的引用位（本文件没声明）→ 跨文件找到 A 的声明 + 两侧出现点', () => {
    const index = baseIndex();
    const result = kojo2ProjectReferencesAt(
      LIB,
      positionIn(LIB, '{心情}', 0, 1),
      index,
      { path: PATH_B },
    );
    expect(result).not.toBeNull();
    expect(result?.symbol.name).toBe('心情');
    expect(result?.symbol.kind).toBe('table');
    expect(result?.symbol.declSpan.startLine).toBe(4);
    expect(result?.local).toHaveLength(1);
    expect(result?.external.map((ref) => `${ref.path}:${ref.kind}`)).toEqual([
      `${PATH_A}:decl`,
      `${PATH_A}:ref`,
    ]);
    expect(result?.refs[0]?.kind).toBe('decl');
    expect(result?.refs.map((ref) => (ref.path === null ? 'local' : ref.path))).toEqual([
      PATH_A,
      'local',
      PATH_A,
    ]);
  });

  it('当前文件不在索引里（脏 model）→ 仍能从引用位解析跨文件符号', () => {
    const index = indexWith([{ path: PATH_A, text: MAIN }]); // B 还没喂进索引
    const result = kojo2ProjectReferencesAt(
      LIB,
      positionIn(LIB, '{心情}', 0, 1),
      index,
      { path: PATH_B },
    );
    expect(result?.symbol.kind).toBe('table');
    expect(result?.local).toEqual([]);
    expect(result?.external.map((ref) => `${ref.path}:${ref.kind}`)).toEqual([
      `${PATH_A}:decl`,
      `${PATH_A}:ref`,
    ]);
  });

  it('B 文件引用位 + 索引缺席 → null（没有项目就归属不了跨文件名字）', () => {
    expect(
      kojo2ProjectReferencesAt(LIB, positionIn(LIB, '{心情}', 0, 1), null, { path: PATH_B }),
    ).toBeNull();
  });

  it('B 文件引用位 + 同名多家族 → null（不猜一个种类）', () => {
    const index = indexWith([
      { path: PATH_A, text: MAIN },
      { path: PATH_B, text: LIB },
      { path: 'D:/proj/c.kojo2', text: VARIABLE_HEART },
    ]);
    expect(
      kojo2ProjectReferencesAt(LIB, positionIn(LIB, '{心情}', 0, 1), index, { path: PATH_B }),
    ).toBeNull();
  });

  it('索引端抛错 → 本文件结果照旧交出（不炸）', () => {
    const broken = {
      refsOf() {
        throw new Error('桩：索引端炸了');
      },
    } as unknown as Kojo2ProjectIndex;
    const result = kojo2ProjectReferencesAt(MAIN, declarationPosition(MAIN, '心情'), broken);
    expect(result?.external).toEqual([]);
    expect(result?.refs).toHaveLength(2);
  });
});

/* ============================== ⑧ B3e：索引形状仍供跨文件合并 ============================== */

describe('B3e：索引实例仍满足结构与跨文件合并（唯一供方是插件，provider 翻译在 kojo2-references）', () => {
  it('常驻索引直接喂 `kojo2ProjectReferencesAt`：本文件 + 跨文件结果逐条对得上', () => {
    const index = baseIndex();
    const result = kojo2ProjectReferencesAt(MAIN, declarationPosition(MAIN, '心情'), index, {
      path: PATH_A,
    });
    expect(result?.refs.map((site) => `${site.path ?? 'local'}:${site.kind}`)).toEqual([
      'local:decl',
      'local:ref',
      `${PATH_B}:ref`,
    ]);
  });

  it('索引的 `files()` + `getFile()` 是宿主快照的唯一来源（快照口径见 legs 的闸）', () => {
    const index = baseIndex();
    expect(index.files()).toEqual([PATH_A, PATH_B]);
    expect(index.getFile(PATH_A)?.text).toBe(MAIN);
    expect(index.getFile(PATH_B)?.text).toBe(LIB);
  });
});

