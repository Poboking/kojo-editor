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

  /** 口上域 */
  paths: {
    /** 個人口上：编辑器主战场 */
    personalKojo: ['ERB', '口上・メッセージ関連', '個人口上'] as const,
  },

  /** 存档目录（v1.0 快照回放/注入用；适配器提议、内核不感知语义） */
  savDir: ['sav'] as const,

  /** CHARA CSV 文件名形态：`Chara{no} {name}.csv` */
  charaCsvPattern: /^Chara(\d+)/i,
} as const;
