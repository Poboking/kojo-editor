import { describe, expect, it } from 'vitest';
import { packUpdateCheck, type InstalledPack, type MarketIndexEntry } from '@kojo/plugin-api';
import {
  appUpdateRelation,
  reduceUpdatePhase,
  updateFailureNote,
  updateStatus,
  UPDATE_SUBJECT,
  type UpdatePhase,
} from '../src/ui/update-check';

/**
 * MK-1 语义并一的**对拍**（不许放宽成恒真）：应用自更新这条链路与包更新那条链路，
 * 拿**同一批版本对**过一遍，三态必须逐字相同；失败态那一句必须同一张表。
 *
 * 两边的实现关系是：版本比较的唯一真源在契约（`compareVersions`，`single-source.test.ts`
 * 钉着它的定义点），关系态类型也是契约导出的那一个（`PackUpdateState`）；
 * 宿主侧的 `appUpdateRelation` / `updateFailureNote` 是**同一张表的复刻接合点**
 * （契约的 `updateRelationOf` / `makeUpdateFailure` 没进 `@kojo/plugin-api` 的出口清单，
 * `plugin-api/src/index.ts` 在本批边界外）。本文件就是把"复刻不等于漂移"钉死的地方：
 * 任何一边改口径，这里当场红。
 */

const HEX = 'a'.repeat(64);

/** 注册表那一行（版本可以 given 畸形串——正是要比"读不出"那种情形） */
const entry = (version: string): MarketIndexEntry => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version,
  name: '示例包',
  author: 'someone',
  license: 'CC-BY-NC 4.0',
  minAppVersion: '0.1.0',
  zip: { url: 'https://github.com/p/p/releases/download/v1/a.zip', sha256: HEX, bytes: 1 },
  fileCount: 1,
  unpackedBytes: 3,
});

/** 本机那条记账（同上，版本可以是畸形串） */
const local = (version: string): InstalledPack => ({
  kind: 'kojo-pack',
  id: 'demo.pack',
  version,
  name: '示例包',
  author: 'someone',
  license: 'CC-BY-NC 4.0',
  contentDigest: HEX,
  installedAt: 1,
  files: [{ path: 'files/a.erb', bytes: 3, sha256: HEX }],
});

/** 包侧那条链路的三态（走契约的 `packUpdateCheck`，不是我们自己猜的） */
const packState = (remote: string, current: string): string | undefined =>
  packUpdateCheck(entry(remote), [local(current)])?.state;

/** 宿主侧那条链路的关系态（同一把尺） */
const appState = (remote: string, current: string): string => appUpdateRelation(remote, current);

const VERSIONS = [
  '0.1.0',
  '0.1.9',
  '0.2.0',
  '0.10.0', // 逐段数值比：字典序在这里会给出相反答案
  '1.0.0',
  '0.4.0-beta.1', // 预发布后缀：两侧都必须折成核心三段
  '1.2', // 畸形：两段
  'v1.2.3', // 畸形：带前缀
  '', // 畸形：空
];

describe('MK-1 对拍：版本比较只有一把尺', () => {
  it('同一批版本对逐组过两边 ⇒ 态名逐字相同（含"读不出"那一态）', () => {
    const rows: Array<{ remote: string; current: string; pack: string | undefined; app: string }> = [];
    for (const remote of VERSIONS) {
      for (const current of VERSIONS) {
        rows.push({ remote, current, pack: packState(remote, current), app: appState(remote, current) });
      }
    }
    const drift = rows.filter((r) => r.pack !== r.app);
    // 不是"两边都别抛异常"那种空判据：每一条都给出行内容与两个读数
    expect(
      drift.map((d) => `注册表 ${d.remote} / 本机 ${d.current} ⇒ 包侧 ${String(d.pack)} 宿主侧 ${d.app}`),
    ).toEqual([]);
    // 而且判据本身确实在工作：三态与失败态都在这张表里出现过
    const seen = new Set(rows.map((r) => r.app));
    expect([...seen].sort()).toEqual(['ahead', 'failed', 'latest', 'updatable']);
    expect(rows.filter((r) => r.app === 'updatable').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.app === 'ahead').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.app === 'failed').length).toBeGreaterThan(0);
  });

  it('同一批版本对再逐组过状态机 ⇒ 给哪个态与对拍结果一致（found 态只在真"可更新"时出现）', () => {
    const checking: UpdatePhase = { kind: 'checking' };
    const phaseOf = (remote: string, current: string): string =>
      reduceUpdatePhase(checking, { type: 'checkFound', version: remote, currentVersion: current }).kind;
    expect(phaseOf('0.2.0', '0.1.0')).toBe('found');
    expect(phaseOf('0.1.0', '0.2.0')).toBe('latest');
    expect(phaseOf('0.2.0', '0.2.0')).toBe('latest');
    expect(phaseOf('0.4.0', '0.4.0-beta.1')).toBe('latest');
    expect(phaseOf('1.2', '0.1.0')).toBe('failed');
    // "比不了"绝不许演成"已是最新"，也不许给安装按钮（这两条是过去最容易被混掉的两种粉饰）
    expect(phaseOf('1.2', '0.1.0')).not.toBe('latest');
    expect(updateStatus(reduceUpdatePhase(checking, { type: 'checkFound', version: '1.2', currentVersion: '0.1.0' })))
      .not.toBeNull();
  });
});

describe('MK-1 对拍：失败态只有一套说法', () => {
  /** 取一句失败话的主干（主语之后的那一段）——两条链路必须逐字相同 */
  const grammar = (note: string): string => note.slice(note.indexOf('没有'));

  it('包侧那条链路的失败句由契约生成；宿主侧那句走同一张表（主干逐字相同）', () => {
    const packFailure = packUpdateCheck(entry('1.2'), [local('1.0.0')])?.failure;
    expect(packFailure?.stage).toBe('check');
    expect(packFailure?.note).toBeTypeOf('string');
    const appNote = updateFailureNote({ stage: 'check', reason: packFailure!.reason });
    expect(grammar(appNote)).toBe(grammar(packFailure!.note));
    // 两边都带"可重试"的承诺；主语各归各（一个是包、一个是编辑器），不互相冒充
    expect(packFailure!.note).toContain('可重试');
    expect(appNote).toContain('可重试');
    expect(appNote.startsWith(UPDATE_SUBJECT)).toBe(true);
    expect(packFailure!.note.startsWith(UPDATE_SUBJECT)).toBe(false);
  });

  it('两段失败（check / install）的动词与包侧同表；段名取值集合也与契约一致', () => {
    expect(grammar(updateFailureNote({ stage: 'check', reason: 'r' }))).toBe('没有检查成功，可重试：r');
    expect(grammar(updateFailureNote({ stage: 'install', reason: 'r' }))).toBe('没有下载安装成功，可重试：r');
    // 阶段词汇就这两个（契约 `UpdateStage` 由 `MarketIndexRefresh` 的失败分支导出，
    // 这里把它当**类型**用：新增一段而宿主侧的穷尽表没跟上，typecheck 当场红）
    const stages: Array<'check' | 'install'> = ['check', 'install'];
    expect(stages.map((s) => grammar(updateFailureNote({ stage: s, reason: '' })))).toEqual([
      '没有检查成功，可重试',
      '没有下载安装成功，可重试',
    ]);
  });

  it('病因缺省时也不是哑巴话：两段各自的常态病因都非空、都可重试', () => {
    const checking: UpdatePhase = { kind: 'checking' };
    const failedCheck = reduceUpdatePhase(checking, { type: 'checkFailed' });
    expect(updateStatus(failedCheck)?.text).toContain('可重试');
    expect(updateStatus(failedCheck)?.tone).toBe('err');
    const downloading: UpdatePhase = { kind: 'downloading', received: 1, total: 2, version: '0.2.0' };
    const failedInstall = reduceUpdatePhase(downloading, { type: 'installFailed' });
    expect(updateStatus(failedInstall)?.text).toContain('可重试');
    expect(updateStatus(failedInstall)?.tone).toBe('err');
    // 两段的话不同一段（作者得知道是"没查到"还是"查到了但没装上"）
    expect(updateStatus(failedCheck)?.text).not.toBe(updateStatus(failedInstall)?.text);
  });
});
