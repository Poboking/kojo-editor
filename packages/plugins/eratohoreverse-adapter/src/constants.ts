/**
 * eratohoReverse（真盘标题写作 `eratohoЯeverse`，Я 是西里尔字母）领域常量 ——
 * **本文件是「游戏知识归 adapter」原则的集中体现**。内核与其它通用插件不得引入本文件。
 *
 * 全部路径与格式基于 `C:/game/eratohoReverse`（中文 era 收录计划
 * `era-games-zh/touhou/eratohoReverse`，`CSV/GameBase.csv` 的 `バージョン,1214`，
 * 引擎 `Emuera1824+v1.exe`，2026-10-26 真盘实测）：
 *
 * - 工程自证靠**三件同时成立**：`CSV/GameBase.csv` 标题命中 `titlePattern` +
 *   `ERB/口上` 是目录 + `ERB/口上/EVENT_K.ERB` 是文件。**标题是关键闸**：
 *   `ERB/口上` 这个目录名 eraFL / era紅魔館 / eratohoK 也有，只看目录会把四个游戏认混；
 *   而 eratohoK 的 `/eratoho\s*K/i` 对本作**不成立**——真标题里 `eratoho` 之后是西里尔 `Я`
 *   再接 `everse`，任何照抄的 `eratoho…K` 判据都会漏掉这一盘；
 * - 口上域是 **`ERB/口上/{NNNN}_{角色名}/`**：25 个角色目录，**四位零补齐 + 下划线分隔**
 *   （`0001_霊夢` … `0079_神子`，号稀疏），**没有 `00 あなた` 玩家目录**（玩家台词走
 *   性别族 `KOJO_{MALE|TWIN|PENIS|FEMALE}YOU_*` 与 `KOJO_NO9_*`，实测 121 / 564 个定义）；
 *   角色目录内还有**二级函数族目录**（`0001_霊夢/KOJO_ACT_K1/ACT_00_会話_K1.ERB`，
 *   0001 共 37 份文件），这与 eraTW 的「一角色一目录」和 eratohoK 的「`{no} {名}口上`」都不同；
 * - 根层路由是 `ERB/口上/EVENT_K.ERB`（844 行）：**间接转发**——`@KOJO_CALL`
 *   （`:502`）/ `@KOJO_CALL2`（`:561`）收 FORM 字符串，`CALL KOJO_CALL(@"DIGEST_K{ARG}", TARGET)`（`:61`）
 *   → `TRYCALLFORM KOJO_%ARGS%`（`:793`），并按性器分 `KOJO_{MALE|TWIN|PENIS|FEMALE}YOU_%ARGS%`（`:573-664`）
 *   ⇒ 「扫 TRYCALLFORM 字面拼名」这一套在本作**抓不全路由**（另有 `TRYCCALLFORM` 21 处）；
 * - 角色 CSV 在 **`CSV/CHARA/`**（108 份，目录名全大写），文件名 `Chara{no}_{名前}.csv`
 *   （含 `Chara0_あなた.csv`）；CSV 根层 28 份 `.csv` + 2 份 `.config`，且
 *   **`Global.csv` 与 `Globals.csv` 并存**（15 / 17 行）⇒ 名字表按文件名精确取，不做前缀匹配；
 * - 实测编码（全树 963 份 `.ERB/.ERH/.CSV`，非抽样）：**UTF-8 BOM 100%**、
 *   **换行 100% 纯 LF（CRLF 0 份）**——eraTW 与 eratohoK 都是 CRLF 主导（hok：2,522 纯 CRLF / 41 混合），
 *   所以本作**绝不允许按 CRLF 保存**，否则整文件行尾重排；
 * - 无静态 `sav/` 目录 ⇒ 不提议 `savDir`，状态回放类插件按契约自动 inactive；
 * - 盘上有两棵干扰树：`口上テンプレ/modern/ERB/口上/キャラ番号_キャラ名/` 是**完整第二棵 ERB 树**
 *   （38 份 `KX2` 模板），`resources/`（list.csv + title.png）与 `readme/`、`開発情報/`、
 *   `作者メモ/`、`取扱説明/` 全是 txt ⇒ 受管范围一律锁在 `erbRoot: ['ERB']`，模板树天然在外；
 * - 本仓库做过机翻混排：注释里中日文并列（`CSV/GameBase.csv:16`、`EV20_絶頂口上_*` 头注）
 *   ⇒ 词表/文案的日文口径要按真盘原文收，不能沿用 eraTW 的中文措辞。
 */

export const ERATOHOREVERSE = {
  gameId: 'eratohoreverse',
  displayName: 'eratohoReverse',

  /** 工程识别特征（三者同时成立才判定为本作） */
  detect: {
    /** 游戏自述表 */
    gameBaseCsv: ['CSV', 'GameBase.csv'] as const,
    /**
     * 标题匹配：真盘 `タイトル,eratohoЯeverse`（Я＝西里尔字母，`CSV/GameBase.csv:10-11`）。
     * `[^\r\n]*` 而不是 `\w*`：Я 在某些 `\w` 定义下不匹配，而日文/汉化标题常在中间插字。
     */
    titlePattern: /eratoho[^\r\n]*everse/i,
    /** 口上域根（必须是**目录**；eraFL / era紅魔館 / eratohoK 也有同名目录，故不单独作闸） */
    kojoDir: ['ERB', '口上'] as const,
    /** 根层主路由（必须是**文件**；本作的 `EVENT_K.ERB` 住在 `ERB/口上/`，eraAV 住在 `ERB/EVENT/`） */
    routerErb: ['ERB', '口上', 'EVENT_K.ERB'] as const,
  },

  /** 口上与角色数据的路径（相对工程根） */
  paths: {
    /** ERB 根；`口上テンプレ/` 的第二棵树天然落在其外 */
    erbRoot: ['ERB'] as const,
    /** 口上域根（编辑器主战场；也是唯一可写路径） */
    kojoRoot: ['ERB', '口上'] as const,
    /** 角色 CSV 目录（实测目录名全大写 `CSV/CHARA`，108 份） */
    charaCsvDir: ['CSV', 'CHARA'] as const,
    /** CSV 根（变量名字典 / 指令名表） */
    csvDir: ['CSV'] as const,
  },

  /**
   * 口上目录名形态：`{四位数字}_{名称}`（实测 25/25 命中；名称段是日文）。
   * 号只认前导数字，名称段一律当自由文本。
   *
   * **分隔符只认下划线，位数钉死四位**：eratohoK 的口径是「数字 + 空格」
   * （`^(\d+)[\s　]+`，在本作实测 **0/25 命中**），把它放宽进来只会让两盘的目录
   * 互相认领——判据只写在这一条正则里，消费方不许再各自补闸。
   */
  kojoDirPattern: /^(\d{4})_(.+)$/,

  /**
   * Chara CSV 文件名形态：`Chara{no}_{名前}.csv`（108 份全带名称段，另有 `Chara0_あなた.csv`）。
   * 名称段可含句点与全角字符 ⇒ 一律 `.*`，不做校验。
   */
  charaCsvPattern: /^chara(\d+)(?:_.*)?\.csv$/i,

  /**
   * 角色号锚点 `_K{数字}`（`KOJO_ACT_K1_…` / `COM_K1_12` / `KOJO_SHOP_K1`）。
   * 引擎侧证据是 `ERB/口上/EVENT_K.ERB` 的间接转发链，**文件放在哪个目录完全不参与路由**。
   */
  charaAnchor: /_K(\d+)(?:_|$)/i,

  /**
   * 指令名表：`CSV/Train.csv`（实测 67 行 / 33 条，表头自述「反应(COM)名」）。
   *
   * **本作有两张名表，别混**（2026-10-26 真盘复核）：
   * - `Train.csv` 是 **COM 反应名**，与 `COM_K{角色号}_{指令号}` 的尾槽行号逐一对上
   *   （0–8 / 10–16 / … / 70–71，含同套空缺）⇒ `kojoInstructionTable` 只认这张；
   * - `Str.csv` 里另有一段「调教指令名称(ACT) 通常行动0-199」（`10,用手爱抚` /
   *   `11,胸爱抚` / `300,Ｗ手淫` …），那是 **ACT 动作名**，随 `KOJO_ACT_K{n}_{类别}` 的
   *   `TFLAG:ACT` 动作号走，**归变量名表层**（已由名称表 loader 建成 `STR` 族），
   *   不是指令名表。`instructionFaces` 因此只声明 `['COM']`。
   */
  instructionCsv: 'Train.csv',
} as const;
