/**
 * Google Drive API interaction functions
 * Handles all API requests and response processing
 */

import { DriveFile, DriveFileList, ProfileSyncData, TokenInfo } from "./types";
import { checkAndRefreshAuth } from "./auth";

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
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,appProperties,modifiedTime,kind`;

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
): Promise<DriveFile> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const parentId = existingFileId
      ? null
      : await getOrCreateAppFolder(tokenInfo, refreshCallback);

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
): Promise<DriveFile> => {
  if (!tokenInfo?.accessToken) {
    throw new Error("Not authenticated");
  }

  try {
    const parentId = existingDriveId
      ? null
      : await getOrCreateAppFolder(tokenInfo, refreshCallback);

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
