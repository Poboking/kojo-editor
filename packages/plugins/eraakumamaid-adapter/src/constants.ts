/**
 * eraAkumaMaid 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 eraAkumaMaid（Emuera 1824+v18 私家改造版，日文）实测：
 * - 口上域 `ERB/EVENT_K/`（= eraTW `ERB/口上・メッセージ関連/` 的等价物）；
 * - 命名 = **后缀式** `{家族}_K{n}`（eraTW 是中缀 `M_KOJO_K{n}_{家族}`，规则不可复用）；
 * - CHARA CSV 与 eraTW 逐字同格式；ERB/CSV 均 UTF-8-BOM；
 * - **无静态 sav/ 目录**（运行期才生成）⇒ 适配器不提议 savDir。
 */

export const ERAAKUMA_MAID = {
  gameId: 'eraakumamaid',
  displayName: 'eraAkumaMaid',

  /** 工程识别特征（两者同时存在才判定为 eraAkumaMaid 工程） */
  detect: {
    /** 口上域主路由文件（eraAkumaMaid 特有结构；= eraTW `KOJO_MESSAGE.ERB` 的等价物） */
    kojoRouteFile: ['ERB', 'EVENT_K', 'EVENT_K.ERB'] as const,
    /** 角色数据目录（`CSV/CHARA`） */
    charaCsvDir: ['CSV', 'CHARA'] as const,
  },

  /** 变量名称表目录（emuera 通用 CSV 目录；CFLAG.csv / Talent.csv … 变量字典来源） */
  csvDir: ['CSV'] as const,

  /** ERB 根目录（引擎 `ErbDir`）。作者自定名表（FT-1）扫这一层里的 `.ERH` */
  erbDir: ['ERB'] as const,

  /** 口上域 */
  paths: {
    /** 口上域根（编辑器主战场） */
    kojoRoot: ['ERB', 'EVENT_K'] as const,
    /** 口上路由总表（口上调用协议的解析来源） */
    kojoMessageRoute: ['ERB', 'EVENT_K', 'EVENT_K.ERB'] as const,
  },

  /** CHARA CSV 文件名形态：`CHARA{no}.csv` */
  charaCsvPattern: /^CHARA(\d+)/i,
} as const;

/**
 * 指令名表文件名（eraAkumaMaid：`<项目根>/CSV/TRAIN.csv`）。
 *
 * 「指令口上」中文名 ↔ 编号的来源（HK-11 / HK-12）。数据源随打开的工程 /
 * 魔改自动跟随、**不内置打包**。
 *
 * ⚠ 盘上实测文件名是**全大写** `TRAIN.csv`（eraTW 是 `Train.csv`）——Windows
 * 大小写不敏感两种写法都能命中，但大小写敏感的宿主上只有逐字匹配才稳，
 * 故按盘实况取全大写。
 */
export const TRAIN_CSV = 'TRAIN.csv';
