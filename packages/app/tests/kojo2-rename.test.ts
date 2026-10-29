// @vitest-environment happy-dom
/**
 * B3e · Kojo 2.0 改名的**宿主翻译层**闸（判据已整块搬进 `@kojo/kojo-lang/rename`）。
 *
 * 判据本体（引用扫描 / 三道全或无闸 / prepare / 64 文件·2000 编辑上限）在
 * `packages/kojo-lang/tests/rename.test.ts` 与 `rename-xfile.test.ts`；本文件只钉宿主那一格：
 * 1. **model → 请求**：身份三格 / 全文 / 光标 / 新名 / 当前项目 / 项目文件快照
 *    （排除自身、上限 ⇒ `projectFilesComplete: false`、没索引 ⇒ 不出现）；
 * 2. **契约 → `WorkspaceEdit`**：`resourcePath` 缺省 / 等于请求文件 ⇒ `model.uri`；其余走
 *    `uriForPath`；`versionId === undefined`；`textEdit` 的 range / text 逐项对上；
 * 3. **prepare**：`resolveRenameLocation` 只调包里 `kojo2PrepareRename`——名字段区间 / 原名
 *    作输入框初值，不在符号上 / 只读 / 重名时给理由、不弹输入框、不递请求；
 * 4. **`rejectReason` 透传**：契约给的拒绝理由原样成 Monaco 的 `rejectReason`（编辑集为空）；
 *    契约空编辑无理由 ⇒ 一条"没有可落地的编辑"；陈旧 / 越界坐标由供方拒绝后同样透传；
 * 5. **失败面**：只读 / 已释放 / 取文抛错 / 无 uri / 内核未就绪 ⇒ 拒绝，不抛；
 * 6. **注册**：经 `registerForLanguageServices(..., 'rename')` 挂上；dispose 幂等；半途抛错回滚。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import type { Kojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import { installKojo2RenameProvider } from '../src/monaco/kojo2-rename';

const HERE = import.meta.dirname;
const LAYER_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-rename.ts'),
  'utf8',
);

const RENAME_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('rename') === true,
  )
  .map((descriptor) => descriptor.id);

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

interface Registration {
  readonly selector: unknown;
  readonly provider: unknown;
}

function fakeMonaco(failAt = -1): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const registrations: Registration[] = [];
  let disposeCalls = 0;
  const fake = {
    languages: {
      registerRenameProvider: (selector: unknown, provider: unknown) => {
        if (registrations.length === failAt) throw new Error('桩：注册 rename 抛错');
        registrations.push({ selector, provider });
        return {
          dispose: () => {
            disposeCalls += 1;
          },
        };
      },
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    registrations,
    disposeCalls: () => disposeCalls,
  };
}

function fakeModel(
  text: string,
  options: {
    readonly withoutUri?: boolean;
    readonly readOnly?: boolean;
    readonly disposed?: boolean;
    readonly failGetValue?: boolean;
    readonly languageId?: string;
  } = {},
) {
  const uri = {
    scheme: 'file',
    path: '/D:/proj/a.kojo2',
    fsPath: 'D:/proj/a.kojo2',
    toString: () => 'file:///D:/proj/a.kojo2',
  };
  const model = {
    getValue: () => {
      if (options.failGetValue === true) throw new Error('桩：取文抛错');
      return text;
    },
    getLanguageId: () => options.languageId ?? KOJO2_LANGUAGE_ID,
    getVersionId: () => 7,
    getOptions: () => ({ readOnly: options.readOnly === true }),
    isDisposed: () => options.disposed === true,
    ...(options.withoutUri === true ? {} : { uri }),
  } as unknown as Monaco.editor.ITextModel;
  return model;
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

function installKernel(
  contributions: readonly EditorLanguageServiceContribution[],
  project: unknown = { adapterId: 'proj-a' },
): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => project },
  } as unknown as KernelLike);
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

/** 一条只答 rename 的贡献；`capture` 收下宿主递来的请求 */
function renameContribution(
  answer: (request: unknown) => unknown,
  capture?: (request: unknown) => void,
): EditorLanguageServiceContribution {
  return {
    id: 'stub-rename',
    provide: (request) => {
      if (request.kind !== 'rename') return undefined;
      capture?.(request);
      return answer(request);
    },
  } as EditorLanguageServiceContribution;
}

function fakeIndex(files: ReadonlyArray<{ path: string; text: string }>): Kojo2ProjectIndex {
  return {
    files: () => files.map((file) => file.path),
    getFile: (target: string) => files.find((file) => file.path === target),
  } as unknown as Kojo2ProjectIndex;
}

function installAndProvider(
  options: Parameters<typeof installKojo2RenameProvider>[1] = {},
): {
  readonly fake: ReturnType<typeof fakeMonaco>;
  readonly disposable: Monaco.IDisposable;
  readonly provider: Monaco.languages.RenameProvider;
} {
  const fake = fakeMonaco();
  const disposable = installKojo2RenameProvider(fake.monaco, options);
  const registration = fake.registrations.find((entry) => entry.selector === KOJO2_LANGUAGE_ID);
  if (registration === undefined) throw new Error('kojo2 上没有挂 rename provider');
  return {
    fake,
    disposable,
    provider: registration.provider as Monaco.languages.RenameProvider,
  };
}

const AT = (line: number, column: number): Monaco.Position =>
  ({ lineNumber: line, column }) as Monaco.Position;

function editAt(
  provider: Monaco.languages.RenameProvider,
  model: Monaco.editor.ITextModel,
  line: number,
  column: number,
  newName: string,
): Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection {
  return provider.provideRenameEdits!(model, AT(line, column), newName, TOKEN) as
    Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection;
}

/* ============================== ① 注册 ============================== */

describe('注册：共享收口 + 能力名 rename（kojo2 由 descriptor 点名）', () => {
  it('铺到"全铺语言 + 点名 rename 的语言"；kojo2 在列', () => {
    const fake = fakeMonaco();
    installKojo2RenameProvider(fake.monaco);
    const selectors = fake.registrations.map((entry) => entry.selector);
    expect(selectors).toEqual(RENAME_SELECTORS);
    expect(selectors).toContain(KOJO2_LANGUAGE_ID);
  });

  it('dispose 幂等：两次只撤一遍', () => {
    const { fake, disposable } = installAndProvider();
    disposable.dispose();
    disposable.dispose();
    expect(fake.disposeCalls()).toBe(RENAME_SELECTORS.length);
  });

  it('注册半途抛错 ⇒ 先撤回已挂上的再外抛', () => {
    const fake = fakeMonaco(1);
    expect(() => installKojo2RenameProvider(fake.monaco)).toThrow(/注册 rename 抛错/);
    expect(fake.disposeCalls()).toBe(1);
  });

  it('源码纪律：只一个注册点、语言 id 不写死、不自己 executeEdits', () => {
    expect(LAYER_SOURCE.match(/registerRenameProvider/g) ?? []).toHaveLength(1);
    expect(LAYER_SOURCE).not.toMatch(/registerRenameProvider\(\s*KOJO2_LANGUAGE_ID/);
    expect(LAYER_SOURCE).not.toContain('executeEdits');
    expect(LAYER_SOURCE).not.toContain('applyTextEdits');
  });
});

/* ============================== ①' prepare（输入框之前的位置门） ============================== */

describe('prepare：只调包里的 kojo2PrepareRename，不在宿主复制判据', () => {
  it('光标在声明名上 ⇒ 名字段区间 + 原名（F2 输入框初值）', () => {
    const { provider } = installAndProvider();
    const prepared = provider.resolveRenameLocation!(
      fakeModel('# 设 心情 整数 = 0'),
      AT(1, 6),
      TOKEN,
    ) as Monaco.languages.RenameLocation & Monaco.languages.Rejection;
    expect(prepared.rejectReason).toBeUndefined();
    expect(prepared.text).toBe('心情');
    expect(prepared.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 7,
    });
  });

  it('不在符号上 / 只读 model ⇒ 拒绝理由（不弹输入框，且不递请求）', () => {
    const capture = vi.fn();
    installKernel([renameContribution(() => ({ kind: 'rename', edits: [] }), capture)]);
    const { provider } = installAndProvider();
    const blank = provider.resolveRenameLocation!(
      fakeModel('> 只是旁白'),
      AT(1, 1),
      TOKEN,
    ) as Monaco.languages.RenameLocation & Monaco.languages.Rejection;
    expect(blank.text).toBe('');
    expect(blank.rejectReason).toBeTruthy();

    const readOnly = provider.resolveRenameLocation!(
      fakeModel('# 设 心情 整数 = 0', { readOnly: true }),
      AT(1, 6),
      TOKEN,
    ) as Monaco.languages.RenameLocation & Monaco.languages.Rejection;
    expect(readOnly.rejectReason).toContain('只读');
    expect(capture).not.toHaveBeenCalled();
  });
  it('共享收口挂到 ERB / kojo1 时弃权（不把 kojo2 的拒绝理由塞进它们的 F2）', () => {
    const { provider } = installAndProvider();
    const erbModel = fakeModel('#DIM X, 0', { languageId: 'erb' });
    expect(provider.resolveRenameLocation!(erbModel, AT(1, 1), TOKEN)).toBeUndefined();
    expect(provider.provideRenameEdits!(erbModel, AT(1, 1), 'Y', TOKEN)).toBeUndefined();
  });
});

/* ============================== ② 请求构造 ============================== */

describe('model → 请求：身份三格 / 新名 / 快照', () => {
  it('path / languageId / version / line / column / newName / project 原样递', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      renameContribution(() => ({ kind: 'rename', edits: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const { provider } = installAndProvider();
    editAt(provider, fakeModel('# 设 心情 整数 = 0'), 1, 5, '情绪');
    expect(captured.kind).toBe('rename');
    expect(captured.path).toBe('D:/proj/a.kojo2');
    expect(captured.languageId).toBe(KOJO2_LANGUAGE_ID);
    expect(captured.version).toBe(7);
    expect(captured.line).toBe(1);
    expect(captured.column).toBe(5);
    expect(captured.newName).toBe('情绪');
    expect(captured.project).toEqual({ adapterId: 'proj-a' });
  });

  it('没给索引 ⇒ 请求里不出现 projectFiles（旧行为逐字不变）', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      renameContribution(() => ({ kind: 'rename', edits: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const { provider } = installAndProvider();
    editAt(provider, fakeModel('# 设 心情 整数 = 0'), 1, 5, '情绪');
    expect(Object.hasOwn(captured, 'projectFiles')).toBe(false);
  });

  it('给了索引 ⇒ 快照排除请求文件自己；上限 ⇒ projectFilesComplete = false', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      renameContribution(() => ({ kind: 'rename', edits: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const index = fakeIndex([
      { path: 'D:/proj/a.kojo2', text: '# 设 心情 整数 = 0' },
      { path: 'D:/proj/b.kojo2', text: '> {心情}' },
      { path: 'D:/proj/c.kojo2', text: '> {心情}' },
    ]);
    const { provider } = installAndProvider({
      getIndex: () => index,
      snapshotLimits: { maxFiles: 1 },
    });
    editAt(provider, fakeModel('# 设 心情 整数 = 0'), 1, 5, '情绪');
    expect(captured.projectFiles).toEqual([{ path: 'D:/proj/b.kojo2', text: '> {心情}' }]);
    expect(captured.projectFilesComplete).toBe(false);
  });
});

/* ============================== ③ WorkspaceEdit ============================== */

describe('契约编辑 → WorkspaceEdit：resourcePath → URI / versionId / 文本', () => {
  it('本文件编辑（无 resourcePath）⇒ model.uri；跨文件 ⇒ uriForPath；versionId undefined', () => {
    installKernel([
      renameContribution(() => ({
        kind: 'rename',
        oldName: '心情',
        edits: [
          { line: 1, startColumn: 5, endColumn: 7, newText: '情绪' },
          { line: 1, startColumn: 5, endColumn: 7, newText: '情绪', resourcePath: 'D:/proj/b.kojo2' },
        ],
      })),
    ]);
    const uriForPath = vi.fn((target: string) => ({ path: target }) as Monaco.Uri);
    const { provider } = installAndProvider({ uriForPath });
    const model = fakeModel('# 设 心情 整数 = 0');
    const workspace = editAt(provider, model, 1, 5, '情绪');
    const edits = workspace.edits as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits).toHaveLength(2);
    expect(edits[0]?.resource).toBe((model as unknown as { uri: Monaco.Uri }).uri);
    expect(edits[0]?.versionId).toBeUndefined();
    expect(edits[0]?.textEdit).toEqual({
      range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 7 },
      text: '情绪',
    });
    expect(uriForPath).toHaveBeenCalledWith('D:/proj/b.kojo2');
    expect(edits[1]?.resource).toEqual({ path: 'D:/proj/b.kojo2' });
  });

  it('`resourcePath` 等于请求文件路径 ⇒ 仍落 model.uri（不绕道造新 URI）', () => {
    installKernel([
      renameContribution(() => ({
        kind: 'rename',
        edits: [
          { line: 1, startColumn: 5, endColumn: 7, newText: '情绪', resourcePath: 'D:/proj/a.kojo2' },
        ],
      })),
    ]);
    const uriForPath = vi.fn(() => ({ path: '不该被调用' }) as Monaco.Uri);
    const { provider } = installAndProvider({ uriForPath });
    const model = fakeModel('# 设 心情 整数 = 0');
    const workspace = editAt(provider, model, 1, 5, '情绪');
    const edits = workspace.edits as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits[0]?.resource).toBe((model as unknown as { uri: Monaco.Uri }).uri);
    expect(uriForPath).not.toHaveBeenCalled();
  });
});

/* ============================== ④ 拒绝理由 ============================== */

describe('rejectReason 透传与全或无形状', () => {
  it('契约 rejectReason ⇒ 原样成 Monaco 的 rejectReason，编辑集为空', () => {
    installKernel([
      renameContribution(() => ({
        kind: 'rename',
        edits: [],
        rejectReason: '新名「1坏名」不是合法的 2.0 名字',
      })),
    ]);
    const { provider } = installAndProvider();
    const workspace = editAt(provider, fakeModel('# 设 心情 整数 = 0'), 1, 5, '1坏名');
    expect(workspace.edits).toEqual([]);
    expect(workspace.rejectReason).toBe('新名「1坏名」不是合法的 2.0 名字');
  });

  it('陈旧 / 越界坐标：供方拒绝（行不在本文件里）⇒ 理由逐字透传', () => {
    installKernel([
      renameContribution((request) => {
        const line = (request as { line: number }).line;
        return {
          kind: 'rename',
          edits: [],
          rejectReason: `第 ${line} 行不在本文件里`,
        };
      }),
    ]);
    const { provider } = installAndProvider();
    const workspace = editAt(provider, fakeModel('> x'), 999, 1, '情绪');
    expect(workspace.edits).toEqual([]);
    expect(workspace.rejectReason).toContain('第 999 行不在本文件里');
  });

  it('空编辑且无理由 ⇒ 一条"没有可落地的编辑"；无人应答 ⇒ 一条"没有语言服务应答"', () => {
    installKernel([renameContribution(() => ({ kind: 'rename', edits: [] }))]);
    const { provider } = installAndProvider();
    expect(editAt(provider, fakeModel('> x'), 1, 1, '情绪').rejectReason).toContain(
      '没有可落地的编辑',
    );

    installKernel([]);
    const second = installAndProvider();
    expect(editAt(second.provider, fakeModel('> x'), 1, 1, '情绪').rejectReason).toContain(
      '没有语言服务应答',
    );
  });
});

/* ============================== ⑤ 失败面 ============================== */

describe('失败面：只读 / 已释放 / 取文抛错 / 无 uri', () => {
  it('只读 model（预览 / 生成面）⇒ 不递请求、直接拒绝', () => {
    const provide = vi.fn(() => ({ kind: 'rename', edits: [] }));
    installKernel([{ id: 'stub-rename', provide } as unknown as EditorLanguageServiceContribution]);
    const { provider } = installAndProvider();
    const workspace = editAt(provider, fakeModel('> x', { readOnly: true }), 1, 1, '情绪');
    expect(workspace.edits).toEqual([]);
    expect(workspace.rejectReason).toContain('只读');
    expect(provide).not.toHaveBeenCalled();
  });

  it('已释放 / 取文抛错 / 无 uri ⇒ 拒绝，不抛', () => {
    installKernel([
      renameContribution(() => ({
        kind: 'rename',
        edits: [{ line: 1, startColumn: 1, endColumn: 2, newText: '情绪' }],
      })),
    ]);
    const { provider } = installAndProvider();
    expect(editAt(provider, fakeModel('> x', { disposed: true }), 1, 1, '情绪').rejectReason).toContain(
      '已释放',
    );
    expect(
      editAt(provider, fakeModel('> x', { failGetValue: true }), 1, 1, '情绪').rejectReason,
    ).toContain('取不到');
    expect(editAt(provider, fakeModel('> x', { withoutUri: true }), 1, 1, '情绪').rejectReason).toContain(
      'URI',
    );
  });

  it('供方抛错 ⇒ 拒绝理由（legs 隔离后无人应答），不把 throw 甩进 Monaco', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      renameContribution(() => {
        throw new Error('桩：供方炸了');
      }),
    ]);
    const { provider } = installAndProvider();
    const workspace = editAt(provider, fakeModel('> x'), 1, 1, '情绪');
    expect(workspace.edits).toEqual([]);
    expect(workspace.rejectReason).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
