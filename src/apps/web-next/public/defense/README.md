# 已上线答辩演示

2026-09-06 从 home `/srv/stacks/mathpilot-next/deploy/dev/web-dist/defense/` 同步。
`index.html` 是演示入口；`assets/` 保存演示 PDF、视频、缩略图和知识库数据，
`_shared/` 保存实际引用的样式与翻页运行时。

本目录随 Web 的 Vite 构建原样复制到 `dist/defense/`。请保留资源的相对路径。
已移除重复入口 `mathpilot-defense.html` 和未被使用的图表库、代码高亮库及额外主题。
字体 CSS 仍引用原有 Google Fonts，可用系统字体回退；当前演示不承诺完全离线字体一致。

答辩稿和信息卡模板见仓库 `design-docs/defense/`。这里不保存演示账号密码。
