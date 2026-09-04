export async function run(cdp) {
  const r = await cdp.evaluate(`(async () => {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' });
    const j = await res.json().catch(() => null);
    const cookies = document.cookie;
    return { status: res.status, body: JSON.stringify(j).slice(0, 200), cookies };
  })()`);
  console.log('get-session:', r.status, r.body);
  console.log('document.cookie:', r.cookies);
}
