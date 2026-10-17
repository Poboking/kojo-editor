/**
 * 回归：标签/台词文本进产物时的**字面量安全**。
 *
 * - HIGH（选项/问答）：旧实现用 `JSON.stringify` 包标签 ⇒ ERB 里出现 `\"`。
 *   ERB 没有转义语法，`PRINTBUTTON "他说\"好\"", "1"` 是无法加载的产物；
 *   选项/询问的标签必须走 `erbStringLiteral`（`"` → 全角 `＂`）。
 * - MED（问答模板替换）：`String.replace('{label}', …)` 的字符串替换串会把标签
 *   里的 `$&` / `` $` `` / `$'` / `$1` 当替换模板展开（`甲$&乙` → `甲{label}乙`）；
 *   一律用函数形替换。
 * - LOW-MED（菜单）：标签裸拼进 `PRINTL` 行尾——`;` / `@` / `"` / `\` 破坏行结构，
 *   `%…%` 被引擎当变量记号；前者按字面量包裹，后者直接拒绝（`stray-percent`）。
 * - LOW（心形）：`「甲」「乙」` 曾只剥首尾引号 → `甲」「乙`；多段文本必须原样保留。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
const wrap = (body: string) => `角色: 12\n时机 指令 310：\n${body}`;
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

describe('HIGH · 选项标签含 `"`：字面量可加载（无 `\\"`）', () => {
  const src = wrap('    选项：\n        「他说"好"」：\n            「嗯。」\n');

  it('PRINTBUTTON 标签内的 `"` 降为全角 ＂，产物里不出现 `\\"`', () => {
    const { erb, diagnostics } = t(src);
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('PRINTBUTTON "他说＂好＂", "1"');
    expect(erb).not.toContain('\\"');
    // CASE 的编号字面量不受影响（纯数字，逐字节不变）
    expect(erb).toContain('CASE "1"');
  });

  it('普通标签逐字节不变（golden 口径）', () => {
    const plain = t(wrap('    选项：\n        「继续」：\n            「好。」\n')).erb;
    expect(plain).toContain('PRINTBUTTON "继续", "1"');
  });
});

describe('MED · 问答标签替换：`$&` / `$1` 不被当作替换模板', () => {
  const src = wrap(
    '    询问：\n        「甲$&乙」：\n            「嗯。」\n        「丙$1丁」：\n            「哦。」\n',
  );

  it('标签原样出现在 ASK_M 调用里，不出现 `{label}` 残迹', () => {
    const { erb, diagnostics } = t(src);
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('ASK_M("甲$&乙",1,"丙$1丁",1)');
    expect(erb).not.toContain('{label}');
    expect(erb).not.toContain('{options}');
  });
});

describe('LOW-MED · 菜单标签：危险字符按字面量包裹，`%` 拒绝', () => {
  it('`;x` 标签包成 ERB 字面量（不再裸拼到 PRINTL 行尾）', () => {
    const { erb, diagnostics } = t(wrap('    菜单：\n        「;x」：\n            「a」\n'));
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('PRINTL [1] ";x"');
  });

  it('`%CALLNAME:TARGET%` 标签 → error `stray-percent`，整块不产字节（fail-closed）', () => {
    const r = t(wrap('    菜单：\n        「%CALLNAME:TARGET%」：\n            「a」\n'));
    expect(r.diagnostics.some((d) => d.code === 'stray-percent' && d.severity === 'error')).toBe(true);
    expect(r.erb).not.toContain('PRINTL');
    expect(r.erb).not.toContain('$INPUT_LOOP');
  });

  it('普通标签维持裸形态（golden 逐字节不变）', () => {
    expect(t(wrap('    菜单：\n        「继续」：\n            「好。」\n')).erb).toContain('PRINTL [1] 继续');
  });
});

describe('LOW · 心形引号剥离：只剥"整段一句"的首尾', () => {
  it('单段台词仍剥引号（`心形 「甲」` → `@"甲"`）', () => {
    expect(t(wrap('    心形 「甲」\n')).erb).toContain('CALL HPH_PRINT(@"甲","w")');
  });

  it('多段文本（`「甲」「乙」`）原样保留，不粘成 `甲」「乙`', () => {
    const erb = t(wrap('    心形 「甲」「乙」\n')).erb;
    expect(erb).toContain('CALL HPH_PRINT(@"「甲」「乙」","w")');
    expect(erb).not.toContain('@"甲」「乙"');
  });
});
