// Inspired and partly copied from https://gitlab.com/kiliandeca/excalidraw-fork
// MIT, Kilian Decaderincourt

import {
  MIME_TYPES,
  hashElementsVersion,
  restoreElements,
} from "@excalidraw/excalidraw";
//import { decompressData } from "@excalidraw/excalidraw/data/encode";

import { reconcileElements } from "@excalidraw/excalidraw";

import { getTenantFromURLPathname } from "excalidraw-app/collab/TenantId";

import { prepareElementsForExport } from "@excalidraw/excalidraw/data";

import { DEFAULT_EXPORT_PADDING } from "@excalidraw/common";

import { exportToCanvas } from "@excalidraw/excalidraw/scene/export";

import { canvasToBlob } from "@excalidraw/excalidraw/data/blob";

import { t } from "@excalidraw/excalidraw/i18n";

import type {
  AppState,
  BinaryFileData,
  //BinaryFileMetadata,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { FILE_UPLOAD_MAX_BYTES } from "../app_constants";

import { getSyncableElements } from ".";

import type { Socket } from "socket.io-client";
import type Portal from "../collab/Portal";

import type { SyncableExcalidrawElement } from ".";

const HTTP_STORAGE_BACKEND_URL = import.meta.env
  .VITE_APP_HTTP_STORAGE_BACKEND_URL;
const HTTP_URL_PREFIX = "api/excalidraw/";

const httpStorageSceneVersionCache = new WeakMap<Socket, number>();

export const exportAsPng = async (
  elements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  const { exportedElements, exportingFrame } = prepareElementsForExport(
    elements,
    appState,
    false,
  );

  const tempCanvas = exportToCanvas(exportedElements, appState, files, {
    exportBackground: true,
    viewBackgroundColor: appState.viewBackgroundColor,
    exportPadding: DEFAULT_EXPORT_PADDING,
    exportingFrame,
  });

  return canvasToBlob(tempCanvas);
};

export const saveRoomPreviewToHttpStorage = async (
  tenantId: string,
  roomId: string,
  blob: Blob,
) => {
  try {
    //const payload = await new Response(blob).arrayBuffer();
    const payload = new FormData();
    payload.append("file", blob);

    await fetch(
      `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/preview/${roomId}`,
      {
        method: "POST",
        body: payload,
      },
    );
  } catch (error: any) {}
};

export const isSavedToHttpStorage = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = hashElementsVersion(elements);

    return httpStorageSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveToHttpStorage = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // if no room exists, consider the room saved because there's nothing we can
    // do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToHttpStorage(portal, elements)
  ) {
    return null;
  }

  const tenantId = getTenantFromURLPathname();
  if (!tenantId) {
    return null;
  }

  const sceneVersion = hashElementsVersion(elements);
  const getResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/room/${roomId}`,
  );

  if (!getResponse.ok && getResponse.status !== 404) {
    return null;
  }
  if (getResponse.status === 404) {
    const result: boolean = await saveElementsToBackend(
      roomKey,
      roomId,
      tenantId,
      [...elements],
      sceneVersion,
    );
    if (result) {
      httpStorageSceneVersionCache.set(socket, sceneVersion);
      const syncableElements = getSyncableElements(
        restoreElements(elements, null),
      );
      const files = portal.collab.excalidrawAPI.getFiles();
      const blob = await exportAsPng(syncableElements, appState, files);
      saveRoomPreviewToHttpStorage(tenantId, roomId, blob);
      return syncableElements;
    }
    return null;
  }
  // If room already exist, we compare scene versions to check
  // if we're up to date before saving our scene
  const buffer = await getResponse.json();
  const sceneVersionFromRequest = buffer.sceneVersion;
  if (sceneVersionFromRequest === sceneVersion) {
    return null;
  }
  const existingElements = buffer.elements;
  const reconciledElements = getSyncableElements(
    reconcileElements(elements, existingElements, appState),
  );

  const result: boolean = await saveElementsToBackend(
    roomKey,
    roomId,
    tenantId,
    reconciledElements,
    sceneVersion,
  );

  if (result) {
    httpStorageSceneVersionCache.set(socket, sceneVersion);
    const files: BinaryFiles = {};
    const blob = await exportAsPng(reconciledElements, appState, files);
    saveRoomPreviewToHttpStorage(tenantId, roomId, blob);
    return reconciledElements;
  }
  return null;
};

export const loadFromHttpStorage = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const tenantId = getTenantFromURLPathname();
  if (!tenantId) {
    return null;
  }
  const getResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/room/${roomId}`,
  );
  if (!getResponse.ok || getResponse.status === 404) {
    return null;
  }
  const response = await getResponse.json();
  const elements = response.elements;

  if (socket) {
    httpStorageSceneVersionCache.set(socket, hashElementsVersion(elements));
  }
  return getSyncableElements(restoreElements(elements, null));
};

export const saveFilesToHttpStorage = async ({
  prefix,
  files,
  roomKey,
}: {
  prefix: string;
  files: Map<FileId, BinaryFileData>;
  roomKey: string;
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];
  const maxBytes = FILE_UPLOAD_MAX_BYTES;
  const tenantId = getTenantFromURLPathname();
  if (!tenantId) {
    return { savedFiles, erroredFiles };
  }

  const processedFiles: {
    id: FileId;
    buffer: Uint8Array;
  }[] = [];

  for (const [id, fileData] of files) {
    const buffer = new TextEncoder().encode(fileData.dataURL);

    if (buffer.byteLength > maxBytes) {
      throw new Error(
        t("errors.fileTooBig", {
          maxSize: `${Math.trunc(maxBytes / 1024 / 1024)}MB`,
        }),
      );
    }

    processedFiles.push({
      id,
      buffer,
    });
  }

  await Promise.all(
    processedFiles.map(async ({ id, buffer }) => {
      try {
        const payloadBlob = new Blob([buffer]);
        const payload = new FormData();
        payload.append("file", payloadBlob);
        await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}files/${prefix}/${id}`,
          {
            method: "POST",
            body: payload,
          },
        );
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromHttpStorage = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  const tenantId = getTenantFromURLPathname();
  if (!tenantId) {
    return { loadedFiles, erroredFiles };
  }

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}files/${prefix}/${id}`,
        );
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();
          const dataURL = new TextDecoder().decode(arrayBuffer) as DataURL;
          let mimeType;
          const parsed = dataURL.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/);
          if (parsed) {
            mimeType = parsed[0];
          }
          loadedFiles.push({
            mimeType: mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: /* metadata?.created ||*/ Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

const saveElementsToBackend = async (
  roomKey: string,
  roomId: string,
  tenantId: string,
  elements: SyncableExcalidrawElement[],
  sceneVersion: number,
) => {
  const payload = {
    sceneVersion,
    elements,
  };
  const putResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/room/${roomId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  return putResponse.ok;
};
