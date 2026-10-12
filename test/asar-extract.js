/**
 * Extract @deepseek-ai packages from the installed DeepSeek Harness app.asar so
 * the plugin's adapter can be validated against the REAL kernel.
 *
 * Files are located at 16 + headerSize + offset (the header JSON begins at
 * byte 16) and each entry is verified against the SHA-256 the asar records,
 * so a misaligned read can never silently produce a corrupt module.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** Uniform byte shift between recorded asar offsets and stored file content. */
const CONTENT_SHIFT = 2

function openAsar() {
  const fd = fs.openSync(ASAR, 'r')
  const hs = Buffer.alloc(16)
  fs.readSync(fd, hs, 0, 16, 0)
  const headerSize = hs.readUInt32LE(12)
  const probe = Buffer.alloc(headerSize + 16)
  fs.readSync(fd, probe, 0, probe.length, 16)
  const header = JSON.parse(probe.toString('utf8', 0, headerSize))
  return { fd, header, dataBase: 16 + headerSize }
}

function nodeAt(header, asarPath) {
  let node = header
  for (const part of asarPath.split('/')) {
    if (!node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node
}

/**
 * Extract one package directory from the asar into `dest`.
 *
 * This app.asar stores every file with a uniform 2-byte prefix before its
 * recorded content, so offsets are shifted by CONTENT_SHIFT. Each file is
 * verified against the SHA-256 the asar records; a misaligned read raises
 * instead of silently producing a corrupt module.
 *
 * @returns {{files: number, bytes: number, verified: number}} extraction stats
 */
export function extractPackage(header, fd, dataBase, prefix, dest) {
  let files = 0
  let bytes = 0
  let verified = 0
  const walk = (node, rel) => {
    for (const [key, value] of Object.entries(node.files || {})) {
      const full = rel ? `${rel}/${key}` : key
      if (value.files) { walk(value, full); continue }
      if (full !== prefix && !full.startsWith(prefix + '/')) continue
      const out = path.join(dest, full.slice(prefix.length).replace(/^\//, ''))
      fs.mkdirSync(path.dirname(out), { recursive: true })
      const buffer = Buffer.alloc(value.size)
      fs.readSync(fd, buffer, 0, value.size, dataBase + Number(value.offset) + CONTENT_SHIFT)
      const expected = value.integrity?.hash
      if (expected) {
        const actual = crypto.createHash('sha256').update(buffer).digest('hex')
        if (actual !== expected) {
          throw new Error(`asar integrity mismatch for ${full} (extractor bug)`)
        }
        verified++
      }
      fs.writeFileSync(out, buffer)
      files++
      bytes += buffer.length
    }
  }
  walk(header, '')
  return { files, bytes, verified }
}

export { openAsar, nodeAt }
