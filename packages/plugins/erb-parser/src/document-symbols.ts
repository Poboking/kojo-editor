import type { EditorDocumentSymbol, ErbFile, ErbFunction } from '@kojo/plugin-api';

/**
 * ERB 文件 → 文档大纲（B3）。
 *
 * 数据源刻意是**当前缓冲区解析结果**（`parseErbText(request.text)`）而不是项目索引：
 * 索引里的 `startLine/endLine` 说的是**磁盘上那份**，作者一有未保存编辑就整体错位——
 * 大纲与吸顶跳过去会落在隔壁函数，比不给大纲更坏。
 *
 * 纯函数：文本进、符号出，不读盘、不碰索引。
 */

/** `detail` 上限（大纲一行放不下长注释；截断比换行好，Monaco 不自适应行高） */
const DETAIL_MAX = 80;

/** ERB 形参 → 副标题（`ARGS` / `ARG:1` 原样列出；无参 = 空串，不留 `()` 噪声） */
function paramsDetail(fn: ErbFunction): string {
  return fn.params.length === 0 ? '' : `(${fn.params.map((p) => p.name).join(', ')})`;
}

/** 函数条目的副标题：作者写的注释首行优先（比形参认得出来），其次形参 */
function functionDetail(fn: ErbFunction): string {
  const comment = fn.docComment ? truncate(firstNonBlankLine(fn.docComment)) : '';
  return comment || paramsDetail(fn);
}

function firstNonBlankLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/**
 * 大纲项（函数 + 变量声明，按起始行升序）。
 *
 * 声明（`#DIM`）也给：`.ERH` 这类声明文件里一个 `@` 定义都没有，只给函数就等于
 * "这类文件没有大纲"——而恰恰是这些文件最需要靠吸顶看清"现在在哪个声明段里"。
 */
export function erbDocumentSymbols(file: ErbFile): EditorDocumentSymbol[] {
  const out: EditorDocumentSymbol[] = [];
  for (const fn of file.functions) {
    const detail = functionDetail(fn);
    out.push({
      name: fn.name,
      kind: 'function',
      startLine: fn.startLine,
      endLine: fn.endLine,
      ...(detail ? { detail } : {}),
    });
  }
  for (const dim of file.dims) {
    out.push({
      name: dim.name,
      kind: 'declaration',
      startLine: dim.line,
      endLine: dim.line,
      detail: dim.directive,
    });
  }
  // 文档序（同起始行时函数优先——它是"更大的那一段"）
  return out.sort((a, b) => a.startLine - b.startLine || (a.kind === b.kind ? 0 : a.kind === 'function' ? -1 : 1));
}
