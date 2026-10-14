/**
 * 真实语料（K12 露米娅）转译闸：`tests/goldens/corpus-k12-lumia-*.kojo` 全量零 error。
 *
 * 这批语料是**装译实录**（附录 C 反糖成果），不是规范摘录，故不断言逐字节产物
 * ——产物本身已作为 `.translated.ERB` 检入留档，本文件只锁"零 error 诊断"这条底线。
 *
 * 运行期扫目录取样（不硬编码文件清单），新增语料自动纳入；本测试**不写任何文件**。
 *
 * 输入预处理与建这批 golden 时使用的口径完全一致（原临时 harness，已删除）：
 * 去 BOM → CRLF 归一为 LF → 丢弃以 `//` 开头的横幅行
 * （`;` 开头的 ERB 注释行是**正文**，照常进转译并写进产物）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const dir = new URL('./goldens/', import.meta.url);

/** 语料金样 = 扩展名恰为 `.kojo`（`.translated.ERB` / `.kojo.generated.ERB` 一律排除） */
const CORPUS_RE = /^corpus-k12-lumia-.+\.kojo$/;

const corpusFiles = readdirSync(dir)
  .filter((name) => CORPUS_RE.test(name))
  .sort();

/** 去 UTF-8 BOM（按码元判定，源码里不留不可见字符） */
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** 读语料并按建闸口径预处理：去 BOM → CRLF 归一 LF → 去 `//` 横幅行 */
const readCorpus = (name: string) =>
  stripBom(readFileSync(new URL(name, dir), 'utf8'))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith('//'))
    .join('\n');

/** 失败信息里的诊断预览：最多摊开前 8 条，其余只报总数 */
const previewErrors = (errs: SugarDiagnostic[]) => {
  const head = errs
    .slice(0, 8)
    .map((d) => `    [${d.code}] ${d.loc ? `${d.loc.line}:${d.loc.column} ` : ''}${d.message}`)
    .join('\n');
  return errs.length > 8 ? `${head}\n    …（共 ${errs.length} 条）` : head;
};

const service = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

describe('真实语料 K12 露米娅 · 转译零 error', () => {
  it('扫目录命中语料（目录被清空或改名时不得静默空跑）', () => {
    expect(
      corpusFiles.length,
      `tests/goldens/ 下没有匹配 ${CORPUS_RE} 的语料文件——目录被清空还是改名了？`,
    ).toBeGreaterThan(0);
  });

  for (const name of corpusFiles) {
    it(`${name}：无 error 诊断`, () => {
      const { diagnostics } = service().transpile(readCorpus(name));
      const errs = diagnostics.filter((d) => d.severity === 'error');
      expect(errs, `${name} 转译出 ${errs.length} 条 error：\n${previewErrors(errs)}`).toEqual([]);
    });
  }
});
