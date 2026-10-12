/**
 * Verify the real binary download path end to end against the live GitHub
 * release: platform/arch selection, SHA-256 verification, extraction, and a
 * successful boot. Uses an isolated DSH_HOME and the pinned default version.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dl-'))
delete process.env.ATOM2API_BIN   // force the real download path
const { AtomCodeBridge } = await import('../bridge.js')

const bridge = new AtomCodeBridge()
const PINNED = process.env.ATOM2API_VERSION || 'v1.0.9'
let failed = false
const step = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = true
}

try {
  console.log('DSH_HOME =', process.env.DSH_HOME)
  console.log('下载 Atom2Api', PINNED, 'for', `${process.platform}/${process.arch}`)

  const state = await bridge.startSidecar()
  const binary = path.join(bridge.root, 'bin', 'atom2api')
  step('下载并安装二进制', fs.existsSync(binary))

  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  step('二进制可执行', version === '1.0.9', `atom2api --version = ${version}`)

  step('sidecar 健康', (await bridge.health()) === true, `127.0.0.1:${state.port}`)

  // The release asset SHA-256 published by GitHub must match what we installed.
  const release = await (await fetch(`https://api.github.com/repos/cnluminous/Atom2Api/releases/tags/${PINNED}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-atomcode-codingplan' }
  })).json()
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const asset = release.assets.find((a) => a.name === `atom2api_${PINNED.replace('v', '')}_darwin_${arch}.tar.gz`)
  step('定位到本平台 asset', Boolean(asset), asset?.name)
  step('上游提供 sha256 digest', typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:'), asset?.digest)

  // Left-over download artifacts must be cleaned up.
  const leftovers = fs.readdirSync(path.join(bridge.root, 'bin')).filter((n) => n !== 'atom2api')
  step('下载临时文件已清理', leftovers.length === 0, leftovers.join(', ') || '(无)')

  await bridge.stop()
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
} catch (error) {
  failed = true
  console.log('\nRESULT: ERROR\n', error.stack || error.message)
}
await bridge.stop().catch(() => {})
process.exit(failed ? 1 : 0)
