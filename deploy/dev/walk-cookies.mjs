export async function run(cdp) {
  await cdp.send('Network.enable');
  const cs = await cdp.send('Network.getAllCookies');
  const hits = cs.cookies.filter(c => c.name.includes('mathpilot'));
  console.log('mathpilot cookies in store:', hits.length, hits.map(c => `${c.name}@${c.domain}`).join(', '));
}
