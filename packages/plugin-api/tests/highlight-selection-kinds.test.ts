/**
 * B3f · 同符号高亮（`documentHighlight`）与结构化扩选（`selectionRange`）的契约闸。
 *
 * 契约是 additive 的：两个判别成员**加在联合末尾**，旧成员一格不动。这里钉四件事：
 * 1. **位置在末尾**：既有成员（含 B3e 的 references / rename）顺序不被重排；
 * 2. **形状**：高亮每处是单行区间 + **必填**三档 `kind`（缺省不许猜）；扩选的
 *    `selections` 与 `positions` 同序同长，`null` = 该位点显式空链，链是
 *    `{ range, parent? }` 的经典 LSP 嵌套形状（摊平只在宿主安装层做）；
 * 3. **三态可分**：整条能力无人应答（宿主交 `[]`）与"某位点空链"（`null`）是两件事——
 *    后者必须能表达，否则供方只能靠"少给一条"装空链，宿主按位点对齐就错位；
 * 4. **桶导出**：新类型从 `@kojo/plugin-api` 桶里可拿（供方与宿主同一枚类型）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EditorDocumentHighlight,
  EditorDocumentHighlightKind,
  EditorDocumentHighlightRequest,
  EditorDocumentHighlightResult,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorSelectionChain,
  EditorSelectionRangeRequest,
  EditorSelectionRangeResult,
} from '@kojo/plugin-api';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SLOTS_SRC = readFileSync(
  fileURLToPath(new URL('../src/slots.ts', import.meta.url)),
  'utf8',
);

/** 取某个联合（`export type X = …;`）里的成员名，按源码顺序 */
function unionMembers(name: string): string[] {
  const head = `export type ${name} =`;
  const start = SLOTS_SRC.indexOf(head);
  if (start < 0) throw new Error(`契约里找不到 ${name}`);
  const end = SLOTS_SRC.indexOf(';', start);
  return [...SLOTS_SRC.slice(start, end).matchAll(/\|\s*(Editor\w+)/g)].map((m) => m[1] as string);
}

/** 取某个 `export interface Name` 区块正文（到收尾大括号为止） */
function interfaceBody(name: string): string {
  const at = SLOTS_SRC.indexOf(`export interface ${name}`);
  if (at < 0) throw new Error(`契约里找不到 ${name}`);
  const brace = SLOTS_SRC.indexOf('{', at);
  const end = SLOTS_SRC.indexOf('\n}', brace);
  if (brace < 0 || end < 0) throw new Error(`${name} 的接口块不完整`);
  return SLOTS_SRC.slice(brace + 1, end);
}

/* ============================== ① 联合成员：加在末尾 ============================== */

describe('新成员只许加在联合末尾（既有顺序一格不动）', () => {
  const requests = unionMembers('EditorLanguageServiceRequest');
  const results = unionMembers('EditorLanguageServiceResult');

  it('请求 / 结果尾部就是后加的五枚，且顺序一致', () => {
    expect(requests.slice(-5)).toEqual([
      'EditorDocumentHighlightRequest',
      'EditorSelectionRangeRequest',
      'EditorRenameTargetRequest',
      'EditorCallHierarchyRequest',
      'EditorImplementationRequest',
    ]);
    expect(results.slice(-5)).toEqual([
      'EditorDocumentHighlightResult',
      'EditorSelectionRangeResult',
      'EditorRenameTargetResult',
      'EditorCallHierarchyResult',
      'EditorImplementationResult',
    ]);
  });

  it('B3e 的两枚仍在它们之前（加成员不许重排既有项）', () => {
    const references = requests.indexOf('EditorReferencesRequest');
    const rename = requests.indexOf('EditorRenameRequest');
    expect(references).toBeGreaterThan(-1);
    expect(rename).toBe(references + 1);
    expect(references).toBeLessThan(requests.indexOf('EditorDocumentHighlightRequest'));
  });

  it('请求与结果逐项对齐（多一个少一个都是漏改）', () => {
    const stem = (name: string): string => name.replace(/(Request|Result)$/, '');
    expect(requests.map(stem)).toEqual(results.map(stem));
  });
});

/* ============================== ② 高亮：形状与必填档位 ============================== */

describe('documentHighlight：单行区间 + 必填三档 kind', () => {
  it('坐标是 line / startColumn / endColumn（单行，模型坐标），kind 必填', () => {
    const body = interfaceBody('EditorDocumentHighlight');
    for (const field of ['line', 'startColumn', 'endColumn', 'kind']) {
      expect(body, `缺少 ${field}`).toMatch(new RegExp(`readonly ${field}\\??:`));
    }
    // `kind` 不许带 `?`：缺省 = "宿主替供方猜这一处算声明还是引用"
    expect(body).toMatch(/readonly kind: EditorDocumentHighlightKind;/);
  });

  it('三档就是 text / read / write，没有第四种', () => {
    expectTypeOf<EditorDocumentHighlightKind>().toEqualTypeOf<'text' | 'read' | 'write'>();
  });

  it('最小响应只是一组出现处（不夹带渲染面字段）', () => {
    const highlight: EditorDocumentHighlight = {
      line: 5,
      startColumn: 6,
      endColumn: 8,
      kind: 'write',
    };
    const result: EditorDocumentHighlightResult = {
      kind: 'documentHighlight',
      highlights: [highlight],
    };
    expect(result.highlights).toEqual([highlight]);
  });

  it('请求与 definition 同族：path / text / line / column / project 都在', () => {
    const request: EditorDocumentHighlightRequest = {
      kind: 'documentHighlight',
      path: 'D:/p/a.kojo',
      text: '# 变量 心情 整数',
      line: 1,
      column: 8,
      project: null,
    };
    expect(request.kind).toBe('documentHighlight');
    // 旧的判别成员仍是彼此的子集关系：同一个对象不会被两个 kind 同时认领
    expect((request as EditorLanguageServiceRequest).kind).toBe('documentHighlight');
  });
});

/* ============================== ③ 扩选：同序同长 + 空链 ============================== */

describe('selectionRange：与 positions 同序同长，空链用 null 表达', () => {
  it('请求带 positions（1 基行列，内联形状）且 lineCount 可选', () => {
    const positions: EditorSelectionRangeRequest['positions'] = [
      { line: 3, column: 5 },
      { line: 9, column: 1 },
    ];
    const request: EditorSelectionRangeRequest = {
      kind: 'selectionRange',
      path: 'D:/p/a.kojo',
      text: 'x',
      project: null,
      positions,
    };
    expect(request.positions).toHaveLength(2);
    expect(Object.hasOwn(request, 'lineCount')).toBe(false);
    expect((request as EditorLanguageServiceRequest).kind).toBe('selectionRange');
  });

  it('链是 { range, parent? }：最内层在返回值本身，parent 逐级向外', () => {
    const chain: EditorSelectionChain = {
      range: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 7 },
      parent: {
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 20 },
        parent: { range: { startLine: 1, startColumn: 1, endLine: 9, endColumn: 1 } },
      },
    };
    const result: EditorSelectionRangeResult = {
      kind: 'selectionRange',
      selections: [chain, null],
    };
    expect(result.selections).toHaveLength(2);
    expect(result.selections[0]!.parent!.parent!.range.endLine).toBe(9);
    // `null` = 该位点显式空链（越界 / 空文件 / 非法坐标），**不是**弃权
    expect(result.selections[1]).toBeNull();
  });

  it('`parent` 可缺省（只扩到一级也是合法链）', () => {
    const leaf: EditorSelectionChain = {
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    };
    expect(Object.hasOwn(leaf, 'parent')).toBe(false);
    expect((leaf as EditorSelectionChain).range.startColumn).toBe(1);
  });

  it('结果声明的类型逐字是 `readonly (EditorSelectionChain | null)[]`（同长 + 空链）', () => {
    const body = interfaceBody('EditorSelectionRangeResult');
    expect(body).toMatch(/readonly selections: readonly \(EditorSelectionChain \| null\)\[\];/);
  });
});

/* ============================== ④ 桶导出 ============================== */

describe('桶导出：供方与宿主取的是同一枚类型', () => {
  it('七个新名字都在桶里（源码取证，不靠 import 编过就算）', () => {
    const barrel = readFileSync(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf8',
    );
    for (const name of [
      'EditorDocumentHighlight',
      'EditorDocumentHighlightKind',
      'EditorDocumentHighlightRequest',
      'EditorDocumentHighlightResult',
      'EditorSelectionChain',
      'EditorSelectionRangeRequest',
      'EditorSelectionRangeResult',
    ]) {
      expect(barrel, `桶里没有 ${name}`).toContain(name);
    }
  });
});
