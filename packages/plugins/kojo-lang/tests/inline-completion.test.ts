/**
 * LAU-KOJO2-INLINE（2026-10-31）· 槽 `completion.source` 的 2.0 供方行为闸。
 *
 * 钉三件事：
 * 1. **三态**：非 kojo2 弃权（`undefined`）／坐标映不回出声失败／看过并确认没有答
 *    `no-completion`——"不答"与"答没有"是两件事，前者让下一家接手，后者是记账（铁律 4）；
 * 2. **窗口对账**：`contextBefore` / `contextAfter` 折回 `{ source, line, column }` 的
 * 行号平移、`wholeDocument` 的等式判据（切片的窗口不许拿"窗内唯一"当唯一）；
 * 3. **候选形状**：`version` 逐字回带、区间用**绝对行号** + 包内列、`sourceId` 是本家 id、
 *    `kind` / `note` 走弹窗那一族的同一张映射表。
 *
 * 位置判据本身**不在这里测**（那是 `packages/kojo-lang/tests/completion-inline.test.ts`
 * 的活）——本层是翻译层，测的是翻译与三态，不测尺子。
 */
import { describe, expect, it } from 'vitest';
import type { InlineCompletionRequest } from '@kojo/plugin-api';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import {
  KOJO2_INLINE_ORDER,
  KOJO2_INLINE_SOURCE_ID,
  KOJO2_INLINE_TITLE,
  createKojo2InlineContribution,
  isKojo2InlineRequest,
  kojo2InlineCompletion,
  kojo2InlineQueryOf,
} from '../src/inline-completion';

/** 一份 2.0 源文 + 光标标记 ⇒ 一次幽灵文本请求（缺省 = 整篇都在窗口里） */
function requestOf(
  marked: string,
  over: Partial<InlineCompletionRequest> = {},
): InlineCompletionRequest {
  const at = marked.indexOf('|');
  if (at < 0) throw new Error('夹具里没有光标标记');
  const source = marked.slice(0, at) + marked.slice(at + 1);
  const before = source.slice(0, at);
  const line = before.split('\n').length;
  const column = at - before.lastIndexOf('\n');
  const lines = source.split('\n');
  const current = lines[line - 1] ?? '';
  return {
    path: 'C:/corpus/kojo2/0001.kojo',
    languageId: 'kojo2',
    version: 7,
    line,
    column,
    lineText: current,
    prefix: current.slice(0, column - 1),
    suffix: current.slice(column - 1),
    contextBefore: lines.slice(0, line - 1).concat(current.slice(0, column - 1)).join('\n'),
    contextAfter: [current.slice(column - 1), ...lines.slice(line)].join('\n'),
    project: null,
    lineCount: lines.length,
    triggerKind: 'auto',
    timeoutMs: 1500,
    ...over,
  };
}

/** 没有 adapter 事实的一套依赖（方言四路零候选，其余照给） */
const NO_ADAPTER = { adapterFor: () => null } as const;

describe('语言门（三态的第一态）', () => {
  it.each(['erb', 'kojo', 'plaintext', 'json'])('%s ⇒ undefined 弃权，不替下一家答"没有"', (languageId) => {
    const request = requestOf('# 视|', { languageId });
    expect(isKojo2InlineRequest(request)).toBe(false);
    expect(kojo2InlineCompletion(request, NO_ADAPTER)).toBeUndefined();
  });

  it('kojo2 才认（大小写敏感：宿主交回的是 model 归一后的小写 id）', () => {
    expect(isKojo2InlineRequest({ languageId: 'kojo2' })).toBe(true);
    expect(isKojo2InlineRequest({ languageId: 'KOJO2' })).toBe(false);
  });
});

describe('窗口对账（kojo2InlineQueryOf）', () => {
  it('整篇在窗口里 ⇒ line 平移到窗口坐标、column 原样、wholeDocument 为真', () => {
    const request = requestOf('# 幕 开场\n# 视|');
    const query = kojo2InlineQueryOf(request);
    expect(query).not.toBeNull();
    expect(query?.line).toBe(2);
    expect(query?.column).toBe(4);
    expect(query?.wholeDocument).toBe(true);
    expect(query?.source).toBe('# 幕 开场\n# 视');
  });

  it('窗口是切片（首行不是第 1 行）⇒ wholeDocument 为假，行号仍对得上', () => {
    const full = '# 池 甲雨\n# 池 甲雪\n! 甲|';
    const request = requestOf(full);
    const sliced: InlineCompletionRequest = {
      ...request,
      // 宿主把最上面一行裁掉了：窗口只剩后两行
      contextBefore: '# 池 甲雪\n! 甲',
      contextAfter: '',
      lineCount: request.lineCount,
    };
    const query = kojo2InlineQueryOf(sliced);
    expect(query?.line).toBe(2);
    expect(query?.column).toBe(4);
    expect(query?.wholeDocument).toBe(false);
  });

  it('窗口行数比光标行号还多（坐标映不回去）⇒ null', () => {
    const request = requestOf('# 视|', { line: 1, contextBefore: '甲\n乙\n丙\n# 视' });
    expect(kojo2InlineQueryOf(request)).toBeNull();
  });

  it('没有 lineCount（旧宿主）⇒ 按"不是整篇"处理（保守方向：宁可少给）', () => {
    const request = requestOf('# 视|', { lineCount: undefined });
    expect(kojo2InlineQueryOf(request)?.wholeDocument).toBe(false);
  });
});

describe('候选形状与抑制面（翻译层）', () => {
  it('唯一命中 ⇒ candidates 一条：version 逐字回带、区间用绝对行号、sourceId 是本家', () => {
    const request = requestOf('# 幕 开场\n# 视|', { version: 41 });
    const outcome = kojo2InlineCompletion(request, NO_ADAPTER);
    expect(outcome?.state).toBe('candidates');
    if (outcome?.state !== 'candidates') return;
    expect(outcome.version).toBe(41);
    expect(outcome.partial).toBeUndefined();
    expect(outcome.candidates).toHaveLength(1);
    const [candidate] = outcome.candidates;
    expect(candidate?.sourceId).toBe(KOJO2_INLINE_SOURCE_ID);
    expect(candidate?.insertText).toBe('视角');
    expect(candidate?.kind).toBe('keyword');
    expect(candidate?.range).toEqual({ startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 });
  });

  it.each([
    ['名录多条（`# |`）', '# |'],
    ['空行行首的五锚点', '|'],
    ['旁白正文', '> 今天天气不|'],
    ['注释行', '// 这里想说|'],
    ['串内', '? 心意 == "很|'],
    ['@原生 围栏体内', '@原生\n    CALL HPH_PRINT "w|'],
    ['名字已写完', '# 视角|'],
  ])('%s ⇒ no-completion（看过，这一格没有可证明的唯一答案）', (_label, marked) => {
    const outcome = kojo2InlineCompletion(requestOf(marked), NO_ADAPTER);
    expect(outcome).toEqual({ state: 'no-completion' });
  });

  it('切片的窗口里"只剩一条声明"⇒ 假唯一 ⇒ 仍答 no-completion（错报比漏报贵）', () => {
    const request = requestOf('# 池 甲雨\n# 池 甲雪\n! 甲|');
    const sliced: InlineCompletionRequest = {
      ...request,
      contextBefore: '# 池 甲雪\n! 甲',
      contextAfter: '',
    };
    // 同一份文、同一格：整篇在窗口里也不唯一（两条），切片时**也不许**冒出唯一候选
    expect(kojo2InlineCompletion(request, NO_ADAPTER)).toEqual({ state: 'no-completion' });
    expect(kojo2InlineCompletion(sliced, NO_ADAPTER)).toEqual({ state: 'no-completion' });
  });

  it('坐标映不回去 ⇒ failed（locate 段，三段话一次给全；不静默当"没有"）', () => {
    const request = requestOf('# 视|', { line: 1, contextBefore: '甲\n乙\n# 视' });
    const outcome = kojo2InlineCompletion(request, NO_ADAPTER);
    expect(outcome?.state).toBe('failed');
    if (outcome?.state !== 'failed') return;
    expect(outcome.stage).toBe('locate');
    expect(outcome.reason).toBe('window-lines-exceed-cursor-line');
    expect(outcome.note.trim().length).toBeGreaterThan(8);
  });
});

describe('adapter 事实（只认 id 对得上的那一枚）', () => {
  it('事件位没有 adapter ⇒ 零候选 ⇒ no-completion（不猜内置事件）', () => {
    expect(kojo2InlineCompletion(requestOf('# 机 |'), NO_ADAPTER)).toEqual({
      state: 'no-completion',
    });
  });

  it('注入 eraTW 目录后按已打字面裁：目录里唯一以该前缀开头的事件才上屏', () => {
    const events = ERATW_GAME_ADAPTER.eventCatalog.events.map((spec) => spec.event);
    // 找一枚"前缀只命中一条"的事件：拿它的首字，若首字命中多条则退到前两字
    let marked = '';
    for (const event of events) {
      for (let take = 1; take <= event.length; take++) {
        const prefix = event.slice(0, take);
        if (events.filter((name) => name.startsWith(prefix)).length === 1) {
          marked = `# 机 ${prefix}|`;
          break;
        }
      }
      if (marked !== '') break;
    }
    if (marked === '') return; // 目录里没有唯一前缀的事件 ⇒ 本用例不适用（不算假绿：上面那条已钉"未注入零候选"）
    const request = requestOf(marked, {
      project: { adapterId: ERATW_GAME_ADAPTER.id } as unknown as InlineCompletionRequest['project'],
    });
    const outcome = kojo2InlineCompletion(request, {
      adapterFor: (adapterId) => (adapterId === ERATW_GAME_ADAPTER.id ? ERATW_GAME_ADAPTER : null),
    });
    expect(outcome?.state).toBe('candidates');
    if (outcome?.state !== 'candidates') return;
    const [candidate] = outcome.candidates;
    expect(events).toContain(candidate?.insertText);
  });

  it('project.adapterId 对不上 ⇒ 按"没有 adapter 事实"作答（不拿 A 游戏的目录解释 B 游戏）', () => {
    const request = requestOf('# 机 |', {
      project: { id: 'other', adapterId: 'other' } as unknown as InlineCompletionRequest['project'],
    });
    expect(
      kojo2InlineCompletion(request, {
        adapterFor: (adapterId) => (adapterId === 'eratw' ? ERATW_GAME_ADAPTER : null),
      }),
    ).toEqual({ state: 'no-completion' });
  });
});

describe('贡献形状（槽 `completion.source` 的台账）', () => {
  it('id / order / title 齐备，provideInline 交出 Promise 且非 kojo2 弃权', async () => {
    const contribution = createKojo2InlineContribution(NO_ADAPTER);
    expect(contribution.id).toBe(KOJO2_INLINE_SOURCE_ID);
    expect(contribution.order).toBe(KOJO2_INLINE_ORDER);
    expect(contribution.title).toBe(KOJO2_INLINE_TITLE);
    expect(KOJO2_INLINE_ORDER).toBeLessThan(20); // 本地一族排在外部模型源之前
    await expect(contribution.provideInline(requestOf('# 视|', { languageId: 'erb' }))).resolves.toBeUndefined();
    await expect(contribution.provideInline(requestOf('# 视|'))).resolves.toMatchObject({
      state: 'candidates',
    });
  });
});
