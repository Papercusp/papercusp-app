import { notFound } from 'next/navigation';
import HarnessDashboard from '../HarnessDashboard';
import DepartmentHarnessDashboard from '../DepartmentHarnessDashboard';

export const dynamic = 'force-dynamic';

type ProjectEntry = {
  slug: string;
  path: string;
  harness_kind?: 'coding' | 'department';
  department_slug?: string;
};

async function fetchProject(slug: string): Promise<ProjectEntry | null> {
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/api/harness/projects`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const projects: ProjectEntry[] = data.projects ?? [];
    return projects.find((p) => p.slug === slug) ?? null;
  } catch {
    return null;
  }
}

export default async function HarnessProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await fetchProject(slug);

  if (!project) {
    notFound();
  }

  if (project.harness_kind === 'department' && project.department_slug) {
    return (
      <DepartmentHarnessDashboard
        harnessSlug={project.slug}
        departmentSlug={project.department_slug}
      />
    );
  }

  // Coding flavor — same as /harness, but locked to this slug via query param prefill
  return <HarnessDashboard />;
}
