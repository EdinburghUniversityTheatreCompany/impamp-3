/**
 * What a modal shows while its component is still being fetched.
 *
 * Shared by the two Suspense boundaries that can be waiting on one: the
 * `modalType` path in `ModalRenderer`, and the pad editor, whose `renderForm`
 * output is rendered as plain `content` and so carries its own boundary.
 *
 * @module components/modals/ModalLoadingSpinner
 */

import React from "react";

const ModalLoadingSpinner: React.FC = () => (
  <div className="flex items-center justify-center p-8">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    <span className="ml-2 text-gray-600">Loading...</span>
  </div>
);

export default ModalLoadingSpinner;
