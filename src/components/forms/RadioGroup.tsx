/**
 * RadioGroup Component
 *
 * A standardized radio button group component
 *
 * @module components/forms/RadioGroup
 */

import React, { useContext } from "react";

import { FormFieldLabelContext } from "./FormField";

interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface RadioGroupProps<T extends string> {
  id: string;
  name: string;
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  error?: string;
  horizontal?: boolean;
  className?: string;
  /**
   * Forwarded to the radiogroup container. Declared explicitly because
   * hyphenated JSX attributes bypass prop-type checking, so an unforwarded
   * data-testid is dropped silently rather than failing the build.
   */
  "data-testid"?: string;
  /**
   * When set, each option's radio input gets
   * `data-testid="{optionTestIdPrefix}-{option.value}"`, so individual options
   * can be targeted without depending on generated element ids.
   */
  optionTestIdPrefix?: string;
}

/**
 * RadioGroup provides a standardized group of radio buttons
 */
export const RadioGroup = <T extends string>({
  id,
  name,
  options,
  value,
  onChange,
  error,
  horizontal = false,
  className = "",
  "data-testid": dataTestId,
  optionTestIdPrefix,
}: RadioGroupProps<T>) => {
  // Undefined outside a FormField, which is the point: a group with no label
  // to point at carries no `aria-labelledby` rather than one that resolves to
  // nothing. See FormFieldLabelContext.
  const labelledBy = useContext(FormFieldLabelContext);

  return (
    <div className={className}>
      <div
        className={`${horizontal ? "space-x-4 flex items-center" : "space-y-4"}`}
        role="radiogroup"
        aria-labelledby={labelledBy}
        data-testid={dataTestId}
      >
        {options.map((option) => (
          <div
            key={option.value}
            className={`${horizontal ? "mr-4" : "mb-2"} flex items-start`}
          >
            <div className="flex items-center h-5">
              <input
                id={`${id}-${option.value}`}
                // Only when there is one, so a radio without an explanation
                // does not point at an empty element.
                aria-describedby={
                  option.description
                    ? `${id}-${option.value}-description`
                    : undefined
                }
                data-testid={
                  optionTestIdPrefix
                    ? `${optionTestIdPrefix}-${option.value}`
                    : undefined
                }
                name={name}
                type="radio"
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="h-4 w-4 text-blue-600 border-gray-300 
                  focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600
                  dark:focus:ring-blue-600 dark:ring-offset-gray-800"
              />
            </div>
            <div className="ml-3 text-sm">
              <label
                htmlFor={`${id}-${option.value}`}
                className="font-medium text-gray-700 dark:text-gray-300 capitalize"
              >
                {option.label || option.value.replace("-", " ")}
              </label>
              {option.description && (
                <p
                  id={`${id}-${option.value}-description`}
                  className="text-gray-500 dark:text-gray-400"
                >
                  {option.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
};

export default RadioGroup;
