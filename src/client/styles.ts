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
  '',
  '/* ==================== 候选输入框（combobox） ==================== */',
  '/* head/输入框/徽章对齐官方 SettingsValueField 的观感（13px label、36px 输入、',
  '   pill 徽章）；面板本体是官方 MenuSurface + MenuItemButton，样式随宿主。 */',
  '.wk-field {',
  '  display: flex; flex-direction: column; gap: 6px; padding: 12px 0;',
  '}',
  '.wk-combo-head { display: flex; align-items: center; gap: 8px; }',
  '.wk-combo-label {',
  '  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;',
  '  color: var(--dsw-alias-label-primary);',
  '}',
  '.wk-combo-badges { display: inline-flex; align-items: center; gap: 8px; }',
  '.wk-combo-badge {',
  '  white-space: nowrap; background: var(--dsw-alias-bg-module-platform);',
  '  color: var(--dsw-alias-label-secondary); border-radius: 999px;',
  '  padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px;',
  '}',
  '.wk-combo-reset {',
  '  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary);',
  '  cursor: pointer; background: none; border: none; padding: 0;',
  '}',
  '.wk-combo-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }',
  '.wk-combo { position: relative; display: flex; align-items: center; gap: 4px; }',
  '.wk-combo-input {',
  '  flex: 1; min-width: 0; min-height: 36px; padding: 0 12px;',
  '  border: .5px solid var(--dsw-alias-border-l4); border-radius: 8px;',
  '  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);',
  '  font: inherit; font-size: 13px; line-height: 1.5; box-sizing: border-box;',
  '}',
  '.wk-combo-input:focus-visible {',
  '  outline: none; border-color: var(--dsw-alias-state-business-primary);',
  '}',
  '.wk-combo-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }',
  '.wk-combo-btn {',
  '  width: 24px; height: 24px; flex: none; padding: 0;',
  '  display: inline-flex; align-items: center; justify-content: center;',
  '  background: none; border: none; border-radius: 6px; cursor: pointer;',
  '  color: var(--dsw-alias-label-tertiary);',
  '}',
  '.wk-combo-btn:hover:not(:disabled) { color: var(--dsw-alias-label-secondary); }',
  '.wk-combo-btn:disabled { opacity: .4; cursor: default; }',
  '.wk-combo-list {',
  '  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;',
  '  max-height: 260px; overflow-y: auto; display: flex; flex-direction: column;',
  '}',
  '.wk-combo-item {',
  '  display: flex; align-items: center; justify-content: space-between; gap: 12px;',
  '  min-width: 0; flex: 1;',
  '}',
  '.wk-combo-itemLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.wk-combo-status {',
  '  margin: 0; padding: 8px 12px; font-size: 12px;',
  '  color: var(--dsw-alias-label-tertiary);',
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
