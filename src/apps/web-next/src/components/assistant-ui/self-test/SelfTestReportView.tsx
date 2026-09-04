"use client";

// 自我测评终版报告的视觉渲染（六维雷达 + 知识点掌握表 + 风险因子 + 学习计划 + 多轮趋势）。
// 对话框与学生详情页共用：输入为后端 report.ts 透传的 ReportPayload（纯数据，无状态依赖）。
import { AlertCircleIcon } from "lucide-react";
import type { FC } from "react";
import type { ReportPayload } from "@/learning/data/selfTestClient";
import { cn } from "@/lib/utils";

// 六维雷达 + 知识点掌握 + 风险因子 + 学习计划（data 用 payload 渲染，无需图表库）
export const ReportDetail: FC<{ payload: ReportPayload }> = ({ payload }) => {
  const p = payload;
  const masteryText = p.chapter.mastery == null ? "—" : `${Math.round(p.chapter.mastery * 100)}%`;
  return (
    <div className="flex flex-col gap-4">
      {/* 结论卡 */}
      <div className="rounded-xl border bg-muted/30 px-3.5 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <span className="text-muted-foreground text-xs">整章掌握度</span>
            <div className="text-lg font-semibold">{masteryText}</div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">风险等级</span>
            <div className={cn(
              "font-semibold",
              p.chapter.risk === "高" ? "text-rose-600" : p.chapter.risk === "中" ? "text-amber-600" : "text-emerald-600",
            )}>
              {p.chapter.risk}风险（{p.chapter.riskScore}）
            </div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">最弱项</span>
            <div className="font-medium">{p.chapter.weakest ?? "—"}</div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">章节</span>
            <div className="font-medium">{p.chapter.chapterName}</div>
          </div>
        </div>
        {p.chapter.goalScore != null && p.chapter.gap != null && (
          <p className="mt-2 text-xs text-muted-foreground">
            目标差距 = 目标分 {p.chapter.goalScore} − 当前掌握度 {p.chapter.mastery == null ? "—" : Math.round(p.chapter.mastery * 100)}% ={" "}
            <span className="font-medium">
              {p.chapter.gap > 0 ? `还差 ${p.chapter.gap} 分` : "已达目标"}
            </span>
            {p.chapter.gap > 0 && "（差距越大，学习计划周数越长）"}
          </p>
        )}
      </div>

      {/* 测评概览 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[
          { label: "答题", value: `${p.chapter.totalAnswered} 题` },
          { label: "覆盖广度", value: `${p.chapter.coveragePct}%（${p.points.filter((x) => x.tested).length}/${p.chapter.totalPoints} 点）` },
          { label: "薄弱集中度", value: `${p.chapter.weaknessPct}%` },
          { label: "进行轮次", value: `${p.chapter.rounds} 轮` },
          { label: "达标线", value: p.chapter.verdict === "mastered" ? "已掌握" : p.chapter.verdict === "developing" ? "待巩固" : "证据不足" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border bg-muted/20 px-2.5 py-1.5">
            <div className="text-muted-foreground text-xs">{item.label}</div>
            <div className="text-sm font-medium">{item.value}</div>
          </div>
        ))}
      </div>

      {/* 六维雷达 */}
      <div className="rounded-xl border p-3">
        <div className="mb-2 text-sm font-medium">六维画像</div>
        <RadarChart radar={p.radar} />
      </div>

      {/* 知识点掌握（表格） */}
      <div className="rounded-xl border p-3.5">
        <div className="mb-2 text-sm font-medium">知识点掌握情况</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="border-b px-2 py-1 font-medium">知识点</th>
                <th className="border-b px-2 py-1 text-right font-medium">掌握度</th>
                <th className="border-b px-2 py-1 text-right font-medium">作答</th>
                <th className="border-b px-2 py-1 text-right font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {p.points.map((point) => (
                <tr key={point.id} className="border-b border-muted/40 last:border-0">
                  <td className="max-w-[45%] truncate px-2 py-1.5">{point.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{point.pMastery.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    答 {point.answered}
                    {!point.tested && <span className="text-muted-foreground/60"> · 待复测</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={cn(
                      "inline-block rounded px-1.5 py-0.5 text-xs",
                      point.state === "mastered" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : point.state === "weak" ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                          : "bg-muted text-muted-foreground",
                    )}>
                      {stateLabelEdit(point.state)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 风险因子 */}
      {p.risks.length > 0 && (
        <div className="rounded-xl border p-3.5">
          <div className="mb-1.5 text-sm font-medium">风险因子</div>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {p.risks.map((risk, index) => <li key={index} className="flex gap-1.5"><AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />{risk}</li>)}
          </ul>
        </div>
      )}

      {/* 学习计划 */}
      {p.plan.length > 0 && (
        <div className="rounded-xl border p-3.5">
          <div className="mb-2 text-sm font-medium">
            学习计划
            <span className="text-muted-foreground ml-1.5 text-xs font-normal">
              （按目标差距 {p.chapter.gap == null ? "未设置目标" : p.chapter.gap > 0 ? `还差 ${p.chapter.gap} 分` : "已达标"}规划 {p.plan.length} 周）
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            {p.plan.map((week) => {
              const focus = week.dailyTasks[0]?.match(/重点：(.+)[）)]\s*$/)?.[1]?.trim() ?? "保持当前掌握度";
              const daily = week.dailyTasks[0] ?? "";
              const review = week.dailyTasks[1] ?? "";
              const steps = [
                { k: "本周重点知识点", v: focus },
                { k: "每日训练", v: daily },
                { k: "复习巩固", v: review },
                { k: "阶段检验", v: week.passLine },
              ];
              return (
                <div key={week.week} className="rounded-lg border bg-muted/20 p-2.5 text-sm">
                  <div className="mb-1.5 font-medium">第 {week.week} 周 · {week.theme}</div>
                  <ul className="flex flex-col gap-1">
                    {steps.map((s, i) => (
                      <li key={s.k} className="flex gap-1.5 text-muted-foreground">
                        <span className="bg-primary/10 text-primary flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-medium">{i + 1}</span>
                        <span><span className="text-foreground/90 font-medium">{s.k}：</span>{s.v}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 历史趋势 */}
      {p.trend.length > 1 && (
        <div className="rounded-xl border p-3.5">
          <div className="mb-2 text-sm font-medium">多轮掌握度趋势</div>
          <div className="flex items-end gap-2">
            {p.trend.map((point) => (
              <div key={point.round} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-primary/15 text-center text-xs font-medium">
                  {point.mastery == null ? "—" : `${Math.round(point.mastery * 100)}%`}
                </div>
                <div className="text-muted-foreground text-xs">R{point.round}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// 纯 SVG 六维雷达（0–100），无第三方图表依赖
export const RadarChart: FC<{ radar: { dimension: string; score: number | null }[] }> = ({ radar }) => {
  const dims = radar.slice(0, 6).map((d, index, arr) => ({
    ...d,
    angle: -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, arr.length),
  }));
  const size = 330;
  const height = 230;
  const centerX = size / 2;
  const centerY = height / 2;
  const radius = 78;
  // 实际坐标按各自角度计算
  const coords = dims.map((d) => [
    centerX + radius * (d.score == null ? 0 : Math.min(100, Math.max(0, d.score)) / 100) * Math.cos(d.angle),
    centerY + radius * (d.score == null ? 0 : Math.min(100, Math.max(0, d.score)) / 100) * Math.sin(d.angle),
  ] as [number, number]);

  const axisCoords = dims.map((d) => [
    centerX + radius * Math.cos(d.angle),
    centerY + radius * Math.sin(d.angle),
  ] as [number, number]);

  const labels = dims.map((d) => {
    const x = centerX + (radius + 26) * Math.cos(d.angle);
    const y = centerY + (radius + 26) * Math.sin(d.angle);
    return { ...d, x, y };
  });

  const polygon = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  return (
    <div className="flex justify-center">
      <svg width={330} height={230} viewBox="0 0 330 230" role="img" aria-label="六维画像雷达图">
        {/* 网格 4 层 */}
        {[1, 2, 3, 4].map((ring) => {
          const r = (radius * ring) / 4;
          const poly = dims.map((d) => [
            centerX + r * Math.cos(d.angle),
            centerY + r * Math.sin(d.angle),
          ].map((n) => n.toFixed(1)).join(","));
          return <polygon key={ring} points={poly.join(" ")} fill="none" stroke="var(--border)" strokeWidth="1" />;
        })}
        {/* 主轴 */}
        {axisCoords.map(([x, y], index) => (
          <line key={index} x1={centerX} y1={centerY} x2={x} y2={y} stroke="var(--border)" strokeWidth="0.75" />
        ))}
        {/* 六维数据面 */}
        <polygon key="data" points={polygon} fill="color-mix(in srgb, var(--primary) 25%, transparent)" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" />
        {coords.map(([x, y], index) => (
          <circle key={index} cx={x} cy={y} r="2.5" fill="var(--primary)" />
        ))}
        {/* 维度标签 */}
        {labels.map((label) => (
          <text
            key={label.dimension}
            x={label.x}
            y={label.y + 3.5}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted-foreground)"
          >
            {label.dimension}
            <tspan fontSize="9" dy="10" fontWeight="600">
              {label.score == null ? "" : ` ${label.score}`}
            </tspan>
          </text>
        ))}
      </svg>
    </div>
  );
};

function stateLabelEdit(state: string): string {
  switch (state) {
    case "mastered": return "已掌握";
    case "possibly_mastered": return "可能掌握";
    case "learning": return "学习中";
    case "weak": return "薄弱";
    default: return "证据不足";
  }
}