import { describe, expect, it } from 'vitest';
import { erbNameSlotAt } from '../src/slot-shape';

/**
 * 名字槽判定的闸（B 线 · IC 批）。
 *
 * 这一层只回答一件事："光标**是否**在一格名字槽里、那一段的区间在哪、已经打出来的是哪几个字"。
 * 调用形态一律 `slot(prefix, suffix)` —— **光标就在 `prefix` 的末尾**，与宿主递进来的
 * "光标把当前行切成两段"逐字同构（本包从不读 `lineText`，所以夹具也不许用它拼光标）。
 *
 * 每条断言都在钉一个**会真出事的漂移**：
 * - 区间算错 ⇒ 幽灵文本吃掉后面的实参 / 漏掉尾巴（作者接受后行被改坏）；
 * - 该弃权的形状认下来 ⇒ 在清单位/拼接位/标签位上插函数名；
 * - 注释行 / 代码前缀判错 ⇒ 要么在 `;` 注释里出字，要么 `;!;` 的合法代码行整条哑掉。
 */

const DIM_LIKE = new Set(['DIM', 'DIMS', 'DIMSTR']);

describe('形状①：行首 @ 定义位', () => {
  it('已打前缀落在名字段内，区间从名字起点开始（不含 @）', () => {
    const slot = erbNameSlotAt('@M_KOJ', '', DIM_LIKE);
    expect(slot).not.toBeNull();
    expect(slot!.shape).toBe('definition');
    expect(slot!.catalog).toBe('functions');
    expect(slot!.start).toBe(1);
    expect(slot!.end).toBe(6);
    expect(slot!.typed).toBe('M_KOJ');
  });

  it('光标紧贴 @（还没打字）⇒ 槽成立但 typed 是空串（弃权归 provider 判）', () => {
    const slot = erbNameSlotAt('@', 'AB', DIM_LIKE);
    expect(slot!.start).toBe(1);
    expect(slot!.end).toBe(3);
    expect(slot!.typed).toBe('');
  });

  it('光标还在 @ 与名字之间的空白里 ⇒ 不认（那一格不是名字）', () => {
    expect(erbNameSlotAt('@ ', ' AB', DIM_LIKE)).toBeNull();
  });

  it('缩进与 ;!; / ;#; 代码前缀都算进列坐标', () => {
    expect(erbNameSlotAt('   @AB', '', DIM_LIKE)!.start).toBe(4);
    const prefixed = erbNameSlotAt(';!;@AB', '', DIM_LIKE);
    expect(prefixed!.start).toBe(4);
    expect(prefixed!.end).toBe(6);
    expect(prefixed!.typed).toBe('AB');
    expect(erbNameSlotAt(';#;@AB', '', DIM_LIKE)!.start).toBe(4);
  });

  it('名字段的结束判据与解析器同一套：( , 空格 制表 ; 之外都算名字', () => {
    // 中文函数名整体是一枚名字，到 `(` 才收
    const withArgs = erbNameSlotAt('@增加羁绊', '(ARGS, 2)', DIM_LIKE);
    expect(withArgs!.typed).toBe('增加羁绊');
    expect(withArgs!.end).toBe(5);
    // 名字里出现空格 = 解析器也会在那里收刀（口径同 parseFunctionDefinition）
    expect(erbNameSlotAt('@增加', ' 羁绊', DIM_LIKE)!.end).toBe(3);
  });

  it('光标已经离开名字段（跑到后面的实参/尾巴上）⇒ 不认', () => {
    expect(erbNameSlotAt('@AB ', 'C', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('@AB(ARG', 'S)', DIM_LIKE)).toBeNull();
  });

  it('@"" 形是 FORM 续行，不是定义 ⇒ 不认', () => {
    expect(erbNameSlotAt('@', '"%UNICODE(0x2660)%."', DIM_LIKE)).toBeNull();
  });

  it('; 注释行里不认（整行是注释，没有代码语义）', () => {
    expect(erbNameSlotAt(';@AB', '', DIM_LIKE)).toBeNull();
  });
});

describe('形状②：CALL 直系族的调用位', () => {
  it('CALL 之后那一位是名字槽，光标在词中间也覆盖整段', () => {
    const slot = erbNameSlotAt('CALL FO', 'O, 1', DIM_LIKE);
    expect(slot!.shape).toBe('call');
    expect(slot!.typed).toBe('FO');
    expect(slot!.start).toBe(5);
    // 区间覆盖整个 FOO（含光标右侧那一枚 O），不覆盖 `, 1`
    expect(slot!.end).toBe(8);
  });

  it('TRYCALL / TRYCCALL 同样服务；带前置修饰词的行（首词不是整词）不服务', () => {
    expect(erbNameSlotAt('TRYCALL AB', '', DIM_LIKE)!.shape).toBe('call');
    expect(erbNameSlotAt('TRYCCALL AB', '', DIM_LIKE)!.shape).toBe('call');
    expect(erbNameSlotAt('T TRYCCALL AB', '', DIM_LIKE)).toBeNull();
  });

  it('关键字后空着 ⇒ 槽存在但 typed 空串（绝不补名录的第一条）', () => {
    const slot = erbNameSlotAt('CALL ', '', DIM_LIKE);
    expect(slot!.typed).toBe('');
    expect(slot!.start).toBe(5);
    expect(slot!.end).toBe(5);
    expect(erbNameSlotAt('CALL', '', DIM_LIKE)!.typed).toBe('');
  });

  it('清单族 / 拼接族 / 跳转族一律不认（那几位不是"一个名字"）', () => {
    expect(erbNameSlotAt('TRYCALLLIST AB', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('CALLFORM AB', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('GOTO AB', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('JUMP *AB', '', DIM_LIKE)).toBeNull();
  });

  it('普通语句行（PRINT / IF / 赋值）不在本形状的服务面内', () => {
    expect(erbNameSlotAt('PRINT AB', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('FLAG:1 = 2', '', DIM_LIKE)).toBeNull();
  });

  it('大小写不敏感（引擎按整词大写比对）', () => {
    expect(erbNameSlotAt('call AB', '', DIM_LIKE)!.shape).toBe('call');
  });
});

describe('形状③：#<声明指令> 之后的声明名位', () => {
  it('指令词表按**索引派生集合**认：在集合里才判位', () => {
    const slot = erbNameSlotAt('#DIM GOOD', '', DIM_LIKE);
    expect(slot!.shape).toBe('declaration');
    expect(slot!.catalog).toBe('declared');
    // `#` 也算进偏移：名字从下标 5 起
    expect(slot!.start).toBe(5);
    expect(slot!.end).toBe(9);
    expect(slot!.typed).toBe('GOOD');
  });

  it('不在派生集合里的指令词 ⇒ 不认（解析器扩族时本包零改动）', () => {
    expect(erbNameSlotAt('#DIMFROB GOOD', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('#DIM GOOD', '', new Set<string>())).toBeNull();
  });

  it('逗号之后那一位是数组维度/初值，不是第二个名字 ⇒ 只服务首槽', () => {
    const slot = erbNameSlotAt('#DIM 名称', ', 1', DIM_LIKE);
    expect(slot!.end).toBe(7); // 首槽 = "名称"
    // 光标已经跑到维度那一格上 ⇒ 整条不认（不是"给第二个名字"）
    expect(erbNameSlotAt('#DIM 名称, 1', '', DIM_LIKE)).toBeNull();
  });

  it('#DEFINE / #FUNCTION 这些不在派生集合里的 # 行不认', () => {
    expect(erbNameSlotAt('#DEFINE ABC', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('#FUNCTION ABC', '', DIM_LIKE)).toBeNull();
  });
});

describe('通用弃权面', () => {
  it('含换行的请求不判位（三条形状全按单行算）', () => {
    expect(erbNameSlotAt('@A\nB', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('A\r', '', DIM_LIKE)).toBeNull();
  });

  it('空行 / 纯缩进 ⇒ null', () => {
    expect(erbNameSlotAt('', '', DIM_LIKE)).toBeNull();
    expect(erbNameSlotAt('   ', '', DIM_LIKE)).toBeNull();
  });

  it('散文行（行首不是 @ / # / 语句词）⇒ null，一视同仁', () => {
    expect(erbNameSlotAt('她走了过来', '', DIM_LIKE)).toBeNull();
  });
});
