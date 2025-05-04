/**
 * FormField Component
 *
 * A standardized field container with label and error display
 *
 * @module components/forms/FormField
 */

import React from "react";

interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}

/**
 * FormField wraps form controls with standardized label and error display
 */
export const FormField: React.FC<FormFieldProps> = ({
  id,
  label,
  error,
  children,
}) => {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
};

export default FormField;
