/**
 * Kojo 2.0 **转到定义**（K2-EDITOR-SEMANTIC）：同文件声明即定义。
 *
 * 与 `kojo2-hover.ts` 共用 `kojo2-declarations.ts` 的同一份索引（不各扫一遍源码）：
 * - 声明处：F12 落在自己（`# 变量 好感度` / `# 表 心情` / `@函 …` / `# 幕 …`）；
 * - 引用处：代码面里的同名声明 → 声明行的**名字段**（`! 池 / 模 / 函` 调用同样走这条）；
 * - 台词正文 / `@原生` 体内不跳（那是文本，不是引用）。
 *
 * 纯函数：源码 + 1 基行列进，声明落点出；零 IO、零 Monaco、零注册。宿主只把
 * `{line, column, endColumn}` 翻成 Monaco 的 `LocationLink`（注册由 CUTOVER 收口）。
 */

import { insideInterpolation } from './kojo-completion-position';
import {
  KOJO2_DECL_WORD_BY_KIND,
  kojo2DeclarationAt,
  kojo2DeclarationHeaderAt,
  kojo2DeclarationNamed,
  kojo2DocumentOf,
  kojo2IsCodeSurface,
  kojo2IsNativeRecord,
  kojo2IsTextSurface,
  kojo2TokenSpanAt,
  type Kojo2Declaration,
  type Kojo2Query,
} from '@kojo/kojo-lang';

/** 定义落点（同文件；1 基，尾列半开）。 */
export interface Kojo2DefinitionTarget {
  readonly name: string;
  /** 声明种类文案（`变量` / `表` / `函` …；来自 core 词表） */
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

/** 声明事实 → 定义落点。 */
function targetOf(declaration: Kojo2Declaration): Kojo2DefinitionTarget {
  return {
    name: declaration.name,
    kind: KOJO2_DECL_WORD_BY_KIND[declaration.kind],
    line: declaration.line,
    column: declaration.nameStart,
    endColumn: declaration.nameEnd,
  };
}

/**
 * 光标处的定义落点（**纯函数**）。
 *
 * 位置门与悬停同一套：`@原生` / 注释 / 台词的正文不跳，`{…}` 插值内照常解析。
 * 返回 `undefined` = 此处没有可跳的同文件声明（Monaco 自己会提示"未找到定义"）。
 */
export function kojo2DefinitionAt(query: Kojo2Query): Kojo2DefinitionTarget | undefined {
  const document = kojo2DocumentOf(query.source);
  const record = document.lines[query.line - 1];
  if (record === undefined) return undefined;
  if (kojo2IsNativeRecord(record)) return undefined;
  if (record.kind === 'comment' || record.kind === 'legacy') return undefined;
  const text = document.physical[query.line - 1]?.text ?? '';
  const col0 = Math.min(Math.max(query.column - 1, 0), text.length);
  const interpolated = insideInterpolation(text, col0);
  if (kojo2IsTextSurface(record) && !interpolated) return undefined;

  const atDeclaration = kojo2DeclarationAt(document, query.line, col0);
  if (atDeclaration !== undefined) return targetOf(atDeclaration);
  const headerDeclaration = kojo2DeclarationHeaderAt(document, query.line, col0);
  if (headerDeclaration !== undefined) return targetOf(headerDeclaration);

  if (!kojo2IsCodeSurface(record) && !(kojo2IsTextSurface(record) && interpolated)) {
    return undefined;
  }
  const span = kojo2TokenSpanAt(text, col0);
  if (span === null) return undefined;
  const declaration = kojo2DeclarationNamed(document, span.text, query.line);
  return declaration === undefined ? undefined : targetOf(declaration);
}
