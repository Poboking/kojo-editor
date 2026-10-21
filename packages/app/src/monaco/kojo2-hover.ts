/**
 * Kojo 2.0 **悬停**（K2-EDITOR-SEMANTIC）：`# 变量 / 常量 / 表 / 池 / 模`、`@函`、`# 幕`
 * 的声明事实（类型 / 初值 / 来源行）。
 *
 * ## 分层
 * 本文件是**纯函数**：源码文本 + 1 基行列进，事实出。零 IO、零 Monaco、零注册——
 * 宿主只把结果翻成 `monaco.languages.Hover` 的 `contents` / `range`（注册由 CUTOVER 收口）。
 * 声明索引住在 `kojo2-declarations.ts`（与转定义 / 补全共用同一份），本文件只负责
 * "光标下是哪条声明"与"这条声明怎么讲给作者看"。
 *
 * ## 位置门
 * - `@原生` 围栏体内不悬停（原文不解释）；
 * - 台词 / 旁白 / 转义字面文本的**正文**不悬停；`{…}` 插值内例外（那是表达式，不是台词）；
 * - 注释行不悬停。
 *
 * ## 事实口径
 * 名字、类型、初值、参数、表体行数全部来自 core 的 AST（`kojo2-declarations.ts` 搬运）；
 * 读不到就少说一行，**不编默认值**（例如没写初值就不写"初值：0"）。
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
  kojo2StorageWordOf,
  kojo2TokenSpanAt,
  kojo2TypeWordOf,
  type Kojo2Declaration,
  type Kojo2Query,
} from './kojo2-declarations';

/** 一次悬停的结果：显示名 / 声明种类 / 屏上区间 + 事实正文 + 声明落点。 */
export interface Kojo2HoverResult {
  readonly name: string;
  readonly kind: string;
  /** 屏上高亮区间（1 基、半开；引用处是引用词，声明处是名字段） */
  readonly startColumn: number;
  readonly endColumn: number;
  /** 事实正文（每行一段；宿主逐段渲染） */
  readonly lines: readonly string[];
  /** 声明落点（同文件；1 基） */
  readonly declaration: {
    readonly line: number;
    readonly column: number;
    readonly endColumn: number;
  };
}

/** 行原文（物理行缺失 = 空串；末尾空行等越界情形自然落空，不猜）。 */
function lineTextOf(document: ReturnType<typeof kojo2DocumentOf>, line: number): string {
  return document.physical[line - 1]?.text ?? '';
}

/** 声明事实正文（导出 = 可直接单测；渲染顺序 = 先位置、再语义）。 */
export function kojo2HoverLines(declaration: Kojo2Declaration): string[] {
  const lines: string[] = [
    `来源行：第 ${declaration.line} 行`,
    `原文：\`${truncate(declaration.lineText, 180)}\``,
  ];
  switch (declaration.kind) {
    case 'variable': {
      if (declaration.valueType !== undefined) {
        const array =
          declaration.arraySize === undefined ? '' : `[${declaration.arraySize}]`;
        lines.push(`类型：\`${kojo2TypeWordOf(declaration.valueType)}${array}\``);
      }
      if (declaration.storage !== undefined) {
        lines.push(`存储期：\`${kojo2StorageWordOf(declaration.storage)}\``);
      }
      if (declaration.initializer !== undefined) {
        lines.push(`初值：\`${declaration.initializer}\``);
      }
      break;
    }
    case 'constant': {
      if (declaration.valueType !== undefined) {
        lines.push(`类型：\`${kojo2TypeWordOf(declaration.valueType)}\``);
      }
      if (declaration.constantValue !== undefined) {
        lines.push(`初值：\`${declaration.constantValue}\``);
      }
      break;
    }
    case 'table': {
      if (declaration.subject !== undefined) {
        lines.push(`由：\`${declaration.subject.length === 0 ? '（空表达式）' : declaration.subject}\``);
      }
      if (declaration.rowCount !== undefined) {
        lines.push(`表体：${declaration.rowCount} 行`);
      }
      break;
    }
    case 'pool': {
      if (declaration.branchCount !== undefined) {
        lines.push(`分支：${declaration.branchCount} 条`);
      }
      break;
    }
    case 'template': {
      if (declaration.params !== undefined) {
        lines.push(`参数：\`${declaration.params.length === 0 ? '（无）' : declaration.params.join('、')}\``);
      }
      if (declaration.hasSlot !== undefined) {
        lines.push(`插槽：${declaration.hasSlot ? '有' : '无'}`);
      }
      break;
    }
    case 'function': {
      if (declaration.params !== undefined) {
        lines.push(`参数：\`${declaration.params.length === 0 ? '（无）' : declaration.params.join('、')}\``);
      }
      break;
    }
    case 'scene': {
      if (declaration.sceneTitle !== undefined) {
        lines.push(`场景标题：\`${declaration.sceneTitle}\``);
      }
      break;
    }
  }
  return lines;
}

/** 悬停 kind 文案（`变量声明` / `函声明` …；词形来自 core 词表）。 */
function hoverKindOf(declaration: Kojo2Declaration): string {
  return `${KOJO2_DECL_WORD_BY_KIND[declaration.kind]}声明`;
}

/** 超长行截断（悬停块不是正文阅读器）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 光标处的悬停事实（**纯函数**）。
 *
 * 解析顺序：位置门 → 声明名字段（声明处）→ 名字段反查（引用处）。
 * 引用处只认代码面（声明 / 调度 / 触发 / 条件 / 调度区裸行）；台词正文与原生体在位置门已退让。
 */
export function kojo2HoverAt(query: Kojo2Query): Kojo2HoverResult | undefined {
  const document = kojo2DocumentOf(query.source);
  const record = document.lines[query.line - 1];
  const text = lineTextOf(document, query.line);
  const col0 = Math.min(Math.max(query.column - 1, 0), text.length);
  if (record === undefined) return undefined;
  if (kojo2IsNativeRecord(record)) return undefined;
  if (record.kind === 'comment' || record.kind === 'legacy') return undefined;
  // 台词的**正文**不悬停；`{…}` 插值里是表达式，照常给事实。
  const interpolated = insideInterpolation(text, col0);
  if (kojo2IsTextSurface(record) && !interpolated) return undefined;

  const atDeclaration = kojo2DeclarationAt(document, query.line, col0);
  const headerDeclaration =
    atDeclaration === undefined
      ? kojo2DeclarationHeaderAt(document, query.line, col0)
      : undefined;
  const declaration = atDeclaration ?? headerDeclaration;
  if (declaration !== undefined) {
    return {
      name: declaration.name,
      kind: hoverKindOf(declaration),
      startColumn: atDeclaration !== undefined ? declaration.nameStart : 1,
      endColumn: atDeclaration !== undefined ? declaration.nameEnd : declaration.nameStart,
      lines: kojo2HoverLines(declaration),
      declaration: {
        line: declaration.line,
        column: declaration.nameStart,
        endColumn: declaration.nameEnd,
      },
    };
  }

  if (!kojo2IsCodeSurface(record) && !(kojo2IsTextSurface(record) && interpolated)) {
    return undefined;
  }
  const span = kojo2TokenSpanAt(text, col0);
  if (span === null) return undefined;
  const resolved = kojo2DeclarationNamed(document, span.text, query.line);
  if (resolved === undefined) return undefined;
  return {
    name: resolved.name,
    kind: hoverKindOf(resolved),
    startColumn: span.start + 1,
    endColumn: span.end + 1,
    lines: kojo2HoverLines(resolved),
    declaration: {
      line: resolved.line,
      column: resolved.nameStart,
      endColumn: resolved.nameEnd,
    },
  };
}
