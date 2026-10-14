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
 * 追加名表（`*.als`）的**合并口径 = 只并集、不覆盖**：
 * 先按目录扫全部 `.csv` 建表，再把 `.als` **逐个并入同一张表**，沿用同一条
 * "首个定义优先" ⇒ ①`byIndex` 里 CSV 已定义的编号**逐字不变**（`.als` 只补 CSV
 * 没有的编号）；②`byName` 只**新增**名称键（同名的既有编号不改）。
 * 为什么不能让 `.als` 覆盖 `.csv`：`byIndex` 是悬停描述与**降糖产物**
 * （`nameAt(族, 编号) → 名称`）的唯一来源，改一个编号的名称 = 改所有人已有产物的
 * 字面；而 `.als` 的价值全在"这个名字也合法"（`byName`），一条都不需要覆盖。
 * 游戏自带工具 `tool/Generate_ERH.py` 实测同一口径（先 CSV 后 ALS，
 * 撞名时打印"保留旧值"），本并不另立标准。
 *
 * 读取失败/缺表 → `lookup` 返回 undefined（通用层照常工作，只是没有标签；
 * 引擎侧「不静默」由调用方日志保证）。
 */

import { foldDigest, stableHash } from '@kojo/plugin-api';
import type { FileIO, Logger, VariableInfo, VariableSchema } from '@kojo/plugin-api';

interface VariableTable {
  byIndex: Map<string, string>;
  byName: Map<string, string>;
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
 */
export function mergeVariableTable(target: VariableTable, text: string): { addedIndex: number; addedName: number } {
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
    if (!target.byIndex.has(idx)) target.byIndex.set(idx, name);
    if (!target.byName.has(name)) target.byName.set(name, idx);
  }
  return { addedIndex: target.byIndex.size - beforeIndex, addedName: target.byName.size - beforeName };
}

/** 解析单个变量名表 CSV（纯函数；导出供测试）——等价于并入一张空表 */
export function parseVariableCsv(text: string): VariableTable {
  const table: VariableTable = { byIndex: new Map(), byName: new Map() };
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
  log: Logger;
}

/** 名称表文件：`{变量名}.csv` = 主表 / `{变量名}.als` = 追加名表 */
interface NameTableFile {
  variableName: string;
  path: string;
}

/**
 * 加载 eraTW 变量字典：扫描 `CSV/` 根目录的全部 `*.csv` 名称表**与** `*.als` 追加名表
 * （文件名去掉扩展名后大写即变量名；子目录不进入——Chara 子目录是角色数据，不是变量表）。
 *
 * 两轮顺序 = 裁决顺序：先把全部 `.csv` 建成主表，再把 `.als` 按同表键**并入**
 * （首个定义优先 ⇒ 主表的编号名称逐字不变，追加名表只贡献新名称 / 主表缺的编号）。
 */
export async function loadEratwVariableSchema(opts: LoadVariableSchemaOptions): Promise<VariableSchema> {
  const { io, csvDir, chsMapPath, log } = opts;
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
      t = { byIndex: new Map(), byName: new Map() };
      tables.set(variableName, t);
    }
    return t;
  };

  /** 一轮加载：读文件 → 并入表 → 记摘要。单文件读失败只 warn 跳过（不静默：日志可见） */
  const runPass = async (files: readonly NameTableFile[], isAppend: boolean): Promise<void> => {
    for (const f of files) {
      try {
        const tf = await io.readText(f.path);
        const merged = mergeVariableTable(tableOf(f.variableName), tf.text);
        digestParts.push(stableHash(`${f.path}\u0000${tf.text}`));
        if (isAppend) {
          appendedNames += merged.addedName;
          appendedIndexes += merged.addedIndex;
        }
      } catch (err) {
        log.warn(`变量表读取失败（跳过）：${f.path} — ${String(err)}`);
      }
    }
  };

  await runPass(primaryFiles, false);
  await runPass(appendFiles, true);
  if (appendFiles.length > 0) {
    log.info(
      `追加名表（*.als）：${appendFiles.length} 份，并入 ${appendedNames} 个新名称 / ${appendedIndexes} 个新编号（主表已有的编号名称不改写）`,
    );
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
        const info: VariableInfo = { name: key, index, description: jpToCn.get(byIdx) ?? byIdx };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      if (table.byName.has(idxStr)) {
        // 具名索引（如 TALENT:恋慕）→ 名称本身即描述（经汉化词典得中文）；resolvedIndex = 字典编号
        const info: VariableInfo = { name: key, index, description: jpToCn.get(idxStr) ?? idxStr };
        const n = Number(table.byName.get(idxStr));
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      return { name: key, index };
    },
  };
}
