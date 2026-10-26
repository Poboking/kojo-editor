/**
 * eraTW 启动面（`GameLaunchAdapter`）—— **「怎么把 eraTW 跑起来」的全部游戏侧知识**。
 *
 * 规格：`docs/LAUNCHER-ARCHITECTURE.md` §6.1（adapter 启动面职责）/ §6.3（`instanceStore.create`
 * 只用 `probe` 的**候选 id** 与 `buildProfile` 的产物）。`launcher-core` 只认字段名，不认任何
 * 具体值；本文件是这些值在 eraTW 上的唯一住处（内核 / 契约 / Rust 宿主零游戏名词）。
 *
 * ## 证据纪律（每条常量都带等级，改之前先复核）
 *
 * 取证盘：`D:/Game/eratw/eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)`
 * （eraTW 4.980 画蛇添足版；根 34 项 / 16,120 个文件 / 637 MB；`ERB/` 4,509 份其中
 * `.erb` 3,818 + `.erh` 153，`CSV/` 55 项，`resources/` 23 项 328 MB，`sav/` 6 份）。
 * 等级三分：
 * - **本机实测** —— 上面这盘上真读到的字节 / 文件名 / 目录（可在语料换版后整体重核）；
 * - **文档记载** —— 盘上自带的 `.bat` / `readme` / `emuera.config` 写明的行为；
 * - **未知（保守值）** —— 没有证据的一律不猜：`probe` 宁可如实返回「没有候选」，
 *   `buildProfile` 宁可省略字段（声明错比不声明更糟：错声明会让 core 拦掉能跑的、或放过跑不了的）。
 *
 * ## 契约缺口（**只报告，不改契约**；用现有字段表达或保守省略）
 *
 * 1. `LaunchCandidate` 没有「推荐」位 ⇒ 用**排序 + label 后缀「推荐」+ notes 说明**表达；
 * 2. `LaunchCandidate` 没有「证据」位 ⇒ 证据进 `notes`（本文件注释仍逐条留等级）；
 * 3. `LaunchBuildOptions` 没有「调试启动」位 ⇒ `args` 恒为 `[]`（`-debug` 的形态有文档，
 *    但由 `.bat` 显式启动，不是默认启动形态）；
 * 4. `LaunchBuildOptions.runtimeId` 在 `LaunchProfile` 上没有对应字段 ⇒ **忽略**（不假装已生效）；
 * 5. `SaveLayoutSpec.listRule` 只能按扩展名筛 ⇒ `sav/` 里的 `global.sav`（全局数据，不是存档槽）
 *    无法排除，会与应用存档同列（如实报告，不加第二套名单）。
 *
 * ## 本作不需要的成员（缺席 = 该能力整块消失，不降级）
 *
 * - `pluginRules`：本批只落「启动」面；插件安装 / 函数级冲突留给后续车道，缺席 ⇒ 该游戏禁用插件；
 * - `copyExclude`：盘上确有可再生的缓存（`lazyloading.dat` / `emuera.log`），但「哪些丢了不疼」
 *   没有实测依据（`lazyloading.dat` 首次启动重建、`emuera.log` 是崩溃排查的唯一凭据）。
 *   多删一个文件就会让 copy 实例缺证据 ⇒ 本批**不声明**（不猜）。
 */

import type {
  ContentRootSpec,
  DirEntry,
  EncodingProfile,
  FileIO,
  GameLaunchAdapter,
  LaunchBuildOptions,
  LaunchCandidate,
  LauncherErrorCode,
  LaunchProfile,
  LocaleProfile,
  LogLocation,
  LogParseRules,
  Logger,
  SaveLayoutSpec,
  SaveRootSpec,
} from '@kojo/plugin-api';
import { isAbsolute, join } from '@kojo/plugin-api';
import { ERATW } from './constants';

/* ══════════════════════════════════════════════════════════════════════════════
 * 探测：本作可执行体的两个来源（已知名表 + 引擎命名家族）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 引擎可执行体命名家族：`Emuera<任意后缀>.exe`（大小写不敏感）。
 *
 * **本机实测（跨 6 个 era 盘）**：`Emuera_LazyLoadingV3.0_x64.exe`、`Emuera.exe`、
 * `EmueraFL_v1.45-preview.exe`、`Emuera1821 cn v8.exe`、`Emuera1824+v18+EMv17+EEv43.exe`、
 * `Emuera.NET 1824+v22+EMv18+EEv53.exe`、`emuera1824中文版.exe` —— 版本号 / 汉化标记 /
 * 分支名全部落在 `Emuera` 之后，前缀是唯一稳定判据。同盘另有 `update.exe` 一类**非引擎**
 * 程序，故不能退化成「根目录任意 exe 都算候选」。
 */
const EXE_FAMILY = /^emuera.*\.exe$/i;

/** 档位标记（**本机实测**：eraTW 盘上成对出现 `_x64` / `_x86`，其余盘无标记） */
const ARCH_X64 = /x64|amd64/i;
const ARCH_X86 = /x86|win32/i;

interface KnownExe {
  /** 盘上文件名（大小写不敏感命中；命中即取**盘上真名**当相对路径） */
  readonly fileName: string;
  /** adapter 内稳定 id（判据是「这一档」，不含版本号，换版不换 id） */
  readonly id: string;
  readonly arch: 'x64' | 'x86';
  readonly label: string;
  /** 证据（进 `LaunchCandidate.notes`：契约没有 evidence 位，见文件头缺口 2） */
  readonly note: string;
}

/**
 * 已知可执行体（**顺序 = 推荐顺序**；契约没有推荐位，见文件头缺口 1）。
 *
 * 两条证据都来自同一盘点：
 * - 根层无扩展名说明文件 `#双击LazyloadingV3.0开启游戏` 原文：「x64为64位系统准备 /
 *   x86为32为系统准备 / 如无特殊情况，或者你不懂这是什么，那说明你需要选x64」；
 * - `DEBUG_MODE.bat` 内容逐字是 `START Emuera_LazyLoadingV3.0_x64.exe -debug`，
 *   `Debug Mode (拖曳启动).bat` 是 `@echo off` + `START "" "%~1" -debug`
 *   ⇒ **argv 形态「`-debug` 单个开关、可跟任意 exe」有文档**，默认启动**不带参数**。
 */
const KNOWN_EXES: readonly KnownExe[] = [
  {
    fileName: 'Emuera_LazyLoadingV3.0_x64.exe',
    id: 'eratw-lazyloading-x64',
    arch: 'x64',
    label: `${ERATW.displayName}（x64 懒加载版 · 推荐）`,
    note:
      '本机实测：语料根根层即有本文件；同目录 `DEBUG_MODE.bat` 直接 START 它。' +
      '盘上说明「不懂就选 x64」⇒ 64 位系统推荐此档。',
  },
  {
    fileName: 'Emuera_LazyLoadingV3.0_x86.exe',
    id: 'eratw-lazyloading-x86',
    arch: 'x86',
    label: `${ERATW.displayName}（x86 懒加载版）`,
    note: '本机实测：同上目录成对存在；盘上说明「x86 为 32 位系统准备」⇒ 仅在 32 位系统需要。',
  },
];

/** 家族命中但不在已知名表里的候选 id 前缀（`eratw-<slug>`；不与已知名表撞车） */
const FAMILY_ID_PREFIX = 'eratw';

/* ══════════════════════════════════════════════════════════════════════════════
 * 布局：存档根 / 内容根（都按「盘上真的在」产出，缺目录如实省略）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 存档目录相对路径（**本机实测**：`sav/` 6 份 = `global.sav` + `save00..save03.sav` + `save1000.sav`） */
const SAV_RELATIVE = ERATW.savDir.join('/');

/**
 * 存档根。
 *
 * - 目录名`本机实测`；`USE SAV FOLDER:YES`（`emuera.config` 明文，**文档记载**）证明
 *   「存档住在 `sav/` 子目录」不是本盘偶然；
 * - `format: 'emuera-sav'` 只是给上层挑解析器的标签（宿主不解释）；引擎 `COMPRESS SAVE DATA:YES`
 *   + `USE THE BINARY FORMAT FOR SAVING DATA:YES`（**文档记载**）⇒ 是引擎自有二进制，不是纯文本；
 * - `writableInShared: false`：**契约口径**——shared 实例读可以，写回需用户逐根目录授权
 *   （游戏自己写档是进程行为，不走启动器；启动器的恢复/导入才需要这道闸）。
 */
const SAV_ROOT: SaveRootSpec = {
  id: 'sav',
  label: '存档（sav/）',
  relativePath: SAV_RELATIVE,
  format: 'emuera-sav',
  writableInShared: false,
};

/**
 * 内容根（声明面；`buildProfile` 再按「盘上在不在」过滤一层）。
 *
 * - `ERB/`：**本机实测** 4,509 份脚本（`.erb` 3,818 / `.erh` 153）⇒ `script`，可写：
 *   编辑器本来就往 `ERB/口上・メッセージ関連/個人口上` 部署（`loadProject` 的 writablePaths），
 *   内容包落在这里与既有写面同域；
 * - `CSV/`：**本机实测** 55 项（`CFLAG.csv` / `Train.csv` / `Chara/` 168 份…）⇒ `data`，
 *   **不可写**：数据表改动会影响存档兼容与后续版本升级，属「必须用户显式授权」的一类；
 * - `resources/`：**本机实测** 23 项 / 328 MB 素材 ⇒ `resource`，**不可写**：替换素材是最容易
 *   毁掉整合包的一步，shared 实例一律不动（copy 实例里做）。
 *
 * **不声明** `plugins/`（**本机实测** 6 项：`tw_csv_chs.xml` 汉化词典 + `ClassLibrary1.dll` /
 * `MathParser.org-mXparser.dll` 原生/托管程序集）：那是引擎的程序集与全局词典目录，
 * 让内容包落进 DLL 目录 = 直接换掉引擎代码，任何 `kind` 都不该给这个落点。
 */
const CONTENT_ROOTS: readonly ContentRootSpec[] = [
  {
    id: 'erb',
    label: 'ERB 脚本',
    relativePath: ERATW.erbDir.join('/'),
    kind: 'script',
    accepts: ['script'],
    writableInShared: true,
  },
  {
    id: 'csv',
    label: 'CSV 数据表',
    relativePath: ERATW.csvDir.join('/'),
    kind: 'data',
    accepts: ['data'],
    writableInShared: false,
  },
  {
    id: 'resources',
    label: 'resources 素材',
    relativePath: 'resources',
    kind: 'resource',
    accepts: ['resource'],
    writableInShared: false,
  },
];

/**
 * 存档布局（存档页的列表面：`saveLayout.listRule` 决定「列哪些、显示什么名字」）。
 *
 * - `extensions: ['.sav']`：**本机实测** 6 份存档全部 `.sav` 后缀；
 * - `labelFromFileName: true`：显示名去掉扩展名（`save1000` 比 `save1000.sav` 好读）；
 * - 缺口（见文件头缺口 5）：`global.sav` 也在白名单内 —— 契约没有排除位。
 */
const SAVE_LAYOUT: SaveLayoutSpec = {
  roots: [SAV_ROOT],
  listRule: { extensions: ['.sav'], labelFromFileName: true },
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 编码 / 语言
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 日志/文本解码策略。
 *
 * - **本机实测**：引擎自己写的 `emuera.log` 是 **UTF-8 + BOM**（首字节 `EF BB BF`，30,055 B）；
 *   `CSV/GameBase.csv` 同为 UTF-8 BOM（`コード,7153` / `タイトル,eraThe World【画蛇添足版】`），
 *   `CSV/CFLAG.csv` 是无 BOM 的合法 UTF-8（`1,既成事実`）——本盘 CSV/ERB 无一需要 Shift-JIS 解；
 * - 故 `fallback` 取 `utf-8`：`auto` 先探 BOM/UTF-8，探不出时才退这一档；
 * - **未知（保守值）**：日文原版的盘可能是 Shift-JIS，`auto` 的探测本身能覆盖；
 *   标准输出的代码页随控制台设置（`emuera.config` 只写了 `DEFAULT ANSI ENCODING:CHINESE_HANS`
 *   这类**文件**编码项），故不钉 `mode: 'fixed'`。
 */
const DEFAULT_ENCODING: EncodingProfile = { mode: 'auto', fallback: 'utf-8' };

/**
 * 语言/区域：`inherit`（跟随系统）。
 *
 * 依据（**文档记载**）：`emuera.config` 里 `EMUERA INTERFACE LANGUAGE:简体中文`、
 * `DEFAULT ANSI ENCODING:CHINESE_HANS` —— 界面语言与 ANSI 解码由**引擎自己的配置**决定，
 * 不依赖进程区域；而契约首版也明说不存在「按进程切 ANSI 代码页」的原生能力，
 * 故这里只声明「不干预」，不假装能切日区。
 */
const DEFAULT_LOCALE: LocaleProfile = { mode: 'inherit' };

/* ══════════════════════════════════════════════════════════════════════════════
 * 日志行解析（`LogParseRules`）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 定位行里的路径片段：**不含空白与括号/冒号**。
 *
 * 为什么不写成 `(.+?\.ERB)`：真盘第 170 行的形态是
 * `函数: @GET_MAPID（MOVEMENTS\物件関連\COMMON2.ERB的26行）` —— 贪婪到「最后一个 `.ERB`」
 * 会把 `函数: @GET_MAPID（` 一起吞进路径。文件名带空格的 `.ERB` 确实存在（引擎允许），
 * 但那种名字在这里**切不出可靠边界** ⇒ 按「宁可漏报不可误报」当作认不出（返回 null），
 * 而不是猜一个半截路径去做跳转。
 */
const PATH_PART = '[^\\s（）()：「」]+?\\.ERB';

/**
 * 定位行形态一：`<路径>.ERB在<N>行` —— **本机实测**原句
 * `MOVEMENTS\物件関連\COMMON2.ERB在30行错误发生在:…`（`emuera.log` 第 167 行）。
 */
const LOCATION_AT = new RegExp(`(${PATH_PART})在(\\d+)行`, 'i');

/**
 * 定位行形态二：`<路径>.ERB的第?<N>行` —— **本机实测**原句
 * `MOVEMENTS\物件関連\PLACE_拠点別分岐.ERB的第255行（函数@NAME_FROM_PLACE内）`（第 172 行）
 * 与 `函数: @GET_MAPID（MOVEMENTS\物件関連\COMMON2.ERB的26行）`（第 170 行，无「第」）。
 */
const LOCATION_LINE_OF = new RegExp(`(${PATH_PART})的第?(\\d+)行`, 'i');

/**
 * 错误行标记（**本机实测**：中文汉化版的「错误内容:」「…错误发生在:」；
 * 引擎日文原句一律是「エラー」）。**不**收 `警告`（引擎的「基本标志未设定」一类是警告，
 * 计进错误会让崩溃摘要全是噪声）；ASCII 标记（`ERROR:` / `Exception`）在盘上未出现 ⇒
 * **未知，保守不收**——宁可漏报不可误报。
 */
const ERROR_MARKER = /错误|エラー/;

/** 纯排版标记行（`emuera.log` 里大量 `<shape type='space' param='100'>` 分隔物；**本机实测**） */
const SHAPE_ONLY = /^(?:<shape\b[^>]*>\s*)+$/i;

/**
 * 日志路径 → 相对 posix 路径；**不合法（绝对路径 / 盘符 / `..`）一律 null**。
 *
 * 契约只认相对 `gameRoot` 的路径（绝对路径会把用户目录带进编辑器 UI / 诊断包）；
 * 这里拿不到 `gameRoot`，所以宁可不给位置，也不回显绝对路径。
 */
function toRelativePosix(raw: string): string | null {
  const text = raw
    .trim()
    // 汉化版在路径外面套了全角/半角括号与冒号（`（…内）` / `错误发生在:`）——剥掉包裹符号
    .replace(/^[（(【[「'"]+/, '')
    .replace(/[）)】\]」'"]+$/, '');
  if (text === '') return null;
  const unified = text.replace(/\\/g, '/');
  if (isAbsolute(unified) || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) return null;
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

const LOG_RULES: LogParseRules = {
  /** 认不出就 `null`（不猜：宁可没有跳转，也不把正文里随便一段当文件路径） */
  parseLocation(line: string): LogLocation | null {
    const match = LOCATION_AT.exec(line) ?? LOCATION_LINE_OF.exec(line);
    if (!match) return null;
    const relativePath = toRelativePosix(match[1] ?? '');
    const lineNo = Number.parseInt(match[2] ?? '', 10);
    if (relativePath === null || !Number.isSafeInteger(lineNo) || lineNo <= 0) return null;
    return { relativePath, line: lineNo };
  },
  isErrorLine(line: string): boolean {
    return ERROR_MARKER.test(line);
  },
  isNoiseLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === '' || SHAPE_ONLY.test(trimmed);
  },
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 错误：候选不合法（与 core 同一码语义；本包不 import `launcher-core`）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * adapter 侧的启动错误。
 *
 * 形状刻意与 `LauncherError` 对齐（`code` / `message` / `detail` / `retryable`）：
 * `launcher-core` 的 `normalizeLauncherError` 会**原样保留**合集内的码与中文 message，
 * 所以这里抛 `LAUNCHER_EXECUTABLE_INVALID` 就等价于 core 自己那一句（见
 * `instance-store.ts::create` 对「候选 id 不在探测结果里」的同一判据）。
 * `message` 用中文（英文串会被 core 压成默认话术、原文进 detail）。
 */
export class EratwLaunchError extends Error {
  readonly code: LauncherErrorCode;
  readonly detail: string;
  /** `LAUNCHER_EXECUTABLE_INVALID` 是确定性拒绝，重试没有意义（与 core 码级默认一致） */
  readonly retryable = false;

  constructor(code: LauncherErrorCode, message: string, detail: string) {
    super(message);
    this.name = 'EratwLaunchError';
    this.code = code;
    this.detail = detail;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 工厂
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface EratwLaunchDeps {
  /** 插件上下文注入的 `kernel.io`（只用到只读两件：列举 + 存在性；**不 import 内核实现**） */
  readonly io: Pick<FileIO, 'listDir' | 'exists'>;
  readonly log: Logger;
}

/** 可执行体相对路径的判据：相对、无 `..`、无盘符、UNC、以 `.exe` 结尾（否则抛 EXECUTABLE_INVALID） */
function executableRelativePathOrThrow(raw: string): string {
  const text = raw.trim();
  const unified = text.replace(/\\/g, '/');
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  const problem =
    text === ''
      ? '空路径'
      : isAbsolute(unified) || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')
        ? '是绝对路径或带盘符'
        : segments.some((segment) => segment === '..')
          ? '含 .. 段'
          : segments.some((segment) => segment.includes(':'))
            ? '段里带冒号（盘符 / 备用数据流形态）'
            : !/\.exe$/i.test(unified)
              ? '不是 .exe'
              : null;
  if (problem !== null) {
    throw new EratwLaunchError(
      'LAUNCHER_EXECUTABLE_INVALID',
      '目标程序不合法：必须是游戏目录内的可执行文件',
      `可执行体相对路径「${text}」${problem}（只允许 gameRoot 内的相对 .exe 路径）`,
    );
  }
  return segments.join('/');
}

/** 名字 → 稳定 id 片段（小写、非 `[a-z0-9]` 折叠成 `-`；中文名只剩 ASCII 段，仍稳定） */
function slugOf(fileName: string): string {
  const slug = fileName
    .replace(/\.exe$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'exe' : slug;
}

/** 从文件名推档位；**未知就不给**（`'any'` 会被读成「平台无关」，比不给更糟） */
function archOf(fileName: string): 'x64' | 'x86' | null {
  if (ARCH_X64.test(fileName)) return 'x64';
  if (ARCH_X86.test(fileName)) return 'x86';
  return null;
}

/**
 * eraTW 的启动面（`GameAdapter.launch`）。
 *
 * `probe` / `buildProfile` 都**只读**（`listDir` + `exists`），不写盘、不 import 内核实现；
 * 写授权一律留在启动器与宿主（铁律 5 / 6）。
 */
export function createEratwLaunchAdapter(deps: EratwLaunchDeps): GameLaunchAdapter {
  /** `exists` 读不动 = 按「不在位」处理（如实省略路径，不当成错误；但必须出声） */
  const existsSafe = async (path: string): Promise<boolean> => {
    try {
      return await deps.io.exists(path);
    } catch (err) {
      deps.log.warn(`启动面：路径存在性判定失败（按不在位处理）${path}：${String(err)}`);
      return false;
    }
  };

  /** 根目录列举；读不动返回 null（`probe` 据此如实给「没有候选」而不是抛） */
  const listRootSafe = async (rootDir: string): Promise<DirEntry[] | null> => {
    try {
      return await deps.io.listDir(rootDir);
    } catch (err) {
      deps.log.warn(`启动面：目录列举失败（视为没有候选）${rootDir}：${String(err)}`);
      return null;
    }
  };

  const probe = async (rootDir: string): Promise<readonly LaunchCandidate[]> => {
    const entries = await listRootSafe(rootDir);
    if (entries === null) return [];

    // 根层 exe：只认引擎命名家族（同盘的 `update.exe` 一类不是游戏本体）
    const family = new Map<string, DirEntry>();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!EXE_FAMILY.test(entry.name)) continue;
      family.set(entry.name.toLowerCase(), entry);
    }

    const candidates: LaunchCandidate[] = [];
    const claimed = new Set<string>();

    // ① 已知名表（顺序即推荐序）
    for (const known of KNOWN_EXES) {
      const key = known.fileName.toLowerCase();
      const entry = family.get(key);
      if (entry === undefined) continue;
      claimed.add(key);
      candidates.push({
        id: known.id,
        label: known.label,
        executableRelativePath: entry.name,
        arch: known.arch,
        notes: known.note,
      });
    }

    // ② 家族里剩下的（换版 / 别家整合 / 汉化改名的引擎程序）：能认就认，**不推荐**
    //    排序用码元比较（不用 `localeCompare`：它随 ICU/区域变，候选顺序必须可复现）
    const extras = [...family.entries()]
      .filter(([key]) => !claimed.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const usedIds = new Set(candidates.map((candidate) => candidate.id));
    for (const [, entry] of extras) {
      let id = `${FAMILY_ID_PREFIX}-${slugOf(entry.name)}`;
      for (let n = 2; usedIds.has(id); n += 1) id = `${FAMILY_ID_PREFIX}-${slugOf(entry.name)}-${n}`;
      usedIds.add(id);
      const arch = archOf(entry.name);
      candidates.push({
        id,
        label: `${ERATW.displayName}（${entry.name}）`,
        executableRelativePath: entry.name,
        ...(arch === null ? {} : { arch }),
        notes:
          '本机实测（家族判据）：文件名落在 `Emuera*.exe` 家族里，但不是本机取证过的那两档之一。' +
          '档位（x64/x86）与推荐位未知 ⇒ 保守不推荐；实为 32 位程序时选它，否则请用带 `_x64` 的那份。',
      });
    }

    deps.log.debug(`启动面：${rootDir} 探到 ${candidates.length} 个候选（根层 exe ${family.size} 个）`);
    return candidates;
  };

  /** 存档根：`sav/` 在盘上才声明（缺目录如实省略，绝不给不存在的路径） */
  const saveRootsOf = async (rootDir: string): Promise<SaveRootSpec[]> =>
    (await existsSafe(join(rootDir, ...ERATW.savDir))) ? [SAV_ROOT] : [];

  /** 内容根：逐个按存在性过滤（同一理由：路径必须真的在） */
  const contentRootsOf = async (rootDir: string): Promise<ContentRootSpec[]> => {
    const present: ContentRootSpec[] = [];
    for (const root of CONTENT_ROOTS) {
      if (await existsSafe(join(rootDir, ...root.relativePath.split('/')))) present.push(root);
    }
    return present;
  };

  /**
   * 候选 + 用户选项 → 完整启动描述。
   *
   * 刻意**复跑一次 `probe`**（而不是自己拼路径）：`candidateId` 是唯一的寻址方式，
   * 「id 有效 ⇔ 该 id 此刻仍在探测结果里」这条判据只有一处真源（同 core 的 create 判据）。
   */
  const buildProfile = async (
    rootDir: string,
    candidateId: string,
    options: LaunchBuildOptions = {},
  ): Promise<LaunchProfile> => {
    const candidates = await probe(rootDir);
    const hit = candidates.find((candidate) => candidate.id === candidateId);
    if (hit === undefined) {
      throw new EratwLaunchError(
        'LAUNCHER_EXECUTABLE_INVALID',
        '目标程序不合法：必须是游戏目录内的可执行文件',
        `候选 ${candidateId} 不在 ${rootDir} 的探测结果里（实测候选：${
          candidates.map((candidate) => `${candidate.id}→${candidate.executableRelativePath}`).join('、') ||
          '无'
        }）`,
      );
    }
    const relativePath = executableRelativePathOrThrow(hit.executableRelativePath);

    const saveRoots = await saveRootsOf(rootDir);
    const contentRoots = await contentRootsOf(rootDir);

    const warnings: string[] = [];
    const head = candidates[0];
    if (head !== undefined && head.id !== hit.id) {
      warnings.push(
        `同目录还有推荐位更高的候选「${head.label}」（${head.executableRelativePath}）：` +
          '盘上说明 64 位系统应选 x64 档；若当前不是 32 位系统，建议改选它。',
      );
    }
    if (saveRoots.length === 0) {
      warnings.push(
        `未发现「${SAV_RELATIVE}/」存档目录：引擎首次存档才会创建它，此刻声明一个不存在的路径只会让存档页指空。`,
      );
    }

    /**
     * 一个字面量都不外溢的组装点。
     *
     * **刻意缺席的字段：`runtime`**。`emuera.log` 首行自述 `Emuera.NET 1.824+v22+…`
     * （**本机实测**），说明引擎是 .NET 构建，但适配器无法核验 .NET 框架/运行时的版本；
     * 而声明任何 `versionRange` 都会让 core 在「缺登记的运行时」时**直接拦启动**
     * （`LAUNCHER_RUNTIME_MISSING`）——错声明比不声明更糟。等启动器真有登记运行时的
     * 那一批再补（本批只报告，不动契约）。
     */
    return {
      candidateId: hit.id,
      executable: {
        relativePath,
        /**
         * **文档记载**：正常启动不带参数（双击 exe / `#双击…` 说明文件）；
         * `-debug` 只出现在两个专门的开 debug `.bat` 里 ⇒ 默认 `[]`。
         * 其余参数未知（保守：一律不带）。
         */
        args: [],
        /** 无需追加环境变量：编码/界面语言都在 `emuera.config`（文档记载） */
        env: {},
        /**
         * `auto`：引擎是自带窗口的 GUI 进程（`emuera.config` 的 `WINDOW WIDTH/HEIGHT`、
         * `MAXIMIZE WINDOW ON STARTUP` 都是引擎自己的窗口设置），没有需要宿主隐藏的控制台
         * ⇒ 不给 `hidden` / `visible` 这种宿主侧硬判据。
         */
        windowMode: 'auto',
        /** 宿主在创建/信任时算好写回；JS 传的值一律忽略（契约注释），这里如实给 null */
        sha256: null,
      },
      /**
       * `'.'`（exe 同层）：**本机实测** `ERB/` `CSV/` `emuera.config` `sav/` 全在 exe 同层，
       * 引擎按「exe 所在目录」找数据根；盘上没有 `-root` 一类改数据根的参数证据。
       */
      cwdRelative: '.',
      /** 语言/区域：缺省跟随系统（依据见 `DEFAULT_LOCALE` 的注释） */
      locale: options.locale ?? DEFAULT_LOCALE,
      /** 解码策略：与 `defaultEncoding` 同一档（依据见 `DEFAULT_ENCODING` 的注释） */
      encoding: options.encoding ?? DEFAULT_ENCODING,
      saveRoots,
      contentRoots,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  return {
    probe,
    buildProfile,
    saveLayout: SAVE_LAYOUT,
    contentRoots: CONTENT_ROOTS,
    logRules: LOG_RULES,
    /**
     * 与 `buildProfile` 的 `encoding` 同一档（单源：改一处两处都跟着变）。
     * 契约里这个字段是「日志默认编码；不给 = auto」的实例级落点。
     */
    defaultEncoding: DEFAULT_ENCODING,
  };
}
