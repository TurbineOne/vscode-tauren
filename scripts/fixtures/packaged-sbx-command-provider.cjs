// The provider describes creation. It does not call SBX itself.
const { appendFileSync } = require('node:fs');

const [mainKit, extraMixin, calls] = process.argv.slice(2);
appendFileSync(calls, `${process.cwd()}\n`);
process.stdout.write(JSON.stringify({ version: 1, argv: ['sbx', 'create', '--kit', extraMixin, mainKit] }) + '\n');
