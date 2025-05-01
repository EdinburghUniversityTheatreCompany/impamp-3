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
    // Set up headers with auth token
    const headers = {
      Authorization: `Bearer ${tokenInfo.accessToken}`,
      ...options.headers,
    };

    const response = await fetch(url, {
      method,
      headers,
      ...options,
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
          ...options.headers,
        };

        const retryResponse = await fetch(url, {
          method,
          headers: retryHeaders,
          ...options,
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
    // Using correct Google Drive API property search syntax
    const query = `appProperties has { key='appIdentifier' and value='ImpAmp3' } and trashed=false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,appProperties,modifiedTime,kind)`;

    const data = await authenticatedRequest<DriveFileList>(
      url,
      "GET",
      tokenInfo,
      {},
      refreshCallback,
    );

    return data?.files || [];
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
    const metadata = {
      name: fileName,
      mimeType: "application/json",
      appProperties: {
        profileId: profileId.toString(),
        appIdentifier: "ImpAmp3",
      },
      ...(existingFileId ? {} : { parents: ["root"] }), // Only set parents when creating new
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
