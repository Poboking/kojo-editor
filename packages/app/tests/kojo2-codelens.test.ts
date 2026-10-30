// @vitest-environment happy-dom
/**
 * B3g · Kojo 2.0 **行上注解的宿主翻译层**闸（判据已整块搬进 `@kojo/kojo-lang/codelens`）。
 *
 * 判据本体（三档识别 / 计数 / 大文件截断 / 项目快照口径）在
 * `packages/kojo-lang/tests/codelens.test.ts`；供方的三态与契约形状在
 * `packages/plugins/kojo-lang/tests/codelens.test.ts`。本文件只钉宿主自己那一格：
 *
 * 1. **请求构造**：`kind: 'codeLens'`、文件身份（注入位 → `model.uri`）、`languageId` /
 *    `version` / `lineCount` / 当前项目；**快照缺席**时请求里没有 `projectFiles`
 *    （开快照要走 `getIndex`，装配点今天不传——理由见 `monaco/kojo2-codelens.ts` 头注）；
 * 2. **契约 → Monaco**：翻译复用 v1 那枚 `toMonacoCodeLenses`（命令 id = 已注册的
 *    `kojo.codeLens.execute`、越界行丢弃、逐条唯一 id、无落点 ⇒ 空参数）；
 * 3. **三态不混**：无人应答 ⇒ provider 交 **`undefined`**（空列表会顶掉别家）；有人答空 /
 *    取文失败 / 模型已释放 / 没有内核 ⇒ `{ lenses: [] }`；
 * 4. **大文件档**：≥ `LARGE_FILE_LINES` 不问供方（省一次整篇词法 + 每个 `@函` 一次引用查询）；
 * 5. **注册**：经 `registerForLanguageServices(..., 'codeLens')` 挂 descriptor 点名的语言，
 *    dispose 幂等、注册失败原样外抛；源码里**没有** `registerCodeLensProvider(KOJO2_LANGUAGE_ID`
 *    的原生形状、也不读切流开关、不 import 判据。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EditorCodeLens,
  EditorCodeLensRequest,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import { languageDescriptors } from '../src/monaco/language-registry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { CODE_LENS_COMMAND } from '../src/monaco/kojo-code-lens';
import { installKojo2CodeLensProvider } from '../src/monaco/kojo2-codelens';
import type { Kojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import {
  codeLensRequestOf,
  collectCodeLensResult,
} from '../src/monaco/kojo-language-service-legs';
import { KOJO2_CODE_LENS_LARGE_FILE_LINES } from '@kojo/kojo-lang/codelens';

const HOST_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'monaco', 'kojo2-codelens.ts'),
  'utf8',
);

/** 共享收口该挂到的 selector（descriptor 全铺或点名 `codeLens`） */
const SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('codeLens') === true,
  )
  .map((descriptor) => descriptor.id);

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

interface Registration {
  readonly selector: string;
  readonly provider: Monaco.languages.CodeLensProvider;
}

function fakeMonaco(): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const registrations: Registration[] = [];
  let disposeCalls = 0;
  const fake = {
    languages: {
      registerCodeLensProvider: (
        selector: string,
        provider: Monaco.languages.CodeLensProvider,
      ): Monaco.IDisposable => {
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

interface FakeModelOptions {
  /** `getValue()` 抛错（模拟已释放 / 取文失败） */
  readonly breakValue?: boolean;
  /** `isDisposed()` 回 true（模拟 model 已释放） */
  readonly disposed?: boolean;
  /** 行数（缺省按文本算；大文件档用） */
  readonly lineCount?: number;
  /** 不给 uri（桩 model：没有文件身份） */
  readonly noUri?: boolean;
}

function fakeModel(text: string, options: FakeModelOptions = {}): Monaco.editor.ITextModel {
  const computedLines = text.split(/\r\n|\r|\n/).length;
  const model: Record<string, unknown> = {
    getValue: () => {
      if (options.breakValue === true) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => options.lineCount ?? computedLines,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    getVersionId: () => 7,
    isDisposed: () => options.disposed === true,
  };
  if (options.noUri !== true) {
    model['uri'] = { scheme: 'file', path: '/proj/a.kojo', fsPath: '/proj/a.kojo' };
  }
  return model as unknown as Monaco.editor.ITextModel;
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

/** 一条贡献（`provide` 的返回由用例决定） */
function contributionOf(
  provide: EditorLanguageServiceContribution['provide'],
  id = 'stub-codelens',
): EditorLanguageServiceContribution {
  return { id, provide };
}

/** 只答 `codeLens` 的贡献（记下每次收到的请求，供"请求构造"取证） */
function codeLensContribution(
  lenses: readonly EditorCodeLens[] = [],
  seen: EditorLanguageServiceRequest[] = [],
  id = 'stub-codelens',
): EditorLanguageServiceContribution {
  return contributionOf((request) => {
    seen.push(request);
    if (request.kind !== 'codeLens') return undefined;
    return { kind: 'codeLens', lenses };
  }, id);
}

/** 取回挂上来的 provider（没挂上直接抛：证据缺席不许静默） */
function providerOf(options: Parameters<typeof installKojo2CodeLensProvider>[1] = {}): {
  readonly provider: Monaco.languages.CodeLensProvider;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const fake = fakeMonaco();
  installKojo2CodeLensProvider(fake.monaco, options);
  const registration = fake.registrations.find((entry) => entry.selector === SELECTORS[0]);
  if (registration === undefined) {
    throw new Error(`codeLens 上没有挂 provider（selector=${SELECTORS[0]}）`);
  }
  return { provider: registration.provider, ...fake };
}

/** 问一次（provider 的返回值原样交回：`undefined` 与空列表是两件事） */
function ask(
  model: Monaco.editor.ITextModel,
  options: Parameters<typeof installKojo2CodeLensProvider>[1] = {},
): ReturnType<Monaco.languages.CodeLensProvider['provideCodeLenses']> {
  return providerOf(options).provider.provideCodeLenses(model, TOKEN);
}

/** 把 provider 的返回值摊成列表（`undefined` ⇒ `null`，与空列表分开） */
function lensesOf(
  result: ReturnType<typeof ask>,
): readonly Monaco.languages.CodeLens[] | null {
  if (result === undefined || result === null) return null;
  // Monaco 的类型面允许 Thenable；宿主这一枚**同步**交回（`installKojo2CodeLensProvider`
  // 里没有 async / Promise），按既有测试（`w6-dual-language-switch`）的口径收窄一次。
  return Array.isArray(result) ? result : (result as Monaco.languages.CodeLensList).lenses;
}

const LENSES: readonly EditorCodeLens[] = [
  {
    line: 1,
    label: '事件 指令 · 参数 1',
    target: { filePath: '/proj/a.kojo', line: 1, column: 5 },
  },
  { line: 3, label: '本文件 2 处用到', target: { filePath: '/proj/a.kojo', line: 3, column: 4 } },
];

const SOURCE = '# 机 指令 310\n@织 回合末 之后\n@函 增加羁绊()\n    ! 增加羁绊(1)\n';

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== ① 注册面 ============================== */

describe('①注册：共享收口带能力名 `codeLens`，原生形状清零', () => {
  it('selector 恰是 descriptor 全铺 / 点名 codeLens 的那些语言（kojo2 在内）', () => {
    const fake = fakeMonaco();
    installKojo2CodeLensProvider(fake.monaco);
    expect(fake.registrations.map((entry) => entry.selector).sort()).toEqual(
      [...SELECTORS].sort(),
    );
    expect(fake.registrations.map((entry) => entry.selector)).toContain(KOJO2_LANGUAGE_ID);
  });

  it('dispose 幂等：连撤两次，每一门的注册各撤一次、不抛', () => {
    const fake = fakeMonaco();
    const handle = installKojo2CodeLensProvider(fake.monaco);
    handle.dispose();
    handle.dispose();
    expect(fake.disposeCalls()).toBe(SELECTORS.length);
    expect(() => handle.dispose()).not.toThrow();
  });

  it('注册失败原样外抛（共享收口已把半途挂上的撤回）', () => {
    const monaco = {
      languages: {
        registerCodeLensProvider: () => {
          throw new Error('桩：注册抛错');
        },
      },
    } as unknown as typeof Monaco;
    expect(() => installKojo2CodeLensProvider(monaco)).toThrow('桩：注册抛错');
  });

  it('源码里没有 `registerCodeLensProvider(KOJO2_LANGUAGE_ID` 的原生形状，也不读切流开关', () => {
    expect(HOST_SOURCE).not.toMatch(/registerCodeLensProvider\(\s*KOJO2_LANGUAGE_ID/);
    expect(HOST_SOURCE).toMatch(/registerForLanguageServices\(/);
    expect(HOST_SOURCE).toContain("'codeLens'");
    expect(HOST_SOURCE).not.toMatch(/isKojo2CutoverEnabled/);
  });

  it('宿主不 import 判据：请求构造走 legs、翻译复用 v1 那枚共享函数（判据只在包里）', () => {
    expect(HOST_SOURCE).toContain("from './kojo-language-service-legs'");
    expect(HOST_SOURCE).toContain("from './kojo-code-lens'");
    // 判据（三档识别 / 计数）一件都不在宿主：包叶子只在插件里被引。
    expect(HOST_SOURCE).not.toMatch(/from\s+'@kojo\/kojo-lang/);
    expect(HOST_SOURCE).not.toContain('kojo2ReferencesAt');
  });

  it('行数界线与包的缺省同值（两处漂开就是两套体量口径）', () => {
    expect(KOJO2_CODE_LENS_LARGE_FILE_LINES).toBe(LARGE_FILE_LINES);
  });
});

/* ============================== ② 请求构造 ============================== */

describe('②请求构造：身份三格 / 项目 / 快照缺席', () => {
  it('`kind` / `path` / `languageId` / `version` / `lineCount` / `project` 逐格就位', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    lensesOf(ask(fakeModel(SOURCE)));
    const request = seen[0] as EditorCodeLensRequest;
    expect(request.kind).toBe('codeLens');
    expect(request.path).toBe('/proj/a.kojo');
    expect(request.languageId).toBe(KOJO2_LANGUAGE_ID);
    expect(request.version).toBe(7);
    expect(request.text).toBe(SOURCE);
    expect(request.lineCount).toBe(5); // 4 行正文 + 结尾换行（与 Monaco `getLineCount` 同口径）
    expect(request.project).toEqual({ adapterId: 'proj-a' });
  });

  it('文件身份：注入位优先；注入位抛错 ⇒ 退回 `model.uri`；都没 ⇒ `path: \'\'`', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);

    lensesOf(ask(fakeModel(SOURCE), { getFilePath: () => 'D:/别的/path.kojo2' }));
    expect((seen[0] as EditorCodeLensRequest).path).toBe('D:/别的/path.kojo2');

    lensesOf(
      ask(fakeModel(SOURCE), {
        getFilePath: () => {
          throw new Error('桩：身份取不到');
        },
      }),
    );
    expect((seen[1] as EditorCodeLensRequest).path).toBe('/proj/a.kojo');

    lensesOf(ask(fakeModel(SOURCE, { noUri: true })));
    expect((seen[2] as EditorCodeLensRequest).path).toBe('');
  });

  it('快照缺席（装配点今天不给 `getIndex`）⇒ 请求里没有 `projectFiles` 这两格', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    lensesOf(ask(fakeModel(SOURCE)));
    const request = seen[0] as EditorCodeLensRequest;
    expect(request.projectFiles).toBeUndefined();
    expect(request.projectFilesComplete).toBeUndefined();
  });

  it('给了 `getIndex` ⇒ 快照经 B3e 同一条腿进请求（本文件被排除、截断如实）', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    const files = new Map([
      ['/proj/a.kojo', SOURCE],
      ['/proj/b.kojo2', '# 幕 夜晚\n! 增加羁绊(2)\n'],
      ['/proj/c.kojo2', '# 幕 清晨\n> 无关。\n'],
    ]);
    lensesOf(
      ask(fakeModel(SOURCE), {
        // 桩索引只给快照取数用到的两面（与 `kojo-language-service-legs-references-rename`
        // 的同形桩一致：索引的其余面这一格走不到）。
        getIndex: () =>
          ({
            files: () => [...files.keys()],
            getFile: (filePath: string) => ({ path: filePath, text: files.get(filePath) ?? '' }),
          }) as unknown as Kojo2ProjectIndex,
        snapshotLimits: { maxFiles: 1 },
      }),
    );
    const request = seen[0] as EditorCodeLensRequest;
    // 本文件被排除（同文件结果由供方自己给），且只剩一份名额 ⇒ complete 如实为 false。
    expect(request.projectFiles?.map((file) => file.path)).toEqual(['/proj/b.kojo2']);
    expect(request.projectFilesComplete).toBe(false); // 还差一份没塞进去 ⇒ 如实说"少给了"
  });

  it('索引 getter 抛错 ⇒ 请求里没有快照（只是同文件结果，不崩）', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    lensesOf(
      ask(fakeModel(SOURCE), {
        getIndex: () => {
          throw new Error('桩：索引炸了');
        },
      }),
    );
    expect((seen[0] as EditorCodeLensRequest).projectFiles).toBeUndefined();
  });
});

/* ============================== ③ 契约 → Monaco ============================== */

describe('③契约 → Monaco：复用 v1 那枚翻译器', () => {
  it('行 / 文本 / 命令 id / 落点参数逐条翻译（id 逐条唯一）', () => {
    installKernel([codeLensContribution(LENSES)]);
    const lenses = lensesOf(ask(fakeModel(SOURCE)))!;
    expect(lenses).toHaveLength(2);
    expect(lenses.map((lens) => lens.command?.title)).toEqual([
      '事件 指令 · 参数 1',
      '本文件 2 处用到',
    ]);
    for (const lens of lenses) expect(lens.command?.id).toBe(CODE_LENS_COMMAND);
    expect(new Set(lenses.map((lens) => lens.id)).size).toBe(lenses.length);
    expect(lenses[1]!.range.startLineNumber).toBe(3);
    expect((lenses[1]!.command?.arguments as Array<{ filePath: string }>)[0]!.filePath).toBe(
      '/proj/a.kojo',
    );
  });

  it('越界行一律丢弃（错标比不标危险：不夹取到最近的有效行）', () => {
    installKernel([codeLensContribution([{ line: 99, label: '第 99 行的话' }])]);
    expect(lensesOf(ask(fakeModel(SOURCE)))).toEqual([]);
  });

  it('没有落点的注解照样给同一条命令 + 空参数（不给 Monaco 一个没人接的 id）', () => {
    installKernel([codeLensContribution([{ line: 1, label: '只说一句话' }])]);
    const [lens] = lensesOf(ask(fakeModel(SOURCE)))!;
    expect(lens!.command?.id).toBe(CODE_LENS_COMMAND);
    expect(lens!.command?.arguments).toEqual([]);
  });

  it('有人答空表 ⇒ `{ lenses: [] }`（作答，不是弃权）', () => {
    installKernel([codeLensContribution([])]);
    expect(lensesOf(ask(fakeModel(SOURCE)))).toEqual([]);
  });
});

/* ============================== ④ 三态与失败面 ============================== */

describe('④三态与失败面', () => {
  it('无人应答（没有贡献 / 全部弃权）⇒ provider 交 `undefined`，不交空列表', () => {
    installKernel([]);
    expect(ask(fakeModel(SOURCE))).toBeUndefined();

    installKernel([contributionOf(() => undefined)]);
    expect(ask(fakeModel(SOURCE))).toBeUndefined();
  });

  it('贡献抛错 ⇒ 被隔离（这一家没说话），别家的作答仍然生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      contributionOf(() => {
        throw new Error('桩：供方炸了');
      }, 'boom'),
      codeLensContribution(LENSES, [], 'ok'),
    ]);
    expect(lensesOf(ask(fakeModel(SOURCE)))).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it('取文抛错 ⇒ `{ lenses: [] }`、不抛（Monaco 的 throw 会被吞成"注解突然没了"）', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    expect(lensesOf(ask(fakeModel(SOURCE, { breakValue: true })))).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('模型已释放 ⇒ `{ lenses: [] }`，也不问供方', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    expect(lensesOf(ask(fakeModel(SOURCE, { disposed: true })))).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('没有内核（装配顺序错了）⇒ `{ lenses: [] }`，不抛进击键路径', () => {
    setGlobalKernel(undefined as unknown as KernelLike);
    expect(lensesOf(ask(fakeModel(SOURCE)))).toEqual([]);
  });
});

/* ============================== ⑤ 大文件档 ============================== */

describe('⑤大文件档：≥ LARGE_FILE_LINES 不问供方', () => {
  it('恰好 LARGE_FILE_LINES 行 ⇒ 已进大文件档（界线是「大于等于」）', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    expect(lensesOf(ask(fakeModel(SOURCE, { lineCount: LARGE_FILE_LINES })))).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('LARGE_FILE_LINES - 1 行 ⇒ 照常问（供方自己还有"只产前 N 条"的渲染预算）', () => {
    const seen: EditorLanguageServiceRequest[] = [];
    installKernel([codeLensContribution(LENSES, seen)]);
    expect(lensesOf(ask(fakeModel(SOURCE, { lineCount: LARGE_FILE_LINES - 1 })))).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });
});

/* ============================== ⑥ legs：请求构造 / 单答裁决 ============================== */

describe('⑥legs：`codeLensRequestOf` 与 `collectCodeLensResult`', () => {
  const IDENTITY = { path: '/proj/a.kojo', languageId: KOJO2_LANGUAGE_ID, version: 3 };

  it('请求构造：快照缺席不出现那两格；给了就一起给（complete 如实）', () => {
    const plain = codeLensRequestOf(IDENTITY, 'a\nb\n', null);
    expect(plain).toEqual({
      kind: 'codeLens',
      path: '/proj/a.kojo',
      languageId: KOJO2_LANGUAGE_ID,
      version: 3,
      text: 'a\nb\n',
      project: null,
      lineCount: 3, // 2 行正文 + 结尾换行（与 Monaco `getLineCount` 同口径）
    });
    const withSnapshot = codeLensRequestOf(IDENTITY, 'a\nb\n', null, {
      files: [{ path: '/proj/b.kojo2', text: 'x\n' }],
      complete: false,
    });
    expect(withSnapshot.projectFiles).toEqual([{ path: '/proj/b.kojo2', text: 'x\n' }]);
    expect(withSnapshot.projectFilesComplete).toBe(false);
  });

  it('单答：第一家作答的说了算，后面的不再问', () => {
    const seen: string[] = [];
    const first = contributionOf((request) => {
      seen.push('first');
      return request.kind === 'codeLens' ? { kind: 'codeLens', lenses: LENSES } : undefined;
    }, 'first');
    const second = contributionOf((request) => {
      seen.push('second');
      return request.kind === 'codeLens' ? { kind: 'codeLens', lenses: [] } : undefined;
    }, 'second');
    const request = codeLensRequestOf(IDENTITY, 'a\n', null);
    const result = collectCodeLensResult([first, second], request);
    expect(result?.lenses).toHaveLength(2);
    expect(seen).toEqual(['first']);
  });

  it('弃权（undefined）会让下一家作答；全部弃权 ⇒ undefined', () => {
    const silent = contributionOf(() => undefined, 'silent');
    const answering = codeLensContribution(LENSES, [], 'answering');
    const request = codeLensRequestOf(IDENTITY, 'a\n', null);
    expect(collectCodeLensResult([silent, answering], request)?.lenses).toHaveLength(2);
    expect(collectCodeLensResult([silent], request)).toBeUndefined();
  });
});
