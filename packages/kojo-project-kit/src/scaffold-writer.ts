/**
 * 脚手架落盘（`GameAdapter.scaffold?()` 契约的实现半边）。
 *
 * 契约声明的返回是**落盘态**（`{createdFiles, report}`），而共享层的脚手架
 * 只产文本（`{dirName, files}`）。这一层负责把两者接起来：路径拼装、
 * 目录创建、逐文件写入、失败即停并如实报告。
 *
 * 三条口径：
 * - **不覆盖**：目标文件已存在即报错（与部署同一条纪律——游戏目录里可能是别人的东西）；
 * - **不猜目录**：`targetDir` 必填，由调用方按本游戏的布局决定（共享层不认识游戏目录结构）；
 * - **不转码**：逐字节写（`writeBytes`）。脚手架文本自己就带 BOM / CRLF（角色表 CSV
 *   必须是 UTF-8-BOM + CRLF），交给 `writeText` 会被按文件编码策略重排一遍——
 *   首次写入默认补 BOM，于是自带 BOM 的 CSV 变双 BOM。编码口径的**唯一陈述处**
 *   是 `encoding-policy.ts` 的 `scaffold-text` / `scaffold-csv` 两行；
 *   本文件只调 `encodeScaffoldText`（= 原样 UTF-8，不增不减 BOM）。
 * - **报告逐条**：一行一个文件，失败时说清是哪个、为什么。
 */

import type { FileIO, ScaffoldResult } from '@kojo/plugin-api';
import { dirname, join } from '@kojo/plugin-api';
import { encodeScaffoldText } from './encoding-policy';

/** 落盘入参 */
export interface WriteScaffoldInput {
  io: FileIO;
  /** 相对路径 → 文本内容（共享层脚手架的 `files`） */
  files: Readonly<Record<string, string>>;
  /** 绝对路径根（文件按 `files` 的相对路径落在其下） */
  targetDir: string;
  /** 只写这些相对路径（缺省 = 全写）；用于 `ScaffoldOptions.faces` 一类筛选 */
  only?: readonly string[];
}

/**
 * 把脚手架文本写进目标目录。
 *
 * 逐个文件「先查存在、再建父目录、再写」——顺序不能反：先建目录再查，
 * 失败时会留下空目录壳。
 */
export async function writeScaffoldFiles(input: WriteScaffoldInput): Promise<ScaffoldResult> {
  const { io, files, targetDir } = input;
  const only = input.only === undefined ? null : new Set(input.only);
  const createdFiles: string[] = [];
  const report: string[] = [];

  for (const [relPath, text] of Object.entries(files)) {
    if (only !== null && !only.has(relPath)) continue;
    const abs = join(targetDir, relPath);
    if (await io.exists(abs)) {
      throw new Error(`目标文件已存在，未覆盖：${abs}`);
    }
    await io.ensureDir(dirname(abs));
    await io.writeBytes(abs, encodeScaffoldText(text));
    createdFiles.push(abs);
    report.push(`${relPath}（${text.length} 字符）`);
  }

  report.push(`共 ${createdFiles.length} 个文件，落在 ${targetDir}`);
  return { createdFiles, report };
}
