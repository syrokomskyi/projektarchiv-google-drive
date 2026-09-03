/*
<MODULE_CONTRACT>
<purpose>Expose the Google Drive workspace source adapter and its credential-neutral runtime configuration contract.</purpose>
<non-goals><item>Do not expose provider tokens, capture workflow state, or storage adapters.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY><item>RFC-1007: publish the Google Drive adapter entrypoint.</item></CHANGE_SUMMARY>
*/

export * from "./google-drive-workspace-source.ts";
