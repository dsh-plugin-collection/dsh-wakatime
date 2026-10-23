/**
 * 设置字段的草稿 ↔ 存储值转换（官方 `SettingsFormModel` 的 `SettingsFieldSpec`）。
 *
 * 本模块保持零运行时依赖（类型 import 会被 esbuild 剥离，vitest 的 node 环境
 * 也无法解析 primitives 的运行时 require）：三个工厂复刻官方
 * `settingsTextField` / `settingsNumberField` 的语义，并给数值字段补上
 * min/max 区间——越界的草稿 parse 返回 undefined，表单据此阻塞保存并保留
 * 草稿（与官方 web-search 对 count 字段 1–50 的自定义 parse 同款做法）。
 *
 * 布尔字段没有官方工厂：卡片用 Switch 呈现，草稿仍是文本形态
 * （'true' / 'false'），由 spec 在读写两端做布尔转换；空/缺失的存储值
 * 显示为关（仅显式 true 视为开，与旧 select 行为一致）。
 * @module dsh-wakatime/client/field-specs
 */

import type { SettingsFieldSpec, SettingsFieldWrite } from '@deepseek-ai/dsh-client-ui-primitives';

/** 存储值 → 草稿文本：null/undefined 渲染为空串，其余 String()。 */
function formatScalar(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 自由文本字段：空白草稿 = clear（保存后回退组合层/默认值），其余草稿原样写入。
 * 与官方 `settingsTextField` 语义一致。
 */
export function textField(field: string): SettingsFieldSpec {
  return {
    field,
    format: formatScalar,
    parse: (text: string): SettingsFieldWrite | undefined =>
      text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text },
  };
}

/**
 * 整数字段（可选闭区间 min/max）：空白草稿 = clear；非整数或越界的草稿返回
 * undefined——表单据此把字段标为 invalid 并阻塞保存，而不是改写用户输入。
 */
export function numberField(field: string, min?: number, max?: number): SettingsFieldSpec {
  return {
    field,
    format: formatScalar,
    parse: (text: string): SettingsFieldWrite | undefined => {
      const raw = text.trim();
      if (raw === '') return { kind: 'clear' };
      if (!/^-?\d+$/.test(raw)) return undefined;
      const value = Number(raw);
      if (min !== undefined && value < min) return undefined;
      if (max !== undefined && value > max) return undefined;
      return { kind: 'set', value };
    },
  };
}

/**
 * 布尔字段：存储值渲染为 'true' / 'false' 文本（未设置 = 'false'，仅显式
 * true 视为开）；草稿只接受这两个字面量，其余一律 invalid。Switch 控件
 * 切换时由卡片 stage 'true' / 'false'，保存经同一个原子 mutate 落盘。
 */
export function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value: unknown): string => (value === true || value === 'true' ? 'true' : 'false'),
    parse: (text: string): SettingsFieldWrite | undefined =>
      text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  };
}
