import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { BackButton } from "../components/BackButton";
import { MathText } from "../components/MathText";
import { apiFetch, jsonBody } from "../lib/api";
import { aiRequestErrorMessage } from "../lib/ai-feedback";
import { PRODUCT_NAME } from "../lib/brand";

type Usage = { input?: number; cacheRead?: number; total?: number };
type AgentEvent = { type: string; detail?: string; label?: string; at?: string; status?: string; toolName?: string; usage?: Usage };
type EventsResponse = { events?: AgentEvent[] };
type ToolEvent = { name: string; status: string; detail: string };
type Message = { id: string; role: "user" | "assistant"; text: string; at?: string; tools: ToolEvent[]; usage?: Usage };

function lastTerminalEventIndex(events: AgentEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event && (event.type === "session_end" || event.type === "agent_end") && ["completed", "failed"].includes(event.status || "")) return index;
  }
  return -1;
}

function buildMessages(events: AgentEvent[]): Message[] {
  const messages: Message[] = [];
  let tools: ToolEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === "tool_start") tools.push({ name: event.toolName || "操作", status: "running", detail: event.detail || "" });
    else if (event.type === "tool_end") {
      const open = [...tools].reverse().find((item) => item.name === (event.toolName || "操作") && item.status === "running");
      if (open) Object.assign(open, { status: event.status || "completed", detail: event.detail || open.detail });
      else tools.push({ name: event.toolName || "操作", status: event.status || "completed", detail: event.detail || "" });
    } else if (event.type === "user_message") {
      messages.push({ id: `user-${index}`, role: "user", text: event.detail || "已发送一条引导", at: event.at, tools: [] });
    } else if (event.type === "assistant_message") {
      messages.push({ id: `assistant-${index}`, role: "assistant", text: event.detail || event.label || "处理完成", at: event.at, tools });
      tools = [];
    } else if (event.type === "turn_end" && event.usage) {
      const last = [...messages].reverse().find((message) => message.role === "assistant");
      if (last) last.usage = event.usage;
    }
  }
  if (tools.length) messages.push({ id: "tools-pending", role: "assistant", text: "完成了一组资料操作", tools });
  return messages;
}

export function AgentSessionPage() {
  const [params] = useSearchParams();
  const ref = params.get("ref") || "";
  const safe = /^(run_ktq|run_er)_[a-f0-9]{32}$/.test(ref);
  const task = ref.startsWith("run_er_") ? "补充错因与诊断规则" : "整理题目与知识点";
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("消息会加入当前对话的下一回合");
  const streamRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const events = useQuery({
    queryKey: ["agent-events", ref],
    queryFn: () => apiFetch<EventsResponse>(`/api/agent-sessions/${encodeURIComponent(ref)}/events`),
    enabled: safe,
    retry: true,
    refetchInterval: (query) => {
      const list = (query.state.data as EventsResponse | undefined)?.events ?? [];
      const lastTerminal = lastTerminalEventIndex(list);
      const resumed = lastTerminal >= 0 && list.slice(lastTerminal + 1).some((event) => ["agent_start", "turn_start", "tool_start"].includes(event.type));
      const terminal = lastTerminal >= 0 && !resumed;
      return terminal ? 5_000 : 1_200;
    },
  });
  const rawEvents = (events.data?.events ?? []).filter((event) => event.type !== "model_update");
  const messages = useMemo(() => buildMessages(rawEvents), [rawEvents]);
  const lifecycle = rawEvents.filter((event) => event.type === "session_end");
  const lastTerminalIndex = lastTerminalEventIndex(rawEvents);
  const resumedAfterTerminal = lastTerminalIndex >= 0 && rawEvents.slice(lastTerminalIndex + 1).some((event) => ["agent_start", "turn_start", "tool_start"].includes(event.type));
  const latestTerminal = lastTerminalIndex >= 0 && !resumedAfterTerminal ? rawEvents[lastTerminalIndex] : undefined;
  const stopped = latestTerminal?.status === "completed";
  const failed = latestTerminal?.status === "failed";
  const terminal = stopped || failed;
  const toolCount = rawEvents.filter((event) => event.type === "tool_start").length;
  const usages = rawEvents.filter((event) => event.type === "turn_end" && event.usage).map((event) => event.usage as Usage);
  const tokens = usages.reduce((sum, usage) => sum + Number(usage.total || 0), 0);
  const prompt = usages.reduce((sum, usage) => sum + Number(usage.input || 0) + Number(usage.cacheRead || 0), 0);
  const cache = usages.reduce((sum, usage) => sum + Number(usage.cacheRead || 0), 0);
  const status = !safe ? "地址无效" : failed ? "需要处理" : stopped ? "已完成" : events.isError ? "正在重新连接" : rawEvents.length ? "处理中" : "准备中";

  useEffect(() => {
    const stream = streamRef.current;
    if (stream && followRef.current) stream.scrollTo({ top: stream.scrollHeight, behavior: "auto" });
  }, [messages.length, rawEvents.length]);

  const send = useMutation({
    mutationFn: (message: string) => apiFetch(`/api/agent-sessions/${encodeURIComponent(ref)}/messages`, { method: "POST", ...jsonBody({ message }) }),
    onSuccess: async () => {
      setText("");
      setFeedback("已发送，将在当前步骤完成后继续");
      await queryClient.invalidateQueries({ queryKey: ["agent-events", ref] });
    },
    onError: (error) => setFeedback(aiRequestErrorMessage(error, "消息没有发送成功，请检查网络后重试。")),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); const value = text.trim(); if (value) { setFeedback("正在发送…"); send.mutate(value); } };

  return (
    <main className="page agent-chat-page" id="main-content">
      <BackButton fallback="/content" />
      <header className="chat-page-header"><div><p className="eyebrow">{ref.startsWith("run_er_") ? "诊断研究" : "内容整理"}</p><h1>{task}</h1><p className="mono">{safe ? ref : "无效的会话地址"}</p></div><div className="session-status"><span className={`status-pill ${failed ? "is-error" : stopped ? "is-complete" : "is-running"}`}>{status}</span><Link to="/content" className="btn ghost">返回内容任务</Link></div></header>
      <div className="agent-chat-layout">
        <section className="chat-panel" aria-label="会话内容">
          <div ref={streamRef} className="chat-stream" aria-live="polite" onScroll={(event) => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}>
            {!messages.length && <div className="chat-empty"><span className="spinner" /><p>{safe ? "会话正在准备，请稍候…" : "请从内容任务打开有效对话。"}</p></div>}
            {messages.map((message) => <article className={`message-row ${message.role}`} key={message.id}>
              <span className="message-avatar" aria-hidden="true">{message.role === "user" ? "你" : "∴"}</span>
              <div className="message-wrap"><div className="message-head"><strong>{message.role === "user" ? "你" : PRODUCT_NAME}</strong><time>{message.at ? new Date(message.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</time></div><div className="message-bubble"><MathText text={message.text} as="span" /></div>
                {!!message.tools.length && <details className="message-attachments"><summary>{message.tools.some((tool) => tool.status === "failed") ? `${message.tools.length} 个操作，有需要查看的项目` : `查看 ${message.tools.length} 个操作`}</summary><div className="attachment-list">{message.tools.map((tool, index) => <details className={`attachment-item ${tool.status}`} key={`${tool.name}-${index}`}><summary>{tool.name} · {tool.status === "failed" ? "未完成" : tool.status === "running" ? "进行中" : "已完成"}</summary><pre>{tool.detail}</pre></details>)}</div></details>}
                {message.usage && <small className="message-usage">本回合 {Number(message.usage.total || 0).toLocaleString()} tokens{Number(message.usage.input || 0) + Number(message.usage.cacheRead || 0) > 0 && Number(message.usage.cacheRead || 0) > 0 ? ` · 提示缓存 ${Math.round(Number(message.usage.cacheRead || 0) / (Number(message.usage.input || 0) + Number(message.usage.cacheRead || 0)) * 100)}%` : ""}</small>}
              </div>
            </article>)}
            {!terminal && safe && <div className="agent-typing"><span /><span /><span /><em>正在处理</em></div>}
          </div>
          <form className="chat-composer" onSubmit={submit}><label className="sr-only" htmlFor="agent-message">发送消息</label><textarea id="agent-message" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000} disabled={terminal || !safe} placeholder={failed ? "这段处理未完成，请返回内容任务后重试" : stopped ? "这段处理对话已经完成" : "补充说明，或请它核对某份资料…"} /><div className="composer-foot"><p aria-live="polite">{feedback}</p><AsyncButton className="cinnabar" type="submit" pending={send.isPending} pendingLabel="发送中…" disabled={!safe || terminal || !text.trim()}><Send aria-hidden="true" />发送</AsyncButton></div></form>
        </section>
        <aside className="session-overview"><section className="section-card"><p className="eyebrow">当前任务</p><h2>{task}</h2><dl className="session-facts"><div><dt>状态</dt><dd>{status}</dd></div><div><dt>回复</dt><dd>{messages.filter((item) => item.role === "assistant").length}</dd></div><div><dt>操作</dt><dd>{toolCount}</dd></div><div><dt>用量</dt><dd id="factTokens">{tokens ? tokens.toLocaleString() : "—"}</dd></div><div><dt>提示缓存</dt><dd id="factCache" title="已复用的提示 tokens 占全部提示 tokens 的比例">{prompt ? `${Math.round(cache / prompt * 100)}%` : "—"}</dd></div></dl></section><section className="section-card"><h2>对话会自动保存</h2><p className="muted">离开页面后仍可从内容任务重新打开。操作过程和引用资料会跟随对应回复保留。</p></section></aside>
      </div>
    </main>
  );
}
