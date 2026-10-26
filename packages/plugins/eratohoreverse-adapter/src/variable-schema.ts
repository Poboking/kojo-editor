/**
 * eratohoReverse 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 形态照 `eratohok-adapter/src/variable-schema.ts`（同一套三层数据源、同一份 `inputDigest`
 * 折叠口径、同一条「层内后者胜 / 跨层主表胜」的合并裁决、同一组导出名），差异全部来自
 * `C:/game/eratohoReverse` 实测语料（2026-10-26 勘查；路径与真盘事实见 `./constants.ts`）。
 *
 * ## 真盘普查读数（按本模块 loader 的逐字口径复算，非抽样；`tests/` 的真盘用例逐条钉住）
 *
 * - 名称表 **28 张**（`CSV/` 根层全部 `.csv`；另有 `_default.config` / `_fixed.config` 两份
 *   配置不是 `.csv`，天然不参与）。**有条目标签的名词总数 1038 条**（各表 `byIndex` 之和）、
 *   有名行也是 1038 行 ⇒ **层内重号 0 处**——本作的表没有 eraTW 那种「同一编号跨段复用」形态，
 *   「后者胜」在真盘上是死分支，但裁决照旧保留（魔改能造出来）；空名称跳过 **27 行**；
 * - 逐表条目数：ABL 26 / BASE 9 / CFLAG 77 / CSTR 33 / EQUIP 40 / EX 8 / EXP 35 / FLAG 68 /
 *   GAMEBASE 0 / **GLOBAL 3** / **GLOBALS 6** / ITEM 23 / MARK 5 / PALAM 14 / SAVESTR 2 /
 *   SOURCE 19 / STAIN 7 / STR 198 / STRNAME 79 / TALENT 111 / TCVAR 65 / TEQUIP 55 /
 *   TFLAG 117 / TIME 2 / TRAIN 33 / TSTR 3 / VARIABLESIZE 0 / `_REPLACE` 0；
 * - `.ERH` 作者自定名表：**17 份全部住在受管的 `ERB/` 下**（`口上テンプレ/` 那棵干扰树 0 份），
 *   其中 **16 份含声明、74 条声明行、74 个唯一声明名、0 个带整数初值**。真盘声明形态就是
 *   `#DIMS SAVEDATA KEY_UP` / `#DIMS GLOBAL SAVEDATA C_G_LINM` / `#DIMS UPC_S, 10` /
 *   `#DIMS CONST C_OPTION  = "行数", "列数", "项目"` 四类：`#DIM CONST` 只挂**字符串清单**，
 *   `, 10` 之类是数组尺寸不是编号 ⇒ **本作 const 层一律只认名字、一个编号也不换算**
 *   （`resolvedIndex` 全缺省；这不是漏实现，是盘上确实没有可换算的整数值）；
 *   另注：`grep -c '^[[:space:]]*#DIM'` 口径读出来是 **14 份 / 70 条**，差的 4 条压在
 *   **各文件的 BOM 首行**（`HTML_FUNC` / `SYSTEM_LAYER` / `SYSTEM_LAYER_ADD` / `TAGPRINT` 各 1 条）
 *   ——BOM 不是行首空白，纯 `^#DIM` 判据会漏；本模块先 `trim()` 再判，所以读到 74 条；
 * - 追加名表 `.als`：**全树 0 份** ⇒ 主表之后只有市场字典包追加层（缺省为空，代码路径保留，
 *   将来汉化包 / 魔改放 `.als` 或市场包即可自动生效）；
 * - 指令名表 `CSV/Train.csv`：**67 行 / 33 条编号 / 33 个唯一名 / 0 处重名**（表头自述
 *   「反应(COM)名」；本作血统是 eraKanon 改変，`CSV/GameBase.csv` 的 `追加情報` 行自述，
 *   `constants.ts` 记作 `:16`），比 eraTW 的 233 条薄得多 ⇒ 指令中文名词表覆盖率天然低，
 *   **一律只用真盘这张表，绝不拿 eraTW 词表补洞**。
 *   **留给主会话的一个口子（本模块不擅自改口径）**：真盘的 ACT 指令名其实住在
 *   `CSV/Str.csv` 的分段注释底下（`;调教指令名称(ACT) 通常行动0-199` @ `:10`、
 *   `(SPACT) 200-299` @ `:135`、`(助手コンビ派生ACT)` @ `:142`，即 `STR` 族 198 条里），
 *   而 `constants.ts` 把 `instructionCsv` 定为 `Train.csv` ⇒ 指令名 seam 究竟取哪张表是
 *   constants / plugin.ts 的决定，不在本文件范围；这里只按 constants 读 `Train.csv`。
 *
 * ## 表名归一口径（本作独有的一条闸）
 *
 * 表键 = **文件名去扩展名后大写**（`Cflag.csv` → `CFLAG`、`Globals.csv` → `GLOBALS`）；
 * 建表与查询的匹配一律大小写不敏感（盘上实测是 `Cflag.csv` / `Tflag.csv` 这类**首字母大写**
 * 形态，eraFL 才是 `CFLAG.CSV` 全大写；魔改版写 `CFLAG.Csv` 也必须认）。但**精确按文件名取，
 * 绝不做前缀匹配**：真盘同时存在 `Global.csv`（15 行 / 3 条，键 `GLOBAL`）与 `Globals.csv`
 * （17 行 / 6 条，键 `GLOBALS`），是两张**不同名**的表、编号段互不相交
 * （`GLOBAL:0` = 「动画效果配置」，`GLOBALS:10` = 「自动模式登录0」）
 * ⇒ 任何 `^GLOBAL` 式的前缀吞并把两张表并成一张就是错的；
 * `tests/variable-schema.test.ts` 的用例「`Global.csv` 与 `Globals.csv` 是两个独立键」钉住这条。
 *
 * ## 换行口径（本作 100% 纯 LF）
 *
 * 全树 1085 份 `.ERB` / `.ERH` / `.csv` / `.config` 实测 **100% UTF-8 BOM + 100% 纯 LF
 * （含 CR 的 0 份）**——eraTW / eratohoK 都是 CRLF 主导，所以**任何按 CRLF split 的写法在这里
 * 都是错的**（`text.split('\r\n')` 会把整本表读成一行 ⇒ 全表 0 条）。本模块一律
 * `split(/\r\n?|\n/)`（LF 为主、CRLF 也吃，给将来的魔改版留着），测试钉一条**纯 LF** 用例。
 *
 * ## 解析策略（宽容，与模板同）
 *
 * - 跳过空行与 `;` 开头的整行注释（真盘 `POSE.ERH` 的 `;#DIMS POSE_L, 100, 5` 就是被注释掉的
 *   声明 ⇒ 不收，这也是该文件在 16/17 之外的原因）；
 * - 行首非数字不收录（`GameBase.csv` 的 `タイトル,eratohoЯeverse` / `VariableSize.csv` 的
 *   `CFLAG,3000` 这类键值行天然 0 条）；
 * - 名称取第二个字段并剥掉行内 `;` 注释——**标签一律取原文**：本仓库做过机翻混排（中日并列，
 *   如 `Strname.csv` 的 `1300,好感的反应,    ;【屈服:0】好感的反应(调教对象但积极的服从系被选择)`），
 *   所以盘上读出来是什么就写什么，**不编造中文、不回填 eraTW 的措辞**；
 * - 同时建立名称 → 编号反向表（`lookup('CFLAG', '调教等级')` 双向可用）；
 * - 层内同编号**后者胜**；跨层追加表只补不盖。
 *
 * 读取失败 / 缺表 → 对应族缺席，`lookup` 返回 `undefined`（通用层照常工作）；
 * 失败一律 `log.warn`（不静默）。角色 CSV 在 `CSV/CHARA/`（108 份 `Chara{no}_{名前}.csv`），
 * 根层扫描天然干净；`^CHARA\d+` 排除只作为「魔改把角色表挪回根层」的兜底保留。
 *
 * **`Train.csv` 不塞进 `VariableSchema`**：契约里指令名查询是另一个 seam
 * （`GameAdapter.kojoInstructionTable`）。本模块额外导出
 * `loadEratohoreverseInstructionNames()`，与字典共用同一份解析器。
 */

import { foldDigest, isErbDeclarationPath, stableHash } from '@kojo/plugin-api';
import type {
  FileIO,
  KojoInstructionTable,
  Logger,
  VariableInfo,
  VariableSchema,
  VariableSource,
} from '@kojo/plugin-api';
import { ERATOHOREVERSE } from './constants';

/** 名称表键的来源层：`.csv` 主表 / 市场字典包追加（`.ERH` 常量走另一条路，见 `lookup`） */
export type NameTableSource = Extract<VariableSource, 'primary' | 'append'>;

export interface VariableTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
  /** 键 → 来源层（与两张 Map 同一裁决：键最后一次落地的那一轮） */
  indexSource: Map<string, NameTableSource>;
  nameSource: Map<string, NameTableSource>;
}

/** 一条「编号重复」现场（调用方负责把文件名拼进日志；本模块只报事实） */
export interface NameTableOverwrite {
  index: string;
  previous: string;
  next: string;
}

export interface NameTableParseResult {
  table: VariableTable;
  /** 名称为空而跳过的行数 */
  skippedEmptyName: number;
  /** 编号重复（层内后者胜）的条数 */
  overwritten: number;
}

const emptyTable = (): VariableTable => ({
  byIndex: new Map(),
  byName: new Map(),
  indexSource: new Map(),
  nameSource: new Map(),
});

/** 剥掉行内注释：`;` 起的一切都不算名称（`3,名前<tab>;注` 与 `1300,名,    ;【屈服:0】…` 同吃） */
function stripInlineComment(field: string): string {
  const semi = field.indexOf(';');
  return (semi >= 0 ? field.slice(0, semi) : field).trim();
}

/**
 * 把一份名称表**并入**累积表（纯函数，就地改 `target`；导出供测试）。
 *
 * 裁决：
 * - **层内后者胜**：同编号再出现时用新名称覆盖旧名称，并回调 `onOverwrite`；
 * - **跨层主表胜**：`source === 'append'` 撞上主表已有的编号 ⇒ 整行跳过。
 * 反查表 `byName` 与 `byIndex` 同向覆盖（旧名不删：它仍指向同一槽位）。
 *
 * 换行 split 用 `/\r\n?|\n/`：本作实测 100% 纯 LF（见头注），只按 CRLF split 会把整本表
 * 读成一行；写成 `\r\n?` 形态同时保住将来魔改版的 CRLF。
 */
export function mergeNameTable(
  target: VariableTable,
  text: string,
  opts: { source?: NameTableSource; onOverwrite?: (e: NameTableOverwrite) => void } = {},
): Omit<NameTableParseResult, 'table'> {
  const source = opts.source ?? 'primary';
  let skippedEmptyName = 0;
  let overwritten = 0;
  for (const rawLine of text.split(/\r\n?|\n/)) {
    // `trim()` 顺带吃掉 UTF-8 BOM（U+FEFF 属 ES 空白集）；本作 BOM 100%，不是可选项
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const index = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(index)) continue; // `タイトル,eratohoЯeverse` / `CFLAG,3000` 这类键值行天然不收
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = stripInlineComment(secondComma >= 0 ? rest.slice(0, secondComma) : rest);
    if (name.length === 0) {
      skippedEmptyName++;
      continue;
    }
    const previous = target.byIndex.get(index);
    const previousSource = target.indexSource.get(index);
    if (source === 'append' && previousSource === 'primary') continue;
    if (previous !== undefined && previous !== name) {
      overwritten++;
      opts.onOverwrite?.({ index, previous, next: name });
    }
    target.byIndex.set(index, name);
    target.indexSource.set(index, source);
    if (!(source === 'append' && target.nameSource.get(name) === 'primary')) {
      target.byName.set(name, index);
      target.nameSource.set(name, source);
    }
  }
  return { skippedEmptyName, overwritten };
}

/** 解析单份名称表 CSV（纯函数；导出供测试）——等价于并入一张空表 */
export function parseNameTableCsv(
  text: string,
  opts: { source?: NameTableSource; onOverwrite?: (e: NameTableOverwrite) => void } = {},
): NameTableParseResult {
  const table = emptyTable();
  const stats = mergeNameTable(table, text, opts);
  return { table, ...stats };
}

/**
 * 解析 `.ERH` 声明行 → 作者自定名表 `Map<大写名称, 整数编号 | undefined>`（纯函数）。
 *
 * 收本作实测的四类形态（74 条声明行全在此列）：`#DIMS SAVEDATA KEY_UP` /
 * `#DIMS GLOBAL SAVEDATA C_G_LINM`（修饰词可连写，逐个剥）/ `#DIMS UPC_S, 10`（数组）/
 * `#DIMS CONST C_OPTION  = "行数", "列数", "项目"`（字符串清单，名字收、编号不猜）。
 *
 * 不收「猜出来的编号」：初值只认十进制 / `0x` 十六进制**非负整数字面量**；表达式、字符串清单、
 * 数组尺寸一律 undefined——`resolvedIndex` 用于存档寻址，猜错一个值就会读错槽位。
 * 本作真盘是极端情形：**74 个名字 0 个带整数初值** ⇒ const 层只认名字（见头注）。
 *
 * 行首要先 `trim()` 再判 `#`：本作有 4 条声明压在**各文件的 BOM 首行**（`HTML_FUNC.ERH:1`
 * 的 `﻿#DIMS CONST HTML_SUBSTITUTE = "【HTML】"` 一类），只按 `^#DIM` 逐行匹配会漏掉它们
 * （`grep` 口径因此读出 70 条 / 14 份，本模块读出 74 条 / 16 份）。
 * `;` 起的首行同样不收：`POSE.ERH` 整份只有一条被注释掉的 `;#DIMS POSE_L, 100, 5`。
 */
export function parseErhDeclarations(text: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const head = rawLine.trim(); // 吃掉 BOM（含压在首行的那 4 条）
    if (!head.startsWith('#')) continue;
    const semi = head.indexOf(';');
    const line = (semi >= 0 ? head.slice(0, semi) : head).trim();
    const m = /^#(DIMS|DIMF|DIM)([^A-Za-z0-9_]|$)([\s\S]*)$/i.exec(line);
    if (m === null) continue;
    let rest = (m[3] ?? '').trim();
    for (;;) {
      // 前置修饰词逐个剥掉（`#DIMS GLOBAL SAVEDATA C_G_LINM` 是两个修饰词连写）
      const km = /^([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_]|$)([\s\S]*)$/i.exec(rest);
      if (km === null) break;
      if (!ERH_DECL_KEYWORDS.has((km[1] ?? '').toUpperCase())) break;
      rest = (km[3] ?? '').trim();
    }
    const eq = rest.indexOf('=');
    const namePart = (eq >= 0 ? rest.slice(0, eq) : rest).trim();
    // 名字后面可能是 `= …`（已切走）、`, 尺寸…`（数组）或行尾
    const name = (namePart.split(/[\s,]+/)[0] ?? '').trim();
    if (name.length === 0) continue;
    const key = name.toUpperCase();
    if (out.has(key)) continue;
    out.set(key, eq >= 0 ? integerLiteral(rest.slice(eq + 1)) : undefined);
  }
  return out;
}

/** `.ERH` 声明行的前置关键字（Emuera `UserDefinedVariableData.Create` 认的修饰词） */
const ERH_DECL_KEYWORDS = new Set([
  'CONST',
  'LOCAL',
  'STATIC',
  'DYNAMIC',
  'GLOBAL',
  'SAVEDATA',
  'REF',
  'OUT',
  'CHARADATA',
]);

/** 整数字面量（十进制 / `0x` 十六进制）→ 编号；其它形态一律不认 */
function integerLiteral(text: string): number | undefined {
  const s = text.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined;
  const n = /^0[xX]/.test(s) ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export interface EratohoreverseVariableSchemaDeps {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径；即 `constants.ts` 的 `paths.csvDir` = `CSV`，根层 28 份 `.csv`） */
  csvDir: string;
  /** ERB 根目录（绝对路径；作者自定名表要递归整棵树——本作 17 份 `.ERH` 全在 `ERB/` 下） */
  erbDir: string;
  log: Logger;
  /**
   * 市场字典包（`kind === 'dict-pack'`）的 contentDir 列表（additive）。
   * 每个目录里的 `*.csv` 一律以 `source: 'append'` 并入；缺省 / 空数组 = 不读市场。
   */
  marketAppendDirs?: string[];
}

/** 名称表文件：`{变量名}.csv`（主表）或字典包里的同名表（追加层） */
interface NameTableFile {
  variableName: string;
  path: string;
}

/** 字符串路径序（确定性：目录与文件两级的「先定义优先」裁决都不许随枚举顺序漂） */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 文件名 → 表键：**去扩展名后大写**（`Cflag.csv` / `TRAIN.CSV` / `Globals.csv` 都归一）。
 * 这是本作唯一的归一形态——**不做前缀折叠**，故 `GLOBAL` 与 `GLOBALS` 保持两个键
 * （真盘两张表并存、编号段互不相交；头注那条闸）。
 */
function tableNameOf(fileName: string): string {
  return fileName.replace(/\.csv$/i, '').toUpperCase();
}

/**
 * 角色数据表名（本作形态 `Chara{no}_{名前}`，见 `constants.ts` 的 `charaCsvPattern`；
 * 名称段可含句点与全角字符）——**不是变量名表**，主表扫描时排除。
 * 角色表实际住在 `CSV/CHARA/`（108 份），根层正常不会撞到；这条是「魔改把角色表挪回根层」
 * 的兜底。表键已大写，故判据按大写比较。
 */
function isCharaDataTable(variableName: string): boolean {
  return /^CHARA\d+(?:[_　\s].*)?$/.test(variableName);
}

/**
 * 加载 eratohoReverse 变量字典：`CSV/` 根目录的全部 `*.csv` 名称表（真盘 28 张 / 1038 条）→
 * 市场字典包追加表 → 整棵 ERB 子树的 `.ERH` 作者自定名表（真盘 74 个声明名）。
 * 三轮，顺序即裁决序。
 */
export async function loadEratohoreverseVariableSchema(
  deps: EratohoreverseVariableSchemaDeps,
): Promise<VariableSchema> {
  const { io, csvDir, erbDir, log } = deps;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每份文件的「路径 + 正文」哈希（`foldDigest` 排序折叠） */
  const digestParts: string[] = [];

  const tableOf = (variableName: string): VariableTable => {
    let t = tables.get(variableName);
    if (!t) {
      t = emptyTable();
      tables.set(variableName, t);
    }
    return t;
  };

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`变量字典加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    entries = [];
  }

  // 按文件名精确取（`Global.csv` 与 `Globals.csv` 各建一表，不做前缀合并）；`.config` 因非 `.csv` 天然出局
  const primaryFiles: NameTableFile[] = entries
    .filter((e) => !e.isDirectory && /\.csv$/i.test(e.name))
    .map((e) => ({ variableName: tableNameOf(e.name), path: e.path }))
    .filter((f) => f.variableName.length > 0 && !isCharaDataTable(f.variableName))
    .sort((a, b) => comparePaths(a.path, b.path));

  let emptyNameTotal = 0;
  let overwrittenTotal = 0;

  /**
   * 一轮加载：**一次批量读** → 按序并入 → 记摘要。
   * `readTexts` 一次带回 N 份、失败位是 `null` ⇒ 单份读失败只 warn 跳过，其余照常。
   */
  const runPass = async (files: readonly NameTableFile[], source: NameTableSource): Promise<void> => {
    if (files.length === 0) return;
    const texts = await io.readTexts(files.map((f) => f.path));
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tf = texts[i];
      if (tf === null || tf === undefined) {
        log.warn(`变量表读取失败（跳过）：${f.path}`);
        continue;
      }
      const stats = mergeNameTable(tableOf(f.variableName), tf.text, {
        source,
        onOverwrite: (e) =>
          log.warn(
            `名称表编号重复（后者胜）：${f.path} 第 ${e.index} 号「${e.previous}」→「${e.next}」`,
          ),
      });
      emptyNameTotal += stats.skippedEmptyName;
      overwrittenTotal += stats.overwritten;
      digestParts.push(stableHash(`${f.path}\u0000${tf.text}`));
    }
  };

  await runPass(primaryFiles, 'primary');

  /**
   * 第二轮：市场字典包。目录与文件都先按路径排序（裁决与安装顺序无关）；
   * 本作 `.als` 实测全树 0 份，故只收 `.csv`（不为它留死分支）。
   */
  const marketDirs = [...(deps.marketAppendDirs ?? [])].sort(comparePaths);
  const marketFiles: NameTableFile[] = [];
  for (const dir of marketDirs) {
    let dirEntries: Awaited<ReturnType<FileIO['listDir']>>;
    try {
      dirEntries = await io.listDir(dir);
    } catch (err) {
      log.warn(`变量字典：市场字典包目录不可读（跳过）：${dir} — ${String(err)}`);
      continue;
    }
    for (const e of dirEntries) {
      if (e.isDirectory || !/\.csv$/i.test(e.name)) continue;
      const variableName = tableNameOf(e.name);
      if (variableName.length > 0 && !isCharaDataTable(variableName)) {
        marketFiles.push({ variableName, path: e.path });
      }
    }
  }
  marketFiles.sort((a, b) => comparePaths(a.path, b.path));
  const beforeMarket = [...tables.values()].reduce((n, t) => n + t.byIndex.size, 0);
  await runPass(marketFiles, 'append');
  if (marketFiles.length > 0) {
    const afterMarket = [...tables.values()].reduce((n, t) => n + t.byIndex.size, 0);
    log.info(
      `市场字典包追加名表：${marketDirs.length} 个目录 / ${marketFiles.length} 份，` +
        `新增 ${afterMarket - beforeMarket} 个编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 第三轮：作者自定名表（整棵 ERB 子树的 `.ERH` 声明）。
   * 必须递归整个 ERB 根：本作 17 份 `.ERH` 散在 `ERB/FUNCTION/**`（含 `ぱにめーしょん/`）、
   * `ERB/SYSTEM/**`、`ERB/TRAIN/**`、`ERB/口上/{NNNN}_{名}/**` 四处（16 份有声明，
   * `TRAINSYS/POSE.ERH` 的那条声明整行被 `;` 注释 ⇒ 0 条）。
   * 装载顺序按路径排序（引擎同样按路径装载）⇒ 同名首个定义优先可复现（本作实测 0 处重名）。
   */
  const erhNames = new Map<string, number | undefined>();
  let erhFileCount = 0;
  let erhSkippedDup = 0;
  {
    let erhPaths: string[] = [];
    try {
      const found = await io.walkDir(erbDir, {
        filter: (e) => e.isDirectory || isErbDeclarationPath(e.name),
      });
      erhPaths = found
        .filter((e) => !e.isDirectory && isErbDeclarationPath(e.name))
        .map((e) => e.path)
        .sort(comparePaths);
    } catch (err) {
      log.warn(`自定名表扫描失败（跳过，具名索引回落名称表）：${erbDir} — ${String(err)}`);
    }
    const erhTexts = erhPaths.length > 0 ? await io.readTexts(erhPaths) : [];
    for (let i = 0; i < erhPaths.length; i++) {
      const path = erhPaths[i]!;
      const tf = erhTexts[i];
      if (tf === null || tf === undefined) {
        log.warn(`自定名表读取失败（跳过）：${path}`);
        continue;
      }
      erhFileCount++;
      digestParts.push(stableHash(`${path}\u0000${tf.text}`));
      for (const [name, value] of parseErhDeclarations(tf.text)) {
        if (erhNames.has(name)) {
          erhSkippedDup++;
          continue;
        }
        erhNames.set(name, value);
      }
    }
    if (erhFileCount > 0) {
      const withValue = [...erhNames.values()].filter((v) => v !== undefined).length;
      log.info(
        `自定名表（*.ERH 声明）：${erhFileCount} 份，收录 ${erhNames.size} 个名字` +
          `（其中 ${withValue} 个带整数初值）` +
          (erhSkippedDup > 0 ? `；重名 ${erhSkippedDup} 处按首个定义优先跳过` : ''),
      );
    }
  }

  if (emptyNameTotal > 0 || overwrittenTotal > 0) {
    log.info(
      `名称表清洗：跳过空名称 ${emptyNameTotal} 行` +
        (overwrittenTotal > 0 ? `；编号重复后者胜 ${overwrittenTotal} 处（已逐条告警）` : ''),
    );
  }
  log.info(`变量字典：${tables.size} 张名称表（${[...tables.keys()].sort().join(', ')}）`);

  // 输入摘要：字典由游戏 CSV / `.ERH` 驱动，作者改一行描述就该让下游派生缓存失效。
  // 一份都没读到也是**确定值**（区别于 undefined = "没有判据"）。
  const inputDigest = foldDigest(digestParts);

  return {
    version: '1',
    inputDigest,
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const table = tables.get(key);
      if (!table) return undefined;
      if (index === undefined) {
        // 家族级：本作没有机读的「家族→中文」表 ⇒ 只给变量名（不猜显示名）
        return { name: key };
      }
      const idxStr = String(index);
      const byIdx = table.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        const info: VariableInfo = {
          name: key,
          index,
          description: byIdx,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        const n = Number(idxStr);
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      const namedIdx = table.byName.get(idxStr);
      if (namedIdx !== undefined) {
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          source: table.nameSource.get(idxStr) ?? 'primary',
        };
        const n = Number(namedIdx);
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      /**
       * 名称表查无 → 作者自定名表（`.ERH` 声明）兜底。
       * 引擎侧这条路不是「名称表」而是「索引位是一个表达式」：`CFLAG:{名}` 与 `CFLAG:{号}`
       * 同一槽位（与 eraFL / eratohoK 同口径）。常量不属于任何族，故只做名字 → 编号换算、
       * 不宣称族归属（`source: 'const'` 把这条意图交给消费方）。无整数初值的声明名字照样收录
       * （拼错名核对要看见它），但不给 `resolvedIndex`——本作真盘 74 个声明名**全部**没有
       * 整数初值，所以这一层今天一律只认名字（见头注普查）。
       */
      const erhKey = idxStr.toUpperCase();
      if (erhNames.has(erhKey)) {
        const value = erhNames.get(erhKey);
        const info: VariableInfo = {
          name: key,
          index,
          description: idxStr,
          source: 'const',
        };
        if (value !== undefined) info.resolvedIndex = value;
        return info;
      }
      return { name: key, index };
    },
    /** 枚举该族可写的索引名（契约 `VariableSchema.names`）。无该族 → 空数组。 */
    names(family: string): readonly VariableInfo[] {
      const table = tables.get(family.toUpperCase());
      if (!table) return [];
      const out: VariableInfo[] = [];
      for (const [idxStr, name] of table.byIndex) {
        const n = Number(idxStr);
        const info: VariableInfo = {
          name,
          index: Number.isNaN(n) ? idxStr : n,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        out.push(info);
      }
      return out;
    },
  };
}

export interface EratohoreverseInstructionNamesDeps {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径；指令名表固定是其中的 `constants.ts` 的 `instructionCsv`） */
  csvDir: string;
  log: Logger;
}

/**
 * 加载 eratohoReverse 的**指令名表**（`CSV/Train.csv`，真盘 67 行 / 33 条编号 / 33 个唯一名）
 * → 契约 `KojoInstructionTable`。
 *
 * 与字典共用同一个解析器 ⇒ `lookup('TRAIN', 0)` 与 `lookupByName('保持沉默')` 读到同一个名称。
 * 缺表 / 读失败 / 空表 ⇒ `hasTable: false`（消费方 fail-closed），并 warn。**绝不内置兜底词表**：
 * 本作这张表薄（33 条，且表头自述「反应(COM)名」），拿 eraTW 的 233 条补洞会把不属于本作的
 * 指令名送进补全候选 ⇒ 覆盖率低是**事实**，不是待修的缺陷。
 */
export async function loadEratohoreverseInstructionNames(
  deps: EratohoreverseInstructionNamesDeps,
): Promise<KojoInstructionTable> {
  const { io, csvDir, log } = deps;
  const absent: KojoInstructionTable = {
    hasTable: false,
    lookupByName: () => undefined,
    lookupByNo: () => undefined,
    names: () => [],
  };

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`指令名表加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    return absent;
  }
  // 文件名大小写不敏感：盘上是 `Train.csv`，魔改版可能写成 `TRAIN.CSV`；仍是**精确名**比较
  const instructionCsv = ERATOHOREVERSE.instructionCsv;
  const file = entries.find(
    (e) => !e.isDirectory && e.name.toUpperCase() === instructionCsv.toUpperCase(),
  );
  if (file === undefined) {
    log.warn(`指令名表缺失：${csvDir}/${instructionCsv}（「时机 指令 …」将 fail-closed）`);
    return absent;
  }
  let text: string;
  try {
    text = (await io.readText(file.path)).text;
  } catch (err) {
    log.warn(`指令名表读取失败：${file.path} — ${String(err)}`);
    return absent;
  }
  const { table, skippedEmptyName } = parseNameTableCsv(text);
  if (table.byIndex.size === 0) {
    log.warn(`指令名表为空（0 条编号行）：${file.path}`);
    return absent;
  }
  log.info(
    `指令名表：${table.byIndex.size} 条编号` +
      (skippedEmptyName > 0 ? `（跳过空名称 ${skippedEmptyName} 行）` : ''),
  );
  /**
   * 指令表用**同名取首条**（与 eratw / eraAkumaMaid / era紅魔館 / eratohoK 同一口径，也与引擎
   * CSV 加载顺序语义一致）。本作真盘 `Train.csv` 实测 33 条编号 0 处重名，但「层内后者胜」的
   * 字典裁决会把将来出现的重名记成后段编号——降糖时作者写 `时机 指令 保持沉默：` 期望的是
   * **基础段**，故指令表单独按 `byIndex` 的插入序重建首名表，不直接复用 `table.byName`。
   */
  const firstByName = new Map<string, number>();
  for (const [idx, name] of table.byIndex) {
    if (!firstByName.has(name)) firstByName.set(name, Number(idx));
  }
  return {
    hasTable: true,
    lookupByName: (name: string) => firstByName.get(name),
    lookupByNo: (no: number) => table.byIndex.get(String(no)),
    // 正向补全的唯一名字源：`firstByName` 的键（CSV 原序，同名多编号已取首条）
    names: () => [...firstByName.keys()],
  };
}
