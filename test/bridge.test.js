import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomCodeBridge } from '../bridge.js';

/**
 * Each test gets a private DSH_HOME so the plugin's real state directory is
 * never touched, and every generated file is removed afterwards.
 */
async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('state generation produces a config Atom2Api can actually boot', async () => {
  await withHome(async (home) => {
    const bridge = new AtomCodeBridge();
    const state = await bridge.loadState();
    const config = JSON.parse(fs.readFileSync(path.join(home, 'atomcode-codingplan', 'config.json'), 'utf8'));

    // Atom2Api parseConfig: user_agent must be non-empty or it log.Fatals.
    assert.ok(config.user_agent.length > 0, 'user_agent is required by Atom2Api');
    // validateConfig: encryption_key must be base64url 32 bytes.
    assert.match(config.encryption_key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(config.encryption_key, 'base64url').length, 32);
    // listen_address must bind loopback only.
    assert.match(config.listen_address, /^127\.0\.0\.1:\d+$/);
    // DSH owns the system prompt.
    assert.equal(config.system_prompt_enabled, false);
    assert.equal(config.admin_password, state.adminPassword);
  });
});

test('credential and state files are owner-only', async () => {
  await withHome(async (home) => {
    const bridge = new AtomCodeBridge();
    await bridge.loadState();
    const dir = path.join(home, 'atomcode-codingplan');
    const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
    assert.equal(mode(dir), '700', 'state directory');
    assert.equal(mode(path.join(dir, 'config.json')), '600', 'config.json');
    assert.equal(mode(path.join(dir, 'bridge-state.json')), '600', 'bridge-state.json');
  });
});

test('an invalid legacy state file is regenerated rather than reused', async () => {
  await withHome(async (home) => {
    const dir = path.join(home, 'atomcode-codingplan');
    fs.mkdirSync(dir, { recursive: true });
    // Exactly the shape 0.1.0 wrote: a 40-char encryption_key that Atom2Api
    // rejects with "encryption_key must be a base64url-encoded 32-byte key".
    fs.writeFileSync(path.join(dir, 'bridge-state.json'), JSON.stringify({
      version: 1,
      port: 54891,
      adminPassword: 'lxH3s7iRQo37legacy',
      encryptionKey: 'sj-_HS2EHTRlTOOshort',
      apiKey: null,
      pid: null
    }));

    const bridge = new AtomCodeBridge();
    const state = await bridge.loadState();
    assert.match(state.encryptionKey, /^[A-Za-z0-9_-]{43}$/, 'invalid key replaced');
    assert.equal(Buffer.from(state.encryptionKey, 'base64url').length, 32);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(config.encryption_key, state.encryptionKey);
    assert.ok(config.user_agent.length > 0);
  });
});

test('user-set upstream endpoints survive a config rewrite', async () => {
  await withHome(async (home) => {
    const dir = path.join(home, 'atomcode-codingplan');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      gateway_url: 'http://127.0.0.1:19188/v1',
      codingplan_api_url: 'http://127.0.0.1:19189/api/v5'
    }));

    const bridge = new AtomCodeBridge();
    await bridge.loadState();
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(config.gateway_url, 'http://127.0.0.1:19188/v1');
    assert.equal(config.codingplan_api_url, 'http://127.0.0.1:19189/api/v5');
    assert.ok(config.user_agent.length > 0, 'managed keys are still applied');
    assert.match(config.listen_address, /^127\.0\.0\.1:\d+$/);
  });
});

test('stop refuses to signal without a recorded PID', async () => {
  await withHome(async () => {
    const bridge = new AtomCodeBridge();
    await bridge.loadState();
    const result = await bridge.stop();
    assert.equal(result.stopped, false);
    assert.match(result.message, /没有已记录的桥接进程 PID/);
  });
});

test('doctor reports staged, secret-free diagnostics', async () => {
  await withHome(async () => {
    const bridge = new AtomCodeBridge();
    const report = await bridge.doctor();
    const names = report.stages.map((stage) => stage.stage);
    assert.deepEqual(names, ['plugin-env', 'state-dir', 'config', 'process']);
    const serialized = JSON.stringify(report);
    const state = await bridge.loadState();
    assert.equal(serialized.includes(state.adminPassword), false, 'no admin password');
    assert.equal(serialized.includes(state.encryptionKey), false, 'no encryption key');
  });
});

test('a symlinked binary pointing outside the extraction root is rejected', async () => {
  await withHome(async (home) => {
    const { findBinaryInExtractedTree } = await import('../bridge.js').then((m) => m.__test);
    const extractDir = path.join(home, 'out');
    fs.mkdirSync(path.join(home, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(home, 'outside', 'target'), 'not a real binary');
    fs.mkdirSync(extractDir, { recursive: true });
    // A malicious archive could ship `atom2api` as a symlink to a system path.
    fs.symlinkSync(path.join(home, 'outside', 'target'), path.join(extractDir, 'atom2api'));

    await assert.rejects(
      () => findBinaryInExtractedTree('evil.tar.gz', extractDir),
      /越界路径条目/
    );
  });
});

test('a well-formed archive yields its binary', async () => {
  await withHome(async (home) => {
    const { extractArchive } = await import('../bridge.js').then((m) => m.__test);
    const src = path.join(home, 'good');
    const stage = path.join(src, 'stage');
    fs.mkdirSync(path.join(stage, 'atom2api_1.0.9_darwin_arm64'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'atom2api_1.0.9_darwin_arm64', 'atom2api'), '#!/bin/sh\necho ok\n');
    fs.writeFileSync(path.join(stage, 'atom2api_1.0.9_darwin_arm64', 'README.md'), 'docs');
    const archive = path.join(src, 'good.tar.gz');
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-czf', archive, '-C', stage, 'atom2api_1.0.9_darwin_arm64']);

    const found = await extractArchive(archive, path.join(home, 'out'), 'tar');
    assert.ok(found.endsWith(path.join('atom2api_1.0.9_darwin_arm64', 'atom2api')), found);
  });
});
