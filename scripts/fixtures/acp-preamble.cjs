'use strict';
const readline = require('node:readline');
process.stdout.write('Hermes ACP launcher ready\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\n');
  if (message.method === 'ping') {
    process.stdout.write('Rich status after initialize\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pong: true } }) + '\n');
  }
});
