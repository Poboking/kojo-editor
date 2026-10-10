/**
 * 文档追加脚本（S1 批）：把 drafts/_s1-section.md 追加到 IMPLEMENTATION-LOG 末尾。
 *
 * 用 node 读文件 + 拼接写入（不走模板字符串——反引号与 `\`` 转义是本机多次翻车点，
 * HANDOFF §八）。追加式编辑必须事后 grep 标题层级验证（§九-23）。
 *
 * 用法：node tools/_doc-append-s1.mjs
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG = path.join(ROOT, 'docs/IMPLEMENTATION-LOG.md');
const SECTION = path.join(ROOT, 'drafts/_s1-section.md');

async function main() {
  const text = await fs.readFile(LOG, 'utf8');
  const section = await fs.readFile(SECTION, 'utf8');
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.join('\n') + '\n\n' + section;
  await fs.writeFile(LOG, out, 'utf8');
  console.log('[doc] IMPLEMENTATION-LOG appended: ' + lines.length + ' -> ' + out.split(/\r?\n/).length + ' lines');
}

await main();
