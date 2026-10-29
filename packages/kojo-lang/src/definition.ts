/**
 * Kojo 2.0 **转到定义**的判据：同文件声明即定义。
 *
 * 与悬停共用 `declarations.ts` 的同一份索引（不各扫一遍源码）：
 * - 声明处：F12 落在自己（`# 变量 好感度` / `# 对照表 心情` / `@函 …` / `# 幕 …`）；
 * - 引用处：代码面里的同名声明 → 声明行的**名字段**（`! 池 / 模 / 函` 调用同样走这条）；
 * - 台词正文 / `@原生` 体内不跳（那是文本，不是引用）。
 *
 * 纯函数：源码 + 1 基行列进，声明落点出；零 IO、零 Monaco、零注册。
 *
 * ## 落点为什么是「同文件」而不是绝对位置
 *
 * 这一层只回答"名字 → 本文档里的哪一行哪一列"。跨文件（跳进别的 `.kojo2`、
 * 跳进 `ERB/` 里的定义）是**索引 + 宿主导航**的事，不属于语言面判据——
 * 判据里塞路径就等于让每一门语言各自发明一套路径口径。
 *
 * ## 谁消费
 *
 * - 插件 `@kojo/plugin-kojo-lang` 把它翻成契约的 `EditorSymbolLocation`，经
 *   `ui.editor.languageService` 槽（`kind: 'definition'`）交给宿主；
 * - 宿主把它翻成 Monaco `LocationLink`（**翻译**，不是判据）。
 *
 * 展开视图（模板 / 池 / 随机的"调用处 ↦ 定义处"）不在这里：那是 `expand-view.ts` 的
 * 事，由消费方在拿到本函数的落点之后**追加**，两条腿不互相依赖。
 */
import { insideInterpolation } from './interpolation';
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
} from './declarations';

/** 定义落点（同文件；1 基，尾列半开）。 */
export interface Kojo2DefinitionTarget {
  readonly name: string;
  /** 声明种类文案（`变量` / `对照表` / `函` …；来自 core 词表） */
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
