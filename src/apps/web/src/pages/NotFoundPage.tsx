import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="page narrow" id="main-content">
      <section className="page-hero compact">
        <p className="eyebrow">页面不存在</p>
        <h1>这一步没有找到</h1>
        <p className="lede">返回学习空间，继续当前任务。</p>
        <div className="action-cluster"><Link className="btn cinnabar" to="/">返回首页</Link></div>
      </section>
    </main>
  );
}
