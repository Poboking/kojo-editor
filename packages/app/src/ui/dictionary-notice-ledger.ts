import type { Kernel } from '@kojo/kernel';
import type { VariableDictionaryStatus, VariableSchema } from '@kojo/plugin-api';
import type { Notify, NoticeInput } from './NotificationCenter';

/**
 * 变量名词典缺失/读失败的**一次性台账 + 作者面文案表**（TW-DICT-VISIBLE）。
 *
 * ## 要修的是哪一种哑
 *
 * 适配器读不到变量名汉化词典时只打一条 `log.warn`，然后拿空词典继续 ⇒ 变量名回落游戏原文。
 * 契约面（`VariableSchema.dictionary`，TW-DICT-VISIBLE 那一批加的）现在会陈述这件事，
 * 但**没人接**就还是静默：作者看到一屏原文名，无从判断"这游戏没带词典"还是"编辑器不认"。
 * 本文件就是那条接到屏幕上的线：项目打开、schema 就绪后读一次陈述，`loaded: false` ⇒
 * 一条 toast；同一会话同一身份 ⇒ 只那一条。**不打断编辑**（info，六秒自己走）。
 *
 * ## 身份与一次性（形状照 `ui/format-notice-ledger.ts` 的 claim/ledger，不自创算法）
 *
 * - **去重键 = 项目根 + 原因 + 词典路径**：同一个项目同一种失败一次会话只说一遍；
 *   换一个项目（同样缺词典）仍会说——那是另一位作者的另一个工程，不该被上一个项目的
 *   沉默连坐；同一个项目从"读失败"变成"文件没了"是不同现场，也会再说一遍。
 * - **会话级内存，不持久化**：台账是一张模块级 `Set`，重启后允许再说一次。有界
 *   （超过 {@link DICTIONARY_NOTICE_LEDGER_MAX} 整表清空），长跑会话不把内存喂给一张只增的表。
 *
 * ## 分层（文案为什么住这一侧）
 *
 * 提供方（`plugins/eratw-adapter/src/variable-schema.ts`）**只有** `log.warn` 与事实陈述
 * 两件事，上屏文案一个字都不许长在那一侧——句子只住本文件这张表
 * （`tests/dictionary-notice-ledger.test.ts` 的静态闸按源码形态反查，多一处即红）。
 * 宿主侧接线也只有一处：`App.openProject` 在 `kernel.project.open()` 返回后调
 * {@link reportDictionaryStatus}（此时 `loadProject` 已把 schema 填好，见 `project.ts` 的
 * `project.opened` 时序）。
 */

/** 台账整表清空的阈值（有界性；与 `format-notice-ledger.ts` 同一做法） */
export const DICTIONARY_NOTICE_LEDGER_MAX = 200;

/** 词典陈述的原因闭集（与契约 `VariableDictionaryStatus['reason']` 一一对应） */
type DictionaryReason = NonNullable<VariableDictionaryStatus['reason']>;

/** 一次上屏判定的输入：哪个项目的什么陈述 */
export interface DictionaryNoticeFacts {
  /** 当前项目根（只在悬停的技术原文里出现；同时是去重键的一部分） */
  readonly projectRoot: string;
  readonly status: VariableDictionaryStatus;
}

/** 一次陈述在会话台账里的身份：项目 + 原因 + 词典路径（口径见模块头注） */
export function dictionaryNoticeKey(facts: DictionaryNoticeFacts): string {
  return [facts.projectRoot, facts.status.reason ?? '', facts.status.path ?? ''].join('\u0000');
}

export interface DictionaryNoticeClaim {
  /** `true` = 这个身份本次会话还没说过（调用方该上屏）；`false` = 说过，什么都不做 */
  readonly said: boolean;
  readonly key: string;
}

/**
 * 台账的**纯函数内核**：输入事实与"已说过的键集合"，输出这次该不该说。
 * 集合由调用方持有（会话台账是模块级那张，测试可以自带一张）；命中即登记，不重复登记。
 */
export function claimDictionaryNotice(
  facts: DictionaryNoticeFacts,
  seen: Set<string>,
): DictionaryNoticeClaim {
  const key = dictionaryNoticeKey(facts);
  if (seen.has(key)) return { said: false, key };
  if (seen.size >= DICTIONARY_NOTICE_LEDGER_MAX) seen.clear();
  seen.add(key);
  return { said: true, key };
}

/**
 * 作者面文案表：两种原因各一句人话。
 *
 * 两档都要说清三件事：**没读到词典**、**后果是名字按原文显示**、**编辑照常**。
 * 正文零机器词（连 ASCII 字母都不许出现）；原因与路径逐字进悬停。
 */
const NOTICE_TEXT: Record<DictionaryReason, string> = {
  missing: '这个项目没带变量名汉化词典，变量名会按游戏原文显示（不影响编辑）。',
  'read-error': '变量名汉化词典这次没能读出来，变量名会按游戏原文显示（不影响编辑）。',
};

/** 闭集外的兜底句（插件是外部实现，运行时不保证只报那两种原因） */
const NOTICE_TEXT_UNKNOWN = '变量名汉化词典这次没能用上，变量名会按游戏原文显示（不影响编辑）。';

export interface DictionaryNoticeCopy {
  /** 第一眼：作者读得懂的中文短句，零机器词 */
  readonly text: string;
  /** 悬停：逐字技术原文（项目 / 词典路径 / 原因，一条不丢） */
  readonly detail: string;
  /** 严重度：词典缺席只是名称显示降级，`info` 六秒自己走（不打断编辑） */
  readonly kind: 'info';
}

/** 悬停里的技术原文（机器面不动：路径与原因逐字跟在后面） */
export function dictionaryNoticeDetail(facts: DictionaryNoticeFacts): string {
  return (
    `变量名词典 · 项目=${facts.projectRoot}` +
    ` · 文件=${facts.status.path ?? '（未陈述）'}` +
    ` · 原因=${facts.status.reason ?? '（未陈述）'}`
  );
}

/** 陈述 → 上屏那一格的内容（纯查表，零判定；闭集外的原因落到兜底句） */
export function dictionaryNoticeCopy(facts: DictionaryNoticeFacts): DictionaryNoticeCopy {
  const reason = facts.status.reason;
  const text =
    reason === 'missing' || reason === 'read-error' ? NOTICE_TEXT[reason] : NOTICE_TEXT_UNKNOWN;
  return { text, detail: dictionaryNoticeDetail(facts), kind: 'info' };
}

/** 陈述 → 通知中心的一条输入（`message` 是人话，`detail` 逐字进悬停） */
export function dictionaryNoticeInput(facts: DictionaryNoticeFacts): NoticeInput {
  const copy = dictionaryNoticeCopy(facts);
  return { kind: copy.kind, message: copy.text, detail: copy.detail };
}

/** 本会话已经说过的词典陈述身份（键见 {@link dictionaryNoticeKey}；不落盘，重启即清零） */
const sessionLedger = new Set<string>();

/**
 * 当前项目那枚适配器的变量字典（**运行时现取**；适配器随项目开闭重建，缓存会带错项目）。
 * 与 `ui/editor-global-providers.ts` 的 `editorTables` 同一条匹配口径：按 `adapterId` 精确匹配
 * `game.adapter` 槽位贡献；没有同 id 的贡献 ⇒ `undefined`（不猜、不跨适配器借表）。
 */
export function variableSchemaFor(kernel: Kernel, adapterId: string): VariableSchema | undefined {
  for (const contribution of kernel.slots.query('game.adapter')) {
    if (contribution.adapter.gameId === adapterId) return contribution.adapter.variableSchema;
  }
  return undefined;
}

/**
 * 词典降级的**上屏入口**（`App.openProject` 里 `kernel.project.open()` 返回后调这一次）。
 *
 * 返回 `true` = 这条是新身份、已递给通知中心；`false` = 没有可说的（陈述缺省 / `loaded` 非
 * `false`）或本次会话说过同样的话，什么都不做。陈述缺省**不算失败**：那是"实现没陈述"，
 * 消费方不得据此上屏（契约 `VariableSchema.dictionary` 的红线）。
 */
export function reportDictionaryStatus(
  notify: Notify,
  projectRoot: string,
  schema: VariableSchema | undefined,
): boolean {
  const status = schema?.dictionary;
  // 只有显式 `loaded: false` 是可上屏的事实；缺省 / true 一律不出声
  if (status === undefined || status.loaded !== false) return false;
  const facts: DictionaryNoticeFacts = { projectRoot, status };
  if (!claimDictionaryNotice(facts, sessionLedger).said) return false;
  try {
    notify(dictionaryNoticeInput(facts));
  } catch {
    /* 呈现面抛错不许打断开项目（通知链路炸了最多是少一条 toast） */
  }
  return true;
}

/** 清会话台账（测试复位用） */
export function resetDictionaryNoticeLedger(): void {
  sessionLedger.clear();
}

/** 文案表的闭集读数（静态闸拿它对照原因联合类型，少一格即红；只读视图，改不动本体） */
export function dictionaryNoticeTextTable(): Readonly<Record<DictionaryReason, string>> {
  return NOTICE_TEXT;
}

/** 机器词名单（静态闸拿它查正文；导出来只为让测试不必抄第二份名单） */
export const DICTIONARY_NOTICE_MACHINE_WORDS: readonly string[] = [
  'missing',
  'read-error',
  'loaded',
  'dictionary',
  'schema',
  'VariableSchema',
  'undefined',
];
