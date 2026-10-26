/**
 * eraTW 领域常量 —— **本文件是「游戏知识归 adapter」原则的集中体现**。
 * 内核与其它通用插件不得引入本文件的任何内容。
 *
 * 全部路径与格式基于 eraTW 4.980 实测（汉化整合版目录结构验证）。
 *
 * 下半部分另有**启动面**（`GameAdapter.launch`）的同步声明（ADAPTER-LAZY 批）：
 * 它们必须开机可读，而探测 / 组装（`probe` / `buildProfile`）只有打开启动器才用
 * ⇒ 常量住本文件（eager），实现走 `./launch` 的懒边。
 */

import type {
  ContentRootSpec,
  EncodingProfile,
  LocaleProfile,
  LogLocation,
  LogParseRules,
  SaveLayoutSpec,
  SaveRootSpec,
} from '@kojo/plugin-api';
import { isAbsolute } from '@kojo/plugin-api';

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

/* ══════════════════════════════════════════════════════════════════════════════
 * 启动面（`GameAdapter.launch`）的**同步声明面** —— ADAPTER-LAZY 批（2026-10-26）
 *
 * 这四件必须"开机即可读"（实例库 / 存档页 / 日志解析一开机就要），而 `probe` /
 * `buildProfile` 只有打开启动器才跑 ⇒ 声明住本文件（已在开机图里，零新增文件），
 * 实现留 `./launch` 的懒边。每条带证据等级（**本机实测** / **文档记载** / **未知**）；
 * 取证盘 eraTW 4.980：`ERB/` 4,509 份 · `CSV/` 55 项 · `resources/` 23 项 328 MB · `sav/` 6 份。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 存档根（**本机实测** `sav/`；`emuera.config` 的 `USE SAV FOLDER:YES` 为**文档记载**） */
export const LAUNCH_SAV_ROOT: SaveRootSpec = {
  id: 'sav',
  label: '存档（sav/）',
  relativePath: ERATW.savDir.join('/'),
  // 引擎自有二进制（`COMPRESS SAVE DATA:YES`；**文档记载**）：只是给上层挑解析器的标签
  format: 'emuera-sav',
  // **契约口径**：shared 实例读可以，写回需用户逐根授权
  writableInShared: false,
};

/** 存档列表（**本机实测** 6 份全 `.sav`）。缺口：契约无排除位 ⇒ `global.sav` 会与应用存档同列 */
export const LAUNCH_SAVE_LAYOUT: SaveLayoutSpec = {
  roots: [LAUNCH_SAV_ROOT],
  listRule: { extensions: ['.sav'], labelFromFileName: true },
};

/**
 * 内容根**声明面**（实例面由 `buildProfile` 再按盘上存在性过滤）。
 * **不声明** `plugins/`（**本机实测**：汉化词典 + 引擎程序集）：内容包落进 DLL 目录
 * 等于换掉引擎代码，任何 `kind` 都不该给这个落点。
 */
export const LAUNCH_CONTENT_ROOTS: readonly ContentRootSpec[] = [
  // **本机实测** 4,509 份脚本：与既有部署写面（个人口上）同域 ⇒ 可写
  { id: 'erb', label: 'ERB 脚本', relativePath: ERATW.erbDir.join('/'), kind: 'script', accepts: ['script'], writableInShared: true },
  // **本机实测** 55 项数据表：改动影响存档兼容与升级 ⇒ 须用户显式授权
  { id: 'csv', label: 'CSV 数据表', relativePath: ERATW.csvDir.join('/'), kind: 'data', accepts: ['data'], writableInShared: false },
  // **本机实测** 23 项 / 328 MB 素材：换素材最容易毁整合包 ⇒ 一律不动（copy 实例里做）
  { id: 'resources', label: 'resources 素材', relativePath: 'resources', kind: 'resource', accepts: ['resource'], writableInShared: false },
];

/** 默认解码（**本机实测** `emuera.log` 为 UTF-8+BOM、`CFLAG.csv` 无 BOM 合法 UTF-8）：`auto` 探不出才退 utf-8；日文原版盘可能 Shift-JIS（**未知**），故不钉 `fixed` */
export const LAUNCH_DEFAULT_ENCODING: EncodingProfile = { mode: 'auto', fallback: 'utf-8' };

/** 语言/区域：跟随系统（**文档记载** `emuera.config` 自管界面语言与 ANSI 编码；契约无"按进程切代码页"）⇒ 只声明不干预 */
export const LAUNCH_DEFAULT_LOCALE: LocaleProfile = { mode: 'inherit' };

/** 定位行路径片段：不含空白与括号/冒号（真盘第 170 行带前缀，贪婪匹配会吞掉它） */
const LAUNCH_PATH_PART = '[^\\s（）()：「」]+?\\.ERB';
/** 形态一 `<路径>.ERB在<N>行`（**本机实测** `emuera.log` 第 167 行） */
const LAUNCH_LOCATION_AT = new RegExp(`(${LAUNCH_PATH_PART})在(\\d+)行`, 'i');
/** 形态二 `<路径>.ERB的第?<N>行`（**本机实测** 第 172 / 170 行） */
const LAUNCH_LOCATION_LINE_OF = new RegExp(`(${LAUNCH_PATH_PART})的第?(\\d+)行`, 'i');
/** 错误标记：汉化版「错误」/ 引擎原句「エラー」（**本机实测**）；「警告」与 ASCII 标记不收（**未知**，保守） */
const LAUNCH_ERROR_MARKER = /错误|エラー/;
/** 纯排版标记行 `<shape …>`（**本机实测**） */
const LAUNCH_SHAPE_ONLY = /^(?:<shape\b[^>]*>\s*)+$/i;

/** 日志路径 → 相对 posix；绝对路径 / 盘符 / `..` 一律 null（契约只认相对 gameRoot，不回显用户目录） */
function launchRelativePosix(raw: string): string | null {
  const text = raw
    .trim()
    // 汉化版在路径外套了全角/半角括号与冒号（`（…内）` / `错误发生在:`）——剥掉包裹符号
    .replace(/^[（(【[「'"]+/, '')
    .replace(/[）)】\]」'"]+$/, '');
  if (text === '') return null;
  const unified = text.replace(/\\/g, '/');
  if (isAbsolute(unified) || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) return null;
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

/** 日志行解析（`logRules`）：三件都在；认不出就 `null`（不猜：没有跳转好过乱跳） */
export const LAUNCH_LOG_RULES: LogParseRules = {
  parseLocation(line: string): LogLocation | null {
    const match = LAUNCH_LOCATION_AT.exec(line) ?? LAUNCH_LOCATION_LINE_OF.exec(line);
    if (!match) return null;
    const relativePath = launchRelativePosix(match[1] ?? '');
    const lineNo = Number.parseInt(match[2] ?? '', 10);
    if (relativePath === null || !Number.isSafeInteger(lineNo) || lineNo <= 0) return null;
    return { relativePath, line: lineNo };
  },
  isErrorLine(line: string): boolean {
    return LAUNCH_ERROR_MARKER.test(line);
  },
  isNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === '' || LAUNCH_SHAPE_ONLY.test(trimmed);
  },
};
