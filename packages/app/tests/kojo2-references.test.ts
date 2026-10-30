// @vitest-environment happy-dom
/**
 * B3e · Kojo 2.0 查找引用的**宿主翻译层**闸（判据已整块搬进 `@kojo/kojo-lang/references`）。
 *
 * 判据本体（符号归属 / 表达式扫描 / 跨文件合并 / 500 条上限 / 快照索引）在
 * `packages/kojo-lang/tests/references.test.ts`；本文件只钉宿主自己那一格，五件事：
 * 1. **model → 请求**：身份三格 / 全文 / 光标位 / 当前项目，以及**项目文件快照**
 *    （从注入的索引现取、排除请求文件自己、超文件数 / 字节数上限 ⇒ `projectFilesComplete: false`；
 *    没给索引 ⇒ 请求里**不出现** `projectFiles`）；
 * 2. **契约 → Monaco `Location[]`**：本文落点用 `model.uri`，跨文件落点走 `uriForPath`；
 *    `span` → `IRange`；`includeDeclaration === false` 去掉 `kind: 'definition'` 的声明位；
 * 3. **三态**：无人应答 / 空结果 ⇒ `[]`；`truncated` ⇒ 照给落点 + warn 一条；
 * 4. **失败面**：取文抛错 / model 无 uri ⇒ `[]`（不抛进 Monaco）；
 * 5. **注册**：经 `registerForLanguageServices(..., 'references')` 挂上（kojo2 由 descriptor
 *    点名）；dispose 幂等；注册半途抛错先回滚再外抛。
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
// SDK-B5b 车 3（2026-10-31）：宿主翻译层并入语言无关的槽腿工厂（`legOf('references', …)`）。
import {
  installSlotServiceLegs,
  type SlotServiceHost,
} from '../src/monaco/slot-service-providers';

const HERE = import.meta.dirname;
const LAYER_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'),
  'utf8',
);

/* ============================== 共享收口的期望 selector ============================== */

const REFERENCE_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('references') === true,
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
      registerReferenceProvider: (selector: unknown, provider: unknown) => {
        if (registrations.length === failAt) throw new Error('桩：注册引用 provider 抛错');
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
  readonly withoutUri?: boolean;
}

/** 假 model：路径 = `D:/proj/a.kojo2`，语言 kojo2，版本 7 */
function fakeModel(text: string, options: FakeModelOptions = {}) {
  let broken = false;
  const uri = {
    scheme: 'file',
    path: '/D:/proj/a.kojo2',
    fsPath: 'D:/proj/a.kojo2',
    toString: () => 'file:///D:/proj/a.kojo2',
  };
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    getVersionId: () => 7,
    isDisposed: () => broken,
    ...(options.withoutUri === true ? {} : { uri }),
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    breakModel: () => {
      broken = true;
    },
  };
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

/** 一条只答 references 的贡献；`capture` 收下宿主递来的请求 */
function referencesContribution(
  answer: (request: unknown) => unknown,
  capture?: (request: unknown) => void,
): EditorLanguageServiceContribution {
  return {
    id: 'stub-references',
    provide: (request) => {
      if (request.kind !== 'references') return undefined;
      capture?.(request);
      return answer(request);
    },
  } as EditorLanguageServiceContribution;
}

/** 假项目索引：只实现快照要的两格（`files` / `getFile`） */
function fakeIndex(files: ReadonlyArray<{ path: string; text: string }>): Kojo2ProjectIndex {
  return {
    files: () => files.map((file) => file.path),
    getFile: (target: string) => files.find((file) => file.path === target),
  } as unknown as Kojo2ProjectIndex;
}

/** 安装一枚 provider 并取回它（注册集合按共享收口铺语言，取 kojo2 那一枚） */
function installAndProvider(
  options: SlotServiceHost = {},
): {
  readonly fake: ReturnType<typeof fakeMonaco>;
  readonly disposable: Monaco.IDisposable;
  readonly provider: Monaco.languages.ReferenceProvider;
} {
  const fake = fakeMonaco();
  const disposable = installSlotServiceLegs(fake.monaco, ['references'], options);
  const registration = fake.registrations.find((entry) => entry.selector === KOJO2_LANGUAGE_ID);
  if (registration === undefined) throw new Error('kojo2 上没有挂引用 provider');
  return {
    fake,
    disposable,
    provider: registration.provider as Monaco.languages.ReferenceProvider,
  };
}

function provide(
  provider: Monaco.languages.ReferenceProvider,
  model: Monaco.editor.ITextModel,
  line: number,
  column: number,
  includeDeclaration = true,
): Monaco.languages.Location[] {
  return provider.provideReferences(
    model,
    { lineNumber: line, column } as Monaco.Position,
    { includeDeclaration } as Monaco.languages.ReferenceContext,
    TOKEN,
  ) as Monaco.languages.Location[];
}

/* ============================== ① 注册 ============================== */

describe('注册：共享收口 + 能力名 references（kojo2 由 descriptor 点名）', () => {
  it('铺到"全铺语言 + 点名 references 的语言"；kojo2 在列、ERB / kojo1 也在列', () => {
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['references']);
    const selectors = fake.registrations.map((entry) => entry.selector);
    expect(selectors).toEqual(REFERENCE_SELECTORS);
    expect(selectors).toContain(KOJO2_LANGUAGE_ID);
  });

  it('dispose 幂等：两次只撤一遍', () => {
    const { fake, disposable } = installAndProvider();
    disposable.dispose();
    disposable.dispose();
    expect(fake.disposeCalls()).toBe(REFERENCE_SELECTORS.length);
  });

  it('注册半途抛错 ⇒ 先撤回已挂上的再外抛', () => {
    const fake = fakeMonaco(1);
    expect(() => installSlotServiceLegs(fake.monaco, ['references'])).toThrow(
      /注册引用 provider 抛错/,
    );
    expect(fake.disposeCalls()).toBe(1);
  });

  it('源码纪律：只 type-only 引 Monaco、不碰插件包 / kernel；注册调用只有一个、语言 id 不写死', () => {
    expect(LAYER_SOURCE).toContain("import type * as Monaco from './entry'");
    expect(LAYER_SOURCE).not.toMatch(/from\s+'@kojo\/plugin-(?!api')/);
    expect(LAYER_SOURCE).not.toMatch(/@kojo\/kernel/);
    expect(LAYER_SOURCE.match(/registerReferenceProvider/g) ?? []).toHaveLength(1);
    expect(LAYER_SOURCE).not.toMatch(/registerReferenceProvider\(\s*KOJO2_LANGUAGE_ID/);
  });
});

/* ============================== ② 请求构造 ============================== */

describe('model → 请求：身份三格 / 全文 / 光标 / 快照', () => {
  it('身份与位置原样递：languageId / version / path / line / column / lineCount', () => {
    installKernel(
      [referencesContribution(() => ({ kind: 'references', locations: [] }))],
    );
    let captured: Record<string, unknown> = {};
    const { provider } = installAndProvider();
    installKernel([
      referencesContribution(() => ({ kind: 'references', locations: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const { model } = fakeModel('# 设 心情 整数 = 0\n> {心情}');
    provide(provider, model, 2, 4);
    expect(captured.kind).toBe('references');
    expect(captured.path).toBe('D:/proj/a.kojo2');
    expect(captured.languageId).toBe(KOJO2_LANGUAGE_ID);
    expect(captured.version).toBe(7);
    expect(captured.line).toBe(2);
    expect(captured.column).toBe(4);
    expect(captured.lineCount).toBe(2);
    expect(captured.text).toBe('# 设 心情 整数 = 0\n> {心情}');
    expect(captured.project).toEqual({ adapterId: 'proj-a' });
  });

  it('没给索引 ⇒ 请求里不出现 projectFiles（旧行为逐字不变）', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      referencesContribution(() => ({ kind: 'references', locations: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const { provider } = installAndProvider();
    provide(provider, fakeModel('> x').model, 1, 1);
    expect(Object.hasOwn(captured, 'projectFiles')).toBe(false);
    expect(Object.hasOwn(captured, 'projectFilesComplete')).toBe(false);
  });

  it('给了索引 ⇒ 快照排除请求文件自己，其余原样进 projectFiles', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      referencesContribution(() => ({ kind: 'references', locations: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const index = fakeIndex([
      { path: 'D:/proj/a.kojo2', text: '> 自己' },
      { path: 'D:/proj/b.kojo2', text: '> 别人' },
    ]);
    const { provider } = installAndProvider({ projectIndex: () => index });
    provide(provider, fakeModel('> x').model, 1, 1);
    expect(captured.projectFiles).toEqual([{ path: 'D:/proj/b.kojo2', text: '> 别人' }]);
    expect(captured.projectFilesComplete).toBe(true);
  });

  it('快照上限：文件数超 ⇒ 截到上限并置 projectFilesComplete = false', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      referencesContribution(() => ({ kind: 'references', locations: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const index = fakeIndex([
      { path: 'D:/proj/a.kojo2', text: '> 自己' },
      { path: 'D:/proj/b.kojo2', text: 'b' },
      { path: 'D:/proj/c.kojo2', text: 'c' },
    ]);
    const { provider } = installAndProvider({
      projectIndex: () => index,
      snapshotLimits: { maxFiles: 1 },
    });
    provide(provider, fakeModel('> x').model, 1, 1);
    expect(captured.projectFiles).toEqual([{ path: 'D:/proj/b.kojo2', text: 'b' }]);
    expect(captured.projectFilesComplete).toBe(false);
  });

  it('快照上限：字节数超 ⇒ 不出这一份并置 projectFilesComplete = false', () => {
    let captured: Record<string, unknown> = {};
    installKernel([
      referencesContribution(() => ({ kind: 'references', locations: [] }), (request) => {
        captured = request as Record<string, unknown>;
      }),
    ]);
    const index = fakeIndex([{ path: 'D:/proj/b.kojo2', text: '0123456789' }]);
    const { provider } = installAndProvider({
      projectIndex: () => index,
      snapshotLimits: { maxBytes: 4 },
    });
    provide(provider, fakeModel('> x').model, 1, 1);
    expect(captured.projectFiles).toEqual([]);
    expect(captured.projectFilesComplete).toBe(false);
  });
});

/* ============================== ③ 契约 → Monaco ============================== */

describe('契约 → Monaco Location[]：uri / range / includeDeclaration', () => {
  it('本文落点用 model.uri；跨文件落点走 uriForPath；span → IRange', () => {
    installKernel([
      referencesContribution(() => ({
        kind: 'references',
        locations: [
          {
            filePath: 'D:/proj/a.kojo2',
            line: 1,
            column: 5,
            span: { columnStart: 5, columnEnd: 7 },
            kind: 'definition',
          },
          {
            filePath: 'D:/proj/b.kojo2',
            line: 3,
            column: 2,
            span: { columnStart: 2, columnEnd: 6 },
            kind: 'mention',
          },
        ],
      })),
    ]);
    const uriForPath = vi.fn((target: string) => ({ path: target }) as Monaco.Uri);
    const { provider } = installAndProvider({ uriForPath });
    const { model } = fakeModel('> x');
    const locations = provide(provider, model, 1, 5);
    expect(locations).toHaveLength(2);
    expect(locations[0]?.uri).toBe((model as unknown as { uri: Monaco.Uri }).uri);
    expect(locations[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 7,
    });
    expect(uriForPath).toHaveBeenCalledWith('D:/proj/b.kojo2');
    expect(locations[1]?.range.startLineNumber).toBe(3);
  });

  it('`includeDeclaration === false` ⇒ 去掉 kind 为 definition 的声明位', () => {
    installKernel([
      referencesContribution(() => ({
        kind: 'references',
        locations: [
          { filePath: 'D:/proj/a.kojo2', line: 1, column: 5, kind: 'definition' },
          { filePath: 'D:/proj/a.kojo2', line: 9, column: 1, kind: 'mention' },
        ],
      })),
    ]);
    const { provider } = installAndProvider();
    const { model } = fakeModel('> x');
    const kept = provide(provider, model, 1, 5, false);
    expect(kept.map((location) => location.range.startLineNumber)).toEqual([9]);
    // 缺省 span / column ⇒ 零宽
    expect(kept[0]?.range).toEqual({
      startLineNumber: 9,
      startColumn: 1,
      endLineNumber: 9,
      endColumn: 1,
    });
  });

  it('truncated ⇒ 落点照给 + warn 一条（不静默少给）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      referencesContribution(() => ({
        kind: 'references',
        locations: [{ filePath: 'D:/proj/a.kojo2', line: 1, column: 1, kind: 'mention' }],
        truncated: true,
      })),
    ]);
    const { provider } = installAndProvider();
    const locations = provide(provider, fakeModel('> x').model, 1, 1);
    expect(locations).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/* ============================== ④ 三态 / 失败面 ============================== */

describe('三态与失败面：无人应答 / 空结果 / 取文失败 / 无 uri', () => {
  it('槽里没有供方 ⇒ []（不抛）', () => {
    installKernel([]);
    const { provider } = installAndProvider();
    expect(provide(provider, fakeModel('> x').model, 1, 1)).toEqual([]);
  });

  it('供方作答空结果 ⇒ []（作答，不是弃权；宿主只看形状）', () => {
    installKernel([referencesContribution(() => ({ kind: 'references', locations: [] }))]);
    const { provider } = installAndProvider();
    expect(provide(provider, fakeModel('> x').model, 1, 1)).toEqual([]);
  });

  it('取文抛错 / model 无 uri ⇒ []', () => {
    installKernel([
      referencesContribution(() => ({
        kind: 'references',
        locations: [{ filePath: 'D:/proj/a.kojo2', line: 1, column: 1, kind: 'mention' }],
      })),
    ]);
    const { provider } = installAndProvider();
    const broken = fakeModel('> x');
    broken.breakModel();
    expect(provide(provider, broken.model, 1, 1)).toEqual([]);
    expect(provide(provider, fakeModel('> x', { withoutUri: true }).model, 1, 1)).toEqual([]);
  });

  it('供方抛错 ⇒ []（legs 隔离后无人应答，不把 throw 甩进 Monaco）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      referencesContribution(() => {
        throw new Error('桩：供方炸了');
      }),
    ]);
    const { provider } = installAndProvider();
    expect(provide(provider, fakeModel('> x').model, 1, 1)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
