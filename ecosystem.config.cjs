module.exports = {
  apps: [
    {
      name: 'google-ads-tool',
      cwd: './server',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 5011,
      },
    },
  ],
};
