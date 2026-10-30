/**
 * K2-LSP-CODELENS · Kojo 2.0 行上注解**判据**的闸（B3g 起判据住 `@kojo/kojo-lang/codelens`）。
 *
 * 覆盖七件事：
 * 1. **三类注解**：`# 机` 的「事件 + 参数 N」、`@织` 的「事件 + 层」、`@函` 的「N 处用到」；
 * 2. **计数口径**：就是引用判据（`@kojo/kojo-lang/references`）剔掉声明位那一条——
 *    台词 / 旁白 / 注释 / `@原生` 一律不算，声明头自己不算，递归照数；**不写第二把尺子**
 *    （B3g 之前宿主那侧另有一份自扫，本批连同它的口径一起删了）；
 * 3. **落点口径**：`line` / `column` / `span` 与声明索引逐字对齐，`mode` 三段分档
 *    （`# 机` / `@织` = `reveal`，`@函` = `references`）；文件身份由调用方补（包不碰路径）；
 * 4. **锚定行**：注解属于那一行（行尾空白 / 缩进 / CRLF 都不改行号）；
 * 5. **大文件闸**：> `KOJO2_CODE_LENS_LARGE_FILE_LINES` 只产前 `KOJO2_CODE_LENS_LARGE_FILE_LIMIT` 条；
 * 6. **不产**：`@原生` 体 / 注释 / 块内错写的声明 / 缺名字的声明；
 * 7. **项目快照**（B3g additive）：缺席 = 只答本篇（旧标题）；在场 = 数到项目级并改口
 *    「共 N 处用到」；快照不完整 ⇒ 标题如实写「未看全」+ `truncated` 标志。
 *
 * 宿主那一格（契约 → Monaco、注册与三态）在 `packages/app/tests/kojo2-codelens.test.ts`；
 * 供方那一格（非 kojo2 弃权、契约形状）在 `packages/plugins/kojo-lang/tests/codelens.test.ts`。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kojo2DocumentOf } from '@kojo/kojo-lang';
import { kojo2ReferencesAt } from '@kojo/kojo-lang/references';
import {
  KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER,
  KOJO2_CODE_LENS_LARGE_FILE_LIMIT,
  KOJO2_CODE_LENS_LARGE_FILE_LINES,
  kojo2CodeLenses,
  type Kojo2CodeLens,
  type Kojo2CodeLensKind,
  type Kojo2CodeLensTarget,
} from '@kojo/kojo-lang/codelens';

const HERE = import.meta.dirname;
const FIXTURE = readFileSync(
  resolve(HERE, '..', '..', 'app', 'tests', 'fixtures', 'kojo2', 'symbols.kojo2'),
  'utf8',
);

/** 某一类的全部注解（源码序） */
function lensesOfKind(source: string, kind: Kojo2CodeLensKind): readonly Kojo2CodeLens[] {
  return kojo2CodeLenses(source).filter((lens) => lens.kind === kind);
}

/** 落点（每条注解都带，路径那一格由调用方补） */
function targetOf(lens: Kojo2CodeLens): Kojo2CodeLensTarget {
  return lens.target;
}

/* ============================== 夹具 ============================== */

/** `# 机`：事件 `指令` + 一个参数 `310`（规范 §3.7 的示例形状） */
const MACHINE = '# 机 指令 310\n# 幕 神社清晨\n    > 她推开了门。\n';

/** `@织`：事件 `回合末` + 修饰词 `之后` */
const WEAVE = '@织 回合末 之后\n    > 雨声盖住了她的脚步。\n';

/** `@函`：声明 + 一处 `!` 调用 + 一处表达式调用 */
const FUNCTION = '@函 增加羁绊(目标, 数值=10)\n    ! 增加羁绊(1)\n    结果 = 增加羁绊(2)\n    @返 结果\n';

/** 三类都有的文件（`# 机` 在最前，`@织` / `@函` 在后） */
const MIXED = `${MACHINE}\n${WEAVE}\n${FUNCTION}`;

/* ============================== ① `# 机` ============================== */

describe('`# 机` 事件注解', () => {
  it('事件名 + 参数个数：`参数 N` 数的是事件名之后的词', () => {
    const [lens] = lensesOfKind(MACHINE, 'events');
    expect(lens).toBeDefined();
    expect(lens!.title).toBe('事件 指令 · 参数 1');
    expect(lens!.kind).toBe('events');
  });

  it('没有参数 ⇒ `参数 0`；多个参数按个数数', () => {
    expect(lensesOfKind('# 机 指令\n', 'events')[0]!.title).toBe('事件 指令 · 参数 0');
    expect(lensesOfKind('# 机 指令 310 80\n', 'events')[0]!.title).toBe('事件 指令 · 参数 2');
  });

  it('缺事件名的 `# 机` 不产注解（错误行不产注解）', () => {
    expect(lensesOfKind('# 机\n', 'events')).toEqual([]);
  });
});

/* ============================== ② `@织` ============================== */

describe('`@织` 监听注解', () => {
  it('带修饰词 ⇒ 层就是那个修饰词', () => {
    const [lens] = lensesOfKind(WEAVE, 'weave');
    expect(lens!.title).toBe('监听 回合末 · 之后');
    expect(lens!.kind).toBe('weave');
  });

  it('不带修饰词 ⇒ 普通层（`KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER`）', () => {
    expect(lensesOfKind('@织 回合末\n    > 旁白\n', 'weave')[0]!.title).toBe(
      `监听 回合末 · ${KOJO2_CODE_LENS_DEFAULT_WEAVE_LAYER}`,
    );
  });

  it('多个修饰词按源码原样列出（错误态也如实照抄，不替作者挑一个）', () => {
    expect(lensesOfKind('@织 回合末 之前 之后\n    > 旁白\n', 'weave')[0]!.title).toBe(
      '监听 回合末 · 之前 之后',
    );
  });

  it('缺事件名（首词就是修饰词）不产注解', () => {
    expect(lensesOfKind('@织 之前\n    > 旁白\n', 'weave')).toEqual([]);
    expect(lensesOfKind('@织\n', 'weave')).toEqual([]);
  });
});

/* ============================== ③ `@函` 引用计数 ============================== */

describe('`@函` 引用计数（引用判据单源）', () => {
  it('`! 名字` 与 `名字(` 都算一处：两处调用 ⇒ `本文件 2 处用到`', () => {
    const [lens] = lensesOfKind(FUNCTION, 'refs');
    expect(lens!.title).toBe('本文件 2 处用到');
    expect(lens!.kind).toBe('refs');
  });

  it('只有声明没有调用 ⇒ `本文件 0 处用到`（0 是事实，不退化成不出）', () => {
    expect(lensesOfKind('@函 孤独()\n    @返 1\n', 'refs')[0]!.title).toBe('本文件 0 处用到');
  });

  it('`! 名字` 不带括号也算一处调用', () => {
    expect(lensesOfKind('@函 打招呼()\n    ! 打招呼\n', 'refs')[0]!.title).toBe(
      '本文件 1 处用到',
    );
  });

  it('台词 / 旁白 / 注释 / `@原生` 体里的同名文字不算引用', () => {
    const source = [
      '@函 笑(目标)',
      '    > 笑(目标) 只是旁白里的字',
      '    灵梦：「笑(目标) 是台词。」',
      '    // 笑(目标) 是注释',
      '    @原生',
      '        笑(目标)',
      '    @返 0',
      '',
    ].join('\n');
    expect(lensesOfKind(source, 'refs')[0]!.title).toBe('本文件 0 处用到');
  });

  it('递归调用照数（函数体里两处自调用 ⇒ 2）', () => {
    const source = [
      '@函 斐波那契(n)',
      '    ? n <= 1',
      '        @返 n',
      '    @返 斐波那契(n - 1) + 斐波那契(n - 2)',
      '',
    ].join('\n');
    expect(lensesOfKind(source, 'refs')[0]!.title).toBe('本文件 2 处用到');
  });

  it('声明头自己不算一处调用（哪怕名字后面紧跟 `(`）', () => {
    expect(lensesOfKind('@函 单独(目标)\n    @返 目标\n', 'refs')[0]!.title).toBe(
      '本文件 0 处用到',
    );
  });

  it('名字按整词匹配：`增加羁绊` 不把 `增加羁绊值` 算到自己头上', () => {
    const source = ['@函 增加羁绊(目标)', '    ! 增加羁绊值(1)', '    ! 增加羁绊(2)', ''].join(
      '\n',
    );
    expect(lensesOfKind(source, 'refs')[0]!.title).toBe('本文件 1 处用到');
  });

  it('计数与引用面的读数逐字相等（同一条判据，不是第二把尺子）', () => {
    const lens = lensesOfKind(FUNCTION, 'refs')[0]!;
    const references = kojo2ReferencesAt(FUNCTION, {
      line: lens.target.line,
      column: lens.target.column,
    });
    expect(references).not.toBeNull();
    const nonDecl = references!.refs.filter((site) => site.kind !== 'decl').length;
    expect(lens.title).toBe(`本文件 ${nonDecl} 处用到`);
    expect(nonDecl).toBe(2);
    // 没有可归属符号的位置不会被冒写成"有一处"（判据回 null ⇒ 注解写 0）。
    expect(kojo2ReferencesAt('> 旁白\n', { line: 1, column: 1 })).toBeNull();
  });

  it('名字区间与 `kojo2-declarations` 的声明索引逐字对拍（不写第二把尺子）', () => {
    const declaration = kojo2DocumentOf(FUNCTION).declarations.find(
      (item) => item.kind === 'function',
    );
    expect(declaration).toBeDefined();
    const target = targetOf(lensesOfKind(FUNCTION, 'refs')[0]!);
    expect(target.column).toBe(declaration!.nameStart);
    expect(target.span).toEqual({
      columnStart: declaration!.nameStart,
      columnEnd: declaration!.nameEnd,
    });
  });
});

/* ============================== ④ 落点口径 / 锚定行 ============================== */

describe('落点口径 / 锚定行', () => {
  it('三类注解都有可读的标题（不产空话）', () => {
    for (const lens of kojo2CodeLenses(MIXED)) {
      expect(lens.title.length).toBeGreaterThan(0);
    }
  });

  it('`# 机` / `@织` 的落点 mode = reveal，`@函` 的 mode = references（请求引用面）', () => {
    const machine = targetOf(lensesOfKind(MACHINE, 'events')[0]!);
    expect(machine.mode).toBe('reveal');
    expect(machine.line).toBe(1);
    expect(machine.column).toBe(5); // `# 机 指令 310`：`指令` 从第 5 列起
    expect(machine.span).toEqual({ columnStart: 5, columnEnd: 7 });
    expect(targetOf(lensesOfKind(WEAVE, 'weave')[0]!).mode).toBe('reveal');
    expect(targetOf(lensesOfKind(FUNCTION, 'refs')[0]!).mode).toBe('references');
  });

  it('落点不带文件身份（路径是调用方的事：包不碰 IO 也不猜 model 是谁）', () => {
    const target = targetOf(lensesOfKind(MACHINE, 'events')[0]!) as unknown as Record<
      string,
      unknown
    >;
    expect(target['filePath']).toBeUndefined();
  });

  it('锚定行不随行尾空白 / 行尾 `续` 漂（注解属于那一行）', () => {
    const [plain] = lensesOfKind('# 机 指令 310\n', 'events');
    const [spaced] = lensesOfKind('# 机 指令 310    \n', 'events');
    expect(spaced!.line).toBe(plain!.line);
    expect(spaced!.target).toEqual(plain!.target);
  });

  it('三类注解按源码行升序（同一篇里不交叉）', () => {
    const lines = kojo2CodeLenses(MIXED).map((lens) => lens.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(kojo2CodeLenses(MIXED).map((lens) => lens.kind))).toEqual(
      new Set<Kojo2CodeLensKind>(['events', 'weave', 'refs']),
    );
  });

  it('同一输入两次调用逐字相等（纯函数、无缓存）', () => {
    expect(kojo2CodeLenses(MIXED)).toEqual(kojo2CodeLenses(MIXED));
  });

  it('LF / CRLF 同一份源文 ⇒ 同一批注解（行列口径不随换行漂）', () => {
    expect(kojo2CodeLenses(MIXED.replace(/\n/g, '\r\n'))).toEqual(kojo2CodeLenses(MIXED));
  });

  it('真实夹具：三类注解各就各位（行号 / 标题逐字）', () => {
    expect(kojo2CodeLenses(FIXTURE).map((lens) => [lens.line, lens.kind, lens.title])).toEqual([
      [4, 'events', '事件 指令 · 参数 1'],
      [25, 'refs', '本文件 0 处用到'],
      [28, 'weave', '监听 指令 · 之前'],
    ]);
  });
});

/* ============================== ⑤ 不产 / 空输入 ============================== */

describe('不产注解的行与空输入', () => {
  it('`@原生` 围栏里的 `# 机` / `@织` / `@函` 都是原文，不产注解', () => {
    const source = ['@原生', '    # 机 指令 310', '    @织 回合末 之后', '    @函 藏起来()', ''].join(
      '\n',
    );
    expect(kojo2CodeLenses(source)).toEqual([]);
  });

  it('块内错写的声明（缩进 > 0）不产注解', () => {
    const source = [
      '@函 外层()',
      '    # 机 指令 310',
      '    @织 回合末 之后',
      '    @函 内层()',
      '    @返 0',
      '',
    ].join('\n');
    const kinds = kojo2CodeLenses(source).map((lens) => lens.kind);
    expect(kinds).toEqual(['refs']);
    expect(kojo2CodeLenses(source)[0]!.title).toBe('本文件 0 处用到');
  });

  it('纯注释 / 纯叙事 / 空串 ⇒ []', () => {
    expect(kojo2CodeLenses('')).toEqual([]);
    expect(kojo2CodeLenses('// 注释\n// 又一行\n')).toEqual([]);
    expect(kojo2CodeLenses('> 只有旁白\n灵梦：「只有台词。」\n')).toEqual([]);
  });

  it('坏输入不抛（不把异常送进调用方）', () => {
    expect(() => kojo2CodeLenses('# 机\n@织\n@函 \n')).not.toThrow();
  });
});

/* ============================== ⑥ 大文件闸 ============================== */

/** 造一篇「函数声明若干行 + 旁白填充到指定行数」的源文（末尾无多余空行） */
function sourceOfLines(declarations: readonly string[], totalLines: number): string {
  const head = `${declarations.join('\n')}\n`;
  const filler = totalLines - declarations.length;
  return `${head}${'> 旁白\n'.repeat(Math.max(0, filler))}`;
}

const LARGE_DECLARATIONS = Array.from({ length: 12 }, (_, index) => `@函 f${index}()`);

describe('大文件闸：超过行数界线只产前 N 条', () => {
  it('N 写死为 10（改这条线必须改测试，不许悄悄放宽）', () => {
    expect(KOJO2_CODE_LENS_LARGE_FILE_LIMIT).toBe(10);
  });

  it('行数界线与宿主 `LARGE_FILE_LINES` 同值（5,000；漂了就是两套体量口径）', () => {
    expect(KOJO2_CODE_LENS_LARGE_FILE_LINES).toBe(5000);
  });

  it('恰好行数界线 ⇒ 全产（界线是「大于」）', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, KOJO2_CODE_LENS_LARGE_FILE_LINES);
    expect(kojo2CodeLenses(source)).toHaveLength(12);
  });

  it('行数界线 + 1 行 ⇒ 只产前 KOJO2_CODE_LENS_LARGE_FILE_LIMIT 条', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, KOJO2_CODE_LENS_LARGE_FILE_LINES + 1);
    expect(kojo2CodeLenses(source)).toHaveLength(KOJO2_CODE_LENS_LARGE_FILE_LIMIT);
  });

  it('截断保留的是源码序最前的那几条（行号从 1 起连续）', () => {
    const source = sourceOfLines(LARGE_DECLARATIONS, KOJO2_CODE_LENS_LARGE_FILE_LINES + 1);
    expect(kojo2CodeLenses(source).map((lens) => lens.line)).toEqual(
      Array.from({ length: KOJO2_CODE_LENS_LARGE_FILE_LIMIT }, (_, index) => index + 1),
    );
  });

  it('超档文件的注解内容不因截断而改变（仍是真话）', () => {
    const source = `${'# 机 指令 310\n'}${'> 旁白\n'.repeat(KOJO2_CODE_LENS_LARGE_FILE_LINES)}`;
    const [lens] = kojo2CodeLenses(source);
    expect(lens!.title).toBe('事件 指令 · 参数 1');
    // 界线可注入（只为可单测；宿主与插件都用缺省值）。
    expect(kojo2CodeLenses(source, { largeFileLines: 3 })).toHaveLength(1);
  });
});

/* ============================== ⑦ 项目快照（B3g） ============================== */

const FILE_PATH = 'C:/p/口上.kojo2';

/** 声明 `增加羁绊` 的那一篇（本文件）+ 两处别的文件里的调用 */
const PROJECT_FILES = [
  {
    path: 'C:/p/事件.kojo2',
    text: '# 幕 夜晚\n! 增加羁绊(3)\n> 她笑了。\n! 增加羁绊(4)\n',
  },
  {
    path: 'C:/p/无关.kojo2',
    text: '# 幕 清晨\n> 与这个函数无关。\n',
  },
];

describe('项目快照：缺席复刻本文件口径，在场数到项目级并如实说范围', () => {
  it('快照缺席 ⇒ 仍是「本文件 N 处用到」（与 B3g 之前逐字相同）', () => {
    const [lens] = lensesOfKind(FUNCTION, 'refs');
    expect(lens!.title).toBe('本文件 2 处用到');
    expect(lens!.truncated).toBeUndefined();
  });

  it('空快照数组 ⇒ 退化成同文件（不退化成"项目里没有"）', () => {
    const [lens] = kojo2CodeLenses(FUNCTION, { path: FILE_PATH, projectFiles: [] }).filter(
      (item) => item.kind === 'refs',
    );
    expect(lens!.title).toBe('本文件 2 处用到');
  });

  it('快照在场 ⇒ 同文件 + 别的文件的调用合并计数，标题改口「共 N 处用到」', () => {
    const [lens] = kojo2CodeLenses(FUNCTION, {
      path: FILE_PATH,
      projectFiles: PROJECT_FILES,
      projectFilesComplete: true,
    }).filter((item) => item.kind === 'refs');
    // 本文件 2 处 + 事件.kojo2 里 2 处 = 4；本文件自己不在快照里，不会重复计。
    expect(lens!.title).toBe('共 4 处用到');
    expect(lens!.truncated).toBeUndefined();
  });

  it('快照不完整 ⇒ 照样作答，但标题如实写「未看全」并置 truncated', () => {
    const [lens] = kojo2CodeLenses(FUNCTION, {
      path: FILE_PATH,
      projectFiles: PROJECT_FILES,
      projectFilesComplete: false,
    }).filter((item) => item.kind === 'refs');
    expect(lens!.title).toBe('共 4 处用到（未看全）');
    expect(lens!.truncated).toBe(true);
  });

  it('快照在场但不知道本篇是谁（无 path）⇒ 退回同文件口径并照实说「本文件」', () => {
    const [lens] = kojo2CodeLenses(FUNCTION, {
      projectFiles: PROJECT_FILES,
      projectFilesComplete: true,
    }).filter((item) => item.kind === 'refs');
    expect(lens!.title).toBe('本文件 2 处用到');
  });

  it('快照只影响 `@函`：`# 机` / `@织` 的标题一字不变', () => {
    const withSnapshot = kojo2CodeLenses(MIXED, {
      path: FILE_PATH,
      projectFiles: PROJECT_FILES,
    });
    const without = kojo2CodeLenses(MIXED);
    expect(withSnapshot.filter((lens) => lens.kind !== 'refs')).toEqual(
      without.filter((lens) => lens.kind !== 'refs'),
    );
  });

  it('坏快照（缺 text / 空路径）不抛，退回同文件读数', () => {
    const broken = [
      { path: '', text: '! 增加羁绊(9)\n' },
      { path: 'C:/p/坏.kojo2' } as unknown as { path: string; text: string },
    ];
    let lenses: readonly Kojo2CodeLens[] = [];
    expect(() => {
      lenses = kojo2CodeLenses(FUNCTION, { path: FILE_PATH, projectFiles: broken });
    }).not.toThrow();
    expect(lenses.filter((item) => item.kind === 'refs')[0]!.title).toBe('共 2 处用到');
  });

  it('同一份快照两次调用逐字相等（纯函数；快照索引是临时表，不缓存）', () => {
    const options = { path: FILE_PATH, projectFiles: PROJECT_FILES };
    expect(kojo2CodeLenses(FUNCTION, options)).toEqual(kojo2CodeLenses(FUNCTION, options));
  });
});

/* ============================== ⑧ 纯函数边界 ============================== */

describe('纯函数边界（包内不许出现 IO / 宿主类型）', () => {
  it('路径只当字符串用：给不给都不影响本文件那几条的标题口径', () => {
    const withPath = kojo2CodeLenses(MIXED, { path: FILE_PATH });
    const withoutPath = kojo2CodeLenses(MIXED);
    expect(withPath.map((lens) => lens.title)).toEqual(withoutPath.map((lens) => lens.title));
  });

  it('源文里的绝对路径字样不会出现在任何标题里（注解只说源码事实）', () => {
    const titles = kojo2CodeLenses(MIXED, { path: FILE_PATH }).map((lens) => lens.title);
    for (const title of titles) expect(title).not.toContain(join('C:', 'p'));
  });
});
