/**
 * eraTW 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 eraTW 4.980 实测（汉化整合版 SANYOUSEI 目录结构验证）。
 */

export const ERATW = {
  gameId: 'eratw',
  displayName: 'eraTW',

  /** 工程识别特征（两者同时存在才判定为 eraTW 工程） */
  detect: {
    /** 口上・消息域目录（eraTW 特有结构） */
    kojoRoot: ['ERB', '口上・メッセージ関連'] as const,
    /** 角色数据目录（emuera 通用 CSV 目录下的 Chara 子目录） */
    charaCsvDir: ['CSV', 'Chara'] as const,
  },

  /** 变量名称表目录（emuera 通用 CSV 目录；CFLAG.csv / Talent.csv … 变量字典来源） */
  csvDir: ['CSV'] as const,

  /**
   * ERB 根目录（引擎 `Program.ErbDir`）。变量字典的**作者自定名表**（FT-1）扫这一层：
   * `.ERH` 具名常量声明散落在整棵 ERB 子树里（实测画蛇添足版 153 份 / 400KB）。
   */
  erbDir: ['ERB'] as const,

  /**
   * 变量名汉化词典（游戏自带 JP→CN 名词典；引擎 `SYSTEM.ERB` 经 `MAP_FROMXML`
   * 装为 `CSV_MAP`，游戏 UI 的名称汉化就靠它）。相对工程根。
   */
  chsNameMap: ['plugins', 'tw_csv_chs.xml'] as const,

  /** 口上域 */
  paths: {
    /** 個人口上：编辑器主战场 */
    personalKojo: ['ERB', '口上・メッセージ関連', '個人口上'] as const,
    /** 口上路由总表（v0.2 第十批：口上调用协议的解析来源） */
    kojoMessageRoute: ['ERB', '口上・メッセージ関連', 'KOJO_MESSAGE.ERB'] as const,
  },

  /** 存档目录（v1.0 快照回放/注入用；适配器提议、内核不感知语义） */
  savDir: ['sav'] as const,

  /** CHARA CSV 文件名形态：`Chara{no} {name}.csv` */
  charaCsvPattern: /^Chara(\d+)/i,
} as const;

/**
 * 指令名表文件名（eraTW：`<项目根>/CSV/Train.csv`）。
 *
 * 「指令口上」中文名 ↔ 编号的来源（HK-11 / HK-12）。数据源随打开的工程 / 汉化包
 * 变化、**不内置打包**——各版本 / 魔改自动跟随。
 */
export const TRAIN_CSV = 'Train.csv';
