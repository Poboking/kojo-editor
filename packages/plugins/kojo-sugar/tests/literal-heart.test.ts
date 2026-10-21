/**
 * K2-PRE-REUSE ①：心形提示的字面量编码（`CALL HPH_PRINT(@"…")`）。
 *
 * 缺陷形态：心形体**裸拼**进 `@"…"`——提示里出现半角 `"` 就把字面量**截断**、
 * 出现 `\` 就被引擎当转义引导符吃掉一个字符（行尾 `\` 连收尾引号一起吃掉），
 * 产物不可加载且零诊断。修法：整条心形路径收口到 `literal.ts::encodeErbText`
 * （唯一编码器）——`"` → 全角 `＂`、`\` → `\\`；装不下的字符（NUL / CR /
 * 未配对代理项）**fail-closed**（error + 本行不产字节）。
 *
 * 判据都落在**产物字节**上（不看中间态）：红→绿的鉴别力在 `@"…"` 是否被截断。
 * 装配不依赖游戏盘：字典 / 分野表用 `support.ts` 的桩。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 正文落在 `时机 指令 310：` 的函数体内 */
const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;

/** 产物里所有 `CALL HPH_PRINT` 行（去缩进后逐字比对） */
const hphLines = (src: string): string[] =>
  t(src)
    .erb.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('CALL HPH_PRINT'));

const errs = (src: string) => t(src).diagnostics.filter((d) => d.severity === 'error');

/* ============================================================================ */
/* A. 两个危险字符：`"` 降全角、`\` 双写（产物可加载、逐字可断言）                   */
/* ============================================================================ */

describe('① 心形字面量 · 危险字符编码', () => {
  it('半角 `"` 降为全角 `＂`（字面量不被截断，产物里不出现 `\\"`）', () => {
    const src = doc('    心形 「他说"好"」');
    const r = t(src);
    expect(errs(src)).toEqual([]);
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"他说＂好＂","w")']);
    expect(r.erb).not.toContain('\\"');
  });

  it('`\\` 双写（引擎只吃一个转义引导符，屏幕上仍是作者写的那一个）', () => {
    const src = doc('    心形 「C:\\存档」'); // 源里一个反斜杠
    expect(errs(src)).toEqual([]);
    // 产物里两个反斜杠（转义形态）
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"C:\\\\存档","w")']);
  });

  it('行尾 `\\` 不会吃掉收尾引号（整行仍是完整的 `@"…","w")`）', () => {
    const src = doc('    心形 「结尾\\」');
    const lines = hphLines(src);
    expect(errs(src)).toEqual([]);
    expect(lines).toEqual(['CALL HPH_PRINT(@"结尾\\\\","w")']);
    expect(lines[0]!.endsWith('","w")')).toBe(true);
  });

  it('全角引号 `＂` 原样保留（只降半角，不动作者写的全角）', () => {
    const src = doc('    心形 「他说＂好＂」');
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"他说＂好＂","w")']);
  });

  it('多段文本里的半角 `"` 也照编码（不粘成残句、不截断）', () => {
    const src = doc('    心形 「甲」"乙"');
    expect(errs(src)).toEqual([]);
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"「甲」＂乙＂","w")']);
  });

  it('心形连续块与单行形走**同一条**编码管线（逐字节相同）', () => {
    const single = doc('    心形 「他说"好"」');
    const block = doc('    心形：\n        「他说"好"」');
    expect(hphLines(block)).toEqual(hphLines(single));
    expect(hphLines(block)).toEqual(['CALL HPH_PRINT(@"他说＂好＂","w")']);
  });

  it('无转义时列区段照旧落在源正文（`_rawAt` = 心形体起点，不是行首内容起点）', () => {
    const src = doc('    心形 「嗯。」');
    const r = t(src);
    const lines = r.erb.split('\n');
    const genLine = lines.findIndex((l) => l.includes('CALL HPH_PRINT')) + 1;
    const entry = r.sourceMap.find((e) => e.generatedLine === genLine)!;
    expect(entry.runs).toEqual([{ generatedColumn: 19, length: 2, source: { line: 3, column: 9 } }]);
  });
});

/* ============================================================================ */
/* B. 装不下的字符：fail-closed（error + 本行零字节，绝不写坏产物）                  */
/* ============================================================================ */

describe('① 心形字面量 · 装不下的字符 fail-closed', () => {
  it('NUL（U+0000）→ error、零 `HPH_PRINT`、产物里没有 NUL', () => {
    const src = doc('    心形 「甲\u0000乙」');
    const r = t(src);
    const bad = r.diagnostics.find((d) => d.severity === 'error');
    expect(bad?.code).toBe('literal-unencodable');
    expect(bad?.message).toContain('U+0000');
    // 诊断落在作者文本的那个码元上（1 基列：4 缩进 + `心形 `3 + `「` + `甲` = 10）
    expect(bad?.loc).toEqual({ line: 3, column: 10 });
    expect(hphLines(src)).toEqual([]);
    expect(r.erb).not.toContain('\u0000');
  });

  it('专用码 `literal-unencodable`：不再是 `internal`（转译器异常 ≠ 作者文本装不下）', () => {
    const src = doc('    心形 「甲\u0000乙」');
    const codes = t(src).diagnostics.map((d) => d.code);
    expect(codes).toContain('literal-unencodable');
    expect(codes).not.toContain('internal');
  });

  it('未配对代理项 → error、零 `HPH_PRINT`（不产非法 UTF-16 产物）', () => {
    const src = doc('    心形 「甲\ud83d乙」'); // 孤立高位代理项
    const r = t(src);
    expect(errs(src).some((d) => d.message.includes('代理项'))).toBe(true);
    expect(hphLines(src)).toEqual([]);
    expect(r.erb).not.toContain('\ud83d');
  });

  it('负自证：同文件另一行正常心形照常产出（坏行不连坐好行）', () => {
    const src = doc('    心形 「正常」\n    心形 「坏\u0000行」');
    expect(hphLines(src)).toEqual(['CALL HPH_PRINT(@"正常","w")']);
    expect(errs(src).length).toBeGreaterThan(0);
  });
});
