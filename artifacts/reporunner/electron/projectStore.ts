import { app } from "electron";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  MAX_FREE_REPO_PROFILES,
  ProjectProfile,
  ProjectProfilesState,
} from "../src/types.js";
import { validateProjectProfileForLoad } from "./projectProfileValidation.js";

const STORE_FILE = "reporunner-project.json";
const EMPTY_PROJECT_STATE: ProjectProfilesState = {
  profiles: [],
  activeProfileId: null,
};

function getStorePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeProjectState(state: ProjectProfilesState): void {
  fs.writeFileSync(getStorePath(), JSON.stringify(state, null, 2), "utf-8");
}

function normalizeProjectState(input: unknown): ProjectProfilesState {
  if (!isRecord(input) || !Array.isArray(input.profiles)) {
    const profile = validateProjectProfileForLoad(input);
    return {
      profiles: [profile],
      activeProfileId: profile.id,
    };
  }

  const profiles = input.profiles.map(validateProjectProfileForLoad);
  const requestedActiveProfileId =
    typeof input.activeProfileId === "string" ? input.activeProfileId : null;
  const activeProfileId = profiles.some(
    (profile) => profile.id === requestedActiveProfileId
  )
    ? requestedActiveProfileId
    : profiles[0]?.id ?? null;

  return { profiles, activeProfileId };
}

export function loadProjectState(): ProjectProfilesState {
  const filePath = getStorePath();
  if (!fs.existsSync(filePath)) return EMPTY_PROJECT_STATE;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const state = normalizeProjectState(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(state)) {
      writeProjectState(state);
    }

    return state;
  } catch {
    return EMPTY_PROJECT_STATE;
  }
}

export function saveProject(
  profile: Omit<ProjectProfile, "id"> & { id?: string }
): ProjectProfilesState {
  const saved: ProjectProfile = {
    ...profile,
    id: profile.id || uuidv4(),
  };
  const state = loadProjectState();
  const existingIndex = state.profiles.findIndex(
    (existing) => existing.id === saved.id
  );

  if (
    existingIndex === -1 &&
    state.profiles.length >= MAX_FREE_REPO_PROFILES
  ) {
    throw new Error(
      "Repo limit reached. RepoRunner Free currently supports up to 5 saved repo setups."
    );
  }

  const profiles = [...state.profiles];
  if (existingIndex === -1) {
    profiles.push(saved);
  } else {
    profiles[existingIndex] = saved;
  }

  const nextState = {
    profiles,
    activeProfileId: saved.id,
  };
  writeProjectState(nextState);
  return nextState;
}

export function loadProject(): ProjectProfile | null {
  const state = loadProjectState();
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    null
  );
}

export function setActiveProject(profileId: string): ProjectProfilesState {
  const state = loadProjectState();
  if (!state.profiles.some((profile) => profile.id === profileId)) {
    throw new Error("Saved repo setup not found.");
  }

  const nextState = { ...state, activeProfileId: profileId };
  writeProjectState(nextState);
  return nextState;
}

export function deleteProject(profileId: string): ProjectProfilesState {
  const state = loadProjectState();
  const profiles = state.profiles.filter((profile) => profile.id !== profileId);

  if (profiles.length === state.profiles.length) {
    throw new Error("Saved repo setup not found.");
  }

  const activeProfileId =
    state.activeProfileId === profileId
      ? profiles[0]?.id ?? null
      : state.activeProfileId;
  const nextState = { profiles, activeProfileId };
  writeProjectState(nextState);
  return nextState;
}

