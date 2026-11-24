const { server, host, port, mode } = require('./app');
if (require.main === module) server.listen(port, host,
  () => console.log(`NFT console: http://${host}:${port} (${mode})`));
module.exports = { server };
