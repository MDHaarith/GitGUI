import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 1 && args[0] === '--check'), 'Usage: node scripts/version.mjs [--check]');
const { version } = JSON.parse(read('package.json'));
const npmLock = JSON.parse(read('package-lock.json'));
assert.equal(npmLock.version, version, 'npm lockfile version differs from package.json');
assert.equal(npmLock.packages[''].version, version, 'npm root package version differs from package.json');
assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, '../package.json', 'Tauri must read the package.json version');

const manifest = read('src-tauri/Cargo.toml');
const cargoVersion = /^version = "([^"]+)"$/m;
const cargoLock = read('src-tauri/Cargo.lock');
const lockVersion = /(\[\[package\]\]\r?\nname = "gitgui"\r?\nversion = ")([^"]+)(")/;
assert.ok(manifest.match(cargoVersion), 'Cargo package version not found');
assert.ok(cargoLock.match(lockVersion), 'gitgui lockfile entry not found');
if (args[0] === '--check') {
  assert.equal(manifest.match(cargoVersion)[1], version, 'Cargo package version differs from package.json');
  assert.equal(cargoLock.match(lockVersion)[2], version, 'Cargo lockfile version differs from package.json');
} else {
  writeFileSync(new URL('src-tauri/Cargo.toml', root), manifest.replace(cargoVersion, () => `version = "${version}"`));
  writeFileSync(new URL('src-tauri/Cargo.lock', root), cargoLock.replace(lockVersion, (_, prefix, oldVersion, suffix) => prefix + version + suffix));
}
console.log(`GitGUI ${version}: versions ${args[0] === '--check' ? 'verified' : 'synchronized'}`);
