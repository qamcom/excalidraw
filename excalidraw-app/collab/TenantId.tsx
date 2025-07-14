const RE_TENANT = /^([a-zA-Z0-9-]+)_([a-zA-Z0-9-]+)$/;

let defaultTenantId: string | null = null;
if (!import.meta.env.VITE_APP_WS_SERVER_TENANT) {
  defaultTenantId = import.meta.env.VITE_APP_WS_SERVER_TENANT;
}

export const getTenantIdFromRoomId = (roomId: string) => {
  const match = roomId.match(RE_TENANT);
  return match ? match[2] : defaultTenantId;
};
