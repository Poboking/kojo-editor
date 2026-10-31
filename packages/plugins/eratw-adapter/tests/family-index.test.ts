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

  it('faceLabels：面 token → 中文（用户所见的 MESSAGE_COM/SUCCESS_COM/MESSAGE 均已收录）', () => {
    const labels = createEratwFamilyIndex().faceLabels!;
    expect(labels.MESSAGE_COM).toBe('指令口上');
    expect(labels.SUCCESS_COM).toBe('指令成否');
    expect(labels.MESSAGE).toBe('通用口上');
    // 表与 PLAIN_FACES 同源：任一识别出的面都有标签（'' 与 declare 由消费方兜底，不入表）
    for (const face of ['ENCOUNTER', 'EVENT', 'SPEVENT', 'COLOR', 'MESSAGE_ENDING', 'IRAI', 'DIARY']) {
      expect(labels[face]).toBeTypeOf('string');
    }
    expect(labels['']).toBeUndefined();
    expect(labels.declare).toBeUndefined();
  });

  it('instructionFaces：列出 8 个指令承载面（条件矩阵据此细分列）', () => {
    const faces = createEratwFamilyIndex().instructionFaces!;
    expect(faces).toHaveLength(8);
    expect([...faces].sort()).toEqual(
      [
        'EXTRASOURCE_COM',
        'EXTRASOURCE_SCOM',
        'MESSAGE_COM',
        'MESSAGE_CUSTOM_COM',
        'MESSAGE_CUSTOM_SCOM',
        'MESSAGE_SCOM',
        'SUCCESS_COM',
        'SUCCESS_SCOM',
      ].sort(),
    );
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

describe('KX 占位符按文件路径编号还原（additive：第二参 filePath 可选）', () => {
  const rule = createEratwFamilyIndex();

  it('KX 名 + 文件路径（…/阿燐/M_KOJO_K36_コマンド.ERB）→ characterNo 36', () => {
    // 文件名 basename 的 ^M_KOJO_K36 = 真编号；函数名里的 KX 是模板残留
    const m = rule.match(
      'M_KOJO_MESSAGE_COM_KX_90',
      'C:\\game\\個人口上\\阿燐\\M_KOJO_K36_コマンド.ERB',
    )!;
    expect(m).toMatchObject({
      kind: 'placeholder',
      face: 'MESSAGE_COM',
      characterNo: 36,
      isPlaceholder: true,
      slot: '90',
    });
  });

  it('KX 名 + **不传路径** → 与旧行为逐字一致（characterNo null，仍占位符）', () => {
    const m = rule.match('M_KOJO_MESSAGE_COM_KX_90')!;
    expect(m).toMatchObject({ kind: 'placeholder', isPlaceholder: true, characterNo: null });
  });

  it('KX 名 + 路径 basename 非 M_KOJO_K{digits} → 不改判定（characterNo null）', () => {
    const m = rule.match('M_KOJO_MESSAGE_COM_KX_90', '/kojo/some/OTHER_FILE.ERB')!;
    expect(m).toMatchObject({ isPlaceholder: true, characterNo: null });
  });

  it('编号名不受路径影响（非占位符不参与对齐）', () => {
    expect(rule.match('M_KOJO_MESSAGE_COM_K1_30')?.characterNo).toBe(1);
    expect(rule.match('M_KOJO_MESSAGE_COM_K1_30', '/x/M_KOJO_K36_コマンド.ERB')?.characterNo).toBe(1);
  });

  it('memo 键包含 filePath：同名不同文件各自对齐、不串味', () => {
    const memo = createKojoFamilyMemo();
    const name = 'M_KOJO_MESSAGE_COM_KX_90';
    const a = memo.parse(name, '/kojo/阿燐/M_KOJO_K36_コマンド.ERB');
    const b = memo.parse(name, '/kojo/魔理沙/M_KOJO_K8_コマンド.ERB');
    expect(a?.characterNo).toBe(36);
    expect(b?.characterNo).toBe(8);
    expect(memo.size()).toBe(2); // 两条独立条目
    // 同键二次 ⇒ 命中同一实例（memo 在生效）
    expect(memo.parse(name, '/kojo/阿燐/M_KOJO_K36_コマンド.ERB')).toBe(a);
    // 不带路径 ⇒ 又一条独立条目，且回到占位符原样（characterNo null）
    expect(memo.parse(name)?.characterNo).toBeNull();
    expect(memo.size()).toBe(3);
  });

  it('159 先代：文件名 `M_KOJO_K1[]` 是 dummy → 回退父目录名取 159（非 1）', () => {
    const m = rule.match(
      'M_KOJO_MESSAGE_COM_KX_90',
      'C:\\game\\eratw-画蛇添足版eratw4.980\\ERB\\口上・メッセージ関連\\個人口上\\159 先代\\M_KOJO_K1[]_コマンド.ERB',
    )!;
    expect(m).toMatchObject({ kind: 'placeholder', isPlaceholder: true, characterNo: 159 });
  });

  it('真形态后继字符（`.` / 空格 / 汉字）不受占位排除影响', () => {
    const at = (file: string) => rule.match('M_KOJO_MESSAGE_COM_KX_90', `C:\\game\\個人口上\\x\\${file}`)!;
    expect(at('M_KOJO_K86.ERB').characterNo).toBe(86);
    expect(at('M_KOJO_K37 カウンター.ERB').characterNo).toBe(37);
    expect(at('M_KOJO_K75刻印取得.ERB').characterNo).toBe(75);
  });
});

/**
 * 锚点搜索的**终止性**（2026-11 卡死回归）。
 *
 * 病史：`splitAtLastKAnchor` 从右往左退锚点，靠 `limit = k` 递减。退到 `k === 0` 之后，
 * 下一轮 `lastIndexOf('_K', -1)` 会被 JS 把负 position **钳到 0**——若这个名字恰以 `_K`
 * 开头，它返回的还是 0，`k` 原地不动 ⇒ `for(;;)` 空转。表现不是报错而是**页面满核自旋**
 * （单线程 1.00 核、无日志、连 CDP 都投递不进去），打开大项目索引一完成就必然复现。
 *
 * 触发形态全是「剥前缀后以 `_KX` 开头」：`_K` 后跟非数字 ⇒ 不进"数字 + 槽位"那条分支
 * ⇒ 直接落到 `limit = k`。而 `_KX` 正是本适配器显式支持的占位符形态（`/_KX(?:_|$)/`），
 * 所以这个 bug 的实际效果是**占位符那一整支永远执行不到**。
 *
 * 下面 4 个名字全部取自 eraTW 4.981 语料（120284 个函数名里就这 4 个命中）。
 */
describe('锚点搜索必须终止（无面段的 _KX 形态）', () => {
  const rule = createEratwFamilyIndex();

  const STUCK_NAMES = [
    'M_KOJO_KX_X',
    'M_KOJO_KX_X内的RESULTS:2，可以写入剧本描述文。<br>',
    'DIARY_KX_YY_HAPPEN',
    'DIARY_KX_YY',
  ];

  for (const name of STUCK_NAMES) {
    // 终止性兜底就是这条超时：若 `for(;;)` 空转回归，用例会一直挂在这里直到超时失败。
    // （不用墙钟断言——那会把整份文件推进 perf 池，主套件就再也跑不到它了。）
    it(`${name} → 有限步内给出占位符判定`, { timeout: 2000 }, () => {
      const m = rule.match(name);
      expect(m).toMatchObject({ kind: 'placeholder', isPlaceholder: true, characterNo: null });
    });
  }

  it('正常形态的判定一字未动（修终止性不动语义）', () => {
    expect(rule.match('M_KOJO_MESSAGE_COM_K1_30')).toMatchObject({
      kind: 'ok',
      face: 'MESSAGE_COM',
      characterNo: 1,
      slot: '30',
    });
    // 最右锚点仍然生效（BUG-3 的贪婪语义）
    expect(rule.match('X_K3_MESSAGE_COM_K1_1')?.characterNo).toBe(1);
    // 无锚点的名字仍旧拒绝
    expect(rule.match('M_KOJO_MESSAGE_COM')).toBeNull();
  });
});
