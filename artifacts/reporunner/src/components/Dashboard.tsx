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

function RepoRunnerLogo() {
  return (
    <svg
      width="27"
      height="27"
      viewBox="0 0 28 28"
      fill="none"
      className="flex-none [filter:drop-shadow(0_0_6px_rgba(30,255,90,0.28))]"
    >
      <rect
        width="28"
        height="28"
        rx="7"
        fill="hsl(142 100% 56% / 0.12)"
        stroke="hsl(142 100% 56% / 0.45)"
        strokeWidth="1"
      />
      <path
        d="M9 8h5.5a3.5 3.5 0 0 1 0 7H9V8z"
        fill="hsl(142 100% 56%)"
        opacity="0.95"
      />
      <path
        d="M9 15h4l4 5"
        stroke="hsl(142 100% 56%)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface DashboardProps {
  project: ProjectProfile;
  onEdit: () => void;
}

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
    return () => {
      unsubLog();
      unsubStatus();
    };
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

  const getStatusDisplay = (status: string) => {
    switch (status) {
      case "running":
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#1EFF5A]/[0.12] text-[#1EFF5A] border border-[#1EFF5A]/30
              shadow-[0_0_10px_rgba(30,255,90,0.15)]"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#1EFF5A] animate-pulse flex-none shadow-[0_0_4px_rgba(30,255,90,0.8)]" />
            Running
          </span>
        );
      case "starting":
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#c6a84a]/[0.12] text-[#d4b558] border border-[#c6a84a]/25"
          >
            <Loader2 className="w-3 h-3 animate-spin flex-none" />
            Starting
          </span>
        );
      case "stopping":
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#c6a84a]/[0.08] text-[#c6a84a]/90 border border-[#c6a84a]/20"
          >
            <Loader2 className="w-3 h-3 animate-spin flex-none" />
            Stopping
          </span>
        );
      case "failed":
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#c94b57]/[0.12] text-[#e05e6a] border border-[#c94b57]/25
              shadow-[0_0_8px_rgba(201,75,87,0.1)]"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#c94b57] flex-none" />
            Failed
          </span>
        );
      case "unknown":
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#7FA18B]/[0.08] text-[#7FA18B]/70 border border-[#7FA18B]/15"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#7FA18B]/50 flex-none" />
            Unknown
          </span>
        );
      case "stopped":
      default:
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-full leading-none text-xs font-medium
              bg-[#080e0b] text-[#3a5243] border border-[#122019]"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#1e3429] flex-none" />
            Stopped
          </span>
        );
    }
  };

  const getLogSourceColor = (source: string) => {
    switch (source) {
      case "git":      return "text-cyan-400/75";
      case "install":  return "text-[#c6a84a]/90";
      case "frontend": return "text-[#1EFF5A]/85";
      case "backend":  return "text-blue-400/75";
      case "system":
      default:         return "text-[#4a6655]";
    }
  };

  const bothStopped =
    statuses.frontend === "stopped" && statuses.backend === "stopped";

  return (
    <div className="h-screen flex flex-col bg-background text-foreground animate-in fade-in duration-300">

      {/* Header */}
      <header className="h-[60px] flex-none border-b border-[#173126] bg-[#080e0b] flex items-center px-5 gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-none">
          <RepoRunnerLogo />
          <span className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[#3d6050] select-none">
            RepoRunner
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-[#173126] flex-none" />

        {/* Project identity */}
        <div className="flex flex-col justify-center min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-[#B8FFCA] leading-tight truncate">
            {project.name}
          </span>
          <span
            className="text-[11px] font-mono text-[#3d6050] leading-tight truncate mt-px"
            title={project.repoPath}
          >
            {project.repoPath}
          </span>
        </div>

        {/* Edit Setup */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="flex-none h-8 px-3 gap-1.5 text-xs text-[#4a6655] hover:text-[#7FA18B] hover:bg-[#0f1a14]"
        >
          <Settings2 className="w-3.5 h-3.5" />
          Edit Setup
        </Button>
      </header>

      {/* Main Content */}
      <div className="flex-none overflow-y-auto w-full">
        <div className="max-w-5xl mx-auto px-5 py-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Quick Actions */}
            <Card
              className="lg:col-span-2 rounded-xl border border-[#173126] bg-[#0a1510]"
              style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(30,255,90,0.04)" }}
            >
              <CardHeader className="px-5 pt-4 pb-3 border-b border-[#173126]/70">
                <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#3d6050]">
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

                  <div className="w-px h-5 bg-[#173126] mx-0.5 hidden sm:block" />

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

                  <div className="w-px h-5 bg-[#173126] mx-0.5 hidden sm:block" />

                  <CommandButton
                    label="Stop Services"
                    icon={SquareSquare}
                    onClick={wrapAction("stop", window.repoRunner.stopServices)}
                    disabled={bothStopped}
                    loading={actionLoading["stop"]}
                    variant="destructive"
                  />

                  <div className="w-px h-5 bg-[#173126] mx-0.5 hidden sm:block" />

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
              className="rounded-xl border border-[#173126] bg-[#0a1510]"
              style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(30,255,90,0.04)" }}
            >
              <CardHeader className="px-5 pt-4 pb-3 border-b border-[#173126]/70">
                <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#3d6050]">
                  Services
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 flex flex-col gap-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-semibold text-[#7FA18B] leading-none tracking-wide">
                      Frontend
                    </p>
                    {project.frontendPort && (
                      <p className="text-[11px] font-mono text-[#3d6050] mt-1.5 leading-none">
                        port {project.frontendPort}
                      </p>
                    )}
                  </div>
                  {getStatusDisplay(statuses.frontend)}
                </div>
                <Separator className="bg-[#173126]/50" />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-semibold text-[#7FA18B] leading-none tracking-wide">
                      Backend
                    </p>
                    {project.backendPort && (
                      <p className="text-[11px] font-mono text-[#3d6050] mt-1.5 leading-none">
                        port {project.backendPort}
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

      {/* Logs Panel */}
      <section className="flex-1 min-h-0 flex flex-col border-t border-[#173126]">
        {/* Log toolbar */}
        <div className="flex-none h-[42px] flex items-center justify-between px-5 border-b border-[#173126]/50 bg-[#080e0b]">
          <div className="flex items-center gap-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#3d6050]">
              App Logs
            </span>
            <span className="text-[10px] bg-[#0f1a14] border border-[#173126]/60 px-1.5 py-0.5 rounded text-[#3d6050] tabular-nums leading-none">
              {logs.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyLogs}
              className="h-7 px-2.5 gap-1.5 text-[11px] text-[#3d6050] hover:text-[#7FA18B] hover:bg-[#0f1a14]"
            >
              <Copy className="w-3 h-3" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearLogs}
              className="h-7 px-2.5 gap-1.5 text-[11px] text-[#3d6050] hover:text-[#7FA18B] hover:bg-[#0f1a14]"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </Button>
          </div>
        </div>

        {/* Log output */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 py-3 bg-[#040805] font-mono text-[12px] leading-relaxed"
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1.5 select-none">
              <span className="text-[13px] text-[#3a6048] italic">No logs yet.</span>
              <span className="text-[11px] text-[#2a4a38] italic">
                Run Pull, Install, or Start a service to see output here.
              </span>
            </div>
          ) : (
            <div>
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-3 hover:bg-[#1EFF5A]/[0.025] px-2 py-[3px] rounded transition-colors"
                >
                  <span className="flex-none select-none text-[#253d2e] w-[56px] text-right">
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span
                    className={`flex-none w-[72px] font-semibold uppercase text-[10.5px] tracking-wide ${getLogSourceColor(log.source)}`}
                  >
                    [{log.source}]
                  </span>
                  <span className="text-[#7FA18B] whitespace-pre-wrap break-all">
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
