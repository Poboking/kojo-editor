/**
 * 变量名词典缺失/读失败的一次性台账 + 文案表 + 分层守卫（TW-DICT-VISIBLE）。
 *
 * 钉的是判据而不是字符串运气，五组闸：
 * 1. **台账三条真实行为**：同一项目同一原因第二次**不再说**；换项目 / 换原因 / 换路径**要说**；
 *    台账有界（到阈值整表清空）。
 * 2. **上屏点**（走 `reportDictionaryStatus` 这条真入口，不是只测纯函数）：缺词典连调两次
 *    ⇒ `notify` 恰好 **1** 次；陈述缺省 / `loaded: true` ⇒ **不出声**（契约红线：
 *    "没陈述"不许当成失败）。
 * 3. **文案表**：原因闭集两格各一句人话，正文**零 ASCII 字母**、零机器词；原因与路径逐字
 *    进悬停；严重度 `info`（六秒自己走，不打断编辑）。
 * 4. **分层守卫（静态扫源码，连注释一起看）**：句子只住本文件这张表——适配器侧只有
 *    `log.warn` 与事实陈述，宿主接线只有 `App.openProject` 那一条调用；多一处即红。
 * 5. **匹配口径**：`variableSchemaFor` 按 `adapterId` 精确取表，找不到同 id 的贡献 ⇒
 *    `undefined`（不跨适配器借表）。
 *
 * revert-prove-red：把 `reportDictionaryStatus` 里的 `notify(...)` 注释掉、或把
 * `claimDictionaryNotice` 换成恒 `said: true` ⇒ 第 1 / 2 组当场红；恢复后绿。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type { GameAdapter, VariableSchema } from '@kojo/plugin-api';
import type { NoticeInput, Notify } from '../src/ui/NotificationCenter';
import {
  DICTIONARY_NOTICE_LEDGER_MAX,
  DICTIONARY_NOTICE_MACHINE_WORDS,
  claimDictionaryNotice,
  dictionaryNoticeCopy,
  dictionaryNoticeDetail,
  dictionaryNoticeInput,
  dictionaryNoticeKey,
  dictionaryNoticeTextTable,
  reportDictionaryStatus,
  resetDictionaryNoticeLedger,
  variableSchemaFor,
  type DictionaryNoticeFacts,
} from '../src/ui/dictionary-notice-ledger';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

const facts = (over: Partial<DictionaryNoticeFacts> = {}): DictionaryNoticeFacts => ({
  projectRoot: 'C:/game/eratw',
  status: { loaded: false, reason: 'missing', path: 'C:/game/eratw/plugins/tw_csv_chs.xml' },
  ...over,
});

const schemaWithDictionary = (status: VariableSchema['dictionary']): VariableSchema =>
  ({
    version: '1',
    ...(status !== undefined ? { dictionary: status } : {}),
    lookup: () => undefined,
  }) as VariableSchema;

beforeEach(() => {
  resetDictionaryNoticeLedger();
});

describe('台账 · 三条真实行为', () => {
  it('同一项目同一原因：第二次不再说（纯函数腿）', () => {
    const seen = new Set<string>();
    expect(claimDictionaryNotice(facts(), seen)).toEqual({
      said: true,
      key: dictionaryNoticeKey(facts()),
    });
    expect(claimDictionaryNotice(facts(), seen).said).toBe(false);
    expect(seen.size).toBe(1);
  });

  it('换项目 / 换原因 / 换路径：要说（身份 = 项目 + 原因 + 路径）', () => {
    const seen = new Set<string>();
    expect(claimDictionaryNotice(facts(), seen).said).toBe(true);
    expect(claimDictionaryNotice(facts({ projectRoot: 'D:/game/eratw' }), seen).said).toBe(true);
    expect(
      claimDictionaryNotice(
        facts({ status: { loaded: false, reason: 'read-error', path: 'C:/game/eratw/plugins/tw_csv_chs.xml' } }),
        seen,
      ).said,
    ).toBe(true);
    expect(
      claimDictionaryNotice(
        facts({ status: { loaded: false, reason: 'missing', path: 'C:/game/eratw/plugins/other.xml' } }),
        seen,
      ).said,
    ).toBe(true);
    expect(seen.size).toBe(4);
  });

  it('台账有界：到阈值整表清空（长跑会话不把内存喂给一张只增的表）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < DICTIONARY_NOTICE_LEDGER_MAX; i++) {
      expect(claimDictionaryNotice(facts({ projectRoot: `C:/game/${i}` }), seen).said).toBe(true);
    }
    expect(seen.size).toBe(DICTIONARY_NOTICE_LEDGER_MAX);
    expect(claimDictionaryNotice(facts({ projectRoot: 'C:/game/next' }), seen).said).toBe(true);
    expect(seen.size).toBe(1);
  });
});

describe('上屏点 · 一次会话只说一遍（真入口）', () => {
  function recordingNotify() {
    const calls: NoticeInput[] = [];
    const notify = ((input: NoticeInput) => void calls.push(input)) as unknown as Notify;
    return { calls, notify };
  }

  it('缺词典：连调两次 ⇒ notify 恰好 1 次；第二次返回 false', () => {
    const { calls, notify } = recordingNotify();
    const schema = schemaWithDictionary({ loaded: false, reason: 'missing', path: 'C:/game/eratw/plugins/tw_csv_chs.xml' });
    expect(reportDictionaryStatus(notify, 'C:/game/eratw', schema)).toBe(true);
    expect(reportDictionaryStatus(notify, 'C:/game/eratw', schema)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('info');
    expect(calls[0]!.message).toBe(dictionaryNoticeCopy(facts()).text);
    expect(calls[0]!.detail).toContain('C:/game/eratw/plugins/tw_csv_chs.xml');
    expect(calls[0]!.detail).toContain('missing');
  });

  it('陈述缺省 / loaded: true / 没有 schema ⇒ 一律不出声（不猜、不假警报）', () => {
    const { calls, notify } = recordingNotify();
    expect(reportDictionaryStatus(notify, 'C:/game/eratw', undefined)).toBe(false);
    expect(reportDictionaryStatus(notify, 'C:/game/eratw', schemaWithDictionary(undefined))).toBe(false);
    expect(
      reportDictionaryStatus(
        notify,
        'C:/game/eratw',
        schemaWithDictionary({ loaded: true, path: 'C:/game/eratw/plugins/tw_csv_chs.xml' }),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('换项目再说一遍（上一个项目的沉默不连坐）；呈现面抛错不吃掉开项目', () => {
    const { calls, notify } = recordingNotify();
    const schema = schemaWithDictionary({ loaded: false, reason: 'read-error', path: 'C:/x.xml' });
    expect(reportDictionaryStatus(notify, 'C:/game/a', schema)).toBe(true);
    expect(reportDictionaryStatus(notify, 'C:/game/b', schema)).toBe(true);
    expect(calls).toHaveLength(2);

    const boom = (() => {
      throw new Error('通知链路炸了');
    }) as unknown as Notify;
    expect(() =>
      reportDictionaryStatus(boom, 'C:/game/c', schemaWithDictionary({ loaded: false, reason: 'missing' })),
    ).not.toThrow();
  });
});

describe('文案表 · 作者面说人话', () => {
  it('原因闭集两格齐全、互不相同（不许留白、不许抄近路共用）', () => {
    const table = dictionaryNoticeTextTable();
    expect(Object.keys(table).sort()).toEqual(['missing', 'read-error']);
    expect(new Set(Object.values(table)).size).toBe(2);
    for (const text of Object.values(table)) expect(text.length).toBeGreaterThan(8);
  });

  it('正文零机器词：ASCII 字母一个都不许出现；两种原因都说得清"按原文显示、不影响编辑"', () => {
    for (const reason of ['missing', 'read-error'] as const) {
      const copy = dictionaryNoticeCopy(
        facts({ status: { loaded: false, reason, path: 'C:/game/eratw/plugins/tw_csv_chs.xml' } }),
      );
      expect(copy.text).not.toMatch(/[A-Za-z]/);
      for (const word of DICTIONARY_NOTICE_MACHINE_WORDS) expect(copy.text).not.toContain(word);
      // 后果与"编辑照常"两句都要在：只报"缺词典"不说后果等于把谜语丢给作者
      expect(copy.text).toContain('原文');
      expect(copy.text).toContain('不影响编辑');
      expect(copy.kind).toBe('info');
    }
  });

  it('路径与原因逐字进悬停（技术信息一条不丢），正文不含它们', () => {
    const subject = facts({
      status: { loaded: false, reason: 'read-error', path: 'C:/game/eratw/plugins/tw_csv_chs.xml' },
    });
    const copy = dictionaryNoticeCopy(subject);
    expect(copy.detail).toBe(dictionaryNoticeDetail(subject));
    expect(copy.detail).toContain('C:/game/eratw/plugins/tw_csv_chs.xml');
    expect(copy.detail).toContain('read-error');
    expect(copy.text).not.toContain('C:/game/eratw/plugins/tw_csv_chs.xml');
    expect(dictionaryNoticeInput(subject).detail).toBe(copy.detail);
  });

  it('闭集外不许崩：插件将来报第三种原因 ⇒ 落到兜底句而不是 undefined', () => {
    const odd = facts({ status: { loaded: false, reason: 'weird' as 'missing' } });
    const copy = dictionaryNoticeCopy(odd);
    expect(copy.text.length).toBeGreaterThan(8);
    expect(copy.text).not.toMatch(/[A-Za-z]/);
    expect(copy.text).toContain('不影响编辑');
    expect(copy.detail).toContain('weird');
  });
});

describe('匹配口径 · variableSchemaFor 按 adapterId 精确取表', () => {
  const adapter = (gameId: string, schema?: VariableSchema): GameAdapter =>
    ({ gameId, detect: async () => true, loadProject: async () => ({}) as never, ...(schema ? { variableSchema: schema } : {}) }) as unknown as GameAdapter;

  it('命中同 id ⇒ 那枚表；找不到 ⇒ undefined（不借别的适配器的表）', () => {
    const schema = schemaWithDictionary({ loaded: false, reason: 'missing' });
    const kernel = {
      slots: { query: () => [{ adapter: adapter('eratw', schema) }, { adapter: adapter('other') }] },
    } as unknown as Kernel;
    expect(variableSchemaFor(kernel, 'eratw')).toBe(schema);
    expect(variableSchemaFor(kernel, 'absent')).toBeUndefined();
  });
});

describe('分层守卫 · 静态扫源码（连注释一起看）', () => {
  const LEDGER = read('packages', 'app', 'src', 'ui', 'dictionary-notice-ledger.ts');
  const APP = read('packages', 'app', 'src', 'ui', 'App.tsx');
  // REF-FRONT-PERF 起 openProject 搬进 use-project-session；宿主接线两处同扫、处数仍只许 1
  const SESSION = read('packages', 'app', 'src', 'ui', 'use-project-session.ts');
  const ADAPTER = read('packages', 'plugins', 'eratw-adapter', 'src', 'variable-schema.ts');

  it('句子只住台账：两格文案在宿主接线与适配器里逐字反查，命中一处即红', () => {
    for (const text of Object.values(dictionaryNoticeTextTable())) {
      expect(APP.includes(text), `正文句子写进了 App.tsx：${text}`).toBe(false);
      expect(SESSION.includes(text), `正文句子写进了 use-project-session.ts：${text}`).toBe(false);
      expect(ADAPTER.includes(text), `正文句子写进了适配器：${text}`).toBe(false);
    }
    // 作者面句式也不许在适配器冒出（哪怕换了措辞）
    for (const phrase of ['按游戏原文显示', '不影响编辑']) {
      expect(ADAPTER, `适配器出现了作者面句式「${phrase}」`).not.toContain(phrase);
    }
  });

  it('适配器仍只有 log.warn + 事实陈述：不许碰通知中心 / 不许自带上屏通道', () => {
    const importLines = ADAPTER.split('\n').filter((line) => /^\s*(import|require)\b/.test(line));
    expect(importLines.filter((l) => l.includes('NotificationCenter'))).toEqual([]);
    expect(importLines.filter((l) => l.includes('dictionary-notice-ledger'))).toEqual([]);
    expect(ADAPTER).not.toMatch(/\bnotify\(/);
    // 事实陈述确实在（否则本批等于没接）
    expect(ADAPTER).toContain('dictionary: dictionaryStatus');
    expect(ADAPTER).toContain('classifyDictionaryReadFailure');
  });

  it('宿主接线只有一处：openProject 里调真入口，且不另立显示面', () => {
    const host = `${APP}\n${SESSION}`;
    expect(host.match(/reportDictionaryStatus\(notify,/g) ?? []).toHaveLength(1);
    expect(SESSION).toContain("from './dictionary-notice-ledger'");
    // 不许在宿主接线里自造文案 / 第二套 toast 模板
    expect(host).not.toMatch(/notify\(\{[^}]*变量名汉化词典/);
    expect(LEDGER).not.toMatch(/statusBar|badge/i);
  });
});
