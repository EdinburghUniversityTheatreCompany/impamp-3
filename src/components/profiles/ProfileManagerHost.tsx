"use client";

import { useProfileStore } from "@/store/profileStore";
import ProfileManager from "./ProfileManager";

/**
 * Mounts the profile manager only while it is open.
 *
 * `ProfileManager` is rendered unconditionally by `ClientLayout`, and used to
 * decide it was invisible six hundred lines into its own body — after 29
 * `useState` calls, `useGoogleDriveSync()` and `useGoogleLogin()`, and after an
 * effect that imports `@googleworkspace/drive-picker-element`. So every visitor
 * downloaded and registered the Google Drive Picker custom element on app
 * start, whether or not they ever opened the manager, signed into Google, or
 * used Drive at all.
 *
 * It also subscribes to the whole profile store with no selector, so every sync
 * tick, `padConfigsVersion` bump and bank switch re-ran all of that while
 * rendering nothing.
 *
 * Gating here means the body is never constructed until it is wanted. This
 * component subscribes to exactly one boolean.
 *
 * Measured on a production build, JS transferred on first load:
 *
 *   always mounted          427 KB over 20 requests
 *   gated, plain import     378 KB over 19 requests
 *   gated, next/dynamic     554 KB over 20 requests
 *
 * So this is a plain import on purpose. `dynamic()` looks like the obvious
 * choice and is the worst of the three, because it emits a preload for the
 * chunk and pulls it anyway — on top of the split. The saving comes from the
 * picker import in the body no longer running, not from code splitting.
 */
export default function ProfileManagerHost() {
  const isProfileManagerOpen = useProfileStore(
    (state) => state.isProfileManagerOpen,
  );

  return isProfileManagerOpen ? <ProfileManager /> : null;
}
