/**
 * v1.9 P0 · 结构三件（A 声明族直通 / B 行连接块 / C 预处理条件块）。
 *
 * 三条硬缺口（改前）：
 * 1. `#FUNCTION` 一族 8 枚 ⇒ `#` 起手且非 `#DIM` 族 ⇒ **兜底成台词**；
 * 2. `{` / `}` 行连接 ⇒ 无写层分支 ⇒ 兜底成台词；
 * 3. `[IF <宏>]` / `[ELSEIF <宏>]` ⇒ 被 `matchRuleTag` 当规则池标签（误报
 *    `rule-pool-branch-outside-pool` 且阻止编译）；`[ELSE]` / `[ENDIF]` / `[IF_DEBUG]` /
 *    `[IF_NDEBUG]` ⇒ 纯大写被标签判据排除 ⇒ 兜底成台词。
 *
 * 本文件把三类都按"产物逐字节 / 诊断零误报 / 失败形态 fail-closed"钉住；诊断码只用既有集合
 * （`unclosed-block` / `statement-shape`），不新增。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { compileToBytes } from '../src/compile';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
/** 文档骨架：正文挂在 `时机 指令 310：` 之下（第 3 行起） */
const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}`;
const transpile = (src: string) => svc().transpile(src);

/** 断言某段产物里"该行原样出现、且没有被打成台词" */
function expectRawLine(erb: string, line: string): void {
  expect(erb.split('\n').some((l) => l.trim() === line), `产物里应有原生行 ${line}`).toBe(true);
  expect(erb).not.toContain(`PRINTFORMW ${line}`);
}

/* ============================== P0-A · `#` 声明族直通 ============================== */

describe('P0-A · # 声明族 8 枚（闭集直通）', () => {
  const eight = [
    '#FUNCTION',
    '#FUNCTIONS',
    '#GLOBAL 100',
    '#LOCALSIZE 20',
    '#LOCALSSIZE 30',
    '#SFUNCTION',
    '#XFUNCTION',
    '#TESTMEMORY',
  ];

  for (const line of eight) {
    it(`「${line}」逐字节透传，不再是台词`, () => {
      const r = transpile(doc(`    ${line}\n`));
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
      expectRawLine(r.erb, line);
    });
  }

  it('#DIM 族既有直通不受影响（回归）', () => {
    const r = transpile(doc('    #DIM 好感度, 10\n'));
    expectRawLine(r.erb, '#DIM 好感度, 10');
  });

  it('`# 注释` 不被泛化吃掉——仍是台词（闭集，不做 /^#\\w/）', () => {
    const r = transpile(doc('    # 这不是声明\n'));
    expect(r.erb).toContain('PRINTFORMD');
    expect(r.erb).toContain('# 这不是声明');
  });
});

/* ============================== P0-B · 行连接块 ============================== */

describe('P0-B · 行连接块（`{` / `}` 与两枚中文词）', () => {
  it('糖形：两枚中文词 → 整行 `{` / `}`（与其它语句同层），块体逐行原文', () => {
    const r = transpile(
      doc(
        '    多行语句开始\n' +
          '    PRINTFORM 这是一条很长的\n' +
          '        需要拆成多行写的语句\n' +
          '    多行语句结束\n',
      ),
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const lines = r.erb.split('\n');
    // 糖形的两枚标记按当前层级发射（块体在时机体内 = 1 级 ⇒ TAB）
    expect(lines).toContain('\t{');
    expect(lines).toContain('\t}');
    expect(lines).toContain('    PRINTFORM 这是一条很长的');
    expect(lines).toContain('        需要拆成多行写的语句');
    expect(r.erb).not.toContain('多行语句开始');
    expect(r.erb).not.toContain('多行语句结束');
  });

  it('原生：整行 `{` / `}` 逐字节透传（含缩进）', () => {
    const r = transpile(doc('    {\n    PRINTFORM A\n    }\n'));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const lines = r.erb.split('\n');
    expect(lines).toContain('    {');
    expect(lines).toContain('    PRINTFORM A');
    expect(lines).toContain('    }');
  });

  it('未收束 ⇒ unclosed-block warning，且一行不丢、不凭空补 `}`', () => {
    const r = transpile(doc('    多行语句开始\n    PRINTFORM A\n'));
    expect(r.diagnostics.some((d) => d.code === 'unclosed-block')).toBe(true);
    expect(r.erb).toContain('PRINTFORM A');
    // fail-closed：没等到收束词就不许发射闭标记（半块比没有更坏）
    expect(r.erb.split('\n').some((l) => l.trim() === '}')).toBe(false);
  });

  it('嵌套 ⇒ statement-shape error（引擎无嵌套语义）', () => {
    const r = transpile(doc('    多行语句开始\n        多行语句开始\n        多行语句结束\n    多行语句结束\n'));
    expect(r.diagnostics.some((d) => d.code === 'statement-shape' && d.severity === 'error')).toBe(true);
  });

  it('落单 `多行语句结束` ⇒ statement-shape error', () => {
    const r = transpile(doc('    多行语句结束\n'));
    expect(r.diagnostics.some((d) => d.code === 'statement-shape' && d.severity === 'error')).toBe(true);
  });
});

/* ============================== P0-C · 预处理条件块 ============================== */

describe('P0-C · 预处理条件块（糖形）', () => {
  it('五枚块头 + 收束 → `[IF …]` 族标记', () => {
    const r = transpile(
      doc(
        '    预处理 如果 恋慕开关：\n' +
          '        「甲」\n' +
          '    预处理 否则如果 嫉妒开关：\n' +
          '        「乙」\n' +
          '    预处理 否则：\n' +
          '        「丙」\n' +
          '    预处理结束\n',
      ),
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(r.erb.split('\n').map((l) => l.trim())).toEqual(
      expect.arrayContaining(['[IF 恋慕开关]', '[ELSEIF 嫉妒开关]', '[ELSE]', '[ENDIF]']),
    );
    // 标记行必须整行严格等值：不得在行尾追加注释 / 条件
    for (const line of r.erb.split('\n')) {
      const t = line.trim();
      if (t.startsWith('[IF ') || t.startsWith('[ELSEIF ')) continue;
      expect(t).not.toMatch(/^\[(IF|ELSEIF|ELSE|ENDIF)\].*;/);
    }
  });

  it('调试 / 非调试二形 → `[IF_DEBUG]` / `[IF_NDEBUG]`（共用 `预处理结束`）', () => {
    const r = transpile(
      doc(
        '    预处理 调试：\n        「甲」\n    预处理结束\n' +
          '    预处理 非调试：\n        「乙」\n    预处理结束\n',
      ),
    );
    const lines = r.erb.split('\n').map((l) => l.trim());
    expect(lines).toEqual(expect.arrayContaining(['[IF_DEBUG]', '[IF_NDEBUG]', '[ENDIF]']));
    expect(lines.filter((l) => l === '[ENDIF]')).toHaveLength(2);
  });

  it('可嵌套：内层 `预处理 如果 …：` 落在外层块体内', () => {
    const r = transpile(
      doc(
        '    预处理 如果 A：\n' +
          '        预处理 如果 B：\n' +
          '            「甲」\n' +
          '        预处理结束\n' +
          '    预处理结束\n',
      ),
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const marks = r.erb.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('['));
    expect(marks).toEqual(['[IF A]', '[IF B]', '[ENDIF]', '[ENDIF]']);
  });

  it('空宏名 / 表达式宏名 ⇒ statement-shape error（fail-closed，不产半成品）', () => {
    for (const bad of ['预处理 如果：', '预处理 如果 A + B：']) {
      const r = transpile(doc(`    ${bad}\n        「甲」\n`));
      expect(r.diagnostics.some((d) => d.code === 'statement-shape' && d.severity === 'error'), bad).toBe(true);
      expect(() => compileToBytes(svc().transpile, doc(`    ${bad}\n        「甲」\n`))).toThrow(/编译被拒绝/);
    }
  });

  it('子词不在闭集 ⇒ 按台词处理（`预处理 一下：` 不被误读成指令）', () => {
    const r = transpile(doc('    预处理 一下：\n'));
    expect(r.diagnostics.filter((d) => d.code === 'statement-shape')).toHaveLength(0);
    expect(r.erb).toContain('PRINTFORM');
  });

  it('未收束 ⇒ unclosed-block warning', () => {
    const r = transpile(doc('    预处理 如果 A：\n        「甲」\n'));
    expect(r.diagnostics.some((d) => d.code === 'unclosed-block')).toBe(true);
  });

  it('`否则：` 之后再接分支 ⇒ statement-shape error', () => {
    const r = transpile(
      doc('    预处理 如果 A：\n        「甲」\n    预处理 否则：\n        「乙」\n    预处理 否则如果 B：\n        「丙」\n    预处理结束\n'),
    );
    expect(r.diagnostics.some((d) => d.code === 'statement-shape' && d.severity === 'error')).toBe(true);
  });
});

describe('P0-C · 原生预处理标记（strict-equality 直通，先于 matchRuleTag）', () => {
  // 原生标记是**透传**构造，缩进只是排版（引擎判整行等值）；`.kojo` 里正文与标记同缩进即可。
  it('`[IF <宏>]` 不再被误诊为规则池标签，逐字节透传', () => {
    const r = transpile(doc('    [IF 恋慕开关]\n    「甲」\n    [ENDIF]\n'));
    // 规则池标签判定曾把 `[IF <宏>]` 吃成 `rule-pool-branch-outside-pool`；码是本地声明
    // （契约闭集暂未收录，见 `parser.ts::reportRulePool`），故按字符串比而不是类型比。
    expect(r.diagnostics.filter((d) => String(d.code) === 'rule-pool-branch-outside-pool')).toHaveLength(0);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    const lines = r.erb.split('\n').map((l) => l.trim());
    expect(lines).toEqual(expect.arrayContaining(['[IF 恋慕开关]', '[ENDIF]']));
  });

  it('`[ELSE]` / `[ELSEIF <宏>]` / `[IF_DEBUG]` / `[IF_NDEBUG]` 都不落台词', () => {
    const r = transpile(
      doc('    [IF_DEBUG]\n    「甲」\n    [ELSE]\n    「乙」\n    [ENDIF]\n    [IF_NDEBUG]\n    「丙」\n    [ENDIF]\n'),
    );
    const lines = r.erb.split('\n').map((l) => l.trim());
    expect(lines).toEqual(expect.arrayContaining(['[IF_DEBUG]', '[ELSE]', '[IF_NDEBUG]', '[ENDIF]']));
    expect(r.erb).not.toContain('PRINTFORMW [');
  });

  it('原生落单 `[ENDIF]` ⇒ statement-shape error', () => {
    const r = transpile(doc('    [ENDIF]\n'));
    expect(r.diagnostics.some((d) => d.code === 'statement-shape' && d.severity === 'error')).toBe(true);
  });

  it('原生未收束 ⇒ unclosed-block warning', () => {
    const r = transpile(doc('    [IF A]\n    「甲」\n'));
    expect(r.diagnostics.some((d) => d.code === 'unclosed-block')).toBe(true);
  });
});
