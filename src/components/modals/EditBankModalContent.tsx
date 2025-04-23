"use client";

import React, { useState, useEffect, useRef } from "react";

interface EditBankModalContentProps {
  initialName: string;
  initialIsEmergency: boolean;
  // Callback to pass the current state up to the caller
  onDataChange: (data: { name: string; isEmergency: boolean }) => void;
}

const EditBankModalContent: React.FC<EditBankModalContentProps> = ({
  initialName,
  initialIsEmergency,
  onDataChange,
}) => {
  const [name, setName] = useState(initialName);
  const [isEmergency, setIsEmergency] = useState(initialIsEmergency);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Update the parent component whenever the data changes
  useEffect(() => {
    onDataChange({ name, isEmergency });
  }, [name, isEmergency, onDataChange]);

  // Focus the name input field when the modal content mounts and select text
  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const handleEmergencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsEmergency(e.target.checked);
  };

  return (
    <div className="space-y-4">
      {/* Bank Name Input */}
      <div>
        <label
          htmlFor="bank-name-input"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Bank Name
        </label>
        <input
          ref={nameInputRef}
          type="text"
          id="bank-name-input"
          data-testid="bank-name-input"
          value={name}
          onChange={handleNameChange}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:focus:ring-blue-600 dark:focus:border-blue-600"
        />
      </div>

      {/* Emergency Checkbox */}
      <div className="flex items-center">
        <input
          id="emergency-checkbox"
          data-testid="emergency-checkbox"
          name="emergency"
          type="checkbox"
          checked={isEmergency}
          onChange={handleEmergencyChange}
          className="h-4 w-4 text-red-600 border-gray-300 rounded focus:ring-red-500 dark:bg-gray-700 dark:border-gray-600 dark:focus:ring-red-600 dark:ring-offset-gray-800"
        />
        <label
          htmlFor="emergency-checkbox"
          className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
        >
          Mark as Emergency Bank
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            (Can be triggered with the Enter key)
          </span>
        </label>
      </div>
    </div>
  );
};

export default EditBankModalContent;
