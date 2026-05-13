import { useEffect, useState } from "react";
import * as z from "zod";
import { Folder, Save, ArrowRight, X } from "lucide-react";
import { ProjectProfile } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type SetupFormState = {
  name: string;
  repoPath: string;
  installCommand: string;
  frontendCommand: string;
  backendCommand: string;
  previewUrl: string;
  frontendPort: string;
  backendPort: string;
};

const setupSchema = z.object({
  name: z.string().trim().min(1, "Project name is required"),
  repoPath: z.string().trim().min(1, "Repository path is required"),
  installCommand: z.string().trim().min(1, "Install command is required"),
  frontendCommand: z.string().trim().min(1, "Frontend command is required"),
  backendCommand: z.string().trim().min(1, "Backend command is required"),
  previewUrl: z.string().trim().url("Must be a valid URL"),
  frontendPort: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || isValidPort(value),
      "Must be a valid port",
    ),
  backendPort: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || isValidPort(value),
      "Must be a valid port",
    ),
});

type SetupErrors = Partial<Record<keyof SetupFormState, string>>;

const defaultFormValues: SetupFormState = {
  name: "",
  repoPath: "",
  installCommand: "npm install",
  frontendCommand: "npm run dev",
  backendCommand: "npm start",
  previewUrl: "http://localhost:3000",
  frontendPort: "3000",
  backendPort: "3001",
};

function isValidPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function projectToFormValues(project?: ProjectProfile | null): SetupFormState {
  if (!project) return defaultFormValues;

  return {
    name: project.name,
    repoPath: project.repoPath,
    installCommand: project.installCommand,
    frontendCommand: project.frontendCommand,
    backendCommand: project.backendCommand,
    previewUrl: project.previewUrl,
    frontendPort: project.frontendPort?.toString() ?? "",
    backendPort: project.backendPort?.toString() ?? "",
  };
}

function formValuesToProfile(
  data: SetupFormState,
  existingId?: string,
): ProjectProfile {
  return {
    id: existingId ?? crypto.randomUUID(),
    name: data.name.trim(),
    repoPath: data.repoPath.trim(),
    installCommand: data.installCommand.trim(),
    frontendCommand: data.frontendCommand.trim(),
    backendCommand: data.backendCommand.trim(),
    previewUrl: data.previewUrl.trim(),
    frontendPort: data.frontendPort.trim()
      ? Number(data.frontendPort)
      : undefined,
    backendPort: data.backendPort.trim()
      ? Number(data.backendPort)
      : undefined,
  };
}

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

const inputStyle: React.CSSProperties = {
  background: "#060606",
  border: "1px solid #252220",
  color: "#dedad5",
  height: "40px",
};

const inputClassName =
  "focus-visible:ring-[#b90e1c]/20 focus-visible:border-[#b90e1c]/40 " +
  "focus-visible:shadow-[0_0_10px_rgba(185,14,28,0.10)] transition-shadow placeholder:text-[#3e3c3a]";

const labelStyle: React.CSSProperties = {
  color: "#858280",
  fontSize: "11px",
  letterSpacing: "0.04em",
};

export function SetupScreen({
  onSave,
  onClose,
  overlay = false,
  initialProfile = null,
}: {
  onSave: (profile: ProjectProfile) => void;
  onClose?: () => void;
  overlay?: boolean;
  initialProfile?: ProjectProfile | null;
}) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [formData, setFormData] = useState<SetupFormState>(() =>
    projectToFormValues(initialProfile),
  );
  const [errors, setErrors] = useState<SetupErrors>({});

  useEffect(() => {
    setFormData(projectToFormValues(initialProfile));
    setErrors({});
  }, [initialProfile]);

  const updateField = (field: keyof SetupFormState, value: string) => {
    setFormData((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSelectFolder = async () => {
    try {
      setIsSelecting(true);
      try {
        const folder = await window.repoRunner.selectFolder();
        if (folder) {
          setFormData((current) => {
            const parts = folder.split(/[/\\]/);
            return {
              ...current,
              repoPath: folder,
              name: current.name || parts[parts.length - 1] || "My Project",
            };
          });
          setErrors((current) => ({
            ...current,
            repoPath: undefined,
            name: undefined,
          }));
        }
      } catch (error) {
        console.error("Failed to select folder:", error);
      }
    } finally {
      setIsSelecting(false);
    }
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const result = setupSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: SetupErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof SetupFormState | undefined;
        if (field) fieldErrors[field] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    const profile = formValuesToProfile(result.data, initialProfile?.id);
    await window.repoRunner.saveProject(profile);
    onSave(profile);
  };

  const renderError = (field: keyof SetupFormState) =>
    errors[field] ? (
      <p className="text-[0.8rem] font-medium text-destructive">
        {errors[field]}
      </p>
    ) : null;

  return (
    <div
      className={
        overlay
          ? "w-full"
          : "flex min-h-screen w-full items-center justify-center px-4 py-8 sm:px-8 animate-in fade-in duration-300"
      }
      style={overlay ? undefined : { background: "#070707" }}
    >
      {/* Subtle grain — only in full-screen (non-overlay) mode */}
      {!overlay && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            backgroundImage: `url('data:image/svg+xml,<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/></filter><rect width="100%25" height="100%25" filter="url(%23n)"/></svg>')`,
            backgroundSize: "200px 200px",
            opacity: 0.045,
            mixBlendMode: "overlay",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      <Card
        className="relative z-10 mx-auto w-full max-w-[920px] rounded-xl overflow-hidden"
        style={{
          background: "#0a0a0a",
          border: overlay ? "1px solid #242020" : "1px solid #1e1e1e",
          boxShadow: overlay
            ? "0 24px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(185,14,28,0.10), 0 0 40px rgba(185,14,28,0.06)"
            : "0 8px 40px rgba(0,0,0,0.8), 0 0 0 1px rgba(185,14,28,0.04), 0 0 60px rgba(185,14,28,0.03)",
          zIndex: 1,
        }}
      >
        {/* Red top accent hairline */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "1px",
            background:
              "linear-gradient(90deg, transparent 0%, rgba(185,14,28,0.55) 30%, rgba(185,14,28,0.72) 50%, rgba(185,14,28,0.55) 70%, transparent 100%)",
            zIndex: 2,
          }}
        />

        <CardHeader
          className="space-y-1 px-5 pb-5 pt-6 sm:px-8 sm:pt-7 relative"
          style={{ borderBottom: "1px solid #161616" }}
        >
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="absolute top-5 right-5 flex items-center justify-center w-8 h-8 rounded-md transition-all duration-150"
              style={{
                color: "#4a4846",
                background: "transparent",
                border: "1px solid #1c1c1c",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#b90e1c";
                e.currentTarget.style.background = "rgba(185,14,28,0.08)";
                e.currentTarget.style.borderColor = "rgba(185,14,28,0.28)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#4a4846";
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "#1c1c1c";
              }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <CardTitle
            className="text-xl font-semibold tracking-tight"
            style={{ color: "#dedad5", letterSpacing: "-0.01em" }}
          >
            RepoRunner Setup
          </CardTitle>
          <CardDescription className="text-xs" style={{ color: "#5a5856" }}>
            Save your local app setup once. Run it with buttons after that.
          </CardDescription>
        </CardHeader>

        <CardContent className="px-5 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-6">
          <form onSubmit={onSubmit} className="space-y-6">
            {/* Row 1: Project Name | Repo Folder */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[0.9fr_1.1fr] md:gap-5">
              <div className="space-y-1.5">
                <label
                  className="font-medium"
                  style={labelStyle}
                  htmlFor="setup-project-name"
                >
                  Project Name
                </label>
                <Input
                  id="setup-project-name"
                  placeholder="My Cool App"
                  value={formData.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  className={inputClassName}
                  style={inputStyle}
                />
                {renderError("name")}
              </div>

              <div className="flex flex-col justify-end space-y-1.5">
                <label
                  className="font-medium"
                  style={labelStyle}
                  htmlFor="setup-repo-path"
                >
                  Local Repository Folder
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="setup-repo-path"
                    placeholder="/path/to/project"
                    value={formData.repoPath}
                    onChange={(event) =>
                      updateField("repoPath", event.target.value)
                    }
                    className={`flex-1 min-w-0 text-sm ${inputClassName}`}
                    style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleSelectFolder}
                    disabled={isSelecting}
                    className="h-10 flex-none whitespace-nowrap px-3 text-xs sm:w-auto"
                    style={{
                      background: "#0d0d0d",
                      border: "1px solid #1e1e1e",
                      color: "#6a6864",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#141414";
                      e.currentTarget.style.color = "#9a9896";
                      e.currentTarget.style.borderColor = "#2a2a2a";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#0d0d0d";
                      e.currentTarget.style.color = "#6a6864";
                      e.currentTarget.style.borderColor = "#1e1e1e";
                    }}
                  >
                    <Folder className="h-3.5 w-3.5 mr-1.5 flex-none" />
                    Choose
                  </Button>
                </div>
                {renderError("repoPath")}
              </div>
            </div>

            {/* Row 2: Preview URL — full width */}
            <div className="space-y-1.5">
              <label
                className="font-medium"
                style={labelStyle}
                htmlFor="setup-preview-url"
              >
                Preview URL
              </label>
              <Input
                id="setup-preview-url"
                value={formData.previewUrl}
                onChange={(event) =>
                  updateField("previewUrl", event.target.value)
                }
                className={`text-xs ${inputClassName}`}
                style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
              />
              {renderError("previewUrl")}
            </div>

            {/* Row 3: Install | Frontend | Backend commands */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
              {([
                ["installCommand", "Install Command"],
                ["frontendCommand", "Frontend Command"],
                ["backendCommand", "Backend Command"],
              ] as const).map(([fieldName, label]) => (
                <div key={fieldName} className="space-y-1.5">
                  <label
                    className="font-medium"
                    style={labelStyle}
                    htmlFor={`setup-${fieldName}`}
                  >
                    {label}
                  </label>
                  <Input
                    id={`setup-${fieldName}`}
                    value={formData[fieldName]}
                    onChange={(event) =>
                      updateField(fieldName, event.target.value)
                    }
                    className={`text-xs ${inputClassName}`}
                    style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
                  />
                  {renderError(fieldName)}
                </div>
              ))}
            </div>

            {/* Row 4: Frontend Port | Backend Port */}
            <div className="grid w-full grid-cols-1 gap-4 sm:max-w-md sm:grid-cols-2 md:gap-5">
              {([
                ["frontendPort", "Frontend Port"],
                ["backendPort", "Backend Port"],
              ] as const).map(([fieldName, label]) => (
                <div key={fieldName} className="space-y-1.5">
                  <label
                    className="font-medium flex items-center gap-1.5"
                    style={labelStyle}
                    htmlFor={`setup-${fieldName}`}
                  >
                    {label}
                    <span
                      style={{
                        color: "#4c4a48",
                        fontSize: "10px",
                        letterSpacing: "0.02em",
                      }}
                    >
                      optional
                    </span>
                  </label>
                  <Input
                    id={`setup-${fieldName}`}
                    type="number"
                    value={formData[fieldName]}
                    onChange={(event) =>
                      updateField(fieldName, event.target.value)
                    }
                    className={`text-xs ${inputClassName}`}
                    style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
                  />
                  {renderError(fieldName)}
                </div>
              ))}
            </div>

            <div
              className="pt-6 mt-1"
              style={{ borderTop: "1px solid #161616" }}
            >
              <button
                type="submit"
                className="btn-glass btn-glass-primary w-full justify-center h-10"
              >
                <Save className="h-4 w-4 flex-none" strokeWidth={1.5} />
                <span
                  style={{
                    fontSize: "0.63rem",
                    letterSpacing: "0.03em",
                    lineHeight: 1,
                  }}
                >
                  Save Configuration
                </span>
                <ArrowRight className="h-4 w-4 flex-none" strokeWidth={1.5} />
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
