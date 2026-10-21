/**
 * K2-PRE-REUSE 剩余项 ①：`@` 原生块 / `[SKIPSTART]` 死区的**逐字节透传**。
 *
 * 缺陷形态（探针实测）：`readRawFunctionBlock` / `readSkipBlock` 取的是**逻辑行**
 * `line.text` —— 块内行尾 `\` 会把下一物理行折进来，同时**丢掉 `\` 与续行缩进**：
 *
 * ```kojo
 * @M_KOJO_K12_310
 * A = 1 \
 *     B = 2
 * ```
 *
 * 产物变成 `A = 1 B = 2`（字节级丢字符，零诊断）。这条块语义是"引擎不编译、
 * 转译器一个字节都不许解释"，任何折行归一都是改内容。
 *
 * 修法：块体改走**物理行视图**（`Cursor.physicalLinesOf`，与 `splitLogicalLines`
 * 同一份切行真源 `splitPhysicalLines`）；块外仍走逻辑行折行（§3.10），诊断列口径
 * 仍由 `column-map.ts::foldPositionToPhysical` 负责——本文件下半部分是"块外不变"对照。
 */

import { describe, expect, it } from 'vitest';
import type { RawFunctionBlock } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import type { TopNode } from '../src/parser';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 产物按物理行切开（**不去缩进、不丢空行**——本文件的判据就是字节） */
const rows = (erb: string): string[] => erb.split('\n');

const errorsOf = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');

/** 在产物里找一段**连续**的行；命中返回起点下标，否则 -1 */
function indexOfRun(product: readonly string[], run: readonly string[]): number {
  for (let i = 0; i + run.length <= product.length; i++) {
    let hit = true;
    for (let j = 0; j < run.length; j++) {
      if (product[i + j] !== run[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** 字节级读数（小写十六进制；UTF-8 编码，用于 golden / 逐字节比对） */
const hex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

const rawBlocksOf = (src: string): RawFunctionBlock[] =>
  (svc().parse(src).topLevel as unknown as readonly TopNode[]).filter(
    (n): n is RawFunctionBlock => n.kind === 'rawFunctionBlock',
  );

/* ============================================================================ */
/* A. `@` 原生块：折行不许把块体归一                                            */
/* ============================================================================ */

describe('① `@` 原生块 · 块体按物理行逐字节进产物', () => {
  /** 探针原文（缺陷复现用的最小源；无末尾换行） */
  const PROBE = '@M_KOJO_K12_310\nA = 1 \\\n    B = 2';

  it('行尾 `\\` 与续行缩进都保留：三行各自成行，绝不被折成 `A = 1 B = 2`', () => {
    const res = t(PROBE);
    expect(errorsOf(PROBE), `源：\n${PROBE}`).toEqual([]);
    const at = indexOfRun(rows(res.erb), ['@M_KOJO_K12_310', 'A = 1 \\', '    B = 2']);
    expect(at, `产物：\n${res.erb}`).toBeGreaterThanOrEqual(0);
    // 缺陷的字节读数（修复前这里是 `A = 1 B = 2`）
    expect(res.erb).not.toContain('A = 1 B = 2');
    // 源字节一个不少：产物 = 源 + 末尾换行
    expect(res.erb).toBe(`${PROBE}\n`);
  });

  it('字节级 golden：块体 UTF-8 逐字节等于源切片（含 CJK / emoji 代理对）', () => {
    const src = ['@M_KOJO_K12_310', 'A = 1 \\', '    B = 2', 'C = "😀」"'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    // golden = 源 + 产物末尾换行（**硬编码字节**，不是拿输出跟自己比）
    expect(hex(res.erb)).toBe(
      '404d5f4b4f4a4f5f4b31325f3331300a41203d2031205c0a' +
        '2020202042203d20320a43203d2022f09f9880e3808d220a',
    );
    // emoji（U+1F600）在 UTF-8 里是 4 字节 `f0 9f 98 80`，一个字节都不许被改写
    expect(hex(res.erb)).toContain('f09f9880');
  });

  it('块内空行 / 纯空白行一行不丢（空行也是块体字节）', () => {
    const src = ['@M_KOJO_K12_310', 'A = 1 \\', '    B = 2', '', '   ', 'D = 4'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(res.erb).toBe(`${src}\n`);
    expect(indexOfRun(rows(res.erb), ['A = 1 \\', '    B = 2', '', '   ', 'D = 4'])).toBeGreaterThanOrEqual(0);
  });

  it('块内 `;` 注释（含行尾折行）原样透传：不剥注释、不折行', () => {
    const src = ['@M_KOJO_K12_310', '; 注释一 \\', '    继续注释', 'A = 1 ; 行尾注释 \\', '    继续赋值'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(indexOfRun(rows(res.erb), ['; 注释一 \\', '    继续注释', 'A = 1 ; 行尾注释 \\', '    继续赋值'])).toBeGreaterThanOrEqual(0);
  });

  it('CRLF 源：折行与缩进照原样保留，产物里不留 `\\r`', () => {
    const lf = '@M_KOJO_K12_310\nA = 1 \\\n    B = 2';
    const src = lf.replace(/\n/g, '\r\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(res.erb).toBe(`${lf}\n`);
    expect(res.erb.includes('\r')).toBe(false);
  });

  it('块头自身折行（`@NAME(ARG, \\` 续行）同样逐字节保留', () => {
    const src = ['@M_KOJO_K12_310(ARG, \\', '    FLAG:1)', 'A = 1'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(res.erb).toBe(`${src}\n`);
  });

  it('AST：`RawFunctionBlock.lines` 是物理行原文（不是折行后的逻辑行）', () => {
    const src = '@M_KOJO_K12_310\nA = 1 \\\n    B = 2';
    const blocks = rawBlocksOf(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toEqual(['@M_KOJO_K12_310', 'A = 1 \\', '    B = 2']);
    // loc 仍按物理行收尾（末物理行 = 3）
    expect(blocks[0]!.loc.start.line).toBe(1);
    expect(blocks[0]!.loc.end.line).toBe(3);
  });

  it('块尾判定仍在逻辑行上：折行续接的 `@` 行不另开一块（既有边界语义不变）', () => {
    const src = ['@M_KOJO_K12_310', 'A = 1 \\', '@M_KOJO_K12_311', 'B = 2'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    // 物理第 3 行被第 2 行的 `\` 折进同一条逻辑行 ⇒ 不构成块边界；整段仍是一块
    expect(rawBlocksOf(src)).toHaveLength(1);
    expect(rawBlocksOf(src)[0]!.lines).toEqual(['@M_KOJO_K12_310', 'A = 1 \\', '@M_KOJO_K12_311', 'B = 2']);
    expect(res.erb).toBe(`${src}\n`);
  });

  it('块内折行不产任何诊断（零诊断；修复前同样零诊断——这正是"静默丢字节"）', () => {
    expect(t(PROBE).diagnostics).toEqual([]);
  });

  it('块后的糖行照常编译（物理行视图不吞块外内容）', () => {
    const src = ['角色: 1', '时机 指令 1：', '    「台词」', '@M_KOJO_K12_310', 'A = 1 \\', '    B = 2'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(res.erb).toContain('PRINTFORMW 「台词」');
    expect(indexOfRun(rows(res.erb), ['@M_KOJO_K12_310', 'A = 1 \\', '    B = 2'])).toBeGreaterThanOrEqual(0);
  });
});

/* ============================================================================ */
/* B. `[SKIPSTART]` 死区：同一份物理行视图                                      */
/* ============================================================================ */

describe('① `[SKIPSTART]` 死区 · 同一份物理行视图（不写第二份循环）', () => {
  it('死区内行尾 `\\` 与续行缩进逐字节保留', () => {
    const src = ['角色: 1', '[SKIPSTART]', 'A = 1 \\', '    B = 2', '[SKIPEND]', '时机 绝顶：', '    「台词」'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(indexOfRun(rows(res.erb), ['[SKIPSTART]', 'A = 1 \\', '    B = 2', '[SKIPEND]'])).toBeGreaterThanOrEqual(0);
    expect(res.erb).toContain('PRINTFORMW 「台词」');
  });

  it('死区内空行 / CJK / `;` 注释与折行混排：整段连续行原样出现', () => {
    const block = ['[SKIPSTART]', '; 注释 \\', '    续注释', '', '甲 = "乙」" \\', '    丙', '[SKIPEND]'];
    const src = ['角色: 1', ...block, '时机 绝顶：', '    「台词」'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(indexOfRun(rows(res.erb), block)).toBeGreaterThanOrEqual(0);
  });
});

/* ============================================================================ */
/* C. 块外不变对照：折行仍折、诊断列仍折回物理行                                */
/* ============================================================================ */

describe('① 对照 · 块外的折行行为一个字节都不改', () => {
  it('块外台词折行仍合并成一条 PRINT（`\\` 与续行缩进被折掉，规范 §3.10）', () => {
    const src = ['角色: 1', '时机 指令 1：', '    甲 \\', '        乙'].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    // 折成一条文本行：**没有** `\`、两条物理行不再各自成行
    expect(res.erb).toContain('甲 乙');
    expect(res.erb.includes('\\')).toBe(false);
    expect(rows(res.erb).filter((l) => l.includes('甲'))).toHaveLength(1);
  });

  it('同一份源里"块外折、块内不折"并存（判据互不污染）', () => {
    const src = [
      '角色: 1',
      '时机 指令 1：',
      '    甲 \\',
      '        乙',
      '@M_KOJO_K12_310',
      'A = 1 \\',
      '    B = 2',
    ].join('\n');
    const res = t(src);
    expect(errorsOf(src)).toEqual([]);
    expect(res.erb).toContain('甲 乙');
    expect(indexOfRun(rows(res.erb), ['A = 1 \\', '    B = 2'])).toBeGreaterThanOrEqual(0);
  });

  it('块外折行的诊断列仍折回续接的物理行（`foldPositionToPhysical` 口径不动）', () => {
    const src = '角色: 12\n时机 指令 310：\n' + '    心形 「甲\\\n        {乙」\n';
    const loc = t(src).diagnostics.find((d) => d.code === 'interpolation-unclosed')?.loc ?? null;
    expect(loc).toEqual({ line: 4, column: 9 });
  });
});
