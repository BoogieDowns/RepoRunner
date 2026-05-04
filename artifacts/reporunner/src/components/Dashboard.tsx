import { useState, useEffect, useRef, useCallback } from "react";
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

interface MeteorDef {
  id:   number;
  left: number;  // % from left edge
  dur:  number;  // fall duration (seconds)
  h:    number;  // streak height (vh)
  op:   number;  // base opacity
}

/**
 * A single meteor streak.
 * Spawns at top: -32vh (above viewport), plays one full fall, then calls onDone.
 * The parent removes it from state — no orphan elements.
 */
function MeteorLine({ id, left, dur, h, op, onDone }: MeteorDef & { onDone: (id: number) => void }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "-70vh",
        left: `${left}%`,
        width: "3px",
        height: `${h}vh`,
        transform: "translateX(-50%)",
        animationName: "rr-fall",
        animationDuration: `${dur}s`,
        animationTimingFunction: "linear",
        animationIterationCount: 1,
        animationFillMode: "forwards",
      }}
      onAnimationEnd={() => onDone(id)}
    >
      {/* Tail — fades in gradually from top, brightens toward head */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "1px",
          width: "1px",
          height: "100%",
          background: `linear-gradient(to bottom,
            transparent 0%,
            rgba(140,10,10,${op * 0.03}) 10%,
            rgba(158,14,14,${op * 0.12}) 32%,
            rgba(188,24,24,${op * 0.34}) 58%,
            rgba(210,38,38,${op * 0.64}) 80%,
            rgba(224,45,45,${op * 0.88}) 100%
          )`,
        }}
      />
      {/* Head — bright leading point with glow */}
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
}

function AmbientBackground({ anyRunning, bothRunning }: { anyRunning: boolean; bothRunning: boolean }) {
  const [meteors, setMeteors]   = useState<MeteorDef[]>([]);
  const spawnerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const idRef          = useRef(0);
  const wasRunningRef  = useRef(false);
  /* Refs so the visibilitychange handler always reads the current prop values */
  const anyRunningRef  = useRef(anyRunning);
  const bothRunningRef = useRef(bothRunning);
  anyRunningRef.current  = anyRunning;
  bothRunningRef.current = bothRunning;

  /* Stable callback: removes one meteor by id after its animation ends */
  const removeMeteor = useCallback((id: number) => {
    setMeteors(prev => prev.filter(m => m.id !== id));
  }, []);

  /* Stable callback: creates one new meteor with randomised properties */
  const spawnMeteor = useCallback(() => {
    setMeteors(prev => {
      const id   = ++idRef.current;
      const left = 5   + Math.random() * 87;    // 5–92 %
      const dur  = 4.8 + Math.random() * 2.8;  // 4.8–7.6 s
      const h    = 32  + Math.random() * 26;   // 32–58 vh
      const op   = 0.28 + Math.random() * 0.36; // 0.28–0.64
      return [...prev, { id, left, dur, h, op }];
    });
  }, []);

  useEffect(() => {
    /* Clear any running spawner before reconfiguring */
    if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; }

    if (anyRunning) {
      /* Initial burst — only on first activation, not on density change */
      if (!wasRunningRef.current) {
        const count = bothRunning ? 5 : 3;
        for (let i = 0; i < count; i++) setTimeout(spawnMeteor, i * 380);
      }
      wasRunningRef.current = true;

      /* Ongoing stream: sparser for 1 service, slightly denser for 2 */
      const interval = bothRunning ? 1600 : 2600;
      spawnerRef.current = setInterval(spawnMeteor, interval);
    } else {
      wasRunningRef.current = false;
      /* No spawner — existing meteors self-remove via onAnimationEnd / removeMeteor */
    }

    return () => { if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; } };
  }, [anyRunning, bothRunning, spawnMeteor]);

  /* Pause spawning while the tab/window is hidden; restart cleanly on return.
   * Clearing the interval on hide means no timer debt accumulates, so there
   * is no burst of catch-up meteors when the user switches back. */
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        /* Tab hidden — kill spawner so no timers pile up in the background */
        if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; }
      } else {
        /* Tab visible again — restart fresh only if services are still running */
        if (anyRunningRef.current && !spawnerRef.current) {
          const interval = bothRunningRef.current ? 1600 : 2600;
          spawnerRef.current = setInterval(spawnMeteor, interval);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [spawnMeteor]);

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
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 46%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.06) 100%)",
        maskImage:        "linear-gradient(to bottom, black 0%, black 46%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.06) 100%)",
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

      {/* Dynamic meteors — each spawns above viewport, falls once, self-removes */}
      {meteors.map(m => (
        <MeteorLine key={m.id} {...m} onDone={removeMeteor} />
      ))}
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
            style={{ background: "rgba(242,184,160,0.10)", color: "#f2b8a0", border: "1px solid rgba(242,184,160,0.38)" }}
          >
            <Loader2 className="w-3 h-3 animate-spin flex-none" />
            Starting
          </span>
        );
      case "stopping":
        return (
          <span
            className={base}
            style={{ background: "rgba(242,184,160,0.07)", color: "#c8967e", border: "1px solid rgba(242,184,160,0.24)" }}
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
            style={{ background: "#080808", color: "#3c3a38", border: "1px solid #141414" }}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: "#282624" }} />
            Stopped
          </span>
        );
    }
  };

  const getLogSourceColor = (source: string) => {
    switch (source) {
      case "git":      return "#4a9878";
      case "install":  return "#f2b8a0";
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
            style={{ ...MONO, color: "#434040" }}
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
          style={{ borderBottom: "1px solid #111", background: "rgba(6,6,6,0.84)" }}
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
          style={{ background: "rgba(5,5,5,0.78)", ...MONO, fontSize: "12px", lineHeight: "1.7" }}
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1.5 select-none">
              <span className="italic" style={{ fontSize: "13px", color: "#363432" }}>No logs yet.</span>
              <span className="italic" style={{ fontSize: "11px", color: "#2e2c2a" }}>
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
                    style={{ color: "#3a3836" }}
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
