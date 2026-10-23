/**
 * 迁移引擎 · v1 缩进失配的**成因定位**（K2-MIGRATE-INDENT-DETAIL）。
 *
 * 背景：v1 前端对"这一行放不进任何块"统一报 `indent-mismatch`；一条码把
 * 四类完全不同的成因压成同一句话，作者拿到 blocked 也不知道该改哪儿。
 * 本模块只做**解释**与**唯一解修复**，不改迁移判据：
 *
 * - 解释：给定 v1 诊断的**行号**，回看该行的行首（BOM / TAB / 空格）与上方块头，
 *   给出可定位的成因（`tab/space 混用` / `块缩进跳级` / `孤儿正文` / `顶层外部行` …）；
 * - 修复：只做**机械唯一解**——首行 BOM。BOM 是编码事实（`readSource` 的 `bom` 已单独记账），
 *   剥掉它不会改变任何一行的语义；其余成因（顶层外部行 / 跳级 / 混用）都有多解，
 *   **一律维持 blocked**（不猜）。
 *
 * 只读事实、不产诊断对象：成因为 null 表示"这一行看不出缩进类问题"（调用方原样透出原码）。
 */
import type { V1Kind } from './classify.js';
import { classifyV1 } from './classify.js';
import { isBlankBody, readSource, type V1Line } from './source.js';

/** 成因词表（报告与测试的稳定标识；人话在 `detail` 里） */
export type V1IndentCause =
  | 'bom-first-line'
  | 'tab-space-mixed'
  | 'indent-jump'
  | 'orphan-body'
  | 'top-level-foreign-line'
  | 'block-body-mismatch';

/** 一条成因定位 */
export interface V1IndentFinding {
  readonly cause: V1IndentCause;
  /** 1 基行号（对输入原文；BOM 不影响行号） */
  readonly line: number;
  /** 可直接透出的 detail：`indent-mismatch: <成因> @第 N 行（<证据>）` */
  readonly detail: string;
  /** 是否机械可解（true = 由 `repairV1Source` 自动修复；false = 维持 blocked） */
  readonly repairable: boolean;
}

/** 一次机械修复的记录（additive：旧消费方不看这个字段也不受影响） */
export interface V1SourceRepair {
  readonly cause: 'bom-first-line';
  readonly line: 1;
  readonly detail: string;
}

/** 修复结果：`code` 是喂给 v1 前端的源码（无修复时逐字原样） */
export interface V1SourceRepairResult {
  readonly code: string;
  readonly repairs: readonly V1SourceRepair[];
}

/** 证据里引用的行内容最长长度（行内容本身可能很长） */
const EVIDENCE_CLIP = 48;

function clip(text: string): string {
  const flat = text.trim();
  return flat.length <= EVIDENCE_CLIP ? flat : `${flat.slice(0, EVIDENCE_CLIP)}…`;
}

function detailOf(cause: V1IndentCause, line: number, evidence: string): string {
  return `indent-mismatch: ${causeLabel(cause)} @第 ${line} 行（${evidence}）`;
}

function causeLabel(cause: V1IndentCause): string {
  switch (cause) {
    case 'bom-first-line':
      return '首行 BOM';
    case 'tab-space-mixed':
      return 'tab/space 混用';
    case 'indent-jump':
      return '块缩进跳级';
    case 'orphan-body':
      return '孤儿正文';
    case 'top-level-foreign-line':
      return '顶层外部行';
    case 'block-body-mismatch':
      return '块体不归属';
  }
}

/** 行首空白的种类（用于 tab/space 混用判据；全角空格按"空格"侧） */
function leadKind(lead: string): 'tab' | 'space' | 'none' {
  const hasTab = lead.includes('\t');
  const hasSpace = /[ \u3000]/.test(lead);
  if (hasTab && hasSpace) return 'space'; // 行内混用由调用方先判，这里只区分"以谁为主"
  if (hasTab) return 'tab';
  if (hasSpace) return 'space';
  return 'none';
}

/** 该行是否开启可容纳更深缩进正文的块（v1 冻结语法） */
function opensBlock(kind: V1Kind): boolean {
  switch (kind.kind) {
    case 'timingHead':
    case 'elseHead':
    case 'whenHead':
    case 'isHead':
    case 'branchHead':
    case 'askHead':
    case 'hiddenHead':
    case 'loopHead':
    case 'catchHead':
    case 'dataHead':
    case 'menuHead':
    case 'randomHead':
    case 'groupHead':
    case 'heartHead':
    case 'colorHead':
    case 'functionHead':
    case 'choiceHead':
      return true;
    // 行内 `如果 条件： 语句` 没有块体；只有裸块头才开块
    case 'ifHead':
      return kind.inline === '';
    case 'other':
      return kind.block;
    default:
      return false;
  }
}

/** 顶层行里 v1 前端能接住的种类（其余都是"外部行"） */
function isAcceptedTopLevel(kind: V1Kind): boolean {
  switch (kind.kind) {
    case 'blank':
    case 'comment':
    case 'preprocessor':
    case 'skipStart':
    case 'skipEnd':
    case 'rawAt':
    case 'headDecl':
    case 'timingHash':
    case 'timingHead':
    case 'functionHead':
    case 'choiceItem':
      return true;
    default:
      return false;
  }
}

function classifyLine(line: V1Line): V1Kind | null {
  if (isBlankBody(line.body)) return null;
  return classifyV1(line.body).kind;
}

/** 上方最近的、比 `line` 更浅的非空行（块头候选） */
function parentOf(lines: readonly V1Line[], index: number): { line: V1Line; kind: V1Kind } | null {
  const target = lines[index]!;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = lines[i]!;
    const kind = classifyLine(candidate);
    if (kind === null) continue;
    if (candidate.indent < target.indent) return { line: candidate, kind };
  }
  return null;
}

/**
 * 定位 v1 `indent-mismatch` 的成因。
 *
 * @param source 输入原文（可带 BOM）
 * @param line   v1 诊断给出的 1 基行号
 * @returns 成因；`null` = 这一行看不出缩进类问题（原码可能来自别的判据）
 */
export function diagnoseV1IndentMismatch(source: string, line: number): V1IndentFinding | null {
  const read = readSource(source);
  if (line < 1 || line > read.lines.length) return null;
  if (read.bom && line === 1) {
    return {
      cause: 'bom-first-line',
      line: 1,
      detail: detailOf('bom-first-line', 1, 'BOM 让行首内容不被识别，整行落成顶层正文'),
      repairable: true,
    };
  }
  const target = read.lines[line - 1]!;
  const kind = classifyLine(target);
  if (kind === null) return null;

  // 行内 tab 与空格混用：无论层级都先把这一条摆出来（v1 的缩进口径最脆）
  if (/\t/.test(target.lead) && /[ \u3000]/.test(target.lead)) {
    return {
      cause: 'tab-space-mixed',
      line,
      detail: detailOf('tab-space-mixed', line, `行首「${JSON.stringify(target.lead)}」同时含 tab 与空格`),
      repairable: false,
    };
  }

  if (target.indent === 0) {
    if (isAcceptedTopLevel(kind)) return null;
    return {
      cause: 'top-level-foreign-line',
      line,
      detail: detailOf('top-level-foreign-line', line, `「${clip(target.body)}」不是 v1 认可的顶层行`),
      repairable: false,
    };
  }

  const parent = parentOf(read.lines, line - 1);
  if (parent === null) {
    return {
      cause: 'orphan-body',
      line,
      detail: detailOf('orphan-body', line, `行首缩进 ${target.indent} 级，但上方没有开启的块头`),
      repairable: false,
    };
  }
  if (target.indent > parent.line.indent + 1) {
    return {
      cause: 'indent-jump',
      line,
      detail: detailOf(
        'indent-jump',
        line,
        `父块头第 ${parent.line.number} 行是 ${parent.line.indent} 级，本行 ${target.indent} 级——跳级`,
      ),
      repairable: false,
    };
  }
  if (!opensBlock(parent.kind)) {
    return {
      cause: 'orphan-body',
      line,
      detail: detailOf('orphan-body', line, `上方第 ${parent.line.number} 行「${clip(parent.line.body)}」不是块头`),
      repairable: false,
    };
  }
  if (leadKind(target.lead) !== leadKind(parent.line.lead)) {
    return {
      cause: 'tab-space-mixed',
      line,
      detail: detailOf(
        'tab-space-mixed',
        line,
        `父块头第 ${parent.line.number} 行用${leadKind(parent.line.lead) === 'tab' ? ' tab' : '空格'}，本行用${
          leadKind(target.lead) === 'tab' ? ' tab' : '空格'
        }`,
      ),
      repairable: false,
    };
  }
  return {
    cause: 'block-body-mismatch',
    line,
    detail: detailOf('block-body-mismatch', line, `父块头第 ${parent.line.number} 行「${clip(parent.line.body)}」不接受这一行`),
    repairable: false,
  };
}

/**
 * 只做**机械唯一解**修复：剥掉首行 BOM。
 *
 * 不做的事（都维持 blocked，不猜）：
 * - 顶层外部行（`# 版本` / 2.0 专有行）——删行/改词都是语义决策；
 * - 块缩进跳级 / tab-space 混用——同形多解，统一缩进可能改变块归属。
 */
export function repairV1Source(source: string): V1SourceRepairResult {
  if (!source.startsWith('\uFEFF')) return { code: source, repairs: [] };
  return {
    code: source.slice(1),
    repairs: [
      {
        cause: 'bom-first-line',
        line: 1,
        detail: detailOf('bom-first-line', 1, '已剥除首行 BOM（编码事实另行记账，不改任何行语义）'),
      },
    ],
  };
}
