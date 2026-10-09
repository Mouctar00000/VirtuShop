const https = require('https');
const fs = require('fs');
const path = require('path');

// Charger les variables depuis .env
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (e) {}

const token = process.env.VERCEL_TOKEN || process.env.VERCEL_AUTH_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;

if (!token) {
  console.error('Erreur: VERCEL_TOKEN non configuré dans .env');
  process.exit(1);
}

https.get(`https://api.vercel.com/v6/domains/getvirtu.shop/config?teamId=${teamId || ''}`, {
  headers: { 'Authorization': 'Bearer ' + token }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log(JSON.stringify(JSON.parse(d), null, 2)));
});
