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

export function SetupScreen({ onSave, onClose }: { onSave: (profile: ProjectProfile) => void; onClose?: () => void }) {
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
          // Extract last part of path for project name
          const parts = folder.split(/[/\\]/);
          form.setValue("name", parts[parts.length - 1] || "My Project");
        }
      }
    } finally {
      setIsSelecting(false);
    }
  };

  const onSubmit = async (data: SetupFormValues) => {
    const profile: ProjectProfile = {
      id: crypto.randomUUID(),
      ...data,
    };
    await window.repoRunner.saveProject(profile);
    onSave(profile);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4 sm:p-8 bg-background animate-in fade-in duration-500">
      <Card className="w-full max-w-2xl border-border bg-card shadow-lg rounded-xl">
        <CardHeader className="space-y-2 pb-6 pt-8 px-8 sm:px-10 relative">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="absolute top-5 right-5 flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.08] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <CardTitle className="text-2xl font-bold tracking-tight">Setup RepoRunner</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            Save your local app setup once. Run it with buttons after that.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8 sm:px-10 sm:pb-10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Project Name</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="My Cool App" 
                          {...field} 
                          className="bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring"
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
                      <FormLabel className="text-sm font-medium text-foreground">Local Repository Folder</FormLabel>
                      <div className="flex gap-2">
                        <FormControl>
                          <Input 
                            placeholder="/path/to/project" 
                            readOnly 
                            {...field} 
                            className="font-mono text-sm flex-1 bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                          />
                        </FormControl>
                        <Button 
                          type="button" 
                          variant="secondary" 
                          onClick={handleSelectFolder}
                          disabled={isSelecting}
                          className="flex-none"
                        >
                          <Folder className="h-4 w-4 mr-2" />
                          Choose Folder
                        </Button>
                      </div>
                      <FormDescription className="text-xs text-muted-foreground">The folder where your project lives locally.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="installCommand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Install Command</FormLabel>
                      <FormControl>
                        <Input 
                          {...field} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormDescription className="text-xs text-muted-foreground">Runs once to install dependencies (e.g. npm install).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="frontendCommand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Frontend Command</FormLabel>
                      <FormControl>
                        <Input 
                          {...field} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormDescription className="text-xs text-muted-foreground">Starts your frontend dev server (e.g. npm run dev).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="backendCommand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Backend Command</FormLabel>
                      <FormControl>
                        <Input 
                          {...field} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormDescription className="text-xs text-muted-foreground">Starts your backend server (e.g. node server.js).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <FormField
                  control={form.control}
                  name="previewUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Preview URL</FormLabel>
                      <FormControl>
                        <Input 
                          {...field} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormDescription className="text-xs text-muted-foreground">The URL to open when you click Open Preview.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="frontendPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Frontend Port (Optional)</FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          {...field} 
                          value={field.value || ""} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="backendPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-foreground">Backend Port (Optional)</FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          {...field} 
                          value={field.value || ""} 
                          className="font-mono text-sm bg-input border-border text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring" 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-6 mt-6 border-t border-border/50">
                <Button type="submit" size="lg" className="w-full font-semibold" variant="default">
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
