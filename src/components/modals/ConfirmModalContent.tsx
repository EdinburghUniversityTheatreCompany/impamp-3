'use client';

import React from 'react';

interface ConfirmModalContentProps {
  message: string;
}

const ConfirmModalContent: React.FC<ConfirmModalContentProps> = ({ message }) => {
  return (
    <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="confirm-message">
      {message}
    </p>
  );
};

export default ConfirmModalContent;
