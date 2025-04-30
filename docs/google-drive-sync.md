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
    *   In the filter box, search for `https://www.googleapis.com/auth/drive.appdata`.
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

Once signed in, each profile card in the Profile Manager will display Google Drive sync options:

1.  **Link to a New Drive File:**
    *   Click the "Link to new Drive file" button on a profile card.
    *   ImpAmp3 will create a new file in your Google Drive with the current profile data.
    *   Once linked, the profile card will show the sync status.

2.  **Link to an Existing Drive File:**
    *   Click the "Link to existing file" button on a profile card.
    *   A file picker will appear showing your existing ImpAmp3 profile files in Drive.
    *   Select the file you want to link to.
    *   If the selected file's data differs from your local profile, a conflict resolution dialog may appear.

3.  **Manual Sync:**
    *   For any linked profile, click the "Sync now" button to manually trigger synchronization.
    *   This will compare local and remote data and either sync automatically or prompt for conflict resolution.

4.  **Unlink a Profile:**
    *   Click the "Unlink from Drive" button on a linked profile card.
    *   This removes the link between your local profile and the Drive file (but doesn't delete the Drive file).

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

You can share your profiles with other ImpAmp3 users:

1.  **Link a Profile to Google Drive** as described above.

2.  **Share the Drive File:**
    *   Open Google Drive in your browser.
    *   Find the linked file (format: `impamp-profile-profilename.json`).
        * Note: If you can't see the file in your main Drive view, it might be in the hidden AppData folder. In this case, you can click "Search in Drive" in the Google Drive UI and search for "impamp-profile".
    *   Right-click and select "Share".
    *   Add email addresses of people you want to share with and set permissions (usually "Editor" if you want them to be able to make changes).
    *   Click "Send" to share the file.

3.  **Collaborator Access:**
    *   Your collaborators need to:
        *   Have ImpAmp3 set up with their own Google account.
        *   Link one of their profiles to the shared file using the "Link to existing file" option.
    *   Once linked, their changes will sync with yours through the shared Drive file.

4.  **Important Note on Audio Files:**
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
