import type { ProjectProfile } from "../src/types.js";
import { sanitizeCommandInput } from "./commandUtils.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  profile: UnknownRecord,
  key: string,
  label: string
): string {
  const value = profile[key];

  if (typeof value !== "string") {
    throw new Error(`Invalid project profile: ${label} is required`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Invalid project profile: ${label} is required`);
  }

  return trimmed;
}

function readOptionalString(profile: UnknownRecord, key: string): string {
  const value = profile[key];

  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid project profile: ${key} must be a string`);
  }

  return value.trim();
}

function readRequiredCommand(
  profile: UnknownRecord,
  key: string,
  label: string
): string {
  const raw = readRequiredString(profile, key, label);
  const sanitized = sanitizeCommandInput(raw);

  if (!sanitized) {
    throw new Error(`Invalid project profile: ${label} is required`);
  }

  return sanitized;
}

function readOptionalCommand(profile: UnknownRecord, key: string): string {
  const raw = readOptionalString(profile, key);
  return sanitizeCommandInput(raw);
}

function readOptionalPort(
  profile: UnknownRecord,
  key: "frontendPort" | "backendPort",
  label: string
): number | undefined {
  const value = profile[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const port =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid project profile: ${label} must be a valid port`);
  }

  return port;
}

function validatePreviewUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid project profile: Preview URL must be valid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid project profile: Preview URL must use http or https");
  }

  return value;
}

export function validateProjectProfileForSave(input: unknown): ProjectProfile {
  if (!isRecord(input)) {
    throw new Error("Invalid project profile: Expected an object");
  }

  const id = readOptionalString(input, "id");
  const name = readRequiredString(input, "name", "Project name");
  const repoPath = readRequiredString(input, "repoPath", "Repository path");
  const installCommand = readRequiredCommand(input, "installCommand", "Install command");
  const frontendCommand = readRequiredCommand(input, "frontendCommand", "Frontend command");
  const backendCommand = readOptionalCommand(input, "backendCommand");
  const previewUrl = validatePreviewUrl(
    readRequiredString(input, "previewUrl", "Preview URL")
  );
  const frontendPort = readOptionalPort(input, "frontendPort", "Frontend port");
  const backendPort = readOptionalPort(input, "backendPort", "Backend port");

  return {
    id,
    name,
    repoPath,
    installCommand,
    frontendCommand,
    backendCommand,
    previewUrl,
    ...(frontendPort !== undefined ? { frontendPort } : {}),
    ...(backendPort !== undefined ? { backendPort } : {}),
  };
}
