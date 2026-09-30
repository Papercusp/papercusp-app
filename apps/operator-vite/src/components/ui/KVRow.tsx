import React from 'react';

interface KVRowProps {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}

export const KVRow: React.FC<KVRowProps> = ({ label, value, className = '' }) => {
  return (
    <div className={`pclsb-kv-row ${className}`}>
      <dt className="pclsb-kv-row__label">{label}</dt>
      <dd className="pclsb-kv-row__value">{value}</dd>
    </div>
  );
};

interface DetailGridProps {
  items: Array<{ label: React.ReactNode; value: React.ReactNode }>;
  className?: string;
}

export const DetailGrid: React.FC<DetailGridProps> = ({ items, className = '' }) => {
  return (
    <dl className={`pclsb-detail-grid ${className}`}>
      {items.map((item, i) => (
        <KVRow key={i} label={item.label} value={item.value} />
      ))}
    </dl>
  );
};
