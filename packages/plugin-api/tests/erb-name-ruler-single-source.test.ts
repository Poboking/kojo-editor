import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin, relative as nodeRel, resolve as nodeResolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ERB_ENGINE_NAME_DELIMITERS,
  ERB_NAME_RUN_SOURCE,
  isErbEngineNameCode,
} from '../src/erb-name-ruler';
import { MODEL_TOKEN_CLASS } from '../src/semantic-locate';
import * as pluginApiLeaf from '@kojo/plugin-api/erb-name-ruler';
import * as scannerModule from '../../plugins/erb-parser/src/scanner';

/**
 * 引擎名字尺的**单一真源守门**（D01b，2026-11-06；可复跑判据，违例直接红）。
 *
 * 照仓里既有成例（`compareVersions` / `packUpdateCheck` / `sha256Hex` 各只有一份定义 +
 * 一份守门测试，见 `packages/plugins/kojo-market/tests/single-source.test.ts`）：判据
 * "搬家"之后，**拦后来者**的必须是测试，不是文档。
 *
 * 四条口径：
 * 1. `ERB_ENGINE_NAME_DELIMITERS` / `isErbEngineNameCode` 的**定义**全仓只准住在
 *    `packages/plugin-api/src/erb-name-ruler.ts` 一处；
 * 2. 分隔集**字面量**（不走常量名、直接再抄一串字符集）也只准出现在那一处 ——
 *    唯一豁免是逐字钉真源的已知向量测试（改了字面它就红，见 `LITERAL_ALLOWED`）；
 * 3. `erb-parser/src/scanner.ts` 只做**再导出**（对外形态零变化），自己不许再留一份定义；
 * 4. **两把尺不许合并**：`MODEL_TOKEN_CLASS`（记号尺：着色 / 补全）与 `ERB_NAME_RUN_SOURCE`
 *    （名字段尺：引擎怎么读一个变量名）字符类必须不相等，谁把它们改成同一把就红。
 */
vi.setConfig({ testTimeout: 120000 });

const ROOT = nodeResolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PACKAGES = nodeJoin(ROOT, 'packages');
const SELF = nodeRel(ROOT, fileURLToPath(new URL(import.meta.url))).replace(/\\/g, '/');
/** 尺子的唯一住处（定义与字面量的合法落点） */
const RULER_SOURCE = 'packages/plugin-api/src/erb-name-ruler.ts';
/**
 * 字面量的**点名豁免**：逐字钉住真源的已知向量测试（`undefined-name.drift.test.ts` 的
 * `expect(ERB_ENGINE_NAME_DELIMITERS).toBe('...')` 那一枚）。它的价值恰恰是"第二份抄本
 * 与真源不一致就红"，与"再写一份判据去消费"是两件事；除这一枚外任何新抄本一律红。
 */
const LITERAL_ALLOWED = ['packages/plugins/erb-parser/tests/undefined-name.drift.test.ts'];
/** 分隔集里最具辨识度的一段（再抄一遍字符集的人绕不开它；截到转义引号之前，与引号写法无关） */
const LITERAL_PROBE = "|&^~?#)}],:({[$";

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (statSync(dir).isFile()) {
    out.push(dir);
    return out;
  }
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target' || name === '.git') continue;
    const p = nodeJoin(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(p);
  }
  return out;
}

/** 全仓源码（`packages/**` 的 `.ts(x)`；本守门文件自身除外——它当然得能引用这些名字） */
const ALL = sourceFiles(PACKAGES)
  .map((p) => nodeRel(ROOT, p).replace(new RegExp(`\\${sep}`, 'g'), '/'))
  .filter((rel) => rel !== SELF);

/** 返回"内容里出现任一模板/正则"的文件相对路径（去重、排序，便于读出违例者） */
function filesMatching(patterns: RegExp[], rels: string[] = ALL): string[] {
  const hit = new Set<string>();
  for (const rel of rels) {
    const text = readFileSync(nodeJoin(ROOT, rel), 'utf8');
    if (patterns.some((re) => re.test(text))) hit.add(rel);
  }
  return [...hit].sort();
}

const DEF_DELIMITERS = /^\s*(?:export\s+)?const\s+ERB_ENGINE_NAME_DELIMITERS\s*=/m;
const DEF_RUN_SOURCE = /^\s*(?:export\s+)?const\s+ERB_NAME_RUN_SOURCE\s*=/m;
const DEF_IS_CODE = /^\s*(?:export\s+)?function\s+isErbEngineNameCode\s*\(/m;
const DEF_MODEL_TOKEN = /^\s*(?:export\s+)?const\s+MODEL_TOKEN_CLASS\s*=/m;

describe('引擎名字尺：全仓仅一份定义（D01b 单一真源）', () => {
  it('ERB_ENGINE_NAME_DELIMITERS 的定义只住契约层那一枚叶子', () => {
    expect(filesMatching([DEF_DELIMITERS]), '分隔集定义处数').toEqual([RULER_SOURCE]);
  });

  it('isErbEngineNameCode 与 ERB_NAME_RUN_SOURCE 的定义同样只住那一枚叶子', () => {
    expect(filesMatching([DEF_IS_CODE]), '码位判据定义处数').toEqual([RULER_SOURCE]);
    expect(filesMatching([DEF_RUN_SOURCE]), '正则形态定义处数').toEqual([RULER_SOURCE]);
  });

  it('分隔集字面量不许被再抄一遍（豁免只有逐字钉真源的已知向量测试）', () => {
    const found = filesMatching([new RegExp(LITERAL_PROBE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')])
      .filter((rel) => !LITERAL_ALLOWED.includes(rel));
    expect(found, '手抄分隔集的文件').toEqual([RULER_SOURCE]);
  });

  it('契约根入口**不许**再挂这枚叶子（开机图 197 文件闸）；消费方只走子路径', () => {
    const index = readFileSync(nodeJoin(ROOT, 'packages/plugin-api/src/index.ts'), 'utf8');
    expect(/from '\.\/erb-name-ruler'/.test(index), 'index.ts 又把叶子挂进桶了（PS-10 开机图会长一枚文件）').toBe(false);
    // 宿主与插件两侧的取词消费方必须经子路径拿到**同一枚**导出（不是各自复制）
    expect(pluginApiLeaf.ERB_ENGINE_NAME_DELIMITERS).toBe(ERB_ENGINE_NAME_DELIMITERS);
    expect(pluginApiLeaf.ERB_NAME_RUN_SOURCE).toBe(ERB_NAME_RUN_SOURCE);
    expect(pluginApiLeaf.isErbEngineNameCode).toBe(isErbEngineNameCode);
    // erb-parser 的消费方（undefined-name.ts / drift 测试）仍从 './scanner' 取——必须是同一枚函数
    expect(scannerModule.ERB_ENGINE_NAME_DELIMITERS).toBe(ERB_ENGINE_NAME_DELIMITERS);
    expect(scannerModule.isErbEngineNameCode).toBe(isErbEngineNameCode);
    expect(scannerModule.ERB_NAME_RUN_SOURCE).toBe(ERB_NAME_RUN_SOURCE);
  });

  it('宿主侧两处消费方都引叶子（不许退回记号尺、也不许手抄字符类）', () => {
    const consumers = ['packages/app/src/ui/name-ledger.ts', 'packages/app/src/ui/reference-utils.ts'];
    for (const rel of consumers) {
      const text = readFileSync(nodeJoin(ROOT, rel), 'utf8');
      expect(text, `${rel} 未引引擎名字尺`).toContain("@kojo/plugin-api/erb-name-ruler");
      expect(text, `${rel} 仍 import 记号尺来按名取词`).not.toMatch(/import[^;\n]*MODEL_TOKEN_CLASS/);
    }
  });

  it('scanner 侧只剩再导出：没有定义、也没有第二串字面量', () => {
    const scanner = readFileSync(nodeJoin(ROOT, 'packages/plugins/erb-parser/src/scanner.ts'), 'utf8');
    expect(DEF_DELIMITERS.test(scanner), 'scanner 里又写了分隔集定义').toBe(false);
    expect(DEF_IS_CODE.test(scanner), 'scanner 里又写了码位判据').toBe(false);
    expect(DEF_RUN_SOURCE.test(scanner), 'scanner 里又写了正则形态').toBe(false);
    expect(scanner.includes(LITERAL_PROBE), 'scanner 里又手抄了一遍字符集').toBe(false);
    expect(scanner, 'scanner 必须经零依赖叶子子路径再导出（裸 node 约束）').toContain(
      "from '@kojo/plugin-api/erb-name-ruler'",
    );
  });

  it('两把尺、两个问题：记号尺与名字段尺**不相等**，谁合并就红', () => {
    expect(MODEL_TOKEN_CLASS).toBe(String.raw`[\p{L}\p{N}_]`);
    expect(filesMatching([DEF_MODEL_TOKEN])).toEqual(['packages/plugin-api/src/semantic-locate.ts']);
    const engine = new RegExp(`^${ERB_NAME_RUN_SOURCE}+$`, 'u');
    const model = new RegExp(`^${MODEL_TOKEN_CLASS}+$`, 'u');
    // `·`(U+00B7) / 全角 `％` / 全角句号：引擎眼里是一枚名字的一部分，记号尺不认
    for (const word of ['P23温泉·更衣间', '100％（シリーズ毎）', '问候。処理']) {
      expect(engine.test(word), `${word} 应是引擎的一枚名字`).toBe(true);
      expect(model.test(word), `${word} 不该被记号尺当成一枚记号`).toBe(false);
    }
    // 反向：`.` / `%` / `(` 是引擎分隔符 ⇒ 引擎尺判 false，记号尺也 false（此处**一致**，
    // 一致不代表可以合并——上面三枚就是两把尺的分歧面）
    expect(engine.test('A.B')).toBe(false);
    expect(engine.test('')).toBe(false);
  });
});

describe('引擎名字尺：判据行为（改前会碎的真名字钉住边界）', () => {
  const engineRun = (text: string): string[] => text.match(new RegExp(`${ERB_NAME_RUN_SOURCE}+`, 'gu')) ?? [];

  it('非分隔符连成一枚名字（· / 全角％ / 全角括号 / 反引号）', () => {
    expect(engineRun('CALL P23温泉·更衣间')).toEqual(['CALL', 'P23温泉·更衣间']);
    expect(engineRun('IF 100％（シリーズ毎）= 1')).toEqual(['IF', '100％（シリーズ毎）', '1']);
    expect(engineRun("DIM 反`引号")).toEqual(['DIM', "反`引号"]);
  });

  it('分隔符处断开（. ~ ? # $ @ 与 ASCII % / ( / )）', () => {
    expect(engineRun('FORM_P0.温泉')).toEqual(['FORM_P0', '温泉']);
    expect(engineRun('%CALLNAME:TARGET%')).toEqual(['CALLNAME', 'TARGET']);
    expect(engineRun('A-B')).toEqual(['A', 'B']);
    expect(engineRun('A[0]')).toEqual(['A', '0']);
  });

  it('isErbEngineNameCode 与正则形态逐码位一致（两枚出口不许分叉）', () => {
    const single = new RegExp(`^${ERB_NAME_RUN_SOURCE}$`, 'u');
    for (let code = 0; code < 0x3000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const viaCode = isErbEngineNameCode(code);
      const viaRegex = code < 0x10000 ? single.test(String.fromCharCode(code)) : true;
      if (code < 0x10000) expect(viaCode, `${code} 两枚出口分叉`).toBe(viaRegex);
    }
    expect(isErbEngineNameCode(Number.NaN), '空串 charCodeAt ⇒ 不是名字字符').toBe(false);
  });
});
