import { useMutation, useQuery } from "@tanstack/react-query";
import { ImagePlus, Send, Trash2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { MathText } from "../components/MathText";
import { apiFetch, jsonBody } from "../lib/api";

type ImageInput = { data: string; mimeType: string };
type Choice = { key: string; text_markdown: string };
type Question = { stem_markdown: string; stem_format?: string; options?: Choice[]; assets?: Array<{ image_data_url: string }>; published_packages?: Array<{ version?: string }> };
type Artifact = { artifact_id?: string; interaction_token?: string; title?: string; kind: string; content?: string; uri?: string };
type ChatMessage = { id: string; role: "student" | "agent"; text: string; label?: string };
type TraceStep = { status?: string; taskType?: string; label?: string; detail?: string; usage?: { total?: number; input?: number; cacheRead?: number } };
type Trace = { steps?: TraceStep[] };
type Judgment = { verdict?: string; decision_summary?: string };
type VerdictData = { state?: string; session_learning_record_id?: string; judgment?: Judgment; card?: { card_id?: string }; probe?: { question?: string }; claim?: { status?: string; resolved_error_cause?: string } };
type DraftHandle = { capture: (sessionId: string) => Promise<ImageInput | null> };

async function filesToImages(files: File[]): Promise<ImageInput[]> {
  return Promise.all(files.slice(0, 4).map((file) => new Promise<ImageInput>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve({ data: String(reader.result).split(",")[1] || "", mimeType: file.type }); reader.readAsDataURL(file);
  })));
}

const DraftCanvas = forwardRef<DraftHandle>(function DraftCanvas(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * canvas.width / rect.width, (event.clientY - rect.top) * canvas.height / rect.height] as const;
  };
  const clear = () => { const canvas = canvasRef.current; canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height); strokes.current = 0; };
  useImperativeHandle(ref, () => ({
    capture: async (sessionId: string) => {
      const canvas = canvasRef.current;
      if (!canvas || !strokes.current) return null;
      const url = canvas.toDataURL("image/png");
      const raw = Uint8Array.from(atob(url.split(",")[1]), (char) => char.charCodeAt(0));
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/draft`, { method: "POST", ...jsonBody({ segment_id: "draft-main", content_hash: `sha256:${digest}`, event_count: strokes.current, bbox: [0, 0, 420, 520] }) });
      return { data: url.split(",")[1], mimeType: "image/png" };
    },
  }));
  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => { const canvas = canvasRef.current, context = canvas?.getContext("2d"); if (!canvas || !context) return; drawing.current = true; canvas.setPointerCapture(event.pointerId); const [x, y] = point(event); context.lineWidth = 2.2; context.lineCap = "round"; context.strokeStyle = "#17233b"; context.beginPath(); context.moveTo(x, y); };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (!drawing.current) return; const context = canvasRef.current?.getContext("2d"); if (!context) return; const [x, y] = point(event); context.lineTo(x, y); context.stroke(); strokes.current++; };
  return <aside className="draft-studio"><div className="sheet-heading"><div><p className="eyebrow">草稿</p><h2>手写区</h2></div><button className="text-button" type="button" onClick={clear}><Trash2 aria-hidden="true" />清空</button></div><canvas ref={canvasRef} width="420" height="520" aria-label="手写草稿画布" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} /><p>草稿会随本题保存，提问和提交时会一起用于理解你的思路。</p></aside>;
});

function safeUri(uri: string | undefined, kind: string, ref: string | null) {
  if (!uri) return null;
  if (kind === "image" && /^data:image\/(png|jpeg|webp);base64,/.test(uri)) return uri;
  return ref && uri.startsWith(`/api/sessions/${encodeURIComponent(ref)}/artifacts/`) ? uri : null;
}

function ArtifactCard({ artifact, sessionRef, onEvent }: { artifact: Artifact; sessionRef: string | null; onEvent: (artifact: Artifact, response: "submitted" | "skipped" | "bypassed_free_text", answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const uri = safeUri(artifact.uri, artifact.kind, sessionRef);
  let spec: Record<string, any> | null = null;
  if (artifact.kind === "question_card" && artifact.content) { try { spec = JSON.parse(artifact.content); } catch { spec = null; } }
  useEffect(() => {
    if (artifact.kind !== "html") return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== frameRef.current?.contentWindow || !event.data || event.data.interaction_token !== artifact.interaction_token) return;
      const response = ({ "card.answer_submitted": "submitted", "card.skipped": "skipped", "card.free_text_requested": "bypassed_free_text" } as Record<string, "submitted" | "skipped" | "bypassed_free_text">)[event.data.type];
      if (response) onEvent(artifact, response, String(event.data.answer || ""));
    };
    window.addEventListener("message", receive); return () => window.removeEventListener("message", receive);
  }, [artifact, onEvent]);
  return <article className="artifact-card"><strong>{artifact.title || artifact.kind}</strong>
    {artifact.kind === "text" && <MathText text={artifact.content || ""} />}
    {artifact.kind === "question_card" && <><MathText text={spec?.prompt || spec?.question || artifact.content || "交互题卡"} /><textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="写下你的回答" /><div className="action-cluster"><button className="btn" type="button" onClick={() => onEvent(artifact, "submitted", answer)}>提交卡片</button><button className="btn ghost" type="button" onClick={() => onEvent(artifact, "skipped", "")}>跳过</button><button className="btn ghost" type="button" onClick={() => onEvent(artifact, "bypassed_free_text", "")}>直接文字回复</button></div></>}
    {artifact.kind === "image" && uri && <img src={uri} alt={artifact.title || "教学图片"} width="1200" height="900" loading="lazy" decoding="async" />}
    {artifact.kind === "video" && uri && <video src={uri} controls preload="metadata" />}
    {artifact.kind === "html" && uri && <iframe ref={frameRef} sandbox="allow-scripts" src={`${uri}?interaction_token=${encodeURIComponent(artifact.interaction_token || "")}`} title={artifact.title || "教学演示"} />}
    {!(["text", "question_card"].includes(artifact.kind) || uri) && <p>这项互动内容正在准备，你可以先继续文字对话。</p>}
  </article>;
}

function Conversation({ messages }: { messages: ChatMessage[] }) {
  return <div className="conversation" aria-live="polite">{messages.map((message) => <article className={`message-row ${message.role === "student" ? "user" : "assistant"}`} key={message.id}><span className="message-avatar" aria-hidden="true">{message.role === "student" ? "你" : "∴"}</span><div className="message-wrap"><div className="message-head"><strong>{message.role === "student" ? "你" : "AGMATH"}</strong><small>{message.label}</small></div><div className="message-bubble"><MathText text={message.text} as="span" /></div></div></article>)}</div>;
}

function FilePicker({ files, onChange, label }: { files: File[]; onChange: (files: File[]) => void; label: string }) {
  return <div className="file-row"><label className="file-chip"><ImagePlus aria-hidden="true" />{label}<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => onChange([...(event.target.files ?? [])].slice(0, 4))} /></label><span>{files.length ? `已选择 ${files.length} 张` : "最多 4 张"}</span></div>;
}

export function SolvePage() {
  const { state: { principal } } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qid = params.get("q") || "";
  const assessmentRunId = params.get("run");
  const assessmentGoal = params.get("goal") || "coverage";
  const draftRef = useRef<DraftHandle>(null);
  const startedQuestion = useRef("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [answerFiles, setAnswerFiles] = useState<File[]>([]);
  const [askText, setAskText] = useState("");
  const [askFiles, setAskFiles] = useState<File[]>([]);
  const [hintLevel, setHintLevel] = useState(0);
  const [verdict, setVerdict] = useState<VerdictData | null>(null);
  const [judgment, setJudgment] = useState<Judgment | null>(null);
  const [probeCard, setProbeCard] = useState<{ card_id?: string } | null>(null);
  const [probeAnswer, setProbeAnswer] = useState("");
  const [trace, setTrace] = useState<Trace>({});
  const [advanceStatus, setAdvanceStatus] = useState("");
  const question = useQuery({ queryKey: ["question", qid], queryFn: () => apiFetch<Question>(`/api/questions/${encodeURIComponent(qid)}`), enabled: Boolean(qid), retry: false });
  const addMessage = (role: "student" | "agent", text: string, label = "") => setMessages((current) => [...current, { id: `${Date.now()}-${Math.random()}`, role, text, label }]);
  const collectAnswer = () => selected.length ? `${question.data?.stem_format === "multiple_choice" ? "选择答案" : "答案"}：${selected.join("、")}${answer.trim() ? `\n推导说明：${answer.trim()}` : ""}` : answer.trim();

  useEffect(() => {
    if (!qid || !question.data || startedQuestion.current === qid) return;
    startedQuestion.current = qid;
    apiFetch<{ session_id: string }>("/api/sessions", { method: "POST", ...jsonBody({ student_id: principal.user_id, question_id: qid, chapter_package_version: question.data.published_packages?.[0]?.version, mode: assessmentGoal === "review" ? "review" : "diagnostic", draft_enabled: true, ...(assessmentRunId ? { assessment_run_id: assessmentRunId } : {}) }) })
      .then((session) => setSessionId(session.session_id))
      .catch(() => { startedQuestion.current = ""; addMessage("agent", "这道练习暂时无法打开，你可以刷新后重试。", "提示"); });
  }, [assessmentGoal, assessmentRunId, principal.user_id, qid, question.data]);

  useEffect(() => {
    const ref = sessionId || conversationId;
    if (!ref) return;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(ref)}/agent-events`);
    source.addEventListener("trace", (event) => { try { setTrace(JSON.parse((event as MessageEvent).data)); } catch { /* keep last valid trace */ } });
    return () => source.close();
  }, [sessionId, conversationId]);

  const withImages = async (files: File[], includeDraft: boolean) => {
    const images = await filesToImages(files);
    if (includeDraft && sessionId) { const draft = await draftRef.current?.capture(sessionId); if (draft) images.push(draft); }
    return images.slice(0, 4);
  };
  const interact = useMutation({
    mutationFn: async (action: string) => {
      if (!sessionId) throw new Error("session not ready");
      const text = collectAnswer();
      if (action === "check_step" && !text) throw new Error("请先写下需要检查的步骤。");
      addMessage("student", text || ({ stuck: "请给我一个提示", method_hint: "请换一种思路讲解" } as Record<string, string>)[action] || "继续讨论");
      return apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/interact`, { method: "POST", ...jsonBody({ action, text, images: await withImages(answerFiles, true) }) });
    },
    onSuccess: (data) => { addMessage("agent", data.reply, data.status === "completed" ? "" : data.status); setArtifacts(data.artifacts || []); setHintLevel(Number(data.hint_level || hintLevel)); },
    onError: (error) => addMessage("agent", error instanceof Error && error.message.startsWith("请先") ? error.message : "这次回复没有完成，请稍后再试。", "提示"),
  });
  const submit = useMutation({
    mutationFn: async () => {
      const text = collectAnswer(); if (!text || !sessionId) throw new Error("请先写下解答。");
      return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, { method: "POST", ...jsonBody({ answer_text: text, answer_images: await withImages(answerFiles, true) }) });
    },
    onSuccess: (data) => { setVerdict(data); if (data.judgment) setJudgment(data.judgment); if (data.card) setProbeCard(data.card); },
    onError: (error) => addMessage("agent", error instanceof Error && error.message.startsWith("请先") ? error.message : "这次提交没有完成，请检查网络后重试。", "提示"),
  });
  const ask = useMutation({
    mutationFn: async () => apiFetch<any>("/api/ask", { method: "POST", ...jsonBody({ conversation_id: conversationId, text: askText.trim(), images: await withImages(askFiles, false) }) }),
    onMutate: () => addMessage("student", askText.trim() || "（上传图片）"),
    onSuccess: (data) => { setConversationId(data.conversation_id); addMessage("agent", data.reply, data.evidence_policy); setArtifacts(data.artifacts || []); setAskText(""); setAskFiles([]); },
    onError: () => addMessage("agent", "暂时没有收到回复，请稍后再试。", "提示"),
  });
  const cardEvent = async (artifact: Artifact, response: "submitted" | "skipped" | "bypassed_free_text", cardAnswer: string) => {
    const ref = sessionId || conversationId; if (!ref) return;
    let cardSpec: Record<string, unknown> | null = null;
    try { cardSpec = artifact.content ? JSON.parse(artifact.content) : null; } catch { cardSpec = null; }
    const cardId = String(cardSpec?.card_id || artifact.artifact_id || "").slice(0, 160), payload = { answer: cardAnswer.slice(0, 4000), source: "learning_artifact" };
    const url = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/card-event` : `/api/teaching-conversations/${encodeURIComponent(conversationId as string)}/card-event`;
    try {
      await apiFetch(url, { method: "POST", ...jsonBody({ card_id: cardId, artifact_id: artifact.artifact_id, interaction_token: artifact.interaction_token, response_type: response, payload }) });
      if (response === "bypassed_free_text") { document.getElementById(sessionId ? "answer-text" : "ask-text")?.focus(); return; }
      addMessage("student", response === "skipped" ? "跳过这张教学卡片" : `卡片回答：${payload.answer || "（已提交）"}`, "教学卡片");
      const result = sessionId
        ? await apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/interact`, { method: "POST", ...jsonBody({ action: "card_event", text: JSON.stringify({ response_type: response, card_id: cardId, payload }) }) })
        : await apiFetch<any>("/api/ask", { method: "POST", ...jsonBody({ action: "card_event", conversation_id: conversationId, text: JSON.stringify({ response_type: response, card_id: cardId, payload }) }) });
      addMessage("agent", result.reply, result.status); setArtifacts(result.artifacts || []);
    } catch { addMessage("agent", "这次互动没有保存成功，请直接用文字回复。", "提示"); }
  };
  const probe = useMutation({
    mutationFn: async (skip: boolean) => {
      if (!sessionId) throw new Error();
      if (skip) return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/probe-skip`, { method: "POST" });
      if (!probeAnswer.trim()) throw new Error("请先回答追问");
      if (probeCard?.card_id) await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/card-event`, { method: "POST", ...jsonBody({ card_id: probeCard.card_id, response_type: "bypassed_free_text" }) });
      return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/probe`, { method: "POST", ...jsonBody({ answer_text: probeAnswer.trim() }) });
    },
    onSuccess: (data) => { setVerdict(data); if (data.judgment) setJudgment(data.judgment); setProbeAnswer(""); },
  });
  const advance = useMutation({
    mutationFn: async () => {
      if (!assessmentRunId || !sessionId) return null;
      setAdvanceStatus("正在安排下一步学习…");
      const decision = await apiFetch<any>(`/api/assessment-runs/${encodeURIComponent(assessmentRunId)}/decide`, { method: "POST", ...jsonBody({ session_id: sessionId }) });
      if (decision.stop) return { stop: true, reason: decision.reason };
      const next = await apiFetch<any>(`/api/assessment-runs/${encodeURIComponent(assessmentRunId)}/next`, { method: "POST" });
      return { ...next, goal: next.goal || decision.goal || "coverage", reason: decision.reason };
    },
    onSuccess: (data) => { if (!data) return; if (data.stop) setAdvanceStatus(`本轮已完成：${data.reason || "证据已足够"}`); else if (data.question_id) navigate(`/solve?run=${encodeURIComponent(assessmentRunId as string)}&goal=${encodeURIComponent(data.goal)}&q=${encodeURIComponent(data.question_id)}`); else setAdvanceStatus("本轮没有更多合适题目"); },
    onError: () => setAdvanceStatus("暂时无法选择下一题，请稍后再试。"),
  });

  const choices = question.data?.stem_format === "true_false" ? [{ key: "true", text_markdown: "正确" }, { key: "false", text_markdown: "错误" }] : question.data?.options || [];
  const completion = verdict?.state === "CLOSED" || Boolean(verdict?.session_learning_record_id);
  const currentJudgment = judgment || verdict?.judgment || {};
  const steps = (trace.steps || []).slice(-80), totalTokens = steps.reduce((sum, step) => sum + Number(step.usage?.total || 0), 0), promptInput = steps.reduce((sum, step) => sum + Number(step.usage?.input || 0), 0), cacheRead = steps.reduce((sum, step) => sum + Number(step.usage?.cacheRead || 0), 0);
  const phase = verdict ? 4 : messages.length ? 2 : answer || selected.length ? 1 : 0;
  const busy = interact.isPending || submit.isPending || probe.isPending || advance.isPending;

  return (
    <main className="proof-layout" id="main-content">
      <aside className="proof-spine" aria-label="本题状态"><p className="eyebrow">本题进度</p><ol id="stateSpine">{["查看题目", "写下解答", "检查解答", "进一步提问", "本题总结"].map((label, index) => <li className={index === phase ? "active" : index < phase ? "complete" : ""} key={label}>{label}</li>)}</ol><div className="hint-meter">{hintLevel ? `提示 L${hintLevel}` : "L0 · 独立作答"}</div></aside>
      <section className="proof-main">
        {!qid && <section className="proof-sheet"><p className="eyebrow">自由问答</p><h1>把题目发给我</h1><p className="lede">输入题目或上传截图，我们可以从你的问题开始一步步讨论。</p><textarea id="ask-text" rows={5} value={askText} onChange={(e) => setAskText(e.target.value)} placeholder="例如：这道几何题为什么要作这条辅助线？" /><FilePicker files={askFiles} onChange={setAskFiles} label="上传题图" /><AsyncButton className="cinnabar" pending={ask.isPending} pendingLabel="正在思考…" disabled={!askText.trim() && !askFiles.length} onClick={() => ask.mutate()}><Send aria-hidden="true" />发送问题</AsyncButton>{messages.length > 0 && <Conversation messages={messages} />}<div className="artifact-deck">{artifacts.map((artifact, index) => <ArtifactCard key={artifact.artifact_id || index} artifact={artifact} sessionRef={conversationId} onEvent={cardEvent} />)}</div></section>}
        {qid && <>
          <article className="proof-sheet"><div className="q-meta"><span>本题</span><span className="mono">{question.data?.published_packages?.[0]?.version ? `内容版本 ${question.data.published_packages[0].version}` : ""}</span><span>当前练习</span></div>{question.isPending ? <div className="skeleton-lines"><i /><i /><i /></div> : question.isError ? <h1>这道练习暂时无法打开</h1> : <MathText text={question.data?.stem_markdown || ""} as="h1" />}<div className="asset-grid">{question.data?.assets?.map((asset, index) => <figure key={index}><img src={asset.image_data_url} alt="题目配图" width="1200" height="900" loading="lazy" decoding="async" /><figcaption>题目配图</figcaption></figure>)}</div></article>
          <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">我的解答</p><h2>写下你的思路</h2></div><span className="mono">{sessionId ? "自动保存" : "正在准备会话…"}</span></div>
            {!!choices.length && <div className="answer-control"><p className="eyebrow">{question.data?.stem_format === "multiple_choice" ? "可选择多项" : "请选择一项"}</p>{choices.map((choice) => { const checked = selected.includes(choice.key.toUpperCase()); return <label className="answer-choice" key={choice.key}><input type={question.data?.stem_format === "multiple_choice" ? "checkbox" : "radio"} name="structured-answer" value={choice.key} checked={checked} onChange={() => setSelected((current) => question.data?.stem_format === "multiple_choice" ? checked ? current.filter((item) => item !== choice.key.toUpperCase()) : [...current, choice.key.toUpperCase()] : [choice.key.toUpperCase()])} /><strong>{choice.key.toUpperCase()}</strong><MathText text={choice.text_markdown} as="span" /></label>; })}</div>}
            <textarea id="answer-text" rows={6} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="逐步写下你的解答；检查某一步时，请指出要检查的位置。" /><FilePicker files={answerFiles} onChange={setAnswerFiles} label="补充作答图片" />
            <div className="action-cluster" aria-label="学习帮助方式"><button className="btn ghost" type="button" disabled={!sessionId || busy} onClick={() => interact.mutate("stuck")}>给我一个提示</button><button className="btn ghost" type="button" disabled={!sessionId || busy} onClick={() => interact.mutate("check_step")}>检查这一步</button><button className="btn ghost" type="button" disabled={!sessionId || busy} onClick={() => interact.mutate("method_hint")}>换一种思路</button><AsyncButton className="cinnabar" pending={submit.isPending} pendingLabel="正在判读…" disabled={!sessionId || interact.isPending} onClick={() => submit.mutate()}>提交解答</AsyncButton></div>{busy && <p className="pending-line"><span className="spinner" />正在阅读你的解答…</p>}
          </section>
          {!!messages.length && <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">教学对话</p><h2>一起把这道题想清楚</h2></div><span className="live-dot">对话中</span></div><Conversation messages={messages} /><div className="artifact-deck">{artifacts.map((artifact, index) => <ArtifactCard key={artifact.artifact_id || index} artifact={artifact} sessionRef={sessionId} onEvent={cardEvent} />)}</div></section>}
          {verdict && <section className="proof-sheet"><p className="eyebrow">本题反馈</p><div><div className={`judgment-seal ${currentJudgment.verdict || "unresolved"}`}>{({ correct: "正确", partially_correct: "部分正确", incorrect: "需要修正", unresolved: "证据不足" } as Record<string, string>)[currentJudgment.verdict || ""] || "已判读"}</div><MathText text={currentJudgment.decision_summary || ""} /></div>{verdict.probe?.question && <div className="probe-card"><MathText text={verdict.probe.question} /><textarea rows={3} value={probeAnswer} onChange={(e) => setProbeAnswer(e.target.value)} placeholder="回答这条错因追问" /><div className="action-cluster"><AsyncButton pending={probe.isPending} pendingLabel="正在提交…" onClick={() => probe.mutate(false)}>用文字回答追问</AsyncButton><button className="btn ghost" type="button" disabled={probe.isPending} onClick={() => probe.mutate(true)}>跳过，不计为答错</button></div></div>}{verdict.claim?.status && <p>错因结论：{verdict.claim.status}{verdict.claim.resolved_error_cause ? ` · ${verdict.claim.resolved_error_cause}` : ""}</p>}{completion && <div className="action-cluster">{assessmentRunId && <AsyncButton className="cinnabar" pending={advance.isPending} pendingLabel="正在安排…" onClick={() => advance.mutate()}>继续下一题</AsyncButton>}<Link className="btn ghost" to="/report">查看当前证据</Link></div>}{advanceStatus && <p className="status-note">{advanceStatus}</p>}</section>}
          {!!steps.length && <details className="proof-sheet model-steps"><summary>查看处理过程 <span className="mono">{totalTokens ? `${totalTokens.toLocaleString()} tokens${promptInput + cacheRead ? ` · 提示缓存 ${Math.round(cacheRead / (promptInput + cacheRead) * 100)}%` : ""}` : ""}</span></summary><ol>{steps.map((step, index) => <li key={index}><span className={`step-state ${step.status || "running"}`}>{step.status || "running"}</span><span>{step.taskType || "agent"} · {step.label || step.detail || "处理中"}</span></li>)}</ol></details>}
        </>}
      </section>
      {qid && <DraftCanvas ref={draftRef} />}
    </main>
  );
}
