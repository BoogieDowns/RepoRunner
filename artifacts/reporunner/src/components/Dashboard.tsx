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
  Settings2
} from "lucide-react";
import { ProjectProfile, ServiceStatuses, LogEntry } from "@/types";
import { CommandButton } from "./CommandButton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

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

  const getStatusColor = (status: string) => {
    switch (status) {
      case "running": return "bg-green-500/10 text-green-500 border-green-500/20";
      case "starting": return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
      case "stopping": return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
      case "failed": return "bg-red-500/10 text-red-500 border-red-500/20";
      case "stopped": default: return "bg-muted text-muted-foreground border-border";
    }
  };

  const getLogColor = (source: string) => {
    switch (source) {
      case "git": return "text-cyan-400";
      case "install": return "text-yellow-400";
      case "frontend": return "text-green-400";
      case "backend": return "text-blue-400";
      case "system": default: return "text-muted-foreground";
    }
  };

  const bothRunning = statuses.frontend === "running" && statuses.backend === "running";
  const bothStopped = statuses.frontend === "stopped" && statuses.backend === "stopped";

  return (
    <div className="h-screen flex flex-col animate-in fade-in duration-500">
      <header className="h-20 flex-none border-b border-border/40 bg-card/50 backdrop-blur px-6 flex items-center justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">{project.name}</h1>
            <div className="flex gap-2">
              <Badge variant="outline" className={`font-mono text-xs px-2 py-0.5 ${getStatusColor(statuses.frontend)}`}>
                Frontend: {statuses.frontend}
              </Badge>
              <Badge variant="outline" className={`font-mono text-xs px-2 py-0.5 ${getStatusColor(statuses.backend)}`}>
                Backend: {statuses.backend}
              </Badge>
            </div>
          </div>
          <span className="text-xs text-muted-foreground font-mono mt-1 truncate max-w-[400px]">
            {project.repoPath}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mr-2">
            RepoRunner
          </span>
          <Button variant="ghost" size="sm" onClick={onEdit} className="text-muted-foreground">
            <Settings2 className="w-4 h-4 mr-2" />
            Edit Setup
          </Button>
        </div>
      </header>

      <main className="flex-none p-6 pb-2 border-b border-border/40 bg-background/50">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-5xl mx-auto">
          <CommandButton
            label="Pull Latest"
            icon={Download}
            onClick={wrapAction("pull", window.repoRunner.pullLatest)}
            loading={actionLoading["pull"]}
            variant="secondary"
          />
          <CommandButton
            label="Install"
            icon={Package}
            onClick={wrapAction("install", window.repoRunner.runInstall)}
            loading={actionLoading["install"]}
            variant="secondary"
          />
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
          <CommandButton
            label="Stop Services"
            icon={SquareSquare}
            onClick={wrapAction("stop", window.repoRunner.stopServices)}
            disabled={bothStopped}
            loading={actionLoading["stop"]}
            variant="destructive"
          />
          <CommandButton
            label="Restart All"
            icon={RotateCw}
            onClick={wrapAction("restart", window.repoRunner.restartAll)}
            loading={actionLoading["restart"]}
            variant="secondary"
          />
          <CommandButton
            label="Open Preview"
            icon={ExternalLink}
            onClick={wrapAction("preview", window.repoRunner.openPreview)}
            loading={actionLoading["preview"]}
            variant="secondary"
          />
        </div>
      </main>

      <section className="flex-1 min-h-0 flex flex-col bg-black/60">
        <div className="flex-none h-12 flex items-center justify-between px-6 border-b border-border/20">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">App Logs</h2>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCopyLogs} className="h-8 text-xs text-muted-foreground hover:text-foreground">
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearLogs} className="h-8 text-xs text-muted-foreground hover:text-foreground">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Clear
            </Button>
          </div>
        </div>
        
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 sm:p-6 font-mono text-[13px] leading-relaxed break-all"
        >
          {logs.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground/40 italic">
              No logs to display
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                  <span className="text-muted-foreground/40 flex-none select-none w-[60px]">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`font-semibold flex-none w-[80px] uppercase text-[11px] tracking-wider pt-0.5 ${getLogColor(log.source)}`}>
                    [{log.source}]
                  </span>
                  <span className="text-foreground/90 whitespace-pre-wrap">{log.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
