export function AppLoading({ label = "正在读取" }: { label?: string }) {
  return (
    <main className="app-loading page" id="main-content" aria-live="polite" aria-busy="true">
      <span className="brand-pulse" aria-hidden="true">∴</span>
      <strong>{label}</strong>
      <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
    </main>
  );
}
