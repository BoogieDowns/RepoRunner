import { useState, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installMock } from "@/mock/repoRunnerMock";
import { ProjectProfile } from "@/types";
import { SetupScreen } from "@/components/SetupScreen";
import { Dashboard } from "@/components/Dashboard";

// Install browser mock for preview
if (typeof window !== "undefined" && !window.repoRunner) {
  installMock();
}

function App() {
  const [project, setProject] = useState<ProjectProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
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

  if (loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
        <div className="text-center text-muted-foreground animate-pulse">Loading...</div>
      </div>
    );
  }

  const showSetup = !project || isEditing;

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground">
        {showSetup ? (
          <SetupScreen
            onSave={(profile) => { setProject(profile); setIsEditing(false); }}
            onClose={isEditing ? () => setIsEditing(false) : undefined}
          />
        ) : (
          <Dashboard project={project!} onEdit={() => setIsEditing(true)} />
        )}
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
