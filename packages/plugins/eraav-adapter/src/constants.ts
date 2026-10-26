/**
 * eraAV 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 `C:/game/eraAV`（中文 era 收录计划 `era-games-zh/original/erAV`，
 * `README.md:11` 自述 `erAV_HoX_pre2_ZH`，2026-10-26 真盘实测）：
 *
 * - 工程自证靠**三件同时成立**：`ERB/Lines` 是目录 + `ERB/EVENT/EVENT_K.ERB` 是文件 +
 *   `CSV/GameBase.csv` 的标题行命中 `titlePattern`。单看标题不够（汉化版常改标题措辞），
 *   单看 `EVENT_K.ERB` 更不够——**eraAkumaMaid 的主路由同名**，只是住在
 *   `ERB/EVENT_K/` 而不是 `ERB/EVENT/`（父目录不同是最险的一处，必须连路径一起钉）；
 * - 真盘标题原文：`CSV/GameBase.csv:4` = `タイトル,Erav优化整合版`，`README.md:11` = `eraAV`
 *   ⇒ 两种拼写（`Erav` / `eraAV`）都要认，`titlePattern` 因此是 `era\s*av|erav`；
 * - 口上域是 **`ERB/Lines/` 17 份扁平 `.ERB`**（**没有角色子目录**，与 eraTW/eratohoK 的
 *   「一角色一目录」根本不同）：`EVENT_K{零填充}_{角色名}.ERB`，号稀疏
 *   （1/5/10/12/17/22/29/30/33/38/39/45/80/87/88/89/97），合计 49,618 行；
 * - 角色数据住在 **`CSV/Chara/`**（120 份）：`Chara0.csv`（唯一无名段）、
 *   `Chara01_宮間かなで.csv`、`Chara100_後藤彩香.csv`、`Chara207_両島みちる..csv`
 *   （**尾段双点**）、非人物条目 `Chara51_【求人広告】.csv` / `Chara92_アンドロイド.csv`
 *   ⇒ 编号只认前导数字，名称段一律当自由文本；
 *   实测 120/120 的 `番号` 行与文件名前导号**逐份一致且全局唯一**（盘上另有 4 份在 `番号` 前
 *   压着 `;` 注释行：Chara98/211/214/215）；存在的是**重名不同号**——`宮間かなで` 同时是
 *   01 与 91（`名前` 分别「宫间奏美 / 宫间香奈」），所以名称段**不作条目身份**；
 * - **文件名里的号 ≠ 函数名里的号**（实测 `EVENT_K01_宮間かなで.ERB:384` 定义的是
 *   `KOJO_MESSAGE_COM_1`，而工具族写成零填充前缀 `@K01_KOJO2`）⇒ 家族解析不许从文件名倒推号；
 * - 受管范围只到 `ERB/`：根层的 `附件/`（12 份 `.ERB`，其中 **7 份与活盘同名**，如
 *   `附件/去绝顶加值补丁/ERB/Brothel/WORK_RESULT.ERB`，还含 `口上テンプレート/EVENT_KXX.ERB`
 *   模板树）**必须落在 `erbRoot` 之外**，否则家族索引会造出 `KOJO_MESSAGE_COM_X1` 假成员；
 * - 实测编码（全量 480 份 `.ERB/.ERH`，非抽样）：**UTF-8 BOM 479/480**，唯一无 BOM 的是
 *   `ERB/Lines/EVENT_K22_織部真菜香.ERB`（正在口上域内）；**换行 480/480 纯 CRLF、零混合**；
 *   `CSV/Chara` 同样 120/120 纯 CRLF，但**7/120 无 BOM**（Chara70–75、78）⇒ 读盘不得假定「必有 BOM」；
 *   另 `Chara51_【求人広告】.csv` 的 `呼び名` 是空值（⇒ `callName` 为 null，不是空串）；
 *   另有 5 份小写扩展名 `.erb`（`ERB/SYSTEM/DELCHARA.erb` 与 4 份 `MISSION_20*`）⇒ 匹配一律不区分大小写；
 * - 无静态 `sav/` 目录 ⇒ 适配器不提议 `savDir`，状态回放类插件按契约自动 inactive；
 * - `CSV/` 根层 11 份名表 + `_default.config`，**缺 `CFLAG` / `SOURCE` / `TEQUIP` / `EQUIP` 四表**
 *   （全盘唯一的 cflag 表在 `附件/杂项/` 里，不算），而语料里 `CFLAG:` 引用有 **17,400 处**
 *   ⇒ 「名字表齐全」是 eraTW 的假设，本作必须容忍「引用很多、表里没有」。
 */

export const ERAAV = {
  gameId: 'eraav',
  displayName: 'eraAV',

  /** 工程识别特征（三者同时成立才判定为 eraAV） */
  detect: {
    /** 口上域根（必须是**目录**；散文件不算） */
    linesDir: ['ERB', 'Lines'] as const,
    /** 主路由（必须是**文件**；eraAkumaMaid 同名文件在 `ERB/EVENT_K/`，故连父目录一起钉） */
    routerErb: ['ERB', 'EVENT', 'EVENT_K.ERB'] as const,
    /** 游戏自述表 */
    gameBaseCsv: ['CSV', 'GameBase.csv'] as const,
    /**
     * 标题匹配：真盘 `タイトル,Erav优化整合版`（`CSV/GameBase.csv:4`）与
     * `README.md` 的 `eraAV` 是两种拼写，二者都要认。
     */
    titlePattern: /era\s*av|erav/i,
  },

  /** 口上与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根（引擎 `ErbDir`）；`附件/` 天然落在其外，见文件头 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', 'Lines'] as const,
    /** 角色 CSV 目录（`CSV/Chara/Chara{no}_{名前}.csv`，名称段可缺） */
    charaCsvDir: ['CSV', 'Chara'] as const,
    /** CSV 根（变量名字典 / 指令名表都在这层） */
    csvDir: ['CSV'] as const,
  },

  /**
   * 口上文件名形态：`EVENT_K{数字}_{角色名}`（**扁平文件**，本作用户目录不存在）。
   * 零填充两位（`EVENT_K01`），但号段本身按 `\d+` 收，不假设位数。
   *
   * **只吃去扩展名后的词干**：扩展名判据的单一真源在 `@kojo/plugin-api`
   * （`isErbBodyPath` / `ERB_BODY_EXTENSIONS`，含 `.erb` 与 `.erm`），本包再写一份
   * `\.erb$` 就是 `packages/plugin-api/tests/erb-ext.test.ts` 抓的「口径副本」——
   * 而且那份副本会把 `.erm` 口上直接漏掉。
   */
  kojoFilePattern: /^EVENT_K(\d+)_(.+)$/i,

  /**
   * Chara CSV 文件名形态：`Chara{no}` + 可选 `_{名前}` + `.csv`。
   * 实测三种都要认中：`Chara0.csv`（无名称段）、`Chara01_宮間かなで.csv`、
   * `Chara207_両島みちる..csv`（名称段自带句点）⇒ 名称段一律 `.*`，不做校验。
   */
  charaCsvPattern: /^chara(\d+)(?:_.*)?\.csv$/i,

  /**
   * 角色号锚点（本作用**裸尾号**，不是 eraTW 的中缀 `_K{n}_`）：
   * 主族 `KOJO_MESSAGE_COM_{1}` / `KOJO_MESSAGE_PALAMCNG_{1}` / `…_MARKCNG_{1}`，
   * 另有 `SELF_KOJO_K{1}` 与 `SINGLE_ENDING_K{1}` 带 `K`，工具族则是**前缀**零填充
   * `K{01}_KOJO2`。三种形态由 family-index 各自裁决，本字段只作「尾号」一条的复用锚。
   */
  trailingNoAnchor: /_(\d+)$/i,

  /**
   * 指令名表（eraAV：`<项目根>/CSV/Train.csv`，实测 181 行 / 105 条数据）。
   * 数据源随工程变化，**不内置打包**。
   */
  instructionCsv: 'Train.csv',
} as const;
