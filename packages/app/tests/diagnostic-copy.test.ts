/**
 * 诊断码中文显示名守卫（ZH-D2）。
 *
 * 钉的是**口径**而不是字符串运气，三道闸：
 * 1. **全覆盖闸**——闭集里每一条码必须有中文短名，**或**进 `DIAGNOSTIC_CODE_EXCLUSIONS`
 *    台账且写明理由（二选一，形态照 `eratw-adapter/variable-schema.ts` 的族别名台账）；
 *    漏一条即红。新增码的上游（`sugar.ts` 的联合 / `erb.ts` 的 kind / `condition-extractor`
 *    的 kind / `convention-linter` 的规则 id）与运行期枚举之间也做双向对账，
 *    改了上游忘了补表 ⇒ 当场红，不会悄悄留白。
 * 2. **无孤儿**——表里不许留着已经废弃的码（口径分叉的另一半）。
 * 3. **两处消费方屏上零裸 ASCII 码**——静态扫源码：`ProblemPanel` 与 `ui-sugar-editor`
 *    的上屏文本必须取自同一张表，且原码逐字进悬停 `title`；把原码直接插回 JSX/字符串即红。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_CODE_EXCLUSIONS,
  DIAGNOSTIC_LABELS,
  KOJO_STRUCTURE_SYNTAX_CODES,
  NATIVE_EXPR_CODES,
  NATIVE_STRUCTURE_CODES,
  SUGAR_DIAGNOSTIC_CODES,
  diagnosticDisplay,
} from '@kojo/plugin-api';
import type { ErbStructureIssue, SugarDiagnosticCode } from '@kojo/plugin-api';
import { KOJO_STRUCTURE_SYNTAX_KINDS, type KojoStructureSyntaxKind } from '../src/monaco/tree-sitter/types';
import { DECORATOR_MARKER_OWNER, SYNTAX_CODE_PREFIX, syntaxErrorCode } from '../src/monaco/tree-sitter/syntax-decorations';
import {
  CONT_INSIDE_QUOTES_RULE_ID,
  DUPLICATE_FUNCTION_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
} from '@kojo/plugin-convention-linter';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const rel = (abs: string): string => path.relative(ROOT, abs).replaceAll('\\', '/');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

/* ============================== 闭集（上游真源） ============================== */

/**
 * 上游联合 ⇄ 本表运行期枚举的**双向**对账（纯编译期，零运行成本）。
 * 两个方向各管一种漂移：漏补枚举 ⇒ 第二行红；枚举里留着已删的码 ⇒ 第三行红。
 */
const _sugarFwd: readonly SugarDiagnosticCode[] = SUGAR_DIAGNOSTIC_CODES;
const _sugarBack: readonly (typeof SUGAR_DIAGNOSTIC_CODES)[number][] =
  [] as readonly SugarDiagnosticCode[];
const _structureBack: readonly (typeof NATIVE_STRUCTURE_CODES)[number][] =
  [] as readonly `erb.${ErbStructureIssue['kind']}`[];
/** 结构层：闭集 ⇄ 生产方的 kind 联合双向对账（改一边忘另一边 ⇒ typecheck 红） */
const _syntaxFwd: readonly (typeof KOJO_STRUCTURE_SYNTAX_CODES)[number][] =
  [] as readonly `kojo.${KojoStructureSyntaxKind}`[];
const _syntaxBack: readonly `kojo.${KojoStructureSyntaxKind}`[] =
  [] as readonly (typeof KOJO_STRUCTURE_SYNTAX_CODES)[number][];
void _sugarFwd;
void _sugarBack;
void _structureBack;
void _syntaxFwd;
void _syntaxBack;

/** 结构类上屏码的唯一拼法出处（`erb-parser/src/structure.ts`）；拼法一改，本守卫即红（不静默分叉） */
const structureCodeSource = (): string => read('packages', 'plugins', 'erb-parser', 'src', 'structure.ts');

/** 表达式类上屏码：kind 联合在 `condition-extractor/src/expr.ts`，前缀拼法在 `decorator.ts` */
const exprKindUnion = (): string =>
  read('packages', 'plugins', 'condition-extractor', 'src', 'expr.ts');
const exprCodeSource = (): string =>
  read('packages', 'plugins', 'condition-extractor', 'src', 'decorator.ts');

/** 约定校验内置规则 id 全集（`convention-linter` 导出的常量，逐个而非猜字符串） */
const CONVENTION_RULE_IDS: readonly string[] = [
  DUPLICATE_FUNCTION_RULE_ID,
  CONT_INSIDE_QUOTES_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
];

/** 全部闭集码（去重后即为「必须有条目」的清单） */
const ALL_CODES: readonly string[] = [
  ...SUGAR_DIAGNOSTIC_CODES,
  ...NATIVE_STRUCTURE_CODES,
  ...NATIVE_EXPR_CODES,
  ...KOJO_STRUCTURE_SYNTAX_CODES,
  ...CONVENTION_RULE_IDS,
];

const hasChinese = (s: string): boolean => /[\u4e00-\u9fa5]/.test(s);

/* ============================== 闸 1：全覆盖 ============================== */

describe('诊断码中文显示名：全覆盖闸（二选一）', () => {
  it('闭集不为空（守卫别在空清单上自欺）', () => {
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(45);
  });

  it('每一条码要么有中文短名、要么在排除台账且有理由', () => {
    const missing: string[] = [];
    for (const code of ALL_CODES) {
      const named = DIAGNOSTIC_LABELS[code]?.name;
      const excluded = DIAGNOSTIC_CODE_EXCLUSIONS[code];
      if (!named && !excluded) missing.push(code);
    }
    expect(missing, `这些码没有中文显示名，也没进排除台账：\n${missing.join('\n')}`).toEqual([]);
  });

  it('中文短名真的是中文、且不含被禁的旧术语', () => {
    for (const [code, label] of Object.entries(DIAGNOSTIC_LABELS)) {
      expect(hasChinese(label.name), `${code} 的短名不是中文：${label.name}`).toBe(true);
      expect(label.name.length, `${code} 的短名过长`).toBeLessThanOrEqual(12);
      for (const banned of ['语法糖', '糖视图', '升糖', '降糖', '糖判定', '糖预览', '上糖', '糖']) {
        expect(label.name, `${code} 的短名含禁用术语 ${banned}`).not.toContain(banned);
        expect(label.detail ?? '', `${code} 的说明含禁用术语 ${banned}`).not.toContain(banned);
      }
    }
  });

  it('排除台账一条一理由、且不与表内条目重复登记', () => {
    for (const [code, why] of Object.entries(DIAGNOSTIC_CODE_EXCLUSIONS)) {
      expect(why.trim().length, `${code} 的豁免没有理由`).toBeGreaterThan(0);
      expect(DIAGNOSTIC_LABELS[code], `${code} 既有中文名又被豁免`).toBeUndefined();
      expect(ALL_CODES, `${code} 豁免了一条闭集里不存在的码`).toContain(code);
    }
  });

  it('上游联合漂移即刻可见（拼法 / kind 集合被改动不许静默）', () => {
    // 结构类：`erb.${issue.kind}` 这一条拼法是本表键的前提
    expect(structureCodeSource()).toContain('`erb.${issue.kind}`');
    // 表达式类：kind 只有 lexical / syntax 两形；多一种就得补表（这一行会先红）
    expect(exprKindUnion()).toContain("readonly kind: 'lexical' | 'syntax'");
    expect(exprCodeSource()).toContain('`erb.expr-${diag.kind}`');
    expect([...NATIVE_EXPR_CODES].sort()).toEqual(['erb.expr-lexical', 'erb.expr-syntax']);
  });

  it('结构层（TSIT2-D）：码 = `kojo.` + kind，拼法与闭集逐一对账', () => {
    // 生产方的拼法就一处（`syntax-decorations.ts` 的 `syntaxErrorCode`）；换了前缀 ⇒ 这两行一起红
    expect(SYNTAX_CODE_PREFIX).toBe('kojo.');
    for (const kind of KOJO_STRUCTURE_SYNTAX_KINDS) {
      expect(ALL_CODES, `kind「${kind}」没有登记进码表（补 DIAGNOSTIC_LABELS 与闭集数组）`).toContain(syntaxErrorCode(kind));
    }
    for (const code of KOJO_STRUCTURE_SYNTAX_CODES) {
      const bare = code.slice(SYNTAX_CODE_PREFIX.length);
      expect(KOJO_STRUCTURE_SYNTAX_KINDS, `码表里的 ${code} 对不上任何 kind（孤儿条目）`).toContain(bare as KojoStructureSyntaxKind);
    }
    expect([...KOJO_STRUCTURE_SYNTAX_KINDS]).toHaveLength(KOJO_STRUCTURE_SYNTAX_CODES.length);
  });

  it('去重判据的那个 owner 与装饰通道真源一致（改了那边忘了这里 ⇒ 去重静默失效）', () => {
    // 真源 = `ui/EditorPane.tsx` 里 `const MARKER_OWNER = 'kojo-decorators'`（组件文件的局部常量，
    // 表现层不该反向 import 它，所以这里读源码对账，形态照上面那几条"拼法出处"闸）
    const pane = read('packages', 'app', 'src', 'ui', 'EditorPane.tsx');
    expect(pane).toContain(`const MARKER_OWNER = '${DECORATOR_MARKER_OWNER}'`);
  });
});

/* ============================== 闸 2：无孤儿 ============================== */

describe('诊断码中文显示名：无孤儿条目', () => {
  it('表里每一条都对应真实存在的码', () => {
    const orphans = Object.keys(DIAGNOSTIC_LABELS).filter((c) => !ALL_CODES.includes(c));
    expect(orphans, `这些条目对应的码已不存在（口径分叉）：${orphans.join(', ')}`).toEqual([]);
  });

  it('结构类闭集与 erb.ts 的 kind 联合逐一对账', () => {
    expect([...NATIVE_STRUCTURE_CODES].sort()).toEqual(
      ['erb.orphan-branch', 'erb.orphan-close', 'erb.unclosed-open'].sort(),
    );
  });
});

/* ============================== 呈现函数 ============================== */

describe('diagnosticDisplay：第一眼中文、原码留悬停', () => {
  it('已知码给中文短名，原码逐字进 title', () => {
    const d = diagnosticDisplay('section-mixed');
    expect(d.name).toBe('段与普通语句混写');
    expect(hasChinese(d.name)).toBe(true);
    expect(d.code).toBe('section-mixed');
    expect(d.title).toContain('section-mixed');
  });

  it('带说明的码把说明附在 title（技术信息零丢失）', () => {
    const d = diagnosticDisplay('timing-counter-unknown');
    expect(d.title).toContain('timing-counter-unknown');
    expect(d.title.length).toBeGreaterThan(d.code.length);
  });

  it('未登记的码回落原码显示，绝不编造中文名', () => {
    const d = diagnosticDisplay('brand-new-code-from-another-plugin');
    expect(d.name).toBe('brand-new-code-from-another-plugin');
    expect(d.title).toBe('brand-new-code-from-another-plugin');
  });
});

/* ============================== 闸 3：两处消费方屏上零裸码 ============================== */

const PROBLEM_PANEL = rel(path.join('packages', 'app', 'src', 'ui', 'ProblemPanel.tsx'));
const SUGAR_EDITOR = rel(path.join('packages', 'plugins', 'ui-sugar-editor', 'src', 'index.ts'));

describe('上屏文案零裸 ASCII 码（两处消费方读同一张表）', () => {
  it('问题面板：码位取中文短名，原码只在 title', () => {
    const s = read('packages', 'app', 'src', 'ui', 'ProblemPanel.tsx');
    expect(s).toContain('diagnosticDisplay');
    // 旧写法 `{it.code}` 直出 JSX 即红
    expect(/\{it\.code\}/.test(s), `${PROBLEM_PANEL}: 原码不许再当上屏文本`).toBe(false);
    expect(s).toMatch(/<code[^>]*title=\{[^\n]*\.title\}/);
    expect(s).toMatch(/>\s*\{[^\n]*\.name\}/);
  });

  it('.kojo 校验面板：sv-code 芯片取中文短名，原码只在 title', () => {
    const s = read('packages', 'plugins', 'ui-sugar-editor', 'src', 'index.ts');
    expect(s).toContain('diagnosticDisplay');
    expect(/\{ className: 'sv-code dim' \}, r\.code\)/.test(s), `${SUGAR_EDITOR}: 原码不许再当芯片文本`).toBe(false);
    expect(s).toContain("{ className: 'sv-code dim', title: disp.title }, disp.name");
  });

  it('两处都不自带映射表（单一真源，口径不分叉）', () => {
    for (const parts of [
      ['packages', 'app', 'src', 'ui', 'ProblemPanel.tsx'],
      ['packages', 'plugins', 'ui-sugar-editor', 'src', 'index.ts'],
    ]) {
      const s = read(...parts);
      expect(/Record<[^>]*string[^>]*>\s*=\s*\{[^}]*'[\w-]+':/.test(s), `${rel(path.join(ROOT, ...parts))}: 又抄了一份码→文案映射`).toBe(false);
    }
  });
});
