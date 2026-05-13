import { useState, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installMock } from "@/mock/repoRunnerMock";
import { ProjectProfile } from "@/types";
import { SetupScreen } from "@/components/SetupScreen";
import { Dashboard } from "@/components/Dashboard";

if (typeof window !== "undefined" && !window.repoRunner) {
  installMock();
}

function App() {
  const [project, setProject] = useState<ProjectProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editClosing, setEditClosing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const loaded = await window.repoRunner.loadProject();
        setProject(loaded);
      } catch (err) {
        console.error("Failed to load project:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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

  if (!project) {
    return (
      <TooltipProvider>
        <div className="min-h-screen w-full bg-background text-foreground font-sans">
          <SetupScreen onSave={(profile) => setProject(profile)} />
        </div>
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-background text-foreground font-sans relative">
        <Dashboard project={project} onEdit={handleEditOpen} />

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
                  onSave={(profile) => { setProject(profile); setIsEditing(false); }}
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
