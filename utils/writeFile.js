const fs = require('fs')
const path = require('path')

/**
 * 写入文件，若目录不存在则先创建
 * @param {string} filePath - 文件路径
 * @param {string|Buffer|Uint8Array} data - 要写入的内容
 * @param {object} [options] - fs.writeFile 的选项，如 { encoding: 'utf8' }
 */
function writeFileSync(filePath, data, options = {}) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, data, options)
}

/**
 * 异步写入文件，若目录不存在则先创建
 * @param {string} filePath - 文件路径
 * @param {string|Buffer|Uint8Array} data - 要写入的内容
 * @param {object} [options] - fs.writeFile 的选项，如 { encoding: 'utf8' }
 * @returns {Promise<void>}
 */
async function writeFile(filePath, data, options = {}) {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(filePath, data, options)
}

module.exports = { writeFile, writeFileSync }
