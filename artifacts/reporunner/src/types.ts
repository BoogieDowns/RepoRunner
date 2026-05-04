export type ServiceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "unknown";

export type LogSource = "system" | "git" | "install" | "frontend" | "backend";

export type AppPhase = "landing" | "scanning" | "analysis" | "running";

export type ReadinessStatus = "ready" | "missing-input" | "warning" | "blocked";

export interface LogEntry {
  id: string;
  timestamp: number;
  source: LogSource;
  level?: "info" | "warn" | "error";
  text: string;
}

export interface ServiceStatuses {
  frontend: ServiceStatus;
  backend: ServiceStatus;
}

export interface ScanStep {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
}

export interface EnvVar {
  name: string;
  required: boolean;
  hasValue: boolean;
  description?: string;
}

export interface RunPlan {
  repoUrl: string;
  projectName: string;
  framework: string;
  packageManager: string;
  installCommand: string;
  startCommand: string;
  port: number;
  branch: string;
  runtime: string;
  envVars: EnvVar[];
  readiness: ReadinessStatus;
}

// Legacy types kept for Electron IPC compatibility
export interface ProjectProfile {
  id: string;
  name: string;
  repoPath: string;
  installCommand: string;
  frontendCommand: string;
  backendCommand: string;
  previewUrl: string;
  frontendPort?: number;
  backendPort?: number;
}

export interface RepoRunnerAPI {
  // New GitHub-based flow
  analyzeRepo(url: string, onStep: (step: ScanStep) => void): Promise<RunPlan>;
  launchPreview(): Promise<void>;
  stopPreview(): Promise<void>;

  // Legacy local-project methods (Electron IPC)
  selectFolder(): Promise<string | null>;
  saveProject(profile: ProjectProfile): Promise<void>;
  loadProject(): Promise<ProjectProfile | null>;
  pullLatest(): Promise<void>;
  runInstall(): Promise<void>;
  startFrontend(): Promise<void>;
  startBackend(): Promise<void>;
  stopServices(): Promise<void>;
  restartAll(): Promise<void>;
  openPreview(): Promise<void>;
  copyLogs(): Promise<void>;
  clearLogs(): Promise<void>;
  onLog(callback: (entry: LogEntry) => void): () => void;
  onStatus(callback: (statuses: ServiceStatuses) => void): () => void;
}

declare global {
  interface Window {
    repoRunner: RepoRunnerAPI;
  }
}
