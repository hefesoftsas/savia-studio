import type { ProjectEditorExtensionReference } from "@savia/studio-shared/plugin-editor-extensions";
import type { IdeFiles } from "./plugin-ide-project";
export type ProjectDraft = {
  files: IdeFiles;
  editorExtensions?: string[];
  installedEditorExtensions?: ProjectEditorExtensionReference[];
  history: { role: "user" | "assistant"; content: string }[];
};
export type RecoveryDraft = ProjectDraft & { version: number };
export type SaveState = {
  state: "saved" | "dirty" | "saving" | "error";
  error?: unknown;
};

export function serializeDraft(draft: ProjectDraft) {
  return JSON.stringify({
    files: Object.fromEntries(
      Object.entries(draft.files).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    history: draft.history.map(({ role, content }) => [role, content]),
    editorExtensions: draft.editorExtensions ?? [],
    installedEditorExtensions: (draft.installedEditorExtensions ?? []).map(
      ({ installationId, sha256 }) => [installationId, sha256],
    ),
  });
}

async function fingerprint(snapshot: string): Promise<string> {
  try {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(snapshot),
    );
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return snapshot;
  }
}

export async function recoveryProjectId(scope: string, draft: RecoveryDraft) {
  const digest = await fingerprint(
    JSON.stringify([
      "savia:plugin-project-recovery:v1",
      scope,
      draft.version,
      serializeDraft(draft),
    ]),
  );
  if (!/^[a-f0-9]{64}$/.test(digest)) return crypto.randomUUID();
  // Use a version 8 UUID with the standard UUID variant bits.
  const variant = ((Number.parseInt(digest[16], 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export class PluginProjectSession {
  private stopped = false;
  private latest: ProjectDraft;
  private acknowledged: string;
  private needsConfirmation = false;
  private unconfirmed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  constructor(
    private version: number,
    initial: ProjectDraft,
    private save: (input: RecoveryDraft) => Promise<{ version: number }>,
    private recover: (input: RecoveryDraft | null) => void,
    private notify: (state: SaveState) => void,
    private readSaved?: () => Promise<RecoveryDraft>,
  ) {
    this.latest = initial;
    this.acknowledged = serializeDraft(initial);
  }
  get savedVersion() {
    return this.version;
  }
  get isSaved() {
    return (
      !this.needsConfirmation &&
      serializeDraft(this.latest) === this.acknowledged
    );
  }
  update(next: ProjectDraft) {
    if (this.stopped) return;
    if (serializeDraft(next) === serializeDraft(this.latest)) return;
    this.latest = next;
    this.recover({ ...next, version: this.version });
    this.notify({ state: "dirty" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 600);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private acknowledge(snapshot: string, version: number) {
    this.version = version;
    this.acknowledged = snapshot;
    this.needsConfirmation = false;
    this.unconfirmed.clear();
    this.recover(this.isSaved ? null : { ...this.latest, version });
  }
  private async confirmUnacknowledgedSave() {
    if (!this.readSaved) return;
    let saved: RecoveryDraft;
    try {
      saved = await this.readSaved();
    } catch {
      return;
    }
    if (this.stopped || saved.version !== this.version + 1) return;
    const snapshot = serializeDraft(saved);
    const digest = await fingerprint(snapshot);
    if (!this.stopped && this.unconfirmed.has(digest))
      this.acknowledge(snapshot, saved.version);
  }
  private async drain() {
    try {
      if (this.unconfirmed.size) {
        this.notify({ state: "saving" });
        await this.confirmUnacknowledgedSave();
      }
      while (!this.stopped && !this.isSaved) {
        const snapshot = this.latest;
        const serialized = serializeDraft(snapshot);
        this.needsConfirmation = true;
        this.notify({ state: "saving" });
        let result: { version: number };
        try {
          result = await this.save({ ...snapshot, version: this.version });
        } catch (error) {
          if (this.readSaved && !this.stopped)
            this.unconfirmed.add(await fingerprint(serialized));
          throw error;
        }
        this.acknowledge(serialized, result.version);
      }
      this.notify({ state: "saved" });
    } catch (error) {
      this.notify({ state: "error", error });
      throw error;
    }
  }
  cancel() {
    this.stopped = true;
    this.dispose();
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
