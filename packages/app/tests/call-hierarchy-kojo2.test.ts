/**
 * 调用层级面板的**语言分派**（批次十 S3，2026-10-23）。
 *
 * 三条腿（形态照 `erb-call-hierarchy.test.ts` + `kojo2-callhierarchy.test.ts`）：
 * 1. 分派：`modelFor(请求文件).getLanguageId()` 是唯一判据——kojo2 走
 *    `createKojo2CallHierarchyProvider()`，其余（ERB / 无 model）逐字走既有 ERB 分支；
 * 2. 两语言的出入边：kojo2 用纯模型夹具（`fixtures/kojo2/callhierarchy.kojo2`）驱动、
 *    ERB 用假索引驱动，都要求面板把目标 / 入边组 / 点位 / 出边画出来；
 * 3. 空态与错误态可见（铁律「不静默」）：不在可调用声明里 / 调用本地无落点 / 读不到源文，
 *    外加跨文件 `data.path` 键要落到组行与点位行的跳转目标上。
 */

import { functionLookupOf } from '@kojo/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Monaco from '../src/monaco/entry';
import type {
  EditorLanguageServiceContribution,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbReference,
} from '@kojo/plugin-api';
import { provideErbCallHierarchy } from '@kojo/plugin-erb-parser';
import * as kojo2Module from '@kojo/kojo-lang/call-hierarchy';
import {
  createKojo2CallHierarchyProvider,
  resolveKojo2CallHierarchy,
  type Kojo2CallHierarchyItem,
  type Kojo2CallHierarchyProvider,
} from '@kojo/kojo-lang/call-hierarchy';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';
import {
  loadKojo2CallHierarchyPanel,
  setCallHierarchyState,
} from '../src/ui/call-hierarchy';
import { createCallHierarchyOverlay, type CallHierarchyDeps } from '../src/ui/CallHierarchyOverlay';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'kojo2', 'callhierarchy.kojo2'),
  'utf8',
);
const KOJO2_PATH = 'C:\\game\\KOJO\\callhierarchy.kojo2';
const ERB_PATH = 'C:\\game\\ERB\\A.ERB';
const ERB_LANGUAGE_ID = 'kojo-erb';

/* ============================== 桩：model / ERB 假索引 ============================== */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakModel: () => void;
}

/** 桩 model：面板只读 `getValue` / `getLanguageId` / `isDisposed` 三处 */
function fakeModel(text: string, languageId: string): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    isDisposed: () => broken,
    getLanguageId: () => languageId,
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakModel: () => void (broken = true) };
}

function fn(name: string, startLine: number, endLine: number): ErbFunction {
  return { name, normalizedName: name.toUpperCase(), params: [], startLine, endLine, filePath: ERB_PATH };
}

function fnRef(name: string, startLine: number, endLine: number): ErbFunctionRef {
  return { name, normalizedName: name.toUpperCase(), filePath: ERB_PATH, startLine, endLine };
}

function ref(kind: ErbReference['kind'], line: number, column: number): ErbReference {
  return { filePath: ERB_PATH, line, column, endColumn: column + 5, kind };
}

function erbFile(functions: ErbFunction[]): ErbFile {
  return { path: ERB_PATH, functions, dims: [], hasFunctionDirective: false, lineCount: 200 };
}

/** 最小可用 ERB 索引：TARGET（入边 CALLER1 / 出边 CALLEE） */
function erbIndex(): ErbIndex {
  const fileB = 'C:\\game\\ERB\\B.ERB';
  return {
    files: new Map([
      [ERB_PATH, erbFile([fn('TARGET', 10, 20), fn('CALLER1', 30, 40)])],
      [
        fileB,
        {
          path: fileB,
          functions: [{ ...fn('CALLEE', 1, 9), filePath: fileB }],
          dims: [],
          hasFunctionDirective: false,
          lineCount: 50,
        },
      ],
    ]),
    byName: functionLookupOf(new Map([
      ['TARGET', [fnRef('TARGET', 10, 20)]],
      ['CALLER1', [fnRef('CALLER1', 30, 40)]],
      ['CALLEE', [{ ...fnRef('CALLEE', 1, 9), filePath: fileB }]],
    ])),
    references: {
      bySymbol: new Map([
        ['TARGET', [ref('definition', 10, 2), ref('call', 31, 3)]],
        ['CALLEE', [ref('call', 12, 1)]],
      ]),
    },
  } as ErbIndex;
}

/* ============================== 渲染脚手架 ============================== */

interface Rendered {
  readonly html: string;
  readonly reveals: Array<readonly [string, number, number | undefined]>;
  readonly modelRequests: string[];
}

function render(
  request: { filePath: string; line: number; column?: number },
  options: {
    model?: Monaco.editor.ITextModel | null;
    index?: ErbIndex | null;
    provider?: Kojo2CallHierarchyProvider;
    /** `'loading'` = 模拟首帧（动态边还没回来）；默认注入真模块走同步渲染 */
    panel?: 'loading';
  } = {},
): Rendered {
  setCallHierarchyState({ kind: 'request', request });
  const reveals: Array<readonly [string, number, number | undefined]> = [];
  const modelRequests: string[] = [];
  // ERB 腿走**真供方**（判据已搬进 `@kojo/plugin-erb-parser`）：假索引接上插件供方，
  // 于是"面板画出来的"就是"插件答出来的"（不另造判据、不喂罐头）。
  const erbContribution: EditorLanguageServiceContribution = {
    id: 'erb-call-hierarchy',
    provide: (request) => provideErbCallHierarchy(request, options.index ?? null),
  };
  const deps: CallHierarchyDeps = {
    // ERB 腿故意给 null：kojo2 分支若去读索引就是分派没兜住（本套件按渲染结果钉住）
    currentIndex: () => options.index ?? null,
    contributions: () => [erbContribution],
    modelFor: (p) => {
      modelRequests.push(p);
      return options.model ?? null;
    },
    kojo2Panel: () => (options.panel === 'loading' ? null : kojo2Module),
    ...(options.provider !== undefined ? { kojo2Provider: () => options.provider! } : {}),
    reveal: (p, line, column) => void reveals.push([p, line, column]),
    close: () => undefined,
  };
  const Overlay = createCallHierarchyOverlay(deps) as () => ReactElement;
  return { html: renderToStaticMarkup(createElement(Overlay)), reveals, modelRequests };
}

afterEach(() => {
  setCallHierarchyState(null);
});

/* ============================== ① 语言分派 ============================== */

describe('语言分派：按当前 model 的 languageId 选取数依赖', () => {
  it('kojo2 model ⇒ 走 provider（ERB 索引缺席也照样出结果）', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html, modelRequests } = render({ filePath: KOJO2_PATH, line: 15 }, { model, index: null });
    expect(modelRequests).toEqual([KOJO2_PATH]);
    expect(html).toContain('调用层级');
    expect(html).toContain('入口');
    // 分派到 kojo2 就不会出现 ERB 的索引空态
    expect(html).not.toContain('ERB 函数索引未建');
    expect(html).not.toContain('ERB 函数');
  });

  it('ERB model ⇒ 仍走既有 ERB 分支（索引缺席时那句原样可见）', () => {
    const { model } = fakeModel('@FUNCTION TARGET\n@END\n', ERB_LANGUAGE_ID);
    const { html, modelRequests } = render({ filePath: ERB_PATH, line: 15 }, { model, index: null });
    expect(modelRequests).toEqual([ERB_PATH]);
    expect(html).toContain('ERB 函数索引未建');
    expect(html).not.toContain('当前文件里没有别的 @函');
  });

  it('无 model（文件已关 / 旧宿主）⇒ 退回 ERB 分支，不吃掉请求', () => {
    const { html } = render({ filePath: KOJO2_PATH, line: 15 }, { model: null, index: null });
    expect(html).toContain('ERB 函数索引未建');
  });

  it('kojo2 首帧（动态边未回）⇒ 可见"正在载入"，不画空列表', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 15 }, { model, panel: 'loading' });
    expect(html).toContain('正在载入 kojo2 调用层级');
  });
});

/* ============================== ② kojo2 出入边 ============================== */

describe('kojo2 出入边：入边按调用者分组、出边按被调声明排序', () => {
  it('光标在 `入口` 体内 ⇒ 目标是 `入口`，入边 = 问候、出边 = 阶乘 + 甲', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 16 }, { model });
    // 目标 + 声明的面板头（组行点它是跳声明）
    expect(html).toContain('入口');
    expect(html).toContain('callhierarchy.kojo2:14');
    // 入边：问候（模）在 28 行调入口？夹具里 `! 入口(1)` 在第 29 行
    expect(html).toContain('1 个调用者 · 1 处');
    expect(html).toContain('问候');
    expect(html).toContain('callhierarchy.kojo2:29:7');
    // 出边：阶乘 + 甲（20 行之外的外部函数不进边）
    expect(html).toContain('2 个目标 · 2 处');
    expect(html).toContain('阶乘');
    expect(html).toContain('甲');
    expect(html).not.toContain('外部函数');
  });

  it('光标在 `阶乘` 体内 ⇒ 自递归入边 + 三条他人入边、出边只有自己', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 6 }, { model });
    expect(html).toContain('4 个调用者 · 4 处');
    expect(html).toContain('插值陷阱');
    expect(html).toContain('1 个目标 · 1 处');
    // 精确名字段（`! 阶乘(n)` = 15 行第 7 列）
    expect(html).toContain('callhierarchy.kojo2:15:7');
  });

  it('`# 模` 也是节点：问候的出边 = 阶乘 + 入口', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 27 }, { model });
    expect(html).toContain('问候');
    expect(html).toContain('2 个目标 · 2 处');
    expect(html).toContain('阶乘');
    expect(html).toContain('入口');
  });
});

/* ============================== ③ ERB 出入边（分派不能伤旧语言） ============================== */

describe('ERB 分支：出入边与旧行为逐字一致', () => {
  it('目标 / 入边组 / 点位 / 出边照旧（model 在场也不改变判据）', () => {
    const { model } = fakeModel('@FUNCTION TARGET\n@END\n', ERB_LANGUAGE_ID);
    const { html } = render(
      { filePath: ERB_PATH, line: 15 },
      { model, index: erbIndex() },
    );
    expect(html).toContain('TARGET');
    expect(html).toContain('1 个调用者 · 处数未读');
    expect(html).toContain('CALLER1');
    expect(html).toContain('A.ERB:31:3');
    expect(html).toContain('1 个目标 · 1 处');
    expect(html).toContain('CALLEE');
    expect(html).toContain('A.ERB:12:1');
  });
});

/* ============================== ④ 空态 / 错误态可见 ============================== */

describe('空态与错误态：每一条都有自己的可见句', () => {
  it('不在任何 `@函` / `# 模` 正文里 ⇒ 明说行号', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 1 }, { model });
    expect(html).toContain('第 1 行不在任何 @函 / # 模 的正文里');
  });

  it('是一次调用但本文件没有同名声明 ⇒ 显式空（不说"没有调用关系"）', () => {
    const source = ['# 幕 场景', '    ! 外部函数(1)'].join('\n');
    const { model } = fakeModel(source, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 2, column: 7 }, { model });
    expect(html).toContain('本文件里没有同名声明');
  });

  it('模型已释放 / 读不到源文 ⇒ 可见错误，不画空列表', () => {
    const broken = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    broken.breakModel();
    const { html } = render({ filePath: KOJO2_PATH, line: 15 }, { model: broken.model });
    expect(html).toContain('读不到当前文件的内容');
  });

  it('provider 的入边 / 出边交回 null（item 认不出）⇒ 可见"声明已不在模型里"', () => {
    const real = createKojo2CallHierarchyProvider();
    const stale: Kojo2CallHierarchyProvider = {
      displayName: 'kojo2-stale',
      prepareCallHierarchy: (model, position) => real.prepareCallHierarchy(model, position),
      provideCallHierarchyIncomingCalls: () => null,
      provideCallHierarchyOutgoingCalls: () => null,
    };
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render({ filePath: KOJO2_PATH, line: 15 }, { model, provider: stale });
    expect(html).toContain('这枚声明已经不在当前模型里');
  });
});

/* ============================== ⑤ 跨文件 data.path ============================== */

describe('跨文件 `data.path` 键：组行与点位行的跳转目标取 item 自带的文件', () => {
  const OTHER = 'C:\\game\\KOJO\\other.kojo2';

  function crossFileProvider(): Kojo2CallHierarchyProvider {
    const item: Kojo2CallHierarchyItem = {
      name: '入口',
      kind: 'function',
      range: { startLine: 14, startColumn: 1, endLine: 18, endColumn: 9 },
      selectionRange: { startLine: 14, startColumn: 4, endLine: 14, endColumn: 6 },
      data: {
        name: '入口',
        declarationKind: 'function',
        line: 14,
        nameStart: 4,
        nameEnd: 6,
        path: OTHER,
      },
    };
    const caller: Kojo2CallHierarchyItem = {
      ...item,
      name: '别处模',
      data: { ...item.data, name: '别处模', declarationKind: 'template', line: 3, path: OTHER },
    };
    return {
      displayName: 'kojo2-xfile',
      prepareCallHierarchy: () => [item],
      provideCallHierarchyIncomingCalls: () => [
        {
          from: caller,
          fromRanges: [{ startLine: 5, startColumn: 7, endLine: 5, endColumn: 9 }],
        },
      ],
      provideCallHierarchyOutgoingCalls: () => [],
    };
  }

  it('组行标题与点位行都落在 `data.path`，不是请求文件', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const { html } = render(
      { filePath: KOJO2_PATH, line: 15 },
      { model, provider: crossFileProvider() },
    );
    expect(html).toContain('other.kojo2:3');
    expect(html).toContain('other.kojo2:5:7');
    expect(html).not.toContain('callhierarchy.kojo2:3');
    // 出边为空时也有自己的那句（不静默）
    expect(html).toContain('函数体内没有落到本文件的调用');
  });
});

/* ============================== ⑥ 取数层直测 ============================== */

describe('resolveKojo2CallHierarchy：位点 → 声明 → 出入边', () => {
  it('光标行落在函数体内 ⇒ 取最内层可调用声明（与 ERB「当前函数」同义）', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const resolution = resolveKojo2CallHierarchy(
      model,
      { line: 17, path: KOJO2_PATH },
      createKojo2CallHierarchyProvider(),
    );
    expect(resolution.kind).toBe('ready');
    if (resolution.kind !== 'ready') return;
    expect(resolution.view.target).toEqual({ name: '入口', path: KOJO2_PATH, line: 14 });
  });

  it('跨文件键缺席 ⇒ 组与点位落到请求文件（同文件边）', () => {
    const { model } = fakeModel(FIXTURE, KOJO2_LANGUAGE_ID);
    const resolution = resolveKojo2CallHierarchy(
      model,
      { line: 6, path: KOJO2_PATH },
      createKojo2CallHierarchyProvider(),
    );
    if (resolution.kind !== 'ready') throw new Error(`期望 ready，实得 ${resolution.kind}`);
    expect(resolution.view.incoming.map((g) => g.path)).toEqual([
      KOJO2_PATH,
      KOJO2_PATH,
      KOJO2_PATH,
      KOJO2_PATH,
    ]);
    expect(resolution.view.outgoing[0]?.sites).toEqual([
      { filePath: KOJO2_PATH, line: 6, column: 12 },
    ]);
  });

  it('默认腿 = 懒装载：动态边拿到的模块同时给出 provider 与取数函数', async () => {
    const api = await loadKojo2CallHierarchyPanel();
    expect(typeof api.createKojo2CallHierarchyProvider).toBe('function');
    expect(typeof api.resolveKojo2CallHierarchy).toBe('function');
    // 懒装载的模块就是面板注入的那一份（同一条动态边，不另开第二份）
    expect(api).toBe(kojo2Module);
  });
});
