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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
  background: "#070707",
  border: "1px solid #1c1c1c",
  color: "#dedad5",
};

const inputClassName =
  "focus-visible:ring-[#cc2222]/20 focus-visible:border-[#cc2222]/30 " +
  "focus-visible:shadow-[0_0_8px_rgba(204,34,34,0.08)] transition-shadow placeholder:text-[#282422]";

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
      className={overlay ? undefined : "flex min-h-screen items-center justify-center p-4 sm:p-8 animate-in fade-in duration-300"}
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
        className="w-full max-w-2xl rounded-xl relative"
        style={{
          background: "#0a0a0a",
          border: overlay ? "1px solid #242020" : "1px solid #1a1a1a",
          boxShadow: overlay
            ? "0 24px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(204,34,34,0.10), 0 0 40px rgba(204,34,34,0.06)"
            : "0 8px 40px rgba(0,0,0,0.8), 0 0 0 1px rgba(204,34,34,0.04), 0 0 60px rgba(204,34,34,0.03)",
          zIndex: 1,
        }}
      >
        <CardHeader className="space-y-1.5 pb-6 pt-8 px-8 sm:px-10 relative" style={{ borderBottom: "1px solid #141414" }}>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="absolute top-5 right-5 flex items-center justify-center w-7 h-7 rounded-md transition-colors"
              style={{ color: "#3a3836", background: "transparent", border: "1px solid transparent" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#cc2222";
                e.currentTarget.style.background = "rgba(204,34,34,0.08)";
                e.currentTarget.style.border = "1px solid rgba(204,34,34,0.2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#3a3836";
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.border = "1px solid transparent";
              }}
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <CardTitle
            className="text-2xl font-bold tracking-tight"
            style={{ color: "#dedad5" }}
          >
            Setup RepoRunner
          </CardTitle>
          <CardDescription className="text-sm" style={{ color: "#4a4845" }}>
            Save your local app setup once. Run it with buttons after that.
          </CardDescription>
        </CardHeader>

        <CardContent className="px-8 pb-8 sm:px-10 sm:pb-10 pt-7">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium" style={{ color: "#6a6864" }}>
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
                    <FormItem className="flex flex-col justify-end">
                      <FormLabel className="text-sm font-medium" style={{ color: "#6a6864" }}>
                        Local Repository Folder
                      </FormLabel>
                      <div className="flex gap-2">
                        <FormControl>
                          <Input
                            placeholder="/path/to/project"
                            readOnly
                            {...field}
                            className={`flex-1 text-sm ${inputClassName}`}
                            style={{ ...inputStyle, ...MONO }}
                          />
                        </FormControl>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleSelectFolder}
                          disabled={isSelecting}
                          className="flex-none"
                          style={{
                            background: "#0c0c0c",
                            border: "1px solid #1c1c1c",
                            color: "#6a6864",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#111";
                            e.currentTarget.style.color = "#9a9896";
                            e.currentTarget.style.borderColor = "#282828";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "#0c0c0c";
                            e.currentTarget.style.color = "#6a6864";
                            e.currentTarget.style.borderColor = "#1c1c1c";
                          }}
                        >
                          <Folder className="h-4 w-4 mr-2" />
                          Choose Folder
                        </Button>
                      </div>
                      <FormDescription className="text-xs" style={{ color: "#383432" }}>
                        The folder where your project lives locally.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                {(["installCommand", "frontendCommand", "backendCommand"] as const).map((fieldName, i) => {
                  const labels = ["Install Command", "Frontend Command", "Backend Command"];
                  const descs = [
                    "Runs once to install dependencies.",
                    "Starts your frontend dev server.",
                    "Starts your backend server.",
                  ];
                  return (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium" style={{ color: "#6a6864" }}>
                            {labels[i]}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              className={`text-sm ${inputClassName}`}
                              style={{ ...inputStyle, ...MONO }}
                            />
                          </FormControl>
                          <FormDescription className="text-xs" style={{ color: "#383432" }}>
                            {descs[i]}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="previewUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium" style={{ color: "#6a6864" }}>
                        Preview URL
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          className={`text-sm ${inputClassName}`}
                          style={{ ...inputStyle, ...MONO }}
                        />
                      </FormControl>
                      <FormDescription className="text-xs" style={{ color: "#383432" }}>
                        Opens when you click Open Preview.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {(["frontendPort", "backendPort"] as const).map((fieldName, i) => (
                  <FormField
                    key={fieldName}
                    control={form.control}
                    name={fieldName}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium" style={{ color: "#6a6864" }}>
                          {i === 0 ? "Frontend Port" : "Backend Port"}
                          <span className="ml-1" style={{ color: "#3a3836", fontSize: "11px" }}>(optional)</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            {...field}
                            value={field.value || ""}
                            className={`text-sm ${inputClassName}`}
                            style={{ ...inputStyle, ...MONO }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </div>

              <div className="pt-6 mt-2" style={{ borderTop: "1px solid #141414" }}>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full font-semibold"
                  style={{
                    background: "#cc2222",
                    border: "1px solid rgba(224,48,48,0.5)",
                    color: "#f5f5f5",
                    boxShadow: "0 0 20px rgba(204,34,34,0.25)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#d12b2b";
                    e.currentTarget.style.boxShadow = "0 0 28px rgba(204,34,34,0.38)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#cc2222";
                    e.currentTarget.style.boxShadow = "0 0 20px rgba(204,34,34,0.25)";
                  }}
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Configuration
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>

            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
