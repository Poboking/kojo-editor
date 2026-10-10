/**
 * 引擎内置·通用规则：语法糖侧可静态判定的约定（规范 §8「lint 规则」子集）。
 *
 * **零游戏知识**——只做 `.kojo` 表层文本的结构扫描（缩进/关键字/引号/插值），
 * 不依赖任何游戏字典或适配器，任何符合表层规范的项目都适用，因此住在引擎插件自身。
 *
 * 覆盖规范 §8 中"糖文本行里新增"的可静态判定项（实现为纯文本扫描，不依赖
 * kojo-sugar 插件的转译器——避免插件交叉依赖，且这些判据在**未编译**的源文本上
 * 就能确定）：
 *   1. `续`（不等待标记）写在引号内 —— 规范 §3.3（标记必须在引号/句号之外）
 *   2. 同一时机出现多个 `选项` 块 —— 规范 §3.7（每时机只允许一个，且不嵌套）
 *   3. 表达式 `如果` / `当` 缺 `否则` —— 规范 §3.5 / §3.6（左值会存在未赋值路径）
 *   4. 只读别名（字面量 / 角色）作赋值左值 —— 规范 §5.0（只读别名不可写）
 *
 * 设计取舍：这些判据只做**保守**的静态近似——宁可漏报（交由转译器的精确诊断），
 * 不可误报。缩进用空格数近似层级（制表符按 4 空格折算），与转译器的配对规则一致。
 */

import type { ConventionIssue, ConventionRule } from '@kojo/plugin-api';

/* ============================== 共享扫描工具 ============================== */

/** 逻辑行：原文 + 1 基行号 + 缩进（制表符折算 4 空格） */
interface ScanLine {
  readonly text: string;
  readonly raw: string;
  readonly line: number;
  readonly indent: number;
}

const TAB_WIDTH = 4;

function indentOf(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += TAB_WIDTH;
    else break;
  }
  return n;
}

/** `;` 起为行注释；`//` 亦然（表层规范同时接受）；返回去掉注释后的正文原样 */
function stripLineComment(raw: string): string {
  // 简单实现：引号外的首个 `;` 或 `//` 截断。引号内不视为注释。
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === '「' || ch === '『' || ch === '“' || ch === '"') {
      inQuote = true;
      quoteChar = ch === '「' ? '」' : ch === '『' ? '』' : ch === '“' ? '”' : '"';
      continue;
    }
    if (ch === ';') return raw.slice(0, i);
    if (ch === '/' && raw[i + 1] === '/') return raw.slice(0, i);
  }
  return raw;
}

function scanLines(source: string): ScanLine[] {
  const rawLines = source.split(/\r\n|\n|\r/);
  const out: ScanLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    out.push({
      text: stripLineComment(raw).trim(),
      raw,
      line: i + 1,
      indent: indentOf(raw),
    });
  }
  return out;
}

/** 是否是块头行（去掉行尾注释后以全角/半角冒号收尾，且冒号后仅空白） */
function endsWithBlockColon(text: string): boolean {
  return /[:：]\s*$/.test(text);
}

/** 是否是原生直通行（全大写指令 / `$标签`）——糖规则一律跳过 */
function isRawLine(text: string): boolean {
  if (text.length === 0) return false;
  if (text.startsWith('$')) return true;
  // 全大写指令：首词全部由 A-Z / 数字 / 下划线 组成且至少一个字母
  const first = text.split(/\s+/)[0] ?? '';
  return /^[A-Z][A-Z0-9_]*$/.test(first);
}

/** 是否是执行块（`@` 起）——糖规则跳过整块 */
function isRawBlockStart(text: string): boolean {
  return text.startsWith('@');
}

/** 从行文本里剥掉块头冒号（末尾） */
function stripBlockColon(text: string): string {
  return text.replace(/[:：]\s*$/, '').trim();
}

/* ============================== 规则 1：`续` 写在引号内（§3.3） ============================== */

export const CONT_INSIDE_QUOTES_RULE_ID = 'sugar.cont-inside-quotes';

/** `续` 的隐藏别名（规范 §3.3） */
const CONT_MARKS = ['续', '~', '⏎', 'cont', 'continue'] as const;

/**
 * 判据：一行文本里，若某个引号对的**内部**恰好以 `续`/`~`/`cont` 等标记收尾，
 * 即判为"续标记写在引号内"。标记写在引号外是正确写法（§3.3）。
 *
 * 保守：只在标记紧贴右引号（忽略尾随空白）时判定，避免把台词里的"续"当误报。
 */
function checkContInsideQuotes(lines: ScanLine[], filePath: string): ConventionIssue[] {
  const issues: ConventionIssue[] = [];
  for (const ln of lines) {
    const text = ln.text;
    if (text.length === 0 || isRawLine(text) || isRawBlockStart(text) || text.startsWith(';')) {
      continue;
    }
    // 收集引号对（「」/｢｣/『』/“”/"")
    const pairs: { open: string; close: string }[] = [
      { open: '「', close: '」' },
      { open: '｢', close: '｣' },
      { open: '『', close: '』' },
      { open: '“', close: '”' },
    ];
    for (const { open, close } of pairs) {
      let i = text.indexOf(open);
      while (i >= 0) {
        const j = text.indexOf(close, i + 1);
        if (j < 0) break;
        const inner = text.slice(i + 1, j);
        const trimmed = inner.replace(/\s+$/u, '');
        for (const mark of CONT_MARKS) {
          if (trimmed.endsWith(mark) && trimmed.length > mark.length) {
            issues.push({
              ruleId: CONT_INSIDE_QUOTES_RULE_ID,
              severity: 'error',
              message: `「续」标记写在了引号内（\`…${mark}${close}\`）：不等待标记必须在引号之外（规范 §3.3）。正确写法：\`${open}…${close} ${mark}\``,
              filePath,
              line: ln.line,
              key: `${CONT_INSIDE_QUOTES_RULE_ID}|${filePath}|${ln.line}|${i}`,
            });
            break;
          }
        }
        i = text.indexOf(open, j + 1);
      }
    }
  }
  return issues;
}

/* ============================== 规则 2：每时机多个 `选项` 块（§3.7） ============================== */

export const MULTIPLE_CHOICE_BLOCKS_RULE_ID = 'sugar.multiple-choice-blocks';

/** 是否是 `选项` / `choice` 块头 */
function isChoiceHead(text: string): boolean {
  if (!endsWithBlockColon(text)) return false;
  const body = stripBlockColon(text);
  return body === '选项' || body === 'choice';
}

/** 是否是时机块头（`时机 …：` / `timing …：`）——只统计时机体内 */
function isTimingHead(text: string): boolean {
  if (!endsWithBlockColon(text)) return false;
  const body = stripBlockColon(text);
  return /^(时机|timing)(\s|$)/.test(body);
}

/**
 * 判据：在同一时机块体内（缩进深于时机头），出现 ≥2 个 `选项` 块头即报错。
 * 嵌套 `选项` 块会同时体现为 ≥2，故一并覆盖（规范 §3.7 两者都禁）。
 */
function checkMultipleChoiceBlocks(lines: ScanLine[], filePath: string): ConventionIssue[] {
  const issues: ConventionIssue[] = [];
  let timingIndent = -1;
  let choiceCount = 0;
  let firstChoiceLine = 0;

  const flush = (): void => {
    if (choiceCount > 1) {
      issues.push({
        ruleId: MULTIPLE_CHOICE_BLOCKS_RULE_ID,
        severity: 'error',
        message: `同一时机内出现 ${choiceCount} 个「选项」块：每个时机只允许一个，且不允许嵌套（规范 §3.7；多个 INPUTS 共用引擎约定的 RESULTS）。多轮选择请用原生直通 \`$标签\`+\`GOTO\`，或拆成两个时机。首个「选项」在第 ${firstChoiceLine} 行。`,
        filePath,
        line: firstChoiceLine,
        key: `${MULTIPLE_CHOICE_BLOCKS_RULE_ID}|${filePath}|${firstChoiceLine}`,
      });
    }
    choiceCount = 0;
    firstChoiceLine = 0;
  };

  for (const ln of lines) {
    if (ln.text.length === 0) continue;
    if (timingIndent >= 0 && ln.indent <= timingIndent) {
      flush();
      timingIndent = -1;
    }
    if (isTimingHead(ln.text)) {
      flush();
      timingIndent = ln.indent;
      continue;
    }
    if (timingIndent >= 0 && ln.indent > timingIndent && isChoiceHead(ln.text)) {
      if (choiceCount === 0) firstChoiceLine = ln.line;
      choiceCount++;
    }
  }
  flush();
  return issues;
}

/* ===================== 规则 3：表达式 如果 / 当 缺 否则（§3.5 / §3.6） ===================== */

export const EXPR_MISSING_ELSE_RULE_ID = 'sugar.expr-missing-else';

/** 表达式 `如果` 头：行首是 `左值 =`，右侧以 `如果`/`if` 开头，行尾块头冒号 */
function isExprIfHead(text: string): boolean {
  if (!endsWithBlockColon(text)) return false;
  const body = stripBlockColon(text);
  const eq = body.indexOf('=');
  if (eq < 0) return false;
  const rhs = body.slice(eq + 1).trim();
  return /^(如果|if)(\s|$)/.test(rhs);
}

/** 表达式 `当` 头：行首是 `左值 =`，右侧以 `当`/`when` 开头，行尾块头冒号 */
function isExprWhenHead(text: string): boolean {
  if (!endsWithBlockColon(text)) return false;
  const body = stripBlockColon(text);
  const eq = body.indexOf('=');
  if (eq < 0) return false;
  const rhs = body.slice(eq + 1).trim();
  return /^(当|when)(\s|$)/.test(rhs);
}

/**
 * 判据：表达式 `如果` / `当` 的块体内（缩进更深）未出现 `否则` 分支即报错。
 * 表达式形态必须有 `否则`，否则左值存在未赋值路径（§3.5 / §3.6）。
 *
 * `当` 的 `否则` 分支形如 `否则 -> 值`；`如果` 的形如 `否则：`。两者都含 `否则`/`else`。
 */
function checkExprMissingElse(lines: ScanLine[], filePath: string): ConventionIssue[] {
  const issues: ConventionIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const kind = isExprIfHead(ln.text) ? '如果' : isExprWhenHead(ln.text) ? '当' : null;
    if (!kind) continue;
    // 从下一行起扫块体：
    //   - `如果` 的 `否则` 分支头与块头**同级**（缩进相同）；
    //   - `当` 的 `否则 -> 值` 分支在块体内（缩进更深）。
    // 故接受"缩进 ≥ 块头"的 `否则`，遇到更浅的行则结束本块。
    let hasElse = false;
    for (let j = i + 1; j < lines.length; j++) {
      const sub = lines[j]!;
      if (sub.text.length === 0) continue;
      if (sub.indent < ln.indent) break;
      if (/^(否则|else)(\s|[:：]|->|$)/.test(sub.text)) {
        hasElse = true;
        break;
      }
      // 同级但不是 `否则`（新的语句 / 新块头）→ 本表达式块已结束
      if (sub.indent === ln.indent) break;
    }
    if (!hasElse) {
      issues.push({
        ruleId: EXPR_MISSING_ELSE_RULE_ID,
        severity: 'error',
        message: `表达式「${kind}」缺少「否则」分支：目标变量在有的路径上不会被赋值（规范 §3.5 / §3.6）。请补上「否则」。`,
        filePath,
        line: ln.line,
        key: `${EXPR_MISSING_ELSE_RULE_ID}|${filePath}|${ln.line}`,
      });
    }
  }
  return issues;
}

/* ============== 规则 4：只读别名作赋值左值（§5.0 + §3.1） ============== */

export const READONLY_ALIAS_ASSIGN_RULE_ID = 'sugar.readonly-alias-assign';

/** `别名 X = 目标` 声明（规范 §3.1） */
interface AliasEntry {
  readonly name: string;
  readonly readonlyAlias: boolean;
  readonly line: number;
}

/** 判断别名右值是否只读：字面量（数字 / 引号字符串）或 `角色` 引用（§5.0） */
function isReadonlyAliasTarget(target: string): boolean {
  const t = target.trim();
  if (/^-?\d+$/.test(t)) return true; // 数字字面量
  if (/^".*"$/.test(t)) return true; // 字符串字面量
  if (/^「.*」$/.test(t)) return true; // 全角引号字符串
  if (/^角色[:：]/.test(t)) return true; // 角色引用
  if (/^character[:：]/i.test(t)) return true;
  return false;
}

/** 解析 `别名 X = 目标` 行 */
function parseAliasDecl(text: string, line: number): AliasEntry | null {
  const m = /^(别名|alias)\s+(.+)$/.exec(text);
  if (!m) return null;
  const rest = m[2]!;
  const eq = rest.indexOf('=');
  if (eq < 0) return null;
  const name = rest.slice(0, eq).trim();
  const target = rest.slice(eq + 1).trim();
  if (name.length === 0 || target.length === 0) return null;
  return { name, readonlyAlias: isReadonlyAliasTarget(target), line };
}

/** 赋值左值：`左值 = …`（排除 `==` 比较、`别名` 声明行、头部声明） */
function assignTarget(text: string): string | null {
  if (/^(别名|alias)\s/.test(text)) return null;
  // 头部声明 `词: 值`（词与冒号间无空白）不是赋值
  if (/^[^:：\s=]+\s*[:：]/.test(text) && !/^[^:：\s=]+\s*=/.test(text)) return null;
  // `左值 = …`，左值不含空白（连续表达式/比较用 `==` 区分）
  const m = /^([^\s=<>!]+)\s*=(?!=)/.exec(text);
  return m ? m[1]! : null;
}

/**
 * 判据：把同一文件内的只读别名（字面量 / 角色）当作赋值左值即报错（规范 §5.0）。
 * 只读别名可作**右值**参与运算，但不可作左值写入。
 *
 * 说明：这是保守的**文本级**近似——只比对同一文件内声明的别名名。
 */
function checkReadonlyAliasAssign(lines: ScanLine[], filePath: string): ConventionIssue[] {
  const issues: ConventionIssue[] = [];
  // 第一遍：收集只读别名（同一文件内）
  const readonlyNames = new Map<string, AliasEntry>();
  const allNames = new Set<string>();
  for (const ln of lines) {
    if (ln.text.length === 0 || isRawLine(ln.text) || isRawBlockStart(ln.text)) continue;
    const decl = parseAliasDecl(ln.text, ln.line);
    if (!decl) continue;
    allNames.add(decl.name);
    if (decl.readonlyAlias) readonlyNames.set(decl.name, decl);
  }
  if (readonlyNames.size === 0) return issues;

  // 第二遍：找用只读别名作左值的赋值行
  for (const ln of lines) {
    if (ln.text.length === 0 || isRawLine(ln.text) || isRawBlockStart(ln.text)) continue;
    const target = assignTarget(ln.text);
    if (!target) continue;
    const decl = readonlyNames.get(target);
    if (!decl) continue;
    issues.push({
      ruleId: READONLY_ALIAS_ASSIGN_RULE_ID,
      severity: 'error',
      message: `只读别名「${target}」被用作赋值左值：它绑定的是${
        /^-?\d+$/.test(decl.name) ? '字面量' : '字面量/角色'
      }，不可写入（规范 §5.0）。只读别名只能作右值；需要可写请绑定变量（如 \`别名 ${target} = CFLAG:TARGET:…\`）。`,
      filePath,
      line: ln.line,
      key: `${READONLY_ALIAS_ASSIGN_RULE_ID}|${filePath}|${ln.line}`,
    });
  }
  return issues;
}

/* ============================== 规则导出 ============================== */

/**
 * 合并成一条引擎规则（单一 `check`，内部跑四项扫描后再统一返回）。
 *
 * 之所以合成一条而不是四条：引擎的 `ruleCount` 进报告与 UI，四项都是"糖侧静态约定"，
 * 归为一条语义单元（`sugar.static-conventions`）更贴合"一条约定一块"的报告口径；
 * 每条 issue 仍带各自细分的 `ruleId`，UI 可按 `ruleId` 再分组。
 */
export const SUGAR_STATIC_CONVENTIONS_RULE_ID = 'sugar.static-conventions';

export const sugarStaticConventionsRule: ConventionRule = {
  id: SUGAR_STATIC_CONVENTIONS_RULE_ID,
  description:
    '语法糖侧静态约定（规范 §8 子集）：`续` 标记写在引号内、每时机多个「选项」块、表达式 `如果`/`当` 缺「否则」、只读别名作赋值左值',
  severity: 'error',
  source: 'docs/SYNTAX-SUGAR-SURFACE-SPEC.md §3.3 / §3.7 / §3.5 / §3.6 / §5.0 / §8',
  async check(ctx): Promise<ConventionIssue[]> {
    const issues: ConventionIssue[] = [];
    for (const file of ctx.index.files.values()) {
      const path = file.path;
      // 仅糖源文件参与（`.kojo`）——原生 `.ERB` 不适用这些约定
      if (!/\.kojo$/i.test(path)) continue;
      let text: string;
      try {
        text = await ctx.readFile(path);
      } catch (err) {
        // 读失败不静默：记日志并跳过该文件（引擎会把整条规则的抛错计入 failedRules，
        // 但这里是单文件级失败，跳过比让整条规则失败更符合"不伪造结果"的本意）
        ctx.log.warn(`sugar conventions: 读取 ${path} 失败，跳过：${String(err)}`);
        continue;
      }
      const lines = scanLines(text);
      issues.push(
        ...checkContInsideQuotes(lines, path),
        ...checkMultipleChoiceBlocks(lines, path),
        ...checkExprMissingElse(lines, path),
        ...checkReadonlyAliasAssign(lines, path),
      );
    }
    return issues;
  },
};
