/**
 * 口上 XML 的诊断面（未知属性 / 枚举越界 / 正文为空）。
 *
 * 归属与纪律同 `kojo-xml-providers.ts`：本文件只做**通用 XML 结构判据**，
 * 属性枚举与 `com` 编号一律查 `currentKojoXmlSchema()` 交来的规格表。
 *
 * 判据口径：只报**可证明**的问题（错一个字符就能说清的那种），风格偏好一律不报
 * ——误报比漏报更伤作者信任。四条边界是刻意的：
 * 1. **只查 `<command …>` 这一层**：同目录还有 `<parts>` / `<color>` / `<quest>` 等
 *    元素，它们的属性（`layer` / `r` / `questId` …）不在口上属性表里，一律不查；
 * 2. **只查标了 `closed: true` 的枚举**：恋爱状态、情绪这类取值域会随游戏版本长，
 *    当封闭集报错等于替游戏宣布"这个值不存在"；
 * 3. **不报"缺 com"**：真语料里 61,545 条 `<command>` 中有 9,595 条没有 `com`
 *    （`name="実行"` 这类），那是合法写法，不是缺陷；
 * 4. **不查"同 key 重复"**：eraFL 语料里同 `com`+`kojoPlace`+`priority` 多条是
 *    **随机变体**的常态（实测 44,809 / 61,562 条、279/293 份文件），属性逐字相同
 *    而台词不同（`1001_汎用_クール/KOJO_K1001_COM.xml` 第 6、9 行即此形态）。
 *    判据在这里只能制造噪声。真要查"复制粘贴残留"必须比正文，那是解析器层的活，
 *    不是逐行扫描器能做的。
 */
import type * as Monaco from './entry';
import type { KojoXmlSchema } from '@kojo/plugin-api';
import { attrsOnLine, currentKojoXmlSchema } from './kojo-xml-providers';

export interface KojoXmlProblem {
  /** 1 基行 */
  readonly line: number;
  /** 1 基起止列（`endColumn` 不含） */
  readonly startColumn: number;
  readonly endColumn: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
}

/** 编辑距离上限：只用来"提个醒"，不追求最优编辑脚本 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 最像的候选（距离 ≤ 2 才给，否则 null） */
function nearest(word: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= 2 ? best : null;
}

/** 一行里 `<command …>` 的开始位置（不是 command 行 = -1） */
function commandTagStart(line: string): number {
  const idx = line.indexOf('<command');
  if (idx < 0) return -1;
  const next = line.charAt(idx + '<command'.length);
  // `<command_>` / `<commandx` 这类拼写不是命令标签，交给解析器的诊断
  return next === '' || next === ' ' || next === '>' || next === '\t' ? idx : -1;
}

/**
 * 纯函数：整份文本 → 问题列表（按行列升序）。
 *
 * 输入是**行数组**而不是 Monaco model，这样测试与真实编辑器走同一条判据。
 */
export function checkKojoXmlText(
  lines: readonly string[],
  schema: KojoXmlSchema | null,
): KojoXmlProblem[] {
  const problems: KojoXmlProblem[] = [];
  if (!schema) return problems;
  const known = schema.attributes.map((a) => a.name);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // ---- 正文为空（作者漏写台词：引擎会输出空行，排查成本极高） ----
    if (/<contents>\s*<\/contents>/.test(line)) {
      const start = line.indexOf('<contents>') + 1;
      problems.push({
        line: lineNo,
        startColumn: start,
        endColumn: start + '<contents>'.length,
        severity: 'info',
        code: 'kojo-xml.contents.empty',
        message: '这一条口上的正文是空的（引擎会输出空行）。',
      });
    }

    if (commandTagStart(line) < 0) continue;
    const attrs = attrsOnLine(line);

    for (const attr of attrs) {
      const spec = schema.attributes.find((a) => a.name === attr.name);
      if (!spec) {
        const hint = nearest(attr.name, known);
        problems.push({
          line: lineNo,
          startColumn: attr.nameStart + 1,
          endColumn: attr.nameEnd + 1,
          severity: 'warning',
          code: 'kojo-xml.attr.unknown',
          message:
            hint === null
              ? `未知属性 \`${attr.name}\`：引擎会忽略它。`
              : `未知属性 \`${attr.name}\`，是不是 \`${hint}\`？`,
        });
        continue;
      }
      if (!spec.closed || !spec.values || spec.values.length === 0) continue;

      // 多值属性按逗号切（`LOVER,SLAVED_BY` / `怒,悲,恐`），`!` 前缀是取反
      const allowed = new Set(spec.values.map((v) => v.toLowerCase()));
      for (const raw of attr.value.split(',')) {
        const token = raw.trim().replace(/^!/, '');
        if (token.length === 0) continue;
        if (allowed.has(token.toLowerCase())) continue;
        problems.push({
          line: lineNo,
          startColumn: attr.valueStart + 1,
          endColumn: attr.valueEnd + 1,
          severity: 'warning',
          code: 'kojo-xml.attr.value',
          message: `\`${attr.name}\` 不接受 \`${token}\`；可用：${spec.values.slice(0, 8).join(' / ')}`,
        });
        break; // 一行一个属性只报一次，免得一个错值刷三条
      }
    }
  }

  return problems;
}

let registered = false;

/** 挂上诊断面（幂等）。marker owner 固定 `kojo-xml`，同一 model 重算即覆盖。 */
export function registerKojoXmlDiagnostics(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  const LANGUAGE = 'kojo-xml';
  const OWNER = 'kojo-xml';
  /** model → 去抖定时器（同一 model 连打字只算最后一次） */
  const timers = new Map<Monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
  /** 已挂监听的 model（`onDidCreateModel` 与"已存在"两条路都要挂，且只挂一次） */
  const watched = new WeakSet<Monaco.editor.ITextModel>();

  const run = (model: Monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== LANGUAGE) return;
    const lines: string[] = [];
    for (let i = 1; i <= model.getLineCount(); i++) lines.push(model.getLineContent(i));
    const problems = checkKojoXmlText(lines, currentKojoXmlSchema());
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      problems.map((p) => ({
        severity:
          p.severity === 'error' ? 8 /* MarkerSeverity.Error */ : p.severity === 'warning' ? 4 : 1,
        message: p.message,
        code: p.code,
        startLineNumber: p.line,
        startColumn: p.startColumn,
        endLineNumber: p.line,
        endColumn: Math.max(p.endColumn, p.startColumn + 1),
      })),
    );
  };

  const schedule = (model: Monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== LANGUAGE) return;
    const pending = timers.get(model);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      model,
      setTimeout(() => {
        timers.delete(model);
        run(model);
      }, 350),
    );
  };

  /**
   * 内容变化订阅是**按 model** 的（Monaco 没有全局 `onDidChangeModelContent`）：
   * 全局那层只有 `onDidCreateModel`，所以"创建时挂监听 + 创建时先算一遍"是同一处。
   */
  const attach = (model: Monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== LANGUAGE) return;
    run(model);
    if (watched.has(model)) return;
    watched.add(model);
    model.onDidChangeContent(() => schedule(model));
  };

  for (const model of monaco.editor.getModels()) attach(model);
  monaco.editor.onDidCreateModel((model) => attach(model));
}
