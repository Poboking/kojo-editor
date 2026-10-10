/**
 * S2 批 · 语法糖转译单测（规范 §3 每条糖 + §5 降糖算法 + 错误路径）。
 *
 * 组织：按规范章节顺序，一节一组。所有断言都直接对着产物字符串
 * （不依赖快照），失败时给出的信息足以定位到具体糖。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';

/** 测试字典桩（游戏知识只允许出现在测试里） */
const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '胆怯' || name === '恋慕' || name === '思慕') return 'TALENT';
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (
      ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR', 'FLAG', 'TFLAG'].includes(head)
    ) {
      return ident;
    }
    return undefined;
  },
};

const svc = () => createSugarTranspileService({ dictionary: stubDict });
const t = (src: string) => svc().transpile(src);
const body = (src: string) => {
  const r = t(src);
  const start = r.erb.indexOf('IF LOCAL');
  const end = r.erb.indexOf('\nENDIF');
  return start < 0 ? '' : r.erb.slice(start, end + 6);
};
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);

/* ============================================================================ */
/* §3.1 文件结构与头部声明                                                        */
/* ============================================================================ */

describe('§3.1 头部声明 · 三件套函数名拼装（§5.5）', () => {
  it('标准版：`角色:` 生成 K{No} 骨架，无口上 → 不生成登记函数', () => {
    const { erb } = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_310_1');
    expect(erb).not.toContain('@M_KOJO_K12');
  });

  it('别人版：`口上: 破空自制` → 函数名带家族段（下划线由工具补）', () => {
    const { erb } = t('角色: 14\n口上: 破空自制\n时机 指令 100：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_K14');
    expect(erb).toContain('RESULTS = "_破空自制"');
    expect(erb).toContain('@M_KOJO_破空自制_MESSAGE_COM_K14_100');
  });

  it('`显示名:` / `简介:` → RESULTS:1 / RESULTS:2', () => {
    const { erb } = t('角色: 12\n显示名: 的AA琪露诺版\n简介: 国人自制\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('RESULTS:1 = "的AA琪露诺版"');
    expect(erb).toContain('RESULTS:2 = "国人自制"');
  });

  it('`口上色:` → @M_KOJO_COLOR_K{No} + SETCOLOR，且排在全部时机之后', () => {
    const { erb } = t('角色: 12\n口上色: 0xE4FC08\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_COLOR_K12');
    expect(erb).toContain('SETCOLOR 0xE4FC08');
    expect(erb.indexOf('@M_KOJO_COLOR_K12')).toBeGreaterThan(erb.indexOf('@M_KOJO_MESSAGE_COM_K12_310_1'));
  });

  it('未声明 `口上色:` → 不生成 COLOR 函数', () => {
    const { erb } = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    expect(erb).not.toContain('@M_KOJO_COLOR_K12');
  });

  it('`开关:` 缩进块 → @M_KOJO_FLAGSETTING_K{No}（是→1，否→0）', () => {
    const { erb } = t('角色: 12\n开关:\n    眠姦口上有: 是\n    時間停止口上有: 否\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_FLAGSETTING_K12');
    expect(erb).toContain('FLAG:眠姦口上有 = 1');
    expect(erb).toContain('FLAG:時間停止口上有 = 0');
  });

  it('英文别名 `char:` / `family:` / `color:` 等价生效', () => {
    const { erb } = t('char: 12\nfamily: custom\ncolor: 0xFF0000\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_custom_MESSAGE_COM_K12_310');
    expect(erb).toContain('SETCOLOR 0xFF0000');
  });
});

/* ============================================================================ */
/* §3.1 别名 · 四右值 + 三约束                                                    */
/* ============================================================================ */

describe('§3.1 / §3.8 别名 · 四右值', () => {
  it('变量别名：读位置展开为变量引用', () => {
    const { erb } = t('角色: 12\n别名 今天已触发 = CFLAG:TARGET:1088\n时机 指令 310：\n    如果 今天已触发：\n        「做过。」\n');
    expect(erb).toContain('IF CFLAG:TARGET:1088');
  });

  it('变量别名：写位置（赋值左值）也展开（可读写）', () => {
    const { erb } = t('角色: 12\n别名 今天已触发 = CFLAG:TARGET:1088\n时机 指令 310：\n    今天已触发 = 1\n');
    expect(erb).toContain('CFLAG:TARGET:1088 = 1');
  });

  it('角色别名：插值内 → %CALLNAME:N%', () => {
    const { erb } = t('角色: 12\n别名 朋友 = 角色 15\n时机 指令 310：\n    「{朋友}来了。」\n');
    expect(erb).toContain('%CALLNAME:15%');
  });

  it('数值字面量别名：表达式位置纯文本展开为数值', () => {
    const { erb } = t('角色: 12\n别名 安静 = 0\n时机 指令 310：\n    如果 她的心情 等于 安静：\n        「嗯。」\n');
    expect(erb).toContain('== 0');
  });

  it('字符串字面量别名：表达式位置展开为字符串字面量', () => {
    const { erb } = t('角色: 12\n别名 昵称 = "小露"\n时机 指令 310：\n    如果 她的心情 等于 昵称：\n        「嗯。」\n');
    expect(erb).toContain('== "小露"');
  });

  it('别名优先于字典：作者显式声明覆盖默认解析', () => {
    const { erb } = t('角色: 12\n别名 恋慕 = CFLAG:MINE\n时机 指令 310：\n    如果 恋慕：\n        「嗯。」\n');
    expect(erb).toContain('IF CFLAG:MINE');
  });
});

describe('§3.1 别名 · 三约束（错误路径）', () => {
  it('① 出现在时机之后 → alias-not-in-header', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「呀。」\n别名 X = 0\n')).toContain('alias-not-in-header');
  });

  it('② 与保留代词同名 → alias-name-conflict', () => {
    expect(codes('角色: 12\n别名 她 = CFLAG:1\n时机 指令 310：\n    「呀。」\n')).toContain('alias-name-conflict');
    expect(codes('角色: 12\n别名 你 = CFLAG:1\n时机 指令 310：\n    「呀。」\n')).toContain('alias-name-conflict');
  });

  it('② 重名 → alias-duplicate', () => {
    expect(codes('角色: 12\n别名 X = CFLAG:1\n别名 X = CFLAG:2\n时机 指令 310：\n    「呀。」\n')).toContain(
      'alias-duplicate',
    );
  });

  it('只读别名作赋值左值 → readonly-alias-assignment（且不产出 `0 = 1`）', () => {
    const src = '角色: 12\n别名 安静 = 0\n时机 指令 310：\n    安静 = 1\n';
    expect(codes(src)).toContain('readonly-alias-assignment');
    expect(t(src).erb).not.toContain('0 = 1');
  });

  it('角色别名作赋值左值 → readonly-alias-assignment', () => {
    expect(codes('角色: 12\n别名 朋友 = 角色 15\n时机 指令 310：\n    朋友 = 1\n')).toContain(
      'readonly-alias-assignment',
    );
  });
});

/* ============================================================================ */
/* §3.2 时机声明 · 分野 / 命名参数 / MESSAGECHECK                                 */
/* ============================================================================ */

describe('§3.2 时机 · 分野函数名（§5.5 模板）', () => {
  const cases: [string, string][] = [
    ['初见', '@M_KOJO_ENCOUNTER_K12'],
    ['绝顶', '@M_KOJO_MESSAGE_PALAMCNG_B_K12'],
    ['标记', '@M_KOJO_MESSAGE_MARKCNG_K12'],
    ['日记', '@DIARY_TEXT_K12'],
    ['成功', '@M_KOJO_SUCCESS_COM_K12'],
  ];
  for (const [face, expected] of cases) {
    it(`时机 ${face} → ${expected}`, () => {
      const head = face === '日记' || face === '初见' || face === '绝顶' || face === '标记' ? face : `${face}`;
      const src =
        face === '成功'
          ? `角色: 12\n时机 成功：\n    「呀。」\n`
          : `角色: 12\n时机 ${head}：\n    「呀。」\n`;
      expect(t(src).erb).toContain(expected);
    });
  }

  it('时机 指令 310 → MESSAGE_COM_K12_310', () => {
    expect(t('角色: 12\n时机 指令 310：\n    「呀。」\n').erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
  });

  it('类型: SCOM → MESSAGE_SCOM', () => {
    expect(t('角色: 12\n时机 指令 310 类型: SCOM：\n    「呀。」\n').erb).toContain('@M_KOJO_MESSAGE_SCOM_K12_310');
  });

  it('时机 事件 100 → EVENT_K12_100', () => {
    expect(t('角色: 12\n时机 事件 100：\n    「呀。」\n').erb).toContain('@M_KOJO_EVENT_K12_100');
  });

  it('未知分野 → timing-face-unknown 且不产出半成品', () => {
    const src = '角色: 12\n时机 不存在：\n    「呀。」\n';
    expect(codes(src)).toContain('timing-face-unknown');
  });
});

describe('§3.2 时机 · 命名参数 `成否:`', () => {
  it('游戏判定 → SUCCESS 函数 + TFLAG:192 = 0', () => {
    const { erb } = t('角色: 12\n时机 指令 310 成否: 游戏判定：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_SUCCESS_COM_K12_310');
    expect(erb).toContain('TFLAG:192 = 0');
  });

  it('一定成功 → TFLAG:192 = 1 / 一定失败 → -1 / 不执行 → -2', () => {
    expect(t('角色: 12\n时机 指令 310 成否: 一定成功：\n    「呀。」\n').erb).toContain('TFLAG:192 = 1');
    expect(t('角色: 12\n时机 指令 310 成否: 一定失败：\n    「呀。」\n').erb).toContain('TFLAG:192 = -1');
    expect(t('角色: 12\n时机 指令 310 成否: 不执行：\n    「呀。」\n').erb).toContain('TFLAG:192 = -2');
  });

  it('未写 `成否:` → 不生成 SUCCESS 函数', () => {
    expect(t('角色: 12\n时机 指令 310：\n    「呀。」\n').erb).not.toContain('SUCCESS');
  });
});

describe('§3.2 时机 · MESSAGECHECK（隐藏情景 / 隐藏口上）', () => {
  it('隐藏情景 → SETBIT RESULT, 0；隐藏口上 → SETBIT RESULT, 1', () => {
    const src = '角色: 12\n时机 指令 311：\n    隐藏情景: 如果 她睡着了\n    隐藏口上: 如果 她睡着了\n    「呀。」\n';
    const { erb } = t(src);
    expect(erb).toContain('MESSAGECHECK_SCENE_K12_311');
    expect(erb).toContain('MESSAGECHECK_KOJO_K12_311');
    expect(erb).toContain('SETBIT RESULT, 0');
    expect(erb).toContain('SETBIT RESULT, 1');
  });
});

/* ============================================================================ */
/* §3.3 文本行 · PRINTFORM 变体选择（§5.1）                                       */
/* ============================================================================ */

describe('§3.3 文本行 · §5.1 PRINTFORM 变体', () => {
  it('引号台词 + 等待 → PRINTFORMW', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「今天也来训练了？」\n')).toContain(
      '\tPRINTFORMW 「今天也来训练了？」',
    );
  });

  it('无引号旁白 + 等待 → PRINTFORMDW', () => {
    expect(body('角色: 12\n时机 指令 310：\n    她点了点头。\n')).toContain('\tPRINTFORMDW 她点了点头。');
  });

  it('引号台词 + `续` → PRINTFORML', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「……」 续\n')).toContain('\tPRINTFORML 「……」');
  });

  it('无引号旁白 + `续` → PRINTFORMDL', () => {
    expect(body('角色: 12\n时机 指令 310：\n    她叹了口气。 续\n')).toContain('\tPRINTFORMDL 她叹了口气。');
  });

  it('`旁白色: 作者色` → 旁白也走非 D 系（PRINTFORMW）', () => {
    const { erb } = t('角色: 12\n旁白色: 作者色\n时机 指令 310：\n    她点了点头。\n');
    expect(erb).toContain('\tPRINTFORMW 她点了点头。');
  });

  it('`续` 隐藏别名 `~` / `cont` 等价', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「……」 ~\n')).toContain('PRINTFORML');
    expect(body('角色: 12\n时机 指令 310：\n    「……」 cont\n')).toContain('PRINTFORML');
  });

  it('`｢｣` 半角引号同样判为台词', () => {
    expect(body('角色: 12\n时机 指令 310：\n    ｢你好。｣\n')).toContain('PRINTFORMW ｢你好。｣');
  });
});

/* ============================================================================ */
/* §3.3 / §5.2 纯条件行                                                          */
/* ============================================================================ */

describe('§3.3 / §5.2 纯条件行 → IF 块', () => {
  it('整行只有一个条件插值且假分支为空 → IF / PRINT / ENDIF', () => {
    const out = body('角色: 12\n时机 指令 310：\n    {她的恋慕 ? "她的耳朵红了。" : ""}\n');
    expect(out).toContain('IF TALENT:TARGET:恋慕');
    expect(out).toContain('PRINTFORMDW 她的耳朵红了。');
    expect(out).toContain('ENDIF');
  });

  it('省略假分支的纯条件行同样成块', () => {
    const out = body('角色: 12\n时机 指令 310：\n    {她的恋慕 ? "她的耳朵红了。"}\n');
    expect(out).toContain('IF TALENT:TARGET:恋慕');
  });

  it('混在其它文本里的条件插值 → 行内 `\\@…\\@`（不成块）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    「嗯…{她的恋慕 ? "脸红" : ""}」\n');
    expect(out).toContain('PRINTFORMW');
    expect(out).toContain('\\@TALENT:TARGET:恋慕?脸红\\@');
    expect(out).not.toContain('IF TALENT:TARGET:恋慕');
  });

  it('两侧非空的行内条件 → `\\@条件?A#B\\@`', () => {
    const out = body('角色: 12\n时机 指令 310：\n    「{她的恋慕 ? "只有你" : "别靠太近"}」\n');
    expect(out).toContain('\\@TALENT:TARGET:恋慕?只有你#别靠太近\\@');
  });
});

/* ============================================================================ */
/* §3.4 插值 · 值插值分类                                                        */
/* ============================================================================ */

describe('§3.4 插值 · 值插值分类', () => {
  it('数值族属性 → `{CFLAG:…}`', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「好感度是{她的好感度}。」\n')).toContain(
      '{CFLAG:TARGET:好感度}',
    );
  });

  it('代词 `{她}` → `%CALLNAME:TARGET%`；`{你}` → `%CALLNAME:MASTER%`', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「{她}，你来了。」\n')).toContain('%CALLNAME:TARGET%');
    expect(body('角色: 12\n时机 指令 310：\n    「{你}，来了。」\n')).toContain('%CALLNAME:MASTER%');
  });

  it('字符串族属性 → `%…%`', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「{她的名字}」\n')).toContain('%CALLNAME:TARGET:名字%');
  });

  it('正文裸文本里的「她」「你」不替换', () => {
    const out = body('角色: 12\n时机 指令 310：\n    她的母亲来了。\n');
    expect(out).toContain('她的母亲来了。');
    expect(out).not.toContain('%CALLNAME');
  });

  it('`{}` 内出现 `当`/`如果` → interpolation-block-expression', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「{当 她的心情：}」\n')).toContain('interpolation-block-expression');
  });

  it('`{` 未收尾 → interpolation-unclosed', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「{她的好感度」\n')).toContain('interpolation-unclosed');
  });

  it('嵌套 `{}` → interpolation-nested', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「{a{b}}」\n')).toContain('interpolation-nested');
  });

  it('落单 `%` → stray-percent 警告（非致命）', () => {
    const r = t('角色: 12\n时机 指令 310：\n    「打折50%。」\n');
    expect(r.diagnostics.some((d) => d.code === 'stray-percent' && d.severity === 'warning')).toBe(true);
  });
});

/* ============================================================================ */
/* §3.5 如果 / 否则如果 / 否则                                                    */
/* ============================================================================ */

describe('§3.5 如果块', () => {
  it('多分支 → IF / ELSEIF / ELSE / ENDIF', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 她的恋慕：\n        「只有你。」\n    否则如果 她的思慕：\n        「别靠太近。」\n    否则：\n        「……」\n';
    const out = body(src);
    expect(out).toContain('IF TALENT:TARGET:恋慕');
    expect(out).toContain('ELSEIF TALENT:TARGET:思慕');
    expect(out).toContain('\tELSE');
    expect(out).toContain('ENDIF');
  });

  it('嵌套如果块', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    如果 她的恋慕：\n        如果 她的思慕：\n            「嗯。」\n        「哦。」\n';
    const out = body(src);
    expect(out.match(/IF /g)?.length).toBeGreaterThanOrEqual(2);
    expect(out.match(/ENDIF/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('中文运算符降糖：等于/超过/至少/不足/至多/且/或', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 她的好感度 至少 100 且 她的好感度 至多 200：\n        「嗯。」\n';
    const out = body(src);
    expect(out).toContain('>= 100');
    expect(out).toContain('<= 200');
    expect(out).toContain('&&');
  });

  it('`不等于` 长词优先于 `等于`（不产出 `! =`）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    如果 她的心情 不等于 0：\n        「嗯。」\n');
    expect(out).toContain('!= 0');
    expect(out).not.toContain('! =');
  });

  it('`不在` 范围取反 → !(X >= a && X <= b)（不转成 ||）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    如果 她的好感度 不在 0 到 99：\n        她皱了皱眉。\n');
    expect(out).toContain('!(CFLAG:TARGET:好感度 >= 0 && CFLAG:TARGET:好感度 <= 99)');
    expect(out).not.toContain('||');
  });

  it('单行形式 `如果 条件： 内容`', () => {
    const out = body('角色: 12\n时机 指令 310：\n    如果 FLAG:70： 「这是……」\n');
    expect(out).toContain('IF FLAG:70');
    expect(out).toContain('PRINTFORMW 「这是……」');
  });
});

/* ============================================================================ */
/* §3.5 表达式 如果                                                              */
/* ============================================================================ */

describe('§3.5 表达式 如果（赋值位置）', () => {
  it('逐分支赋左值 → IF/ELSE + 左值 = 分支值', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    她的心情 = 如果 她的好感度 >= 500：\n        "热情"\n    否则：\n        "冷淡"\n';
    const out = body(src);
    expect(out).toContain('IF CFLAG:TARGET:好感度 >= 500');
    expect(out).toContain('CFLAG:TARGET:心情 = "热情"');
    expect(out).toContain('CFLAG:TARGET:心情 = "冷淡"');
  });

  it('缺 `否则` → expr-missing-else', () => {
    const src = '角色: 12\n时机 指令 310：\n    她的心情 = 如果 她的好感度 >= 500：\n        "热情"\n';
    expect(codes(src)).toContain('expr-missing-else');
  });

  it('分支体非单表达式 → expr-body-not-expression', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    她的心情 = 如果 她的好感度 >= 500：\n        "热情"\n        "多余"\n    否则：\n        "冷淡"\n';
    expect(codes(src)).toContain('expr-body-not-expression');
  });

  it('左值用别名 → 先按 §5.0 展开', () => {
    const src = '角色: 12\n别名 心情量 = CFLAG:TARGET:1088\n时机 指令 310：\n    心情量 = 如果 她的好感度 >= 500：\n        1\n    否则：\n        0\n';
    const out = body(src);
    expect(out).toContain('CFLAG:TARGET:1088 = 1');
    expect(out).toContain('CFLAG:TARGET:1088 = 0');
  });
});

/* ============================================================================ */
/* §3.6 当 / 是 / 到 / 否则                                                       */
/* ============================================================================ */

describe('§3.6 当块', () => {
  it('SELECTCASE / CASE / CASEELSE / ENDSELECT', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 TFLAG:193：\n        是 1：\n            「不、不要。」\n        是 2, 3：\n            「呜。」\n        否则：\n            她沉默着。\n';
    const out = body(src);
    expect(out).toContain('SELECTCASE TFLAG:193');
    expect(out).toContain('CASE 1');
    expect(out).toContain('CASE 2, 3');
    expect(out).toContain('CASEELSE');
    expect(out).toContain('ENDSELECT');
  });

  it('`是 5 到 8` → CASE 5 TO 8', () => {
    const out = body('角色: 12\n时机 指令 310：\n    当 她的心情：\n        是 5 到 8：\n            「呜。」\n');
    expect(out).toContain('CASE 5 TO 8');
  });

  it('字符串值 `是 "A"` → CASE "A"', () => {
    const out = body('角色: 12\n时机 指令 310：\n    当 她的心情：\n        是 "A"：\n            「嗯。」\n');
    expect(out).toContain('CASE "A"');
  });
});

/* ============================================================================ */
/* §3.6 表达式 当                                                                */
/* ============================================================================ */

describe('§3.6 表达式 当（赋值位置，`->` 分支）', () => {
  it('逐分支赋左值 → SELECTCASE + CASE/CASEELSE + 左值 = 值', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    她的心情 = 当 她的好感度：\n        是 0 到 99 -> 0\n        是 100 到 499 -> 1\n        否则 -> 2\n';
    const out = body(src);
    expect(out).toContain('SELECTCASE CFLAG:TARGET:好感度');
    expect(out).toContain('CASE 0 TO 99');
    expect(out).toContain('CFLAG:TARGET:心情 = 0');
    expect(out).toContain('CASE 100 TO 499');
    expect(out).toContain('CFLAG:TARGET:心情 = 1');
    expect(out).toContain('CASEELSE');
    expect(out).toContain('CFLAG:TARGET:心情 = 2');
  });

  it('缺 `否则` → expr-missing-else', () => {
    const src = '角色: 12\n时机 指令 310：\n    她的心情 = 当 她的好感度：\n        是 0 到 99 -> 0\n';
    expect(codes(src)).toContain('expr-missing-else');
  });
});

/* ============================================================================ */
/* §3.6 随机块 / 行内随机（§5.4 槽位）                                            */
/* ============================================================================ */

describe('§3.6 随机块 · §5.4 LOCAL 槽位', () => {
  it('随机块 → LOCAL = RAND:n + SELECTCASE + CASE i', () => {
    const out = body('角色: 12\n时机 指令 310：\n    随机：\n        「……呼。」\n        「再、再摸摸嘛。」\n');
    expect(out).toContain('LOCAL = RAND:2');
    expect(out).toContain('SELECTCASE LOCAL');
    expect(out).toContain('CASE 0');
    expect(out).toContain('CASE 1');
    expect(out).toContain('ENDSELECT');
  });

  it('两个随机块 → 槽位不冲突（LOCAL / LOCAL:1）', () => {
    const out = body(
      '角色: 12\n时机 指令 310：\n    随机：\n        「甲。」\n        「乙。」\n    随机：\n        「丙。」\n        「丁。」\n',
    );
    expect(out).toContain('LOCAL = RAND:2');
    expect(out).toContain('LOCAL:1 = RAND:2');
    expect(out).toContain('SELECTCASE LOCAL:1');
  });

  it('嵌套随机 → 内层槽位递增（LOCAL:1）', () => {
    const out = body(
      '角色: 12\n时机 指令 310：\n    随机：\n        「甲。」\n        随机：\n            「乙。」\n            「丙。」\n',
    );
    expect(out).toContain('LOCAL = RAND:2');
    expect(out).toContain('LOCAL:1 = RAND:2');
  });

  it('行内随机简写 `随机 「甲」,「乙」` → RAND + SELECTCASE', () => {
    const out = body('角色: 12\n时机 指令 310：\n    随机 「嗯。」,「哦？」\n');
    expect(out).toContain('LOCAL = RAND:2');
    expect(out).toContain('PRINTFORMW 「嗯。」');
  });

  it('空随机块 → block-empty', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    随机：\n')).toContain('block-empty');
  });
});

/* ============================================================================ */
/* §3.7 选项块                                                                   */
/* ============================================================================ */

describe('§3.7 选项块', () => {
  it('PRINTBUTTON 按序编号 + INPUTS + SELECTCASE RESULTS + CASE "n"', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    选项：\n        「用亲吻代替回答」：\n            「……唔。」\n        「摸摸头」：\n            「……好。」\n        「什么也不做」：\n            「……回去吧。」\n';
    const out = body(src);
    expect(out).toContain('PRINTBUTTON "用亲吻代替回答", "1"');
    expect(out).toContain('PRINTBUTTON "摸摸头", "2"');
    expect(out).toContain('PRINTBUTTON "什么也不做", "3"');
    expect(out).toContain('INPUTS');
    expect(out).toContain('SELECTCASE RESULTS');
    expect(out).toContain('CASE "1"');
    expect(out).toContain('CASE "3"');
    expect(out).toContain('ENDSELECT');
  });

  it('同一时机两个选项块 → choice-multiple', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    选项：\n        「A」：\n            「a」\n    选项：\n        「B」：\n            「b」\n';
    expect(codes(src)).toContain('choice-multiple');
  });

  it('选项块嵌套（在如果/选项体内）→ choice-nested', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    如果 她的好感度 超过 0：\n        选项：\n            「A」：\n                「a」\n';
    expect(codes(src)).toContain('choice-nested');
  });

  it('条目内可含其它块（如果 / 随机）', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    选项：\n        「A」：\n            如果 她的好感度 超过 0：\n                「嗯。」\n';
    const out = body(src);
    expect(out).toContain('PRINTBUTTON "A", "1"');
    expect(out).toContain('IF CFLAG:TARGET:好感度 > 0');
  });
});

/* ============================================================================ */
/* §3.9 心形 / 着色                                                              */
/* ============================================================================ */

describe('§3.9 心形 HPH_PRINT', () => {
  it('台词 + 等待 → `CALL HPH_PRINT(@"…","w")`（引号剥离、无空格）', () => {
    expect(body('角色: 12\n时机 指令 310：\n    心形 「……嗯。」\n')).toContain('CALL HPH_PRINT(@"……嗯。","w")');
  });

  it('台词 + 续 → mode `l`', () => {
    expect(body('角色: 12\n时机 指令 310：\n    心形 「……嗯。」 续\n')).toContain('CALL HPH_PRINT(@"……嗯。","l")');
  });

  it('旁白 + 等待 → mode `dw`（不剥引号）', () => {
    expect(body('角色: 12\n时机 指令 310：\n    心形 她轻轻叹了口气。\n')).toContain(
      'CALL HPH_PRINT(@"她轻轻叹了口气。","dw")',
    );
  });

  it('英文别名 `heart` 等价', () => {
    expect(body('角色: 12\n时机 指令 310：\n    heart 「……嗯。」\n')).toContain('CALL HPH_PRINT(@"……嗯。","w")');
  });
});

describe('§3.9 着色块', () => {
  it('SETCOLOR + 体 + RESETCOLOR（自动成对）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    着色 0xFF8080：\n        「这行是红色。」\n');
    expect(out).toContain('SETCOLOR 0xFF8080');
    expect(out).toContain('PRINTFORMW 「这行是红色。」');
    expect(out).toContain('RESETCOLOR');
  });

  it('空着色块 → block-empty', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    着色 0xFF8080：\n')).toContain('block-empty');
  });
});

/* ============================================================================ */
/* §3.10 注释 / 折行 / 原生直通                                                   */
/* ============================================================================ */

describe('§3.10 注释 · 折行 · 原生直通', () => {
  it('`;` 注释行不产出指令；行内注释被剥除', () => {
    const out = body('角色: 12\n时机 指令 310：\n    ; 这是注释\n    「呀。」\n');
    expect(out).toContain('PRINTFORMW 「呀。」');
    expect(out).not.toContain('这是注释');
  });

  it('行尾 `\\` 折行合并为一条 PRINT', () => {
    const out = body('角色: 12\n时机 指令 310：\n    「这是很长\\\n的一段台词。」\n');
    expect(out).toContain('PRINTFORMW 「这是很长的一段台词。」');
  });

  it('全大写指令行原样透传（SETCOLOR / TFLAG 赋值）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    SETCOLOR 0xFF0000\n    TFLAG:193 = 7\n');
    expect(out).toContain('SETCOLOR 0xFF0000');
    expect(out).toContain('TFLAG:193 = 7');
  });

  it('`$标签` 行原样透传', () => {
    expect(t('角色: 12\n时机 指令 310：\n    $myloop\n    「呀。」\n').erb).toContain('$myloop');
  });

  it('行首 `@` 起整块透传（含 `#DIM` 预处理行，块内不解析糖）', () => {
    const src = '角色: 12\n@MY_HELPER\n#DIM X\nX = 1\nRETURN\n';
    const { erb } = t(src);
    expect(erb).toContain('@MY_HELPER');
    expect(erb).toContain('#DIM X');
    expect(erb).toContain('X = 1');
  });

  it('折行里的 `续` 仍生效（合并后判尾标记）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    「分成两段\\\n的台词。」 续\n');
    expect(out).toContain('PRINTFORML');
  });
});

/* ============================================================================ */
/* §5.3 缩进配对 · 结构错误路径                                                   */
/* ============================================================================ */

describe('§5.3 缩进配对 · 结构错误路径', () => {
  it('顶层正文行（不在任何时机内）→ indent-mismatch', () => {
    expect(codes('角色: 12\n「没有时机。」\n')).toContain('indent-mismatch');
  });

  it('块体缩进比块头更深但前面无块头 → indent-mismatch', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「甲。」\n        「乙。」\n')).toContain('indent-mismatch');
  });

  it('空如果分支 → block-empty', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    如果 她的好感度 超过 0：\n')).toContain('block-empty');
  });

  it('`当` 无任何 `是` 分支 → block-empty', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    当 她的心情：\n')).toContain('block-empty');
  });

  it('空选项块 → block-empty', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    选项：\n')).toContain('block-empty');
  });
});

/* ============================================================================ */
/* §5.2 / §8 杂项错误                                                            */
/* ============================================================================ */

describe('§5.2 / §8 杂项诊断', () => {
  it('未定义标识符 → unknown-identifier（不静默）', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    如果 未定义变量：\n        「呀。」\n')).toContain('unknown-identifier');
  });

  it('`续` 写在引号内 → cont-inside-quotes', () => {
    expect(codes('角色: 12\n时机 指令 310：\n    「这是续续台词」\n')).toContain('cont-inside-quotes');
  });

  it('无字典时属性访问 → unknown-identifier（宽容但不静默）', () => {
    const noDict = createSugarTranspileService().transpile('角色: 12\n时机 指令 310：\n    如果 她的恋慕：\n        「呀。」\n');
    expect(noDict.diagnostics.map((d) => d.code)).toContain('unknown-identifier');
  });

  it('诊断按源位置升序排列（golden 稳定）', () => {
    const r = t('角色: 12\n时机 指令 310：\n    「{未定义1」\n    「{未定义2」\n');
    const lines = r.diagnostics.map((d) => d.loc?.line ?? 0);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });
});

/* ============================================================================ */
/* 源映射（行级）                                                                */
/* ============================================================================ */

describe('源映射 · sourceOf', () => {
  it('产物行可回溯到源行；纯生成行返回 null', () => {
    const r = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    const erbLines = r.erb.split('\n');
    const printLine = erbLines.findIndex((l) => l.includes('PRINTFORMW 「呀。」')) + 1;
    const pos = svc().sourceOf(r, printLine);
    expect(pos?.line).toBe(3);
    // @M_KOJO_… 骨架为纯生成行
    expect(svc().sourceOf(r, 1)).toBeNull();
  });

  it('sourceMap 覆盖全部产物行且行号连续', () => {
    const r = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    const total = r.erb.split('\n').length - 1; // 末尾换行
    expect(r.sourceMap.length).toBe(total);
    expect(r.sourceMap.map((e) => e.generatedLine)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });
});
