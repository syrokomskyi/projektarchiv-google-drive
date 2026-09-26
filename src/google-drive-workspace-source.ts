/*
<MODULE_CONTRACT>
<purpose>Capture a bound Google Drive folder or shared drive through the frozen workspace source port.</purpose>
<non-goals><item>Do not own OAuth refresh credentials, persist tokens, publish snapshots, or interpret business facts.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY><item>RFC-1007: add recursive listing, native export, cursor reconciliation, and version-safe reads.</item></CHANGE_SUMMARY>
*/

import {
  assertTenantScope,
  type SourceCaptureRepresentation,
  type SourceChangeSet,
  type SourceCursor,
  type SourceItemDescriptor,
  type TenantScope,
  type WorkspaceId,
  type WorkspaceSourceAdapter,
  type WorkspaceSourceRequest,
} from "@warpgogol/projektarchiv-core";
import type {
  CaptureClassification,
  CaptureSourceCapabilities,
} from "@warpgogol/projektarchiv-operations/capture";

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const GOOGLE_PREFIX = "application/vnd.google-apps.";
const exportsByMime: Record<string, { mime: string; representation: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    representation: "google-docs-docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    representation: "google-sheets-xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    representation: "google-slides-pptx",
  },
  "application/vnd.google-apps.drawing": {
    mime: "application/pdf",
    representation: "google-drawing-pdf",
  },
};

interface DriveFile {
  id: string;
  name?: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  parents?: string[];
  size?: string;
  trashed?: boolean;
}
interface FileList {
  files?: DriveFile[];
  nextPageToken?: string;
}
interface ChangeList {
  changes?: { fileId: string; removed?: boolean; file?: DriveFile }[];
  nextPageToken?: string;
  newStartPageToken?: string;
}
type SourceFailure = {
  readonly ok: false;
  readonly code: "PA_SCOPE_MISMATCH" | "PA_NOT_FOUND" | "PA_UNAVAILABLE";
  readonly detail: string;
};

export interface GoogleDriveSourceConfig {
  readonly scope: TenantScope;
  readonly workspaceId: WorkspaceId;
  readonly providerWorkspaceId: string;
  readonly mode: "folder" | "shared-drive";
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly adapterVersion?: string;
}

export class GoogleDriveWorkspaceSourceAdapter
  implements WorkspaceSourceAdapter, CaptureSourceCapabilities
{
  readonly provider = "google-drive";
  private readonly request: typeof globalThis.fetch;
  private readonly knownItemIds = new Set<string>();
  private readonly knownFolderIds = new Set<string>();

  constructor(private readonly config: GoogleDriveSourceConfig) {
    this.request = config.fetch ?? globalThis.fetch;
    this.knownFolderIds.add(config.providerWorkspaceId);
  }

  classify(item: SourceItemDescriptor): CaptureClassification {
    if (item.itemKind === FOLDER || item.itemKind === SHORTCUT) return { kind: "skip-container" };
    const native = exportsByMime[item.itemKind];
    if (native)
      return {
        kind: "capture",
        representation: this.representation(native.representation),
        mediaType: native.mime,
      };
    if (item.itemKind.startsWith(GOOGLE_PREFIX)) return { kind: "unsupported_capture" };
    return {
      kind: "capture",
      representation: this.representation("original"),
      mediaType: item.itemKind || "application/octet-stream",
    };
  }

  async establishCursor(request: WorkspaceSourceRequest) {
    const scoped = this.scope(request);
    if (scoped) return scoped;
    const response = await this.json<{ startPageToken?: string }>(
      `${API}/changes/startPageToken?${this.commonParams()}`,
    );
    return response?.startPageToken
      ? { ok: true as const, value: { value: response.startPageToken } }
      : this.unavailable("change cursor is unavailable");
  }

  async listItems(request: WorkspaceSourceRequest) {
    const scoped = this.scope(request);
    if (scoped) return scoped;
    try {
      const result: SourceItemDescriptor[] = [];
      const queue: { id: string; path: string }[] = [
        { id: this.config.providerWorkspaceId, path: "" },
      ];
      while (queue.length) {
        const parent = queue.shift()!;
        let pageToken: string | undefined;
        do {
          const params = new URLSearchParams({
            q: `'${parent.id.replaceAll("'", "\\'")}' in parents and trashed = false`,
            fields:
              "nextPageToken,files(id,name,mimeType,version,modifiedTime,parents,size,trashed)",
            pageSize: "1000",
          });
          if (pageToken) params.set("pageToken", pageToken);
          this.applyDriveParams(params);
          const page = await this.json<FileList>(`${API}/files?${params}`);
          if (!page) return this.unavailable("Drive listing is unavailable");
          for (const file of page.files ?? []) {
            this.knownItemIds.add(file.id);
            const path = `${parent.path}/${file.name ?? file.id}`;
            if (file.mimeType === FOLDER) {
              this.knownFolderIds.add(file.id);
              queue.push({ id: file.id, path });
              continue;
            }
            result.push({
              providerItemId: file.id,
              providerVersion: file.version ?? file.modifiedTime ?? null,
              path,
              filename: file.name ?? null,
              itemKind: file.mimeType,
              metadata: {
                adapter: "google-drive",
                adapterVersion: this.config.adapterVersion ?? "1",
                modifiedTime: file.modifiedTime ?? null,
              },
            });
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
      return { ok: true as const, value: result };
    } catch {
      return this.unavailable("Drive listing is unavailable");
    }
  }

  async readItem(
    request: WorkspaceSourceRequest & {
      readonly providerItemId: string;
      readonly expectedProviderVersion: string | null;
    },
  ) {
    const scoped = this.scope(request);
    if (scoped) return scoped;
    const before = await this.file(request.providerItemId);
    if (!before) return this.notFound();
    const version = before.version ?? before.modifiedTime ?? null;
    if (version !== request.expectedProviderVersion)
      return this.unavailable("source item changed before capture");
    const classification = this.classify({
      providerItemId: before.id,
      providerVersion: version,
      path: null,
      filename: before.name ?? null,
      itemKind: before.mimeType,
      metadata: {},
    });
    if (classification.kind !== "capture")
      return this.unavailable("source item has no capture representation");
    const url = exportsByMime[before.mimeType]
      ? `${API}/files/${encodeURIComponent(before.id)}/export?mimeType=${encodeURIComponent(classification.mediaType)}`
      : `${API}/files/${encodeURIComponent(before.id)}?alt=media&supportsAllDrives=true`;
    const response = await this.authorized(url);
    if (!response?.ok) return this.unavailable("source bytes are unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const after = await this.file(request.providerItemId);
    if (!after || (after.version ?? after.modifiedTime ?? null) !== version)
      return this.unavailable("source item changed during capture");
    const value: SourceCaptureRepresentation = {
      providerItemId: before.id,
      providerVersion: version,
      mediaType: classification.mediaType,
      captureRepresentation: classification.representation,
      bytes,
    };
    return { ok: true as const, value };
  }

  async reconcileChanges(request: WorkspaceSourceRequest & { readonly after: SourceCursor }) {
    const scoped = this.scope(request);
    if (scoped) return scoped;
    if (!request.after.value) return this.unavailable("change cursor is missing");
    const changed = new Set<string>();
    let token: string | undefined = request.after.value;
    let final = request.after.value;
    do {
      const params: URLSearchParams = new URLSearchParams({
        pageToken: token,
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,mimeType,parents,trashed,version,modifiedTime))",
        pageSize: "1000",
        includeRemoved: "true",
        supportsAllDrives: "true",
      });
      this.applyDriveParams(params);
      const page: ChangeList | null = await this.json<ChangeList>(`${API}/changes?${params}`);
      if (!page) return this.unavailable("Drive reconciliation is unavailable");
      for (const change of page.changes ?? []) {
        const inWorkspace =
          this.knownItemIds.has(change.fileId) ||
          change.file?.parents?.some((id: string) => this.knownFolderIds.has(id));
        if (inWorkspace) changed.add(change.fileId);
      }
      final = page.newStartPageToken ?? final;
      token = page.nextPageToken;
    } while (token);
    const value: SourceChangeSet = {
      cursor: { value: final },
      changedProviderItemIds: [...changed].sort(),
    };
    return { ok: true as const, value };
  }

  private scope(request: WorkspaceSourceRequest): SourceFailure | null {
    const scope = assertTenantScope(this.config.scope, request.scope);
    if (!scope.ok) return scope;
    return request.workspaceId === this.config.workspaceId
      ? null
      : { ok: false, code: "PA_SCOPE_MISMATCH", detail: "workspace identity mismatch" };
  }
  private async file(id: string): Promise<DriveFile | null> {
    const params = new URLSearchParams({
      fields: "id,name,mimeType,version,modifiedTime,parents,size,trashed",
      supportsAllDrives: "true",
    });
    return this.json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?${params}`);
  }
  private commonParams(): URLSearchParams {
    const params = new URLSearchParams({ supportsAllDrives: "true" });
    this.applyDriveParams(params);
    return params;
  }
  private representation(kind: string): string {
    return `google-drive@${this.config.adapterVersion ?? "1"}/${kind}`;
  }
  private applyDriveParams(params: URLSearchParams): void {
    if (this.config.mode === "shared-drive") {
      params.set("driveId", this.config.providerWorkspaceId);
      params.set("corpora", "drive");
      params.set("includeItemsFromAllDrives", "true");
    }
  }
  private async authorized(url: string): Promise<Response | null> {
    try {
      return await this.request(url, {
        headers: { Authorization: `Bearer ${await this.config.accessToken()}` },
      });
    } catch {
      return null;
    }
  }
  private async json<T>(url: string): Promise<T | null> {
    const response = await this.authorized(url);
    if (!response?.ok) return null;
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
  private unavailable(detail: string): SourceFailure {
    return { ok: false, code: "PA_UNAVAILABLE", detail };
  }
  private notFound(): SourceFailure {
    return { ok: false, code: "PA_NOT_FOUND", detail: "source item not found" };
  }
}
