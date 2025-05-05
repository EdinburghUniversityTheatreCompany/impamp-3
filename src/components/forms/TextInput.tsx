/**
 * TextInput Component
 *
 * A standardized text input component with auto-focus and error display
 *
 * @module components/forms/TextInput
 */

import React, { useEffect, useRef } from "react";

interface TextInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  type?: "text" | "password" | "number" | "email";
  error?: string;
  selectOnFocus?: boolean;
  className?: string;
  disabled?: boolean;
}

/**
 * TextInput provides a standardized text input field with support for
 * auto-focus, selection, and error states
 */
export const TextInput: React.FC<TextInputProps> = ({
  id,
  value,
  onChange,
  autoFocus = false,
  placeholder,
  type = "text",
  error,
  selectOnFocus = false,
  className = "",
  disabled = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      if (selectOnFocus) {
        inputRef.current.select();
      }
    }
  }, [autoFocus, selectOnFocus]);

  return (
    <input
      ref={inputRef}
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`block w-full px-3 py-2 border rounded-md shadow-sm sm:text-sm
        ${
          error
            ? "border-red-300 focus:ring-red-500 focus:border-red-500"
            : "border-gray-300 focus:ring-blue-500 focus:border-blue-500"
        }
        dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:focus:ring-blue-600 dark:focus:border-blue-600
        ${className}`}
    />
  );
};

export default TextInput;
