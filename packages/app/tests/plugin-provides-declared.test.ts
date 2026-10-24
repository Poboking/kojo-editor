/**
 * 插件服务登记闭合闸（视觉批十一 · 组长收尾路）。
 *
 * 动因是真壳读数，不是设想：批次十三把 `erafl-adapter` 并进 dev 后，桌面壳的插件面板读到
 * **「插件 (21/22 运行中)」**，那一行下面原样摊着
 * `Error: Plugin 'erafl-adapter' called provide('kojo.xml') but did not declare it in provides[]`
 * ——`activate` 里 `ctx.provide(WellKnownServices.KojoXml, …)`，清单里却没有 `provides`。
 * 内核那道守卫是对的（依赖排序与冲突检测都按 `provides[]` 算），但**全量测试当时是全绿的**：
 * 插件自己的单测不起内核，app 侧的装配测试也不跑真实 activate。⇒ 这类洞只有静态闭合闸拦得住。
 *
 * 判据（只查一个方向，且不许静默降级）：
 *  ① 每个插件包 `src/` 里的每一枚 `ctx.provide(X, …)`，`X` 解析出的服务键必须出现在
 *     **同包**的 `provides: [...]` 清单里——漏一枚当场红（内核会在 activate 里抛同一个错，
 *     但那要等真壳跑起来才看得见，本闸把它提到 `pnpm test` 的第一秒）；
 *  ② 服务键必须**解析得动**：字面量 / `某表.成员`（表住在 plugin-api）/ 包内常量三种形态，
 *     解析不出来 = 红（闸最怕"扫了却什么都没查"，所以宁可红在解析器上）；
 *  ③ 反向（声明了却没 provide）不判红：`provides` 是多声明少实现的合法形态（条件性提供、
 *     后续批次补实现都算），钉成红会让插件为凑绿删声明，反而削掉内核排序的依据。
 *
 * 只扫 `src/`，不扫 `tests/`（测试里的假 ctx 也调 provide，扫进来是噪声）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const PLUGINS_DIR = path.join(REPO, 'packages', 'plugins');
const API_DIR = path.join(REPO, 'packages', 'plugin-api', 'src');

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const srcOf = (abs: string): string => stripComments(readFileSync(abs, 'utf8'));

/** 一个数组字面量里的条目（按逗号切，够本仓所有清单形态；注释已先剥掉） */
const arrayEntries = (body: string): string[] =>
  body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** 递归列出某目录下的 .ts 源文件（跳过 tests / node_modules） */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'tests' || ent.name === 'node_modules') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...tsFiles(abs));
    else if (ent.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const relShort = (abs: string): string => path.relative(REPO, abs).replace(/\\/g, '/').replace(/^packages\/plugins\//, '');

/**
 * plugin-api 里的服务键表（`export const WellKnownServices = { KojoXml: 'kojo.xml', … }`）。
 * 表名 → 成员 → 字符串值；解析 `WellKnownServices.KojoXml` 这类点号形态要用。
 */
function serviceTables(): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const abs of tsFiles(API_DIR)) {
    for (const m of srcOf(abs).matchAll(/export const ([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\n\}/g)) {
      const members = new Map<string, string>();
      for (const e of m[2]!.matchAll(/^\s*([A-Za-z0-9_]+)\s*(?:\?)?:\s*'([^']+)'/gm)) {
        members.set(e[1]!, e[2]!);
      }
      tables.set(m[1]!, members);
    }
  }
  return tables;
}

const TABLES = serviceTables();

/** token → 真实服务键；解析不动返回 null（由判据 ② 报红，绝不放它过去） */
function resolveKey(token: string, ownPkg: string): string | null {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(token);
  if (quoted) return quoted[2]!;
  const dotted = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(token);
  if (dotted) return TABLES.get(dotted[1]!)?.get(dotted[2]!) ?? null;
  if (!/^[A-Za-z0-9_]+$/.test(token)) return null;
  // 常量形态两处找：包内 `const X = '…'`，以及契约里的 `export const X = '…'`
  // （`MARKET_SERVICE_KEY` 就住在 plugin-api/market.ts——服务键的字面量按铁律只许在契约里出一次）
  const haystacks = [path.join(PLUGINS_DIR, ownPkg, 'src'), API_DIR];
  for (const dir of haystacks) {
    if (!existsSync(dir)) continue;
    for (const abs of tsFiles(dir)) {
      const m = new RegExp(`(?:const|let|var)\\s+${token}\\s*(?::[^=]+)?=\\s*'([^']+)'`).exec(srcOf(abs));
      if (m) return m[1]!;
    }
  }
  return null;
}

interface PackageScan {
  readonly pkg: string;
  /** 每枚 `ctx.provide(...)` 的落点与 token */
  readonly registrations: { readonly file: string; readonly token: string }[];
  /** `provides: [...]` 里的原始 token */
  readonly declaredTokens: string[];
}

function scanPackage(pkg: string): PackageScan | null {
  const pkgDir = path.join(PLUGINS_DIR, pkg, 'src');
  if (!existsSync(pkgDir)) return null;
  const registrations: { file: string; token: string }[] = [];
  const declaredTokens: string[] = [];
  for (const abs of tsFiles(pkgDir)) {
    const src = srcOf(abs);
    for (const m of src.matchAll(/\bctx\.provide\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.]+)/g)) {
      registrations.push({ file: abs, token: m[1]! });
    }
    for (const m of src.matchAll(/\bprovides:\s*\[([\s\S]*?)\]/g)) {
      declaredTokens.push(...arrayEntries(m[1]!));
    }
  }
  return { pkg, registrations, declaredTokens };
}

const SCANS = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => scanPackage(e.name))
  .filter((s): s is PackageScan => s !== null);

describe('插件服务登记闭合 · ctx.provide 的键必须在同包 provides[] 在册', () => {
  it('扫描器本身要被扫到：全仓登记点总数不许无声缩水（本批实测 13 枚）', () => {
    const total = SCANS.reduce((n, s) => n + s.registrations.length, 0);
    expect(total).toBeGreaterThanOrEqual(13);
    // 每个插件包的 provides 面都不许是空的解析结果（真源至少一枚在册键）
    expect(SCANS.some((s) => s.declaredTokens.length > 0)).toBe(true);
  });

  it('每一枚 ctx.provide 都解析得出服务键（解析器失手 = 闸形同虚设，宁可红在这里）', () => {
    const unresolved = SCANS.flatMap((s) =>
      s.registrations
        .filter((r) => resolveKey(r.token, s.pkg) === null)
        .map((r) => `${s.pkg}：${relShort(r.file)} 的 '${r.token}' 解析不出服务键`),
    );
    expect(unresolved).toEqual([]);
  });

  it('每一枚 ctx.provide 的键都在同包 provides[] 在册（erafl-adapter 漏声明那枚就是这条拦的）', () => {
    const missing: string[] = [];
    for (const s of SCANS) {
      const declared = new Set(
        s.declaredTokens.map((t) => resolveKey(t, s.pkg)).filter((k): k is string => k !== null),
      );
      for (const reg of s.registrations) {
        const key = resolveKey(reg.token, s.pkg);
        if (key === null) continue; // 上一条已报红，不重复计
        if (!declared.has(key)) {
          missing.push(`${s.pkg}：${relShort(reg.file)} 提供 '${key}'，但同包 provides[] 没有它（内核 activate 当场抛）`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
