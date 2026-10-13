/**
 * eraTW 指令名表（`CSV/Train.csv`）数据层 —— **游戏知识，只住 adapter**。
 *
 * 「指令口上」的中文名 ↔ 编号来源（HK-11）：`时机 指令 摸屁股：` 里的中文名
 * 经本表查编号，转译器据此拼函数名。数据源 = 当前打开项目的 `CSV/Train.csv`
 * （引擎读取惯例 `TRAINNAME:编号`），随版本 / 汉化 / 魔改自动跟随、**不内置打包**。
 *
 * ## 解析铁律（实测自 eraTW 4.980 汉化包，见看板 HK-11）
 * - 文件是 UTF-8 **带 BOM**、`编号,中文名` 行 + 大量 `;` 注释行**穿插其间**；
 * - **编号取第一列，不是行号**——注释行也带编号且自身占位，按行号取会整套错位；
 * - 故：`;` 开头的行**整行跳过**、空行跳过；同名多编号**取首条**。
 *
 * 查不到的名字 / 编号一律 `undefined`（**绝不猜**，规范 §5.3 精神）。
 */

import { join } from '@kojo/plugin-api';
import type { FileIO, KojoInstructionTable, Logger } from '@kojo/plugin-api';
import { TRAIN_CSV } from './constants';

/**
 * 解析 `CSV/Train.csv` 文本 → 中文名 → 编号 映射（纯函数；导出供测试）。
 *
 * 容忍 UTF-8 BOM（首字符 `\uFEFF` 去掉）；按 `,` 切分，**第一列 = 编号、
 * 第二列 = 中文名**（第三列及之后忽略）。
 */
export function parseTrainCsv(text: string): Map<string, number> {
  const map = new Map<string, number>();
  // 只可能出现在文件最开头；逐行 trim 时也一并兜底
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const rawLine of src.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // 注释行整行跳过——**注意注释行自身也带编号**（按行号取编号会整套错位）
    if (line.startsWith(';')) continue;
    const firstComma = line.indexOf(',');
    if (firstComma <= 0) continue; // 无第一列 / 首列为空
    const noText = line.slice(0, firstComma).trim();
    if (!/^\d+$/.test(noText)) continue; // 编号是第一列；非数字行丢弃
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const name = (secondComma >= 0 ? rest.slice(0, secondComma) : rest).trim();
    if (name.length === 0) continue;
    // 同名多编号取首条（与引擎 CSV 加载顺序语义一致）
    if (!map.has(name)) map.set(name, Number(noText));
  }
  return map;
}

/**
 * 由「中文名 → 编号」映射构建 `KojoInstructionTable`（纯数据，无 IO）。
 * `hasTable = 映射非空`；双向查表走反查，无则 `undefined`。
 */
export function createEratwInstructionTable(map: ReadonlyMap<string, number>): KojoInstructionTable {
  const byName = new Map(map);
  const byNo = new Map<number, string>();
  for (const [name, no] of byName) {
    // 编号 → **首条**中文名（与 byName 的取首条同口径）
    if (!byNo.has(no)) byNo.set(no, name);
  }
  return {
    hasTable: byName.size > 0,
    lookupByName: (name) => byName.get(name),
    lookupByNo: (no) => byNo.get(no),
  };
}

/** 空表实例（未加载 / 无表时返回它；`hasTable=false`，查啥都 undefined） */
export const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = createEratwInstructionTable(new Map());

export interface LoadInstructionTableOptions {
  io: FileIO;
  /** 项目 `CSV/` 目录（绝对路径） */
  csvDir: string;
  log: Logger;
}

/**
 * 读 `<csvDir>/Train.csv` 建指令表。
 *
 * - 文件不存在 = 空表（`hasTable=false`），**不抛**；
 * - 读取 / 解析失败 = 记 `log.warn` 并回空表。
 */
export async function loadEratwInstructionTable(opts: LoadInstructionTableOptions): Promise<KojoInstructionTable> {
  const { io, csvDir, log } = opts;
  const file = join(csvDir, TRAIN_CSV);
  try {
    if (!(await io.exists(file))) return EMPTY_INSTRUCTION_TABLE;
    const tf = await io.readText(file);
    const table = createEratwInstructionTable(parseTrainCsv(tf.text));
    log.info(`指令表加载：${table.hasTable ? '有表' : '空表'}（${file}）`);
    return table;
  } catch (err) {
    log.warn(`指令表加载失败（回空表）：${file} — ${String(err)}`);
    return EMPTY_INSTRUCTION_TABLE;
  }
}
