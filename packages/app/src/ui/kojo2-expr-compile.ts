/**
 * K2-EXPR-PORT · 2.0 表达式端口的**域符号真管线**（宿主装配侧，零游戏知识硬编码）。
 *
 * ## 为什么需要它
 *
 * 实测（K2-EXPR-PORT 探针）：core 传给 `compileExpression` 端口的是**原样中文源切片**
 * （`我` / `恋慕` / `分数 + 1`）。旧端口 `kojo2IdentityCompileExpression` 恒等透传，
 * 把 `%我%` 原样写进 ERB——引擎只认 `%CALLNAME:TARGET%`，不认中文代词；发布回执
 * 里那句「表达式端口恒等透传」的已知缺口就是这里。
 *
 * ## 口径（与 v1 `expression.ts::lowerPronounsAndAttributes` 与 core golden 逐条对齐）
 *
 * - **代词**：按 adapter `domainSymbols.pronouns` 的 `engineRef` 落点
 *   （eraTW：`我`/`她`→`%CALLNAME:TARGET%`、`你`→`%CALLNAME:MASTER%`）；
 * - **独立词**：前后都不是标识符字符才替换（`你和我` 黏连 ⇒ 不替，与 v1 `matchPronoun` 同源）；
 * - **字符串字面量**：双引号内部是正文，一个字都不动（与 v1 `splitStringLiterals` 同源）；
 * - **属性 / 声明变量 / 算术 / 条件**：原样透传。core 契约 `adapter.ts:207` 明确这些
 *   「只参与名字解析、不参与 lowering，产物仍原样写作者名字」——不在这里重复降糖。
 *
 * 游戏事实全部来自注入的 {@link DomainSymbols}：本模块不认任何具体游戏，
 * 也不 import 任何 adapter 插件（解耦审计 B/C）；adapter 缺席 ⇒ 恒等透传（不猜）。
 */
import type { DomainSymbols, KojoExprText } from '@kojo/kojo-core';
import { isIdentPart } from '@kojo/kojo-vocab/identifier-chars';

/** 端口签名（与 `bootstrap.ts::Kojo2BackendDeps.compileExpression` 同源） */
export type Kojo2CompileExpression = (expr: KojoExprText) => string;

/**
 * 恒等透传（保留导出：测试 / 诊断 / 无 adapter 事实时的回退口径；旧消费方零改动）。
 */
export function kojo2IdentityCompileExpression(expr: KojoExprText): string {
  return expr.text;
}

/** 字符串字面量切片：`isString=true` 的段一个字都不动 */
function splitStringLiterals(code: string): { readonly text: string; readonly isString: boolean }[] {
  const parts: { text: string; isString: boolean }[] = [];
  let buf = '';
  let inString = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '\\' && inString && i + 1 < code.length) {
      buf += ch + code[i + 1]!;
      i++;
      continue;
    }
    if (ch === '"') {
      buf += ch;
      parts.push({ text: buf, isString: inString });
      buf = '';
      inString = !inString;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) parts.push({ text: buf, isString: inString });
  return parts;
}

/**
 * 从 adapter 的域符号派生一台表达式编译器。
 *
 * @param symbols adapter 的 `domainSymbols`（游戏事实；由组合根从当前项目现取）
 * @returns 端口函数；代词按 engineRef 落点，其余原样；纯函数、可缓存复用。
 */
export function createDomainSymbolExprCompiler(symbols: DomainSymbols | null | undefined): Kojo2CompileExpression {
  const pronouns = (symbols?.pronouns ?? [])
    .filter((item) => item.pronoun.length > 0 && item.engineRef.length > 0)
    .map((item) => ({ pronoun: item.pronoun, engineRef: item.engineRef }))
    .sort((a, b) => b.pronoun.length - a.pronoun.length);

  if (pronouns.length === 0) return kojo2IdentityCompileExpression;

  return (expr: KojoExprText): string => {
    const code = expr.text;
    let out = '';
    for (const part of splitStringLiterals(code)) {
      if (part.isString) {
        out += part.text;
        continue;
      }
      const text = part.text;
      let i = 0;
      while (i < text.length) {
        let replaced = false;
        for (const { pronoun, engineRef } of pronouns) {
          if (!text.startsWith(pronoun, i)) continue;
          const before = i > 0 ? text[i - 1]! : '';
          const after = i + pronoun.length < text.length ? text[i + pronoun.length]! : '';
          if (isIdentPart(before) || isIdentPart(after)) continue;
          out += engineRef;
          i += pronoun.length;
          replaced = true;
          break;
        }
        if (!replaced) {
          out += text[i]!;
          i++;
        }
      }
    }
    return out;
  };
}
