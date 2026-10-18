/**
 * 部署到游戏目录向导（2026-10-12 口上项目批 P-E；`ui.overlay` 贡献）。
 *
 * 链路：包行「部署」按钮 → 插件把待部署请求存入闭包（**overlay 组件无 props，
 * payload 不经组件**）→ 发 `ui.overlay.open` 打开本向导 → 选目标角色
 * （新建向导 P-C 写在制品 meta 里的角色号自动预选，导入的包由用户挑）
 * → 落点预览 `<角色口上目录>/<包目录名>/` → 用户确认 → 字节级复制 → 状态条交代结果。
 *
 * 双真相源的收口就在这一步：窗口里把「工作区为权威、游戏目录只是部署目标」讲明白，
 * 并把两道前置闸门做成**看得见的状态**——游戏目录只读（未批准写权限）与
 * 目标已存在，都直接禁用按钮并说明下一步，而不是让用户点下去吃异常。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react';
import type { GameProject } from '@kojo/plugin-api';
import { resolveDeployTarget, type DeployTargetOk, type PendingDeploy } from './deploy';

/**
 * 部署向导（`ui.overlay` 贡献的组件半边）。
 *
 * overlay 的**贡献 id** 由 adapter 定义并注册——共享层只管「这个窗长什么样、
 * 点了按钮做什么」，不认任何具体游戏的命名空间。
 */

export interface DeployKojoWizardDeps {
  /** 当前游戏项目（角色表 + 口上目录来源；无项目时向导显式不可用） */
  gameProject(): GameProject | null;
  /** 落点是否在内核写白名单内（游戏目录默认只读） */
  writable(targetDir: string): boolean;
  /** 落点是否已存在（**预览用**；真正的拒绝由 `deployPackage` 的前置守卫兜底） */
  checkTargetExists(targetDir: string): Promise<boolean>;
  /** 读取待部署请求（null = 无——向导显式降级） */
  pending(): PendingDeploy | null;
  /** 清除待部署请求（完成 / 取消时） */
  clearPending(): void;
  close(): void;
  /** 发起部署（控制器负责状态条与落盘）；返回是否成功，成功即关窗 */
  deploy(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean>;
}

/** 部署向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createDeployKojoWizard(deps: DeployKojoWizardDeps): () => unknown {
  return function DeployKojoWizard(): unknown {
    const pending = deps.pending();
    const gameProject = deps.gameProject();

    const [charaNo, setCharaNo] = useState<number | null>(pending?.charaNo ?? null);
    const [exists, setExists] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);

    // 换包重新打开时回到该包自己的角色（导入的包无 meta → 回到未选）
    useEffect(() => {
      setCharaNo(pending?.charaNo ?? null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending?.absDir]);

    const target = useMemo(
      () => resolveDeployTarget(gameProject, charaNo, pending?.dirName ?? ''),
      [gameProject, charaNo, pending?.dirName],
    );
    const targetDir = target.ok ? target.targetDir : '';

    useEffect(() => {
      if (!targetDir) {
        setExists(null);
        return;
      }
      let cancelled = false;
      setExists(null);
      deps
        .checkTargetExists(targetDir)
        // 探测失败按「不存在」放行：这只是预览，真正的「不覆盖」由 deployPackage 守卫
        .catch(() => false)
        .then((v) => {
          if (!cancelled) setExists(v);
        });
      return () => {
        cancelled = true;
      };
    }, [deps, targetDir]);

    const charas = useMemo(() => {
      if (!gameProject) return [];
      return [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no);
    }, [gameProject]);

    /* ---------- 降级：无待部署请求 / 无游戏项目（不静默，各自讲清下一步） ---------- */
    if (!pending) {
      return h(
        'div',
        { className: 'wizard' },
        h('h3', null, '部署到游戏目录'),
        h('p', { className: 'dim' }, '当前没有要部署的包。请在「我的口上项目」中选择一个作者包再部署。'),
        h(
          'div',
          { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
        ),
      );
    }

    if (!gameProject) {
      return h(
        'div',
        { className: 'wizard' },
        h('h3', null, '部署到游戏目录'),
        h('p', { className: 'dim' }, '当前无打开的游戏项目。落点来自项目里的角色口上目录，请先打开项目。'),
        h(
          'div',
          { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
        ),
      );
    }

    const writable = targetDir.length > 0 && deps.writable(targetDir);

    const submit = async (): Promise<void> => {
      if (!target.ok) return;
      setBusy(true);
      const ok = await deps.deploy(pending, target);
      setBusy(false);
      if (ok) {
        deps.clearPending();
        deps.close();
      }
    };

    const cancel = (): void => {
      deps.clearPending();
      deps.close();
    };

    return h(
      'div',
      { className: 'wizard' },
      h('h3', null, '部署到游戏目录'),

      // 源（只读展示）
      h(
        'div',
        { className: 'wizard-preview' },
        h(
          'div',
          null,
          h('span', { className: 'wizard-label' }, '工作区包'),
          h('code', null, pending.absDir),
        ),
        h('div', { className: 'dim' }, '部署 = 把这一份副本写进游戏目录；工作区仍是权威，改回来请改工作区。'),
      ),

      // 目标角色（meta 里有就预选）
      h(
        'label',
        { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '目标角色'),
        h(
          'select',
          {
            value: charaNo === null ? '' : String(charaNo),
            onChange: (e: { target: { value: string } }) =>
              setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
          },
          h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
          charas.map((c) =>
            h(
              'option',
              { key: c.no, value: String(c.no) },
              c.kojoDir ? `#${c.no} ${c.name}` : `#${c.no} ${c.name}（无口上目录）`,
            ),
          ),
        ),
      ),

      // 落点预览 / 无法解析的原因
      h(
        'div',
        { className: 'wizard-preview' },
        h(
          'div',
          null,
          h('span', { className: 'wizard-label' }, '落点'),
          h('code', null, target.ok ? target.targetDir : '—'),
        ),
        !target.ok ? h('div', { className: 'wizard-warn' }, target.reason) : null,
      ),

      // 两道前置闸门：可见的状态，而不是等用户点下去吃异常
      target.ok && !writable
        ? h(
            'div',
            { className: 'wizard-warn' },
            '游戏目录当前只读：请先在项目视图批准该角色口上目录的写权限，再回来部署。',
          )
        : null,
      target.ok && writable && exists === true
        ? h(
            'div',
            { className: 'wizard-warn' },
            '目标目录已存在：部署不会覆盖。请先在游戏目录里移除或改名，或换个包名再部署。',
          )
        : null,
      target.ok && writable && exists === null
        ? h('div', { className: 'dim' }, '正在确认目标是否已存在…')
        : null,

      // 动作
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: cancel, disabled: busy }, '取消'),
        h(
          'button',
          {
            className: 'small primary',
            // 写权限没批 / 目标已存在 / 落点无法解析 → 禁用，且上面已说明下一步
            disabled: !target.ok || busy || !writable || exists !== false,
            onClick: () => void submit(),
          },
          busy ? '部署中…' : '部署到游戏目录',
        ),
      ),
    );
  };
}
