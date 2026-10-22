// @vitest-environment happy-dom
/**
 * K2-SEMA-QUICKFIX · 语义诊断的快速修复闸（batch-7；设计稿 §16.6 S5.2 / S5.4、§16.7 U6.4）。
 *
 * 覆盖七件事：
 * 1. `core/expr/unknown-symbol`：声明区补 `# 变量`（插入点：最后一条单行声明之后、
 *    首个正文块 / 块声明之前；含 `# 幕` / `# 视` / `# 常量` 混排与 `@织` 声明）；
 *    类型按赋值右侧字面量推断，推不出按整数并在标题写明；已声明 / 非单名目标不产；
 * 2. `core/expr/type-mismatch`：`# 变量` 声明 + 右侧整数字面量 ⇒ 只留"改成整数"
 *    （"改成字符串"那条 / 破坏初值的那条都被收口否决）；其它形状不产；
 * 3. `core/func/arg-count`：缺必填 ⇒ 补占位实参（`0` / `""`，按形参默认值类型唯一）；
 *    无默认值 / 混类型 / 多给 ⇒ 不产；
 * 4. 显式不产：`readonly-target` / `index-out-of-range` / `bad-index` 零动作且不在认领清单；
 * 5. **每条动作应用后** `parse` 零 error、目标码在全链编译里消失；
 * 6. 注册纪律：flag 关零注册、v1 语言面零动作、动作带 `command` 而非 `edit`、
 *    落地走宿主注入的 `applyEdits`；
 * 7. 停点复用：真 model + 假 editor，调用序 `pushUndoStop → executeEdits → pushUndoStop`。
 *
 * 诊断一律来自 core 真编译（`compileKojoSource`，sema 已接进主链），不在测试里手写"假波浪线"；
 * 只有"已声明名字"那条用**手工诊断**构造（真编译不会对已声明名字报 unknown-symbol）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../src/monaco/entry';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
  parseSource,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import type { EditorTextEdit } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-constants';
import { kojo2DiagnosticsToMarkers } from '../src/monaco/kojo2-diagnostics';
import {
  KOJO2_CODE_ACTION_CODES,
  KOJO2_CODE_ACTION_COMMAND,
  KOJO2_CODE_ACTION_KIND_LABELS,
  installKojo2CodeActionProvider,
  kojo2CodeActionFacts,
  kojo2CodeActionKindOf,
  kojo2DiagnosticsFromMarkers,
  kojo2EditedSource,
  kojo2EditorEditsOf,
  type Kojo2CodeActionFact,
  type Kojo2CodeActionRange,
  type Kojo2CodeActionVerifier,
} from '../src/monaco/kojo2-code-actions';
import { applyTextEdits } from '../src/ui/editor-global-providers';

const UNKNOWN = 'core/expr/unknown-symbol';
const TYPE_MISMATCH = 'core/expr/type-mismatch';
const ARG_COUNT = 'core/func/arg-count';
const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

/* ============================== 夹具小工具 ============================== */

function diagnosticsOf(source: string): readonly KojoDiagnostic[] {
  return compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
}

function rangeOf(from: number, to: number): Kojo2CodeActionRange {
  return { startLine: from, startColumn: 1, endLine: to, endColumn: 1 };
}

/** 按诊断码取第一处诊断作为请求区间（真实 `Ctrl+.` 落在波浪线上） */
function factsForCode(
  source: string,
  code: string,
  extra: { readonly verifier?: Kojo2CodeActionVerifier } = {},
): readonly Kojo2CodeActionFact[] {
  const diagnostics = diagnosticsOf(source);
  const target = diagnostics.find((diagnostic) => diagnostic.code === code);
  if (target === undefined || target.span === null) {
    throw new Error(`夹具里没有 ${code}：实际 = ${JSON.stringify(diagnostics.map((d) => d.code))}`);
  }
  return kojo2CodeActionFacts({
    source,
    diagnostics,
    range: rangeOf(target.span.start.line, target.span.end.line),
    ...extra,
  });
}

function parseErrors(source: string): readonly KojoDiagnostic[] {
  return parseSource(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/** 应用一条动作：parse 零 error + 全链编译里目标码消失（"真的修好了"的机器判据） */
function expectCleanApply(fact: Kojo2CodeActionFact, source: string): string {
  const after = kojo2EditedSource(source, fact.edits);
  expect(parseErrors(after), `应用后仍有解析错误：${JSON.stringify(after)}`).toEqual([]);
  expect(
    diagnosticsOf(after).filter((diagnostic) => diagnostic.code === fact.code),
    `应用后目标码没有消失：${JSON.stringify(after)}`,
  ).toEqual([]);
  return after;
}

/* ============================== 1. unknown-symbol ============================== */

describe('①unknown-symbol：声明区补 `# 变量`', () => {
  const SOURCE = '# 机 开场\n\n@算\n    临时 = 1\n';

  it('整数字面量右侧 ⇒ 声明 `整数`，插在 `# 机` 之后的声明区，应用后 parse 零 error 且码消失', () => {
    const facts = factsForCode(SOURCE, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(KOJO2_CODE_ACTION_KIND_LABELS[fact.kind]).toBe('补全');
    expect(fact.code).toBe(UNKNOWN);
    expect(fact.edits).toHaveLength(1);
    expect(fact.edit.range).toEqual({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 });
    expect(fact.edit.newText).toBe('# 变量 临时 整数\n');
    expect(fact.title).toContain('# 变量 临时 整数');
    expect(expectCleanApply(fact, SOURCE)).toBe(
      '# 机 开场\n# 变量 临时 整数\n\n@算\n    临时 = 1\n',
    );
  });

  it('字符串字面量右侧 ⇒ 声明 `字符串`（不把已知类型硬写成整数）', () => {
    const source = '# 机 开场\n\n@算\n    名字 = "甲"\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 变量 名字 字符串\n');
    expectCleanApply(facts[0]!, source);
  });

  it('类型不可知（右侧不是字面量）⇒ 默认整数，标题写明"按整数声明，请按需改类型"', () => {
    const source = '# 机 开场\n\n@算\n    临时 = 数量\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 变量 临时 整数\n');
    expect(facts[0]!.title).toContain('按整数声明，请按需改类型');
    expectCleanApply(facts[0]!, source);
  });

  it('`# 幕` / `# 视` / `# 常量` 混排 ⇒ 插到最后一条单行声明之后、`# 幕`（正文块）之前', () => {
    const source =
      '# 机 开场\n# 视 我\n# 常量 甲 整数 = 1\n# 幕 一\n\n@算\n    临时 = 1\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edit.range).toEqual({ startLine: 4, startColumn: 1, endLine: 4, endColumn: 6 });
    expect(fact.edit.newText).toBe('# 变量 临时 整数\n\n# 幕 一');
    const after = expectCleanApply(fact, source);
    expect(after).toContain('# 常量 甲 整数 = 1\n# 变量 临时 整数\n\n# 幕 一\n');
    expect(after.indexOf('# 变量 临时 整数')).toBeLessThan(after.indexOf('# 幕 一'));
  });

  it('`@织` 块声明在声明区之后 ⇒ 插在 `@织` 之前并保留块声明前的空行', () => {
    const source = '# 机 开场\n# 视 我\n\n@织 收场\n    @算\n        临时 = 1\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.edit.range).toEqual({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 });
    expect(fact.edit.newText).toBe('# 变量 临时 整数\n');
    const after = expectCleanApply(fact, source);
    expect(after).toContain('# 视 我\n# 变量 临时 整数\n\n@织 收场\n');
  });

  it('同一名字已在文件里声明 ⇒ 不产（改名 / 拼写机器不猜）', () => {
    const source = '# 变量 临时 整数\n# 机 开场\n\n@算\n    临时 = 1\n';
    const diagnostics: KojoDiagnostic[] = [
      {
        code: UNKNOWN,
        severity: 'error',
        message: '桩：已声明却仍报 unknown（手工构造）',
        span: { start: { line: 5, column: 5 }, end: { line: 5, column: 7 } },
      },
    ];
    expect(
      kojo2CodeActionFacts({ source, diagnostics, range: rangeOf(5, 5) }),
    ).toEqual([]);
  });

  it('目标不是单个名字（`{角色}的<属性>`）⇒ 不产（补 `# 变量` 修不了）', () => {
    const source = '# 机 开场\n\n@算\n    {我}的幻想 = 1\n';
    expect(factsForCode(source, UNKNOWN)).toEqual([]);
  });

  it('目标不是单个名字（未声明数组的 `名[下标]`）⇒ 不产', () => {
    const source = '# 机 开场\n\n@算\n    队伍[0] = 1\n';
    expect(factsForCode(source, UNKNOWN)).toEqual([]);
  });

  it('同一条诊断传两遍 ⇒ 只出一条动作', () => {
    const diagnostics = diagnosticsOf(SOURCE);
    const facts = kojo2CodeActionFacts({
      source: SOURCE,
      diagnostics: [diagnostics[0]!, diagnostics[0]!],
      range: rangeOf(4, 4),
    });
    expect(facts).toHaveLength(1);
  });

  it('假 compile 改后仍报目标码 ⇒ 否决（不产）', () => {
    const verifier: Kojo2CodeActionVerifier = {
      parse: () => [],
      compile: () => [
        {
          code: UNKNOWN,
          severity: 'error',
          message: '桩：补了声明还是未知',
          span: { start: { line: 1, column: 1 }, end: { line: 20, column: 1 } },
        },
      ],
    };
    expect(factsForCode(SOURCE, UNKNOWN, { verifier })).toEqual([]);
  });
});

/* ============================== 2. type-mismatch ============================== */

describe('②type-mismatch：`# 变量` 声明类型二选一', () => {
  it('字符串声明 + 整数字面量右侧 ⇒ 只留"改成整数"，应用后码消失', () => {
    const source = '# 变量 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('fix');
    expect(KOJO2_CODE_ACTION_KIND_LABELS.fix).toBe('修复');
    expect(fact.title).toContain('把 `名` 的声明类型改成整数');
    expect(fact.edit.newText).toBe('# 变量 名 整数');
    expect(expectCleanApply(fact, source)).toBe(
      '# 变量 名 整数\n# 机 开场\n\n@算\n    名 = 1\n',
    );
  });

  it('声明行尾还有存储期 ⇒ 只换类型 token，尾部原样保留', () => {
    const source = '# 变量 名 字符串 场景\n# 机 开场\n\n@算\n    名 = 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 变量 名 整数 场景');
    expectCleanApply(facts[0]!, source);
  });

  it('增量运算 `+=` 打在字符串变量上 + 整数字面量 ⇒ 同样把声明改成整数', () => {
    const source = '# 变量 数 字符串\n# 机 开场\n\n@算\n    数 += 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('# 变量 数 整数');
    expectCleanApply(facts[0]!, source);
  });

  it('改类型会破坏声明初值（`= "甲"`）⇒ 两条候选都被收口否决，零动作', () => {
    const source = '# 变量 名 字符串 = "甲"\n# 机 开场\n\n@算\n    名 = 1\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('右侧不是整数字面量（字符串字面量）⇒ 按任务口径不产', () => {
    const source = '# 变量 数 整数\n# 机 开场\n\n@算\n    数 = "甲"\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('右侧不是字面量（变量）⇒ 不产', () => {
    const source = '# 变量 数 整数\n# 变量 名 字符串\n# 机 开场\n\n@算\n    名 = 数\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('改类型会把另一处旧赋值写成新的同类错误（`名 = "x"`）⇒ 计数闸否决，零动作', () => {
    const source = '# 变量 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n    名 = "甲"\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });

  it('诊断落在函数实参上（不是 `# 变量` 赋值左侧）⇒ 不产', () => {
    const source = '@函 称呼(名字 = "甲")\n    @返 名字\n\n# 机 开场\n\n! 称呼(1)\n';
    expect(factsForCode(source, TYPE_MISMATCH)).toEqual([]);
  });
});

/* ============================== 3. arg-count ============================== */

describe('③arg-count：缺必填补占位实参', () => {
  const INT_DEFAULT = '@函 加(甲, 乙=2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加()\n';

  it('缺 1 个必填 + 形参默认值全是整数 ⇒ 补 `0`，应用后码消失', () => {
    const facts = factsForCode(INT_DEFAULT, ARG_COUNT);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.kind).toBe('complete');
    expect(fact.title).toContain('补 1 个必填实参');
    expect(fact.edit.newText).toBe('! 加(0)');
    expect(expectCleanApply(fact, INT_DEFAULT)).toContain('\n! 加(0)\n');
  });

  it('形参默认值全是字符串 ⇒ 占位 `""`', () => {
    const source = '@函 问候(称呼, 尾巴 = "。")\n    @返 称呼\n\n# 机 开场\n\n! 问候()\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 问候("")');
    expectCleanApply(facts[0]!, source);
  });

  it('缺多个必填（中间/尾部有默认值）⇒ 按缺口个数补多个占位', () => {
    const source = '@函 混(甲 = 1, 丙)\n    @返 丙\n\n# 机 开场\n\n! 混()\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 混(0, 0)');
    expectCleanApply(facts[0]!, source);
  });

  it('调用没写括号 ⇒ 补成 `! 名(占位)`（仍是整行替换）', () => {
    const source = '@函 加(甲, 乙 = 2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加\n';
    const facts = factsForCode(source, ARG_COUNT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.edit.newText).toBe('! 加(0)');
    expectCleanApply(facts[0]!, source);
  });

  it('形参没有任何默认值 ⇒ 类型无法判定，不产', () => {
    const source = '@函 两(甲, 乙)\n    @返 甲\n\n# 机 开场\n\n! 两()\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });

  it('形参默认值类型混杂（整数 + 字符串）⇒ 无法判定，不产', () => {
    const source = '@函 混(甲 = 1, 乙 = "x", 丙)\n    @返 丙\n\n# 机 开场\n\n! 混()\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });

  it('实参多给 ⇒ 不产（删参危险）', () => {
    const source = '@函 加(甲, 乙 = 2)\n    @返 甲 + 乙\n\n# 机 开场\n\n! 加(1, 2, 3)\n';
    expect(factsForCode(source, ARG_COUNT)).toEqual([]);
  });
});

/* ============================== 4. 显式不产 ============================== */

describe('④显式不产：readonly-target / index-out-of-range / bad-index', () => {
  it('`readonly-target` 零动作且不在认领清单（需要作者决策）', () => {
    const source = '# 机 开场\n\n@算\n    外部上限 = 1\n';
    expect(factsForCode(source, 'core/expr/readonly-target')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/readonly-target')).toBe(false);
  });

  it('`index-out-of-range` 零动作且不在认领清单（可能想改下标本身）', () => {
    const source = '# 变量 队列 整数[3]\n# 机 开场\n\n@算\n    队列[5] = 1\n';
    expect(factsForCode(source, 'core/expr/index-out-of-range')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/index-out-of-range')).toBe(false);
  });

  it('`bad-index` 零动作且不在认领清单（可能想改下标 / 补数组声明）', () => {
    const source = '# 变量 数 整数\n# 机 开场\n\n@算\n    数[0] = 1\n';
    expect(factsForCode(source, 'core/expr/bad-index')).toEqual([]);
    expect(KOJO2_CODE_ACTION_CODES.has('core/expr/bad-index')).toBe(false);
  });

  it('三条可产的语义码都在认领清单里', () => {
    for (const code of [UNKNOWN, TYPE_MISMATCH, ARG_COUNT]) {
      expect(KOJO2_CODE_ACTION_CODES.has(code), code).toBe(true);
    }
  });
});

/* ============================== 5. 假 Monaco：注册纪律 ============================== */

const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly providers: { readonly selector: unknown; readonly provider: Monaco.languages.CodeActionProvider }[];
  readonly commands: Map<string, (accessor: unknown, ...args: unknown[]) => void>;
  readonly disposed: string[];
  readonly models: Map<string, Monaco.editor.ITextModel>;
  registerModel(model: Monaco.editor.ITextModel): void;
  runCommand(id: string, ...args: unknown[]): void;
}

function fakeMonaco(): FakeMonaco {
  const providers: FakeMonaco['providers'] = [];
  const commands = new Map<string, (accessor: unknown, ...args: unknown[]) => void>();
  const disposed: string[] = [];
  const models = new Map<string, Monaco.editor.ITextModel>();
  const fake = {
    MarkerSeverity: MARKER_SEVERITY,
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        commands.set(id, handler);
        return { dispose: () => disposed.push('command') };
      },
      getModel(uri: { toString(): string }) {
        return models.get(uri.toString()) ?? null;
      },
    },
    Uri: { parse: (text: string) => ({ toString: () => text, fsPath: text, path: text }) },
    languages: {
      registerCodeActionProvider(selector: unknown, provider: unknown) {
        providers.push({
          selector,
          provider: provider as Monaco.languages.CodeActionProvider,
        });
        return { dispose: () => disposed.push('provider') };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    providers,
    commands,
    disposed,
    models,
    registerModel(model) {
      models.set(uriOf(model), model);
    },
    runCommand(id, ...args) {
      const handler = commands.get(id);
      if (handler === undefined) throw new Error(`桩：没有命令 ${id}`);
      handler(null, ...args);
    },
  };
}

function uriOf(model: Monaco.editor.ITextModel): string {
  return (model as unknown as { uri: { toString(): string } }).uri.toString();
}

function fakeModel(
  text: string,
  languageId: string = KOJO2_LANGUAGE_ID,
): Monaco.editor.ITextModel {
  const uri = {
    toString: () => 'file:///D:/proj/chara/开场.kojo2',
    fsPath: 'D:/proj/chara/开场.kojo2',
  };
  return {
    getValue: () => text,
    getLanguageId: () => languageId,
    isDisposed: () => false,
    uri,
  } as unknown as Monaco.editor.ITextModel;
}

function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set(KOJO2_KEY, 'on');
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

function requestActions(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  source: string,
  range: Kojo2CodeActionRange,
): Monaco.languages.CodeAction[] {
  const diagnostics = diagnosticsOf(source);
  const markers = kojo2DiagnosticsToMarkers(fake.monaco, diagnostics, source);
  fake.registerModel(model);
  const list = fake.providers[0]!.provider.provideCodeActions!(
    model,
    new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn),
    { markers, triggerKind: 1 } as unknown as Monaco.languages.CodeActionContext,
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as unknown as Monaco.CancellationToken,
  ) as Monaco.languages.CodeActionList;
  return [...list.actions];
}

describe('⑤注册纪律：flag 关零注册 / v1 零动作 / command 而非 edit', () => {
  it('flag 关 ⇒ 注册函数一次都没被调用（零注册），句柄可重复 dispose', () => {
    stubFlag(false);
    const fake = fakeMonaco();
    const handle = installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    expect(fake.providers).toHaveLength(0);
    expect(fake.commands.size).toBe(0);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
    expect(fake.disposed).toEqual([]);
  });

  it('v1 语言面（`.kojo`）零动作：provider 只答 `kojo2`', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    installKojo2CodeActionProvider(fake.monaco, { applyEdits: () => false });
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const model = fakeModel(source, 'kojo');
    expect(requestActions(fake, model, source, rangeOf(4, 4))).toEqual([]);
  });

  it('动作带 `command`（不是 `edit`）；命令回调把同一批 EditorTextEdit 交给宿主的 applyEdits', () => {
    stubFlag(true);
    const fake = fakeMonaco();
    const applied: (readonly EditorTextEdit[])[] = [];
    installKojo2CodeActionProvider(fake.monaco, {
      applyEdits: (_model, edits) => {
        applied.push(edits);
        return true;
      },
    });
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const actions = requestActions(fake, fakeModel(source), source, rangeOf(4, 4));
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('quickfix');
    expect(action.edit).toBeUndefined();
    expect(action.command?.id).toBe(KOJO2_CODE_ACTION_COMMAND);
    expect(action.diagnostics?.map((marker) => marker.code)).toEqual([UNKNOWN]);
    fake.runCommand(action.command!.id, action.command!.arguments![0]);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual([{ fromLine: 2, toLine: 2, newText: '# 变量 临时 整数\n' }]);
  });

  it('marker 往返仍保留 sema 码与 span（宿主按它画关联高亮）', () => {
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const markers = kojo2DiagnosticsToMarkers(fakeMonaco().monaco, diagnosticsOf(source), source);
    const back = kojo2DiagnosticsFromMarkers(fakeMonaco().monaco, markers);
    expect(back).toHaveLength(1);
    expect(back[0]!.code).toBe(UNKNOWN);
    expect(back[0]!.span?.start.line).toBe(4);
  });
});

/* ============================== 6. 停点复用（undo 纪律） ============================== */

describe('⑥落地走同一条 `applyTextEdits`（前后各一颗停点）', () => {
  it('真 model + 假 editor 转发桩：调用序 `停点 → executeEdits → 停点`，文本落到真 model', () => {
    const source = '# 机 开场\n\n@算\n    临时 = 1\n';
    const facts = factsForCode(source, UNKNOWN);
    expect(facts).toHaveLength(1);
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
    expect(applyTextEdits(editor, kojo2EditorEditsOf(facts[0]!))).toBe(true);
    expect(calls).toEqual(['stop', 'edit', 'stop']);
    expect(model.getValue()).toBe('# 机 开场\n# 变量 临时 整数\n\n@算\n    临时 = 1\n');
    model.dispose();
  });

  it('类型修复也走同一条整行编辑（声明行），edits 逐字可映射到 EditorTextEdit', () => {
    const source = '# 变量 名 字符串\n# 机 开场\n\n@算\n    名 = 1\n';
    const facts = factsForCode(source, TYPE_MISMATCH);
    expect(kojo2EditorEditsOf(facts[0]!)).toEqual([
      { fromLine: 1, toLine: 1, newText: '# 变量 名 整数' },
    ]);
    expect(kojo2CodeActionKindOf('fix')).toBe('quickfix');
  });
});
