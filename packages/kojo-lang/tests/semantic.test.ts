/**
 * 结构化着色判据（`packages/kojo-lang/src/semantic.ts`，B3 语义收口）的闸。
 *
 * 这一格从宿主 `monaco/kojo2-semantic.ts` 整块搬来（映射 / 跨行拆段 / 重叠裁剪 / 每组预算），
 * 钉七件事：
 *
 * 1. **捕获名 → 档位**：主树表 / 注入子树表各自翻译；`none` 与空名不上色；`@` 前缀容错；
 *    表外主树捕获只报一次（`onUnknownCapture`），表外子树捕获静默丢（与旧行为同）；
 * 2. **0 基 → 契约 1 基**：`kojo2ContractCaptures` 只搬坐标、不裁几何（唯一例外：`none` /
 *    空名 = 不上色，不进快照），跨行带 `endLine`、注入带 `origin`；
 * 3. **坐标纪律**：行越界 / 倒置 / 非有限 / 零宽一律丢；单行列不查行长（宿主最后夹），
 *    跨行缺行几何整条丢；
 * 4. **排序与去重叠**：按（行，起始列，长者优先，档名），同行后到重叠段丢掉，相邻不算重叠；
 * 5. **预算**：主树与注入子树**各自** 20,000 条上限；
 * 6. **注入优先**：子树涂到的列让主树 raw 让位，没涂到的列仍由主树兜底；无子树的行走原样；
 * 7. **legend 与主题逐字对齐**：`KOJO2_SEMANTIC_TOKEN_TYPES` = 主树表实际用到的档位，
 *    每一档在三套 `kojo2-*` 主题里都有规则（名字仍是 `role.*`，不另造色板）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_THEME_RULES } from '@kojo/kojo-lang/theme-rules';
import { KOJO2_THEMES, KOJO2_THEME_IDS, KOJO2_THEME_TOKEN_MAP } from '@kojo/kojo-lang/monaco-theme';
import { KOJO2_TOKEN } from '@kojo/kojo-sdk/semantic-roles';
import {
  KOJO2_CAPTURE_TOKEN_TYPES,
  KOJO2_INJECTION_CAPTURE_TOKENS,
  KOJO2_SEMANTIC_MAX_SPAN_LINES,
  KOJO2_SEMANTIC_MAX_TOKENS,
  KOJO2_SEMANTIC_TOKEN_TYPES,
  kojo2ContractCaptures,
  kojo2SemanticSpansFromCaptures,
  type Kojo2RawCapture,
  type Kojo2SemanticCapture,
  type Kojo2SemanticSpan,
} from '@kojo/kojo-lang/semantic';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HIGHLIGHTS_SCM = join(REPO_ROOT, 'packages/kojo-syntax-tree/queries/v2/highlights.scm');

const cap = (
  name: string,
  line: number,
  startColumn: number,
  endColumn: number,
  extra: Partial<Kojo2SemanticCapture> = {},
): Kojo2SemanticCapture => ({ name, line, startColumn, endColumn, ...extra });

const span = (
  line: number,
  startColumn: number,
  endColumn: number,
  tokenType: string,
): Kojo2SemanticSpan => ({ line, startColumn, endColumn, tokenType });

const raw = (
  name: string,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): Kojo2RawCapture => ({
  name,
  startPosition: { row: startRow, column: startColumn },
  endPosition: { row: endRow, column: endColumn },
});

const options = (over: Partial<Parameters<typeof kojo2SemanticSpansFromCaptures>[1]> = {}) => ({
  lineCount: 20,
  ...over,
});

/* ============================== legend ↔ 主题 ============================== */

describe('legend · 档位与三套主题逐字对齐', () => {
  it('legend = 主树捕获表实际用到的档位（声明序稳定、无重复）', () => {
    expect([...KOJO2_SEMANTIC_TOKEN_TYPES]).toEqual([
      ...new Set(Object.values(KOJO2_CAPTURE_TOKEN_TYPES)),
    ]);
    expect(new Set(KOJO2_SEMANTIC_TOKEN_TYPES).size).toBe(KOJO2_SEMANTIC_TOKEN_TYPES.length);
  });

  it('每一档在暗色角色规则里都有一条规则，且前景 / 字重逐格相等', () => {
    const rules = new Map(ROLE_THEME_RULES.map((rule) => [rule.token, rule]));
    for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
      const rule = rules.get(token);
      expect(rule, `legend「${token}」在暗色角色规则里没有规则`).toBeDefined();
      const themeStyle = (KOJO2_THEME_TOKEN_MAP as Readonly<Record<string, { dark: { foreground: string; fontStyle?: string } }>>)[token]!.dark;
      expect({ foreground: rule!.foreground, fontStyle: rule!.fontStyle }).toEqual({
        foreground: themeStyle.foreground,
        ...(themeStyle.fontStyle === undefined ? {} : { fontStyle: themeStyle.fontStyle }),
      });
    }
  });

  it('三套 2.0 主题的 rules 都覆盖 legend 的每一档（不靠继承）', () => {
    for (const id of KOJO2_THEME_IDS) {
      const defined = new Set(KOJO2_THEMES[id].rules.map((rule) => rule.token));
      for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) expect(defined.has(token), `${id} 缺 ${token}`).toBe(true);
    }
  });

  it('highlights.scm 里的每个捕获名（`none` 除外）都有主树档位映射', () => {
    const query = readFileSync(HIGHLIGHTS_SCM, 'utf8');
    const names = new Set<string>();
    for (const line of query.split(/\r?\n/)) {
      const match = /^\s*\([^)]*\)\s*@([A-Za-z][\w.]*)\s*$/.exec(line);
      if (match !== null) names.add(match[1]!);
    }
    names.delete('none');
    expect(names.size).toBeGreaterThan(5); // 反空匹配自证
    for (const name of names) {
      expect(KOJO2_CAPTURE_TOKEN_TYPES[name], `查询捕获「@${name}」没有档位`).toBeDefined();
    }
  });

  it('两张表对**同名**捕获说法一致（并集不会因来自哪棵树而变色）', () => {
    for (const [name, token] of Object.entries(KOJO2_INJECTION_CAPTURE_TOKENS)) {
      const main = KOJO2_CAPTURE_TOKEN_TYPES[name];
      if (main !== undefined) expect(main, `同名捕获「${name}」两表说法不同`).toBe(token);
    }
  });
});

/* ============================== 0 基 → 契约 1 基 ============================== */

describe('kojo2ContractCaptures · 坐标搬运', () => {
  it('行列 +1、跨行带 endLine、注入带 origin', () => {
    expect(kojo2ContractCaptures([raw('string', 1, 2, 3, 4)])).toEqual([
      { name: 'string', line: 2, startColumn: 3, endColumn: 5, endLine: 4 },
    ]);
    expect(kojo2ContractCaptures([raw('comment', 0, 0, 0, 3)], 'injection')).toEqual([
      { name: 'comment', line: 1, startColumn: 1, endColumn: 4, origin: 'injection' },
    ]);
  });

  it('坏条目丢：负行 / 倒置 / 非有限 / 缺位置；非数组给空', () => {
    expect(kojo2ContractCaptures(null)).toEqual([]);
    expect(kojo2ContractCaptures(undefined)).toEqual([]);
    expect(
      kojo2ContractCaptures([
        raw('a', -1, 0, 0, 1),
        raw('b', 2, 0, 1, 1),
        raw('c', Number.NaN, 0, 0, 1),
        { name: 'd' } as never,
        raw('ok', 0, 0, 0, 1),
      ]),
    ).toEqual([{ name: 'ok', line: 1, startColumn: 1, endColumn: 2 }]);
  });

  it('`@none` / 空名不进快照（契约原文：这一条不上色）；`@` 前缀照样剥掉', () => {
    expect(
      kojo2ContractCaptures([
        raw('none', 0, 0, 0, 4),
        raw('@none', 1, 0, 1, 4),
        raw('', 2, 0, 2, 4),
        raw('@comment', 3, 0, 3, 4),
      ]),
    ).toEqual([{ name: 'comment', line: 4, startColumn: 1, endColumn: 5 }]);
  });
});

/* ============================== 映射 ============================== */

describe('捕获名 → 档位', () => {
  it('主树 / 子树各自翻译，`@` 前缀容错，`none` 与空名不上色', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('keyword', 1, 1, 3),
        cap('@string', 1, 4, 6),
        cap('none', 1, 7, 8),
        cap('', 1, 9, 10),
        cap('tag', 2, 1, 4, { origin: 'injection' }),
      ],
      options(),
    );
    expect(spans).toEqual([
      span(1, 1, 3, KOJO2_TOKEN.keyword),
      span(1, 4, 6, KOJO2_TOKEN.speech),
      span(2, 1, 4, KOJO2_TOKEN.keyword),
    ]);
  });

  it('表外主树捕获报一次名字后丢掉；表外子树捕获静默丢（旧行为同）', () => {
    const unknown: string[] = [];
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('directive.unknown', 1, 1, 2),
        cap('mystery', 2, 1, 2, { origin: 'injection' }),
        cap('keyword', 3, 1, 2),
      ],
      options({ onUnknownCapture: (name) => unknown.push(name) }),
    );
    expect(unknown).toEqual(['directive.unknown']);
    expect(spans).toEqual([span(3, 1, 2, KOJO2_TOKEN.keyword)]);
  });

  it('空 captures / 非数组 / 非法行数 ⇒ 空结果（不抛）', () => {
    expect(kojo2SemanticSpansFromCaptures([], options())).toEqual([]);
    expect(kojo2SemanticSpansFromCaptures(null, options())).toEqual([]);
    expect(kojo2SemanticSpansFromCaptures([cap('keyword', 1, 1, 2)], options({ lineCount: 0 }))).toEqual([]);
    expect(kojo2SemanticSpansFromCaptures([cap('keyword', 1, 1, 2)], options({ lineCount: Number.NaN }))).toEqual([]);
  });
});

/* ============================== 坐标裁剪 ============================== */

describe('坐标纪律 · 越界一律丢、跨行逐行拆段', () => {
  it('行越界 / 倒置 / 零宽 / 非有限一律丢，合法条目照留', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('string', 0, 1, 4), // 行 < 1
        cap('string', 21, 1, 4), // 行 > lineCount
        cap('string', 3, 1, 4, { endLine: 2 }), // 倒置
        cap('string', 2, 3, 3), // 零宽
        cap('string', 2, Number.NaN, 4), // 非有限
        cap('string', 1, 1, 4), // 合法
      ],
      options(),
    );
    expect(spans).toEqual([span(1, 1, 4, KOJO2_TOKEN.speech)]);
  });

  it('单行捕获不查行长（宿主最后一道夹取），跨行捕获逐行拆到行尾', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('string', 1, 3, 99, { endLine: 3 }),
        cap('string', 2, 1, 2),
      ],
      options({ lineCount: 4, maxColumn: (line) => (line === 1 ? 10 : line === 2 ? 6 : line === 3 ? 8 : 20) }),
    );
    expect(spans).toEqual([
      span(1, 3, 10, KOJO2_TOKEN.speech),
      span(2, 1, 6, KOJO2_TOKEN.speech),
      span(3, 1, 8, KOJO2_TOKEN.speech),
    ]);
  });

  it('跨行捕获缺行几何 ⇒ 整条丢（不许只画前半截）；超 200 行同样丢', () => {
    expect(kojo2SemanticSpansFromCaptures([cap('string', 1, 1, 4, { endLine: 2 })], options())).toEqual([]);
    const long = cap('string', 1, 1, 4, { endLine: KOJO2_SEMANTIC_MAX_SPAN_LINES + 1 });
    expect(
      kojo2SemanticSpansFromCaptures([long], options({ lineCount: 500, maxColumn: () => 20 })),
    ).toEqual([]);
  });
});

/* ============================== 排序 / 去重叠 / 预算 ============================== */

describe('排序 · 重叠裁剪 · 预算', () => {
  it('按（行，起始列，长者优先，档名）排序；同行后到重叠段丢掉，相邻保留', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('string', 2, 5, 9),
        cap('keyword', 1, 4, 6),
        cap('keyword', 1, 1, 4), // 相邻（end 4 = start 4）⇒ 不算重叠
        cap('number', 2, 6, 8), // 与 5..9 重叠 ⇒ 丢
        cap('variable', 2, 5, 7), // 同起点更短 ⇒ 排在长者之后 ⇒ 丢
      ],
      options(),
    );
    expect(spans).toEqual([
      span(1, 1, 4, KOJO2_TOKEN.keyword),
      span(1, 4, 6, KOJO2_TOKEN.keyword),
      span(2, 5, 9, KOJO2_TOKEN.speech),
    ]);
  });

  it('主树与注入子树各自封顶 20,000 条（旧实现同口径）', () => {
    const many: Kojo2SemanticCapture[] = [];
    for (let i = 0; i < KOJO2_SEMANTIC_MAX_TOKENS + 5_000; i++) {
      many.push(cap('keyword', (i % 100) + 1, 1, 2));
    }
    const spans = kojo2SemanticSpansFromCaptures(many, options({ lineCount: 100 }));
    expect(spans.length).toBeLessThanOrEqual(KOJO2_SEMANTIC_MAX_TOKENS);
    expect(spans.length).toBeGreaterThan(0);
  });
});

/* ============================== 注入优先 ============================== */

describe('注入子树优先 · 主树 raw 让位、未覆盖列兜底', () => {
  const main = cap('embedded', 2, 1, 12);

  it('子树涂到的列让位，未涂到的列仍由主树兜底（列区间减法）', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [main, cap('comment', 2, 4, 8, { origin: 'injection' })],
      options(),
    );
    expect(spans).toEqual([
      span(2, 1, 4, KOJO2_TOKEN.raw),
      span(2, 4, 8, KOJO2_TOKEN.comment),
      span(2, 8, 12, KOJO2_TOKEN.raw),
    ]);
  });

  it('子树整行覆盖 ⇒ 主树这一行一条不剩；其它行原样', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [main, cap('embedded', 4, 1, 5), cap('comment', 2, 1, 12, { origin: 'injection' })],
      options(),
    );
    expect(spans).toEqual([
      span(2, 1, 12, KOJO2_TOKEN.comment),
      span(4, 1, 5, KOJO2_TOKEN.raw),
    ]);
  });

  it('子树一条也没有 ⇒ 主树原样（与旧 mergeInjectionSpans 的空输入同）', () => {
    expect(kojo2SemanticSpansFromCaptures([main], options())).toEqual([
      span(2, 1, 12, KOJO2_TOKEN.raw),
    ]);
  });

  it('子树档位映射走子语言表：`tag` / `function` / `raw` 只在子树表里', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [
        cap('tag', 2, 1, 3, { origin: 'injection' }),
        cap('function', 2, 4, 7, { origin: 'injection' }),
        cap('raw', 2, 8, 12, { origin: 'injection' }),
      ],
      options(),
    );
    expect(spans).toEqual([
      span(2, 1, 3, KOJO2_TOKEN.keyword),
      span(2, 4, 7, KOJO2_TOKEN.declaration),
      span(2, 8, 12, KOJO2_TOKEN.raw),
    ]);
  });

  it('子树的跨行捕获同样逐行拆段，且优先于主树', () => {
    const spans = kojo2SemanticSpansFromCaptures(
      [cap('embedded', 2, 1, 10), cap('embedded', 3, 1, 10), cap('comment', 2, 5, 10, { endLine: 3, origin: 'injection' })],
      options({ maxColumn: () => 12 }),
    );
    expect(spans).toEqual([
      span(2, 1, 5, KOJO2_TOKEN.raw),
      span(2, 5, 12, KOJO2_TOKEN.comment),
      span(3, 1, 10, KOJO2_TOKEN.comment),
    ]);
  });
});