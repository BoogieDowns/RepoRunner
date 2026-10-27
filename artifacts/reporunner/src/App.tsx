import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { CredentialSettingsDialog } from "@/components/CredentialSettingsDialog";
import { getCredentialApi } from "@/lib/credentialSettings";
import { getAiConfigStatusApi } from "@/lib/aiConfigStatus";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installMock } from "@/mock/repoRunnerMock";
import { ProjectProfilesState, ProjectStoreStatus, ServiceStatuses } from "@/types";
import { SetupScreen } from "@/components/SetupScreen";
import { Dashboard } from "@/components/Dashboard";
import {
  displayErrorMessage,
  isStoreBlocked,
  readStoreForDisplay,
  recoveryRevision,
  runStoreMutation,
  type ProjectStoreNoticeAction,
} from "@/lib/projectStoreRecovery";

const isElectronRuntime =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

if (typeof window !== "undefined" && !window.repoRunner && !isElectronRuntime) {
  installMock();
}

const EMPTY_PROJECT_STATE: ProjectProfilesState = {
  profiles: [],
  activeProfileId: null,
};

const SWITCH_BLOCKED_MESSAGE =
  "RepoRunner can run one saved repo at a time. Stop the current repo before switching saved setups.";

function App() {
  const [projectState, setProjectState] =
    useState<ProjectProfilesState>(EMPTY_PROJECT_STATE);
  const [statuses, setStatuses] = useState<ServiceStatuses>({
    frontend: "unknown",
    backend: "unknown",
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editClosing, setEditClosing] = useState(false);
  const [showSetup, setShowSetup] = useState(true);
  const [loading, setLoading] = useState(true);
  const [storeStatus, setStoreStatus] = useState<ProjectStoreStatus | null>(null);
  const [storeActionError, setStoreActionError] = useState<string | null>(null);

  // Internal credential Settings (Stage 4C): null unless this launch's preload
  // provides the credential methods, so packaged builds never show it.
  const credentialApi = useMemo(() => getCredentialApi(window.repoRunner), []);
  // Read only when the Settings dialog opens; never at startup.
  const aiStatusApi = useMemo(() => getAiConfigStatusApi(window.repoRunner), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => {
    settingsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    // Back to the Settings button once the dialog is gone.
    setTimeout(() => settingsTrigger.current?.focus(), 0);
  }, []);
  const settingsDialog = credentialApi && settingsOpen ? <CredentialSettingsDialog api={credentialApi} aiStatusApi={aiStatusApi} onClose={closeSettings} /> : null;

  /**
   * Re-reads the saved-setups status and, when the file is usable, the saved
   * setups. A blocked file never replaces what is shown with an empty list.
   * Only reads; recovery actions run solely from handleStoreAction.
   */
  const refreshStore = useCallback(async () => {
    const { status, state } = await readStoreForDisplay(window.repoRunner);
    setStoreStatus(status);
    if (state) setProjectState(state);
    return { status, state };
  }, []);

  const refreshStoreStatus = useCallback(async () => {
    try {
      setStoreStatus(await window.repoRunner.getProjectStoreStatus());
    } catch (err) {
      console.error("Failed to read saved setups status:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Status and setups are read before the first render so a damaged file
      // is never shown as an empty first launch.
      const { status, state } = await readStoreForDisplay(window.repoRunner);
      if (!cancelled) {
        setStoreStatus(status);
        if (state) setProjectState(state);
      }

      try {
        const loadedStatuses = await window.repoRunner.getStatuses();
        if (!cancelled) {
          setStatuses(loadedStatuses);
        }
      } catch (err) {
        console.error("Failed to load service statuses:", err);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    const unsubscribe = window.repoRunner.onStatus(setStatuses);
    load();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const activeProject =
    projectState.profiles.find(
      (profile) => profile.id === projectState.activeProfileId
    ) ?? null;
  const servicesBusy =
    statuses.frontend !== "stopped" || statuses.backend !== "stopped";

  const ensureServicesStopped = () => {
    if (servicesBusy) {
      throw new Error(SWITCH_BLOCKED_MESSAGE);
    }
  };

  const handleSelectProfile = async (profileId: string) => {
    ensureServicesStopped();
    const nextState = await runStoreMutation(
      () => window.repoRunner.setActiveProject(profileId, projectState.revision),
      refreshStore,
    );
    setProjectState(nextState);
    void refreshStoreStatus();
  };

  const handleDeleteProfile = async (profileId: string) => {
    ensureServicesStopped();
    const nextState = await runStoreMutation(
      () => window.repoRunner.deleteProject(profileId, projectState.revision),
      refreshStore,
    );
    setProjectState(nextState);
    void refreshStoreStatus();
    // Close edit overlay when deleting the active profile (edit modal flow)
    if (!nextState.activeProfileId) {
      setIsEditing(false);
    }
    // If there are no saved profiles left and the full-screen setup overlay
    // is open (showSetup), close it so the dashboard shell (with pulse)
    // becomes visible immediately.
    if ((nextState.profiles ?? []).length === 0) {
      setShowSetup(false);
    }
  };

  const handleStoreAction = async (action: ProjectStoreNoticeAction) => {
    setStoreActionError(null);

    if (action === "reveal") {
      try {
        await window.repoRunner.revealProjectStoreFile();
      } catch {
        setStoreActionError("RepoRunner couldn't show the saved setups file location.");
      }
      return;
    }

    const status = storeStatus;
    if (!status) return;

    try {
      await window.repoRunner.resolveProjectStoreIssue(action, recoveryRevision(action, status));
    } catch (err) {
      setStoreActionError(displayErrorMessage(err, "The recovery action didn't complete."));
    }
    // Always show the file as it is now, whether the action worked or not.
    const { state } = await refreshStore();
    if (state && !state.profiles.some((profile) => profile.id === state.activeProfileId)) {
      setShowSetup(true);
    }
  };

  const handleSaved = (nextState: ProjectProfilesState) => {
    setProjectState(nextState);
    void refreshStoreStatus();
  };

  const storeProps = {
    revision: projectState.revision,
    storeStatus,
    storeActionError,
    onStoreAction: handleStoreAction,
    onStoreError: refreshStore,
  };

  const handleEditOpen = () => {
    setEditClosing(false);
    setIsEditing(true);
    // Pick up problems that appeared since startup (read-only check).
    void refreshStoreStatus();
  };

  const handleEditClose = () => {
    setEditClosing(true);
    setTimeout(() => {
      setIsEditing(false);
      setEditClosing(false);
    }, 230);
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
        <div className="text-center text-muted-foreground animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!activeProject) {
    const placeholderProject = {
      id: "",
      name: "No repo selected",
      repoPath: "",
      installCommand: "",
      frontendCommand: "",
      backendCommand: "",
      previewUrl: "",
      frontendPort: undefined,
      backendPort: undefined,
    };

    return (
      <TooltipProvider>
        <div className="min-h-screen w-full bg-background text-foreground font-sans relative">
          <Dashboard
            project={placeholderProject}
            onEdit={() => setShowSetup(true)}
            controlsDisabled={true}
            showNoRepoPulse={projectState.profiles.length === 0 && !isStoreBlocked(storeStatus)}
            showPlaceholderProjectName={true}
            onOpenSettings={credentialApi ? openSettings : undefined}
          />
          {settingsDialog}

          {showSetup && (
            <>
              <div
                className="fixed inset-0 z-40"
                style={{
                  background: "rgba(0,0,0,0.45)",
                  backdropFilter: "blur(2px)",
                  WebkitBackdropFilter: "blur(2px)",
                }}
                onClick={() => setShowSetup(false)}
                aria-hidden="true"
              />
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 pointer-events-none">
                <div className="pointer-events-auto w-full max-w-4xl max-h-full overflow-y-auto rounded-xl">
                  <SetupScreen
                    overlay
                    profiles={projectState.profiles}
                    activeProfileId={projectState.activeProfileId}
                    activeProject={activeProject}
                    servicesBusy={servicesBusy}
                    onSave={(nextState) => {
                      handleSaved(nextState);
                      setShowSetup(false);
                    }}
                    onSelectProfile={handleSelectProfile}
                    onDeleteProfile={handleDeleteProfile}
                    onClose={() => setShowSetup(false)}
                    {...storeProps}
                  />
                </div>
              </div>
            </>
          )}
        </div>
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-background text-foreground font-sans relative">
        <Dashboard project={activeProject} onEdit={handleEditOpen} onOpenSettings={credentialApi ? openSettings : undefined} />
        {settingsDialog}

        {isEditing && (
          <>
            {/* Scrim */}
            <div
              className="fixed inset-0 z-40"
              style={{
                background: "rgba(0,0,0,0.45)",
                backdropFilter: "blur(2px)",
                WebkitBackdropFilter: "blur(2px)",
                animation: editClosing
                  ? "rr-scrim-out 0.16s ease forwards"
                  : "rr-scrim-in 0.20s ease forwards",
              }}
              onClick={handleEditClose}
              aria-hidden="true"
            />
            {/* Modal */}
            <div
              className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 pointer-events-none"
              style={{
                animation: editClosing
                  ? "rr-modal-out 0.15s cubic-bezier(0.4,0,0.6,1) forwards"
                  : "rr-modal-in 0.18s cubic-bezier(0.16,1,0.3,1) forwards",
              }}
            >
              <div className="pointer-events-auto w-full max-w-4xl max-h-full overflow-y-auto rounded-xl">
                <SetupScreen
                  overlay
                  profiles={projectState.profiles}
                  activeProfileId={projectState.activeProfileId}
                  activeProject={activeProject}
                  servicesBusy={servicesBusy}
                  onSave={(nextState) => {
                    handleSaved(nextState);
                    setIsEditing(false);
                  }}
                  onSelectProfile={handleSelectProfile}
                  onDeleteProfile={handleDeleteProfile}
                  onClose={handleEditClose}
                  {...storeProps}
                />
              </div>
            </div>
          </>
        )}
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
