/**
 * IC 批 A 车道（宿主接线）·「**同一判据全仓只许定义一次**」的源码级自证。
 *
 * ## 为什么要有这一枚文件
 *
 * 弹窗（`suggest-context-trigger.ts`）与幽灵文本（`inline-completion-host.ts`）是**同一个作者
 * 在同一拍上的两条腿**：一边是宿主替作者按键弹列表，一边是 Monaco 自己问出一行灰字。
 * 那七条与"弹哪一侧"无关的纯标量判据（⑫合成期 / ①无文件 / ②只读 / ③派生视图 / ④无焦点 /
 * ⑤多光标·有选区）如果被两侧各抄一份，症状是"弹窗不弹的地方幽灵文本弹了"（或反过来），
 * 而**两侧各自的测试都还是绿的**——这类漂移单靠行为测试抓不住。
 *
 * 所以这里按**源码文本**钉：判据只许有一个定义点，对面只许**引用**它。先例同
 * `tools/lib/audit-allow.mjs`、`packages/app/tests/erb-preproc-single-source.test.ts`、
 * 契约批的 `packages/plugin-api/tests/inline-completion.test.ts`。
 *
 * ## 第二半：十二道闸的点名表
 *
 * 下面 `GATE_ROLL_CALL` 就是交付里那张表的机器可读版本：每一道闸标成
 * `shared`（两侧同一个纯函数）/ `counterpart`（内联侧有自己的对面判据，点名是哪个符号）/
 * `popup-only`（只有弹窗侧用得上，理由写在表里）。**不许出现 `copied`**——
 * 判据真被抄了第二份，这里第一组断言就会红，且红在改动之前。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sharedSuggestGates, type SharedSuggestGateFacts } from '../src/monaco/suggest-context-trigger';

const src = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

const TRIGGER = src('monaco/suggest-context-trigger.ts');
const HOST = src('monaco/inline-completion-host.ts');
const ASSEMBLY = src('ui/editor-global-providers.ts');

/** 数定义点（只数**函数/接口定义**，不数调用与注释） */
function definitionCount(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

const ALL = [TRIGGER, HOST, ASSEMBLY].join('\n');

/* ============================== ① 单一真源 ============================== */

describe('① 判据的定义点：全仓恰好一处', () => {
  it.each([
    ['sharedSuggestGates', /export function sharedSuggestGates\(/g],
    ['SharedSuggestGateFacts', /export interface SharedSuggestGateFacts\b/g],
    ['codeViewAt', /export function codeViewAt\(/g],
    ['isNonCodePosition', /export function isNonCodePosition\(/g],
    ['singleInsertedChar', /export function singleInsertedChar\(/g],
    ['cursorReasonBreaksTypingLeg', /export function cursorReasonBreaksTypingLeg\(/g],
    ['isImeOwnedSuggestKey', /export function isImeOwnedSuggestKey\(/g],
    ['isSuggestWidgetKey', /export function isSuggestWidgetKey\(/g],
    ['SUGGEST_WIDGET_KEYS', /export const SUGGEST_WIDGET_KEYS\w*[:=]/g],
  ])('%s 只许定义一次', (_name, pattern) => {
    expect(definitionCount(ALL, pattern)).toBe(1);
  });

  it('七条共用事实的形状只有一张表（两侧不许各写一份字段名）', () => {
    const keys = ['hasPath', 'readOnly', 'derivedView', 'focused', 'multiCursor', 'selectionActive', 'composing'];
    const interfaceBody = TRIGGER.slice(
      TRIGGER.indexOf('export interface SharedSuggestGateFacts'),
      TRIGGER.indexOf('export function sharedSuggestGates'),
    );
    for (const key of keys) {
      expect(interfaceBody, `共用事实缺键：${key}`).toContain(`readonly ${key}`);
    }
    // 装配面交出的那份 facts（path / derivedView / …）是**宿主事实**，不是第二张判据表；
    // 不许出现的是第二**函数**——两侧各写一枚"这些条件该不该弹"。
    expect(HOST).not.toMatch(/function \w*[Gg]ate\w*\(/);
    expect(ASSEMBLY).not.toMatch(/function \w*[Gg]ate\w*\(/);
  });

  it('内联侧**引用**共用判据，不重抄判定（重抄的症状：宿主里出现 if (readOnly) return 那一族）', () => {
    expect(HOST).toContain('sharedSuggestGates({');
    for (const copied of [
      'if (facts.readOnly)',
      'if (facts.derivedView)',
      'if (!facts.focused)',
      'if (facts.multiCursor',
      'if (facts.selectionActive',
      'if (!facts.path',
      'if (path === null)',
    ]) {
      expect(HOST, `内联侧把共用判据抄了第二份：${copied}`).not.toContain(copied);
    }
  });

  it('弹窗侧也走同一枚函数（谁都不许绕过它自己判）', () => {
    expect(TRIGGER).toContain('sharedSuggestGates(c)');
    for (const copied of [
      'if (!c.hasPath) return false',
      'if (c.readOnly) return false',
      'if (c.derivedView) return false',
      'if (!c.focused) return false',
    ]) {
      // 这些行**只许出现在 sharedSuggestGates 自己那一段里**
      const outside = TRIGGER.split(copied).length - 1;
      expect(outside, `弹窗侧抄了第二份：${copied}`).toBeLessThanOrEqual(1);
    }
    expect(definitionCount(TRIGGER, /if \(!c\.hasPath\) return false;/g)).toBe(1);
  });

  it('合成期的按键护栏只有一副（内联侧不许自己再 stopPropagation 一遍）', () => {
    expect(definitionCount(TRIGGER, /addEventListener\('keydown'/g)).toBe(1);
    expect(definitionCount(TRIGGER, /\.stopPropagation\(\)/g)).toBe(1);
    // 头注里**提**这些 API 是允许的（那正是"不碰键位"的说明），调用形态才是要挡的
    expect(HOST).not.toContain('.stopPropagation(');
    expect(HOST).not.toContain('addEventListener(');
    expect(HOST).not.toContain('preventDefault(');
  });

  it('打字腿的判据共用同一枚 singleInsertedChar（内联侧不另写"是不是打字"）', () => {
    expect(HOST).toContain('singleInsertedChar(event)');
    expect(definitionCount(HOST, /isFlush === true/g)).toBe(0);
    expect(definitionCount(HOST, /rangeLength !== 0/g)).toBe(0);
    expect(definitionCount(TRIGGER, /isFlush === true/g)).toBe(1);
  });

  it('装配点把槽 / 事实 / 偏好三件交齐，数字与键位都不在装配点', () => {
    expect(ASSEMBLY).toContain("installInlineCompletion(monaco, {");
    expect(ASSEMBLY).toContain("slots.query('completion.source')");
    expect(ASSEMBLY).toContain('facts: inlineCompletionFacts');
    // 时间预算 / 窗宽 / 截断上限只住在宿主接线层那一处
    for (const file of [ASSEMBLY, src('ui/editor-pane/pane-helpers.ts')]) {
      expect(file).not.toContain('INLINE_REQUEST_TIMEOUT');
      expect(file).not.toContain('INLINE_CONTEXT_WINDOW');
    }
    expect(definitionCount(HOST, /export const INLINE_REQUEST_TIMEOUT_MS/g)).toBe(1);
    expect(definitionCount(HOST, /export const INLINE_CONTEXT_WINDOW_LINES/g)).toBe(1);
  });
});

/* ============================== ② 共用判据的逐条真值 ============================== */

describe('② sharedSuggestGates 逐条判得住（两侧共用同一张真值表）', () => {
  const base: SharedSuggestGateFacts = {
    hasPath: true,
    readOnly: false,
    derivedView: false,
    focused: true,
    multiCursor: false,
    selectionActive: false,
    composing: false,
  };

  it('七条全过 ⇒ 放行（两侧都判 true 才有"共用"可言）', () => {
    expect(sharedSuggestGates(base)).toBe(true);
    // 缺省（旧调用方不传 composing）= 不在合成期
    const { composing: _drop, ...rest } = base;
    expect(sharedSuggestGates(rest)).toBe(true);
  });

  it.each([
    ['⑫输入法合成期', { composing: true }],
    ['①没打开文件', { hasPath: false }],
    ['②编辑器只读', { readOnly: true }],
    ['③派生视图（糖预览 / 投影）', { derivedView: true }],
    ['④没有文本焦点', { focused: false }],
    ['⑤多光标', { multiCursor: true }],
    ['⑤有选区', { selectionActive: true }],
  ])('%s ⇒ 挡下（两侧同一判据，不许一侧放行）', (_label, over) => {
    expect(sharedSuggestGates({ ...base, ...(over as Partial<SharedSuggestGateFacts>) })).toBe(false);
  });

  it('合成期排在最前：连"有没有文件"都不必问（只读 + 合成期也只出一条闸门）', () => {
    expect(sharedSuggestGates({ ...base, composing: true, hasPath: false, readOnly: true })).toBe(false);
  });

  it('只读 / 预览 / 台词 / 旁白 / 注释 / 字符串这一族"一律不弹"由两枚判据分持：共用七条 + 语言代码位门', () => {
    // ①–⑤⑫ 走共用函数（上面逐条已判）；台词 / 旁白 / 注释 / 字符串走 codeViewAt（语言侧真源）
    expect(TRIGGER).toContain('export function codeViewAt(');
    expect(TRIGGER).toContain('kojoCodePositionAt(line, column)');
    expect(TRIGGER).toContain("erbCompletionGate(line, column) !== 'in-string'");
    // 内联侧确实把它用上了（弹窗侧的答案位由⑩兜，内联侧没有⑩ ⇒ 必须直接问这一枚）
    expect(HOST).toContain('codeViewAt(languageId, lineText, column)');
  });
});

/* ============================== ③ 十二道闸点名表（机器可读） ============================== */

/**
 * 弹窗侧那十二道闸（`shouldTriggerContextSuggest` 的编号）在**内联侧**的对面：
 * - `shared`     = 两侧真共用同一个纯函数（`symbol` 就是那一个定义点）；
 * - `counterpart` = 内联侧有自己的对面判据（`symbol` 点名为哪一枚，通常是 vendor 交来的事实）；
 * - `popup-only` = 只有弹窗侧用得上，`reason` 写清为什么内联侧不适用。
 * 这张表**只是交付物**；它的一致性由下面的断言按源码文本核对，符号不存在即红。
 */
type GateKind = 'shared' | 'counterpart' | 'popup-only';
interface GateRow {
  readonly gate: string;
  readonly kind: GateKind;
  readonly symbol: string;
  readonly reason: string;
}

const GATE_ROLL_CALL: readonly GateRow[] = [
  { gate: '①无文件', kind: 'shared', symbol: 'sharedSuggestGates', reason: '同一份 hasPath 判据' },
  { gate: '②只读', kind: 'shared', symbol: 'sharedSuggestGates', reason: '同一份 readOnly 判据' },
  { gate: '③派生视图', kind: 'shared', symbol: 'sharedSuggestGates', reason: '投影上是写动作，一律不弹' },
  { gate: '④无焦点', kind: 'shared', symbol: 'sharedSuggestGates', reason: '同一份 focused 判据' },
  { gate: '⑤多光标 / 有选区', kind: 'shared', symbol: 'sharedSuggestGates', reason: '一次接受只落一个光标' },
  { gate: '⑥widget 已开', kind: 'counterpart', symbol: 'selectedSuggestionInfo', reason: '弹窗侧读 SuggestController.model.state；内联侧的对面是 vendor 交来的 context.selectedSuggestionInfo——两侧都不是"自己数一遍"' },
  { gate: '⑦不是刚敲下的一枚字符', kind: 'counterpart', symbol: 'singleInsertedChar', reason: '判据同一枚函数；对面用途不同：弹窗据此排程触发，内联据此决定是否递 triggerCharacter 并挡"没打字的一拍"（弹出时机归 Monaco）' },
  { gate: '⑧这门语言没有名字位判据', kind: 'popup-only', symbol: 'nameSlotProbesOf', reason: '内联侧不铺名字位探针：供方"不认这一位"在契约里有专门的一态（undefined = 弃权）' },
  { gate: '⑨串 / 注释内', kind: 'counterpart', symbol: 'codeViewAt', reason: '内联侧要问语言侧那枚更严的代码位门（弹窗由⑩兜住，内联没有⑩）' },
  { gate: '⑩候选源自己不信这一位', kind: 'popup-only', symbol: 'KOJO_NAME_SLOTS / ERB_NAME_SLOTS', reason: '同上：名字位探针是"宿主替作者按键"的降噪，幽灵文本的对面是契约的弃权' },
  { gate: '⑪输入时自动弹出补全（总开关）', kind: 'counterpart', symbol: 'loadInlineCompletionPref', reason: '弹窗侧的 QSUG-2 开关；幽灵文本这一条腿有自己那格偏好，落点是 Monaco 的 inlineSuggest.enabled 选项 + provider 的 pref-disabled 第二道' },
  { gate: '⑫输入法合成期', kind: 'shared', symbol: 'sharedSuggestGates', reason: '同一份 composing 判据（排在最前）' },
];

describe('③ 十二道闸点名表与源码一致', () => {
  it('每一道的符号都在源码里真存在（不许点一个不存在的名字交差）', () => {
    for (const row of GATE_ROLL_CALL) {
      for (const symbol of row.symbol.split(' / ')) {
        expect(ALL, `闸门 ${row.gate} 点名的符号不存在：${symbol}`).toContain(symbol);
      }
    }
  });

  it('表里没有"两侧各抄一份"这一档（出现即红）', () => {
    const kinds = new Set(GATE_ROLL_CALL.map((r) => r.kind));
    expect(kinds.has('copied')).toBe(false);
    expect([...kinds].sort()).toEqual(['counterpart', 'popup-only', 'shared']);
  });

  it('shared 那五道的判据函数只有 sharedSuggestGates 一枚；弹窗侧的入口仍是从它转发', () => {
    const shared = GATE_ROLL_CALL.filter((r) => r.kind === 'shared').map((r) => r.symbol);
    expect(new Set(shared).size).toBe(1);
    expect(shared[0]).toBe('sharedSuggestGates');
    expect(TRIGGER).toMatch(/export function shouldTriggerContextSuggest[\s\S]*sharedSuggestGates\(c\)/);
  });

  it('popup-only 恰好两道（⑧⑩），且理由都写着"对面是契约的弃权"', () => {
    const only = GATE_ROLL_CALL.filter((r) => r.kind === 'popup-only').map((r) => r.gate);
    expect(only).toEqual(['⑧这门语言没有名字位判据', '⑩候选源自己不信这一位']);
    for (const row of GATE_ROLL_CALL.filter((r) => r.kind === 'popup-only')) {
      expect(row.reason).toContain('弃权');
    }
  });

  it('内联侧的名字位探针一次都不问（真抄了第二份的话，这里先红）', () => {
    expect(HOST).not.toContain('KOJO_NAME_SLOTS');
    expect(HOST).not.toContain('ERB_NAME_SLOTS');
    expect(HOST).not.toContain('nameSlotProbesOf');
    expect(HOST).not.toContain('suggestNameSlotGates');
  });

  it('闸门名的集合与源码里的 skip 调用逐一对上（改了名字没改表 = 红）', () => {
    const gates = [...HOST.matchAll(/return skip\('([^']+)'\)/g)].map((m) => m[1]);
    expect(gates.slice().sort()).toEqual(
      [
        'already-cancelled',
        'non-code-position',
        'not-completions-requested',
        'not-just-typed',
        'pref-disabled',
        'shared-gates',
        'suggest-widget-visible',
        'unknown-model',
      ].sort(),
    );
    // 第九道是"问完才发现没观众"：`cancelled` 走 finish 而不是 skip，仍要在这份文本里
    expect(HOST).toContain("gateSkipped: wasCancelled ? 'cancelled' : null");
  });
});
