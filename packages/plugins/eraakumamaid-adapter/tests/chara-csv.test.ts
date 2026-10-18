import { describe, expect, it } from 'vitest';
import { deriveCharaNoFromFileNames, parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from '../src/chara-csv';
import { ERAAKUMA_MAID } from '../src/constants';

describe('parseCharaCsv（eraAkumaMaid 实测格式，与 eraTW 逐字同构）', () => {
  it('实测样本 CHARA1.csv：番号/名前/呼び名 三行（BOM + CRLF）', () => {
    // CSV/CHARA/CHARA1.csv 前 3 行原样（UTF-8-BOM、CRLF）
    const text = '\uFEFF番号,1,\r\n名前,フェリシエル,\r\n呼び名,フェリシエル,\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 1, name: 'フェリシエル', callName: 'フェリシエル' });
  });

  it('实测样本 CHARA0.csv（玩家 0 号）与 CHARA100.csv', () => {
    expect(parseCharaCsv('\uFEFF番号,0,\n名前,あなた,\n呼び名,あなた,\nCSTR,ふりがな,あなた,\n')).toEqual({
      no: 0,
      name: 'あなた',
      callName: 'あなた',
    });
    expect(parseCharaCsv('\uFEFF番号,100,\n名前,パトラ,\n呼び名,パトラ,\n')).toEqual({
      no: 100,
      name: 'パトラ',
      callName: 'パトラ',
    });
  });

  it('CRLF 换行与行尾空格容错', () => {
    const text = '番号,26, \r\n名前,八云紫, \r\n呼び名,紫,\r\n';
    expect(parseCharaCsv(text)).toEqual({ no: 26, name: '八云紫', callName: '紫' });
  });

  it('BOM 头（\\uFEFF）不影响首行关键字', () => {
    const text = '\uFEFF番号,1,\n名前,博丽 灵梦,\n呼び名,灵梦,\n';
    expect(parseCharaCsv(text)).toEqual({ no: 1, name: '博丽 灵梦', callName: '灵梦' });
  });

  it('行首空格容错', () => {
    const text = '  番号,3,\n \t 名前,十六夜咲夜,\n  呼び名,咲夜,\n';
    expect(parseCharaCsv(text)).toEqual({ no: 3, name: '十六夜咲夜', callName: '咲夜' });
  });

  it('缺呼び名 / 缺名前 → null（不猜测）', () => {
    expect(parseCharaCsv('番号,5,\n名前,美鈴,\n基礎,体力,100\n')).toEqual({ no: 5, name: '美鈴', callName: null });
    expect(parseCharaCsv('番号,5,\n基礎,体力,100\n')).toEqual({ no: 5, name: null, callName: null });
    expect(parseCharaCsv('')).toEqual({ no: null, name: null, callName: null });
  });

  it('中文关键字变体（汉化版容错，照 eratw 口径）', () => {
    const text = '编号,7,\n姓名,测试角色,\n称呼,昵称,\n';
    expect(parseCharaCsv(text)).toEqual({ no: 7, name: '测试角色', callName: '昵称' });
  });

  it('非法番号值不采纳', () => {
    expect(parseCharaCsv('番号,abc,\n').no).toBeNull();
    expect(parseCharaCsv('番号,,\n').no).toBeNull();
  });
});

describe('parseCharaNoFromFileName（CHARA{no}.csv）', () => {
  it('实测文件名提取', () => {
    expect(parseCharaNoFromFileName('CHARA0.csv', ERAAKUMA_MAID.charaCsvPattern)).toBe(0);
    expect(parseCharaNoFromFileName('CHARA1.csv', ERAAKUMA_MAID.charaCsvPattern)).toBe(1);
    expect(parseCharaNoFromFileName('CHARA100.csv', ERAAKUMA_MAID.charaCsvPattern)).toBe(100);
  });

  it('忽略大小写', () => {
    expect(parseCharaNoFromFileName('chara51.csv', ERAAKUMA_MAID.charaCsvPattern)).toBe(51);
  });

  it('不匹配返回 null', () => {
    expect(parseCharaNoFromFileName('Abl.csv', ERAAKUMA_MAID.charaCsvPattern)).toBeNull();
    expect(parseCharaNoFromFileName('CHARA.csv', ERAAKUMA_MAID.charaCsvPattern)).toBeNull();
  });
});

describe('parseKojoDirName（口上角色目录约定：1–3 位编号 + 空白 + 名称）', () => {
  it('实测目录名', () => {
    expect(parseKojoDirName('01 フェリシエル')).toEqual({ no: 1, label: 'フェリシエル' });
    expect(parseKojoDirName('100 パトラ')).toEqual({ no: 100, label: 'パトラ' });
    expect(parseKojoDirName('00 あなた')).toEqual({ no: 0, label: 'あなた' });
  });

  it('编号 1–3 位均可（eraTW 固定三位；AM 有 1/2 位）', () => {
    expect(parseKojoDirName('5 六華')).toEqual({ no: 5, label: '六華' });
    expect(parseKojoDirName('12 成美')).toEqual({ no: 12, label: '成美' });
  });

  it('不符合约定 → null（不猜测）', () => {
    expect(parseKojoDirName('你好')).toBeNull();
    expect(parseKojoDirName('Reimu')).toBeNull();
    expect(parseKojoDirName('')).toBeNull();
    expect(parseKojoDirName('of_new_kojo_api_TEST.ERB')).toBeNull();
    // 实测行为钉死：编号与名称间必须有空白，'1abc def' 的 '1' 后紧跟字母
    expect(parseKojoDirName('1abc def')).toBeNull();
  });

  it('实测坑：只有数字无名称的目录 → null（由调用方按文件名反推兜底）', () => {
    // ERB/EVENT_K/ 下真实存在 '67' / '68' 两个此类目录
    expect(parseKojoDirName('67')).toBeNull();
    expect(parseKojoDirName('68')).toBeNull();
  });
});

describe('deriveCharaNoFromFileNames（无编号目录按 EVENT_K{n} 文件名回退）', () => {
  it('组长给定样本：多编号取出现次数最多者', () => {
    expect(deriveCharaNoFromFileNames(['EVENT_K36_コマンド.ERB', 'EVENT_K36.ERB', 'EVENT_K1.ERB'])).toBe(36);
  });

  it('实测目录内文件名（01 フェリシエル / 100 パトラ / 00 あなた）', () => {
    expect(
      deriveCharaNoFromFileNames([
        'EVENT_K1.ERB',
        'EVENT_K1_CLOTHES.ERB',
        'EVENT_K1_COMM.ERB',
        'EVENT_K1_DAILY.ERB',
        'EVENT_K1_SELECT.ERB',
        'EVENT_K1_SHOP.ERB',
      ]),
    ).toBe(1);
    expect(deriveCharaNoFromFileNames(['EVENT_K100.ERB', 'EVENT_K100_DAILY.ERB', 'UPDATE_K100.ERB'])).toBe(100);
    expect(deriveCharaNoFromFileNames(['EVENT_K0_CLOTHES.ERB'])).toBe(0);
  });

  it('实测坑：纯数字目录 67 靠文件名反推', () => {
    expect(deriveCharaNoFromFileNames(['EVENT_K67.ERB', 'EVENT_K67_CLOTHES.ERB', 'EVENT_K67_COMM.ERB'])).toBe(67);
  });

  it('忽略大小写、忽略无关文件', () => {
    expect(deriveCharaNoFromFileNames(['event_k36_event.erb', 'README.txt'])).toBe(36);
  });

  it('多个不同编号取出现次数最多者（并列取最小）', () => {
    expect(deriveCharaNoFromFileNames(['EVENT_K36_a.ERB', 'EVENT_K36_b.ERB', 'EVENT_K65_c.ERB'])).toBe(36);
    expect(deriveCharaNoFromFileNames(['EVENT_K65_c.ERB', 'EVENT_K36_a.ERB'])).toBe(36); // 并列 1:1 → 取小
  });

  it('根层共享文件天然不计入（EVENT_K 后非数字）', () => {
    expect(deriveCharaNoFromFileNames(['EVENT_K.ERB'])).toBeNull();
    expect(deriveCharaNoFromFileNames(['EVENT_K_COMM.ERB', 'EVENT_K_DAILY.ERB', 'CALL_NAME.ERB'])).toBeNull();
  });

  it('共享目录（汎用喘ぎ）与无关内容 → null', () => {
    expect(deriveCharaNoFromFileNames(['PANT.ERB', 'PANT_LIST.ERB'])).toBeNull();
    expect(deriveCharaNoFromFileNames([])).toBeNull();
  });

  it('AM 实测无 `EVENT_K{n}[` 占位形态，故不设 (?!\\[) 排除（行为钉死）', () => {
    // eraTW 4.842 有 M_KOJO_K1[]_… dummy 占位；AM 76 目录 0 命中，已去掉该排除
    expect(deriveCharaNoFromFileNames(['EVENT_K1[]_コマンド.ERB'])).toBe(1);
  });

  it('`.` 后继主文件仍取真编号', () => {
    expect(deriveCharaNoFromFileNames(['EVENT_K86.ERB'])).toBe(86);
  });
});
