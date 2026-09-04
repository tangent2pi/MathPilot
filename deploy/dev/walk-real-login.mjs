export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/' });
  await cdp.sleep(5000);
  const signin = await cdp.evaluate(`(async () => {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'student@mathpilot.local', password: 'MathPilotStudent123!' }),
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, err: j?.error?.message || j?.message || null, hasToken: (j?.token || j?.session) ? true : false };
  })()`);
  console.log('signin:', JSON.stringify(signin));
  await cdp.send('Page.reload');
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return {
      url: location.href,
      auth: body.includes('数学智元') && body.includes('新对话'),
      hasStudent: body.includes('Demo Student') || body.includes('学生'),
      head: body.slice(0, 200),
    };
  })()`);
  console.log('after reload:', st.url, '| auth UI:', st.auth, '| student:', st.hasStudent);
  console.log('head:', JSON.stringify(st.head));
}
