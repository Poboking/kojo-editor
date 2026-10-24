/**
 * eraFL 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 eraFL（Emuera 变体，`D:/Game/erafl` 实测，2026-10-24）：
 * - 工程根特征是 `FLconfig.xml`（eraFL 独有的外部服务配置文件）；
 * - 口上主形态是 **XML 文件**（不是 ERB 函数体），ERB 侧只有注册壳函数；
 * - 口上目录命名是 **下划线分隔** `{编号}_{名称}`（不是空格），编号 1–4 位，
 *   5xxx 段是主角口上（`5192_主人公口上_汎用_流され人妻`）；
 * - Chara CSV 与引擎同名表同格式（`番号,` / `名前,` / `呼び名,`），UTF-8-BOM。
 */

export const ERAFL = {
  gameId: 'erafl',
  displayName: 'eraFL',

  /** 工程识别特征（三者同时存在才判定为 eraFL 工程） */
  detect: {
    /** eraFL 独有配置文件（普通 Emuera 工程没有） */
    configFile: ['FLconfig.xml'] as const,
    /** 口上域根（必须是**目录**；同名的散文件不算） */
    kojoDir: ['ERB', '口上'] as const,
    /** 引擎变量字典主表（证明这是可玩的 Emuera 工程，而不是空壳目录） */
    charaFlagCsv: ['CSV', 'CFLAG.CSV'] as const,
  },

  /** 口上域与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根（引擎 `ErbDir`）。索引吃**整棵树**：define 壳函数散落在各子目录 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', '口上'] as const,
    /** 角色 CSV 目录（`CSV/Chara/Chara{n}_{名}.csv`） */
    charaCsvDir: ['CSV', 'Chara'] as const,
    /** CSV 根（变量名字典 / 指令名表 / 配置项表都在这层） */
    csvDir: ['CSV'] as const,
  },

  /**
   * Chara CSV 文件名形态：`Chara{no}_{名}.csv`。
   *
   * 实盘有三种分隔：下划线（`Chara10_ティア.csv`）、空格（`Chara0 あなた.csv`）、
   * 以及小写开头（`chara25_リナ.csv`）⇒ 前缀大小写不敏感、编号后不强制分隔符。
   */
  charaCsvPattern: /^chara(\d+)/i,

  /**
   * 口上目录名形态：`{编号}_{名称}`。
   *
   * 编号长度不设上限：1–4 位（`1_…` / `1099_…` / `5192_…`）实测都有；
   * 名称段本身可含下划线（`5192_主人公口上_汎用_流され人妻`），故只切**第一个**下划线。
   */
  kojoDirPattern: /^(\d+)_(.+)$/,
} as const;
