import { describe, expect, it } from 'vitest';
import { buildProjectSettingsPatch, deleteProjectConfirm, projectSettingsInitial } from '../src/project-settings';

/**
 * 项目删除 / 项目设置纯函数（P0-7b）。
 *
 * 钉三件事：删除确认层必须点名项目且说清"连目录一起删、不可恢复"；
 * 设置表单初值只认既有 meta 键；patch 组装**未改动 / 空值一律不写**。
 * 项目名重名校验复用重命名批的 `projectNameProblem`（由 project-actions 测试覆盖）。
 */

describe('deleteProjectConfirm · 删除确认文案', () => {
  it('正文含项目名与「连同文件夹内全部内容一起删除，且不可恢复」', () => {
    const copy = deleteProjectConfirm('0.4beta合集-宇佐见 堇子');
    expect(copy.body).toContain('0.4beta合集-宇佐见 堇子');
    expect(copy.body).toContain('连同文件夹内全部内容一起删除，且不可恢复');
    expect(copy.confirmLabel).toBe('删除');
    expect(copy.cancelLabel).toBe('取消');
  });

  it('项目名空白时退回「这个项目」，不让引号空着', () => {
    const copy = deleteProjectConfirm('   ');
    expect(copy.body).toContain('「这个项目」');
  });
});

describe('projectSettingsInitial · 设置表单初值', () => {
  it('读取既有 meta.author / meta.version（字符串）', () => {
    const initial = projectSettingsInitial({
      name: '作品',
      meta: { author: '某作者', version: '1.2' },
    });
    expect(initial).toMatchObject({ name: '作品', author: '某作者', version: '1.2' });
  });

  it('缺键 / 类型不符按未填处理（不把坏值洗成字符串），meta 是浅拷贝', () => {
    const meta = { other: 42, author: 1, version: null };
    const initial = projectSettingsInitial({ name: '作品', meta });
    expect(initial.author).toBe('');
    expect(initial.version).toBe('');
    expect(initial.meta.other).toBe(42);
    expect(initial.meta).not.toBe(meta);
  });
});

describe('buildProjectSettingsPatch · patch 组装与空值过滤', () => {
  const initial = () => projectSettingsInitial({ name: '旧名', meta: { author: '原作者', version: '1.0' } });

  it('未改动 ⇒ null（面板据此直接收窗，不发写请求）', () => {
    expect(
      buildProjectSettingsPatch(initial(), { name: '旧名', author: '原作者', version: '1.0' }),
    ).toBeNull();
  });

  it('改名按 trim 后写入；作者 / 版本未改不写 meta', () => {
    const patch = buildProjectSettingsPatch(initial(), {
      name: '  新名  ',
      author: '原作者',
      version: '1.0',
    });
    expect(patch).toEqual({ name: '新名' });
  });

  it('项目名留空 / 纯空白不写（不覆盖原名），其他实际改动照常写', () => {
    const patch = buildProjectSettingsPatch(initial(), { name: '  ', author: '新作者', version: '1.0' });
    expect(patch?.name).toBeUndefined();
    expect(patch?.meta).toMatchObject({ author: '新作者', version: '1.0' });
  });

  it('作者 / 版本留空或纯空白不写（本批不做「清空」）', () => {
    const patch = buildProjectSettingsPatch(initial(), { name: '旧名', author: '   ', version: '' });
    expect(patch).toBeNull();
  });

  it('只改作者时保留 meta 其余键与原版本值', () => {
    const withExtra = projectSettingsInitial({
      name: '旧名',
      meta: { author: '原作者', version: '1.0', charaName: '堇子', scriptNo: 3 },
    });
    const patch = buildProjectSettingsPatch(withExtra, {
      name: '旧名',
      author: '新作者',
      version: '1.0',
    });
    expect(patch?.meta).toEqual({
      author: '新作者',
      version: '1.0',
      charaName: '堇子',
      scriptNo: 3,
    });
    expect(patch?.name).toBeUndefined();
  });

  it('原名带首尾空白时按 trim 后比较（不产生无意义的 name 写入）', () => {
    const spaced = projectSettingsInitial({ name: ' 旧名 ', meta: {} });
    expect(buildProjectSettingsPatch(spaced, { name: '旧名', author: '', version: '' })).toBeNull();
  });
});
