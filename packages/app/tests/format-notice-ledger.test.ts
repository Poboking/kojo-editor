/**
 * 格式化让路的**一次性台账 + 文案表 + 分层守卫**（FMT-TOAST）。
 *
 * 钉的是判据而不是字符串运气，五组闸：
 * 1. **台账三条真实行为**（逐条做过"临时回退即红"确认）：同一 `where` + 同一行区间
 *    第二次**不再说**；换 `where` 或换行区间**要说**；会话内不重复刷屏；
 * 2. **刷屏护栏**：同一次会话里同一处让路连打 200 次 ⇒ `notify` 被调用 **1** 次
 *    （走的是真 provider 那条链，不是只测台账）；
 * 3. **文案表**：五个 `where` × 两个 `stage` 各一句人话，正文**零机器词**（连 ASCII
 *    字母都不许出现），逐字 `reason` 只进悬停；"换了一条腿"与"这次真没改动"分两档严重度；
 * 4. **分层守卫（静态扫源码，连注释一起看）**：`monaco/kojo-format-range.ts` 里不许长出
 *    上屏文案字符串，副作用出口仍**只有** `console.warn` + 回调各一处，多一处即红；
 * 5. **订阅按函数身份去重 + 引用计数**：多枚编辑器标签共用根通知中心那枚 `notify`
 *    ⇒ 一条让路只上一条 toast；关掉其中一枚标签不会把还挂着的那枚的订阅一起撤掉。
 *
 * 返回值语义（`resolveRange` 抛→`null`、compute 抛→`[]`）由 `kojo-format-range.test.ts`
 * 钉着，本文件只额外确认"接了台账之后那条语义没被碰"（见下方护栏用例的第二条断言）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { installRangeFormatter, type RangeFormatHandlers, type FormatDegradationNotice } from '../src/monaco/kojo-format-range';
import type { NoticeInput, Notify } from '../src/ui/NotificationCenter';
import {
  FORMAT_NOTICE_LEDGER_MAX,
  claimFormatNotice,
  formatDegradationCopy,
  formatDegradationCopyTable,
  formatNoticeDetail,
  formatNoticeInput,
  formatNoticeKey,
  reportFormatDegradation,
  resetFormatNoticeLedger,
  subscribeFormatNotices,
} from '../src/ui/format-notice-ledger';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

const notice = (
  over: Partial<FormatDegradationNotice> = {},
): FormatDegradationNotice => ({
  where: 'resolve',
  stage: 'range',
  startLine: 3,
  endLine: 7,
  reason: '解析炸了',
  ...over,
});

const WHORES = ['resolve', 'compute', 'resolveRange', 'windowCompute', 'anchor'] as const;
const STAGES = ['range', 'onType'] as const;

/** 桩 monaco：只登记两枚 provider（口径同 `kojo-format-range.test.ts`） */
function stubMonaco() {
  const providers: {
    kind: 'range' | 'onType';
    languageId: string;
    provider: Monaco.languages.DocumentRangeFormattingEditProvider &
      Partial<Monaco.languages.OnTypeFormattingEditProvider>;
  }[] = [];
  const monaco = {
    languages: {
      registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
        providers.push({ kind: 'range', languageId, provider: provider as (typeof providers)[number]['provider'] });
        return { dispose: () => undefined };
      },
      registerOnTypeFormattingEditProvider(languageId: string, provider: unknown) {
        providers.push({ kind: 'onType', languageId, provider: provider as (typeof providers)[number]['provider'] });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, providers };
}

function stubModel(text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

const formatOpts = {} as Monaco.languages.FormattingOptions;
const token = {} as Monaco.CancellationToken;
const range = (start: number, end: number) => ({ startLineNumber: start, endLineNumber: end }) as Monaco.Range;
const pos = (lineNumber: number) => ({ lineNumber, column: 1 }) as Monaco.Position;

beforeEach(() => {
  resetFormatNoticeLedger();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('台账 · 三条真实行为', () => {
  it('① 同一 where + 同一行区间：第二次不再说（纯函数腿）', () => {
    const seen = new Set<string>();
    expect(claimFormatNotice(notice(), seen)).toEqual({ said: true, key: formatNoticeKey(notice()) });
    expect(claimFormatNotice(notice(), seen).said).toBe(false);
    // 连 reason / stage 换了也不再说：键的身份就是 "where + 行区间"（一次只说一遍）
    expect(claimFormatNotice(notice({ reason: '换了个错法' }), seen).said).toBe(false);
    expect(claimFormatNotice(notice({ stage: 'onType' }), seen).said).toBe(false);
    expect(seen.size).toBe(1);
  });

  it('① 同一 where + 同一行区间：第二次不再说（会话腿 = 安装点真正调用的那枚入口）', () => {
    const sink = vi.fn() as unknown as Notify;
    const off = subscribeFormatNotices(sink);
    expect(reportFormatDegradation(notice())).toBe(true);
    expect(reportFormatDegradation(notice())).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    off();
  });

  it('②a 换一个 where 要说（同一行区间不算同一次让路）', () => {
    const seen = new Set<string>();
    const keys = new Set<string>();
    for (const where of WHORES) {
      expect(claimFormatNotice(notice({ where }), seen).said).toBe(true);
      keys.add(formatNoticeKey(notice({ where })));
    }
    expect(keys.size).toBe(WHORES.length);
    expect(seen.size).toBe(WHORES.length);
  });

  it('②b 换一段行区间要说；端点动一格也算另一段', () => {
    const seen = new Set<string>();
    expect(claimFormatNotice(notice({ where: 'compute' }), seen).said).toBe(true);
    // 同一让路点、另一段行区间 ⇒ 新的身份（作者看到的确实是另一次让路）
    expect(claimFormatNotice(notice({ where: 'compute', startLine: 9, endLine: 9 }), seen).said).toBe(true);
    expect(claimFormatNotice(notice({ where: 'compute', startLine: 3, endLine: 8 }), seen).said).toBe(true);
    expect(seen.size).toBe(3);
  });

  it('③ 会话内不重复刷屏：同一处让路反复来，台账只登记一次身份', () => {
    const seen = new Set<string>();
    let said = 0;
    for (let i = 0; i < 200; i++) if (claimFormatNotice(notice({ where: 'anchor', startLine: 1, endLine: 40 }), seen).said) said++;
    expect(said).toBe(1);
    expect(seen.size).toBe(1);
  });

  it('台账有界：到阈值整表清空（长跑会话不把内存喂给一张只增的表）', () => {
    const seen = new Set<string>();
    for (let line = 1; line <= FORMAT_NOTICE_LEDGER_MAX; line++) {
      expect(claimFormatNotice(notice({ startLine: line, endLine: line }), seen).said).toBe(true);
    }
    expect(seen.size).toBe(FORMAT_NOTICE_LEDGER_MAX);
    expect(claimFormatNotice(notice({ startLine: FORMAT_NOTICE_LEDGER_MAX + 1, endLine: FORMAT_NOTICE_LEDGER_MAX + 1 }), seen).said).toBe(true);
    expect(seen.size).toBe(1);
  });
});

describe('刷屏护栏 · 真 provider 链路', () => {
  /** 一枚记账 sink（函数身份唯一，测试之间不串） */
  function recordingSink() {
    const calls: NoticeInput[] = [];
    const sink = ((input: NoticeInput) => void calls.push(input)) as unknown as Notify;
    return { calls, sink };
  }

  it('同一处让路连打 200 次 ⇒ notify 恰好 1 次；返回值语义照旧（空数组，不是抛错）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, sink } = recordingSink();
    const off = subscribeFormatNotices(sink);
    const { monaco, providers } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => {
        throw new Error('宿主判据炸了');
      },
      onDegraded: reportFormatDegradation,
    } satisfies RangeFormatHandlers);
    const model = stubModel(['  IF X', 'PRINTFORMW 甲', 'ENDIF'].join('\n'));
    for (let i = 0; i < 200; i++) {
      const out = providers[0]!.provider.provideDocumentRangeFormattingEdits(
        model,
        range(1, 2),
        formatOpts,
        token,
      ) as Monaco.languages.TextEdit[];
      // 让路 = 这次不做，返回空数组而不是把命令掀桌（既有语义，接台账不许改它）
      expect(out).toEqual([]);
    }
    expect(calls).toHaveLength(1);
    // 开发者面每次都打（机器面不动）；作者面只说一遍
    expect(warn).toHaveBeenCalledTimes(200);
    expect(calls[0]!.message).toBe(formatDegradationCopy(notice({ reason: '宿主判据炸了' })).text);
    expect(calls[0]!.detail).toContain('第 1–3 行');
    off();
  });

  it('打字那一击撞上同一段行区间的让路 ⇒ 同一条订阅不重复上屏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, sink } = recordingSink();
    const off = subscribeFormatNotices(sink);
    const { monaco, providers } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => {
        throw new Error('宿主判据炸了');
      },
      onDegraded: reportFormatDegradation,
    });
    const model = stubModel(['  IF X', 'PRINTFORMW 甲', 'ENDIF'].join('\n'));
    // onType 腿的 `resolve` 让路报的行区间恒为 1–全文行数 ⇒ 三次击键是同一个身份
    for (let line = 1; line <= 3; line++) {
      expect(
        providers[1]!.provider.provideOnTypeFormattingEdits!(model, pos(line), ';', formatOpts, token),
      ).toEqual([]);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      kind: 'error',
      message: formatDegradationCopy(notice({ stage: 'onType', reason: '宿主判据炸了' })).text,
      detail: formatNoticeDetail(notice({ stage: 'onType', startLine: 1, endLine: 3, reason: '宿主判据炸了' })),
    });
    expect(warn).toHaveBeenCalledTimes(3);
    off();
  });
});

describe('文案表 · 作者面说人话', () => {
  it('五个 where × 两个 stage 各有一格，且互不相同（不许留白、不许抄近路共用）', () => {
    const table = formatDegradationCopyTable();
    expect(Object.keys(table).sort()).toEqual([...WHORES].sort());
    const seenTexts = new Set<string>();
    for (const where of WHORES) {
      const byStage = table[where];
      expect(Object.keys(byStage).sort()).toEqual([...STAGES].sort());
      for (const stage of STAGES) {
        const text = byStage[stage];
        expect(text.length).toBeGreaterThan(8);
        seenTexts.add(text);
      }
    }
    expect(seenTexts.size).toBe(WHORES.length * STAGES.length);
  });

  it('正文零机器词：ASCII 字母一个都不许出现（windowCompute / anchor 这类内部词只在悬停）', () => {
    for (const where of WHORES) {
      for (const stage of STAGES) {
        const { text } = formatDegradationCopy(notice({ where, stage }));
        expect(text).not.match(/[A-Za-z]/);
        for (const word of ['resolve', 'resolveRange', 'windowCompute', 'anchor', 'onType', 'degrade']) {
          expect(text).not.toContain(word);
        }
      }
    }
  });

  it('逐字 reason 进悬停（技术信息一条不丢），first-glance 正文不含它', () => {
    const raw = "TypeError: cannot read 'kojo' at 口上.ts:42 — 原始错误串一个字不许改";
    const where = 'windowCompute';
    const subject = notice({ where, stage: 'onType', startLine: 12, endLine: 12, reason: raw });
    const copy = formatDegradationCopy(subject);
    expect(copy.detail).toContain(raw);
    expect(copy.detail).toContain(where);
    expect(copy.detail).toContain('第 12–12 行');
    expect(copy.text).not.toContain(raw);
    expect(formatNoticeInput(subject).detail).toBe(copy.detail);
  });

  it('严重度分档：空手而归 = error 常驻；只是换了一条腿 = info 自动消失', () => {
    const kinds = Object.fromEntries(WHORES.map((w) => [w, formatDegradationCopy(notice({ where: w })).kind]));
    expect(kinds).toEqual({
      resolve: 'error',
      compute: 'error',
      resolveRange: 'info',
      windowCompute: 'error',
      anchor: 'info',
    });
  });

  it('说得出"这次到底有没有改动"：三个空手而归的点必须承认没改，两个换腿的点不许谎称没改', () => {
    for (const where of ['resolve', 'compute', 'windowCompute'] as const) {
      expect(formatDegradationCopy(notice({ where })).text).toContain('没有生效');
    }
    for (const where of ['resolveRange', 'anchor'] as const) {
      const text = formatDegradationCopy(notice({ where })).text;
      expect(text).toContain('整篇判断');
      expect(text).not.toContain('没有生效');
    }
  });

  it('闭集外不许崩：提供方将来多长一个 where 而未补表 ⇒ 落到兜底句而不是 undefined', () => {
    const copy = formatDegradationCopy(notice({ where: 'futurePoint' as FormatDegradationNotice['where'] }));
    expect(copy.text).toBe(formatDegradationCopy(notice({ where: 'compute' })).text);
    expect(copy.kind).toBe('error');
  });
});

describe('订阅表 · 按函数身份去重 + 引用计数', () => {
  it('同一枚 notify 订两次只上屏一次；退订一次仍然上屏（多枚标签共用根通知中心）', () => {
    const sink = vi.fn() as unknown as Notify;
    const offA = subscribeFormatNotices(sink);
    const offB = subscribeFormatNotices(sink);
    resetFormatNoticeLedger();
    reportFormatDegradation(notice({ where: 'anchor' }));
    expect(sink).toHaveBeenCalledTimes(1);
    offA();
    resetFormatNoticeLedger();
    reportFormatDegradation(notice({ where: 'anchor', startLine: 20, endLine: 21 }));
    expect(sink).toHaveBeenCalledTimes(2);
    offB();
    resetFormatNoticeLedger();
    reportFormatDegradation(notice({ where: 'anchor', startLine: 30, endLine: 31 }));
    expect(sink).toHaveBeenCalledTimes(2);
    // 重复退订幂等（React 严格模式下 effect 会被调两次清理）
    offB();
    offA();
  });

  it('订阅者抛错不许打断格式化请求，也不许吃掉后面几条订阅', () => {
    const boom = vi.fn(() => {
      throw new Error('呈现面自己炸了');
    }) as unknown as Notify;
    const good = vi.fn() as unknown as Notify;
    const offBoom = subscribeFormatNotices(boom);
    const offGood = subscribeFormatNotices(good);
    expect(() => reportFormatDegradation(notice({ where: 'compute' }))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    offBoom();
    offGood();
  });
});

describe('分层守卫 · 静态扫源码（连注释一起看）', () => {
  const SOURCE = read('packages', 'app', 'src', 'monaco', 'kojo-format-range.ts');

  it('提供方不许长上屏文案：文案表里那十句逐字反查，命中一处即红', () => {
    const table = formatDegradationCopyTable();
    for (const where of WHORES) {
      for (const stage of STAGES) {
        expect(SOURCE.includes(table[where][stage]), `${where}/${stage} 的句子写进了提供方`).toBe(false);
      }
    }
    // 作者面句式也不许在那一侧冒出来（哪怕换了具体措辞）
    for (const phrase of ['没有生效', '整篇判断', '保持原样', '可以再按一次']) {
      expect(SOURCE, `提供方出现了作者面句式「${phrase}」`).not.toContain(phrase);
    }
  });

  it('反向对照：提供方仍只有 console.warn + 回调两件事，多一处即红', () => {
    // 只数**代码行**里的调用位点（文档注释里提这两个名字是设计说明，不算上屏动作）
    const codeLines = SOURCE.split('\n').filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const code = codeLines.join('\n');
    expect(code.match(/console\.\w+\(/g) ?? []).toEqual(['console.warn(']);
    expect(code.match(/handlers\.onDegraded\?\.\(/g) ?? []).toHaveLength(1);
    // 唯一那处"递出去"就在 degrade() 的 try 里（回调抛错被吃掉，绝不打断编辑）
    expect(SOURCE).toMatch(/try \{\s*\n\s*handlers\.onDegraded\?\.\(full\);\s*\n\s*\} catch \{/);
  });

  it('提供方不许 import 壳层呈现面（上屏与否由宿主决定，分层不靠自觉）', () => {
    expect(SOURCE).not.toMatch(/from '\.\.\/ui\//);
    expect(SOURCE).not.toContain('format-notice-ledger');
    expect(SOURCE).not.toContain('NotificationCenter');
    expect(SOURCE).not.toContain('notify');
  });

  it('宿主侧接线只有两处，且都不新开显示面（安装点接台账 · 编辑器接通知中心）', () => {
    const providers = read('packages', 'app', 'src', 'ui', 'editor-global-providers.ts');
    const pane = read('packages', 'app', 'src', 'ui', 'EditorPane.tsx');
    // ① 安装点：`onDegraded` 就挂在那枚既有安装点上，零新调用位点
    expect(providers.match(/onDegraded: reportFormatDegradation/g) ?? []).toHaveLength(1);
    expect(providers.match(/reportFormatDegradation/g) ?? []).toHaveLength(2); // import + 上面那一处
    // ② 编辑器：订阅根通知中心那枚 notify，一条一行，不另立状态格 / 徽章
    expect(pane.match(/subscribeFormatNotices\(notify\)/g) ?? []).toHaveLength(1);
    expect(pane).toMatch(/useEffect\(\(\) => subscribeFormatNotices\(notify\), \[notify\]\);/);
    expect(providers).not.toMatch(/onDegraded:[^}]*notify/); // 安装点不直接碰通知中心
    // 这条线不许带出第二套显示面：格式化让路的正文只能由台账递给 notify
    expect(pane).not.toMatch(/notify\(\{[^}]*格式化/);
    expect(read('packages', 'app', 'src', 'ui', 'format-notice-ledger.ts')).not.toMatch(/statusBar|badge/i);
  });
});

describe('全链路 · 五处让路点逐处打通到通知中心', () => {
  /**
   * 每一格都走**真 provider**（假 monaco + 假 model）：让路 → `onDegraded` → 台账 → 订阅者。
   * `expectedShape` 同时钉住"上屏那一句是谁"和"返回值语义没被碰"（`null` = 该条腿交回整篇，
   * 空数组 = 这次不做；两档都不许抛出去）。
   */
  const FW = FULLWIDTH_SPACE;
  /** 带 `getValueInRange` 的假 model（锚点那条腿要问前缀） */
  function windowModel(text: string) {
    const lines = text.split(/\r\n|\r|\n/);
    const base = stubModel(text);
    return {
      ...base,
      getValueInRange: (r: { startLineNumber: number; endLineNumber: number }) =>
        lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n'),
    } as unknown as Monaco.editor.ITextModel;
  }

  /** 订阅一枚新 sink（函数身份唯一）并跑一次请求，返回上屏到的正文与 provider 的返回值 */
  function drive(
    handlers: RangeFormatHandlers,
    run: (providers: ReturnType<typeof stubMonaco>['providers'], model: Monaco.editor.ITextModel) => unknown,
    modelText: string,
  ): { messages: string[]; details: string[]; out: unknown } {
    resetFormatNoticeLedger();
    const messages: string[] = [];
    const details: string[] = [];
    const sink = ((input: Parameters<Notify>[0]) => {
      messages.push(input.message);
      details.push(input.detail ?? '');
    }) as unknown as Notify;
    const off = subscribeFormatNotices(sink);
    const { monaco, providers } = stubMonaco();
    installRangeFormatter(monaco, { ...handlers, onDegraded: reportFormatDegradation });
    const model = windowModel(modelText);
    const out = run(providers, model);
    off();
    return { messages, details, out };
  }

  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const rangeRun = (start: number, end: number) => (
    p: ReturnType<typeof stubMonaco>['providers'],
    m: Monaco.editor.ITextModel,
  ) => p[0]!.provider.provideDocumentRangeFormattingEdits(m, range(start, end), formatOpts, token);

  it('resolve 抛错 ⇒ 上屏 resolve 那句，provider 仍交回空数组（这次不做，不掀桌）', () => {
    const w = warn();
    const { messages, details, out } = drive(
      {
        resolve: () => {
          throw new Error('R1');
        },
      },
      rangeRun(1, 1),
      [`  IF X`, 'ENDIF'].join('\n'),
    );
    expect(out).toEqual([]);
    expect(messages).toEqual([formatDegradationCopy(notice({ where: 'resolve', reason: 'R1' })).text]);
    expect(details[0]).toContain('位置=resolve');
    expect(details[0]).toContain('R1');
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('compute 抛错 ⇒ 上屏 compute 那句（行区间就是请求那段）', () => {
    const w = warn();
    const { messages, out } = drive(
      { resolve: () => ({ text: null as unknown as string, dialect: 'erb' }) },
      rangeRun(2, 3),
      ['  IF X', 'PRINTFORMW 甲', 'ENDIF'].join('\n'),
    );
    expect(out).toEqual([]);
    expect(messages).toEqual([formatDegradationCopy(notice({ where: 'compute', reason: 'x' })).text]);
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('resolveRange 抛错 ⇒ 上屏"换腿"那句，且整篇那条腿照常把改动交出来（不是假警报）', () => {
    const w = warn();
    const text = [`${FW}IF X`, 'ENDIF'].join('\n');
    const { messages, details, out } = drive(
      {
        resolve: (m) => ({ text: m.getValue(), dialect: 'erb' }),
        resolveRange: () => {
          throw new Error('R3');
        },
      },
      rangeRun(1, 1),
      text,
    );
    expect((out as Monaco.languages.TextEdit[]).map((e) => e.range.startLineNumber)).toEqual([1]);
    expect(messages).toEqual([formatDegradationCopy(notice({ where: 'resolveRange', reason: 'R3' })).text]);
    expect(messages[0]).not.toContain('没有生效');
    expect(details[0]).toContain('位置=resolveRange');
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('windowCompute 抛错 ⇒ 上屏 windowCompute 那句（这条腿空手而归，返回空数组）', () => {
    const w = warn();
    const { messages, out } = drive(
      {
        resolve: (m) => ({ text: m.getValue(), dialect: 'erb' }),
        resolveRange: () => ({ text: null as unknown as string, dialect: 'erb' }),
      },
      rangeRun(2, 2),
      ['  IF X', `${FW}ENDIF`].join('\n'),
    );
    expect(out).toEqual([]);
    expect(messages).toEqual([formatDegradationCopy(notice({ where: 'windowCompute', reason: 'x' })).text]);
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('anchor 问不到 ⇒ 上屏"换腿"那句，整篇那条腿接管（前缀这段宿主不答）', () => {
    const w = warn();
    const { messages, details, out } = drive(
      {
        resolve: (m) => ({ text: m.getValue(), dialect: 'erb' }),
        resolveRange: (m, start, end) =>
          start === 1 ? null : { text: m.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }), dialect: 'erb' as const },
      },
      rangeRun(2, 2),
      ['; 甲', `${FW}ENDIF`].join('\n'),
    );
    expect((out as Monaco.languages.TextEdit[]).map((e) => e.range.startLineNumber)).toEqual([2]);
    expect(messages).toEqual([
      formatDegradationCopy(notice({ where: 'anchor', reason: '前缀末态问不到（窗口腿没有前缀这段）⇒ 交回整篇那条腿' })).text,
    ]);
    expect(details[0]).toContain('位置=anchor');
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('打字那一击（onType 腿）让路 ⇒ 上屏的是 onType 那一句，与 range 那句不同格', () => {
    const w = warn();
    const { messages, out } = drive(
      {
        resolve: () => {
          throw new Error('R6');
        },
      },
      (p, m) => p[1]!.provider.provideOnTypeFormattingEdits!(m, pos(2), ';', formatOpts, token),
      ['  IF X', 'ENDIF'].join('\n'),
    );
    expect(out).toEqual([]);
    expect(messages).toEqual([
      formatDegradationCopy(notice({ where: 'resolve', stage: 'onType', reason: 'R6' })).text,
    ]);
    expect(messages[0]).toBe(
      formatDegradationCopyTable().resolve.onType,
    );
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('呈现面抛错不许打断编辑：订阅者炸了，provider 仍照常交回"这次不做"的形状', () => {
    const w = warn();
    resetFormatNoticeLedger();
    const off = subscribeFormatNotices((() => {
      throw new Error('通知链路炸了');
    }) as unknown as Notify);
    const { monaco, providers } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => {
        throw new Error('R7');
      },
      onDegraded: reportFormatDegradation,
    });
    const out = providers[0]!.provider.provideDocumentRangeFormattingEdits(
      windowModel(['  IF X', 'ENDIF'].join('\n')),
      range(1, 1),
      formatOpts,
      token,
    );
    expect(out).toEqual([]);
    off();
    expect(w).toHaveBeenCalledTimes(1);
  });
});

