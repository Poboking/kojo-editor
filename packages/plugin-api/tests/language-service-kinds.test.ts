/**
 * `ui.editor.languageService` 的判别成员表守卫（LS-B0）。
 *
 * 本文件只钉**一件**事：`diagnostics` 与 `codeAction` **不在**这个联合里，而且
 * 这**不是遗漏**——它们各自有专用槽（`ui.editor.decorator` / `ui.editor.codeAction`），
 * 再开一个判别成员就是同一能力两条路径。
 *
 * 为什么值得一条测试：这张表最容易被"顺手补一个 kind"改动，而补错的代价是隐性的——
 * 两份判据同时活着时，任何一次结果不一致都表现为"有时候对、有时候不对"，没有人会
 * 想到去查契约。理由写在 `slots.ts` 的 LS-B0 区块头，这里只负责让"重新加回去"
 * 必须显式删掉这条测试（也就必须读到那段理由）。
 *
 * 判据取自**源码文本**而不是类型系统：类型系统只能证明"我写的这行能编过"，
 * 证明不了"这两行没有一起存在"。与 `compute-task-table-single-source.test.ts` 同口径。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
