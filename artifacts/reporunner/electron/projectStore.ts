import { app } from "electron";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { ProjectProfile } from "../src/types.js";

const STORE_FILE = "reporunner-project.json";

function getStorePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

export function loadProject(): ProjectProfile | null {
  const filePath = getStorePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ProjectProfile;
  } catch {
    return null;
  }
}

export function saveProject(profile: Omit<ProjectProfile, "id"> & { id?: string }): ProjectProfile {
  const filePath = getStorePath();
  const saved: ProjectProfile = {
    ...profile,
    id: profile.id || uuidv4(),
  };
  fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), "utf-8");
  return saved;
}

export function deleteProject(): void {
  const filePath = getStorePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
