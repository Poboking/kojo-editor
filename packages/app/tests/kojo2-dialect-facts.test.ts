/**
 * 方言事实面接线的闸（LAU-D2 任务 A）：**同一份文本，两个方言必须给出不同的事实**。
 *
 * 钉四件事：
 * 1. **悬停**（本批补的缺口）：`# 机` / `@织` 的事件名此前没有任何方言来源——两枚 adapter
 *    喂同一份 `# 机 训练`，eraTW 讲得出 `EVENTTRAIN`，eraFL 只能说"目录里没有"；
 * 2. **补全**：候选名单来自当前 adapter 的 `eventCatalog`（eraTW 9 条 / eraFL 4 条）；
 *    没注入 adapter ⇒ `# 机` 零候选（不猜内置事件）；
 * 3. **provider 层真的把 adapter 送进去了**（不是只有纯函数能吃到）；
 * 4. **未绑定不猜**（§9-9）：adapter 取不到时事件名不给悬停、补全零事件候选。
 *
 * B3c 车道 2（2026-10-28）：判据搬进 `@kojo/kojo-lang` 后本闸**留在 app 侧**（它证的是
 * "方言事实真的进了供方"），补全 / 悬停 / Markdown 措辞三处 import 改成包面叶子；车道 5 把
 * 最后一处"宿主翻译腿"换成**插件供方**（`provideHover`）——事实与条数一条未改。
 */
import { describe, expect, it } from 'vitest';
import { eventNames } from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter';
import { provideHover } from '@kojo/plugin-kojo-lang';
import { kojo2CompletionAt, type Kojo2CompletionCandidate } from '@kojo/kojo-lang/completion';
import { kojo2HoverAt, kojo2HoverMarkdown } from '@kojo/kojo-lang/hover';

/** `# 机 训练` 的 `训练` 在第 1 行第 5 列（行尾再停一格也算在名字上） */
const AT_EVENT_NAME = { line: 1, column: 5 };
const MACHINE_LINE = '# 机 训练\n\n> 正文。\n';

const labelsOf = (candidates: readonly Kojo2CompletionCandidate[]): string[] =>
  candidates.map((candidate) => candidate.label);

describe('悬停 · 事件名讲的是方言事实', () => {
  it('同一份 `# 机 训练`：eraTW 讲 EVENTTRAIN，eraFL 说目录里没有（逐条不同）', () => {
    const eratw = kojo2HoverAt({ source: MACHINE_LINE, ...AT_EVENT_NAME }, { adapter: ERATW_GAME_ADAPTER });
    const erafl = kojo2HoverAt({ source: MACHINE_LINE, ...AT_EVENT_NAME }, { adapter: ERAFL_GAME_ADAPTER });
    expect(eratw).toBeDefined();
    expect(erafl).toBeDefined();
    const eratwText = eratw!.lines.join('\n');
    const eraflText = erafl!.lines.join('\n');
    expect(eratwText).toContain('EVENTTRAIN');
    expect(eratwText).toContain('引擎分发');
    expect(eraflText).toContain('没有“训练”');
    expect(eraflText).toContain('初见');
    expect(eratwText).not.toBe(eraflText);
    // 区间 = 事件名那一段（悬停范围落在名字上，不糊整行）
    expect(eratw!.startColumn).toBe(5);
    expect(eratw!.endColumn).toBe(7);
  });

  it('`@织` 监听位：eraTW 的 `训练` 讲引擎落点，eraFL 说没有这个事件', () => {
    const source = '@织 训练 之后\n\n> 监听体。\n';
    const at = { line: 1, column: 4 };
    const eratw = kojo2HoverAt({ source, ...at }, { adapter: ERATW_GAME_ADAPTER });
    const erafl = kojo2HoverAt({ source, ...at }, { adapter: ERAFL_GAME_ADAPTER });
    expect(eratw?.lines.join('\n')).toContain('监听这个事件');
    expect(erafl?.lines.join('\n')).toContain('没有“训练”');
  });

  it('没有 adapter（未绑定）⇒ 事件名不给悬停（不猜任何内置事件）', () => {
    expect(kojo2HoverAt({ source: MACHINE_LINE, ...AT_EVENT_NAME })).toBeUndefined();
    expect(
      kojo2HoverAt({ source: MACHINE_LINE, ...AT_EVENT_NAME }, { adapter: null }),
    ).toBeUndefined();
  });

  it('事件之外的事实不因 adapter 变：同一份声明悬停逐字相同', () => {
    const source = '# 机 初见\n# 设 好感 整数[3]\n\n> 正文。\n';
    const at = { line: 2, column: 6 };
    const eratw = kojo2HoverAt({ source, ...at }, { adapter: ERATW_GAME_ADAPTER });
    const erafl = kojo2HoverAt({ source, ...at }, { adapter: ERAFL_GAME_ADAPTER });
    expect(eratw).toEqual(erafl);
  });
});

describe('provider 层 · adapter 真的被送进悬停', () => {
  /** 宿主/插件共用的请求形状（`languageId` 与 `path` 两格是"认不认这篇"的判据） */
  function hoverRequestAt(line: number, column: number) {
    return {
      kind: 'hover' as const,
      path: 'D:/proj/口上/12/场景.kojo2',
      text: MACHINE_LINE,
      line,
      column,
      project: null,
      languageId: 'kojo2',
    };
  }

  it('插件供方带 adapter 时事件名有话可说，不带时保持弃权', () => {
    const withFacts = provideHover(hoverRequestAt(1, 5), { adapter: ERATW_GAME_ADAPTER });
    expect(withFacts).toBeDefined();
    expect(withFacts!.contents).toContain('EVENTTRAIN');
    // B3c 契约新格：正文是 Markdown（措辞在包，供方只声明渲染口径）
    expect(withFacts!.format).toBe('markdown');
    expect(provideHover(hoverRequestAt(1, 5))).toBeUndefined();
  });

  it('悬停正文走同一个 Markdown 口径（`**名字**（种类）`）', () => {
    const hover = kojo2HoverAt({ source: MACHINE_LINE, ...AT_EVENT_NAME }, { adapter: ERATW_GAME_ADAPTER })!;
    expect(kojo2HoverMarkdown(hover).startsWith('**训练**（事件）')).toBe(true);
  });
});

describe('补全 · 事件候选来自当前 adapter', () => {
  const queryAt = (text: string) => {
    const at = text.indexOf('|');
    const source = text.slice(0, at) + text.slice(at + 1);
    return { source, line: 1, column: at + 1 };
  };

  it('同一份 `# 机 `：eraTW 9 条、eraFL 4 条，逐条不同', () => {
    const query = queryAt('# 机 |\n');
    const eratw = labelsOf(kojo2CompletionAt(query, { adapter: ERATW_GAME_ADAPTER }));
    const erafl = labelsOf(kojo2CompletionAt(query, { adapter: ERAFL_GAME_ADAPTER }));
    expect(eratw).toEqual([...eventNames(ERATW_GAME_ADAPTER)]);
    expect(erafl).toEqual([...eventNames(ERAFL_GAME_ADAPTER)]);
    expect(eratw).not.toEqual(erafl);
    expect(eratw).toContain('训练');
    expect(erafl).not.toContain('训练');
  });

  it('没有 adapter ⇒ `# 机` 零事件候选（不猜内置事件）', () => {
    expect(kojo2CompletionAt(queryAt('# 机 |\n'), {})).toEqual([]);
  });
});
