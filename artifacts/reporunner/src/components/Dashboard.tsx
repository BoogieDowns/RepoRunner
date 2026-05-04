import { useState, useEffect, useRef } from "react";
import {
  Download,
  Package,
  Play,
  Server,
  SquareSquare,
  RotateCw,
  ExternalLink,
  Copy,
  Trash2,
  Settings2,
  Loader2,
} from "lucide-react";
import { ProjectProfile, ServiceStatuses, LogEntry } from "@/types";
import { CommandButton } from "./CommandButton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/* ─── Ambient Background ──────────────────────────────────────────────────── */

const LINE_CONFIGS = [
  { left: 7,  delay: 0.0, dur: 5.2, h: 22, op: 0.50 },
  { left: 15, delay: 3.1, dur: 7.4, h: 16, op: 0.30 },
  { left: 23, delay: 1.4, dur: 6.0, h: 26, op: 0.58 },
  { left: 34, delay: 4.8, dur: 5.7, h: 18, op: 0.40 },
  { left: 44, delay: 2.2, dur: 6.8, h: 30, op: 0.55 },
  { left: 53, delay: 0.6, dur: 5.4, h: 20, op: 0.35 },
  { left: 62, delay: 3.9, dur: 7.1, h: 24, op: 0.62 },
  { left: 71, delay: 1.8, dur: 5.9, h: 19, op: 0.38 },
  { left: 80, delay: 5.2, dur: 6.3, h: 27, op: 0.48 },
  { left: 88, delay: 2.7, dur: 4.8, h: 21, op: 0.42 },
];

const EXTRA_LINES = [
  { left: 19, delay: 1.1, dur: 6.6, h: 23, op: 0.52 },
  { left: 40, delay: 3.5, dur: 5.2, h: 17, op: 0.36 },
  { left: 76, delay: 0.9, dur: 6.9, h: 28, op: 0.60 },
];

function AmbientBackground({ anyRunning, bothRunning }: { anyRunning: boolean; bothRunning: boolean }) {
  const lines = bothRunning ? [...LINE_CONFIGS, ...EXTRA_LINES] : LINE_CONFIGS;

  const moonBorder = anyRunning
    ? bothRunning ? "rgba(175,25,25,0.20)" : "rgba(155,20,20,0.13)"
    : "rgba(90,8,8,0.06)";
  const moonGlow = anyRunning
    ? bothRunning
      ? "0 0 60px rgba(175,25,25,0.18), 0 0 120px rgba(130,12,12,0.10)"
      : "0 0 40px rgba(155,20,20,0.11)"
    : "none";

  const grainUrl = `url('data:image/svg+xml,<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/></filter><rect width="100%25" height="100%25" filter="url(%23n)"/></svg>')`;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {/* Film grain */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: grainUrl,
          backgroundSize: "200px 200px",
          opacity: 0.048,
          mixBlendMode: "overlay",
        }}
      />

      {/* Outer halo ring */}
      <div
        style={{
          position: "absolute",
          bottom: "-315px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "790px",
          height: "790px",
          borderRadius: "50%",
          border: `1px solid ${anyRunning ? "rgba(130,12,12,0.07)" : "rgba(70,5,5,0.04)"}`,
          transition: "border-color 2.5s ease",
        }}
      />

      {/* Main moon arc */}
      <div
        style={{
          position: "absolute",
          bottom: "-265px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "650px",
          height: "650px",
          borderRadius: "50%",
          border: `1px solid ${moonBorder}`,
          boxShadow: moonGlow,
          transition: "border-color 2.5s ease, box-shadow 2.5s ease",
        }}
      />

      {/* Falling red lines — meteor streak: bright head + trailing tail */}
      {lines.map((line, i) => {
        const op = line.op;
        const anim = anyRunning
          ? `rr-fall ${line.dur}s ${line.delay}s infinite linear`
          : "none";
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: "-32vh",
              left: `${line.left}%`,
              width: "3px",
              height: `${line.h}vh`,
              transform: "translateX(-50%)",
              animation: anim,
              opacity: anyRunning ? 1 : 0,
              transition: "opacity 1.8s ease",
            }}
          >
            {/* Tail — 1px, fades in from top, brightens toward the head */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: "1px",
                width: "1px",
                height: "100%",
                background: `linear-gradient(to bottom,
                  transparent 0%,
                  rgba(140,10,10,${op * 0.07}) 18%,
                  rgba(180,22,22,${op * 0.28}) 52%,
                  rgba(208,38,38,${op * 0.65}) 80%,
                  rgba(224,45,45,${op * 0.88}) 100%
                )`,
              }}
            />
            {/* Head — 3px wide, bright leading point with glow */}
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: "0px",
                width: "3px",
                height: "11px",
                background: `linear-gradient(to bottom,
                  rgba(210,40,40,${op * 0.80}),
                  rgba(255,82,82,${op * 0.97}),
                  rgba(255,115,115,${op * 0.50})
                )`,
                boxShadow: `0 0 5px 1px rgba(255,72,72,${op * 0.30})`,
                borderRadius: "1px 1px 2px 2px",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ─── Logo ──────────────────────────────────────────────────────────────────*/

function RepoRunnerLogo() {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 30 30"
      fill="none"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 5px rgba(200,30,30,0.30))", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="rr-badge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e0d0d" />
          <stop offset="100%" stopColor="#0b0505" />
        </linearGradient>
        <linearGradient id="rr-border-g" x1="0" y1="0" x2="0" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="rgba(200,50,50,0.55)" />
          <stop offset="100%" stopColor="rgba(80,10,10,0.20)" />
        </linearGradient>
        <linearGradient id="rr-mark-g" x1="0" y1="7" x2="0" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#ffb0b0" />
          <stop offset="40%"  stopColor="#e03030" />
          <stop offset="100%" stopColor="#7a1010" />
        </linearGradient>
      </defs>

      {/* Badge face */}
      <rect width="30" height="30" rx="7" fill="url(#rr-badge)" />
      {/* Badge border */}
      <rect width="30" height="30" rx="7" fill="none" stroke="url(#rr-border-g)" strokeWidth="1" />
      {/* Top sheen */}
      <rect x="1.5" y="1.5" width="27" height="7" rx="5.5" fill="rgba(255,255,255,0.025)" />

      {/*
        Double-R monogram: two mirrored Rs sharing one center vertical bar.
        Left R  — bowl curves left,  leg goes down-left.
        Right R — bowl curves right, leg goes down-right.
        Center vertical bar shared by both.
      */}
      <path
        d={[
          /* shared center bar */        "M 15 7.5 L 15 22",
          /* right bowl */               "M 15 7.5 Q 22 7.5 22 11.2 Q 22 14.8 15 14.8",
          /* right leg  */               "M 15 14.8 L 22 22",
          /* left bowl  */               "M 15 7.5 Q 8 7.5 8 11.2 Q 8 14.8 15 14.8",
          /* left leg   */               "M 15 14.8 L 8 22",
        ].join(" ")}
        stroke="url(#rr-mark-g)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─── Dashboard ─────────────────────────────────────────────────────────────*/

interface DashboardProps {
  project: ProjectProfile;
  onEdit: () => void;
}

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const LABEL: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.13em",
  textTransform: "uppercase",
};

export function Dashboard({ project, onEdit }: DashboardProps) {
  const { toast } = useToast();
  const [statuses, setStatuses] = useState<ServiceStatuses>({
    frontend: "stopped",
    backend: "stopped",
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubLog = window.repoRunner.onLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    const unsubStatus = window.repoRunner.onStatus((s) => {
      setStatuses(s);
    });
    return () => { unsubLog(); unsubStatus(); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const wrapAction = (name: string, fn: () => Promise<void>) => async () => {
    setActionLoading((prev) => ({ ...prev, [name]: true }));
    try {
      await fn();
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [name]: false }));
    }
  };

  const handleCopyLogs = async () => {
    await window.repoRunner.copyLogs();
    toast({ title: "Copied", description: "Logs copied to clipboard." });
  };

  const handleClearLogs = async () => {
    await window.repoRunner.clearLogs();
    setLogs([]);
  };

  const anyRunning =
    statuses.frontend === "running" || statuses.frontend === "starting" ||
    statuses.backend  === "running" || statuses.backend  === "starting";
  const bothRunning =
    statuses.frontend === "running" && statuses.backend === "running";
  const bothStopped =
    statuses.frontend === "stopped" && statuses.backend === "stopped";

  const getStatusDisplay = (status: string) => {
    const base = "inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-[11px] font-medium";
    switch (status) {
      case "running":
        return (
          <span
            className={base}
            style={{
              background: "rgba(204,34,34,0.12)",
              color: "#e03030",
              border: "1px solid rgba(204,34,34,0.32)",
              boxShadow: "0 0 10px rgba(204,34,34,0.15)",
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-none animate-pulse"
              style={{ background: "#e03030", boxShadow: "0 0 4px rgba(224,48,48,0.9)" }}
            />
            Running
          </span>
        );
      case "starting":
        return (
          <span
            className={base}
            style={{ background: "rgba(255,159,28,0.10)", color: "#ff9f1c", border: "1px solid rgba(255,159,28,0.38)" }}
          >
            <Loader2 className="w-3 h-3 animate-spin flex-none" />
            Starting
          </span>
        );
      case "stopping":
        return (
          <span
            className={base}
            style={{ background: "rgba(255,159,28,0.07)", color: "#d48818", border: "1px solid rgba(255,159,28,0.28)" }}
          >
            <Loader2 className="w-3 h-3 animate-spin flex-none" />
            Stopping
          </span>
        );
      case "failed":
        return (
          <span
            className={base}
            style={{
              background: "rgba(224,48,48,0.14)",
              color: "#f04848",
              border: "1px solid rgba(224,48,48,0.35)",
              boxShadow: "0 0 8px rgba(224,48,48,0.12)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: "#e03030" }} />
            Failed
          </span>
        );
      case "unknown":
        return (
          <span
            className={base}
            style={{ background: "#111", color: "#4a4845", border: "1px solid #1e1e1e" }}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: "#333" }} />
            Unknown
          </span>
        );
      case "stopped":
      default:
        return (
          <span
            className={base}
            style={{ background: "#080808", color: "#2e2c2a", border: "1px solid #141414" }}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: "#1a1a1a" }} />
            Stopped
          </span>
        );
    }
  };

  const getLogSourceColor = (source: string) => {
    switch (source) {
      case "git":      return "#4a9878";
      case "install":  return "#ff9f1c";
      case "frontend": return "#cc4444";
      case "backend":  return "#5080a8";
      case "system":
      default:         return "#3a3836";
    }
  };

  const DIV = "w-px h-4 flex-none hidden sm:block";
  const DIV_STYLE = { background: "#1e1e1e" };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground animate-in fade-in duration-300 relative overflow-hidden">

      <AmbientBackground anyRunning={anyRunning} bothRunning={bothRunning} />

      {/* ── Header ── */}
      <header
        className="h-[56px] flex-none flex items-center px-5 gap-4 relative"
        style={{ borderBottom: "1px solid #161616", background: "rgba(7,7,7,0.92)" }}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-none">
          <RepoRunnerLogo />
          <span
            className="select-none leading-none"
            style={{
              fontFamily: "'Orbitron', 'Plus Jakarta Sans', sans-serif",
              fontSize: "11px",
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: "linear-gradient(160deg, #e0dcd8 0%, #a8a4a0 55%, #d4d0cc 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            RepoRunner
          </span>
        </div>

        <div className={DIV} style={DIV_STYLE} />

        {/* Project identity */}
        <div className="flex flex-col justify-center min-w-0 flex-1">
          <span
            className="text-[14px] leading-tight truncate"
            style={{ fontWeight: 600, color: "#dedad5" }}
          >
            {project.name}
          </span>
          <span
            className="text-[11px] leading-tight truncate mt-[3px]"
            style={{ ...MONO, color: "#383432" }}
            title={project.repoPath}
          >
            {project.repoPath}
          </span>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="flex-none h-8 px-3 gap-1.5 text-[12px] font-medium"
          style={{ color: "#4a4845", background: "transparent" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#9a9896"; e.currentTarget.style.background = "#111"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#4a4845"; e.currentTarget.style.background = "transparent"; }}
        >
          <Settings2 className="w-3.5 h-3.5" />
          Edit Setup
        </Button>
      </header>

      {/* ── Main content ── */}
      <div className="flex-none w-full relative">
        <div className="max-w-5xl mx-auto px-5 py-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Quick Actions */}
            <Card
              className="lg:col-span-2 rounded-xl"
              style={{
                background: "rgba(10,10,10,0.85)",
                border: "1px solid #1a1a1a",
                boxShadow: "0 4px 20px rgba(0,0,0,0.7), 0 0 0 1px rgba(204,34,34,0.03)",
              }}
            >
              <CardHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid #161616" }}>
                <CardTitle style={{ ...LABEL, color: "#3a3836" }}>
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <CommandButton
                    label="Pull Latest"
                    icon={Download}
                    onClick={wrapAction("pull", window.repoRunner.pullLatest)}
                    loading={actionLoading["pull"]}
                    variant="outline"
                  />
                  <CommandButton
                    label="Install"
                    icon={Package}
                    onClick={wrapAction("install", window.repoRunner.runInstall)}
                    loading={actionLoading["install"]}
                    variant="outline"
                  />

                  <div className={DIV} style={DIV_STYLE} />

                  <CommandButton
                    label="Start Frontend"
                    icon={Play}
                    onClick={wrapAction("startFront", window.repoRunner.startFrontend)}
                    disabled={statuses.frontend === "running" || statuses.frontend === "starting"}
                    loading={actionLoading["startFront"]}
                    variant="default"
                  />
                  <CommandButton
                    label="Start Backend"
                    icon={Server}
                    onClick={wrapAction("startBack", window.repoRunner.startBackend)}
                    disabled={statuses.backend === "running" || statuses.backend === "starting"}
                    loading={actionLoading["startBack"]}
                    variant="default"
                  />

                  <div className={DIV} style={DIV_STYLE} />

                  <CommandButton
                    label="Stop Services"
                    icon={SquareSquare}
                    onClick={wrapAction("stop", window.repoRunner.stopServices)}
                    disabled={bothStopped}
                    loading={actionLoading["stop"]}
                    variant="destructive"
                  />

                  <div className={DIV} style={DIV_STYLE} />

                  <CommandButton
                    label="Restart All"
                    icon={RotateCw}
                    onClick={wrapAction("restart", window.repoRunner.restartAll)}
                    loading={actionLoading["restart"]}
                    variant="outline"
                  />
                  <CommandButton
                    label="Open Preview"
                    icon={ExternalLink}
                    onClick={wrapAction("preview", window.repoRunner.openPreview)}
                    loading={actionLoading["preview"]}
                    variant="outline"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Services */}
            <Card
              className="rounded-xl"
              style={{
                background: "rgba(10,10,10,0.85)",
                border: "1px solid #1a1a1a",
                boxShadow: "0 4px 20px rgba(0,0,0,0.7), 0 0 0 1px rgba(204,34,34,0.03)",
              }}
            >
              <CardHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid #161616" }}>
                <CardTitle style={{ ...LABEL, color: "#3a3836" }}>
                  Services
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 flex flex-col gap-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium leading-none" style={{ color: "#7a7572" }}>
                      Frontend
                    </p>
                    {project.frontendPort && (
                      <p className="text-[11px] leading-none mt-2" style={{ ...MONO, color: "#383432" }}>
                        :{project.frontendPort}
                      </p>
                    )}
                  </div>
                  {getStatusDisplay(statuses.frontend)}
                </div>
                <Separator style={{ background: "#161616" }} />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium leading-none" style={{ color: "#7a7572" }}>
                      Backend
                    </p>
                    {project.backendPort && (
                      <p className="text-[11px] leading-none mt-2" style={{ ...MONO, color: "#383432" }}>
                        :{project.backendPort}
                      </p>
                    )}
                  </div>
                  {getStatusDisplay(statuses.backend)}
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>

      {/* ── Logs Panel ── */}
      <section
        className="flex-1 min-h-0 flex flex-col relative"
        style={{ borderTop: "1px solid #161616" }}
      >
        {/* Log toolbar */}
        <div
          className="flex-none h-[40px] flex items-center justify-between px-5"
          style={{ borderBottom: "1px solid #111", background: "rgba(6,6,6,0.92)" }}
        >
          <div className="flex items-center gap-2.5">
            <span style={{ ...LABEL, color: "#363432" }}>
              App Logs
            </span>
            <span
              className="tabular-nums leading-none"
              style={{
                ...MONO,
                fontSize: "10px",
                color: "#363432",
                background: "#0c0c0c",
                border: "1px solid #181818",
                padding: "2px 5px",
                borderRadius: "3px",
              }}
            >
              {logs.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyLogs}
              className="h-7 px-2.5 gap-1.5 text-[11px]"
              style={{ color: "#363432" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#7a7572"; e.currentTarget.style.background = "#0f0f0f"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#363432"; e.currentTarget.style.background = "transparent"; }}
            >
              <Copy className="w-3 h-3" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearLogs}
              className="h-7 px-2.5 gap-1.5 text-[11px]"
              style={{ color: "#363432" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#7a7572"; e.currentTarget.style.background = "#0f0f0f"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#363432"; e.currentTarget.style.background = "transparent"; }}
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </Button>
          </div>
        </div>

        {/* Log output */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto py-2"
          style={{ background: "#050505", ...MONO, fontSize: "12px", lineHeight: "1.7" }}
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1.5 select-none">
              <span className="italic" style={{ fontSize: "13px", color: "#363432" }}>No logs yet.</span>
              <span className="italic" style={{ fontSize: "11px", color: "#262422" }}>
                Run Pull, Install, or Start a service to see output here.
              </span>
            </div>
          ) : (
            <div>
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-3 px-3 py-[3px] rounded transition-colors"
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(204,34,34,0.03)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                >
                  <span
                    className="flex-none select-none w-[56px] text-right"
                    style={{ color: "#282624" }}
                  >
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span
                    className="flex-none w-[76px] font-medium uppercase text-[10px] tracking-wider pt-[1px]"
                    style={{ color: getLogSourceColor(log.source) }}
                  >
                    [{log.source}]
                  </span>
                  <span className="whitespace-pre-wrap break-all" style={{ color: "#706e6c" }}>
                    {log.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
