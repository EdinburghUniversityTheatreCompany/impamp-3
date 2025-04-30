"use client";

import { useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { getAllProfiles } from "@/lib/db";

/**
 * This component ensures that the initial profile fetching (which involves DB access)
 * happens only on the client-side after the initial render.
 * It also handles automatic sync for Google Drive-linked profiles.
 */
const ClientSideInitializer: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { syncProfile } = useGoogleDriveSync();
  const isGoogleSignedIn = useProfileStore((state) => state.isGoogleSignedIn);

  useEffect(() => {
    // Fetch profiles only once when the component mounts on the client
    console.log("ClientSideInitializer mounted, fetching initial profiles...");
    useProfileStore.getState().fetchProfiles();
  }, []); // Empty dependency array ensures this runs only once on mount

  // Auto-sync on load and when Google auth changes
  useEffect(() => {
    if (isGoogleSignedIn) {
      const syncAllProfiles = async () => {
        try {
          const profiles = await getAllProfiles();
          console.log(`Auto-syncing profiles on app load...`);

          for (const profile of profiles) {
            if (
              profile.id !== undefined &&
              profile.syncType === "googleDrive" &&
              profile.googleDriveFileId
            ) {
              console.log(
                `Auto-syncing profile ${profile.id} (${profile.name})...`,
              );
              await syncProfile(profile.id);
            }
          }
        } catch (error) {
          console.error("Error during auto-sync:", error);
        }
      };

      syncAllProfiles();
    }
  }, [isGoogleSignedIn, syncProfile]);

  // Network connectivity change detection
  useEffect(() => {
    const handleOnline = async () => {
      if (isGoogleSignedIn) {
        console.log("Network connection restored. Syncing profiles...");
        try {
          const profiles = await getAllProfiles();

          for (const profile of profiles) {
            if (
              profile.id !== undefined &&
              profile.syncType === "googleDrive" &&
              profile.googleDriveFileId
            ) {
              await syncProfile(profile.id);
            }
          }
        } catch (error) {
          console.error("Error during network reconnect sync:", error);
        }
      }
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [isGoogleSignedIn, syncProfile]);

  // Periodic sync (every 15 minutes)
  useEffect(() => {
    if (!isGoogleSignedIn) return;

    const intervalId = setInterval(
      async () => {
        console.log("Running periodic sync...");
        try {
          const profiles = await getAllProfiles();

          for (const profile of profiles) {
            if (
              profile.id !== undefined &&
              profile.syncType === "googleDrive" &&
              profile.googleDriveFileId
            ) {
              await syncProfile(profile.id);
            }
          }
        } catch (error) {
          console.error("Error during periodic sync:", error);
        }
      },
      15 * 60 * 1000,
    ); // 15 minutes

    return () => clearInterval(intervalId);
  }, [isGoogleSignedIn, syncProfile]);

  // Render children immediately; the profile store will update asynchronously
  return <>{children}</>;
};

export default ClientSideInitializer;
