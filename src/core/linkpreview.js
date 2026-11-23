'use strict'
// Vistas previas de enlaces. Las obtiene QUIEN ENVÍA el mensaje (los demás nunca contactan con el sitio) y las reparte
// como un evento firmado. Como el servidor al que apunta un enlace lo elige quien escribe, la descarga es defensiva:
// solo http/https, nunca hacia direcciones privadas, locales o de metadatos de la nube (también tras redirecciones y
// sin poder engañarla con un DNS cambiante: se conecta a la IP ya comprobada), con límite de tamaño y de tiempo.
const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')

const MAX_BYTES = 400 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT = 6000

const blocked = new net.BlockList()
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blocked.addSubnet(ip, bits, 'ipv4')
for (const [ip, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) blocked.addSubnet(ip, bits, 'ipv6')

/** ¿Es una dirección que no debe contactarse (privada, local, multicast…)? Si no se entiende, sí. */
function isPrivateAddress(ip) {
  const v = net.isIP(ip)
  if (!v) return true
  if (v === 6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip) // IPv4 dentro de IPv6
    if (m) return isPrivateAddress(m[1])
    const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
    if (h) { const a = parseInt(h[1], 16); const b = parseInt(h[2], 16); return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`) }
  }
  return blocked.check(ip, v === 6 ? 'ipv6' : 'ipv4')
}

/** Primer enlace http(s) de un texto, sin la puntuación final. */
function extractUrl(text) {
  const m = /\bhttps?:\/\/[^\s<>"'`\])]+/i.exec(String(text || ''))
  if (!m) return null
  const url = m[0].replace(/[.,;:!?]+$/, '')
  try { return /^https?:$/.test(new URL(url).protocol) && url.length <= 500 ? url : null } catch { return null }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»' }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n) } catch { return '' } }
  return ENT[e.toLowerCase()] ?? m
})
const tidy = (s, max) => {
  const t = decode(String(s || '')).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** Título, descripción y sitio de una página HTML (Open Graph, Twitter o etiquetas normales). null si no hay nada útil. */
function parseMeta(html, url) {
  html = String(html).slice(0, MAX_BYTES)
  const meta = {}
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase()
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    if (key && content && !(key in meta)) meta[key] = content[1] ?? content[2] ?? content[3] ?? ''
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const title = tidy(meta['og:title'] || meta['twitter:title'] || titleTag, 200)
  const desc = tidy(meta['og:description'] || meta['twitter:description'] || meta.description, 300)
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch {}
  const site = tidy(meta['og:site_name'] || host, 100)
  return title || desc ? { url, title, desc, site } : null
}

function pickAddress(host, lookup, allowPrivate) {
  // allowPrivate (solo pruebas): true, o una función que decide qué direcciones privadas se admiten.
  const allowed = (ip) => (typeof allowPrivate === 'function' ? allowPrivate(ip) : allowPrivate) || !isPrivateAddress(ip)
  if (net.isIP(host)) return allowed(host) ? Promise.resolve({ address: host, family: net.isIP(host) }) : Promise.reject(new Error('dirección no permitida'))
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, list) => {
      if (err) return reject(err)
      const ok = (list || []).find((a) => allowed(a.address))
      ok ? resolve(ok) : reject(new Error('dirección no permitida'))
    })
  })
}

/**
 * @param {string} rawUrl
 * @param {{lookup?: Function, allowPrivate?: boolean, timeout?: number}} [o]  allowPrivate: solo pruebas
 * @returns {Promise<{url,title,desc,site}|null>}
 */
async function fetchPreview(rawUrl, { lookup = dns.lookup, allowPrivate = false, timeout = TIMEOUT } = {}) {
  let url = new URL(rawUrl)
  const deadline = Date.now() + timeout
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(url.protocol)) return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addr = await pickAddress(host, lookup, allowPrivate)
    const res = await new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http
      const req = lib.request({
        host, port: url.port || undefined, path: url.pathname + url.search, method: 'GET', servername: net.isIP(host) ? undefined : host,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; HumbleChat link preview)', accept: 'text/html,application/xhtml+xml', 'accept-language': 'es,en;q=0.8', host: url.host },
        lookup: (_h, _o, cb) => (_o?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)), // conecta a la IP ya comprobada
        timeout: Math.max(500, deadline - Date.now())
      }, resolve)
      const stop = setTimeout(() => req.destroy(new Error('timeout')), Math.max(500, deadline - Date.now()))
      req.on('close', () => clearTimeout(stop))
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end()
    })
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      url = new URL(res.headers.location, url)
      continue
    }
    if (res.statusCode !== 200 || !/\b(text\/html|application\/xhtml\+xml)\b/i.test(res.headers['content-type'] || '')) { res.resume(); return null }
    const charset = /charset=["']?([\w-]+)/i.exec(res.headers['content-type'])?.[1] || 'utf-8'
    const chunks = []
    let got = 0
    for await (const c of res) {
      chunks.push(c)
      got += c.length
      if (got >= MAX_BYTES || /<\/head>/i.test(c.toString('latin1'))) { res.destroy(); break }
    }
    let html
    try { html = new TextDecoder(charset).decode(Buffer.concat(chunks)) } catch { html = Buffer.concat(chunks).toString('utf8') }
    return parseMeta(html, url.toString())
  }
  return null
}

module.exports = { fetchPreview, parseMeta, extractUrl, isPrivateAddress }
