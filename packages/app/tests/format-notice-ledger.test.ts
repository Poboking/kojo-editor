/**
 * FMT-TOAST · 格式化让路的**一次性台账** + 作者面文案表 + **两条真出口的接线**。
 *
 * 本文件钉四件事，理由各不相同：
 *
 * ① **台账的纯函数腿**（`claimFormatNotice`，自带一张 seen 表）与**会话腿**（模块级那张 +
 *    `reportFormatDegradation` 入口）：去重键 = `where` + 行区间；换一处让路要说、换一段行区间
 *    也要说；同一处反复来只说一次；重启清零；整表有界。`stage` **不进键**是"一次只说一遍"的
 *    字面要求（选区格式化与打字撞到同一处不重复刷屏）。
 * ② **文案表**：`五个 where × 两个 stage` 各有一格、互不相同；正文零机器词（逐字表在悬停）；
 *    严重度按"有没有改动"分档。静态闸直接读提供方源码，多一处上屏句子即红。
 * ③ **两档让路出口真的会说话**（ERB-PARITY G2 收尾后的形状）：
 *    - `range` 一档（选区格式化）：ERB 的区间 provider 由**槽腿工厂**挂上、插件供方作答
 *      （`@kojo/plugin-erb-lang` 的 `erb-formatting`）。判据抛错 ⇒ 供方**上抛** →
 *      `collectFormattingEdits` 的错态回调如实交回 → 槽腿报 `{where:'compute', stage:'range'}`
 *      → 交回 `[]`；纯弃权（没有供方应答）**不报台账**——这两种旧形状都塌成同一个 `[]`，
 *      FMT-TOAST 的 `range` 一档因此在 G2 搬家后一度静默，本批就是把它接回去。
 *      台账入口经 `SlotServiceHost.onFormatDegraded` 接进来（装配点 = `reportFormatDegradation`），
 *      本文件拿同一枚入口直接驱动槽腿（`installSlotServiceLegs(['formatting'])` + 桩 kernel/供方）。
 *      整篇腿（`Shift+Alt+F`）抛错只 warn 不进台账——请求表里没有那一格文案（与 v1 旧口径一致）。
 *    - `onType` 一档（打字规范化）：走 `monaco/kojo-format-range.ts` 留下的
 *      `installErbOnTypeFormatter`（五处降级点：resolve / compute / resolveRange /
 *      windowCompute / anchor，`stage:'onType'`）。
 *    两档共用同一枚台账：同一处 200 次只上屏一条；换 `where` 或换区间会再说；
 *    开发者面 `console.warn` 每次照打；返回值语义一字未动（`[]`）。
 * ④ **分层**：句子只住台账这张表；提供方（on-type 腿 / `.kojo` 腿 / 槽腿工厂）只 warn + 回调；
 *    接线只有装配点（`editor-global-providers.ts`）与壳层（`ui/EditorPane.tsx`），都不新开显示面。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorLanguageServiceContribution, EditorLanguageServiceRequest } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import {
  clipFormatEditsToLines,
  installErbOnTypeFormatter as onTypeFormatter,
  type FormatDegradationNotice,
} from '../src/monaco/kojo-format-range';
import { installRangeFormatter as installKojoRangeFormatter } from '../src/monaco/kojo-format';
import { installSlotServiceLegs } from '../src/monaco/slot-service-providers';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  FORMAT_NOTICE_LEDGER_MAX,
  FORMAT_NOTICE_MACHINE_WORDS,
  claimFormatNotice,
  formatDegradationCopy,
  formatDegradationCopyTable,
  reportFormatDegradation,
  resetFormatNoticeLedger,
  subscribeFormatNotices,
} from '../src/ui/format-notice-ledger';

const HERE = import.meta.dirname;
/** 台账本体（句子只许住这一份源码） */
const LEDGER_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'format-notice-ledger.ts'), 'utf8');
/** on-type 提供方（kojo-format-range.ts）：只许 warn + 回调，不许长上屏文案 */
const PROVIDER_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'kojo-format-range.ts'), 'utf8');
/** `.kojo` 区间提供方（kojo-format.ts）：两处让路（resolve / compute），同一 `where` 词表 */
const KOJO_FORMAT_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'kojo-format.ts'), 'utf8');
/** 槽腿工厂（ERB range 腿的让路点）：只报 `where:'compute'`，一句人话都不许长 */
const SLOT_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'), 'utf8');
/** 宿主接线：安装点把台账入口递给三条腿（onDegraded ×2 + onFormatDegraded ×1） */
const WIRING_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'editor-global-providers.ts'), 'utf8');
/** 壳层接线：编辑器把通知中心订阅给台账（唯一一处上屏） */
const EDITOR_SOURCE = readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'EditorPane.tsx'), 'utf8');

/** 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**，注释里提到句子不该把针弄红 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const PROVIDER_CODE = codeOf(PROVIDER_SOURCE);
const KOJO_FORMAT_CODE = codeOf(KOJO_FORMAT_SOURCE);
const SLOT_CODE = codeOf(SLOT_SOURCE);
const WIRING_CODE = codeOf(WIRING_SOURCE);
const EDITOR_CODE = codeOf(EDITOR_SOURCE);

/** 十句正文的逐字片段（每格挑一段 ≥12 字的连续正文——机器造不出这种串，只能抄） */
const SENTENCE_SNIPPETS = [
  '选区格式化没有生效：编辑器没能确认',
  '打字时的自动规范化没有生效：编辑器没能确认',
  '选区格式化没有生效：格式化规则在这一段上',
  '打字时的自动规范化没有生效：格式化规则在这一行上',
  '选区格式化改用了整篇判断（只取选区那几行时',
  '打字时的自动规范化改用了整篇判断（只取这一行时',
  '选区格式化没有生效：只按选区那几行算的时候',
  '打字时的自动规范化没有生效：只按这一行算的时候',
  '选区格式化改用了整篇判断（这一段之前的上下文在分段视角里问不到',
  '打字时的自动规范化改用了整篇判断（这一段之前的上下文在分段视角里问不到',
] as const;

/** 上屏句的残片（提供方与接线里都不许出现；悬停 detail 走的是机器面，不在这张黑名单） */
const TOAST_PHRASE_FRAGMENTS = ['没有生效', '改用了整篇判断', '保持原样', '文件保持原样'] as const;

const WHERE_ALL: readonly FormatDegradationNotice['where'][] = [
  'resolve', 'compute', 'resolveRange', 'windowCompute', 'anchor',
];
const STAGE_ALL: readonly FormatDegradationNotice['stage'][] = ['range', 'onType'];

/** 一条基准 notice（去重键的两格 + 可覆写），①② 两组共用 */
function base(over: Partial<FormatDegradationNotice> = {}): FormatDegradationNotice {
  return { where: 'resolve', stage: 'range', startLine: 2, endLine: 4, reason: '甲', ...over };
}

const FULLWIDTH = '\u3000';
const RANGE_OPTS = {} as Monaco.languages.FormattingOptions;
const RANGE_TOKEN = {} as Monaco.CancellationToken;

afterEach(() => {
  resetFormatNoticeLedger();
  while (offHandles.length > 0) offHandles.pop()!();
  vi.restoreAllMocks();
});

/* ============================== ① 台账本体（纯函数腿 + 会话腿） ============================== */

describe('① 同一处只说一次（去重键 = where + 行区间）', () => {
  it('同一 where + 同一行区间：第二次不再说（纯函数腿）；reason / stage 换掉也不算新身份', () => {
    const seen = new Set<string>();
    expect(claimFormatNotice(base(), seen).said).toBe(true);
    expect(claimFormatNotice(base({ reason: '乙——换一种失败说法' }), seen).said).toBe(false);
    expect(claimFormatNotice(base({ stage: 'onType' }), seen).said).toBe(false);
    expect(seen.size).toBe(1);
  });

  it('端点不同 = 另一段区间 = 另一个身份；同一身份换段回来仍然不说（纯函数腿）', () => {
    const seen = new Set<string>();
    expect(claimFormatNotice(base(), seen).said).toBe(true);
    expect(claimFormatNotice(base({ endLine: 5 }), seen).said).toBe(true);
    expect(claimFormatNotice(base({ startLine: 3, endLine: 4 }), seen).said).toBe(true);
    expect(claimFormatNotice(base(), seen).said).toBe(false);
    expect(seen.size).toBe(3);
  });

  it('会话腿（安装点真正调用的那枚入口）：第一次 true、重复 false；换 where 会说；换 stage 不说', () => {
    const notice = base({ where: 'compute', stage: 'onType', startLine: 7, endLine: 7, reason: 'x' });
    expect(reportFormatDegradation(notice)).toBe(true);
    expect(reportFormatDegradation(notice)).toBe(false);
    expect(reportFormatDegradation({ ...notice, where: 'windowCompute' })).toBe(true);
    expect(reportFormatDegradation({ ...notice, where: 'compute', stage: 'range' })).toBe(false);
  });

  it('换一个 where 要说（同一行区间不算同一次让路）——五个点逐个报，各说一次', () => {
    const seen = new Set<string>();
    for (const where of WHERE_ALL) {
      expect(claimFormatNotice(base({ where, startLine: 4, endLine: 9, reason: '同一份原文' }), seen).said).toBe(true);
      expect(claimFormatNotice(base({ where, startLine: 4, endLine: 9, reason: '同一份原文' }), seen).said).toBe(false);
    }
    expect(seen.size).toBe(WHERE_ALL.length);
  });

  it('换一段行区间要说；端点动一格也算另一段', () => {
    const seen = new Set<string>();
    const first = base({ where: 'windowCompute', startLine: 10, endLine: 20 });
    expect(claimFormatNotice(first, seen).said).toBe(true);
    expect(claimFormatNotice({ ...first, startLine: 11 }, seen).said).toBe(true);
    expect(claimFormatNotice({ ...first, endLine: 21 }, seen).said).toBe(true);
    expect(claimFormatNotice(first, seen).said).toBe(false);
  });

  it('会话内不重复刷屏：同一处让路反复来，台账只登记一次身份', () => {
    const notice = base({ where: 'anchor', startLine: 3, endLine: 8 });
    let said = 0;
    for (let i = 0; i < 50; i++) {
      if (reportFormatDegradation(notice)) said += 1;
    }
    expect(said).toBe(1);
  });

  it('台账有界：到阈值整表清空（长跑会话不把内存喂给一张只增的表）', () => {
    for (let i = 0; i < FORMAT_NOTICE_LEDGER_MAX; i++) {
      reportFormatDegradation(base({ startLine: i + 1, endLine: i + 1, where: 'compute' }));
    }
    // 下一枚触发清空；清空后第一枚的身份又被登记一次 ⇒ `true`
    reportFormatDegradation(base({ startLine: 99_999, endLine: 99_999, where: 'compute', reason: '越界新身份，先把整表换掉' }));
    expect(reportFormatDegradation(base({ startLine: 1, endLine: 1, where: 'compute' }))).toBe(true);
  });
});

/* ============================== ② 文案表（静态闸） ============================== */

describe('② 文案表：五个 where × 两个 stage 逐格都有、正文零机器词、逐字 reason 进悬停', () => {
  const table = formatDegradationCopyTable();

  it('五个 where × 两个 stage 各有一格，且互不相同（不许留白、不许抄近路共用）', () => {
    const texts = new Set<string>();
    for (const where of WHERE_ALL) {
      const byStage = table[where];
      expect(Object.keys(byStage).sort()).toEqual([...STAGE_ALL].sort());
      for (const stage of STAGE_ALL) {
        expect(byStage[stage].length).toBeGreaterThan(8);
        texts.add(byStage[stage]);
      }
    }
    expect(texts.size).toBe(WHERE_ALL.length * STAGE_ALL.length);
  });

  it('静态闸：`NOTICE_TEXT` 恰好五个 where 格 × 两档 stage = 十格文本（多一格 = 有人绕过闭集偷加文案）', () => {
    const ledgerCode = codeOf(LEDGER_SOURCE);
    expect(ledgerCode.match(/(?:resolve|compute|resolveRange|windowCompute|anchor):\s*\{/g) ?? []).toHaveLength(5);
    expect(ledgerCode.match(/(?:range|onType):\s*'/g) ?? []).toHaveLength(10);
  });

  it('正文零机器词：ASCII 字母一个都不许出现（windowCompute / anchor 这类内部词只在悬停）', () => {
    const machineWordRe = new RegExp(`(?<![A-Za-z])(?:${FORMAT_NOTICE_MACHINE_WORDS.join('|')})(?![A-Za-z])`, 'i');
    for (const where of WHERE_ALL) {
      for (const stage of STAGE_ALL) {
        const text = table[where][stage];
        expect(text, `正文混进机器词：${where}/${stage}`).not.toMatch(machineWordRe);
        expect(text, `正文混进英文：${where}/${stage}`).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it('逐字 reason 进悬停（技术信息一条不丢），first-glance 正文不含它', () => {
    const reason = "TypeError: cannot read 'kojo' at 口上.ts:42 — 原始错误串一个字不许改";
    const copy = formatDegradationCopy({ where: 'compute', stage: 'range', startLine: 3, endLine: 9, reason });
    expect(copy.detail).toContain(reason);
    expect(copy.detail).toContain('compute');
    expect(copy.detail).toContain('第 3–9 行');
    expect(copy.text).not.toContain(reason);
  });

  it('严重度分档：空手而归 = error 常驻；只是换了一条腿 = info 自动消失', () => {
    const sev = (where: FormatDegradationNotice['where']): string => formatDegradationCopy(base({ where })).kind;
    expect(sev('resolve')).toBe('error');
    expect(sev('compute')).toBe('error');
    expect(sev('windowCompute')).toBe('error');
    expect(sev('resolveRange')).toBe('info');
    expect(sev('anchor')).toBe('info');
  });

  it('说得出"这次到底有没有改动"：三个空手而归的点必须承认没改，两个换腿的点不许谎称没改', () => {
    for (const where of ['resolve', 'compute', 'windowCompute'] as const) {
      const text = formatDegradationCopy(base({ where })).text;
      expect(text, `where=${where} 不许含糊`).toContain('没有生效');
      expect(text).not.toContain('改用了整篇判断');
    }
    for (const where of ['resolveRange', 'anchor'] as const) {
      const text = formatDegradationCopy(base({ where })).text;
      expect(text, `where=${where} 不许假警报`).not.toContain('没有生效');
      expect(text).toContain('改用了整篇判断');
    }
  });

  it('闭集外不许崩：提供方将来多长一个 where 而未补表 ⇒ 落到兜底句而不是 undefined', () => {
    const copy = formatDegradationCopy({
      where: 'brandNewPoint' as unknown as FormatDegradationNotice['where'],
      stage: 'range',
      startLine: 1,
      endLine: 1,
      reason: 'r',
    });
    expect(copy.text).toBe(table.compute.range);
    expect(copy.kind).toBe('error');
  });

  it('同一枚 notify 订两次只上屏一次；退订一次仍然上屏（多枚标签共用根通知中心）', () => {
    const notify = vi.fn();
    const offFirst = subscribeFormatNotices(notify);
    const offSecond = subscribeFormatNotices(notify);
    reportFormatDegradation(base({ startLine: 1, endLine: 1 }));
    expect(notify).toHaveBeenCalledTimes(1);
    offFirst(); // 另一枚标签还挂着 ⇒ 计数没归零，仍上屏
    reportFormatDegradation(base({ startLine: 2, endLine: 2 }));
    expect(notify).toHaveBeenCalledTimes(2);
    offSecond(); // 归零 ⇒ 从此不再上屏
    reportFormatDegradation(base({ startLine: 3, endLine: 3 }));
    expect(notify).toHaveBeenCalledTimes(2);
    offSecond(); // 再退一次是 no-op，不许把刚订上的撤掉
    const again = subscribeFormatNotices(notify);
    reportFormatDegradation(base({ startLine: 5, endLine: 5 }));
    expect(notify).toHaveBeenCalledTimes(3);
    again();
  });

  it('订阅者抛错不许打断格式化请求，也不许吃掉后面几条订阅', () => {
    const boom = vi.fn(() => {
      throw new Error('呈现面炸了');
    });
    const ok = vi.fn();
    const offBoom = subscribeFormatNotices(boom);
    const offOk = subscribeFormatNotices(ok);
    try {
      expect(() => reportFormatDegradation(base({ where: 'compute', startLine: 1, endLine: 2 }))).not.toThrow();
      expect(ok).toHaveBeenCalledTimes(1);
    } finally {
      offBoom();
      offOk();
    }
  });
});

/* ============================== ③ range 一档：槽腿工厂 + 桩 kernel/供方 ============================== */

describe('③ range 一档（ERB 选区格式化经槽腿）：判据抛错要说话，纯弃权不许假警报', () => {
  /** 桩 kernel：`ui.editor.languageService` 槽只答这几枚贡献（ERB 供方的行为由用例给） */
  function installKernel(contributions: readonly EditorLanguageServiceContribution[]): void {
    setGlobalKernel({
      slots: { query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []) },
      project: { current: () => null },
    } as never);
  }

  /** 抛错供方（G2 收尾后的插件供方形状：判据炸 = 上抛，不再吞成弃权） */
  function throwingContribution(message: string, id = 'erb-formatting'): EditorLanguageServiceContribution {
    return {
      id,
      order: 10,
      provide: (request: EditorLanguageServiceRequest) => {
        if (request.kind !== 'formatting') return undefined;
        throw new Error(message);
      },
    } as unknown as EditorLanguageServiceContribution;
  }

  /** 固定答案的供方 */
  function answeringContribution(
    edits: readonly { startLine: number; endLine: number; newText: string }[],
    id = 'stub-format',
  ): EditorLanguageServiceContribution {
    return {
      id,
      order: 20,
      provide: (request: EditorLanguageServiceRequest) =>
        request.kind === 'formatting' ? { kind: 'formatting', edits } : undefined,
    } as unknown as EditorLanguageServiceContribution;
  }

  /** 弃权供方：不认这篇就交回 undefined（没有抛错） */
  function abstainingContribution(id = 'other-lang'): EditorLanguageServiceContribution {
    return { id, order: 10, provide: () => undefined } as unknown as EditorLanguageServiceContribution;
  }

  /** ERB 四行假 model（槽腿只用到这几格读数） */
  function erbModel(lines: readonly string[]): Monaco.editor.ITextModel {
    return {
      getLanguageId: () => ERB_LANGUAGE_ID,
      getVersionId: () => 1,
      getValue: () => lines.join('\n'),
      getLineCount: () => lines.length,
      getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    } as unknown as Monaco.editor.ITextModel;
  }
  const FOUR = ['甲', '乙', '丙', '丁'];

  /** 装整篇 + 区间两枚 provider（`onFormatDegraded` 等注入面由用例给，装配点同款） */
  function installFormatLeg(host: Parameters<typeof installSlotServiceLegs>[2] = {}) {
    const registrations: { kind: 'document' | 'range'; provider: Record<string, unknown> }[] = [];
    const monaco = {
      languages: {
        registerDocumentFormattingEditProvider(_id: string, provider: unknown) {
          registrations.push({ kind: 'document', provider: provider as Record<string, unknown> });
          return { dispose: () => undefined };
        },
        registerDocumentRangeFormattingEditProvider(_id: string, provider: unknown) {
          registrations.push({ kind: 'range', provider: provider as Record<string, unknown> });
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installSlotServiceLegs(monaco, ['formatting'], host);
    const providerOf = (kind: 'document' | 'range'): Record<string, unknown> => {
      const found = registrations.find((entry) => entry.kind === kind);
      if (!found) throw new Error(`${kind} 没挂上（桩没装好）`);
      return found.provider;
    };
    const askRange = (model: Monaco.editor.ITextModel, start: number, end: number): Monaco.languages.TextEdit[] =>
      (
        providerOf('range').provideDocumentRangeFormattingEdits as (
          m: Monaco.editor.ITextModel,
          r: unknown,
          o: unknown,
          t: unknown,
        ) => Monaco.languages.TextEdit[]
      )(model, { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 }, RANGE_OPTS, RANGE_TOKEN);
    const askDocument = (model: Monaco.editor.ITextModel): Monaco.languages.TextEdit[] =>
      (
        providerOf('document').provideDocumentFormattingEdits as (
          m: Monaco.editor.ITextModel,
          o: unknown,
          t: unknown,
        ) => Monaco.languages.TextEdit[]
      )(model, RANGE_OPTS, RANGE_TOKEN);
    return { askRange, askDocument, registrations };
  }

  it('供方判据抛错 ⇒ 一条 compute/range 的 notice（行区间 = 选区），provider 仍交回空数组', () => {
    installKernel([throwingContribution('规则面炸了')]);
    const notices: FormatDegradationNotice[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    expect(leg.askRange(erbModel(FOUR), 2, 4)).toEqual([]);
    expect(notices).toEqual([
      { where: 'compute', stage: 'range', startLine: 2, endLine: 4, reason: 'erb-formatting: 规则面炸了' },
    ]);
    // 开发者面每次都有：legs 一条（带贡献 id）+ 槽腿一条（带 where/stage）
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('erb-formatting') && m.includes('规则面炸了'))).toBe(true);
    expect(messages.some((m) => m.includes('compute') && m.includes('range') && m.includes('第 2–4 行'))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('纯弃权（没有供方应答）⇒ 不报台账——"这篇不归插件管"不是故障', () => {
    installKernel([abstainingContribution()]);
    const notices: FormatDegradationNotice[] = [];
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    expect(leg.askRange(erbModel(FOUR), 1, 4)).toEqual([]);
    expect(notices).toHaveLength(0);
  });

  it('有人答空表（已规范）⇒ 不报台账也不 warn——零编辑是作答，不是让路', () => {
    installKernel([answeringContribution([])]);
    const notices: FormatDegradationNotice[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    expect(leg.askRange(erbModel(FOUR), 1, 4)).toEqual([]);
    expect(notices).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('前一家抛错、后一家照常作答 ⇒ 改动落地、不报台账（真改成了就不许说"没生效"），warn 照打', () => {
    installKernel([throwingContribution('第一家炸', 'boom'), answeringContribution([{ startLine: 2, endLine: 2, newText: 'X' }], 'ok')]);
    const notices: FormatDegradationNotice[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    const out = leg.askRange(erbModel(FOUR), 2, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('X');
    expect(notices).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1); // legs 那条 warn 不许少（错态从开发者面上消失过一次就再也找不到）
  });

  it('整篇腿抛错 ⇒ 只 warn 不进台账——请求表里没有那一格文案，硬套"选区"那句是假警报', () => {
    installKernel([throwingContribution('规则面又炸')]);
    const notices: FormatDegradationNotice[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    expect(leg.askDocument(erbModel(FOUR))).toEqual([]);
    expect(notices).toHaveLength(0);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('整篇请求'))).toBe(true);
  });

  it('宿主没给 onFormatDegraded（老宿主）⇒ 交回 [] 不炸，与接台账之前逐字一致', () => {
    installKernel([throwingContribution('没人接也不许掀桌')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg();
    expect(leg.askRange(erbModel(FOUR), 1, 3)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('台账入口自己抛错不许打断格式化：provider 仍照常交回空数组', () => {
    installKernel([throwingContribution('r')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({
      onFormatDegraded: () => {
        throw new Error('呈现面炸了');
      },
    });
    expect(leg.askRange(erbModel(FOUR), 2, 3)).toEqual([]);
    warn.mockRestore();
  });

  it('陈旧 / 倒置选区：notice 的行区间先对折再夹进文档现实（与 v1 区间腿同口径）', () => {
    installKernel([throwingContribution('r')]);
    const notices: FormatDegradationNotice[] = [];
    const leg = installFormatLeg({ onFormatDegraded: (n) => notices.push(n) });
    const model = erbModel(FOUR); // 4 行
    leg.askRange(model, 9, 12);
    leg.askRange(model, 3, 1);
    expect(notices.map((n) => [n.startLine, n.endLine])).toEqual([
      [4, 4],
      [1, 3],
    ]);
  });

  it('同一处 200 次上屏恰好 1 次（经 reportFormatDegradation，返回值仍是 []，warn 一次不省）', () => {
    installKernel([throwingContribution('规则面炸')]);
    const notify = vi.fn();
    const off = subscribeFormatNotices(notify);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const leg = installFormatLeg({ onFormatDegraded: reportFormatDegradation });
    const model = erbModel(FOUR);
    let out: Monaco.languages.TextEdit[] | undefined;
    for (let i = 0; i < 200; i++) out = leg.askRange(model, 2, 4);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(400); // 两条 warn 腿 × 200
    off();
  });

  it('换区间要说：range 腿 2..4 说过之后，同 where 换 3..4 仍上屏第二条（悬停带新行区间）', () => {
    installKernel([throwingContribution('r')]);
    const notify = vi.fn();
    const off = subscribeFormatNotices(notify);
    const leg = installFormatLeg({ onFormatDegraded: reportFormatDegradation });
    const model = erbModel(FOUR);
    leg.askRange(model, 2, 4);
    leg.askRange(model, 3, 4);
    expect(notify).toHaveBeenCalledTimes(2);
    const detail = String((notify.mock.calls[1]![0] as { detail?: string }).detail ?? '');
    expect(detail).toContain('第 3–4 行');
    expect(detail).toContain('compute');
    off();
  });

  it('range 腿与 onType 腿撞同一处（同 where + 同区间）⇒ 共用一条订阅，不重复刷屏（stage 不进键）', () => {
    installKernel([throwingContribution('r')]);
    const notify = vi.fn();
    const off = subscribeFormatNotices(notify);
    const leg = installFormatLeg({ onFormatDegraded: reportFormatDegradation });
    leg.askRange(erbModel(FOUR), 3, 3); // range 先说 compute@3..3
    const model = fakeOnTypeModel([`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF']);
    installErbOnTypeWithBrokenCompute(model); // onType 撞同一格（compute@3..3）⇒ 不说
    expect(notify).toHaveBeenCalledTimes(1);
    // 换段（4..4）⇒ 说
    reportFormatDegradation({ where: 'compute', stage: 'onType', startLine: 4, endLine: 4, reason: '另一段' });
    expect(notify).toHaveBeenCalledTimes(2);
    off();
  });

  it('`.kojo` 区间腿（installKojoRangeFormatter）两处让路接同一张表：resolve / compute 各说各的 stage=range', () => {
    const notices: FormatDegradationNotice[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = fakeOnTypeModel([`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF']);
    const range = (start: number, end: number) =>
      ({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 }) as Monaco.Range;
    // ① resolve 抛错 ⇒ 上屏 resolve 那句
    const stubA = monacoStub();
    installKojoRangeFormatter(stubA.monaco, {
      resolve() {
        throw new Error('宿主判据炸了');
      },
      onDegraded: (n) => notices.push(n),
    });
    const provider = stubA.rangeProvider();
    expect(provider.provideDocumentRangeFormattingEdits!(model, range(1, 2), RANGE_OPTS, RANGE_TOKEN)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'resolve', stage: 'range', startLine: 1, endLine: 4 });
    // ② resolve 交回的请求在取文本时炸 ⇒ compute 那句（区间就是选区）
    let broken = false;
    const stubB = monacoStub();
    installKojoRangeFormatter(stubB.monaco, {
      resolve: () => throwingFormatRequest(() => broken),
      onDegraded: (n) => notices.push(n),
    });
    broken = true;
    expect(stubB.rangeProvider().provideDocumentRangeFormattingEdits!(model, range(2, 3), RANGE_OPTS, RANGE_TOKEN)).toEqual([]);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ where: 'compute', stage: 'range', startLine: 2, endLine: 3 });
    expect(warn).toHaveBeenCalledTimes(2); // 两处 warn 照打（kojo-format 前缀）
    expect(warn.mock.calls.every((c) => String(c[0]).includes('kojo-format'))).toBe(true);
  });
});

/* ============================== ④ onType 一档：五处降级点逐个钉 ============================== */

describe('④ onType 一档（installErbOnTypeFormatter）：五处降级点各自说各自的，stage 不许串档', () => {
  it('resolve 抛错（窗口腿问不到才轮到它）⇒ notice {resolve, onType, 1..行末}，provider 仍交回空数组', () => {
    const { notices, onDegraded, notify } = installLedger();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve() {
        throw new Error('宿主不让路才怪');
      },
      resolveRange: () => null, // 窗口这条腿不适用 ⇒ 整篇那条被问到 ⇒ resolve 抛错兜住
      onDegraded,
    });
    const out = pressOnType(stub, fakeOnTypeModel(['甲', '乙', '丙', '丁']), 3);
    expect(out).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'resolve', stage: 'onType', startLine: 1, endLine: 4 });
    expect(notices[0]!.reason).toContain('宿主不让路才怪');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(noticeText(notify.mock.calls[0]![0])).toContain('刚才打字时的自动规范化没有生效');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('kojo-format-range');
  });

  it('compute 抛错（整篇那条腿）⇒ notice {compute, onType, 触发行}，上屏 compute 那句', () => {
    const { notices, onDegraded, notify } = installLedger();
    let broken = false;
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve: () => throwingFormatRequest(() => broken),
      onDegraded,
    });
    const model = fakeOnTypeModel(['甲', '乙', `;${FULLWIDTH}注释`, '丁']);
    broken = true;
    expect(pressOnType(stub, model, 3)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'compute', stage: 'onType', startLine: 3, endLine: 3 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(noticeText(notify.mock.calls[0]![0])).toContain('格式化规则在这一行上算不下去了');
  });

  it('resolveRange 抛错 ⇒ "换腿"那句（info 档），整篇那条腿照常把改动交出来——不是假警报', () => {
    const { notices, onDegraded, notify } = installLedger();
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const }),
      resolveRange(): never {
        throw new Error('窗口腿这次读不到');
      },
      onDegraded,
    });
    const model = fakeOnTypeModel([`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF']);
    const out = pressOnType(stub, model, 3);
    expect(out.length).toBeGreaterThan(0); // 整篇那条照常：第 3 行的全角注释被折出来
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'resolveRange', stage: 'onType', startLine: 3, endLine: 3 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(noticeText(notify.mock.calls[0]![0])).toContain('改用了整篇判断');
    expect(noticeKind(notify.mock.calls[0]![0])).toBe('info');
  });

  it('windowCompute 抛错（窗口算不下去）⇒ notice {windowCompute, onType, 触发行}，这一击空手而归', () => {
    const { notices, onDegraded, notify } = installLedger();
    let broken = false;
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const }),
      resolveRange: () => throwingFormatRequest(() => broken),
      onDegraded,
    });
    const model = fakeOnTypeModel([`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF']);
    broken = true;
    expect(pressOnType(stub, model, 3)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'windowCompute', stage: 'onType', startLine: 3, endLine: 3 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(noticeText(notify.mock.calls[0]![0])).toContain('只按这一行算的时候规则报错了');
    expect(noticeKind(notify.mock.calls[0]![0])).toBe('error');
  });

  it('anchor 问不到（桩 model 没有逐行取文这条腿）⇒ "换腿"那句，整篇那条腿接管（前缀这段宿主不答）', () => {
    const { notices, onDegraded, notify } = installLedger();
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'erb' as const }),
      resolveRange: (m) => ({ text: m.getValue(), dialect: 'erb' as const }), // 窗口=整篇：切片必非空
      onDegraded,
    });
    // 没有 getLineContent 的假 model ⇒ 前缀直读行的腿问不到 ⇒ 交回整篇那条
    const bare = {
      getValue: () => [`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF'].join('\n'),
      getLineCount: () => 4,
      getLineMaxColumn: (l: number) => [`${FULLWIDTH}IF X`, 'PRINTFORMW 甲', `;${FULLWIDTH}注释${FULLWIDTH}文`, 'ENDIF'][l - 1]!.length + 1,
      getAlternativeVersionId: () => 1,
    } as unknown as Monaco.editor.ITextModel;
    const out = pressOnType(stub, bare, 3);
    expect(out.length).toBeGreaterThan(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ where: 'anchor', stage: 'onType', startLine: 3, endLine: 3 });
    expect(notices[0]!.reason).toContain('逐行取文');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(noticeKind(notify.mock.calls[0]![0])).toBe('info');
  });

  it('onType 一句与 range 一句不同格：打字撞上的让路上屏的是"刚才打字时"那句', () => {
    const { notify } = installLedger();
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve() {
        throw new Error('打字这一击撞上了');
      },
      onDegraded: reportFormatDegradation,
    });
    pressOnType(stub, fakeOnTypeModel(['甲', '乙', '丙', '丁']), 4);
    expect(notify).toHaveBeenCalledTimes(1);
    const text = noticeText(notify.mock.calls[0]![0]);
    expect(text).toContain('刚才打字时');
    expect(text).not.toContain('这次选区格式化');
  });

  it('呈现面抛错不许打断编辑：订阅者炸了，on-type 仍照常交回"这次不做"的形状', () => {
    const boom = vi.fn(() => {
      throw new Error('呈现面炸了');
    });
    const offBoom = subscribeFormatNotices(boom);
    const stub = monacoStub();
    onTypeFormatter(stub.monaco, {
      resolve() {
        throw new Error('r');
      },
      onDegraded: reportFormatDegradation,
    });
    try {
      expect(pressOnType(stub, fakeOnTypeModel(['甲', '乙', '丙', '丁']), 1)).toEqual([]);
      expect(boom).toHaveBeenCalled();
    } finally {
      offBoom();
    }
  });

  it('clipFormatEditsToLines 仍是纯裁剪（台账没把它掰成第二份判据）', () => {
    const edits = [
      { line: 1, startColumn: 1, endColumn: 2, text: 'a' },
      { line: 5, startColumn: 1, endColumn: 2, text: 'b' },
    ];
    expect(clipFormatEditsToLines(edits, 2, 4)).toEqual([]);
    expect(clipFormatEditsToLines(edits, 1, 5)).toEqual(edits);
    expect(clipFormatEditsToLines(edits, 5, 5)).toEqual([edits[1]]);
    expect(clipFormatEditsToLines(edits, 4, 1)).toEqual([]); // 区间倒置
  });
});

/* ============================== ⑤ 分层守卫 ============================== */

describe('⑤ 分层守卫：句子只住台账，接线只有两处', () => {
  it('提供方不许长上屏文案：三枚提供方（on-type / `.kojo` / 槽腿）逐字反查十句正文，命中一处即红', () => {
    for (const snippet of SENTENCE_SNIPPETS) {
      expect(LEDGER_SOURCE, `文案表漏了格子：${snippet}`).toContain(snippet);
      expect(PROVIDER_SOURCE, `kojo-format-range 混进上屏文案：${snippet}`).not.toContain(snippet);
      expect(KOJO_FORMAT_SOURCE, `kojo-format 混进上屏文案：${snippet}`).not.toContain(snippet);
      expect(SLOT_CODE, `槽腿工厂混进上屏文案：${snippet}`).not.toContain(snippet);
    }
    for (const frag of TOAST_PHRASE_FRAGMENTS) {
      expect(PROVIDER_CODE, `kojo-format-range 混进上屏残片：${frag}`).not.toContain(frag);
      expect(KOJO_FORMAT_CODE, `kojo-format 混进上屏残片：${frag}`).not.toContain(frag);
      expect(SLOT_CODE, `槽腿工厂混进上屏残片：${frag}`).not.toContain(frag);
    }
  });

  it('反向对照：on-type 提供方仍只有 console.warn + 回调两件事，`.kojo` 两处、槽腿一处，出口各一枚', () => {
    // 五处降级点 = 五个 where 字面量（anchor 有两处：问不到 + 扫前缀抛错）；
    // 带尾逗号的形状把 `FormatDegradationNotice['where']` 的联合类型声明行排除在外
    for (const where of ['resolve', 'compute', 'resolveRange', 'windowCompute'] as const) {
      expect(PROVIDER_CODE.match(new RegExp(`where: '${where}',`, 'g')) ?? [], `${where} 次数变了要说`).toHaveLength(1);
    }
    expect(PROVIDER_CODE.match(/where: 'anchor',/g) ?? []).toHaveLength(2);
    // 出口仍只有一处回调 + 一处 console.warn：降级点再长也得从 degrade 那一枚助手走
    expect(PROVIDER_CODE.match(/onDegraded\?\.\(/g) ?? []).toHaveLength(1);
    expect(PROVIDER_CODE.match(/console\.warn\(/g) ?? []).toHaveLength(1);
    // `.kojo` 那枚区间腿：两处让路（resolve / compute），stage 恒为 range
    expect(KOJO_FORMAT_CODE.match(/where: 'resolve'/g) ?? []).toHaveLength(1);
    expect(KOJO_FORMAT_CODE.match(/where: 'compute'/g) ?? []).toHaveLength(1);
    expect(KOJO_FORMAT_CODE.match(/degradeRange\(/g) ?? []).toHaveLength(3); // 定义 + 两处调用
    // 槽腿工厂：一处回调出口、一个 where（compute），range 一档的 stage 只许硬编码这一处
    expect(SLOT_CODE.match(/onFormatDegraded\?\.\(/g) ?? []).toHaveLength(1);
    expect(SLOT_CODE.match(/where: 'compute'/g) ?? []).toHaveLength(1);
    expect(SLOT_CODE.match(/stage: 'range'/g) ?? []).toHaveLength(1);
  });

  it('提供方不许 import 壳层呈现面（上屏与否由宿主决定，分层不靠自觉）', () => {
    expect(PROVIDER_CODE).not.toMatch(/format-notice-ledger|NotificationCenter/);
    expect(KOJO_FORMAT_CODE).not.toMatch(/format-notice-ledger|NotificationCenter/);
    expect(SLOT_CODE).not.toMatch(/from ['"][^'"]*format-notice-ledger/);
    expect(SLOT_CODE).not.toMatch(/from ['"][^'"]*NotificationCenter/);
    // 槽腿只许 type-only 引 notice 形状（词表唯一真源在 kojo-format-range，经 kojo-format 转口）
    expect(SLOT_SOURCE).toMatch(/import type \{ FormatDegradationNotice \} from '\.\/kojo-format'/);
  });

  it('宿主侧接线只有三处出口，且都不新开显示面（`.kojo` / on-type 接 onDegraded · 槽腿接 onFormatDegraded）', () => {
    expect(WIRING_CODE.match(/onDegraded: reportFormatDegradation/g) ?? []).toHaveLength(2);
    expect(WIRING_CODE.match(/onFormatDegraded: reportFormatDegradation/g) ?? []).toHaveLength(1);
    for (const frag of TOAST_PHRASE_FRAGMENTS) {
      expect(WIRING_CODE, `接线混进上屏残片：${frag}`).not.toContain(frag);
    }
    // 壳层只订阅通知中心，不自己造显示面、不抄文案
    expect(EDITOR_CODE.match(/subscribeFormatNotices\(/g) ?? []).toHaveLength(1);
    expect(EDITOR_CODE).toContain('subscribeFormatNotices(notify)');
    for (const snippet of SENTENCE_SNIPPETS) {
      expect(EDITOR_SOURCE, `编辑器混进上屏文案：${snippet}`).not.toContain(snippet);
    }
    expect(EDITOR_CODE).not.toMatch(/document\.createElement\(['"]dialog/);
  });
});

/* ============================== 测试内小工具（不进生产代码） ============================== */

/** 假 model：on-type 腿用到的那几格（含逐行取文与窗口取文） */
function fakeOnTypeModel(lines: readonly string[]): Monaco.editor.ITextModel {
  return {
    getLanguageId: () => ERB_LANGUAGE_ID,
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => lines.join('\n'),
    getValueInRange: (r: Monaco.IRange) =>
      lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n') + (r.endLineNumber >= lines.length ? '' : '\n'),
    getAlternativeVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
}

/** 桩 Monaco：记区间 / on-type 两枚注册，取回供测试直调 */
function monacoStub() {
  const registrations: { kind: 'range' | 'onType'; provider: unknown }[] = [];
  const monaco = {
    languages: {
      registerDocumentRangeFormattingEditProvider(_id: string, provider: unknown) {
        registrations.push({ kind: 'range', provider });
        return { dispose: () => undefined };
      },
      registerOnTypeFormattingEditProvider(_id: string, provider: unknown) {
        registrations.push({ kind: 'onType', provider });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  const rangeProvider = (): Monaco.languages.DocumentRangeFormattingEditProvider => {
    const found = registrations.find((r) => r.kind === 'range');
    if (!found) throw new Error('range provider 没挂上');
    return found.provider as Monaco.languages.DocumentRangeFormattingEditProvider;
  };
  const onTypeProvider = (): Monaco.languages.OnTypeFormattingEditProvider => {
    const found = registrations.find((r) => r.kind === 'onType');
    if (!found) throw new Error('on-type provider 没挂上');
    return found.provider as Monaco.languages.OnTypeFormattingEditProvider;
  };
  return { monaco, registrations, rangeProvider, onTypeProvider };
}

/** 走 on-type 那一击（触发字符 `;`） */
function pressOnType(
  stub: ReturnType<typeof monacoStub>,
  model: Monaco.editor.ITextModel,
  lineNumber: number,
): Monaco.languages.TextEdit[] {
  return (
    stub.onTypeProvider().provideOnTypeFormattingEdits?.(
      model,
      { lineNumber, column: 2 } as Monaco.Position,
      ';',
      RANGE_OPTS,
      RANGE_TOKEN,
    ) ?? []
  ) as Monaco.languages.TextEdit[];
}

/**
 * "取 text 才抛"的 FormatRequest：`computeFormatEdits` 在 `request.text` 处炸 ⇒ 恰好命中
 * `compute` / `windowCompute` 那一档（`Proxy` 对 `then` / `valueOf` / `Symbol.toPrimitive` 让路，
 * 免得被 await 或字符串拼接把异常吞成 resolved）。
 */
function throwingFormatRequest(broken: () => boolean) {
  return new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'then' || key === 'valueOf' || key === Symbol.toPrimitive) return undefined;
        if (key === 'dialect') return 'erb';
        if (key === 'text' && broken()) throw new Error('规则面炸了');
        return Reflect.get(target, key);
      },
    },
  ) as { text: string; dialect: 'erb' };
}

/** 装一枚台账 + 订阅（④ 组每条 it 自带一张干净会话表，afterEach 统一 reset） */
function installLedger(): {
  notices: FormatDegradationNotice[];
  /** 递给 onDegraded 的出口：先记一条原始 notice（断言形状用），再走**真台账入口**（断言上屏用） */
  onDegraded: (n: FormatDegradationNotice) => void;
  notify: ReturnType<typeof vi.fn>;
} {
  const notices: FormatDegradationNotice[] = [];
  const notify = vi.fn();
  const off = subscribeFormatNotices(notify);
  const onDegraded = (n: FormatDegradationNotice): void => {
    notices.push(n);
    reportFormatDegradation(n);
  };
  // afterEach 的 resetFormatNoticeLedger 清台账；订阅随 vi.restoreAllMocks 之外的 off 撤
  offHandles.push(off);
  return { notices, onDegraded, notify };
}
const offHandles: (() => void)[] = [];

/** on-type 装一条"整篇那条 compute 会炸"的腿（供 ③ 组跨档撞键那一格复用） */
function installErbOnTypeWithBrokenCompute(model: Monaco.editor.ITextModel): void {
  const stub = monacoStub();
  onTypeFormatter(stub.monaco, {
    resolve: () => throwingFormatRequest(() => true),
    onDegraded: reportFormatDegradation,
  });
  pressOnType(stub, model, 3); // compute@3..3——range 腿已先报过同一格 ⇒ 台账不说第二条
}

/** NoticeInput 两格读数 */
function noticeText(input: unknown): string {
  return String((input as { message?: string }).message ?? '');
}
function noticeKind(input: unknown): string {
  return String((input as { kind?: string }).kind ?? '');
}
