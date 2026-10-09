/**
 * 一次性分析工具：扫描真实 eraTW 口上域的**函数名命名模式**。
 *
 * 目的：为 FamilyIndexRule（函数家族识别规则）提供数据依据——
 * 用真名分布验证解析算法覆盖率，找出长尾形态。
 *
 * 本文件中的 parseKojoFunction 是**正式算法的原型**（v2，数据驱动迭代），
 * 验证覆盖率后按同逻辑移植为 TS（eratw-adapter/src/family-index.ts）。
 *
 * 用法：node tools/analyze-kojo-names.mjs "<游戏目录>"
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node analyze-kojo-names.mjs <game-dir>');
  process.exit(1);
}

/* ------------------------------ 算法 v2 ------------------------------ */

// 普通"面"名表（最长优先匹配）。PALAMCNG / IRAI / OPTION / DIARY 有专门正则在前。
const PLAIN_FACES = [
  'MESSAGE_CUSTOM_COM', 'MESSAGE_CUSTOM_SCOM',
  'MESSAGE_MARKCNG', 'MESSAGE_COUNTER', 'MESSAGE_ENDING',
  'CUSTOM_TALENT_SET', 'CUSTOM_BUTTON_CONDITION', 'CUSTOM_EVENT', 'CUSTOM_BUTTON',
  'EXTRASOURCE_COM', 'EXTRASOURCE_SCOM', 'EXTRASOURCE',
  'SF_CONTRACT_EVENT', 'SF_CONTRACT', 'DAILY_EVENT', 'FLAGSETTING',
  'SUCCESS_COM', 'SUCCESS_SCOM', 'SUCCESS',
  'MESSAGE_COM', 'MESSAGE_SCOM', 'MESSAGE_PALAMCNG', 'MESSAGE',
  'SPEVENT', 'ENCOUNTER', 'COMMAND', 'IMAGE_EX', 'IMAGE',
  'COM_NAME', 'COM_ABLE', 'CAN_COM', 'COM_Counter不发', 'COM',
  'COLOR', 'CHECK', 'EVENT',
].sort((a, b) => b.length - a.length);

// 特殊结构正则（作用于 head；捕获 1 = family 部分（可空），捕获 2 = 子号（可空））
const SPECIAL_HEADS = [
  // M_{PALAMCNG 变体}：_MESSAGE_PALAMCNG_A / _A1 / _B ... _F
  { face: 'MESSAGE_PALAMCNG', re: /^(.*?)_MESSAGE_PALAMCNG(?:_([A-F]\d?))?$/ },
  // _IRAI 可带依頼名：_IRAI_依頼名 或 _IRAI
  { face: 'IRAI', re: /^(.*?)_IRAI(?:_([^_]+))?$/ },
  // KOJO_OPTION 系统：_OPTION_EXIST / _OPTION / _OPTION_RESULT（RESULT 在 tail）
  { face: 'OPTION_EXIST', re: /^(.*?)_OPTION_EXIST$/ },
  { face: 'OPTION', re: /^(.*?)_OPTION$/ },
  // 剧本更新钩子
  { face: 'UPDATE', re: /^(.*?)_UPDATE$/ },
  // KOJO_VERSION
  { face: 'VERSION_UPDATE', re: /^(.*?)_VERSION_UPDATE$/ },
  { face: 'VERSION', re: /^(.*?)_VERSION$/ },
];

const PREFIXES = ['M_KOJO', 'KOJO', 'DIARY', 'RUN_INTO'];

/**
 * @returns {{kind:string, [k:string]:any}}
 */
function parseKojoFunction(rawName) {
  const name = rawName.replace(/[,;\s]+$/, ''); // 容忍尾部逗号/空白（真实语料存在）
  const kx = /_KX(?:_|$)/.test(name); // 模板占位符残留标记（KX 未替换）

  // 1) 家族声明：M_KOJO_K{n} / M_KOJO_K{n}_{selector}
  let m = /^M_KOJO_K(\d+)(?:_(\d+))?$/.exec(name);
  if (m) return { kind: 'declare', family: '', no: +m[1], selector: m[2] ? +m[2] : 0, kx };

  // 2) BEFORETRAIN：K{n}_BEFORETRAIN{family}
  m = /^K(\d+)_BEFORETRAIN(.*)$/.exec(name);
  if (m) return { kind: 'beforetrain', family: m[2] ?? '', no: +m[1], kx };

  // 3) 前缀剥离（含"裸家族前缀"回退）
  let prefix = PREFIXES.find((p) => name.startsWith(p));
  let rest;
  if (prefix) {
    rest = name.slice(prefix.length);
  } else {
    // 私货形态：{家族}_{FACE}_K{n}...（家族名直接做前缀，无 M_KOJO）
    // 判定：存在 _K{digits} 且 head 含已知面
    const anchor = /^(.*)_K(\d+)(_.+)?$/.exec(name);
    if (anchor && PLAIN_FACES.some((f) => (anchor[1] ?? '').includes('_' + f))) {
      prefix = '';
      rest = name;
    } else {
      return { kind: 'null', name, kx };
    }
  }

  // 4) K 锚点：rest = head..._K{no}{tail}
  //    KX：模板占位符残留（K{n} 未替换）——不是解析失败而是**数据质量信号**：
  //    照常解析 face/family，编号置 null。
  const tailMatch = /^(.*)_K(\d+)(_.+)?$/.exec(rest);
  if (!tailMatch) {
    if (kx) {
      const kxTail = /^(.*)_KX(_.+)?$/.exec(rest);
      if (kxTail) {
        const head = kxTail[1] ?? '';
        const tail = kxTail[2] ?? '';
        const r = decomposeHead(head, { kind: 'placeholder', prefix, no: null, tail, kx: true });
        return r;
      }
    }
    // 通用 K{n}_ 前缀私货形态：K{n}_XXXX（家族名后置的推广）
    const knPrefix = /^K(\d+)_(.+)$/.exec(name);
    if (knPrefix) return { kind: 'kn', no: +knPrefix[1], rest: knPrefix[2], kx };
    return { kind: 'noid', prefix, rest, kx };
  }
  let head = tailMatch[1] ?? '';
  const no = +tailMatch[2];
  const tail = tailMatch[3] ?? '';

  return decomposeHead(head, { kind: 'ok', prefix, no, tail, kx });
}

/** head 分解：剥 MESSAGECHECK → 特殊结构 → 普通面 → DIARY 兜底 */
function decomposeHead(head, base) {
  const { prefix } = base;
  let isCheck = false;
  let checkSub = '';
  const mcIdx = head.lastIndexOf('_MESSAGECHECK');
  if (mcIdx >= 0) {
    isCheck = true;
    checkSub = head.slice(mcIdx + '_MESSAGECHECK'.length);
    checkSub = checkSub.startsWith('_') ? checkSub.slice(1) : checkSub;
    head = head.slice(0, mcIdx);
  }

  for (const { face, re } of SPECIAL_HEADS) {
    const sm = re.exec(head);
    if (sm) {
      const famRaw = sm[1] ?? '';
      const sub = (sm[2] ?? '').replace(/^_/, '');
      return { ...base, family: stripFamilyMarker(famRaw), face, sub, isCheck, checkSub };
    }
  }

  for (const face of PLAIN_FACES) {
    if (head === '_' + face) {
      return { ...base, family: '', face, sub: '', isCheck, checkSub };
    }
    if (head.endsWith('_' + face)) {
      const famRaw = head.slice(0, head.length - face.length - 1);
      return { ...base, family: stripFamilyMarker(famRaw), face, sub: '', isCheck, checkSub };
    }
  }

  if (prefix === 'DIARY') {
    return { ...base, family: stripFamilyMarker(head), face: 'DIARY', sub: '', isCheck, checkSub };
  }

  return { ...base, kind: 'noface', head };
}

/** head 里家族部分形如 `_少女之梦` / `_Deter`；剥离前导下划线；空 → '' */
function stripFamilyMarker(head) {
  if (!head) return '';
  const s = head.startsWith('_') ? head.slice(1) : head;
  return s;
}

/* ------------------------------- 扫描 ------------------------------- */

const kojoDir = path.join(root, 'ERB', '口上・メッセージ関連', '個人口上');
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.er[bm]$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = await walk(kojoDir);
const funcNames = [];
for (const f of files) {
  const buf = await fs.readFile(f);
  const text = new TextDecoder('utf-8').decode(buf);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('@')) {
      const name = t.slice(1).split(/[(\s;]/)[0];
      if (name) funcNames.push(name);
    }
  }
}
console.log('files:', files.length, '| functions:', funcNames.length);

/* ------------------------------- 统计 ------------------------------- */

const buckets = {};
const byFace = new Map();
const nofaceSamples = new Map();
const nullSamples = new Map();
const noidSamples = new Map();
let kxCount = 0;

for (const name of funcNames) {
  const r = parseKojoFunction(name);
  buckets[r.kind] = (buckets[r.kind] ?? 0) + 1;
  if (r.kx) kxCount++;
  if (r.kind === 'ok' || r.kind === 'placeholder') {
    const key = `${r.prefix || '(bare)'}|${r.face}${r.isCheck ? '+CHECK' : ''}${r.sub ? ':' + r.sub : ''}`;
    byFace.set(key, (byFace.get(key) ?? 0) + 1);
  } else if (r.kind === 'noface') {
    const norm = name.replace(/\d+/g, 'N');
    nofaceSamples.set(norm, (nofaceSamples.get(norm) ?? 0) + 1);
  } else if (r.kind === 'noid') {
    const norm = name.replace(/\d+/g, 'N');
    noidSamples.set(norm, (noidSamples.get(norm) ?? 0) + 1);
  } else if (r.kind === 'null') {
    const norm = name.replace(/\d+/g, 'N');
    nullSamples.set(norm, (nullSamples.get(norm) ?? 0) + 1);
  }
}

const total = funcNames.length;
const parsed = (buckets.ok ?? 0) + (buckets.placeholder ?? 0) + (buckets.declare ?? 0) + (buckets.beforetrain ?? 0) + (buckets.kn ?? 0);
console.log('\n=== 解析结果 ===');
console.log(buckets);
console.log(`覆盖率：${parsed}/${total} = ${((parsed / total) * 100).toFixed(2)}%`);
console.log(`KX 占位符残留：${kxCount}`);

const top = (map, n) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k, v]) => console.log(String(v).padStart(7), k));

console.log('\n=== 面分布（top 45）===');
top(byFace, 45);
console.log('\n=== noface 残留（top 30）===');
top(nofaceSamples, 30);
console.log('\n=== noid 残留（top 15）===');
top(noidSamples, 15);
console.log('\n=== null 残留（top 30）===');
top(nullSamples, 30);
