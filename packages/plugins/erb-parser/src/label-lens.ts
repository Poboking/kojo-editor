import type { EditorCodeLens, EditorSymbolLocation, ErbFile, ErbLabel } from '@kojo/plugin-api';
import { JUMP_FAMILY } from './symbols';
import { visibleCodeLines } from './references';

/**
 * `$` 标签行上注解（T12，2026-10-16 erb-deep 批）：**这个标签在函数内被跳了几次**。
 *
 * 与函数行的「被 N 处用到」（`usage-lens.ts`）同一呈现面、同一宿主预算，只是判据不同：
 * 标签是**函数局部作用域**（契约 `ErbLabel.functionStartLine`），引用 = 同一函数内
 * `JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO` 行首关键字后的**裸**标签名（`JUMP_FAMILY`
 * 单一真源在 `symbols.ts`——转到定义的标签腿用它，这里逐字复用，不开第二把尺子；
 * 漂移的表现会是"转定义跳得过去、引用数却是 0"）。
 *
 * 判据边界（fail-open / 错标比不标危险）：
 * - 名字与关键字之间有非空白字符（`TRYGOTOFORM` 那类动态形态本就不在
 *   `JUMP_FAMILY` 里；槽位不裸 = 不算）；
 * - 变量成员访问（`:` 紧邻）不算标签名；
 * - 注释、字符串内容、`[SKIPSTART]` 区、`$` / `@` / `#` 行由 `visibleCodeLines`
 *   的屏蔽面统一挡掉；
 * - 跨函数的 `JUMP 同名` 不算（标签不是全局的——引擎语义）。
 *
 * **0 引用也开口**（与函数注解的"没人调用不说"刻意不同）：标签引用面是**可证明闭集**
 * （跳转只可能是 JUMP 系裸名，没有 `*CALLFORM` / CSV 派发那种口径外的形态），
 * "未引用"是确定事实而不是"证明不了"——它对作者的含义是"可清理"，正是这条注解的价值。
 * 删除动作不做（那是 Quick Fix 的领地，本条只说事实）。
 *
 * 纯函数：缓冲区进、注解出；标签是本文件事实（`parseErbText` 的 `labels`），
 * 项目索引零参与——与文档大纲 / 标签转定义同款口径。
 */

/** 一个标签的引用聚合（按"处"计：同一条 JUMP 行算一处） */
interface LabelAgg {
  count: number;
  seenLines: Set<number>;
  first?: EditorSymbolLocation;
}

/** 聚合键：函数局部作用域 ⇒ (所属函数定义行, 归一化标签名) */
const labelKey = (functionStartLine: number, upperName: string): string =>
  `${functionStartLine}\u0000${upperName}`;

/**
 * 单文件的标签行上注解（**纯函数**）。
 * `file` 来自 `parseErbText`（脏缓冲跟着编辑走），`text` 是同一份缓冲区文本。
 */
export function labelLenses(file: ErbFile, text: string): EditorCodeLens[] {
  const labels = file.labels;
  if (!labels || labels.length === 0 || text.length === 0) return [];
  // 定义表：键 → 标签（跳转扫描只认"确实定义过的"，未定义跳转目标不归本条管）
  const defined = new Map<string, ErbLabel>();
  for (const l of labels) defined.set(labelKey(l.functionStartLine, l.name.toUpperCase()), l);
  const aggs = new Map<string, LabelAgg>();

  /** 1 基行 → 所属函数定义行（`@` 行按序遍历时维护；第一个 `@` 之前 = -1） */
  const startByLine = new Map<number, number>();
  for (const fn of file.functions) startByLine.set(fn.startLine, fn.startLine);
  let currentFuncStart = -1;

  for (const { line, raw, codeView, isDefinition } of visibleCodeLines(text)) {
    if (isDefinition) {
      const s = startByLine.get(line);
      if (s !== undefined) currentFuncStart = s;
      continue;
    }
    // 行首 JUMP 系判定（与 symbols.ts 的 jumpKeywordEndOf 同一写法、同一张表）
    const indent = raw.length - raw.trimStart().length;
    const lead = /^[A-Za-z_]+/.exec(raw.slice(indent));
    if (!lead || !JUMP_FAMILY.has(lead[0]!.toUpperCase())) continue;
    const keywordEnd = indent + lead[0]!.length;
    // 代码视野是惰性方法（2026-10-16 LS-R6 批）：只在确定是跳转行时才付这趟钱
    const code = codeView();
    // 槽位 = 关键字后的第一个记号，且与关键字之间只许空白（裸名；动态形态不猜）
    const tokenRe = /[\p{L}\p{N}_]+/gu;
    tokenRe.lastIndex = keywordEnd;
    const m = tokenRe.exec(code);
    if (m === null) continue;
    if (!/^[\t \u3000]*$/.test(code.slice(keywordEnd, m.index))) continue;
    // 成员访问占槽：`:` 紧邻的记号是变量世界，不是标签名
    const prev = code[m.index - 1];
    const next = code[m.index + m[0]!.length];
    if (prev === ':' || prev === '：' || next === ':' || next === '：') continue;
    const key = labelKey(currentFuncStart, m[0]!.toUpperCase());
    const label = defined.get(key);
    if (label === undefined) continue; // 跳向未定义标签 / 跨函数同名：不归本条管
    if (currentFuncStart !== label.functionStartLine) continue; // 防御：函数区间外不归
    let agg = aggs.get(key);
    if (agg === undefined) {
      agg = { count: 0, seenLines: new Set() };
      aggs.set(key, agg);
    }
    if (agg.seenLines.has(line)) continue;
    agg.seenLines.add(line);
    agg.count++;
    agg.first ??= { filePath: file.path, line, column: m.index + 1 };
  }

  const out: EditorCodeLens[] = [];
  for (const l of labels) {
    const agg = aggs.get(labelKey(l.functionStartLine, l.name.toUpperCase()));
    const count = agg?.count ?? 0;
    out.push(
      count > 0
        ? { line: l.line, label: `${count} 处引用`, target: agg!.first }
        : { line: l.line, label: '未引用' },
    );
  }
  return out.sort((a, b) => a.line - b.line);
}
