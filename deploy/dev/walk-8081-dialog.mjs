// 8081: 确认登录态(账户菜单/侧栏) → 打开自我测评 Dialog
export async function run(cdp) {
  const me = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    if (r.status === 401) return { authed: false, status: r.status };
    const j = await r.json().catch(() => null);
    return { authed: true, status: r.status, user: j?.user?.email || j?.email || JSON.stringify(j).slice(0, 120) };
  })()`);
  console.log('me:', JSON.stringify(me));

  const st = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return {
      hasEntry: !!document.querySelector('[aria-label="自我测评"]'),
      hasSidebar: body.includes('学习记录'),
      hasNewChat: body.includes('新对话'),
      bodyLen: body.length,
      sample: body.slice(0, 220),
    };
  })()`);
  console.log('ui:', JSON.stringify(st));

  if (st.hasEntry) {
    const open = await cdp.evaluate(`(() => { const b = document.querySelector('[aria-label="自我测评"]'); if (!b) return 'no'; b.click(); return 'ok'; })()`);
    console.log('entry click:', open);
    await cdp.sleep(4000);
    const dlg = await cdp.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return { hasDialog: false };
      const t = d.innerText;
      return { hasDialog: true, inPick: t.includes('① 选择章节'), inAnswer: t.includes('提交答案'), head: t.slice(0, 200) };
    })()`);
    console.log('dialog:', JSON.stringify(dlg));
    await cdp.screenshot('ui-shots/8081-2-dialog.png');
  }
}
