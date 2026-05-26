const path = require('path')

/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: 'bobo-cap',
      cwd: __dirname,
      script: 'src/main.ts',
      interpreter: path.join(__dirname, 'node_modules/.bin/ts-node'),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      merge_logs: true,
      time: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
