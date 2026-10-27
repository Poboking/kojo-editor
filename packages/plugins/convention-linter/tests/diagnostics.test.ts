/**
 * 诊断折叠层（`src/diagnostics.ts`）+ 兜底修法（`src/fixes.ts`）的钉桩测试（DIAG-LINK）。
 *
 * 钉的是四条**产品口径**，不是实现细节：
 * ① 同一条 issue 在装饰面与 `Ctrl+.` 里的身份键一致（否则聚合视图与 💡 说的不是同一次问题）；
 * ② 无 `edits` ⇒ 不产动作（不猜、不装好）；
 * ③ 严重度三档如实落地，`info` 一条不许被吞（`erb.duplicate-function` 整条就是 info）；
 * ④ issues 按文件归属，跨文件绝不串（A 的问题不能画到 B 的行上）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ConventionIssue,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  GameProject,
  LineDecoration,
  Logger,
  SugarDiagnostic,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { duplicateFunctionRule } from '../src/rules/duplicate-function';
import {
  CONT_INSIDE_QUOTES_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
  createSugarStaticConventionsRule,
  setSugarTranspileProvider,
  sugarStaticConventionsRule,
} from '../src/rules/sugar-conventions';
import {
  buildConventionIssueView,
  conventionCodeActionsForFile,
  conventionDecorationsForFile,
  conventionIssueDecoration,
  conventionIssueKey,
  conventionSeverityToDecoration,
  conventionSquiggleOwnedElsewhere,
  conventionSurfaceDecoration,
  foldIssueEdit,
  toIssueLines,
  type ConventionIssueEdit,
} from '../src/diagnostics';
import { conventionIssueFixes } from '../src/fixes';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const FILE_A = 'C:/game/data/kojo/a.kojo1';
const FILE_B = 'C:/game/data/kojo/b.erb';

function issue(over: Partial<ConventionIssue> = {}): ConventionIssue {
  return {
    ruleId: 'test.rule',
    severity: 'warning',
    message: '测试问题',
    filePath: FILE_A,
    line: 3,
    ...over,
  };
}

function view(...issues: ConventionIssue[]) {
  return buildConventionIssueView(issues);
}

describe('约定问题 → 波浪线（装饰面）', () => {
  it('severity 三档如实映射，info 不被吞也不被抬成 warning', () => {
    expect(conventionSeverityToDecoration('error')).toBe('error');
    expect(conventionSeverityToDecoration('warning')).toBe('warning');
    expect(conventionSeverityToDecoration('info')).toBe('info');
    const decorations = conventionDecorationsForFile(
      view(
        issue({ ruleId: 'r.error', severity: 'error', message: 'e', line: 1 }),
        issue({ ruleId: 'r.warn', severity: 'warning', message: 'w', line: 2 }),
        issue({ ruleId: 'r.info', severity: 'info', message: 'i', line: 3 }),
      ),
      FILE_A,
    );
    expect(decorations.map((d) => d.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('code = ruleId、message 原样；已登记的码带中文来源标签，未登记的**不编**（行号升序）', () => {
    const decorations = conventionDecorationsForFile(
      view(
        issue({ ruleId: 'erb.duplicate-function', severity: 'info', message: '重名', line: 9 }),
        // 未登记码用 `test.` 而不是 `sugar.`：后者在 `.kojo1` 上归别家画线（见
        // `decorator-ownership.test.ts` 的归属闸），混进来就测不到"未登记 ⇒ 不给 source"这一条
        issue({ ruleId: 'test.not-registered', severity: 'error', message: '坏', line: 2 }),
      ),
      FILE_A,
    );
    expect(decorations).toEqual([
      { line: 2, severity: 'error', message: '坏', code: 'test.not-registered' },
      { line: 9, severity: 'info', message: '重名', code: 'erb.duplicate-function', source: '函数重名' },
    ]);
  });

  it('列尺全链一次换算：契约 `column` 是 0 基、`startColumn` 是 1 基 ⇒ 折叠层 +1（别处不再加减）', () => {
    // 0 基列 0 ⇒ 1 基列 1（行首）；0 基列 4 ⇒ 1 基列 5
    expect(conventionIssueDecoration(issue({ column: 0 }))?.startColumn).toBe(1);
    expect(conventionIssueDecoration(issue({ column: 4 }))?.startColumn).toBe(5);
    expect(conventionIssueDecoration(issue())?.startColumn).toBeUndefined();
    // 坏列（负数 / NaN）⇒ 退回整行装饰，绝不画一个 NaN 列的 marker
    expect(conventionIssueDecoration(issue({ column: -1 }))?.startColumn).toBeUndefined();
    expect(conventionIssueDecoration(issue({ column: Number.NaN }))?.startColumn).toBeUndefined();
  });

  it('与糖侧发布方同一列位：`SugarPosition`（1 基）经规则投影 `-1` 进契约，折叠层 `+1` 回到面上', () => {
    // 糖波浪线那一头的既有翻译（ui-sugar-editor/panel-logic.ts:101）：startColumn 直接取
    // `SugarPosition.column`（1 基）。约定这一头：规则投影 `column = loc.column - 1`（0 基，
    // 契约口径）⇒ 本层 `+1`。两条流水线必须落在**同一列**，否则同一个问题面上出现两条
    // 错位的红线（这一条就是那把尺子的对账闸）。
    const transpilerColumn = 7; // SugarPosition.column（1 基）
    const sugarSide = transpilerColumn;
    const folded = conventionIssueDecoration(
      issue({ ruleId: CONT_INSIDE_QUOTES_RULE_ID, severity: 'error', message: 'm', line: 2, column: transpilerColumn - 1 }),
    )!;
    expect(folded.startColumn).toBe(sugarSide);
  });

  it('无 filePath / 无 line 的问题不进装饰面（不属于任何一行 ⇒ 不猜位置）', () => {
    expect(conventionIssueDecoration(issue({ filePath: undefined }))).toBeNull();
    expect(conventionIssueDecoration(issue({ line: undefined }))).toBeNull();
    expect(conventionIssueDecoration(issue({ line: 0 }))).toBeNull();
  });

  it('跨文件不串：每棵只拿自己的 issues（Windows 大小写/分隔符差异同归一个桶）', () => {
    const v = view(issue({ message: 'A 的', line: 1 }), issue({ filePath: FILE_B, message: 'B 的', line: 7 }));
    expect(conventionDecorationsForFile(v, FILE_A).map((d) => d.message)).toEqual(['A 的']);
    expect(conventionDecorationsForFile(v, FILE_B).map((d) => d.message)).toEqual(['B 的']);
    expect(conventionDecorationsForFile(v, 'c:\\game\\data\\kojo\\A.KOJO1').map((d) => d.message)).toEqual(['A 的']);
    expect(conventionDecorationsForFile(v, 'C:/game/data/kojo/none.erb')).toEqual([]);
  });
});

describe('约定问题 → 💡 动作（codeAction 面）', () => {
  const fixed = issue({
    ruleId: 'sugar.cont-inside-quotes',
    severity: 'error',
    message: '「续」写在引号内',
    line: 2,
    edits: [{ description: '把「续」移到引号外', loc: { line: 2, column: 0 }, newText: '「你好」 续' }],
  });
  const text = '时机 对话：\n  「你好」\n';

  it('①身份键一致：动作带出的诊断与**面上那一条**同尺（G3 与 Ctrl+. 说同一次问题）', () => {
    const v = view(fixed);
    // `.kojo1` 上的糖族**不由本层画线**（归 `sugar-diagnostics`，见文件末归属闸），所以面上的
    // 那条是别家发布的那一枚；本层的动作必须认领**那一枚的身份**，否则 `Ctrl+.` 静默失灵。
    const surface = conventionSurfaceDecoration(fixed)!;
    expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
    const actions = conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document' });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.diagnostics).toEqual([surface]);
    expect(conventionIssueKey(actions[0]!.diagnostics![0]!)).toBe(hostDiagnosticKey(surface));
    expect(actions[0]!.kind).toBe('quickfix');
    expect(actions[0]!.title).toBe('把「续」移到引号外');
  });

  it('②无 edits ⇒ 不产动作（波浪线照旧在，绝不凭空造 quickfix）', () => {
    const v = view(issue({ ruleId: 'erb.duplicate-function', severity: 'info', message: '重名', line: 2 }));
    expect(conventionDecorationsForFile(v, FILE_A)).toHaveLength(1);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document' })).toEqual([]);
  });

  it('③严重度三档都能拿到动作面（info 的问题不因"不是错误"被排除在关联之外）', () => {
    const withEdits = (severity: ConventionIssue['severity']) =>
      issue({ ruleId: `r.${severity}`, severity, message: severity, line: 2, edits: [{ description: '修', loc: { line: 2, column: 0 }, newText: 'ok' }] });
    for (const severity of ['error', 'warning', 'info'] as const) {
      const v = view(withEdits(severity));
      const actions = conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document' });
      expect(actions[0]!.diagnostics![0]!.severity).toBe(severity);
    }
  });

  it('④跨文件不串：动作只按本文件的 issues 产', () => {
    const v = view(fixed, { ...fixed, filePath: FILE_B, key: 'b' });
    const actions = conventionCodeActionsForFile(v, { path: FILE_B, text, scope: 'document' });
    expect(actions).toHaveLength(1);
    expect(conventionCodeActionsForFile(v, { path: 'C:/game/data/kojo/c.kojo1', text, scope: 'document' })).toEqual([]);
  });

  it('B9：递来 diagnostics 时只应答对得上的那些；空数组 = 一条都不应答', () => {
    const v = view(fixed);
    // 递来的是**面上画着的那一条**：`.kojo1` 上糖族波浪线由 `ui-sugar-editor#sugar-diagnostics`
    // 发布，码是不带面板前缀的转译器本名 ⇒ 本层认领的也是这一枚身份（前缀⇄本名的换算只有一处，
    // 见 `rules/sugar-conventions.ts`）。用带前缀的码当"面上那条"就是第二个真源。
    const requested: LineDecoration[] = [{ line: 2, severity: 'error', message: '「续」写在引号内', code: 'cont-inside-quotes' }];
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, line: 2, diagnostics: requested })).toHaveLength(1);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, line: 2, diagnostics: [] })).toEqual([]);
    const other: LineDecoration[] = [{ line: 2, severity: 'error', message: '别的来源', code: 'other.rule' }];
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, line: 2, diagnostics: other })).toEqual([]);
  });

  it('区间请求缺位置 = 不猜（旧宿主无 diagnostics 时也守这条）；document 批量不按行筛', () => {
    const v = view(fixed);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text })).toEqual([]);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, line: 99 })).toEqual([]);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document' })).toHaveLength(1);
  });

  it('只读路径不出动作（游戏目录默认只读，executeEdits 却照样能改缓冲）', () => {
    const v = view(fixed);
    expect(conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document', writable: false })).toEqual([]);
  });

  it('陈旧落点整条放弃（不给半截）：行越界 / 列超过那行的实际长度', () => {
    const ranged = issue({
      line: 1,
      edits: [{ description: '改', newText: 'x', loc: { line: 1, column: 0 }, end: { line: 1, column: 400 } }],
    });
    expect(conventionCodeActionsForFile(view(ranged), { path: FILE_A, text, scope: 'document' })).toEqual([]);
    const moved = issue({ line: 999, edits: [{ description: '改', loc: { line: 999, column: 0 }, newText: 'x' }] });
    expect(conventionCodeActionsForFile(view(moved), { path: FILE_A, text, scope: 'document' })).toEqual([]);
    // 多处修法：一处成立一处失效 ⇒ 整条不给（不给半截）
    const half = issue({
      line: 2,
      edits: [
        { description: '改', loc: { line: 2, column: 0 }, newText: 'ok' },
        { description: '改', loc: { line: 999, column: 0 }, newText: 'stale' },
      ],
    });
    expect(conventionCodeActionsForFile(view(half), { path: FILE_A, text, scope: 'document' })).toEqual([]);
  });

  it('列级落点折成整行替换时保住这一行的其余内容（契约 `Loc` 是 0 基 ⇒ 本层加减都不做）', () => {
    // `[2,4)` 0 基 ⇒ 盖住 `CD`：`ABCD-EF` → `ABX-EF`
    const folded = foldIssueEdit(
      { description: '改', newText: 'X', loc: { line: 1, column: 2 }, end: { line: 1, column: 4 } },
      1,
      toIssueLines('ABCD-EF'),
    );
    expect(folded).toEqual({ fromLine: 1, toLine: 1, newText: 'ABX-EF' });
    // 契约口径：**省略 `end` = 整行替换 `loc.line`**（`loc.column` 不参与，见 sugar.ts:103）
    expect(foldIssueEdit({ description: '改', newText: 'XY', loc: { line: 1, column: 0 } }, 9, toIssueLines('a\nb'))).toEqual({
      fromLine: 1,
      toLine: 1,
      newText: 'XY',
    });
    expect(foldIssueEdit({ description: '改', newText: 'XY', loc: { line: 1, column: 3 } }, 9, toIssueLines('abcd\nef'))).toEqual({
      fromLine: 1,
      toLine: 1,
      newText: 'XY',
    });
    // 运行时兜底：契约必填的 `loc` 真缺了（外部/旧产物），退回替换该条 issue 的那一行，绝不猜列
    expect(
      foldIssueEdit({ newText: 'Z' } as unknown as ConventionIssueEdit, 2, toIssueLines('a\nb')),
    ).toEqual({ fromLine: 2, toLine: 2, newText: 'Z' });
  });
});

/**
 * **真规则**的产出走真诊断面（不拿合成 issue 自证自答）。
 *
 * 规则文件（`src/rules/`）由并发线重做，本测试**只读**它的投影函数：
 * 转译服务用一枚最小桩喂进去（`createSugarStaticConventionsRule` 的依赖注入形态，零全局态、
 * 不碰 kernel），于是 `ruleId` / `line` / `column` / 消息**全部出自规则自己的投影代码**，
 * 被测的是我这一层（折叠 + 修法消费）对不对。
 */
describe('真规则 × 诊断面（端到端）', () => {
  function ctxFor(files: Record<string, string>): ConventionCheckContext {
    const map = new Map<string, ErbFile>();
    for (const [path, text] of Object.entries(files)) map.set(path, parseErbText(text, path));
    const index = { files: map, byName: new Map() } as unknown as ErbIndex;
    const project = {
      rootDir: 'C:/game',
      adapterId: 'test',
      kojoPaths: [],
      writablePaths: [],
      charaIndex: new Map(),
    } as unknown as GameProject;
    return { project, index, log: silentLog, readFile: async (p: string) => files[p] ?? '' };
  }

  const KOJO = '时机 对话：\n  「你好续」\n  心情 = 如果 思慕：\n    心情 = 1\n';

  /** 最小桩转译服务：只答 `transpile`，诊断逐条与转译器同形（`loc` 1 基行 / 1 基列） */
  function ruleWith(diagnostics: readonly SugarDiagnostic[]) {
    const service = { transpile: () => ({ diagnostics }) } as unknown as SugarTranspileService;
    return createSugarStaticConventionsRule(() => service);
  }

  it('投影出的 ruleId / 行 原样上面（列只在这一层 +1），`loc: null` 那条不画线但仍进桶', async () => {
    const rule = ruleWith([
      { code: 'cont-inside-quotes', severity: 'error', message: '「续」写在了引号内。', loc: { line: 2, column: 3 } },
      { code: 'expr-missing-else', severity: 'error', message: '取值位置的条件下必须穷尽。', loc: { line: 3, column: 3 } },
      { code: 'choice-multiple', severity: 'error', message: '一个时机内只允许一个选项块。', loc: null },
    ]);
    const issues = (await rule.check!(ctxFor({ [FILE_A]: KOJO }))) ?? [];
    expect(issues.map((i) => i.ruleId)).toEqual([
      CONT_INSIDE_QUOTES_RULE_ID,
      EXPR_MISSING_ELSE_RULE_ID,
      MULTIPLE_CHOICE_BLOCKS_RULE_ID,
    ]);
    const v = view(...issues);
    // 折叠层成形的那三条（行/列/消息逐字来自投影；`loc: null` = 没有可画的位置 ⇒ null）
    const folded = issues.map((i) => conventionSurfaceDecoration(i));
    expect(folded.map((d) => d?.line)).toEqual([2, 3, undefined]);
    // NOTE(规则线)：`sugarDiagnosticToIssue` 眼下把 `diag.loc.column` 只写进了 `key`，没落进
    // `issue.column` ⇒ 这里成形的是**整行**的（列区间缺席）。列的 `+1` 本身由折叠层保证
    // （见上面"列尺全链一次换算"与"与糖侧发布方同一列位"两条），投影一补 `column`
    // （契约口径 = `SugarPosition.column - 1`）就自动变成列级波浪线，且与糖侧那条红线同列。
    expect(folded[0]).toEqual({
      line: 2,
      severity: 'error',
      message: '「续」写在了引号内。',
      source: '续行标记写在引号内',
      // 面上那条由 `sugar-diagnostics` 发布 ⇒ 身份用转译器码本名（无面板前缀）
      code: 'cont-inside-quotes',
    });
    // 桶里三条都在（面板与折叠层读的是同一份 issues，不静默丢）
    expect(v.get(pathKey(FILE_A))?.issues).toHaveLength(3);
    // 而这一棵 `.kojo1` 上本层**一条线都不画**（归属闸；`decorator-ownership.test.ts` 钉合并后的条数）
    expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
  });

  it('「续」写在引号内 → 一键移到引号外（台词一字不动）；缺「否则」那条只报不修', async () => {
    const rule = ruleWith([
      { code: 'cont-inside-quotes', severity: 'error', message: '「续」写在了引号内。', loc: { line: 2, column: 3 } },
      { code: 'expr-missing-else', severity: 'error', message: '取值位置的条件下必须穷尽。', loc: { line: 3, column: 3 } },
    ]);
    const issues = (await rule.check!(ctxFor({ [FILE_A]: KOJO }))) ?? [];
    const v = view(...issues);
    const actions = conventionCodeActionsForFile(v, {
      path: FILE_A,
      text: KOJO,
      scope: 'document',
      fixResolver: conventionIssueFixes,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([{ fromLine: 2, toLine: 2, newText: '  「你好」 续' }]);
    expect(actions[0]!.title).toBe('把「续」移到引号外（规范 §3.3）');
    // 动作关联的诊断 == **面上那一条**的身份（线由别家画，认领的仍是同一次问题）
    expect(actions[0]!.diagnostics).toEqual([conventionSurfaceDecoration(issues[0]!)]);
    expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
  });

  it('一行两处「续」⇒ 不知道搬哪一处 ⇒ 一条都不动（不猜）；线归发布方，本层不重复发', async () => {
    const text = '时机 对话：\n  「你好续」「再来续」\n';
    const issues = [
      {
        ruleId: CONT_INSIDE_QUOTES_RULE_ID,
        severity: 'error' as const,
        message: '「续」写在了引号内。',
        filePath: FILE_A,
        line: 2,
        column: 3,
      },
    ];
    const v = view(...issues);
    expect(
      conventionCodeActionsForFile(v, { path: FILE_A, text, scope: 'document', fixResolver: conventionIssueFixes }),
    ).toEqual([]);
    // 面上那一条由发布方画（本层不再重复发 ⇒ 合并后不翻倍，见 `decorator-ownership.test.ts`）
    expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
    expect(v.get(pathKey(FILE_A))?.issues).toHaveLength(1);
  });

  it('真·内置 `erb.duplicate-function`：info 上得了线，但拿不出可证明改法 ⇒ 不产动作', async () => {
    const text = '@AAA\nPRINTDATA\nEND\n@AAA\nPRINTDATA\nEND\n';
    const index = parseDuplicateIndex(text);
    const project = {
      rootDir: 'C:/game',
      adapterId: 'test',
      kojoPaths: [],
      writablePaths: [],
      charaIndex: new Map(),
    } as unknown as GameProject;
    const ctx = { project, index, log: silentLog, readFile: async () => text };
    const issues = (await duplicateFunctionRule.check!(ctx)) ?? [];
    expect(issues.length).toBeGreaterThan(0);
    const v = view(...issues);
    const path = [...v.values()][0]!.path;
    const decorations = conventionDecorationsForFile(v, path);
    expect(decorations.every((d) => d.severity === 'info')).toBe(true);
    expect(
      conventionCodeActionsForFile(v, { path, text, scope: 'document', fixResolver: conventionIssueFixes }),
    ).toEqual([]);
  });

  it('规则自带 `edits`（列级 loc/end）时折叠层原样落地，不再问兜底供给方', () => {
    const withEdits = issue({
      ruleId: 'erb.indent',
      severity: 'warning',
      message: '缩进不齐',
      line: 2,
      edits: [
        {
          description: '按所在块补齐缩进',
          newText: '  ',
          // 契约 `Loc`：**0 基列**、`end` 不含 ⇒ `[0,0)` = 行首插入（旧写法按 1 基列传 1，
          // 在这把尺子下会插到第一个字后面 = 改坏作者的行）
          loc: { line: 2, column: 0 },
          end: { line: 2, column: 0 },
        },
      ],
    });
    const v = view(withEdits);
    const actions = conventionCodeActionsForFile(v, {
      path: FILE_A,
      text: '时机 对话：\n你好\n',
      scope: 'document',
      // 兜底供给方故意"投毒"：一旦真给 edits 就说明它压过了规则自带的
      fixResolver: () => [{ description: '兜底', loc: { line: 2, column: 0 }, newText: '不该被用到' }],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([{ fromLine: 2, toLine: 2, newText: '  你好' }]);
    expect(actions[0]!.title).toBe('按所在块补齐缩进');
  });

  /* ---------------- 真转译器 × 只读别名（装配通道注入，判据③的另一半） ---------------- */

  /**
   * 契约口径：**别名声明必须在所有 `时机` 块之前**，违者转译器另报 `alias-not-in-header`
   * ⇒ 夹具一律写成文件头形态，别把另一条判据的产物混进本层的对账里。
   */
  const ALIAS_NOOP = ['角色: 12', '别名 冷淡 = 0', '时机 指令 310：', '    冷淡 = 0'].join('\n');
  const ALIAS_CHANGED = ['角色: 12', '别名 冷淡 = 0', '时机 指令 310：', '    冷淡 = 5'].join('\n');

  /** 走**装配点同一通道**（模块级惰性 provider + 内置单例规则），不是自己 new 一条规则 */
  async function issuesViaAssembly(src: string): Promise<ConventionIssue[]> {
    const all = (await sugarStaticConventionsRule.check!(ctxFor({ [FILE_A]: src }))) ?? [];
    return all.filter((i) => i.ruleId === READONLY_ALIAS_ASSIGN_RULE_ID);
  }

  it('真转译器：只读别名的空写入 ⇒ 有红线 + 一键注释掉（右值与绑定字面量逐字相同 = 零语义变化）', async () => {
    setSugarTranspileProvider(() => createSugarTranspileService({ faceTable: createEratwFaceTable() }));
    try {
      const issues = await issuesViaAssembly(ALIAS_NOOP);
      expect(issues.map((i) => i.line), `夹具要让真转译器在第 4 行报出该码：${JSON.stringify(issues)}`).toEqual([4]);
      const v = view(...issues);
      // 线归发布方（`.kojo1` 上的糖族由 `sugar-diagnostics` 画）⇒ 本层不再重复发；
      // issue 仍在桶里（项目级结论一条不少），💡 认领的是面上那一条的身份
      expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
      expect(v.get(pathKey(FILE_A))?.issues).toHaveLength(1);
      const actions = conventionCodeActionsForFile(v, {
        path: FILE_A,
        text: ALIAS_NOOP,
        scope: 'document',
        fixResolver: conventionIssueFixes,
      });
      expect(actions).toHaveLength(1);
      expect(actions[0]!.edits).toEqual([{ fromLine: 4, toLine: 4, newText: '; 冷淡 = 0' }]);
      expect(actions[0]!.title).toBe('注释掉这条无效赋值（右值与只读别名绑定的字面量相同）');
      // 改完之后这条红线自己消失（把修法真应用到文本再跑一遍 = 唯一不自证的判据）
      const fixedText = ALIAS_NOOP.split('\n').map((l, i) => (i === 3 ? '; 冷淡 = 0' : l)).join('\n');
      expect(await issuesViaAssembly(fixedText)).toEqual([]);
    } finally {
      setSugarTranspileProvider(null);
    }
  });

  it('真转译器：右值不同（`冷淡 = 5`）⇒ 换绑/改名/删别名是作者的决定 ⇒ 只报不修', async () => {
    setSugarTranspileProvider(() => createSugarTranspileService({ faceTable: createEratwFaceTable() }));
    try {
      const issues = await issuesViaAssembly(ALIAS_CHANGED);
      expect(issues).toHaveLength(1);
      const v = view(...issues);
      // 线归发布方（`.kojo1` 上的糖族由 `sugar-diagnostics` 画）⇒ 本层不再重复发；
      // issue 仍在桶里（项目级结论一条不少），💡 认领的是面上那一条的身份
      expect(conventionDecorationsForFile(v, FILE_A)).toEqual([]);
      expect(v.get(pathKey(FILE_A))?.issues).toHaveLength(1);
      expect(
        conventionCodeActionsForFile(v, { path: FILE_A, text: ALIAS_CHANGED, scope: 'document', fixResolver: conventionIssueFixes }),
      ).toEqual([]);
    } finally {
      setSugarTranspileProvider(null);
    }
  });

  it('服务缺席（未接线）⇒ 规则抛进 failedRules 通道、本层零装饰（绝不把"没结论"画成"没问题"）', async () => {
    setSugarTranspileProvider(null);
    const rule = sugarStaticConventionsRule;
    await expect(rule.check!(ctxFor({ [FILE_A]: ALIAS_NOOP }))).rejects.toThrow(/未接线/);
    expect(conventionDecorationsForFile(buildConventionIssueView([]), FILE_A)).toEqual([]);
  });
});

/* ====================== 判据①：身份键与宿主逐字同尺 ====================== */

/**
 * 宿主 `app/src/monaco/kojo-code-action.ts:68` 的 `diagnosticKey`（这里逐字复刻一份当闸：
 * 尺子一漂移，症状是"波浪线上按不出菜单"——静默、不报错，只能靠这条测试钉住）。
 */
function hostDiagnosticKey(d: LineDecoration): string {
  return [d.severity, d.line, d.message, d.code ?? ''].join('\u0000');
}

describe('装饰与 Ctrl+. 说的是同一次问题（身份键对账）', () => {
  const dec = conventionIssueDecoration(
    issue({ ruleId: CONT_INSIDE_QUOTES_RULE_ID, severity: 'error', message: '「续」写在了引号内。', line: 2, column: 4 }),
  )!;

  it('折叠层的键 === 宿主 diagnosticKey 的算法（同一把尺，不是"看着像"）', () => {
    expect(conventionIssueKey(dec)).toBe(hostDiagnosticKey(dec));
  });

  it('marker 回译补的默认列、丢掉 `source` 都不影响认领 ⇒ 列与标签**不进键**', () => {
    // `markersToDecorations`（宿主反向翻译）必然带上 `startColumn`/`endColumn`（正向翻译补过默认值），
    // 且**不回传 `source`**。这两样进了键，正向与反向就是两条不同诊断 ⇒ isPreferred 永远点不亮。
    const back: LineDecoration = {
      line: dec.line,
      severity: dec.severity,
      message: dec.message,
      startColumn: 1,
      endColumn: 999,
      code: dec.code,
    };
    expect(conventionIssueKey(back)).toBe(conventionIssueKey(dec));
    expect(conventionIssueKey({ ...back, source: '别的标签' })).toBe(conventionIssueKey(dec));
    // 反过来：四要素任一不同就是两条问题（不许近似）
    expect(conventionIssueKey({ ...back, message: '别的消息' })).not.toBe(conventionIssueKey(dec));
    expect(conventionIssueKey({ ...back, code: 'other.rule' })).not.toBe(conventionIssueKey(dec));
    expect(conventionIssueKey({ ...back, severity: 'warning' })).not.toBe(conventionIssueKey(dec));
    expect(conventionIssueKey({ ...back, line: 3 })).not.toBe(conventionIssueKey(dec));
  });
});

/* ====================== 判据②：状态栏「问题 n」× convention-counts 对账 ====================== */

describe('两个数字的差额是**算得出来的**（不各说各话）', () => {
  const mixed: ConventionIssue[] = [
    issue({ ruleId: 'r.a', message: 'A 可画', line: 1 }),
    issue({ ruleId: 'r.b', message: 'B 可画', line: 2, column: 3 }),
    issue({ ruleId: 'r.c', message: 'C 整项目级结论', filePath: undefined, line: undefined }),
    issue({ ruleId: 'r.d', message: 'D 只有文件没有行', line: undefined }),
    // E：`.kojo1` 上的糖族 ⇒ 行装饰归 `sugar-diagnostics`（本层只记账，不再画第二条）
    issue({ ruleId: CONT_INSIDE_QUOTES_RULE_ID, severity: 'error', message: 'E 归发布方画', line: 5 }),
  ];

  it('面上红线数 = **归本层画**且有位置可画的 issue 数（一一对应：不多画、不漏画、不折叠）', () => {
    const v = buildConventionIssueView(mixed);
    const decorated = [...v.values()].reduce((n, b) => n + b.decorations.length, 0);
    const drawable = mixed.filter(
      (i) =>
        i.filePath &&
        typeof i.line === 'number' &&
        i.line >= 1 &&
        !conventionSquiggleOwnedElsewhere(i),
    ).length;
    expect(decorated).toBe(drawable);
    // 差额三类，且**逐条有名有姓**（面板与 `report.counts` 照样统计它们 ⇒ 不静默）：
    // 无文件归属、有文件无行号、归发布方画的那一条
    expect(mixed.length - decorated).toBe(3);
    expect(v.get(pathKey(FILE_A))?.issues.map((i) => i.ruleId)).toEqual([
      'r.a',
      'r.b',
      'r.d',
      CONT_INSIDE_QUOTES_RULE_ID,
    ]);
    // 无 filePath 的那条不属于任何一棵文件 ⇒ 任何桶里都没有它
    expect([...v.values()].some((b) => b.issues.some((i) => i.ruleId === 'r.c'))).toBe(false);
    // 归发布方那一条**进了桶、没进装饰**（项目级结论一条不少，面上不重复画）
    const delegated = mixed.filter(conventionSquiggleOwnedElsewhere);
    expect(delegated.map((i) => i.ruleId)).toEqual([CONT_INSIDE_QUOTES_RULE_ID]);
    expect(
      [...v.values()].reduce((n, b) => n + b.issues.filter(conventionSquiggleOwnedElsewhere).length, 0),
    ).toBe(delegated.length);
  });

  it('同一行两处同文案问题 = 两条装饰（不折叠成一条），列位各归各', () => {
    // 用 `test.` 规则：糖族在 `.kojo1` 上归发布方画线，拿它测"同文案两处不折叠"会测到归属闸上去
    const v = buildConventionIssueView([
      issue({ ruleId: 'test.dup', severity: 'error', message: 'm', line: 2, column: 0 }),
      issue({ ruleId: 'test.dup', severity: 'error', message: 'm', line: 2, column: 5 }),
    ]);
    const decorations = conventionDecorationsForFile(v, FILE_A);
    expect(decorations).toHaveLength(2);
    expect(decorations.map((d) => d.startColumn)).toEqual([1, 6]);
  });

  it('糖侧那一族已由 `sugar-diagnostics` 发布 ⇒ 本层的差额账要报得出"哪些条只进计数、不进面上这一棵文件"', () => {
    // 面上「问题 n」= **全部**装饰贡献 × **仅已打开**的文件；`convention-counts` = 全项目去重 issue 按严重度。
    // 两数天然不等（本层不假装能消除），但差额必须逐条可归因：①无文件归属；②无行号；
    // ③归发布方画的糖族（线在面上由别家发，本层不重复）；④未打开的文件；⑤别的贡献方
    // （ERB 结构 / 表达式）自己的账。①②③由上面这条与 `decorator-ownership.test.ts` 钉死。
    const v = buildConventionIssueView(mixed);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const i of mixed) counts[i.severity]++;
    const total = counts.error + counts.warning + counts.info;
    const decorated = [...v.values()].reduce((n, b) => n + b.decorations.length, 0);
    const unplaceable = mixed.filter((i) => !i.filePath).length + mixed.filter((i) => i.filePath && i.line === undefined).length;
    const delegated = mixed.filter(conventionSquiggleOwnedElsewhere).length;
    expect(total).toBe(decorated + unplaceable + delegated);
  });
});

/** 真规则的索引夹具：同名函数两处定义（`erb.duplicate-function` 的输入面） */
function parseDuplicateIndex(text: string): ErbIndex {
  const file = parseErbText(text, 'C:/game/data/erbkoujo/a.erb');
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const fn of file.functions) {
    const refs = byName.get(fn.normalizedName) ?? [];
    refs.push({
      name: fn.name,
      normalizedName: fn.normalizedName,
      filePath: fn.filePath,
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
    byName.set(fn.normalizedName, refs);
  }
  return { files: new Map([[file.path, file]]), byName };
}

it('`.ERB` 不吃糖侧兜底修法（那条判据只归 `.kojo1`）', () => {
  expect(
    conventionIssueFixes(
      { ruleId: CONT_INSIDE_QUOTES_RULE_ID, severity: 'error', message: 'x', filePath: FILE_B, line: 1 },
      ['「你好续」'],
    ),
  ).toEqual([]);
});