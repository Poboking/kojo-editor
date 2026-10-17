/**
 * SH-3 · 补全热路径**延迟读数**（纯同步、无 IO、无语料、不设 KOJO_SMOKE_PROJECT）。
 *
 * 用**合成数据**量三类热路径的单次延迟（median / p95，ms，N = 300 ≥ 200），断言**有界**
 * （候选条数 ≤ `MAX_ITEMS`、热路径 p95 < 宽松阈值取本机实测的 3–5 倍）；**绝不钉死绝对值**。
 *
 * - (a) **99k 函数名索引**：`new Map()` 塞 ~99,000 个函数名 → 经 `memoizedErbFunctionNames`
 *   （按 `ErbIndex.fingerprint` 记忆化，指纹不变返回**同一数组引用**）+ `erbFunctionCompletionItems`
 *   （按数组身份记忆化的前缀二分索引）在 `CALL <前缀>` 位出货；量「首次调用（排序 + 建索引）」
 *   与「稳态单次（provider 记忆化命中 + 二分）」。
 * - (b) **大文件标签扫描**：~20,000 行 / 400 个 `$标签` 的 `.erb` 文本 → `erbLabelCompletionItems`
 *   在 `GOTO $` 位。冷路径 = `getVersionId` **每次自增**（缓存全失效，每击键重扫全文）；
 *   热路径 = 版本号**不变**（命中 SH-3 的版本记忆化，复用上次数组）。两者差值 = 缓存收益。
 * - (c) **kojo 大文件声明扫描**：~10,000 行 `.kojo` 经 `KOJO_COMPLETION_SOURCES` 走
 *   `installKojoCompletion` 的真实装配点（provider → `mergeSuggestions` 一轮整体延迟；
 *   COMPL-SHARED 起声明名判据 = **解析器**（不再是第二份正则），按 model 版本 / 文本身份记忆化
 *   ⇒ 同一份文本只解析一次，热路径不替全文解析买单）。
 *
 * 桩 monaco / 桩 model 照抄 `erb-completion.test.ts` 口径；桩 model 额外提供 `getVersionId`。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbFunctionRef, ErbIndex } from '@kojo/plugin-api';
import { memoizedErbFunctionNames } from '../src/monaco/erb-completion';
import { erbFunctionCompletionItems } from '../src/monaco/erb-completion-functions';
import { erbLabelCompletionItems } from '../src/monaco/erb-completion-labels';
import { installKojoCompletion, KOJO_COMPLETION_SOURCES } from '../src/monaco/kojo-completion';

/* ============================== 读数工具 ============================== */

/** 一次延迟分位读数（ms） */
interface Latency {
  readonly median: number;
  readonly p95: number;
  readonly runs: number;
}

const N = 300;

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/** 逐次计时跑 `fn`，返回 median / p95（ms） */
function measure(runs: number, fn: () => void): Latency {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return { median: quantile(ds, 0.5), p95: quantile(ds, 0.95), runs };
}

const fmt = (l: Latency): string => `median ${l.median.toFixed(3)} ms / p95 ${l.p95.toFixed(3)} ms（n=${l.runs}）`;

/* ============================== 桩 monaco / 桩 model ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/** 桩 monaco：补全注册链所需最薄面 + 各 kind 常量 */
function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 21 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/** 桩 model：`getValue` / `getLineContent` / `getWordUntilPosition`（+ 可选 `getVersionId`） */
function textModel(text: string, versionId?: () => number): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  const stub: Record<string, unknown> = {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  };
  if (versionId !== undefined) stub.getVersionId = versionId;
  return stub as unknown as Monaco.editor.ITextModel;
}

/** `getVersionId` 每次自增（模拟每次击键都改文档 ⇒ 缓存全失效） */
function bumpingVersion(): () => number {
  let v = 0;
  return () => ++v;
}

const itemLabels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

/* ============================== (a) 99k 函数名索引 ============================== */

function fnRef(name: string): ErbFunctionRef {
  return { name, normalizedName: name, filePath: 'x.ERB', startLine: 1, endLine: 1 };
}

function indexOf(names: readonly string[], fingerprint: string | null): ErbIndex {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const n of names) byName.set(n, [fnRef(n)]);
  return { files: new Map(), byName, fingerprint } as unknown as ErbIndex;
}

const BIG_N = 99_000;
const BIG_NAMES: readonly string[] = Array.from({ length: BIG_N }, (_, i) => `FUNC_${String(i).padStart(6, '0')}`);

describe('SH-3 · (a) 99k 函数名索引：冷建 + 稳态', () => {
  const fnMonaco = { languages: { CompletionItemKind: { Function: 1 } } } as unknown as typeof Monaco;

  it('首次调用（排序 99k + 建前缀索引）vs 稳态单次；候选 ≤ MAX_ITEMS；稳态 p95 有界', () => {
    const idx = indexOf(BIG_NAMES, 'fp-99k'); // 索引只建一次（provider 每次现建 Map 会污染稳态读数）
    const provider = memoizedErbFunctionNames(() => idx);
    const line = 'CALL FUNC_0989'; // 命中 `FUNC_098900..098999` 恰 100 条
    const model = textModel(line);
    const pos = { lineNumber: 1, column: line.length + 1 } as Monaco.Position;

    const t0 = performance.now();
    const names = provider(); // 排序 99k（指纹不变后返回同一引用）
    const cold = erbFunctionCompletionItems(fnMonaco, model, pos, names); // 建前缀二分索引
    const coldMs = performance.now() - t0;

    const warm = measure(N, () => {
      erbFunctionCompletionItems(fnMonaco, model, pos, provider());
    });

    // 稳态命中集与冷启动一致；`FUNC_0999*` 恰 100 条
    expect(erbFunctionCompletionItems(fnMonaco, model, pos, provider())).toHaveLength(100);
    expect(cold).toHaveLength(100);
    expect(provider()).toBe(provider()); // 指纹不变 ⇒ 同一数组引用（索引只建一次）

    // 空前缀 / 极短前缀命中全表 ⇒ 护栏上限（避免造 99k 个对象）
    const broadLine = 'CALL FUNC_';
    const broad = erbFunctionCompletionItems(fnMonaco, textModel(broadLine), {
      lineNumber: 1,
      column: broadLine.length + 1,
    } as Monaco.Position, provider());
    expect(broad.length).toBeLessThanOrEqual(1000);
    expect(broad).toHaveLength(1000);

    console.log(
      `[SH-3 a] 99k 函数名：冷启动(排序+建索引) ${coldMs.toFixed(1)} ms；` +
        `稳态单次 ${fmt(warm)}；命中 100 条（空前缀护栏 1000）`,
    );

    expect(warm.p95).toBeLessThan(5); // 二分 + 命中区间，与总量无关
  });

  it('缓存正确性：指纹变化 ⇒ 新数组引用（索引随之重建）；指纹 null ⇒ 每次重算', () => {
    const stable = memoizedErbFunctionNames(() => indexOf(BIG_NAMES, 'fp-A'));
    const a = stable();
    expect(stable()).toBe(a);

    let idx = indexOf(BIG_NAMES, 'fp-A');
    const mut = memoizedErbFunctionNames(() => idx);
    const b1 = mut();
    idx = indexOf([...BIG_NAMES, 'FUNC_999999'], 'fp-B');
    const b2 = mut();
    expect(b2).not.toBe(b1); // 指纹变 ⇒ 新引用 ⇒ `INDEX_CACHE` 按身份必然重建
    expect(b2).toContain('FUNC_999999');

    const nullFp = memoizedErbFunctionNames(() => indexOf(BIG_NAMES, null));
    expect(nullFp()).not.toBe(nullFp()); // 指纹 null ⇒ 保守失效（每次新引用）
  });
});

/* ============================== (b) 大文件标签扫描 ============================== */

const ERB_LINES = 20_000;
const ERB_LABEL_COUNT = 400;
const LABEL_PREFIX = 'LBL_';

/** 造 ~20,000 行 / 400 个 `$LBL_xxxxxx` 定义的 `.erb` 文本，末行 = `GOTO $LBL_` */
function bigErbText(): { text: string; lineNumber: number; column: number } {
  const step = ERB_LINES / ERB_LABEL_COUNT;
  const lines: string[] = [];
  for (let i = 0; i < ERB_LINES; i++) {
    if (i % step === 0) lines.push(`$${LABEL_PREFIX}${String(i).padStart(6, '0')}`);
    else lines.push(`\tPRINTL 行${i} 这是一段足够长的填充文本用于逼近真实体量`);
  }
  const jump = `\tGOTO $${LABEL_PREFIX}`;
  lines.push(jump);
  return { text: lines.join('\n'), lineNumber: lines.length, column: jump.length + 1 };
}

describe('SH-3 · (b) 大文件标签扫描：冷（版本自增）vs 热（版本不变）', () => {
  const labMonaco = { languages: { CompletionItemKind: { Reference: 21 } } } as unknown as typeof Monaco;

  it('冷路径（每击键重扫全文）与热路径（版本记忆化命中）的 median / p95', () => {
    const { text, lineNumber, column } = bigErbText();
    const pos = { lineNumber, column } as Monaco.Position;

    // 冷：`getVersionId` 每次自增 ⇒ 缓存全失效 ⇒ 每次都重扫 20k 行全文
    const coldModel = textModel(text, bumpingVersion());
    const cold = measure(200, () => {
      erbLabelCompletionItems(labMonaco, coldModel, pos);
    });

    // 热：版本不变 ⇒ 首次建表，其后复用同一数组
    const hotModel = textModel(text, () => 1);
    const hot = measure(N, () => {
      erbLabelCompletionItems(labMonaco, hotModel, pos);
    });

    // 冷热结果一致（缓存不失真）：400 个 `LBL_` 前缀命中
    const sample = erbLabelCompletionItems(labMonaco, textModel(text, () => 1), pos);
    expect(sample).toHaveLength(ERB_LABEL_COUNT);
    expect(itemLabels(sample).every((l) => l.startsWith(LABEL_PREFIX))).toBe(true);

    console.log(
      `[SH-3 b] 大文件标签（20k 行 / 400 标签）：冷路径 ${fmt(cold)}；热路径 ${fmt(hot)}；` +
        `热/冷 median 比 ${(cold.median / Math.max(hot.median, 1e-6)).toFixed(1)}×；命中 400 条`,
    );

    expect(cold.median).toBeGreaterThan(hot.median * 3); // 缓存确有收益（失效则两者同阶，必挂）
    expect(hot.p95).toBeLessThan(1); // 热路径（复用标签数组 + 前缀过滤）远低于可感阈值
  });
});

/* ============================== (c) kojo 大文件别名扫描 ============================== */

const KOJO_LINES = 10_000;

/** 造 ~10,000 行 `.kojo` 文本（含若干 `别名` 声明；别名扫描为全文件正则） */
function bigKojoText(): { text: string; lineNumber: number; column: number } {
  const lines: string[] = [];
  for (let i = 0; i < KOJO_LINES; i++) {
    if (i % 500 === 0) lines.push(`别名 她${i} = 角色${i}`);
    else lines.push(`\t她は「这是用于逼近真实体量的填充口上文本，行 ${i}」`);
  }
  lines.push('\t时机 ');
  return { text: lines.join('\n'), lineNumber: lines.length, column: '\t时机 '.length + 1 };
}

describe('SH-3 · (c) kojo 大文件别名扫描（provider → mergeSuggestions 一轮）', () => {
  it('10k 行 `.kojo` 经完整装配点出货的单次 median / p95', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}));
    expect(registered).toHaveLength(1);
    expect(KOJO_COMPLETION_SOURCES).toHaveLength(7); // 块头模板 / 词表 / 变量 / 分野 / 指令名 / 库函数名 / 项目函数名七源一轮

    const provider = registered[0]!.provider;
    const { text, lineNumber, column } = bigKojoText();
    const model = textModel(text);
    const pos = { lineNumber, column } as Monaco.Position;
    const token = {} as Monaco.CancellationToken;

    const once = (): void => {
      provider.provideCompletionItems(model, pos, {} as Monaco.languages.CompletionContext, token);
    };

    // 声明 source 每次取全文走解析器（判据单一真源）；文本身份命中记忆化 ⇒ 稳态不重解析
    const out = provider.provideCompletionItems(
      model,
      pos,
      {} as Monaco.languages.CompletionContext,
      token,
    ) as unknown as Monaco.languages.CompletionList;
    expect(out.suggestions.length).toBeGreaterThan(0);

    const warm = measure(N, once);
    console.log(
      `[SH-3 c] kojo 别名扫描（10k 行）：单次 ${fmt(warm)}；候选 ${out.suggestions.length} 条`,
    );

    expect(warm.p95).toBeLessThan(15); // 全量别名扫描回归护栏（本机实测 p95 的 ~4 倍）
  });
});
