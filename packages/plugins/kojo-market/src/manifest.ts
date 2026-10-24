/**
 * `pack.json` / `index.json` 的**纯**校验（零 IO；装前全量核，一条不符就拒）。
 *
 * 规则来源 = 契约 `@kojo/plugin-api` 的 market 段（限额、正则、路径判据都住那里，
 * 本文件只把它们串成人话错误）。
 */

import {
  MARKET_MANIFEST_FILE,
  MARKET_PACK_KINDS,
  MARKET_SCHEMA_VERSION,
  PACK_ID_RE,
  PACK_VERSION_RE,
  SHA256_HEX_RE,
  marketCoverProblem,
  minAppVersionSatisfied,
  packFilesProblem,
  type MarketIndex,
  type MarketIndexEntry,
  type MarketRejectCode,
  type PackKind,
  type PackManifest,
  type RemoteExtractEntry,
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

/** 容器源要比的三样事实：容器整包摘要（已与索引锚对平过）+ 解出的条目清单 + 注册表那一行 */
export interface ContainerFacts {
  /** 容器本体的整包 sha256（调用方已核过它等于注册表声明的那个锚） */
  readonly sha256: string;
  readonly entries: readonly RemoteExtractEntry[];
  readonly declared: MarketIndexEntry;
}

export interface ContainerProblem {
  readonly code: MarketRejectCode;
  readonly detail: string;
  /** 人话那半句（调用方拼成 MarketError 的 message） */
  readonly why: string;
}

/**
 * 容器源的**双向对平**（纯函数、零 IO）：`pack.json` 说有什么，容器就得解出什么，反过来也一样。
 *
 * 三个方向各自的失败模式不同，缺一维就留了个洞：
 * - 清单声明、容器没解出来 ⇒ 装完的包少文件（`entry-missing`）；
 * - 容器解出来、清单没声明 ⇒ 落点里躺着没人核对过的东西（`entry-extra`）：它**不会**被
 *   `installLocalDir` 那条复制路径写进落点，所以"看起来没事"正是它危险的地方——
 *   有人往容器里塞一个 pack.json 没声明的文件，注册表与本机就此对不上账；
 * - 同一份路径两边都有但字节数不同 ⇒ 内容与清单说的不是同一份东西（`entry-bytes`）。
 *
 * 根 `pack.json` 是**元数据**而不是内容条目（清单自己的那一行），所以它是唯一允许出现在
 * 容器里而不出现在 `files[]` 中的路径 —— Rust 的条目闸刻意不判 `files/` 前缀，正是为了
 * 让它进来（内容口径归本函数）。路径必须在 `files/` 之内这件事已由 `packFilesProblem`
 * 在 `parseManifest` 里核过，这里不重述（不出现第二份校验实现）。
 *
 * 顺带核容器身份：注册表那条说 `kind/id/version`，容器里的 pack.json 必须逐字一致——
 * 落点是按**清单**派生的，两者不一致时空有注册表那行会指着别处。
 */
export function packContainerProblem(manifest: PackManifest, facts: ContainerFacts): ContainerProblem | null {
  const d = facts.declared;
  if (manifest.kind !== d.kind || manifest.id !== d.id || manifest.version !== d.version) {
    return {
      code: 'container-identity',
      detail: `container=${manifest.kind}/${manifest.id}@${manifest.version} index=${d.kind}/${d.id}@${d.version}`,
      why: `容器里的 pack.json 写的是 ${manifest.kind}/${manifest.id} v${manifest.version}，注册表那一行说的是 ${d.kind}/${d.id} v${d.version}——不是同一个包`,
    };
  }
  const byPath = new Map<string, number>();
  for (const e of facts.entries) {
    if (byPath.has(e.path)) {
      return { code: 'entry-duplicate', detail: e.path, why: `容器里同一个路径出现两次：${e.path}` };
    }
    byPath.set(e.path, e.bytes);
  }
  for (const f of manifest.files) {
    const got = byPath.get(f.path);
    if (got === undefined) {
      return { code: 'entry-missing', detail: f.path, why: `清单声明了 ${f.path}，容器里没解出来` };
    }
    if (got !== f.bytes) {
      return {
        code: 'entry-bytes',
        detail: f.path,
        why: `${f.path} 清单声明 ${f.bytes}B，容器里解出 ${got}B`,
      };
    }
  }
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const e of facts.entries) {
    if (e.path === MARKET_MANIFEST_FILE || declared.has(e.path)) continue;
    return {
      code: 'entry-extra',
      detail: e.path,
      why: `容器里解出了 ${e.path}，清单却没有声明它`,
    };
  }
  return null;
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
  // 封面（R3 additive）：**不在这里整条毙**。缺席 = 合法；在册但不合格 ⇒ 由 `parseIndex`
  // 去掉 `cover` 照常收条、并记进 `coverIgnored` 出声（装饰字段没有让一个包蒸发的权力）。
  return null;
}

/**
 * 索引校验：整体形状不对 ⇒ `null`（调用方出声）；
 * 单条不对 ⇒ **丢掉这一条**并计数（不让一个坏包把整站打死）。
 *
 * 封面是**例外**（组长判，R3 交回时改的口径）：它只是装饰，坏链接不该有让一个包从列表里
 * 蒸发的权力——注册表里一个 `http://` 缩略图就把别人的作品整条藏掉，罚错了对象也修不好
 * （消费侧改不了发布方的索引）。所以这里只**丢字段、不丢包**，并单列 `coverIgnored` 出声
 * （铁律 4 要的是"不许静默"，不是"一律整条毙")。
 */
export function parseIndex(raw: unknown): {
  index: MarketIndex | null;
  dropped: string[];
  /** 封面链接不合规 ⇒ 该条去掉 cover 照常列出，id + 原因记在这里 */
  coverIgnored: string[];
} {
  const nothing = { index: null, dropped: [], coverIgnored: [] } as const;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...nothing };
  const o = raw as Record<string, unknown>;
  if (o['schema'] !== MARKET_SCHEMA_VERSION) return { ...nothing };
  if (typeof o['generatedAt'] !== 'string') return { ...nothing };
  if (!Array.isArray(o['packs'])) return { ...nothing };
  const dropped: string[] = [];
  const coverIgnored: string[] = [];
  const packs: MarketIndexEntry[] = [];
  for (const e of o['packs']) {
    const why = indexEntryProblem(e);
    if (why !== null) {
      const rawId = (e as { id?: unknown })?.id;
      dropped.push(`${typeof rawId === 'string' ? rawId : '(无 id)'}: ${why}`);
      continue;
    }
    const entry = e as MarketIndexEntry;
    if (entry.cover !== undefined) {
      const coverWhy = marketCoverProblem(entry.cover);
      if (coverWhy !== null) {
        coverIgnored.push(`${entry.id}: ${coverWhy}`);
        const sanitized: MarketIndexEntry = { ...entry };
        delete sanitized.cover;
        packs.push(sanitized);
        continue;
      }
    }
    packs.push(entry);
  }
  return {
    index: { schema: MARKET_SCHEMA_VERSION, generatedAt: o['generatedAt'], packs },
    dropped,
    coverIgnored,
  };
}
