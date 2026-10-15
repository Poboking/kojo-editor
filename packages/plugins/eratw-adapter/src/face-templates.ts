/**
 * eraTW 时机分野模板表（游戏知识 —— 只住本包）。
 *
 * 表层 DSL 的 `时机 <分野> [编号] [命名参数]：` 里作者**只写分野关键字**；
 * 「分野关键字 → 目标函数名」的映射是**游戏知识**，故由本包（adapter）
 * 以 `KojoFaceTable` 形式暴露给转译器（`kojo-sugar` 只消费不解释）。
 *
 * 权威依据：`docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §3.2 / §5.5 / **附录 C**
 * （完整 37 种调用面；实测自 `KOJO_MESSAGE.ERB` 行号）。
 *
 * 模板占位符（与规范 §5.5 同口径）：
 * - `{t}` = 家族段（标准版空串 / 别人版 `_口上名`，由转译器求值）；
 * - `{n}` = 角色号；
 * - `{i}` = 时机编号（**仅含 `{i}` 的模板才消费声明里的编号**）；
 * - `${…}` = 上下文段（本表的 `segments` 声明候选；如 `类型:` 决定 COM/SCOM）。
 *
 * 覆盖范围：规范 §3.2 正文只列 12 种高频；附录 C 列全 37 种。本表按附录 C
 * 全量登记（v1 有糖形态的入口 + 其余入口的完整模板），转译器只对 `faces`
 * 里存在的关键字出产物——v1 未开放糖写法的入口在函数名上与附录 C 逐字一致，
 * 供校验/补全取用（规范 §5.5 使用约定：**不要按 12 行反推全集**）。
 *
 * A4 另补 8 个**附录 C 未收录**的实测调用面（角色介绍 / 礼物 / 参数变动 / 触手 /
 * 房间描述 / 游玩指南 ×3），caller 出处见各自条目注释（引擎源码确证，非猜测）。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';

/**
 * `类型:` 命名参数 → `%LOCALS%` 段（规范 §3.2 命名参数表）。
 * 键 = 语法层 `类型:` 取值，值 = 段文本。
 */
const LOCALS_SEGMENTS: Readonly<Record<string, string>> = {
  COM: 'COM',
  SCOM: 'SCOM',
  自定指令: 'CUSTOM_COM',
  自定副指令: 'CUSTOM_SCOM',
};

/**
 * 构建 eraTW 分野表。
 *
 * 返回**冻结**的表（纯数据，无 IO）——转译器每次转译时经 `game.adapter`
 * 槽位取用，与 `variableSchema` 同生命周期（无需 loadProject 才可用）。
 */
export function createEratwFaceTable(): KojoFaceTable {
  return {
    faces: {
      /* ---- v1 开放糖写法的 11 个入口（规范 §3.2 高频表 / 附录 C 的 v1 列） ---- */

      // 附录 C #1：初见 `M_KOJO{t}_ENCOUNTER_K{n}`
      初见: { template: 'M_KOJO{t}_ENCOUNTER_K{n}' },

      // 附录 C #4：通用事件 `M_KOJO{t}_EVENT_K{n}_{i}`
      事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}' },

      // 附录 C #5：指令口上 `M_KOJO{t}_MESSAGE_{COM|SCOM}_K{n}_{LOCAL}`
      // `{i}` 消费编号；`${com}` 段由 `类型:` 决定（COM/SCOM/CUSTOM_*）。
      指令: {
        template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
        success: { template: 'M_KOJO{t}_SUCCESS_${com}_K{n}_{i}' },
        segments: { com: LOCALS_SEGMENTS },
      },

      // 附录 C #6：计数器 `KOJO_MESSAGE_SEND_COUNTER` 转交；
      // 实测形态 `M_KOJO{t}_MESSAGE_COUNTER_K{n}_{i}`
      计数器: { template: 'M_KOJO{t}_MESSAGE_COUNTER_K{n}_{i}' },

      // 附录 C #7 PALAM：射精 A2 / 绝顶 B（v1 只开放这两个子类）
      绝顶: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_B_K{n}' },
      射精: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_A2_K{n}_{i}' },

      // P-6 绝顶子面补糖（三条无参面，权威：`KOJO_MESSAGE.ERB:328-332/:366/:468`）。
      // 键**不含空格**：`时机 绝顶 恶作剧：` 里的 `恶作剧` 会被词法器当作中文指令名
      // （`indexName`）消费掉、分野 key 只剩 `绝顶`；故恶作剧子面写成单令牌
      // `绝顶恶作剧`（`时机 绝顶恶作剧：`）方能落表。`调教后` / `寸止` 本就是单令牌。
      绝顶恶作剧: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_B2_K{n}' },
      调教后: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_C_K{n}' },
      寸止: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_F_K{n}' },

      // 附录 C #8：刻印/素质变化 `M_KOJO{t}_MESSAGE_MARKCNG_K{n}`
      标记: { template: 'M_KOJO{t}_MESSAGE_MARKCNG_K{n}' },

      // 附录 C #10：追加源 `M_KOJO{t}_EXTRASOURCE_{COM|SCOM}_K{n}_{LOCAL}`
      追加源: {
        template: 'M_KOJO{t}_EXTRASOURCE_${com}_K{n}_{i}',
        segments: { com: LOCALS_SEGMENTS },
      },

      // 附录 C #13：成否 `M_KOJO{t}_SUCCESS_{COM|SCOM}_K{n}_{LOCAL}`
      // 划分野自身即 SUCCESS 函数（`success` 留空避免重复生成同名函数）。
      成功: {
        template: 'M_KOJO{t}_SUCCESS_${com}_K{n}_{i}',
        segments: { com: LOCALS_SEGMENTS },
      },

      // 附录 C #20：每日事件 `M_KOJO{t}_DAILY_EVENT_K{n}_{i}`
      日常: { template: 'M_KOJO{t}_DAILY_EVENT_K{n}_{i}' },

      // 附录 C #21：日记 `DIARY{t}_TEXT_K{n}`（前缀是 DIARY，非 M_KOJO）
      日记: { template: 'DIARY{t}_TEXT_K{n}' },

      /* ---- A4：附录 C 之外的**实测**调用面（引擎源码确证，additive 补面） ---- */

      // 角色介绍：`ステータス表示関連/PRINT_STATE2.ERB:165`
      //   `TRYCALLFORM CHARA_INFO_KOJO%RESULTS%_K{ARG}`（无编号、无实参；样例 `@CHARA_INFO_KOJO_K160()`）
      角色介绍: { template: 'CHARA_INFO_KOJO{t}_K{n}' },

      // 礼物：`KOJO_MESSAGE.ERB:752`
      //   `TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO:TARGET}_GIFT(ARG:1, ARG:3, ARG:4, ARGS:1, ARGS:2)`
      礼物: { template: 'M_KOJO{t}_EVENT_K{n}_GIFT' },

      // 参数变动：`KOJO_MESSAGE.ERB:400`（PALAM CASE 4，`;==== パラメータ変動口上 ====`）
      参数变动: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_D_K{n}' },
      // 触手：`KOJO_MESSAGE.ERB:434`（PALAM CASE 5，`;==== 触手の射精 ====`）
      触手: { template: 'M_KOJO{t}_MESSAGE_PALAMCNG_E_K{n}' },

      // 房间描述：`ANOTHER_TALK.ERB:1023`
      //   `TRYCCALLFORM K{NO:KROOM_DESC}%RESULTS%_ROOM_DESCRIPTION`（样例 `@K33_ROOM_DESCRIPTION` /
      //   `@K34_顶空灿梦_ROOM_DESCRIPTION`）——**家族段在编号之后**（与 #27 BEFORETRAIN 同为特例）
      房间描述: { template: 'K{n}{t}_ROOM_DESCRIPTION' },

      // 游玩指南：`fromEN/NEW_UPDATE/UPDATE_MAIN.ERB:1133` `TRYCALLFORM KOJO%RESULTS%_OPTION_K{NO:ARG}`
      // 游玩指南存在：同上 `:1487` `TRYCALLFORM KOJO%RESULTS%_OPTION_EXIST_K{C_ID}`
      //   （`:1102` 那条 `OPTION_EXIST` 被注释掉，不采信；采信 `:1487` 有效 caller）
      // 游玩指南结果：同上 `:1171` `TRYCCALLFORM KOJO%RESULTS%_OPTION_K{NO:ARG}_RESULT_{nInput}`
      游玩指南: { template: 'KOJO{t}_OPTION_K{n}' },
      游玩指南存在: { template: 'KOJO{t}_OPTION_EXIST_K{n}' },
      游玩指南结果: { template: 'KOJO{t}_OPTION_K{n}_RESULT_{i}' },

      /* ---- 附录 C 其余入口（v1 走原生直通；模板登记供校验/补全取用） ---- */

      // #2 特殊事件（带 SKIP 检查）
      特殊事件: { template: 'M_KOJO{t}_SPEVENT_K{n}_{i}' },
      // #3 剧本自定义事件
      自定义事件: { template: 'M_KOJO{t}_CUSTOM_EVENT_K{n}_{i}' },
      // #12 自慰被撞见
      撞见: { template: 'M_KOJO{t}_EVENT_K{n}_ONABARE_{i}' },
      // #14 推倒许可
      推倒许可: { template: 'M_KOJO{t}_EVENT_K{n}_PERMISSION_{i}' },
      // #15 破瓜中止
      破瓜中止: { template: 'M_KOJO{t}_EVENT_K{n}_LOST_VIRGIN_STOP' },
      // #28 走光
      走光: { template: 'M_KOJO{t}_EVENT_K{n}_PANCHIRA' },
      // #29 结局
      结局: { template: 'M_KOJO{t}_MESSAGE_ENDING_K{n}' },
      // #11 初始化 8 个"～上"开关（头部 `开关:` 消费；此处登记名称口径）
      开关初始化: { template: 'M_KOJO{t}_FLAGSETTING_K{n}' },
      // #36 剧本侧查询钩子
      查询: { template: 'M_KOJO{t}_CHECK_K{n}_{i}' },
    },

    // 三件套（规范 §5.5：**不带家族段**，只有 `K{角色号}`）
    registration: {
      declare: 'M_KOJO_K{n}',
      color: 'M_KOJO_COLOR_K{n}',
      flagSetting: 'M_KOJO_FLAGSETTING_K{n}',
    },

    // 成否位协议（规范 §3.2 命名参数表：`成否:` → `TFLAG:192 = 0/1/-1/-2`）
    successFlag: {
      target: 'TFLAG:192',
      values: {
        游戏判定: 0,
        一定成功: 1,
        一定失败: -1,
        不执行: -2,
      },
    },

    // MESSAGECHECK 位协议（规范 §3.2 时机内子句；`SETBIT RESULT, 0/1`）
    // 函数名形态（实测）：`M_KOJO{_家族}_MESSAGECHECK_{SCENE|KOJO}_K{n}[_{i}]`
    messageCheck: {
      template: 'M_KOJO{t}_MESSAGECHECK_{scope}_K{n}_{i}',
      scopes: { scene: 'SCENE', kojo: 'KOJO' },
      setBit: 'SETBIT RESULT, {bit}',
      bits: { scene: 0, kojo: 1 },
    },

    // 自定指令编号可用段（HK-12；eraTW 4.980：kojo_com 自定义段 = 270–299）
    customComRange: { min: 270, max: 299 },

    // 自定函数钩子模板（附录 C 原文；`{i}` = 编号/参数，占位符同主模板口径）：
    // #34 自定指令五钩子 + #3 自定事件 + #30 `CUSTOM_TALENT` + #31/#32 SHOP 按钮。
    customHooks: {
      comName: 'KOJO{t}_COM_NAME',
      comAble: 'KOJO{t}_COM_ABLE',
      com: 'KOJO{t}_COM',
      canCom: 'KOJO{t}_CAN_COM',
      comCounter: 'KOJO{t}_COM_Counter不发_K{n}_{i}',
      customEvent: 'M_KOJO{t}_CUSTOM_EVENT_K{n}_{i}',
      customTalent: 'KOJO{t}_CUSTOM_TALENT_SET_K{n}',
      shopButtonCondition: 'KOJO{t}_CUSTOM_BUTTON_CONDITION_K{n}_{i}',
      shopButton: 'KOJO{t}_CUSTOM_BUTTON_K{n}_{i}',
    },
  };
}
