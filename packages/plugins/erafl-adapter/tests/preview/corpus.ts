/**
 * 真盘语料取样（测试专用，只读）。
 *
 * 抽样用**固定步长**而不是 `Math.random()`：真盘读数要能复现，CI 里同一个
 * 断言今天 2,675、明天 2,610 会让"量级判据"变成掷骰子。步长均匀覆盖整份
 * 文件列表（按路径排序后取第 0、k、2k… 份），等价于随机抽样的可复现版。
 *
 * 语料盘不在位时所有函数都返回空，守卫用例据此 skip。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KojoXmlFile } from '@kojo/plugin-api';
import { decodeKojoXmlBytes } from '../../src/kojo-xml/encoding';
import { parseKojoXmlText } from '../../src/kojo-xml/parse';
import { charaNoFromKojoPath } from '../../src/kojo-xml/service';

/** 真盘口上根目录（与 `tests/kojo-xml.test.ts` 同一口径） */
export const KOJO_CORPUS_ROOT = 'D:/Game/erafl/ERB/口上';

/** 语料是否在位（守卫用） */
export const hasKojoCorpus = existsSync(KOJO_CORPUS_ROOT);

/** 递归列出全部口上 XML（路径排序，保证抽样稳定） */
export function listKojoXmlFiles(root: string = KOJO_CORPUS_ROOT): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.xml$/i.test(entry.name)) paths.push(full);
    }
  };
  walk(root);
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 均匀抽 `count` 份（文件不足 count 时全取） */
export function sampleKojoXmlFiles(count: number, root: string = KOJO_CORPUS_ROOT): string[] {
  const all = listKojoXmlFiles(root);
  if (all.length <= count) return all;
  const step = all.length / count;
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = all[Math.floor(i * step)];
    if (path) picked.push(path);
  }
  return picked;
}

/** 读一份真盘口上（BOM 优先解码 + 现有解析器），与索引面走同一条路径 */
export function readKojoCorpusFile(path: string): KojoXmlFile {
  const { text, encoding } = decodeKojoXmlBytes(readFileSync(path));
  return parseKojoXmlText({ path, text, encoding, charaNo: charaNoFromKojoPath(path) });
}
