#!/usr/bin/env node
// 合并 GeckoView 的 AndroidManifest 到宿主 manifest。
//
// 为什么不引 XML 库：GeckoView 的 manifest 里有 `${applicationId}` 占位符、
//   MPL 许可证注释、tools: 命名空间。用解析器再序列化会丢掉这些（或者被占位符绊倒）。
//   这里做的是纯文本插入：找到宿主 <application ...> 开标签的结尾 '>'，
//   把 GeckoView 的 service/provider 原样插进去，其余内容一律不动。
//
// 用法：
//   node merge-geckoview-manifest.mjs <宿主manifest> <GeckoView manifest> <输出>
//
// 合并四件事：
//   1) <application> 开标签补上 android:zygotePreloadName
//   2) 89 个 <service>、1 个 <provider> 原样插入 <application> 内
//   3) 缺的 <uses-permission> 补到 <application> 之前
//   4) 缺的 <uses-feature> 补到 <application> 之前
//
// 任一步骤拿不到预期结果就 exit 1，绝不输出半成品（避免"包出来了但一装就崩"）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , srcHost, srcGv, outPath] = process.argv;
if (!srcHost || !srcGv || !outPath) {
  console.error('用法: node merge-geckoview-manifest.mjs <宿主manifest> <GeckoView manifest> <输出>');
  process.exit(2);
}

const host = readFileSync(srcHost, 'utf8');
const gv = readFileSync(srcGv, 'utf8');

// ── 工具：从 <tag ...> 到 </tag> 的全部配对块（支持嵌套同名标签）──────────────
function extractBlocks(text, tag) {
  const out = [];
  const openRe = new RegExp(`<${tag}\\b`, 'g');
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const start = m.index;
    // 找到这个开标签真正的结尾 '>'（跳过引号内的 '>'）
    let i = start;
    let inQuote = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inQuote) { if (c === inQuote) inQuote = null; continue; }
      if (c === '"' || c === "'") { inQuote = c; continue; }
      if (c === '>') break;
    }
    if (i >= text.length) continue;
    const selfClosing = text[i - 1] === '/';
    if (selfClosing) {
      out.push(text.slice(start, i + 1));
      openRe.lastIndex = i + 1;
      continue;
    }
    // 向后配平同名标签
    let depth = 1;
    let j = i + 1;
    const scanRe = new RegExp(`<(/?)${tag}\\b`, 'g');
    scanRe.lastIndex = j;
    let s;
    while ((s = scanRe.exec(text)) !== null) {
      depth += s[1] === '/' ? -1 : 1;
      if (depth === 0) {
        // 跳过 '>' 找收尾
        let k = s.index;
        let q = null;
        for (; k < text.length; k++) {
          const c = text[k];
          if (q) { if (c === q) q = null; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (c === '>') break;
        }
        out.push(text.slice(start, k + 1));
        openRe.lastIndex = k + 1;
        break;
      }
    }
  }
  return out;
}

const die = (msg) => { console.error('!! ' + msg); process.exit(1); };

// ── 1) 取 GeckoView 的 service / provider ───────────────────────────────────
const gvServices = extractBlocks(gv, 'service');
const gvProviders = extractBlocks(gv, 'provider');
console.log(`  GeckoView: ${gvServices.length} 个 service, ${gvProviders.length} 个 provider`);
if (gvServices.length !== 89) die(`预期 89 个 service，实际 ${gvServices.length}，源 manifest 可能不对`);
if (gvProviders.length !== 1) die(`预期 1 个 provider，实际 ${gvProviders.length}，源 manifest 可能不对`);

// ── 2) 取 zygotePreloadName ────────────────────────────────────────────────
const zp = gv.match(/android:zygotePreloadName\s*=\s*"([^"]+)"/);
if (!zp) die('GeckoView manifest 里找不到 android:zygotePreloadName');
const zygoteName = zp[1];
console.log(`  zygotePreloadName = ${zygoteName}`);

// ── 3) 处理宿主的 <application> 开标签 ──────────────────────────────────────
const appOpenRe = /<application\b/;
const appMatch = appOpenRe.exec(host);
if (!appMatch) die('宿主 manifest 里找不到 <application>');
let p = appMatch.index + '<application'.length;
let q = null;
for (; p < host.length; p++) {
  const c = host[p];
  if (q) { if (c === q) q = null; continue; }
  if (c === '"' || c === "'") { q = c; continue; }
  if (c === '>') break;
}
if (p >= host.length) die('<application> 开标签没有闭合');

let appOpen = host.slice(appMatch.index, p + 1);
const isSelfClosing = appOpen.trimEnd().endsWith('/>');
if (isSelfClosing) die('宿主的 <application> 是自闭合的，无法插入子节点（不是预期情况）');
if (host.includes('android:zygotePreloadName')) {
  die('宿主 manifest 已经有 android:zygotePreloadName —— 说明被重复处理过');
}

// 在开标签的 '>' 前插入 zygotePreloadName
const newAppOpen = appOpen.replace(/\s*>$/, `\n        android:zygotePreloadName="${zygoteName}" >`);
if (newAppOpen === appOpen) die('zygotePreloadName 插入失败');

// ── 4) 组装子节点 ──────────────────────────────────────────────────────────
const indent = (s) => s.split('\n').map((l) => (l.trim() ? '        ' + l.replace(/^\s{0,8}/, '') : l)).join('\n');
const injection =
  '\n\n        <!-- ===== GeckoView 合并段：以下 89 个 service + 1 个 provider 由 GeckoView AAR 的 manifest 原样搬入 ===== -->\n' +
  gvServices.map((s) => indent(s)).join('\n') + '\n' +
  gvProviders.map((s) => indent(s)).join('\n') + '\n' +
  '        <!-- ===== GeckoView 合并段 结束 ===== -->\n';

let merged = host.slice(0, appMatch.index) + newAppOpen + injection + host.slice(p + 1);

// ── 5) 补 uses-permission / uses-feature ──────────────────────────────────
const havePerm = new Set([...merged.matchAll(/<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
const neededPerm = [...gv.matchAll(/<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const addPerm = neededPerm.filter((x) => !havePerm.has(x));
const permXml = addPerm.map((x) => `    <uses-permission android:name="${x}" />`).join('\n');

const haveFeat = new Set([...merged.matchAll(/<uses-feature[^>]*android:name\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
const gvFeatBlocks = extractBlocks(gv, 'uses-feature');
const addFeatBlocks = [];
for (const blk of gvFeatBlocks) {
  const nm = blk.match(/android:name\s*=\s*"([^"]+)"/);
  if (nm && !haveFeat.has(nm[1])) addFeatBlocks.push({ name: nm[1], xml: blk });
}

// 插到 <application 之前
const appIdx = merged.indexOf('<application');
let head = merged.slice(0, appIdx);
let tail = merged.slice(appIdx);
if (addPerm.length) {
  head = head.replace(/\s*$/, '\n') + '\n    <!-- ===== GeckoView 合并段：权限 ===== -->\n' + permXml + '\n\n';
  console.log(`  补充 ${addPerm.length} 个 uses-permission: ${addPerm.join(', ')}`);
}
if (addFeatBlocks.length) {
  head = head.replace(/\s*$/, '\n') + '\n    <!-- ===== GeckoView 合并段：硬件特性（全部 required=false，不限制安装）===== -->\n' +
    addFeatBlocks.map((f) => f.xml).join('\n') + '\n\n';
  console.log(`  补充 ${addFeatBlocks.length} 个 uses-feature: ${addFeatBlocks.map((f) => f.name).join(', ')}`);
}
merged = head + tail;

// ── 6) 自检 ────────────────────────────────────────────────────────────────
const checks = [
  ['application 开标签', /<application\b/],
  ['zygotePreloadName', /android:zygotePreloadName\s*=\s*"org\.mozilla\.gecko\.process\.ZygotePreload"/],
  ['manifest 根闭合', /<\/manifest>\s*$/],
];
for (const [name, re] of checks) {
  if (!re.test(merged)) die(`合并结果自检失败：找不到 ${name}`);
}
const svcCount = (merged.match(/<service\b/g) || []).length;
const hostSvcCount = (host.match(/<service\b/g) || []).length;
if (svcCount !== hostSvcCount + 89) {
  die(`service 数量不符：合并后 ${svcCount}，预期 ${hostSvcCount} + 89 = ${hostSvcCount + 89}`);
}
const provCount = (merged.match(/<provider\b/g) || []).length;
const hostProvCount = (host.match(/<provider\b/g) || []).length;
if (provCount !== hostProvCount + 1) {
  die(`provider 数量不符：合并后 ${provCount}，预期 ${hostProvCount} + 1 = ${hostProvCount + 1}`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, merged, 'utf8');
console.log(`  合并完成：${outPath}  (${merged.length} 字节, ${svcCount} service / ${provCount} provider)`);
