/**
 * W1 语言重构 × eraTW **真 backend 全链**（`compileKojoSource` + `ERATW_GAME_ADAPTER` +
 * `createEratwEmitBackend`）：
 *
 * 1. 新正典表面源码（`【幕】/【视角】/【挂 指令 310】/【设】/【池】/【模】/【函】/【织】` +
 *    `若/再若/否则` + 裸行旁白 + `算：/色：/颜绘：/择一：/组：/循环：/重复：/演：` + `@原生{}`）
 *    必须真实编译出 ERB，且关键落点（口上函数名 / CALL / IF 链 / PRINTFORMW /
 *    HPH_PRINT / SETCOLOR / PRINT_FACE / RAND+SELECTCASE / WHILE / REPEAT /
 *    `@EVENTTURNEND`+`#LATER` / 原生直通行）逐条存在；
 * 2. 同一份语义的**旧写法**（`#` / `@` / `?` / `!` / `>`）产出 ERB 与它**逐字相同**
 *    —— W1 设计案 §3.6「新表面与旧写法必须逐字相同」在真 adapter + 真 backend 上成立；
 * 3. 新表面产物里不许残留方寸记号（`【` / `】`）：词法归一化只改"词"，不得把表面记号漏进
 *    表达式或注释（W1 修复前 `【对照表 …】` 的判别式会带上 `】`，由 conformance 对拍兜住；
 *    这里对整份产物再兜一次）。
 *
 * 表达式端口：`compileExpression` 只做**域符号替换**（代词 → 引擎引用、角色属性 →
 * `族:TARGET:名`），与既有 `backend.test.ts` 集成 golden 的口径一致——真表达式编译属于宿主注入，
 * 本测试要钉的是"W1 新表面 → 同一张落点表"，而不是表达式编译器。
 *
 * 说明：`@函` 的**定义体**不在单文件 ERB 里（core `lower/index.ts`：声明是数据，函数体由项目级
 * 装配消费），所以这里钉的是「函数被语义层接受 + 调用点落进表达式端口」；函数体本身由
 * `kojo-core/tests/language-redesign-w1.test.ts` 的 lowering 对拍覆盖。
 */
import { describe, expect, it } from 'vitest';

import type { KojoExprText } from '@kojo/kojo-core';
import { compileKojoSource } from '@kojo/kojo-core';

import { ERATW_DOMAIN_SYMBOLS, ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { createEratwEmitBackend } from '../../src/kojo2/backend.js';

/* ============================== 夹具 ============================== */

/** 确定性表达式端口：只做域符号替换（字符串字面量里的字不替换） */
function compileExpression(value: KojoExprText): string {
  const substitute = (chunk: string): string => {
    let text = chunk;
    for (const pronoun of ERATW_DOMAIN_SYMBOLS.pronouns) {
      text = text.replaceAll(pronoun.pronoun, pronoun.engineRef.replaceAll('%', ''));
    }
    for (const attribute of ERATW_DOMAIN_SYMBOLS.attributes) {
      text = text.replaceAll(attribute.name, `${attribute.family}:TARGET:${attribute.name}`);
    }
    return text;
  };
  return value.text
    .split('"')
    .map((chunk, index) => (index % 2 === 0 ? substitute(chunk) : chunk))
    .join('"');
}

function backend() {
  return createEratwEmitBackend({ compileExpression, charNo: '12' });
}

function compile(source: string) {
  return compileKojoSource({ source, adapter: ERATW_GAME_ADAPTER, backend: backend() });
}

const errorsOf = (result: ReturnType<typeof compile>) =>
  result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

/** 完整示例（W1 新正典表面）：一个文件覆盖 声明/叙事/条件/函数/随机/循环/模板/监听/池/演出/原生 */
const NEW_SURFACE = `【幕 神社清晨】
【视角 灵梦】
【挂 指令 310】
【设 亲近线 整数 = 500 场景】
【设 心情快照 字符串 场景】

【池 早安问候】
    若 恋慕 < 100：
        「……早。」
    再若 恋慕 < 亲近线：
        「早上好，今天天气不错呢。」
    否则：
        「亲爱的，早安~」(拥抱)
        > 她把脸埋进你的肩膀。

【模 娇羞退场(原因)】
    > （她红着脸，因为{原因}而不知所措）
    [插槽]
    > （随后匆匆跑开了）

【函 加一(n)】
    @返 n + 1

【织 回合末 之后】
    > 她轻轻关上了门。

晨光透过鸟居，斑驳地洒在石阶上。
灵梦：「{你}今天来得挺早嘛。」(微笑)

若 恋慕 >= 亲近线：
    灵梦：「其实……{我}一直在等你。」(心形)
再若 恋慕 >= 100：
    > 第二档。
否则：
    灵梦：「……早。」

算：
    心情快照 = "亲近"
    亲近线 = 加一(1)

色：0xFF8080
    灵梦：「这行是红色。」

颜绘：笑顔

择一：
    灵梦：「……呼。」
    组：
        灵梦：「再、再摸摸嘛。」

循环：亲近线 < 3
    亲近线 = 加一(亲近线)
    续
    断

重复：2
    > 重复一次。

演：早安问候
演：娇羞退场("被夸奖")
    灵梦：「才、才没有很开心呢！」

@原生{
    ; 逃生舱：底层 ERB 代码
    CALL HPH_PRINT "w"
}

> 散场。
`;

/** 与 {@link NEW_SURFACE} 语义完全相同、只用旧五锚点的等价写法（逐行一一对应） */
const LEGACY_SURFACE = `# 幕 神社清晨
# 视角 灵梦
# 机 指令 310
# 设 亲近线 整数 = 500 场景
# 设 心情快照 字符串 场景

# 池 早安问候
    ? 恋慕 < 100
        「……早。」
    ? 恋慕 < 亲近线
        「早上好，今天天气不错呢。」
    ? 否
        「亲爱的，早安~」(拥抱)
        > 她把脸埋进你的肩膀。

# 模 娇羞退场(原因)
    > （她红着脸，因为{原因}而不知所措）
    [插槽]
    > （随后匆匆跑开了）

@函 加一(n)
    @返 n + 1

@织 回合末 之后
    > 她轻轻关上了门。

> 晨光透过鸟居，斑驳地洒在石阶上。
灵梦：「{你}今天来得挺早嘛。」(微笑)

? 恋慕 >= 亲近线
    灵梦：「其实……{我}一直在等你。」(心形)
? 恋慕 >= 100
    > 第二档。
? 否
    灵梦：「……早。」

@算
    心情快照 = "亲近"
    亲近线 = 加一(1)

@着色 0xFF8080
    灵梦：「这行是红色。」

@颜绘 笑顔

@随机
    灵梦：「……呼。」
    @组
        灵梦：「再、再摸摸嘛。」

@循 亲近线 < 3
    亲近线 = 加一(亲近线)
    @续
    @断

@复 2
    > 重复一次。

! 早安问候
! 娇羞退场("被夸奖")
    灵梦：「才、才没有很开心呢！」

@原生{
    ; 逃生舱：底层 ERB 代码
    CALL HPH_PRINT "w"
}

> 散场。
`;

const NEW = compile(NEW_SURFACE);
const LEGACY = compile(LEGACY_SURFACE);
const LINES = NEW.erb.slice(0, -1).split('\n');

/* ============================== 1. 真实编译：零 error ============================== */

describe('W1 × eraTW 真 backend：新表面源码真实编译', () => {
  it('新表面完整示例零 error（真 adapter + 真 backend）', () => {
    expect(errorsOf(NEW).map((diagnostic) => diagnostic.code)).toEqual([]);
    expect(NEW.ok).toBe(true);
    expect(NEW.erb.length).toBeGreaterThan(0);
    expect(NEW.erb.endsWith('\n')).toBe(true);
  });

  it('新旧写法 ERB **逐字相同**（W1 §3.6 在真 adapter + 真 backend 上成立）', () => {
    expect(errorsOf(LEGACY)).toEqual([]);
    expect(LEGACY.ok).toBe(true);
    expect(NEW.erb).toBe(LEGACY.erb);
    expect(NEW.slots).toEqual(LEGACY.slots);
    expect(NEW.sourceMap.lineCount).toBe(LINES.length);
  });

  it('归一化不漏表面记号：产物里没有 `【` / `】`（表判别式带收口符的 W1 回归）', () => {
    expect(NEW.erb).not.toContain('】');
    expect(NEW.erb).not.toContain('【');
  });
});

/* ============================== 2. 关键落点真实存在 ============================== */

describe('W1 × eraTW 真 backend：关键落点真实存在', () => {
  it('`【挂 指令 310】` → 口上函数头 + 伴生调用 + 記入チェック信封（@函数名 / CALL / RETURN）', () => {
    expect(LINES.slice(0, 14)).toEqual([
      ';kojo2: # 机 指令 310',
      '@M_KOJO_MESSAGE_COM_K12_310(ARG)',
      'CALL M_KOJO_MESSAGE_COM_K12_310_1(ARG)',
      'RETURN RESULT',
      '',
      '@M_KOJO_MESSAGE_COM_K12_310_1(ARG)',
      '#DIM __kojo_rand_46',
      ';-------------------------------------------------',
      ';記入チェック（=0, 非表示、1, 表示）',
      'LOCAL = 1',
      ';-------------------------------------------------',
      'IF LOCAL',
      '    PRINTFORMW 晨光透过鸟居，斑驳地洒在石阶上。',
      '    PRINTFORMW %CALLNAME:MASTER%今天来得挺早嘛。 ;(微笑)',
    ]);
    expect(LINES.slice(-7)).toEqual([
      '    PRINTFORMW 散场。',
      'ENDIF',
      'RETURN 1',
      ';kojo2: @织 回合末',
      '@EVENTTURNEND',
      '#LATER',
      'PRINTFORMW 她轻轻关上了门。',
    ]);
  });

  it('`若/再若/否则` → IF / ELSEIF / ELSE / ENDIF，心形走 HPH_PRINT 落点', () => {
    expect(LINES).toContain('    IF TALENT:TARGET:恋慕 >= 亲近线');
    expect(LINES).toContain('    ELSEIF TALENT:TARGET:恋慕 >= 100');
    expect(LINES).toContain('    CALL HPH_PRINT(@"其实……%CALLNAME:TARGET%一直在等你。","w")');
    expect(LINES).toContain('    PRINTFORMW 第二档。');
    expect(LINES).toContain('    PRINTFORMW ……早。');
    // 主条件链 + 池内联链各一个
    expect(LINES.filter((line) => line.trim() === 'ENDIF')).toHaveLength(3);
  });

  it('裸行旁白 / 台词 → PRINTFORMW（台词不把说话人名字打进正文）', () => {
    expect(LINES).toContain('    PRINTFORMW 晨光透过鸟居，斑驳地洒在石阶上。');
    expect(LINES).toContain('    PRINTFORMW %CALLNAME:MASTER%今天来得挺早嘛。 ;(微笑)');
    expect(LINES).toContain('    PRINTFORMW 散场。');
    expect(LINES.some((line) => line.includes('灵梦'))).toBe(false);
  });

  it('`演：` 统一调用 → 池内联 / 模板内联 / 函数调用三处真实落点', () => {
    // 池：内联 IF 链（不是 CALL）
    expect(LINES).toContain('    IF TALENT:TARGET:恋慕 < 100');
    expect(LINES).toContain('    ELSEIF TALENT:TARGET:恋慕 < 亲近线');
    expect(LINES).toContain('    PRINTFORMW 亲爱的，早安~ ;(拥抱)');
    expect(LINES).toContain('    PRINTFORMW 她把脸埋进你的肩膀。');
    // 模板：内联正文 + 插槽实参替换
    expect(LINES).toContain('    PRINTFORMW （她红着脸，因为被夸奖而不知所措）');
    expect(LINES).toContain('    PRINTFORMW 才、才没有很开心呢！');
    expect(LINES).toContain('    PRINTFORMW （随后匆匆跑开了）');
    // 函数：调用点落进表达式端口（定义体属项目级装配，不在这份 ERB）
    expect(LINES).toContain('    亲近线 = 加一(1)');
    expect(LINES).toContain('    亲近线 = 加一(亲近线)');
  });

  it('`色：` / `颜绘：` / `择一：`+`组：` → SETCOLOR / PRINT_FACE / RAND+SELECTCASE', () => {
    expect(LINES.slice(LINES.indexOf('    SETCOLOR 0xFF8080'), LINES.indexOf('    CALL PRINT_FACE, TARGET, "笑顔"') + 1)).toEqual([
      '    SETCOLOR 0xFF8080',
      '    PRINTFORMW 这行是红色。',
      '    RESETCOLOR',
      '    CALL PRINT_FACE, TARGET, "笑顔"',
    ]);
    // 随机槽号 = 源行号（`择一：` 在第 46 行）——顺带钉住"新表面 span 不偏移"
    expect(NEW_SURFACE.split('\n')[45]).toBe('择一：');
    expect(LINES).toContain('    __kojo_rand_46 = RAND:2');
    expect(LINES.slice(LINES.indexOf('    SELECTCASE __kojo_rand_46'), LINES.indexOf('    SELECTCASE __kojo_rand_46') + 6)).toEqual([
      '    SELECTCASE __kojo_rand_46',
      '        CASE 0',
      '            PRINTFORMW ……呼。',
      '        CASE 1',
      '            PRINTFORMW 再、再摸摸嘛。',
      '    ENDSELECT',
    ]);
  });

  it('`循环：` / `重复：` / `续` `断` → WHILE+WEND / REPEAT+REND / CONTINUE+BREAK', () => {
    const start = LINES.indexOf('    WHILE 亲近线 < 3');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(LINES.slice(start, start + 5)).toEqual([
      '    WHILE 亲近线 < 3',
      '    亲近线 = 加一(亲近线)',
      '    CONTINUE',
      '    BREAK',
      '    WEND',
    ]);
    const repeat = LINES.indexOf('    REPEAT 2');
    expect(repeat).toBeGreaterThanOrEqual(0);
    expect(LINES.slice(repeat, repeat + 3)).toEqual(['    REPEAT 2', '    PRINTFORMW 重复一次。', '    REND']);
  });

  it('`【织 回合末 之后】` → 独立监听函数 @EVENTTURNEND + #LATER + 自己的槽', () => {
    const weaveStart = LINES.indexOf(';kojo2: @织 回合末');
    expect(weaveStart).toBeGreaterThan(0);
    expect(LINES.slice(weaveStart)).toEqual([
      ';kojo2: @织 回合末',
      '@EVENTTURNEND',
      '#LATER',
      'PRINTFORMW 她轻轻关上了门。',
    ]);
  });

  it('`@原生{ … }` 逐行直通（W1 未改，逃生舱字节保真）', () => {
    expect(LINES).toContain('    ; 逃生舱：底层 ERB 代码');
    expect(LINES).toContain('    CALL HPH_PRINT "w"');
  });

  it('`@函` 定义被语义层接受（零 error），调用点不在产物里被内联（函数体走项目级装配）', () => {
    expect(errorsOf(NEW)).toEqual([]);
    expect(NEW.erb).not.toContain('@加一');
  });
});
