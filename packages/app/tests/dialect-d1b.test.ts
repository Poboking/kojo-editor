/**
 * LAU-D1b 方言解析链的宿主钉子：解析语义仍是 `@kojo/kojo-core` 的
 * `resolveDialectBinding`（D1a 契约），这里钉的是**宿主这一层**——输入怎么凑、
 * 结果怎么投影、未绑定/冲突怎么上屏，以及 `EditorDocumentIdentity.dialect?` 的那一格。
 *
 * 覆盖面（与 DoD 逐条对应）：
 * 1. 打开工程（识别链结论）⇒ 绑定成功，状态栏读出 id；
 * 2. 未绑定（没项目 / 没 2.0 面）⇒ 空事实 + 一条 `core/dialect/unbound`，**不猜、不回落**；
 * 3. 工作区覆盖与识别链不一致 ⇒ `core/dialect/mismatch`（error）且**以覆盖为准**；
 * 4. 文件断言与解析结果不一致 ⇒ 同样 mismatch，但**归属不变**（断言只自证）；
 * 5. `factsFor` 交回别的方言 ⇒ `core/dialect/response-mismatch` 且按未绑定；
 * 6. 文件内断言的逐行取样式（文法 token 同形状；不碰文法 / wasm）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { GameAdapter, KojoDiagnostic } from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';
import {
  dialectContextOf,
  dialectStatusForProject,
  installDialectFactsFor,
  loadWorkspaceDialectOverride,
  readDialectAssertion,
  resolveDocumentDialect,
  setWorkspaceDialectOverride,
  workspaceDialectOverride,
} from '../src/ui/dialect-binding';
import { documentRequestFields } from '../src/ui/language-service-request';
import type {
  Kojo2DiagnosticsResult,
  Kojo2MarkerSeveritySource,
} from '../src/monaco/kojo2-diagnostics';
import { withDialectDiagnostics } from '../src/ui/kojo2-problem-wiring';

const ROOT = 'D:/game';
const PROJECT = { adapterId: 'erafl', rootDir: ROOT };

/** 只保留方言解析真正会读的两格（id / version）；其余事实与这一层无关 */
function adapter(id: string, version = '1.0.0'): GameAdapter {
  return { id, version } as unknown as GameAdapter;
}

function factsOf(table: Record<string, GameAdapter | null>): (dialect: string) => GameAdapter | null {
  return (dialect) => table[dialect] ?? null;
}

const codes = (resolution: ReturnType<typeof resolveDocumentDialect>): string[] =>
  resolution.diagnostics.map((item) => item.code);

afterEach(() => {
  installDialectFactsFor(null);
  setWorkspaceDialectOverride(ROOT, null);
});

describe('`# 方言 <id>` 的逐行断言读数（不改文法 / wasm）', () => {
  it('认行首的 `# 方言 erafl`，行号 1 基', () => {
    expect(readDialectAssertion('# 方言 erafl\n')).toEqual({ dialect: 'erafl', line: 1 });
    expect(readDialectAssertion('# 幕 神社\r\n# 方言 erafl\r\n')).toEqual({ dialect: 'erafl', line: 2 });
  });

  it('水平空白含 Tab / 全角空格；前导空白照收', () => {
    expect(readDialectAssertion('\t#\t方言\terafl\n')?.dialect).toBe('erafl');
    expect(readDialectAssertion('　#　方言　erafl\n')?.dialect).toBe('erafl');
    expect(readDialectAssertion('  # 方言 erafl 附带说明\n')?.dialect).toBe('erafl');
  });

  it('文法不认的形状这里也不认：`#方言` / `# 方言erafl` / 裸 `# 方言`', () => {
    expect(readDialectAssertion('#方言 erafl\n')).toBeNull();
    expect(readDialectAssertion('# 方言erafl\n')).toBeNull();
    expect(readDialectAssertion('# 方言\n')).toBeNull();
    // 裸写在前、带值在后：裸写不是断言，继续看下一行
    expect(readDialectAssertion('# 方言\n# 方言 erafl\n')?.dialect).toBe('erafl');
  });
});

describe('宿主解析：识别链 → 绑定', () => {
  it('打开 eraFL 工程：绑定成功，状态栏读出 `erafl`，上下文档带事实版本', () => {
    const factsFor = factsOf({ erafl: adapter('erafl', '2.1.0') });
    const resolution = resolveDocumentDialect({ project: PROJECT, factsFor });
    expect(resolution.kind).toBe('bound');
    expect(resolution.binding?.dialect).toBe('erafl');
    expect(dialectContextOf(resolution)).toEqual({
      dialect: 'erafl',
      factsVersion: '2.1.0',
      carrier: null,
    });
    // 还没登记事实：状态栏按未绑定说话（不借任何默认方言的事实）
    expect(dialectStatusForProject(PROJECT)).toMatchObject({ tone: 'unbound', label: '方言 未绑定' });
    installDialectFactsFor(factsFor);
    expect(dialectStatusForProject(PROJECT)).toMatchObject({ tone: 'bound', label: '方言 erafl' });
  });

  it('没项目 / 识别链零命中 ⇒ 未绑定：空事实 + `core/dialect/unbound`，绝不回落到默认方言', () => {
    const resolution = resolveDocumentDialect({
      project: null,
      factsFor: factsOf({ eratw: adapter('eratw') }),
    });
    expect(resolution.kind).toBe('unbound');
    expect(resolution.binding).toBeNull();
    expect(codes(resolution)).toContain('core/dialect/unbound');
    expect(resolution.diagnostics.find((d) => d.code === 'core/dialect/unbound')?.severity).toBe(
      'warning',
    );
    expect(dialectContextOf(resolution)).toBeNull();
    expect(dialectStatusForProject(null)).toMatchObject({ tone: 'unbound', label: '方言 未绑定' });
  });

  it('有方言 id 但没有 2.0 事实面 ⇒ 未绑定（不猜、不借别家）', () => {
    for (const dialect of ['eraakumamaid', 'erakoumakan', 'erasqc', 'eratohok']) {
      const resolution = resolveDocumentDialect({
        project: { adapterId: dialect, rootDir: ROOT },
        factsFor: factsOf({ eratw: adapter('eratw') }),
      });
      expect(resolution.kind).toBe('unbound');
      expect(resolution.binding).toBeNull();
      if (resolution.kind === 'unbound') expect(resolution.resolvedDialect).toBe(dialect);
      expect(resolution.diagnostics.map((d) => d.message).join('')).toContain('没有 2.0 事实面');
    }
  });
});

describe('覆盖 > 识别链；断言只自证', () => {
  it('工作区覆盖 ≠ 识别链 ⇒ mismatch（error）且**以覆盖为准**', () => {
    const resolution = resolveDocumentDialect({
      project: PROJECT,
      workspaceOverride: 'eratw',
      factsFor: factsOf({ erafl: adapter('erafl'), eratw: adapter('eratw', '3.0.0') }),
    });
    expect(resolution.kind).toBe('mismatch');
    expect(resolution.binding?.dialect).toBe('eratw');
    expect(resolution.binding?.factsVersion).toBe('3.0.0');
    expect(codes(resolution)).toContain('core/dialect/mismatch');
    expect(resolution.diagnostics.find((d) => d.code === 'core/dialect/mismatch')?.severity).toBe(
      'error',
    );
    expect(dialectContextOf(resolution)?.dialect).toBe('eratw');

    installDialectFactsFor(factsOf({ erafl: adapter('erafl'), eratw: adapter('eratw') }));
    expect(dialectStatusForProject(PROJECT)).toMatchObject({
      tone: 'bound',
      label: '方言 erafl',
    });
    setWorkspaceDialectOverride(ROOT, 'eratw');
    expect(workspaceDialectOverride(ROOT)).toBe('eratw');
    expect(dialectStatusForProject(PROJECT)).toMatchObject({
      tone: 'mismatch',
      label: '方言 eratw（冲突）',
    });
  });

  it('文件断言 ≠ 解析结果 ⇒ mismatch，但**归属不因断言改变**', () => {
    const resolution = resolveDocumentDialect({
      project: PROJECT,
      source: '# 方言 eratw\n> 正文\n',
      factsFor: factsOf({ erafl: adapter('erafl'), eratw: adapter('eratw') }),
    });
    expect(resolution.kind).toBe('mismatch');
    expect(resolution.binding?.dialect).toBe('erafl');
    expect(codes(resolution)).toContain('core/dialect/mismatch');
    expect(dialectContextOf(resolution)?.dialect).toBe('erafl');
  });

  it('`factsFor` 交回别的方言 ⇒ response-mismatch，按未绑定返回（不给半个事实）', () => {
    const resolution = resolveDocumentDialect({
      project: PROJECT,
      factsFor: () => adapter('eratw'),
    });
    expect(resolution.kind).toBe('unbound');
    expect(resolution.binding).toBeNull();
    expect(codes(resolution)).toContain('core/dialect/response-mismatch');
    expect(dialectContextOf(resolution)).toBeNull();
  });
});

describe('工作区清单的显式覆盖（只读；`workspace.json` 的 `meta.dialect`）', () => {
  it('工作区项目目录 = 当前工程根 ⇒ 取 `meta.dialect`；没有对应项目 ⇒ 清空', async () => {
    const workspaces = {
      list: async () => [
        { id: 'p1', meta: { dialect: 'eratw' } },
        { id: 'p2', meta: {} },
      ],
      projectDir: (id: string) => (id === 'p1' ? ROOT : 'D:/workspace/p2'),
    } as unknown as Parameters<typeof loadWorkspaceDialectOverride>[0];
    expect(await loadWorkspaceDialectOverride(workspaces, ROOT)).toBe('eratw');
    expect(workspaceDialectOverride(ROOT)).toBe('eratw');
    // 换一个没有覆盖的根：清空（不会拿上一个项目的覆盖过来）
    expect(await loadWorkspaceDialectOverride(workspaces, 'D:/workspace/p2')).toBeNull();
    expect(workspaceDialectOverride('D:/workspace/p2')).toBeNull();
  });
});

describe('`EditorDocumentIdentity.dialect?`：宿主下传的一格（既有调用方零改动）', () => {
  function fakeModel(text: string): Monaco.editor.ITextModel {
    return {
      getValue: () => text,
      getLineCount: () => text.split('\n').length,
      getLanguageId: () => 'kojo2',
      getVersionId: () => 1,
    } as unknown as Monaco.editor.ITextModel;
  }

  it('绑上了 ⇒ 请求身份带 dialect；没登记事实 / 没项目 ⇒ 键不出现（未绑定）', () => {
    installDialectFactsFor(factsOf({ erafl: adapter('erafl', '2.0.0') }));
    const bound = documentRequestFields(fakeModel('# 方言 erafl\n'), `${ROOT}/a.kojo`, {
      adapterId: 'erafl',
      rootDir: ROOT,
    } as unknown as GameProject);
    expect(bound.dialect).toEqual({ dialect: 'erafl', factsVersion: '2.0.0', carrier: null });

    const unbound = documentRequestFields(fakeModel('# 幕\n'), `${ROOT}/b.kojo`, null);
    expect('dialect' in unbound).toBe(false);
    expect(unbound.languageId).toBe('kojo2');
    expect(unbound.version).toBe(1);
  });

  it('覆盖随请求一起下传（身份与 project.adapterId 分叉时以覆盖为准）', () => {
    installDialectFactsFor(factsOf({ erafl: adapter('erafl'), eratw: adapter('eratw') }));
    setWorkspaceDialectOverride(ROOT, 'eratw');
    const fields = documentRequestFields(fakeModel('# 幕\n'), `${ROOT}/c.kojo`, {
      adapterId: 'erafl',
      rootDir: ROOT,
    } as unknown as GameProject);
    expect(fields.dialect?.dialect).toBe('eratw');
  });

  it('真实 eraFL 2.0 面经同一张登记簿绑上（版本取适配器自证，不是宿主另抄）', async () => {
    const { ERAFL_GAME_ADAPTER } = await import('@kojo/plugin-erafl-adapter');
    installDialectFactsFor((dialect) => (dialect === 'erafl' ? ERAFL_GAME_ADAPTER : null));
    const fields = documentRequestFields(fakeModel('# 方言 erafl\n'), `${ROOT}/d.kojo`, {
      adapterId: 'erafl',
      rootDir: ROOT,
    } as unknown as GameProject);
    expect(fields.dialect?.dialect).toBe('erafl');
    expect(fields.dialect?.factsVersion).toBe(ERAFL_GAME_ADAPTER.version);
  });
});

describe('方言诊断并进既有 2.0 诊断（同一轮 markers / 问题面板）', () => {
  const SEVERITY = {
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  } as unknown as Kojo2MarkerSeveritySource;

  function compiledResult(diagnostic: KojoDiagnostic): Kojo2DiagnosticsResult {
    return {
      filePath: `${ROOT}/a.kojo`,
      diagnostics: [diagnostic],
      markers: [
        {
          severity: 8,
          message: diagnostic.message,
          code: diagnostic.code,
          source: 'Kojo 2.0',
          startLineNumber: 2,
          startColumn: 1,
          endLineNumber: 2,
          endColumn: 2,
        },
      ],
      artifacts: null,
      error: null,
      errorCount: 1,
      warningCount: 0,
      ok: false,
    } as unknown as Kojo2DiagnosticsResult;
  }

  it('并集后 error / warning 计数与 markers 全部重算，产物原样保留', () => {
    const compileError: KojoDiagnostic = {
      code: 'core/decl/unknown',
      severity: 'error',
      message: '未知声明',
      span: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
    };
    const mismatch: KojoDiagnostic = {
      code: 'core/dialect/mismatch',
      severity: 'error',
      message: '方言冲突',
      span: null,
    };
    const merged = withDialectDiagnostics(compiledResult(compileError), [mismatch], SEVERITY, '# 幕\n> x\n');
    expect(merged.diagnostics.map((d) => d.code)).toEqual(['core/dialect/mismatch', 'core/decl/unknown']);
    expect(merged.errorCount).toBe(2);
    expect(merged.markers).toHaveLength(2);
    expect(merged.ok).toBe(false);
    expect(merged.artifacts).toBeNull();
  });

  it('没有方言诊断 ⇒ 原样返回（旧调用方逐字不变）', () => {
    const result = compiledResult({
      code: 'core/decl/unknown',
      severity: 'error',
      message: '未知声明',
      span: null,
    });
    expect(withDialectDiagnostics(result, [], SEVERITY, '')).toBe(result);
  });
});
