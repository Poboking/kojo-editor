/**
 * S2 批 · 语法糖转译单测（规范 §3 每条糖 + §5 降糖算法 + 错误路径）。
 *
 * 组织：按规范章节顺序，一节一组。所有断言都直接对着产物字符串
 * （不依赖快照），失败时给出的信息足以定位到具体糖。
 */

import { describe, expect, it } from 'vitest';
import type { KojoInstructionTable, KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable, stubInstructionTable } from './support';

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

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 转译服务 + 指定指令表（HK-11② 用；游戏知识只出现在测试里） */
const svcWithTable = (instructionTable: KojoInstructionTable, faceTable: KojoFaceTable = stubFaceTable()) =>
  createSugarTranspileService({ dictionary: stubDict, faceTable, instructionTable });

/** 由 `名 → 编号` 记录造一张指令表桩（`hasTable` 按非空判定） */
const instructionTable = (entries: Record<string, number>): KojoInstructionTable => {
  const byName = new Map(Object.entries(entries));
  const byNo = new Map<number, string>();
  for (const [name, no] of byName) if (!byNo.has(no)) byNo.set(no, name);
  return {
    hasTable: byName.size > 0,
    lookupByName: (n) => byName.get(n),
    lookupByNo: (no) => byNo.get(no),
  };
};
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

/* §3.3 `空行`（批 P）                                                           */
/* ============================================================================ */

describe('§3.3 空行 · 输出空行的显式写法（批 P）', () => {
  const line3 = (src: string) =>
    t(`角色: 12\n时机 指令 310：\n${src}`).erb
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('PRINT'));

  it('`空行` → PRINTFORMDW（旁白系，**不带尾随空格**）', () => {
    expect(line3('    空行\n')).toEqual(['PRINTFORMDW']);
  });

  it('`空行 续` → PRINTFORMDL（不等待）', () => {
    expect(line3('    空行 续\n')).toEqual(['PRINTFORMDL']);
  });

  it('英文别名 `blank` 与 `空行` 同产物', () => {
    expect(line3('    blank\n')).toEqual(['PRINTFORMDW']);
    expect(line3('    blank cont\n')).toEqual(['PRINTFORMDL']);
  });

  it('`空行` 只在**整行恰为该词**时成立：台词写法不受影响', () => {
    // 「空行」是台词，要打印那两个字；`空行是什么` 是旁白，同样照原文打印。
    expect(line3('    「空行」\n')).toEqual(['PRINTFORMW 「空行」']);
    expect(line3('    空行是什么。\n')).toEqual(['PRINTFORMDW 空行是什么。']);
  });

  it('块内与行内注释都照常工作（`空行 ; 分节` 仍是空行）', () => {
    expect(line3('    空行 ; 分节用\n')).toEqual(['PRINTFORMDW']);
    expect(
      t('角色: 12\n时机 指令 310：\n    如果 她的恋慕：\n        空行\n    否则：\n        「不。」\n').erb,
    ).toContain('\t\tPRINTFORMDW');
  });

  it('`空行 不等待`（自造说法）不当成指令——照旁白原样打印，不猜', () => {
    expect(line3('    空行 不等待\n')).toEqual(['PRINTFORMDW 空行 不等待']);
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

  it('字符串族属性：`名字` 走 CALLNAME（**以角色号为索引**，没有"名字的索引"）', () => {
    // 旧断言锚的是 `%CALLNAME:TARGET:名字%`——那是 1D 数组的越界写法，引擎不认。
    // 规范 §3.8 只承诺 `{她}` → `%CALLNAME:TARGET%`；`她的名字` 作为作者的自然人写法在此对齐。
    expect(body('角色: 12\n时机 指令 310：\n    「{她的名字}」\n')).toContain('%CALLNAME:TARGET%');
  });

  it('角色引用属性 `角色12的好感度` → `CFLAG:12:好感度`（规范 §3.8，批 L）', () => {
    expect(body('角色: 12\n时机 指令 310：\n    如果 角色13的好感度 >= 500：\n        「……」\n')).toContain(
      'IF CFLAG:13:好感度 >= 500',
    );
  });

  it('角色引用 `角色12的名字` → `%CALLNAME:12%`（§3.8 承诺的兑现点）', () => {
    expect(body('角色: 12\n时机 指令 310：\n    「{角色12的名字}来了。」\n')).toContain('%CALLNAME:12%');
  });

  it('`角色X的Y` 的 X 必须是**数字**：变量作用域不认（动态角色号糖里没有承诺写法）', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 角色X的好感度 >= 500：\n        「……」\n';
    // `角色` 后不是数字 → 不匹配角色分支，`角色X` 当裸标识符处理 → 报 unknown-identifier
    expect(t(src).diagnostics.some((d) => d.code === 'unknown-identifier')).toBe(true);
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

  it('`不在` 左值含函数调用 → warning notin-complex-operand（产物不变）', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 最大值(她的好感度, 1) 不在 1 到 99：\n        「嗯。」\n';
    const d = t(src).diagnostics.find((x) => x.code === 'notin-complex-operand');
    expect(d?.severity).toBe('warning');
    const out = body(src);
    expect(out).toContain('!(MAX(CFLAG:TARGET:好感度, 1) >= 1 && MAX(CFLAG:TARGET:好感度, 1) <= 99)');
  });

  it('`不在` 左值含加减法 → warning', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 她的好感度 + 1 不在 0 到 99：\n        「嗯。」\n';
    expect(codes(src)).toContain('notin-complex-operand');
  });

  it('`不在` 简单左值 → 不报（不打扰既有写法）', () => {
    const src = '角色: 12\n时机 指令 310：\n    如果 她的好感度 不在 0 到 99：\n        「嗯。」\n';
    expect(codes(src)).not.toContain('notin-complex-operand');
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

  it('`当` 块作候选 → 零诊断、嵌套 SELECTCASE 完整（审计批：修双 next 越行）', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    随机：\n        「平」\n        当 1：\n            是 1：\n                「呼嘻嘻」\n        「尾」\n';
    expect(codes(src)).toEqual([]);
    const out = body(src);
    expect(out).toContain('SELECTCASE 1');
    expect(out).toContain('PRINTFORMW 「呼嘻嘻」');
    expect(out).toContain('PRINTFORMW 「尾」');
  });

  it('`如果` / `着色` 块作候选回归 → 零诊断', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    随机：\n        「平」\n        如果 1 == 1：\n            「壳」\n        着色 0xFFB0C8：\n            「红」\n';
    expect(codes(src)).toEqual([]);
    const out = body(src);
    expect(out).toContain('IF 1 == 1');
    expect(out).toContain('SETCOLOR 0xFFB0C8');
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
/* E17 · `当 RAND:n：` 缺档诊断（rand-case-incomplete）                            */
/* ============================================================================ */

describe('E17 · `当 RAND:n：` 缺档诊断', () => {
  it('缺档（RAND:3 只写 0、1）→ rand-case-incomplete', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 RAND:3：\n        是 0：\n            「甲。」\n        是 1：\n            「乙。」\n';
    expect(codes(src)).toContain('rand-case-incomplete');
  });

  it('糖形 `随机(3)` 缺档 → rand-case-incomplete', () => {
    const src = '角色: 12\n时机 指令 310：\n    当 随机(3)：\n        是 0：\n            「甲。」\n';
    expect(codes(src)).toContain('rand-case-incomplete');
  });

  it('`是 0 到 2：` 盖满 n=3 档 → 不报', () => {
    const src = '角色: 12\n时机 指令 310：\n    当 RAND:3：\n        是 0 到 2：\n            「甲。」\n';
    expect(codes(src)).not.toContain('rand-case-incomplete');
  });

  it('单值 + 区间并集盖满（0、1 到 2）→ 不报', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 RAND:3：\n        是 0：\n            「甲。」\n        是 1 到 2：\n            「乙。」\n';
    expect(codes(src)).not.toContain('rand-case-incomplete');
  });

  it('有 `否则：` 兜底 → 不报（即便档位不全）', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 RAND:3：\n        是 0：\n            「甲。」\n        否则：\n            「乙。」\n';
    expect(codes(src)).not.toContain('rand-case-incomplete');
  });

  it('主体非 RAND 常量（`当 她的心情：`）→ 不查、不报', () => {
    const src = '角色: 12\n时机 指令 310：\n    当 她的心情：\n        是 0：\n            「甲。」\n';
    expect(codes(src)).not.toContain('rand-case-incomplete');
  });

  it('分支值含非数字字面量（`是 "A"：`）→ 不查、不报', () => {
    const src = '角色: 12\n时机 指令 310：\n    当 RAND:2：\n        是 "A"：\n            「甲。」\n';
    expect(codes(src)).not.toContain('rand-case-incomplete');
  });

  it('产物正常：RAND:3 块写出 SELECTCASE RAND:3 + CASE 0/1', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    当 RAND:3：\n        是 0：\n            「甲。」\n        是 1：\n            「乙。」\n';
    const out = t(src).erb;
    expect(out).toContain('SELECTCASE RAND:3');
    expect(out).toContain('CASE 0');
    expect(out).toContain('CASE 1');
  });

  it('表达式「当」（赋值位）不受影响：缺否则仍只报 expr-missing-else', () => {
    const src = '角色: 12\n时机 指令 310：\n    她的心情 = 当 她的好感度：\n        是 0 到 99 -> 0\n';
    const c = codes(src);
    expect(c).toContain('expr-missing-else');
    expect(c).not.toContain('rand-case-incomplete');
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

  it('选项块作随机候选 → choice-nested；产物只留一个 INPUTS（审计批：补候选面守卫）', () => {
    const src =
      '角色: 12\n时机 指令 310：\n    随机：\n        「平」\n        选项：\n            「按钮」：\n                「选后」\n    选项：\n        「二按钮」：\n            「后」\n';
    const r = t(src);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['choice-nested']);
    expect(r.erb.match(/INPUTS/g)?.length).toBe(1);
    expect(r.erb).not.toContain('选后');
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
  it('`;` 注释行**原样进产物**（第 3 条：注释不能丢），且不产生输出指令', () => {
    const out = body('角色: 12\n时机 指令 310：\n    ; 这是注释\n    「呀。」\n');
    expect(out).toContain('PRINTFORMW 「呀。」');
    // 注释保留（作者的分节线与意图说明要跟着进产物）
    expect(out).toContain('; 这是注释');
    // 但注释本身不产出任何指令
    expect(out).not.toContain('PRINTFORMW ; 这是注释');
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
    const noDict = createSugarTranspileService({ faceTable: stubFaceTable() }).transpile(
      '角色: 12\n时机 指令 310：\n    如果 她的恋慕：\n        「呀。」\n',
    );
    expect(noDict.diagnostics.map((d) => d.code)).toContain('unknown-identifier');
  });

  it('无分野表时 → timing-face-unknown（fail-closed，绝不回退内建模板）', () => {
    const noFace = createSugarTranspileService({ dictionary: stubDict }).transpile(
      '角色: 12\n时机 指令 310：\n    「呀。」\n',
    );
    expect(noFace.diagnostics.map((d) => d.code)).toContain('timing-face-unknown');
    // fail-closed：不产半成品（主体函数行不出现）
    expect(noFace.erb).not.toContain('_1');
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

/* ============================================================================ */
/* 生产装配口径（v0.3 S2 补齐：分野模板来自 adapter，而非转译器内建）              */
/* ============================================================================ */

describe('装配口径 · 分野模板来自 adapter（游戏知识只进 adapter）', () => {
  it('注入 eraTW 表 → 各分野函数名逐字等于规范 §5.5 / 附录 C', () => {
    const cases: Array<[string, string]> = [
      ['时机 初见：\n    「初次见面。」', '@M_KOJO_ENCOUNTER_K12'],
      ['时机 事件 100：\n    「事件。」', '@M_KOJO_EVENT_K12_100'],
      ['时机 指令 310：\n    「指令。」', '@M_KOJO_MESSAGE_COM_K12_310'],
      ['时机 指令 310 类型: SCOM：\n    「副指令。」', '@M_KOJO_MESSAGE_SCOM_K12_310'],
      ['时机 计数器 20：\n    「计数。」', '@M_KOJO_MESSAGE_COUNTER_K12_20'],
      ['时机 绝顶：\n    「绝顶。」', '@M_KOJO_MESSAGE_PALAMCNG_B_K12'],
      ['时机 射精：\n    「射精。」', '@M_KOJO_MESSAGE_PALAMCNG_A2_K12_1'],
      ['时机 标记：\n    「标记。」', '@M_KOJO_MESSAGE_MARKCNG_K12'],
      ['时机 追加源：\n    「追加。」', '@M_KOJO_EXTRASOURCE_COM_K12_1'],
      ['时机 日常 100：\n    「日常。」', '@M_KOJO_DAILY_EVENT_K12_100'],
      ['时机 日记：\n    「日记。」', '@DIARY_TEXT_K12'],
    ];
    for (const [src, expected] of cases) {
      const { erb } = t(`角色: 12\n${src}\n`);
      expect(erb, `源：${src.split('\n')[0]}`).toContain(expected);
    }
  });

  it('家族段 `口上: 破空自制` → 别人版函数名（M_KOJO 与分野间一个下划线）', () => {
    const { erb } = t('角色: 12\n口上: 破空自制\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_破空自制_MESSAGE_COM_K12_310');
    expect(erb).not.toContain('@M_KOJO__MESSAGE_COM'); // 不得双下划线
  });

  it('未登记的分野关键字 → timing-face-unknown（adapter 表是权威）', () => {
    const r = t('角色: 12\n时机 不存在：\n    「呀。」\n');
    expect(r.diagnostics.map((d) => d.code)).toContain('timing-face-unknown');
  });

  it('成否 + MESSAGECHECK 组合：位协议目标与原语来自 adapter', () => {
    const { erb } = t(
      '角色: 12\n时机 指令 311 成否: 一定失败：\n    隐藏情景: 如果 TFLAG:193 == 1\n    「呀。」\n',
    );
    expect(erb).toContain('@M_KOJO_SUCCESS_COM_K12_311');
    expect(erb).toContain('TFLAG:192 = -1');
    expect(erb).toContain('@M_KOJO_MESSAGECHECK_SCENE_K12_311');
    expect(erb).toContain('SETBIT RESULT, 0');
  });
});

describe('注释保留（2026-10-12 用户第 3 条：注释不能丢）', () => {
  it('文件头注释 → 产物最前（整份口上的标题/出处该跟着走）', () => {
    // 注意：这条要用**整份产物**（`body()` 只截 `IF LOCAL` 段，看不到头部注释）
    const { erb } = t('; 露米娅 · 摸屁股（310）\n角色: 12\n\n时机 指令 310：\n    「呀。」\n');
    const lines = erb.split('\n').filter((l) => l.trim().length > 0);
    expect(lines[0]).toBe('; 露米娅 · 摸屁股（310）');
    expect(lines[1]!.startsWith('@')).toBe(true);
  });

  it('时机体内注释 → 落在产物正文里，且缩进与所在层级一致', () => {
    const out = body(
      ['角色: 12', '时机 指令 310：', '    ; 分节线', '    「呀。」', '', ''].join('\n'),
    );
    // 正文在 `IF LOCAL` 内（1 级），注释应同层
    expect(out).toContain('\t; 分节线');
    expect(out).toContain('\tPRINTFORMW 「呀。」');
    // 顺序保持：注释在台词之前
    expect(out.indexOf('; 分节线')).toBeLessThan(out.indexOf('PRINTFORMW 「呀。」'));
  });

  it('块体内注释（`如果` 块里）→ 随块缩进更深一级', () => {
    const out = body(
      [
        '角色: 12',
        '时机 指令 310：',
        '    如果 FLAG:1：',
        '        ; 分支说明',
        '        「甲。」',
        '    否则：',
        '        「乙。」',
        '',
      ].join('\n'),
    );
    expect(out).toContain('\t\t; 分支说明');
  });

  it('注释不产生任何指令（惰性：`;` 之后整行都不参与执行）', () => {
    const out = body('角色: 12\n时机 指令 310：\n    ; PRINTFORMW 不该被执行\n    「呀。」\n');
    expect(out).toContain('; PRINTFORMW 不该被执行');
    // 该行没有被当成指令：产物里只有一条真正的 PRINTFORMW（来自台词行）
    expect(out.split('\n').filter((l) => l.trimStart().startsWith('PRINTFORMW')).length).toBe(1);
  });

  it('空行仍不保留（§3.10：空行只用于分隔，不影响产物）', () => {
    const out = body('角色: 12\n\n\n时机 指令 310：\n    「呀。」\n\n\n');
    // 正文里不出现"连续两个空行"这种源文件的排版痕迹
    expect(out).not.toContain('\n\n\n');
  });
});

/* ============================================================================ */
/* 回归 · 2026-10-12 教学样例批实证的三处转译器缺陷                                */
/* ============================================================================ */

describe('回归（教学样例批）：结构化行的行内注释剥离', () => {
  // 根因：classifyLine 对头部声明/别名直接用整行内容——规范 §3.1 的示例全部带
  // 行内注释（`角色: 12 ; 必填…`），注释残留是**静默破坏**：函数名里嵌进注释文本
  // （产物看似能跑、引擎调不到），别名值吞掉整段注释（引用别名时逐词报
  // unknown-identifier）。

  it('头部声明的行内注释不进函数名', () => {
    const { erb, diagnostics } = t('角色: 12                    ; 必填：角色编号\n时机 指令 310：\n    「呀。」\n');
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
    expect(erb).not.toContain('; 必填');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('别名的行内注释不进别名值——字符串别名被 `{…}` 引用时展开干净', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n别名 昵称 = "小露"                     ; 字面量别名（只读）：字符串常量\n时机 指令 310：\n    「呀……！{昵称}」\n',
    );
    expect(erb).toContain('PRINTFORMW 「呀……！小露」');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('别名的行内注释不进别名值——变量别名读写都干净', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n别名 今天已触发 = CFLAG:TARGET:1088   ; 变量别名：读写都解析到它\n时机 指令 310：\n    今天已触发 = 1\n    如果 今天已触发：\n        「呀。」\n',
    );
    expect(erb).toContain('CFLAG:TARGET:1088 = 1');
    expect(erb).toContain('IF CFLAG:TARGET:1088');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('字符串值里的半角分号不剥（引号内的 `;` 属于值本身）', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n别名 台词 = "甲;乙" ; 注释\n时机 指令 310：\n    「{台词}」\n',
    );
    expect(erb).toContain('「甲;乙」');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('回归（教学样例批）：行内条件分支按字面量处理', () => {
  // 根因：expandFragment 曾把分支整段当代码降糖——中文散文逐词报
  // unknown-identifier，且碰巧与变量同名的汉字会被静默改写。规范 §3.4：
  // "分支是 FORM 片段：字面量原样"。

  it('分支含全角逗号/省略号的散文 → 原样进 `\@…#…\@`，零诊断', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n时机 指令 310：\n    「{她的恋慕 ? "只有你，我不讨厌。" : "别靠太近。"}」\n',
    );
    expect(erb).toContain('\\@TALENT:TARGET:恋慕?只有你，我不讨厌。#别靠太近。\\@');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('分支里与变量同名的汉字**不被改写**（字面量优先）', () => {
    const { erb } = t('角色: 12\n时机 指令 310：\n    「{她的恋慕 ? "思慕也好恋慕也好" : ""}」\n');
    expect(erb).toContain('?思慕也好恋慕也好\\@');
    expect(erb).not.toContain('?TALENT:TARGET:思慕也好');
  });

  it('分支内的原生 `%…%` 引用仍按规则降糖（与真实语料写法一致）', () => {
    const { erb } = t(
      '角色: 12\n时机 指令 310：\n    「{她的恋慕 ? "只有%CALLNAME:MASTER%" : "别靠太近"}」\n',
    );
    expect(erb).toContain('?只有%CALLNAME:MASTER%#别靠太近\\@');
  });
});

describe('回归（教学样例批）：字符串字面量别名在插值内展开为裸文本', () => {
  // 根因：`别名 昵称 = "小露"` 的 `{昵称}` 曾被分类成数值族 → 产物 `{"小露"}`——
  // 既不是合法 FORM（引号在 `{}` 内无意义），更不是作者想要的字面文本。

  it('{昵称} → 裸文本（无引号、无括号）', () => {
    const { erb } = t('角色: 12\n别名 昵称 = "小露"\n时机 指令 310：\n    「呀……！{昵称}」\n');
    expect(erb).toContain('PRINTFORMW 「呀……！小露」');
    expect(erb).not.toContain('{"小露"}');
  });
});

/* ============================================================================ */
/* 产物层撞名（任务 20：`成否:` 与独立 `时机 成功` 渲染出同一个函数而零诊断）      */
/* ============================================================================ */

describe('产物层撞名 · function-name-duplicate（跨分野也算）', () => {
  const collide =
    '角色: 12\n' +
    '时机 指令 310 成否: 游戏判定：\n' +
    '    「呀。」\n' +
    '时机 成功 310：\n' +
    '    「成功了。」\n';

  it('`成否:` 与独立 `时机 成功 310：` 同文件 → error 诊断（此前零诊断，引擎侧撞「重复定义」）', () => {
    const r = t(collide);
    const d = r.diagnostics.find((x) => x.code === 'function-name-duplicate');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(d!.message).toContain('@M_KOJO_SUCCESS_COM_K12_310');
    expect(d!.message).toContain('产物第');
  });

  it('诊断位置指向**后写**的那个时机（作者要点的是"我刚写了什么"）', () => {
    const d = t(collide).diagnostics.find((x) => x.code === 'function-name-duplicate')!;
    expect(d.loc?.line).toBe(4); // 第 4 行就是后写的那个 `时机 成功 310：`
  });

  it('撞名成因文案认得出 SUCCESS 家族（`成否:` ↔ 独立 `时机 成功`）', () => {
    const d = t(collide).diagnostics.find((x) => x.code === 'function-name-duplicate')!;
    expect(d.message).toContain('成否:');
    expect(d.message).toContain('时机 成功');
  });

  it('error 诊断即阻断保存（不给半成品 .ERB）', () => {
    const plan = svc().planSave({ source: collide, sourcePath: 'C:/x/a.kojo' });
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toBe('transpile-error');
  });

  /* ---- 假阳性守门：合法的三种写法一个都不能报 ---- */

  it('只写 `成否:` → 不报', () => {
    expect(codes('角色: 12\n时机 指令 310 成否: 游戏判定：\n    「呀。」\n')).not.toContain(
      'function-name-duplicate',
    );
  });

  it('只写独立 `时机 成功 310：` → 不报', () => {
    expect(codes('角色: 12\n时机 成功 310：\n    「成功了。」\n')).not.toContain('function-name-duplicate');
  });

  it('不同编号（310 成否 + 成功 311）→ 不报', () => {
    expect(
      codes(
        '角色: 12\n时机 指令 310 成否: 游戏判定：\n    「呀。」\n时机 成功 311：\n    「另一条。」\n',
      ),
    ).not.toContain('function-name-duplicate');
  });

  it('同编号但 `类型:` 换了通信段（COM vs SCOM）→ 名字不同，不报', () => {
    expect(
      codes(
        '角色: 12\n时机 指令 310 成否: 游戏判定：\n    「呀。」\n时机 指令 310 类型: SCOM：\n    「另一段。」\n',
      ),
    ).not.toContain('function-name-duplicate');
  });

  it('包装函数与 `_1` 正文是两个名字，不该自撞（每个时机都产两行函数头）', () => {
    // 这是最容易误报的形状：`@X` 紧跟 `@X_1`，若把 `_1` 也当同一个名字就全库皆红
    const { diagnostics } = t('角色: 12\n时机 指令 310：\n    「呀。」\n时机 指令 311：\n    「嗯。」\n');
    expect(diagnostics.map((d) => d.code)).not.toContain('function-name-duplicate');
  });

  /* ---- 覆盖面：撞名的三种真实来源 ---- */

  it('同一分野同一编号写两次 → 也报（此前 `timing-duplicate` 只是声明、没人发）', () => {
    expect(
      codes('角色: 12\n时机 指令 310：\n    「第一遍。」\n时机 指令 310：\n    「第二遍。」\n'),
    ).toContain('function-name-duplicate');
  });

  it('原生直通块写了与生成结果同名的函数头 → 报（糖不是围栏，撞名照样撞）', () => {
    expect(
      codes(
        '角色: 12\n时机 指令 310：\n    「呀。」\n@M_KOJO_MESSAGE_COM_K12_310\n#FUNCTION\nRETURN 1\n\n',
      ),
    ).toContain('function-name-duplicate');
  });

  it('一次文件里撞两组 → 两条诊断（逐条报，不合并）', () => {
    const d = t(
      '角色: 12\n' +
        '时机 指令 310 成否: 游戏判定：\n    「呀。」\n时机 成功 310：\n    「成功了。」\n' +
        '时机 指令 311 成否: 一定成功：\n    「唔。」\n时机 成功 311：\n    「又成功了。」\n',
    ).diagnostics.filter((x) => x.code === 'function-name-duplicate');
    expect(d).toHaveLength(2);
    expect(d.map((x) => x.message)).toEqual([
      expect.stringContaining('@M_KOJO_SUCCESS_COM_K12_310'),
      expect.stringContaining('@M_KOJO_SUCCESS_COM_K12_311'),
    ]);
  });
});

/* ============================================================================ */
/* §13.4 HK-11②/③ · 指令表中文化（`时机 指令 <中文名>：`）                       */
/* ============================================================================ */

describe('§13.4 HK-11② 中文指令名（名 → 编号，经 adapter 指令表）', () => {
  const TABLE = instructionTable({ 摸屁股: 310, 会话: 300 });

  it('中文名经表解析为编号：产物与等价数字写法**逐字节一致**', () => {
    const named = svcWithTable(TABLE).transpile('角色: 12\n时机 指令 摸屁股：\n    「呀。」\n');
    const numeric = t('角色: 12\n时机 指令 310：\n    「呀。」\n');
    expect(named.erb).toBe(numeric.erb);
    expect(named.erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
    expect(named.diagnostics).toEqual([]);
  });

  it('中文名 + 命名参数（`成否:`）一起用：SUCCESS 编号也走解析值', () => {
    const { erb } = svcWithTable(TABLE).transpile(
      '角色: 12\n时机 指令 摸屁股 成否: 一定成功：\n    「呀。」\n',
    );
    expect(erb).toContain('@M_KOJO_SUCCESS_COM_K12_310');
    expect(erb).toContain('TFLAG:192 = 1');
  });

  it('旧写法 `时机 指令 310：` 逐字节不破、零诊断（**注入了指令表也一样**）', () => {
    // ③ 数字脱敏的裁决在此钉死：数字路径**不查表、不改写、不新增诊断**——
    // 它是"无表项时作者可写的回退"，与中文名路径并存。
    const src = '角色: 12\n时机 指令 310：\n    「呀。」\n';
    const withTable = svcWithTable(TABLE).transpile(src);
    const withoutTable = t(src);
    expect(withTable.erb).toBe(withoutTable.erb);
    expect(withTable.diagnostics).toEqual([]);
    expect(withTable.erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
  });

  it('查不到的中文名 → `timing-instruction-unknown`（含「未命名指令（编号…）」）且**不产半成品**', () => {
    const src = '角色: 12\n时机 指令 魔改新指令：\n    「呀。」\n';
    const res = svcWithTable(TABLE).transpile(src);
    const diag = res.diagnostics.find((d) => d.code === 'timing-instruction-unknown');
    expect(diag?.severity).toBe('error');
    expect(diag?.message).toContain('未命名指令（编号 魔改新指令）');
    // fail-closed：绝不猜一个编号去拼函数名
    expect(res.erb).not.toContain('@M_KOJO_MESSAGE_COM_K12');
    expect(res.erb).not.toContain('@M_KOJO_MESSAGE_COM');
  });

  it('缺指令表时中文名同样 fail-closed（缺省 = 不猜）', () => {
    expect(codes('角色: 12\n时机 指令 摸屁股：\n    「呀。」\n')).toContain('timing-instruction-unknown');
  });

  it('歧义边界：块头 `自定指令` 入关键字表后，`类型: 自定指令` 的右值路径不受影响', () => {
    // 同一个词在两种上下文出现：① 行首块头 `自定指令 名：`（新关键字）；
    // ② 时机命名参数右值 `类型: 自定指令`（纯字符串，**不查关键字表**）。
    const { erb, diagnostics } = t('角色: 12\n时机 指令 313 类型: 自定指令：\n    「自定义指令面。」\n');
    expect(erb).toContain('@M_KOJO_MESSAGE_CUSTOM_COM_K12_313');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/* ============================================================================ */
/* §13.5 P-5 · 指令名 CASE 值（`当 …： 是 <中文名>：` → `CASE <编号>`）           */
/* ============================================================================ */

describe('§13.5 P-5 `是 <中文指令名>：` 经同一张指令表查编号', () => {
  // 真 CSV 快照（eraTW 4.980 `CSV/Train.csv` 前 26 行）经 adapter **真解析器**建表；
  // 断言中的编号（20/2/0…）全部由表算出，非硬编码（判据：反假绿）。
  const TABLE = stubInstructionTable();

  /** 产物里第一条以 `prefix` 开头的行（剥缩进；无则空串） */
  const line = (erb: string, prefix: string): string =>
    erb
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix)) ?? '';

  /** 时机信封（`时机 指令 310：`），`当` 块落在体内 */
  const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;

  it('具名路径数值全部来自真表：接吻=20、给对方口交=2、愛撫=0', () => {
    expect(TABLE.lookupByName('接吻')).toBe(20);
    expect(TABLE.lookupByName('给对方口交')).toBe(2);
    expect(TABLE.lookupByName('愛撫')).toBe(0);
  });

  it('命名写法与等价数字写法产物**逐字节一致**（`是 接吻：` ≡ `是 20：`）', () => {
    const named = svcWithTable(TABLE).transpile(doc('    当 SELECTCOM：\n        是 接吻：\n            「呀。」\n'));
    const numeric = t(doc('    当 SELECTCOM：\n        是 20：\n            「呀。」\n'));
    expect(named.erb).toBe(numeric.erb);
    expect(named.diagnostics).toEqual([]);
    expect(line(named.erb, 'CASE')).toBe(`CASE ${TABLE.lookupByName('接吻')}`);
  });

  it('多值列举 `是 接吻, 给对方口交：` → `CASE 20, 2`（逗号表逐项查表）', () => {
    const { erb, diagnostics } = svcWithTable(TABLE).transpile(
      doc('    当 SELECTCOM：\n        是 接吻, 给对方口交：\n            「呀。」\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(erb, 'CASE')).toBe(`CASE ${TABLE.lookupByName('接吻')}, ${TABLE.lookupByName('给对方口交')}`);
  });

  it('范围 `是 愛撫 到 给对方口交：` → `CASE 0 TO 2`；混合端点 `是 接吻 到 21：` → `CASE 20 TO 21`', () => {
    const r1 = svcWithTable(TABLE).transpile(doc('    当 SELECTCOM：\n        是 愛撫 到 给对方口交：\n            「呀。」\n'));
    expect(r1.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(r1.erb, 'CASE')).toBe('CASE 0 TO 2');
    const r2 = svcWithTable(TABLE).transpile(doc('    当 SELECTCOM：\n        是 接吻 到 21：\n            「呀。」\n'));
    expect(r2.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(r2.erb, 'CASE')).toBe('CASE 20 TO 21');
  });

  it('行内箭头形态（`X = 当 …： 是 接吻 -> 1`）同样查表', () => {
    const { erb, diagnostics } = svcWithTable(TABLE).transpile(
      doc('    她的心情 = 当 TCVAR:20：\n        是 接吻 -> 1\n        否则 -> 0\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(erb, 'CASE')).toBe('CASE 20');
  });

  it('非指令名值**零波及**：代词 / 属性糖 / 数字 / 字符串在带表与无表装配下产物逐字节一致', () => {
    // 反空断言的正方：形状同构的表**在场**也不得改变这些值的既有降糖（探针放行）。
    for (const src of [
      doc('    当 她的心情：\n        是 她的心情：\n            「呀。」\n'),
      doc('    当 TCVAR:20：\n        是 20, 21：\n            「呀。」\n'),
      doc('    当 TFLAG:193：\n        是 "A"：\n            「呀。」\n'),
    ]) {
      const withTable = svcWithTable(TABLE).transpile(src);
      const without = t(src);
      expect(withTable.erb).toBe(without.erb);
      expect(without.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    }
  });

  it('别名优先于指令表（`别名 接吻 = 5` 时 `是 接吻：` 走别名，不查表）', () => {
    const { erb, diagnostics } = svcWithTable(TABLE).transpile(
      `角色: 12\n别名 接吻 = 5\n时机 指令 310：\n    当 SELECTCOM：\n        是 接吻：\n            「呀。」\n`,
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(erb, 'CASE')).toBe('CASE 5');
  });

  it('表外裸中文词 → 一条 `timing-instruction-unknown`、值保留原文（不猜编号、不重复报 unknown-identifier）', () => {
    const { erb, diagnostics } = svcWithTable(TABLE).transpile(
      doc('    当 SELECTCOM：\n        是 魔改新指令名：\n            「呀。」\n'),
    );
    const errs = diagnostics.filter((d) => d.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe('timing-instruction-unknown');
    expect(line(erb, 'CASE')).toBe('CASE 魔改新指令名');
  });

  it('库里收益形态：`当 TCVAR:20： 是 接吻：`（M_KOJO_K86 `IF TCVAR:20 == 73` 一类的人话名写法）零 error', () => {
    const { erb, diagnostics } = svcWithTable(TABLE).transpile(
      doc('    当 TCVAR:20：\n        是 给对方口交：\n            「呀。」\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(line(erb, 'SELECTCASE')).toBe('SELECTCASE TCVAR:20');
    expect(line(erb, 'CASE')).toBe(`CASE ${TABLE.lookupByName('给对方口交')}`);
  });
});
