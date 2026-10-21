/**
 * M7 迁移引擎回归（v1 `.kojo` → 2.0 `.kojo2`）——设计稿 §12.1 / §16.8。
 *
 * 三层判据：
 * 1. **正例逐字节**：每个机械可迁移构造一条，断言迁移产物逐字相等（不是"大致像"）；
 * 2. **不可迁移台账**：每条断言 `ok=false` + `core/migration/*` 码 + 行号 + **原块逐字保留**；
 * 3. **闭环**：迁移产物再迁移逐字节不变（幂等）；正例产物送 2.0 前端解析零 error。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateKojoSource, summarizeMigration, type MigrateResult } from '../src/migrate/index.js';
import { parseSource } from '../src/parser.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/migrate/${name}`, import.meta.url), 'utf8');
}

/** 迁移并断言成功（正例统一入口；失败时把台账打到断言消息里） */
function migrateOk(source: string, options?: Parameters<typeof migrateKojoSource>[1]): MigrateResult {
  const result = migrateKojoSource(source, options);
  expect(result.ok, `unexpected unsupported: ${JSON.stringify(result.unsupported)}`).toBe(true);
  return result;
}

/** 断言产物里没有 error 诊断（迁移后能过 2.0 前端） */
function expectParsesClean(code: string): void {
  const diagnostics = parseSource(code).diagnostics.filter((d) => d.severity === 'error');
  expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
}

const MACHINE = '# 机 指令 310\n';

/* ============================== 正例：逐字节 ============================== */

describe('机械可迁移：逐字节正例', () => {
  it('端到端 fixture：迁移 → 逐字节 → 2.0 前端零 error → 幂等', () => {
    const result = migrateOk(fixture('mechanical.kojo.txt'));
    expect(result.code).toBe(fixture('mechanical.kojo2'));
    expect(result.unsupported).toEqual([]);
    expectParsesClean(result.code);
    const again = migrateKojoSource(result.code);
    expect(again.ok).toBe(true);
    expect(again.code).toBe(result.code);
  });

  it('2.0 正典 fixture 原样通过（已迁移文件再迁移零改动；`选项` 待定 warning 不影响 ok）', () => {
    const canonical = readFileSync(new URL('./fixtures/kojo2-canonical.kojo2', import.meta.url), 'utf8');
    const result = migrateKojoSource(canonical);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(canonical);
    expect(result.sourceMap).toEqual([...Array(canonical.split('\n').length - 1)].map((_, i) => i + 1));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['core/options/pending']);
    expect(result.diagnostics[0]!.severity).toBe('warning');
  });

  it('行尾等待别名 `~` / `⏎` / `cont` / `continue` → `续`；正典 `续` 不动', () => {
    const src =
      '角色: 灵梦\n时机 指令 310：\n' +
      '    「甲」 ~\n    「乙」 ⏎\n    「丙」 cont\n    「丁」 continue\n    「戊」 续\n';
    const result = migrateOk(src);
    expect(result.code).toBe(
      MACHINE + '灵梦：「甲」 续\n灵梦：「乙」 续\n灵梦：「丙」 续\n灵梦：「丁」 续\n灵梦：「戊」 续\n',
    );
  });

  it('`;` 注释 → 整行 `//`（保留缩进与注释正文）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    ; 分节线\n    「甲」\n');
    expect(result.code).toBe(MACHINE + '// 分节线\n灵梦：「甲」\n');
  });

  it('裸旁白 → `>`；裸台词 → `角色：「…」`（说话人取 v1 文件头 `角色:`）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    她点了点头。\n    「你好。」\n');
    expect(result.code).toBe(MACHINE + '> 她点了点头。\n灵梦：「你好。」\n');
  });

  it('说话人可来自 options.speaker（v1 文件头缺 `角色:` 时的兜底）', () => {
    const result = migrateOk('时机 指令 310：\n    「你好。」\n', { speaker: '灵梦' });
    expect(result.code).toBe(MACHINE + '灵梦：「你好。」\n');
    expect(result.metadata.chara).toBeNull();
  });

  it('半角旧引号 `｢…｣` → 「」', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    ｢你好。｣\n');
    expect(result.code).toBe(MACHINE + '灵梦：「你好。」\n');
  });

  it('`心形 「…」` 单行 / `心形：` 块 → 行尾 `(心形)`（含 `你：` 自机前缀）', () => {
    const src =
      '角色: 灵梦\n时机 指令 310：\n' +
      '    心形 「呀。」\n    心形：\n        「哇。」\n        你：我也很高兴。\n        旁白一句。\n';
    const result = migrateOk(src);
    expect(result.code).toBe(
      MACHINE + '灵梦：「呀。」(心形)\n灵梦：「哇。」(心形)\n你：「我也很高兴。」(心形)\n> 旁白一句。(心形)\n',
    );
  });

  it('`着色 0x…：` 块 → `@着色 0x…`（块体同缩进迁移）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    着色 0xFF8080：\n        「红。」\n    普通旁白。\n');
    expect(result.code).toBe(MACHINE + '@着色 0xFF8080\n    灵梦：「红。」\n> 普通旁白。\n');
  });

  it('`随机：` 块 → `@随机`（单行候选取说话人；多行候选包 `@组`；`组：` → `@组`）', () => {
    const src = fixture('mechanical.kojo.txt');
    const result = migrateOk(src);
    expect(result.code).toContain('@随机\n    灵梦：「甲。」\n    @组\n        灵梦：「乙。」\n        > 旁白。\n');
  });

  it('行内 `随机 「甲」,「乙」` → `@随机` + 两个候选行', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    随机 「甲。」,「乙。」\n');
    expect(result.code).toBe(MACHINE + '@随机\n    灵梦：「甲。」\n    灵梦：「乙。」\n');
  });

  it('`如果 / 否则如果 / 否则` → `?` / `?` / `? 否`（保序，不排序）', () => {
    const src =
      '角色: 灵梦\n时机 指令 310：\n' +
      '    如果 恋慕 >= 500：\n        「高。」\n' +
      '    否则如果 恋慕 >= 100：\n        「中。」\n' +
      '    否则：\n        「低。」\n';
    const result = migrateOk(src);
    expect(result.code).toBe(
      MACHINE +
        '? 恋慕 >= 500\n    灵梦：「高。」\n? 恋慕 >= 100\n    灵梦：「中。」\n? 否\n    灵梦：「低。」\n',
    );
  });

  it('行内块头 `如果 条件： 语句` → `?` + 缩进一行', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    如果 TFLAG:1： 「行内。」\n');
    expect(result.code).toBe(MACHINE + '? TFLAG:1\n    灵梦：「行内。」\n');
  });

  it('`时机 指令 310：` → `# 机 指令 310`，块体降一级；`# 时机` 旧形同映射', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    「a」\n');
    expect(result.code).toBe(MACHINE + '灵梦：「a」\n');
    const hash = migrateOk('角色: 灵梦\n# 时机 事件 100\n');
    expect(hash.code).toBe('# 机 事件 100\n');
  });

  it('`函数 …：` → `@函`；`调用` → `!`；`返回` → `@返`', () => {
    const src = '角色: 灵梦\n函数 打招呼(名字)：\n    调用 早安()\n    返回 1\n';
    const result = migrateOk(src);
    expect(result.code).toBe('@函 打招呼(名字)\n    ! 早安()\n    @返 1\n');
  });

  it('`标签` / `跳到` → `@标` / `@跳`（`$` / `*` 前缀剥掉）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    标签 $主菜单\n    跳到 *主菜单\n');
    expect(result.code).toBe(MACHINE + '@标 主菜单\n@跳 主菜单\n');
  });

  it('`@` 原生函数块 → `@原生` 缩进围栏（内容逐字节保留），与 v1 同界（下一个 `@` 行或 EOF）', () => {
    const src = '角色: 灵梦\n@M_KOJO_K12_310\nPRINTFORMW 「原生」\nIF TFLAG:1\nENDIF\n';
    const result = migrateOk(src);
    expect(result.code).toBe('@原生\n    @M_KOJO_K12_310\n    PRINTFORMW 「原生」\n    IF TFLAG:1\n    ENDIF\n');
  });

  it('`#DIM` 族 / `[SKIPSTART]` 族 → `@原生`', () => {
    const dim = migrateOk('#DIM 旧变量, 0\n#DIMS 旧名, "x"\n');
    expect(dim.code).toBe('@原生\n    #DIM 旧变量, 0\n    #DIMS 旧名, "x"\n');
    const skip = migrateOk('角色: 灵梦\n[SKIPSTART]\nSETCOLOR 1\n[SKIPEND]\n');
    expect(skip.code).toBe('@原生\n    [SKIPSTART]\n    SETCOLOR 1\n    [SKIPEND]\n');
  });

  it('`选项：` 保留为 2.0 待定 UI：条目与正文照常迁移，给 `core/options/pending` warning', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    选项：\n        「好」：\n            「嗯。」\n');
    expect(result.code).toBe(MACHINE + '选项：\n    「好」：\n        灵梦：「嗯。」\n');
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([['core/options/pending', 'warning']]);
  });

  it('`空行` 三态原样保留（2.0 正典）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    空行\n    空行 等待\n    空行 续\n');
    expect(result.code).toBe(MACHINE + '空行\n空行 等待\n空行 续\n');
  });

  it('结构化行的 v1 行内 `;` 注释 → 独立 `//` 行（2.0 无行尾注释）', () => {
    const result = migrateOk('角色: 灵梦\n函数 f()：\n    调用 早安() ; 说明\n');
    expect(result.code).toBe('@函 f()\n    ! 早安()\n    // 说明\n');
  });

  it('缩进归一：TAB 缩进 → 4 空格/级；全角空格同样折算', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n\t如果 TFLAG:1：\n\t\t「a」\n');
    expect(result.code).toBe(MACHINE + '? TFLAG:1\n    灵梦：「a」\n');
  });

  it('v1 文件头声明：`角色:` 作说话人，其余搬进 metadata（不进 2.0 脚本）', () => {
    const src = '角色: 灵梦\n口上: 灵梦口上\n显示名: 清晨\n简介: 说明\n开关:\n    眠姦口上有: 是\n';
    const result = migrateOk(src);
    expect(result.code).toBe('');
    expect(result.metadata.chara).toBe('灵梦');
    expect(result.metadata.headLines.map((h) => h.word)).toEqual(['角色', '口上', '显示名', '简介', '开关']);
    expect(result.metadata.headLines[4]!.body).toEqual(['    眠姦口上有: 是']);
  });

  it('`# 版本` 删除并给 warning（2.0 没有版本号）', () => {
    const result = migrateOk('# 版本 1.0\n角色: 灵梦\n时机 指令 310：\n    「a」\n');
    expect(result.code).toBe(MACHINE + '灵梦：「a」\n');
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([['core/migration/version', 'warning']]);
  });

  it('CRLF / BOM / 末尾换行原样保留', () => {
    const src = '\uFEFF角色: 灵梦\r\n时机 指令 310：\r\n    「a」\r\n';
    const result = migrateOk(src);
    expect(result.code).toBe('\uFEFF# 机 指令 310\r\n灵梦：「a」\r\n');
    const noFinal = migrateOk('角色: 灵梦\n时机 指令 310：\n    「a」');
    expect(noFinal.code.endsWith('\n')).toBe(false);
  });

  it('options.eol 可强制输出 EOL（M7.3 编码/EOL 保留的显式覆盖口）', () => {
    const result = migrateOk('角色: 灵梦\n时机 指令 310：\n    「a」\n', { eol: '\r\n' });
    expect(result.code).toBe('# 机 指令 310\r\n灵梦：「a」\r\n');
  });

  it('条件链重叠 warning：同文条件重复 / 恒真条件后面还有分支（可证的才报）', () => {
    const src =
      '角色: 灵梦\n时机 指令 310：\n' +
      '    如果 恋慕 >= 500：\n        「a」\n' +
      '    否则如果 恋慕 >= 500：\n        「b」\n' +
      '    否则：\n        「c」\n';
    const result = migrateOk(src);
    const warnings = result.diagnostics.filter((d) => d.severity === 'warning' && d.code === 'core/migration/if');
    expect(warnings.length).toBe(1);
    const trueChain = migrateOk(
      '角色: 灵梦\n时机 指令 310：\n    如果 真：\n        「a」\n    否则：\n        「b」\n',
    );
    expect(
      trueChain.diagnostics.filter((d) => d.severity === 'warning' && d.code === 'core/migration/if').length,
    ).toBe(1);
  });
});

/* ============================== 不可机械迁移：台账 ============================== */

describe('不可机械迁移：ok=false + 台账 + 原块不写', () => {
  function blocked(src: string): MigrateResult {
    const result = migrateKojoSource(src);
    expect(result.ok).toBe(false);
    return result;
  }

  it('fixture：全部不可迁移构造 → 码 / 行号 / 原块逐字保留 / 可迁移行仍被迁移', () => {
    const result = blocked(fixture('unsupported.kojo.txt'));
    const codes = result.unsupported.map((u) => [u.line, u.code]);
    expect(codes).toEqual([
      [2, 'core/migration/color-option'],
      [3, 'core/migration/alias'],
      [5, 'core/migration/switch'],
      [10, 'core/migration/branch'],
      [15, 'core/migration/ask'],
      [17, 'core/migration/loop'],
      [19, 'core/migration/loop'],
      [20, 'core/migration/raw'],
      [21, 'core/migration/data'],
      [23, 'core/migration/data'],
      [24, 'core/migration/raw'],
      [27, 'core/migration/raw'],
      [28, 'core/migration/hidden-timing'],
    ]);
    // 每个台账项都有 error 诊断（失败可见）
    expect(result.diagnostics.filter((d) => d.severity === 'error').length).toBe(result.unsupported.length);
    // 原块逐字保留（`当` 块连块头带两个分支）
    expect(result.code).toContain('    当 TFLAG:1：\n        是 0：\n            「甲」\n        否则：\n            「乙」\n');
    expect(result.code).toContain('    分支：\n        [条件]\n            「丙」\n        [其他]\n            「丁」\n');
    // 能迁移的行照样迁移（不是"一错全停"）
    expect(result.code).toContain('# 机 指令 310\n');
    expect(result.code).toContain('@标 主菜单\n@跳 主菜单\n');
    expect(result.code).toContain('! 早安()\n@返 1\n');
  });

  it('裸台词缺说话人 → core/narrative/bare-quote', () => {
    const result = blocked('时机 指令 310：\n    「你好。」\n');
    expect(result.unsupported).toEqual([
      {
        line: 2,
        construct: '裸台词（缺说话人）',
        targetHint: expect.stringContaining('角色'),
        code: 'core/narrative/bare-quote',
      },
    ]);
  });

  it('裸引号未闭合 / 引号后还有正文 → unsupported（不猜）', () => {
    const unclosed = blocked('角色: 灵梦\n时机 指令 310：\n    「你好\n');
    expect(unclosed.unsupported[0]!.code).toBe('core/narrative/bare-quote');
    const tail = blocked('角色: 灵梦\n时机 指令 310：\n    「你好」剩下\n');
    expect(tail.unsupported[0]!.code).toBe('core/migration/raw');
  });

  it('多 `时机` 块 → 每个块 unsupported，提示拆文件（一个文件一个 `# 机`）', () => {
    const src = '角色: 灵梦\n时机 指令 310：\n    「a」\n时机 事件 100：\n    「b」\n';
    const result = blocked(src);
    expect(result.unsupported.map((u) => [u.line, u.code])).toEqual([
      [2, 'core/migration/timing'],
      [4, 'core/migration/timing'],
    ]);
    expect(result.code).toBe('时机 指令 310：\n    「a」\n时机 事件 100：\n    「b」\n');
  });

  it('`时机` 头带命名参数（`成否:` 等）→ unsupported（搬到 adapter 事件配置）', () => {
    const result = blocked('角色: 灵梦\n时机 指令 310 成否: 游戏判定：\n    「a」\n');
    expect(result.unsupported[0]!.code).toBe('core/migration/timing');
    expect(result.code).toContain('时机 指令 310 成否: 游戏判定：\n');
  });

  it('赋值 / 裸表达式 → unsupported（2.0 要进 `@算`）', () => {
    const result = blocked('角色: 灵梦\n时机 指令 310：\n    她的心情 = 1\n');
    expect(result.unsupported[0]!.code).toBe('core/migration/raw');
    expect(result.code).toBe(MACHINE + '    她的心情 = 1\n');
  });

  it('`循环` / `数据表` / `菜单` / `设置标记` / `常量` / 原生行 / 源折行 → 各自码', () => {
    const cases: [string, string][] = [
      ['角色: 灵梦\n时机 指令 310：\n    循环 3 次：\n        「a」\n    循环结束\n', 'core/migration/loop'],
      ['角色: 灵梦\n时机 指令 310：\n    数据表：\n        条目 甲\n    数据表结束\n', 'core/migration/data'],
      ['角色: 灵梦\n时机 指令 310：\n    菜单：\n        「x」：\n            「y」\n', 'core/migration/raw'],
      ['角色: 灵梦\n时机 指令 310：\n    设置标记 FLAG:1, 0\n', 'core/migration/raw'],
      ['常量 亲近线 = 500\n角色: 灵梦\n', 'core/migration/raw'],
      ['角色: 灵梦\n时机 指令 310：\n    SETCOLOR 0xFF0000\n', 'core/migration/raw'],
      ['角色: 灵梦\n时机 指令 310：\n    她点了点头。\\\n', 'core/migration/raw'],
    ];
    for (const [src, code] of cases) {
      const result = blocked(src);
      expect(result.unsupported.map((u) => u.code), src).toContain(code);
    }
  });

  it('`当 / 是`、`分支`、`初回`、`别名`、`旁白色` 各自码（与编译器 §12.1 码表同源）', () => {
    const result = blocked(
      '角色: 12\n旁白色: 作者色\n别名 好感 = CFLAG:1\n时机 指令 310：\n    当 TFLAG:1：\n        是 0：\n            「a」\n',
    );
    expect(result.unsupported.map((u) => u.code)).toEqual([
      'core/migration/color-option',
      'core/migration/alias',
      'core/migration/switch',
    ]);
  });

  it('全角等号 `＝` → unsupported（v1 在编译期也报 fullwidth-expr-punct，不把它当旁白打印）', () => {
    const result = blocked('角色: 灵梦\n时机 指令 310：\n    她的心情 ＝ 1\n');
    expect(result.unsupported[0]!.code).toBe('core/migration/fullwidth-punct');
    expect(result.code).toContain('    她的心情 ＝ 1\n');
  });

  it('`异常 / 未接线的 # 行` → 保守 unsupported（不猜）', () => {
    const result = blocked('#幕 测试\n');
    expect(result.unsupported[0]!.code).toBe('core/lex/anchor');
  });

  it('summarizeMigration 读数（ok / 台账数 / 首个阻断行）', () => {
    const result = migrateKojoSource('角色: 灵梦\n时机 指令 310：\n    她的心情 = 1\n');
    expect(summarizeMigration(result)).toEqual({
      ok: false,
      unsupportedCount: 1,
      warningCount: 0,
      errorCount: 1,
      firstBlockedLine: 3,
    });
    const good = migrateKojoSource('角色: 灵梦\n时机 指令 310：\n    「a」\n');
    expect(summarizeMigration(good)).toMatchObject({ ok: true, unsupportedCount: 0, firstBlockedLine: null });
  });
});

/* ============================== 源映射 / 幂等 ============================== */

describe('sourceMap（新行 → 旧行）与幂等', () => {
  it('一行对一行时映射逐行相等；块头生成的 2.0 行回源到 v1 块头', () => {
    const src = '角色: 灵梦\n时机 指令 310：\n    「a」\n';
    const result = migrateOk(src);
    // 新行 1 = `# 机` ← 旧行 2（时机块头）；新行 2 = 台词 ← 旧行 3
    expect(result.code.split('\n').slice(0, -1)).toEqual(['# 机 指令 310', '灵梦：「a」']);
    expect(result.sourceMap).toEqual([2, 3]);
  });

  it('多行产物（`@原生` / 行内随机 / 行内体）每行都回源到同一条 v1 行', () => {
    const dim = migrateOk('#DIM a, 0\n#DIM b, 1\n');
    expect(dim.sourceMap).toEqual([1, 1, 2]);
    const inlineRandom = migrateOk('角色: 灵梦\n时机 指令 310：\n    随机 「甲。」,「乙。」\n');
    expect(inlineRandom.sourceMap).toEqual([2, 3, 3, 3]);
  });

  it('生产 fixture 的映射：每个序号都在 1..旧行数内，且台词/旁白行回源到自己的 v1 行', () => {
    const src = fixture('mechanical.kojo.txt');
    const result = migrateOk(src);
    const oldLineCount = src.split('\n').length - 1;
    expect(result.sourceMap.length).toBe(result.code.split('\n').length - 1);
    for (const oldLine of result.sourceMap) {
      expect(oldLine).toBeGreaterThanOrEqual(1);
      expect(oldLine).toBeLessThanOrEqual(oldLineCount);
    }
    // 台词行 `灵梦：「你好。」 续` 回源到 v1 的 `「你好。」 ~`
    const line = result.code.split('\n').indexOf('    灵梦：「你好。」 续') + 1;
    expect(result.sourceMap[line - 1]).toBe(10);
  });

  it('幂等：无 unsupported 的结果再迁移逐字节不变（含 CRLF）', () => {
    const cases = [
      '角色: 灵梦\n时机 指令 310：\n    「甲」 ~\n    她笑了。\n',
      '\uFEFF角色: 灵梦\r\n时机 指令 310：\r\n    着色 0xFF8080：\r\n        红色旁白。\r\n',
      '角色: 灵梦\n函数 f(a)：\n    调用 g()\n    返回 a\n',
    ];
    for (const src of cases) {
      const once = migrateOk(src);
      const twice = migrateKojoSource(once.code);
      expect(twice.ok, src).toBe(true);
      expect(twice.code, src).toBe(once.code);
    }
  });
});
