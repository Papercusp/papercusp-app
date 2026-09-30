import React from 'react';

interface ListRowProps {
  indicator?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  isSelected?: boolean;
  isClickable?: boolean;
  onClick?: () => void;
  className?: string;
}

export const ListRow: React.FC<ListRowProps> = ({
  indicator,
  title,
  sub,
  meta,
  action,
  isSelected = false,
  isClickable = false,
  onClick,
  className = '',
}) => {
  const classes = [
    'pclsb-row',
    isClickable && 'is-clickable',
    isSelected && 'is-selected',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} onClick={onClick}>
      {indicator && <span className="pclsb-dot">{indicator}</span>}
      <div className="pclsb-row__main">
        <div className="pclsb-row__title">{title}</div>
        {sub && <div className="pclsb-row__sub">{sub}</div>}
        {meta && <div className="pclsb-row__meta">{meta}</div>}
      </div>
      {action && <span className="pclsb-pill">{action}</span>}
    </div>
  );
};
