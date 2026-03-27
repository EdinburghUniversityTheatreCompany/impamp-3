/**
 * Google Drive API interaction functions
 * Handles all API requests and response processing
 */

import {
  DriveFile,
  DriveFileList,
  DrivePermission,
  ProfileSyncData,
  TokenInfo,
} from "./types";
import { checkAndRefreshAuth } from "./auth";
import { getProfileFolderName } from "./utils";

/**
 * Performs an authenticated request to the Google Drive API
 * @param url The API endpoint URL
 * @param method The HTTP method
 * @param tokenInfo Current token information
 * @param options Additional fetch options
 * @param refreshCallback Callback to update token if refreshed
 * @returns The response data or null on error
 */
async function authenticatedRequest<T>(
  url: string,
  method: string,
  tokenInfo: TokenInfo | null,
  options: RequestInit = {},
  refreshCallback: (token: TokenInfo) => void,
): Promise<T | null> {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    // Set up headers with auth token, keeping any extra headers from options
    const { headers: extraHeaders, ...restOptions } = options;
    const headers = {
      Authorization: `Bearer ${tokenInfo.accessToken}`,
      ...extraHeaders,
    };

    const response = await fetch(url, {
      method,
      headers,
      ...restOptions,
    });

    // Handle authentication errors
    if (response.status === 401) {
      console.warn("Token expired during request. Attempting to refresh...");

      const { isValid, refreshedTokenInfo } =
        await checkAndRefreshAuth(tokenInfo);

      if (isValid && refreshedTokenInfo) {
        // Update token through callback
        refreshCallback(refreshedTokenInfo);

        // Retry the request with new token
        const retryHeaders = {
          Authorization: `Bearer ${refreshedTokenInfo.accessToken}`,
          ...extraHeaders,
        };

        const retryResponse = await fetch(url, {
          method,
          headers: retryHeaders,
          ...restOptions,
        });

        if (retryResponse.ok) {
          return (await retryResponse.json()) as T;
        } else {
          throw new Error(
            `API Error: ${retryResponse.status} ${retryResponse.statusText}`,
          );
        }
      } else {
        throw new Error("Authentication expired. Please sign in again.");
      }
    }

    // Handle 404 gracefully — callers like findDriveFileById expect null for missing files
    if (response.status === 404) {
      return null;
    }

    // Handle other errors
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Google Drive API Error: ${response.status} ${errorData?.error?.message || response.statusText}`,
      );
    }

    // Parse and return response data
    return (await response.json()) as T;
  } catch (err) {
    console.error(`API Request failed: ${url}`, err);
    throw err;
  }
}

const APP_FOLDER_NAME = "ImpAmp_Data";

/**
 * Find or create the ImpAmp_Data folder in Google Drive root
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The folder ID
 */
export const getOrCreateAppFolder = async (
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<string> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  // Try to find existing folder
  const query = `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

  const data = await authenticatedRequest<DriveFileList>(
    url,
    "GET",
    tokenInfo,
    {},
    refreshCallback,
  );

  if (data?.files && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create the folder
  console.log(`Creating ${APP_FOLDER_NAME} folder in Google Drive`);
  const metadata = {
    name: APP_FOLDER_NAME,
    mimeType: "application/vnd.google-apps.folder",
    parents: ["root"],
  };

  const created = await authenticatedRequest<DriveFile>(
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    "POST",
    tokenInfo,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    },
    refreshCallback,
  );

  if (!created?.id) {
    throw new Error("Failed to create ImpAmp_Data folder in Google Drive");
  }

  console.log(`Created ${APP_FOLDER_NAME} folder with ID: ${created.id}`);
  return created.id;
};

/**
 * Find or create a per-profile sub-folder inside ImpAmp_Data
 * @param profileName The profile name (used to derive the folder name)
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The folder ID
 */
export const getOrCreateProfileFolder = async (
  profileName: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<string> => {
  const appFolderId = await getOrCreateAppFolder(tokenInfo, refreshCallback);
  const folderName = getProfileFolderName(profileName);

  // Search for existing sub-folder inside the app folder
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${appFolderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

  const data = await authenticatedRequest<DriveFileList>(
    url,
    "GET",
    tokenInfo,
    {},
    refreshCallback,
  );

  if (data?.files && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create the sub-folder
  console.log(
    `Creating profile folder "${folderName}" inside ${APP_FOLDER_NAME}`,
  );
  const metadata = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
    parents: [appFolderId],
  };

  const created = await authenticatedRequest<DriveFile>(
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    "POST",
    tokenInfo,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    },
    refreshCallback,
  );

  if (!created?.id) {
    throw new Error(
      `Failed to create profile folder "${folderName}" in Google Drive`,
    );
  }

  console.log(`Created profile folder "${folderName}" with ID: ${created.id}`);
  return created.id;
};

export type FolderCapability = "owner" | "writer" | "reader" | "none";

/**
 * Determine the current user's effective access level on a Drive folder
 * @param folderId The folder ID to check
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The capability level: "owner", "writer", "reader", or "none"
 */
export const getFolderCapabilities = async (
  folderId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<FolderCapability> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=capabilities(canAddChildren),ownedByMe`;

    const data = await authenticatedRequest<{
      capabilities?: { canAddChildren?: boolean };
      ownedByMe?: boolean;
    }>(url, "GET", tokenInfo, {}, refreshCallback);

    if (!data) return "none";
    if (data.ownedByMe) return "owner";
    if (data.capabilities?.canAddChildren) return "writer";
    return "reader";
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("404") || err.message.includes("403"))
    ) {
      return "none";
    }
    throw err;
  }
};

/**
 * Move a file into a different parent folder
 * @param fileId The file to move
 * @param newParentId The destination folder ID
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 */
export const moveFileToFolder = async (
  fileId: string,
  newParentId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<void> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  // Get current parents first
  const fileInfo = await authenticatedRequest<{ parents?: string[] }>(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
    "GET",
    tokenInfo,
    {},
    refreshCallback,
  );

  const currentParents = fileInfo?.parents?.join(",") ?? "";
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${encodeURIComponent(currentParents)}&fields=id,parents`;

  await authenticatedRequest<DriveFile>(
    url,
    "PATCH",
    tokenInfo,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    refreshCallback,
  );
};

/**
 * List all permissions on a Drive folder
 */
export const listFolderPermissions = async (
  folderId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<DrivePermission[]> => {
  const url = `https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(id,type,role,emailAddress,displayName,photoLink,pendingOwner)`;
  const data = await authenticatedRequest<{ permissions: DrivePermission[] }>(
    url,
    "GET",
    tokenInfo,
    {},
    refreshCallback,
  );
  return data?.permissions ?? [];
};

/**
 * Set the public link access level on a Drive folder.
 * Finds any existing "anyone" permission and updates or removes it.
 */
export const setPublicLinkAccess = async (
  folderId: string,
  access: "off" | "reader" | "writer",
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<void> => {
  // Find existing "anyone" permission
  const permissions = await listFolderPermissions(
    folderId,
    tokenInfo,
    refreshCallback,
  );
  const existing = permissions.find((p) => p.type === "anyone");

  if (access === "off") {
    if (existing) {
      await authenticatedRequest(
        `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${existing.id}`,
        "DELETE",
        tokenInfo,
        {},
        refreshCallback,
      );
    }
    return;
  }

  if (existing) {
    await authenticatedRequest(
      `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${existing.id}`,
      "PATCH",
      tokenInfo,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: access }),
      },
      refreshCallback,
    );
  } else {
    await authenticatedRequest(
      `https://www.googleapis.com/drive/v3/files/${folderId}/permissions`,
      "POST",
      tokenInfo,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "anyone", role: access }),
      },
      refreshCallback,
    );
  }
};

/**
 * Invite a specific user to a Drive folder
 */
export const inviteUser = async (
  folderId: string,
  email: string,
  role: "reader" | "writer",
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<DrivePermission> => {
  const data = await authenticatedRequest<DrivePermission>(
    `https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=id,type,role,emailAddress,displayName`,
    "POST",
    tokenInfo,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role, emailAddress: email }),
    },
    refreshCallback,
  );
  if (!data) throw new Error("Failed to invite user");
  return data;
};

/**
 * Remove a permission from a Drive folder
 */
export const removePermission = async (
  folderId: string,
  permissionId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<void> => {
  await authenticatedRequest(
    `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${permissionId}`,
    "DELETE",
    tokenInfo,
    {},
    refreshCallback,
  );
};

/**
 * Find a Google Drive file by its ID
 * @param fileId The file ID to find
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The file information or null if not found
 */
export const findDriveFileById = async (
  fileId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<DriveFile | null> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,appProperties,modifiedTime,kind,parents`;

    const data = await authenticatedRequest<DriveFile>(
      url,
      "GET",
      tokenInfo,
      {},
      refreshCallback,
    );

    return data;
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      return null; // File not found
    }
    throw err;
  }
};

/**
 * Find a Google Drive file by name
 * @param fileName The filename to search for
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The file information or null if not found
 */
export const findDriveFileByName = async (
  fileName: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<DriveFile | null> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    // Search only for files created by this application using appProperties
    const query = `name='${fileName}' and mimeType='application/json' and appProperties has { key='appIdentifier' and value='ImpAmp3' } and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,appProperties,modifiedTime,kind)`;

    const data = await authenticatedRequest<DriveFileList>(
      url,
      "GET",
      tokenInfo,
      {},
      refreshCallback,
    );

    return data?.files && data.files.length > 0 ? data.files[0] : null;
  } catch (err) {
    console.error(`Error finding Drive file by name: ${fileName}`, err);
    throw err;
  }
};

/**
 * List all files created by this app in Google Drive
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns Array of file information
 */
export const listAppFiles = async (
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<DriveFile[]> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    // Filter by mimeType=application/json to exclude audio files (which have audio MIME types)
    const query = `appProperties has { key='appIdentifier' and value='ImpAmp3' } and mimeType='application/json' and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,appProperties,modifiedTime,kind)`;

    const data = await authenticatedRequest<DriveFileList>(
      url,
      "GET",
      tokenInfo,
      {},
      refreshCallback,
    );

    return (data?.files || []).filter(
      (f) => f.appProperties?.fileType !== "audioFile",
    );
  } catch (err) {
    console.error("Error listing app files:", err);
    throw err;
  }
};

/**
 * Download a file from Google Drive
 * @param fileId The file ID to download
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The file content as ProfileSyncData or null if not found
 */
export const downloadDriveFile = async (
  fileId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<ProfileSyncData | null> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const data = await authenticatedRequest<ProfileSyncData>(
      url,
      "GET",
      tokenInfo,
      {},
      refreshCallback,
    );

    return data;
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      return null; // File not found
    }
    console.error(`Error downloading file ${fileId}:`, err);
    throw err;
  }
};

/**
 * Set a file permission on Google Drive (e.g. make it editable by anyone with the link)
 * @param fileId The file ID to update permissions on
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 */
export const createFilePermission = async (
  fileId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<void> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`;
  const body = JSON.stringify({ type: "anyone", role: "writer" });

  await authenticatedRequest<unknown>(
    url,
    "POST",
    tokenInfo,
    {
      headers: { "Content-Type": "application/json" },
      body,
    },
    refreshCallback,
  );
};

/**
 * Upload a file to Google Drive (create new or update existing)
 * @param fileName The name for the file
 * @param jsonData The content to upload
 * @param existingFileId Optional existing file ID to update
 * @param profileId The profile ID for metadata
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The uploaded file information
 */
export const uploadDriveFile = async (
  fileName: string,
  jsonData: ProfileSyncData,
  existingFileId: string | null,
  profileId: number,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
  folderId?: string,
): Promise<DriveFile> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const parentId = existingFileId
      ? null
      : (folderId ?? (await getOrCreateAppFolder(tokenInfo, refreshCallback)));

    const metadata = {
      name: fileName,
      mimeType: "application/json",
      appProperties: {
        profileId: profileId.toString(),
        appIdentifier: "ImpAmp3",
      },
      ...(parentId ? { parents: [parentId] } : {}),
    };

    const blob = new Blob([JSON.stringify(jsonData, null, 2)], {
      type: "application/json",
    });

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );
    form.append("file", blob);

    let url: string;
    let method: string;

    if (existingFileId) {
      console.log(
        `Updating existing file: ${fileName} (ID: ${existingFileId})`,
      );
      url = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
      method = "PATCH";
    } else {
      console.log(`Creating new file: ${fileName}`);
      url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
      method = "POST";
    }

    // Direct fetch instead of authenticatedRequest since we need to handle FormData
    const headers = {
      Authorization: `Bearer ${tokenInfo.accessToken}`,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: form,
    });

    // Handle authentication errors
    if (response.status === 401) {
      console.warn("Token expired during upload. Attempting to refresh...");

      const { isValid, refreshedTokenInfo } =
        await checkAndRefreshAuth(tokenInfo);

      if (isValid && refreshedTokenInfo) {
        // Update token through callback
        refreshCallback(refreshedTokenInfo);

        // Retry the upload with new token
        const retryHeaders = {
          Authorization: `Bearer ${refreshedTokenInfo.accessToken}`,
        };

        const retryResponse = await fetch(url, {
          method,
          headers: retryHeaders,
          body: form, // Re-use the same form
        });

        if (retryResponse.ok) {
          const result = await retryResponse.json();
          console.log(
            `File ${method === "POST" ? "created" : "updated"} successfully: ${result.name} (ID: ${result.id})`,
          );
          return result;
        } else {
          throw new Error(
            `API Error: ${retryResponse.status} ${retryResponse.statusText}`,
          );
        }
      } else {
        throw new Error("Authentication expired. Please sign in again.");
      }
    }

    // Handle other errors
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Google Drive API Error (${method}): ${response.status} ${errorData?.error?.message || response.statusText}`,
      );
    }

    const result = await response.json();
    console.log(
      `File ${method === "POST" ? "created" : "updated"} successfully: ${result.name} (ID: ${result.id})`,
    );
    return result;
  } catch (err) {
    console.error(`Error uploading file ${fileName} to Google Drive:`, err);
    throw err;
  }
};

/**
 * Upload an audio file to Google Drive (create new or update existing)
 * @param fileName The audio file name
 * @param blob The audio blob
 * @param mimeType The audio MIME type
 * @param existingDriveId Optional existing Drive file ID to update
 * @param profileId The profile ID for metadata
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The uploaded file information
 */
export const uploadAudioFile = async (
  fileName: string,
  blob: Blob,
  mimeType: string,
  existingDriveId: string | null,
  profileId: number,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
  folderId?: string,
): Promise<DriveFile> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const parentId = existingDriveId
      ? null
      : (folderId ?? (await getOrCreateAppFolder(tokenInfo, refreshCallback)));

    const metadata = {
      name: fileName,
      mimeType,
      appProperties: {
        appIdentifier: "ImpAmp3",
        fileType: "audioFile",
        profileId: profileId.toString(),
      },
      ...(parentId ? { parents: [parentId] } : {}),
    };

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );
    form.append("file", blob);

    let url: string;
    let method: string;

    if (existingDriveId) {
      console.log(
        `Updating existing audio file: ${fileName} (ID: ${existingDriveId})`,
      );
      url = `https://www.googleapis.com/upload/drive/v3/files/${existingDriveId}?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
      method = "PATCH";
    } else {
      console.log(`Uploading new audio file: ${fileName}`);
      url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
      method = "POST";
    }

    const headers = { Authorization: `Bearer ${tokenInfo.accessToken}` };
    const response = await fetch(url, { method, headers, body: form });

    if (response.status === 401) {
      const { isValid, refreshedTokenInfo } =
        await checkAndRefreshAuth(tokenInfo);
      if (isValid && refreshedTokenInfo) {
        refreshCallback(refreshedTokenInfo);
        const retryResponse = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${refreshedTokenInfo.accessToken}`,
          },
          body: form,
        });
        if (retryResponse.ok) {
          return (await retryResponse.json()) as DriveFile;
        }
        throw new Error(
          `API Error: ${retryResponse.status} ${retryResponse.statusText}`,
        );
      }
      throw new Error("Authentication expired. Please sign in again.");
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Google Drive API Error (${method}): ${response.status} ${errorData?.error?.message || response.statusText}`,
      );
    }

    const result = await response.json();
    console.log(
      `Audio file ${method === "POST" ? "uploaded" : "updated"}: ${result.name} (ID: ${result.id})`,
    );
    return result;
  } catch (err) {
    console.error(
      `Error uploading audio file ${fileName} to Google Drive:`,
      err,
    );
    throw err;
  }
};

/**
 * Download an audio file from Google Drive as a Blob
 * @param fileId The Drive file ID
 * @param tokenInfo Current token information
 * @param refreshCallback Callback to update token if refreshed
 * @returns The audio blob or null if not found
 */
export const downloadAudioFileAsBlob = async (
  fileId: string,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<Blob | null> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const headers = { Authorization: `Bearer ${tokenInfo.accessToken}` };
    const response = await fetch(url, { headers });

    if (response.status === 401) {
      const { isValid, refreshedTokenInfo } =
        await checkAndRefreshAuth(tokenInfo);
      if (isValid && refreshedTokenInfo) {
        refreshCallback(refreshedTokenInfo);
        const retryResponse = await fetch(url, {
          headers: {
            Authorization: `Bearer ${refreshedTokenInfo.accessToken}`,
          },
        });
        if (retryResponse.ok) return retryResponse.blob();
        if (retryResponse.status === 404) return null;
        throw new Error(
          `API Error: ${retryResponse.status} ${retryResponse.statusText}`,
        );
      }
      throw new Error("Authentication expired. Please sign in again.");
    }

    if (response.status === 404) return null;

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Google Drive API Error: ${response.status} ${errorData?.error?.message || response.statusText}`,
      );
    }

    return response.blob();
  } catch (err) {
    console.error(
      `Error downloading audio file ${fileId} from Google Drive:`,
      err,
    );
    throw err;
  }
};
