const assert = require('node:assert/strict');
const { test } = require('node:test');
const { taurenTheme } = require('@tauren/shared/rendering/theme');

test('taurenTheme provides Pi Theme styling methods, metadata, and slot-scoped ANSI resets', () => {
  assert.equal(taurenTheme.name, 'dark');
  assert.equal(taurenTheme.appearance, 'dark');
  assert.equal(taurenTheme.getColorMode(), '256color');
  assert.equal(taurenTheme.fg('warning', 'caution'), '\x1b[33mcaution\x1b[39m');
  assert.equal(taurenTheme.bg('toolSuccessBg', 'added'), '\x1b[42madded\x1b[49m');
  assert.equal(taurenTheme.bold('title'), '\x1b[1mtitle\x1b[22m');
  assert.equal(taurenTheme.italic('note'), '\x1b[3mnote\x1b[23m');
  assert.equal(taurenTheme.underline('link'), '\x1b[4mlink\x1b[24m');
  assert.equal(taurenTheme.inverse('cursor'), '\x1b[7mcursor\x1b[27m');
  assert.equal(taurenTheme.strikethrough('old'), '\x1b[9mold\x1b[29m');
  assert.equal(
    taurenTheme.bg('toolSuccessBg', `${taurenTheme.fg('syntaxKeyword', 'const')} value`),
    '\x1b[42m\x1b[35mconst\x1b[39m value\x1b[49m'
  );
  assert.equal(
    taurenTheme.style('banner', { fg: 'accent', bg: 'selectedBg', bold: true }),
    '\x1b[36m\x1b[44m\x1b[1mbanner\x1b[22m\x1b[49m\x1b[39m'
  );
  assert.equal(
    taurenTheme.style('rgb', { fg: { kind: 'rgb', r: 10, g: 20, b: 30 } }),
    '\x1b[38;2;10;20;30mrgb\x1b[39m'
  );
  assert.equal(taurenTheme.getThinkingBorderColor('max')('│'), '\x1b[35m│\x1b[39m');
  assert.equal(taurenTheme.getBashModeBorderColor()('│'), '\x1b[32m│\x1b[39m');
  assert.deepEqual(taurenTheme.colors.warning, { kind: 'indexed', index: 3 });
  assert.deepEqual(taurenTheme.colors.scrollbarTrack, { kind: 'indexed', index: 8 });
  assert.deepEqual(taurenTheme.colors.searchMatchBg, { kind: 'indexed', index: 4 });
  assert.deepEqual(taurenTheme.colors.thinkingMax, { kind: 'indexed', index: 5 });
});
