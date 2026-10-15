/**
 * B3 · 条件（行内三元）别名 —— 一次声明、多处复用。
 *
 * 证据：真实语料大量手抄 `\@TALENT:恋人 ? …\@` 行内三元（全语料 1489 处）。
 * 糖里应当能 `别名 X = 条件 ? "真" : "假"` 声明一次，引用处展开成同款行内条件。
 *
 * 契约与产物**逐字节对齐既有 `{}` 行内条件**（规范 §3.4）：`{条件 ? "真" : "假"}`
 * 降成 `\@条件?真#假\@`，故条件别名也降成同一形态（省略假分支 → `\@条件?真\@`）。
 */

import { describe, expect, it } from 'vitest';
import type { AliasValue, KojoFaceTable } from '@kojo/plugin-api';
import { aliasValueToExpression, lowerExpression, type ExprContext } from '../src/expression';
import { createSugarTranspileService } from '../src/service';
import type { AliasEntry } from '../src/types';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() as KojoFaceTable });
const t = (src: string) => svc().transpile(src);
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

/** 声明一个条件别名 + 指令体，凑成可转译的最小源 */
const withCondAlias = (decl: string, bodyLine: string) => `角色: 12\n${decl}\n时机 指令 310：\n    ${bodyLine}\n`;

/** 最小降糖上下文（别名表由调用方给） */
function ctx(aliases: ReadonlyMap<string, AliasEntry>): ExprContext {
  return { aliases, dictionary: stubDict, report: () => {}, loc: null };
}

/** 构造别名表条目 */
const entry = (value: AliasValue): AliasEntry => ({
  value,
  readonly: value.kind !== 'variable',
  line: 1,
});

const COND: AliasValue = { kind: 'conditional', cond: '她的恋慕', thenText: '只有你', elseText: '别靠太近' };
const COND_NO_ELSE: AliasValue = { kind: 'conditional', cond: '她的恋慕', thenText: '脸红' };

/* ============================================================================ */
/* ① 表达式位置 → 行内条件 `\@…\@`                                              */
/* ============================================================================ */

describe('B3 · 条件别名在表达式位置展开成行内条件', () => {
  it('aliasValueToExpression（无条件上下文）产出 `\\@条件?真#假\\@`', () => {
    expect(aliasValueToExpression(COND)).toBe('\\@她的恋慕?只有你#别靠太近\\@');
  });

  it('省略假分支 → `\\@条件?真\\@`（与 `{条件 ? "真"}` 同款）', () => {
    expect(aliasValueToExpression(COND_NO_ELSE)).toBe('\\@她的恋慕?脸红\\@');
  });

  it('lowerExpression 端到端：条件降糖 + 分支字面量原样', () => {
    const aliases = new Map([['恋语', entry(COND)]]);
    expect(lowerExpression('恋语', ctx(aliases))).toBe('\\@TALENT:TARGET:恋慕?只有你#别靠太近\\@');
  });

  it('分支是字面量片段：`你` / `她的X` 不被后续代词·属性降糖波及', () => {
    // 若分支随本层产物流过代词降糖：`你，` 会被改写成 `%CALLNAME:MASTER%`，
    // `她的耳朵` 会被改写成 `TALENT:TARGET:耳朵`——正是 expandFragment 那条回归的口径。
    const aliases = new Map([
      ['恋语', entry({ kind: 'conditional', cond: '她的恋慕', thenText: '你，别靠太近', elseText: '她的耳朵红了' })],
    ]);
    expect(lowerExpression('恋语', ctx(aliases))).toBe('\\@TALENT:TARGET:恋慕?你，别靠太近#她的耳朵红了\\@');
  });

  it('条件里的别名 / 属性照常降糖（条件走 lowerExpression）', () => {
    const aliases = new Map([
      ['基准', entry({ kind: 'number', text: '500' })],
      ['恋语', entry({ kind: 'conditional', cond: '基准', thenText: '靠得住', elseText: '还早' })],
    ]);
    expect(lowerExpression('恋语', ctx(aliases))).toBe('\\@500?靠得住#还早\\@');
  });

  it('自引用条件别名（`别名 A = A ? …`）不无限递归', () => {
    const aliases = new Map([
      ['A', entry({ kind: 'conditional', cond: 'A', thenText: 'x', elseText: 'y' })],
    ]);
    // 环检测栈在**内层**对 `A` 停手（不再展开）⇒ 产物有界：条件位置留原样 `A`。
    expect(lowerExpression('A', ctx(aliases))).toBe('\\@A?x#y\\@');
  });
});

/* ============================================================================ */
/* ② 文本行插值里的表现                                                          */
/* ============================================================================ */

describe('B3 · 条件别名在文本插值里的表现', () => {
  it('`{恋语}` → 展开成行内条件原样落进 FORM（不包 `{}` / `%…%`）', () => {
    const { erb, diagnostics } = t(withCondAlias('别名 恋语 = 她的恋慕 ? "只有你" : "别靠太近"', '「{恋语}」'));
    expect(erb).toContain('「\\@TALENT:TARGET:恋慕?只有你#别靠太近\\@」');
    expect(erb).not.toContain('{\\@');
    expect(erb).not.toContain('{恋语}');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('与手写 `{条件 ? "真" : "假"}` 产物**逐字节一致**', () => {
    const aliased = t(withCondAlias('别名 恋语 = 她的恋慕 ? "只有你" : "别靠太近"', '「{恋语}」')).erb;
    const inline = t('角色: 12\n时机 指令 310：\n    「{她的恋慕 ? "只有你" : "别靠太近"}」\n').erb;
    const grab = (erb: string) => /「(\\@[^」]*)」/.exec(erb)?.[1];
    expect(grab(aliased)).toBe(grab(inline));
    expect(grab(aliased)).toBe('\\@TALENT:TARGET:恋慕?只有你#别靠太近\\@');
  });

  it('省略假分支 → `\\@条件?真\\@`', () => {
    const { erb } = t(withCondAlias('别名 恋语 = 她的恋慕 ? "脸红"', '「嗯…{恋语}」'));
    expect(erb).toContain('「嗯…\\@TALENT:TARGET:恋慕?脸红\\@」');
  });

  it('分支内的原生 `%…%` 引用照常降糖（与真实语料写法一致）', () => {
    const { erb } = t(
      withCondAlias('别名 恋语 = 她的恋慕 ? "只有%CALLNAME:MASTER%" : "别靠太近"', '「{恋语}」'),
    );
    expect(erb).toContain('\\@TALENT:TARGET:恋慕?只有%CALLNAME:MASTER%#别靠太近\\@');
  });

  it('`%…%` 在糖文本里是**原生直通**、不是插值槽 ⇒ `%恋语%` 不展开', () => {
    const { erb } = t(withCondAlias('别名 恋语 = 她的恋慕 ? "只有你" : "别靠太近"', '「%恋语%」'));
    expect(erb).toContain('「%恋语%」');
    expect(erb).not.toContain('\\@TALENT');
  });

  it('多行复用同一条件别名（一次声明、多处复用）', () => {
    const { erb } = t(
      '角色: 12\n别名 恋语 = 她的恋慕 ? "只有你" : "别靠太近"\n时机 指令 310：\n    「{恋语}…{恋语}。」\n',
    );
    expect(erb.match(/\\@TALENT:TARGET:恋慕\?只有你#别靠太近\\@/g)).toHaveLength(2);
  });
});

/* ============================================================================ */
/* ③ 只读性                                                                      */
/* ============================================================================ */

describe('B3 · 条件别名是只读的', () => {
  it('作赋值左值 → 既有 `readonly-alias-assignment`', () => {
    const src = '角色: 12\n别名 恋语 = 她的恋慕 ? "只有你" : "别靠太近"\n时机 指令 310：\n    恋语 = 1\n';
    expect(codes(src)).toContain('readonly-alias-assignment');
  });

  it('`isReadonlyAlias` / `isWritableAlias` 口径（契约只读真源）', () => {
    const e = entry(COND);
    expect(e.readonly).toBe(true);
  });
});

/* ============================================================================ */
/* ④ 既有四形态回归                                                              */
/* ============================================================================ */

describe('B3 · 既有四形态回归（条件形态 additive，不动旧形态）', () => {
  it('变量别名 → 目标变量引用原文', () => {
    const aliases = new Map([['基准', entry({ kind: 'variable', text: 'CFLAG:TARGET:1088' })]]);
    expect(lowerExpression('基准', ctx(aliases))).toBe('CFLAG:TARGET:1088');
  });

  it('角色别名 → `%CALLNAME:N%`（插值内不包 `{}`）', () => {
    const { erb } = t('角色: 12\n别名 朋友 = 角色 15\n时机 指令 310：\n    「{朋友}来了」\n');
    expect(erb).toContain('「%CALLNAME:15%来了」');
  });

  it('数字 / 字符串字面量别名照旧（字符串在插值里展开为裸文本）', () => {
    expect(lowerExpression('平静', ctx(new Map([['平静', entry({ kind: 'number', text: '0' })]])))).toBe('0');
    const { erb } = t('角色: 12\n别名 昵称 = "小露"\n时机 指令 310：\n    「{昵称}」\n');
    expect(erb).toContain('「小露」');
    expect(erb).not.toContain('{"小露"}');
  });
});

/* ============================================================================ */
/* ⑤ 残缺形态 → 复用 `alias-unknown-target`（不新增诊断码）                       */
/* ============================================================================ */

describe('B3 · 条件右值残缺 → alias-unknown-target（不新增诊断码）', () => {
  it('顶层 `?` 但缺真分支', () => {
    expect(codes('角色: 12\n别名 恋语 = 她的恋慕 ?\n时机 指令 310：\n    「…」\n')).toContain(
      'alias-unknown-target',
    );
  });

  it('顶层 `?` 但缺条件', () => {
    expect(codes('角色: 12\n别名 恋语 = ? "只有你"\n时机 指令 310：\n    「…」\n')).toContain(
      'alias-unknown-target',
    );
  });

  it('`?` 在字符串字面量内 ⇒ 仍是字符串形态，不误判为条件', () => {
    const { erb, diagnostics } = t('角色: 12\n别名 台词 = "真的?"\n时机 指令 310：\n    「{台词}」\n');
    expect(erb).toContain('「真的?」');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
