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
  /**
   * Set when the child is a group of controls rather than one control — in
   * practice, a `RadioGroup`. The label then names the group through
   * `FormFieldLabelContext` instead of `htmlFor`, because `<label for>` is
   * defined only against a labelable element and a group is a `<div>`: the
   * reference resolves to nothing and clicking the label does nothing.
   */
  labelsGroup?: boolean;
  children: React.ReactNode;
}

/**
 * The id of the enclosing `FormField`'s `<label>`, or undefined outside one.
 *
 * A group has to name itself with `aria-labelledby`, and the id it points at
 * has to come from whoever rendered the label. `RadioGroup` used to derive
 * `${id}-label` from its own id and nothing anywhere rendered that id, so
 * every group in the app announced as an unnamed "group" — the markup looked
 * right and no compiler could tell. Passing the real id down is what makes
 * the reference impossible to dangle: outside a `FormField` there is no id
 * and the group simply carries no `aria-labelledby` at all.
 */
export const FormFieldLabelContext = React.createContext<string | undefined>(
  undefined,
);

/**
 * FormField wraps form controls with standardized label and error display
 */
export const FormField: React.FC<FormFieldProps> = ({
  id,
  label,
  error,
  labelsGroup = false,
  children,
}) => {
  const labelId = `${id}-label`;
  return (
    <div className="mb-4">
      <label
        id={labelId}
        htmlFor={labelsGroup ? undefined : id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <FormFieldLabelContext.Provider value={labelId}>
        {children}
      </FormFieldLabelContext.Provider>
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
};

export default FormField;
