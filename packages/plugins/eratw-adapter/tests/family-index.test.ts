import { describe, expect, it } from 'vitest';
import {
  clearKojoFamilyMemo,
  createEratwFamilyIndex,
  createKojoFamilyMemo,
  parseKojoFamily,
} from '../src/family-index';

/**
 * 用例全部取自 eraTW 4.980 汉化整合版**真实函数名**
 * （tools/analyze-kojo-names.mjs 全量扫描产物）。
 */

describe('家族识别 · 家族声明与基础形态', () => {
  it('M_KOJO_K1 / M_KOJO_K1_2（selector）', () => {
    const a = parseKojoFamily('M_KOJO_K1')!;
    expect(a.kind).toBe('declare');
    expect(a.characterNo).toBe(1);
    expect(a.selector).toBe(0);
    const b = parseKojoFamily('M_KOJO_K1_2')!;
    expect(b.kind).toBe('declare');
    expect(b.selector).toBe(2);
  });

  it('初始家族 + 面 + 时机号', () => {
    const r = parseKojoFamily('M_KOJO_MESSAGE_COM_K1_30')!;
    expect(r).toMatchObject({ kind: 'ok', family: '', face: 'MESSAGE_COM', characterNo: 1, slot: '30' });
  });

  it('带家族名（少女之梦）', () => {
    const r = parseKojoFamily('M_KOJO_少女之梦_COLOR_K1')!;
    expect(r).toMatchObject({ family: '少女之梦', face: 'COLOR', characterNo: 1 });
  });

  it('多段时机号保留', () => {
    const r = parseKojoFamily('M_KOJO_MESSAGE_COM_K1_30_2')!;
    expect(r.slot).toBe('30_2');
  });

  it('EVENT 子形态（ONABARE / PERMISSION / GIFT 等）', () => {
    expect(parseKojoFamily('M_KOJO_EVENT_K1_ONABARE_2')!.face).toBe('EVENT');
    expect(parseKojoFamily('M_KOJO_EVENT_K1_PERMISSION_3')!.slot).toBe('PERMISSION_3');
    expect(parseKojoFamily('M_KOJO_少女之梦_EVENT_K1_GIFT')!.family).toBe('少女之梦');
  });
});

describe('家族识别 · PALAM / MESSAGECHECK / IRAI 长尾', () => {
  it('PALAMCNG 变体（A / A2 / B2 / F）', () => {
    expect(parseKojoFamily('M_KOJO_MESSAGE_PALAMCNG_A_K1_1')).toMatchObject({ face: 'MESSAGE_PALAMCNG', sub: 'A' });
    expect(parseKojoFamily('M_KOJO_MESSAGE_PALAMCNG_A2_K1')).toMatchObject({ face: 'MESSAGE_PALAMCNG', sub: 'A2' });
    expect(parseKojoFamily('M_KOJO_MESSAGE_PALAMCNG_B2_K1_1')).toMatchObject({ sub: 'B2' });
    expect(parseKojoFamily('M_KOJO_EGG_MESSAGE_PALAMCNG_F_K1')).toMatchObject({ family: 'EGG', sub: 'F' });
  });

  it('MESSAGECHECK 中缀（位协议否决钩子）', () => {
    const r = parseKojoFamily('M_KOJO_MESSAGE_COUNTER_MESSAGECHECK_K1_1')!;
    expect(r).toMatchObject({ face: 'MESSAGE_COUNTER', isMessageCheck: true, slot: '1' });

    const pal = parseKojoFamily('M_KOJO_MESSAGE_PALAMCNG_MESSAGECHECK_A_K1_1')!;
    expect(pal).toMatchObject({ face: 'MESSAGE_PALAMCNG', isMessageCheck: true, sub: 'A' });

    const msg = parseKojoFamily('M_KOJO_MESSAGE_MESSAGECHECK_SCOM_K1_1')!;
    expect(msg).toMatchObject({ face: 'MESSAGE', isMessageCheck: true, sub: 'SCOM' });

    const spe = parseKojoFamily('M_KOJO_SPEVENT_MESSAGECHECK_K1_1')!;
    expect(spe).toMatchObject({ face: 'SPEVENT', isMessageCheck: true });
  });

  it('IRAI 带依頼名子号', () => {
    expect(parseKojoFamily('M_KOJO_IRAI_K1')).toMatchObject({ face: 'IRAI', sub: '' });
    expect(parseKojoFamily('M_KOJO_IRAI_4_K1')).toMatchObject({ face: 'IRAI', sub: '4' });
    expect(parseKojoFamily('M_KOJO_IRAI_依頼名_K1')).toMatchObject({ face: 'IRAI', sub: '依頼名' });
  });
});

describe('家族识别 · KOJO/DIARY/RUN_INTO 前缀域', () => {
  it('KOJO_OPTION 系统（游玩指南）', () => {
    expect(parseKojoFamily('KOJO_OPTION_K1')).toMatchObject({ prefix: 'KOJO', face: 'OPTION' });
    expect(parseKojoFamily('KOJO_OPTION_EXIST_K1')).toMatchObject({ face: 'OPTION_EXIST' });
    expect(parseKojoFamily('KOJO_少女之梦_OPTION_K1')).toMatchObject({ family: '少女之梦', face: 'OPTION' });
  });

  it('VERSION 热更新 / UPDATE 钩子', () => {
    expect(parseKojoFamily('KOJO_少女之梦_VERSION_K1')).toMatchObject({ face: 'VERSION', family: '少女之梦' });
    expect(parseKojoFamily('KOJO_VERSION_UPDATE_K1')).toMatchObject({ face: 'VERSION_UPDATE' });
    expect(parseKojoFamily('M_KOJO_少女之梦_UPDATE_K1')).toMatchObject({ face: 'UPDATE' });
  });

  it('DIARY 日记系', () => {
    expect(parseKojoFamily('DIARY_K1_TEXT')).toMatchObject({ prefix: 'DIARY', face: 'DIARY', slot: 'TEXT' });
    expect(parseKojoFamily('DIARY_少女之梦_K1_EXIST')).toMatchObject({ family: '少女之梦', slot: 'EXIST' });
    expect(parseKojoFamily('DIARY_少女之梦_K1_2')).toMatchObject({ family: '少女之梦', slot: '2' });
  });

  it('RUN_INTO 外出遭遇', () => {
    expect(parseKojoFamily('RUN_INTO_EVENT_K1')).toMatchObject({ prefix: 'RUN_INTO', face: 'EVENT' });
  });

  it('BEFORETRAIN（家族名后置的唯一形态）', () => {
    const r = parseKojoFamily('K1_BEFORETRAIN_少女之梦')!;
    expect(r).toMatchObject({ kind: 'beforetrain', characterNo: 1, family: '少女之梦' });
  });
});

describe('家族识别 · 数据质量形态', () => {
  it('KX 占位符残留（模板置换事故的化石）', () => {
    const r = parseKojoFamily('M_KOJO_吧友火焔猫燐制作_MESSAGE_COM_KX_1')!;
    expect(r).toMatchObject({ kind: 'placeholder', isPlaceholder: true, characterNo: null, face: 'MESSAGE_COM', family: '吧友火焔猫燐制作' });
  });

  it('K{n}_ 前缀私货形态', () => {
    const r = parseKojoFamily('K1_CONFEDERATION_1_1')!;
    expect(r.kind).toBe('kn');
    expect(r.characterNo).toBe(1);
  });

  it('裸家族前缀（无 M_KOJO）', () => {
    const r = parseKojoFamily('別人変身版_MESSAGE_COM_K1_1')!;
    expect(r).toMatchObject({ prefix: '', family: '別人変身版', face: 'MESSAGE_COM', characterNo: 1 });
  });

  it('M_KOJO_K{n}_{私有功能} 剧本私有函数', () => {
    const r = parseKojoFamily('M_KOJO_K1_HEART')!;
    expect(r).toMatchObject({ prefix: 'M_KOJO', characterNo: 1, face: '', slot: 'HEART' });
  });

  it('尾部逗号容错（真实语料存在）', () => {
    expect(parseKojoFamily('DIARY_TEXT_K1,')?.characterNo).toBe(1);
  });
});

describe('家族识别 · 拒绝非口上函数（宁可漏报不误报）', () => {
  it('无口上特征的函数名 → null', () => {
    expect(parseKojoFamily('PRINTL')).toBeNull();
    expect(parseKojoFamily('SOME_HELPER_FUNC')).toBeNull();
    expect(parseKojoFamily('EVENT_N_N')).toBeNull();
    expect(parseKojoFamily('')).toBeNull();
    expect(parseKojoFamily('M_KOJO')).toBeNull();
    expect(parseKojoFamily('M_KOJO_FOO_K')).toBeNull(); // 无数字编号锚点
  });
});

describe('FamilyIndexRule 包装', () => {
  it('name 与 match 契约', () => {
    const rule = createEratwFamilyIndex();
    expect(rule.name).toBe('eratw-family-index');
    expect(rule.match('M_KOJO_MESSAGE_COM_K1_30')?.face).toBe('MESSAGE_COM');
    expect(rule.match('NOT_A_KOJO_FUNC')).toBeNull();
  });
});

describe('家族识别 · K 锚点语义（BUG-3 显式化：取最后一个 _K{no}）', () => {
  it('单锚点：_K{no} 后跟 _时机号', () => {
    const r = parseKojoFamily('X_MESSAGE_COUNTER_K2_1')!;
    expect(r).toMatchObject({ kind: 'ok', prefix: '', family: 'X', face: 'MESSAGE_COUNTER', characterNo: 2, slot: '1' });
  });

  it('名称含多个 _K 段：最靠后的编号为锚（家族名段允许再含 _K 段）', () => {
    const r = parseKojoFamily('X_MESSAGE_COUNTER_K2_MESSAGE_COUNTER_K1')!;
    expect(r).toMatchObject({ kind: 'ok', characterNo: 1, face: 'MESSAGE_COUNTER' });
  });

  it('数字边界：_K1B 不构成锚点 → null（regex 回溯后无锚可依）', () => {
    expect(parseKojoFamily('X_MESSAGE_COUNTER_K1B')).toBeNull();
  });

  it('无 _K 编号段 → null（与口上命名无关）', () => {
    expect(parseKojoFamily('X_MESSAGE_COUNTER')).toBeNull();
  });
});

describe('名称解析 memo（§5.73：共享实例的前提条件必须可证）', () => {
  /** 覆盖各形态的代表名（声明 / 初始家族 / 具名家族 / MESSAGECHECK / KX 占位 / 无关名） */
  const GOLDEN: readonly string[] = [
    'M_KOJO_K1',
    'M_KOJO_K1_2',
    'M_KOJO_MESSAGE_COM_K1_30',
    'M_KOJO_少女之梦_COLOR_K1',
    'M_KOJO_X_MESSAGECHECK_1_K1_1',
    'M_KOJO_MESSAGE_COM_KX_1',
    'K1_BEFORETRAIN少女之梦',
    'X_MESSAGE_COUNTER_K2_1',
    'X_MESSAGE_COUNTER',
    'GETVAR',
  ];

  it('金名表跑两遍逐字段一致（memo 不改变任何判定）', () => {
    const first = GOLDEN.map((n) => parseKojoFamily(n));
    const second = GOLDEN.map((n) => parseKojoFamily(n));
    expect(second).toEqual(first);
  });

  it('同一名字二次调用返回**同一实例**（这就是 memo 在生效的读数）', () => {
    const a = parseKojoFamily('M_KOJO_MESSAGE_COM_K1_30');
    const b = parseKojoFamily('M_KOJO_MESSAGE_COM_K1_30');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('不同名字各自占一个条目（memo 不会把两个名字并成一个）', () => {
    const memo = createKojoFamilyMemo();
    const declare = memo.parse('M_KOJO_K1');
    const face = memo.parse('M_KOJO_K1_2');
    expect(memo.size()).toBe(2);
    expect(declare).toMatchObject({ kind: 'declare', selector: 0 });
    expect(face).toMatchObject({ kind: 'declare', selector: 2 });
  });

  it('结果被冻结：改写尝试直接抛错——共享实例的安全前提，不是优化', () => {
    const m = parseKojoFamily('M_KOJO_少女之梦_COLOR_K1')!;
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { family: string }).family = '被改写了';
    }).toThrow();
    // 抛错后缓存里的值没被带跑
    expect(parseKojoFamily('M_KOJO_少女之梦_COLOR_K1')!.family).toBe('少女之梦');
  });

  it('null 结果同样进 memo（非口生命名占了大量调用，每次重跑 regex 链就是本批要消掉的成本）', () => {
    const memo = createKojoFamilyMemo();
    expect(memo.size()).toBe(0);
    memo.parse('GETVAR');
    memo.parse('GETVAR');
    expect(memo.size()).toBe(1);
    expect(memo.parse('GETVAR')).toBeNull();
  });

  it('到上限**整表清空**而不是无限增长；清空后判定不变', () => {
    const memo = createKojoFamilyMemo(3);
    memo.parse('M_KOJO_K1');
    memo.parse('M_KOJO_K1_2');
    memo.parse('X_MESSAGE_COUNTER_K2_1');
    expect(memo.size()).toBe(3);
    memo.parse('M_KOJO_K1'); // 命中已有条目 ⇒ 不涨
    expect(memo.size()).toBe(3);
    memo.parse('M_KOJO_少女之梦_COLOR_K1'); // 第 4 个新名字 ⇒ 超限 ⇒ 清表后只留它
    expect(memo.size()).toBe(1);
    expect(memo.parse('M_KOJO_K1')).toMatchObject({ kind: 'declare', characterNo: 1 });
  });

  it('clearKojoFamilyMemo() 之后仍是同一判定（切项目只丢缓存，不丢正确性）', () => {
    const before = parseKojoFamily('M_KOJO_EVENT_K1_ONABARE_2');
    clearKojoFamilyMemo();
    const after = parseKojoFamily('M_KOJO_EVENT_K1_ONABARE_2');
    expect(after).toEqual(before);
    expect(after).not.toBe(before); // 清过表 ⇒ 是新解析出来的实例
  });

  it('规则对象（functionFamilyIndex）走的是同一个 memo 入口', () => {
    const rule = createEratwFamilyIndex();
    expect(rule.match('M_KOJO_MESSAGE_COM_K1_30')).toBe(parseKojoFamily('M_KOJO_MESSAGE_COM_K1_30'));
  });
});
