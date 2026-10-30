/**
 * `ui.editor.codeAction` 供方的闸（B3j，2026-10-30）。
 *
 * 这一层是"判据（包）↔ 宿主"之间的**形状搬运**，所以判据断在边上：
 * 1. **语言分派**：`.kojo` / `.kojo2` 作答，其余一律 `[]`（槽没有 `undefined` 这一态）；
 * 2. **三态退化**：位置未知 / 没有波浪线 / 没码的装饰 ⇒ 空数组（不猜）；
 * 3. **形状搬运**：`LineDecoration` → core 诊断（列夹取、`info` 归 error）→ 动作；
 *    动作的编辑逐字映到 `EditorTextEdit`（整行替换），类别 `indent → refactor` 其余 `quickfix`；
 * 4. **无副作用**：`run` 是空函数（有 `edits` 时宿主不调它，与另两枚既有供方同款）。
 *
 * 判据本体的触发条件 / 编辑内容 / 收口校验在包内（`packages/kojo-lang/tests/code-actions.test.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type { LineDecoration } from '@kojo/plugin-api';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import { coreDiagnosticsOf, provideCodeActions } from '../src/code-actions';

const NARRATION = '# 机 开场\n\n她点了点头。\n';

function diagnosticsOf(source: string): readonly KojoDiagnostic[] {
  return compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
}

/** 宿主那条路的等价形状：core 诊断 → 面上 marker → 契约 `LineDecoration`（列夹取后原样） */
function decorationsOf(source: string): LineDecoration[] {
  const lines = source.split(/\r\n|\r|\n/);
  return diagnosticsOf(source).map((diagnostic) => {
    const span = diagnostic.span!;
    const lineText = lines[span.start.line - 1] ?? '';
    const startColumn = Math.min(Math.max(1, span.start.column), lineText.length + 1);
    const endColumn = Math.min(Math.max(startColumn, span.end.column), lineText.length + 1);
    return {
      line: span.start.line,
      severity: diagnostic.severity,
      message: diagnostic.message,
      startColumn,
      endColumn,
      code: diagnostic.code,
    };
  });
}

function fileOf(source: string, over: Record<string, unknown> = {}) {
  return {
    path: 'D:/proj/chara/开场.kojo',
    text: source,
    project: null,
    line: 3,
    lineCount: source.split('\n').length,
    diagnostics: decorationsOf(source),
    ...over,
  };
}

describe('①语言分派：只有 2.0 文件作答', () => {
  it('`.kojo` / `.kojo2`（大小写不敏感）⇒ 产动作', () => {
    for (const path of ['D:/p/a.kojo', 'D:/p/a.KOJO', 'D:/p/a.kojo2', 'D:/p/a.KOJO2']) {
      const actions = provideCodeActions(fileOf(NARRATION, { path }));
      expect(actions, path).toHaveLength(1);
      expect(actions[0]!.title).toContain('补旁白锚点');
    }
  });

  it('其余路径（ERB / 封存 `.kojo1` / 无扩展名）⇒ `[]`（弃权）', () => {
    for (const path of ['D:/p/a.erb', 'D:/p/a.kojo1', 'D:/p/README', '']) {
      expect(provideCodeActions(fileOf(NARRATION, { path })), path).toEqual([]);
    }
  });
});

describe('②三态退化：位置未知 / 没有波浪线 / 没码', () => {
  it('位置未知（`line` 缺省）⇒ `[]`（不猜光标在哪）', () => {
    const file = fileOf(NARRATION);
    const { line: _line, ...rest } = file;
    expect(provideCodeActions(rest as typeof file)).toEqual([]);
  });

  it('这个区间没有波浪线（`diagnostics` 空 / 缺省）⇒ `[]`', () => {
    expect(provideCodeActions(fileOf(NARRATION, { diagnostics: [] }))).toEqual([]);
    const file = fileOf(NARRATION);
    const { diagnostics: _diagnostics, ...rest } = file;
    expect(provideCodeActions(rest as typeof file)).toEqual([]);
  });

  it('没码的装饰不收（判据没法认领"这是不是我认识的构造"）', () => {
    const decorations: LineDecoration[] = [
      { line: 3, severity: 'error', message: '无码', startColumn: 1, endColumn: 2 },
    ];
    expect(provideCodeActions(fileOf(NARRATION, { diagnostics: decorations }))).toEqual([]);
  });

  it('不在认领清单里的诊断码 ⇒ `[]`', () => {
    const decorations: LineDecoration[] = [
      {
        line: 3,
        severity: 'error',
        message: '桩',
        startColumn: 1,
        endColumn: 2,
        code: 'core/decl/missing-machine',
      },
    ];
    expect(provideCodeActions(fileOf(NARRATION, { diagnostics: decorations }))).toEqual([]);
  });

  it('光标行不沾波浪线 ⇒ `[]`（宿主没按行求交时也不误产）', () => {
    expect(provideCodeActions(fileOf(NARRATION, { line: 1 }))).toEqual([]);
  });
});

describe('③形状搬运：契约动作的每一格', () => {
  it('标题 / quickfix / 编辑（整行替换）/ 关联诊断 / 空 run', () => {
    const actions = provideCodeActions(fileOf(NARRATION));
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.title).toBe('补旁白锚点 `>`：> 她点了点头。');
    expect(action.kind).toBe('quickfix');
    expect(action.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '> 她点了点头。' }]);
    expect(action.diagnostics).toHaveLength(1);
    expect(action.diagnostics![0]).toEqual({
      line: 3,
      severity: 'error',
      message:
        '这行像旁白又像表达式：旁白写 `> …`，台词写 `角色：「…」`；原生 ERB 放进 `@原生`（§4.6 / §4.10）。',
      startColumn: 1,
      endColumn: 7,
      code: 'core/narrative/bare-narration',
    });
    expect(() => action.run({ project: null })).not.toThrow();
  });

  it('修缩进走 `refactor` 档（其余都是 `quickfix`）', () => {
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const actions = provideCodeActions(fileOf(source, { line: 4 }));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('refactor');
  });

  it('多段编辑逐段映射（`分支：` 提升声明 + 原处引用）', () => {
    const source =
      '# 机 开场\n# 视角 我\n\n> 前言\n\n分支：\n    [数值 < 100]\n        「早。」\n    [其他]\n        「嗨。」\n';
    const actions = provideCodeActions(fileOf(source, { line: 6 }));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toHaveLength(2);
    expect(actions[0]!.edits![0]!.fromLine).toBe(4);
    expect(actions[0]!.edits![1]!.newText).toBe('! 迁移池1');
  });

  it('`unknown-symbol`：列信息穿过契约后仍能定位名字（`textAtSpan` 需要单行 span）', () => {
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const actions = provideCodeActions(fileOf(source, { line: 4 }));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([
      { fromLine: 2, toLine: 2, newText: '# 设 临时 整数\n' },
    ]);
  });
});

describe('④LineDecoration → core 诊断的搬运（不改语义）', () => {
  it('列越界按行宽夹取；`info` 归 `error`；没码的丢掉', () => {
    const text = '甲乙\n丙';
    const diagnostics = coreDiagnosticsOf(
      [
        { line: 1, severity: 'info', message: 'a', startColumn: 99, endColumn: 120, code: 'x' },
        { line: 99, severity: 'warning', message: 'b', code: 'y' },
        { line: 1, severity: 'error', message: 'c' },
      ],
      text,
    );
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toEqual({
      code: 'x',
      severity: 'error',
      message: 'a',
      span: { start: { line: 1, column: 3 }, end: { line: 1, column: 3 } },
    });
    expect(diagnostics[1]).toEqual({
      code: 'y',
      severity: 'warning',
      message: 'b',
      span: { start: { line: 99, column: 1 }, end: { line: 99, column: 1 } },
    });
  });
});
