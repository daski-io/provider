export const SERVICE_WORKSPACE_TABS = [
  "overview",
  "pricing",
  "supplier",
  "controls",
  "rules",
  "endpoints",
] as const;

export type ServiceWorkspaceTab = (typeof SERVICE_WORKSPACE_TABS)[number];

export function parseServiceWorkspaceTab(value: unknown): ServiceWorkspaceTab {
  return typeof value === "string"
    && SERVICE_WORKSPACE_TABS.includes(value as ServiceWorkspaceTab)
    ? value as ServiceWorkspaceTab
    : "overview";
}

export function serviceWorkspaceUrl(
  serviceId: string,
  tab: ServiceWorkspaceTab,
  flash?: { kind: "ok" | "err"; message: string },
): string {
  const query = new URLSearchParams({ tab });
  if (flash) query.set(flash.kind, flash.message);
  return `/admin/ui/services/${encodeURIComponent(serviceId)}?${query.toString()}`;
}
