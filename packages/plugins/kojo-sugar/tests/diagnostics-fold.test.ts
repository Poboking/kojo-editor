/**
 * K2-PRE-REUSE ④：诊断列**折回物理行**（§10.7 / §4.13 坐标口径）。
 *
 * 缺陷形态：词法/语法/降糖层手里的列是**逻辑坐标**（折行合并后的行内偏移，且常忘了
 * 加行首缩进）。作者在编辑器里点诊断，位置落在**首物理行**的错误列上——折行续接行、
 * CRLF 文件、CJK / emoji 前后的错误全都指歪；越界时甚至回落到首行起点。
 *
 * 修法：生产端一律报**逻辑全文坐标**（含缩进 / 心形标记），出口由
 * `column-map.ts::foldPositionToPhysical` **一次**折回物理行列（唯一入口，口径写死）：
 * - 1 基行列、列按 UTF-16 码元（emoji = 2）；
 * - 越界夹取：列 < 1 → 行首；列越过逻辑全文 → 末段末尾（不抛错、不回落到首行）；
 * - 非逻辑行首（续接物理行）/ 未折行 → 原样返回（幂等）。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { foldPositionToPhysical } from '../src/column-map';
import { sourceLineViews } from '../src/lexer';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 指定码的第一条诊断（loc 必须是物理行列） */
const locOf = (src: string, code: string) => t(src).diagnostics.find((d) => d.code === code)?.loc ?? null;

const HEAD = '角色: 12\n时机 指令 310：\n';

/* ============================================================================ */
/* A. 折行台词：错误落在**续接的那条物理行**上                                      */
/* ============================================================================ */

describe('④ 折行台词 · 诊断列折回物理行', () => {
  it('折行后的未闭合插值 `{` → 落在第二物理行（不是首行）', () => {
    const src = HEAD + '    心形 「甲\\\n        {乙」\n';
    // 逻辑行 = `    心形 「甲{乙」`（`\` 与续接缩进被折叠）；物理上 `{` 在第 4 行第 9 列
    expect(locOf(src, 'interpolation-unclosed')).toEqual({ line: 4, column: 9 });
  });

  it('CRLF 文件同一判据（`\\r` 不参与列、行号按物理行）', () => {
    const src = HEAD.replace(/\n/g, '\r\n') + '    心形 「甲\\\r\n        {乙」\r\n';
    expect(locOf(src, 'interpolation-unclosed')).toEqual({ line: 4, column: 9 });
  });

  it('CJK 前的插值错误：列按 UTF-16 码元、落在续接行的物理列', () => {
    const src = HEAD + '    心形 「甲\\\n        「乙」{丙」\n';
    // 续接行 = `        「乙」{丙」`：8 空格 + 「 乙 」 = 11 码元 → `{` 在第 12 列
    expect(locOf(src, 'interpolation-unclosed')).toEqual({ line: 4, column: 12 });
  });

  it('emoji（代理对 = 2 码元）之后的错误列不被码点口径算短', () => {
    const src = HEAD + '    心形 「甲\\\n        😀{乙」\n';
    // 8 空格 + 😀(2) → `{` 在第 11 列（码点口径会给 10）
    expect(locOf(src, 'interpolation-unclosed')).toEqual({ line: 4, column: 11 });
  });

  it('折行台词里的插值表达式错误（unknown-identifier）也落在续接行', () => {
    const src = HEAD + '    心形 「甲\\\n        {不认识的名字}」\n';
    expect(locOf(src, 'unknown-identifier')).toEqual({ line: 4, column: 9 });
  });

  it('`续` 写在引号内：非折行时列也含行首缩进（旧实现漏了缩进）', () => {
    const src = HEAD + '    心形 「…… 续」\n';
    // 体从第 8 列起（4 缩进 + `心形 ` 3 + 1），匹配起于 `「`
    expect(locOf(src, 'cont-inside-quotes')).toEqual({ line: 3, column: 8 });
  });
});

/* ============================================================================ */
/* B. 原生块（旧后端 = `@` 透传块 / 停用区）：诊断只落在**块首物理行**              */
/* ============================================================================ */

describe('④ 原生块 · 折行不挪诊断行号', () => {
  it('折行把两行合成一行后，紧随的 `[SKIPSTART]` 仍按**物理行**定位', () => {
    const src =
      '角色: 12\n' +
      '时机 指令 310\\\n' + // 2–3 行折成一条逻辑行
      '    ：\n' +
      '    「甲」\n' +
      '[SKIPSTART]\n' + // 物理第 5 行
      '; 死区正文\n';
    expect(locOf(src, 'unclosed-block')).toEqual({ line: 5, column: 1 });
  });

  it('`@` 原生块整块透传、块内**不产**糖诊断（块体不解释 ⇒ 不可能有块内错误位置）', () => {
    const src = '角色: 12\n@M_KOJO_K12_310\n\t; 注释在块里也是正文\n\t#DIM X\n';
    const r = t(src);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.erb).toContain('#DIM X');
  });
});

/* ============================================================================ */
/* C. 折回入口本身：越界夹取口径写死（单测，不经过转译）                            */
/* ============================================================================ */

describe('④ foldPositionToPhysical · 越界夹取口径', () => {
  /** 源：`甲 \` + 换行 + `   乙`（逻辑行 = `甲 乙`，第 2 段在第 2 行第 4 列起） */
  const views = sourceLineViews('甲 \\\n   乙');
  const fold = (line: number, column: number) => foldPositionToPhysical(views, { line, column });

  it('段内逐码元平移（首段 / 续接段各自落自己的物理行列）', () => {
    expect(fold(1, 1)).toEqual({ line: 1, column: 1 });
    expect(fold(1, 2)).toEqual({ line: 1, column: 2 });
    expect(fold(1, 3)).toEqual({ line: 2, column: 4 }); // 第 2 段首字符（续接 3 空格后）
  });

  it('列越界 → 夹到末段末尾（不抛错、不回落到首行起点）', () => {
    expect(fold(1, 9999)).toEqual({ line: 2, column: 5 });
  });

  it('列 < 1（0 / 负数）→ 夹到行首', () => {
    expect(fold(1, 0)).toEqual({ line: 1, column: 1 });
    expect(fold(1, -5)).toEqual({ line: 1, column: 1 });
  });

  it('未折行 / 不是逻辑行首（续接物理行）⇒ 原样返回（幂等）', () => {
    const flat = sourceLineViews('单行');
    expect(foldPositionToPhysical(flat, { line: 1, column: 7 })).toEqual({ line: 1, column: 7 });
    // 第 2 行是续接行，没有自己的逻辑行视图 ⇒ 不猜，原样
    expect(fold(2, 4)).toEqual({ line: 2, column: 4 });
    // 已折过的物理位置再折一次不变（幂等）
    const once = fold(1, 3)!;
    expect(foldPositionToPhysical(views, once)).toEqual(once);
  });
});
