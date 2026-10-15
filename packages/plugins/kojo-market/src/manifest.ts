/**
 * `pack.json` / `index.json` 的**纯**校验（零 IO；装前全量核，一条不符就拒）。
 *
 * 规则来源 = 契约 `@kojo/plugin-api` 的 market 段（限额、正则、路径判据都住那里，
 * 本文件只把它们串成人话错误）。
 */

import {
  MARKET_PACK_KINDS,
  MARKET_SCHEMA_VERSION,
  PACK_ID_RE,
  PACK_VERSION_RE,
  SHA256_HEX_RE,
  minAppVersionSatisfied,
  packFilesProblem,
  type MarketIndex,
  type MarketIndexEntry,
  type PackKind,
  type PackManifest,
} from '@kojo/plugin-api';
import { MarketError } from '@kojo/plugin-api';

function reqString(o: Record<string, unknown>, field: string, label: string): string {
  const v = o[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new MarketError('manifest-shape', `${label}（字段 ${field}）必须是非空字符串`, field);
  }
  return v;
}

function optString(o: Record<string, unknown>, field: string): string | undefined {
  const v = o[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new MarketError('manifest-shape', `字段 ${field} 存在时必须是字符串`, field);
  }
  return v;
}

function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new MarketError('manifest-shape', `${label}必须是一个 JSON 对象`);
  }
  return v as Record<string, unknown>;
}

/** kind ∈ 三值；非法返回 null（调用方给码） */
function asPackKind(v: unknown): PackKind | null {
  return typeof v === 'string' && (MARKET_PACK_KINDS as readonly string[]).includes(v)
    ? (v as PackKind)
    : null;
}

/**
 * 装前的全量清单校验：schema / kind / id / version / 必填字段 / redistribute /
 * minAppVersion / 逐文件路径与限额。**副作用为零**（不读盘），故可单测穷举。
 */
export function parseManifest(raw: unknown, appVersion: string): PackManifest {
  const o = asRecord(raw, 'pack.json');
  if (o['schema'] !== MARKET_SCHEMA_VERSION) {
    throw new MarketError(
      'schema-version',
      `清单 schema 版本不受支持：本应用只认 ${MARKET_SCHEMA_VERSION}，包写的是 ${String(o['schema'])}`,
      String(o['schema']),
    );
  }
  const kind = asPackKind(o['kind']);
  if (kind === null) {
    throw new MarketError('kind-unknown', `包种类不认识：${String(o['kind'])}（只认 ${MARKET_PACK_KINDS.join(' / ')}）`);
  }
  const id = reqString(o, 'id', '包 id');
  if (!PACK_ID_RE.test(id)) {
    throw new MarketError('id-invalid', `包 id 不合规：${id}（要匹配 ${PACK_ID_RE.source}）`, id);
  }
  const version = reqString(o, 'version', '包版本');
  if (!PACK_VERSION_RE.test(version)) {
    throw new MarketError('version-invalid', `包版本不合规：${version}（要三段数字 x.y.z）`, version);
  }
  const name = reqString(o, 'name', '包名');
  const author = reqString(o, 'author', '作者');
  const license = reqString(o, 'license', '许可');

  if (typeof o['redistribute'] !== 'boolean') {
    throw new MarketError('manifest-shape', 'redistribute 字段必须是布尔（缺省即不合法——不许猜作者的意思）', 'redistribute');
  }
  const redistribute = o['redistribute'];
  if (!redistribute) {
    throw new MarketError(
      'redistribute-denied',
      `作者未许可二次分发，本包不装：${id} v${version}（许可 ${license}）`,
      id,
    );
  }

  const minAppVersion = reqString(o, 'minAppVersion', '最低应用版本');
  if (!PACK_VERSION_RE.test(minAppVersion)) {
    throw new MarketError('min-app-version-invalid', `minAppVersion 不合规：${minAppVersion}（要三段数字 x.y.z）`, minAppVersion);
  }
  if (!minAppVersionSatisfied(appVersion, minAppVersion)) {
    throw new MarketError(
      'app-version-too-low',
      `这个包要 ${minAppVersion} 及以上的应用才能装，你现在是 ${appVersion}——先升级编辑器再装`,
      `current=${appVersion} min=${minAppVersion}`,
    );
  }

  const filesRaw = o['files'];
  if (!Array.isArray(filesRaw)) {
    throw new MarketError('manifest-shape', 'files 必须是数组（逐文件 sha256 是唯一的校验锚，不能没有）', 'files');
  }
  const files = filesRaw.map((e, i) => {
    const f = asRecord(e, `files[${i}]`);
    const p = reqString(f, 'path', '文件路径');
    const b = f['bytes'];
    if (typeof b !== 'number' || !Number.isFinite(b)) {
      throw new MarketError('manifest-shape', `files[${i}].bytes 必须是数字`, p);
    }
    const sha = reqString(f, 'sha256', '逐文件校验锚');
    return { path: p, bytes: b, sha256: sha.toLowerCase() };
  });
  const problem = packFilesProblem(files);
  if (problem !== null) {
    throw new MarketError(problem.code, `清单里的文件条目不合法（${problem.code}）：${problem.detail}`, problem.detail);
  }

  const summary = optString(o, 'summary');
  const sourceUrl = optString(o, 'sourceUrl');
  const gameId = optString(o, 'gameId');
  const manifest: PackManifest = {
    schema: MARKET_SCHEMA_VERSION,
    kind,
    id,
    version,
    name,
    author,
    license,
    redistribute,
    minAppVersion,
    files,
  };
  if (summary !== undefined) manifest.summary = summary;
  if (sourceUrl !== undefined) manifest.sourceUrl = sourceUrl;
  if (gameId !== undefined) manifest.gameId = gameId;
  return manifest;
}

/** 索引条目是否可用（形状 + 字面约束）；不可用时返回人话原因 */
export function indexEntryProblem(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return '条目不是对象';
  const o = e as Record<string, unknown>;
  if (asPackKind(o['kind']) === null) return 'kind 不认识';
  const id = o['id'];
  if (typeof id !== 'string' || !PACK_ID_RE.test(id)) return 'id 不合规';
  const version = o['version'];
  if (typeof version !== 'string' || !PACK_VERSION_RE.test(version)) return 'version 不合规';
  const minAppVersion = o['minAppVersion'];
  if (typeof minAppVersion !== 'string' || !PACK_VERSION_RE.test(minAppVersion)) {
    return 'minAppVersion 不合规';
  }
  for (const f of ['name', 'author', 'license'] as const) {
    const v = o[f];
    if (typeof v !== 'string' || v.length === 0) return `${f} 缺失`;
  }
  const zip = o['zip'];
  if (typeof zip !== 'object' || zip === null) return 'zip 缺失';
  const z = zip as Record<string, unknown>;
  if (typeof z['url'] !== 'string' || z['url'].length === 0) return 'zip.url 缺失';
  if (typeof z['sha256'] !== 'string' || !SHA256_HEX_RE.test(z['sha256'])) return 'zip.sha256 不合规';
  const zb = z['bytes'];
  if (typeof zb !== 'number' || zb < 0) return 'zip.bytes 不合规';
  const fc = o['fileCount'];
  if (typeof fc !== 'number' || fc < 0) return 'fileCount 不合规';
  const ub = o['unpackedBytes'];
  if (typeof ub !== 'number' || ub < 0) return 'unpackedBytes 不合规';
  return null;
}

/**
 * 索引校验：整体形状不对 ⇒ `null`（调用方出声）；
 * 单条不对 ⇒ **丢掉这一条**并计数（不让一个坏包把整站打死）。
 */
export function parseIndex(raw: unknown): { index: MarketIndex | null; dropped: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { index: null, dropped: [] };
  const o = raw as Record<string, unknown>;
  if (o['schema'] !== MARKET_SCHEMA_VERSION) return { index: null, dropped: [] };
  if (typeof o['generatedAt'] !== 'string') return { index: null, dropped: [] };
  if (!Array.isArray(o['packs'])) return { index: null, dropped: [] };
  const dropped: string[] = [];
  const packs: MarketIndexEntry[] = [];
  for (const e of o['packs']) {
    const why = indexEntryProblem(e);
    if (why !== null) {
      const rawId = (e as { id?: unknown })?.id;
      dropped.push(`${typeof rawId === 'string' ? rawId : '(无 id)'}: ${why}`);
      continue;
    }
    packs.push(e as MarketIndexEntry);
  }
  return {
    index: { schema: MARKET_SCHEMA_VERSION, generatedAt: o['generatedAt'], packs },
    dropped,
  };
}
