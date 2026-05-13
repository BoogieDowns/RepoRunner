import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Folder, Save, ArrowRight, X } from "lucide-react";
import { ProjectProfile } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const setupSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  repoPath: z.string().min(1, "Repository path is required"),
  installCommand: z.string().min(1, "Install command is required"),
  frontendCommand: z.string().min(1, "Frontend command is required"),
  backendCommand: z.string().min(1, "Backend command is required"),
  previewUrl: z.string().url("Must be a valid URL"),
  frontendPort: z.coerce.number().optional(),
  backendPort: z.coerce.number().optional(),
});

type SetupFormValues = z.infer<typeof setupSchema>;

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
}: {
  onSave: (profile: ProjectProfile) => void;
  onClose?: () => void;
  overlay?: boolean;
}) {
  const [isSelecting, setIsSelecting] = useState(false);

  const form = useForm<SetupFormValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      name: "",
      repoPath: "",
      installCommand: "npm install",
      frontendCommand: "npm run dev",
      backendCommand: "npm start",
      previewUrl: "http://localhost:3000",
      frontendPort: 3000,
      backendPort: 3001,
    },
  });

  const handleSelectFolder = async () => {
    try {
      setIsSelecting(true);
      const folder = await window.repoRunner.selectFolder();
      if (folder) {
        form.setValue("repoPath", folder);
        if (!form.getValues("name")) {
          const parts = folder.split(/[/\\]/);
          form.setValue("name", parts[parts.length - 1] || "My Project");
        }
      }
    } finally {
      setIsSelecting(false);
    }
  };

  const onSubmit = async (data: SetupFormValues) => {
    const profile: ProjectProfile = { id: crypto.randomUUID(), ...data };
    await window.repoRunner.saveProject(profile);
    onSave(profile);
  };

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
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Row 1: Project Name | Repo Folder */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[0.9fr_1.1fr] md:gap-5">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="font-medium" style={labelStyle}>
                        Project Name
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="My Cool App"
                          {...field}
                          className={inputClassName}
                          style={inputStyle}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="repoPath"
                  render={({ field }) => (
                    <FormItem className="flex flex-col justify-end space-y-1.5">
                      <FormLabel className="font-medium" style={labelStyle}>
                        Local Repository Folder
                      </FormLabel>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <FormControl>
                          <Input
                            placeholder="/path/to/project"
                            readOnly
                            {...field}
                            className={`flex-1 min-w-0 text-sm ${inputClassName}`}
                            style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
                          />
                        </FormControl>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Row 2: Preview URL — full width */}
              <FormField
                control={form.control}
                name="previewUrl"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel className="font-medium" style={labelStyle}>
                      Preview URL
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        className={`text-xs ${inputClassName}`}
                        style={{ ...inputStyle, ...MONO, fontSize: "12px" }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Row 3: Install | Frontend | Backend commands */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
                {(
                  [
                    "installCommand",
                    "frontendCommand",
                    "backendCommand",
                  ] as const
                ).map((fieldName, i) => {
                  const labels = [
                    "Install Command",
                    "Frontend Command",
                    "Backend Command",
                  ];
                  return (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }) => (
                        <FormItem className="space-y-1.5">
                          <FormLabel className="font-medium" style={labelStyle}>
                            {labels[i]}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              className={`text-xs ${inputClassName}`}
                              style={{
                                ...inputStyle,
                                ...MONO,
                                fontSize: "12px",
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  );
                })}
              </div>

              {/* Row 4: Frontend Port | Backend Port */}
              <div className="grid w-full grid-cols-1 gap-4 sm:max-w-md sm:grid-cols-2 md:gap-5">
                {(["frontendPort", "backendPort"] as const).map(
                  (fieldName, i) => (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }) => (
                        <FormItem className="space-y-1.5">
                          <FormLabel
                            className="font-medium flex items-center gap-1.5"
                            style={labelStyle}
                          >
                            {i === 0 ? "Frontend Port" : "Backend Port"}
                            <span
                              style={{
                                color: "#4c4a48",
                                fontSize: "10px",
                                letterSpacing: "0.02em",
                              }}
                            >
                              optional
                            </span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              {...field}
                              value={field.value || ""}
                              className={`text-xs ${inputClassName}`}
                              style={{
                                ...inputStyle,
                                ...MONO,
                                fontSize: "12px",
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ),
                )}
              </div>

              <div
                className="pt-6 mt-1"
                style={{ borderTop: "1px solid #161616" }}
              >
                <button
                  type="submit"
                  className="btn-glass btn-glass-primary w-full hover:-translate-y-px active:translate-y-0 active:scale-[0.99]"
                  style={{ height: "42px" }}
                >
                  <Save className="h-4 w-4 flex-none" strokeWidth={1.5} />
                  <span
                    style={{
                      fontFamily: "'HS LunaObscura', sans-serif",
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
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
