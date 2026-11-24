const path = require('path')

const root = __dirname

/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: 'bobo-cap',
      cwd: root,
      script: path.join(root, 'dist/main.js'),
      interpreter: 'node',
      node_args: `--import ${path.join(root, 'dist/instrument.mjs')}`,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // 退出前要等 Sentry flush；默认 1600ms 容易在事件发出前被 SIGKILL
      kill_timeout: 8000,
      max_memory_restart: '500M',
      merge_logs: true,
      time: true,
      out_file: path.join(root, 'logs/pm2-out.log'),
      error_file: path.join(root, 'logs/pm2-error.log'),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
