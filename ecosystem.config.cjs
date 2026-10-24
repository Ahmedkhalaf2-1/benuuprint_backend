// PM2 process definition for production. Contains no secrets: configuration comes from the server's
// `.env` (read by the app from `cwd`) and/or the environment PM2 is started from.
//   pm2 start ecosystem.config.cjs --env production
//   pm2 restart benue-backend --update-env
module.exports = {
  apps: [
    {
      name: 'benue-backend',
      script: 'dist/main.js',
      cwd: __dirname, // the app loads `.env` and resolves relative paths from here
      // The in-process scheduler must run exactly once: fork mode, single instance (never cluster).
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      kill_timeout: 10000, // let Nest shutdown hooks finish
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
