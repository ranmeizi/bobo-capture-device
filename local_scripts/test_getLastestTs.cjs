const axios = require('axios')
const { beforeRequest } = require('../libs/sign')

const client = axios.create()
client.interceptors.request.use(beforeRequest)

async function getLastestTs() {
  return client
    .get('https://boboan.net/api/momoro/getLastestTs')
    .then((res) => res.data.data)
}

async function main() {
  try {
    const ts = await getLastestTs()
    console.log('getLastestTs 成功:', ts)
  } catch (err) {
    console.error('getLastestTs 失败:', err.message)
    if (err.response) {
      console.error('status:', err.response.status)
      console.error('data:', err.response.data)
    }
    process.exit(1)
  }
}

main()
