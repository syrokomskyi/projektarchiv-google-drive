import { describe, expect, it } from "vitest";
import { workspaceIdSchema, type TenantScope } from "@warpgogol/projektarchiv-core";
import { GoogleDriveWorkspaceSourceAdapter } from "../google-drive-workspace-source.ts";

const scope = {
  tenantId: "01890f7e-7b2c-7a01-8a01-000000000701",
  clientId: "01890f7e-7b2c-7a01-8a01-000000000702",
  projectId: "01890f7e-7b2c-7a01-8a01-000000000703",
} as TenantScope;
const workspaceId = workspaceIdSchema.parse("01890f7e-7b2c-7a01-8a01-000000000704");
const native = [
  ["doc", "application/vnd.google-apps.document", "google-docs-docx"],
  ["sheet", "application/vnd.google-apps.spreadsheet", "google-sheets-xlsx"],
  ["slides", "application/vnd.google-apps.presentation", "google-slides-pptx"],
  ["drawing", "application/vnd.google-apps.drawing", "google-drawing-pdf"],
] as const;

function adapter(options: { changeDuringRead?: boolean } = {}) {
  const calls: { url: string; authorization: string | null }[] = [];
  let metadataReads = 0;
  const files = new Map<
    string,
    { id: string; name: string; mimeType: string; version: string; parents: string[] }
  >([
    [
      "binary",
      { id: "binary", name: "brief.txt", mimeType: "text/plain", version: "1", parents: ["root"] },
    ],
    ...native.map(
      ([id, mime]) =>
        [id, { id, name: id, mimeType: mime, version: "1", parents: ["root"] }] as const,
    ),
    [
      "form",
      {
        id: "form",
        name: "form",
        mimeType: "application/vnd.google-apps.form",
        version: "1",
        parents: ["root"],
      },
    ],
  ]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.includes("changes/startPageToken"))
      return Response.json({ startPageToken: "cursor-1" });
    if (url.includes("/files?") && url.includes("%27root%27"))
      return Response.json({ files: [...files.values()] });
    if (url.includes("/changes?"))
      return Response.json({
        changes: [{ fileId: "binary", file: files.get("binary") }],
        newStartPageToken: "cursor-2",
      });
    const id = [...files.keys()].find((candidate) => url.includes(`/files/${candidate}`));
    if (!id) return new Response("missing", { status: 404 });
    if (url.includes("alt=media") || url.includes("/export?"))
      return new Response(new TextEncoder().encode(`bytes:${id}`));
    metadataReads += 1;
    const file = files.get(id)!;
    return Response.json(
      options.changeDuringRead && metadataReads > 1 ? { ...file, version: "2" } : file,
    );
  };
  return {
    source: new GoogleDriveWorkspaceSourceAdapter({
      scope,
      workspaceId,
      providerWorkspaceId: "root",
      mode: "folder",
      accessToken: async () => "secret-token",
      fetch,
    }),
    calls,
  };
}

describe("GoogleDriveWorkspaceSourceAdapter", () => {
  it("lists binary/native items and classifies every supported export plus unsupported_capture", async () => {
    const { source, calls } = adapter();
    const listed = await source.listItems({ scope, workspaceId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(6);
    for (const [id, , representation] of native) {
      const item = listed.value.find((candidate) => candidate.providerItemId === id)!;
      expect(source.classify(item)).toMatchObject({
        kind: "capture",
        representation: `google-drive@1/${representation}`,
      });
      await expect(
        source.readItem({ scope, workspaceId, providerItemId: id, expectedProviderVersion: "1" }),
      ).resolves.toMatchObject({
        ok: true,
        value: { captureRepresentation: `google-drive@1/${representation}` },
      });
    }
    expect(source.classify(listed.value.find((item) => item.providerItemId === "form")!)).toEqual({
      kind: "unsupported_capture",
    });
    expect(calls.every((call) => call.authorization === "Bearer secret-token")).toBe(true);
  });

  it("captures original binary bytes and filters reconciliation to known workspace identities", async () => {
    const { source } = adapter();
    const cursor = await source.establishCursor({ scope, workspaceId });
    await source.listItems({ scope, workspaceId });
    await expect(
      source.readItem({
        scope,
        workspaceId,
        providerItemId: "binary",
        expectedProviderVersion: "1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { mediaType: "text/plain", captureRepresentation: "google-drive@1/original" },
    });
    if (!cursor.ok) throw new Error("cursor unavailable");
    await expect(
      source.reconcileChanges({ scope, workspaceId, after: cursor.value }),
    ).resolves.toEqual({
      ok: true,
      value: { cursor: { value: "cursor-2" }, changedProviderItemIds: ["binary"] },
    });
  });

  it("fails closed when provider version changes during transfer", async () => {
    const { source } = adapter({ changeDuringRead: true });
    await expect(
      source.readItem({
        scope,
        workspaceId,
        providerItemId: "binary",
        expectedProviderVersion: "1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "PA_UNAVAILABLE",
    });
  });
});
