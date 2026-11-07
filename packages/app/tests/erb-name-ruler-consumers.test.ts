import { describe, expect, it } from 'vitest';
import { ERB_NAME_RUN_SOURCE } from '@kojo/plugin-api/erb-lexical';
import { findNameTokenPositions } from '../src/ui/reference-utils';

/**
 * D01b（2026-11-06）：宿主侧「按名取词」的两处消费方换到**引擎名字尺**之后的回退闸。
 *
 * 换尺前后的分歧只用**真会碎的名字**钉形（`·` U+00B7、全角 `％`、`（シリーズ毎）`）：
 * 这些形状在引擎眼里是**一枚**名字，而旧记号尺（`MODEL_TOKEN_CLASS`）把它们切开——
 * 切开之后整串相等判据永远落空，于是"生成这次改名的糖源"被当成与本动作无关跳过，
 * 改了 `.erb` 没改 `.kojo1` ⇒ 下次保存把改名冲掉（数据损坏级，见本模块头注）。
 */

/** 台账的检索词闸门（`ui/name-ledger.ts` 的 NAME_TOKEN_RE 同一判据形态） */
const LEDGER_GATE_RE = new RegExp(`^${ERB_NAME_RUN_SOURCE}+$`, 'u');

describe('D01b 宿主取词换尺：名字台账（检索词是否算一枚名字）', () => {
  it('含 · / 全角％ / 全角括号的名字是一枚名字（旧记号尺下会被判"不是名字"）', () => {
    for (const word of ['P23温泉·更衣间', '100％（シリーズ毎）', '问候。処理']) {
      expect(LEDGER_GATE_RE.test(word), `${word} 应被认作一枚引擎名字`).toBe(true);
      expect(new RegExp(`^[\\p{L}\\p{N}_]+$`, 'u').test(word), `${word} 旧尺的形状（对照用）`).toBe(false);
    }
  });

  it('正则检索词 / 带空格短语 / 带冒号的引用形状仍不是一枚名字（`.` `%` `(` `:` 都是引擎分隔符）', () => {
    for (const notName of ['问候.*', 'P23 温泉', 'a-b', 'A.B', '%CALLNAME%', 'A[0]', '']) {
      expect(LEDGER_GATE_RE.test(notName), `${notName} 不该被当名字`).toBe(false);
    }
  });
});

describe('D01b 宿主取词换尺：糖源候选定位（findNameTokenPositions）', () => {
  const text = [
    '函数 P23温泉·更衣间',
    '  CALL P23温泉·更衣间',
    'AFTERMARKET_MESSAGE = 100％（シリーズ毎）',
    'CALL FOO',
    '',
  ].join('\n');

  it('引擎眼里的一枚名字 = 一整处命中（旧尺切开后整串相等落空 ⇒ 0 处）', () => {
    const hits = findNameTokenPositions(text, 'P23温泉·更衣间');
    expect(hits).toEqual([
      { line: 1, column: 4, endColumn: 4 + 'P23温泉·更衣间'.length, text: 'P23温泉·更衣间' },
      { line: 2, column: 8, endColumn: 8 + 'P23温泉·更衣间'.length, text: 'P23温泉·更衣间' },
    ]);
    // 反证（改前形状）：同一串按记号尺切，名字被劈成两段 ⇒ 整串相等永不成立
    const oldRuns = 'P23温泉·更衣间'.match(/[\p{L}\p{N}_]+/gu);
    expect(oldRuns).toEqual(['P23温泉', '更衣间']);
  });

  it('全角％与全角括号连成一枚名字（IF 比较式里的形状）', () => {
    expect(findNameTokenPositions(text, '100％（シリーズ毎）')).toEqual([
      { line: 3, column: 23, endColumn: 23 + '100％（シリーズ毎）'.length, text: '100％（シリーズ毎）' },
    ]);
  });

  it('ASCII 记号名零改动（旧尺新尺同形：既有消费方不受影响）', () => {
    expect(findNameTokenPositions(text, 'FOO').map((p) => [p.line, p.column, p.endColumn])).toEqual([[4, 6, 9]]);
    expect(findNameTokenPositions(text, '')).toEqual([]);
  });

  it('大小写不敏感 + 分隔符边界：名字贴在分隔符两侧才算命中', () => {
    expect(findNameTokenPositions('CALL foo-bar\n', 'FOO-BAR')).toEqual([]); // `-` 是引擎分隔符 ⇒ 没有 "foo-bar" 这枚名字
    expect(findNameTokenPositions('CALL foo_bar\n', 'FOO_BAR')).toEqual([{ line: 1, column: 6, endColumn: 13, text: 'foo_bar' }]);
  });
});
