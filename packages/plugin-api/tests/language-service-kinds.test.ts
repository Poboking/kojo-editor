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
 * 判据取自**源码文本**而不是类型系统：类型系统只能证明"我写的这行能编过"，
 * 证明不了"这两行没有一起存在"。与 `compute-task-table-single-source.test.ts` 同口径。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorHoverResult,
  EditorLanguageRange,
} from '../src/slots';

const SLOTS_SRC = readFileSync(
  fileURLToPath(new URL('../src/slots.ts', import.meta.url)),
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

/** 取某个 `export interface Name { … }` 区块正文（到收尾大括号为止） */
function interfaceBody(name: string): string {
  const head = `export interface ${name} {`;
  const start = SLOTS_SRC.indexOf(head);
  if (start < 0) throw new Error(`契约里找不到 ${name}`);
  const end = SLOTS_SRC.indexOf('\n}', start);
  if (end < 0) throw new Error(`${name} 的接口没有收尾大括号`);
  return SLOTS_SRC.slice(start + head.length, end);
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

describe('B3c · 新增值可用（六档新 kind 与新格能被类型接住）', () => {
  it('kind 联合恰好十二档：旧六档 + 新六档，一张表封死（多一档少一档都要先读到注释）', () => {
    expect(kindLiterals()).toEqual([...OLD_KINDS, ...NEW_KINDS]);
    expectTypeOf<EditorCompletionItemKind>().toEqualTypeOf<
      (typeof OLD_KINDS)[number] | (typeof NEW_KINDS)[number]
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
