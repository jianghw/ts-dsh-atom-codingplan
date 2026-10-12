import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const OWNER = 'cnluminous';
const REPO = 'Atom2Api';
const PINNED_VERSION = process.env.ATOM2API_VERSION || 'v1.0.9';
const STATE_NAME = 'bridge-state.json';
const CONFIG_NAME = 'config.json';
const API_KEY_NAME = 'DeepSeek Harness AtomCode Provider';
const HEALTH_TIMEOUT_MS = 1500;
const BOOT_TIMEOUT_MS = 45000;
/** Atom2Api refuses to boot unless `user_agent` is present and non-empty. */
const DEFAULT_USER_AGENT = 'atomcode/5.0.2';

function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only official AtomGit/CodingPlan hosts may be opened in the user's browser. */
const ALLOWED_AUTH_HOSTS = /(^|\.)(atomgit\.com|gitcode\.com|gitcode\.net|csdn\.net|atomcode\.atomgit\.com)$/i;

export function isAllowedAuthUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_AUTH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

function findAccounts(body) {
  if (Array.isArray(body)) return body;
  if (!isObject(body)) return [];
  for (const key of ['data', 'accounts', 'items', 'results']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function findFirstUrl(value, depth = 0) {
  if (depth > 8 || value == null) return undefined;
  if (typeof value === 'string') {
    return isAllowedAuthUrl(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrl(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (isObject(value)) {
    const prioritized = Object.entries(value).sort(([a], [b]) => {
      const score = (s) => /(auth|verify|browser|login|url|uri|link)/i.test(s) ? 0 : 1;
      return score(a) - score(b);
    });
    for (const [, item] of prioritized) {
      const found = findFirstUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filePath);
  try { await fs.chmod(filePath, 0o600); } catch {}
}

async function freeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function platformAssetToken() {
  if (process.platform !== 'darwin') {
    throw new Error(`当前 MVP 仅支持 macOS。检测到平台：${process.platform}/${process.arch}。`);
  }
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['amd64', 'x86_64', 'x64'];
  return { os: ['darwin', 'macos', 'mac-os', 'mac'], arch };
}

/**
 * Match a release asset name against this platform and architecture.
 * Both tokens are required, and a host must never accept an asset naming an
 * architecture it did not ask for (e.g. an Intel host picking the arm64 build).
 */
export function assetMatches(name, osTokens, archTokens) {
  const n = name.toLowerCase().replaceAll('_', '-');
  if (!osTokens.some((token) => n.includes(token))) return false;
  if (!archTokens.some((token) => n.includes(token))) return false;
  const foreignArch = ['arm64', 'aarch64', 'amd64', 'x86_64', 'x64']
    .filter((token) => !archTokens.includes(token));
  return !foreignArch.some((token) => n.includes(token));
}

async function downloadToFile(url, destination, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, buffer, { mode: 0o600 });
  return buffer;
}

/**
 * Walk an extracted archive and return the `atom2api` executable inside it.
 *
 * Every entry is resolved with `realpath` first, so a symlink or `..` entry
 * that points outside the extraction root is rejected instead of being copied
 * in as the binary we later execute.
 */
async function findBinaryInExtractedTree(downloadPath, extractDir) {
  const root = await fs.realpath(extractDir);
  const found = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const real = await fs.realpath(full).catch(() => null);
      if (real === null || (real !== root && !real.startsWith(root + path.sep))) {
        throw new Error(`归档 ${path.basename(downloadPath)} 包含越界路径条目，已拒绝解压。`);
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /(^|\/)atom2api(?:\.exe)?$/i.test(full)) found.push(full);
    }
  }
  await visit(extractDir);
  if (!found.length) throw new Error(`已解压 ${path.basename(downloadPath)}，但未找到 atom2api 可执行文件。`);
  return found[0];
}

/** Extract one file from a downloaded archive, rejecting path traversal entries. */
async function extractArchive(downloadPath, extractDir, kind) {
  await fs.mkdir(extractDir, { recursive: true, mode: 0o700 });
  if (kind === 'zip') {
    execFileSync('unzip', ['-o', downloadPath, '-d', extractDir], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['-xzf', downloadPath, '-C', extractDir], { stdio: 'ignore' });
  }
  return findBinaryInExtractedTree(downloadPath, extractDir);
}

async function ensureAtom2ApiBinary(binDir) {
  const target = path.join(binDir, 'atom2api');
  try {
    await fs.access(target, fsSync.constants.X_OK);
    return target;
  } catch {}

  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  const platform = platformAssetToken();
  const releaseUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${PINNED_VERSION}`;
  const releaseResponse = await fetch(releaseUrl, {
    signal: AbortSignal.timeout(30000),
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-atomcode-codingplan'
    }
  });
  if (!releaseResponse.ok) throw new Error(`无法读取 Atom2Api ${PINNED_VERSION} Release：HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matching = assets.filter((asset) => assetMatches(asset.name || '', platform.os, platform.arch));
  const asset = matching.find((item) => /\.(zip|tar\.gz|tgz)$/i.test(item.name));
  if (!asset?.browser_download_url) {
    const available = assets.map((item) => item.name).join(', ') || 'Release 没有可用资产';
    throw new Error(`找不到适用于 ${process.platform}/${process.arch} 的 Atom2Api 二进制。可用资产：${available}`);
  }

  const downloadPath = path.join(binDir, asset.name);
  const data = await downloadToFile(asset.browser_download_url, downloadPath, {
    'user-agent': 'dsh-atomcode-codingplan'
  });
  // GitHub publishes a sha256 digest per asset; require it rather than
  // silently continuing when the upstream omits it.
  if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== asset.digest.slice('sha256:'.length)) {
      await fs.rm(downloadPath, { force: true });
      throw new Error('Atom2Api 下载文件的 SHA-256 校验失败，已删除文件。');
    }
  } else {
    await fs.rm(downloadPath, { force: true });
    throw new Error(`上游未提供 ${asset.name} 的 SHA-256 校验值，出于供应链安全考虑已放弃安装。可改用已审核的 ATOM2API_BIN。`);
  }

  const lower = asset.name.toLowerCase();
  try {
    if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const kind = lower.endsWith('.zip') ? 'zip' : 'tar';
      const binary = await extractArchive(downloadPath, path.join(binDir, 'extract'), kind);
      await fs.copyFile(binary, target);
    } else {
      await fs.copyFile(downloadPath, target);
    }
  } finally {
    try { await fs.rm(downloadPath, { force: true }); } catch {}
    try { await fs.rm(path.join(binDir, 'extract'), { recursive: true, force: true }); } catch {}
  }

  await fs.chmod(target, 0o700);
  return target;
}

export class AtomCodeBridge {
  constructor() {
    this.root = path.join(dshHome(), 'atomcode-codingplan');
    this.statePath = path.join(this.root, STATE_NAME);
    this.configPath = path.join(this.root, CONFIG_NAME);
    this.logPath = path.join(this.root, 'atom2api.log');
    this._state = null;
    this._readyPromise = null;
  }

  /**
   * Build the Atom2Api config.
   *
   * Atom2Api's `parseConfig` rejects a config whose `user_agent` is empty and
   * validates `encryption_key` as base64url-encoded 32 bytes; a partial config
   * makes the process `log.Fatal` at startup. `admin_password` may be plaintext
   * because Atom2Api bcrypt-hashes and rewrites it on load, so the random
   * password we persist stays the one the user is shown.
   */
  buildConfig(state) {
    return {
      user_agent: DEFAULT_USER_AGENT,
      listen_address: `127.0.0.1:${state.port}`,
      data_path: path.join(this.root, 'data', 'atom2api.db'),
      admin_password: state.adminPassword,
      encryption_key: state.encryptionKey,
      // DSH owns the system prompt. Atom2Api's built-in AtomCode identity
      // prompt would otherwise override the harness instructions.
      system_prompt_enabled: false
    };
  }

  async loadState() {
    if (this._state) return this._state;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let state = safeJsonParse(await fs.readFile(this.statePath, 'utf8').catch(() => ''), null);
    if (
      !isObject(state) ||
      !Number.isInteger(state.port) ||
      state.port <= 0 ||
      typeof state.adminPassword !== 'string' ||
      !state.adminPassword ||
      typeof state.encryptionKey !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(state.encryptionKey)
    ) {
      state = {
        version: 1,
        port: await freeLoopbackPort(),
        adminPassword: crypto.randomBytes(30).toString('base64url'),
        encryptionKey: crypto.randomBytes(32).toString('base64url'),
        apiKey: null,
        apiKeyId: null,
        pid: null,
        createdAt: new Date().toISOString()
      };
    }
    this._state = state;
    await this.#writeManagedConfig(state);
    await writePrivateJson(this.statePath, state);
    return state;
  }

  /**
   * Ensure config.json carries the keys the plugin owns, preserving anything the
   * user (or a test harness) set for the upstream endpoints.
   *
   * Atom2Api's `parseConfig` rejects a config whose `user_agent` is empty and
   * validates `encryption_key` as base64url-encoded 32 bytes, so a partial
   * config makes the process `log.Fatal` at startup — that is what broke 0.1.0.
   */
  async #writeManagedConfig(state) {
    const existing = safeJsonParse(await fs.readFile(this.configPath, 'utf8').catch(() => ''), null);
    const merged = isObject(existing) ? { ...existing } : {};
    let changed = !isObject(existing);
    for (const [key, value] of Object.entries(this.buildConfig(state))) {
      if (merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    }
    if (changed) await writePrivateJson(this.configPath, merged);
    return merged;
  }

  async baseUrl() {
    const state = await this.loadState();
    return `http://127.0.0.1:${state.port}`;
  }

  async health() {
    try {
      const base = await this.baseUrl();
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      return response.ok;
    } catch { return false; }
  }

  async startSidecar() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = this.#startSidecarOnce();
    try {
      return await this._readyPromise;
    } finally {
      this._readyPromise = null;
    }
  }

  async #startSidecarOnce() {
    const state = await this.loadState();
    if (await this.health()) return state;

    const configuredBinary = process.env.ATOM2API_BIN?.trim();
    const binary = configuredBinary || await ensureAtom2ApiBinary(path.join(this.root, 'bin'));
    const logFd = fsSync.openSync(this.logPath, 'a', 0o600);
    let child;
    try {
      child = spawn(binary, [], {
        cwd: this.root,
        env: { ...process.env, ATOM2API_CONFIG: this.configPath },
        stdio: ['ignore', logFd, logFd],
        detached: true
      });
      child.on('error', (error) => {
        console.warn(`[dsh-atomcode-codingplan] Atom2Api 子进程启动错误：${error.message}`);
      });
      child.unref();
    } finally {
      try { fsSync.closeSync(logFd); } catch {}
    }
    state.pid = child.pid || null;
    await writePrivateJson(this.statePath, state);

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.health()) return state;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    let logTail = '';
    try { logTail = (await fs.readFile(this.logPath, 'utf8')).slice(-1800); } catch {}
    throw new Error(`Atom2Api 本地桥接未能启动。日志末尾：\n${logTail || '(暂无日志)'}`);
  }

  /** Exchange the stored admin password for a management session cookie. */
  async loginAdmin() {
    const state = await this.loadState();
    const base = await this.baseUrl();
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: state.adminPassword }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Atom2Api 本地管理认证失败：HTTP ${response.status}`);
    const setCookie = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''];
    for (const entry of setCookie) {
      const match = entry.match(/(?:^|[,;\s])atom2api_admin=([^;]+)/);
      if (match) return match[1];
    }
    throw new Error('Atom2Api 没有返回管理会话 Cookie。');
  }

  async adminRequest(route, options = {}) {
    await this.startSidecar();
    const base = await this.baseUrl();
    const cookie = await this.loginAdmin();
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
        cookie: `atom2api_admin=${cookie}`
      },
      signal: options.signal || AbortSignal.timeout(20000)
    });
    const text = await response.text();
    const body = safeJsonParse(text, text);
    if (!response.ok) {
      const message = isObject(body) ? (body.error?.message ?? body.error ?? body.message) : String(body).slice(0, 800);
      throw new Error(`Atom2Api 管理 API ${route} 返回 HTTP ${response.status}: ${message}`);
    }
    return body;
  }

  /**
   * Resolve the API key DSH uses for `/v1` calls.
   *
   * Atom2Api stores only a SHA-256 digest of each key, so a key that is lost
   * cannot be recovered — it must be replaced. Reuse the recorded key when it
   * still authenticates; otherwise rotate it rather than leaking a new secret
   * on every call.
   */
  async ensureApiKey() {
    const state = await this.loadState();
    const base = await this.baseUrl();
    if (state.apiKey) {
      try {
        const response = await fetch(`${base}/v1/models`, {
          headers: { authorization: `Bearer ${state.apiKey}` },
          signal: AbortSignal.timeout(8000)
        });
        if (response.status !== 401 && response.status !== 403) return state.apiKey;
      } catch {}
    }
    if (state.apiKeyId) {
      try {
        await this.adminRequest(`/api/keys/${encodeURIComponent(state.apiKeyId)}`, { method: 'DELETE' });
      } catch {}
    }
    // POST /api/keys answers `{key, secret}`; `secret` is the only copy.
    const created = await this.adminRequest('/api/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: API_KEY_NAME,
        allowed_models: [],
        rpm_limit: 0,
        concurrency_limit: 0
      })
    });
    const secret = isObject(created) ? (created.secret || created.api_key || created.apiKey) : null;
    if (typeof secret !== 'string' || secret.length < 12 || /\s/.test(secret)) {
      throw new Error('Atom2Api 已返回创建密钥响应，但未能识别有效 API Key；请检查 Atom2Api 版本。');
    }
    state.apiKey = secret;
    state.apiKeyId = isObject(created.key) && typeof created.key.id === 'string' ? created.key.id : null;
    await writePrivateJson(this.statePath, state);
    return secret;
  }

  async getAccounts() {
    const body = await this.adminRequest('/api/accounts');
    return findAccounts(body);
  }

  /** Model catalog entries, enriched with context metadata when available. */
  async getModels(signal) {
    await this.startSidecar();
    const apiKey = await this.ensureApiKey();
    const base = await this.baseUrl();
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: signal || AbortSignal.timeout(20000)
    });
    const text = await response.text();
    const body = safeJsonParse(text, text);
    if (!response.ok) throw new Error(`Atom2Api 模型列表请求失败：HTTP ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
    const models = isObject(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
    const listed = models.filter((item) => isObject(item) && typeof item.id === 'string' && item.id.length > 0);
    // `/v1/models` is an OpenAI-shaped list without context window data; the
    // richer `/api/models` route carries it for the same ids.
    let detailed = [];
    try {
      const adminModels = await this.adminRequest('/api/models');
      const rows = findAccounts(adminModels);
      detailed = new Map(
        rows.filter((row) => isObject(row) && typeof row.alias === 'string')
          .map((row) => [row.alias, row])
      );
    } catch {}
    return listed.map((item) => {
      const detail = detailed.get(item.id);
      const contextLength = detail?.context_window;
      return {
        id: item.id,
        ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
        ...(Number.isInteger(contextLength) && contextLength > 0 ? { context_length: contextLength } : {})
      };
    });
  }

  async chatCompletion(payload, signal) {
    await this.startSidecar();
    const apiKey = await this.ensureApiKey();
    const base = await this.baseUrl();
    return await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(payload.attributionHeaders || {})
      },
      body: JSON.stringify(payload.body),
      signal
    });
  }

  /**
   * Drive the AtomGit broker OAuth to completion.
   *
   * `POST /api/oauth/start` only creates a pending session; the account is not
   * written to the store until `GET /api/oauth/{id}` has been polled, so the
   * poll is mandatory rather than an optimization.
   */
  async connectIfNeeded() {
    await this.startSidecar();
    const existing = await this.getAccounts();
    if (existing.length) return existing;

    const base = await this.baseUrl();
    const cookie = await this.loginAdmin();
    const startResponse = await fetch(`${base}/api/oauth/start`, {
      method: 'POST',
      headers: { cookie: `atom2api_admin=${cookie}` },
      signal: AbortSignal.timeout(15000)
    });
    const startText = await startResponse.text();
    if (!startResponse.ok) {
      const parsed = safeJsonParse(startText, null);
      const reason = isObject(parsed) ? (parsed.error?.message ?? parsed.error) : startText.slice(0, 300);
      throw new Error(`Atom2Api 无法发起 AtomGit 授权：HTTP ${startResponse.status}: ${reason}`);
    }
    const started = safeJsonParse(startText, null);
    const url = findFirstUrl(started);
    if (url) {
      openBrowser(url);
      console.log('已在默认浏览器打开 AtomGit 授权页，请完成登录并同意授权。');
    } else {
      const dashboard = base;
      openBrowser(dashboard);
      console.log('未能取得可直接打开的授权链接，已打开本地管理页。请登录后进入 Accounts → Connect AtomGit 完成授权。');
      console.log(`本地管理密码：${(await this.loadState()).adminPassword}`);
    }

    const sessionId = isObject(started) && typeof started.id === 'string' ? started.id : null;
    if (!sessionId) throw new Error('Atom2Api 的授权响应中没有会话 id，无法跟踪授权进度。');

    console.log('等待 AtomGit 授权完成……（完成后无需复制任何 API Key）');
    const deadline = Date.now() + 10 * 60 * 1000;
    let lastMessageAt = 0;
    while (Date.now() < deadline) {
      try {
        const poll = await this.adminRequest(`/api/oauth/${encodeURIComponent(sessionId)}`);
        const status = isObject(poll) ? poll.status : '';
        if (status === 'complete') {
          // Let the asynchronous CodingPlan claim/model sync settle.
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const accounts = await this.getAccounts();
          if (accounts.length) return accounts;
        }
        if (status === 'expired') {
          throw new Error('AtomGit 授权会话已过期，请重新运行 setup。');
        }
      } catch (error) {
        if (Date.now() - lastMessageAt > 15000) {
          console.warn(`等待授权时检查进度失败：${error.message}`);
          lastMessageAt = Date.now();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error('等待 AtomGit 授权超时（10 分钟）。请重新运行 setup 重新发起授权。');
  }

  async setup() {
    await this.startSidecar();
    await this.ensureApiKey();
    const accounts = await this.getAccounts();
    if (accounts.length) {
      const models = await this.getModels();
      return { alreadyConnected: true, accounts: accounts.length, models: models.map((m) => m.id) };
    }
    const connected = await this.connectIfNeeded();
    const models = await this.getModels();
    return { alreadyConnected: false, accounts: connected.length, models: models.map((m) => m.id) };
  }

  /** Staged, secret-free diagnostics for `doctor`. */
  async doctor() {
    const stages = [];
    const record = (name, ok, detail) => stages.push({ stage: name, status: ok ? 'ok' : 'fail', detail });
    const root = this.root;
    record('plugin-env', true, `node ${process.version} · ${process.platform}/${process.arch} · DSH_HOME=${process.env.DSH_HOME || '(默认 ~/.dsh)'}`);
    record('state-dir', true, root);

    let state = null;
    try {
      state = await this.loadState();
      record('config', true, `127.0.0.1:${state.port}（仅回环）· admin 密码已生成 · 加密密钥有效`);
    } catch (error) {
      record('config', false, error.message);
      return { stages, running: false };
    }

    const running = await this.health();
    record('process', running, running ? `pid ${state.pid ?? '(由其它会话启动)'} · 健康检查通过` : '未运行（首次调用或 setup 时会自动启动）');
    if (!running) return { stages, running: false, binary: process.env.ATOM2API_BIN || '(将在首次启动时下载)' };

    let accounts = [];
    try {
      accounts = await this.getAccounts();
      record('account', accounts.length > 0, `已连接账户 ${accounts.length} 个`);
    } catch (error) {
      record('account', false, error.message);
    }

    let models = [];
    try {
      models = await this.getModels();
      record('models', models.length > 0, models.length ? models.map((m) => m.id).join(', ') : '模型目录为空，请完成 AtomGit 授权后重试');
    } catch (error) {
      record('models', false, error.message);
    }

    // Atom2Api answers 429 `insufficient_quota` both for a genuinely exhausted
    // quota window and for a model this account's plan tier may not use (a Lite
    // plan is DeepSeek-family only). Report which one it is so the user is not
    // left guessing at a bare HTTP status.
    let probe = 'skipped';
    let probeDetail = '无模型可用，跳过';
    if (models.length) {
      try {
        const response = await this.chatCompletion({
          body: { model: models[0].id, stream: false, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
        });
        if (response.ok) {
          probe = 'ok';
          probeDetail = `模型 ${models[0].id} 可达`;
          await response.body?.cancel?.();
        } else {
          probe = `HTTP ${response.status}`;
          // Read the error body first; cancelling afterwards would fail on a
          // consumed stream. The body is Atom2Api's own error envelope, and
          // `doctor` prints only a short derived message.
          const text = await response.text().catch(() => '');
          const body = safeJsonParse(text, null);
          const code = isObject(body) ? body.error?.code : undefined;
          probeDetail = code === 'insufficient_quota'
            ? `模型 ${models[0].id} 返回 insufficient_quota：当前 CodingPlan 套餐等级可能无权使用该模型（Lite 仅支持 DeepSeek 系列），或额度窗口已用尽`
            : `模型 ${models[0].id} 返回 HTTP ${response.status}`;
        }
      } catch (error) {
        probe = `error: ${error.message}`;
        probeDetail = probe;
      }
    }
    record('request', probe === 'ok' || probe === 'skipped', probeDetail);

    return { stages, running: true, models: models.map((m) => m.id) };
  }

  async status() {
    const running = await this.health();
    if (!running) return { running: false, root: this.root };
    let accounts = [];
    let models = [];
    try { accounts = await this.getAccounts(); } catch {}
    try { models = await this.getModels(); } catch {}
    return {
      running: true,
      baseUrl: await this.baseUrl(),
      connectedAccounts: accounts.length,
      models: models.map((model) => model.id),
      root: this.root,
      version: PINNED_VERSION
    };
  }

  /** True when `/api/health` answers as an Atom2Api service on the recorded port. */
  async #healthIdentifiesAtom2Api() {
    try {
      const base = await this.baseUrl();
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!response.ok) return false;
      const body = safeJsonParse(await response.text(), null);
      return isObject(body) && body.service === 'atom2api';
    } catch { return false; }
  }

  /**
   * Confirm a recorded PID still belongs to this plugin's bridge.
   *
   * `ps` is the strongest evidence but is unavailable in some sandboxes, so a
   * loopback health check that answers as `service: atom2api` is the fallback.
   * @returns {{ok: boolean, via: string, reason?: string}}
   */
  async #verifyOwnedPid(pid, state) {
    const bin = path.join(this.root, 'bin', 'atom2api');
    const configured = process.env.ATOM2API_BIN?.trim();
    let command = null;
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (error) {
      // EPERM/ENOENT: `ps` cannot be executed here. Fall through to the
      // health-based check instead of assuming the process is gone.
      const viaHealth = await this.#healthIdentifiesAtom2Api();
      return {
        ok: viaHealth,
        via: 'health',
        reason: viaHealth
          ? undefined
          : `无法用 ps 确认进程身份（${error.code || error.message}），且回环健康检查未确认 Atom2Api`
      };
    }
    if (!command) return { ok: false, via: 'ps', reason: '该 PID 已不存在' };
    if (command.includes(bin) || (configured && command.includes(configured))) {
      return { ok: true, via: 'ps' };
    }
    return { ok: false, via: 'ps', reason: '该 PID 当前不指向本插件的 Atom2Api' };
  }

  async stop() {
    const state = await this.loadState();
    if (!Number.isInteger(state.pid)) {
      return { stopped: false, message: '没有已记录的桥接进程 PID。' };
    }
    const verdict = await this.#verifyOwnedPid(state.pid, state);
    if (!verdict.ok) {
      // Only clear the PID when the process is genuinely gone; a failed
      // identity check must not orphan a live bridge.
      if (verdict.reason === '该 PID 已不存在') {
        state.pid = null;
        await writePrivateJson(this.statePath, state);
        return { stopped: false, message: '桥接进程已经停止或 PID 已失效。' };
      }
      return { stopped: false, message: `${verdict.reason}；未发送终止信号，也未清除 PID。` };
    }
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      return { stopped: false, message: `无法终止 PID ${state.pid}（${error.code || error.message}）。` };
    }
    state.pid = null;
    await writePrivateJson(this.statePath, state);
    return { stopped: true, verifiedBy: verdict.via };
  }
}

function findStringByKey(value, keyPattern, depth = 0) {
  if (depth > 8 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keyPattern, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && typeof item === 'string') return item;
  }
  for (const item of Object.values(value)) {
    const found = findStringByKey(item, keyPattern, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function openBrowser(url) {
  try {
    const command = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', (error) => console.warn(`无法自动打开浏览器：${error.message}`));
    child.unref();
  } catch (error) {
    console.warn(`未能自动打开浏览器，请手动访问该页面（${error.message}）`);
  }
}

export const __test = { findAccounts, findFirstUrl, assetMatches, safeJsonParse, findStringByKey, isAllowedAuthUrl, extractArchive, findBinaryInExtractedTree, platformAssetToken, DEFAULT_USER_AGENT };
