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
  Loader2
} from "lucide-react";
import { ProjectProfile, ServiceStatuses, LogEntry } from "@/types";
import { CommandButton } from "./CommandButton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

function RepoRunnerLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="flex-none">
      <rect width="28" height="28" rx="7" fill="hsl(142 70% 45% / 0.15)" stroke="hsl(142 70% 45% / 0.4)" strokeWidth="1"/>
      <path d="M9 8h5.5a3.5 3.5 0 0 1 0 7H9V8z" fill="hsl(142 70% 45%)" opacity="0.9"/>
      <path d="M9 15h4l4 5" stroke="hsl(142 70% 45%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
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
    setActionLoading(prev => ({ ...prev, [name]: true }));
    try {
      await fn();
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, [name]: false }));
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

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const getStatusDisplay = (status: string) => {
    switch (status) {
      case "running": 
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {capitalize(status)}
          </span>
        );
      case "starting":
      case "stopping":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs font-medium border border-amber-500/20">
            <Loader2 className="w-3 h-3 animate-spin" />
            {capitalize(status)}
          </span>
        );
      case "failed": 
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-xs font-medium border border-red-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            {capitalize(status)}
          </span>
        );
      case "unknown":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 text-xs font-medium border border-purple-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
            {capitalize(status)}
          </span>
        );
      case "stopped": 
      default: 
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 text-xs font-medium border border-zinc-700">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            {capitalize(status || "stopped")}
          </span>
        );
    }
  };

  const getLogColor = (source: string) => {
    switch (source) {
      case "git": return "text-cyan-400";
      case "install": return "text-yellow-400";
      case "frontend": return "text-emerald-400";
      case "backend": return "text-blue-400";
      case "system": default: return "text-muted-foreground";
    }
  };

  const bothRunning = statuses.frontend === "running" && statuses.backend === "running";
  const bothStopped = statuses.frontend === "stopped" && statuses.backend === "stopped";

  return (
    <div className="h-screen flex flex-col bg-background text-foreground animate-in fade-in duration-500">
      {/* Header Bar */}
      <header className="h-[60px] flex-none border-b border-border bg-card/60 backdrop-blur flex items-center px-6">
        <div className="flex items-center gap-4 flex-1">
          <div className="flex items-center gap-2">
            <RepoRunnerLogo />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">RepoRunner</span>
          </div>
          
          <div className="w-px h-6 bg-border mx-2" />
          
          <div className="flex items-baseline gap-3">
            <h1 className="text-base font-bold text-white">{project.name}</h1>
            <span className="text-xs text-muted-foreground font-mono truncate max-w-[40ch]" title={project.repoPath}>
              {project.repoPath}
            </span>
          </div>
        </div>

        <div className="flex-none flex items-center gap-4">
          <div className="flex items-center gap-2">
            {getStatusDisplay(statuses.frontend)}
            {getStatusDisplay(statuses.backend)}
          </div>
          <Button variant="ghost" size="sm" onClick={onEdit} className="text-muted-foreground h-8 px-2 hover:text-foreground">
            <Settings2 className="w-4 h-4 mr-1.5" />
            Edit Setup
          </Button>
        </div>
      </header>

      {/* Main Content - Scrollable */}
      <div className="flex-none overflow-y-auto w-full">
        <div className="max-w-5xl mx-auto p-6 space-y-6">
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Quick Actions Card */}
            <Card className="lg:col-span-2 border border-border bg-card shadow-sm rounded-xl">
              <CardHeader className="py-4 border-b border-border/60">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="p-4 sm:p-6">
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
                  
                  <div className="w-px h-6 bg-border/60 mx-1 hidden sm:block" />
                  
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
                  
                  <div className="w-px h-6 bg-border/60 mx-1 hidden sm:block" />
                  
                  <CommandButton
                    label="Stop Services"
                    icon={SquareSquare}
                    onClick={wrapAction("stop", window.repoRunner.stopServices)}
                    disabled={bothStopped}
                    loading={actionLoading["stop"]}
                    variant="destructive"
                  />
                  
                  <div className="w-px h-6 bg-border/60 mx-1 hidden sm:block" />
                  
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

            {/* Status Card */}
            <Card className="border border-border bg-card shadow-sm rounded-xl">
              <CardHeader className="py-4 border-b border-border/60">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Services</CardTitle>
              </CardHeader>
              <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Frontend</span>
                    {project.frontendPort && (
                      <span className="text-xs font-mono text-muted-foreground/60 mt-0.5">Port {project.frontendPort}</span>
                    )}
                  </div>
                  {getStatusDisplay(statuses.frontend)}
                </div>
                <Separator className="bg-border/60" />
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Backend</span>
                    {project.backendPort && (
                      <span className="text-xs font-mono text-muted-foreground/60 mt-0.5">Port {project.backendPort}</span>
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
      <section className="flex-1 min-h-0 flex flex-col bg-black/60 border-t border-border">
        <div className="flex-none h-10 flex items-center justify-between px-4 border-b border-border/30 bg-card/40">
          <div className="flex items-center gap-3">
            <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">App Logs</h2>
            <span className="text-[10px] bg-white/5 px-1.5 py-0.5 rounded text-muted-foreground">{logs.length}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCopyLogs} className="h-7 text-xs text-muted-foreground hover:text-foreground">
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearLogs} className="h-7 text-xs text-muted-foreground hover:text-foreground">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Clear
            </Button>
          </div>
        </div>
        
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 bg-black/40 font-mono text-[12.5px] leading-relaxed break-all"
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground/40 italic gap-1 text-[13px]">
              <span>No logs yet.</span>
              <span>Run Pull, Install, or Start a service to see output here.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3 hover:bg-white/[0.025] px-2 py-0.5 rounded transition-colors group">
                  <span className="text-muted-foreground/40 flex-none select-none w-[64px]">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`font-semibold flex-none w-[80px] uppercase text-[11.5px] tracking-wider pt-0.5 ${getLogColor(log.source)}`}>
                    [{log.source}]
                  </span>
                  <span className="text-foreground/85 whitespace-pre-wrap">{log.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
