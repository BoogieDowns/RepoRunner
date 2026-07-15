import { useEffect, useState } from "react";
import * as z from "zod";
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  HelpCircle,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  MAX_FREE_REPO_PROFILES,
  ProjectProfile,
  ProjectProfilesState,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
  backendCommand: z.string().trim(),
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

type SetupErrors = Partial<Record<keyof SetupFormState | "form", string>>;

const SWITCH_BLOCKED_MESSAGE =
  "RepoRunner can run one saved repo at a time. Stop the current repo before switching saved setups.";
const FREE_REPO_LIMIT_MESSAGE =
  "RepoRunner Free supports up to 5 saved repo setups. RepoRunner Pro will unlock unlimited saved repos and repo library features.";
const DELETE_CONFIRMATION_MESSAGE =
  "Delete this saved repo setup? This removes the setup from RepoRunner. It does not delete project files from your computer.";

const setupHelpPages = [
  {
    title: "Saved repos",
    content: [
      "RepoRunner Free supports up to 5 saved repo setups.",
      "Each setup remembers the local repo folder, install command, frontend and backend commands, ports, and preview URL.",
      "RepoRunner runs one active saved repo at a time. Stop any running services before switching to another setup.",
    ],
  },
  {
    title: "Commands",
    content: [
      "On Windows, use commands such as npm.cmd install, pnpm.cmd install, npm.cmd run dev, or pnpm.cmd run dev.",
      "Choose the actual repo root folder. For monorepos or apps inside subfolders, include cd in the command, for example:",
      "cd apps\\web && pnpm.cmd run dev",
    ],
  },
  {
    title: "Pull and delete safety",
    content: [
      "Pull runs git pull in the active repo folder using its currently checked-out branch and configured upstream remote.",
      "Deleting a saved setup only removes it from RepoRunner. It does not delete the repository or any project files from your computer.",
    ],
  },
];

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

const blankFormValues: SetupFormState = {
  name: "",
  repoPath: "",
  installCommand: "",
  frontendCommand: "",
  backendCommand: "",
  previewUrl: "",
  frontendPort: "",
  backendPort: "",
};

const placeholderExamples: SetupFormState = {
  name: "My Cool App",
  repoPath: "C:\\path\\to\\project",
  previewUrl: "http://localhost:3000",
  installCommand: "npm install",
  frontendCommand: "npm run dev",
  backendCommand: "npm start",
  frontendPort: "3000",
  backendPort: "3001",
};

function isValidPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function sanitizeCommandField(value: string) {
  return value
    .trim()
    .replace(/^(?:install|frontend|backend|pull)\s+command\s*:\s*/i, "")
    .trim();
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
    installCommand: sanitizeCommandField(data.installCommand),
    frontendCommand: sanitizeCommandField(data.frontendCommand),
    backendCommand: sanitizeCommandField(data.backendCommand),
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

function cleanElectronErrorMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function getSaveProjectErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return cleanElectronErrorMessage(error.message);
  }

  if (typeof error === "string" && error.trim()) {
    return cleanElectronErrorMessage(error);
  }

  return "Failed to save project setup.";
}

function saveErrorField(message: string): keyof SetupFormState | "form" {
  return message.toLowerCase().includes("repository path") ? "repoPath" : "form";
}
export function SetupScreen({
  profiles,
  activeProfileId,
  activeProject,
  servicesBusy,
  onSave,
  onSelectProfile,
  onDeleteProfile,
  onClose,
  overlay = false,
}: {
  profiles: ProjectProfile[];
  activeProfileId: string | null;
  activeProject: ProjectProfile | null;
  servicesBusy: boolean;
  onSave: (state: ProjectProfilesState) => void;
  onSelectProfile: (profileId: string) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onClose?: () => void;
  overlay?: boolean;
}) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isChangingProfile, setIsChangingProfile] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(!activeProject);
  const NEW_REPO_OPTION = "__new_repo_setup";
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [helpPageIndex, setHelpPageIndex] = useState(0);
  const [formData, setFormData] = useState<SetupFormState>(() =>
    projectToFormValues(activeProject),
  );
  const [errors, setErrors] = useState<SetupErrors>({});

  const currentHelpPage = setupHelpPages[helpPageIndex] ?? setupHelpPages[0];
  const isFirstHelpPage = helpPageIndex === 0;
  const isLastHelpPage = helpPageIndex === setupHelpPages.length - 1;

  useEffect(() => {
    if (!isAddingNew) {
      setFormData(projectToFormValues(activeProject));
      setErrors({});
    }
  }, [activeProject, isAddingNew]);

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

  const handleAddNew = () => {
    if (servicesBusy) {
      setErrors({ form: SWITCH_BLOCKED_MESSAGE });
      return;
    }

    if (profiles.length >= MAX_FREE_REPO_PROFILES) {
      setErrors({ form: FREE_REPO_LIMIT_MESSAGE });
      return;
    }

    setIsAddingNew(true);
    setFormData(blankFormValues);
    setErrors({});
  };

  const handleSelectProfile = async (profileId: string) => {
    if (profileId === NEW_REPO_OPTION) {
      if (servicesBusy) {
        setErrors({ form: SWITCH_BLOCKED_MESSAGE });
        return;
      }

      if (profiles.length >= MAX_FREE_REPO_PROFILES) {
        setErrors({ form: FREE_REPO_LIMIT_MESSAGE });
        return;
      }

      setIsAddingNew(true);
      setFormData(blankFormValues);
      setErrors({});
      return;
    }

    if (servicesBusy) {
      setErrors({ form: SWITCH_BLOCKED_MESSAGE });
      return;
    }

    const selectedProfile = profiles.find(
      (profile) => profile.id === profileId
    );
    if (!selectedProfile) return;

    setIsChangingProfile(true);
    try {
      await onSelectProfile(profileId);
      setIsAddingNew(false);
      setFormData(projectToFormValues(selectedProfile));
      setErrors({});
    } catch (error) {
      setErrors({ form: getSaveProjectErrorMessage(error) });
    } finally {
      setIsChangingProfile(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (isAddingNew || !activeProfileId) return;

    if (servicesBusy) {
      setErrors({ form: SWITCH_BLOCKED_MESSAGE });
      return;
    }

    if (!window.confirm(DELETE_CONFIRMATION_MESSAGE)) return;

    setIsChangingProfile(true);
    try {
      await onDeleteProfile(activeProfileId);
      setErrors({});
    } catch (error) {
      setErrors({ form: getSaveProjectErrorMessage(error) });
    } finally {
      setIsChangingProfile(false);
    }
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isSaving) return;

    if (isAddingNew && servicesBusy) {
      setErrors({ form: SWITCH_BLOCKED_MESSAGE });
      return;
    }

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

    const profile = formValuesToProfile(
      result.data,
      isAddingNew ? undefined : activeProfileId ?? undefined,
    );

    setIsSaving(true);

    try {
      const nextState = await window.repoRunner.saveProject(profile);
      setIsAddingNew(false);
      onSave(nextState);
    } catch (error) {
      const message = getSaveProjectErrorMessage(error);
      const field = saveErrorField(message);
      setErrors({ [field]: message });
    } finally {
      setIsSaving(false);
    }
  };

  const renderError = (field: keyof SetupErrors) =>
    errors[field] ? (
      <p
        className="mt-1.5 rounded-md border border-[#4a1218]/70 bg-[#1a080a]/70 px-2.5 py-1.5 text-[0.72rem] font-medium leading-snug text-[#ff8a94]"
        role="alert"
      >
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

        {isHelpOpen && (
          <div
            className="fixed inset-0 z-30 flex items-center justify-center px-4 py-6 animate-in fade-in duration-150"
            style={{ background: "rgba(0,0,0,0.72)" }}
            onClick={() => setIsHelpOpen(false)}
            role="presentation"
          >
            <div
              className="w-full max-w-md rounded-xl p-5 shadow-2xl"
              style={{
                background: "#0a0a0a",
                border: "1px solid #242020",
                boxShadow: "0 24px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(185,14,28,0.10)",
                display: "flex",
                flexDirection: "column",
                width: "100%",
                maxWidth: "520px",
                height: "360px",
                minHeight: "320px",
              }}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="setup-help-title"
            >
              <div className="mb-4 flex items-start justify-between gap-4" style={{ flex: "0 0 auto" }}>
                <div>
                  <p
                    className="text-[0.68rem] font-medium uppercase"
                    style={{ color: "#706d69", letterSpacing: "0.08em" }}
                  >
                    Setup help {helpPageIndex + 1}/{setupHelpPages.length}
                  </p>
                  <h2
                    id="setup-help-title"
                    className="mt-1 text-base font-semibold"
                    style={{ color: "#dedad5" }}
                  >
                    {currentHelpPage.title}
                  </h2>
                </div>
                  <button
                    type="button"
                    onClick={() => setIsHelpOpen(false)}
                    aria-label="Close setup help"
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-md transition-all duration-150"
                    style={{
                      color: "#706d69",
                      background: "#0d0d0d",
                      border: "1px solid #242020",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#b90e1c";
                      e.currentTarget.style.background = "rgba(185,14,28,0.08)";
                      e.currentTarget.style.borderColor = "rgba(185,14,28,0.28)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#706d69";
                      e.currentTarget.style.background = "#0d0d0d";
                      e.currentTarget.style.borderColor = "#242020";
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
              </div>

              <div style={{ flex: "1 1 auto", overflowY: "auto", paddingRight: 4 }}>
                <div className="space-y-3">
                  {currentHelpPage.content.map((line) => (
                    <p
                      key={line}
                      className="text-sm leading-relaxed"
                      style={{ color: "#b8b4af" }}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-t border-[#161616] pt-4" style={{ flex: "0 0 auto" }}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setHelpPageIndex((page) => Math.max(0, page - 1))
                  }
                  disabled={isFirstHelpPage}
                  className="h-9 px-3 text-xs disabled:opacity-40"
                  style={{
                    background: "#0d0d0d",
                    border: "1px solid #242020",
                    color: "#9a9896",
                  }}
                  onMouseEnter={(e) => {
                    if ((e.currentTarget as HTMLButtonElement).disabled) return;
                    e.currentTarget.style.borderColor = "rgba(185,14,28,0.18)";
                    e.currentTarget.style.color = "#d9b0b3";
                    e.currentTarget.style.boxShadow = "0 0 10px rgba(185,14,28,0.06)";
                    const icon = e.currentTarget.querySelector("svg");
                    if (icon) (icon as SVGElement).style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "#242020";
                    e.currentTarget.style.color = "#9a9896";
                    e.currentTarget.style.boxShadow = "none";
                    const icon = e.currentTarget.querySelector("svg");
                    if (icon) (icon as SVGElement).style.opacity = "";
                  }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </Button>
                <div className="flex gap-1.5" aria-hidden="true">
                  {setupHelpPages.map((page, index) => (
                    <span
                      key={page.title}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background:
                          index === helpPageIndex ? "#b90e1c" : "#34302e",
                      }}
                    />
                  ))}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setHelpPageIndex((page) =>
                      Math.min(setupHelpPages.length - 1, page + 1),
                    )
                  }
                  disabled={isLastHelpPage}
                  className="h-9 px-3 text-xs disabled:opacity-40"
                  style={{
                    background: "#0d0d0d",
                    border: "1px solid #242020",
                    color: "#9a9896",
                  }}
                  onMouseEnter={(e) => {
                    if ((e.currentTarget as HTMLButtonElement).disabled) return;
                    e.currentTarget.style.borderColor = "rgba(185,14,28,0.18)";
                    e.currentTarget.style.color = "#d9b0b3";
                    e.currentTarget.style.boxShadow = "0 0 10px rgba(185,14,28,0.06)";
                    const icon = e.currentTarget.querySelector("svg");
                    if (icon) (icon as SVGElement).style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "#242020";
                    e.currentTarget.style.color = "#9a9896";
                    e.currentTarget.style.boxShadow = "none";
                    const icon = e.currentTarget.querySelector("svg");
                    if (icon) (icon as SVGElement).style.opacity = "";
                  }}
                >
                  Next
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}

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
          <div
            className={`flex items-center gap-2 ${onClose ? "pr-12" : ""}`}
          >
            <CardTitle
              className="text-xl font-semibold tracking-tight"
              style={{ color: "#dedad5", letterSpacing: "-0.01em" }}
            >
              {overlay ? "Edit Repo Setup" : "RepoRunner Setup"}
            </CardTitle>
            <button
              type="button"
              onClick={() => setIsHelpOpen(true)}
              aria-label="Open setup help"
              className="flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150"
              style={{
                color: "#706d69",
                background: "#0d0d0d",
                border: "1px solid #242020",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#dedad5";
                e.currentTarget.style.background = "rgba(185,14,28,0.08)";
                e.currentTarget.style.borderColor = "rgba(185,14,28,0.28)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#706d69";
                e.currentTarget.style.background = "#0d0d0d";
                e.currentTarget.style.borderColor = "#242020";
              }}
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
          </div>
          <CardDescription className="text-xs" style={{ color: "#5a5856" }}>
            Save your local app setup once. Run it with buttons after that.
          </CardDescription>
        </CardHeader>

        <CardContent className="px-5 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-6">
          <form onSubmit={onSubmit} className="space-y-6">
            <div
              className="grid grid-cols-1 gap-3 rounded-lg p-3 sm:grid-cols-1 sm:items-start"
              style={{
                background: "#080808",
                border: "1px solid #181818",
              }}
            >
              <div className="space-y-1.5">
                <label className="font-medium" style={labelStyle}>
                  Saved Repos
                </label>
                <Select
                  value={isAddingNew ? "" : activeProfileId ?? ""}
                  onValueChange={handleSelectProfile}
                  disabled={servicesBusy || isChangingProfile}
                >
                  <SelectTrigger
                    className="h-10 w-full focus:ring-[#4a1218]/35"
                    style={{
                      background: "#060606",
                      border: "1px solid #21191a",
                      color: "#dedad5",
                    }}
                  >
                    <SelectValue
                      placeholder={
                        profiles.length === 0
                          ? "New repo setup"
                          : "Select a saved repo"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem
                      value={NEW_REPO_OPTION}
                      className="text-[#c8c0ba] italic"
                      disabled={profiles.length >= MAX_FREE_REPO_PROFILES}
                    >
                      + New repo setup
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {servicesBusy && (
                <p
                  className="text-[0.72rem] leading-snug text-[#d18a90]"
                  role="status"
                >
                  {SWITCH_BLOCKED_MESSAGE}
                </p>
              )}
            </div>
            <Separator className="border-[#161616]" />
            <div className="pb-2">
              <p
                className="text-xs font-medium uppercase tracking-[0.16em]"
                style={{ color: "#6a6864" }}
              >
                Setup Details
              </p>
            </div>

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
                  placeholder={placeholderExamples.name}
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
                    placeholder={placeholderExamples.repoPath}
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
                    Choose Folder
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
                placeholder={placeholderExamples.previewUrl}
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
                ["backendCommand", "Backend Command (optional)"],
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
                    placeholder={placeholderExamples[fieldName]}
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
                ["backendPort", "Backend Port (optional)"],
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
                    placeholder={placeholderExamples[fieldName]}
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
              {renderError("form")}
              {profiles.length >= MAX_FREE_REPO_PROFILES && !isAddingNew && (
                <p className="mb-3 text-[0.72rem] leading-snug text-[#706d69]">
                  {FREE_REPO_LIMIT_MESSAGE}
                </p>
              )}
              <div
                className={
                  !isAddingNew && activeProfileId
                    ? "grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]"
                    : ""
                }
              >
                {!isAddingNew && activeProfileId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleDeleteProfile}
                    disabled={servicesBusy || isChangingProfile || isSaving}
                    className="h-10 px-3 text-xs"
                    style={{
                      background: "#0d0809",
                      border: "1px solid #351318",
                      color: "#c85c66",
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete setup
                  </Button>
                )}
                <button
                  type="submit"
                  disabled={isSaving}
                  className="btn-glass btn-glass-primary w-full justify-center !h-10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Save className="h-4 w-4 flex-none" strokeWidth={1.5} />
                  <span
                    style={{
                      fontSize: "0.63rem",
                      letterSpacing: "0.03em",
                      lineHeight: 1,
                    }}
                  >
                    {isSaving
                      ? "Saving..."
                      : isAddingNew
                        ? "Save Repo Setup"
                        : "Update Repo Setup"}
                  </span>
                  <ArrowRight className="h-4 w-4 flex-none" strokeWidth={1.5} />
                </button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
