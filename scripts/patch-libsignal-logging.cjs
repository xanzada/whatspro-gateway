const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, '..', 'node_modules', 'libsignal', 'src', 'session_record.js');
const unsafe = 'console.info("Removing old closed session:", oldestSession);';
const safe = 'console.info("Removing old closed Signal session");';
const source = fs.readFileSync(target, 'utf8');

if (source.includes(safe)) process.exit(0);
if (!source.includes(unsafe)) {
  throw new Error('LIBSIGNAL_LOG_PATCH_TARGET_NOT_FOUND');
}

fs.writeFileSync(target, source.replace(unsafe, safe));
