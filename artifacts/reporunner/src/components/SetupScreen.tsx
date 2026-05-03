import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Folder } from "lucide-react";
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

export function SetupScreen({ onSave }: { onSave: (profile: ProjectProfile) => void }) {
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
    <div className="flex min-h-screen items-center justify-center p-4 sm:p-8 animate-in fade-in zoom-in duration-500">
      <Card className="w-full max-w-2xl border-border/50 shadow-2xl">
        <CardHeader className="space-y-2 pb-6">
          <CardTitle className="text-3xl font-semibold tracking-tight">Setup RepoRunner</CardTitle>
          <CardDescription className="text-base text-muted-foreground">
            Configure your local project once. Run it with a click forever.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project Name</FormLabel>
                      <FormControl>
                        <Input placeholder="My Cool App" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="repoPath"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Local Repository Folder</FormLabel>
                      <div className="flex gap-2">
                        <FormControl>
                          <Input placeholder="/path/to/project" readOnly {...field} />
                        </FormControl>
                        <Button 
                          type="button" 
                          variant="secondary" 
                          onClick={handleSelectFolder}
                          disabled={isSelecting}
                        >
                          <Folder className="h-4 w-4 mr-2" />
                          Choose
                        </Button>
                      </div>
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
                      <FormLabel>Install Command</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="frontendCommand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Frontend Command</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="backendCommand"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Backend Command</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
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
                      <FormLabel>Preview URL</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="frontendPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Frontend Port (Optional)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value || ""} />
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
                      <FormLabel>Backend Port (Optional)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} value={field.value || ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-4 flex justify-end">
                <Button type="submit" size="lg" className="w-full sm:w-auto px-8 font-medium">
                  Save Configuration
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
