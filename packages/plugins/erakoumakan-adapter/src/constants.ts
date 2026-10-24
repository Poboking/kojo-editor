/**
 * era紅魔館 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 `D:/Game/eraKoumakan`（`era紅魔館protoNTR 0038` 甜艮菜魔改
 * 整合 V2.10，403 份 ERB，2026-10-25 实测）：
 *
 * - 工程自证靠 **`CSV/GameBase.csv` 的 `タイトル,era紅魔館protoNTR`**——本作没有
 *   FLconfig 一类独有配置，且与 eraFL 共用 `ERB/口上` 目录名 ⇒ 只看目录会把两个
 *   游戏认混，必须读标题；
 * - 口上域是 `ERB/口上/{编号}_{名称}`（编号 1–10；另有 `U_汎用` 无编号）；
 * - 角色数据是 **`CSV/Chara{编号}.csv`**（直接住在 CSV 根，不像 eraFL 有 `CSV/Chara/`
 *   子目录）——变量字典扫描必须按文件名把这一族排除掉；
 * - ERB / CSV / ERH 实测 **451 份全部 UTF-8 BOM + LF**（UTF-16 零份）；
 * - 无静态 `sav/` 目录（运行期才生成）⇒ 适配器不提议 savDir。
 */

export const ERAKOUMAKAN = {
  gameId: 'erakoumakan',
  displayName: 'era紅魔館',

  /** 工程识别特征（三者同时成立才判定为 era紅魔館） */
  detect: {
    /** 游戏自述表（`タイトル,era紅魔館protoNTR`） */
    gameBaseCsv: ['CSV', 'GameBase.csv'] as const,
    /**
     * 标题匹配：正式名 `era紅魔館protoNTR`；兼容日文旧字 / 简体写法 / 英文目录名。
     * 这是本作**唯一**的强特征——eraFL 也有 `ERB/口上`，只看目录无法区分。
     */
    titlePattern: /era\s*[紅红]魔館|eraKoumakan/i,
    /** 口上域根（必须是**目录**；散文件不算） */
    kojoDir: ['ERB', '口上'] as const,
    /** 引擎变量字典主表（证明这是可玩的 Emuera 工程，不是只有标题的空壳） */
    charaFlagCsv: ['CSV', 'CFLAG.csv'] as const,
  },

  /** 口上域与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根（引擎 `ErbDir`）。索引吃**整棵树**：口上路由/公共函数都在根层 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', '口上'] as const,
    /** 角色 CSV 目录（`CSV/Chara{no}.csv`；本作没有 `CSV/Chara/` 子目录） */
    charaCsvDir: ['CSV'] as const,
    /** CSV 根（变量名字典 / 指令名表 / 配置项表都在这层） */
    csvDir: ['CSV'] as const,
  },

  /**
   * Chara CSV 文件名形态：`Chara{no}.csv`（实测 `Chara0.csv` … `Chara13.csv`、
   * `Chara148.csv`、`Chara149.csv`；编号后**没有**名称段）。
   */
  charaCsvPattern: /^Chara(\d+)\.csv$/i,

  /**
   * 口上目录名形态：`{编号}_{名称}`（`4_咲夜` / `10_魔理沙`）。
   * `U_汎用` 不是编号目录（泛用口上，函数名用 `_KU_`）——解析为 null，调用方显式跳过。
   */
  kojoDirPattern: /^(\d+)_(.+)$/,
} as const;

/**
 * 指令名表文件名（era紅魔館：`<项目根>/CSV/Train.csv`，中文指令名）。
 *
 * 「指令口上」中文名 ↔ 编号的来源（HK-11 / HK-12）。数据源随打开的工程 / 汉化包
 * 变化、**不内置打包**——各版本 / 魔改自动跟随。
 */
export const TRAIN_CSV = 'Train.csv';
