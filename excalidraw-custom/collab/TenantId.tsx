const RE_TENANT = /^([a-zA-Z0-9-]+)_([a-zA-Z0-9-]+)$/;

const RE_TENANT_IN_PATHNAME = /^\/([^/]+)/;

let defaultTenantId: string | null = null;
if (!import.meta.env.VITE_APP_WS_SERVER_TENANT) {
  defaultTenantId = import.meta.env.VITE_APP_WS_SERVER_TENANT;
}

export const getTenantIdFromRoomId = (roomId: string) => {
  const match = roomId.match(RE_TENANT);
  return match ? match[2] : defaultTenantId;
};

export const getTenantFromURLPathname = () => {
  const match = window.location.pathname.match(RE_TENANT_IN_PATHNAME);
  return match ? match[1] : null;
};
