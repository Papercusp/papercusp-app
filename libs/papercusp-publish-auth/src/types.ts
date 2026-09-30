export type JwtAudience = 'publish' | 'snapshot';

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  sha256: string;
  aud: JwtAudience;
}

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CanonicalManifest {
  files: ManifestFile[];
  deployment_slug: string;
}

export interface Tenant {
  id: string;
  secret_hash: string;
  secret_hash_v: number;
  rotated_from: string | null;
  created_at: number;
  last_used_at: number | null;
  last_ip: string | null;
  status: 'active' | 'revoked' | 'banned';
  tier: 'free' | 'paid' | 'self-host-byo';
  notes: string | null;
}
