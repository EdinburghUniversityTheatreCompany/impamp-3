"use client";

import { useState, useRef, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { syncTargetLabel } from "@/lib/syncState";
import CheckSolidIcon from "@/components/icons/CheckSolidIcon";
import ChevronDownIcon from "@/components/icons/ChevronDownIcon";
import PencilIcon from "@/components/icons/PencilIcon";
import UserIcon from "@/components/icons/UserIcon";

export default function ProfileSelector() {
  // Per-field: this sits in the header, so a bare subscription re-rendered it
  // on every playback-adjacent store bump.
  const profiles = useProfileStore((s) => s.profiles);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const setActiveProfileId = useProfileStore((s) => s.setActiveProfileId);
  const openProfileManager = useProfileStore((s) => s.openProfileManager);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get the active profile object
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleProfileChange = (profileId: number) => {
    setActiveProfileId(profileId);
    setIsOpen(false);
  };

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      {/*
        The visible label is just the active profile's name, which on its own
        says nothing about what the control does — and collides with any pad or
        armed-track button named after a similarly-named sound. Naming it
        "Profile: <name>" keeps the visible text inside the accessible name
        (WCAG 2.5.3, Label in Name) while making the button's purpose clear to a
        screen reader, and gives tests something specific to match.
      */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-2 bg-white dark:bg-gray-700 rounded-lg shadow-sm flex items-center space-x-2 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={`Profile: ${activeProfile?.name || "No Profile"}`}
      >
        <UserIcon className="w-5 h-5 text-gray-500 dark:text-gray-300" />
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate max-w-[150px]">
          {activeProfile?.name || "No Profile"}
        </span>
        <ChevronDownIcon
          className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? "transform rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black/5 z-50">
          <div className="py-1" role="menu" aria-orientation="vertical">
            {/* Profile list */}
            <div className="max-h-60 overflow-y-auto">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => handleProfileChange(profile.id!)}
                  className={`block w-full text-left px-4 py-2 text-sm ${
                    profile.id === activeProfileId
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : "text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                  }`}
                  role="menuitem"
                >
                  <div className="flex items-center">
                    <span className="flex-1 truncate">{profile.name}</span>
                    {profile.id === activeProfileId && (
                      <CheckSolidIcon
                        className="h-5 w-5 text-blue-500"
                        title="Current profile"
                      />
                    )}
                  </div>
                  {/*
                    One vocabulary everywhere. This used to be a two-way
                    ternary with no case for server sync, so every
                    server-synced profile described itself as "Local" — in the
                    one place a user looks to tell their profiles apart.
                  */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {syncTargetLabel(profile.syncType)}
                  </div>
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="border-t border-gray-200 dark:border-gray-700"></div>

            {/* Manage Profiles button */}
            <button
              onClick={() => {
                openProfileManager();
                setIsOpen(false);
              }}
              className="block w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
              role="menuitem"
            >
              <div className="flex items-center">
                <PencilIcon className="h-4 w-4 mr-2" />
                <span>Manage Profiles</span>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
