/**
 * WakaTime 设置卡片样式表。
 *
 * 表单本体（字段、输入框、覆盖徽章、保存按钮、页脚）全部由官方
 * `dsh-client-ui-primitives` 的 SettingsForm / SettingsValueField /
 * SettingsSecretField / Switch 渲染并自带样式，**插件不再覆写**。这里只保留
 * 官方组件没覆盖的两块自有内容，且形状对齐官方网页搜索插件的最小定制
 * （feature/toggleRow/hint）：
 *  - section 分组标题（13px/600，分组间距 16px）；
 *  - 布尔开关行与「在设置中显示」行（label 左 + Switch 右，说明常驻）。
 * 类名统一 wk- 前缀；幂等注入，卸载移除。
 * @module dsh-wakatime/client/styles
 */

export const STYLE_ID = 'dsh-wakatime-styles';

const COMPONENTS = [
  '/* ==================== Section 分组 ==================== */',
  '.wk-section {',
  '  padding: 16px 0;',
  '}',
  '.wk-section-heading {',
  '  margin: 0 0 4px; font-size: 13px; font-weight: 600; line-height: 1.5;',
  '  color: var(--dsw-alias-label-primary);',
  '}',
  '.wk-section-fields {',
  '  display: flex; flex-direction: column;',
  '}',
  '',
  '/* ==================== 开关行（布尔字段 + 在设置中显示） ==================== */',
  '/* 对齐官方 web-search 卡片的 feature/toggleRow/hint 形状。 */',
  '.wk-feature {',
  '  gap: 6px; display: grid;',
  '}',
  '.wk-toggle-row {',
  '  color: var(--dsw-alias-label-primary);',
  '  justify-content: space-between; align-items: flex-start; gap: 16px;',
  '  font-size: 13px; line-height: 1.5;',
  '  display: flex;',
  '}',
  '.wk-hint {',
  '  color: var(--dsw-alias-label-tertiary); margin: 0;',
  '  font-size: 12px; line-height: 1.5;',
  '}',
].join('\n');

export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => undefined;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wakatime';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
