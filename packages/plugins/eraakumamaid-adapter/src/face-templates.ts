/**
 * eraAkumaMaid 时机分野模板表（游戏知识 —— 只住本包）。
 *
 * 表层 DSL 的 `时机 <分野> [编号] [命名参数]：` 里作者**只写分野关键字**；
 * 「分野关键字 → 目标函数名」的映射是**游戏知识**，故由本包（adapter）
 * 以 `KojoFaceTable` 形式暴露给转译器（`kojo-sugar` 只消费不解释）。
 *
 * 与 eraTW（`eratw-adapter/src/face-templates.ts`）的**命名体系差异**是本品读
 * 本表的前提，先钉死三条事实（全部实测自 `C:/game/eraAkumaMaid` 语料）：
 *
 * 1. **后缀式命名**：eraTW 是中缀 `M_KOJO_K{n}_{面}[_{i}]`，本游戏是后缀式
 *    `{面}_K{n}`（如 `KOJO_MESSAGE_COM_K1`）。eraTW 的 37 面表**不可平移**，
 *    每条模板都经本游戏语料逐个复核（见各条目注释的证据行号）。
 * 2. **全部门面无 `{i}` / 无 `${段}` / 无 `{t}` 家族段**：引擎路由一律
 *    `TRYCALLFORM {面}_K{NO:TARGET}[, <实参>]`（`ERB/EVENT_K/EVENT_K.ERB`
 *    主路由 528 行 + `ERB/EVENT_K/EVENT_K_DAILY.ERB` 日常域路由），分派键
 *    （指令号 / 事件名 / 计数器类型…）是**运行期实参**（`SELECTCOM` /
 *    `ARGS` / `LOCALS`），**不在函数名里**：
 *    - `指令`：单函数内 `IF SELECTCOM == n` 分派（`EVENT_K1.ERB:239` 起）；
 *    - `事件` / `计数器`：函数体 `SELECTCASE ARGS`（`EVENT_K1.ERB:3953` /
 *      `:3929`），类型名如 `"調教終了不可能"` / `"恍惚"` 是 ARGS 值；
 *    - `参数变动`：`TRYCALLFORM …, LOCALS`（`EVENT_K.ERB:98`），话题由
 *      `@CHECK_MESSAGE_PALAMCNG()`（:114）选题（処女喪失 / Ｃ絶頂 / 射精した…）。
 *    ⇒ 本表**没有任何面声明 `indexKind` / `autoIndex`**（无 `{i}` 可消费），
 *      转译器对省略/书写编号令牌的行为即契约口径（无 `{i}` ⇒ 不消费、`_{i}`
 *      段剥离）。这也意味着**计数器面不依赖计数器值域表**（eraTW 的
 *      `{i}` = 计数器编号，本游戏的计数器类型在 ARGS 里）——counter/mutator/
 *      library 三张表未交付不影响本表任一平面。
 * 3. **编号尾槽在本游戏不存在**：全语料唯一的数字尾形态是 `15 槞彁/遺産/`
 *    遗留语音包的 `_K15_1` 系（13 个面全套，如 `KOJO_EVENT_K15_1`）——
 *    那是**语音包变体后缀**（family-index 归 `kn` 私货形态），主路由从不调用
 *    （路由拼名 `KOJO_EVENT_K{NO:TARGET}` 对 15 号解析为 `KOJO_EVENT_K15`），
 *    **不是** eraTW 式的事件编号槽（`KOJO_EVENT_K1_12` 形态全语料 0 处）。
 *
 * 收录范围（首批 = 调教主链路 9 面 + 日常域 1 面，对齐实施计划 P3
 * 「主链路 8–10 面」；糖语言只服务中文社区，首批按 eratw 既有首批平移）：
 * 指令 / 指令前 / 参数变动 / 标记 / 计数器 / 事件 / 射精 / 绝顶 /
 * 射精与绝顶 / 日常。已实测但**未进首批**的面（客人 / 指令后 / 问候 /
 * 日常指令 / 日期 / 愿望 / 商店 / 交流 / 角色介绍 / 射精后 / 对方射精前 /
 * 大喜欢…）罗列在交付报告的「可增量清单」，证据同级，按增量交付契约
 * （缺面 `face-table-missing` fail-closed）随时可补。
 *
 * 证据计数口径（实测，`grep -E "^@<面>K[0-9]+( *,.*)?$"`）：
 * 主链路 9 面各 74 个角色实装（`ERB/EVENT_K/{no} {名前}/`，编号 1–71 /
 * 73 / 77 / 100）+ 官方模板 1 处 + 新角色包副本 2 处
 * （`口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_67|68`）
 * ⇒ `ERB/EVENT_K/` 域内 75 处（另含 `15 槞彁/遺産` 的 `_K15_1` 遗留形 1 处），
 * 全语料 77 处。其中**官方模板的位置两面不同**：8 个调教主链路面 +
 * `绝顶` 在 `口上テンプレート/EVENT_KX1.ERB`（如 `@KOJO_MESSAGE_COM_KX1`
 * :384、`@KOJO_MESSAGE_COMING_KX1` :328），而**日常面在
 * `口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_X1/ERB/EVENT_K/X1/EVENT_KX1_DAILY.ERB:193`**
 * （`@KOJO_DAILY_KX1, ARGS`；`EVENT_KX1.ERB` 不含日常面）；
 * `绝顶`（COMING）仅 9 个角色实装（43 / 65 / 67 / 68 / 69 / 70 / 71 / 73 / 77）；
 * `日常` 74 个角色实装（域内即 74，无遗留形）。`15 槞彁` 另有 `_K15_1`
 * 遗留形 13 面（不计入标准形）。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';

/**
 * 构建 eraAkumaMaid 分野表。
 *
 * 返回**冻结**的表（纯数据，无 IO）——转译器每次转译时经 `game.adapter`
 * 槽位取用，与 `variableSchema` 同生命周期（无需 loadProject 才可用）。
 */
export function createErakumamaidFaceTable(): KojoFaceTable {
  return {
    faces: {
      /* ---- 调教主链路（路由 = `ERB/EVENT_K/EVENT_K.ERB`，528 行） ---- */

      // 指令口上：`EVENT_K.ERB:25`（六九特例 :39，97 特例 :43）
      //   `TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}`（无实参转发）；
      //   域外 caller：`ERB/COMF/COMF290_部員間Ｈ報告.ERB:18`
      //   `TRYCALLFORM KOJO_MESSAGE_COM_K{NO:ACTOR}`。
      // 定义 74 处 + 模板，例：`ERB/EVENT_K/01 フェリシエル/EVENT_K1.ERB:233`
      //   `@KOJO_MESSAGE_COM_K1` —— 函数体内 `IF SELECTCOM == 0/1/…` 逐指令分派
      //   （:239 起），RETURN 1。**无 `{i}`、无 `${com}` 段**（eraTW 的
      //   `M_KOJO{t}_MESSAGE_${com}_K{n}_{i}` 形态在本游戏不存在）：指令号是
      //   运行期 `SELECTCOM`，糖层写 `时机 指令：` 得单函数；编号令牌不被消费。
      指令: { template: 'KOJO_MESSAGE_COM_K{n}' },

      // 指令前口上（调教文本之前）：`EVENT_K.ERB:72`
      //   `TRYCALLFORM KOJO_MESSAGE_BEFORE_COM_K{NO:TARGET}`。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3333` `@KOJO_MESSAGE_BEFORE_COM_K1`
      //   （无实参；引擎在调用前先 `CALL SAMEN_CHECK` 试算 PLAYER 绝顶度）。
      指令前: { template: 'KOJO_MESSAGE_BEFORE_COM_K{n}' },

      // 参数变动口上：`EVENT_K.ERB:97`
      //   `TRYCALLFORM KOJO_MESSAGE_PALAMCNG_K{NO:TARGET}, LOCALS`。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3342` `@KOJO_MESSAGE_PALAMCNG_K1, ARGS`。
      // `LOCALS` 由同文件 `@CHECK_MESSAGE_PALAMCNG()`（:114）按优先级选题：
      //   処女喪失 → 初絶頂（Ｃ/Ｖ/Ａ/Ｂ/Ｍ/尿道）→ 絶頂放尿 → 絶頂10回 →
      //   焦らし → 射精/噴乳 → 通常絶頂 → PALAM 3LV 突破（:331 RETURNF）。
      // 即：本面是 eraTW `参数变动`（PALAMCNG D）与 `绝顶` 系（B/A2…）的
      // **合流面**——类型在 ARGS 不在函数名，故无 `{i}`、无子类型段。
      参数变动: { template: 'KOJO_MESSAGE_PALAMCNG_K{n}' },

      // 刻印/素质变化口上：`EVENT_K.ERB:453`
      //   `TRYCALLFORM KOJO_MESSAGE_MARKCNG_K{NO:TARGET}, ARGS`（变动后发；
      //   说了话才记 `CALL SET_FIRST_EV, ARGS`，:457，行数守卫 :456）。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3686` `@KOJO_MESSAGE_MARKCNG_K1, ARGS`。
      标记: { template: 'KOJO_MESSAGE_MARKCNG_K{n}' },

      // 计数器（反撃）口上：`EVENT_K.ERB:434`
      //   `TRYCALLFORM KOJO_COUNTER_K{NO:TARGET}, ARGS`；域外 caller：
      //   `ERB/TRAIN/EVENTCOM.ERB:331/338`（"骨抜きからの終了の提案/拒否"）。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3929` `@KOJO_COUNTER_K1, ARGS`，
      //   函数体 `SELECTCASE ARGS`，类型串："イくのをこらえた" / "恍惚" /
      //   "押し倒し" / "強制終了" / "リザレクション" / "恍惚から復帰" / "助手が限界"。
      // **与 eratw 的关键差异**：eraTW 的 `{i}` = 计数器编号（`…_COUNTER_K{n}_{i}`，
      // 需计数器值域表）；本游戏的计数器类型是 **ARGS 字符串**，函数名无编号尾
      // ⇒ 本面**不声明 `indexKind`**、**不依赖 `kojoCounterTable`**（纯数字令牌
      // 场景不存在——编号压根不进函数名）。counter 表未交付不影响本面。
      计数器: { template: 'KOJO_COUNTER_K{n}' },

      // 事件口上：`EVENT_K.ERB:483`
      //   `TRYCALLFORM KOJO_EVENT_K{NO:TARGET}, ARGS`（无词则回落
      //   `CALL TRAINVOICE_SELF, ARGS` 汎用喘ぎ，:490）。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3953` `@KOJO_EVENT_K1, ARGS`，
      //   函数体 `SELECTCASE ARGS`，事件名如 "調教終了不可能" / "Ｖコンドーム装着"。
      // **无编号尾槽**（任务书专项核查项）：除 `15 槞彁/遺産` 遗留包外，全语料
      //   `KOJO_EVENT_K{n}_{数字}` 形态 0 处；唯一数字尾是
      //   `15 槞彁/遺産/EVENT_K15_調教関係口上_第一段階.ERB:4446` 的
      //   `@KOJO_EVENT_K15_1, ARGS`——遗留语音包变体后缀（`kn` 私货形态，
      //   主路由拼名对 15 号永远解析为 `KOJO_EVENT_K15`，见
      //   `15 槞彁/基本/EVENT_K15.ERB:4550` 的 `@KOJO_EVENT_K15, ARGS`），
      //   **不是**事件编号。
      //   ⇒ 不写 `{i}`、不声明 `autoIndex`（事件编号是引擎键值语义，本就不可自动分配）。
      事件: { template: 'KOJO_EVENT_K{n}' },

      // 射精口上（PLAYER 射精箇所選択直前）：`EVENT_K.ERB:379`
      //   `TRYCALLFORM KOJO_MESSAGE_SHOOT_K{NO:TARGET}`（路由注释 :366
      //   「PLAYERの射精箇所選択直前の口上」；口枷/ディープスロート時跳过）。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3720` `@KOJO_MESSAGE_SHOOT_K1`。
      射精: { template: 'KOJO_MESSAGE_SHOOT_K{n}' },

      // 绝顶口上（指令执行中的汎用絶頂台詞）：`EVENT_K.ERB:21`
      //   `TRYCALLFORM KOJO_MESSAGE_COMING_K{NO:TARGET}`——在 `@KOJO_MESSAGE_COM`
      //   内、指令口上**之前**发（路由注释 :20「絶頂口上」；说了话就不再走指令口上）。
      // 定义 9 个角色实装（43 / 65 / 67 / 68 / 69 / 70 / 71 / 73 / 77）+ 模板
      //   （`口上テンプレート/EVENT_KX1.ERB:328`）+ `15 槞彁/遺産` 的 `_K15_1`
      //   遗留形（`EVENT_K15_調教関係口上_第一段階.ERB:198`）+ 新角色包副本 2 处，
      //   例：`ERB/EVENT_K/65 このは/EVENT_K65.ERB:630` `@KOJO_MESSAGE_COMING_K65`，
      //   函数体注释「汎用絶頂台詞。ここだけは淫語多めでＯＫ」，守卫
      //   `IF COND("絶頂") && CHOSECOM(SELECTCOM)`。
      // 与 `参数变动` 的分工：COMING 是**指令执行中**的绝顶喘声（先于指令口上）；
      //   PALAMCNG 是**参数变动后**的话题口上（初絶頂/絶頂放尿等，见上）。
      绝顶: { template: 'KOJO_MESSAGE_COMING_K{n}' },

      // 射精与绝顶口上（PLAYER 的射精＆绝顶触发）：`EVENT_K.ERB:344`
      //   `TRYCALLFORM KOJO_MESSAGE_SAMEN_AND_EXTACY_K{NO:TARGET}`（路由注释 :332
      //   「PLAYERの射精＆絶頂をトリガーにした口上」；说完记
      //   `CALL SETFLAG, "射精＆絶頂イベントフラグ"` :349）。
      // 定义 74 处 + 模板，例：`EVENT_K1.ERB:3750` `@KOJO_MESSAGE_SAMEN_AND_EXTACY_K1`。
      // （3P 变体 `KOJO_MESSAGE_SAMEN_AND_EXTACY_3P` 是无 `_K{n}` 的共享函数——
      //   `ERB/TRAIN/SOURCE.ERB:221` `CALL`，1 处定义，**不是**分角色面故不收。）
      射精与绝顶: { template: 'KOJO_MESSAGE_SAMEN_AND_EXTACY_K{n}' },

      /* ---- 日常域（路由 = `ERB/EVENT_K/EVENT_K_DAILY.ERB`） ---- */

      // 日常口上（SHOP 画面下のセリフ）：`EVENT_K_DAILY.ERB:56`
      //   `TRYCALLFORM KOJO_DAILY_K{NO:TARGET}, STR:イベント名`（事件名由
      //   `CALL CHECK_MESSAGE_DAILY` 行动决定，:44；定义体 :316）。
      // 定义 74 个角色实装 + 模板（`口上テンプレート/新キャラ追加用パッケージ/
      //   KOJOPackage_X1/ERB/EVENT_K/X1/EVENT_KX1_DAILY.ERB:193` `@KOJO_DAILY_KX1, ARGS`
      //   ——注意 `EVENT_KX1.ERB` **不含**日常面）+ 新角色包副本 2 处，例：
      //   `ERB/EVENT_K/01 フェリシエル/EVENT_K1_DAILY.ERB:245` `@KOJO_DAILY_K1, ARGS`。
      // 与 eratw 首批的 `日常`（`M_KOJO{t}_DAILY_EVENT_K{n}_{i}`，编号 = 日常事件号）
      // 概念对齐但形态不同：本游戏日常事件名同样走 ARGS，函数名无编号尾。
      日常: { template: 'KOJO_DAILY_K{n}' },
    },

    /**
     * 用户自定义函数的产物命名模板（表层 `函数 <名>：`；游戏惯例实测）：
     * `K{n}_{作者函数名}` —— `ERB/EVENT_K/` 全域 296 处 `K{编号}_*` 定义，
     * 其中 `K{n}_KOJO2`（每角色一份、官方模板同款）74 处：
     *   `口上テンプレート/EVENT_KX1.ERB:243` `@KX1_KOJO2`、
     *   `ERB/EVENT_K/01 フェリシエル/EVENT_K1.ERB:164` `@K1_KOJO2`；
     * 其余作者私货形态（`K15_興奮度Calc`、`K15_添い寝ボタン生成`、
     * `K29_LONG_ED1`…）同前缀。family-index 将该形态归 `kn`（K{n}_ 前缀私货），
     * 与此模板同源。
     * 计数口径：296 / 74 均为 `ERB/EVENT_K/` 域内；全语料另含
     * `KX1_KOJO2`（官方模板）与 `K15_1_KOJO2`（`遺産` 遗留形）两处同族。
     */
    userFunction: { template: 'K{n}_{name}' },

    /* ---- 以下 optional 字段整个缺省（AM 无对应概念，转译器跳过对应产物）----
     *
     * - `registration`（declare/color/flagSetting 三件套）：**无**。AM 没有
     *   eraTW 式 `M_KOJO_K{n}` / `M_KOJO_COLOR_K{n}` / `M_KOJO_FLAGSETTING_K{n}`
     *   （全语料 0 处；也无 `KOJO_VERSION` 声明机制）。最接近的每角色"设置"函数是
     *   `@CNAME_K{n}, ARGS`（呼び名表，`ERB/EVENT_K/` 域内 74 处，经引擎
     *   `%CNAME("一人称")%` FORM 调用，见 `EVENT_K1.ERB:7`）与
     *   `@EVENT_PROFILE_K{n}, ARGS`（紹介文/勧誘，域内 74 处，
     *   `EVENT_K_DAILY.ERB:15` 路由）——二者都不是登记三件套，糖层无对应产物，不收。
     * - `successFlag`：**无**（无 `TFLAG:192` 成否位协议，全语料 0 处）。
     * - `messageCheck`：**无**（无 MESSAGECHECK 概念，全语料 `MESSAGECHECK` 0 命中；
     *   各面的 `messageCheck` 模板因此也不声明——写了 `隐藏情景:` 时转译器
     *   按缺省位协议记 INFO 跳过）。
     * - `customComRange`：**无**（`CSV/Train.csv` 无 eraTW 式作者自定指令段：
     *   280–286 = コミュニケーション系、290 = 游戏自加的部員間Ｈ報告、
     *   500 番台 = 派生指令（注释明示「コメントアウト解除禁止」且整段被注释）、
     *   999 = 口上侧强制终了用；没有作者可占用编号段的证据 ⇒ 不造）。
     * - `playerColor`：**无**（口上域 316 行 `SETCOLOR` 无非是角色气氛色：
     *   `DEF_COLOR` 定义处 `"黄色"` 41 / `"ハートピンク"` 22 / `"ピンク"` 26
     *   （`SETCOLOR DEF_COLOR(…)` 组合行 37 / 21 / 20），其余为逐角色 RGB
     *   字面量 / `SETCOLOR CFLAG:ARG:OFC` 动态色 / `K15_MACHINE_COLOR`；
     *   没有 eraTW 式统一自机色惯例 ⇒ 不猜兜底色）。
     * - `ask`：**无**（AM 原生代码无 `ASK_M` / `ASK_YN`；唯一出处是英译覆盖层
     *   `ERB/TRANSLATION/SQN/#Misc.ERB:424`，非本游戏机制。AM 的选择 UI 是
     *   `@PRINT_SELECT`（`ERB/TRAIN/FUNCTION.ERB:273`），不在本表职责内）。
     * - `customHooks`：**无**（无 `KOJO_COM_NAME` / `KOJO_CAN_COM` /
     *   `CUSTOM_TALENT` / SHOP 按钮钩子，全语料 0 处）。
     * - 各面 `success` / `messageCheck` / `segments`：**无**（AM 无 SUCCESS 函数、
     *   无 MESSAGECHECK 钩子、无 `${com}` 类上下文段）。
     */
  };
}
