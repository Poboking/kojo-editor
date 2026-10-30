/**
 * `ui.editor.languageService` 的判别成员表守卫（LS-B0）+ B3c 补全/悬停贡献面字段的
 * additive 守卫。
 *
 * LS-B0 部分只钉**一件**事：`diagnostics` 与 `codeAction` **不在**这个联合里，而且
 * 这**不是遗漏**——它们各自有专用槽（`ui.editor.decorator` / `ui.editor.codeAction`），
 * 再开一个判别成员就是同一能力两条路径。
 *
 * 为什么值得一条测试：这张表最容易被"顺手补一个 kind"改动，而补错的代价是隐性的——
 * 两份判据同时活着时，任何一次结果不一致都表现为"有时候对、有时候不对"，没有人会
 * 想到去查契约。理由写在 `slots.ts` 的 LS-B0 区块头，这里只负责让"重新加回去"
 * 必须显式删掉这条测试（也就必须读到那段理由）。
 *
 * B3c 部分钉两件事（口径同上，形状用 `expectTypeOf`、"不许存在的东西"用源码文本反证）：
 * ①**缺省 = 旧行为**——新格（`range` / `filterText` / `documentationFormat` / `format`）
 * 全部可选、旧六档 kind 逐字在前，最小贡献形状（只给 `label` / 只给 `contents`）照编得过；
 * ②**新增值可用**——扩出的六档 kind 与 `EditorLanguageRange` 三元组能被类型接住。
 *
 * B3d 部分只补一格：`EditorFormattingRequest.lineRange`（格式化区间）同样是**可选**的，
 * 不给 = 整篇（旧宿主的请求对象一个字都不用改），给了 = 只落这几行。签名帮助**不加字段**
 * （`EditorSignature.documentation` 是纯文本，已经装得下）。
 *
 * 判据取自**源码文本**而不是类型系统：类型系统只能证明"我写的这行能编过"，
 * 证明不了"这两行没有一起存在"。与 `compute-task-table-single-source.test.ts` 同口径。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorFormattingLineRange,
  EditorFormattingRequest,
  EditorHoverResult,
  EditorLanguageRange,
} from '../src/slots';

const SLOTS_SRC = readFileSync(
  fileURLToPath(new URL('../src/slots.ts', import.meta.url)),
  'utf8',
);

/** 桶（`src/index.ts`）：新类型只进 slots 不进桶 = 外部消费方 import 不到 */
const BARREL_SRC = readFileSync(
  fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  'utf8',
);

/** 取某个 `export type Xxx =` 起、到下一个 `;` 止的文本 */
function unionBody(name: string): string {
  const head = `export type ${name} =`;
  const start = SLOTS_SRC.indexOf(head);
  if (start < 0) throw new Error(`契约里找不到 ${name}`);
  const end = SLOTS_SRC.indexOf(';', start);
  if (end < 0) throw new Error(`${name} 的联合没有结尾分号`);
  return SLOTS_SRC.slice(start + head.length, end);
}

/** 联合里出现的成员名（按源码顺序） */
function membersOf(name: string): string[] {
  return [...unionBody(name).matchAll(/\|\s*(Editor\w+)/g)].map((m) => m[1] as string);
}

/**
 * 取某个 `export interface Name { … }` 区块正文（到收尾大括号为止）。
 *
 * 起点按 `export interface Name` 找、再取其后第一个 `{`：接口可能带 `extends X`（B3d 的
 * `EditorFormattingRequest` 就带着 `EditorDocumentIdentity`），钉死 `Name {` 会让取证当场
 * 找不到接口——那是测试写脆了，不是契约错了。
 */
function interfaceBody(name: string): string {
  const head = `export interface ${name}`;
  const at = SLOTS_SRC.indexOf(head);
  if (at < 0) throw new Error(`契约里找不到 ${name}`);
  const brace = SLOTS_SRC.indexOf('{', at);
  if (brace < 0) throw new Error(`${name} 的接口没有开头大括号`);
  const end = SLOTS_SRC.indexOf('\n}', brace);
  if (end < 0) throw new Error(`${name} 的接口没有收尾大括号`);
  return SLOTS_SRC.slice(brace + 1, end);
}

/** `EditorCompletionItemKind` 联合里的字面量档名（按源码顺序） */
function kindLiterals(): string[] {
  return [...unionBody('EditorCompletionItemKind').matchAll(/'([a-z]+)'/g)].map(
    (m) => m[1] as string,
  );
}

describe('ui.editor.languageService 的判别成员表', () => {
  const requests = membersOf('EditorLanguageServiceRequest');
  const results = membersOf('EditorLanguageServiceResult');

  it('请求与响应逐项对齐（多一个少一个都是漏改）', () => {
    // 按"去掉 Result / Request 后缀"比：definition ↔ EditorDefinitionResult 这类配对
    const stem = (name: string): string => name.replace(/(Request|Result)$/, '');
    expect(requests.map(stem)).toEqual(results.map(stem));
  });

  it('LS-B0 的四个新成员都在（completion / hover / formatting / signatureHelp）', () => {
    expect(requests).toContain('EditorCompletionRequest');
    expect(requests).toContain('EditorHoverRequest');
    expect(requests).toContain('EditorFormattingRequest');
    expect(requests).toContain('EditorSignatureHelpRequest');
  });

  it('`diagnostics` / `codeAction` 刻意不在（它们各有专用槽，别加回来）', () => {
    expect(requests).not.toContain('EditorDiagnosticsRequest');
    expect(requests).not.toContain('EditorCodeActionRequest');
    expect(results).not.toContain('EditorDiagnosticsResult');
    expect(results).not.toContain('EditorCodeActionResult');
  });

  it('专用槽仍然在（上面那条"别加回来"的前提是这两个槽还活着）', () => {
    expect(SLOTS_SRC).toContain(`'ui.editor.decorator': EditorDecoratorContribution`);
    expect(SLOTS_SRC).toContain(`'ui.editor.codeAction': EditorCodeActionContribution`);
  });
});

/* ======================= B3c：补全/悬停贡献面的 additive 字段 ======================= */

const OLD_KINDS = ['keyword', 'function', 'variable', 'value', 'snippet', 'text'] as const;
const NEW_KINDS = ['operator', 'event', 'constant', 'struct', 'enum', 'module'] as const;
/**
 * LAU-4 补全腿（2026-10-31）additive 的第十三档：`$标签` 一类"本文件内可达的具名引用"。
 * 单列一张表而不是并进 `NEW_KINDS`：那张表说的是"B3c 那一批"，本档是后来的一批，
 * 分组本身就是记账（谁加的、为什么加，看分组注释）。
 */
const LAU_KINDS = ['reference'] as const;
/**
 * LAU-4 补全腿第三批（2026-10-31）additive 的两档：值域里的**某一项**（`enumMember`，ERB 位号）
 * 与作用域记录里的**一格**（`field`，ERB 三段式变量末段）。同样单列分组，理由同上——
 * 记账的是"谁加的、为什么加"，不是"凑够几档"。
 */
const LAU3_KINDS = ['enumMember', 'field'] as const;

describe('B3c · 缺省 = 旧行为（新格全部可选，最小形状照过）', () => {
  it('`EditorCompletionItem` 的三个新格都是可选字段（必填写法一出现即红）', () => {
    const body = interfaceBody('EditorCompletionItem');
    for (const field of ['range', 'filterText', 'documentationFormat']) {
      expect(body).toMatch(new RegExp(`^\\s+readonly ${field}\\?:`, 'm'));
      expect(body).not.toMatch(new RegExp(`^\\s+readonly ${field} *:`, 'm'));
    }
  });

  it('`EditorHoverResult` 的两个新格都是可选字段', () => {
    const body = interfaceBody('EditorHoverResult');
    for (const field of ['format', 'range']) {
      expect(body).toMatch(new RegExp(`^\\s+readonly ${field}\\?:`, 'm'));
      expect(body).not.toMatch(new RegExp(`^\\s+readonly ${field} *:`, 'm'));
    }
  });

  it('最小贡献形状照编得过：只给 `label` 的候选、只给 `kind`+`contents` 的悬停', () => {
    const bare: EditorCompletionItem = { label: 'X' };
    expect(bare).toEqual({ label: 'X' });
    const hover: EditorHoverResult = { kind: 'hover', contents: '正文' };
    expect(hover).toEqual({ kind: 'hover', contents: '正文' });
    // 缺省格在类型面是 `| undefined`——"不给"与"给旧形态"在运行时不可区分（纯类型契约）
    expectTypeOf<EditorCompletionItem['range']>().toEqualTypeOf<EditorLanguageRange | undefined>();
    expectTypeOf<EditorCompletionItem['filterText']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EditorCompletionItem['documentationFormat']>().toEqualTypeOf<
      'text' | 'markdown' | undefined
    >();
    expectTypeOf<EditorHoverResult['format']>().toEqualTypeOf<'text' | 'markdown' | undefined>();
    expectTypeOf<EditorHoverResult['range']>().toEqualTypeOf<EditorLanguageRange | undefined>();
  });

  it('旧六档 kind 逐字在前（additive：扩档不许重排/改名既有条目）', () => {
    expect(kindLiterals().slice(0, 6)).toEqual([...OLD_KINDS]);
  });
});

/* ======================= B3d：格式化请求的区间（additive） ======================= */

describe('B3d · 格式化区间 additive（缺省 = 整篇，给区间 = 只落选中行）', () => {
  it('`lineRange` 是可选字段（必填写法一出现即红）', () => {
    const body = interfaceBody('EditorFormattingRequest');
    expect(body).toMatch(/^\s+readonly lineRange\?:/m);
    expect(body).not.toMatch(/^\s+readonly lineRange *:/m);
  });

  it('桶里也导出这枚新类型（只进 slots 不进桶 ⇒ 插件 import 不到，B3d 实际踩过）', () => {
    // 反向教训：类型住在 `slots.ts`、测试也从 `slots.ts` 取 ⇒ 桶漏一行全员绿，
    // 而插件（唯一消费方）从 `@kojo/plugin-api` 取时直接编不过。
    expect(BARREL_SRC).toMatch(/^\s+EditorFormattingLineRange,$/m);
  });

  it('缺省 = 整篇旧行为：不传 `lineRange` 的请求照编得过，且逐格与加格之前相同', () => {
    // 最小形状（旧宿主 / 直调）——多一个必填格就编不过，这条就是"逐字不变"的类型面证据
    const whole: EditorFormattingRequest = {
      kind: 'formatting',
      path: 'C:/proj/chara.kojo',
      text: '# 机 开场\n',
      project: null,
    };
    expect(whole).toEqual({
      kind: 'formatting',
      path: 'C:/proj/chara.kojo',
      text: '# 机 开场\n',
      project: null,
    });
    // 运行时"没给"就是 `undefined`（纯类型契约：供方拿它区分整篇 / 区间）
    expect(whole.lineRange).toBeUndefined();
    expectTypeOf<EditorFormattingRequest['lineRange']>().toEqualTypeOf<
      EditorFormattingLineRange | undefined
    >();
  });

  it('给 `lineRange` 可表达区间：1 基闭区间两枚行号，与整篇请求只差这一格', () => {
    const range: EditorFormattingLineRange = { startLine: 3, endLine: 3 };
    const ranged: EditorFormattingRequest = {
      kind: 'formatting',
      path: 'C:/proj/chara.kojo',
      text: '# 池 问候\n  ? 恋慕 < 100\n      「早。」\n',
      project: null,
      lineRange: range,
    };
    expect(ranged.lineRange).toEqual({ startLine: 3, endLine: 3 });
    // 单行选区是合法形态（`startLine === endLine`），不是特例
    expect(ranged.lineRange!.startLine).toBe(ranged.lineRange!.endLine);
    expectTypeOf<EditorFormattingLineRange>().toEqualTypeOf<{
      readonly startLine: number;
      readonly endLine: number;
    }>();
  });
});

describe('B3c · 新增值可用（六档新 kind 与新格能被类型接住）', () => {
  it('kind 联合恰好十五档：旧六档 + B3c 六档 + LAU-4 三批共三档，一张表封死（多一档少一档都要先读到注释）', () => {
    expect(kindLiterals()).toEqual([...OLD_KINDS, ...NEW_KINDS, ...LAU_KINDS, ...LAU3_KINDS]);
    expectTypeOf<EditorCompletionItemKind>().toEqualTypeOf<
      | (typeof OLD_KINDS)[number]
      | (typeof NEW_KINDS)[number]
      | (typeof LAU_KINDS)[number]
      | (typeof LAU3_KINDS)[number]
    >();
  });

  it('六枚新 kind 逐枚可赋值给候选的 `kind`', () => {
    const items: EditorCompletionItem[] = NEW_KINDS.map((kind) => ({ label: `k-${kind}`, kind }));
    expect(items.map((i) => i.kind)).toEqual([...NEW_KINDS]);
  });

  it('`range` / `filterText` / `documentationFormat` / `format` 的新值可构造', () => {
    const range: EditorLanguageRange = { line: 2, startColumn: 1, endColumn: 5 };
    const item: EditorCompletionItem = {
      label: 'demo',
      kind: 'struct',
      documentation: '**demo**',
      documentationFormat: 'markdown',
      filterText: 'demo',
      range,
    };
    expect(item.range).toEqual({ line: 2, startColumn: 1, endColumn: 5 });
    expect(item.documentationFormat).toBe('markdown');
    const hover: EditorHoverResult = { kind: 'hover', contents: '**demo**', format: 'markdown', range };
    expect(hover.format).toBe('markdown');
    expect(hover.range).toBe(item.range);
  });

  it('`EditorLanguageRange` 是必填三元组（半截区间不许进契约），补全与悬停共用同一枚类型', () => {
    expectTypeOf<EditorLanguageRange>().toEqualTypeOf<{
      readonly line: number;
      readonly startColumn: number;
      readonly endColumn: number;
    }>();
    // 别各造一套词汇：两处的 `range` 必须是**同一个**具名接口
    expectTypeOf<EditorCompletionItem['range']>().toEqualTypeOf<EditorHoverResult['range']>();
  });
});
