export type ServiceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "unknown";

export type LogSource =
  | "system"
  | "git"
  | "install"
  | "frontend"
  | "backend";

export interface LogEntry {
  id: string;
  timestamp: number;
  source: LogSource;
  text: string;
}

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

export const MAX_FREE_REPO_PROFILES = 5;

export interface ProjectProfilesState {
  profiles: ProjectProfile[];
  activeProfileId: string | null;
}

export interface ServiceStatuses {
  frontend: ServiceStatus;
  backend: ServiceStatus;
}

export interface RepoRunnerAPI {
  selectFolder(): Promise<string | null>;
  loadProjectState(): Promise<ProjectProfilesState>;
  saveProject(profile: ProjectProfile): Promise<ProjectProfilesState>;
  loadProject(): Promise<ProjectProfile | null>;
  setActiveProject(profileId: string): Promise<ProjectProfilesState>;
  deleteProject(profileId: string): Promise<ProjectProfilesState>;
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
  getStatuses(): Promise<ServiceStatuses>;
  onStatus(callback: (statuses: ServiceStatuses) => void): () => void;
}

declare global {
  interface Window {
    repoRunner: RepoRunnerAPI;
  }
}

