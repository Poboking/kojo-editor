/**
 * B3 语义收口 · 结构化着色供方的闸（`src/semantic.ts` + `plugin.ts` 接线）。
 *
 * 形状与 B3h 折叠同一条：捕获快照是**结构 worker**（异步）算的，宿主在打开 / 改动时
 * 预取进缓存，随请求的 `captures` 递过来；供方**同步**作答。四组断言：
 *
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——宿主这枚 provider 也挂在 ERB / kojo1 上，
 *    混成空结果会把那门语言自己的着色供方顶掉；
 * 2. **三态**：有快照 ⇒ 区间；空快照 ⇒ `spans: []`；**快照缺席**（还没预取到）⇒ 同样
 *    `spans: []`（作答，不是弃权，也不异步等待）；
 * 3. **判据一致性**：翻译 / 裁剪交给 `@kojo/kojo-lang/semantic`（跨行拆段用请求全文的行几何）；
 * 4. **装配**：`kojo2-semanticTokens` 是独立一枚贡献（order 10），不与别的腿合并。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceRequest, PluginContext } from '@kojo/plugin-api';
import { KOJO2_TOKEN } from '@kojo/kojo-sdk/semantic-roles';
import { createKojoLangPlugin, provideSemanticTokens } from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo';
const TEXT = '# 幕 神社清晨\n> 晨光。\n';

function request(over: Record<string, unknown> = {}): EditorLanguageServiceRequest {
  return {
    kind: 'semanticToken',
    path: PATH,
    text: TEXT,
    lineCount: 20,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

const capture = (name: string, line: number, startColumn: number, endColumn: number) => ({
  name,
  line,
  startColumn,
  endColumn,
});

describe('着色供方 · 语言过滤与三态', () => {
  it('非 kojo2 ⇒ undefined（弃权；不顶掉 ERB / kojo1 自己的着色供方）', () => {
    expect(
      provideSemanticTokens(request({ languageId: 'kojo-erb', captures: [capture('keyword', 1, 1, 3)] })),
    ).toBeUndefined();
    // 没有 languageId 时退回扩展名：`.erb` 不是 2.0
    expect(
      provideSemanticTokens(request({ languageId: undefined, path: 'D:/p/a.ERB', captures: [capture('keyword', 1, 1, 3)] })),
    ).toBeUndefined();
  });

  it('不是 semanticToken 的请求 ⇒ undefined（同一槽的其它判别成员不归这里）', () => {
    expect(provideSemanticTokens(request({ kind: 'foldingRange' }))).toBeUndefined();
  });

  it('有快照 ⇒ 捕获翻译成契约区间（1 基原样、档位是 role.*）', () => {
    expect(
      provideSemanticTokens(
        request({
          captures: [capture('keyword', 1, 1, 3), capture('string', 2, 1, 4)],
        }),
      ),
    ).toEqual({
      kind: 'semanticToken',
      spans: [
        { line: 1, startColumn: 1, endColumn: 3, tokenType: KOJO2_TOKEN.keyword },
        { line: 2, startColumn: 1, endColumn: 4, tokenType: KOJO2_TOKEN.speech },
      ],
    });
  });

  it('空快照 ⇒ spans: []（作答："这一版确实没有可着色的捕获"）', () => {
    expect(provideSemanticTokens(request({ captures: [] }))).toEqual({
      kind: 'semanticToken',
      spans: [],
    });
  });

  it('快照缺席（还没预取到）⇒ spans: []（作答，不是弃权；不异步等待）', () => {
    expect(provideSemanticTokens(request())).toEqual({ kind: 'semanticToken', spans: [] });
  });

  it('请求没带 lineCount ⇒ 同档空（没有行数事实就判不了越界）', () => {
    expect(
      provideSemanticTokens(request({ lineCount: undefined, captures: [capture('keyword', 1, 1, 3)] })),
    ).toEqual({ kind: 'semanticToken', spans: [] });
  });
});

describe('着色供方 · 判据与最后一道闸', () => {
  it('行越界 / 零宽 / 表外捕获丢掉，合法的照留', () => {
    expect(
      provideSemanticTokens(
        request({
          captures: [
            capture('keyword', 99, 1, 3),
            capture('keyword', 1, 2, 2),
            capture('mystery.capture', 1, 1, 3),
            capture('type', 1, 1, 2),
          ],
        }),
      ),
    ).toEqual({
      kind: 'semanticToken',
      spans: [{ line: 1, startColumn: 1, endColumn: 2, tokenType: KOJO2_TOKEN.type }],
    });
  });

  it('跨行捕获用请求全文的行几何逐行拆段（不依赖宿主再给行长）', () => {
    // 第 1 行 `# 幕 神社清晨` 长度 8 ⇒ maxColumn 9；第 2 行 `> 晨光。` 长度 4 ⇒ 5。
    const result = provideSemanticTokens(
      request({
        captures: [{ name: 'string', line: 1, startColumn: 3, endColumn: 4, endLine: 2 }],
      }),
    );
    expect(result).toEqual({
      kind: 'semanticToken',
      spans: [
        { line: 1, startColumn: 3, endColumn: 9, tokenType: KOJO2_TOKEN.speech },
        { line: 2, startColumn: 1, endColumn: 4, tokenType: KOJO2_TOKEN.speech },
      ],
    });
  });

  it('注入子树捕获（origin: injection）按子语言表翻译，并优先于主树', () => {
    expect(
      provideSemanticTokens(
        request({
          captures: [
            { name: 'embedded', line: 2, startColumn: 1, endColumn: 6 },
            { name: 'comment', line: 2, startColumn: 2, endColumn: 4, origin: 'injection' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'semanticToken',
      spans: [
        { line: 2, startColumn: 1, endColumn: 2, tokenType: KOJO2_TOKEN.raw },
        { line: 2, startColumn: 2, endColumn: 4, tokenType: KOJO2_TOKEN.comment },
        { line: 2, startColumn: 4, endColumn: 6, tokenType: KOJO2_TOKEN.raw },
      ],
    });
  });

  it('坏快照（非数组）⇒ 空结果，不抛', () => {
    expect(provideSemanticTokens(request({ captures: 'nope' as never }))).toEqual({
      kind: 'semanticToken',
      spans: [],
    });
  });
});

describe('装配 · 贡献登记', () => {
  it('`kojo2-semanticTokens` 是 ui.editor.languageService 上的独立一枚（order 10）', () => {
    const registered: { slot: string; item: { id: string; order?: number } }[] = [];
    const ctx = {
      slots: {
        register: (slot: string, item: { id: string; order?: number }) => {
          registered.push({ slot, item });
        },
      },
      log: { info: () => undefined },
    } as unknown as PluginContext;
    createKojoLangPlugin().activate(ctx);
    const entry = registered.find((hit) => hit.item.id === 'kojo2-semanticTokens');
    expect(entry?.slot).toBe('ui.editor.languageService');
    expect(entry?.item.order).toBe(10);
    // 与折叠那枚逐字同形的接线：同一语言、同一 order、不同贡献
    expect(registered.filter((hit) => hit.item.id.startsWith('kojo2-')).length).toBeGreaterThan(5);
  });
});