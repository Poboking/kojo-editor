/**
 * eraTW 变量字典（`VariableSchema`）——**由游戏 CSV 驱动**（不硬编码索引表）。
 *
 * 数据来源：游戏 `CSV/` 目录下的 `{变量名}.csv` 名称表（`编号,名称[,注释]` 行格式）：
 * - `CFLAG.csv`（`2,好感度` / `4,信頼度` …）
 * - `Talent.csv`（`3,恋慕` …）、`Abl.csv`、`Base.csv`、`TFLAG.csv`、`FLAG.csv` …
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

export interface LoadVariableSchemaOptions {
  io: FileIO;
  /** 游戏 CSV 根目录（绝对路径） */
  csvDir: string;
  log: Logger;
}

/**
 * 加载 eraTW 变量字典：扫描 `CSV/` 根目录的全部 `*.csv` 名称表
 * （文件名大写即变量名；子目录不进入——Chara 子目录是角色数据，不是变量表）。
 */
export async function loadEratwVariableSchema(opts: LoadVariableSchemaOptions): Promise<VariableSchema> {
  const { io, csvDir, log } = opts;
  const tables = new Map<string, VariableTable>();

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
    } catch (err) {
      log.warn(`变量表读取失败（跳过）：${e.path} — ${String(err)}`);
    }
  }

  log.info(`变量字典：${tables.size} 张名称表（${[...tables.keys()].join(', ')}）`);

  return {
    version: '1',
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const key = variableName.toUpperCase();
      const table = tables.get(key);
      if (!table) return undefined;
      if (index === undefined) return { name: key };
      const idxStr = String(index);
      const byIdx = table.byIndex.get(idxStr);
      if (byIdx !== undefined) {
        // 编号索引（如 CFLAG:2）→ 名称为描述；resolvedIndex = 自身
        const n = Number(idxStr);
        const info: VariableInfo = { name: key, index, description: byIdx };
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      if (table.byName.has(idxStr)) {
        // 具名索引（如 TALENT:恋慕）→ 名称本身即描述；resolvedIndex = 字典编号
        const info: VariableInfo = { name: key, index, description: idxStr };
        const n = Number(table.byName.get(idxStr));
        if (!Number.isNaN(n)) info.resolvedIndex = n;
        return info;
      }
      return { name: key, index };
    },
  };
}
