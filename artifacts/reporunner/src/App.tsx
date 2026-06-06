import { useState, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installMock } from "@/mock/repoRunnerMock";
import { ProjectProfilesState, ServiceStatuses } from "@/types";
import { SetupScreen } from "@/components/SetupScreen";
import { Dashboard } from "@/components/Dashboard";

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const loaded = await window.repoRunner.loadProjectState();
        if (!cancelled) {
          setProjectState(loaded);
        }
      } catch (err) {
        console.error("Failed to load project state:", err);
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
    const nextState = await window.repoRunner.setActiveProject(profileId);
    setProjectState(nextState);
  };

  const handleDeleteProfile = async (profileId: string) => {
    ensureServicesStopped();
    const nextState = await window.repoRunner.deleteProject(profileId);
    setProjectState(nextState);
    if (!nextState.activeProfileId) {
      setIsEditing(false);
    }
  };

  const handleEditOpen = () => {
    setEditClosing(false);
    setIsEditing(true);
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
    return (
      <TooltipProvider>
        <div className="min-h-screen w-full bg-background text-foreground font-sans">
          <SetupScreen
            profiles={projectState.profiles}
            activeProfileId={projectState.activeProfileId}
            activeProject={activeProject}
            servicesBusy={servicesBusy}
            onSave={(nextState) => {
              setProjectState(nextState);
              setIsEditing(false);
            }}
            onSelectProfile={handleSelectProfile}
            onDeleteProfile={handleDeleteProfile}
          />
        </div>
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-background text-foreground font-sans relative">
        <Dashboard project={activeProject} onEdit={handleEditOpen} />

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
              <div className="pointer-events-auto w-full max-w-4xl">
                <SetupScreen
                  overlay
                  profiles={projectState.profiles}
                  activeProfileId={projectState.activeProfileId}
                  activeProject={activeProject}
                  servicesBusy={servicesBusy}
                  onSave={(nextState) => {
                    setProjectState(nextState);
                    setIsEditing(false);
                  }}
                  onSelectProfile={handleSelectProfile}
                  onDeleteProfile={handleDeleteProfile}
                  onClose={handleEditClose}
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
