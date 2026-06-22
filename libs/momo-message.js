const axios = require('axios')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
const { beforeRequest } = require('./sign')

dayjs.extend(utc)
dayjs.extend(timezone)

const checkReg = /<.+> .+ (got|executed|stole)/
const killReg = /<.+> (.+) executed \[(.+)\]\(.+mob_id=(\d+)&.+\) at (.+)/
const dropReg = /<.+> (.+) got \[(.+)\]\(.+item_id=(\d+)&.+\)/
const stoleReg = /<.+> (.+) stole \[(.+)\]\(.+item_id=(\d+)&.+\)/

const TYPES = {
  executed: 0,
  got: 1,
  stole: 2,
}

const client = axios.create()
client.interceptors.request.use(beforeRequest)

/**
 * @param {string} content
 * @param {string|number|Date} timestamp
 * @returns {object|null}
 */
function parseMomoNote(content, timestamp) {
  const typeMatch = content.match(checkReg)?.[1]
  const type = TYPES[typeMatch]
  const ts = dayjs.utc(timestamp).tz('Asia/Shanghai').valueOf()
  const utcTs = dayjs.utc(timestamp).valueOf()

  if (type === 0) {
    const res = content.match(killReg) || []
    const [, subject, object, objectId, map] = res
    if (!subject) return null

    return {
      ts,
      type: 0,
      key: `${ts}_${subject}_${objectId}`,
      subject,
      object,
      objectId,
      map,
      origin: content,
      utc: utcTs,
    }
  }

  if (type === 1) {
    const res = content.match(dropReg) || []
    const [, subject, object, objectId] = res
    if (!subject) return null

    return {
      ts,
      type: 1,
      key: `${ts}_${subject}_${objectId}`,
      subject,
      object,
      objectId,
      origin: content,
      utc: utcTs,
    }
  }

  if (type === 2) {
    const res = content.match(stoleReg) || []
    const [, subject, object, objectId] = res
    if (!subject) return null

    return {
      ts,
      type: 2,
      key: `${ts}_${subject}_${objectId}`,
      subject,
      object,
      objectId,
      origin: content,
      utc: utcTs,
    }
  }

  return null
}

/**
 * @param {Array<{ content: string, timestamp: string }>} messages
 */
function parseMomoNotes(messages) {
  return messages
    .map((msg) => parseMomoNote(msg.content, msg.timestamp))
    .filter(Boolean)
}

/**
 * @param {object[]} notes
 */
async function pushMomoNotes(notes) {
  if (!notes.length) return null

  const res = await client.post(
    'https://boboan.net/api/momoro/ingamenews/push',
    notes,
  )
  return res.data
}

async function getLatestTs() {
  const res = await client.get('https://boboan.net/api/momoro/getLastestTs')
  return res.data.data
}

module.exports = {
  parseMomoNote,
  parseMomoNotes,
  pushMomoNotes,
  getLatestTs,
}
