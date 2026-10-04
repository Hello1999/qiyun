import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Box,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Globe2,
  LayoutDashboard,
  Leaf,
  Loader2,
  LogOut,
  Menu,
  Mic,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  TriangleAlert,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import type {
  Host,
  Service,
  Session,
  Overview,
  Task,
  TaskStatus,
  LogLine,
  Health,
} from "@qiyun/contracts";
import { api, ApiError, setCsrf } from "./api";
import { recognitionConstructor, type Recognition } from "./voice";

type Page = "overview" | "hosts" | "services" | "tasks" | "settings";
const navigation = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "hosts", label: "服务器", icon: Server },
  { id: "services", label: "服务", icon: Box },
  { id: "tasks", label: "操作记录", icon: Workflow },
  { id: "settings", label: "设置", icon: Settings2 },
] as const;
const taskLabels: Record<TaskStatus, string> = {
  observing: "正在检查",
  awaiting_approval: "等待确认",
  queued: "等待执行",
  running: "正在执行",
  verifying: "正在验证",
  succeeded: "已完成",
  failed: "未完成",
  cancelled: "已停止",
  unknown: "需要核对",
  expired: "计划已过期",
};
const healthLabels: Record<Health, string> = {
  healthy: "运行正常",
  warning: "需要关注",
  critical: "存在异常",
  unknown: "状态未知",
};
const isActive = (task: Task) =>
  ["observing", "queued", "running", "verifying"].includes(task.status);
const time = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const percent = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请重试";

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? "brand-small" : ""}`}>
      <span className="brand-mark">
        <Leaf size={23} strokeWidth={1.8} />
      </span>
      <span>
        栖云 <small>Qiyun</small>
      </span>
    </div>
  );
}
function HealthBadge({ status }: { status: Health }) {
  return (
    <span className={`status ${status}`}>
      <span className="status-dot" />
      {healthLabels[status]}
    </span>
  );
}
function TaskBadge({ task }: { task: Task }) {
  return (
    <span className={`status task-${task.status}`}>
      {isActive(task) ? (
        <Loader2 size={12} className="spin" />
      ) : (
        <span className="status-dot" />
      )}
      {taskLabels[task.status]}
    </span>
  );
}
function IconButton({
  children,
  label,
  onClick,
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Cloud size={30} strokeWidth={1.3} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Sparkline({
  values,
  className = "",
}: {
  values: number[];
  className?: string;
}) {
  if (values.length < 2)
    return <span className="muted tiny">等待更多采样</span>;
  const points = values
    .map(
      (value, i) =>
        `${(i / (values.length - 1)) * 160},${45 - Math.min(100, Math.max(0, value)) * 0.4}`,
    )
    .join(" ");
  return (
    <svg
      className={`sparkline ${className}`}
      viewBox="0 0 160 50"
      role="img"
      aria-label="最近 CPU 使用率采样"
    >
      <polyline points={`0,50 ${points} 160,50`} className="chart-fill" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const els = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input,textarea,select,[tabindex="0"]',
          ) || [],
        );
        const first = els[0];
        const last = els[els.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [onClose]);
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`drawer ${wide ? "wide" : ""}`}
        initial={{ x: reduced ? 0 : 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: reduced ? 0 : 0.24 }}
      >
        <header className="drawer-header">
          <span className="eyebrow">QIYUN WORKSPACE</span>
          <IconButton label="关闭面板" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </motion.div>
    </motion.div>
  );
}

function Composer({
  overview,
  onSubmit,
  busy,
  initialScope = "",
}: {
  overview: Overview;
  onSubmit: (prompt: string, scope: string) => Promise<void>;
  busy: boolean;
  initialScope?: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState(initialScope);
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const recognition = useRef<Recognition | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setScope(initialScope);
  }, [initialScope]);
  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const toggleVoice = () => {
    if (recording) {
      recognition.current?.stop();
      return;
    }
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setVoiceNote("当前浏览器不支持语音识别，请使用文字输入。");
      return;
    }
    const rec = new Constructor();
    recognition.current = rec;
    const prefix = prompt ? `${prompt} ` : "";
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) =>
      setPrompt(
        prefix +
          Array.from(event.results)
            .map((result) => result[0].transcript)
            .join(""),
      );
    rec.onerror = (event) => {
      setVoiceNote(
        (
          {
            "not-allowed": "麦克风权限被拒绝，请在浏览器设置中允许后重试。",
            "no-speech": "没有听清，请重试或输入文字。",
            network: "语音识别连接中断，已保留转写文字。",
          } as Record<string, string>
        )[event.error] || "语音识别不可用，已保留文字，请稍后重试。",
      );
      setRecording(false);
    };
    rec.onend = () => {
      setRecording(false);
      input.current?.focus();
    };
    try {
      rec.start();
      setRecording(true);
      setElapsed(0);
      setVoiceNote(
        "由浏览器提供语音识别；音频可能由浏览器服务处理。结束后可编辑再发送。",
      );
    } catch {
      setVoiceNote("无法开启语音识别，请检查浏览器权限。");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy || recording) return;
    try {
      await onSubmit(prompt.trim(), scope);
      setPrompt("");
    } catch {
      /* The parent displays the API error; preserve the request for editing. */
    }
  };
  return (
    <div className="composer-wrap">
      <form
        className={`composer ${recording ? "recording" : ""}`}
        onSubmit={submit}
      >
        <div className="composer-top">
          <span className="ai-symbol">
            <Sparkles size={18} />
          </span>
          <span>交给栖云，从一句话开始</span>
          <span className="composer-private">
            <ShieldCheck size={12} /> 变更前由你确认
          </span>
        </div>
        <textarea
          ref={input}
          value={prompt}
          maxLength={2000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="检查网站状态，或帮我看看服务为什么变慢了…"
          aria-label="告诉栖云需要处理什么"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-bottom">
          <label className="scope-select">
            <Network size={14} />
            <select
              aria-label="任务资源范围"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">全部资源</option>
              <optgroup label="服务器">
                {overview.hosts.map((h) => (
                  <option key={h.id} value={`host:${h.id}`}>
                    {h.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="服务">
                {overview.services.map((s) => (
                  <option key={s.id} value={`service:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <ChevronDown size={12} />
          </label>
          <div className="composer-actions">
            {recording && (
              <>
                <span className="recording-label">正在听 · {elapsed}s</span>
                <IconButton
                  label="取消录音"
                  onClick={() => {
                    recognition.current?.abort();
                    setRecording(false);
                    setVoiceNote("录音已取消，文字未发送。");
                  }}
                >
                  <X size={15} />
                </IconButton>
              </>
            )}
            <IconButton
              label={recording ? "结束录音" : "语音输入"}
              onClick={toggleVoice}
              className={recording ? "voice-active" : ""}
            >
              {recording ? <Square size={16} /> : <Mic size={18} />}
            </IconButton>
            <button
              className="send-button"
              disabled={!prompt.trim() || busy || recording}
              aria-label="发送任务"
            >
              {busy ? (
                <Loader2 size={18} className="spin" />
              ) : (
                <ArrowRight size={21} />
              )}
            </button>
          </div>
        </div>
      </form>
      {voiceNote && (
        <p className="voice-note" role="status">
          <AudioLines size={14} />
          {voiceNote}
        </p>
      )}
      <div className="suggestions">
        <span>试着问</span>
        {["检查所有服务运行状况", "查找需要关注的服务"].map((s) => (
          <button
            key={s}
            onClick={() => {
              setPrompt(s);
              input.current?.focus();
            }}
          >
            {s}
            <ArrowUpRight size={12} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ServiceCard({
  service,
  host,
  onOpen,
}: {
  service: Service;
  host?: Host;
  onOpen: () => void;
}) {
  const Icon =
    service.category === "website"
      ? Globe2
      : service.category === "database"
        ? Database
        : service.category === "infrastructure"
          ? Network
          : Box;
  return (
    <button className="service-card" onClick={onOpen}>
      <div className="service-card-top">
        <span className={`service-icon ${service.category}`}>
          <Icon size={23} strokeWidth={1.7} />
        </span>
        <HealthBadge
          status={host?.status === "offline" ? "unknown" : service.status}
        />
      </div>
      <h3>
        {service.name}
        <ArrowUpRight className="card-arrow" size={17} />
      </h3>
      <p>{service.description || service.image || "已登记服务"}</p>
      <div className="service-meta">
        <span>
          <Server size={12} />
          {host?.name || "未知主机"}
        </span>
        <span>{service.kind === "docker" ? "Docker" : "Systemd"}</span>
      </div>
      <footer>
        <span>
          {service.responseMs !== undefined ? (
            <>
              <b>{service.responseMs}</b> ms <span className="muted">响应</span>
            </>
          ) : (
            <>
              <b>{percent(service.cpu)}</b> <span className="muted">CPU</span>
            </>
          )}
        </span>
        <span className="muted tiny">{time(service.updatedAt)} 更新</span>
      </footer>
    </button>
  );
}
function HostCard({
  host,
  serviceCount,
  onInspect,
}: {
  host: Host;
  serviceCount: number;
  onInspect: () => void;
}) {
  return (
    <article className="host-card">
      <div className="host-card-head">
        <span className="host-icon">
          <Server size={22} />
        </span>
        <div>
          <h3>{host.name}</h3>
          <span className="muted tiny">{host.address}</span>
        </div>
        <span
          className={`status ${host.status === "online" ? "healthy" : "unknown"}`}
        >
          <span className="status-dot" />
          {host.status === "online" ? "已连接" : "连接中断"}
        </span>
      </div>
      <div className="host-chart">
        <div>
          <span className="muted tiny">CPU 使用率</span>
          <strong>{percent(host.cpu)}</strong>
        </div>
        <Sparkline values={host.history} />
      </div>
      <div className="resource-bars">
        {[
          { label: "内存", value: host.memory },
          { label: "磁盘", value: host.disk },
        ].map((item) => (
          <div key={item.label}>
            <div>
              <span>{item.label}</span>
              <b>{percent(item.value)}</b>
            </div>
            <div className="bar">
              <i
                style={{
                  width: `${item.value === null ? 0 : Math.min(100, item.value)}%`,
                }}
                className={item.value !== null && item.value > 85 ? "high" : ""}
              />
            </div>
          </div>
        ))}
      </div>
      <footer>
        <span>
          {host.os} · {serviceCount} 个服务
        </span>
        <button className="text-button" onClick={onInspect}>
          检查主机
          <ArrowRight size={14} />
        </button>
      </footer>
      {host.status === "offline" && (
        <p className="offline-note">
          最后连接：{date(host.lastSeen)}。当前服务状态需要核对。
        </p>
      )}
    </article>
  );
}
function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className={`task-row-icon ${task.status}`}>
        {task.status === "succeeded" ? (
          <CheckCheck size={18} />
        ) : task.status === "awaiting_approval" ? (
          <ShieldCheck size={18} />
        ) : task.status === "failed" || task.status === "unknown" ? (
          <TriangleAlert size={18} />
        ) : (
          <Activity size={18} />
        )}
      </span>
      <span className="task-row-text">
        <strong>{task.title}</strong>
        <span>
          {time(task.updatedAt)} · {taskLabels[task.status]}
        </span>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

function ServiceDetail({
  service,
  host,
  onTask,
}: {
  service: Service;
  host?: Host;
  onTask: (prompt: string, scope: string) => Promise<void>;
}) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const load = useCallback(() => {
    setError("");
    api<{ lines: LogLine[] }>(
      `/services/${encodeURIComponent(service.id)}/logs`,
    )
      .then((data) => setLines(data.lines))
      .catch((e) => setError(errorText(e)));
  }, [service.id]);
  useEffect(() => {
    if (tab === "logs") load();
  }, [tab, load]);
  const act = async (prompt: string) => {
    setBusy(true);
    try {
      await onTask(prompt, `service:${service.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="detail-title">
        <span className={`service-icon ${service.category}`}>
          <Box size={26} />
        </span>
        <h2>{service.name}</h2>
        <p>{service.description}</p>
        <HealthBadge
          status={host?.status === "offline" ? "unknown" : service.status}
        />
      </div>
      <div className="detail-tabs">
        <button
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          运行概况
        </button>
        <button
          className={tab === "logs" ? "active" : ""}
          onClick={() => setTab("logs")}
        >
          服务日志
        </button>
      </div>
      {tab === "overview" ? (
        <>
          <div className="detail-metrics">
            <div>
              <span>CPU</span>
              <strong>{percent(service.cpu)}</strong>
            </div>
            <div>
              <span>内存</span>
              <strong>
                {service.memory === null
                  ? "—"
                  : `${Math.round(service.memory)} MB`}
              </strong>
            </div>
            <div>
              <span>响应时间</span>
              <strong>
                {service.responseMs === undefined
                  ? "—"
                  : `${service.responseMs} ms`}
              </strong>
            </div>
          </div>
          <dl className="detail-list">
            <div>
              <dt>所在服务器</dt>
              <dd>{host?.name || service.hostId}</dd>
            </div>
            <div>
              <dt>运行方式</dt>
              <dd>
                {service.kind === "docker" ? "Docker 容器" : "Systemd 服务"}
              </dd>
            </div>
            <div>
              <dt>当前状态</dt>
              <dd>{service.state}</dd>
            </div>
            {service.image && (
              <div>
                <dt>镜像</dt>
                <dd className="mono">{service.image}</dd>
              </div>
            )}
            {service.port && (
              <div>
                <dt>端口</dt>
                <dd className="mono">{service.port}</dd>
              </div>
            )}
            <div>
              <dt>最后采集</dt>
              <dd>{date(service.updatedAt)}</dd>
            </div>
          </dl>
          {service.url && /^https?:\/\//i.test(service.url) && (
            <a
              className="external-link"
              href={service.url}
              target="_blank"
              rel="noreferrer"
            >
              {service.url}
              <ExternalLink size={14} />
            </a>
          )}
          <div className="info-box">
            <ShieldCheck size={18} />
            <div>
              <strong>每一次变更，都有迹可循</strong>
              <p>重启将先生成操作方案，经你确认后执行，再检查服务健康状态。</p>
            </div>
          </div>
          <div className="detail-actions">
            <button
              className="primary-button"
              onClick={() => void act("检查这个服务的运行状况")}
              disabled={busy}
            >
              <Sparkles size={16} />
              帮我检查
            </button>
            {service.restartAllowed && (
              <button
                className="secondary-button"
                onClick={() => void act("重启服务")}
                disabled={busy || host?.status === "offline"}
              >
                <RefreshCw size={16} />
                重启服务
              </button>
            )}
          </div>
          {!service.restartAllowed && (
            <p className="muted tiny">当前服务未授权重启操作。</p>
          )}
        </>
      ) : (
        <div className="logs-section">
          <div className="section-heading">
            <span>最近日志 · 有界读取</span>
            <IconButton label="刷新日志" onClick={load}>
              <RefreshCw size={16} />
            </IconButton>
          </div>
          {lines === null && !error ? (
            <div className="loading">
              <Loader2 className="spin" />
              读取日志中
            </div>
          ) : (
            <div className="log-view">
              {lines?.length ? (
                lines.map((line, i) => (
                  <div
                    className={`log-line ${line.level}`}
                    key={`${line.timestamp}-${i}`}
                  >
                    <time>{time(line.timestamp)}</time>
                    <span>{line.level.toUpperCase()}</span>
                    <p>{line.message}</p>
                  </div>
                ))
              ) : (
                <p className="muted">当前没有可读取的日志。</p>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function TaskDetail({
  task,
  onUpdate,
  onError,
}: {
  task: Task;
  onUpdate: (task: Task) => void;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const mutate = async (action: "approve" | "cancel") => {
    setBusy(true);
    try {
      onUpdate(
        await api<Task>(
          `/tasks/${encodeURIComponent(task.id)}/${action}`,
          action === "approve" ? { planHash: task.plan?.hash } : {},
        ),
      );
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const expiry = task.plan
    ? new Date(task.plan.expiresAt).getTime() < clock
    : false;
  return (
    <>
      <div className="task-detail-title">
        <div className="eyebrow green">
          <Sparkles size={14} /> 栖云任务单{" "}
          {task.mode === "demo" && <span className="demo-tag">演示</span>}
        </div>
        <h2>{task.title}</h2>
        <TaskBadge task={task} />
        <p className="muted tiny">
          开始于 {date(task.createdAt)}
          {isActive(task)
            ? ` · 已用 ${Math.max(0, Math.floor((clock - new Date(task.createdAt).getTime()) / 1000))} 秒`
            : ""}
        </p>
      </div>
      <div className="request-box">
        <span>你的请求</span>
        <p>{task.prompt}</p>
      </div>
      <div className="timeline">
        {task.events.map((event) => (
          <div className={`timeline-event ${event.kind}`} key={event.id}>
            <span className="timeline-node">
              {event.kind === "error" || event.kind === "warning" ? (
                <TriangleAlert size={14} />
              ) : event.kind === "approval" ? (
                <ShieldCheck size={14} />
              ) : (
                <Check size={13} />
              )}
            </span>
            <div>
              <div className="timeline-heading">
                <h4>{event.title}</h4>
                <time>{time(event.at)}</time>
              </div>
              {event.detail && <p>{event.detail}</p>}
            </div>
          </div>
        ))}
        {isActive(task) && (
          <div className="timeline-event">
            <span className="timeline-node current">
              <Loader2 size={14} className="spin" />
            </span>
            <div>
              <h4>{taskLabels[task.status]}…</h4>
              <p>最新活动 {time(task.updatedAt)}，结果将在这里持续更新。</p>
            </div>
          </div>
        )}
      </div>
      {task.plan && (
        <div className="plan-card">
          <div className="plan-head">
            <ShieldCheck size={21} />
            <div>
              <h3>
                {task.status === "awaiting_approval"
                  ? "这项操作需要你的确认"
                  : "操作方案"}
              </h3>
              <span>重启服务 · {task.plan.serviceName}</span>
            </div>
          </div>
          <dl>
            <div>
              <dt>影响范围</dt>
              <dd>{task.plan.impact}</dd>
            </div>
            <div>
              <dt>执行前检查</dt>
              <dd>核对服务状态与计划版本，发生变化将拒绝旧方案。</dd>
            </div>
            <div>
              <dt>完成后验证</dt>
              <dd>{task.plan.verification}</dd>
            </div>
            <div>
              <dt>恢复能力</dt>
              <dd>{task.plan.rollback}</dd>
            </div>
          </dl>
          <details>
            <summary>查看计划依据</summary>
            <div className="plan-technical">
              服务器：{task.plan.hostId}
              <br />
              服务：{task.plan.serviceId}
              <br />
              资源版本：{task.plan.expectedRevision}
              <br />
              有效期：{date(task.plan.expiresAt)}
              <br />
              计划标识：{task.plan.hash}
            </div>
          </details>
          {task.status === "awaiting_approval" && (
            <>
              <button
                className="primary-button full"
                disabled={busy || expiry}
                onClick={() => void mutate("approve")}
              >
                {busy ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Check size={17} />
                )}{" "}
                {expiry
                  ? "方案已过期，请重新发起任务"
                  : `确认重启 ${task.plan.serviceName}`}
              </button>
              <p className="tiny muted">
                {task.mode === "demo"
                  ? "演示操作仅影响模拟数据，不会连接真实服务器。"
                  : "仅执行以上操作；批准绑定本次计划及资源状态。"}
              </p>
            </>
          )}
        </div>
      )}
      {task.summary && (
        <div className={`result-card ${task.status}`}>
          <h3>
            {task.status === "succeeded" ? (
              <CheckCircle2 size={19} />
            ) : (
              <FileText size={19} />
            )}
            任务结论
          </h3>
          <p>{task.summary}</p>
        </div>
      )}
      {task.error && (
        <p className="inline-error" role="alert">
          {task.error}
        </p>
      )}
      {task.status === "unknown" && (
        <div className="warning-box">
          结果暂时无法确认，请先核对实际服务状态。不要重复发起相同变更。
        </div>
      )}
      {task.usage && (
        <div className="usage-note">
          模型调用 {task.usage.requests} 次 · 输入{" "}
          {task.usage.inputTokens.toLocaleString()} / 输出{" "}
          {task.usage.outputTokens.toLocaleString()} tokens
          <br />
          Token 用量不等同于套餐费用。
        </div>
      )}
      {(isActive(task) || task.status === "awaiting_approval") && (
        <button
          className="secondary-button full"
          disabled={busy}
          onClick={() => void mutate("cancel")}
        >
          <Square size={14} />
          停止后续步骤
        </button>
      )}
      <p className="task-id mono">{task.id}</p>
    </>
  );
}

function Login({
  session,
  onLogin,
  onError,
}: {
  session: Session;
  onLogin: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const authenticate = async (demo = false) => {
    setBusy(true);
    try {
      await api(
        demo
          ? "/auth/demo"
          : session.setupRequired
            ? "/auth/setup"
            : "/auth/login",
        demo ? {} : session.setupRequired ? { name, password } : { password },
      );
      await onLogin();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div className="login-story-copy">
          <span className="eyebrow">A LITTLE CALM FOR YOUR CLOUD</span>
          <h1>
            把服务器照看好，
            <br />
            把时间留给创造。
          </h1>
          <p>
            看见每一个服务的状态。
            <br />
            用一句话，让复杂的运维井然有序。
          </p>
          <div className="cloud-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-leaf leaf-one">
              <Leaf />
            </div>
            <div className="art-leaf leaf-two">
              <Sparkles />
            </div>
            <div className="art-server">
              <div>
                <span />
                <i />
                <i />
              </div>
              <div>
                <span />
                <i />
                <i />
              </div>
              <div>
                <span />
                <i />
                <i />
              </div>
              <div className="art-check">
                <Check size={22} />
              </div>
            </div>
            <span className="art-caption">EVERYTHING, IN ITS PLACE.</span>
          </div>
        </div>
        <span className="login-footer">
          自托管 · 有边界的智能 · 可追溯的操作
        </span>
      </div>
      <div className="login-form-side">
        <div className="login-form">
          <span className="eyebrow green">YOUR QUIET WORKSPACE</span>
          <h2>{session.setupRequired ? "欢迎来到栖云" : "欢迎回来"}</h2>
          <p>
            {session.setupRequired
              ? "创建管理员，开始照看你的云端空间。"
              : "登录你的工作台，看看一切是否安好。"}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void authenticate();
            }}
          >
            {session.setupRequired && (
              <label>
                怎么称呼你
                <input
                  autoComplete="name"
                  required
                  maxLength={60}
                  placeholder="你的名字"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            <label>
              管理员密码
              <input
                type="password"
                autoComplete={
                  session.setupRequired ? "new-password" : "current-password"
                }
                required
                minLength={session.setupRequired ? 12 : 1}
                maxLength={256}
                placeholder={
                  session.setupRequired ? "至少 12 位字符" : "输入密码"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="primary-button full" disabled={busy}>
              {busy ? <Loader2 size={18} className="spin" /> : null}
              {session.setupRequired ? "创建我的工作台" : "进入工作台"}
              <ArrowRight size={17} />
            </button>
          </form>
          {session.demoAvailable && (
            <>
              <div className="or-divider">
                <span>想先看看？</span>
              </div>
              <button
                className="secondary-button full"
                disabled={busy}
                onClick={() => void authenticate(true)}
              >
                <Sparkles size={16} />
                体验演示工作台 <ArrowUpRight size={16} />
              </button>
              <p className="tiny centered">
                演示数据与真实环境隔离，不会操作真实服务器。
              </p>
            </>
          )}
          <div className="login-trust">
            <ShieldCheck size={15} />
            <span>你的基础设施，始终由你掌控。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [theme, setTheme] = useState(
    () => localStorage.getItem("qiyun-theme") || "light",
  );
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [lastSync, setLastSync] = useState("");
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
    controlUrl: string;
  } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const reduced = useReducedMotion();
  const loadSession = useCallback(async () => {
    const current = await api<Session>("/session");
    setCsrf(current.csrfToken);
    setSession(current);
    if (!current.authenticated) setOverview(null);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const data = await api<Overview>("/overview");
      setOverview(data);
      setLastSync(new Date().toISOString());
      setConnectionError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await loadSession().catch(() => undefined);
        setSelectedTask(null);
        setSelectedService(null);
        setError("登录已过期，请重新进入工作台。");
      } else setConnectionError(errorText(e));
    }
  }, [loadSession]);
  useEffect(() => {
    loadSession().catch((e) => setConnectionError(errorText(e)));
  }, [loadSession]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("qiyun-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!session?.authenticated) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [session?.authenticated, session?.mode, refresh]);
  useEffect(() => {
    if (
      !selectedTask ||
      !(isActive(selectedTask) || selectedTask.status === "awaiting_approval")
    )
      return;
    let stopped = false;
    let pending = false;
    const id = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await api<Task>(
          `/tasks/${encodeURIComponent(selectedTask.id)}`,
        );
        if (!stopped) {
          setSelectedTask(data);
          if (data.status !== selectedTask.status) void refresh();
        }
      } catch (e) {
        if (!stopped) setConnectionError(errorText(e));
      } finally {
        pending = false;
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [selectedTask?.id, selectedTask?.status, refresh]);
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(id);
  }, [error]);
  const changePage = (next: Page) => {
    setPage(next);
    setSearch("");
    setFilter("all");
    setMobileNav(false);
  };
  const createTask = async (prompt: string, chosenScope: string) => {
    setCreating(true);
    try {
      const body = {
        prompt,
        ...(chosenScope.startsWith("service:")
          ? { serviceId: chosenScope.slice(8) }
          : chosenScope.startsWith("host:")
            ? { hostId: chosenScope.slice(5) }
            : {}),
      };
      const task = await api<Task>("/tasks", body);
      setSelectedService(null);
      setSelectedTask(task);
      void refresh();
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setCreating(false);
    }
  };
  const safelyCreate = (prompt: string, chosenScope = "") => {
    void createTask(prompt, chosenScope).catch(() => undefined);
  };
  const logout = async () => {
    try {
      await api("/auth/logout", {});
      setSelectedTask(null);
      setSelectedService(null);
      await loadSession();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const pair = async () => {
    setPairBusy(true);
    try {
      setPairing(await api("/pairing", {}));
      setCopied(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPairBusy(false);
    }
  };
  const closeService = useCallback(() => setSelectedService(null), []);
  const closeTask = useCallback(() => setSelectedTask(null), []);
  const closePairing = useCallback(() => setPairing(null), []);
  const toast = (
    <AnimatePresence>
      {error && (
        <motion.div
          role="alert"
          className="toast"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
        >
          <TriangleAlert size={18} />
          <span>{error}</span>
          <IconButton label="关闭通知" onClick={() => setError("")}>
            <X size={16} />
          </IconButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
  if (!session)
    return (
      <>
        <div className="boot">
          <Brand />
          {connectionError ? (
            <>
              <p>{connectionError}</p>
              <button
                className="secondary-button"
                onClick={() => {
                  setConnectionError("");
                  loadSession().catch((e) => setConnectionError(errorText(e)));
                }}
              >
                重新连接
              </button>
            </>
          ) : (
            <p>
              <Loader2 className="spin" size={18} />
              正在打开你的工作台
            </p>
          )}
        </div>
        {toast}
      </>
    );
  if (!session.authenticated)
    return (
      <>
        <Login session={session} onLogin={loadSession} onError={setError} />
        {toast}
      </>
    );
  const services = overview?.services || [];
  const hosts = overview?.hosts || [];
  const tasks = overview?.tasks || [];
  const online = hosts.filter((h) => h.status === "online").length;
  const healthy = services.filter(
    (s) =>
      s.status === "healthy" &&
      hosts.find((h) => h.id === s.hostId)?.status !== "offline",
  ).length;
  const attention = services.filter(
    (s) =>
      s.status !== "healthy" ||
      hosts.find((h) => h.id === s.hostId)?.status === "offline",
  );
  const service = services.find((s) => s.id === selectedService);
  const filteredServices = services.filter(
    (s) =>
      (filter === "all" ||
        (filter === "attention" && attention.includes(s)) ||
        s.category === filter) &&
      `${s.name} ${s.description} ${s.image || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const filteredTasks = tasks.filter(
    (t) =>
      (filter === "all" ||
        (filter === "active" &&
          (isActive(t) || t.status === "awaiting_approval")) ||
        (filter === "done" && t.status === "succeeded") ||
        (filter === "issue" &&
          ["failed", "unknown", "expired"].includes(t.status))) &&
      `${t.title} ${t.prompt}`.toLowerCase().includes(search.toLowerCase()),
  );
  const title = navigation.find((n) => n.id === page)?.label || "概览";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <Brand />
        <div className="workspace-badge">
          <span className="workspace-avatar">Q</span>
          <div>
            <strong>我的云端空间</strong>
            <span>
              {overview?.mode === "demo" ? "演示工作台" : "个人工作台"}
            </span>
          </div>
          <ChevronDown size={13} />
        </div>
        <span className="nav-caption">工作空间</span>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => changePage(item.id)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              {item.label}
              {item.id === "services" && services.length > 0 && (
                <span className="nav-count">{services.length}</span>
              )}
              {item.id === "tasks" &&
                tasks.some((t) => t.status === "awaiting_approval") && (
                  <span className="nav-notice" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Leaf size={21} />
            <strong>
              少一点忙乱，
              <br />
              多一点从容。
            </strong>
            <span>让每一次操作都有把握。</span>
          </div>
          <div className="sidebar-tools">
            <button
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <span>
                {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}{" "}
                {theme === "light" ? "深色外观" : "浅色外观"}
              </span>
              <span className="tiny">切换</span>
            </button>
            <button onClick={() => void logout()}>
              <span>
                <LogOut size={16} />
                退出{session.mode === "demo" ? "演示" : "登录"}
              </span>
            </button>
          </div>
          <div className="profile">
            <span className="avatar">
              {(session.name || "访客").slice(0, 1)}
            </span>
            <div>
              <strong>{session.name || "演示访客"}</strong>
              <span>
                {session.mode === "demo" ? "正在体验演示" : "工作台管理员"}
              </span>
            </div>
            <ShieldCheck size={15} />
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="mobile-scrim"
          aria-label="收起导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div>
            <IconButton
              className="mobile-menu"
              label="打开导航"
              onClick={() => setMobileNav((v) => !v)}
            >
              <Menu size={20} />
            </IconButton>
            <span className="breadcrumb">
              工作空间 <ChevronRight size={12} /> <b>{title}</b>
            </span>
          </div>
          <div className="topbar-right">
            {overview?.mode === "demo" && (
              <span className="demo-tag">
                <Sparkles size={12} />
                演示环境
              </span>
            )}
            <span
              className={`connection-label ${connectionError ? "disconnected" : ""}`}
            >
              <span className="status-dot" />
              {connectionError ? "连接中断" : "控制端已连接"}
            </span>
            <span className="topbar-divider" />
            <span className="date-label">
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "short",
              })}
            </span>
            <span className="avatar small-avatar">
              {(session.name || "Q").slice(0, 1)}
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: reduced ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.18 }}
              className="page-content"
            >
              {connectionError && (
                <div className="connection-banner" role="status">
                  <TriangleAlert size={17} />
                  <span>
                    数据暂时无法更新：{connectionError}
                    。正在保留最后一次采集结果。
                  </span>
                  <button onClick={() => void refresh()}>重试</button>
                </div>
              )}
              {!overview ? (
                <div className="loading">
                  <Loader2 size={22} className="spin" />
                  正在读取工作台…
                </div>
              ) : (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        {page === "overview"
                          ? "YOUR CLOUD, AT A GLANCE"
                          : page === "hosts"
                            ? "A HOME FOR YOUR SERVICES"
                            : page === "services"
                              ? "EVERY SERVICE MATTERS"
                              : page === "tasks"
                                ? "EVERY ACTION, ACCOUNTED FOR"
                                : "MAKE IT YOURS"}
                      </span>
                      <h1>
                        {page === "overview"
                          ? `${new Date().getHours() < 11 ? "早上好" : new Date().getHours() < 18 ? "下午好" : "晚上好"}，${session.mode === "demo" ? "朋友" : session.name || "朋友"}`
                          : page === "hosts"
                            ? "你的服务器"
                            : page === "services"
                              ? "服务，一目了然"
                              : page === "tasks"
                                ? "每一步，都有记录"
                                : "工作台设置"}
                        {page === "overview" && (
                          <span className="greeting-leaf">
                            <Leaf size={23} />
                          </span>
                        )}
                      </h1>
                      <p>
                        {page === "overview"
                          ? hosts.length
                            ? `这里是你的云端近况。${attention.length ? `${attention.length} 个服务需要留意，我们一起看看。` : "一切有序，可以安心专注于创造。"}`
                            : "新的空间已经准备好，连接第一台服务器吧。"
                          : page === "hosts"
                            ? "掌握每台机器的状态，让资源各得其所。"
                            : page === "services"
                              ? "从网站到数据库，照看每一个重要的服务。"
                              : page === "tasks"
                                ? "查看执行过程、确认方案，追溯每一次改变。"
                                : "连接、模型与偏好，由你掌握。"}
                      </p>
                    </div>
                    {(page === "hosts" || page === "overview") &&
                    overview.mode === "live" ? (
                      <button
                        className="secondary-button"
                        onClick={() => void pair()}
                        disabled={pairBusy}
                      >
                        <Plus size={16} />
                        连接服务器
                      </button>
                    ) : (
                      <button
                        className="subtle-button"
                        onClick={() => void refresh()}
                      >
                        <RefreshCw size={14} />
                        {lastSync ? `${time(lastSync)} 已更新` : "刷新数据"}
                      </button>
                    )}
                  </div>
                  {page === "overview" && (
                    <>
                      <section className="stats-grid" aria-label="资源概要">
                        <div className="stat-card">
                          <span className="stat-label">
                            <Server size={16} />
                            在线服务器
                          </span>
                          <div className="stat-value">
                            {online}
                            <small>/ {hosts.length}</small>
                            <span className="stat-foot">
                              {hosts.length && online === hosts.length
                                ? "全部已连接"
                                : "已连接主机"}
                            </span>
                          </div>
                          <div className="stat-bottom">
                            <span className="mini-dots">
                              {hosts.slice(0, 10).map((h) => (
                                <i className={h.status} key={h.id} />
                              ))}
                            </span>
                            <span>连接状态</span>
                          </div>
                        </div>
                        <div className="stat-card">
                          <span className="stat-label">
                            <Box size={16} />
                            健康服务
                          </span>
                          <div className="stat-value">
                            {healthy}
                            <small>/ {services.length}</small>
                            <span className="stat-foot">持续照看中</span>
                          </div>
                          <div className="stat-bottom">
                            <div className="health-track">
                              <i
                                style={{
                                  width: `${services.length ? (healthy / services.length) * 100 : 0}%`,
                                }}
                              />
                            </div>
                            <span>服务健康</span>
                          </div>
                        </div>
                        <div
                          className={`stat-card ${attention.length ? "attention-stat" : ""}`}
                        >
                          <span className="stat-label">
                            <Activity size={16} />
                            需要关注
                          </span>
                          <div className="stat-value">
                            {attention.length}
                            <small>项</small>
                            <span className="stat-foot">
                              {attention.length ? "值得看一眼" : "目前没有异常"}
                            </span>
                          </div>
                          <div className="stat-bottom">
                            <span>
                              {attention.length
                                ? "让栖云帮你找到原因"
                                : "运行有序，安心一点"}
                            </span>
                            <ArrowUpRight size={15} />
                          </div>
                        </div>
                      </section>
                      {attention.length > 0 && (
                        <div className="attention-banner">
                          <span className="attention-icon">
                            <Activity size={19} />
                          </span>
                          <div>
                            <strong>{attention[0].name} 需要关注</strong>
                            <span>
                              {attention[0].description ||
                                "最近采集到了异常状态，建议检查服务。"}
                            </span>
                          </div>
                          <button
                            onClick={() =>
                              safelyCreate(
                                "检查这个服务的异常原因",
                                `service:${attention[0].id}`,
                              )
                            }
                          >
                            帮我检查
                            <ArrowRight size={14} />
                          </button>
                          <IconButton
                            label="查看异常服务"
                            onClick={() => setSelectedService(attention[0].id)}
                          >
                            <ChevronRight size={17} />
                          </IconButton>
                        </div>
                      )}
                      <Composer
                        overview={overview}
                        onSubmit={createTask}
                        busy={creating}
                      />
                      <div className="overview-columns">
                        <section>
                          <div className="section-heading">
                            <h2>
                              服务近况 <span>{services.length}</span>
                            </h2>
                            <button
                              className="text-button"
                              onClick={() => changePage("services")}
                            >
                              查看全部
                              <ArrowRight size={14} />
                            </button>
                          </div>
                          {services.length ? (
                            <div className="service-grid overview-services">
                              {services.slice(0, 4).map((s) => (
                                <ServiceCard
                                  key={s.id}
                                  service={s}
                                  host={hosts.find((h) => h.id === s.hostId)}
                                  onOpen={() => setSelectedService(s.id)}
                                />
                              ))}
                            </div>
                          ) : (
                            <Empty
                              title="让第一个服务在这里安家"
                              action={
                                overview.mode === "live" ? (
                                  <button
                                    className="primary-button"
                                    onClick={() => void pair()}
                                    disabled={pairBusy}
                                  >
                                    <Plus size={16} />
                                    连接服务器
                                  </button>
                                ) : undefined
                              }
                            >
                              连接 Linux
                              服务器后，已登记的容器与服务会自动出现在这里。
                            </Empty>
                          )}
                        </section>
                        <aside className="activity-column">
                          <div className="section-heading">
                            <h2>最近操作</h2>
                            <button
                              className="text-button"
                              onClick={() => changePage("tasks")}
                            >
                              全部
                              <ArrowRight size={14} />
                            </button>
                          </div>
                          <div className="activity-card">
                            {tasks.length ? (
                              tasks
                                .slice(0, 5)
                                .map((t) => (
                                  <TaskRow
                                    key={t.id}
                                    task={t}
                                    onClick={() => setSelectedTask(t)}
                                  />
                                ))
                            ) : (
                              <div className="activity-empty">
                                <Workflow size={26} />
                                <strong>还没有任务</strong>
                                <p>
                                  从上方输入一句话，
                                  <br />
                                  开始你的第一次检查。
                                </p>
                              </div>
                            )}
                            <div className="activity-card-foot">
                              <ShieldCheck size={14} />
                              每次操作都有完整记录
                            </div>
                          </div>
                          <div className="calm-card">
                            <div className="calm-illustration">
                              <Leaf size={35} strokeWidth={1} />
                              <span />
                              <span />
                            </div>
                            <span className="eyebrow">
                              A LITTLE LESS TO WORRY ABOUT
                            </span>
                            <h3>有条不紊，自在运行。</h3>
                            <p>
                              检查可以交给栖云，
                              <br />
                              重要的决定始终交给你。
                            </p>
                          </div>
                        </aside>
                      </div>
                    </>
                  )}
                  {page === "hosts" && (
                    <>
                      {hosts.length ? (
                        <div className="host-grid">
                          {hosts.map((h) => (
                            <HostCard
                              key={h.id}
                              host={h}
                              serviceCount={
                                services.filter((s) => s.hostId === h.id).length
                              }
                              onInspect={() =>
                                safelyCreate(
                                  "检查这台服务器的运行状况",
                                  `host:${h.id}`,
                                )
                              }
                            />
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title="连接你的第一台服务器"
                          action={
                            <button
                              className="primary-button"
                              onClick={() => void pair()}
                              disabled={pairBusy}
                            >
                              <Plus size={16} />
                              生成配对令牌
                            </button>
                          }
                        >
                          支持 Linux 云服务器 / VPS。主机 Agent
                          主动连接工作台，采集已登记的服务。
                        </Empty>
                      )}
                      <div className="bottom-composer">
                        <h2>想了解某台机器的情况？</h2>
                        <Composer
                          overview={overview}
                          onSubmit={createTask}
                          busy={creating}
                        />
                      </div>
                    </>
                  )}
                  {page === "services" && (
                    <>
                      <div className="filter-toolbar">
                        <div className="filter-tabs">
                          {[
                            { id: "all", label: "全部服务" },
                            { id: "website", label: "网站" },
                            { id: "database", label: "数据库" },
                            { id: "attention", label: "需要关注" },
                          ].map((f) => (
                            <button
                              key={f.id}
                              className={filter === f.id ? "active" : ""}
                              onClick={() => setFilter(f.id)}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                        <label className="search-box">
                          <Search size={16} />
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="查找服务…"
                            aria-label="查找服务"
                          />
                          {search && (
                            <button
                              onClick={() => setSearch("")}
                              aria-label="清除搜索"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </label>
                      </div>
                      {filteredServices.length ? (
                        <div className="service-grid">
                          {filteredServices.map((s) => (
                            <ServiceCard
                              key={s.id}
                              service={s}
                              host={hosts.find((h) => h.id === s.hostId)}
                              onOpen={() => setSelectedService(s.id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title={
                            services.length
                              ? "没有找到匹配的服务"
                              : "服务还没有入住"
                          }
                        >
                          {services.length
                            ? "试试其他名称，或切换服务分类。"
                            : "连接服务器并登记服务后，运行状态将在这里展示。"}
                        </Empty>
                      )}
                      <div className="bottom-composer">
                        <Composer
                          overview={overview}
                          onSubmit={createTask}
                          busy={creating}
                        />
                      </div>
                    </>
                  )}
                  {page === "tasks" && (
                    <>
                      <div className="filter-toolbar">
                        <div className="filter-tabs">
                          {[
                            { id: "all", label: "全部记录" },
                            { id: "active", label: "进行中" },
                            { id: "done", label: "已完成" },
                            { id: "issue", label: "需要核对" },
                          ].map((f) => (
                            <button
                              key={f.id}
                              className={filter === f.id ? "active" : ""}
                              onClick={() => setFilter(f.id)}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                        <label className="search-box">
                          <Search size={16} />
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="查找操作…"
                            aria-label="查找操作"
                          />
                        </label>
                      </div>
                      {filteredTasks.length ? (
                        <div className="task-table">
                          <div className="task-table-heading">
                            <span>任务</span>
                            <span>状态</span>
                            <span>更新时间</span>
                            <span />
                          </div>
                          {filteredTasks.map((t) => (
                            <button
                              className="task-table-row"
                              key={t.id}
                              onClick={() => setSelectedTask(t)}
                            >
                              <div>
                                <span className="table-task-icon">
                                  <Workflow size={19} />
                                </span>
                                <span>
                                  <strong>{t.title}</strong>
                                  <small>{t.prompt}</small>
                                </span>
                              </div>
                              <TaskBadge task={t} />
                              <time>{date(t.updatedAt)}</time>
                              <ChevronRight size={16} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty title="这里会记录每一次行动">
                          发起检查或服务操作后，可以在这里查看完整过程和结果。
                        </Empty>
                      )}
                    </>
                  )}
                  {page === "settings" && (
                    <div className="settings-grid">
                      <section className="settings-card">
                        <div className="settings-title">
                          <Sparkles size={21} />
                          <div>
                            <h2>智能助手</h2>
                            <p>由服务端配置管理，密钥不会发送到浏览器。</p>
                          </div>
                        </div>
                        <dl className="detail-list">
                          <div>
                            <dt>服务商</dt>
                            <dd>火山方舟 · Ark</dd>
                          </div>
                          <div>
                            <dt>模型</dt>
                            <dd className="mono">{overview.provider.model}</dd>
                          </div>
                          <div>
                            <dt>接口地址</dt>
                            <dd className="mono">
                              {overview.provider.baseUrl || "演示无需连接"}
                            </dd>
                          </div>
                          <div>
                            <dt>凭据状态</dt>
                            <dd>
                              <span
                                className={`status ${overview.provider.configured ? "healthy" : "warning"}`}
                              >
                                <span className="status-dot" />
                                {overview.provider.configured
                                  ? "已配置"
                                  : "尚未配置"}
                              </span>
                            </dd>
                          </div>
                          <div>
                            <dt>调用验证</dt>
                            <dd>
                              {overview.provider.verified
                                ? "已验证"
                                : "尚未验证真实调用"}
                            </dd>
                          </div>
                        </dl>
                        <div className="info-box">
                          <CircleHelp size={18} />
                          <p>
                            配置由部署环境提供。演示体验不代表模型已完成真实接入，系统不会自动切换模型或付费端点。
                          </p>
                        </div>
                      </section>
                      <section className="settings-card">
                        <div className="settings-title">
                          <Sun size={21} />
                          <div>
                            <h2>外观与体验</h2>
                            <p>找到让你最舒服的工作方式。</p>
                          </div>
                        </div>
                        <div className="theme-options">
                          <button
                            className={theme === "light" ? "selected" : ""}
                            onClick={() => setTheme("light")}
                          >
                            <span className="theme-preview light-preview">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span>
                              <Sun size={16} />
                              暖雾浅色{theme === "light" && <Check size={15} />}
                            </span>
                          </button>
                          <button
                            className={theme === "dark" ? "selected" : ""}
                            onClick={() => setTheme("dark")}
                          >
                            <span className="theme-preview dark-preview">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span>
                              <Moon size={16} />
                              深林夜色{theme === "dark" && <Check size={15} />}
                            </span>
                          </button>
                        </div>
                        <dl className="detail-list">
                          <div>
                            <dt>动态效果</dt>
                            <dd>
                              {reduced
                                ? "已跟随系统减少动态效果"
                                : "跟随系统偏好"}
                            </dd>
                          </div>
                          <div>
                            <dt>语音识别</dt>
                            <dd>
                              {recognitionConstructor()
                                ? "浏览器支持 · 点击麦克风启用"
                                : "当前浏览器不支持"}
                            </dd>
                          </div>
                        </dl>
                        <p className="muted tiny">
                          语音由浏览器识别服务提供，可能需要联网。转写后可以编辑，不会自动发送任务。
                        </p>
                      </section>
                      <section className="settings-card">
                        <div className="settings-title">
                          <ShieldCheck size={21} />
                          <div>
                            <h2>当前工作空间</h2>
                            <p>操作边界清楚，才能放心交付。</p>
                          </div>
                        </div>
                        <dl className="detail-list">
                          <div>
                            <dt>运行环境</dt>
                            <dd>
                              {overview.mode === "demo"
                                ? "隔离演示环境"
                                : "真实工作空间"}
                            </dd>
                          </div>
                          <div>
                            <dt>当前用户</dt>
                            <dd>{session.name || "访客"}</dd>
                          </div>
                          <div>
                            <dt>变更确认</dt>
                            <dd>服务重启需要逐次批准</dd>
                          </div>
                          <div>
                            <dt>日志记录</dt>
                            <dd>保留任务过程与执行证据</dd>
                          </div>
                        </dl>
                        {overview.mode === "live" && (
                          <button
                            className="secondary-button"
                            onClick={() => void pair()}
                            disabled={pairBusy}
                          >
                            <Plus size={16} />
                            连接新服务器
                          </button>
                        )}
                      </section>
                    </div>
                  )}
                  <footer className="page-footer">
                    <span>
                      <Leaf size={13} />
                      栖云，让运维从容一点。
                    </span>
                    <span>
                      {overview.mode === "demo"
                        ? "演示数据 · 不影响真实服务器"
                        : "自托管工作台 · 变更由你确认"}
                    </span>
                  </footer>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <AnimatePresence>
        {service && (
          <Modal title={`${service.name} 服务详情`} onClose={closeService}>
            <ServiceDetail
              service={service}
              host={hosts.find((h) => h.id === service.hostId)}
              onTask={createTask}
            />
          </Modal>
        )}
        {selectedTask && (
          <Modal title="任务详情" onClose={closeTask}>
            <TaskDetail
              task={selectedTask}
              onError={setError}
              onUpdate={(t) => {
                setSelectedTask(t);
                void refresh();
              }}
            />
          </Modal>
        )}
        {pairing && (
          <Modal title="连接服务器" onClose={closePairing}>
            <div className="detail-title">
              <span className="service-icon">
                <Server size={25} />
              </span>
              <h2>让服务器与你的空间相连</h2>
              <p>
                在 Linux 主机上配置并启动栖云
                Agent，使用以下一次性令牌完成配对。
              </p>
            </div>
            <div className="info-box">
              <ShieldCheck size={18} />
              <p>
                令牌仅在此显示，请妥善保管。到期时间：{date(pairing.expiresAt)}
                。
              </p>
            </div>
            <label className="pairing-label">
              一次性配对令牌
              <div className="token-box">
                <code>{pairing.token}</code>
                <IconButton
                  label="复制配对令牌"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(pairing.token)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError("无法访问剪贴板，请手动复制令牌。"),
                      );
                  }}
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </IconButton>
              </div>
            </label>
            <dl className="detail-list">
              <div>
                <dt>控制端地址</dt>
                <dd className="mono">{pairing.controlUrl}</dd>
              </div>
            </dl>
            <ol className="pairing-steps">
              <li>
                按照仓库中的 Agent 部署说明，在目标 Linux 主机安装并配置 Agent。
              </li>
              <li>确认控制端地址可以从服务器访问，并启用可信的 HTTPS 连接。</li>
              <li>
                将配对令牌交给主机
                Agent。连接成功后，主机会自动出现在服务器列表。
              </li>
            </ol>
            <p className="muted tiny">
              当前页面不提供未经验证的一键安装命令。关闭后不会在浏览器中保存令牌。
            </p>
            <button className="primary-button full" onClick={closePairing}>
              完成，返回工作台
              <ArrowRight size={16} />
            </button>
          </Modal>
        )}
      </AnimatePresence>
      {toast}
    </div>
  );
}
