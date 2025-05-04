/**
 * Checkbox Component
 *
 * A standardized checkbox component with label
 *
 * @module components/forms/Checkbox
 */

import React from "react";

interface CheckboxProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  error?: string;
  className?: string;
}

/**
 * Checkbox provides a standardized checkbox input with integrated label and optional description
 */
export const Checkbox: React.FC<CheckboxProps> = ({
  id,
  label,
  checked,
  onChange,
  description,
  error,
  className = "",
}) => {
  return (
    <div className={`flex items-start ${className}`}>
      <div className="flex items-center h-5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 text-blue-600 border-gray-300 rounded 
            focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 
            dark:focus:ring-blue-600 dark:ring-offset-gray-800
            emergency-checkbox"
        />
      </div>
      <div className="ml-3 text-sm">
        <label
          htmlFor={id}
          className="font-medium text-gray-700 dark:text-gray-300"
        >
          {label}
        </label>
        {description && (
          <p className="text-gray-500 dark:text-gray-400">{description}</p>
        )}
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
};

export default Checkbox;
