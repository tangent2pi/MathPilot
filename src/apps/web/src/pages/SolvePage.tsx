import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Paperclip, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { ImagePicker } from "../components/ImagePicker";
import { MathText } from "../components/MathText";
import { ApiError, apiFetch, jsonBody } from "../lib/api";
import { aiRequestErrorMessage } from "../lib/ai-feedback";
import { PRODUCT_NAME } from "../lib/brand";
import { optionLabel, stemFormatLabel } from "../lib/content";

type ImageInput = { data: string; mimeType: string };
type Choice = { key: string; text_markdown: string };
type Question = { stem_markdown: string; stem_format?: string; options?: Choice[]; assets?: Array<{ image_data_url: string }>; published_packages?: Array<{ version?: string }> };
type QuestionCardSpec = { schema?: string; artifact_id?: string; card_id?: string; type?: "single_choice" | "multiple_choice" | "fill_blank" | "true_false"; prompt?: string; question?: string; options?: Array<{ id?: string; content?: string }>; response_policy?: { allow_skip?: boolean; allow_free_text_without_answer?: boolean } };
type Artifact = { artifact_id?: string; interaction_token?: string; title?: string; kind: string; content?: string; uri?: string };
type TraceStep = { seq?: number; at?: string; type?: string; kind?: string; toolName?: string; status?: string; taskType?: string; label?: string; detail?: string; usage?: { total?: number; input?: number; cacheRead?: number } };
type TraceConversation = { at: string; role: "student" | "agent"; kind: string; text: string; artifacts?: Artifact[]; thinking?: TraceStep[] };
type Trace = { steps?: TraceStep[]; conversation?: TraceConversation[] };
type ChatMessage = { id: string; role: "student" | "agent"; text: string; label?: string; artifacts?: Artifact[]; thinking?: TraceStep[]; images?: string[] };
type Judgment = { verdict?: string; decision_summary?: string };
type VerdictData = { state?: string; session_learning_record_id?: string; judgment?: Judgment; card?: QuestionCardSpec; probe?: { question?: string }; claim?: { status?: string; resolved_error_cause?: string } };
type BootstrapResult = { profile: false } | { profile: true; run_id: string; question_id?: string; goal?: string };
type ThoughtItem =
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; name: string; status: "running" | "completed" | "failed"; input?: string; output?: string };

async function filesToImages(files: File[]): Promise<ImageInput[]> {
  return Promise.all(files.slice(0, 4).map((file) => new Promise<ImageInput>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve({ data: String(reader.result).split(",")[1] || "", mimeType: file.type });
    reader.readAsDataURL(file);
  })));
}

function safeUri(uri: string | undefined, kind: string, ref: string | null) {
  if (!uri) return null;
  if (kind === "image" && /^data:image\/(png|jpeg|webp);base64,/.test(uri)) return uri;
  return ref && uri.startsWith(`/api/sessions/${encodeURIComponent(ref)}/artifacts/`) ? uri : null;
}

function ThinkingPanel({ steps, running = false }: { steps: TraceStep[]; running?: boolean }) {
  const [open, setOpen] = useState(running);
  const items: ThoughtItem[] = [];
  const openTools: number[] = [];
  const friendlyToolName = (name: string) => ({
    bash: "使用工作区",
    read_image: "查看图像",
    crop: "查看图像局部",
    draw_bbox: "标注图像",
    visualize: "查看文档",
    web_search: "搜索资料",
    web_extractor: "读取网页",
    paddleocr: "识别文字与版面",
  }[name] || name.replaceAll("_", " "));
  for (const [index, step] of steps.entries()) {
    if (step.type === "assistant_message" && step.detail?.trim()) {
      items.push({ id: `reasoning-${step.seq ?? index}`, kind: "reasoning", text: step.detail.trim() });
      continue;
    }
    if (step.type === "tool_start" && step.toolName !== "respond" && step.kind !== "respond" && step.label !== "调用 respond") {
      const rawName = step.toolName || step.kind || step.label?.replace(/^调用\s+/, "") || "操作";
      items.push({ id: `tool-${step.seq ?? index}`, kind: "tool", name: friendlyToolName(rawName), status: "running", input: step.detail });
      openTools.push(items.length - 1);
      continue;
    }
    if (step.type === "tool_end" && step.toolName !== "respond" && step.kind !== "respond" && !step.label?.startsWith("respond ")) {
      const rawName = step.toolName || step.kind || step.label?.replace(/\s+(完成|失败)$/, "") || "操作";
      const name = friendlyToolName(rawName);
      const pendingIndex = [...openTools].reverse().find((itemIndex) => {
        const item = items[itemIndex];
        return item?.kind === "tool" && item.name === name && item.status === "running";
      });
      if (pendingIndex !== undefined) {
        const pending = items[pendingIndex];
        if (pending.kind === "tool") items[pendingIndex] = { ...pending, status: step.status === "failed" ? "failed" : "completed", output: step.detail };
      } else {
        items.push({ id: `tool-${step.seq ?? index}`, kind: "tool", name, status: step.status === "failed" ? "failed" : "completed", output: step.detail });
      }
    }
  }
  const visible = items.slice(-20);
  const toolCount = visible.filter((item) => item.kind === "tool").length;
  const total = steps.reduce((sum, step) => sum + (step.type === "turn_end" ? Number(step.usage?.total || 0) : 0), 0);
  return <details className="chat-thinking" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className={running ? "thinking-orbit is-running" : "thinking-orbit"} aria-hidden="true"><i /><i /><i /></span><span>{running ? "正在思考" : "查看思考过程"}</span><small>{toolCount ? `${toolCount} 次工具使用` : visible.length ? "已整理" : "等待响应"}{total ? ` · ${total.toLocaleString()} tokens` : ""}</small><ChevronRight aria-hidden="true" /></summary><div className="thinking-flow">{visible.length ? visible.map((item) => item.kind === "reasoning" ? <div className="thinking-reasoning" key={item.id}><MathText as="div" text={item.text} /></div> : <details className={`thinking-tool ${item.status}`} key={item.id}><summary><span>{item.name}</span>{item.status === "running" && <em>使用中</em>}{item.status === "failed" && <em>需要查看</em>}<ChevronRight aria-hidden="true" /></summary>{(item.input || item.output) && <div className="thinking-tool-detail">{item.input && <><small>输入</small><pre>{item.input}</pre></>}{item.output && <><small>结果</small><pre>{item.output}</pre></>}</div>}</details>) : <div className="thinking-waiting"><span /><span /><span /><em>正在阅读题目和对话</em></div>}</div></details>;
}

function NativeArtifactCard({ spec, disabled, onSubmit, onSkip, onFreeText }: { spec: QuestionCardSpec; disabled?: boolean; onSubmit: (answer: string) => void; onSkip: () => void; onFreeText: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const multiple = spec.type === "multiple_choice";
  const options = spec.type === "true_false" && !spec.options?.length ? [{ id: "true", content: "正确" }, { id: "false", content: "错误" }] : spec.options ?? [];
  const answer = selected.length ? selected.join("、") : text.trim();
  return <section className="native-teaching-card"><MathText as="h3" text={spec.prompt || spec.question || "互动题卡"} />{!!options.length && <div className="native-card-options">{options.map((item, index) => {
    const id = String(item.id || optionLabel(index));
    const checked = selected.includes(id);
    return <label className="native-card-option" key={id}><input type={multiple ? "checkbox" : "radio"} name={`card-${spec.card_id || spec.artifact_id || "native"}`} checked={checked} disabled={disabled} onChange={() => setSelected((current) => multiple ? checked ? current.filter((value) => value !== id) : [...current, id] : [id])} /><strong>{spec.type === "true_false" ? "" : optionLabel(index, id)}</strong><MathText as="span" text={item.content || id} /></label>;
  })}</div>}{!options.length && <textarea rows={3} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} placeholder="写下你的回答" />}<div className="native-card-actions"><button className="btn cinnabar" type="button" disabled={disabled || !answer} onClick={() => onSubmit(answer)}>提交卡片</button>{spec.response_policy?.allow_skip !== false && <button className="btn ghost" type="button" disabled={disabled} onClick={onSkip}>跳过</button>}{spec.response_policy?.allow_free_text_without_answer !== false && <button className="btn ghost" type="button" disabled={disabled} onClick={onFreeText}>改用文字回复</button>}</div></section>;
}

function ArtifactCard({ artifact, sessionRef, onEvent }: { artifact: Artifact; sessionRef: string | null; onEvent: (artifact: Artifact, response: "submitted" | "skipped" | "bypassed_free_text", answer: string) => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [used, setUsed] = useState(false);
  const uri = safeUri(artifact.uri, artifact.kind, sessionRef);
  let spec: QuestionCardSpec | null = null;
  if (artifact.kind === "question_card" && artifact.content) { try { spec = JSON.parse(artifact.content); } catch { spec = null; } }
  useEffect(() => {
    if (artifact.kind !== "html") return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== frameRef.current?.contentWindow || !event.data || event.data.interaction_token !== artifact.interaction_token) return;
      const response = ({ "card.answer_submitted": "submitted", "card.skipped": "skipped", "card.free_text_requested": "bypassed_free_text" } as Record<string, "submitted" | "skipped" | "bypassed_free_text">)[event.data.type];
      if (response) onEvent(artifact, response, String(event.data.answer || ""));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [artifact, onEvent]);
  const emit = (response: "submitted" | "skipped" | "bypassed_free_text", value: string) => { if (response !== "bypassed_free_text") setUsed(true); onEvent(artifact, response, value); };
  return <article className="artifact-card chat-artifact"><strong>{artifact.title || (artifact.kind === "html" ? "互动演示" : "教学卡片")}</strong>{artifact.kind === "text" && <MathText text={artifact.content || ""} />}{artifact.kind === "question_card" && spec && <NativeArtifactCard spec={spec} disabled={used} onSubmit={(value) => emit("submitted", value)} onSkip={() => emit("skipped", "")} onFreeText={() => emit("bypassed_free_text", "")} />}{artifact.kind === "image" && uri && <img src={uri} alt={artifact.title || "教学图片"} width="1200" height="900" loading="lazy" decoding="async" />}{artifact.kind === "video" && uri && <video src={uri} controls preload="metadata" />}{artifact.kind === "html" && uri && <iframe ref={frameRef} sandbox="allow-scripts" src={`${uri}?interaction_token=${encodeURIComponent(artifact.interaction_token || "")}`} title={artifact.title || "教学演示"} />}{artifact.kind === "question_card" && !spec && <p>这张题卡暂时无法打开，请用文字继续回答。</p>}{!(artifact.kind === "text" || artifact.kind === "question_card" || uri) && <p>这项互动内容正在准备，你可以先继续文字对话。</p>}</article>;
}

function MessageRow({ message, sessionRef, onArtifactEvent }: { message: ChatMessage; sessionRef: string | null; onArtifactEvent: (artifact: Artifact, response: "submitted" | "skipped" | "bypassed_free_text", answer: string) => void }) {
  return <article className={`chatbox-message ${message.role}`}>
    <div className="chatbox-avatar" aria-hidden="true">{message.role === "student" ? "你" : "∴"}</div>
    <div className="chatbox-message-body">
      <div className="chatbox-message-head"><strong>{message.role === "student" ? "你" : PRODUCT_NAME}</strong>{message.label && <small>{message.label}</small>}</div>
      {message.role === "agent" && !!message.thinking?.length && <ThinkingPanel steps={message.thinking} />}
      {(message.text || message.images?.length) && <div className="chatbox-message-content">
        {message.text && <div className="chatbox-copy"><MathText text={message.text} as="div" /></div>}
        {!!message.images?.length && <div className="chatbox-images">{message.images.map((src, index) => <img key={src} src={src} alt={`${message.role === "student" ? "你发送的" : PRODUCT_NAME + "发送的"}图片 ${index + 1}`} width="640" height="480" loading="lazy" decoding="async" />)}</div>}
      </div>}
      {message.artifacts?.map((artifact, index) => <ArtifactCard key={artifact.artifact_id || index} artifact={artifact} sessionRef={sessionRef} onEvent={onArtifactEvent} />)}
    </div>
  </article>;
}

function PracticeQuestionCard({ question, selected, answer, files, disabled, sessionReady, busy, onSelected, onAnswer, onFiles, onHelp, onSubmit }: { question?: Question; selected: string[]; answer: string; files: File[]; disabled: boolean; sessionReady: boolean; busy: boolean; onSelected: (values: string[]) => void; onAnswer: (value: string) => void; onFiles: (files: File[]) => void; onHelp: (action: "stuck" | "check_step" | "method_hint") => void; onSubmit: () => void }) {
  const choices = question?.stem_format === "true_false" ? [{ key: "true", text_markdown: "正确" }, { key: "false", text_markdown: "错误" }] : question?.options ?? [];
  const multiple = question?.stem_format === "multiple_choice";
  return <section className="practice-question-card"><div className="practice-card-meta"><span>{stemFormatLabel[question?.stem_format || ""] || "题目"}</span><small>选择答案后提交，也可以随时继续提问</small></div><MathText as="h2" text={question?.stem_markdown || "正在读取题目…"} />{!!question?.assets?.length && <div className="practice-card-images">{question.assets.map((asset, index) => <img key={index} src={asset.image_data_url} alt={`题目配图 ${index + 1}`} width="1200" height="900" loading="lazy" decoding="async" />)}</div>}{!!choices.length && <div className="practice-option-list">{choices.map((choice, index) => {
    const checked = selected.includes(choice.key);
    return <label className="practice-option" key={choice.key}><input type={multiple ? "checkbox" : "radio"} name="practice-answer" checked={checked} disabled={disabled} onChange={() => onSelected(multiple ? checked ? selected.filter((value) => value !== choice.key) : [...selected, choice.key] : [choice.key])} /><strong>{question?.stem_format === "true_false" ? "" : optionLabel(index, choice.key)}</strong><MathText as="span" text={choice.text_markdown} /></label>;
  })}</div>}{!choices.length && <textarea rows={4} value={answer} disabled={disabled} onChange={(event) => onAnswer(event.target.value)} placeholder="写下你的解答或思路" />}<details className="practice-attachments"><summary><Paperclip aria-hidden="true" />补充作答图片</summary><ImagePicker files={files} onChange={onFiles} label="添加题图或草稿" maxBytes={8 * 1_048_576} /></details><div className="practice-card-actions"><button className="btn ghost" type="button" disabled={disabled || !sessionReady || busy} onClick={() => onHelp("stuck")}>给我提示</button><button className="btn ghost" type="button" disabled={disabled || !sessionReady || busy} onClick={() => onHelp("check_step")}>检查思路</button><button className="btn ghost" type="button" disabled={disabled || !sessionReady || busy} onClick={() => onHelp("method_hint")}>换种方法</button><AsyncButton className="cinnabar" pending={busy} pendingLabel="正在阅读…" disabled={disabled || !sessionReady || (!selected.length && !answer.trim())} onClick={onSubmit}>提交解答</AsyncButton></div></section>;
}

export function SolvePage({ askMode = false }: { askMode?: boolean }) {
  const { state: { principal } } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qid = params.get("q") || "";
  const assessmentRunId = params.get("run");
  const assessmentGoal = params.get("goal") || "coverage";
  const mounted = useRef(true);
  const previewUrls = useRef(new Set<string>());
  const startedQuestion = useRef("");
  const streamEnd = useRef<HTMLDivElement>(null);
  const hydratedSessions = useRef(new Set<string>());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState("CREATE");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [answerFiles, setAnswerFiles] = useState<File[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  const [askText, setAskText] = useState("");
  const [askFiles, setAskFiles] = useState<File[]>([]);
  const [verdict, setVerdict] = useState<VerdictData | null>(null);
  const [probeAnswer, setProbeAnswer] = useState("");
  const [trace, setTrace] = useState<Trace>({});
  const [transitionMessages, setTransitionMessages] = useState<ChatMessage[]>([]);
  const [advanceStatus, setAdvanceStatus] = useState("");
  const [loadedDraftKey, setLoadedDraftKey] = useState("");
  const draftKey = qid ? `mathpilot:practice-draft:${principal.user_id}:${assessmentRunId || "standalone"}:${qid}` : "";
  const stillOnThisRoute = () => mounted.current && window.location.pathname === (askMode ? "/ask" : "/solve");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewUrls.current.forEach((url) => URL.revokeObjectURL(url)); previewUrls.current.clear(); }; }, []);
  const createMessagePreviews = (files: File[]) => files.map((file) => { const url = URL.createObjectURL(file); previewUrls.current.add(url); return url; });
  const question = useQuery({ queryKey: ["question", qid], queryFn: () => apiFetch<Question>(`/api/questions/${encodeURIComponent(qid)}`), enabled: Boolean(qid), retry: false });
  const addMessage = (role: "student" | "agent", text: string, label = "", artifacts: Artifact[] = [], thinking: TraceStep[] = [], images: string[] = []) => setMessages((current) => [...current, { id: `${Date.now()}-${Math.random()}`, role, text, label, artifacts, thinking, images }]);
  const latestSteps = async (ref: string | null, startedAt?: string) => {
    if (!ref) return [];
    const after = startedAt ? Date.parse(startedAt) : Number.NEGATIVE_INFINITY;
    const select = (items: TraceStep[] = []) => items
      .filter((step) => ["assistant_message", "tool_start", "tool_end", "turn_end", "retry"].includes(step.type || ""))
      .filter((step) => !startedAt || (step.at && Date.parse(step.at) >= after))
      .slice(-60);
    try { return select((await apiFetch<Trace>(`/api/sessions/${encodeURIComponent(ref)}/agent-trace`)).steps); }
    catch { return select(trace.steps); }
  };
  const currentChoices = useMemo(() => question.data?.stem_format === "true_false" ? [{ key: "true", text_markdown: "正确" }, { key: "false", text_markdown: "错误" }] : question.data?.options ?? [], [question.data]);
  const collectAnswer = () => { const selectedText = selected.map((key) => question.data?.stem_format === "true_false" ? currentChoices.find((choice) => choice.key === key)?.text_markdown || key : key.toUpperCase()).join("、"); return selectedText ? `${question.data?.stem_format === "multiple_choice" ? "选择答案" : "答案"}：${selectedText}${answer.trim() ? `\n推导说明：${answer.trim()}` : ""}` : answer.trim(); };

  const bootstrap = useMutation({
    mutationFn: async (): Promise<BootstrapResult> => {
      try { await apiFetch(`/api/students/${encodeURIComponent(principal.user_id)}/profile`); } catch (error) { if (error instanceof ApiError && error.status === 404) return { profile: false }; throw error; }
      const run = await apiFetch<{ run_id: string; goal?: string; current_question?: string }>("/api/assessment-runs", { method: "POST", ...jsonBody({ student_id: principal.user_id, goal: "coverage" }) });
      if (run.current_question) return { profile: true, run_id: run.run_id, question_id: run.current_question, goal: run.goal || "coverage" };
      const next = await apiFetch<{ question_id?: string; goal?: string }>(`/api/assessment-runs/${encodeURIComponent(run.run_id)}/next`, { method: "POST" });
      return { profile: true, run_id: run.run_id, ...next };
    },
    onSuccess: (data) => { if (!stillOnThisRoute()) return; if (!data.profile) navigate("/profile?first=1", { replace: true }); else if (data.question_id) navigate(`/solve?run=${encodeURIComponent(data.run_id)}&goal=${encodeURIComponent(data.goal || "coverage")}&q=${encodeURIComponent(data.question_id)}`, { replace: true }); else setAdvanceStatus("当前还没有可用练习，请稍后再来。"); },
    onError: (error) => { if (stillOnThisRoute()) setAdvanceStatus(aiRequestErrorMessage(error, "暂时无法开始练习，请稍后重试。")); },
  });
  useEffect(() => { if (!askMode && !qid && !bootstrap.isPending && !bootstrap.isSuccess) bootstrap.mutate(); }, [askMode, qid]);
  useEffect(() => {
    if (!qid) return;
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url)); previewUrls.current.clear();
    startedQuestion.current = "";
    setSessionId(null); setSessionState("CREATE"); setMessages([]); setTransitionMessages([]); setAnswerFiles([]); setChatFiles([]); setVerdict(null); setProbeAnswer(""); setTrace({}); setAdvanceStatus("");
    let restored: { answer?: string; selected?: string[]; chatText?: string } = {};
    try { restored = JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { restored = {}; }
    setAnswer(typeof restored.answer === "string" ? restored.answer : "");
    setSelected(Array.isArray(restored.selected) ? restored.selected.filter((value): value is string => typeof value === "string") : []);
    setChatText(typeof restored.chatText === "string" ? restored.chatText : "");
    setLoadedDraftKey(draftKey);
  }, [qid, draftKey]);
  useEffect(() => {
    if (!draftKey || loadedDraftKey !== draftKey) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ answer, selected, chatText })); } catch { /* 浏览器禁用本地存储时仍可正常作答。 */ }
  }, [answer, selected, chatText, draftKey, loadedDraftKey]);
  useEffect(() => {
    if (!qid || !question.data || startedQuestion.current === qid) return;
    startedQuestion.current = qid;
    const requestedQuestion = qid;
    let cancelled = false;
    let retryTimer: number | undefined;
    const openSession = async () => {
      try {
        const session = await apiFetch<{ session_id: string; state?: string; probe?: { question?: string } }>("/api/sessions", { method: "POST", ...jsonBody({ student_id: principal.user_id, question_id: requestedQuestion, chapter_package_version: question.data?.published_packages?.[0]?.version, mode: assessmentGoal === "review" ? "review" : "diagnostic", draft_enabled: false, ...(assessmentRunId ? { assessment_run_id: assessmentRunId } : {}) }) });
        if (cancelled || !stillOnThisRoute() || startedQuestion.current !== requestedQuestion) return;
        setSessionId(session.session_id); setSessionState(session.state || "CREATE");
        if (session.probe?.question) setVerdict({ state: session.state, probe: session.probe });
      } catch (error) {
        if (cancelled || !stillOnThisRoute() || startedQuestion.current !== requestedQuestion) return;
        if (error instanceof ApiError && error.status === 425) {
          setSessionState("PREPARING");
          retryTimer = window.setTimeout(openSession, 1500);
          return;
        }
        startedQuestion.current = "";
        setSessionState("FAILED");
        addMessage("agent", aiRequestErrorMessage(error, "题目已经打开，但教学对话还没有准备好。请稍后刷新本页重试。"), "提示");
      }
    };
    void openSession();
    return () => { cancelled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [assessmentGoal, assessmentRunId, principal.user_id, qid, question.data]);
  useEffect(() => { const ref = sessionId || conversationId; if (!ref) return; const source = new EventSource(`/api/sessions/${encodeURIComponent(ref)}/agent-events`); source.addEventListener("trace", (event) => { try { setTrace(JSON.parse((event as MessageEvent).data)); } catch { /* retain last valid trace */ } }); return () => source.close(); }, [sessionId, conversationId]);
  useEffect(() => {
    const ref = sessionId || conversationId;
    if (!ref || hydratedSessions.current.has(ref)) return;
    hydratedSessions.current.add(ref);
    apiFetch<Trace>(`/api/sessions/${encodeURIComponent(ref)}/agent-trace`).then((saved) => {
      if (!stillOnThisRoute()) return;
      setTrace(saved);
      setMessages((current) => current.length ? current : (saved.conversation ?? []).map((turn, index) => ({
        id: `history-${ref}-${index}`,
        role: turn.role,
        text: turn.text,
        label: turn.kind === "judgment" ? "判读" : turn.kind === "probe" ? "确认理解" : turn.kind === "summary" ? "本题总结" : "",
        artifacts: turn.artifacts ?? [],
        thinking: turn.thinking ?? [],
      })));
    }).catch(() => { /* A new session has no persisted conversation yet. */ });
  }, [sessionId, conversationId]);
  const interact = useMutation({
    mutationFn: async ({ action, text, files = [] }: { action: "stuck" | "check_step" | "method_hint" | "free_text"; text?: string; files?: File[] }) => { if (!sessionId) throw new Error("session_not_ready"); const content = text ?? (action === "check_step" ? collectAnswer() : ""); if (action === "check_step" && !content) throw new Error("请先写下需要检查的思路。"); return apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/interact`, { method: "POST", ...jsonBody({ action, text: content, images: await filesToImages(files) }) }); },
    onMutate: ({ action, text, files = [] }) => { const startedAt = new Date().toISOString(); const content = text || ({ stuck: "请给我一个提示", check_step: collectAnswer(), method_hint: "请换一种思路讲解" } as Record<string, string>)[action] || "继续讨论"; addMessage("student", content, "", [], [], createMessagePreviews(files)); if (action === "free_text") { setChatText(""); setChatFiles([]); } return { startedAt }; },
    onSuccess: async (data, _variables, context) => addMessage("agent", data.reply, data.status === "question_complete" ? "教学目标已完成" : "", data.artifacts || [], await latestSteps(sessionId, context?.startedAt)),
    onError: (error) => addMessage("agent", aiRequestErrorMessage(error, "这次回复没有完成。你的内容仍保留在对话中，请稍后重试。"), "提示"),
  });
  const submit = useMutation({
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => { if (!text || !sessionId) throw new Error("请先完成题卡中的回答。"); return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, { method: "POST", ...jsonBody({ answer_text: text, answer_images: await filesToImages(files) }) }); },
    onMutate: ({ text, files }) => { const startedAt = new Date().toISOString(); if (text) addMessage("student", text, "提交题卡", [], [], createMessagePreviews(files)); return { startedAt }; },
    onSuccess: async (data, _variables, context) => { setVerdict(data); setSessionState(data.state || (data.session_learning_record_id ? "CLOSED" : "GRADE")); const label = data.state === "CLOSED" || data.session_learning_record_id ? "本题完成" : data.probe?.question ? "继续确认" : "判读完成"; addMessage("agent", data.judgment?.decision_summary || "我已经读完你的回答。", label, [], await latestSteps(sessionId, context?.startedAt)); },
    onError: (error) => addMessage("agent", aiRequestErrorMessage(error, "答案已经保留，但本次判读没有完成。请稍后再次提交。"), "保存未完成"),
  });
  const probe = useMutation({
    mutationFn: async (skip: boolean) => { if (!sessionId) throw new Error("session_not_ready"); if (skip) return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/probe-skip`, { method: "POST" }); if (!probeAnswer.trim()) throw new Error("请先回答追问"); return apiFetch<VerdictData>(`/api/sessions/${encodeURIComponent(sessionId)}/probe`, { method: "POST", ...jsonBody({ answer_text: probeAnswer.trim() }) }); },
    onMutate: (skip) => { const startedAt = new Date().toISOString(); addMessage("student", skip ? "先跳过这条追问" : probeAnswer.trim(), "追问回答"); return { startedAt }; },
    onSuccess: async (data, _skip, context) => { setVerdict(data); setSessionState(data.state || (data.session_learning_record_id ? "CLOSED" : "DIAGNOSE")); setProbeAnswer(""); addMessage("agent", data.judgment?.decision_summary || (data.state === "CLOSED" ? "这道题的学习记录已经整理好。" : "我还需要确认一点。"), data.state === "CLOSED" ? "本题完成" : "继续确认", [], await latestSteps(sessionId, context?.startedAt)); },
    onError: (error) => addMessage("agent", aiRequestErrorMessage(error, "这条追问暂时没有保存成功，请稍后重试。"), "提示"),
  });
  const ask = useMutation({
    mutationFn: async ({ text, files }: { text: string; files: File[] }) => apiFetch<any>("/api/ask", { method: "POST", ...jsonBody({ conversation_id: conversationId, text, images: await filesToImages(files) }) }),
    onMutate: ({ text, files }) => {
      const startedAt = new Date().toISOString();
      addMessage("student", text || "（上传图片）", "", [], [], createMessagePreviews(files));
      setAskText("");
      setAskFiles([]);
      return { startedAt };
    },
    onSuccess: async (data, _variables, context) => { setConversationId(data.conversation_id); addMessage("agent", data.reply, "", data.artifacts || [], await latestSteps(data.conversation_id, context?.startedAt)); },
    onError: (error) => addMessage("agent", aiRequestErrorMessage(error, "AI 暂时没有完成回复。你的提问已保留在对话中，请检查网络后重试。"), "提示"),
  });
  const sendAsk = () => { const text = askText.trim(); if (!ask.isPending && (text || askFiles.length)) ask.mutate({ text, files: [...askFiles] }); };
  const cardEvent = async (artifact: Artifact, response: "submitted" | "skipped" | "bypassed_free_text", cardAnswer: string) => {
    const ref = sessionId || conversationId; if (!ref) return;
    const startedAt = new Date().toISOString();
    let cardSpec: QuestionCardSpec | null = null; try { cardSpec = artifact.content ? JSON.parse(artifact.content) : null; } catch { cardSpec = null; }
    const cardId = String(cardSpec?.card_id || artifact.artifact_id || "").slice(0, 160);
    if (response === "bypassed_free_text") { document.getElementById(askMode ? "ask-text" : "learning-chat-input")?.focus(); return; }
    const payload = { answer: cardAnswer.slice(0, 4000), source: "learning_artifact" };
    const url = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/card-event` : `/api/teaching-conversations/${encodeURIComponent(conversationId as string)}/card-event`;
    try { await apiFetch(url, { method: "POST", ...jsonBody({ card_id: cardId, artifact_id: artifact.artifact_id, interaction_token: artifact.interaction_token, response_type: response, payload }) }); addMessage("student", response === "skipped" ? "跳过这张教学卡片" : `卡片回答：${payload.answer || "（已提交）"}`, "教学卡片"); const result = sessionId ? await apiFetch<any>(`/api/sessions/${encodeURIComponent(sessionId)}/interact`, { method: "POST", ...jsonBody({ action: "card_event", text: JSON.stringify({ response_type: response, card_id: cardId, payload }) }) }) : await apiFetch<any>("/api/ask", { method: "POST", ...jsonBody({ action: "card_event", conversation_id: conversationId, text: JSON.stringify({ response_type: response, card_id: cardId, payload }) }) }); addMessage("agent", result.reply, "", result.artifacts || [], await latestSteps(ref, startedAt)); } catch (error) { addMessage("agent", aiRequestErrorMessage(error, "这次互动没有保存成功，请直接用文字回复。"), "提示"); }
  };
  const advance = useMutation({
    mutationFn: async () => { if (!assessmentRunId || !sessionId) return null; const transition = await apiFetch<any>(`/api/assessment-runs/${encodeURIComponent(assessmentRunId)}/decide`, { method: "POST", ...jsonBody({ session_id: sessionId }) }); const next = await apiFetch<any>(`/api/assessment-runs/${encodeURIComponent(assessmentRunId)}/next`, { method: "POST" }); return { ...next, goal: next.goal || transition.goal || "coverage" }; },
    onMutate: () => { setAdvanceStatus("正在选择下一题…"); },
    onSuccess: (data) => { if (!stillOnThisRoute() || !data) return; if (data.question_id) navigate(`/solve?run=${encodeURIComponent(assessmentRunId as string)}&goal=${encodeURIComponent(data.goal)}&q=${encodeURIComponent(data.question_id)}`, { replace: true }); else setAdvanceStatus("本轮没有更多合适题目，你仍可以继续当前对话。"); },
    onError: (error) => {
      if (!stillOnThisRoute()) return;
      if (error instanceof ApiError && (error.message === "run_completed" || error.message === "assessment run completed")) {
        const detail = error.payload && typeof error.payload === "object" && "detail" in error.payload
          ? String(error.payload.detail || "") : "";
        setAdvanceStatus(detail ? `本轮学习已完成：${detail}。你仍可以继续讨论当前题目。` : "本轮学习已完成，你仍可以继续讨论当前题目。");
        return;
      }
      setAdvanceStatus("下一题暂时没有选好，你可以继续讨论当前题目后再试。");
    },
  });
  const completion = sessionState === "CLOSED" || verdict?.state === "CLOSED" || Boolean(verdict?.session_learning_record_id);
  useEffect(() => { if (completion && draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } } }, [completion, draftKey]);
  const busy = interact.isPending || submit.isPending || probe.isPending;
  const steps = trace.steps?.slice(-30) ?? [];
  useEffect(() => {
    streamEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, transitionMessages, verdict, busy]);
  const sendPracticeText = () => {
    const text = chatText.trim(); if (!text && !chatFiles.length) return;
    if (!sessionId) { const user: ChatMessage = { id: `${Date.now()}-transition-user`, role: "student", text: text || "（上传图片）", images: createMessagePreviews(chatFiles) }; const agent: ChatMessage = { id: `${Date.now()}-transition-agent`, role: "agent", text: "回复得有点快啦，上一题的学习记录还在后台整理。先再看看这道题，准备好后我会继续接收你的消息。", label: "对话准备中" }; setTransitionMessages((current) => [...current, user, agent]); setChatText(""); setChatFiles([]); return; }
    interact.mutate({ action: "free_text", text: text || "请看看我上传的图片。", files: chatFiles });
  };

  if (!qid && !askMode) return <main className="learning-chat-page" id="main-content"><section className="learning-chat-shell"><header className="learning-chat-header"><div><p className="eyebrow">练习</p><h1>正在准备你的下一道题</h1></div></header><div className="learning-chat-stream"><article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><ThinkingPanel steps={[]} running={bootstrap.isPending} />{advanceStatus && <div className="chatbox-copy"><p>{advanceStatus}</p></div>}</div></article><div ref={streamEnd} /></div></section></main>;

  if (askMode) return <main className="learning-chat-page ask-chat-page" id="main-content"><section className="learning-chat-shell"><header className="learning-chat-header"><div><p className="eyebrow">向 AI 提问</p><h1>把问题、题目或草稿发给我</h1><p>AI 会直接解答或一步步引导，适合的内容会生成互动演示。</p></div></header><div className="learning-chat-stream">{messages.length ? messages.map((message) => <MessageRow key={message.id} message={message} sessionRef={conversationId} onArtifactEvent={cardEvent} />) : <article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><div className="chatbox-copy"><p>把你正在想的问题发来吧。可以只写文字，也可以上传题图或草稿。</p></div></div></article>}{ask.isPending && <article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><ThinkingPanel steps={steps} running /></div></article>}<div ref={streamEnd} /></div><footer className="learning-chat-composer"><textarea id="ask-text" rows={1} value={askText} onChange={(event) => setAskText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAsk(); } }} placeholder="输入你的问题…" /><details className="composer-attachment"><summary aria-label="添加图片" title="添加图片"><Paperclip aria-hidden="true" /></summary><ImagePicker files={askFiles} onChange={setAskFiles} label="添加题图或草稿" maxBytes={8 * 1_048_576} /></details><button className="chat-send-button" type="button" disabled={ask.isPending || (!askText.trim() && !askFiles.length)} aria-label="发送问题" onClick={sendAsk}><Send aria-hidden="true" /></button></footer></section></main>;

  return (
    <main className="learning-chat-page" id="main-content">
      <section className="learning-chat-shell">
        <header className="learning-chat-header">
          <div><p className="eyebrow">教学对话</p><h1>一起想清楚这道题</h1><p>{completion ? "本题已经完成，你可以继续讨论，也可以进入下一题。" : "题卡、回复和教学演示都会留在这段对话中。"}</p></div>
          <span className={`session-status ${completion ? "complete" : ""}`}>{completion ? "本题完成" : sessionId ? "对话中" : sessionState === "PREPARING" ? "对话准备中" : "准备中"}</span>
        </header>
        <div className="learning-chat-stream">
          <article className="chatbox-message agent">
            <div className="chatbox-avatar" aria-hidden="true">∴</div>
            <div className="chatbox-message-body">
              <div className="chatbox-message-head"><strong>{PRODUCT_NAME}</strong><small>{question.data?.published_packages?.[0]?.version ? `内容版本 ${question.data.published_packages[0].version}` : "教学题卡"}</small></div>
              {question.isPending ? <ThinkingPanel steps={[]} running /> : question.isError ? <div className="chatbox-copy"><p>这道练习暂时无法打开，请返回学习页重试。</p></div> : <PracticeQuestionCard question={question.data} selected={selected} answer={answer} files={answerFiles} disabled={completion || submit.isPending} sessionReady={Boolean(sessionId)} busy={busy} onSelected={setSelected} onAnswer={setAnswer} onFiles={setAnswerFiles} onHelp={(action) => interact.mutate({ action })} onSubmit={() => submit.mutate({ text: collectAnswer(), files: [...answerFiles] })} />}
            </div>
          </article>
          {messages.map((message) => <MessageRow key={message.id} message={message} sessionRef={sessionId} onArtifactEvent={cardEvent} />)}
          {transitionMessages.map((message) => <MessageRow key={message.id} message={message} sessionRef={sessionId} onArtifactEvent={cardEvent} />)}
          {busy && <article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><ThinkingPanel steps={steps} running /></div></article>}
          {verdict?.probe?.question && !completion && <article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><div className="chatbox-message-head"><strong>{PRODUCT_NAME}</strong><small>确认理解</small></div><section className="native-teaching-card"><MathText as="h3" text={verdict.probe.question} /><textarea rows={3} value={probeAnswer} onChange={(event) => setProbeAnswer(event.target.value)} placeholder="写下你的回答" /><div className="native-card-actions"><AsyncButton className="cinnabar" pending={probe.isPending} pendingLabel="正在阅读…" disabled={!probeAnswer.trim()} onClick={() => probe.mutate(false)}>提交回答</AsyncButton><button className="btn ghost" type="button" disabled={probe.isPending} onClick={() => probe.mutate(true)}>先跳过</button></div></section></div></article>}
          {completion && <article className="chatbox-message agent"><div className="chatbox-avatar" aria-hidden="true">∴</div><div className="chatbox-message-body"><div className="chatbox-copy"><p>{advanceStatus || "这道题已经完成。你可以继续问我，也可以进入下一题。"}</p></div>{assessmentRunId && <button className="btn cinnabar next-question-button" type="button" disabled={advance.isPending} onClick={() => advance.mutate()}>进入下一题 <ArrowRight aria-hidden="true" /></button>}</div></article>}
          <div ref={streamEnd} />
        </div>
        <footer className="learning-chat-composer"><textarea id="learning-chat-input" rows={1} value={chatText} onChange={(event) => setChatText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!interact.isPending && (chatText.trim() || chatFiles.length)) sendPracticeText(); } }} placeholder={completion ? "继续讨论这道题…" : sessionId ? "写下你的思路或问题…" : "可以先看题，教学对话正在准备…"} /><details className="composer-attachment"><summary aria-label="添加图片" title="添加图片"><Paperclip aria-hidden="true" /></summary><ImagePicker files={chatFiles} onChange={setChatFiles} label="补充题图或草稿" maxBytes={8 * 1_048_576} /></details><button className="chat-send-button" type="button" disabled={interact.isPending || (!chatText.trim() && !chatFiles.length)} aria-label="发送消息" onClick={sendPracticeText}><Send aria-hidden="true" /></button></footer>
      </section>
    </main>
  );
}
