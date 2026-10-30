/**
 * K2 跨文件定义 · `kojo2` 转到定义的**判据闸**（同文件 + 项目快照两段）。
 *
 * 覆盖面：
 * 1. **同文件**：七类声明自跳（`# 设` / `# 对照表` / `# 池` / `# 模` / `@函` / `# 幕`）；
 *    `! 池 / 模 / 函` 调用跳声明行的**名字段**；台词 `{}` 插值内照常；
 * 2. **不跳**：注释 / 台词正文（插值外）/ 旁白 / `@原生` 体内 / 参数名 / 类型词——
 *    后两者在跨文件那一段同样不跳（引用位只有一把尺子，见包内 `projectSymbolNameIn`）；
 * 3. **跨文件**：本文无声明 ⇒ 到项目快照的声明里找同名（落点带真实 `filePath`）；
 *    同文件优先 / 按路径 → 行号 → 列排序 / 去重 / 结果上限 / 幕标题不进面 / 本文自排除；
 * 4. **边界**：`files` 缺席 = 同文件；非法坐标 / 空源 / 越界 **不抛**；四道预算闸
 *    （文件数 / 总字节 / 单份字节 / 本文 `lineCount`）各自置 `truncated` 并如实少给。
 */
import { describe, expect, it } from 'vitest';
import {
  KOJO2_PROJECT_DEFINITION_MAX_RESULTS,
  kojo2DefinitionAcrossProject,
  kojo2DefinitionAt,
} from '../src/definition';

const SOURCE = [
  '// 注释行：好感度', // 1
  '# 幕 神社清晨', // 2
  '# 设 好感度 整数 = 0 存档', // 3
  '# 对照表 心情 依据 恋慕', // 4
  '    0..99 -> 疏远', // 5
  '    否 -> 未知', // 6
  '# 池 早安问候', // 7
  '    ? 恋慕 < 100', // 8
  '        > （她笑了）', // 9
  '    ? 否', // 10
  '        > （她没说话）', // 11
  '# 模 娇羞退场(原因)', // 12
  '    > （因为{原因}而脸红）', // 13
  '@函 增加羁绊(目标, 数值=10)', // 14
  '    @返 数值', // 15
  '灵梦：「{心情}今天来得挺早嘛。」', // 16
  '! 早安问候', // 17
  '! 娇羞退场("被夸奖")', // 18
  '', // 19
  '@原生', // 20
  '    好感度 = 1', // 21
  '// 好感度 注释里', // 22
  '> 她今天很安静。', // 23
  '灵梦：「{声望}还差一点。」', // 24（`声望` 本文没有声明 ⇒ 跨文件那一段的入口）
  '! 声望', // 25（调用位形态）
].join('\n');

const OWN = 'D:/proj/a.kojo2';

function across(line: number, column: number, files: readonly { path: string; text: string }[] | undefined) {
  return kojo2DefinitionAcrossProject({ source: SOURCE, line, column, path: OWN }, files);
}

describe('kojo2DefinitionAt · 同文件声明', () => {
  it('四类 `#` 声明自跳：落在名字段（不是行首）', () => {
    // `# 设 好感度`：`#`=1、空格=2、`设`=3、空格=4、名字从第 5 列起
    expect(kojo2DefinitionAt({ source: SOURCE, line: 3, column: 5 })).toEqual({
      name: '好感度',
      kind: '设',
      line: 3,
      column: 5,
      endColumn: 8,
    });
    // 停在声明词 `设` 上同样算"在这条声明上"
    expect(kojo2DefinitionAt({ source: SOURCE, line: 3, column: 3 })?.column).toBe(5);
    // `# 幕 神社清晨`：幕标题整段是名字（4 个字）
    expect(kojo2DefinitionAt({ source: SOURCE, line: 2, column: 3 })).toEqual({
      name: '神社清晨',
      kind: '幕',
      line: 2,
      column: 5,
      endColumn: 9,
    });
    // `# 对照表 心情`
    expect(kojo2DefinitionAt({ source: SOURCE, line: 4, column: 7 })?.name).toBe('心情');
    // `# 池 早安问候`
    expect(kojo2DefinitionAt({ source: SOURCE, line: 7, column: 5 })?.name).toBe('早安问候');
    // `# 模 娇羞退场(原因)`：名字取 `(` 之前
    expect(kojo2DefinitionAt({ source: SOURCE, line: 12, column: 6 })).toEqual({
      name: '娇羞退场',
      kind: '模',
      line: 12,
      column: 5,
      endColumn: 9,
    });
    // `@函 增加羁绊(目标, 数值=10)`
    expect(kojo2DefinitionAt({ source: SOURCE, line: 14, column: 4 })?.name).toBe('增加羁绊');
  });

  it('`! 池 / 模 / 函` 调用跳声明行的名字段', () => {
    expect(kojo2DefinitionAt({ source: SOURCE, line: 17, column: 4 })).toEqual({
      name: '早安问候',
      kind: '池',
      line: 7,
      column: 5,
      endColumn: 9,
    });
    expect(kojo2DefinitionAt({ source: SOURCE, line: 18, column: 3 })).toEqual({
      name: '娇羞退场',
      kind: '模',
      line: 12,
      column: 5,
      endColumn: 9,
    });
    // `! 增加羁绊(目标, 12)` 形态（实参不参与定义落点）
    const call = ['@函 增加羁绊(目标, 数值=10)', '    @返 数值', '', '! 增加羁绊(目标, 12)'].join('\n');
    expect(kojo2DefinitionAt({ source: call, line: 4, column: 3 })?.line).toBe(1);
  });

  it('台词 `{}` 插值内跳，正文 / 旁白 / 注释 / `@原生` 体内不跳', () => {
    // 第 16 行：`灵梦：「` 之后 `{` 在第 5 列 ⇒ 第 6 列落在 `心情` 里
    expect(kojo2DefinitionAt({ source: SOURCE, line: 16, column: 6 })?.line).toBe(4);
    expect(kojo2DefinitionAt({ source: SOURCE, line: 16, column: 1 })).toBeUndefined(); // 说话人
    expect(kojo2DefinitionAt({ source: SOURCE, line: 16, column: 3 })).toBeUndefined(); // 引号正文
    expect(kojo2DefinitionAt({ source: SOURCE, line: 23, column: 3 })).toBeUndefined(); // 旁白
    expect(kojo2DefinitionAt({ source: SOURCE, line: 22, column: 5 })).toBeUndefined(); // 注释
    expect(kojo2DefinitionAt({ source: SOURCE, line: 21, column: 5 })).toBeUndefined(); // `@原生` 体
    expect(kojo2DefinitionAt({ source: SOURCE, line: 1, column: 8 })).toBeUndefined(); // 行首注释
  });

  it('参数名 / 类型词不是引用位 ⇒ 不跳', () => {
    expect(kojo2DefinitionAt({ source: SOURCE, line: 12, column: 10 })).toBeUndefined(); // `原因`
    expect(kojo2DefinitionAt({ source: SOURCE, line: 3, column: 9 })).toBeUndefined(); // `整数`
  });

  it('越界 / 非法坐标 / 空源一律不抛、回 undefined', () => {
    const bad = [
      { line: 0, column: 1 },
      { line: -1, column: 1 },
      { line: 999, column: 1 },
      { line: 3, column: 0 },
      { line: 3, column: 9999 },
      { line: Number.NaN, column: 1 },
      { line: 3, column: Number.NaN },
      { line: Number.POSITIVE_INFINITY, column: 1 },
    ];
    for (const at of bad) {
      expect(() => kojo2DefinitionAt({ source: SOURCE, ...at })).not.toThrow();
    }
    expect(kojo2DefinitionAt({ source: '', line: 1, column: 1 })).toBeUndefined();
  });
});

describe('kojo2DefinitionAcrossProject · 跨文件声明', () => {
  const TABLE_FILE = 'D:/proj/b.kojo2';
  /** 别的文件里声明 `声望`（本文只引用、不声明） */
  const DECL = '# 设 声望 整数 = 1';

  it('`files` 缺席 / 空 ⇒ 与同文件判据逐字相同', () => {
    expect(across(16, 6, undefined)).toEqual({
      targets: [{ name: '心情', kind: '对照表', line: 4, column: 7, endColumn: 9, filePath: OWN }],
      truncated: false,
    });
    expect(across(16, 6, [])).toEqual(across(16, 6, undefined));
    // 本地没有 ⇒ 空结果（不猜）
    expect(across(24, 6, undefined)).toEqual({ targets: [], truncated: false });
    expect(across(23, 3, undefined)).toEqual({ targets: [], truncated: false });
  });

  it('本文没有声明 ⇒ 在别的文件里找到同名声明（带真实 filePath）', () => {
    expect(across(24, 6, [{ path: TABLE_FILE, text: DECL }])).toEqual({
      targets: [{ name: '声望', kind: '设', line: 1, column: 5, endColumn: 7, filePath: TABLE_FILE }],
      truncated: false,
    });
  });

  it('跨文件同样认 `! 名` 调用位（池声明在别的文件）', () => {
    const other = { path: 'D:/proj/c.kojo2', text: '# 池 声望\n    ? 否\n        「早上好。」' };
    const found = across(25, 3, [other]);
    expect(found.targets[0]).toMatchObject({ name: '声望', kind: '池', line: 1, column: 5, filePath: other.path });
  });

  it('同文件优先：本地有声明就不再交项目里的同名声明', () => {
    const found = across(3, 5, [{ path: TABLE_FILE, text: '# 设 好感度 整数 = 1' }]);
    expect(found.targets).toHaveLength(1);
    expect(found.targets[0]!.filePath).toBe(OWN);
  });

  it('多候选按路径 → 行号排序（输入顺序无关）', () => {
    const z = { path: 'D:/proj/z.kojo2', text: '// 头\n# 设 声望 整数 = 1' };
    const b = { path: 'D:/proj/B.kojo2', text: '# 设 声望 整数 = 1\n# 设 声望 整数 = 2' };
    const found = across(24, 6, [z, b]);
    expect(found.targets.map((t) => `${t.filePath}#${t.line}`)).toEqual([
      'D:/proj/B.kojo2#1',
      'D:/proj/B.kojo2#2',
      'D:/proj/z.kojo2#2',
    ]);
    // 反向输入同一结果（确定性）
    expect(across(24, 6, [b, z])).toEqual(found);
  });

  it('结果上限：多出的截掉并置 `truncated`', () => {
    const files = ['a1', 'a2', 'a3'].map((n) => ({ path: `D:/proj/${n}.kojo2`, text: DECL }));
    const found = kojo2DefinitionAcrossProject({ source: SOURCE, line: 24, column: 6, path: OWN }, files, {
      maxResults: 2,
    });
    expect(found.targets).toHaveLength(2);
    expect(found.truncated).toBe(true);
    expect(KOJO2_PROJECT_DEFINITION_MAX_RESULTS).toBe(64);
  });

  it('幕标题不进跨文件面（同名的另一段戏不是定义）', () => {
    expect(across(24, 6, [{ path: TABLE_FILE, text: '# 幕 声望' }]).targets).toEqual([]);
  });

  it('本文自身被排除（快照里的本文可能是旧文本）', () => {
    expect(across(24, 6, [{ path: 'd:\\proj\\A.kojo2', text: DECL }]).targets).toEqual([]);
  });

  it('声明头的形参 / 类型词 / `@原生` 体即便别处有同名声明也不跳', () => {
    const decl = [{ path: TABLE_FILE, text: '# 设 原因 整数 = 1\n# 设 整数 整数 = 2\n# 设 好感度 整数 = 3' }];
    expect(across(12, 10, decl).targets).toEqual([]); // `原因` 是形参（声明头）
    expect(across(3, 9, decl).targets).toEqual([]); // `整数` 是类型词
    expect(across(21, 5, decl).targets).toEqual([]); // `@原生` 体
  });

  it('形参在体内的用法按**名字级**匹配（与 references 同一口径，本批不做作用域分析）', () => {
    // `    > （因为{原因}而脸红）`：`{` 在第 10 列 ⇒ 第 11 列落在 `原因` 里。
    // 这是一枚可证引用位（`candidatesOf` 的口径），所以项目里真有同名声明时会跳——
    // 如实钉在这里，免得下一个人把它当回归；要收窄得先给引用面一套作用域分析。
    const decl = [{ path: TABLE_FILE, text: '# 设 原因 整数 = 1' }];
    expect(across(13, 11, decl).targets).toEqual([
      { name: '原因', kind: '设', line: 1, column: 5, endColumn: 7, filePath: TABLE_FILE },
    ]);
  });

  it('四道预算闸各自置 `truncated` 并如实少给', () => {
    const big = { path: 'D:/proj/big.kojo2', text: DECL };
    const at = { source: SOURCE, line: 24, column: 6, path: OWN };
    // 单份字节
    expect(kojo2DefinitionAcrossProject(at, [big], { maxFileBytes: 4 })).toEqual({
      targets: [],
      truncated: true,
    });
    // 总字节
    expect(kojo2DefinitionAcrossProject(at, [big], { maxBytes: 1 })).toEqual({
      targets: [],
      truncated: true,
    });
    // 文件数
    expect(kojo2DefinitionAcrossProject(at, [big], { maxFiles: 0 })).toEqual({
      targets: [],
      truncated: true,
    });
    // 本文行数超档
    expect(
      kojo2DefinitionAcrossProject({ ...at, lineCount: 60_000 }, [big]),
    ).toEqual({ targets: [], truncated: true });
  });

  it('坏条目 / 坏坐标不抛（纯函数边界）', () => {
    const files = [null, 'x', { path: '', text: '' }, { path: 'D:/proj/b.kojo2' }] as never;
    expect(() => across(24, 6, files)).not.toThrow();
    expect(across(24, 6, files)).toEqual({ targets: [], truncated: false });
    for (const at of [
      { line: Number.NaN, column: 1 },
      { line: 24, column: Number.NaN },
      { line: 0, column: 1 },
      { line: 9999, column: 1 },
    ]) {
      expect(() => across(at.line, at.column, [{ path: TABLE_FILE, text: DECL }])).not.toThrow();
    }
    expect(kojo2DefinitionAcrossProject({ source: '', line: 1, column: 1 }, undefined)).toEqual({
      targets: [],
      truncated: false,
    });
  });
});
