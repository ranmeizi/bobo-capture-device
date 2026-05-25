const crypto = require('crypto')

/**
 * 计算签名（Node crypto，输出与 crypto-js HmacSHA256 hex 一致）
 */
async function calculateSignature(signString, appSecret) {
  return crypto
    .createHmac('sha256', appSecret)
    .update(signString)
    .digest('hex')
    .toLowerCase()
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    return parseFloat(value.toString()).toString()
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeValue(item))
      .filter((item) => item !== '')

    normalized.sort()

    return `[${normalized.join(',')}]`
  }

  if (value && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort()

    const pairs = sortedKeys
      .map((key) => {
        const normalized = normalizeValue(value[key])
        return normalized !== '' ? `${key}:${normalized}` : null
      })
      .filter((pair) => pair !== null)

    return `{${pairs.join(',')}}`
  }

  return ''
}

async function beforeRequest(config) {
  const timestamp = Date.now()
  const nonce = Math.floor(Math.random() * 1000000000)
  const contentType =
    config.headers['content-type'] || config.headers['Content-Type']

  console.log('beforeRequest', contentType, config)

  if (config.method?.toLocaleUpperCase() === 'GET') {
    const sign = normalizeValue({
      ...(config.params || {}),
      timestamp,
      nonce,
    })

    config.headers.set(
      'x-signature',
      await calculateSignature(sign, 'function'),
    )
  } else if (
    config.method?.toLocaleUpperCase() === 'POST' &&
    contentType.indexOf('application/json') !== -1
  ) {
    const sign = normalizeValue({
      ...(config.data || {}),
      timestamp,
      nonce,
    })

    config.headers.set(
      'x-signature',
      await calculateSignature(sign, 'function'),
    )
  } else if (
    config.method?.toLocaleUpperCase() === 'POST' &&
    contentType.indexOf('application/x-www-form-urlencoded') !== -1
  ) {
    const sign = normalizeValue({
      ...(config.data || {}),
      file: undefined,
      files: undefined,
      timestamp,
      nonce,
    })
    config.headers.set(
      'x-signature',
      await calculateSignature(sign, 'function'),
    )
  } else if (
    config.method?.toLocaleUpperCase() === 'POST' &&
    contentType.indexOf('multipart/form-data') !== -1
  ) {
    const sign = normalizeValue({
      ...(config.data || {}),
      file: undefined,
      files: undefined,
      timestamp,
      nonce,
    })
    config.headers.set(
      'x-signature',
      await calculateSignature(sign, 'function'),
    )
  }

  config.headers.set('x-timestamp', timestamp)
  config.headers.set('x-nonce', nonce)
}

module.exports = { calculateSignature, beforeRequest }
