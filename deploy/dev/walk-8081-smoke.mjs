// 8081 产品入口冒烟：登录 → 找到自我测评入口 → 空态区分验证
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(5000);
  const signin = await cdp.evaluate(`(async () => {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'student@mathpilot.local', password: 'MathPilotStudent123!' }),
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, err: j?.error?.message || j?.message || null };
  })()`);
  console.log('signin 8081:', JSON.stringify(signin));
  await cdp.send('Page.reload');
  await cdp.sleep(6000);
  const st1 = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return {
      url: location.href,
      hasEntry: !!document.querySelector('[aria-label="自我测评"]'),
      authUi: body.includes('新对话') && body.includes('学习记录'),
      rootWelcome: body.includes('今天想从哪道数学问题开始'),
      head: body.slice(0, 180),
    };
  })()`);
  console.log('8081 root:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/8081-1-root.png');
}
