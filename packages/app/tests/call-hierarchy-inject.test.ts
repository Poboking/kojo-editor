/**
 * 调用层级面板的 resolver 注入闭环（批次十一 CALLHIER-INJECT，2026-10-23）。
 *
 * 批次十把面板的语言分派做完了，但 kojo2 的跨文件 resolver（项目索引交出的
 * `createKojo2ProjectCallHierarchyResolvers`）**从未接进面板**：`kojo2Provider` 缺席时
 * `resolveKojo2CallHierarchy` 退回默认腿，只算同文件 ⇒ 跨文件入 / 出边永远是"假空"。
 *
 * 本套件钉三条：
 * ① resolver 就绪 ⇒ 打开面板（同步首帧）就有跨文件入边，且同文件调用者不因索引重扫而重复；
 * ② resolver 未就绪 ⇒ 显示明确的加载态，不画"没有调用"的空清单（铁律 4 不静默）；
 * ③ 索引更新后再次打开 ⇒ 新文件里的调用者立刻可见（resolver 读实时索引，不做快照）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Monaco from '../src/monaco/entry';
import * as kojo2Module from '../src/monaco/kojo2-callhierarchy';
import type { Kojo2CallHierarchyResolvers } from '../src/monaco/kojo2-callhierarchy';
import {
  createKojo2ProjectCallHierarchyResolvers,
  createKojo2ProjectIndex,
  type Kojo2ProjectIndex,
} from '../src/monaco/kojo2-project-index';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-constants';
import { setCallHierarchyState } from '../src/ui/call-hierarchy';
import { createCallHierarchyOverlay, type CallHierarchyDeps } from '../src/ui/CallHierarchyOverlay';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'kojo2', 'callhierarchy.kojo2'),
  'utf8',
);
/** 请求文件（面板的 model 就是它；索引里也喂同一路径） */
const MAIN_PATH = 'C:\\game\\KOJO\\callhierarchy.kojo2';
/** 另一个文件：路径写成分隔符 / 大小写不同的一种写法（索引的 `pkey` 要认出是"同一格"） */
const OTHER_PATH = 'C:/game/KOJO/other.kojo2';
const OTHER_TEXT = ['@函 别处调用者(n)', '    ! 阶乘(n)', '    @返 0'].join('\n');

/* ============================== 桩 ============================== */

/** 桩 model：面板只读 `getValue` / `getLanguageId` / `isDisposed` 三处 */
function fakeModel(text: string): Monaco.editor.ITextModel {
  return {
    getValue: () => text,
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    isDisposed: () => false,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
}

/** 主文件 + 另一个文件的索引（resolver 读它，索引的条目随 `updateFile` 实时变化） */
function buildIndex(): Kojo2ProjectIndex {
  const index = createKojo2ProjectIndex();
  index.updateFile({ path: MAIN_PATH, text: FIXTURE });
  index.updateFile({ path: OTHER_PATH, text: OTHER_TEXT });
  return index;
}

interface Rendered {
  readonly html: string;
}

function render(
  request: { filePath: string; line: number; column?: number },
  options: {
    readonly model: Monaco.editor.ITextModel;
    /** 注入 resolver；返回 `null` = 模拟"还没就绪"（与生产懒装载窗同形状） */
    readonly resolvers?: () => Kojo2CallHierarchyResolvers | null;
    /** 取数模块：默认给真模块（同步渲染）；`'loading'` 模拟模块还在拉 */
    readonly panel?: 'ready' | 'loading';
  },
): Rendered {
  setCallHierarchyState({ kind: 'request', request });
  const deps: CallHierarchyDeps = {
    currentIndex: () => null,
    functionAt: () => null,
    modelFor: () => options.model,
    kojo2Panel: () => (options.panel === 'loading' ? null : kojo2Module),
    ...(options.resolvers !== undefined ? { kojo2Resolvers: options.resolvers } : {}),
    reveal: () => undefined,
    close: () => undefined,
  };
  const Overlay = createCallHierarchyOverlay(deps) as () => ReactElement;
  return { html: renderToStaticMarkup(createElement(Overlay)) };
}

/** 某个子串在 HTML 里出现几次（重复组会把它变成 2） */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

afterEach(() => {
  setCallHierarchyState(null);
});

/* ============================== ① 就绪即用 ============================== */

describe('resolver 就绪：首帧同步拿到跨文件入边', () => {
  it('光标在 `阶乘` 体内 ⇒ 另一个文件里的调用者直接出现在入边（不需要 await）', () => {
    const index = buildIndex();
    const { html } = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), resolvers: () => createKojo2ProjectCallHierarchyResolvers(index) },
    );
    // 跨文件组行（声明头）与点位行（调用处）
    expect(html).toContain('别处调用者');
    expect(html).toContain('other.kojo2:2:7');
    // 不是"只同文件"的默认腿：跨文件组确实进了清单
    expect(html).not.toContain('项目索引里也没有这些名字的落点');
  });

  it('索引里的当前文件不会被重扫一遍（同一点位只出现一次，不产重复组）', () => {
    const index = buildIndex();
    const { html } = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), resolvers: () => createKojo2ProjectCallHierarchyResolvers(index) },
    );
    // `问候` 在 28 行调 `阶乘`：同文件边只该有一行点位（`↳` 前缀是点位行本身，
    // 不含按钮 title 里的整条路径）
    expect(occurrences(html, '↳ callhierarchy.kojo2:28:7')).toBe(1);
  });
});

/* ============================== ② 未就绪 ============================== */

describe('resolver 未就绪：可见加载态，不画空清单', () => {
  it('取数模块已就位、resolver 还没回来 ⇒ 明说"正在载入项目索引"', () => {
    const { html } = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), resolvers: () => null },
    );
    expect(html).toContain('正在载入项目索引（跨文件入 / 出边），就绪后自动刷新');
    // 铁律 4：不许先把"只同文件"的结果画出来冒充"没有调用"
    expect(html).not.toContain('个调用者');
    expect(html).not.toContain('个目标');
  });

  it('取数模块还在拉 ⇒ 仍是既有那句模块级加载态（两条腿各有自己的文案）', () => {
    const { html } = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), panel: 'loading' },
    );
    expect(html).toContain('正在载入 kojo2 调用层级');
  });
});

/* ============================== ③ 索引更新 → 再次打开 ============================== */

describe('索引更新后再次打开：resolver 读实时索引', () => {
  it('新文件喂进索引后，第二次打开能看到新的跨文件调用者', () => {
    const index = buildIndex();
    const resolvers = (): Kojo2CallHierarchyResolvers =>
      createKojo2ProjectCallHierarchyResolvers(index);

    const first = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), resolvers },
    );
    expect(first.html).not.toContain('新来的');

    // 保存 / 扫描把新文件喂进同一份索引（宿主走的就是 `updateFile`）
    index.updateFile({
      path: 'C:/game/KOJO/late.kojo2',
      text: ['@函 新来的()', '    ! 阶乘(1)'].join('\n'),
    });

    const second = render(
      { filePath: MAIN_PATH, line: 6 },
      { model: fakeModel(FIXTURE), resolvers },
    );
    expect(second.html).toContain('新来的');
    expect(second.html).toContain('late.kojo2:2:7');
  });
});
