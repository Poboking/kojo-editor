#!/usr/bin/env node
// 口上 XML 体检（只读、零写入）：给人看的读数工具，不是适配器。
//
// 为什么要它：口上从 .ERB 文本迁成 XML 后，两类问题会先在这层露头——
//   ① 编码：文件是 UTF-16LE+BOM，声明却写 encoding="utf-8"（BOM 才是真相，声明会骗人）；
//   ② 结构：漏闭合/错闭合（XML 解析器一报错就整份丢，而丢的是台词）。
// 先量清楚「多少份、多少条、哪几份坏」，再决定适配器怎么容错，避免拍脑袋。
//
// 口径固定五段：份数 / 条目数 / 编码分布 / 解析诊断分布 / 每角色条目数 Top10。
// 条目 = 一个 <command> 元素（新旧两种根 <data>/<kojodef> 都以它为一条口上）；
// 旧格式的台词在 <kojo> 子元素里，故额外报 <kojo> 行数，方便和条目数对账。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCorpusDir, CorpusError } from './corpus.mjs';

const ERB_DIR = 'ERB';
const KOJO_DIR = '口上';
const XML_RE = /\.xml$/i;

// 编码键序固定：打印与断言都按这个顺序，避免「同样的盘两次跑出两种排版」。
export const ENCODINGS = ['utf-8-bom', 'utf-8', 'utf-16le', 'utf-16be', 'other'];
// 诊断键序固定，语义见 diagnoseXml/readXmlFile：
//   ok            结构完整且根元素是口上格式
//   enc-mismatch  BOM 与声明不一致（能解析，但必须知道）
//   bad-structure 标签不闭合/错闭合（解析器会整份失败）
//   empty         零字节或无根元素
//   foreign-root  根元素既不是 <data> 也不是 <kojodef>（例如立绘存档）
export const DIAGNOSES = ['ok', 'enc-mismatch', 'bad-structure', 'empty', 'foreign-root'];
const KOJO_ROOTS = new Set(['data', 'kojodef']);

/** 大小写不敏感地找一个目录条目（语料盘来自 Windows，盘符/目录大小写都不可信）。 */
function findDir(dir, name) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const lower = name.toLowerCase();
  for (const ent of ents) {
    if (ent.name.toLowerCase() === lower && ent.isDirectory()) return ent.name;
  }
  return null;
}

/** 声明里的 encoding（只看文件头，够用；没有声明返回 null）。 */
export function declaredEncoding(text) {
  const head = text.slice(0, 400);
  const m = head.match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 按字节解码：**BOM 优先于声明**。
 * 真实盘上就有 9 份 UTF-16LE+BOM 却写着 encoding="utf-8" 的文件——若信声明，
 * 整份台词会变成夹 NUL 的乱码，条目数直接掉成 0，所以这里先看 BOM。
 * 无 BOM 时用 NUL 分布猜 UTF-16（XML 文本正常不含 NUL），再不行按 UTF-8。
 */
export function decodeXmlBytes(buf) {
  let encoding = 'utf-8';
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'utf-8-bom'; start = 3;
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le'; start = 2;
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be'; start = 2;
  } else {
    const probe = buf.subarray(0, Math.min(buf.length, 512));
    let evenNul = 0; let oddNul = 0;
    for (let i = 0; i < probe.length; i++) if (probe[i] === 0) (i % 2 === 0 ? evenNul++ : oddNul++);
    const half = probe.length / 2 || 1;
    if (evenNul / half > 0.3) encoding = 'utf-16be';
    else if (oddNul / half > 0.3) encoding = 'utf-16le';
  }
  const body = buf.subarray(start);
  let text;
  if (encoding === 'utf-16le') text = body.toString('utf16le');
  else if (encoding === 'utf-16be') {
    const swapped = Buffer.from(body);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    text = swapped.toString('utf16le');
  } else text = body.toString('utf8');
  return { text: text.replace(/^\uFEFF/, ''), encoding, declared: declaredEncoding(text) };
}

/** 去掉声明/注释/CDATA/DOCTYPE，只留标签与文本，避免把注释里的 `<` 当成结构错误。 */
function stripNoise(text) {
  return text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

/**
 * 标签配平（不引 XML 库：要的只是「哪份坏了、坏在哪」的读数，不是完整 DOM）。
 * 返回 clean 供计数复用；裸文本里出现 `<` 也判坏——那是畸形标签，解析器同样整份失败。
 */
export function checkStructure(text) {
  const clean = stripNoise(text);
  const stack = [];
  let root = null;
  let last = 0;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(clean))) {
    if (clean.slice(last, m.index).includes('<')) return { root, clean, ok: false, reason: '标签畸形（裸文本里出现 <）' };
    last = re.lastIndex;
    const [, close, name, , self] = m;
    if (!root && !close) root = name;
    if (close) {
      const top = stack.pop();
      if (top !== name) return { root, clean, ok: false, reason: `闭合不匹配：</${name}> 对不上 <${top ?? '无'}>` };
    } else if (!self) stack.push(name);
  }
  if (clean.slice(last).includes('<')) return { root, clean, ok: false, reason: '标签畸形（裸文本里出现 <）' };
  if (stack.length) return { root, clean, ok: false, reason: `未闭合：<${stack[stack.length - 1]}>` };
  return { root, clean, ok: true, reason: '' };
}

/** 结构判定（只看文本）：空 → 坏结构 → 非口上根 → 正常。编码不符在 readXmlFile 里补。 */
export function diagnoseXml(text) {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) return { root: null, diagnosis: 'empty', detail: '空文件', clean: '' };
  const struct = checkStructure(t);
  if (!struct.ok) return { root: struct.root, diagnosis: 'bad-structure', detail: struct.reason, clean: struct.clean };
  if (!struct.root) return { root: null, diagnosis: 'empty', detail: '无根元素', clean: struct.clean };
  if (!KOJO_ROOTS.has(struct.root)) {
    return { root: struct.root, diagnosis: 'foreign-root', detail: `根元素 <${struct.root}> 不是口上格式`, clean: struct.clean };
  }
  return { root: struct.root, diagnosis: 'ok', detail: '', clean: struct.clean };
}

const countTag = (text, name) => (text.match(new RegExp(`<\\s*${name}\\b`, 'g')) || []).length;

/** 单份文件的全部读数；诊断优先级：结构 > 根 > 编码声明（结构坏了，编码不符就不再是主要问题）。 */
export function readXmlFile(file) {
  const buf = fs.readFileSync(file);
  const { text, encoding, declared } = decodeXmlBytes(buf);
  const diag = diagnoseXml(text);
  const mismatch = diag.diagnosis !== 'empty'
    && diag.diagnosis !== 'bad-structure'
    && declared
    && ((encoding.startsWith('utf-16') && declared === 'utf-8')
      || (encoding.startsWith('utf-8') && declared.startsWith('utf-16')));
  const diagnosis = diag.diagnosis === 'ok' && mismatch ? 'enc-mismatch' : diag.diagnosis;
  const attrs = {};
  for (const a of diag.clean.matchAll(/([A-Za-z_:][\w:.-]*)\s*=/g)) attrs[a[1]] = (attrs[a[1]] || 0) + 1;
  return {
    file,
    encoding,
    declared,
    root: diag.root,
    diagnosis,
    detail: diagnosis === 'enc-mismatch' ? `BOM 是 ${encoding}，声明是 ${declared}` : diag.detail,
    parsed: diag.diagnosis === 'ok' || diagnosis === 'enc-mismatch',
    entries: countTag(diag.clean, 'command'),
    kojoLines: countTag(diag.clean, 'kojo'),
    attrs,
  };
}

/** 递归收 .xml（不跟符号链接：防环，语料盘本就无链）。 */
function listXml(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && XML_RE.test(ent.name)) out.push(p);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 扫一个游戏目录的 ERB/口上/**\/*.xml。
 * 返回全量读数（打印用 files 之外的聚合，测试直接断言聚合，不必解析中文输出）。
 * 目录不是「XML 口上形态」时 kojoDir 为 null，其余字段照旧给零值——不抛，交给调用方决定 rc。
 */
export function scanXmlKojo(dir) {
  const root = path.resolve(dir);
  const encodings = Object.fromEntries(ENCODINGS.map((k) => [k, 0]));
  const diagnoses = Object.fromEntries(DIAGNOSES.map((k) => [k, 0]));
  const base = { dir: root, kojoDir: null, fileCount: 0, entryCount: 0, kojoCount: 0, encodings, diagnoses, perChara: [], attrs: {}, files: [] };
  const erb = findDir(root, ERB_DIR);
  if (!erb) return base;
  const kojoName = findDir(path.join(root, erb), KOJO_DIR);
  if (!kojoName) return base;
  const kojoDir = path.join(root, erb, kojoName);

  const files = listXml(kojoDir).map(readXmlFile);
  const perCharaMap = new Map();
  const attrs = {};
  for (const f of files) {
    encodings[f.encoding] = (encodings[f.encoding] || 0) + 1;
    diagnoses[f.diagnosis] = (diagnoses[f.diagnosis] || 0) + 1;
    for (const [k, v] of Object.entries(f.attrs)) attrs[k] = (attrs[k] || 0) + v;
    const rel = path.relative(kojoDir, f.file);
    const seg = rel.split(path.sep);
    const chara = seg.length > 1 ? seg[0] : '(根目录)';
    const slot = perCharaMap.get(chara) || { name: chara, entries: 0, files: 0 };
    slot.entries += f.entries;
    slot.files += 1;
    perCharaMap.set(chara, slot);
  }
  const perChara = [...perCharaMap.values()]
    .sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));

  return {
    dir: root,
    kojoDir,
    fileCount: files.length,
    entryCount: files.reduce((n, f) => n + f.entries, 0),
    kojoCount: files.reduce((n, f) => n + f.kojoLines, 0),
    encodings,
    diagnoses,
    perChara,
    attrs,
    files,
  };
}

const fmt = (n) => n.toLocaleString('en-US');
const ENC_LABEL = { 'utf-8-bom': 'UTF-8 BOM', 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16LE BOM', 'utf-16be': 'UTF-16BE BOM', other: '其他' };
const DIAG_LABEL = { ok: '正常', 'enc-mismatch': '编码声明不符', 'bad-structure': '结构错误', empty: '空文件', 'foreign-root': '非口上根' };

/** 中文读数（五段固定顺序），给人看；机器读请用 scanXmlKojo 的返回值。 */
export function formatReport(r) {
  const lines = [];
  lines.push(`[xml-kojo] 体检目录 ${r.dir}`);
  if (!r.kojoDir) {
    lines.push(`  [FAIL] 没有 ERB/口上 目录——不是「XML 口上形态」，无需体检`);
    return lines.join('\n');
  }
  lines.push(`  口上目录 ${r.kojoDir}`);
  lines.push(`  份数 ${fmt(r.fileCount)} 份 XML；条目 ${fmt(r.entryCount)} 条（<command>），旧式 <kojo> 台词 ${fmt(r.kojoCount)} 行`);
  lines.push(`  编码分布：${ENCODINGS.map((k) => `${ENC_LABEL[k]} ${fmt(r.encodings[k] || 0)}`).join(' / ')}`);
  lines.push(`  解析诊断：${DIAGNOSES.map((k) => `${DIAG_LABEL[k]} ${fmt(r.diagnoses[k] || 0)}`).join(' / ')}`);
  lines.push('  每角色条目数 Top10：');
  if (r.perChara.length === 0) lines.push('    （无）');
  r.perChara.slice(0, 10).forEach((c, i) => {
    lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${c.name}  ${fmt(c.entries)} 条（${fmt(c.files)} 份）`);
  });
  const bad = r.files.filter((f) => f.diagnosis === 'bad-structure');
  if (bad.length) {
    lines.push(`  结构错误清单（${fmt(bad.length)} 份）：`);
    for (const f of bad) lines.push(`    - ${path.relative(r.dir, f.file)}：${f.detail}`);
  }
  return lines.join('\n');
}

/* CLI：
     node tools/xml-kojo-scan.mjs                 → 走 tools/corpus.mjs 解析语料目录
     node tools/xml-kojo-scan.mjs --dir <path>    → 直接指定游戏目录（不校验 CSV/）
   退出码：0 有读数 / 1 无 XML 口上形态或无语料 / 2 语料路径不成立（与 corpus.mjs 同口径）。
   只读：本脚本不写任何文件、不建临时文件。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dir');
  try {
    let dir;
    if (di >= 0) {
      const raw = argv[di + 1];
      if (!raw) { console.error('[FAIL] --dir 需要一个目录参数'); process.exit(2); }
      dir = path.resolve(raw);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`[FAIL] --dir 指向的目录不存在: ${dir}`);
        process.exit(2);
      }
    } else {
      dir = resolveCorpusDir({ print: false, label: 'xml-kojo' });
      if (!dir) {
        console.error('[FAIL] 盘上未发现符合内容条件的语料目录；请设 KOJO_CORPUS_DIR 或传 --dir <游戏目录>');
        process.exit(1);
      }
    }
    const report = scanXmlKojo(dir);
    if (!report.kojoDir) {
      console.log(formatReport(report));
      console.error(`[FAIL] ${dir} 下没有 ERB/口上 目录（不是「XML 口上形态」）；用 --dir 指到游戏根`);
      process.exit(1);
    }
    console.log(formatReport(report));
    process.exit(0);
  } catch (e) {
    console.error(`[FAIL] ${e instanceof CorpusError ? e.message : e?.stack ?? e}`);
    process.exit(2);
  }
}
