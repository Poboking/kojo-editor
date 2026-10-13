/**
 * eraTW 变量字典（`VariableSchema`）——**由游戏数据文件驱动**（不硬编码索引表）。
 *
 * 数据来源（均取自当前打开的工程目录，随版本 / 汉化 / 魔改自动跟随）：
 * - 名称表：`CSV/{变量名}.csv`（`编号,名称[,注释]` 行格式）：
 *   `CFLAG.csv`（`2,好感度` / `4,信頼度` …）、`Talent.csv`（`3,恋慕` …）、`Abl.csv`…
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
 * - 同一编号/名称的首个定义优先（与引擎 CSV 加载顺序语义一致）。
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

/** 解析单个变量名表 CSV（纯函数；导出供测试） */
export function parseVariableCsv(text: string): VariableTable {
  const byIndex = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const rawLine of text.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue;
    const idx = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(idx)) continue;
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = (secondComma >= 0 ? rest.slice(0, secondComma) : rest).trim();
    if (name.length === 0) continue;
    if (!byIndex.has(idx)) byIndex.set(idx, name);
    if (!byName.has(name)) byName.set(name, idx);
  }
  return { byIndex, byName };
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

/**
 * 加载 eraTW 变量字典：扫描 `CSV/` 根目录的全部 `*.csv` 名称表
 * （文件名大写即变量名；子目录不进入——Chara 子目录是角色数据，不是变量表）。
 */
export async function loadEratwVariableSchema(opts: LoadVariableSchemaOptions): Promise<VariableSchema> {
  const { io, csvDir, chsMapPath, log } = opts;
  const tables = new Map<string, VariableTable>();
  /** 输入摘要素材：实际读到的每个 CSV 的「路径 + 正文」哈希（排序后折叠 ⇒ 与目录顺序无关） */
  const digestParts: string[] = [];

  let entries: Awaited<ReturnType<FileIO['listDir']>>;
  try {
    entries = await io.listDir(csvDir);
  } catch (err) {
    log.warn(`变量字典加载失败（CSV 目录不可读）：${csvDir} — ${String(err)}`);
    entries = [];
  }

  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!/\.csv$/i.test(e.name)) continue;
    const variableName = e.name.replace(/\.csv$/i, '').toUpperCase();
    if (variableName.length === 0) continue;
    try {
      const tf = await io.readText(e.path);
      tables.set(variableName, parseVariableCsv(tf.text));
      digestParts.push(stableHash(`${e.path}\u0000${tf.text}`));
    } catch (err) {
      log.warn(`变量表读取失败（跳过）：${e.path} — ${String(err)}`);
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
