// Host identity for the hybrid-mode plumbing (an earlier release, plan rev 3.1).
//
// In hybrid mode the project rail still shows only station-owned projects,
// but each Claude pane picks where it runs: the station daemon on the Mac
// Studio, or a local daemon on the laptop with cwd set to the sshfs-mounted
// copy of that same project folder.
//
// `HostRef` is the discriminator carried on `Tab.host` (Phase 1) and used to
// key per-host singletons (`ApiClient`, `DaemonConnection`, settings) in
// later phases. Phase 1 introduces the type only; runtime still pins
// everything to `"station"`.
export type HostRef = "station" | "local";

// Runtime set kept next to the type so adding a third host (or removing
// one) updates both the static and dynamic checks in lockstep. Used by
// `isValidTab` in `layout/split-tree.ts` and by `stampLegacyHost` in
// `config.ts`.
export const VALID_HOSTS: ReadonlySet<HostRef> = new Set<HostRef>(["station", "local"]);
