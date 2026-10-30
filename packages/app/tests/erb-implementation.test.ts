/**
 * 跳到实现（`erb-implementation.ts`）单测——**不依赖真 Monaco**（桩同 `erb-rename.test.ts`）。
 *
 * W9 之后本模块**没有取数判据**；ERB-PARITY G3（2026-10-31）起取数请求的判别式是
 * `kind: 'implementation'`（**不再借** `kind: 'definition'`）：`Ctrl+F12` 与 `F12` 是两条
 * Monaco provider，对应槽里两条**各自点名**的腿。本文件钉的五件事全是**接线**：
 * (a) 注册面拉平到 ERB 方言族 + `.kojo`（旧实现只注册给 ERB ⇒ `Ctrl+F12` 在 `.kojo` 无人应答）；
 * (b) 取数一律问槽，**不再直读 `ErbIndex.byName`**（源码级钉死：本文件不许出现 byName）；
 * (c) 三条腿与转到定义逐字同构（有 model ⇒ 真 `LocationLink[]`；缺 model ⇒ 事件通道；空 ⇒ 不应答）；
 * (d) 落点区间一路带到 `targetSelectionRange`，且与转到定义**同一个位置**（对拍见
 *     `tests/reveal-span.test.ts`）；
 * (e) 取数口是 `resolveImplementation`（G3）：实现腿**不许**顺手拿定义腿的 `resolve`——
 *     否则"哪条腿在答"又变成宿主里的隐式决定（kojo2 没有实现面这件事就无处表达）。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import type { EditorLanguageServiceContribution } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  collectDefinitionLocations,
  type DefinitionLocation,
} from '../src/monaco/kojo-definition';
import { installImplementationProvider, type ImplementationHandlers } from '../src/monaco/erb-implementation';

const TOKEN = { isCancellationRequested: false } as Monaco.CancellationToken;
const POS = { lineNumber: 1, column: 7 } as Monaco.Position;

/* ============================== 桩 ============================== */

interface ModelOpts {
  lineContent?: string;
  word?: { startColumn: number; endColumn: number } | null;
  uri?: string;
}

const stubModel = ({ lineContent = 'CALL FOO_BAR', word = null, uri = 'file:///x.ERB' }: ModelOpts = {}) =>
  ({
    getLineContent: () => lineContent,
    getLineCount: () => 20,
    getLineMaxColumn: () => lineContent.length + 1,
    getWordAtPosition: () => word,
    uri: { toString: () => uri },
  }) as unknown as Monaco.editor.ITextModel;

/** 桩 monaco：记录注册面（同 erb-rename.test.ts 口径） */
function stubMonaco() {
  const registered: Array<{ language: string; provider: Monaco.languages.ImplementationProvider }> = [];
  const monaco = {
    languages: {
      registerImplementationProvider: (language: string, provider: Monaco.languages.ImplementationProvider) => {
        registered.push({ language, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/** 只答"FOO_BAR 定义在 C:/p/a.ERB 第 10 行第 2-9 列"的供方（模拟 erb-parser 的语言服务贡献） */
function contribution(locations: readonly DefinitionLocation[]): EditorLanguageServiceContribution {
  return {
    id: 'stub',
    provide: (request) =>
      request.kind === 'implementation' ? { kind: 'implementation', locations } : undefined,
  } as EditorLanguageServiceContribution;
}

/**
 * 把"问槽"这条腿接成 handlers 的取数口（装配层就是这么写的：槽 → `collectDefinitionLocations`）。
 * 这里发的判别式是 `implementation`——供方那侧不认它就会弃权，用例因此同时钉住了请求形状。
 */
const resolveImplementationFrom = (
  contributions: readonly EditorLanguageServiceContribution[],
): ImplementationHandlers['resolveImplementation'] => (model, position) =>
  collectDefinitionLocations(contributions, {
    kind: 'implementation',
    path: 'C:/p/current.ERB',
    text: model.getLineContent(position.lineNumber),
    line: position.lineNumber,
    column: position.column,
    project: null,
    lineCount: model.getLineCount(),
  });

/** 装配形状的最小 handlers（`resolve` 是 `DefinitionHandlers` 的既有字段，实现腿不读它） */
function handlersOf(
  resolveImplementation: ImplementationHandlers['resolveImplementation'],
  rest: Partial<ImplementationHandlers> = {},
): ImplementationHandlers {
  return {
    resolve: () => {
      throw new Error('实现腿不许改问 definition 那条请求');
    },
    resolveImplementation,
    navigate: () => undefined,
    ...rest,
  };
}

/* ============================== 注册面（判据④的前半：`.kojo` 也有人应答） ============================== */

describe('installImplementationProvider · 注册面', () => {
  it('ERB 方言族与 `.kojo` 两个语言 id 都注册（旧实现只给 ERB ⇒ `.kojo` 里 Ctrl+F12 无应答）', () => {
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, handlersOf(() => []));
    expect(registered.map((r) => r.language).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
  });

  it('dispose 把两枚都回收（不留悬 provider）', () => {
    const disposed: string[] = [];
    const monaco = {
      languages: {
        registerImplementationProvider: (language: string) => ({
          dispose: () => disposed.push(language),
        }),
      },
    } as unknown as typeof Monaco;
    const handle = installImplementationProvider(monaco, handlersOf(() => []));
    handle.dispose();
    expect(disposed.sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
  });

  it('判据③的另一半：本文件不直读索引——**代码行**里既没有 `byName` 也没有 `erb.parser`', () => {
    // 只查代码行（与 `tools/audit-decoupling.mjs` 的 A/D 项同一口径）：
    // 文件头注里写"以前直读 byName"正是本批要留下的取证，不该被自己的扫描判成违规
    const code = readFileSync(new URL('../src/monaco/erb-implementation.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map((line: string) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).not.toMatch(/byName/);
    expect(code).not.toMatch(/erb\.parser/);
    expect(code).toMatch(/provideLocations/); // 取数与落地全走转到定义那一条腿
  });
});

/* ============================== 三条腿（与转到定义同一条实现路径） ============================== */

describe('installImplementationProvider · 三条腿', () => {
  it('槽答不出的名字（引擎系统函数 / 拼错词）⇒ 不应答 = 真话"没有实现"（不报错、不猜）', () => {
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, handlersOf(resolveImplementationFrom([contribution([])]), {
      openModelFor: () => undefined,
    }));
    const ret = registered[0]!.provider.provideImplementation(stubModel(), POS, TOKEN);
    expect(ret).toBeUndefined();
  });

  it('目标已开标签 ⇒ 真 `LocationLink[]`，uri 取现成 model 的 uri，落点带区间', () => {
    const targetModel = stubModel({ lineContent: '@FOO_BAR', uri: 'file:///a.ERB' });
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, handlersOf(resolveImplementationFrom([
      contribution([{ filePath: 'C:/p/a.ERB', line: 10, column: 2, span: { columnStart: 2, columnEnd: 9 } }]),
    ]), {
      openModelFor: (filePath) => (filePath === 'C:/p/a.ERB' ? targetModel : undefined),
    }));
    const links = registered[0]!.provider.provideImplementation(
      stubModel({ word: { startColumn: 6, endColumn: 13 } }),
      POS,
      TOKEN,
    ) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.uri).toBe(targetModel.uri);
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 10,
      startColumn: 2,
      endLineNumber: 10,
      endColumn: 9,
    });
    expect(links[0]!.originSelectionRange).toEqual({
      startLineNumber: 1,
      startColumn: 6,
      endLineNumber: 1,
      endColumn: 13,
    });
  });

  it('目标没开标签 ⇒ 走 `editor.revealLocation`（navigate 收到的是**带区间**的目标）并返回 undefined', () => {
    const navigated: unknown[] = [];
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, handlersOf(resolveImplementationFrom([
      contribution([{ filePath: 'C:/p/a.ERB', line: 10, column: 2, span: { columnStart: 2, columnEnd: 9 } }]),
    ]), {
      navigate: (location) => navigated.push(location),
      openModelFor: () => undefined,
    }));
    expect(registered[0]!.provider.provideImplementation(stubModel(), POS, TOKEN)).toBeUndefined();
    expect(navigated).toEqual([
      { filePath: 'C:/p/a.ERB', line: 10, column: 2, span: { columnStart: 2, columnEnd: 9 } },
    ]);
  });

  it('`.kojo` 有应答（判据④）：糖线供方给出实现目标 ⇒ 同一个 provider 给出链接', () => {
    const kojoModel = stubModel({ lineContent: '时机 指令 310：', uri: 'file:///a.kojo' });
    const { monaco, registered } = stubMonaco();
    const kojoTarget = stubModel({ lineContent: '调教 段：', uri: 'file:///b.kojo' });
    installImplementationProvider(monaco, handlersOf(resolveImplementationFrom([
      contribution([{ filePath: 'C:/p/b.kojo', line: 4, column: 1, span: { columnStart: 1, columnEnd: 3 } }]),
    ]), {
      openModelFor: (filePath) => (filePath === 'C:/p/b.kojo' ? kojoTarget : undefined),
    }));
    const kojoProvider = registered.find((r) => r.language === KOJO_LANGUAGE_ID)!.provider;
    const links = kojoProvider.provideImplementation(kojoModel, { lineNumber: 2, column: 3 } as Monaco.Position, TOKEN);
    expect(Array.isArray(links)).toBe(true);
    expect((links as Monaco.languages.LocationLink[])[0]!.uri).toBe(kojoTarget.uri);
  });

  it('宿主取数口抛错 ⇒ 不导航、不崩（Ctrl+F12 不许掀桌子，与 F12 同款隔离）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const navigate = vi.fn();
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, handlersOf(() => {
      throw new Error('boom');
    }, { navigate }));
    expect(() => registered[0]!.provider.provideImplementation(stubModel(), POS, TOKEN)).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('G3：取数只走 `resolveImplementation`——`resolve`（definition 腿）一次都不许被叫', () => {
    const calls: string[] = [];
    const targetModel = stubModel({ lineContent: '@FOO_BAR', uri: 'file:///a.ERB' });
    const { monaco, registered } = stubMonaco();
    installImplementationProvider(monaco, {
      resolve: () => {
        calls.push('definition');
        return [];
      },
      resolveImplementation: () => {
        calls.push('implementation');
        return [{ filePath: 'C:/p/a.ERB', line: 1 }];
      },
      navigate: () => undefined,
      openModelFor: () => targetModel,
    });
    const links = registered[0]!.provider.provideImplementation(stubModel(), POS, TOKEN);
    expect(Array.isArray(links)).toBe(true);
    expect(calls).toEqual(['implementation']);
  });
});
