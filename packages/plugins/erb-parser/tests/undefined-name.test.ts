import { describe, expect, it } from 'vitest';
import {
  ERB_ENGINE_RESERVED_IDENTIFIERS,
  ERB_ENGINE_STRING_IDENTIFIERS,
} from '@kojo/plugin-api';
import {
  ERB_UNDEFINED_NAME,
  collectUndefinedNameDiagnostics,
  type UndefinedNameDiagnosticsInput,
} from '../src/undefined-name';

/**
 * ERB 未定义名诊断（S8）单测。
 *
 * 两路都钉死：真阳性（表达式 / 赋值里的未声明变量与标志）与 **≥ 6 类假阳性**
 * （字符串、注释、数字、函数名、关键字、成员访问、通配展开、调用/跳转行、定义行、
 * SKIP 区、散文行、未知语句行、冒号链赋值）。另有作用域（#DIM / 形参）与
 * did-you-mean 候选的接线测试。
 *
 * **引擎保留名按生产同一条来路取**（LAU-D2）：诊断规则本身零词表，词表由宿主注入；
 * 这里读词表的真源（`@kojo/plugin-api`）当"装配根"，不抄第二份名单——
 * 抄一份就等于把刚拆掉的重复又造回来，还测不出真源漂移。
 */
const collect = (
  text: string,
  extra: Partial<Omit<UndefinedNameDiagnosticsInput, 'text'>> = {},
): ReturnType<typeof collectUndefinedNameDiagnostics> =>
  collectUndefinedNameDiagnostics({
    text,
    builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
    engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
    ...extra,
  });

describe('collectUndefinedNameDiagnostics · 真阳性', () => {
  it('IF 条件里的未声明变量：warning + 中文消息 + 1 基列区间 + 稳定诊断码', () => {
    expect(collect('IF UNDEFINED_VAR > 0')).toEqual([
      {
        line: 1,
        severity: 'warning',
        message: '未定义的名称「UNDEFINED_VAR」：不在已知声明（#DIM / 局部 / 内置 / 引擎全局）中。',
        startColumn: 4,
        endColumn: 17,
        code: ERB_UNDEFINED_NAME,
        name: 'UNDEFINED_VAR',
        suggestions: [],
      },
    ]);
    expect(ERB_UNDEFINED_NAME).toBe('ERB_UNDEFINED_NAME');
  });

  it('写位置视为隐式声明；只报右侧与条件里的读', () => {
    expect(collect('UNDEFINED_VAR = 1')).toEqual([]);
    expect(collect('UNDEFINED_VAR += 1')).toEqual([]);
    expect(collect('UNDEFINED_ARR[0] = 1')).toEqual([]);
    expect(collect('A = 0\nIF A > 0')).toEqual([]);
    expect(collect('LOCAL = UNDEFINED_VAR + 1').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['UNDEFINED_VAR', 9, 22],
    ]);
  });

  it('循环条件 / RETURN 表达式 / CJK 名字照报', () => {
    expect(collect('WHILE UNDEFINED_COND > 0').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['UNDEFINED_COND', 7, 21],
    ]);
    expect(collect('RETURN UNDEFINED_RESULT').map((d) => d.name)).toEqual(['UNDEFINED_RESULT']);
    expect(collect('IF 未定義変数 == 1').map((d) => [d.name, d.startColumn, d.endColumn])).toEqual([
      ['未定義変数', 4, 9],
    ]);
    // 取模不是 `%...%` 展开形：两侧单 `%` 不该放过
    expect(collect('IF MONEY%UNDEFINED_MOD == 0').map((d) => d.name)).toEqual(['UNDEFINED_MOD']);
  });

  it('#DIM 声明与函数形参都算已知（含旧式数组声明归一）', () => {
    expect(collect('#DIM KNOWN_VAR\nIF KNOWN_VAR > 0')).toEqual([]);
    expect(collect('#DIM ARR[10]\nIF ARR[0] > 0')).toEqual([]);
    expect(collect('@F(PARAM_X)\nIF PARAM_X > 0')).toEqual([]);
  });

  it('四类外部已知名（dim / local / builtin / engine global / known）都能压掉误报', () => {
    expect(collect('IF GAME_GLOBAL > 0', { engineGlobalNames: ['GAME_GLOBAL'] })).toEqual([]);
    expect(collect('IF INJECTED_DIM > 0', { dimNames: ['INJECTED_DIM'] })).toEqual([]);
    expect(collect('IF INJECTED_LOCAL > 0', { localNames: ['INJECTED_LOCAL'] })).toEqual([]);
    expect(collect('IF INJECTED_BUILTIN > 0', { builtinNames: ['INJECTED_BUILTIN'] })).toEqual([]);
    expect(collect('IF INJECTED_KNOWN > 0', { knownNames: ['INJECTED_KNOWN'] })).toEqual([]);
  });

  it('形参作用域按函数隔离：别的函数里的同名形参不算本函数已知', () => {
    const text = '@A(P1)\nIF P1 > 0\n@B\nIF P1 > 0';
    expect(collect(text)).toEqual([
      {
        line: 4,
        severity: 'warning',
        message: '未定义的名称「P1」：不在已知声明（#DIM / 局部 / 内置 / 引擎全局）中。',
        startColumn: 4,
        endColumn: 6,
        code: ERB_UNDEFINED_NAME,
        name: 'P1',
        suggestions: [],
      },
    ]);
  });

  it('did-you-mean：编辑距离 ≤ 2 给候选并写进消息', () => {
    const [diag] = collect('#DIM DECLARED\nIF DECLARD > 0');
    expect(diag?.name).toBe('DECLARD');
    expect(diag?.suggestions).toEqual(['DECLARED']);
    expect(diag?.message).toContain('「DECLARED」');
  });

  it('确定性：同一输入调用两次逐字段相等', () => {
    const text = '#DIM DECLARED\nIF DECLARD > 0\nIF ALSO_UNDEFINED == DECLARD';
    expect(collect(text)).toEqual(collect(text));
  });
});

describe('collectUndefinedNameDiagnostics · 假阳性（一条都不许报）', () => {
  it('字符串内容与注释尾巴', () => {
    expect(collect('IF MONEY == "UNDEFINED_IN_STRING"')).toEqual([]);
    expect(collect('MONEY = 1 ; UNDEFINED_IN_COMMENT')).toEqual([]);
    expect(collect('; IF UNDEFINED_IN_COMMENT > 0')).toEqual([]);
  });

  it('数字字面量', () => {
    expect(collect('IF 123 == 456')).toEqual([]);
    expect(collect('MONEY = 12345')).toEqual([]);
  });

  it('函数调用形（记号后紧跟 `(`，允许名字与括号之间有空白）', () => {
    expect(collect('IF SOME_FUNC(1) > 0')).toEqual([]);
    expect(collect('IF FINDELEMENT (LOCAL, ARG:0) == 0')).toEqual([]);
    expect(collect('MONEY = RAND(10) + NO(ARG)')).toEqual([]);
  });

  it('ERB 关键字 / 字面量 / 词运算符 / 引擎通用标量', () => {
    expect(collect('IF MONEY == NULL AND TRUE')).toEqual([]);
    expect(collect('WHILE LOCAL || GLOBAL || FALSE')).toEqual([]);
    expect(collect('CASE ELSE\nCASE IS < 5\nCASE 1 TO 3')).toEqual([]);
    expect(collect('IF CHARANUM > 0 && NAME == CALLNAME')).toEqual([]);
  });

  it('FOR 循环变量是语法声明位（语料常不写 #DIM）', () => {
    expect(collect('FOR LOOP_I, 0, 10\nIF LOOP_I > 0')).toEqual([]);
  });

  it('字符串型赋值右侧的无引号文本（#DIMS / LOCALS / RESULTS / 外部 stringNames）', () => {
    expect(collect('#DIMS CNAME\nCNAME = 你这家伙')).toEqual([]);
    expect(collect('#DIMS AA, 0\nAA:05 = ┃森林三┃')).toEqual([]);
    expect(collect('LOCALS = 今日は晴れ')).toEqual([]);
    expect(collect('RESULTS:0 = 今日の天気')).toEqual([]);
    expect(collect('CNAME2 = 未定義文字列', { stringNames: ['CNAME2'] })).toEqual([]);
  });

  it('成员访问 / 变量族索引链（紧邻半/全角冒号）', () => {
    expect(collect('IF CFLAG:TARGET:100 > 0')).toEqual([]);
    expect(collect('CFLAG:ARG:UNDEFINED = 1')).toEqual([]);
    expect(collect('IF TCVAR:K17C_ID:中止接吻 == 0')).toEqual([]);
  });

  it('通配 / 展开形（成对 `%`）、`￥` 具名索引、`[[…]]` 与名字内符号', () => {
    expect(collect('IF MONEY == %EXPANDED%')).toEqual([]);
    expect(collect('IF FLAG:￥人気 >= 300')).toEqual([]);
    expect(collect('IF [[霊夢]] == NAME')).toEqual([]);
    expect(collect('IF TALENT:ARG:幼児／幼児退行')).toEqual([]);
    expect(collect('IF MONEY < 増加_２０％')).toEqual([]);
  });

  it('CASE 值的无引号文本（含非 ASCII）不猜', () => {
    expect(collect('CASE P512魔理沙宅・寝室, P521人偶洋館・愛麗絲的房間')).toEqual([]);
  });

  it('CALL / JUMP / GOTO / CALLFORM 等调用与跳转行（整行不扫）', () => {
    expect(collect('CALL NOPE\nJUMP NOPE\nGOTO NOPE\nCALLFORM NOPE\nTRYCALLFORM NOPE')).toEqual([]);
  });

  it('`@` 定义 / `#` 指令 / `$` 标签行', () => {
    expect(collect('@F\n#DIM X\n$LABEL')).toEqual([]);
  });

  it('[SKIPSTART]…[SKIPEND] 死代码段', () => {
    expect(collect('[SKIPSTART]\nIF UNDEFINED > 0\n[SKIPEND]')).toEqual([]);
  });

  it('PRINT 散文行（无引号台词里的词不是变量）', () => {
    expect(collect('PRINTFORML UNDEFINED 今日は晴れ')).toEqual([]);
    expect(collect('PRINTFORM UNDEFINED = 1')).toEqual([]);
  });

  it('未知语句行（VARSET / SETBIT 等不是表达式也不是赋值形）', () => {
    expect(collect('VARSET UNDEFINED, 0\nSETBIT UNDEFINED, 1')).toEqual([]);
  });

  it('空文本与非方言路径（`.kojo` 归糖线管）', () => {
    expect(collect('')).toEqual([]);
    expect(collect('IF UNDEFINED > 0', { path: '/a.kojo' })).toEqual([]);
    expect(collect('IF UNDEFINED > 0', { path: '/a.ERB' }).map((d) => d.name)).toEqual(['UNDEFINED']);
  });
});

/**
 * 批次十一 UNDEF-NAME-PRECISION：每条收窄都对应一条 ERB/Emuera 语法事实，
 * 读数见 `plugin.ts` 接线注②（eraTW 4.980 全量：2,065 → 171；活项目 `ERB/`：1,860 → 51）。
 */
describe('collectUndefinedNameDiagnostics · 批次十一收窄（每条都有语法依据）', () => {
  it('Emuera 内置变量名：GETNUM 族头 / 内置标量 / 系统变量不算未定义', () => {
    expect(collect('IF GETNUM(TALENT, 100) == 0')).toEqual([]);
    expect(collect('IF GETNUM(ITEM, 100) == ITEM:0')).toEqual([]);
    expect(collect('IF NOITEM > 0 && TEQUIP == 0')).toEqual([]);
    expect(collect('IF JUEL == 0 && NOWEX == 0 && STAIN == 0')).toEqual([]);
    expect(collect('IF MARK > 0 && PALAM == 0 && EQUIP == 0')).toEqual([]);
    expect(collect('IF GAMEBASE_VERSION > 0 && GAMEBASE_TITLE == NICKNAME')).toEqual([]);
    expect(collect('FOR i, 0, GETNUM(EX, 100)')).toEqual([]);
    expect(collect('ELSEIF CFLAG:100 == TALENT')).toEqual([]);
    expect(collect('IF FLAG;時間停止 == 0')).toEqual([]);
  });

  it('`;` 是行注释：声明名尾粘连的注释不属于名字（语料 `#DIM IFPf;Prefer`）', () => {
    expect(collect('#DIM IFPf;Prefer\nIF IFPf > 0')).toEqual([]);
    expect(collect('#DIM SAVEDATA CNT ; 计数器\nIF CNT > 0')).toEqual([]);
    expect(collect('#DIM ARR[10];旧式数组\nIF ARR[0] > 0')).toEqual([]);
  });

  it('名字内符号（`・` `（）` `／` `？` 零宽空格）紧邻的记号只是更长声明名的一段', () => {
    expect(collect('#DIM CONST P37夢幻遺跡・一階通路 = 37\nIF CFLAG:100 == P37夢幻遺跡・一階通路')).toEqual([]);
    expect(collect('IF ARG == 楽譜最大数（シリーズ毎）')).toEqual([]);
    expect(collect('IF CHECK_自室にいるか？_K31(1)')).toEqual([]);
    expect(collect('IF ARG == P235​​舞​的房間')).toEqual([]);
    expect(collect('IF ARG == Ｖ／Ａ')).toEqual([]);
  });

  it('冒号两侧可隔空白（Emuera 允许 `TALENT: 恋慕` / `RAND : 5`）', () => {
    expect(collect('IF TALENT: 恋慕 == 1')).toEqual([]);
    expect(collect('SELECTCASE RAND : 5')).toEqual([]);
    expect(collect('IF CFLAG: 100 > 0')).toEqual([]);
  });

  it('字符串伪变量的无引号右侧（`ARGS = 共通` / `STR:16 = 破旧小屋`）整行不扫', () => {
    expect(collect('ARGS = 共通')).toEqual([]);
    expect(collect('STR:16 = 破旧小屋')).toEqual([]);
    expect(collect('TSTR:1 = 科技蓝白呼吸')).toEqual([]);
    expect(collect('NICKNAME:59 = 小恶魔')).toEqual([]);
    expect(collect('SAVESTR:1 = ・ 这是文本')).toEqual([]);
  });

  it('`PRINT` 全族之后的整段是文本：画/台词里的 `=` 不当赋值', () => {
    expect(collect('PRINTL =-._　／＼ ヽ')).toEqual([]);
    expect(collect('PRINTFORML Ａ = Ｂ')).toEqual([]);
    expect(collect('PRINTW =_= 这是台词')).toEqual([]);
  });

  it('赋值目标不许数字开头（Emuera 标识符规则）：更新日志被 `=` 误判时不扫', () => {
    expect(collect('109行にTCVAR:TARGET:茶 = 1の処理を「x.ERB」から')).toEqual([]);
  });

  it('收窄不放宽真阳性：未知名照报，且内置名进入 did-you-mean 候选池', () => {
    expect(collect('IF NOITEN > 0').map((d) => d.name)).toEqual(['NOITEN']);
    expect(collect('IF NOITEN > 0')[0]?.suggestions).toContain('NOITEM');
    expect(collect('IF NOSUCHVAR == 0 && ARGS_UNKNOWN > 0').map((d) => d.name)).toEqual([
      'NOSUCHVAR',
      'ARGS_UNKNOWN',
    ]);
  });
});

/**
 * 批次十二 UNDEF-NAME-RESIDUAL：真语料剩余命中里的两处**字符串词法**误报。
 *
 * 共享 `visibleCodeLines().codeView()` 的引号配对是朴素开/闭翻转，两处会跑偏：
 * ① `\"` 转义（CASE 字符表里的 `"\"", …` 让后续所有引号顺序翻转，`"l"` / `"y"` 泄漏）；
 * ② `@"…%…%"` 插值串（插值里还能再放字符串，`%COND_STR("_Nude", …)%` 的嵌套引号让串体泄漏）。
 * 两处都只在**确证是字符串内容**时收窄；反证用例钉住"字符串外 / 插值表达式内照报"。
 */
describe('collectUndefinedNameDiagnostics · 批次十二（字符串词法盲区）', () => {
  it('`\\"` 转义不让引号配对翻转：CASE 字符表里的 ASCII 片段不是变量', () => {
    expect(collect('CASE "／", "\\"", "l", "y"')).toEqual([]);
    // 反证：字符串外同样短的名字照报
    expect(collect('CASE l').map((d) => d.name)).toEqual(['l']);
    expect(collect('IF y > 0').map((d) => d.name)).toEqual(['y']);
  });

  it('`@"…%…%"` 插值串：字面量内容（含 `{…}` 与嵌套字符串）不是变量引用', () => {
    expect(collect('#DIM PAT\n#DIM KNOWN\nIF PAT == @"Start_{LOOP}%COND_STR("_Nude", KNOWN)%"')).toEqual([]);
    // 反证①：字符串外的未知名仍报
    expect(collect('IF UNKNOWN == @"Start_{LOOP}"').map((d) => d.name)).toEqual(['UNKNOWN']);
    // 反证②：插值 `%…%` 之内是表达式（不是字符串内容），未知名仍报
    expect(collect('IF @"%UNKNOWN + 1%" == 0').map((d) => d.name)).toEqual(['UNKNOWN']);
  });
});

/**
 * LAU-D2（2026-10-27）：引擎词表**外提**后的数据驱动判据。
 *
 * 判据只有一条：**结果跟着词表走**。
 * - 词表是唯一判据 ⇒ 注入一份假词表，假名字当场放行（没有第二份硬编码在拦它）；
 * - 不注入 ⇒ 不猜（族头 / 引擎标量照报），**不许**在规则里留回退表——回退表就是刚拆掉的
 *   那份重复，且真源改了它不会跟。
 * 这两条同时钉住"外提"的全部收益：插件层零词表，宿主注入什么就认什么。
 */
describe('collectUndefinedNameDiagnostics · 引擎词表外置（数据驱动，不内置回落）', () => {
  it('不注入 ⇒ 引擎族头与引擎标量都按未定义报（不猜、无回落表）', () => {
    const bare = collectUndefinedNameDiagnostics({ text: 'IF CFLAG == SELECTCOM' });
    expect(bare.map((d) => d.name)).toEqual(['CFLAG', 'SELECTCOM']);
    // 反证：同样的输入，按生产来路注入真源 ⇒ 一条不报
    expect(collect('IF CFLAG == SELECTCOM')).toEqual([]);
  });

  it('注入假词表 ⇒ 结果跟着变（词表就是判据；真源里没有的名字不许被常识放过）', () => {
    const text = 'IF FAKEFAMILY == FAKESCALAR';
    // 只喂一枚：另一枚照报 ⇒ 不是"认识一个就整行放行"
    expect(
      collectUndefinedNameDiagnostics({ text, builtinNames: ['FAKEFAMILY'] }).map((d) => d.name),
    ).toEqual(['FAKESCALAR']);
    expect(
      collectUndefinedNameDiagnostics({ text, builtinNames: ['FAKEFAMILY', 'FAKESCALAR'] }),
    ).toEqual([]);
    // 从真源里删一枚 ⇒ 立刻按未定义报（证明消费的是注入变量，而不是抄进规则里的常量）
    const withoutCom = ERB_ENGINE_RESERVED_IDENTIFIERS.filter((w) => w !== 'SELECTCOM');
    expect(
      collectUndefinedNameDiagnostics({ text: 'IF SELECTCOM == 1', builtinNames: withoutCom }).map((d) => d.name),
    ).toEqual(['SELECTCOM']);
  });

  it('字符串伪变量同样数据驱动：`engineStringNames` 决定"整行不扫"的名单', () => {
    // 不在名单 ⇒ 右侧裸词按未定义报
    expect(collectUndefinedNameDiagnostics({ text: 'ARGS = 共通' }).map((d) => d.name)).toEqual(['共通']);
    // 名单里 ⇒ 整行不扫
    expect(collectUndefinedNameDiagnostics({ text: 'ARGS = 共通', engineStringNames: ['ARGS'] })).toEqual([]);
    // 假名字同样吃这一格
    expect(collectUndefinedNameDiagnostics({ text: 'FAKESTR = 文本', engineStringNames: ['FAKESTR'] })).toEqual([]);
  });
});

describe('R4a · 整项目扫描不算 did-you-mean（`maxSuggestions: 0`）', () => {
  const text = 'IF ABC == 1';
  const baseInput = {
    text,
    dimNames: ['ABD'],
    builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
    engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
  };
  /** 判据面：位置 + 严重度 + 码。`message` **刻意不在判据里**（见契约头注） */
  const shape = (rows: readonly { line: number; startColumn?: number; endColumn?: number; severity: string; code?: string }[]) =>
    rows.map((d) => `${d.line}:${d.startColumn ?? ''}:${d.endColumn ?? ''}:${d.severity}:${d.code ?? ''}`);

  it('条数 / 位置 / severity / code 逐条相等——省掉的只有文案尾巴', () => {
    const withSuggest = collectUndefinedNameDiagnostics(baseInput);
    const without = collectUndefinedNameDiagnostics({ ...baseInput, maxSuggestions: 0 });
    expect(without.length).toBe(withSuggest.length);
    expect(shape(without)).toEqual(shape(withSuggest));
    // 编辑器那一轮带候选
    expect(withSuggest[0]!.message).toContain('你是不是想写');
    // 扫描那一轮不带，但**前缀逐字相同**（不是另一句话）
    expect(without[0]!.message).not.toContain('你是不是想写');
    expect(without[0]!.message).toBe(withSuggest[0]!.message.split('；你是不是想写')[0] + '。');
  });

  it('候选数上限是"真·零成本"：0 = 一条都不算（不是算了再截断）', () => {
    // 若实现是"算了再截断"，`suggestions` 会是空但 `maxDistance` 那圈照样跑；
    // 这里能拿到的可观测面只有结果，故用**等价性**钉：0 与 1 的判据面相同、且 0 无候选。
    const zero = collectUndefinedNameDiagnostics({ ...baseInput, maxSuggestions: 0 });
    const one = collectUndefinedNameDiagnostics({ ...baseInput, maxSuggestions: 1 });
    expect(shape(zero)).toEqual(shape(one));
    expect(zero[0]!.suggestions).toEqual([]);
    expect(one[0]!.suggestions.length).toBeGreaterThan(0);
  });
});
