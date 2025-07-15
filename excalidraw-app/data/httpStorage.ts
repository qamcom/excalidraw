// Inspired and partly copied from https://gitlab.com/kiliandeca/excalidraw-fork
// MIT, Kilian Decaderincourt

import {
  MIME_TYPES,
  hashElementsVersion,
  restoreElements,
} from "@excalidraw/excalidraw";
import { decompressData } from "@excalidraw/excalidraw/data/encode";

import { reconcileElements } from "@excalidraw/excalidraw";

import { getTenantIdFromRoomId } from "excalidraw-app/collab/TenantId";

import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { getSyncableElements } from ".";

import type { Socket } from "socket.io-client";
import type Portal from "../collab/Portal";

import type { SyncableExcalidrawElement } from ".";

const HTTP_STORAGE_BACKEND_URL = import.meta.env
  .VITE_APP_HTTP_STORAGE_BACKEND_URL;
const HTTP_URL_PREFIX = "api/excalidraw/";

const httpStorageSceneVersionCache = new WeakMap<Socket, number>();

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

  const tenantId = getTenantIdFromRoomId(roomId);
  if (!tenantId) {
    return null;
  }

  const sceneVersion = hashElementsVersion(elements);
  const getResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/${roomId}`,
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
      return getSyncableElements(restoreElements(elements, null));
    }
    return null;
  }
  // If room already exist, we compare scene versions to check
  // if we're up to date before saving our scene
  const buffer = await getResponse.json();
  const sceneVersionFromRequest = buffer.sceneVersion;
  if (sceneVersionFromRequest >= sceneVersion) {
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
    return reconciledElements;
  }
  return null;
};

export const loadFromHttpStorage = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  console.log("loadFromHTTPStorage", roomId);
  const tenantId = getTenantIdFromRoomId(roomId);
  if (!tenantId) {
    return null;
  }
  const getResponse = await fetch(
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/${roomId}`,
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
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];
  const tenantId = "unknown";

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const payloadBlob = new Blob([buffer]);
        const payload = await new Response(payloadBlob).arrayBuffer();
        await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}files/${id}`,
          {
            method: "POST",
            /*           headers: {
            "Content-Type": "application/json", // TODO
          }, */
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

  const tenantId = "unknown"; /* getTenantIdFromRoomId(roomId);
  if (!tenantId) {
    return null;
  }  */

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(
          `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}files/${id}`,
        );
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
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
    `${HTTP_STORAGE_BACKEND_URL}/${tenantId}/${HTTP_URL_PREFIX}rooms/${roomId}`,
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
