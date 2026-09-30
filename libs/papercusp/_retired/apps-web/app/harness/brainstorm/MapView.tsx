'use client';

import { useEffect, useRef } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap, loadCSS, loadJS } from 'markmap-view';

interface Props {
  markdown: string;
}

const transformer = new Transformer();

export function MapView({ markdown }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const { root, features } = transformer.transform(markdown || '# (empty)');
    const { styles, scripts } = transformer.getUsedAssets(features);
    if (styles) loadCSS(styles);
    if (scripts) loadJS(scripts, { getMarkmap: () => ({ Markmap }) });

    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current, {
        color: (node: any) => {
          const colors = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff'];
          return colors[Math.abs(node.depth ?? 0) % colors.length];
        },
        duration: 300,
        maxWidth: 260,
      }, root);
    } else {
      mmRef.current.setData(root);
      mmRef.current.fit();
    }
  }, [markdown]);

  useEffect(() => () => {
    mmRef.current?.destroy();
    mmRef.current = null;
  }, []);

  if (!markdown.trim()) {
    return (
      <div className="h-empty">
        <span>write in the editor to see the mindmap</span>
      </div>
    );
  }

  return (
    <div className="h-brainstorm-map">
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
