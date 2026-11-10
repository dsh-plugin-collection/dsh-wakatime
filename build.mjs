/**
 * 构建脚本：
 *  1. tsc 编译 host 端（src/ → lib/，tsconfig.json 已排除 src/client）
 *  2. esbuild 打包 client 端单文件并包进 __ModuleLoader__.load 模板
 * 产物：lib/index.js（host）+ lib/client.js（浏览器端）
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { build } from 'esbuild';

// 1. host 端：tsc
// 用本地二进制而不是 `npx tsc`：npx 在依赖缺失时不会报错，而是去 registry
// 装一个同名的废弃包 `tsc@2.0.4`（它只会打印一句 "This is not the tsc command
// you are looking for"），于是「构建环境没装 typescript」被伪装成一次成功构建，
// lib/ 留在上一次的状态里。本地路径缺失就当场失败，这才是想要的信号。
const localTsc = process.platform === 'win32' ? 'node_modules/.bin/tsc.cmd' : 'node_modules/.bin/tsc';
if (!existsSync(localTsc)) {
  console.error(`构建失败：找不到 ${localTsc}。请先执行 pnpm install（typescript 是声明在案的 devDependency）。`);
  process.exit(1);
}
execSync(`"${localTsc}" -p tsconfig.json`, { stdio: 'inherit' });

// 2. client 端：esbuild 打包（type-only imports 剥离；react 从宿主运行时解析）
//    `@deepseek-ai/dsh-client-ui-primitives` 同样必须保持 external：官方图标集是
//    宿主 web 端静态模块表的常驻成员（与 dsh-client-locale 等官方 client 包同款
//    做法），打进包会整套复制图标；由 package.json 的 `dsh.client.inject` 声明注入。
const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
});

const body = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-wakatime",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`;

mkdirSync('lib', { recursive: true });
writeFileSync('lib/client.js', wrapped);
console.log('✅ lib/index.js (host, tsc) + lib/client.js (browser, esbuild) 构建完成');
