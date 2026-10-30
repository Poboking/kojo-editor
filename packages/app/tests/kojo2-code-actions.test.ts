// @vitest-environment happy-dom
/**
 * Kojo 2.0 一键迁移 code action 的**宿主适配腿**闸（K2 batch-5 → B3j，2026-10-30）。
 *
 * **SDK-B5b 车 5（2026-10-31）**起这枚 provider 住通用槽腿工厂
 * （`monaco/slot-service-providers.ts` 的 `legOf('codeAction', …)`，旧安装器
 * `monaco/kojo2-code-actions.ts` 随批删除）；本文件改经
 * `installSlotServiceLegs(monaco, ['codeAction'], host)` 装配——与生产装配点同一条壳。
 * 它只做四件事：**定位**（model / 光标 / marker）、**问槽**
 * （`ui.editor.codeAction`）、**翻译**（契约动作 → Monaco `CodeAction`）、**落地**
 * （宿主注入的 `applyCodeActionEdits` → `applyTextEdits`）。切流门控**不在这层**（宿主策略，
 * 由 `kojo2-structure-gate.test.ts` ③ 行为取证），本层与"写面腿数据"两格见 ①。判据在
 * `@kojo/kojo-lang/code-actions`，供方是插件——所以本文件**用真插件贡献**跑通整条链，
 * 同时钉住"宿主侧零迁移规则"（源码针）。
 *
 * 覆盖：
 * 1. 注册纪律：flag 关零注册 / flag 开恰好一枚 provider + 一条命令 / 半途回滚 / 幂等 dispose；
 * 2. 取数面：v1 语言零动作、零波浪线不问槽、取文抛错静默、一家贡献抛错不带走另一家；
 * 3. 翻译面：`command` 而非 `edit`、关联诊断 marker、唯一解 preferred、修缩进 `refactor`；
 * 4. 落地面：命令回调把**同一批** `EditorTextEdit` 交给 `applyEdits`；无 `edits` 的动作退回 `run`；
 *    真 model + 假 editor 的调用序 `停点 → executeEdits → 停点`；
 * 5. 分层针：本层不出现 `executeEdits` / `pushUndoStop`，也不 import 包里的判据。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
} from '@kojo/kojo-core';
import type { EditorCodeAction, EditorCodeActionContribution, EditorTextEdit } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import { provideCodeActions } from '@kojo/plugin-kojo-lang';
import { kojo2DiagnosticsToMarkers } from '../src/ui/kojo2-problem-wiring';
import {
  SLOT_CODE_ACTION_COMMAND,
  SLOT_CODE_ACTION_KINDS,
  SLOT_SERVICE_LEGS,
  SLOT_SERVICE_WRITE_LEGS,
  installSlotServiceLegs,
  type SlotServiceHost,
} from '../src/monaco/slot-service-providers';
import { applyTextEdits } from '../src/ui/editor-global-providers';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 行分隔（与 Monaco 同口径；夹具里统一用这一枚，免得把转义写散） */
const LINE_BREAK = /\r\n|\r|\n/;

/* ============================== 夹具 ============================== */

const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly providers: {
    readonly selector: unknown;
    readonly provider: Monaco.languages.CodeActionProvider;
    readonly metadata: unknown;
  }[];
  readonly commands: Map<string, (accessor: unknown, ...args: unknown[]) => void>;
  readonly disposed: string[];
  readonly models: Map<string, Monaco.editor.ITextModel>;
  registerModel(model: Monaco.editor.ITextModel): void;
  runCommand(id: string, ...args: unknown[]): void;
}

function fakeMonaco(
  options: { failOn?: 'command' | 'provider'; failDisposeOn?: 'command' | 'provider' } = {},
): FakeMonaco {
  const providers: FakeMonaco['providers'] = [];
  const commands = new Map<string, (accessor: unknown, ...args: unknown[]) => void>();
  const disposed: string[] = [];
  const models = new Map<string, Monaco.editor.ITextModel>();
  const fake = {
    MarkerSeverity: MARKER_SEVERITY,
    editor: {
      registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void) {
        if (options.failOn === 'command') throw new Error('桩：注册命令抛错');
        commands.set(id, handler);
        return {
          dispose: () => {
            if (options.failDisposeOn === 'command') throw new Error('桩：撤命令抛错');
            disposed.push('command');
          },
        };
      },
      getModel(uri: { toString(): string }) {
        return models.get(uri.toString()) ?? null;
      },
    },
    Uri: {
      parse: (text: string) => ({ toString: () => text, fsPath: text, path: text }),
    },
    languages: {
      registerCodeActionProvider(selector: unknown, provider: unknown, metadata: unknown) {
        if (options.failOn === 'provider') throw new Error('桩：注册 provider 抛错');
        providers.push({
          selector,
          provider: provider as Monaco.languages.CodeActionProvider,
          metadata,
        });
        return {
          dispose: () => {
            if (options.failDisposeOn === 'provider') throw new Error('桩：撤 provider 抛错');
            disposed.push('provider');
          },
        };
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
  options: { languageId?: string; failGetValue?: boolean; uriPath?: string } = {},
): Monaco.editor.ITextModel {
  const languageId = options.languageId ?? KOJO2_LANGUAGE_ID;
  const uriPath = options.uriPath ?? 'D:/proj/chara/开场.kojo';
  const uri = { toString: () => `file:///${uriPath}`, fsPath: uriPath, path: uriPath };
  return {
    getValue: () => {
      if (options.failGetValue === true) throw new Error('桩：模型已释放');
      return text;
    },
    getLanguageId: () => languageId,
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    // `actionDiagnostics` → `decorationsToMarkers` 用这两格夹取行列（与真 model 同口径）
    getLineMaxColumn: (line: number) => (text.split(/\r\n|\r|\n/)[line - 1] ?? '').length + 1,
    isDisposed: () => false,
    uri,
  } as unknown as Monaco.editor.ITextModel;
}

/**
 * 本层不再读切流开关（车 5：门控是**宿主策略**，装配点在 `if (isKojo2CutoverEnabled())` 块里
 * 用 `SLOT_SERVICE_WRITE_LEGS` 把这腿装回来）⇒ 夹具里没有 localStorage、也不需要 `afterEach`
 * 清全局。门控行为由 `kojo2-structure-gate.test.ts` ③ 逐枚量注册次数。
 */

/** 真插件贡献（与装配时 `plugin.ts` 注册的是同一个函数） */
function kojo2Contribution(): EditorCodeActionContribution {
  return {
    id: 'kojo2-codeActions',
    order: 10,
    provideActions: (file) => provideCodeActions(file),
  };
}

function install(
  fake: FakeMonaco,
  over: Partial<SlotServiceHost> = {},
): Monaco.IDisposable {
  return installSlotServiceLegs(fake.monaco, ['codeAction'], {
    codeActionSlot: () => [kojo2Contribution()],
    applyCodeActionEdits: () => false,
    ...over,
  });
}

/** 一次 provider 请求：源码 → core 诊断 → markers（与宿主那条路同源） */
function requestActions(
  fake: FakeMonaco,
  model: Monaco.editor.ITextModel,
  source: string,
  line: number,
): Monaco.languages.CodeAction[] {
  const diagnostics = compileKojoSource({
    source,
    filePath: 'x.kojo2',
    adapter: FIXTURE_ADAPTER,
    backend: FIXTURE_BACKEND,
  }).diagnostics;
  const markers = kojo2DiagnosticsToMarkers(fake.monaco, diagnostics, source);
  fake.registerModel(model);
  const list = fake.providers[0]!.provider.provideCodeActions!(
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

const NARRATION = '# 机 开场\n\n她点了点头。\n';

/* ============================== 1. 注册纪律 ============================== */

describe('①注册纪律：写面腿数据（门控在宿主）/ 只挂点名它的语言 / 回滚与幂等', () => {
  it('写面腿数据：`codeAction` 在 `SLOT_SERVICE_WRITE_LEGS` 里，表里确有这一腿（无条件装配不含它）', () => {
    // 门控**不在这层**（宿主策略）：这里只钉"工厂据哪份名单把写面腿排除在无条件装配之外"。
    // 行为取证由 `kojo2-structure-gate.test.ts` ③ 按注册次数逐枚量（flag 关 ⇒ 零注册）。
    expect(SLOT_SERVICE_WRITE_LEGS).toEqual(['codeAction']);
    expect(SLOT_SERVICE_LEGS.map((leg) => leg.kind)).toContain('codeAction');
  });

  it('装配 ⇒ 恰好一枚 provider + 一条命令，selector 只有 `kojo2`（写面腿只挂点名它的语言），类别声明齐两档', () => {
    const fake = fakeMonaco();
    const handle = install(fake);
    expect(fake.providers).toHaveLength(1);
    expect(fake.providers[0]!.selector).toBe(KOJO2_LANGUAGE_ID);
    expect(fake.commands.has(SLOT_CODE_ACTION_COMMAND)).toBe(true);
    expect(fake.providers[0]!.metadata).toEqual({
      providedCodeActionKinds: SLOT_CODE_ACTION_KINDS,
    });
    expect(SLOT_CODE_ACTION_KINDS).toEqual(['quickfix', 'refactor']);
    handle.dispose();
    expect(fake.disposed).toEqual(['command', 'provider']);
  });

  it('provider 注册抛错 ⇒ 已挂上的命令撤回 + 错误外抛（全有或全无）', () => {
    const fake = fakeMonaco({ failOn: 'provider' });
    expect(() => install(fake)).toThrow('桩：注册 provider 抛错');
    expect(fake.disposed).toEqual(['command']);
    expect(fake.providers).toHaveLength(0);
  });

  it('撤一枚抛错不许带走其余（dispose 逐枚隔离）', () => {
    const fake = fakeMonaco({ failDisposeOn: 'command' });
    const handle = install(fake);
    expect(() => handle.dispose()).not.toThrow();
    expect(fake.disposed).toEqual(['provider']);
  });
});

/* ============================== 2. 取数面 ============================== */

describe('②取数面：语言门 / 零波浪线 / 抛错隔离', () => {
  it('v1 语言面（`kojo`）零动作：provider 只答 `kojo2`', () => {
    const fake = fakeMonaco();
    install(fake);
    const model = fakeModel(NARRATION, { languageId: 'kojo' });
    expect(requestActions(fake, model, NARRATION, 3)).toEqual([]);
  });

  it('零波浪线 ⇒ 一次都不问槽（判据之前那次整篇 parse 不白付）', () => {
    const fake = fakeMonaco();
    let asked = 0;
    install(fake, {
      codeActionSlot: () => [
        {
          id: 'probe',
          provideActions: () => {
            asked += 1;
            return [];
          },
        },
      ],
    });
    const model = fakeModel(NARRATION);
    fake.registerModel(model);
    const list = fake.providers[0]!.provider.provideCodeActions!(
      model,
      new monaco.Range(3, 1, 3, 1),
      { markers: [], triggerKind: 1 } as unknown as Monaco.languages.CodeActionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as Monaco.CancellationToken,
    ) as Monaco.languages.CodeActionList;
    expect(list.actions).toEqual([]);
    expect(asked).toBe(0);
  });

  it('取文抛错 / provider 体内抛错 ⇒ 空动作、不外抛', () => {
    const fake = fakeMonaco();
    install(fake);
    const model = fakeModel(NARRATION, { failGetValue: true });
    expect(requestActions(fake, model, NARRATION, 3)).toEqual([]);
  });

  it('一家贡献抛错不带走另一家（逐家隔离）', () => {
    const fake = fakeMonaco();
    const throwing: EditorCodeActionContribution = {
      id: 'boom',
      provideActions: () => {
        throw new Error('桩：贡献方炸了');
      },
    };
    install(fake, { codeActionSlot: () => [throwing, kojo2Contribution()] });
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain('补旁白锚点');
  });

  it('路径取不到（无归属实例且 uri 无路径）⇒ 不问槽、空动作', () => {
    const fake = fakeMonaco();
    let asked = 0;
    install(fake, {
      codeActionSlot: () => [
        {
          id: 'probe',
          provideActions: () => {
            asked += 1;
            return [];
          },
        },
      ],
      filePathOf: () => null,
    });
    const model = fakeModel(NARRATION, { uriPath: '' });
    expect(requestActions(fake, model, NARRATION, 3)).toEqual([]);
    expect(asked).toBe(0);
  });
});

/* ============================== 3. 翻译面 ============================== */

describe('③翻译面：command 而非 edit、关联诊断、唯一解 preferred', () => {
  it('真插件供方 → 一条动作：标题 / quickfix / command / 关联诊断 / isPreferred', () => {
    const fake = fakeMonaco();
    install(fake);
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.title).toBe('补旁白锚点 `>`：> 她点了点头。');
    expect(action.kind).toBe('quickfix');
    expect(action.command?.id).toBe(SLOT_CODE_ACTION_COMMAND);
    expect(action.edit).toBeUndefined(); // 落地必须走宿主那条带停点的通道
    expect(action.isPreferred).toBe(true);
    expect(action.diagnostics).toHaveLength(1);
    expect(action.diagnostics![0]!.code).toBe('core/narrative/bare-narration');
    expect(action.diagnostics![0]!.startLineNumber).toBe(3);
  });

  it('多解不置 preferred；改缩进走 refactor 档', () => {
    const fake = fakeMonaco();
    install(fake);
    const source = '# 机 开场\n\n? 数值 == 1\n      > a\n? 否\n    > b\n';
    const actions = requestActions(fake, fakeModel(source), source, 4);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('refactor');
    expect(actions[0]!.isPreferred).toBeUndefined();
  });

  it('两条 quickfix 同时出现 ⇒ 都不置 preferred（多解不替作者选）', () => {
    const fake = fakeMonaco();
    const first: EditorCodeAction = {
      title: '甲',
      kind: 'quickfix',
      edits: [{ fromLine: 3, toLine: 3, newText: '> a' }],
      run: () => undefined,
    };
    const second: EditorCodeAction = {
      title: '乙',
      kind: 'quickfix',
      edits: [{ fromLine: 3, toLine: 3, newText: '> b' }],
      run: () => undefined,
    };
    install(fake, {
      codeActionSlot: () => [
        { id: 'two', provideActions: () => [first, second] },
      ],
    });
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.isPreferred === undefined)).toBe(true);
  });

  it('关联诊断按 model 夹取（marker 的行列落在 model 里）', () => {
    const fake = fakeMonaco();
    install(fake);
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    const marker = actions[0]!.diagnostics![0]!;
    expect(marker.endLineNumber).toBe(3);
    expect(marker.endColumn).toBe(7);
  });
});

/* ============================== 4. 落地面 ============================== */

describe('④落地面：同一批 EditorTextEdit / run 型动作 / 停点复用', () => {
  it('命令回调把**同一批** EditorTextEdit 交给注入的 applyEdits 端口', () => {
    const fake = fakeMonaco();
    const applied: { readonly edits: readonly EditorTextEdit[] }[] = [];
    install(fake, {
      applyCodeActionEdits: (_model, edits) => {
        applied.push({ edits });
        return true;
      },
    });
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    fake.runCommand(actions[0]!.command!.id, actions[0]!.command!.arguments![0]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.edits).toEqual([{ fromLine: 3, toLine: 3, newText: '> 她点了点头。' }]);
  });

  it('没有 `edits` 的动作退回契约旧语义（`run` 发意图）', () => {
    const fake = fakeMonaco();
    const ran: string[] = [];
    install(fake, {
      codeActionSlot: () => [
        {
          id: 'intent',
          provideActions: () => [
            {
              title: '跳过去',
              run: (ctx) => {
                ran.push(`run:${ctx.activeFile ?? ''}`);
              },
            },
          ],
        },
      ],
    });
    const actions = requestActions(fake, fakeModel(NARRATION), NARRATION, 3);
    expect(actions).toHaveLength(1);
    fake.runCommand(actions[0]!.command!.id, actions[0]!.command!.arguments![0]);
    expect(ran).toEqual(['run:D:/proj/chara/开场.kojo']);
  });

  it('命令 key 不认识 / 模型已不在 ⇒ 静默不落（不崩）', () => {
    const fake = fakeMonaco();
    let calls = 0;
    install(fake, {
      applyCodeActionEdits: () => {
        calls += 1;
        return true;
      },
    });
    expect(() => fake.runCommand(SLOT_CODE_ACTION_COMMAND, 'no-such-key')).not.toThrow();
    expect(calls).toBe(0);
  });

  it('真 model + 假 editor 转发桩：调用序 `停点 → executeEdits → 停点`，文本落到真 model', () => {
    const source = NARRATION;
    const model = monaco.editor.createModel(
      source,
      KOJO2_LANGUAGE_ID,
      monaco.Uri.parse('inmemory://kojo2-code-actions/1'),
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
    expect(applyTextEdits(editor, [{ fromLine: 3, toLine: 3, newText: '> 她点了点头。' }])).toBe(true);
    expect(calls).toEqual(['stop', 'edit', 'stop']);
    expect(model.getValue()).toBe('# 机 开场\n\n> 她点了点头。\n');
    model.dispose();
  });
});

/* ============================== 5. 分层针 ============================== */

describe('⑤分层：判据不在宿主 / 落地只有一个开口 / 门控只在宿主', () => {
  it('源码钉子：写面腿在切流块里装、落地接到 `applyTextEdits`', () => {
    const providers = codeOf(
      readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'editor-global-providers.ts'), 'utf8'),
    );
    // 车 5：注册/翻译在工厂，**宿主策略**留在切流块里（同一份 `SLOT_SERVICE_WRITE_LEGS` 数据）
    expect(providers).toMatch(
      /if \(isKojo2CutoverEnabled\(\)\) \{[\s\S]{0,1200}?installSlotServiceLegs\(monaco, SLOT_SERVICE_WRITE_LEGS, slotServiceHost\)/,
    );
    expect(providers).toMatch(
      /applyCodeActionEdits: \(model, edits\) => \{[\s\S]{0,400}?return applyTextEdits\(ed, edits\);/,
    );
    // 开口只有一个：宿主里 `ed.executeEdits(` 仍然只有 applyTextEdits 那一处
    expect(providers.match(/ed\.executeEdits\(/g)?.length).toBe(1);
  });

  it('工厂层不出现 `executeEdits` / `pushUndoStop`，也不 import 包里的判据', () => {
    const layer = codeOf(
      readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'), 'utf8'),
    );
    expect(layer).not.toContain('executeEdits');
    expect(layer).not.toContain('pushUndoStop');
    // B3j：判据整块在包里（宿主留一份就是第二份）
    expect(layer).not.toContain('@kojo/kojo-lang/code-actions');
    expect(layer).not.toContain('migrateKojoSourceSemantic');
    expect(layer).not.toContain('core/migration/');
  });

  it('门控只在宿主：工厂（含这一腿）不读切流开关，旧安装器文件已删除', () => {
    const layer = codeOf(
      readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'), 'utf8'),
    );
    expect(layer).not.toContain('isKojo2CutoverEnabled');
    expect(
      existsSync(path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-code-actions.ts')),
      '旧安装器已并入槽腿工厂（车 5），别再把它加回来',
    ).toBe(false);
  });
});

/** 纯代码面（剥整行注释与块注释）：源码针只钉代码 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
