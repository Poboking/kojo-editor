/**
 * eraSQC 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 `C:/game/eraSQC`（eraSQN 中文汉化魔改版「_返」，
 * 63 份 Chara CSV / 351 份 ERB，2026-10-25 实测）：
 *
 * - 工程自证靠 **`CSV/GameBase.csv` 的 `タイトル,erasqn汉化魔改版_返`**——标题是本作
 *   唯一的强特征（`ERB/EVENT_K` 目录名与 eraAkumaMaid 同形，只看目录会认混）；
 * - 口上域是 `ERB/EVENT_K/` 的**扁平文件**：`EVENT_K{no}.ERB` / `EVENT_K{no}_{尾段}.ERB` /
 *   `DEVENT_K{no}...`，没有每角色子目录（与 eraAkumaMaid 的目录式布局不同）；
 * - 角色数据是 **`CSV/Chara{no}.csv`**，直接住在 CSV 根；
 * - 实测编码：ERB/CSV 共 437 份，UTF-8 BOM 386 份、无 BOM 51 份、UTF-16 零份，
 *   全部可按 UTF-8 读取；`.ERH` / `.als` 真盘 0 份；
 * - 无静态 `sav/` 目录（运行期才生成）⇒ 适配器不提议 savDir。
 */

export const ERASQC = {
  gameId: 'erasqc',
  displayName: 'eraSQC',

  /** 工程识别特征（三者同时成立才判定为 eraSQC） */
  detect: {
    /** 游戏自述表（`タイトル,erasqn汉化魔改版_返`） */
    gameBaseCsv: ['CSV', 'GameBase.csv'] as const,
    /**
     * 标题匹配：正式名 eraSQC / 原版名 eraSQN，汉化改版会把标题写成
     * `erasqn汉化魔改版_返` 一类（实测），故只钉 `eraSQ[CN]` 词根、大小写不敏感。
     */
    titlePattern: /era\s*sq[cn]/i,
    /** 口上域主路由（同为目录存在性的强特征；eraAkumaMaid 也有同名目录） */
    kojoRouteFile: ['ERB', 'EVENT_K', 'EVENT_K.ERB'] as const,
    /** 引擎变量字典主表（证明这是可玩的 Emuera 工程，不是只有标题的空壳） */
    charaFlagCsv: ['CSV', 'Cflag.csv'] as const,
  },

  /** 口上域与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根（引擎 `ErbDir`）。索引吃**整棵树**：口上路由/公共函数都在根层 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', 'EVENT_K'] as const,
    /** 角色 CSV 目录（`CSV/Chara{no}.csv`） */
    charaCsvDir: ['CSV'] as const,
    /** CSV 根（变量名字典 / 指令名表 / 配置项表都在这层） */
    csvDir: ['CSV'] as const,
  },

  /** Chara CSV 文件名形态：`Chara{no}.csv`（实测 `Chara0.csv` … `Chara98.csv`） */
  charaCsvPattern: /^Chara(\d+)\.csv$/i,

  /**
   * 口上文件名形态（**不含扩展名**）：`EVENT_K{no}[_{尾段}]` / `DEVENT_K{no}[_{尾段}]`。
   *
   * 尾段是作者自由标记（`2` / `2_829` / `1_43+140` / `2L` / `EX`），**不是**
   * `CFLAG:209` 口上模式——模式只写在函数名尾。文件尾部对不上函数尾是常态，不据此判定。
   *
   * 扩展名判据走契约单一真源（`isErbBodyPath` / `extname`），本正则不重复 `.ERB` 口径。
   */
  kojoFilePattern: /^D?EVENT_K(\d+)(?:_(.*))?$/i,
} as const;

/**
 * 指令名表文件名（eraSQC：`<项目根>/CSV/Train.csv`，中文指令名）。
 *
 * 「指令口上」中文名 ↔ 编号的来源。数据源随打开的工程 / 汉化包变化、
 * **不内置打包**——各版本 / 魔改自动跟随。
 */
export const TRAIN_CSV = 'Train.csv';
