/**
 * Chara CSV / 口上文件名解析判据（形态取自 `C:/game/eraAV` 真盘，2026-10-26 实测）。
 *
 * 合成用例承担全部判据（换机器 / 换汉化包也要过）；真盘用例以目录存在为守卫，
 * 钉的是「120 份 CSV 全过文件名解析」「17 份口上全过文件名解析」这类整盘读数。
 * 重点盯三件盘上事实：**同角色可重号**（01/91、70/76、71/77 ⇒ 名称不是身份）、
 * **名称段是日文而 `名前` 行是中文**、**BOM 与 `;` 注释行都不保证**。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
} from '../src/chara-csv';

const GAME_ROOT = 'C:/game/eraAV';
const CHARA_DIR = `${GAME_ROOT}/CSV/Chara`;
const LINES_DIR = `${GAME_ROOT}/ERB/Lines`;
const CHARA_SAMPLE = `${CHARA_DIR}/Chara01_宮間かなで.csv`;
const hasCharaDisk = existsSync(CHARA_DIR);
const hasLinesDisk = existsSync(LINES_DIR);
const hasSampleCsv = existsSync(CHARA_SAMPLE);

describe('parseCharaCsv（番号 / 名前 / 呼び名 逐行认键，不猜）', () => {
  it('实测头三行：BOM + CRLF + 行尾双逗号，名前取的是中文汉化名', () => {
    const text = '\uFEFF番号,1,,\r\n名前,宫间奏美,,\r\n呼び名,奏美,,\r\nあだ名,深山奏美,,\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 1, name: '宫间奏美', callName: '奏美' });
  });

  it('无 BOM 也认（真盘 7/120 不带 BOM：Chara70–75、Chara78）', () => {
    expect(parseCharaCsv('番号,70,\r\n名前,春风南,\r\n呼び名,南,\r\n')).toEqual({
      no: 70,
      name: '春风南',
      callName: '南',
    });
  });

  it('番号 前有 `;` 注释行照样取到（真盘 4 份：Chara98/211/214/215）', () => {
    const text = '\uFEFF;コギャル系（死语）ヤンキーでビッチ。,,,\r\n番号,207,,\r\n名前,雨岛满,,\r\n';
    expect(parseCharaCsv(text).no).toBe(207);
    expect(parseCharaCsv(text).name).toBe('雨岛满');
  });

  it('呼び名 空值 → null（真盘 Chara51_【求人広告】.csv），也不拿名前 顶替', () => {
    expect(parseCharaCsv('番号,51,\r\n名前,面试对象,\r\n呼び名,,\r\nあだ名,,\r\n')).toEqual({
      no: 51,
      name: '面试对象',
      callName: null,
    });
  });

  it('中文关键字（编号 / 姓名 / 称呼）宽容；LF 与 CRLF 同过', () => {
    expect(parseCharaCsv('编号,7\n姓名,魔理沙\n称呼,黑白\n')).toEqual({
      no: 7,
      name: '魔理沙',
      callName: '黑白',
    });
  });

  it('缺 `番号` 行 → no 为 null（交调用方用文件名回退），空文本/垃圾文本都不抛', () => {
    expect(parseCharaCsv('名前,桐生歌音,\r\n呼び名,歌音,\r\n')).toEqual({
      no: null,
      name: '桐生歌音',
      callName: '歌音',
    });
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
    expect(() => parseCharaCsv('基础,,\n,,,\n;;;\n')).not.toThrow();
  });

  it('非法番号不采纳（abc / 空值 / 全角数字都按 null）', () => {
    expect(parseCharaCsv('番号,abc,\n').no).toBeNull();
    expect(parseCharaCsv('番号,,\n').no).toBeNull();
    expect(parseCharaCsv('番号,１０,\n').no).toBeNull();
  });
});

describe('parseCharaNoFromFileName（`Chara{no}[_名称].csv`，号只认前导数字）', () => {
  it('零填充与稀疏号都取对：Chara0 / Chara01 / Chara10 / Chara100 / Chara240', () => {
    expect(parseCharaNoFromFileName('Chara0.csv')).toBe(0);
    expect(parseCharaNoFromFileName('Chara01_宮間かなで.csv')).toBe(1);
    expect(parseCharaNoFromFileName('Chara10_桐生歌音.csv')).toBe(10);
    expect(parseCharaNoFromFileName('Chara100_後藤彩香.csv')).toBe(100);
    expect(parseCharaNoFromFileName('Chara240_鉢堂陽菜.csv')).toBe(240);
  });

  it('大小写混排一律认（文件名前缀与扩展名都可任意写）', () => {
    expect(parseCharaNoFromFileName('chara10_桐生歌音.CSV')).toBe(10);
    expect(parseCharaNoFromFileName('CHARA207_両島みちる..Csv')).toBe(207);
  });

  it('非角色文件 → null（CSV 根层名表 / 别的扩展名 / 全角数字都不猜）', () => {
    expect(parseCharaNoFromFileName('Train.CSV')).toBeNull();
    expect(parseCharaNoFromFileName('VariableSize.CSV')).toBeNull();
    expect(parseCharaNoFromFileName('Chara01_宮間かなで.ERB')).toBeNull();
    expect(parseCharaNoFromFileName('Chara１０_宮間かなで.csv')).toBeNull();
    expect(parseCharaNoFromFileName('Character10_桐生歌音.csv')).toBeNull();
  });

  it('给整条路径也认（取 basename，Windows 与 POSIX 两种分隔都过）', () => {
    expect(parseCharaNoFromFileName('CSV/Chara/Chara01_宮間かなで.csv')).toBe(1);
    expect(parseCharaNoFromFileName('C:\\game\\eraAV\\CSV\\Chara\\Chara92_アンドロイド.csv')).toBe(92);
  });
});

describe('charaNameFromFileName（名称段是自由文本，日文，不作身份）', () => {
  it('普通段 / 段尾双点 / 非人物条目段', () => {
    expect(charaNameFromFileName('Chara01_宮間かなで.csv')).toBe('宮間かなで');
    expect(charaNameFromFileName('Chara207_両島みちる..csv')).toBe('両島みちる');
    expect(charaNameFromFileName('Chara51_【求人広告】.csv')).toBe('【求人広告】');
    expect(charaNameFromFileName('Chara92_アンドロイド.csv')).toBe('アンドロイド');
    expect(charaNameFromFileName('Chara180_元カノ.csv')).toBe('元カノ');
  });

  it('全角与中文混排的段原样保留（内部句点、中黑不剥）', () => {
    expect(charaNameFromFileName('Chara93_李美鈴.csv')).toBe('李美鈴');
    expect(charaNameFromFileName('Chara09_レイチェル・パラディスス.csv')).toBe('レイチェル・パラディスス');
    expect(charaNameFromFileName('Chara216_クリスティナ・ロココ・ラーグラーデ.csv')).toBe(
      'クリスティナ・ロココ・ラーグラーデ',
    );
  });

  it('无名称段（真盘唯一一份 Chara0.csv）与非角色名 → null', () => {
    expect(charaNameFromFileName('Chara0.csv')).toBeNull();
    expect(charaNameFromFileName('Chara0.CSV')).toBeNull();
    expect(charaNameFromFileName('Train.csv')).toBeNull();
    expect(charaNameFromFileName('')).toBeNull();
  });

  it('大小写混排 + 路径输入都取到同一段', () => {
    expect(charaNameFromFileName('C:/game/eraAV/CSV/Chara/chara22_織部真菜香.CSV')).toBe('織部真菜香');
  });
});

describe('重号 / 同名不合并（名称不是条目身份）', () => {
  it('宮間かなで 住在 01 与 91：段同名、号不同 ⇒ 两个条目', () => {
    expect(charaNameFromFileName('Chara01_宮間かなで.csv')).toBe(
      charaNameFromFileName('Chara91_宮間かなで.csv'),
    );
    expect(parseCharaNoFromFileName('Chara01_宮間かなで.csv')).toBe(1);
    expect(parseCharaNoFromFileName('Chara91_宮間かなで.csv')).toBe(91);
    // 真盘实测：同一日文段名底下是两个不同的中文名前（宫间奏美 / 宫间香奈）
    expect(parseCharaCsv('番号,1,,\r\n名前,宫间奏美,,\r\n').name).not.toBe(
      parseCharaCsv('番号,91,,\r\n名前,宫间香奈,,\r\n').name,
    );
  });

  it('春風南 70/76、神園すみれ 71/77 同样各算一条（不折叠、不判等）', () => {
    const nos = ['Chara70_春風南.csv', 'Chara76_春風南.csv', 'Chara71_神園すみれ.csv', 'Chara77_神園すみれ.csv'].map(
      parseCharaNoFromFileName,
    );
    expect(nos).toEqual([70, 76, 71, 77]);
    expect(new Set(nos).size).toBe(4);
  });
});

describe('parseKojoFileName（本作扁平口上文件，无角色目录）', () => {
  it('实测形态：`EVENT_K{零填充}_{角色名}.ERB`，号只作文件名标记', () => {
    expect(parseKojoFileName('EVENT_K01_宮間かなで.ERB')).toEqual({ no: 1, label: '宮間かなで' });
    expect(parseKojoFileName('EVENT_K22_織部真菜香.ERB')).toEqual({ no: 22, label: '織部真菜香' });
    expect(parseKojoFileName('EVENT_K97_黒井都子.ERB')).toEqual({ no: 97, label: '黒井都子' });
  });

  it('大小写混排与整路径输入都认（盘上另有小写 `.erb`）', () => {
    expect(parseKojoFileName('event_k10_桐生歌音.erb')).toEqual({ no: 10, label: '桐生歌音' });
    expect(parseKojoFileName('C:\\game\\eraAV\\ERB\\Lines\\EVENT_K80_新島美京.ERB')).toEqual({
      no: 80,
      label: '新島美京',
    });
  });

  it('口上根里的非口上文件 → null（不猜归属）', () => {
    expect(parseKojoFileName('EVENT_K.ERB')).toBeNull();
    expect(parseKojoFileName('想达成调教结束后表白效果.txt')).toBeNull();
    expect(parseKojoFileName('_KOJO_SYSTEM.ERB')).toBeNull();
    expect(parseKojoFileName('EVENT_K01.ERB')).toBeNull();
    expect(parseKojoFileName('EVENT_K01_宮間かなで.erh')).toBeNull();
  });
});

describe('真实语料读数（守卫：C:/game/eraAV 在位才跑）', () => {
  it.skipIf(!hasSampleCsv)('CSV/Chara/Chara01_宮間かなで.csv：文件名日文、名前中文、呼び名 中文', () => {
    const parsed = parseCharaCsv(readFileSync(CHARA_SAMPLE, 'utf8'));
    expect(parsed).toEqual({ no: 1, name: '宫间奏美', callName: '奏美' });
    expect(charaNameFromFileName('Chara01_宮間かなで.csv')).toBe('宮間かなで');
  });

  it.skipIf(!hasCharaDisk)('全量 CSV/Chara：每份都取得到号，且与 `番号` 行一致', () => {
    const files = readdirSync(CHARA_DIR);
    expect(files.length).toBe(120);
    for (const f of files) {
      const fromName = parseCharaNoFromFileName(f);
      expect(fromName, f).not.toBeNull();
      expect(parseCharaCsv(readFileSync(`${CHARA_DIR}/${f}`, 'utf8')).no, f).toBe(fromName);
    }
    // 号唯一（同角色是「重名不重号」）；名称段却可重复 ⇒ 身份只能落在号上
    expect(new Set(files.map(parseCharaNoFromFileName)).size).toBe(files.length);
    expect(files.filter((f) => charaNameFromFileName(f) === '宮間かなで').length).toBe(2);
  });

  it.skipIf(!hasLinesDisk)('全量 ERB/Lines：17 份口上文件解析、其余散文件一律 null', () => {
    const entries = readdirSync(LINES_DIR).sort();
    const parsed = entries.map((f) => ({ f, r: parseKojoFileName(f) }));
    expect(parsed.filter((p) => p.r !== null)).toHaveLength(17);
    expect(parsed.filter((p) => p.r === null).map((p) => p.f)).toEqual([
      '想达成调教结束后表白效果.txt',
    ]);
    expect(parsed.filter((p) => p.r !== null).map((p) => p.r!.no)).toEqual([
      1, 5, 10, 12, 17, 22, 29, 30, 33, 38, 39, 45, 80, 87, 88, 89, 97,
    ]);
  });
});
