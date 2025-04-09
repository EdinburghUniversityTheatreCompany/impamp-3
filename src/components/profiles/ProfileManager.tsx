'use client';

import { useState } from 'react';
import { useProfileStore } from '@/store/profileStore';
import { SyncType } from '@/lib/db';
import ProfileCard from './ProfileCard';

export default function ProfileManager() {
  const { profiles, activeProfileId, isProfileManagerOpen, closeProfileManager, createProfile } = useProfileStore();
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileSyncType, setNewProfileSyncType] = useState<SyncType>('local');
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<'profiles' | 'import-export'>('profiles');

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newProfileName.trim()) {
      alert('Please enter a profile name');
      return;
    }
    
    try {
      setIsCreating(true);
      await createProfile({
        name: newProfileName.trim(),
        syncType: newProfileSyncType
      });
      setNewProfileName('');
      setNewProfileSyncType('local');
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to create profile:', error);
      alert('Failed to create profile. Please try again.');
      setIsCreating(false);
    }
  };

  if (!isProfileManagerOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black bg-opacity-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Profile Manager</h2>
          <button
            onClick={closeProfileManager}
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="px-6 flex space-x-4">
            <button
              onClick={() => setActiveTab('profiles')}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === 'profiles'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              Profiles
            </button>
            <button
              onClick={() => setActiveTab('import-export')}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === 'import-export'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              Import / Export
            </button>
          </nav>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'profiles' && (
            <div>
              {/* Existing Profiles */}
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Your Profiles</h3>
              
              {profiles.length === 0 ? (
                <div className="text-gray-500 dark:text-gray-400 italic">No profiles found.</div>
              ) : (
                <div className="space-y-4">
                  {profiles.map(profile => (
                    <ProfileCard
                      key={profile.id}
                      profile={profile}
                      isActive={profile.id === activeProfileId}
                    />
                  ))}
                </div>
              )}
              
              {/* Create New Profile */}
              <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Create New Profile</h3>
                
                <form onSubmit={handleCreateProfile} className="space-y-4">
                  <div>
                    <label htmlFor="profileName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Profile Name
                    </label>
                    <input
                      id="profileName"
                      type="text"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                      placeholder="Enter profile name"
                      required
                    />
                  </div>
                  
                  <div>
                    <label htmlFor="syncType" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Storage Type
                    </label>
                    <select
                      id="syncType"
                      value={newProfileSyncType}
                      onChange={(e) => setNewProfileSyncType(e.target.value as SyncType)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                    >
                      <option value="local">Local Only</option>
                      <option value="googleDrive">Google Drive</option>
                    </select>
                    {newProfileSyncType === 'googleDrive' && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Google Drive integration will be available in a future update.
                      </p>
                    )}
                  </div>
                  
                  <div>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className={`px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors ${
                        isCreating ? 'opacity-70 cursor-not-allowed' : ''
                      }`}
                    >
                      {isCreating ? 'Creating...' : 'Create Profile'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
          
          {activeTab === 'import-export' && (
            <div>
              {/* Export Section */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Export Profile</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Export your profiles and their configurations to a file that you can use for backup or transfer.
                </p>
                
                {/* TODO: Implement export functionality */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Export functionality will be available in a future update.
                  </p>
                  <button
                    disabled
                    className="px-4 py-2 bg-gray-200 text-gray-500 rounded-md cursor-not-allowed"
                  >
                    Export Profile
                  </button>
                </div>
              </section>
              
              {/* Import Section */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Import Profile</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Import a previously exported profile configuration file.
                </p>
                
                {/* TODO: Implement import functionality */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Import functionality will be available in a future update.
                  </p>
                  <button
                    disabled
                    className="px-4 py-2 bg-gray-200 text-gray-500 rounded-md cursor-not-allowed"
                  >
                    Import Profile
                  </button>
                </div>
              </section>
              
              {/* Google Drive Integration */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Google Drive Integration</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Connect your profiles to Google Drive to sync your sound configurations across devices.
                </p>
                
                {/* TODO: Implement Google Drive integration */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Google Drive integration will be available in a future update.
                  </p>
                  <button
                    disabled
                    className="px-4 py-2 bg-gray-200 text-gray-500 rounded-md cursor-not-allowed"
                  >
                    Connect to Google Drive
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button
            onClick={closeProfileManager}
            className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
