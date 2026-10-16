/**
 * eraTW 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 数据来源（均取自当前打开的工程目录，随版本 / 汉化 / 魔改自动跟随）：
 * - 名称表（主表）：`CSV/{变量名}.csv`（`编号,名称[,注释]` 行格式）：
 *   `CFLAG.csv`（`2,好感度` / `4,信頼度` …）、`Talent.csv`（`3,恋慕` …）、`Abl.csv`…
 * - **追加名表**：`CSV/{变量名}.als`（与 `.csv` **同一套行格式**，见下"追加名表"一节）：
 *   汉化 / 魔改版在同名 `.als` 里给同一编号补**别名**（`TCVAR.als:145 = 泥酔`，而
 *   `TCVAR.csv:145 = 烂醉`；`ex.als:1 = Ｖ绝顶`，而 `ex.csv:1 = Ｖ絶頂`）。作者写口上时
 *   抄的是游戏界面显示的 `.als` 名 ⇒ 不读 `.als`，这些具名索引在字典里天然查无。
 * - **市场字典包追加名表**（KM-15，第三轮）：已装字典包（`kind === 'dict-pack'`）的
 *   `files/` 目录（`LoadVariableSchemaOptions.marketAppendDirs`）——里面**一律按追加名表**
 *   并入（主表仍只认游戏 CSV 目录，见下"市场字典包"一节）。
 * - **作者自定名表**（FT-1）：整棵 ERB 子树内 `*.ERH` 的具名常量声明（`#DIM CONST NAME = 1101` /
 *   `#DEFINE NAME 0`）——口上作者自定义的符号名不住在 CSV 里，只住在 `.ERH`；引擎把它们
 *   当**全局变量**装（`IdentifierDictionary.cs:436-444`，键只有名字），`族头:NAME` 走的是
 *   "索引位是表达式"的求值路 ⇒ 收进字典 = 复刻引擎的可见性（详见下方"作者自定名表"注释）。
 * - 汉化词典：`plugins/tw_csv_chs.xml`（游戏自带 JP→CN 名词典，形如
 *   `<p><k>日文</k><v>中文</v></p>`；引擎 `SYSTEM.ERB` 经 `MAP_FROMXML` 装为
 *   `CSV_MAP`，游戏 UI 的名称汉化就靠它）——**叠加在名称表之上**：索引级名称
 *   `信頼度` → `信赖度`；词典查不到则回落名称表原文（**绝不猜**）。
 *
 * 家族级名称（`lookup('CFLAG')` 无索引）：游戏目录**没有**机读的「家族→中文」表，
 * 故取适配器内置策展常量 `FAMILY_LABELS`（取值口径见其注释）。
 *
 * 解析策略（宽容）：
 * - 跳过 `;` 开头注释行与空行；行首非数字的不收录；
 * - 第三个字段（注释）不进入名称；名称取第二个字段原文（日文/中文均可）；
 * - 同时建立**名称 → 编号**反向表（`lookup('TALENT', '恋慕')` 双向可用）；
 * - 同一编号/名称的**首个定义优先**（与引擎 CSV 加载顺序语义一致）。
 *
 * 追加名表（`*.als`）与**市场字典包**（KM-15，第三轮）的**合并口径 = 只并集、不覆盖**：
 * 先按目录扫全部 `.csv` 建表，再把 `.als` 与市场名表**逐个并入同一张表**，沿用同一条
 * "首个定义优先" ⇒ ①`byIndex` 里 CSV 已定义的编号**逐字不变**（追加层只补 CSV
 * 没有的编号）；②`byName` 只**新增**名称键（同名的既有编号不改）。
 * 为什么不能让 `.als` 覆盖 `.csv`：`byIndex` 是悬停描述与**降糖产物**
 * （`nameAt(族, 编号) → 名称`）的唯一来源，改一个编号的名称 = 改所有人已有产物的
 * 字面；而 `.als` 的价值全在"这个名字也合法"（`byName`），一条都不需要覆盖。
 * 游戏自带工具 `tool/Generate_ERH.py` 实测同一口径（先 CSV 后 ALS，
 * 撞名时打印"保留旧值"），本并不另立标准。
 *
 * **来源层（ALS-R1）**：三层数据源在条目上如实标注（契约字段 `VariableInfo.source`）——
 * `.csv` → `'primary'`、`.als`（与市场字典包名表，KM-15）→ `'append'`、
 * `.ERH` 具名常量 → `'const'`，
 * 按"键第一次落地"的那一轮记源（与"首个定义优先"同一裁决）。本包只**标源**、
 * 不裁决归属：族归属如何分层由消费方（`kojo-sugar` 的 `resolveFamily`）决定，
 * 收录判定（拼错名核对）仍三层都算。
 *
 * 读取失败/缺表 → `lookup` 返回 undefined（通用层照常工作，只是没有标签；
 * 引擎侧「不静默」由调用方日志保证）。
 */

import { foldDigest, isErbDeclarationPath, stableHash } from '@kojo/plugin-api';
import type { FileIO, Logger, VariableInfo, VariableSchema, VariableSource } from '@kojo/plugin-api';

import { BITS_BY_FAMILY_INDEX } from './bit-tables';

/** 名称表键的来源层：`.csv` = 主表 / `.als` = 追加名表（`.ERH` 常量走另一条路，见 `lookup`） */
type NameTableSource = Extract<VariableSource, 'primary' | 'append'>;

interface VariableTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
  /**
   * 键 → 来源层（**与 `byIndex`/`byName` 同一裁决：首个定义优先**，键新增时才记源）。
   * 存在的理由：族归属（`resolveFamily`）只许认主表 → 追加表这两层，而合并后的
   * 两张 Map 本身分不出"这个名字是哪一轮进来的"（ALS-R1）。
   */
  indexSource: Map<string, NameTableSource>;
  nameSource: Map<string, NameTableSource>;
}

/**
 * 把一个名称表文件**并入**累积表（纯函数；导出供测试）。
 *
 * 行格式（`.csv` 与 `.als` **实测同一套**，见 `variable-schema.test.ts` 的差异清单）：
 * `编号,名称[,注释]`；`;` 开头（含 tab 缩进的续行注释）与空行跳过；行首非数字不收录；
 * 名称取第二个字段原文，第三个字段不进名称。
 *
 * **裁决 = 首个定义优先**：已存在的 `编号` / `名称` 键一律不覆盖，只回计新增数。
 * 加载方按「先 `.csv` 后 `.als`」的顺序调用本函数 ⇒ 追加名表天然只补不盖。
 *
 * `source`（ALS-R1，additive）= 本轮往表里加的**是哪一层**，缺省 `'primary'`（主表）。
 * 只有"键第一次落地"那一轮的名称才记为该层 ⇒ 主表已有的编号/名称，`.als` 再写一遍
 * 也不改其来源（正是"只并集不覆盖"的另一面）。
 */
export function mergeVariableTable(
  target: VariableTable,
  text: string,
  source: NameTableSource = 'primary',
): { addedIndex: number; addedName: number } {
  const beforeIndex = target.byIndex.size;
  const beforeName = target.byName.size;
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const line = rawLine.trim(); // `trim()` 顺带吃掉 UTF-8 BOM（U+FEFF 属 ES 空白集）
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const idx = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(idx)) continue;
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = (secondComma >= 0 ? rest.slice(0, secondComma) : rest).trim();
    if (name.length === 0) continue;
    if (!target.byIndex.has(idx)) {
      target.byIndex.set(idx, name);
      target.indexSource.set(idx, source);
    }
    if (!target.byName.has(name)) {
      target.byName.set(name, idx);
      target.nameSource.set(name, source);
    }
  }
  return { addedIndex: target.byIndex.size - beforeIndex, addedName: target.byName.size - beforeName };
}

/** 解析单个变量名表 CSV（纯函数；导出供测试）——等价于并入一张空表 */
export function parseVariableCsv(text: string): VariableTable {
  const table: VariableTable = {
    byIndex: new Map(),
    byName: new Map(),
    indexSource: new Map(),
    nameSource: new Map(),
  };
  mergeVariableTable(table, text);
  return table;
}

/**
 * 家族级（数组行，如 `CFLAG` / `EXP`）中文标签 —— **策展常量，不是游戏提供的表**。
 *
 * 为什么内置：游戏目录**没有**机读的「变量家族 → 中文名」表 —— 已实证
 * `plugins/tw_csv_chs.xml`（JP→CN 词典）只覆盖**索引级**名称，不含家族键
 * （フラグ / 能力 / 素質 / 経験 …）；`CSV/{变量}.csv` 的表头 `;` 行是**分组标题**
 * 而非家族名（`Talent.csv` 首行 `;性別系列`、`EXP.csv` 首行 `;快感経験`，逐族不可依赖）。
 * 故家族名只能在适配器内置（游戏知识归 adapter，架构铁律 3）。
 *
 * 取值口径：优先采纳游戏内既有显示证据 —— CFLAG→フラグ / ABL→能力 / TALENT→素質
 * （`ERB/CHARALIST_DT/TEMP_CHARA_LIST_BY_DT.ERB` 的 `C_FILTERTARGET_NAME`）、
 * EXP→快感経験（`EXP.csv` 表头）；其余取 emuera 通用族名。改动本表 = 改产品的显示口径。
 */
const FAMILY_LABELS: Record<string, string> = {
  BASE: '基础值',
  MAXBASE: '基础上限',
  ABL: '能力',
  TALENT: '素质',
  EXP: '快感经验',
  MARK: '刻印',
  CFLAG: '角色标志',
  FLAG: '全局标志',
  TFLAG: '临时标志',
  CSTR: '角色字符串',
  STR: '字符串',
  PALAM: '参数',
  SOURCE: '欲求',
  STAIN: '污渍',
  JUEL: '宝珠',
  ITEM: '道具',
  TEQUIP: '装备',
  EQUIP: '装备',
  TCVAR: '临时角色变量',
  TIME: '时间',
  DAY: '日期',
  TRAIN: '技能',
};

/**
 * 家族头的**作者可写中文别名** —— 与 `FAMILY_LABELS`（家族**显示名**）**不同轴**的独立策展常量。
 *
 * - `FAMILY_LABELS`：家族 → 人类可读**显示名**（悬停描述 / 家族级 `lookup` 的 `description`），
 *   面向"看"（如 `FLAG:'全局标志'`）；
 * - `FAMILY_ALIASES`：表层中文**输入别名** → 引擎变量族头，面向"写"——作者在表达式 / 段条件里
 *   写 `现在:噴乳` 等价于原生 `NOWEX:噴乳`（语法糖 §表达式一节的族头中文化，D2 批）。
 *
 * **两者不许混用、不许覆盖**：显示名（`全局标志`）不是别名（`标记`），别名（`标记`）也不是
 * 显示名；把一张表当另一张用必然产出"作者写不出 / 读者看不懂"的错位。表小、策展、纯数据，
 * 与 `FAMILY_LABELS` 同属"游戏目录无机读表 ⇒ 适配器内置"（架构铁律 3）。未登记 ⇒ 不猜。
 *
 * 注：`随机` 同时是**随机块的块关键字**（糖的语言层），本表只声明"它在**表达式位**的族头
 * 别名 = `RAND`"；块头位由词法器先判（`lexer.classifyLine`），两义不冲突（消歧见 D2 批测试）。
 *
 * **表必须是"无原型"对象**（`Object.create(null)`）：查表键来自**作者字节**，普通对象字面量
 * 会让 `constructor:` / `hasOwnProperty:` 这类未登记输入命中 `Object.prototype` 成员（函数），
 * 静默替换成函数源码 —— 正是"未登记 ⇒ 不猜"要根除的 fail-open。
 */
const aliasTable = (entries: Record<string, string>): Readonly<Record<string, string>> =>
  Object.assign(Object.create(null) as Record<string, string>, entries);

export const FAMILY_ALIASES: Readonly<Record<string, string>> = aliasTable({
  现在: 'NOWEX',
  时标: 'TFLAG',
  标记: 'FLAG',
  随机: 'RAND',
});

/** `FAMILY_ALIASES` 的反向表（族头 → 中文别名；键统一大写 ⇒ 引擎大小写不敏感） */
export const FAMILY_ALIASES_REVERSE: Readonly<Record<string, string>> = aliasTable(
  Object.fromEntries(
    Object.entries(FAMILY_ALIASES).map(([alias, family]) => [family.toUpperCase(), alias]),
  ),
);

/**
 * 解析游戏自带 JP→CN 名词典（`plugins/tw_csv_chs.xml`）→ `Map<日文名, 中文名>`（纯函数）。
 *
 * 文件形态：`<map>` 下大量 `<p><k>日文</k><v>中文</v></p>`（引擎 `MAP_FROMXML` 消费）。
 * - 只认完整的 `<p>` 段；`<k>` 为空跳过；**同名取首条**（与引擎 MAP 装载顺序一致）；
 * - 容忍 UTF-8 BOM；解析不到任何条目 → 空 Map（调用方回落原文，绝不猜）。
 */
export function parseChsMap(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const re = /<p>\s*<k>([\s\S]*?)<\/k>\s*<v>([\s\S]*?)<\/v>\s*<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const k = m[1] ?? '';
    const v = m[2] ?? '';
    if (k.length === 0) continue;
    if (!map.has(k)) map.set(k, v);
  }
  return map;
}

export interface LoadVariableSchemaOptions {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径） */
  csvDir: string;
  /** 变量名汉化词典路径（绝对路径；缺省 = 无词典，名称一律原文） */
  chsMapPath?: string;
  /**
   * ERB 根目录（绝对路径；FT-1）。**缺省 = 完全不读 `.ERH`** ⇒ 不传本参数的调用方
   * （含既有 `*.als` 语料自证）字典与摘要逐字不变。
   */
  erbDir?: string;
  /**
   * 市场字典包（`kind === 'dict-pack'`）的 contentDir 列表（KM-15；additive）。
   *
   * 轮序：游戏主表（`csvDir/*.csv`）→ 游戏追加名表（`csvDir/*.als`）→ 本列表
   * （目录间与文件间**按路径排序**：先定义优先的裁决不许随枚举顺序漂）。
   * 每个目录里的名表文件（仍只收 `.csv` / `.als` 两种，变量名 = 去扩展名大写）
   * **一律以 `source: 'append'` 并入**——市场包没有"主表"语义：改一个主表编号的
   * 名称 = 改所有人已有产物的字面（`byIndex` 是悬停描述与降糖产物的唯一来源）。
   * 缺省 / 空数组 = 不读市场，与历史行为逐字一致（零新增输出）。
   */
  marketAppendDirs?: readonly string[];
  log: Logger;
}

/** 名称表文件：`{变量名}.csv` = 主表 / `{变量名}.als` = 追加名表（市场字典包同轮收两种） */
interface NameTableFile {
  variableName: string;
  path: string;
}

/** 字符串路径序（确定性：目录与文件两级的"先定义优先"裁决都不许随枚举顺序漂） */
const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `.ERH` 声明行的前置关键字（Emuera `UserDefinedVariableData.Create` 认的关键词集） */
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

/** 整数字面量（十进制 / `0x` 十六进制）→ 编号；其它形态（表达式、数组、字符串）一律不认 */
function integerLiteral(text: string): number | undefined {
  const s = text.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined;
  const n = /^0[xX]/.test(s) ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * 解析 `.ERH` 声明行 → **作者自定名表** `Map<大写名称, 整数编号>`（纯函数；导出供测试）。
 *
 * 收的是**"名字 = 一个整数"**这一类声明——引擎侧它们与 CSV 名称表无关，是**全局具名常量**，
 * `族头:名字` 走的是"索引位是一个表达式"这条普通求值路（`VariableEvaluator.cs:215` 只对
 * **字面串**索引走 CSV 名称表；标识符索引直接求值）。实测盘上形态（画蛇添足版整棵 ERB 子树
 * 153 份 `.ERH` / 7,223 条声明行，本表收 5,755 个名字；魔王版 169 份 / 6,407 名，原生官方
 * 4.842 是 37 份 / 1,094 名）：
 * - `#DIM CONST NAME = 1101`（本表主体；含 `0x` 十六进制 88 条）
 * - `#DEFINE NAME 0`（纯整数 2 条；其余 `#DEFINE` 是 `"字符串"` / `TIME:2` / 名字别名 → 不收）
 * - `#DIM NAME, 10`（声明的是"新变量族"，不是"名字=编号"）
 * - `#DIM NAME = 351`（66 条，**无 `CONST` ⇒ 可写变量**，运行期可被改写 ⇒ 收了就是猜）
 * - `#DIM CONST NAME = 0, 100, 500`（数组，无唯一编号）
 *   / `#DIM CONST NAME = 0x44 + COLOR_FROMNAME(…)`（表达式，不在字典里求值）——**一个都不收**。
 * 行尾 `;` 注释实测常见（`#DIM CONST LIST_MAX_SORT = 1 ;コメント`），先截后解析。
 *
 * 键按**大写**存（`emuera.config:1 IGNORE CASE:YES` ⇒ 引擎标识符本就大小写不敏感），
 * 同名**首个定义优先**（与名称表同一裁决口径；实测三张盘 **0 组"同名不同值"**，故顺序不影响结果）。
 */
export function parseErhConsts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (name: string, value: number): void => {
    const key = name.toUpperCase();
    if (key.length === 0 || out.has(key)) return;
    out.set(key, value);
  };
  for (const rawLine of text.split(/\r\n?|\n/)) {
    // `trim()` 顺带吃掉 UTF-8 BOM；`;` 起行 = 整行注释，行中 `;` = 行尾注释 ⇒ 一律先截断
    const head = rawLine.trim();
    if (!head.startsWith('#')) continue;
    const semi = head.indexOf(';');
    const line = (semi >= 0 ? head.slice(0, semi) : head).trim();
    const m = /^#(DIMS|DIMF|DIM|DEFINE)([\s\S]*)$/i.exec(line);
    if (!m) continue;
    let rest = (m[2] ?? '').trim();
    const keywords = new Set<string>();
    if (m[1]!.toUpperCase() !== 'DEFINE') {
      for (;;) {
        const km = /^([A-Za-z_][A-Za-z0-9_]*)[\s\S]*$/.exec(rest);
        if (km === null) break;
        const kw = (km[1] ?? '').toUpperCase();
        if (!ERH_DECL_KEYWORDS.has(kw)) break;
        keywords.add(kw);
        rest = (km[0] ?? '').slice(km[1]!.length).trim();
      }
      if (!keywords.has('CONST')) continue; // 普通 `#DIM NAME, 10` 是"新变量族"，不是"名字=编号"
      const eq = rest.indexOf('=');
      if (eq <= 0) continue;
      const name = (rest.slice(0, eq) ?? '').trim();
      const value = integerLiteral(rest.slice(eq + 1) ?? '');
      if (value === undefined) continue;
      put(name, value);
      continue;
    }
    const space = rest.search(/[\s(]/);
    const name = (space < 0 ? rest : rest.slice(0, space)).trim();
    const value = integerLiteral(space < 0 ? '' : rest.slice(space));
    if (value === undefined) continue;
    put(name, value);
  }
  return out;
}

/**
 * 位表挂接（KC-1b）：把策展位表（`bit-tables.ts`）按 `(族:号)` 挂到 `lookup()` 的返回值上。
 *
 * - 只在**能确定编号**时挂（`resolvedIndex` 有值）；家族级查询（无索引）不挂。
 * - 策展表里没有该 `(族:号)` ⇒ **不加字段**（不猜、不伪造空位表）。
 * - 位表是冻结只读常量，同族同号多次查询共享同一份数组（零拷贝、零状态）。
 */
function withBits(info: VariableInfo): VariableInfo {
  if (info.resolvedIndex === undefined) return info;
  const bits = BITS_BY_FAMILY_INDEX.get(`${info.name}:${info.resolvedIndex}`);
  if (bits !== undefined) info.bits = bits;
  return info;
}

/**
 * 加载 eraTW 变量字典：扫描 `CSV/` 根目录的全部 `*.csv` 名称表**与** `*.als` 追加名表
 * （文件名去掉扩展名后大写即变量名；子目录不进入——Chara 子目录是角色数据，不是变量表），
 * 再把市场字典包目录（`marketAppendDirs`，KM-15）里的名表**同轮并入**。
 *
 * 三轮顺序 = 裁决顺序：先把全部 `.csv` 建成主表，再把游戏 `.als` 并入，
 * 最后并市场字典包名表（目录间与文件间按路径排序）——同一条"首个定义优先"
 * ⇒ 主表的编号名称逐字不变，追加层只贡献新名称 / 主表缺的编号。
 */
export async function loadEratwVariableSchema(opts: LoadVariableSchemaOptions): Promise<VariableSchema> {
  const { io, csvDir, chsMapPath, erbDir, log } = opts;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每个名称表文件的「路径 + 正文」哈希（排序后折叠 ⇒ 与目录顺序无关） */
  const digestParts: string[] = [];

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`变量字典加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    entries = [];
  }

  /** 主表与追加名表**分桶收集** ⇒ 加载顺序恒为"先全部主表，再全部追加表"（与目录枚举顺序无关） */
  const primaryFiles: NameTableFile[] = [];
  const appendFiles: NameTableFile[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (/\.csv$/i.test(e.name)) {
      const variableName = e.name.replace(/\.csv$/i, '').toUpperCase();
      if (variableName.length > 0) primaryFiles.push({ variableName, path: e.path });
    } else if (/\.als$/i.test(e.name)) {
      const variableName = e.name.replace(/\.als$/i, '').toUpperCase();
      if (variableName.length > 0) appendFiles.push({ variableName, path: e.path });
    }
  }

  let appendedNames = 0;
  let appendedIndexes = 0;
  const tableOf = (variableName: string): VariableTable => {
    let t = tables.get(variableName);
    if (!t) {
      t = { byIndex: new Map(), byName: new Map(), indexSource: new Map(), nameSource: new Map() };
      tables.set(variableName, t);
    }
    return t;
  };

  /**
   * 一轮加载：**一次批量读** → 按序并入表 → 记摘要。
   *
   * 2026-10-16 桥分叉批把这里的逐文件 `await io.readText()` 换掉：串行 await-in-loop 下
   * 每份文件 = 两趟 IPC 往返，52 份名称表就烧掉 715ms（真语料实测）。
   * `readTexts` 一次 `read_files_raw` 批带回 N 份，失败位是 `null`（契约：不整批抛），
   * 与旧的"单文件读失败只 warn 跳过"同一可见口径——**不静默**。
   * 并入顺序 = 入参顺序 ⇒「首个定义优先」的裁决与摘要顺序逐字不变。
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
      const merged = mergeVariableTable(tableOf(f.variableName), tf.text, source);
      digestParts.push(stableHash(`${f.path}\u0000${tf.text}`));
      if (source === 'append') {
        appendedNames += merged.addedName;
        appendedIndexes += merged.addedIndex;
      }
    }
  };

  await runPass(primaryFiles, 'primary');
  await runPass(appendFiles, 'append');
  if (appendFiles.length > 0) {
    log.info(
      `追加名表（*.als）：${appendFiles.length} 份，并入 ${appendedNames} 个新名称 / ${appendedIndexes} 个新编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 第三轮：市场字典包（KM-15）。目录与文件**都先按路径排序**再并入（`runPass` 逐文件
   * 读并入 `digestParts` ⇒ 字典换了指纹就变），故"先定义优先"的裁决与市场安装顺序 /
   * 目录枚举顺序无关。全部按 `'append'` 记源：主表仍只认游戏 CSV 目录。
   * 目录不可读 / 文件读失败一律 warn 跳过（不静默），其余输入照常。
   */
  const marketAppendNamesStart = appendedNames;
  const marketAppendIndexesStart = appendedIndexes;
  const marketDirs = [...(opts.marketAppendDirs ?? [])].sort(comparePaths);
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
      if (e.isDirectory) continue;
      const m = /\.(csv|als)$/i.exec(e.name);
      if (m === null) continue;
      const variableName = e.name.slice(0, e.name.length - m[0].length).toUpperCase();
      if (variableName.length > 0) marketFiles.push({ variableName, path: e.path });
    }
  }
  marketFiles.sort((a, b) => comparePaths(a.path, b.path));
  await runPass(marketFiles, 'append');
  if (marketFiles.length > 0) {
    log.info(
      `市场字典包追加名表：${marketDirs.length} 个目录 / ${marketFiles.length} 份，并入 ` +
        `${appendedNames - marketAppendNamesStart} 个新名称 / ${appendedIndexes - marketAppendIndexesStart} 个新编号（主表已有的编号名称不改写）`,
    );
  }

  /**
   * 作者自定名表（整棵 ERB 子树内的 `*.ERH` 具名常量声明，FT-1）——**全局一张，不按角色分桶**。
   *
   * 取证结论（Emuera 源码克隆，分支 develop-skiasharp）：
   * `.ERH` 由 `Process.cs:221` 一次性从**整个 ERB 根**装载（递归与否取
   * `Config.SearchSubdirectory`，eraTW `emuera.config:39 SEARCH SUBFOLDERS:YES` ⇒ 全树），
   * 每行的 `#DIM` 进**同一条**队列（`ErhLoader.cs:126`，isPrivate 恒为 false），
   * 全部文件读完才统一处理（`ErhLoader.cs:284-370`），最终落进
   * `IdentifierDictionary.cs:436-444` 的 `varTokenDic`/`nameDic`——**键只有名字，
   * 没有文件/角色维度**。⇒ 引擎侧"声明即全局可见"，跨角色引用是合法的既有写法
   * （画蛇添足版收 5,755 个名字、**0 组同名不同值**；引擎用 `Dictionary.Add`，重名直接报错），
   * 故本表按全局收录不会引入引擎不认的误判；`#DIM LOCAL`（函数体内）不属 `.ERH` 装载路，
   * 本表天然不涉及。
   */
  const erhConsts = new Map<string, number>();
  if (erbDir !== undefined) {
    /** 实际要读的 `.ERH` 路径（排序后 = 摘要与"首个定义优先"的裁决序） */
    let erhPaths: string[] = [];
    try {
      // `filter` 由内核兑现且**只筛输出条目、不剪枝**（见 `WalkOptions`；2026-10-16 桥分叉批）⇒
      // 目录侧无需放行以外的技巧，但**本层不信任回来的都是 `.ERH`**：读盘前自己再按扩展名筛一遍
      // （读集合的规模是本函数的性能与安全边界，不能委托给一具可能跨进程的桥）。
      // 判扩展名一律问契约层单一真源（FT-2 收口），本包不再抄第二份 `.erh` 字面量。
      const found = await io.walkDir(erbDir, {
        filter: (e) => e.isDirectory || isErbDeclarationPath(e.name),
      });
      // 确定性顺序：首个定义优先的裁决不该随目录枚举顺序漂移（引擎按路径排序装载）
      erhPaths = found
        .filter((e) => !e.isDirectory && isErbDeclarationPath(e.name))
        .map((e) => e.path)
        .sort(comparePaths);
    } catch (err) {
      log.warn(`自定名表扫描失败（跳过，具名索引回落名称表）：${erbDir} — ${String(err)}`);
    }
    // 一次批量读替掉逐份 `await readText`：真语料上这里是 24.4 秒（4,519 份串行 IPC 往返）
    const erhTexts = erhPaths.length > 0 ? await io.readTexts(erhPaths) : [];
    let skippedDup = 0;
    for (let i = 0; i < erhPaths.length; i++) {
      const path = erhPaths[i]!;
      const tf = erhTexts[i];
      if (tf === null || tf === undefined) {
        log.warn(`自定名表读取失败（跳过）：${path}`);
        continue;
      }
      digestParts.push(stableHash(`${path}\u0000${tf.text}`));
      for (const [name, value] of parseErhConsts(tf.text)) {
        if (erhConsts.has(name)) {
          skippedDup++;
          continue;
        }
        erhConsts.set(name, value);
      }
    }
    if (erhPaths.length > 0) {
      log.info(
        `自定名表（*.ERH 具名常量）：${erhPaths.length} 份，收录 ${erhConsts.size} 个名字` +
          (skippedDup > 0 ? `（重名 ${skippedDup} 处按首个定义优先跳过）` : ''),
      );
    }
  }

  // 汉化词典（JP→CN）：叠加在名称表之上。缺表 / 读失败 = 空词典（名称回落原文），**不抛**。
  const jpToCn = new Map<string, string>();
  if (chsMapPath !== undefined) {
    try {
      const tf = await io.readText(chsMapPath);
      for (const [k, v] of parseChsMap(tf.text)) jpToCn.set(k, v);
      digestParts.push(stableHash(`${chsMapPath}\u0000${tf.text}`));
      log.info(`变量名汉化词典：${jpToCn.size} 条（${chsMapPath}）`);
    } catch (err) {
      log.warn(`变量名汉化词典读取失败（跳过，名称回落原文）：${chsMapPath} — ${String(err)}`);
    }
  }

  log.info(`变量字典：${tables.size} 张名称表（${[...tables.keys()].join(', ')}）`);

  // 输入摘要：字典由游戏 CSV 驱动，玩家改一行描述就该让下游派生缓存失效。
  // 一张都没读到也是**确定值**（区别于 undefined = "没有判据"）。
  const inputDigest = foldDigest(digestParts);

  return {
    version: '1',
    inputDigest,
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const table = tables.get(key);
      if (!table) return undefined;
      if (index === undefined) {
        // 家族级：游戏无机读的家族名表 → 取适配器内置策展常量（无则只给变量名）
        const label = FAMILY_LABELS[key];
        return label !== undefined ? { name: key, description: label } : { name: key };
      }
      const idxStr = String(index);
      const byIdx = table.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        // 编号索引（如 CFLAG:2）→ 名称为描述（经汉化词典得中文）；resolvedIndex = 自身
        const n = Number(idxStr);
        const info: VariableInfo = {
          name: key,
          index,
          description: jpToCn.get(byIdx) ?? byIdx,
          source: table.indexSource.get(idxStr) ?? 'primary',
        };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return withBits(info);
      }
      if (table.byName.has(idxStr)) {
        // 具名索引（如 TALENT:恋慕）→ 名称本身即描述（经汉化词典得中文）；resolvedIndex = 字典编号
        const info: VariableInfo = {
          name: key,
          index,
          description: jpToCn.get(idxStr) ?? idxStr,
          // 来源层如实上报（ALS-R1）：`.als` 给的别名 = `'append'`，主表给的 = `'primary'`。
          // 消费方（族归属）据此区分"主表的归属"与"追加表抢走的归属"；收录判定不受影响。
          source: table.nameSource.get(idxStr) ?? 'primary',
        };
        const n = Number(table.byName.get(idxStr));
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return withBits(info);
      }
      /**
       * 名称表查无 → 作者自定名表（`.ERH` 具名常量）兜底。引擎侧这条路不是"名称表"，
       * 而是"索引位是一个表达式"（`VariableEvaluator.cs:215` 只把**字面串**索引交给 CSV
       * 名称表；标识符索引按变量求值）⇒ `CFLAG:K15C_X` 与 `CFLAG:1101` 是同一个槽位。
       * 常量**不属于任何族**（同一个名字可以写在任意族后面），故此处只做"名字→编号"的
       * 换算，不宣称族归属；描述取作者原文，**不喂汉化词典**（词典键是游戏显示词，
       * 命中即误译）。名称表在前、本表在后 ⇒ 既有（含 `*.als`）读数一条都不受影响。
       * `source: 'const'`（ALS-R1）把"不宣称族归属"这条意图**交给消费方**：
       * 收录判定（拼错名核对）三层都算，族归属只认 `'primary'` → `'append'` 两层。
       */
      const constIndex = erhConsts.get(idxStr.toUpperCase());
      if (constIndex !== undefined)
        return withBits({
          name: key,
          index,
          description: idxStr,
          resolvedIndex: constIndex,
          source: 'const',
        });
      return { name: key, index };
    },
    /**
     * 枚举该族可写的索引名（KC-1；契约 `VariableSchema.names` 的 eraTW 实现）。
     *
     * 由 `byIndex`（编号 → 名，天生可枚举）直接产出：每个条目的 `name` = **索引名**
     * （作者可写的名字），`index`/`resolvedIndex` = 其编号，`source` = 该编号的来源层
     * （`.csv` 主表 / `.als` 追加名表）。无该族 → 空数组。**不改动 `lookup` 既有行为**。
     */
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
    /**
     * 家族头中文别名（D2；契约 `VariableSchema.familyAlias` 的 eraTW 实现）。
     * 表层输入别名 → 引擎族头（`现在` → `NOWEX`）；**未登记 ⇒ `undefined`（不猜）**。
     */
    familyAlias(name: string): string | undefined {
      return FAMILY_ALIASES[name];
    },
    /**
     * 家族头中文别名的反向（D2；契约 `VariableSchema.familyAliasReverse`）。
     * 引擎族头 → 表层中文别名（`NOWEX` → `现在`）；**未登记 ⇒ `undefined`（不猜）**。
     * 引擎标识符大小写不敏感 ⇒ 键统一大写后查。
     */
    familyAliasReverse(family: string): string | undefined {
      return FAMILY_ALIASES_REVERSE[family.toUpperCase()];
    },
  };
}
