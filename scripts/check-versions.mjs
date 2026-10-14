#!/usr/bin/env node
// 校验三处版本号必须一致：package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml([package].version)。
// 可选：argv[2] 传入期望的 Git tag（如 v0.1.0，自动去掉前导 v），也必须与上面三者相等。
// 只用 Node 标准库，无第三方依赖，可在任意 cwd 下运行（相对脚本自身解析仓库根目录）。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
const versions = {};

function readFile(rel) {
  try {
    return readFileSync(resolve(root, rel), 'utf8');
  } catch (err) {
    errors.push(`读取失败 ${rel}: ${err.message}`);
    return null;
  }
}

// 1) package.json
const pkgRaw = readFile('package.json');
if (pkgRaw !== null) {
  try {
    versions['package.json'] = JSON.parse(pkgRaw).version;
  } catch (err) {
    errors.push(`解析失败 package.json: ${err.message}`);
  }
}

// 2) src-tauri/tauri.conf.json
const tauriRaw = readFile('src-tauri/tauri.conf.json');
if (tauriRaw !== null) {
  try {
    versions['src-tauri/tauri.conf.json'] = JSON.parse(tauriRaw).version;
  } catch (err) {
    errors.push(`解析失败 src-tauri/tauri.conf.json: ${err.message}`);
  }
}

// 3) src-tauri/Cargo.toml —— 仅用简单正则取 [package] 段的 version，不引入 TOML 解析器
const cargoRaw = readFile('src-tauri/Cargo.toml');
if (cargoRaw !== null) {
  const sectionMatch = /^\[package\]\s*$([\s\S]*?)(?=^\[|\Z)/m.exec(cargoRaw);
  if (!sectionMatch) {
    errors.push('解析失败 src-tauri/Cargo.toml: 找不到 [package] 段');
  } else {
    const versionMatch = /^\s*version\s*=\s*"([^"]+)"/m.exec(sectionMatch[1]);
    if (!versionMatch) {
      errors.push('解析失败 src-tauri/Cargo.toml: [package] 段缺少 version');
    } else {
      versions['src-tauri/Cargo.toml'] = versionMatch[1];
    }
  }
}

// 三处必须一致
const names = Object.keys(versions);
const values = names.map((n) => versions[n]);
const unique = [...new Set(values)];
if (unique.length > 1) {
  errors.push(`三处版本号不一致：${names.map((n) => `${n}=${versions[n]}`).join('，')}`);
}

// 可选：与期望 tag 比对
const expectedRaw = process.argv[2];
if (expectedRaw) {
  const expected = expectedRaw.replace(/^v/, '');
  for (const name of names) {
    if (versions[name] !== expected) {
      errors.push(`版本号 ${versions[name]}（${name}）与 tag ${expectedRaw} => ${expected} 不一致`);
    }
  }
}

const shown = names.length ? values.join('，') : '(未读到任何版本号)';

if (errors.length > 0) {
  console.error('❌ 版本校验失败：');
  for (const e of errors) console.error('   - ' + e);
  process.exit(1);
}

console.log(`✅ 版本校验通过：${shown}`);
