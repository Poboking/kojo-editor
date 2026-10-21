/**
 * 迁移引擎 · 源文本事实层（v1 `.kojo` 文本 → 物理行 / 缩进 / EOL / BOM）。
 *
 * 分工：本文件**只认事实**（怎么切行、缩进多深、EOL 是什么），不做任何改写决策；
 * 改写规则与 unsupported 台账住 `./index.ts` 与 `./classify.ts`。
 *
 * 口径（与 2.0 core `positions.ts` / `lexer.ts` 对齐）：
 * - 行号 **1 基**；列 **1 基、UTF-16 码元**；
 * - EOL：`\r\n` / `\r` / `\n` 只记事实，输出沿用**输入多数派**；BOM 保留（§10.4 Unit 属性）；
 * - 缩进层级照抄 v1 的 `indentLevelOf`（TAB=1 级；全角空格=2 宽；半角空格每 4 个 1 级、
 *   余数按 1 级算）——这是 v1 冻结口径的**迁移专用快照**，不是第二份 2.0 真源：
 *   2.0 新增行一律按 `4*level` 空格发射，Tab 只允许留在 `@原生` 原文里。
 */
import type { KojoSpan } from '../ast.js';

/** 一条 v1 物理行（`raw` 不含 EOL；`body` = 去掉行首空白后的内容） */
export interface V1Line {
  /** 1 基行号 */
  readonly number: number;
  /** 整行原文（不含 EOL） */
  readonly raw: string;
  /** 行首空白（缩进原文） */
  readonly lead: string;
  /** 去掉行首空白后的内容 */
  readonly body: string;
  /** v1 缩进层级（0 基；算法见文件头） */
  readonly indent: number;
}

export type Eol = '\n' | '\r\n';

/** 源文本事实 */
export interface V1Source {
  /** 是否带 UTF-8 BOM（输出原样保留） */
  readonly bom: boolean;
  /** 输出 EOL（输入多数派；无换行时按 `\n`） */
  readonly eol: Eol;
  /** 输入是否以换行结尾（输出保持一致） */
  readonly finalNewline: boolean;
  /** 物理行（最后一行若无尾换行也在内） */
  readonly lines: readonly V1Line[];
}

/** 行首空白字符集（照抄 v1 `blank-charset.ts`：半角空格 / TAB / 全角空格；NBSP 不算） */
const LEAD_RE = /^[ \t\u3000]*/;

/** 全角空格宽度按 2 计（与 v1 `indentLevelOf` 同口径） */
const FULLWIDTH_SPACE = '\u3000';

/** 一段行首空白的 v1 缩进层级（0 基） */
export function indentLevelOf(lead: string): number {
  let tabs = 0;
  let width = 0;
  for (const ch of lead) {
    if (ch === '\t') tabs++;
    else if (ch === FULLWIDTH_SPACE) width += 2;
    else width += 1;
  }
  return tabs + (width > 0 ? Math.ceil(width / 4) : 0);
}

/** 整行是否空白（空行不参与缩进计算，也不进产物） */
export function isBlankBody(body: string): boolean {
  return body.length === 0 || /^[ \t\u3000]*$/.test(body);
}

/**
 * 切分源文本：BOM / EOL 多数派 / 末尾换行 / 物理行。
 *
 * 纯函数、零 IO。空文本 → 0 行；`finalNewline` 为真时不会有"尾随空行"伪行。
 */
export function readSource(source: string): V1Source {
  const bom = source.startsWith('\uFEFF');
  const text = bom ? source.slice(1) : source;

  let crlf = 0;
  let cr = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const finalNewline = /(?:\r\n|\r|\n)$/.test(text);
  const eol: Eol = crlf >= lf && crlf >= cr && crlf > 0 ? '\r\n' : '\n';

  const rawLines: string[] = [];
  const parts = text.split(/\r\n|\r|\n/);
  if (finalNewline) parts.pop(); // 末尾换行来自最后一段空串，不产生伪行
  for (const raw of parts) rawLines.push(raw);
  const lines: V1Line[] = rawLines.map((raw, index) => {
    const lead = LEAD_RE.exec(raw)![0]!;
    return {
      number: index + 1,
      raw,
      lead,
      body: raw.slice(lead.length),
      indent: indentLevelOf(lead),
    };
  });

  return { bom, eol, finalNewline, lines };
}

/** 一条v1行整行区间（1 基、UTF-16；供诊断 span 用） */
export function lineSpan(line: V1Line): KojoSpan {
  return {
    start: { line: line.number, column: 1 },
    end: { line: line.number, column: line.raw.length + 1 },
  };
}

/** 归一化缩进（2.0 一级 = 4 空格）；`level` 允许为负（越界回缩由调用方先拦住） */
export function indentOfLevel(level: number): string {
  return '    '.repeat(Math.max(0, level));
}

/**
 * v1 行内注释起点（引号外第一个半角 `;`；没有 → -1）。
 *
 * 与 v1 `lexer.ts::inlineCommentIndex` 同判据：只在 ASCII 双引号里不切；
 * v1 的文本行**不剥**注释（`;` 是作者要打印的字），所以本函数只供"结构化行"使用。
 */
export function inlineCommentIndex(body: string): number {
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"') inString = !inString;
    else if (ch === ';' && !inString) return i;
  }
  return -1;
}

/** 剥结构化行的行内注释（返回 `{ code, comment }`；comment 不含 `;`） */
export function splitInlineComment(body: string): { code: string; comment: string | null } {
  const at = inlineCommentIndex(body);
  if (at < 0) return { code: body, comment: null };
  return { code: body.slice(0, at).trimEnd(), comment: body.slice(at + 1) };
}

/** 顶层逗号切分（不进入引号 / 括号；行内随机候选切分用） */
export function splitTopLevelComma(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inString = false;
  for (const ch of text) {
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(' || ch === '（') depth++;
      else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    }
    if (!inString && depth === 0 && (ch === ',' || ch === '，')) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 末尾块头冒号（全角 `：` / 半角 `:`）——返回剥掉冒号后的正文；无冒号 → null */
export function stripHeadColon(body: string): string | null {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith('：') || trimmed.endsWith(':')) return trimmed.slice(0, -1).trimEnd();
  return null;
}

/** 首个空白分隔词（`如果` / `否则如果` / `调用` …；无空白则整串） */
export function leadingWord(body: string): string {
  const m = /^(\S+)/.exec(body);
  return m ? m[1]! : '';
}

/** 词后余文（已 trimStart；不含词） */
export function restAfterWord(body: string, word: string): string {
  return body.slice(word.length).replace(/^[ \t\u3000]+/, '');
}
