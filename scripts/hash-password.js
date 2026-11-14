#!/usr/bin/env node
/**
 * Generates the scrypt hash to put in ADMIN_PASSWORD_HASH (Vercel > Settings > Environment Variables).
 *   node scripts/hash-password.js            -> asks for the password (hidden input)
 *   node scripts/hash-password.js --generate -> generates a strong random password and prints it once
 * The plain password is never written anywhere by this script.
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const group = () => { let s = ''; while (s.length < 5) { const b = crypto.randomBytes(1)[0]; if (b < alphabet.length * 4) s += alphabet[b % alphabet.length]; } return s; };
  return 'Gv-' + [group(), group(), group(), group()].join('-');
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  let password;
  if (process.argv.includes('--generate')) {
    password = generate();
    console.log('Generated password (store it in a password manager NOW, it is not saved):\n  ' + password + '\n');
  } else {
    password = await askHidden('New administrator password: ');
    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }
    if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      console.error('Use at least 12 characters with letters and digits.');
      process.exit(1);
    }
  }
  console.log('ADMIN_PASSWORD_HASH=' + hash(password));
  console.log('\nSet this value in Vercel (type: Sensitive) and redeploy. It is applied once, then the dashboard password is kept.');
})();
