/**
 * eraTW 分野模板表（`KojoFaceTable`）——把硬编码从转译器搬进 adapter 后的
 * 权威回归（v0.3 S2 补齐批）。
 *
 * 断言口径：模板**逐字**对 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §5.5 / 附录 C。
 * 这是"游戏知识只进 adapter"的可执行凭证——模板若漂移，此处先红。
 */

import { describe, expect, it } from 'vitest';
import { createEratwFaceTable } from '../src/face-templates';

const table = createEratwFaceTable();

describe('KojoFaceTable · 分野模板（规范 §3.2 / 附录 C）', () => {
  it('v1 开放糖写法的 11 个入口全部登记，且模板逐字符合附录 C', () => {
    const expectFaces: Record<string, string> = {
      // #1 初见
      初见: 'M_KOJO{t}_ENCOUNTER_K{n}',
      // #4 通用事件
      事件: 'M_KOJO{t}_EVENT_K{n}_{i}',
      // #5 指令口上（类型: 决定 COM/SCOM 段）
      指令: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
      // #6 计数器
      计数器: 'M_KOJO{t}_MESSAGE_COUNTER_K{n}_{i}',
      // #7 PALAM 子类（绝顶 B / 射精 A2）
      绝顶: 'M_KOJO{t}_MESSAGE_PALAMCNG_B_K{n}',
      射精: 'M_KOJO{t}_MESSAGE_PALAMCNG_A2_K{n}_{i}',
      // #8 刻印/素质
      标记: 'M_KOJO{t}_MESSAGE_MARKCNG_K{n}',
      // #10 追加源
      追加源: 'M_KOJO{t}_EXTRASOURCE_${com}_K{n}_{i}',
      // #13 成否
      成功: 'M_KOJO{t}_SUCCESS_${com}_K{n}_{i}',
      // #20 每日事件
      日常: 'M_KOJO{t}_DAILY_EVENT_K{n}_{i}',
      // #21 日记（前缀 DIARY，非 M_KOJO）
      日记: 'DIARY{t}_TEXT_K{n}',
    };
    for (const [face, template] of Object.entries(expectFaces)) {
      expect(table.faces[face], `分野「${face}」`).toBeDefined();
      expect(table.faces[face]!.template).toBe(template);
    }
  });

  it('P-6 绝顶子面补糖三条无参面全部登记，模板逐字符合语料', () => {
    const expectSubFaces: Record<string, string> = {
      // 恶作剧子面（`KOJO_MESSAGE.ERB:328-332` 的 `CFLAG:恶作剧` 分支）→ B2
      绝顶恶作剧: 'M_KOJO{t}_MESSAGE_PALAMCNG_B2_K{n}',
      // 调教后（`KOJO_MESSAGE.ERB:366`）→ C
      调教后: 'M_KOJO{t}_MESSAGE_PALAMCNG_C_K{n}',
      // 寸止（焦らし；`KOJO_MESSAGE.ERB:468`）→ F
      寸止: 'M_KOJO{t}_MESSAGE_PALAMCNG_F_K{n}',
    };
    for (const [face, template] of Object.entries(expectSubFaces)) {
      expect(table.faces[face], `分野「${face}」`).toBeDefined();
      expect(table.faces[face]!.template).toBe(template);
    }
  });

  it('A4 补面：附录 C 之外 8 个实测调用面全部登记，模板逐字符合引擎 caller', () => {
    const expectA4: Record<string, string> = {
      // PRINT_STATE2.ERB:165 `TRYCALLFORM CHARA_INFO_KOJO%RESULTS%_K{ARG}`
      角色介绍: 'CHARA_INFO_KOJO{t}_K{n}',
      // KOJO_MESSAGE.ERB:752 `TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO:TARGET}_GIFT(...)`
      礼物: 'M_KOJO{t}_EVENT_K{n}_GIFT',
      // KOJO_MESSAGE.ERB:400 PALAM CASE 4（パラメータ変動）
      参数变动: 'M_KOJO{t}_MESSAGE_PALAMCNG_D_K{n}',
      // KOJO_MESSAGE.ERB:434 PALAM CASE 5（触手の射精）
      触手: 'M_KOJO{t}_MESSAGE_PALAMCNG_E_K{n}',
      // ANOTHER_TALK.ERB:1023 `TRYCCALLFORM K{NO:KROOM_DESC}%RESULTS%_ROOM_DESCRIPTION`
      // ——家族段在编号**之后**（与 #27 BEFORETRAIN 同为特例）
      房间描述: 'K{n}{t}_ROOM_DESCRIPTION',
      // UPDATE_MAIN.ERB:1133 / :1487 / :1171
      游玩指南: 'KOJO{t}_OPTION_K{n}',
      游玩指南存在: 'KOJO{t}_OPTION_EXIST_K{n}',
      游玩指南结果: 'KOJO{t}_OPTION_K{n}_RESULT_{i}',
    };
    for (const [face, template] of Object.entries(expectA4)) {
      expect(table.faces[face], `分野「${face}」`).toBeDefined();
      expect(table.faces[face]!.template).toBe(template);
    }
  });

  it('附录 C #37 图像面：模板逐字符合引擎 caller，且 `{i}` 是**运行期形态名**（`indexKind: literal`）', () => {
    // 引擎 `KOJO_MESSAGE.ERB:1107 CASE "IMAGE","IMAGE_EX"`
    //   → `:1123 TRYCALLFORM M_KOJO%KOJO_NAME%_%ARGS%_K{NO:(ARG:2)}_%ARGS:1%(ARGS:2,ARG:3,ARG:4)`
    // 尾部 `%ARGS:1%` 是运行期字符串（形态名，`IMAGE.ERB:1263` 的 `FUNC_TYPE`）⇒
    // **不能**按编号查指令表——令牌原样拼名，故两面都必须显式声明 `indexKind: 'literal'`。
    const literalFaces: Record<string, string> = {
      图像: 'M_KOJO{t}_IMAGE_K{n}_{i}',
      图像扩展: 'M_KOJO{t}_IMAGE_EX_K{n}_{i}',
    };
    for (const [face, template] of Object.entries(literalFaces)) {
      expect(table.faces[face], `分野「${face}」`).toBeDefined();
      expect(table.faces[face]!.template).toBe(template);
      expect(table.faces[face]!.indexKind, `分野「${face}」的 {i} 取值口径`).toBe('literal');
    }
    // 缺省口径仍是 `command`（其余面零改动）——抽查 `指令` 面（中文令牌要过指令表）
    expect(table.faces['指令']!.indexKind).toBeUndefined();
  });

  it('三件套模板不带家族段（规范 §5.5），只含 {n}', () => {
    expect(table.registration?.declare).toBe('M_KOJO_K{n}');
    expect(table.registration?.color).toBe('M_KOJO_COLOR_K{n}');
    expect(table.registration?.flagSetting).toBe('M_KOJO_FLAGSETTING_K{n}');
    for (const tpl of Object.values(table.registration ?? {})) {
      if (typeof tpl !== 'string') continue; // declareSelector（别人版）是 {template,pragmas}
      expect(tpl).not.toContain('{t}'); // 三件套无家族段
      expect(tpl).toContain('{n}');
    }
    // 别人版登记函数：仍不带家族段，选择器段 `{s}` 记在函数名尾（规范 §5.5 变体）
    expect(table.registration?.declareSelector?.template).toBe('M_KOJO_K{n}_{s}(ARG)');
  });

  it('成否位协议 = TFLAG:192，四档取值符合规范 §3.2', () => {
    expect(table.successFlag?.target).toBe('TFLAG:192');
    expect(table.successFlag?.values).toEqual({
      游戏判定: 0,
      一定成功: 1,
      一定失败: -1,
      不执行: -2,
    });
  });

  it('MESSAGECHECK 位协议：SCENE→bit0 / KOJO→bit1；函数名**逐面**（中缀插入点各异）', () => {
    const mc = table.messageCheck!;
    expect(mc.bits).toEqual({ scene: 0, kojo: 1 });
    expect(mc.setBit).toBe('SETBIT RESULT, {bit}');
    // `_MESSAGECHECK` 插入点**不统一**，证据是引擎 KOJO_MESSAGE.ERB 的调用点行号：
    //   COM 系插在 `_MESSAGE_` 之后、`${com}` 段之前；PALAM 系插在子类型之前；
    //   其余（SPEVENT/CUSTOM_EVENT/DAILY_EVENT/MARKCNG/COUNTER）插在 `_K{n}` 之前。
    expect(table.faces['指令']!.messageCheck?.template).toBe(
      'M_KOJO{t}_MESSAGE_MESSAGECHECK_${com}_K{n}_{i}',
    );
    expect(table.faces['绝顶']!.messageCheck?.template).toBe(
      'M_KOJO{t}_MESSAGE_PALAMCNG_MESSAGECHECK_B_K{n}',
    );
    expect(table.faces['日常']!.messageCheck?.template).toBe('M_KOJO{t}_DAILY_EVENT_MESSAGECHECK_K{n}_{i}');
    expect(table.faces['特殊事件']!.messageCheck?.template).toBe(
      'M_KOJO{t}_SPEVENT_MESSAGECHECK_K{n}_{i}',
    );
    expect(table.faces['计数器']!.messageCheck?.template).toBe(
      'M_KOJO{t}_MESSAGE_COUNTER_MESSAGECHECK_K{n}_{i}',
    );
    expect(table.faces['标记']!.messageCheck?.template).toBe(
      'M_KOJO{t}_MESSAGE_MARKCNG_MESSAGECHECK_K{n}',
    );
    // 无钩子面显式缺省（引擎从不调用）：事件 / 日记 / 初见…
    expect(table.faces['事件']!.messageCheck).toBeUndefined();
  });

  it('`类型:` 段映射：COM 默认 + SCOM + 两个自定（规范 §3.2 命名参数表）', () => {
    expect(table.faces['指令']!.segments?.com).toEqual({
      COM: 'COM',
      SCOM: 'SCOM',
      自定指令: 'CUSTOM_COM',
      自定副指令: 'CUSTOM_SCOM',
    });
  });

  it('`成功` 划分野自身即 SUCCESS 函数 —— success 留空（不重复生成同名函数）', () => {
    expect(table.faces['成功']!.success).toBeUndefined();
  });

  it('`指令` 划分野写了 `成否:` 时另生成 SUCCESS 函数模板', () => {
    expect(table.faces['指令']!.success?.template).toBe('M_KOJO{t}_SUCCESS_${com}_K{n}_{i}');
  });

  it('自定指令编号可用段 = 270–299（HK-12；kojo_com 自定义段）', () => {
    expect(table.customComRange).toEqual({ min: 270, max: 299 });
  });

  it('自定函数钩子模板全部登记，且逐字符合附录 C（#34 五钩子 + #3/#30/#31/#32）', () => {
    // 附录 C 记 `{i}` = 编号/参数占位（与主模板同口径），故 `{ARG:3}` / `{n|ARGS:1}`
    // 在契约里写成 `{i}`（既有 `自定义事件` / `查询` 分野即此口径）。
    expect(table.customHooks).toEqual({
      comName: 'KOJO{t}_COM_NAME',
      comAble: 'KOJO{t}_COM_ABLE',
      com: 'KOJO{t}_COM',
      canCom: 'KOJO{t}_CAN_COM',
      comCounter: 'KOJO{t}_COM_Counter不发_K{n}_{i}',
      customEvent: 'M_KOJO{t}_CUSTOM_EVENT_K{n}_{i}',
      customTalent: 'KOJO{t}_CUSTOM_TALENT_SET_K{n}',
      shopButtonCondition: 'KOJO{t}_CUSTOM_BUTTON_CONDITION_K{n}_{i}',
      shopButton: 'KOJO{t}_CUSTOM_BUTTON_K{n}_{i}',
    });
  });

  it('自定事件钩子与 `自定义事件` 分野模板一致（不产两套函数名）', () => {
    expect(table.customHooks!.customEvent).toBe(table.faces['自定义事件']!.template);
  });
});
