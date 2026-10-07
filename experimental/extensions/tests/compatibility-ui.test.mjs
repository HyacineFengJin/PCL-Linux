// Render the actual CE report component with the real React server renderer.
// No browser, native application, accounts or settings are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectForeignManifest } from '../src/compatibility.mjs';

const desktop = fileURLToPath(new URL('../../../apps/desktop/', import.meta.url));
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const { build } = requireDesktop('esbuild');
const scratch = fileURLToPath(new URL('../../../work/extension-compatibility-tests/', import.meta.url));

test('real report dialog is localized, escapes plugin text and cannot approve installation', async () => {
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(path.join(scratch, 'renderer-'));
  try {
    const compiled = await build({ stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ExtensionCompatibilityDialog } from './src/ExperimentalExtensions';
      import { configureLocale } from './src/i18n';
      import zh from './src/locales/experimentalZh';
      import en from './src/locales/experimentalEn';
      export { zh, en };
      export function render(report, language) {
        configureLocale({language, region: language});
        return renderToStaticMarkup(React.createElement(ExtensionCompatibilityDialog, {report, onClose() {}}));
      }
    `, resolveDir: desktop, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs',
      jsx: 'automatic', loader: { '.css': 'empty' }, write: false,
      define: { 'process.env.NODE_ENV': '"production"' } });
    const modulePath = path.join(work, 'report.cjs');
    await writeFile(modulePath, compiled.outputFiles[0].text);
    const { render, zh, en } = requireDesktop(modulePath);
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const report = inspectForeignManifest(JSON.stringify({ id: 'example.mixin', name: '<script>alert(1)</script>',
      version: '1.0.0', entryAssembly: 'lib/Plugin.dll', mixinConfig: 'mixins/base.json' }));
    for (const language of ['zh-CN', 'en-US']) {
      const html = render(report, language);
      assert.match(html, /role="dialog"/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script>|<input|<iframe/);
      assert.match(html, /type="submit" disabled=""/);
      assert.ok(html.includes(language === 'zh-CN' ? '暂不支持安装' : 'Installation unavailable'));
      assert.ok(html.includes(language === 'zh-CN' ? '插件兼容报告' : 'Plugin compatibility report'));
      assert.doesNotMatch(html, /experimental\.compat/);
      assert.ok(html.includes('mixins/base.json'));
    }
    delete requireDesktop.cache[modulePath];
  } finally { await rm(work, { recursive: true, force: true }); }
});
