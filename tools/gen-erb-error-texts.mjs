#!/usr/bin/env node
/**
 * ERB 引擎报错文案数据契约生成器（ERBDIAG-ERATW）。
 *
 * 输入：`tools/data/error-texts.yaml` —— 取自 eratw-安卓移植计划的 `specs/error-texts.yaml`
 *       （原版 `Lang.Error` 文案表；日文原文 `Lang.cs`、中文译文 `lang.emuera-zhs.xml`，
 *       逐条带 C# 行号与抛出点锚）。
 * 产物：`packages/plugin-api/src/erb.ts` 中 `// @erb-engine-error-texts:begin` … `:end`
 *       标记区间——104 条引擎报错原话（id / 占位符个数 / 接线状态 / 中文原话）+ 定位函数。
 *
 * 为什么内联进 erb.ts 而不是单独模块：PS-10 开机图有硬文件数闸（≤197），`erb.ts` 已在
 * 图内，新增一个静态 import 模块会 197→198 判红。内联只在既有文件里加字节。
 *
 * 为什么运行时只带 `zhs`：ja / en / used_at 是**溯源**字段，只有审计要用，
 * 留在 yaml 快照里由测试读；编辑器使用者看的是中文，运行时不背两份用不上的译文。
 *
 * 用法：node tools/gen-erb-error-texts.mjs
 * 输入快照的 sha256 写进产物头；输入变了必须重跑并订正测试里的指纹。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT = path.join(ROOT, 'tools', 'data', 'error-texts.yaml');
const TARGET = path.join(ROOT, 'packages', 'plugin-api', 'src', 'erb.ts');
const BEGIN = '// @erb-engine-error-texts:begin';
const END = '// @erb-engine-error-texts:end';

const raw = readFileSync(INPUT, 'utf8');
// EOL 归一化后再算 sha：git 的 autocrlf 会在 checkout 时把 CRLF 换成 LF，
// 直接对原始字节算会让同一份逻辑内容在不同 checkout 下得到不同指纹（rebase 后实测踩过）。
const normalized = raw.replace(/\r\n?/g, '\n');
const sha256 = createHash('sha256').update(normalized, 'utf8').digest('hex');
const lines = normalized.split('\n');

/**
 * 解析条目。形态固定（`- id:` 起条目，其后 4 空格缩进的 `键: 值`，
 * 多行文本用 `|-` 起块、6 空格缩进续行），故不引 yaml 依赖——仓库里没有该依赖，
 * 也不为一个生成器加一份。解析不到的字段留空由下面的完整性断言兜住。
 */
function parseEntries() {
  const out = [];
  let cur = null;
  let mode = null;
  for (const ln of lines) {
    const idm = /^\s*-\s*id:\s*(\S+)\s*$/.exec(ln);
    if (idm) {
      if (cur !== null) out.push(cur);
      cur = { id: idm[1] };
      mode = null;
      continue;
    }
    if (cur === null) continue;
    const kv = /^\s{4}([a-z_0-9]+):\s*(.*)$/.exec(ln);
    if (kv) {
      const key = kv[1];
      const value = kv[2];
      if (value === '|-') {
        mode = key;
        cur[key] = '';
      } else {
        cur[key] = value;
        mode = null;
      }
      continue;
    }
    if (mode !== null && /^\s{6}/.test(ln)) {
      cur[mode] += (cur[mode] ? '\n' : '') + ln.slice(6);
      continue;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

const entries = parseEntries();

/** 完整性断言：少字段就让生成器红，而不是产出一份悄悄缺字的表 */
for (const e of entries) {
  for (const key of ['id', 'args', 'status', 'zhs']) {
    if (e[key] === undefined || e[key] === '') {
      throw new Error(`条目 ${e.id ?? '(无名)'} 缺少字段 ${key}`);
    }
  }
  if (!/^\d+$/.test(e.args)) throw new Error(`条目 ${e.id} 的 args 不是整数：${e.args}`);
  if (e.status !== 'wired' && e.status !== 'registered') {
    throw new Error(`条目 ${e.id} 的 status 不认识：${e.status}`);
  }
  // 占位符个数必须与 `args` 自洽：`{n}` 的最大序号 + 1 = args。
  // 摆错一位，运行时替换就会把用户数据填错位，这条断言是本表的自检底线。
  const seen = new Set();
  for (const m of e.zhs.matchAll(/\{(\d+)\}/g)) seen.add(Number(m[1]));
  const want = Number(e.args);
  const max = seen.size === 0 ? -1 : Math.max(...seen);
  if (max + 1 !== want || seen.size !== want) {
    throw new Error(
      `条目 ${e.id} 的占位符与 args 不符：args=${want}，实际占位符 ${JSON.stringify([...seen].sort())}`,
    );
  }
}

const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const wired = sorted.filter((e) => e.status === 'wired').length;

const body = sorted
  .map(
    (e) =>
      `  ${e.id}: { args: ${e.args}, status: ${JSON.stringify(e.status)}, zhs: ${JSON.stringify(e.zhs)} },`,
  )
  .join('\n');

const block = `${BEGIN}
/**
 * 引擎报错原话 —— **生成区间，勿手改**；由 \`node tools/gen-erb-error-texts.mjs\` 重生成。
 *
 * 真源：eratw-安卓移植计划 \`specs/error-texts.yaml\`（原版 \`Lang.Error\` 文案表）。
 *       日文原文 \`MinorShift.Emuera.Runtime.Utils.EvilMask/Lang.cs\`、
 *       中文译文 \`MinorShift.Emuera.Properties.lang.emuera-zhs.xml\`，
 *       抛出点锚在 \`ArgumentBuilder.cs\` / \`ArgumentParser.cs\` / \`ErbLoader.cs\`。
 * 快照：\`tools/data/error-texts.yaml\`，sha256 = \`${sha256}\`。
 * 条数：${sorted.length}（wired ${wired} / registered ${sorted.length - wired}）。
 *
 * 为什么要有这张表：这些文案是**玩家实际看到过的原文**（线上项目数千玩家校验），
 * 编辑器自己另写一套措辞，作者按引擎原话去搜社区/提问时就对不上号。凡引擎有原话的诊断，
 * 一律以原文为锚，编辑器要补充定位信息就**追加**在原文之后，不改写原文。
 *
 * 字段口径：
 * - \`args\` = \`string.Format\` 占位符个数（\`{0}\`…\`{args-1}\`），与 yaml 逐条自洽；
 * - \`status\` = \`wired\`（引擎确实会抛）/ \`registered\`（键已登记、调用点仍用旧串）；
 * - \`zhs\` = 中文原文**逐字**（只做按序号原位替换，不 trim、不改引号形态、不修误译——
 *   照抄纪律见上游 ADR-005）。
 *
 * 日文原文、英文译文与抛出点锚不在运行时表里：它们只在审计时用，随 yaml 快照留在
 * \`tools/data/\`，由 \`tests/engine-error-texts.test.ts\` 读。
 */
export interface ErbEngineErrorText {
  /** \`string.Format\` 占位符个数（\`{0}\`…\`{args-1}\`） */
  readonly args: number;
  /** \`wired\` = 引擎真会抛；\`registered\` = 键已登记、调用点仍用旧串 */
  readonly status: 'wired' | 'registered';
  /** 简体中文原话（逐字；占位符留在原位） */
  readonly zhs: string;
}

/** 全部引擎报错原话（键 = \`Lang.Error\` 的键名，去掉 \`Error.\` 前缀；按 id 升序） */
export const ERB_ENGINE_ERROR_TEXTS: Readonly<Record<string, ErbEngineErrorText>> = {
${body}
};

/**
 * 按序号原位替换 \`{0}\`…\`{n}\`（引擎 \`string.Format\` 的同口径最小实现）。
 *
 * 三条纪律与上游一致：**只替换、不 trim、不改引号形态**；缺参数时把占位符原样留下
 * （让缺参可见，而不是悄悄插一个空串）。未登记的 id ⇒ \`undefined\`，**绝不编造文案**——
 * 未登记是上游漏了表，该由审计闸报错，不在这里猜。
 */
export function formatEngineErrorText(
  id: string,
  values: readonly (string | number)[] = [],
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ERB_ENGINE_ERROR_TEXTS, id)) return undefined;
  const text = ERB_ENGINE_ERROR_TEXTS[id]!.zhs;
  return text.replace(/\\{(\\d+)\\}/g, (whole, digits: string) => {
    const value = values[Number(digits)];
    return value === undefined ? whole : String(value);
  });
}
${END}`;

const src = readFileSync(TARGET, 'utf8');
const start = src.indexOf(BEGIN);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  throw new Error(`erb.ts 缺少 ${BEGIN}/${END} 标记区间`);
}
const next = src.slice(0, start) + block + src.slice(end + END.length);
writeFileSync(TARGET, next, 'utf8');
console.log(
  `生成 ${path.relative(ROOT, TARGET)} 标记区间：${sorted.length} 条（wired ${wired}）；输入 sha256 ${sha256.slice(0, 16)}…`,
);
