/**
 * Discord Gateway 二进制帧流式解码（zlib-stream）
 * 逻辑参考 kanzhege.js，适配实时 WS 逐帧输入
 */
const zlib = require('node:zlib')

const ZLIB_SUFFIX = Buffer.from([0x00, 0x00, 0xff, 0xff])

class DiscordGatewayDecoder {
  constructor() {
    this._inflate = null
    this._chunks = []
  }

  _resetInflate() {
    if (this._inflate) {
      this._inflate.removeAllListeners('data')
      this._inflate.close?.()
      this._inflate = null
    }
    this._inflate = zlib.createInflate()
    this._chunks = []
    this._inflate.on('data', (chunk) => this._chunks.push(chunk))
  }

  /**
   * @param {Buffer|string|ArrayBuffer} payload
   * @returns {Promise<object|null>}
   */
  decodeFrame(payload) {
    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(
          typeof payload === 'string' ? payload : new Uint8Array(payload),
        )

    if (!buf.length) return Promise.resolve(null)

    if (buf[0] === 0x7b) {
      return Promise.resolve(JSON.parse(buf.toString('utf8')))
    }

    if (!buf.subarray(-4).equals(ZLIB_SUFFIX)) {
      return Promise.resolve(null)
    }

    if (buf[0] === 0x78) {
      this._resetInflate()
    }

    if (!this._inflate) {
      return Promise.resolve(null)
    }

    this._chunks = []

    return new Promise((resolve, reject) => {
      this._inflate.write(buf, (err) => {
        if (err) {
          reject(err)
          return
        }

        if (!this._chunks.length) {
          resolve(null)
          return
        }

        try {
          resolve(
            JSON.parse(Buffer.concat(this._chunks).toString('utf8')),
          )
        } catch (parseErr) {
          reject(parseErr)
        }
      })
    })
  }

  reset() {
    if (this._inflate) {
      this._inflate.removeAllListeners('data')
      this._inflate.close?.()
      this._inflate = null
    }
    this._chunks = []
  }
}

function isDiscordGatewayUrl(url) {
  return /gateway.*\.discord\.gg/i.test(url)
}

module.exports = { DiscordGatewayDecoder, ZLIB_SUFFIX, isDiscordGatewayUrl }
