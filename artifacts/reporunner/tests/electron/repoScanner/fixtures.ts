// Disposable fixture repositories for scanner tests. Everything is created
// under one temp base folder (its name contains spaces and non-ASCII
// characters) and cleanup only ever deletes inside that folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Tree = Record<string, string | Buffer>;

export class FixtureSpace {
  readonly base: string;
  private readonly links: string[] = [];

  constructor() {
    this.base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rr scan ü 名前 ")));
  }

  /** Creates `name` under the base with the given files ("a/b/c.txt": content). */
  repo(name: string, tree: Tree = {}): string {
    const root = path.join(this.base, name);
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(tree)) {
      const file = path.join(root, ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return root;
  }

  /** Directory link (junction on Windows, symlink elsewhere). */
  dirLink(linkPath: string, target: string): void {
    fs.symlinkSync(target, linkPath, "junction");
    this.links.push(linkPath);
  }

  /** File symlink; returns false if the OS refuses (Windows without privilege). */
  fileLink(linkPath: string, target: string): boolean {
    try {
      fs.symlinkSync(target, linkPath, "file");
      this.links.push(linkPath);
      return true;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    // Remove links first so nothing can ever be deleted through them.
    for (const link of this.links.reverse()) {
      try {
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(link);
      } catch {
        try {
          fs.rmdirSync(link); // Windows junction
        } catch {
          // already gone
        }
      }
    }
    const resolved = fs.realpathSync.native(this.base);
    if (!path.basename(resolved).startsWith("rr scan ") || path.dirname(resolved) !== fs.realpathSync.native(os.tmpdir())) {
      throw new Error("refusing to delete outside the fixture area");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

export const pkg = (fields: Record<string, unknown>) => JSON.stringify(fields, null, 2);

/** Builds strings with invisible/control characters without putting them in source. */
export const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
