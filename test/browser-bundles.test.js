'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const prisoner = require('../games/prisoner');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const browserAssets = {
  '/game-rules.js': read('games/clawclash/engine/rules_core.js'),
  '/builtin-bots.js': [
    'games/clawclash/engine/rules_metered.js',
    'games/clawclash/engine/templates_factory.js',
    'games/clawclash/engine/training_bots.js',
    'games/clawclash/engine/builtins.js',
    'games/prisoner/engine/rules.js',
    'games/prisoner/engine/training_bots.js',
  ].map(read).join('\n;\n'),
};

test('prisoner page loads its shared bundle in a fresh browser and exposes local training bots', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);

  for (const src of prisoner.client.scripts) {
    if (src.startsWith('/games/')) break;
    assert.equal(typeof browserAssets[src], 'string', `missing browser asset fixture for ${src}`);
    vm.runInContext(browserAssets[src], context, { filename: src });
  }

  assert.equal(typeof sandbox.PdRules?.normalizeChoice, 'function');
  assert.equal(typeof sandbox.PdTraining?.getTrainingBot, 'function');
});
