/**
 * F12-TOKEN（2026-10-19）：中文函数名上的**转到定义 / 查找引用**取词尺。
 *
 * 改前这两条腿用契约 `symbolTokenAt` 的缺省 ASCII 集，中文函数名量不出记号 ⇒
 * `byName` 查不到 ⇒ 一律"没有定义"。真实语料读数（同文件
 * `references.corpus.test.ts` 里钉成可复跑断言的那一份）：含非 ASCII 的 `@` 定义名
 * 25,003 条，在 50,006 个名字点位上 ASCII 尺只答出 61 次（0.12%），换尺后 49,848 次
 * （99.68%）。
 *
 * 判据落点只有一处：`references.ts::functionNameTokenAt`（契约 `MODEL_TOKEN_CLASS`
 * 那一把 Unicode 尺 + `colonAdjacent` 成员冒号退让）。转到定义与查找引用**共用这同一枚
 * 函数**，不再各写取词；契约的 ASCII 缺省**一字未动**，因为它服务的是另一条腿
 * （宿主悬停 / 补全的**原生名反查表**，那些表的键就是 ASCII 原生名）。
 *
 * 夹具一律走生产路径（`parseErbText` + `aggregateIndex` + `scanFileRefs`）：手搓
 * `ErbIndex` 字面量会把"索引长什么样"钉死在测试里，真实解析变了测试仍绿，那就白测。
 */
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex, ErbReferenceIndex } from '@kojo/plugin-api';
import { symbolTokenAt } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import { definitionTargetsAt } from '../src/symbols';
import { buildReferenceIndex, erbReferenceLocationsAt, functionNameTokenAt, scanFileRefs } from '../src/references';

const A = 'C:\\proj\\ERB\\A.ERB';

/** 解析 → 聚合 → 反向引用索引（生产路径的三趟，一条都不省） */
function indexOf(files: { path: string; text: string }[]): ErbIndex {
  const parsed: ErbFile[] = files.map((f) => parseErbText(f.text, f.path));
  const agg = aggregateIndex(parsed);
  const refsByPath = new Map(parsed.map((f) => [f.path, scanFileRefs(files.find((x) => x.path === f.path)!.text, (upper) => agg.byName.has(upper))]));
  const references: ErbReferenceIndex = buildReferenceIndex(parsed, refsByPath);
  return { files: agg.files, byName: agg.byName, references };
}

/** 名字所在列（1 基，从原文现算，不硬编码） */
const col = (line: string, name: string): number => line.indexOf(name) + 1;
const nth = (text: string, n: number): string => text.split('\n')[n - 1]!;

describe('functionNameTokenAt · 光标处函数名的唯一取词判据', () => {
  it('中文 / 中英混排 / 全角字母的函数名整串命中；词内任意格与尾后一格同整串', () => {
    const line = 'CALL 充填率(1)';
    const start = col(line, '充填率');
    expect(functionNameTokenAt(line, start)?.text).toBe('充填率');
    expect(functionNameTokenAt(line, start + 1)?.text).toBe('充填率');
    expect(functionNameTokenAt(line, start + '充填率'.length)?.text).toBe('充填率');
    const mixed = '@SHOW_上半身内衣(ARG)';
    expect(functionNameTokenAt(mixed, col(mixed, 'SHOW_上半身内衣'))?.text).toBe('SHOW_上半身内衣');
    const fullWidth = '@ＭＡＸ_容量';
    expect(functionNameTokenAt(fullWidth, col(fullWidth, 'ＭＡＸ_容量'))?.text).toBe('ＭＡＸ_容量');
    // 契约那把尺就是 `[\p{L}\p{N}_]`（半角下划线才在集里）：全角 `＿`（U+FF3F）是连接号不是
    // 字母数字 ⇒ 名字里带它的仍然被切断。这是 `MODEL_TOKEN_CLASS` 既有口径（反向索引同一条），
    // 本批不动它——要动的是消费方选哪把尺，不是尺上的字符。
    expect(functionNameTokenAt('@ＦＵＮ＿１', 3)?.text).toBe('ＦＵＮ');
    // 对照：契约 ASCII 那把尺照旧窄（本批一字未动，它服务原生名反查表）
    expect(symbolTokenAt(line, start)).toBeUndefined();
  });

  it('成员访问整体不算函数名：`CFLAG:FOO` 两段都不给（既不整串给，也不留两个可用记号）', () => {
    const line = 'IF CFLAG:充填率 == 1';
    expect(functionNameTokenAt(line, col(line, '充填率'))).toBeUndefined();
    expect(functionNameTokenAt(line, col(line, '充填率') + 1)).toBeUndefined();
    expect(functionNameTokenAt(line, col(line, 'CFLAG'))).toBeUndefined();
    const half = 'PRINT ALPHA:FOO';
    expect(functionNameTokenAt(half, col(half, 'FOO'))).toBeUndefined();
    expect(functionNameTokenAt(half, col(half, 'ALPHA'))).toBeUndefined();
    const fullColon = 'PRINT ：充填率';
    expect(functionNameTokenAt(fullColon, col(fullColon, '充填率'))).toBeUndefined();
    // 反向钉：这条退让是新判据——ASCII 尺原本会把 FOO 单独交出去
    expect(symbolTokenAt(half, col(half, 'FOO'))?.text).toBe('FOO');
  });

  it('列口径与 `symbolTokenAt` 逐字一致：0 / 负 / NaN / 超过行宽 + 1 ⇒ undefined（不猜）', () => {
    const line = '充填率'; // 3 个码元
    expect(line.length).toBe(3);
    expect(functionNameTokenAt(line, 0)).toBeUndefined();
    expect(functionNameTokenAt(line, -3)).toBeUndefined();
    expect(functionNameTokenAt(line, Number.NaN)).toBeUndefined();
    expect(functionNameTokenAt(line, 4)).toBeDefined(); // 行宽 3 ⇒ 列 4 = 尾后一格，命中
    expect(functionNameTokenAt(line, 5)).toBeUndefined();
    expect(functionNameTokenAt('', 1)).toBeUndefined();
    expect(functionNameTokenAt('  ', 2)).toBeUndefined();
  });
});

describe('转到定义 · 中文函数名（①：回退判据即红）', () => {
  const NAME = '好感度检查';
  const TEXT = [
    `@${NAME}(ARG)`,
    '\tPRINTFORMW "甲"',
    '',
    '@CALLER',
    `\tCALL ${NAME}(2)`,
    `\tPRINT ${NAME}`,
  ].join('\n');
  const index = indexOf([{ path: A, text: TEXT }]);
  const defLine = nth(TEXT, 1);
  const callLine = nth(TEXT, 5);
  const mentionLine = nth(TEXT, 6);

  it('定义行名字上按 F12 ⇒ 命中该定义（带名字列）', () => {
    expect(definitionTargetsAt(index, A, TEXT, 1, col(defLine, NAME))).toEqual([
      { name: NAME, normalizedName: NAME, filePath: A, startLine: 1, endLine: 3, nameColumn: 2 },
    ]);
  });

  it('CALL 名字槽与表达式里的提及都命中（与悬停第 5 路对称，不再有"悬停查得到、F12 跳不动"）', () => {
    expect(definitionTargetsAt(index, A, TEXT, 5, col(callLine, NAME))).toHaveLength(1);
    expect(definitionTargetsAt(index, A, TEXT, 6, col(mentionLine, NAME))).toHaveLength(1);
  });

  it('查找引用是同一条取词腿：中文名的引用点全集给得出，分类随位置走', () => {
    const refs = erbReferenceLocationsAt(index, TEXT, 5, col(callLine, NAME));
    expect(refs.map((r) => r.kind)).toEqual(['definition', 'call', 'mention']);
  });

  it('索引里没有的中文词 ⇒ 空数组（放宽尺子不等于"什么都给个答案"）', () => {
    const line = '\tIF 未知中文词 >= 1';
    expect(definitionTargetsAt(index, A, `${line}\n`, 1, col(line, '未知中文词'))).toEqual([]);
  });
});

describe('优先序 · 同一位置既是库表中文名又是函数名（③）', () => {
  // 真实语料里这一类点位就是基础库中文函数（`充填率` 等 13 条：库表恒等条目 13/13 在索引里有 `@` 定义）
  const NAME = '充填率';
  const TEXT = [`@${NAME}`, '\tRETURN 1', '', '@调用方', `$${NAME}`, `\tGOTO ${NAME}`, `\tCALL ${NAME}(1)`].join('\n');
  const index = indexOf([{ path: A, text: TEXT }]);

  it('函数索引先答：CALL 名字槽上的 `充填率` 走函数腿，给定义行 1（库表那一路进不了 F12）', () => {
    const callLine = nth(TEXT, 7);
    expect(definitionTargetsAt(index, A, TEXT, 7, col(callLine, NAME))).toEqual([
      expect.objectContaining({ name: NAME, startLine: 1 }),
    ]);
  });

  it('`$` 标签腿优先于函数腿：同名标签的定义行上按 F12 给标签出现点，不给函数定义', () => {
    const labelLine = nth(TEXT, 5);
    expect(definitionTargetsAt(index, A, TEXT, 5, col(labelLine, NAME))).toEqual([
      expect.objectContaining({ name: NAME, startLine: 5, endLine: 5, nameColumn: 2 }),
    ]);
  });

  it('跳转目标一侧不落函数名：有同名标签给标签，没有标签给空数组（宁可不跳）', () => {
    const gotoLine = nth(TEXT, 6);
    expect(definitionTargetsAt(index, A, TEXT, 6, col(gotoLine, NAME))).toEqual([
      expect.objectContaining({ startLine: 5 }),
    ]);
    const looseText = `@${NAME}\n@调用方\n\tGOTO ${NAME}\n\tCALL ${NAME}\n`;
    const loose = indexOf([{ path: A, text: looseText }]);
    expect(definitionTargetsAt(loose, A, looseText, 3, 7)).toEqual([]);
    expect(definitionTargetsAt(loose, A, looseText, 4, 7)).toHaveLength(1);
  });

  it('成员访问位上的中文函数名不算函数引用：反向索引与两条腿同一判据', () => {
    const text = `@${NAME}\n\tIF CFLAG:${NAME} == 1\n\tCALL ${NAME}(1)\n`;
    const idx2 = indexOf([{ path: A, text }]);
    const memberLine = nth(text, 2);
    expect(definitionTargetsAt(idx2, A, text, 2, col(memberLine, NAME))).toEqual([]);
    expect(erbReferenceLocationsAt(idx2, text, 2, col(memberLine, NAME))).toEqual([]);
    // 同名的真调用点照旧给得出（退让只挡冒号那一格）
    expect(definitionTargetsAt(idx2, A, text, 3, col(nth(text, 3), NAME))).toHaveLength(1);
  });
});

describe('散文行反向钉（④：既有行为不变）', () => {
  const NAME = '好感度检查';
  const TEXT = [
    `@${NAME}`,
    `; 写了好感度检查的那段说明`,
    '; 中文散文里的一个词',
    `\tPRINTL "${NAME}"`,
    '\tPRINTL "普通中文台词"',
  ].join('\n');
  const index = indexOf([{ path: A, text: TEXT }]);

  it('注释 / 台词里**整串不等于函数名**的中文词 ⇒ 一律空数组（长记号把名字包住也不给）', () => {
    const embedded = nth(TEXT, 2);
    // 整串是 `写了好感度检查的那段说明`——Unicode 尺量出来的是一个**更长**的记号，查表查不到
    expect(functionNameTokenAt(embedded, col(embedded, NAME))?.text).toBe('写了好感度检查的那段说明');
    expect(definitionTargetsAt(index, A, TEXT, 2, col(embedded, NAME))).toEqual([]);
    const prose = nth(TEXT, 3);
    expect(definitionTargetsAt(index, A, TEXT, 3, col(prose, '中文散文里的一个词'))).toEqual([]);
    const speech = nth(TEXT, 5);
    expect(definitionTargetsAt(index, A, TEXT, 5, col(speech, '普通中文台词'))).toEqual([]);
  });

  it('散文里**独立成串的整名**（引号 / 空白切断）现在给定义 = 本批量出来的代价面（1,269,664 个散文点位里 3,287 个 = 0.26%，其中新增 1,384 = 0.11%）', () => {
    const quoted = nth(TEXT, 4);
    expect(functionNameTokenAt(quoted, col(quoted, NAME))?.text).toBe(NAME);
    expect(definitionTargetsAt(index, A, TEXT, 4, col(quoted, NAME))).toHaveLength(1);
    // 同一格在 ASCII 尺下给不出记号 ⇒ 钉住"这是新增面"，不是"一直如此"
    expect(symbolTokenAt(quoted, col(quoted, NAME))).toBeUndefined();
  });

  it('非可见代码行（`$` 标签行的名字、`#DIM` 声明名）不因换尺而多跳：仍走各自那条腿', () => {
    const dimText = `#DIM ${NAME}\n@${NAME}\n`;
    const idx3 = indexOf([{ path: A, text: dimText }]);
    // `#DIM 好感度检查` 那一格由宿主的 `#DIM` 腿答（`mergeNavigationLegs` 排在前），
    // 本包的函数腿在这里给的是名录命中——两边的优先序在宿主裁决，不在本包各写 if
    expect(definitionTargetsAt(idx3, A, dimText, 1, col(nth(dimText, 1), NAME))).toHaveLength(1);
  });
});
