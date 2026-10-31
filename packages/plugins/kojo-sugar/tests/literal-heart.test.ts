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
import { encodeErbText } from '../src/literal';
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

/* ============================================================================ */
/* C. 字符串值（普通串 `"…"`）：别名右值同走唯一编码器                              */
/* ============================================================================ */

/**
 * 缺陷形态（与心形同源）：`别名 台词 = "…"` 的**字符串值**在表达式 / 分支值位置
 * 曾裸拼 `"${text}"`——文本里一个半角 `"` 就截断产物字面量（`"他说"好""`），
 * 一个 `\` 就被引擎吃掉下一字符，且**零诊断**。修法：三处（插值降糖 / `是 <别名>：`
 * CASE 值 / `-> <别名>` 分支值）都走 `literal.ts::erbStringLiteral`。
 */
describe('① 字符串值 · 别名右值走同一编码器', () => {
  const ALIAS = '别名 台词 = "他说"好""\n';

  it('插值里的字符串别名：半角 `"` 降全角（不截断 `"…"`）', () => {
    const src = `角色: 12\n${ALIAS}时机 指令 310：\n    「{台词}」\n`;
    const r = t(src);
    expect(errs(src)).toEqual([]);
    expect(r.erb).toContain('PRINTFORMW 「他说＂好＂」');
    expect(r.erb).not.toContain('"他说"好""');
  });

  it('字符串别名里的 `\\` 双写（引擎只吃一个转义引导符）', () => {
    const src = '角色: 12\n别名 路径 = "C:\\存档"\n时机 指令 310：\n    「{路径}」\n';
    const r = t(src);
    expect(errs(src)).toEqual([]);
    expect(r.erb).toContain('「{"C:\\\\存档"}」');
  });

  it('`当 … 是 <别名>：` 的 CASE 值同样编码（不产截断分支）', () => {
    const src = `角色: 12\n${ALIAS}时机 指令 310：\n    当 TFLAG:193：\n        是 台词：\n            「嗯。」\n`;
    const r = t(src);
    expect(errs(src)).toEqual([]);
    expect(r.erb).toContain('CASE "他说＂好＂"');
  });

  it('表达式 `-> <别名>` 的分支值同样编码（赋值右侧不产截断字面量）', () => {
    const src =
      `角色: 12\n${ALIAS}时机 指令 310：\n` +
      '    她的心情 = 当 她的好感度：\n        是 0 到 99 -> 台词\n        否则 -> 2\n';
    const r = t(src);
    expect(errs(src)).toEqual([]);
    expect(r.erb).toContain('CFLAG:TARGET:心情 = "他说＂好＂"');
  });
});

/* ============================================================================ */
/* D. 编码器本体：回车符 fail-closed 的口径钉住                                      */
/* ============================================================================ */

/**
 * 转译器按物理行切源（`splitPhysicalLines` 认 `\r\n` / `\r` / `\n`），CR 进不到
 * 单行文本体里——所以 CR 分支只能在编码器本体上钉住：`failures` 里有事实、
 * `body` 里没有坏字节（调用方据此不发射）。
 */
describe('① encodeErbText · 回车符 fail-closed 与合法代理项放行', () => {
  it('U+000D 进 failures、不进 body', () => {
    const r = encodeErbText('甲\u000D乙');
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ reason: 'carriage-return', offset: 1, char: 'U+000D' }]);
    expect(r.body).toBe('甲乙');
  });

  it('合法代理对（emoji）原样放行（fail-closed 不误伤可表达字符）', () => {
    const r = encodeErbText('😀"\\');
    expect(r.ok).toBe(true);
    expect(r.body).toBe('😀＂\\\\');
  });
});
