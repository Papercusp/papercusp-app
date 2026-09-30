import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  body,
  className = '',
}) => {
  return (
    <div className={`pclsb-panel__empty ${className}`}>
      {icon && <div className="pclsb-empty__icon">{icon}</div>}
      <div className="pclsb-empty__title">{title}</div>
      {body && <div className="pclsb-empty__body">{body}</div>}
    </div>
  );
};
