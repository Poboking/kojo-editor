/**
 * 适配器清单的结构化读取（清单 = 组合根的**唯一身份表**）。
 *
 * 为什么需要它：`tools/kojo-conformance.mjs` 的 `language` 子命令过去把
 * `LANGUAGE_ADAPTER_ENTRIES` 写死成 `{ eratw, erafl, demo }`——新增一个方言包，conformance
 * 仍然只认那三枚（`--adapter <新 id>` 报「未知 adapter」）。清单本来就已经有 `id` / `dir` /
 * `kojo2AdapterExport` / `kojo2BackendFactoryExport` 四个字段，conformance 没有任何理由
 * 另抄一份。
 *
 * 读取口径（与 `tools/adapter-manifest-words.mjs` 的 auditWord 读取同一条纪律）：
 * **fail-closed**——清单读不到、条目形状缺字段，一律抛错，绝不「读不到就当没有」。
 *
 * 解析走**字符扫描**而不是一行正则：条目里可以有注释、可以有 `load: () => import('…')`，
 * 用「花括号配对 + 跳过字符串/注释」一种规则把每个对象块切出来，再逐字段取字面量。
 * 只认 `'…'` 单引号字面量（清单的写法），别的一律算缺失。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 清单文件（相对仓库根） */
export const MANIFEST_REL = 'packages/app/src/adapter-manifest.ts';

/** 清单条目里我们关心的字段（顺序 = 报告序，不参与判据） */
const ENTRY_FIELDS = ['id', 'dir', 'packageName', 'factory', 'scope', 'auditWord'];

/**
 * 从清单源码里切出 `ADAPTER_MANIFEST = [ … ]` 的每个顶层对象块。
 *
 * 判据：字符串（' " `）与注释（// 与 /* *\/）里的花括号不算数；数组在深度 0 结束。
 * 返回的是**块原文**（含花括号），调用方自己取值。
 */
export function extractManifestBlocks(source) {
  const anchor = source.indexOf('ADAPTER_MANIFEST');
  if (anchor < 0) throw new Error(`${MANIFEST_REL} 里找不到 ADAPTER_MANIFEST`);
  // 从**赋值号之后**找 `[`：`ADAPTER_MANIFEST: readonly AdapterManifestEntry[] = [` 里
  // 类型标注自带一对空方括号，先拿到它会切出空数组。
  const assign = source.indexOf('=', anchor);
  if (assign < 0) throw new Error(`${MANIFEST_REL} 的 ADAPTER_MANIFEST 没有赋值号`);
  const open = source.indexOf('[', assign);
  if (open < 0) throw new Error(`${MANIFEST_REL} 的 ADAPTER_MANIFEST 不是数组字面量`);

  const blocks = [];
  let depth = 0;
  let blockStart = -1;
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(blockStart, i + 1));
        blockStart = -1;
      }
      i += 1;
      continue;
    }
    if (ch === ']' && depth === 0) break;
    i += 1;
  }
  if (depth !== 0) throw new Error(`${MANIFEST_REL} 的 ADAPTER_MANIFEST 花括号不配对（读到文件尾仍有未闭合块）`);
  return blocks;
}

/** 跳过一段字符串字面量，返回右引号之后的位置（转义按反斜杠吃两字符） */
function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/** 取一个字段的单引号字面量（行首锚定：注释里提到同名字段不误伤） */
function readField(block, name) {
  const re = new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'm');
  const match = block.match(re);
  return match === null ? undefined : match[1];
}

/** 把块原文解析成条目（缺字段 = 抛错，不猜） */
function parseEntry(block, index) {
  const entry = {};
  const missing = [];
  for (const field of ENTRY_FIELDS) {
    const value = readField(block, field);
    if (value === undefined) missing.push(field);
    else entry[field] = value;
  }
  if (missing.length > 0) {
    throw new Error(`清单第 ${index + 1} 个条目缺字段：${missing.join(', ')}（清单块原文：${block.trim().slice(0, 160)}）`);
  }
  // 三个可选字段：conformance 只认「两面都声明了」的条目，其余照旧跳过
  const adapterExport = readField(block, 'kojo2AdapterExport');
  const backendExport = readField(block, 'kojo2BackendFactoryExport');
  if (adapterExport !== undefined) entry.kojo2AdapterExport = adapterExport;
  if (backendExport !== undefined) entry.kojo2BackendFactoryExport = backendExport;
  return Object.freeze(entry);
}

/**
 * 清单源码 → 条目数组（**顺序 = 注册序**，不排序）。
 *
 * 空清单也抛：`ADAPTER_MANIFEST` 空掉等于「所有项目都无适配器」，这不该静默通过。
 */
export function extractAdapterEntries(source) {
  const blocks = extractManifestBlocks(source);
  if (blocks.length === 0) throw new Error(`${MANIFEST_REL} 的 ADAPTER_MANIFEST 是空数组`);
  return blocks.map(parseEntry);
}

/** 读清单 → 条目数组（读不到就抛） */
export function manifestAdapterEntries(root) {
  const file = path.join(root, MANIFEST_REL);
  return extractAdapterEntries(readFileSync(file, 'utf8'));
}
