import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  admitProjectWriteDomain,
  initialWriteDomainFact,
  isProjectWritableOf,
  redeliverProjectWriteDomain,
  writeDomainFixAction,
  writeDomainRedeliverLabel,
  writeDomainRefusedMessage,
  type AdmitProjectWriteDomainDeps,
  type WriteDomainAdmission,
} from '../src/ui/write-domain';

/**
 * 写域双份记录的**收敛判据**（WRITE-ADMIT-SPLIT 出路①，2026-10-21）。
 *
 * 现场：TS 批准记录里有这个游戏目录（早于准入门就批过），宿主准入清单里没有它
 * ⇒ `register_write_domain` 被拒、Rust 写域停在"仅应用数据目录可写"，而旧代码紧接着那行
 * `setWritable(approved !== null && !approvalMismatch)` 仍按 TS 那份把 UI 翻成"能编辑"——
 * 徽章说能写、保存按钮可点，点下去只回一句域外拒绝。**准入门是对的**，本批不放宽写域，
 * 只把 UI 的答复钉回同一个事实，并给出唯一合法出路（原生选目录框重新交付）。
 *
 * 测法照 `project-close.test.ts`：假 deps / 假 invoke，零 React、不起壳。
 */

const REFUSED_REASON = '可写范围注册拒绝：C:\\game\\某项目 未经系统目录对话框或拖放由宿主交付';
const DIR = 'C:\\game\\某项目';

interface FakeWriteDomain {
  readonly hosted?: boolean;
  readonly approvalMismatch?: boolean;
  readonly register?: (root: string) => Promise<void>;
  readonly hasApprovalRecord?: () => Promise<boolean>;
}

function makeDeps(overrides: FakeWriteDomain = {}) {
  const calls: string[] = [];
  const register = vi.fn(async (root: string) => {
    calls.push(`register:${root}`);
    await overrides.register?.(root);
  });
  const hasApprovalRecord = vi.fn(async () => {
    calls.push('read-approval-record');
    return overrides.hasApprovalRecord ? overrides.hasApprovalRecord() : true;
  });
  const redeliver = vi.fn();
  const deps: AdmitProjectWriteDomainDeps = {
    dir: DIR,
    hosted: overrides.hosted ?? true,
    approvalMismatch: overrides.approvalMismatch ?? false,
    register: (root) => register(root),
    hasApprovalRecord: () => hasApprovalRecord(),
    redeliver: () => redeliver(),
  };
  return { deps, calls, register, redeliver, hasApprovalRecord };
}

/** 假成"准入门拒了"的注册 */
const refusedRegister = async (root: string): Promise<void> => {
  throw new Error(`${REFUSED_REASON}，不在准入清单内: ${root}`);
};

function admission(overrides: FakeWriteDomain = {}): Promise<WriteDomainAdmission> {
  return admitProjectWriteDomain(makeDeps(overrides).deps);
}

describe('admitProjectWriteDomain：注册被拒 ⇒ 可写态必须退到只读（本批核心判据）', () => {
  it('宿主拒了、TS 批准记录还在 ⇒ writable=false，错误条带出路动作', async () => {
    const { deps, calls } = makeDeps({ register: refusedRegister });
    const a = await admitProjectWriteDomain(deps);

    // 顺序照旧：先登记、再读批准记录（读记录不因为被拒而跳过——needsApproval 仍要说）
    expect(calls).toEqual([`register:${DIR}`, 'read-approval-record']);
    expect(a.fact).toEqual({ dir: DIR, grant: 'refused', reason: expect.stringContaining(REFUSED_REASON) });
    expect(a.writable).toBe(false);
    expect(a.error).not.toBeNull();
    expect(a.error?.message).toContain('这个项目文件夹眼下不能写入');
    expect(a.error?.message).toContain(REFUSED_REASON);
    expect(a.error?.action?.label).toBe('重新选择这个文件夹');
    expect(a.error?.action?.title).toBe('在弹出的系统选目录框里选回这个项目文件夹，编辑器才会允许写入');
  });

  it('那颗按钮不是死按钮：run 叫得响调用方注入的执行体', async () => {
    const { deps, redeliver } = makeDeps({ register: refusedRegister });
    const a = await admitProjectWriteDomain(deps);
    a.error?.action?.run();
    expect(redeliver).toHaveBeenCalledTimes(1);
  });

  it('宿主拒了且 TS 也没有记录 ⇒ 仍然只读，同时该弹的确认照旧要弹（needsApproval）', async () => {
    const a = await admission({ register: refusedRegister, hasApprovalRecord: async () => false });
    expect(a.writable).toBe(false);
    expect(a.needsApproval).toBe(true);
    expect(a.error?.action).not.toBeNull();
  });

  it('批准记录与新提议不一致（旧判据零改动）：没被拒也要重弹确认、也只读', async () => {
    const a = await admission({ approvalMismatch: true });
    expect(a.fact.grant).toBe('granted');
    expect(a.writable).toBe(false);
    expect(a.needsApproval).toBe(true);
    expect(a.error).toBeNull();
  });

  it('注册成功 + 有批准记录 ⇒ 没有错误条、可写态照常（旧行为零改动）', async () => {
    const a = await admission();
    expect(a.fact).toEqual({ dir: DIR, grant: 'granted', reason: null });
    expect(a.writable).toBe(true);
    expect(a.needsApproval).toBe(false);
    expect(a.error).toBeNull();
  });

  it('浏览器开发壳（没有宿主这道闸）⇒ 不参与判定，照旧只看 TS 批准记录', async () => {
    const { deps, calls } = makeDeps({ hosted: false });
    const a = await admitProjectWriteDomain(deps);
    expect(calls).toEqual(['read-approval-record']); // 不发明知会失败的 IPC
    expect(a.fact.grant).toBe('not-hosted');
    expect(a.writable).toBe(true);
    expect(a.error).toBeNull();
  });

  it('非 Tauri 壳 + 无记录 ⇒ 只读且要弹确认（与搬迁前逐字同判）', async () => {
    const a = await admission({ hosted: false, hasApprovalRecord: async () => false });
    expect(a.writable).toBe(false);
    expect(a.needsApproval).toBe(true);
  });
});

describe('isProjectWritableOf：可写态的唯一判定（两份事实必须同时吃）', () => {
  it('宿主没给写域 ⇒ 批准记录再多也是 false（三态各钉一次）', () => {
    expect(isProjectWritableOf({ hasApprovalRecord: true, approvalMismatch: false, hostGrant: 'refused' })).toBe(false);
    expect(isProjectWritableOf({ hasApprovalRecord: true, approvalMismatch: false, hostGrant: 'granted' })).toBe(true);
    expect(isProjectWritableOf({ hasApprovalRecord: true, approvalMismatch: false, hostGrant: 'not-hosted' })).toBe(true);
  });

  it('宿主给了但没批过 / 批的与提议不一致 ⇒ 仍旧只读（这条不许被出路带跑）', () => {
    expect(isProjectWritableOf({ hasApprovalRecord: false, approvalMismatch: false, hostGrant: 'granted' })).toBe(false);
    expect(isProjectWritableOf({ hasApprovalRecord: true, approvalMismatch: true, hostGrant: 'granted' })).toBe(false);
    expect(isProjectWritableOf({ hasApprovalRecord: true, approvalMismatch: true, hostGrant: 'not-hosted' })).toBe(false);
  });
});

describe('redeliverProjectWriteDomain：错误条上那颗按钮的出路（对话框即授权）', () => {
  function makeRedeliver(opts: {
    picked?: string | null;
    dialogThrows?: Error;
    register?: (root: string) => Promise<void>;
    hasApprovalRecord?: () => Promise<boolean>;
  }) {
    const calls: string[] = [];
    const chooseDirectory = vi.fn(async (title: string) => {
      calls.push(`dialog:${title}`);
      if (opts.dialogThrows) throw opts.dialogThrows;
      return opts.picked === undefined ? DIR : opts.picked;
    });
    const register = vi.fn(async (root: string) => {
      calls.push(`register:${root}`);
      if (opts.register) return opts.register(root);
    });
    const hasApprovalRecord = vi.fn(async () => {
      calls.push('read-approval-record');
      return opts.hasApprovalRecord ? opts.hasApprovalRecord() : true;
    });
    const redeliver = vi.fn();
    const deps = {
      dir: DIR,
      chooseDirectory,
      register,
      hasApprovalRecord,
      approvalMismatch: false,
      redeliver: () => redeliver(),
    };
    return { deps, calls, chooseDirectory, register, redeliver };
  }

  it('作者选回这个项目文件夹 ⇒ 重新登记成功：错误清空（null 错误条）、可写态恢复', async () => {
    const { deps, calls, chooseDirectory } = makeRedeliver({});
    const a = await redeliverProjectWriteDomain(deps);

    expect(calls).toEqual([`dialog:${writeDomainRedeliverLabel}`, `register:${DIR}`, 'read-approval-record']);
    // 对话框标题与按钮同名：作者按下按钮后看到的标题就是按钮那件事
    expect(chooseDirectory).toHaveBeenCalledWith(writeDomainRedeliverLabel);
    expect(a).not.toBeNull();
    expect(a?.fact.grant).toBe('granted');
    expect(a?.error).toBeNull();
    expect(a?.writable).toBe(true);
  });

  it('取消 ⇒ 返回 null：调用方什么都不改，错误条仍在原地', async () => {
    const { deps, calls, register } = makeRedeliver({ picked: null });
    const a = await redeliverProjectWriteDomain(deps);
    expect(a).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(calls).toEqual([`dialog:${writeDomainRedeliverLabel}`]);
  });

  it('选了别的目录 ⇒ 前端不二次判定，照项目根再登记一次，仍被拒则错误条带同一颗按钮', async () => {
    const { deps } = makeRedeliver({ picked: 'C:\\game\\别的目录', register: refusedRegister });
    const a = await redeliverProjectWriteDomain(deps);
    expect(a?.fact.grant).toBe('refused');
    expect(a?.writable).toBe(false);
    expect(a?.error?.action?.label).toBe('重新选择这个文件夹');
  });

  it('重新交付成功后宿主仍不认（注册第二次也失败）⇒ 只读保持，错误文案里带着原因', async () => {
    const { deps } = makeRedeliver({ register: refusedRegister });
    const a = await redeliverProjectWriteDomain(deps);
    expect(a?.writable).toBe(false);
    expect(writeDomainRefusedMessage(a?.fact ?? initialWriteDomainFact)).toContain('这个项目文件夹眼下不能写入');
  });

  it('对话框本身坏了 ⇒ 当作"这一趟仍没交付成功"：有声、只读、出路还在', async () => {
    const { deps } = makeRedeliver({ dialogThrows: new Error('对话框起不来') });
    const a = await redeliverProjectWriteDomain(deps);
    expect(a?.fact).toEqual({ dir: DIR, grant: 'refused', reason: '对话框起不来' });
    expect(a?.writable).toBe(false);
    expect(a?.error?.action).not.toBeNull();
  });
});

describe('文案面（作者面去黑话）', () => {
  it('被拒那句话不带机制名与宿主路径 API 名', () => {
    const message = writeDomainRefusedMessage({ dir: DIR, grant: 'refused', reason: '宿主给的原因原文' });
    expect(message).toBe('这个项目文件夹眼下不能写入，只有编辑器自己的文件夹能写（备份、作者工作区、未保存快照都在那里）：宿主给的原因原文');
    expect(message).not.toContain('appDataDir');
    expect(message).not.toContain('写允许域');
  });

  it('原因缺失也成句（不把 undefined 甩到屏上）', () => {
    expect(writeDomainRefusedMessage({ dir: DIR, grant: 'refused', reason: null })).toContain('宿主没有说明原因');
  });

  it('出路动作与选目录框标题是同一句话，且只住一处', () => {
    expect(writeDomainFixAction(() => undefined).label).toBe(writeDomainRedeliverLabel);
  });
});

describe('接线面：openProject 必须走这份判定，不许再按单侧记录解锁', () => {
  const sessionSrc = (): string =>
    readFileSync(new URL('../src/ui/use-project-session.ts', import.meta.url), 'utf8');

  it('旧那句只看 TS 批准记录的 setWritable 已经消失（回归即红）', () => {
    expect(sessionSrc()).not.toContain('setWritable(approved !== null && !approvalMismatch)');
  });

  it('可写态与错误条都由同一次交付结果写（admit → apply → 出路动作）', () => {
    const src = sessionSrc();
    expect(src).toContain('admitProjectWriteDomain(');
    expect(src).toContain('setWritable(admission.writable)');
    expect(src).toContain('redeliverProjectWriteDomain(');
    // 重授权那一路也吃同一份事实：批了 TS 记录也不许把 writable 直接翻成 true。
    // SAVE-BUTTON-IO-SEAM 出路②：这份事实的存储从 hook 私有的 writeDomainRef 搬进
    // `write-domain.ts` 会话单例（写方仍只有本 hook），判定入口随之变成
    // `getSessionWriteDomainFact()`——同一份事实换了住址，不是多了第二份。
    expect(src).toContain('const hostFact = getSessionWriteDomainFact();');
    expect(src).toContain('hostGrant: hostFact.grant');
    // 写方封口：会话事实只许从 setSessionWriteDomainFact 进出，屏上不许长出第二份宿主事实
    expect(src.split('setSessionWriteDomainFact(').length - 1).toBe(3);
    expect(src).not.toContain('writeDomainRef.current');
  });
});
