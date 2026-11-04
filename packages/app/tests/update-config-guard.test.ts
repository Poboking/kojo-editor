/**
 * 发标链路静态守卫（UPD-C 车 · 2026-11-05）。
 *
 * 自动更新是一条三节链：`tauri.conf.json` 的 updater 配置（信任根 + 下载源 + 产物开关）
 * → `.github/workflows/release.yml` 的签名 env 与 latest.json 产出 → `capabilities/default.json`
 * 的 updater 调用权限。这条链的险处在于：**任何一格松掉都不会当场报错**——
 *  - pubkey / 签名密钥忘配 ⇒ 发版照样出产物，只是**无签名**；已装客户端验签失败，
 *    那个版本从此谁都更不动，还占着 latest 通道；
 *  - endpoint 退回 http ⇒ 更新包可被中间人整包替换（比"更不动"更糟）；
 *  - prerelease 判定行丢了 ⇒ `v0.4.3-beta.1` 被当正式版发，抢走 `releases/latest`
 *    的稳定自动更新通道（stable 用户直接"升级"到 beta）；
 *  - includeUpdaterJson 丢了 ⇒ 已装客户端没有清单可拉，静默停在旧版；
 *  - capability 漏了 `updater:default` ⇒ 前端检查/下载全部被权限层拒绝。
 * 等用户报"更新不了"再回查就晚了，所以钉成读文件的静态判据：改这三份文件的人，
 * 跑到这个文件当场看红线。读数口径同 `shell-notice-density.test.ts`：路径走
 * `new URL(..., import.meta.url)`（中文路径的 checkout 上硬编码盘符必红）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 只取本守卫关心的格子，多出的字段不关心（配置文件本身归 Tauri schema 管） */
interface TauriUpdaterConf {
  pubkey?: string;
  endpoints?: unknown;
  windows?: { installMode?: string };
}
interface TauriConfShape {
  bundle?: { targets?: unknown; createUpdaterArtifacts?: boolean };
  plugins?: { updater?: TauriUpdaterConf };
}
interface CapabilitiesShape {
  permissions?: string[];
}

const tauriConf = JSON.parse(read('../src-tauri/tauri.conf.json')) as TauriConfShape;
const releaseYml = read('../../../.github/workflows/release.yml');
const capabilities = JSON.parse(read('../src-tauri/capabilities/default.json')) as CapabilitiesShape;

describe('tauri.conf.json · updater 插件块（发标链的源头配置）', () => {
  const updater = tauriConf.plugins?.updater;

  it('插件块在位：pubkey 非空（信任根丢了 = 全部产物验签必败，静默且致命）', () => {
    expect(updater, 'updater 插件块没了 ⇒ 客户端没有更新配置可读，自动更新整条链失效').toBeDefined();
    expect(
      typeof updater?.pubkey === 'string' && updater.pubkey.trim().length > 0,
      'updater.pubkey 空了 ⇒ 发出去的产物没有信任根，客户端验签必败；这条守卫防"忘配密钥还照常发版"',
    ).toBe(true);
  });

  it('endpoints 非空且全部 https://（http 更新源 = 安装包可被中间人整包替换）', () => {
    const endpoints = updater?.endpoints;
    expect(
      Array.isArray(endpoints) && endpoints.length > 0,
      'updater.endpoints 空了 ⇒ 客户端不知道去哪拉 latest.json，静默停在旧版',
    ).toBe(true);
    const insecure = (endpoints as unknown[]).filter(
      (u) => !(typeof u === 'string' && u.startsWith('https://')),
    );
    expect(
      insecure,
      `这些 endpoint 不是 https：${JSON.stringify(insecure)}；更新源退回 http = 安装包可被中间人替换，这条守卫防"顺手加了条内网 http 源还留在生产配置里"`,
    ).toEqual([]);
  });

  it('createUpdaterArtifacts === true 且 bundle.targets 含 nsis（不产出签名产物 = 客户端无更新可拉）', () => {
    expect(
      tauriConf.bundle?.createUpdaterArtifacts,
      'createUpdaterArtifacts 关了 ⇒ 发版不再产出 latest.json / 签名包，已装客户端没有更新清单可拉；这条守卫防"打包配置重构时顺手把 updater 产物关掉"',
    ).toBe(true);
    expect(
      Array.isArray(tauriConf.bundle?.targets) && (tauriConf.bundle?.targets as unknown[]).includes('nsis'),
      'bundle.targets 里没有 nsis ⇒ Windows 用户没有安装包，updater 产物也没了着落（本仓只发 Windows）',
    ).toBe(true);
  });

  it('windows.installMode ∈ {passive, basicUi}（静默更新不许弹出交互向导打断作者）', () => {
    // Tauri v2 的 NSIS 安装模式枚举是 passive / basicUi / quiet；'basic' 是任务书的简写，
    // 落到配置枚举就是 basicUi。quiet（完全无界面）不收：更新装了什么、走到哪一步，
    // 作者至少要有一眼可看的进度（passive 的进度条就是这层底线）。
    const mode = updater?.windows?.installMode;
    expect(
      mode === 'passive' || mode === 'basicUi',
      `windows.installMode = ${JSON.stringify(mode)}，只许 passive（进度条免交互）或 basicUi（极简界面）；弹完整安装向导会打断正在写作的作者，quiet 则连进度都看不见`,
    ).toBe(true);
  });
});

describe('release.yml · 签名 env 与 updater 清单产物（发标日的事故都在这）', () => {
  // 险处：TAURI_SIGNING_PRIVATE_KEY 是 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 的前缀——
  // 裸 toContain 会被 PASSWORD 那行喂假绿，所以 env 名要用「后面跟冒号 / secrets. 引用」钉。
  it('两个签名 env 都在且都真接线到 secrets（忘配 = 静默出无签名产物，整版更不动）', () => {
    expect(
      releaseYml,
      'release.yml 里没有 TAURI_SIGNING_PRIVATE_KEY: 这行 env ⇒ tauri-action 拿不到私钥，静默产出无签名包；这条守卫防"忘配密钥 → 无签名产物上 latest 通道"',
    ).toMatch(/^\s*TAURI_SIGNING_PRIVATE_KEY(?!_PASSWORD):\s*\S/m);
    expect(
      releaseYml,
      'TAURI_SIGNING_PRIVATE_KEY env 在、但没引用 secrets.TAURI_SIGNING_PRIVATE_KEY ⇒ 拿到的是空串，产物照样无签名（半接线也是没接线）',
    ).toMatch(/secrets\.TAURI_SIGNING_PRIVATE_KEY(?!_PASSWORD)\b/);
    expect(
      releaseYml,
      'release.yml 里没有 TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 这行 env ⇒ 私钥有密码时解不开，同样静默出不了签名',
    ).toMatch(/^\s*TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\S/m);
    expect(
      releaseYml,
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD env 在、但没引用同名 secret ⇒ 同样是半接线',
    ).toMatch(/secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\b/);
  });

  it('includeUpdaterJson: true（latest.json 不产出 = 已装客户端没有清单可拉）', () => {
    expect(
      releaseYml,
      'includeUpdaterJson 不见了或不是 true ⇒ tauri-action 不上传 latest.json，自动更新通道整条断；这条守卫防"改 release 步骤时把清单产出顺手丢了"',
    ).toMatch(/includeUpdaterJson:\s*true/);
  });

  it('prerelease 判定行在位：ref_name 含 "-" 即 prerelease（beta 不抢 stable 通道的判据）', () => {
    expect(
      releaseYml,
      "prerelease 判定行丢了 ⇒ v0.4.3-beta.1 这类带 '-' 的标签被当正式版发，抢走 releases/latest 的稳定通道，stable 用户会被「升级」到 beta；这条守卫钉的就是 contains(github.ref_name, '-') 这行",
    ).toMatch(/prerelease:\s*\$\{\{\s*contains\(github\.ref_name,\s*'-'\)\s*\}\}/);
  });
});

describe('capabilities/default.json · updater 权限（最后一格：前端能不能调到）', () => {
  it('permissions 含 updater:default（漏了 = 检查/下载/安装全部被权限层拒绝）', () => {
    expect(
      capabilities.permissions ?? [],
      'capabilities 里没有 updater:default ⇒ 前端 invoke updater 插件全被拒，自动更新在前端就是哑的（配置面看着全对、功能面全死，最难排查的那种）',
    ).toContain('updater:default');
  });
});
