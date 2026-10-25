/**
 * eratohoK 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 `D:/game/eratohoK`（中文 era 收录计划的 `eratohoK` 主线，
 * 3,430 个受管文件，2026-10-25 实测）：
 *
 * - 工程自证靠 **`CSV/GameBase.csv` 的 `タイトル,eratohoK`**（`ウィンドウタイトル` 也是
 *   同名）——`ERB/口上` 这个目录名 eraFL / era紅魔館 也有，只看目录会把三个游戏认混；
 * - 口上域是 **`ERB/口上/{编号} {名称}口上/`**：118 个角色目录 + 8 份根层公共文件
 *   （`_KOJO_SYSTEM.ERB` / `_KOJO_PATTERN.ERB` / `EVENT_KOJO_DAILY.ERB` …）。
 *   目录名是「数字 + 空格 + 名称」，名称多以 `口上` 收尾，另有
 *   `1204 ランダムキャラ武官` 一类无 `口上` 后缀的随机角色目录；
 * - 角色数据住在 **`CSV/Chara/`** 子目录（174 份），文件名为
 *   `Chara{编号} {名前}.csv`（编号与名称之间有**空格**，与 eraTW 的纯 `Chara{no}.csv`
 *   不同）；CSV 根层只有名称表与配置；
 * - 口上规模：**694 份 ERB / 1,057,608 行 / 118 个角色目录**（`_KOJO_SYSTEM.ERB` 的
 *   `TRYCALLFORM KOJO_*_K{LOCAL:5}` 路由族决定函数名尾部一律是 `_K{角色号}`）；
 * - 实测编码（全量 2,563 份 `.erb/.erh`，非抽样）：**BOM 2,563/2,563＝100%**；
 *   换行 **CRLF 纯 2,522 / 混合（同文件内 CRLF 与 LF 并存）41 / 纯 LF 0**——
 *   混合那 41 份会让 Monaco 报 `EOL=lf`（首个行尾是 LF 时按 LF 建模型），
 *   是**盘上原样**不是读错；`CSV/Chara` 与 CSV 根同样 BOM + CRLF；
 * - `.als` 全树 **0 份**；`.ERH` 共 145 份，其中 13 份含 `#DIM` 声明；
 * - 无静态 `sav/` 目录（运行期才生成）⇒ 适配器不提议 savDir。
 */

export const ERATOHOK = {
  gameId: 'eratohok',
  displayName: 'eratohoK',

  /** 工程识别特征（三者同时成立才判定为 eratohoK） */
  detect: {
    /** 游戏自述表（`タイトル,eratohoK`） */
    gameBaseCsv: ['CSV', 'GameBase.csv'] as const,
    /**
     * 标题匹配：正式名 `eratohoK`（大小写不敏感）。
     * 真盘同时有 `ウィンドウタイトル,eratohoK` ⇒ 两行任一命中即算，
     * 汉化/魔改常改窗口标题而保留 `タイトル`，故不钉单行。
     */
    titlePattern: /eratoho\s*K/i,
    /** 口上域根（必须是**目录**；散文件不算） */
    kojoDir: ['ERB', '口上'] as const,
    /** 引擎变量字典主表（证明这是可玩的 Emuera 工程，不是只有标题的空壳） */
    charaFlagCsv: ['CSV', 'CFLAG.CSV'] as const,
  },

  /** 口上与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根（引擎 `ErbDir`）。索引吃**整棵树**：口上路由/公共函数都在根层 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', '口上'] as const,
    /** 角色 CSV 目录（`CSV/Chara/Chara{no} {名前}.csv`） */
    charaCsvDir: ['CSV', 'Chara'] as const,
    /** CSV 根（变量名字典 / 指令名表 / 配置项表都在这层） */
    csvDir: ['CSV'] as const,
  },

  /** Chara CSV 文件名形态：`Chara{no} {名前}.csv`（名称段可缺，实测 174 份都带） */
  charaCsvPattern: /^Chara(\d+)(?:[\s_].*)?\.csv$/i,

  /**
   * 口上目录名形态：`{编号} {名称}`（数字与名称之间是**空格**，实测 118/118 命中）。
   *
   * 名称段是作者/汉化自由文本（`01 霊夢口上` / `1204 ランダムキャラ武官`），
   * **不据此判定角色号**——号只认前导数字。
   */
  kojoDirPattern: /^(\d+)[\s　]+(.+)$/,

  /**
   * 口上函数名的角色号锚点：`_K{数字}`（`KOJO_TRAIN_START_A1_K1` / `KOJO_DAILY_K1_…`）。
   *
   * 引擎侧证据（`ERB/口上/_KOJO_SYSTEM.ERB`）：
   * `TRYCALLFORM KOJO_TRAIN_START_K{LOCAL:5}` / `…_%KOJO_STATE(1)%_K{LOCAL:5}` /
   * `…_K{LOCAL:5}_{CFLAG:(LOCAL:5):2999}`。**文件放在哪个目录完全不参与路由**。
   */
  charaAnchor: /_K(\d+)(?:_|$)/i,
} as const;

/**
 * 指令名表文件名（eratohoK：`<项目根>/CSV/Train.csv`，中文指令名）。
 *
 * 「指令口上」中文名 ↔ 编号的来源。数据源随打开的工程 / 汉化包变化，
 * **不内置打包**——各版本 / 魔改自动跟随。
 */
export const TRAIN_CSV = 'Train.csv';
