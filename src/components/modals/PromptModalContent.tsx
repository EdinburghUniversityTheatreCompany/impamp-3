"use client";

import React, { useState, useEffect, useRef } from "react";

interface PromptModalContentProps {
  label: string;
  initialValue?: string;
  // Callback to pass the current input value up to the caller
  // This allows the caller to access the value in its onConfirm handler
  onValueChange: (value: string) => void;
  inputType?: "text" | "number" | "password"; // Add more types if needed
}

const PromptModalContent: React.FC<PromptModalContentProps> = ({
  label,
  initialValue = "",
  onValueChange,
  inputType = "text",
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Update the parent component whenever the value changes
  useEffect(() => {
    onValueChange(value);
  }, [value, onValueChange]);

  // Focus the input field when the modal content mounts
  useEffect(() => {
    inputRef.current?.focus();
    // Select the text if there's an initial value
    if (initialValue) {
      inputRef.current?.select();
    }
  }, [initialValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor="prompt-input"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        {label}
      </label>
      <input
        ref={inputRef}
        type={inputType}
        id="prompt-input"
        data-testid="prompt-input"
        value={value}
        onChange={handleChange}
        className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:focus:ring-blue-600 dark:focus:border-blue-600"
      />
    </div>
  );
};

export default PromptModalContent;
