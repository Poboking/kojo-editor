// @vitest-environment happy-dom
/**
 * 语义诊断三条（unknown-symbol / type-mismatch / arg-count）的**一键修复链**（K2-SEMA-QUICKFIX
 * → B3j，2026-10-30）。
 *
 * 判据本体（触发条件 / 编辑集合 / 收口校验）已随 B3j 搬进 `@kojo/kojo-lang/code-actions`，
 * 闸在 `packages/kojo-lang/tests/code-actions.test.ts`；本文件只钉**宿主这一层**：
 *
 * 1. core 真编译出的 sema 诊断 → marker → 契约 `LineDecoration` → 插件供方 → Monaco 动作，
 *    码与行列一路不丢（宿主按它画关联高亮）；
 * 2. 每条语义动作的编辑逐字等于"声明行 / 调用行"的整行替换；
 * 3. v1 语言面零动作（适配腿只答 `kojo2`）；
 * 4. 落地仍走宿主那条带停点的 `applyTextEdits`（真 model + 假 editor 的调用序）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND, compileKojoSource } from '@kojo/kojo-core';
import type { EditorTextEdit } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import { provideCodeActions } from '@kojo/plugin-kojo-lang';
import { kojo2DiagnosticsToMarkers } from '../src/monaco/kojo2-diagnostics';
import {
  KOJO2_CODE_ACTION_COMMAND,
  installKojo2CodeActionProvider,
} from '../src/monaco/kojo2-code-actions';
import { applyTextEdits } from '../src/ui/editor-global-providers';

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

/* ============================== 假件 ============================== */

const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

interface Fake {
  readonly monaco: typeof Monaco;
  readonly provider: Monaco.languages.CodeActionProvider;
  readonly commands: Map<string, (accessor: unknown, ...args: unknown[]) => void>;
  readonly models: Map<string, Monaco.editor.ITextModel>;
}

function fakeMonaco(): Fake {
  const commands = new Map<string, (accessor: unknown, ...args: unknown[]) => void>();
  const models = new Map<string, Monaco.editor.ITextModel>();
  let provider: Monaco.languages.CodeActionProvider | null = null;
  const fake = {
    MarkerSeverity: MARKER_SEVERITY,
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        commands.set(id, handler);
        return { dispose: () => undefined };
      },
      getModel(uri: { toString(): string }) {
        return models.get(uri.toString()) ?? null;
      },
    },
    Uri: { parse: (text: string) => ({ toString: () => text, fsPath: text, path: text }) },
    languages: {
      registerCodeActionProvider(_selector: unknown, value: unknown) {
        provider = value as Monaco.languages.CodeActionProvider;
        return { dispose: () => undefined };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    get provider() {
      if (provider === null) throw new Error('桩：provider 还没注册');
      return provider;
    },
    commands,
    models,
  };
}

function uriOf(model: Monaco.editor.ITextModel): string {
  return (model as unknown as { uri: { toString(): string } }).uri.toString();
}

function fakeModel(text: string, languageId: string = KOJO2_LANGUAGE_ID): Monaco.editor.ITextModel {
  const uri = {
    toString: () => 'file:///D:/proj/chara/开场.kojo',
    fsPath: 'D:/proj/chara/开场.kojo',
    path: 'D:/proj/chara/开场.kojo',
  };
  return {
    getValue: () => text,
    getLanguageId: () => languageId,
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    getLineMaxColumn: (line: number) =>
      (text.split(/\r\n|\r|\n/)[line - 1] ?? '').length + 1,
    isDisposed: () => false,
    uri,
  } as unknown as Monaco.editor.ITextModel;
}

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
  else
    store.set(
      'kojo.ui.kojo2Cutover.plan.v1',
      JSON.stringify({ version: 2, stage: 'v1-only', overrides: {} }),
    );
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function install(
  fake: Fake,
  extra: {
    applyEdits?: (model: Monaco.editor.ITextModel, edits: readonly EditorTextEdit[]) => boolean;
  } = {},
): void {
  installKojo2CodeActionProvider(fake.monaco, {
    contributions: () => [
      { id: 'kojo2-codeActions', order: 10, provideActions: (file) => provideCodeActions(file) },
    ],
    applyEdits: extra.applyEdits ?? (() => false),
  });
}

function diagnosticsOf(source: string) {
  return compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
}

/** 一次 provider 请求：真编译诊断 → markers（宿主那条路的等价形状） */
function requestActions(
  fake: Fake,
  model: Monaco.editor.ITextModel,
  source: string,
  line: number,
): Monaco.languages.CodeAction[] {
  const markers = kojo2DiagnosticsToMarkers(fake.monaco, diagnosticsOf(source), source);
  fake.models.set(uriOf(model), model);
  const list = fake.provider.provideCodeActions!(
    model,
    new monaco.Range(line, 1, line, 1),
    { markers, triggerKind: 1 } as unknown as Monaco.languages.CodeActionContext,
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as unknown as Monaco.CancellationToken,
  ) as Monaco.languages.CodeActionList;
  return [...list.actions];
}

/* ============================== 用例 ============================== */

describe('①三条语义动作经槽上屏（码 / 行列 / 编辑逐字）', () => {
  it('unknown-symbol ⇒ 补 `# 设 临时 整数`（声明区整行插入）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    install(fake);
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const actions = requestActions(fake, fakeModel(source), source, 4);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('quickfix');
    expect(action.title).toContain('# 设 临时 整数');
    // 关联诊断仍带着 sema 码（宿主按它画关联高亮 / 排序）
    expect(action.diagnostics![0]!.code).toBe('core/expr/unknown-symbol');
    expect(action.command?.id).toBe(KOJO2_CODE_ACTION_COMMAND);
  });

  it('type-mismatch ⇒ 只换 `# 设` 的声明类型 token（声明行整行替换）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    install(fake);
    const source = '# 设 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n';
    const actions = requestActions(fake, fakeModel(source), source, 5);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain('把 `名` 的声明类型改成整数');
    expect(actions[0]!.diagnostics![0]!.code).toBe('core/expr/type-mismatch');
  });

  it('arg-count ⇒ 补占位实参（调用行整行替换）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    install(fake);
    const source = '@函 加(甲, 乙=2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加()\n';
    const actions = requestActions(fake, fakeModel(source), source, 6);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain('补 1 个必填实参');
    expect(actions[0]!.diagnostics![0]!.code).toBe('core/func/arg-count');
  });

  it('v1 语言面（`kojo`）零动作：适配腿只答 `kojo2`', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    install(fake);
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    expect(requestActions(fake, fakeModel(source, 'kojo'), source, 4)).toEqual([]);
  });
});

describe('②落地走同一条 `applyTextEdits`（前后各一颗停点）', () => {
  it('命令回调把同一批 EditorTextEdit 交给宿主的 applyEdits（未知符号那条）', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const applied: { readonly edits: readonly EditorTextEdit[] }[] = [];
    install(fake, {
      applyEdits: (_model, edits) => {
        applied.push({ edits });
        return true;
      },
    });
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const model = fakeModel(source);
    const actions = requestActions(fake, model, source, 4);
    const command = actions[0]!.command!;
    fake.commands.get(command.id)!(null, ...(command.arguments ?? []));
    expect(applied).toHaveLength(1);
    expect(applied[0]!.edits).toEqual([{ fromLine: 2, toLine: 2, newText: '# 设 临时 整数\n' }]);
  });

  it('真 model + 假 editor 转发桩：调用序 `停点 → executeEdits → 停点`，类型修复落到声明行', () => {
    const source = '# 设 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n';
    const model = monaco.editor.createModel(
      source,
      KOJO2_LANGUAGE_ID,
      monaco.Uri.parse('inmemory://kojo2-sema-quickfix/1'),
    );
    const calls: string[] = [];
    const editor = {
      getModel: () => model,
      executeEdits: (_source: string, operations: monaco.editor.IIdentifiedSingleEditOperation[]) => {
        calls.push('edit');
        return model.pushEditOperations(null, operations, () => null) !== null;
      },
      pushUndoStop: () => {
        calls.push('stop');
        model.pushStackElement();
      },
    } as unknown as Parameters<typeof applyTextEdits>[0];
    expect(applyTextEdits(editor, [{ fromLine: 1, toLine: 1, newText: '# 设 名 整数' }])).toBe(true);
    expect(calls).toEqual(['stop', 'edit', 'stop']);
    expect(model.getValue()).toContain('# 设 名 整数\n');
    model.dispose();
  });
});
