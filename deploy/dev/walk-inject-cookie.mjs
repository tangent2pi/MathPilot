import { readFileSync } from 'node:fs';
export async function run(cdp) {
  const raw = readFileSync('C:/Users/小渊/AppData/Local/Temp/fresh-cookies.txt', 'utf8');
  let injected = 0;
  for (let line of raw.split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [, , , , , name, value] = parts;
    if (!name.startsWith('mathpilot')) continue;
    await cdp.send('Network.setCookie', {
      name, value, domain: '127.0.0.1', path: '/',
      httpOnly: true, secure: false, sameSite: 'Lax',
      expires: Math.floor(Date.now()/1000) + 7*86400,
    });
    injected++;
    console.log('injected:', name);
  }
  console.log('total:', injected);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(async () => {
    const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.status);
    const body = document.body.innerText;
    return { me, auth: body.includes('数学智元') && body.includes('新对话') };
  })()`);
  console.log('me:', st.me, '| authenticated UI:', st.auth);
}
