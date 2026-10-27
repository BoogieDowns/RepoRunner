import { app, safeStorage } from "electron";
import { CredentialStore } from "./credentialStore.js";

/*
 * The application's one credential store (Stage 4B).
 *
 * - Created on first use, never at startup: importing this module does
 *   nothing, and RepoRunner's ordinary (Free) workflows never call it, so they
 *   never read the credentials file or check encryption.
 * - One instance per process. The store serializes its operations per
 *   instance, so a second instance on the same file could lose updates. Every
 *   main-process consumer (the credential IPC handlers now, a provider adapter
 *   later) must use getCredentialStore() and never construct a CredentialStore.
 *   The single-instance lock in main.ts keeps a second process away.
 * - Main process only. Electron's safeStorage is injected here and nowhere else.
 *   Session-only credentials live in this instance's memory and end with the
 *   process; nothing is written at shutdown.
 */

let store: CredentialStore | null = null;

/** The shared store, created on first call (only after app "ready", from an IPC call or later). */
export function getCredentialStore(): CredentialStore {
  if (!store) store = new CredentialStore({ dir: app.getPath("userData"), safeStorage });
  return store;
}
