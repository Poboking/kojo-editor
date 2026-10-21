/**
 * 引擎字面量编码器（**本包唯一入口**）——心形 `CALL HPH_PRINT(@"…")` 与字符串值
 * `RESULTS = "…"` 共用同一份转义，禁止逐处手写。
 *
 * ## 为什么必须只有一个入口
 * 任何作者文本进入 `"…"` / `@"…"` 的路径都走这里：两处各写一份转义 = 两份会漂移的
 * 判据，迟早一条路径把 `"` 或 `\` 漏进产物（心形曾整段裸拼：提示里的半角双引号
 * 直接**截断** `@"…"` 字面量，产物不可加载）。
 *
 * ## 规则（逐条对应引擎语义）
 * - `\` → `\\`：引擎的 ReadString / 格式化串把 `\` 当转义引导符（吃掉自己后再看下一个
 *   字符：`\n` / `\s` / `\@…\@` 都是引擎记号）。不双写的话 `心形 「C:\存档」` 里的
 *   `\存` 会被吃掉一个字符，行尾的 `\` 还会吞掉收尾引号 ⇒ 整行不可加载。
 * - `"` → `＂`（U+FF02）：引擎的 `"` 不能内嵌，**没有 `\"` 这种可依赖写法**——旧缺陷
 *   用 `JSON.stringify` 产出的 `\"` 在 ERB 里无法加载（`label-escaping` 批已定全角
 *   降级为唯一出路）。无 `"` 时逐字节不变（golden 不受扰动）。
 * - U+0000 / U+000D / 未配对代理项：引擎里**根本表达不了**（`\0` 抛错、CR 断行、
 *   非法 UTF-16）⇒ **fail-closed**：`ok:false` + 事实列表，调用方**不得发射任何
 *   字节**并报 error——既不静默丢字符，也不把坏字节写进产物。
 *
 * 纯函数、零 IO、零依赖。
 */

/** 引擎字面量装不下的三类事实（闭集；新增必须同时改头注与 {@link describeErbLiteralFailure}） */
export type ErbLiteralFailureReason = 'nul' | 'carriage-return' | 'unpaired-surrogate';

export interface ErbLiteralFailure {
  readonly reason: ErbLiteralFailureReason;
  /** 作者文本内的 UTF-16 偏移（0 基码元） */
  readonly offset: number;
  /** 出问题的码元（未配对代理项给出 `U+XXXX`） */
  readonly char: string;
}

export interface ErbTextEncoding {
  /** `false` = 有装不下的字符；`body` 只含可安全表达的字符（调用方不得发射） */
  readonly ok: boolean;
  /** 无引号的文本体（已转义） */
  readonly body: string;
  readonly failures: readonly ErbLiteralFailure[];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 作者文本 → 引擎文本体（无引号、已转义）。
 *
 * **不抛错**：装不下的字符进 `failures`（不进 `body`），是否发射由调用方按
 * fail-closed 决定（本包口径：报 error、本行不产字节）。
 */
export function encodeErbText(value: string): ErbTextEncoding {
  const out: string[] = [];
  const failures: ErbLiteralFailure[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0000) {
      failures.push({ reason: 'nul', offset: i, char: 'U+0000' });
      continue;
    }
    if (code === 0x000d) {
      failures.push({ reason: 'carriage-return', offset: i, char: 'U+000D' });
      continue;
    }
    if (isHighSurrogate(code)) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (!isLowSurrogate(next)) {
        failures.push({ reason: 'unpaired-surrogate', offset: i, char: `U+${code.toString(16).toUpperCase()}` });
        continue;
      }
      // 合法代理对：原样追加（引擎按 UTF-16 码元处理，不经手就不会坏）
      out.push(value[i]!, value[i + 1]!);
      i++;
      continue;
    }
    if (isLowSurrogate(code)) {
      failures.push({ reason: 'unpaired-surrogate', offset: i, char: `U+${code.toString(16).toUpperCase()}` });
      continue;
    }
    const ch = value[i]!;
    if (ch === '\\') out.push('\\\\');
    else if (ch === '"') out.push('＂');
    else out.push(ch);
  }
  return { ok: failures.length === 0, body: out.join(''), failures };
}

/** 普通串 `"…"`（字符串值 / 标签 / RESULTS 用；`"` 已内降为全角） */
export function quotedErbLiteral(body: string): string {
  return `"${body}"`;
}

/** 格式串 `@"…"`（心形 `HPH_PRINT` 用；`body` 必须来自 {@link encodeErbText}） */
export function formattedErbLiteral(body: string): string {
  return `@"${body}"`;
}

/**
 * 作者文本 → 普通串字面量 `"…"`。
 *
 * 装不下的字符**不在这里报**（本函数没有 sink）：调用方若需要 fail-closed，先用
 * {@link encodeErbText} 拿 `failures` 自己报，再拼引号。这条便捷通道只服务
 * 「文本里不可能出现 NUL/CR」的既有调用点（保持旧行为逐字节不变）。
 */
export function erbStringLiteral(value: string): string {
  return quotedErbLiteral(encodeErbText(value).body);
}

/** 失败事实 → 作者可读的一句话（诊断文案用） */
export function describeErbLiteralFailure(failure: ErbLiteralFailure): string {
  switch (failure.reason) {
    case 'nul':
      return 'U+0000（NUL）——引擎的字符串 / 格式化串遇到它直接终止或抛错';
    case 'carriage-return':
      return '回车符 U+000D——单行字面量装不下它';
    case 'unpaired-surrogate':
      return `未配对的 UTF-16 代理项（${failure.char}）——源文本不是合法 UTF-16，落盘必被替换`;
  }
}
