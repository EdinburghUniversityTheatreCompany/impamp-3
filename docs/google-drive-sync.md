# ImpAmp3 - Google Drive Synchronization Guide

This guide explains how to set up and use the Google Drive synchronization feature in ImpAmp3 for automatically syncing your soundboard profiles across devices and collaborating with others.

## 1. Google Cloud Setup (One-time setup)

To use this feature for your own hosted version, you first need to configure API access through the Google Cloud Console. 

1.  **Create/Select a Project:**
    *   Go to the [Google Cloud Console](https://console.cloud.google.com/).
    *   Create a new project (e.g., "ImpAmp3 Sync") or select an existing one.

2.  **Enable the Google Drive API:**
    *   In the search bar at the top, search for "Google Drive API".
    *   Select the "Google Drive API" result.
    *   Click the "Enable" button. If it's already enabled, you can skip this step.

3.  **Configure OAuth Consent Screen:**
    *   Navigate to "APIs & Services" > "OAuth consent screen" in the left-hand menu.
    *   Choose "External" user type (unless you have a Google Workspace account and only want internal users). Click "Create".
    *   Fill in the required information:
        *   **App name:** e.g., "ImpAmp3 Profile Sync"
        *   **User support email:** Your email address.
        *   **Developer contact information:** Your email address.
    *   Click "Save and Continue".
    *   On the "Scopes" page, click "Add or Remove Scopes".
    *   In the filter box, search for `https://www.googleapis.com/auth/drive.file`.
    *   Check the box next to this scope.
    *   Click "Update".
    *   Click "Save and Continue".
    *   On the "Test users" page, add the Google account(s) you want to use with ImpAmp3 sync by clicking "Add Users" and entering their email addresses.
    *   Click "Save and Continue".
    *   Review the summary and click "Back to Dashboard".
    *   **Important:** You might need to click "Publish App" under "Publishing status" for the consent screen to be active for your test users. If you chose "External", Google might require verification for wider use, but for personal use with test users, publishing should be sufficient.

4.  **Create OAuth 2.0 Credentials:**
    *   Navigate to "APIs & Services" > "Credentials" in the left-hand menu.
    *   Click "+ Create Credentials" > "OAuth client ID".
    *   Select "Web application" as the application type.
    *   Give it a name (e.g., "ImpAmp3 Web Client").
    *   Under "Authorized JavaScript origins", click "+ Add URI" and enter the URL where you are running ImpAmp3 (e.g., `http://localhost:3000` for local development, or your deployed app's URL). You might need to add multiple URIs if you run it in different locations.
    *   **Do not** add anything under "Authorized redirect URIs" for this setup.
    *   Click "Create".

5.  **Get Your Client ID:**
    *   A pop-up will show your "Client ID" and "Client Secret". You only need the **Client ID**. Copy it.

6.  **Configure ImpAmp3 Environment Variable:**
    *   In the root directory of your ImpAmp3 project, create a file named `.env.local` (if it doesn't already exist).
    *   Add the following line to the file, replacing `your-google-client-id-here` with the Client ID you just copied:
        ```
        NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-google-client-id-here
        ```
    *   **Restart your ImpAmp3 development server** for the environment variable to be loaded.

## 2. Using Google Drive Sync in ImpAmp3

Once the setup is complete and you've restarted the app:

### Signing In

1.  **Open Profile Manager:** Click the profile selector/button in the ImpAmp3 header and select "Manage Profiles".
2.  **Sign In with Google:**
    *   Within the Profile Manager, there will be a "Sign in with Google" button.
    *   Click this button to authenticate with your Google account.
    *   A Google sign-in pop-up will appear. Choose the account you want to use and grant permission.
    *   Once signed in, your name and email should appear.

### Linking Profiles to Google Drive

Once signed in, each profile card in the **Profiles tab** shows Google Drive sync options:

1.  **Link to Drive (new file):** Creates a new file in your Google Drive with the current profile data.

2.  **Link to Existing…:** Opens the Google Drive picker to select an existing ImpAmp3 file and link this profile to it.

3.  **Sync Now / Update from Drive:** Manually triggers sync. Read-only profiles show "Update from Drive" and only download changes.

4.  **Share:** Makes the linked Drive file accessible to anyone with the link (sets it to public editable). Copies the share URL to your clipboard. Only shown for writable profiles.

5.  **Unlink:** Removes the link between the local profile and the Drive file (does not delete the Drive file).

### Automatic Synchronization

Linked profiles benefit from automatic synchronization in these situations:

*   When the application loads
*   When your internet connection is restored after being offline
*   Every 15 minutes while the application is open

### Conflict Resolution

If changes are made to the same profile on different devices, ImpAmp3 will detect conflicts and display a resolution modal:

1.  **Field-Level Conflicts:**
    *   The modal will show each field that has conflicting changes.
    *   You can choose between the local version and the remote version for each field.
    *   A preview of both versions is shown to help you decide.

2.  **Local-Only and Remote-Only Items:**
    *   Items that exist only locally or only remotely are automatically preserved during sync.
    *   No manual resolution is needed for these items.

3.  **Applying Resolution:**
    *   After making your selections, click "Apply Resolution".
    *   The merged data will be saved locally and uploaded to Google Drive.

## 3. Collaboration with Others

You can share your profiles with other ImpAmp3 users directly from within ImpAmp3.

### Sharing a Profile (Person A — the file owner)

1.  **Link a Profile to Google Drive** as described above.

2.  **Click "Share"** on the linked profile card in the Profiles tab.
    *   This makes the Drive file editable by anyone with the link.
    *   The share link is automatically copied to your clipboard.

3.  **Send the link** to your collaborators.

### Connecting to a Shared Profile (Person B — a collaborator)

1.  **Open Profile Manager** and go to the **Import/Export** tab.

2.  **Scroll to "Connect to shared profile"** at the bottom of the tab.

3.  **Paste the share link** you received into the input field.
    *   Accepts a full Google Drive URL (e.g. `https://drive.google.com/file/d/.../view`).

4.  Optionally check **"Read-only"** if you want to receive updates from the shared profile without being able to push your own changes back.

5.  **Click "Connect"** — ImpAmp3 will download the profile and link it to the shared Drive file automatically.

From this point, sync works exactly like a personal profile. The existing sync mechanism handles everything, including conflict detection and the conflict resolution modal when both users edit the same pad.

### Important Note on Audio Files

*   The sync process transfers profile configurations (pad layouts, names, etc.) but **not the audio files themselves**.
*   All users need to have the necessary audio files on their local devices.
*   Consider sharing your audio files separately if needed for collaboration.

## Sync Status Indicators

Each linked profile displays its sync status:

*   **Syncing:** Profile is currently being synchronized with Google Drive.
*   **Synced:** Profile is up-to-date with the linked Drive file.
*   **Conflict:** Conflicts detected that require manual resolution.
*   **Error:** Synchronization failed (details in error message).

## Troubleshooting

*   **Auth Errors:** If you experience authentication issues, try signing out and back in.
*   **Sync Errors:** Check your internet connection and try manual sync.
*   **Conflict Loop:** If you're stuck in a conflict loop, try selecting "Use Remote" for all fields once to reset.
*   **Shared File Not Appearing:** Ensure the file has been shared with the correct email address and permissions.
