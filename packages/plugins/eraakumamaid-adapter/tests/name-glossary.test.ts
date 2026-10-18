import { describe, expect, it } from 'vitest';
import { ERAAKUMA_MAID_NAME_GLOSSARY, glossName } from '../src/name-glossary';

/**
 * 日文名 → 中文名对照词典（展示用）单测。
 *
 * 口径：**导入既有包保持原样不强制改名**——只加显示对照，不改任何目录 / 文件名。
 * 测试锁死三条：最长命中、已含中文不重复、无命中 fail-visible 原样返回；
 * 另用 eraAkumaMaid 实测目录名 / 文件名样本验证「宁缺勿编」（角色名不收、文件族收）。
 */

describe('glossName · 日文（中文）对照', () => {
  it('含日文片段：拼 `日文（中文）`', () => {
    expect(glossName('恋慕')).toBe('恋慕（爱慕）');
    expect(glossName('押し倒し')).toBe('押し倒し（推倒）');
  });

  it('命中**最长**键：「処女喪失」取 4 字键而非「処女」；「アナルバイブ」取 5 字键而非「バイブ」', () => {
    expect(glossName('処女喪失')).toBe('処女喪失（处女丧失）');
    expect(glossName('アナルバイブ')).toBe('アナルバイブ（肛门振动棒）');
  });

  it('无日文片段的名字：原样返回（fail-visible，绝不猜）', () => {
    expect(glossName('my_pack')).toBe('my_pack');
    expect(glossName('readme.txt')).toBe('readme.txt');
    expect(glossName('EVENT_K1.ERB')).toBe('EVENT_K1.ERB');
  });

  it('名字自身已含对应中文：原样返回（不重复添加）', () => {
    expect(glossName('恋慕（爱慕）')).toBe('恋慕（爱慕）');
    expect(glossName('中出し（中出）')).toBe('中出し（中出）');
  });

  it('空名：原样返回空串', () => {
    expect(glossName('')).toBe('');
  });
});

describe('glossName · eraAkumaMaid 实测样本', () => {
  it('真实口上角色目录名：无通用中文译名 ⇒ 原样返回（宁缺勿编）', () => {
    // 外来名 / 汉字和名均无通用社区译名，一律不收（见 src 头注收录原则 5）
    expect(glossName('ERB/EVENT_K/01 フェリシエル')).toBe('ERB/EVENT_K/01 フェリシエル');
    expect(glossName('ERB/EVENT_K/02 濡烏の君')).toBe('ERB/EVENT_K/02 濡烏の君');
    expect(glossName('ERB/EVENT_K/12 成美')).toBe('ERB/EVENT_K/12 成美');
    // 坑位目录（67 / 68 只有数字无名称）同样原样
    expect(glossName('ERB/EVENT_K/67')).toBe('ERB/EVENT_K/67');
  });

  it('真实文件族样本：日文/英文片段命中', () => {
    expect(glossName('ERB/EVENT_K/01 フェリシエル/EVENT_K1_DAILY.ERB')).toBe(
      'ERB/EVENT_K/01 フェリシエル/EVENT_K1_DAILY.ERB（日常）',
    );
    expect(glossName('ERB/EVENT_K/01 フェリシエル/EVENT_K1_CLOTHES.ERB')).toBe(
      'ERB/EVENT_K/01 フェリシエル/EVENT_K1_CLOTHES.ERB（服装）',
    );
    expect(glossName('ERB/EVENT_K/01 フェリシエル/EVENT_K1_COMM.ERB')).toBe(
      'ERB/EVENT_K/01 フェリシエル/EVENT_K1_COMM.ERB（会话）',
    );
    expect(glossName('ERB/EVENT_K/01 フェリシエル/EVENT_K1_SELECT.ERB')).toBe(
      'ERB/EVENT_K/01 フェリシエル/EVENT_K1_SELECT.ERB（选择）',
    );
    expect(glossName('ERB/EVENT_K/01 フェリシエル/EVENT_K1_SHOP.ERB')).toBe(
      'ERB/EVENT_K/01 フェリシエル/EVENT_K1_SHOP.ERB（商店）',
    );
  });

  it('根层目录/文件样本：模板与授权信息', () => {
    expect(glossName('口上テンプレート')).toBe('口上テンプレート（模板）');
    expect(glossName('口上ライセンス一覧.txt')).toBe('口上ライセンス一覧.txt（授权信息）');
    expect(glossName('資料')).toBe('資料（资料）');
  });

  it('日汉同形词不收：原样返回（对照无信息量）', () => {
    expect(glossName('TALENT:反抗的')).toBe('TALENT:反抗的');
    expect(glossName('PALAM:欲情')).toBe('PALAM:欲情');
    expect(glossName('CFLAG:好感度')).toBe('CFLAG:好感度');
  });
});

describe('ERAAKUMA_MAID_NAME_GLOSSARY · 词典本身', () => {
  it('是冻结对象（防消费方就地改写）', () => {
    expect(Object.isFrozen(ERAAKUMA_MAID_NAME_GLOSSARY)).toBe(true);
  });

  it('键值均非空、无重复键', () => {
    const entries = Object.entries(ERAAKUMA_MAID_NAME_GLOSSARY);
    expect(entries.length).toBeGreaterThan(0);
    for (const [k, v] of entries) {
      expect(k.length).toBeGreaterThan(0);
      expect(v.length).toBeGreaterThan(0);
    }
    expect(new Set(entries.map(([k]) => k)).size).toBe(entries.length);
  });

  it('译名为简体中文：键中旧字形（繁体/和制简体）不得出现在值里', () => {
    // 这些旧字形只应出现在**键**（日文片段）里；值（中文译名）必须已简体化
    const kyujitai = /[処貧噴頼順絶鬱満護産経験戀壓彌髮衝]/;
    for (const v of Object.values(ERAAKUMA_MAID_NAME_GLOSSARY)) {
      expect(kyujitai.test(v)).toBe(false);
    }
  });
});
