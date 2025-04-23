"use client";

import { useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";

/**
 * This component ensures that the initial profile fetching (which involves DB access)
 * happens only on the client-side after the initial render.
 */
const ClientSideInitializer: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  useEffect(() => {
    // Fetch profiles only once when the component mounts on the client
    console.log("ClientSideInitializer mounted, fetching initial profiles...");
    useProfileStore.getState().fetchProfiles();
  }, []); // Empty dependency array ensures this runs only once on mount

  // Render children immediately; the profile store will update asynchronously
  return <>{children}</>;
};

export default ClientSideInitializer;
