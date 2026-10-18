import { describe, expect, it } from 'vitest';
import {
  ERAAKUMA_MAID_FACE_LABELS,
  clearKojoFamilyMemo,
  createErakumamaidFamilyIndex,
  createKojoFamilyMemo,
  parseKojoFamily,
} from '../src/family-index';

/**
 * 用例全部取自 eraAkumaMaid **真实函数名**（`ERB/EVENT_K` 全量扫描产物，
 * 3,352 函数 / 3,174 去重名，2026-10-18 实测）。不构造臆造名——判据以语料为准。
 */

describe('家族识别 · 后缀式主形态', () => {
  it('面 + 角色号（每角色一份的主链路面）', () => {
    expect(parseKojoFamily('KOJO_MESSAGE_COM_K1')).toMatchObject({
      kind: 'ok',
      prefix: '',
      family: '',
      face: 'MESSAGE_COM',
      characterNo: 1,
      slot: '',
      isPlaceholder: false,
    });
    expect(parseKojoFamily('KOJO_MESSAGE_BEFORE_COM_K1')!.face).toBe('MESSAGE_BEFORE_COM');
    expect(parseKojoFamily('KOJO_MESSAGE_PALAMCNG_K1')!.face).toBe('MESSAGE_PALAMCNG');
    expect(parseKojoFamily('KOJO_MESSAGE_MARKCNG_K1')!.face).toBe('MESSAGE_MARKCNG');
    expect(parseKojoFamily('KOJO_MESSAGE_SHOOT_K1')!.face).toBe('MESSAGE_SHOOT');
    expect(parseKojoFamily('KOJO_MESSAGE_SAMEN_AND_EXTACY_K1')!.face).toBe('MESSAGE_SAMEN_AND_EXTACY');
    expect(parseKojoFamily('KOJO_COUNTER_K1')!.face).toBe('COUNTER');
    expect(parseKojoFamily('KOJO_EVENT_K1')!.face).toBe('EVENT');
    expect(parseKojoFamily('KOJO_DAILY_K1')!.face).toBe('DAILY');
  });

  it('三位编号（100 パトラ）', () => {
    const r = parseKojoFamily('KOJO_MESSAGE_COM_K100')!;
    expect(r.characterNo).toBe(100);
    expect(r.face).toBe('MESSAGE_COM');
  });

  it('无 KOJO_ 前缀的面（CNAME / CLOTHES / EVENT_PROFILE 等）', () => {
    expect(parseKojoFamily('CNAME_K1')).toMatchObject({ face: 'CNAME', characterNo: 1 });
    expect(parseKojoFamily('CLOTHES_K1')!.face).toBe('CLOTHES');
    expect(parseKojoFamily('EVENT_PROFILE_K1')!.face).toBe('EVENT_PROFILE');
    expect(parseKojoFamily('IS_SINGLE_ENDING_K1')!.face).toBe('IS_SINGLE_ENDING');
    expect(parseKojoFamily('SETFLAG_BEFORE_TRAIN_K1')!.face).toBe('SETFLAG_BEFORE_TRAIN');
    expect(parseKojoFamily('MAIDFACE_K1')!.face).toBe('MAIDFACE');
  });

  it('KOJO_ 前缀归一：KOJO_WISH_K1 与 WISH_K1 归同一面', () => {
    expect(parseKojoFamily('KOJO_WISH_K1')!.face).toBe('WISH');
    expect(parseKojoFamily('WISH_K1')!.face).toBe('WISH');
    expect(parseKojoFamily('KOJO_DATE_K1')!.face).toBe('DATE');
    expect(parseKojoFamily('DATE_K1')!.face).toBe('DATE');
    expect(parseKojoFamily('KOJO_DAILY1_K1')!.face).toBe('DAILY1');
    expect(parseKojoFamily('DAILY1_K1')!.face).toBe('DAILY1');
    expect(parseKojoFamily('KOJO_DAILY2_K1')!.face).toBe('DAILY2');
  });

  it('尾部 `, ARGS` 入参声明被裁剪（真实语料形态）', () => {
    const r = parseKojoFamily('KOJO_MESSAGE_PALAMCNG_K1, ARGS')!;
    expect(r).toMatchObject({ face: 'MESSAGE_PALAMCNG', characterNo: 1, slot: '' });
    expect(parseKojoFamily('KOJO_COUNTER_K1, ARGS')!.face).toBe('COUNTER');
    expect(parseKojoFamily('KOJO_MESSAGE_MARKCNG_K1, ARGS')!.face).toBe('MESSAGE_MARKCNG');
    expect(parseKojoFamily('KOJO_DAILY_K1, ARGS')!.face).toBe('DAILY');
  });

  it('尾部空白与分号同样宽容', () => {
    expect(parseKojoFamily('KOJO_EVENT_K1  ')!.face).toBe('EVENT');
  });
});

describe('家族识别 · 尾段（slot）三条判据', () => {
  it('ADDSELECT（唯一主流尾段，345 处）', () => {
    expect(parseKojoFamily('KOJO_DAILY2_K1_ADDSELECT')).toMatchObject({
      face: 'DAILY2',
      characterNo: 1,
      slot: 'ADDSELECT',
    });
    expect(parseKojoFamily('KOJO_WISH_K1_ADDSELECT')!.face).toBe('WISH');
    expect(parseKojoFamily('DAILY1_K1_ADDSELECT')!.face).toBe('DAILY1');
    expect(parseKojoFamily('MOVE_K1_ADDSELECT')!.face).toBe('MOVE');
    expect(parseKojoFamily('DAILY2_SLEEP_K1_ADDSELECT')!.face).toBe('DAILY2_SLEEP');
  });

  it('纯数字尾：语音包变体 / 剧本私货（17 处，主路由不可达但信息不丢）', () => {
    // 15 槞彁/遺産 语音包变体（14 处）
    const a = parseKojoFamily('KOJO_MESSAGE_COM_K15_1')!;
    expect(a).toMatchObject({ face: 'MESSAGE_COM', characterNo: 15, slot: '1' });
    expect(parseKojoFamily('KOJO_EVENT_K15_1')!.face).toBe('EVENT');
    // 27 維吹 剧本私货（3 处）
    expect(parseKojoFamily('AFFAIRS_K27_2')).toMatchObject({ face: 'AFFAIRS', characterNo: 27, slot: '2' });
  });

  it('陌生尾段 ⇒ face 置空（拿不准不猜面，归属仍保留）', () => {
    // 库函数不是"事件面"：EVENT_K15_LIBRARY
    const lib = parseKojoFamily('EVENT_K15_LIBRARY')!;
    expect(lib).toMatchObject({ face: '', characterNo: 15, slot: 'LIBRARY' });
    expect(parseKojoFamily('SET_K15_UsedKojo')!.face).toBe('');
    expect(parseKojoFamily('Count_K15_CompleteRate')!.face).toBe('');
    // 私货尾巴
    expect(parseKojoFamily('KOJO_WISH_K25_USESOUL')!.face).toBe('');
  });

  it('家族段中缀：KOJO_K11_DAILY_TALK（head 只剩 KOJO，面不标）', () => {
    const r = parseKojoFamily('KOJO_K11_DAILY_TALK')!;
    expect(r).toMatchObject({ face: '', characterNo: 11, slot: 'DAILY_TALK' });
    expect(parseKojoFamily('KOJO_K11_LOCAL_STRING')!.slot).toBe('LOCAL_STRING');
  });
});

describe('家族识别 · KX 占位符与文件编号还原', () => {
  it('_KX{n} ⇒ placeholder / characterNo 为 null（不传 filePath）', () => {
    const r = parseKojoFamily('KOJO_MESSAGE_COM_KX1')!;
    expect(r).toMatchObject({
      kind: 'placeholder',
      face: 'MESSAGE_COM',
      characterNo: null,
      isPlaceholder: true,
    });
  });

  it('传 filePath 时按 EVENT_K{n} 锚还原角色号', () => {
    const p = 'C:\\game\\eraAkumaMaid\\ERB\\EVENT_K\\01 フェリシエル\\EVENT_K1.ERB';
    expect(parseKojoFamily('KOJO_MESSAGE_COM_KX1', p)).toMatchObject({
      kind: 'placeholder',
      characterNo: 1,
      isPlaceholder: true,
    });
    // 三位编号与子文件
    const p100 = 'C:\\game\\eraAkumaMaid\\ERB\\EVENT_K\\100 パトラ\\EVENT_K100_DAILY.ERB';
    expect(parseKojoFamily('KOJO_DAILY_KX1', p100)!.characterNo).toBe(100);
  });

  it('根层共享路由 / 模板包文件名取不到编号 ⇒ 仍为 null', () => {
    // EVENT_K.ERB：EVENT_K 后是 `.` 不是数字
    expect(
      parseKojoFamily('KOJO_MESSAGE_COM_KX1', 'C:\\game\\eraAkumaMaid\\ERB\\EVENT_K\\EVENT_K.ERB')!.characterNo,
    ).toBeNull();
    // 模板包：EVENT_KX1.ERB（X 非数字）
    expect(
      parseKojoFamily('KOJO_MESSAGE_COM_KX1', 'C:\\game\\eraAkumaMaid\\口上テンプレート\\EVENT_KX1.ERB')!
        .characterNo,
    ).toBeNull();
  });

  it('非占位符传 filePath 不改变判定（additive 零影响）', () => {
    const p = 'C:\\game\\eraAkumaMaid\\ERB\\EVENT_K\\01 フェリシエル\\EVENT_K1.ERB';
    expect(parseKojoFamily('KOJO_EVENT_K5', p)!.characterNo).toBe(5);
    expect(parseKojoFamily('KOJO_EVENT_K5', p)!.isPlaceholder).toBe(false);
  });
});

describe('家族识别 · 前缀式 K{n}_（eratw kn 语义）', () => {
  it('K{n}_KOJO2（74 处，每角色一份恋慕/刻印分支口上）', () => {
    const r = parseKojoFamily('K1_KOJO2')!;
    expect(r).toMatchObject({ kind: 'kn', characterNo: 1, slot: 'KOJO2', face: '', family: '' });
    expect(parseKojoFamily('K100_KOJO2')!.characterNo).toBe(100);
  });

  it('K{n}_LONG 系（27 处）', () => {
    expect(parseKojoFamily('K36_LONG')).toMatchObject({ kind: 'kn', characterNo: 36, slot: 'LONG' });
    expect(parseKojoFamily('K36_LONG_03')!.slot).toBe('LONG_03');
  });
});

describe('家族识别 · 拒绝非口上函数（宁可漏报不误报）', () => {
  it('每角色重复的无编号定义 → null', () => {
    expect(parseKojoFamily('EVENTTRAIN')).toBeNull();
    expect(parseKojoFamily('EVENTEND')).toBeNull();
  });

  it('库函数 / 引擎助手 / 畸形名 → null', () => {
    expect(parseKojoFamily('LIBT_PRINT')).toBeNull();
    expect(parseKojoFamily('LIBDF_GET')).toBeNull();
    expect(parseKojoFamily('D20XX_OS_HTMLReInput')).toBeNull();
    expect(parseKojoFamily('')).toBeNull();
  });

  it('无数字锚的 K 前缀（K15_ 空尾）→ null', () => {
    expect(parseKojoFamily('K15_')).toBeNull();
  });
});

describe('名称解析 memo', () => {
  it('命中/未命中计数（含 null 命中）', () => {
    const m = createKojoFamilyMemo();
    m.parse('KOJO_MESSAGE_COM_K1');
    m.parse('KOJO_MESSAGE_COM_K1'); // 命中
    m.parse('EVENTTRAIN'); // 未命中，缓存 null
    m.parse('EVENTTRAIN'); // 命中 null
    expect(m.stats()).toEqual({ hits: 2, misses: 2 });
  });

  it('键含 filePath：同名不同文件各自缓存（占位符对齐不串味）', () => {
    const m = createKojoFamilyMemo();
    const a = m.parse('KOJO_EVENT_KX1', 'X/EVENT_K1.ERB')!;
    const b = m.parse('KOJO_EVENT_KX1', 'X/EVENT_K2.ERB')!;
    expect(a.characterNo).toBe(1);
    expect(b.characterNo).toBe(2);
    expect(m.size()).toBe(2);
  });

  it('limit 满整表清空（不是 LRU）', () => {
    const m = createKojoFamilyMemo(3);
    m.parse('A_K1');
    m.parse('A_K2');
    m.parse('A_K3');
    m.parse('A_K4'); // 第 4 条：满 ⇒ 清空后写入
    expect(m.size()).toBe(1);
  });

  it('clear 后重新解析', () => {
    const m = createKojoFamilyMemo();
    m.parse('KOJO_EVENT_K1');
    expect(m.size()).toBe(1);
    m.clear();
    expect(m.size()).toBe(0);
  });

  it('共享 memo：clearKojoFamilyMemo 可清（不改变判定）', () => {
    clearKojoFamilyMemo();
    expect(parseKojoFamily('KOJO_EVENT_K1')!.face).toBe('EVENT');
    clearKojoFamilyMemo();
  });
});

describe('FamilyIndexRule 包装', () => {
  it('name / match 契约', () => {
    const rule = createErakumamaidFamilyIndex();
    expect(rule.name).toBe('eraakumamaid-family-index');
    expect(rule.match('KOJO_MESSAGE_COM_K1')!.face).toBe('MESSAGE_COM');
    expect(rule.match('EVENTTRAIN')).toBeNull();
  });

  it('instructionFaces 为空数组（本游戏无指令号尾槽，显式声明）', () => {
    expect(createErakumamaidFamilyIndex().instructionFaces).toEqual([]);
  });

  it('faceLabels 覆盖 face-templates 收录的全部 10 个糖面', () => {
    for (const face of [
      'MESSAGE_COM',
      'MESSAGE_BEFORE_COM',
      'MESSAGE_PALAMCNG',
      'MESSAGE_MARKCNG',
      'COUNTER',
      'EVENT',
      'MESSAGE_SHOOT',
      'MESSAGE_COMING',
      'MESSAGE_SAMEN_AND_EXTACY',
      'DAILY',
    ]) {
      expect(ERAAKUMA_MAID_FACE_LABELS[face], face).toBeTruthy();
    }
    expect(ERAAKUMA_MAID_FACE_LABELS.MESSAGE_COM).toBe('指令口上');
    expect(ERAAKUMA_MAID_FACE_LABELS.MESSAGE_PALAMCNG).toBe('参数变动');
  });

  it('faceLabels 已冻结（防消费方改写共享表）', () => {
    expect(Object.isFrozen(ERAAKUMA_MAID_FACE_LABELS)).toBe(true);
  });

  it('解析结果是冻结对象（memo 共享实例的前提）', () => {
    expect(Object.isFrozen(parseKojoFamily('KOJO_EVENT_K1'))).toBe(true);
  });
});
